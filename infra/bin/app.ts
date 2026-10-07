#!/usr/bin/env node
/**
 * CDK entry point. Configuration comes from cdk.json context per environment
 * (`-c env=staging|production`). Nothing here creates resources until
 * `cdk deploy` is run with credentials for the target account.
 */
import { App } from 'aws-cdk-lib';
import { resolve } from 'node:path';
import { PortalStack } from '../lib/portal-stack.js';

const app = new App();
const envName = (app.node.tryGetContext('env') ?? 'staging') as 'staging' | 'production';
// HOP_CDK_CONFIG (JSON, set by the deploy pipeline from environment variables) overrides cdk.json.
const override = process.env.HOP_CDK_CONFIG ? (JSON.parse(process.env.HOP_CDK_CONFIG) as Record<string, unknown>) : {};
const cfg = { ...(app.node.tryGetContext(envName) as Record<string, unknown> | undefined), ...override } as Record<string, unknown>;
if (!['staging', 'production'].includes(envName)) throw new Error(`Unknown env "${envName}"`);
const str = (k: string) => (cfg[k] as string | undefined) || undefined;

new PortalStack(app, `HotelOwnersPortal-${envName}`, {
  env: { account: str('account') ?? process.env.CDK_DEFAULT_ACCOUNT, region: str('region') ?? 'us-east-1' },
  envName,
  supabaseUrl: str('supabaseUrl') ?? 'https://REPLACE.supabase.co',
  supabaseAnonKey: str('supabaseAnonKey') ?? 'REPLACE_WITH_PUBLISHABLE_KEY',
  allowedOrigins: (cfg.allowedOrigins as string[] | undefined) ?? [],
  appDomainNames: cfg.appDomainNames as string[] | undefined,
  certificateArn: str('certificateArn'),
  inboundEmailDomain: str('inboundEmailDomain'),
  notificationFromAddress: str('notificationFromAddress'),
  enableMalwareScanning: cfg.enableMalwareScanning === true,
  alarmEmail: str('alarmEmail'),
  lambdaAssetDir: resolve(process.cwd(), '../services/api/dist/lambda'),
  tags: { app: 'hotel-owners-portal', environment: envName },
});
