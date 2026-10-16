import { Stack, Duration, RemovalPolicy, CfnOutput, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export const centralLogs = {
  account: '747301449112', region: 'us-west-2',
  bucket: 'sollucio-vpc-flowlogs-747301449112-us-west-2',
  prefix: 'vpc-flowlogs', sources: ['909762691423'], retentionDays: 365,
} as const;

export class LogArchive extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope,id,props);
    if(props.env?.account!==centralLogs.account||props.env?.region!==centralLogs.region)throw new Error('Central logs must be created only in SolluCIO Log Archive, Oregon.');
    // A separate bucket keeps workload delivery policies out of Control Tower-owned resources.
    const bucket=new s3.Bucket(this,'VpcLogs',{
      bucketName:centralLogs.bucket,blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,
      encryption:s3.BucketEncryption.S3_MANAGED,versioned:true,enforceSSL:true,
      objectOwnership:s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,removalPolicy:RemovalPolicy.RETAIN,
      lifecycleRules:[{expiration:Duration.days(centralLogs.retentionDays),noncurrentVersionExpiration:Duration.days(centralLogs.retentionDays),abortIncompleteMultipartUploadAfter:Duration.days(7)}],
    });
    for(const account of centralLogs.sources){
      const sourceArn=`arn:aws:logs:${centralLogs.region}:${account}:*`;
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid:`DeliveryAcl${account}`,principals:[new iam.ServicePrincipal('delivery.logs.amazonaws.com')],actions:['s3:GetBucketAcl'],resources:[bucket.bucketArn],
        conditions:{StringEquals:{'aws:SourceAccount':account},ArnLike:{'aws:SourceArn':sourceArn}},
      }));
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid:`DeliveryWrite${account}`,principals:[new iam.ServicePrincipal('delivery.logs.amazonaws.com')],actions:['s3:PutObject'],resources:[bucket.arnForObjects(`${centralLogs.prefix}/AWSLogs/${account}/*`)],
        conditions:{StringEquals:{'aws:SourceAccount':account,'s3:x-amz-acl':'bucket-owner-full-control'},ArnLike:{'aws:SourceArn':sourceArn}},
      }));
    }
    new CfnOutput(this,'FlowLogsDestination',{value:`${bucket.bucketArn}/${centralLogs.prefix}`});
    new CfnOutput(this,'BucketName',{value:bucket.bucketName});
    new CfnOutput(this,'RetentionDays',{value:String(centralLogs.retentionDays)});
  }
}
