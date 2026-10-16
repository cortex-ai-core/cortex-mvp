// Explicit one-time Ohio inventory -> Oregon identity transfer. Password stays in process memory.
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {CognitoIdentityProviderClient,AdminCreateUserCommand,AdminGetUserCommand,AdminDisableUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import {guard,outputs} from '../deploy/aws.mjs';
guard('dev');
const password=process.env.CORTEX_INITIAL_PASSWORD;
if(!password||password.length<12)throw new Error('Provide the initial temporary password through the process environment; never commit it.');
const out=outputs('cortex-dev-data'),s3=new S3Client({region:'us-west-2'}),cognito=new CognitoIdentityProviderClient({region:'us-west-2'});
const archive=await s3.send(new GetObjectCommand({Bucket:out.MigrationBucket,Key:'cognito/users.json'}));
const users=JSON.parse(await archive.Body.transformToString()),mappings=[];
for(const old of users){
  const attrs=Object.fromEntries(old.Attributes.map(a=>[a.Name,a.Value]));
  if(!attrs.email||!attrs.sub)throw new Error('Inventory is missing an email or source subject.');
  let user;
  try{user=await cognito.send(new AdminGetUserCommand({UserPoolId:out.UserPoolId,Username:attrs.email}));}
  catch(error){if(error.name!=='UserNotFoundException')throw error;}
  if(user){
    const previous=Object.fromEntries(user.UserAttributes.map(a=>[a.Name,a.Value]));
    if(previous['custom:legacy_subject']!==attrs.sub||previous['custom:legacy_issuer']!=='https://cognito-idp.us-east-2.amazonaws.com/us-east-2_gfKKl0wNa')throw new Error('Existing Oregon identity does not match the archived source. Manual reconciliation required.');
  }else{
    const allowed=['email','email_verified','name','given_name','family_name','phone_number','phone_number_verified'];
    const result=await cognito.send(new AdminCreateUserCommand({UserPoolId:out.UserPoolId,Username:attrs.email,TemporaryPassword:password,MessageAction:'SUPPRESS',UserAttributes:[...allowed.filter(k=>attrs[k]).map(Name=>({Name,Value:attrs[Name]})),{Name:'custom:legacy_subject',Value:attrs.sub},{Name:'custom:legacy_issuer',Value:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_gfKKl0wNa'}]}));
    user={...result.User,UserAttributes:result.User.Attributes};
  }
  if(old.Enabled===false)await cognito.send(new AdminDisableUserCommand({UserPoolId:out.UserPoolId,Username:user.Username}));
  mappings.push({legacySubject:attrs.sub,targetSubject:user.UserAttributes.find(a=>a.Name==='sub').Value,enabled:old.Enabled!==false,status:user.UserStatus});
}
await s3.send(new PutObjectCommand({Bucket:out.MigrationBucket,Key:'cognito/oregon-transfer.json',Body:JSON.stringify({at:new Date().toISOString(),pool:out.UserPoolId,mappings},null,2),ContentType:'application/json'}));
console.log(JSON.stringify({usersTransferred:mappings.length,temporaryPasswordRequired:mappings.filter(u=>u.status==='FORCE_CHANGE_PASSWORD').length,ohioSignInDependency:false}));
cognito.destroy();s3.destroy();
