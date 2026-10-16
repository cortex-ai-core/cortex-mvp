import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import jwt from 'jsonwebtoken';

const secret='attachment-contract-session-secret-32chars';
const identity={userId:'10000000-0000-4000-8000-000000000001',organizationId:'10000000-0000-4000-8000-000000000002',namespaceId:'10000000-0000-4000-8000-000000000003',role:'operator'};

test('production route loader serves temporary attachments with auth, parser and no persistence',async(t)=>{
 let role='operator',member=true,parserCalls=0,parserStatus=200;
 const writes=[];
 const mock=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/user')return res.end(JSON.stringify([{active:true,organization_id:identity.organizationId,role:{name:role}}]));
  if(url.pathname==='/namespace_users')return res.end(JSON.stringify(member?[{id:'membership',namespace:{organization_id:identity.organizationId}}]:[]));
  if(url.pathname==='/parse'){
   for await(const _ of req){};parserCalls++;
   res.statusCode=parserStatus;
   return res.end(JSON.stringify(parserStatus===200?{markdown:'Synthetic PDF attachment code ATTACH-9274.',chunks:[],page_count:1,parser:'docling'}:{detail:'Synthetic parser failure'}));
  }
  if(req.method!=='GET')writes.push({method:req.method,path:url.pathname});
  res.end('[]');
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>mock.close(r)));
 const mockUrl=`http://127.0.0.1:${mock.address().port}`;
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,CORTEX_ENV:'local',NODE_ENV:'test',PORT:'0',BACKEND_PROVIDER:'aws',AWS_REGION:'us-west-2',AWS_ACCESS_KEY_ID:'',AWS_SECRET_ACCESS_KEY:'',AWS_SESSION_TOKEN:'',AWS_CONFIG_FILE:'/dev/null',AWS_SHARED_CREDENTIALS_FILE:'/dev/null',AWS_EC2_METADATA_DISABLED:'true',AWS_CORTEX_JWT_SECRET:secret,RDS_REST_JWT_SECRET:'different-attachment-database-secret-32chars',RDS_REST_URL:mockUrl,COGNITO_USER_POOL_ID:'us-west-2_attachmenttest',COGNITO_CLIENT_ID:'attachment-client',OPENAI_API_KEY:'synthetic-not-a-real-key',PARSER_URL:mockUrl,PARSER_SECRET:'synthetic-parser-secret',MAX_UPLOAD_MB:'1',INGEST_WORKER:'off',RETENTION_SWEEP_MINUTES:'0',RETRIEVAL_TRACE:'off'},stdio:['ignore','pipe','pipe']});
 let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
 let base;
 for(let i=0;i<200;i++){const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(match){base=match[0];break;}if(child.exitCode!==null)throw Error('Server exited before listening');await new Promise(r=>setTimeout(r,25));}
 assert.ok(base,'Production server started');
 const token=jwt.sign(identity,secret,{algorithm:'HS256',issuer:'cortex:aws',audience:'cortex:api',expiresIn:'5m'});
 const send=(name,text,authorization=token)=>{
  const body=new FormData();if(name!==null)body.append('file',new Blob([text]),name);else body.append('description','no file');
  return fetch(base+'/api/attachments/parse',{method:'POST',headers:authorization?{Authorization:'Bearer '+authorization}:{},body});
 };
 await t.test('text attachment returns readable text through the actual server route',async()=>{
  const res=await send('fixture.txt','\r\n  ATTACH-9274\r\n');assert.equal(res.status,200);const body=await res.json();assert.equal(body.text,'ATTACH-9274');assert.equal(body.parser,'text');assert.equal(parserCalls,0);
 });
 await t.test('PDF attachment reaches Docling and returns its text',async()=>{
  const res=await send('fixture.pdf','%PDF-synthetic');assert.equal(res.status,200);const body=await res.json();assert.match(body.text,/ATTACH-9274/);assert.equal(body.page_count,1);assert.equal(parserCalls,1);
 });
 await t.test('large attachment text is bounded and its JSON chat payload is accepted',async()=>{
  const res=await send('long.txt','x'.repeat(400001));assert.equal(res.status,200);const body=await res.json();assert.equal(body.chars,400000);assert.equal(body.truncated,true);
  const chat=await fetch(base+'/api/chat',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({message:'',ephemeralContext:'界'.repeat(400000)})});
  assert.equal(chat.status,400);assert.equal((await chat.json()).error,'Message required');
 });
 await t.test('missing authentication and revoked namespace membership are rejected',async()=>{
  assert.equal((await send('fixture.txt','test',null)).status,401);member=false;assert.equal((await send('fixture.txt','test')).status,403);member=true;
 });
 await t.test('viewer and client cannot attach files',async()=>{
  for(const denied of ['viewer','client']){role=denied;assert.equal((await send('fixture.txt','test')).status,403);}role='operator';
 });
 await t.test('unsupported, absent, empty and oversized files fail explicitly',async()=>{
  assert.equal((await send('fixture.exe','test')).status,415);
  assert.equal((await send(null,'')).status,400);
  assert.equal((await send('fixture.txt','')).status,400);
  assert.equal((await send('fixture.txt','x'.repeat(1024*1024+1))).status,413);
 });
 await t.test('parser failure is reported and a subsequent retry succeeds',async()=>{
  parserStatus=503;assert.equal((await send('fixture.pdf','%PDF-synthetic')).status,503);parserStatus=200;assert.equal((await send('fixture.pdf','%PDF-synthetic')).status,200);
 });
 assert.deepEqual(writes,[],'Temporary parsing never writes document, storage or trace records');
});

test('private trace text stays null while normal query tracing remains available',async()=>{
 const {finishTrace}=await import('../../backend/retrieval/trace.js');
 const rows=[];const db={from:()=>({insert:async batch=>{rows.push(...batch);return {error:null};}})};
 for(const query of [null,'ordinary query'])await finishTrace(db,{}, {traceId:identity.userId,hadRetrieval:false,query,namespaceId:identity.namespaceId,conflicts:null});
 assert.equal(rows[0].query,null);assert.equal(rows[0].conflicts,null);assert.equal(rows[1].query,'ordinary query');
});
