# Hotel Owners Portal

White-label portal for hotel management companies, owners and investors: portfolio and property performance, budgets and published financials, CapEx approvals, private documents, monthly owner reporting packages and automated report ingestion.

- **Frontend:** React + TypeScript (Vite) — `apps/web`
- **Data & auth:** Supabase Postgres with row-level security, Supabase Auth (TOTP MFA) — `supabase/`
- **Server:** TypeScript (Hono) on AWS Lambda; same code runs locally — `services/api`
- **Shared domain logic:** KPI maths, variances, CapEx rules, parsers — `packages/core`
- **Infrastructure as code:** AWS CDK — `infra/`
- **Tests:** unit (`packages/core`, `infra`), integration against local Supabase (`tests/integration`), Playwright (`e2e/`)

Start with [`PROJECT_STATUS.md`](PROJECT_STATUS.md), then [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Quick start (local)

Requirements: Node 22, Docker.

```bash
npm install
npm run db:start          # local Supabase (Docker) + writes .env.local files
npm run db:reset          # migrations + FICTIONAL demo seed + demo PDFs
npm run start -w services/api   # API + in-process worker on :8787
npm run dev:web           # Vite on :5173
```

If Docker Hub is reachable but `public.ecr.aws` is not, prefix `db:start` with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`.

Open a tenant host (browsers resolve `*.localhost` to 127.0.0.1, so no DNS setup is needed):

- http://harborview.localhost:5173 — Harborview Hospitality Group branding
- http://summit.localhost:5173 — Summit Peak Hotel Partners branding

### Demo accounts (all fictional, password `DemoPass!2026`)

| Email | Role | Notes |
|---|---|---|
| `admin@harborview.example` | Company admin (Harborview) | users, branding, audit |
| `finance@harborview.example` | Corporate finance | drafts, publishing, imports, budgets |
| `ops@harborview.example` | Corporate operations | CapEx approvals, internal notes |
| `gm.seattle@harborview.example` | Property manager (Seattle only) | uploads, CapEx edits |
| `olivia.owner@owners.example` | Owner — Harborview Seattle + Portland, **and** Summit Denver | multi-company switcher; security acceptance subject |
| `ian.investor@owners.example` | Investor — Seattle, limited grant | performance + packages only |
| `revoked.owner@owners.example` | Revoked owner | sees nothing |
| `admin@summitpeak.example`, `finance@summitpeak.example` | Summit admin / finance | |
| `platform@portal.example` | Platform admin | no data access without an audited support session (requires MFA) |

The demo companies have `require_mfa_for_privileged = false` so privileged actions can be explored without an authenticator app. New companies default to requiring MFA.

## Commands

| Command | What it does |
|---|---|
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript across all workspaces |
| `npm run test:unit` | core domain + CDK assertion tests |
| `npm run test:integration` | resets local DB, runs RLS/API/pipeline tests (local Supabase only) |
| `npm run test:e2e` | Playwright against local stack (starts API + web if not running) |
| `npm run build -w services/api` | Lambda bundles in `services/api/dist/lambda` |
| `npx cdk synth -c env=staging` (in `infra/`) | synthesizes CloudFormation; deploys nothing |

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Nothing has been deployed: no cloud credentials were available during development. Staging deploys are gated on configuration; production requires manual dispatch and environment approval.

## Repository layout

```
apps/web               React SPA
packages/core          shared domain logic (KPI, variance, CapEx, parsers, permissions)
services/api           API routes, import pipeline, email intake, scanning, Lambda handlers, local server
supabase/migrations    schema, RLS, permission engine, workflow RPCs
supabase/seeds         FICTIONAL demo data (local only)
infra                  AWS CDK stack + assertion tests
tests/integration      Vitest suites against local Supabase
e2e                    Playwright suites
docs                   plan, architecture, decisions, security, deployment, operations, costs, ingestion, pilot checklist
```
