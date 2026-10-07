# Data Ingestion and Import Formats

## Pipeline

1. **Receive** — manual upload (`POST /imports`, multipart) or scheduled email (`reports+<route token>@<inbound domain>`).
2. **Store original privately** — `SourceFiles` bucket, `source_files` row with SHA-256, sender, message id.
3. **Identify** — company from the authenticated uploader (permission checked) or from the route; report type and parser from the request/route.
4. **Parse** — deterministic parser chosen by key (CSV or first XLSX worksheet).
5. **Validate** — dates, required fields, totals, metric definitions, property mapping, duplicates within the file, inventory limits.
6. **Flag** — issues stored in `import_validation_issues` (row, field, code, message). Any error rejects the run.
7. **Write idempotently** — dry-run first; unchanged values are no-ops; changed values require review unless replacement is explicitly allowed (`replace_existing` or source `revision_policy = replace`). Prior values are kept (`daily_performance_revisions`, financial report revisions).
8. **Record results and lineage** — counts on `import_runs`; every written row references `import_run_id` / `source_file_id`; audit events; notifications.

Exact duplicate files (same company, report type, SHA-256 already loaded or in flight) create a `duplicate` run and change nothing.

Processing runs in the worker (SQS, 5 attempts, then DLQ). Background jobs re-verify that a requesting user still holds the import permission for the company and for every property in the file — revocation between upload and processing is honoured.

## Email routing security

An email is accepted only when **all** hold: the recipient token matches an active `email` source; the `From` address matches the route's allowed senders (exact address or `@domain`); SES reports SPF or DKIM `PASS` (configurable per route); attachments are CSV/XLSX. Routed sources resolve property codes **only** through the route's `ingestion_property_mappings`, so a correctly authenticated sender still cannot load data for an unmapped hotel or another company.

## Standardized formats

Header names are case/space-insensitive (`Room Revenue` → `room_revenue`). Numbers accept `1,234.56`, `$1,234` and accounting negatives `(123.45)`. Dates accept `YYYY-MM-DD` or `M/D/YYYY`.

### `hop.daily_performance.v1`
| Column | Required | Notes |
|---|---|---|
| `property_code` | ✓ | Property code (manual) or route external code (email) |
| `business_date` | ✓ | Property-local night-audit date; not in the future; not before opening |
| `rooms_sold` | ✓ | Paid rooms sold, integer ≥ 0 |
| `room_revenue` | ✓ | ≥ 0; must be 0 when rooms_sold is 0 |
| `rooms_available` | | Physical rooms that day; defaults to room inventory history (mismatch → warning) |
| `rooms_out_of_order` | | ≤ rooms in inventory |
| `rooms_comp` | | Complimentary rooms; sold + comp ≤ inventory |
| `food_beverage_revenue`, `other_revenue` | | If both present with `total_revenue`, the total must reconcile within 1.00 |
| `total_revenue` | | ≥ room revenue |
| `source_occupancy_pct`, `source_adr`, `source_revpar` | | Preserved verbatim in `source_metrics`; warning if the PMS definition differs from the portal's |

### `hop.monthly_actuals.v1`
`property_code, period (YYYY-MM), account_code, account_name?, amount`. Source account codes map to reporting accounts via `source_account_mappings` (property-specific overrides first). Unmapped accounts block the import. The original code, name and raw value are stored on each line. Imports write into a **draft** report; over a published period they require approval and create a new revision.

### `hop.budget.v1`
`property_code, fiscal_year, account_code, jan … dec` — one fiscal year per file. `account_code` may be a reporting account code (e.g. `REV_ROOMS`, `ROOMS_SOLD`) or a mapped source code. Each import creates a new **draft** budget version; approval is a separate step.

## PMS, accounting and Travera integrations

`packages/core/src/integrations.ts` defines `PmsAdapter`, `AccountingAdapter` and `TraveraAdapter` interfaces that emit the same record shapes as the standardized parsers, so every integration flows through identical validation, idempotency and lineage. **No vendor endpoints are implemented or assumed.** Connections are tracked in `integration_connections` (status `not_configured` in the demo). Credentials, when granted, belong in AWS Secrets Manager (`secret_ref`), never in the database or browser.

PMS-specific report parsers (Opera, Mews, etc.) must be added only from real sample reports, with fixtures and tests; until then the registry exposes only the standardized formats. AI-assisted extraction, if introduced, must produce standardized records, pass the same validators, and route uncertain financial values to human review.
