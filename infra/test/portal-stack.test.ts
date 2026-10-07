import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { PortalStack } from '../lib/portal-stack';

let template: Template;
let minimal: Template;

function assets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hop-lambda-'));
  for (const n of ['api', 'worker', 'emailReceiver', 'scanResult', 'scheduler']) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, 'index.mjs'), 'export const handler = async () => ({});');
  }
  return dir;
}

beforeAll(() => {
  const base = {
    env: { account: '111111111111', region: 'us-east-1' },
    supabaseUrl: 'https://example-staging.supabase.co',
    supabaseAnonKey: 'sb_publishable_test',
    allowedOrigins: ['https://owners.example.com'],
    lambdaAssetDir: assets(),
  };
  template = Template.fromStack(new PortalStack(new App(), 'Full', { ...base, envName: 'production', inboundEmailDomain: 'inbound.example.com', notificationFromAddress: 'no-reply@example.com', enableMalwareScanning: true, alarmEmail: 'ops@example.com' }));
  minimal = Template.fromStack(new PortalStack(new App(), 'Min', { ...base, envName: 'staging', enableMalwareScanning: false }));
});

describe('storage security', () => {
  it('every bucket blocks public access and enforces TLS', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(5);
    for (const b of Object.values(buckets)) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    }
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const ssl = Object.values(policies).filter((p) => JSON.stringify(p).includes('aws:SecureTransport'));
    expect(ssl.length).toBe(Object.keys(buckets).length);
  });

  it('document, source and email buckets use the customer-managed KMS key', () => {
    template.resourcePropertiesCountIs('AWS::S3::Bucket', { BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: Match.anyValue() } })] } }, 3);
  });

  it('quarantined uploads expire automatically', () => {
    template.hasResourceProperties('AWS::S3::Bucket', { LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'quarantine/', ExpirationInDays: 30 })]) } });
  });
});

describe('processing', () => {
  it('import queue has a dead-letter queue with bounded retries', () => {
    template.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() } });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { FunctionResponseTypes: ['ReportBatchItemFailures'] });
  });

  it('the service-role key is never in Lambda environment variables (only a secret reference)', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    for (const f of Object.values(fns)) {
      const env = (f.Properties.Environment?.Variables ?? {}) as Record<string, unknown>;
      expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      if (env.SUPABASE_URL) expect(env.SUPABASE_SERVICE_ROLE_SECRET_ARN).toBeDefined();
    }
  });

  it('schedules missing-report checks and notification dispatch', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(1 hour)', Target: Match.objectLike({ Input: '{"task":"missing-reports"}' }) });
    template.hasResourceProperties('AWS::Scheduler::Schedule', { Target: Match.objectLike({ Input: '{"task":"dispatch-notifications"}' }) });
  });

  it('inbound email stores raw mail before invoking the receiver, with TLS and spam/virus scanning', () => {
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: Match.objectLike({ ScanEnabled: true, TlsPolicy: 'Require', Recipients: ['inbound.example.com'], Actions: [Match.objectLike({ S3Action: Match.anyValue() }), Match.objectLike({ LambdaAction: Match.anyValue() })] }),
    });
  });

  it('malware protection scans only the quarantine prefix', () => {
    template.hasResourceProperties('AWS::GuardDuty::MalwareProtectionPlan', { ProtectedResource: { S3Bucket: { ObjectPrefixes: ['quarantine/'] } } });
    template.hasResourceProperties('AWS::Events::Rule', { EventPattern: Match.objectLike({ 'detail-type': ['GuardDuty Malware Protection Object Scan Result'] }) });
  });

  it('optional paid features are absent unless enabled', () => {
    minimal.resourceCountIs('AWS::GuardDuty::MalwareProtectionPlan', 0);
    minimal.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    const fns = minimal.findResources('AWS::Lambda::Function');
    const api = Object.values(fns).find((f) => f.Properties.Environment?.Variables?.SCAN_MODE);
    expect(api!.Properties.Environment.Variables.SCAN_MODE).toBe('none');
  });
});

describe('edge and monitoring', () => {
  it('CloudFront enforces HTTPS, security headers and private origin access', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }) }) });
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', { ResponseHeadersPolicyConfig: Match.objectLike({ SecurityHeadersConfig: Match.objectLike({ FrameOptions: { FrameOption: 'DENY', Override: true } }) }) });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('alarms cover the DLQ, API errors and the worker', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmDescription: Match.stringLikeRegexp('DLQ') });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmDescription: 'API Lambda errors' });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmDescription: 'Import worker errors' });
  });

  it('API is throttled and access-logged', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 }, AccessLogSettings: Match.anyValue() });
  });
});
