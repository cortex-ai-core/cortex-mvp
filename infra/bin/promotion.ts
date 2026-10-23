import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { TestPromotionSource } from '../lib/promotion.js';
const app = new App();
if (process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_ACCOUNT !== '909762691423') throw new Error('Wrong promotion source account.');
new TestPromotionSource(app, 'cortex-dev-test-promotion', { env: { account: '909762691423', region: 'us-west-2' }, synthesizer: new BootstraplessSynthesizer() });
