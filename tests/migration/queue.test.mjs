import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFromMessage } from '../../backend/ingest/queue.js';
import { createIngestWorker } from '../../backend/ingest/worker.js';
const id='10000000-0000-4000-8000-000000000001';
test('accepts original-upload events and rejects another bucket or parsed output',()=>{
  const event={detail:{bucket:{name:'documents'},object:{key:`core/${id}/original.pdf`}}};
  assert.equal(documentFromMessage(event,'documents').id,id);
  assert.throws(()=>documentFromMessage(event,'another-bucket'));
  assert.throws(()=>documentFromMessage({detail:{...event.detail,object:{key:`core/${id}/parsed.md`}}},'documents'));
  assert.throws(()=>documentFromMessage({documentId:'../../invalid'},'documents'));
});
test('duplicate delivery of a ready document never invokes parsing or database claim',async()=>{
  let claims=0;
  const db={from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{id,status:'ready',storage_path:`core/${id}/original.pdf`},error:null};}};},rpc(){claims++;throw new Error('Must not claim ready documents.');}};
  const worker=createIngestWorker({supabase:db,openai:{},log:{info(){},warn(){},error(){}}});
  assert.deepEqual(await worker.processQueuedDocument(id,`core/${id}/original.pdf`),{status:'ready',duplicate:true});
  assert.equal(claims,0);
  await assert.rejects(worker.processQueuedDocument(id,'another/object'),/does not match/);
});
