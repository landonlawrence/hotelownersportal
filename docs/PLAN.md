# Implementation Plan & Backlog

This plan is the working backlog for the Hotel Owners Portal. Progress, test evidence and
blockers are tracked in [`PROJECT_STATUS.md`](../PROJECT_STATUS.md). Architecture is described in
[`ARCHITECTURE.md`](ARCHITECTURE.md) and decisions in [`DECISIONS.md`](DECISIONS.md).

## Starting point

The repository was empty when work began (no commits, no project instructions, no existing
infrastructure). Everything below is new. No AWS or Supabase cloud credentials are available in
the build environment, so all cloud work is delivered as infrastructure-as-code, CI/CD workflows
and documentation, and verified locally (CDK synth + assertion tests, local Supabase stack).

## Milestones and acceptance criteria

### M1 — Foundation
Acceptance criteria:
- [x] Monorepo with web app, shared core package, API service, infra (CDK) and test packages.
- [x] Versioned migrations for companies/branding/domains/modules, profiles, memberships,
      roles → permission defaults, permission overrides, properties, room inventory history,
      reporting configuration, ownership groups + property ownership, property access grants,
      support access sessions, audit events.
- [x] Composite foreign keys make it impossible for a row to reference another company's property.
- [x] RLS on every exposed table; permission checks centralised in `app.*` security-definer helpers.
- [x] Supabase Auth sign-in; MFA (TOTP) required for privileged roles before privileged data is
      reachable (`aal2` enforced in policies for privileged permissions).
- [x] Invitations (create/accept), access revocation (membership + property grant), audited.
- [x] Branding resolved from host name (custom domains + local `*.localhost` domains), branded login
      screen, company switcher limited to the user's active memberships.
- [x] Fictional seed data for two management companies, clearly labelled as demo data.
- [x] Tests: cross-company and cross-property denial, revoked access, branding resolution,
      company switching. Security acceptance test: owner with two hotels cannot reach a third via
      UI, API, export or document URL (export/document parts completed in M2/M3 when those surfaces
      exist; test file is extended rather than replaced).

### M2 — Performance
- [x] Standardized daily performance CSV/XLSX format and parser interface.
- [x] Validation (dates, required fields, totals, metric definitions, property mapping).
- [x] Idempotent writes, duplicate file detection, revised report handling with history.
- [x] Property & portfolio dashboards: date/property filters, daily/MTD/YTD/monthly, budget and
      prior-year comparisons, KPI cards, trend chart, comparison table, coverage + freshness.
- [x] KPI maths from summed numerators/denominators; missing ≠ zero; zero denominators safe;
      OOO/comp/inventory/leap-year/business-date rules documented and tested.
- [x] CSV export endpoint authorised through RLS.

### M3 — Financial reporting
- [x] Chart of reporting accounts, source-account mappings preserving original codes/values.
- [x] Budget versions (draft → approved → superseded), manual entry and CSV/XLSX import.
- [x] Monthly actual imports into draft financial reports; draft → review → publish; revisions.
- [x] Actual vs budget and prior year with variance amount/% and commentary.
- [x] Private documents (S3 / local adapter), versions, visibility, quarantine + scan, signed URLs
      issued only after server-side authorisation, download audit events.
- [x] Downloadable financial statements (CSV) honouring publication status.

### M4 — CapEx & owner reporting
- [x] CapEx projects, commitments/actuals, vendors/attachments, management updates.
- [x] Threshold-based approval routing (corporate/owner), duplicate-decision prevention, locked
      approved amounts, full history.
- [x] Management commentary (internal vs owner-visible).
- [x] Monthly reporting packages with publish snapshot + revisions.
- [x] Notifications (in-app + email outbox) to authorised recipients, no sensitive attachments.

### M5 — Automation
- [x] SES inbound email → S3 → route validation → import run → SQS → worker (retries + DLQ).
- [x] Parser adapter registry (standardized CSV/XLSX only; PMS parsers only from real samples).
- [x] Import review tools, retry controls, missing-report alerts (scheduled).
- [x] Integration interfaces for PMS / accounting / Travera (no invented endpoints).

### M6 — Release readiness
- [x] Security verification checklist + automated security suite.
- [x] Backup/restore runbook, observability (logs, metrics, alarms), rollback procedures.
- [x] Staging deployment pipeline (defined; execution blocked until credentials provided), pilot acceptance checklist,
      production deployment documentation.

## Backlog conventions

Each milestone follows: acceptance criteria → implementation → automated tests → UI inspection →
fixes → (staging deploy when authorised) → status update in `PROJECT_STATUS.md`.
