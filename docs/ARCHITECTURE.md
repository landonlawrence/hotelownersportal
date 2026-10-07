# Architecture

## Overview

```
                    ┌──────────────────────────── Browser (React SPA) ─────────────────────────────┐
                    │  host → resolve_branding()  ·  Supabase Auth session (JWT, optional TOTP MFA) │
                    └───────────────┬───────────────────────────────────────────┬──────────────────┘
                     reads/RPC with user JWT (RLS)                 user JWT (Bearer)
                                    │                                           │
                 ┌──────────────────▼──────────────────┐        ┌───────────────▼────────────────┐
                 │ Supabase (per environment)          │        │ AWS API Gateway (HTTP) → Lambda │
                 │  Postgres + RLS + RPC (PostgREST)   │◀───────│  documents · imports · exports  │
                 │  Auth (JWKS ES256, TOTP MFA)        │ user   │  invitations · release          │
                 └──────────────────▲──────────────────┘ JWT /  └──────┬───────────────┬─────────┘
                                    │                    service       │ presigned URLs │ SQS
                       svc_* RPCs (service role,         role          │                │
                       explicit authorization)                  ┌──────▼─────┐   ┌──────▼──────┐
                 ┌──────────────────┴──────────────────┐        │ S3 (KMS)    │   │ SQS + DLQ   │
                 │ Worker Lambda (SQS)                  │◀──────│ documents   │   └──────┬──────┘
                 │  import pipeline · scan follow-up    │       │ source files│          │
                 └──────────────────▲──────────────────┘        └──────▲──────┘          │
   SES inbound → S3 → Email Lambda ─┘   GuardDuty Malware Protection ──┘   EventBridge Scheduler
                                        → EventBridge → Scan Lambda        → missing reports, email dispatch
```

## Components and responsibilities

| Component | Location | Responsibility |
|---|---|---|
| Web app | `apps/web` | Branded SPA. Reads data directly from Supabase with the user's session; every query is filtered by RLS. Calls the AWS API for files, imports, exports and invitations. Holds **no** secrets (publishable key only). |
| Core library | `packages/core` | Pure TypeScript: KPI maths, coverage, freshness, variance, CapEx funds/approval routing, CSV parsing, standardized parsers, permission catalogue, formatting. Shared by web, API and workers so every surface computes identical numbers. |
| Supabase Postgres | `supabase/migrations` | System of record. RLS on every table. Permission engine in schema `app` (not exposed). Workflow RPCs (publish, approve, revise) enforce state machines, immutability and audit. |
| Supabase Auth | managed | Email/password sessions, TOTP MFA (`aal2`), invitations accepted against the authenticated email. |
| API Lambda | `services/api/src/routes` | Verifies the Supabase JWT (JWKS), re-authorizes every request as the user (RLS + `check_permission`), issues short-lived presigned S3 URLs, accepts import uploads, produces branded CSV exports, sends invitations. |
| Worker Lambda | `services/api/src/ingestion/pipeline.ts` | Processes import runs from SQS: re-checks requester permissions, parses, validates, detects revisions, writes idempotently with history, records lineage and notifications. Partial batch failures → retries → DLQ. |
| Email Lambda | `services/api/src/ingestion/email.ts` | SES receipt: route token → allowed sender → SPF/DKIM verdict → attachments → intake. |
| Scan Lambda | `services/api/src/documents/scan.ts` | GuardDuty scan result → content-signature check → promote `quarantine/` → `clean/`, or mark infected/error. |
| Scheduler Lambda | `services/api/src/lambda/scheduler.ts` | Hourly missing-report detection; 5-minute notification email dispatch (no attachments, no figures). |
| Infra | `infra/` | AWS CDK stack per environment. |

## Data flows

**Daily performance import (email):** SES → raw MIME in `InboundEmail` bucket → Email Lambda validates route/sender/auth → original attachment stored in `SourceFiles` (SHA-256, lineage row) → duplicate check → `import_runs` row → SQS → Worker parses with the route's property mappings → issues recorded → dry-run write detects revised values → `needs_review` or idempotent write with `daily_performance_revisions` history → alerts resolved, notifications created.

**Document upload:** `POST /documents/uploads` → `create_document_upload` RPC (as user: permission, type, size, visibility) → presigned POST into `quarantine/` (content-length range, content type) → `POST /complete` (uploader only; size + SHA-256) → scan → `clean/` → `documents.current_version_id` updated → visible to authorized viewers.

**Document download:** `GET /documents/versions/:id/download` → `authorize_document_download` RPC as user (visibility permission, status, scan state; audited) → presigned GET (60 s, attachment disposition). Unauthorized and nonexistent are indistinguishable (404).

**Financial publication:** import or manual lines → draft report → `submit` → `in_review` (lines frozen) → `publish` (requires `financials.publish`, supersedes prior revision, notifies `financials.view` holders) → corrections via `create_financial_report_revision` (new draft, prior stays visible until republished).

## Tenancy model

One shared application and database. Every business row carries `company_id`; property-scoped rows carry `property_id` and a composite foreign key to `properties(id, company_id)`. Branding is resolved from the host name (verified domains only) and only affects presentation. The active company in the UI is a convenience; authorization never depends on it.

## Local development topology

`supabase start` (Docker) provides Postgres/Auth/PostgREST on `127.0.0.1:54321`. The API runs as a Node server (`services/api`, esbuild bundle) with the local filesystem storage driver (HMAC-signed URLs that mimic S3 presigning), an in-process queue with retries and a dead-letter list, and the local signature scanner. Vite serves the SPA on `*.localhost:5173` so tenant branding can be tested without DNS.
