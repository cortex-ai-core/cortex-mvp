import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

if (process.env.AWS_REGION !== 'us-west-2' || !process.env.CORTEX_ACCOUNT_ID) throw new Error('Explicit Oregon account configuration required.');
const sts = new STSClient({ region: 'us-west-2' });
const identity = await sts.send(new GetCallerIdentityCommand({}));
sts.destroy();
if (identity.Account !== process.env.CORTEX_ACCOUNT_ID) throw new Error('AWS account mismatch.');
const cognito = new CognitoIdentityProviderClient({ region: 'us-west-2' });
const result = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: process.env.COGNITO_USER_POOL_ID, ClientId: process.env.COGNITO_CLIENT_ID }));
process.env.COGNITO_CLIENT_SECRET = result.UserPoolClient.ClientSecret;
cognito.destroy();
process.env.CORTEX_ENV = 'aws';
await import('../../server.js');
