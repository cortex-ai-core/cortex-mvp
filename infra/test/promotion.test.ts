import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { TestPromotionSource } from '../lib/promotion.js';
test('promotion source has ECR read-only access and exact backend Test-branch trust',()=>{
 const template=Template.fromStack(new TestPromotionSource(new App(),'promotion',{env:{account:'909762691423',region:'us-west-2'}}));
 const role=Object.values(template.findResources('AWS::IAM::Role'))[0];
 assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'],'repo:cortex-ai-core/cortex-mvp:ref:refs/heads/test');
 const policies=Object.values(template.findResources('AWS::IAM::Policy'));
 assert.ok(JSON.stringify(policies).includes('cortex-dev-parser'));
 assert.ok(!JSON.stringify(policies).match(/ecr:(Put|Upload|Delete|Initiate|Complete)/));
 assert.throws(()=>new TestPromotionSource(new App(),'wrong',{env:{account:'223323955607',region:'us-west-2'}}));
});
