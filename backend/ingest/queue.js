import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function documentFromMessage(body, expectedBucket) {
  const event=typeof body==='string'?JSON.parse(body):body;
  if(event.documentId){
    if(!UUID.test(event.documentId))throw new Error('Invalid queued document id.');
    return {id:event.documentId,storagePath:event.storagePath||null};
  }
  const record=event.Records?.[0];
  const bucket=event.detail?.bucket?.name||record?.s3?.bucket?.name;
  if(bucket!==expectedBucket)throw new Error('Unexpected source bucket.');
  const key=event.detail?.object?.key || (record?.s3?.object?.key ? decodeURIComponent(record.s3.object.key.replace(/\+/g,' ')) : '');
  const parts=key.split('/');
  if(parts.length!==3||!UUID.test(parts[1])||!/^original\.[a-z0-9]+$/i.test(parts[2]))throw new Error('Not an original document object.');
  return {id:parts[1],storagePath:key};
}
export async function enqueueDocument(documentId, storagePath, env=process.env) {
  if(!env.INGEST_QUEUE_URL)return;
  const client=new SQSClient({region:env.AWS_REGION});
  try {await client.send(new SendMessageCommand({QueueUrl:env.INGEST_QUEUE_URL,MessageBody:JSON.stringify({documentId,storagePath})}));}
  finally {client.destroy();}
}
