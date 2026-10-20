# Security Model

## Principles

1. **The database enforces access.** Every exposed table has RLS; the UI, API and workers are additional layers, never the only layer.
2. **Identity comes only from a verified session.** The API verifies Supabase JWTs against the project JWKS (ES256/RS256; HS256 only for legacy projects with an explicit secret) and never accepts user or company ids from clients as authority.
3. **Domains, company selectors, URL parameters and frontend filters are not authorization.**
4. **Least privilege for background work.** The service-role key exists only in AWS Secrets Manager and is used by server code that performs explicit authorization (`svc_user_has_permission`) or follows an approved ingestion route.
5. **Financial visibility ≠ property visibility.** Separate permissions for performance, published financials, drafts, budgets, each document visibility tier, internal commentary, CapEx approval and ingestion.

## Permission model

`app.membership_allows_user` evaluates: active membership → company active → module enabled → role default or explicit allow → no explicit deny → MFA (`aal2`) when the permission is privileged and the company requires it. Property access then requires `all_properties` (corporate roles only) or an active, unexpired grant whose optional permission list includes the permission. Owners/investors can never hold `all_properties` (check constraint).

Policies use `app.permitted_property_ids(perm)` / `app.permitted_company_ids(perm)` (security definer, evaluated once per statement via `(select …)`), so performance stays predictable.

| Role (defaults) | Notable defaults |
|---|---|
| Company admin | everything, incl. users, company settings, audit |
| Corporate finance | financials incl. drafts/publish, budgets, all document tiers, ingestion manage |
| Corporate operations | performance, drafts (view), CapEx approve, internal commentary |
| Property manager | own properties: performance, published financials, uploads, CapEx edit, internal notes |
| Owner | performance, published financials, budgets (approved), owner documents, CapEx approve, packages |
| Investor | performance, published financials, general documents, packages, owner commentary |

Per-membership allow/deny overrides and per-property permission lists refine these defaults (e.g. the demo investor's grant is limited to performance + packages).

**Company-wide rows need company-wide access.** A company-level role permission is not enough to write configuration that affects every property. Rows with a `property_id` are writable only for `property_id = any(app.permitted_property_ids(perm))` (in both `USING` and `WITH CHECK`, so an update cannot move a row to another property); rows without one, the chart of accounts, ingestion sources and routes, integration connections and route-token rotation need `app.has_company_wide_permission(perm, company_id)` (an active all-properties membership or a support session). Property-specific code and account mappings are readable only for permitted properties.

**Authorship is set by the database.** Author, publisher, approver and timestamp columns on commentary, budget versions and CapEx updates/transactions are filled by `BEFORE` triggers for client writes; values sent by the browser are ignored.

**The last administrator stays an administrator.** Administrators cannot deny themselves `admin.*`, and a deny of `admin.users`/`admin.company` is refused when no other active membership effectively holds it.

## Specific controls

| Risk | Control | Verified by |
|---|---|---|
| Cross-company access | RLS + composite FKs | `foundation.test.ts` (isolation, composite FK) |
| Cross-property access | property grants in every policy | `security-acceptance.test.ts`, `e2e/security-acceptance.spec.ts` |
| Direct API writes | no write grants/policies except where intended; workflow RPCs | `foundation.test.ts` (direct writes) |
| Service functions called by users | `svc_*` executable by `service_role` only | `foundation.test.ts` |
| Revoked access | evaluated per request (no cached claims) | revocation tests (DB and background job) |
| Draft financial leakage | status-aware policies; snapshots via filtered RPC | `financials.test.ts`, `capex-packages.test.ts` |
| Tampered published data | immutability triggers (even service role) | `financials.test.ts` |
| Duplicate/changed approvals | unique decision per user, append-only decisions, immutable requests, guarded approved budget | `capex-packages.test.ts` |
| Document exfiltration | private KMS buckets, server-side authorization per download, 60 s URLs, signature binds key, audit | `documents.test.ts`, `security-acceptance.test.ts` |
| Malicious uploads | allow-listed types/sizes (DB + API + storage policy), quarantine prefix, GuardDuty/local scanner, signature check, manager-only manual release | `documents.test.ts` |
| Spoofed report emails | secret route token + sender allow-list + SPF/DKIM + route property mappings | `imports.test.ts` |
| Formula injection in exports | CSV cell neutralisation | `ingestion.test.ts` |
| Privileged actions without MFA | `aal2` required for privileged permissions | `foundation.test.ts` (TOTP step-up) |
| Property-scoped editors changing shared configuration | company-wide permission for company-wide rows; property checks in `USING` and `WITH CHECK` | `qa-round3.test.ts` (R3-01, R3-19) |
| Forged authors and timestamps | `BEFORE` triggers set author/approver/time columns | `qa-round3.test.ts` (R3-08) |
| Platform staff reading tenant data | money-free audit metadata, profiles only in support sessions | `qa-round3.test.ts` (R3-02) |
| Operator console | operational metadata only (ADR-008); writes need aal2; no admin invitations once a company has an admin or to platform-admin accounts; anon cannot execute `platform_*` | `platform-console.test.ts` |
| Support staff over-reach | no standing access; time-boxed, MFA-gated, read-only, audited sessions endable by company admins | `foundation.test.ts` |
| Client privilege defaults | default privileges revoked; test asserts `anon` has no table grants and every table has RLS | `foundation.test.ts` |
| Secrets exposure | browser has publishable key only; lint rule; Lambda env has secret ARN only | CDK assertion tests, ESLint |
| Secrets in audit trail | row audits redact route tokens, verification tokens and token hashes | `admin-tools.test.ts` |
| Abuse / common web attacks | optional WAF (`enableWaf`, on in production context): per-IP rate limit, AWS IP reputation, common and known-bad-input rule sets; API served via CloudFront `/api/*` so the same ACL applies | CDK assertion tests |
| Exported documents | PDFs/CSVs generated per request as the user (RLS), unpublished content watermarked, every export audited | `admin-tools.test.ts`, `security-acceptance.test.ts` |

## Audit

`audit_events` is append-only (trigger blocks update/delete). Row-change triggers cover companies, branding, domains, modules, memberships, overrides, grants, properties, inventory, support sessions, ingestion config, accounts/mappings, CapEx; RPCs log publication, approvals, invitations, downloads (authorized and denied), imports and exports. Company admins with `audit.view` see their company's events. Platform admins see tenant audit events without a support session only because audit metadata never contains financial figures: `app.audit()` strips money fields (amounts, budgets, thresholds, raw source values) from every event, and row-change audits record changed money columns by name only (`changed_fields`), never their values. `audit_events` is append-only, so events written before migration `20261016001000_qa_round3` are not rewritten; the read policy hides from platform admins any event whose metadata still carries a money field. Tenant user profiles (names, emails) are visible to platform staff only inside an active, 2FA-verified support session (ADR-008: no implicit access to tenant data).

## Known limitations / follow-ups

- Login rate limiting and lockout rely on Supabase Auth defaults; review per-project settings before production.
- Custom-domain verification (DNS TXT + ACM certificate) is an operational step performed by the platform team.
- PDF statements are generated through the browser print view; server-rendered branded PDFs are a planned enhancement.
