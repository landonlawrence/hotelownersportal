# Deployment Guide

> **Status:** No AWS or Supabase cloud credentials were available while building this project. Nothing has been deployed. Everything below is ready to execute once the accounts/projects exist and deployment is authorized. Production releases require explicit release authorization.

## Environments

| Environment | Supabase | AWS | Data | Deploy trigger |
|---|---|---|---|---|
| local | `supabase start` (Docker) | none (local adapters) | fictional demo seed | developer |
| staging | dedicated Supabase project | dedicated account or stack `HotelOwnersPortal-staging` | fictional/anonymised only — **never production financial data** | automatic after green CI on `main` when `vars.STAGING_ENABLED == 'true'` |
| production | dedicated Supabase project | dedicated account recommended, stack `HotelOwnersPortal-production` | live | manual `workflow_dispatch` + GitHub environment approval |

The demo seed (`supabase/seeds/*`) is only loaded by `supabase db reset` locally. Remote deploys use `supabase db push` (migrations only).

## One-time setup (per environment)

1. **Supabase project** — create a project in the region closest to users. Settings:
   - Auth → enable TOTP MFA; disable public sign-ups (users join via invitation); set Site URL to the primary portal domain and add each tenant domain to redirect URLs; configure SMTP for auth emails.
   - Use asymmetric JWT signing keys (default for new projects). The API verifies via `/auth/v1/.well-known/jwks.json`.
   - Note: project ref, URL, publishable key, service-role key, DB password.
2. **AWS account** — bootstrap CDK: `npx cdk bootstrap aws://<account>/us-east-1`.
3. **GitHub OIDC deploy role** — IAM role trusted for `token.actions.githubusercontent.com` restricted to this repo and the `staging`/`production` environments, with permission to assume the CDK bootstrap roles.
4. **GitHub environments** `staging` and `production` (production with required reviewers). Variables / secrets:

| Name | Type | Example |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | var | `arn:aws:iam::123456789012:role/hop-github-deploy` |
| `AWS_REGION` | var | `us-east-1` |
| `SUPABASE_PROJECT_REF` | var | `abcd1234` |
| `SUPABASE_URL` | var | `https://abcd1234.supabase.co` |
| `SUPABASE_ANON_KEY` | var | publishable key (browser-safe) |
| `CDK_CONTEXT_JSON` | var | `{"account":"123456789012","supabaseUrl":"…","supabaseAnonKey":"…","allowedOrigins":["https://owners.example.com"],"appDomainNames":["owners.example.com"],"certificateArn":"arn:aws:acm:us-east-1:…","inboundEmailDomain":"inbound.example.com","notificationFromAddress":"no-reply@example.com","enableMalwareScanning":true,"enableWaf":true,"alarmEmail":"ops@example.com"}` |
| `SUPABASE_ACCESS_TOKEN` | secret | Supabase personal access token (deploy only) |
| `SUPABASE_DB_PASSWORD` | secret | database password (deploy only) |
| `STAGING_ENABLED` | repo var | `true` to enable automatic staging deploys |

5. **First deploy**, then set the service-role key **out of band** (never in GitHub or the browser):
   ```bash
   aws secretsmanager put-secret-value --secret-id hop/<env>/supabase-service-role-key --secret-string '<service-role key>'
   ```
6. **SES** (optional, enables email ingestion and notification email):
   - Verify the sending domain (DKIM) and request production access.
   - Point `MX` for `inboundEmailDomain` to `inbound-smtp.<region>.amazonaws.com`.
   - Activate the receipt rule set (only one can be active per account/region): `aws ses set-active-receipt-rule-set --rule-set-name hop-<env>-inbound`.
7. **Custom domains** — issue an ACM certificate in `us-east-1` covering the portal domains; add `appDomainNames` + `certificateArn`; point DNS (CNAME/ALIAS) at the CloudFront distribution; insert/verify rows in `company_domains` (platform admin) after confirming the DNS TXT token.
8. **Bootstrap the first platform admin** (SQL editor, once): `insert into public.platform_admins (user_id) values ('<auth user id>');` then provision companies from the Platform tab.

## WAF and API routing

With `enableWaf: true` (default in the production context) the stack creates a CloudFront-scoped web ACL (per-IP rate limit, AWS IP reputation list, common rule set, known bad inputs) and serves the API through CloudFront at `/api/*`, because API Gateway HTTP APIs cannot attach WAF directly. The deploy workflow then builds the SPA with `VITE_API_URL=https://<portal domain>/api` (stack output `ProtectedApiUrl`). The stack must be in `us-east-1` for CloudFront-scoped WAF.

## Required environment variables

### API / workers (set by CDK)
| Variable | Purpose |
|---|---|
| `APP_ENV` | `staging` / `production` (enforces S3 + SQS drivers) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase project (anon key used with user JWT → RLS) |
| `SUPABASE_SERVICE_ROLE_SECRET_ARN` | Secrets Manager reference (value never in env) |
| `DOCUMENTS_BUCKET`, `SOURCE_FILES_BUCKET` | private buckets |
| `IMPORT_QUEUE_URL` | SQS queue |
| `SCAN_MODE` | `guardduty` or `none` (none ⇒ manual release required) |
| `EMAIL_DRIVER`, `EMAIL_FROM_ADDRESS` | `ses`/`log` |
| `INBOUND_EMAIL_DOMAIN` | `reports+<token>@<domain>` routing |
| `ALLOWED_ORIGINS` | static CORS patterns (verified tenant domains are allowed dynamically) |

### Web (build time)
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL` — public values only.

## Release procedure

1. Merge to `main`; CI must be green (lint, typecheck, unit, integration, e2e, CDK synth).
2. Staging deploys automatically (if enabled). Run the pilot acceptance checklist (`docs/PILOT_ACCEPTANCE.md`) against staging with fictional data.
3. Tag the release (`vX.Y.Z`). Review `cdk diff -c env=production` output and pending migrations (`supabase db diff --linked`).
4. Dispatch **Deploy** with `environment=production`, `ref=vX.Y.Z`; a required reviewer approves the GitHub environment.
5. Smoke test: `/health`, sign-in, one owner dashboard, one document download; check alarms are quiet.

## Rollback

| Layer | Procedure |
|---|---|
| Web app | Re-run Deploy for the previous tag (re-syncs the previous build) or restore the previous object versions in the versioned web bucket; invalidate `/index.html`. |
| Lambda/API/infra | Re-run Deploy with the previous tag (`cdk deploy` converges to the prior template). Buckets, KMS key and secret are retained on stack changes. |
| Database | Migrations are forward-only. Write a compensating migration and deploy it; for data corruption use Supabase point-in-time recovery (see `docs/OPERATIONS.md`). Never edit an applied migration. |
| Bad import | Approve/reject flow keeps prior values in `daily_performance_revisions` / prior financial report revisions; re-import corrected data or restore the prior revision through a corrective import. |

Database-first compatibility rule: each migration must remain compatible with the previously deployed application version so the app can roll back independently.
