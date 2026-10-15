import { Stack, Duration, CfnOutput, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Data } from './data.js';
import type { Runtime } from './runtime.js';

export class Delivery extends Stack {
  constructor(scope:Construct,id:string,data:Data,runtime:Runtime,props:StackProps){
    super(scope,id,props);
    const route=new cloudfront.Function(this,'StaticRoutes',{runtime:cloudfront.FunctionRuntime.JS_2_0,code:cloudfront.FunctionCode.fromInline(`function handler(event){var r=event.request;var leaf=r.uri.split('/').pop();if(r.uri.endsWith('/'))r.uri+='index.html';else if(leaf.indexOf('.')===-1)r.uri+='/index.html';return r;}`)});
    const web=s3.Bucket.fromBucketName(this,'WebOrigin',data.web.bucketName);
    const distribution=new cloudfront.Distribution(this,'Distribution',{
      comment:id,defaultRootObject:'index.html',minimumProtocolVersion:cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior:{origin:origins.S3BucketOrigin.withOriginAccessControl(web),viewerProtocolPolicy:cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,cachePolicy:cloudfront.CachePolicy.CACHING_OPTIMIZED,responseHeadersPolicy:cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,functionAssociations:[{function:route,eventType:cloudfront.FunctionEventType.VIEWER_REQUEST}]},
      additionalBehaviors:{'api/*':{origin:origins.VpcOrigin.withApplicationLoadBalancer(runtime.alb,{readTimeout:Duration.seconds(120)}),viewerProtocolPolicy:cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,allowedMethods:cloudfront.AllowedMethods.ALLOW_ALL,cachePolicy:cloudfront.CachePolicy.CACHING_DISABLED,originRequestPolicy:cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,responseHeadersPolicy:cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS}},
    });
    new CfnOutput(this,'Url',{value:`https://${distribution.distributionDomainName}`});
    new CfnOutput(this,'DistributionId',{value:distribution.distributionId});
  }
}
