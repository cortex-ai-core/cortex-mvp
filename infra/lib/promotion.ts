import { Stack, CfnOutput, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

// A separate stack adds source-read permissions without changing the running Dev foundation.
export class TestPromotionSource extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    if (props.env?.account !== '909762691423' || props.env?.region !== 'us-west-2') throw new Error('Promotion source must be the Dev account in Oregon.');
    super(scope, id, props);
    const role = new iam.Role(this, 'Reader', {
      roleName: 'cortex-dev-promotion-cortex-mvp',
      assumedBy: new iam.FederatedPrincipal('arn:aws:iam::909762691423:oidc-provider/token.actions.githubusercontent.com', { StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': 'repo:cortex-ai-core/cortex-mvp:ref:refs/heads/test',
      } }, 'sts:AssumeRoleWithWebIdentity'),
    });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability', 'ecr:DescribeImages'],
      resources: ['api', 'parser', 'postgrest'].map(name => `arn:aws:ecr:us-west-2:909762691423:repository/cortex-dev-${name}`) }));
    new CfnOutput(this, 'ReaderRole', { value: role.roleArn });
  }
}
