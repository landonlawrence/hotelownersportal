# Operations: Backups, Observability and Runbooks

## Backup and restore

| Data | Mechanism | Restore |
|---|---|---|
| Postgres (all structured data) | Supabase daily backups; enable **Point-in-Time Recovery** add-on for production (RPO minutes). | Supabase dashboard → Database → Backups → restore to a timestamp (restores the whole project; schedule a maintenance window), or restore into a **new** project and copy affected rows with `pg_dump --data-only -t <table>`. |
| Logical exports | Nightly `pg_dump` from CI or a scheduled job into a versioned, KMS-encrypted S3 bucket in a separate account (recommended for production). | `pg_restore` into a scratch project, verify, then copy. |
| Documents / source files | S3 versioning (+ noncurrent retention: 7 years production), KMS, `RETAIN` on stack deletion. Optional cross-region replication. | Restore a prior object version (`aws s3api list-object-versions` / `copy-object`). Database rows reference keys, so restoring an object version is non-destructive. |
| Raw inbound email | 400-day retention in `InboundEmail` bucket. | Re-run ingestion by re-invoking the email Lambda with the stored message id. |
| Infrastructure | CDK source in git. | `cdk deploy` the tagged version. |

**Restore drill (quarterly):** restore the latest production backup into a scratch Supabase project, run `npm run test:integration`-style smoke queries (row counts per table, latest business dates, a published report statement), record duration and gaps in the status file.

## Observability

- **Logs:** structured JSON from Lambdas (request id, level, message) in CloudWatch Logs (1 year production). API Gateway access logs include request id, path, status, latency. Supabase logs (Postgres, Auth, PostgREST) in the Supabase dashboard / log drains.
- **Tracing:** X-Ray active tracing on all Lambdas.
- **Alarms (SNS → email):** DLQ not empty; API Lambda errors; API 5xx; worker errors; scheduler errors; oldest import message > 15 min.
- **Product signals:** `ingestion_alerts` (missing reports), import runs in `failed`/`needs_review`, documents stuck in `pending` scan, `notification_outbox` rows in `failed`.

Useful queries:
```sql
-- imports needing attention
select company_id, status, count(*) from import_runs where status in ('failed','needs_review') group by 1,2;
-- scans not completed after 1 hour
select id, company_id, created_at from document_versions where scan_status = 'pending' and upload_completed_at < now() - interval '1 hour';
-- notification emails failing
select status, count(*) from notification_outbox group by 1;
```

## Runbooks

### DLQ alarm
1. Inspect messages: `aws sqs receive-message --queue-url <dlq> --max-number-of-messages 10`.
2. Each body is `{type, importRunId|versionId}`; look up `import_runs.last_error`.
3. Fix the cause (bad deploy → rollback; Supabase outage → wait).
4. Retry from the UI (Data imports → Retry) or redrive: `aws sqs start-message-move-task --source-arn <dlq-arn>`. Handlers are idempotent (runs are claimed only from `queued`).

### Missing daily report
1. Data imports → Missing reports shows the property and business date.
2. Confirm with the property whether the PMS export was sent; check `audit_events` for `ingestion.email_rejected` (unknown sender, failed SPF/DKIM).
3. Upload the file manually if needed. The alert resolves automatically when the date is loaded.

### Suspected unauthorized access
1. Revoke the membership (Administration → Users → Revoke) — effective immediately.
2. Query `audit_events` for the user (`actor_user_id`) including `document.download_*` and `export.*`.
3. Rotate the user's password / revoke sessions in Supabase Auth.
4. If service credentials may be exposed: rotate the Supabase service-role key (Supabase → API keys), update the Secrets Manager value, and redeploy (Lambdas re-read on cold start; force with a config change).

### Support request needing data access
Platform admin (with MFA) opens a support session from the Platform tab with ticket and reason (max 8 h). Company admins see it under Administration → Support access and can end it. All access is audited with `actor_kind = support`.

### Revised PMS report
Daily sources configured with `revision_policy = replace` apply revisions automatically, keeping prior values in `daily_performance_revisions`. Otherwise the run is `needs_review`; review the changed values and approve or reject.

### Key rotation
- Supabase JWT signing keys: rotate in Supabase; the API fetches JWKS automatically.
- KMS: automatic annual rotation enabled.
- Service-role key: see above.
