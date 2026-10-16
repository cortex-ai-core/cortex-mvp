// Copy service data to Oregon. Source operations are List/Get only; no source deletes.
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { S3Client,ListObjectsV2Command,ListObjectVersionsCommand,GetBucketVersioningCommand,CopyObjectCommand,GetObjectCommand,PutObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient,PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient,ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { guard,outputs } from '../deploy/aws.mjs';
guard('dev');
const target=outputs('cortex-dev-data');
const env=dotenv.parse(await readFile(new URL('../../.env.aws',import.meta.url)));
const sourceBucket='cortex-documents-dev-909762691423';
const source=new S3Client({region:'us-east-2'}),destination=new S3Client({region:'us-west-2'});
const manager=new SecretsManagerClient({region:'us-west-2'});
await manager.send(new PutSecretValueCommand({SecretId:target.OpenAiSecret,SecretString:env.OPENAI_API_KEY}));
await manager.send(new PutSecretValueCommand({SecretId:target.LegacySecret,SecretString:JSON.stringify({enabled:true,clientId:env.COGNITO_CLIENT_ID,clientSecret:env.COGNITO_CLIENT_SECRET,issuer:`https://cognito-idp.us-east-2.amazonaws.com/${env.COGNITO_USER_POOL_ID}`})}));
const cognito=new CognitoIdentityProviderClient({region:'us-east-2'});const users=[];let token;
do{const page=await cognito.send(new ListUsersCommand({UserPoolId:env.COGNITO_USER_POOL_ID,PaginationToken:token}));users.push(...page.Users);token=page.PaginationToken;}while(token);
await destination.send(new PutObjectCommand({Bucket:target.MigrationBucket,Key:'cognito/users.json',Body:JSON.stringify(users),ContentType:'application/json'}));
const report={sourceRegion:'us-east-2',destinationRegion:'us-west-2',at:new Date().toISOString(),users:users.length,objects:[],archivedVersions:0};
let continuation;
const digest=async(client,input)=>{const object=await client.send(new GetObjectCommand(input));const hash=createHash('sha256');for await(const part of object.Body)hash.update(part);return hash.digest('hex');};
do{
  const page=await source.send(new ListObjectsV2Command({Bucket:sourceBucket,ContinuationToken:continuation}));
  for(const object of page.Contents||[]){
    const CopySource=sourceBucket+'/'+object.Key.split('/').map(encodeURIComponent).join('/');
    await destination.send(new CopyObjectCommand({Bucket:target.DocumentsBucket,Key:object.Key,CopySource,MetadataDirective:'COPY'}));
    const [before,after]=await Promise.all([digest(source,{Bucket:sourceBucket,Key:object.Key}),digest(destination,{Bucket:target.DocumentsBucket,Key:object.Key})]);
    if(before!==after)throw new Error('Document checksum mismatch; source must be stable during verification.');
    report.objects.push({key:object.Key,bytes:object.Size,sha256:after});
  }
  continuation=page.NextContinuationToken;
}while(continuation);
const versioning=await source.send(new GetBucketVersioningCommand({Bucket:sourceBucket}));
if(versioning.Status){
  let keyMarker,versionMarker;
  do{
    const page=await source.send(new ListObjectVersionsCommand({Bucket:sourceBucket,KeyMarker:keyMarker,VersionIdMarker:versionMarker}));
    for(const version of page.Versions||[]){
      if(version.IsLatest)continue;
      await destination.send(new CopyObjectCommand({Bucket:target.MigrationBucket,Key:`s3-history/${encodeURIComponent(version.Key)}/${encodeURIComponent(version.VersionId)}`,CopySource:sourceBucket+'/'+version.Key.split('/').map(encodeURIComponent).join('/')+'?versionId='+encodeURIComponent(version.VersionId)}));
      report.archivedVersions++;
    }
    if(page.DeleteMarkers?.length)await destination.send(new PutObjectCommand({Bucket:target.MigrationBucket,Key:`s3-history/delete-markers-${report.archivedVersions}-${Date.now()}.json`,Body:JSON.stringify(page.DeleteMarkers),ContentType:'application/json'}));
    keyMarker=page.NextKeyMarker;versionMarker=page.NextVersionIdMarker;
  }while(keyMarker);
}
const sourceReport=await readFile(new URL('../../.local/migration/source-report.json',import.meta.url));
await destination.send(new PutObjectCommand({Bucket:target.MigrationBucket,Key:'verification/ohio-database.json',Body:sourceReport,ContentType:'application/json'}));
await destination.send(new PutObjectCommand({Bucket:target.MigrationBucket,Key:'verification/service-copy.json',Body:JSON.stringify(report,null,2),ContentType:'application/json'}));
await writeFile(new URL('../../.local/migration/service-copy-report.json',import.meta.url),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({usersCopied:users.length,currentObjectsVerified:report.objects.length,historicalVersionsArchived:report.archivedVersions,sourceUnchanged:true}));
for(const client of [source,destination,manager,cognito])client.destroy();
