import { mkdir,writeFile,readFile,readdir,unlink } from 'node:fs/promises';
import { resolve,sep,dirname } from 'node:path';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';

export function localFileKey(env=process.env){return createHash('sha256').update(env.AWS_CORTEX_JWT_SECRET+':local-files').digest('hex');}
export function localFilePath(key,root=resolve('.local/dev/storage')){
  const path=resolve(root,key);
  if(!key||path===root||!path.startsWith(root+sep))throw new Error('Invalid local object path.');
  return path;
}
export function createLocalStorage(env=process.env){
  if(env.CORTEX_ENV!=='local'||env.NODE_ENV==='production')throw new Error('Local storage is restricted to local development.');
  const run=async(fn)=>{try{return {data:await fn(),error:null};}catch{return {data:null,error:{message:'Local storage operation failed.'}};}};
  return {from(){return {
    upload:(key,body)=>run(async()=>{const path=localFilePath(key);await mkdir(dirname(path),{recursive:true});await writeFile(path,body);return {path:key};}),
    download:key=>run(async()=>new Blob([await readFile(localFilePath(key))])),
    list:prefix=>run(async()=>{try{return (await readdir(localFilePath(prefix))).map(name=>({name}));}catch(error){if(error.code==='ENOENT')return [];throw error;}}),
    remove:keys=>run(async()=>{for(const key of keys)await unlink(localFilePath(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});return keys.map(name=>({name}));}),
    createSignedUrl:(key,seconds)=>run(async()=>{localFilePath(key);const token=jwt.sign({key},localFileKey(env),{algorithm:'HS256',issuer:'cortex:local-file',audience:'cortex:local-file',expiresIn:Math.min(seconds,300)});return {signedUrl:`http://127.0.0.1:${env.PORT||8082}/api/local-files/${token}`};}),
  };}};
}
