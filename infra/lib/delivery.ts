import { Stack, Duration, CfnOutput, SecretValue, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Data } from './data.js';
import type { Runtime } from './runtime.js';
import { originHeader, type PublicEdge } from './edge.js';

export class Delivery extends Stack {
  constructor(scope:Construct,id:string,data:Data,runtime:Runtime,props:StackProps & { edge?: PublicEdge }){
    super(scope,id,props);
    const edge=props.edge;
    const route=new cloudfront.Function(this,'StaticRoutes',{runtime:cloudfront.FunctionRuntime.JS_2_0,code:cloudfront.FunctionCode.fromInline(`function handler(event){var r=event.request;var leaf=r.uri.split('/').pop();if(r.uri.endsWith('/'))r.uri+='index.html';else if(leaf.indexOf('.')===-1)r.uri+='/index.html';return r;}`)});
    const web=s3.Bucket.fromBucketName(this,'WebOrigin',data.web.bucketName);
    // An attached VPC origin cannot be updated. Give this corrected endpoint a
    // new resource identity, then switch the distribution before retiring the old origin.
    const apiOrigin=new cloudfront.VpcOrigin(this,'PrivateHttpOriginV1',{
      endpoint:cloudfront.VpcOriginEndpoint.applicationLoadBalancer(runtime.alb),
      protocolPolicy:cloudfront.OriginProtocolPolicy.HTTP_ONLY,httpPort:80,
    });
    // The private VPC origin stays defined after the switch so it can be retired in a separate reviewed cleanup.
    // The public origin's hostname matches its ALB certificate; CloudFront sends that hostname as Host.
    const api=edge?.apiOrigin==='public'
      ?new origins.HttpOrigin(edge.originDomain,{protocolPolicy:cloudfront.OriginProtocolPolicy.HTTPS_ONLY,originSslProtocols:[cloudfront.OriginSslPolicy.TLS_V1_2],readTimeout:Duration.seconds(120),customHeaders:{[originHeader]:SecretValue.secretsManager(edge.originSecretName).unsafeUnwrap()}})
      :origins.VpcOrigin.withVpcOrigin(apiOrigin,{readTimeout:Duration.seconds(120)});
    const distribution=new cloudfront.Distribution(this,'Distribution',{
      comment:id,defaultRootObject:'index.html',minimumProtocolVersion:cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(edge?{domainNames:[edge.viewerDomain],certificate:acm.Certificate.fromCertificateArn(this,'ViewerCertificate',edge.viewerCertificateArn)}:{}),
      defaultBehavior:{origin:origins.S3BucketOrigin.withOriginAccessControl(web),viewerProtocolPolicy:cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,cachePolicy:cloudfront.CachePolicy.CACHING_OPTIMIZED,responseHeadersPolicy:cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,functionAssociations:[{function:route,eventType:cloudfront.FunctionEventType.VIEWER_REQUEST}]},
      // The interim private ALB listens on HTTP. Keep viewer HTTPS and make each
      // origin hop explicit; MATCH_VIEWER would select the private ALB's absent HTTPS listener.
      additionalBehaviors:{'api/*':{origin:api,viewerProtocolPolicy:cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,allowedMethods:cloudfront.AllowedMethods.ALLOW_ALL,cachePolicy:cloudfront.CachePolicy.CACHING_DISABLED,originRequestPolicy:cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,responseHeadersPolicy:cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS}},
    });
    new CfnOutput(this,'Url',{value:`https://${distribution.distributionDomainName}`});
    new CfnOutput(this,'DistributionId',{value:distribution.distributionId});
    if(edge)new CfnOutput(this,'ViewerUrl',{value:`https://${edge.viewerDomain}`});
  }
}
