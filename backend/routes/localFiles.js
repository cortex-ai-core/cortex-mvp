import { readFile } from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import { localFileKey,localFilePath } from '../lib/services/localStorage.js';
export default async function localFiles(fastify){
  if(process.env.CORTEX_ENV!=='local'||process.env.NODE_ENV==='production')return;
  fastify.get('/api/local-files/:token',async(request,reply)=>{
    try{
      const decoded=jwt.verify(request.params.token,localFileKey(),{algorithms:['HS256'],issuer:'cortex:local-file',audience:'cortex:local-file'});
      const body=await readFile(localFilePath(decoded.key));
      return reply.type('application/octet-stream').header('Cache-Control','no-store').send(body);
    }catch{return reply.code(404).send({error:'File link is unavailable or expired.'});}
  });
}
