# Pilot Acceptance Checklist (staging)

Run with fictional or anonymised data only. Record results in `PROJECT_STATUS.md`.

## Access & security
- [ ] Owner with two hotels cannot see a third via UI, direct URL, CSV export or document link (automated: `security-acceptance` suites; repeat manually once on staging).
- [ ] Investor sees only granted properties and sections (no drafts, no internal notes, no confidential documents).
- [ ] Revoking a membership removes access on the next request.
- [ ] Privileged users are prompted for TOTP; publishing/approving fails without it.
- [ ] Support session: requires MFA, appears under company Support access, ends on demand, audited.
- [ ] Anonymous REST calls to the Supabase project return no data.

## Branding & tenancy
- [ ] Each tenant domain shows its logo, colours, favicon and login copy; unknown domains show neutral branding.
- [ ] Multi-company owner switches companies; data and branding change together; no combined financials.

## Performance
- [ ] Daily email from the PMS arrives and loads (or a missing-report alert fires after the deadline).
- [ ] Dashboard KPIs reconcile to a manual calculation from the PMS report for one hotel/month.
- [ ] Partial-coverage periods are flagged; missing days show “Unavailable”.

## Finance
- [ ] Monthly GL import → draft → review → publish; owners notified (email without figures).
- [ ] Correction creates revision 2; revision 1 shows superseded with history.
- [ ] Budget import → draft → approve; variances match spreadsheet.

## CapEx
- [ ] Threshold routing matches the company policy; owner approval works; duplicate decisions are blocked.
- [ ] Remaining funds = approved − actual − open commitments on screen and in packages.

## Documents & packages
- [ ] Upload → scan → download within 60 s link lifetime; EICAR test file is blocked.
- [ ] Monthly package publishes with snapshot; revision supersedes.

## Operations
- [ ] Alarms deliver to the on-call address (trigger a test DLQ message).
- [ ] Backup restore drill completed into a scratch project.
