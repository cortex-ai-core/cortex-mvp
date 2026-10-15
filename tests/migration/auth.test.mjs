import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticationService } from '../../backend/lib/services/authentication.js';
const oldIssuer='https://cognito-idp.us-east-2.amazonaws.com/us-east-2_legacy';
function fixture(legacyIssuer=oldIssuer){
  const inserted=[];const lookups=[];
  const database={from(){const filter={};return {select(){return this;},eq(key,value){filter[key]=value;return this;},async maybeSingle(){lookups.push({...filter});return {data:filter.issuer===oldIssuer&&filter.subject==='old-sub'?{user_id:'preserved-application-id'}:null,error:null};},async insert(row){inserted.push(row);return {error:null};}};}};
  const env={BACKEND_PROVIDER:'aws',AWS_REGION:'us-west-2',COGNITO_USER_POOL_ID:'us-west-2_target',COGNITO_CLIENT_ID:'client',COGNITO_LEGACY_ISSUER:oldIssuer};
  const id={sub:'new-sub',email:'developer@example.invalid',email_verified:true,'custom:legacy_issuer':legacyIssuer,'custom:legacy_subject':'old-sub'};
  const service=createAuthenticationService(database,env,{adminClient:{},fetch:async()=>({ok:true,json:async()=>({AuthenticationResult:{IdToken:'id-token',AccessToken:'access-token'}})}),idVerifier:{verify:async()=>id},accessVerifier:{verify:async()=>({sub:'new-sub'})}});
  return {service,inserted,lookups};
}
test('verified migration claims preserve the application id and link the new subject',async()=>{
  const {service,inserted,lookups}=fixture();
  const result=await service.signInWithPassword({email:'developer@example.invalid',password:'not-logged'});
  assert.equal(result.data.user.id,'preserved-application-id');
  assert.equal(inserted[0].subject,'new-sub');
  assert.equal(inserted[0].user_id,'preserved-application-id');
  assert.equal(lookups.some(filter=>'email'in filter),false);
});
test('a different legacy issuer cannot create an identity link',async()=>{
  const {service,inserted}=fixture('https://another-provider.invalid');
  const result=await service.signInWithPassword({email:'developer@example.invalid',password:'not-logged'});
  assert.equal(result.error.status,403);assert.equal(inserted.length,0);
});
test('temporary-password challenge returns no application identity and completes using canonical Cognito username',async()=>{
  const requests=[];
  const env={BACKEND_PROVIDER:'aws',AWS_REGION:'us-west-2',COGNITO_USER_POOL_ID:'us-west-2_target',COGNITO_CLIENT_ID:'client',COGNITO_CLIENT_SECRET:'test-client-secret'};
  const service=createAuthenticationService({},env,{adminClient:{},fetch:async(_url,request)=>{requests.push(JSON.parse(request.body));return {ok:true,json:async()=>({ChallengeName:'NEW_PASSWORD_REQUIRED',Session:'opaque-session',ChallengeParameters:{USER_ID_FOR_SRP:'canonical-user'}})};}});
  const first=await service.signInWithPassword({email:'fixture@example.invalid',password:'temporary'});
  assert.equal(first.data.user,null);assert.equal(first.data.challenge.username,'canonical-user');
  await service.signInWithPassword({email:'fixture@example.invalid',challengeUsername:'canonical-user',challengeSession:'opaque-session',newPassword:'New-test-password-123!'});
  assert.equal(requests[1].ChallengeResponses.USERNAME,'canonical-user');
  assert.equal(requests[1].ChallengeResponses.PASSWORD,undefined);
  assert.equal(requests[1].Session,'opaque-session');
});
