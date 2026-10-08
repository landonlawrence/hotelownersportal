# Project Status

_Last updated: 2026-10-08. Keep this file current so another session can resume without repeating work._

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

## Test evidence (last full run, 2026-10-08)

| Suite | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean |
| Typecheck (all workspaces) | `npm run typecheck` | clean |
| Core unit | `npm run test -w packages/core` | 57 passed |
| CDK assertions | `npm run test -w infra` | 13 passed |
| CDK synth | `npx cdk synth -c env=staging` / `production` | succeeds |
| Integration (local Supabase, fresh reset) | `npm run test:integration` | 79 passed (8 files) |
| End-to-end (Playwright) | `npm run test:e2e` | 11 passed |
| Web production build | `npm run build -w apps/web` | succeeds; route-level code splitting (initial chunk 376 kB) |

Required verification coverage: cross-company/cross-property denial ✔, direct API and document access ✔, revoked permissions (DB + background job) ✔, draft visibility ✔, portfolio KPI weighting ✔, missing data/zero denominators ✔, budget/variance ✔, duplicate and revised imports ✔, invalid property mappings ✔, publication/revision history ✔, CapEx permissions/thresholds ✔, branding and company switching ✔, security acceptance (UI, API, export, document URL) ✔.

## Round 2 (2026-10-08) — added

- Server-rendered branded PDFs: financial statements (`/exports/financial-reports/:id.pdf`) and owner packages (`/exports/packages/:id.pdf`), authorized as the user, watermarked when unpublished, audited.
- Notification email preferences (per event type; in-app always kept).
- Ingestion management UI: create sources, pause/resume, revision policy, email route with inbound address, allowed senders, SPF/DKIM requirement, token rotation, property code mappings.
- Property administration: create properties (`create_property` RPC), edit details/status, room-inventory changes with history (`set_room_inventory`), KPI conventions (OOO/comp) and report deadlines.
- Optional WAF (production default) with the API routed through CloudFront `/api/*`.
- `scripts/dev-up.sh` one-command local stack; mobile top-bar fix; statement builder moved to `@hop/core`.

## Defects found and fixed during verification

- Default privileges granted new tables to `anon` → default privileges revoked globally; test asserts no `anon` grants and RLS on every table.
- Local Supabase signs sessions with ES256 → API verifies via JWKS (HS256 only for legacy secrets).
- Manually released unscanned files stayed in quarantine → release endpoint promotes the object.
- Host branding was wiped by the initial auth event → only real sign-outs clear the cache.
- Dashboard crashed when switching company (stale placeholder data) → placeholders scoped to company + property set.
- Partial-period revenue totals were compared against full prior-year periods (misleading −60% deltas) → comparisons hidden with an explanation when coverage is incomplete.
- Member list served stale after invitation acceptance → refetch on mount.
- (Round 2) Creating a property via INSERT … RETURNING failed under RLS → `create_property` RPC.
- (Round 2) New onboarding properties made the whole portfolio look "partial" → onboarding/archived properties only count toward coverage when they report.
- (Round 2) Row audits would have copied email-route tokens into audit metadata → secret columns redacted.
- (Round 2) After accepting an invitation the app could show a stale "no access" screen → context refetched before entering; "Check again" button added.

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
2. Log drains from Supabase to CloudWatch (or a SIEM) for a single audit/observability pane.
3. Scheduled delivery of owner-package PDFs to a secure download link (never as attachments).
4. Company-level chart-of-accounts editor and budget templates in the UI (policies exist; currently seeded).
5. PMS / accounting parser adapters once real sample files are supplied (fixtures + tests first); Travera adapter once API access is granted.

## How to resume

```bash
npm install
bash scripts/dev-up.sh
npm run test:integration && npm run test:e2e
```
