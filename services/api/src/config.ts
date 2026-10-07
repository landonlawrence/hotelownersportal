import { z } from 'zod';

const schema = z.object({
  APP_ENV: z.enum(['local', 'test', 'development', 'staging', 'production']).default('local'),
  SUPABASE_URL: z.string().url(),
  /** Publishable (anon) key — used together with the caller's JWT so RLS applies. */
  SUPABASE_ANON_KEY: z.string().min(10),
  /** Service-role key. Locally from env; in AWS resolved from Secrets Manager at cold start. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional(),
  SUPABASE_SERVICE_ROLE_SECRET_ARN: z.string().optional(),
  /** Only for legacy HS256 projects. Tokens signed with asymmetric keys are verified against the JWKS endpoint. */
  SUPABASE_JWT_SECRET: z.string().optional(),
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  DOCUMENTS_BUCKET: z.string().default('local-documents'),
  SOURCE_FILES_BUCKET: z.string().default('local-source-files'),
  LOCAL_STORAGE_DIR: z.string().default('.local-storage'),
  LOCAL_SIGNING_SECRET: z.string().default('local-dev-signing-secret-change-me'),
  QUEUE_DRIVER: z.enum(['sqs', 'local']).default('local'),
  IMPORT_QUEUE_URL: z.string().optional(),
  SCAN_MODE: z.enum(['guardduty', 'local', 'none']).default('local'),
  EMAIL_DRIVER: z.enum(['ses', 'log']).default('log'),
  EMAIL_FROM_ADDRESS: z.string().default('no-reply@portal.example'),
  INBOUND_EMAIL_DOMAIN: z.string().default('inbound.portal.example'),
  PUBLIC_API_URL: z.string().default('http://localhost:8787'),
  PUBLIC_APP_URL: z.string().default('http://harborview.localhost:5173'),
  /** Comma-separated origin patterns; `*` matches one DNS label. Verified tenant domains are also allowed. */
  ALLOWED_ORIGINS: z.string().default('http://*.localhost:5173,http://localhost:5173,http://127.0.0.1:5173,http://*.localhost:4173'),
  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  MAX_IMPORT_BYTES: z.coerce.number().int().default(15 * 1024 * 1024),
  AWS_REGION: z.string().default('us-east-1'),
  PORT: z.coerce.number().int().default(8787),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const cfg = parsed.data;
  if (cfg.APP_ENV === 'production' || cfg.APP_ENV === 'staging') {
    if (cfg.STORAGE_DRIVER !== 's3') throw new Error('S3 storage is required outside local development');
    if (cfg.QUEUE_DRIVER !== 'sqs') throw new Error('SQS is required outside local development');
  }
  return cfg;
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

export function setConfig(cfg: Config): void {
  cached = cfg;
}
