# Project Status

_Last updated: 2026-10-07. Keep this file current so another session can resume without repeating work._

## Summary

All six milestones are implemented and verified **locally**. No cloud deployment has happened — no AWS or Supabase cloud credentials or deployment authorization were available. Cloud steps are fully scripted (CDK + GitHub Actions) and documented, and are blocked only on credentials/approval (see "Blocked").

## Milestones

| Milestone | Status | Evidence |
|---|---|---|
| M1 Foundation — auth, branding, memberships, properties, ownership, permissions, migrations, seed | ✅ Done (local) | `foundation.test.ts` (23), `security-acceptance.test.ts` (7), e2e security + branding |
| M2 Performance — validated imports, dashboards, KPI maths, freshness | ✅ Done (local) | core `kpi/dates/freshness/ingestion` tests, `performance.test.ts`, `imports.test.ts`, e2e dashboard |
| M3 Financial reporting — budgets, actuals, mappings, variance, documents, publish workflow | ✅ Done (local) | `financials.test.ts`, `documents.test.ts`, e2e publish |
| M4 CapEx & owner reporting — projects, approvals, commentary, packages, notifications | ✅ Done (local) | `capex-packages.test.ts`, e2e owner approval |
| M5 Automation — email ingestion, parser adapters, queue/retries/DLQ, review tools, missing-report alerts | ✅ Done (local); SES/SQS/GuardDuty defined in CDK | `imports.test.ts` (email routing, retries, revocation at processing time, alerts), CDK assertions |
| M6 Release readiness — security verification, backup/restore, observability, staging pipeline, pilot checks, prod docs | ✅ Documented and automated; ⛔ staging deploy blocked on credentials | `docs/SECURITY.md`, `docs/OPERATIONS.md`, `docs/DEPLOYMENT.md`, `docs/PILOT_ACCEPTANCE.md`, `.github/workflows/*` |

## Test evidence (last full run, 2026-10-07)

| Suite | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean |
| Typecheck (all workspaces) | `npm run typecheck` | clean |
| Core unit | `npm run test -w packages/core` | 56 passed |
| CDK assertions | `npm run test -w infra` | 12 passed |
| CDK synth | `npx cdk synth -c env=staging` / `production` | succeeds |
| Integration (local Supabase, fresh reset) | `npm run test:integration` | 70 passed (7 files) |
| End-to-end (Playwright) | `npm run test:e2e` | 8 passed |
| Web production build | `npm run build -w apps/web` | succeeds; route-level code splitting (initial chunk 376 kB) |

Required verification coverage: cross-company/cross-property denial ✔, direct API and document access ✔, revoked permissions (DB + background job) ✔, draft visibility ✔, portfolio KPI weighting ✔, missing data/zero denominators ✔, budget/variance ✔, duplicate and revised imports ✔, invalid property mappings ✔, publication/revision history ✔, CapEx permissions/thresholds ✔, branding and company switching ✔, security acceptance (UI, API, export, document URL) ✔.

## Defects found and fixed during verification

- Default privileges granted new tables to `anon` → default privileges revoked globally; test asserts no `anon` grants and RLS on every table.
- Local Supabase signs sessions with ES256 → API verifies via JWKS (HS256 only for legacy secrets).
- Manually released unscanned files stayed in quarantine → release endpoint promotes the object.
- Host branding was wiped by the initial auth event → only real sign-outs clear the cache.
- Dashboard crashed when switching company (stale placeholder data) → placeholders scoped to company + property set.
- Partial-period revenue totals were compared against full prior-year periods (misleading −60% deltas) → comparisons hidden with an explanation when coverage is incomplete.
- Member list served stale after invitation acceptance → refetch on mount.

## Blocked (needs owner action)

1. **Cloud credentials & authorization:** AWS account + GitHub OIDC deploy role; separate Supabase projects for staging and production; GitHub environment variables/secrets listed in `docs/DEPLOYMENT.md`. Staging auto-deploy is disabled until `STAGING_ENABLED=true`.
2. **Production release authorization** (manual dispatch + environment reviewers).
2. **Domains:** inbound email domain (MX → SES), verified SES sending identity, ACM certificate and DNS for tenant custom domains.
3. **Real PMS / accounting sample reports** before implementing vendor-specific parsers; **Travera** API documentation/access before implementing its adapter.
4. **Policy decisions to confirm with the business:** CapEx thresholds per company; whether owners should see confidential (loan/bank) documents by default (currently no); MFA requirement for owners approving CapEx (currently required when the company enforces MFA).

## Assumptions in effect

See `docs/DECISIONS.md` (single currency per company, calendar fiscal year default, OOO excluded / comps excluded by default, remaining funds = approved − actual − open commitments, etc.).

## Next tasks (suggested order)

1. Provision staging (Supabase project + AWS account), run the Deploy workflow, execute `docs/PILOT_ACCEPTANCE.md`.
3. Server-rendered branded PDF exports for statements and owner packages (currently browser print view + CSV).
4. Notification preferences UI (table and API already exist).
5. Ingestion source/route management UI (currently seeded/SQL; read-only list in UI).
5. Property and room-inventory management UI for company admins (policies exist; UI is read-only).
6. WAF for CloudFront/API in production; log drains from Supabase to CloudWatch.
7. PMS parser adapters once real sample files are supplied (fixtures + tests first).

## How to resume

```bash
npm install
SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npm run db:start   # registry var only if public.ecr.aws is blocked
npm run db:reset
npm run test:integration && npm run test:e2e
```
