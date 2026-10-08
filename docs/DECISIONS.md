# Architectural Decisions & Assumptions

Lightweight ADR log. Each entry: context → decision → consequences.

## ADR-001 Monorepo with npm workspaces
- **Decision:** `apps/web` (React + TS + Vite), `packages/core` (pure domain logic shared by web,
  API and workers), `services/api` (Hono handlers deployed to AWS Lambda; same code runs locally),
  `infra` (AWS CDK, TypeScript), `supabase/` (migrations, seed), `tests/integration`, `e2e`.
- **Why:** One language end to end, shared calculation code guarantees UI, exports, packages and
  workers compute KPIs identically.

## ADR-002 Supabase is the system of record and the primary authorization layer
- All business data lives in Supabase Postgres. Every exposed table has RLS enabled.
- Permission logic is centralised in `app.*` `SECURITY DEFINER` functions (in a schema not exposed
  through PostgREST) so policies stay short and consistent.
- The browser talks to Supabase with the user's JWT (anon/publishable key only). The AWS API also
  forwards the user's JWT to Supabase so RLS applies to API reads and exports. The service-role key
  is only used by background workers that perform their own explicit authorization checks, and it is
  only stored in AWS Secrets Manager.

## ADR-003 Roles are defaults; permissions are explicit
- Membership role → default permission set (`role_permission_defaults`).
- Per-membership overrides (`membership_permission_overrides`, allow/deny, deny wins).
- Property access is separate (`property_access_grants`); corporate roles may hold
  company-wide access (`all_properties`). A grant can further restrict permissions for that property.
- Company modules (`company_modules`) switch whole features off for a company regardless of role.
- Financial visibility is separate from property visibility: e.g. `performance.view` vs
  `financials.view` vs `financials.view_draft` vs `documents.view_confidential` vs
  `commentary.view_internal`.

## ADR-004 Company isolation via composite foreign keys
Every property-scoped row carries `company_id` and `property_id` and references
`properties(id, company_id)`. A row therefore cannot point at another company's property even if
application code is wrong.

## ADR-005 Ownership ≠ access
`ownership_groups` / `property_ownerships` record who legally owns what (with percentages and
effective dates). Software access is granted only by memberships + property access grants. Owning a
share of a hotel never implicitly grants login access.

## ADR-006 Multi-company owners and the company switcher
A user can hold memberships in several companies. The UI requires an explicit active company. All
queries are scoped by company id *and* RLS; the selected company is a UX choice, not an
authorization input. Cross-company combined financial views are disabled
(`platform_settings.cross_company_rollups_enabled = false`) and not implemented in this release.

## ADR-007 Branding / domain resolution
Branding is resolved from the request host via `public.resolve_branding(host)` which returns only
public presentation fields. Local development uses `*.localhost` hosts (e.g.
`harborview.localhost:5173`), which browsers resolve to 127.0.0.1, so no DNS or certificates are
needed. A domain never grants access — it only selects presentation and the default company.

## ADR-008 Platform support access is deliberate, time-boxed and audited
Platform administrators manage companies, branding and domains but have **no** implicit access to
financial data. Support access requires opening a `support_access_sessions` row (reason, ticket ref,
expiry ≤ 8h), which is audited and notifies company admins. Sessions grant read-only permissions
(no publishing, approving, or confidential documents).

## ADR-009 MFA for privileged users
Privileged permissions (admin, publish, approve, edit financials, manage documents, ingestion)
require an `aal2` session (Supabase TOTP MFA). Policies call `app.has_permission`, which demotes a
privileged permission to "denied" when the JWT `aal` claim is not `aal2` and the company setting
`require_mfa_for_privileged` is on (default on; the local seed turns it off for the demo companies
only so the demo can be explored without an authenticator app — tests cover both modes).

## ADR-010 KPI calculation rules
- Occupancy = rooms sold / available room nights × 100; ADR = room revenue / rooms sold;
  RevPAR = room revenue / available room nights.
- Portfolio values are computed from summed numerators and denominators; hotel percentages/ADRs are
  never averaged.
- **Out-of-order rooms:** excluded from available room nights by default
  (`reporting_config.ooo_treatment = 'exclude'`); configurable to `'include'`.
- **Complimentary rooms:** excluded from rooms sold by default (`comp_treatment = 'exclude'`), so
  they do not depress ADR; configurable to `'include'`.
- **Room inventory changes:** physical room count comes from `room_inventory_history` effective on
  each business date unless the source supplies rooms available for that day.
- **Business dates:** the property-local business (night-audit) date supplied by the source is stored
  as a `date`; it is never derived from UTC timestamps. "Today" for freshness uses the property
  timezone.
- **Leap years / prior year:** prior-year periods are the same calendar dates one year earlier;
  29 Feb maps to 28 Feb. Ratios remain comparable; totals for periods containing 29 Feb are flagged.
- **Missing data:** a day without a record is *unavailable*, not zero. Each result carries coverage
  (reported property-days / expected property-days). Portfolio results with incomplete coverage are
  flagged and the UI shows the coverage rather than presenting the number as complete.
- **Zero denominators:** return `null` (displayed "—"), never `Infinity`/`NaN`.
- Daily operating figures are labelled *provisional*; published monthly financials are labelled
  *published*.
- Source conventions (e.g. a PMS reporting occupancy including comps) are preserved in
  `daily_performance.source_metrics` and never overwrite the portal's normalised definitions.

## ADR-011 Financial publication workflow
Structured actuals belong to a `financial_reports` row (property + period + type) with status
`draft → in_review → published → superseded`. Owners/investors see only `published` rows (and
their lines) when they hold `financials.view`. A correction creates a new revision (copy of lines),
which on publish supersedes the previous revision. History is retained.
Uploading a P&L PDF creates a document only; it never populates structured data.

## ADR-012 CapEx remaining funds definition
**Remaining funds = Approved budget − Actual spend − Open commitments.** "Uncommitted remaining"
is shown explicitly in the UI with this definition. Approved amounts are immutable once approved;
any change requires a new approval request (change order).

## ADR-013 Documents
Private S3 bucket, object keys never exposed to clients. Uploads go to a `quarantine/` prefix via a
short-lived presigned PUT after server-side authorization. Scanning (GuardDuty Malware Protection
for S3 in AWS; a local signature scanner in development) promotes clean files. Unscanned or
infected versions can only be seen by document managers and can never be downloaded by
owners/investors. Downloads are authorized server-side (RLS check with the user's JWT + explicit
permission check), audited, then a ≤60s presigned GET URL is issued.

## ADR-014 AWS architecture (simple managed services)
CloudFront + private S3 for the SPA; API Gateway HTTP API + Lambda (Node 22) for the API; SQS
(with DLQ, maxReceiveCount 5) + Lambda worker for imports; SES inbound receipt rule → S3 → Lambda
for scheduled report emails; EventBridge Scheduler for missing-report checks and the notification
dispatcher; Secrets Manager for the Supabase service key; CloudWatch alarms. No VPC/NAT/RDS is
needed because the database is Supabase — this keeps fixed monthly cost low.

## ADR-015 Ingestion
Parsers are deterministic adapters registered by key. Only the portal's standardized
CSV/XLSX formats are implemented. PMS-specific parsers will be added only from real sample reports.
Email senders are never trusted alone: an email must arrive at a route's secret inbound address,
match an allowed sender, and every property code must map to a property of the route's company.

## ADR-016 No Travera integration
The original brief allowed for future Travera data. The owner decided (2026-10-08) not to link Travera. The integration kind, adapter interface and demo connection were removed; data enters only through standardized uploads, scheduled report emails, and (later) direct PMS/accounting adapters.

## Assumptions
- Single currency per company (default USD); multi-currency is out of scope for v1.
- Fiscal year = calendar year by default (configurable `fiscal_year_start_month` stored for later).
- Budget granularity: monthly by property and reporting account; operating stats budgets monthly.
- Email delivery uses SES once a verified domain exists; until then notifications are in-app and
  queued in `notification_outbox`.
- Region default `us-east-1` (SES inbound availability); configurable.
