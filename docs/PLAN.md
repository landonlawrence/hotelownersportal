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
- [ ] Monorepo with web app, shared core package, API service, infra (CDK) and test packages.
- [ ] Versioned migrations for companies/branding/domains/modules, profiles, memberships,
      roles → permission defaults, permission overrides, properties, room inventory history,
      reporting configuration, ownership groups + property ownership, property access grants,
      support access sessions, audit events.
- [ ] Composite foreign keys make it impossible for a row to reference another company's property.
- [ ] RLS on every exposed table; permission checks centralised in `app.*` security-definer helpers.
- [ ] Supabase Auth sign-in; MFA (TOTP) required for privileged roles before privileged data is
      reachable (`aal2` enforced in policies for privileged permissions).
- [ ] Invitations (create/accept), access revocation (membership + property grant), audited.
- [ ] Branding resolved from host name (custom domains + local `*.localhost` domains), branded login
      screen, company switcher limited to the user's active memberships.
- [ ] Fictional seed data for two management companies, clearly labelled as demo data.
- [ ] Tests: cross-company and cross-property denial, revoked access, branding resolution,
      company switching. Security acceptance test: owner with two hotels cannot reach a third via
      UI, API, export or document URL (export/document parts completed in M2/M3 when those surfaces
      exist; test file is extended rather than replaced).

### M2 — Performance
- [ ] Standardized daily performance CSV/XLSX format and parser interface.
- [ ] Validation (dates, required fields, totals, metric definitions, property mapping).
- [ ] Idempotent writes, duplicate file detection, revised report handling with history.
- [ ] Property & portfolio dashboards: date/property filters, daily/MTD/YTD/monthly, budget and
      prior-year comparisons, KPI cards, trend chart, comparison table, coverage + freshness.
- [ ] KPI maths from summed numerators/denominators; missing ≠ zero; zero denominators safe;
      OOO/comp/inventory/leap-year/business-date rules documented and tested.
- [ ] CSV export endpoint authorised through RLS.

### M3 — Financial reporting
- [ ] Chart of reporting accounts, source-account mappings preserving original codes/values.
- [ ] Budget versions (draft → approved → superseded), manual entry and CSV/XLSX import.
- [ ] Monthly actual imports into draft financial reports; draft → review → publish; revisions.
- [ ] Actual vs budget and prior year with variance amount/% and commentary.
- [ ] Private documents (S3 / local adapter), versions, visibility, quarantine + scan, signed URLs
      issued only after server-side authorisation, download audit events.
- [ ] Downloadable financial statements (CSV) honouring publication status.

### M4 — CapEx & owner reporting
- [ ] CapEx projects, commitments/actuals, vendors/attachments, management updates.
- [ ] Threshold-based approval routing (corporate/owner), duplicate-decision prevention, locked
      approved amounts, full history.
- [ ] Management commentary (internal vs owner-visible).
- [ ] Monthly reporting packages with publish snapshot + revisions.
- [ ] Notifications (in-app + email outbox) to authorised recipients, no sensitive attachments.

### M5 — Automation
- [ ] SES inbound email → S3 → route validation → import run → SQS → worker (retries + DLQ).
- [ ] Parser adapter registry (standardized CSV/XLSX only; PMS parsers only from real samples).
- [ ] Import review tools, retry controls, missing-report alerts (scheduled).
- [ ] Integration interfaces for PMS / accounting / Travera (no invented endpoints).

### M6 — Release readiness
- [ ] Security verification checklist + automated security suite.
- [ ] Backup/restore runbook, observability (logs, metrics, alarms), rollback procedures.
- [ ] Staging deployment pipeline (blocked until credentials provided), pilot acceptance checklist,
      production deployment documentation.

## Backlog conventions

Each milestone follows: acceptance criteria → implementation → automated tests → UI inspection →
fixes → (staging deploy when authorised) → status update in `PROJECT_STATUS.md`.
