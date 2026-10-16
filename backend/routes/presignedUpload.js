import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { LambdaClient,InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client,HeadObjectCommand } from '@aws-sdk/client-s3';
import { hasPermission,identityFrom,requireNamespaceMember } from '../lib/permissions.js';
import { findDocumentType } from '../lib/documentTypeScope.js';
import { enqueueDocument } from '../ingest/queue.js';

const types={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.md':'text/markdown','.txt':'text/plain','.html':'text/html','.htm':'text/html','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.tif':'image/tiff','.tiff':'image/tiff'};
export default async function presignedUploadRoutes(fastify){
  fastify.addHook('preHandler',requireNamespaceMember(fastify));
  fastify.post('/api/documents/upload-url',async(request,reply)=>{
    const identity=identityFrom(request);
    if(!hasPermission(identity,'upload'))return reply.code(403).send({error:'Your role cannot upload documents.'});
    if(!process.env.UPLOAD_SIGNER_NAME)return reply.code(503).send({error:'Direct uploads are not configured.'});
    const body=request.body||{},fileName=String(body.file_name||'').trim();
    const extension=extname(fileName).toLowerCase();
    if(!types[extension]||fileName.length>255||!Number.isInteger(body.byte_size)||body.byte_size<1||body.byte_size>50*1024*1024||!/^[0-9a-f]{64}$/.test(body.sha256||''))return reply.code(400).send({error:'Provide a supported file, its size, and SHA-256 checksum.'});
    const db=fastify.supabase;
    const duplicate=await db.from('documents').select('id,file_name,status,stage_detail,storage_path,mime_type').eq('namespace_id',identity.namespaceId).eq('sha256',body.sha256).maybeSingle();
    if(duplicate.error)return reply.code(503).send({error:'Unable to check existing documents.'});
    const resume=duplicate.data?.status==='queued'&&duplicate.data.stage_detail==='Waiting for upload';
    if(duplicate.data&&!resume)return {document_id:duplicate.data.id,file_name:duplicate.data.file_name,status:duplicate.data.status,duplicate:true};
    let documentType=String(body.document_type||'').trim().slice(0,60)||null;
    if(documentType){const found=await findDocumentType(db,identity,documentType);if(!found)return reply.code(400).send({error:'Unknown document type.'});documentType=found.name;}
    const id=resume?duplicate.data.id:randomUUID(),key=resume?duplicate.data.storage_path:`${identity.namespaceId}/${id}/original${extension}`;
    const lambda=new LambdaClient({region:process.env.AWS_REGION});
    let signed;
    try{
      const result=await lambda.send(new InvokeCommand({FunctionName:process.env.UPLOAD_SIGNER_NAME,Payload:Buffer.from(JSON.stringify({key,size:body.byte_size,checksum:body.sha256,contentType:resume?duplicate.data.mime_type:types[extension]}))}));
      if(result.FunctionError)throw new Error('Upload signer failed.');
      signed=JSON.parse(Buffer.from(result.Payload).toString());
    }catch{return reply.code(503).send({error:'Unable to prepare the upload. Try again.'});}
    finally{lambda.destroy();}
    const row={id,file_name:fileName,display_name:String(body.display_name||'').trim().slice(0,160)||null,description:String(body.description||'').trim().slice(0,1000)||null,document_type:documentType,namespace_id:identity.namespaceId,status:'queued',stage_progress:0,stage_detail:'Waiting for upload',sha256:body.sha256,byte_size:body.byte_size,mime_type:types[extension],storage_path:key,parser:'docling',uploaded_by:identity.userId,attempts:0};
    const inserted=resume?{error:null}:await db.from('documents').insert(row);
    if(inserted.error)return reply.code(503).send({error:'Unable to record the upload. Try again.'});
    return reply.code(201).send({document_id:id,file_name:fileName,status:'queued',duplicate:false,...signed});
  });
  fastify.post('/api/documents/:document_id/upload-complete',async(request,reply)=>{
    const identity=identityFrom(request);
    if(!hasPermission(identity,'upload'))return reply.code(403).send({error:'Forbidden'});
    const {data:doc,error}=await fastify.supabase.from('documents').select('id,file_name,storage_path,sha256,byte_size,status').eq('id',request.params.document_id).eq('namespace_id',identity.namespaceId).maybeSingle();
    if(error)return reply.code(503).send({error:'Unable to read upload status.'});
    if(!doc)return reply.code(404).send({error:'Document not found.'});
    const s3=new S3Client({region:process.env.AWS_REGION});
    try{
      const object=await s3.send(new HeadObjectCommand({Bucket:process.env.S3_DOCUMENTS_BUCKET,Key:doc.storage_path,ChecksumMode:'ENABLED'}));
      if(object.ContentLength!==doc.byte_size||object.ChecksumSHA256!==Buffer.from(doc.sha256,'hex').toString('base64'))return reply.code(409).send({error:'Uploaded file does not match its size or checksum.'});
      await enqueueDocument(doc.id,doc.storage_path);
      return {document_id:doc.id,file_name:doc.file_name,status:doc.status,duplicate:false};
    }catch{return reply.code(409).send({error:'The upload is not complete. Try again.'});}
    finally{s3.destroy();}
  });
}
