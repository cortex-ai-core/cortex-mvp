import { SQSClient,ReceiveMessageCommand,DeleteMessageCommand,ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { STSClient,GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import OpenAI from 'openai';
import { createDatabaseClient } from '../../backend/lib/services/database.js';
import { createIngestWorker } from '../../backend/ingest/worker.js';
import { documentFromMessage } from '../../backend/ingest/queue.js';
if(process.env.AWS_REGION!=='us-west-2'||!process.env.INGEST_QUEUE_URL)throw new Error('Explicit Oregon queue configuration is required.');
const identity=await new STSClient({region:'us-west-2'}).send(new GetCallerIdentityCommand({}));
if(identity.Account!==process.env.CORTEX_ACCOUNT_ID)throw new Error('Account mismatch.');
const log=Object.fromEntries(['info','warn','error'].map(level=>[level,(data,message)=>console.log(JSON.stringify({level,message,...data}))]));
const worker=createIngestWorker({supabase:createDatabaseClient(),openai:new OpenAI({apiKey:process.env.OPENAI_API_KEY}),log});
const sqs=new SQSClient({region:'us-west-2'});const QueueUrl=process.env.INGEST_QUEUE_URL;
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
let lastSweep=0;
while(!stopping){
  if(Date.now()-lastSweep>60000){await worker.sweepStale();lastSweep=Date.now();}
  const batch=await sqs.send(new ReceiveMessageCommand({QueueUrl,MaxNumberOfMessages:1,WaitTimeSeconds:20,VisibilityTimeout:900}));
  for(const message of batch.Messages||[]){
    const ReceiptHandle=message.ReceiptHandle;
    const heartbeat=setInterval(()=>sqs.send(new ChangeMessageVisibilityCommand({QueueUrl,ReceiptHandle,VisibilityTimeout:900})).catch(()=>log.warn({},'Queue heartbeat failed')),60_000);
    try{
      const doc=documentFromMessage(message.Body,process.env.S3_DOCUMENTS_BUCKET);
      await worker.processQueuedDocument(doc.id,doc.storagePath);
      await sqs.send(new DeleteMessageCommand({QueueUrl,ReceiptHandle}));
      log.info({documentId:doc.id},'Document ready; delivery acknowledged');
    }catch(error){
      log.error({reason:error.message},'Document delivery failed; will retry or enter dead-letter queue');
      await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl,ReceiptHandle,VisibilityTimeout:/already claimed|not claimed/.test(error.message)?900:60})).catch(()=>{});
    }finally{clearInterval(heartbeat);}
  }
}
sqs.destroy();
