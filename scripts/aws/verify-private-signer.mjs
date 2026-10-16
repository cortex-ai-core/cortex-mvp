// Synthetic fixture only. Never print signed URLs or temporary credentials.
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import {S3Client,HeadObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {guard,outputs} from '../deploy/aws.mjs';
guard('dev');
const Bucket=outputs('cortex-dev-data').DocumentsBucket;
const Key=`00000000-0000-4000-8000-000000000000/${randomUUID()}/original.txt`;
const Body=Buffer.from('Synthetic Cortex Oregon private upload signer verification.\n');
const checksum=createHash('sha256').update(Body).digest('hex');
const lambda=new LambdaClient({region:'us-west-2'}),s3=new S3Client({region:'us-west-2'});
let version;
try{
 const invocation=await lambda.send(new InvokeCommand({FunctionName:'cortex-dev-upload-signer',Payload:Buffer.from(JSON.stringify({key:Key,size:Body.length,checksum,contentType:'text/plain'}))}));
 if(invocation.FunctionError)throw new Error('Private signer invocation failed.');
 const signed=JSON.parse(Buffer.from(invocation.Payload).toString());
 const url=new URL(signed.uploadUrl);
 if(url.protocol!=='https:'||!url.hostname.endsWith('.amazonaws.com')||url.searchParams.get('X-Amz-Algorithm')!=='AWS4-HMAC-SHA256')throw new Error('Expected a SigV4 HTTPS S3 URL.');
 const uploaded=await fetch(signed.uploadUrl,{method:'PUT',headers:signed.headers,body:Body});
 if(!uploaded.ok)throw new Error(`Synthetic signed upload failed: HTTP${uploaded.status}.`);
 version=uploaded.headers.get('x-amz-version-id');
 const object=await s3.send(new HeadObjectCommand({Bucket,Key,ChecksumMode:'ENABLED'}));version=object.VersionId||version;
 if(object.ContentLength!==Body.length||object.ChecksumSHA256!==Buffer.from(checksum,'hex').toString('base64'))throw new Error('Synthetic object size/checksum mismatch.');
 const report={at:new Date().toISOString(),account:'909762691423',region:'us-west-2',privateSigner:true,sigV4:true,uploadStatus:uploaded.status,bytes:Body.length,checksumVerified:true};
 await writeFile('.local/migration/private-signer-verification.json',JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify(report));
}finally{
 if(version)await s3.send(new DeleteObjectCommand({Bucket,Key,VersionId:version}));
 lambda.destroy();s3.destroy();
}
