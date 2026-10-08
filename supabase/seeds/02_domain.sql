-- =============================================================================
-- DEMO SEED DATA (fictional) — operating performance, finance, CapEx, documents.
-- Daily data is generated relative to current_date so the demo stays fresh.
-- Deliberate data-quality scenarios:
--   * HV-HNL: last 4 business days missing (stale freshness)
--   * HV-SFO: yesterday missing (late)
--   * SP-AUS: 10–12 Sept 2026 missing (partial coverage)
-- =============================================================================

-- Lineage: one "seed" source file + completed import run per company.
insert into public.source_files (id, company_id, storage_key, original_filename, content_type, size_bytes, sha256, received_via)
select ('60000000-0000-4000-8000-00000000000' || right(c.id::text, 1))::uuid, c.id, 'demo/seed/' || c.slug || '.csv',
       'demo-seed-' || c.slug || '.csv', 'text/csv', 1, encode(extensions.digest(c.slug, 'sha256'), 'hex'), 'upload'
from public.companies c;

insert into public.import_runs (id, company_id, source_file_id, report_type, parser_key, status, completed_at, rows_total, rows_valid, result)
select ('61000000-0000-4000-8000-00000000000' || right(c.id::text, 1))::uuid, c.id,
       ('60000000-0000-4000-8000-00000000000' || right(c.id::text, 1))::uuid,
       'daily_performance', 'hop.daily_performance.v1', 'completed', now(), 0, 0, '{"note":"Demo seed data"}'
from public.companies c;

-- Property market profiles for generation.
create temporary table seed_profile (code text primary key, base_occ numeric, base_adr numeric, season_peak integer, fb_ratio numeric, comp_rate integer);
insert into seed_profile values
  ('HV-SEA', 0.78, 245, 7, 0.32, 2),
  ('HV-PDX', 0.74, 189, 8, 0.22, 1),
  ('HV-SFO', 0.81, 279, 9, 0.18, 2),
  ('HV-HNL', 0.86, 335, 1, 0.28, 3),
  ('SP-DEN', 0.76, 212, 7, 0.26, 2),
  ('SP-AUS', 0.72, 228, 3, 0.20, 1),
  ('SP-MIA', 0.79, 301, 2, 0.24, 2);

with base as (
  select p.company_id, p.id as property_id, p.code, d::date as business_date,
         sp.base_occ, sp.base_adr, sp.season_peak, sp.fb_ratio, sp.comp_rate,
         (select r.room_count from public.room_inventory_history r
           where r.property_id = p.id and r.effective_from <= d::date and (r.effective_to is null or r.effective_to > d::date)) as rooms,
         (abs(hashtext(p.code || d::text)) % 1000) / 1000.0 as rnd,
         (abs(hashtext(d::text || p.code || 'x')) % 1000) / 1000.0 as rnd2
  from public.properties p
  join seed_profile sp on sp.code = p.code
  cross join generate_series(date '2025-01-01', current_date - 1, interval '1 day') d
  where not (p.code = 'HV-HNL' and d::date > current_date - 5)
    and not (p.code = 'HV-SFO' and d::date = current_date - 1)
    and not (p.code = 'SP-AUS' and d::date between date '2026-09-10' and date '2026-09-12')
),
calc as (
  select b.*,
    case when b.code = 'HV-SEA' and b.business_date between date '2026-01-05' and date '2026-02-20' then 12
         else floor(b.rnd2 * 3)::integer end as ooo,
    least(0.99, greatest(0.35,
      b.base_occ
      + 0.12 * cos(2 * pi() * (extract(month from b.business_date) - b.season_peak) / 12.0)
      + case when extract(isodow from b.business_date) in (5, 6) then 0.06 else -0.02 end
      + (b.rnd - 0.5) * 0.10)) as occ,
    b.base_adr
      * (1 + 0.15 * cos(2 * pi() * (extract(month from b.business_date) - b.season_peak) / 12.0))
      * (case when extract(isodow from b.business_date) in (5, 6) then 1.08 else 0.98 end)
      * (case when b.business_date >= date '2026-01-01' then 1.035 else 1 end)
      * (0.97 + b.rnd2 * 0.06) as adr
  from base b
),
final as (
  select c.*,
    least(c.rooms - c.ooo - (c.comp_rate), floor((c.rooms - c.ooo) * c.occ))::integer as sold,
    c.comp_rate as comp
  from calc c
)
insert into public.daily_performance (company_id, property_id, business_date, physical_rooms, rooms_out_of_order, rooms_sold, rooms_comp,
  room_revenue, fb_revenue, other_revenue, total_revenue, source_metrics, import_run_id, source_file_id)
select f.company_id, f.property_id, f.business_date, f.rooms, f.ooo, f.sold, f.comp,
  round(f.sold * f.adr::numeric, 2),
  round(f.sold * f.adr::numeric * f.fb_ratio, 2),
  round(f.sold * f.adr::numeric * 0.06, 2),
  round(f.sold * f.adr::numeric, 2) + round(f.sold * f.adr::numeric * f.fb_ratio, 2) + round(f.sold * f.adr::numeric * 0.06, 2),
  -- Harborview's PMS reports occupancy including comps over physical rooms (different convention).
  case when f.code like 'HV-%' then jsonb_build_object('occupancy_pct', round(100.0 * (f.sold + f.comp) / f.rooms, 1)) else '{}'::jsonb end,
  ('61000000-0000-4000-8000-00000000000' || right(f.company_id::text, 1))::uuid,
  ('60000000-0000-4000-8000-00000000000' || right(f.company_id::text, 1))::uuid
from final f;

update public.import_runs r set rows_total = x.n, rows_valid = x.n, rows_inserted = x.n,
  period_start = x.mn, period_end = x.mx, property_ids = x.props
from (select company_id, count(*) n, min(business_date) mn, max(business_date) mx, array_agg(distinct property_id) props
      from public.daily_performance group by company_id) x
where r.company_id = x.company_id;

-- -----------------------------------------------------------------------------
-- Chart of accounts (USALI-style summary) and source mappings
-- -----------------------------------------------------------------------------
create temporary table seed_accounts (code text, name text, nature text, section text, sort_order integer, kpi_role text, src text[]);
insert into seed_accounts values
  ('ROOMS_AVAILABLE', 'Rooms available', 'statistic', 'Statistics', 10, 'rooms_available', array['STAT-AVL']),
  ('ROOMS_SOLD', 'Rooms sold', 'statistic', 'Statistics', 20, 'rooms_sold', array['STAT-SLD']),
  ('REV_ROOMS', 'Rooms revenue', 'revenue', 'Revenue', 100, 'room_revenue', array['4000']),
  ('REV_FB', 'Food & beverage revenue', 'revenue', 'Revenue', 110, null, array['4100']),
  ('REV_OTHER', 'Other operated departments', 'revenue', 'Revenue', 120, null, array['4200']),
  ('EXP_ROOMS', 'Rooms expense', 'expense', 'Departmental expenses', 200, null, array['5000']),
  ('EXP_FB', 'Food & beverage expense', 'expense', 'Departmental expenses', 210, null, array['5100']),
  ('EXP_OTHER_DEPT', 'Other departmental expense', 'expense', 'Departmental expenses', 220, null, array['5200']),
  ('EXP_AG', 'Administrative & general', 'expense', 'Undistributed expenses', 300, null, array['6000', '6010']),
  ('EXP_IT', 'Information & telecom systems', 'expense', 'Undistributed expenses', 310, null, array['6100']),
  ('EXP_SM', 'Sales & marketing', 'expense', 'Undistributed expenses', 320, null, array['6200']),
  ('EXP_POM', 'Property operations & maintenance', 'expense', 'Undistributed expenses', 330, null, array['6300']),
  ('EXP_UTIL', 'Utilities', 'expense', 'Undistributed expenses', 340, null, array['6400']),
  ('EXP_MGMT_FEE', 'Base management fee', 'expense', 'Management fees', 400, null, array['7000']),
  ('EXP_PROP_TAX', 'Property & other taxes', 'expense', 'Fixed charges', 500, null, array['7100']),
  ('EXP_INSURANCE', 'Insurance', 'expense', 'Fixed charges', 510, null, array['7200']),
  ('EXP_FFE_RESERVE', 'FF&E reserve', 'expense', 'Fixed charges', 520, null, array['7300']);

insert into public.financial_accounts (company_id, code, name, nature, section, sort_order, kpi_role)
select c.id, a.code, a.name, a.nature, a.section, a.sort_order, a.kpi_role from public.companies c cross join seed_accounts a;

insert into public.source_account_mappings (company_id, source_system, source_account_code, source_account_name, account_id)
select fa.company_id, 'standard', s.src, fa.name || case when s.src = '6010' then ' (non-payroll)' when s.src = '6000' then ' (payroll)' else '' end, fa.id
from public.financial_accounts fa join seed_accounts a on a.code = fa.code cross join unnest(a.src) s(src);

-- San Francisco's legacy GL uses a different rooms revenue code (property-specific override).
insert into public.source_account_mappings (company_id, property_id, source_system, source_account_code, source_account_name, account_id)
select fa.company_id, '20000000-0000-4000-8000-000000000103', 'standard', '40100', 'Transient + group room revenue', fa.id
from public.financial_accounts fa where fa.company_id = '10000000-0000-4000-8000-000000000001' and fa.code = 'REV_ROOMS';

-- -----------------------------------------------------------------------------
-- Monthly actuals → financial reports
-- -----------------------------------------------------------------------------
create temporary table seed_month as
select d.company_id, d.property_id, p.code, date_trunc('month', d.business_date)::date as period_month,
       sum(d.physical_rooms - d.rooms_out_of_order) as avl, sum(d.rooms_sold) as sold,
       sum(d.room_revenue) as rooms_rev, sum(d.fb_revenue) as fb_rev, sum(d.other_revenue) as other_rev,
       sum(d.total_revenue) as total_rev
from public.daily_performance d join public.properties p on p.id = d.property_id
where d.business_date < date_trunc('month', current_date)
group by 1, 2, 3, 4;

create temporary table seed_lines as
select m.*, x.src, x.amount from seed_month m
cross join lateral (values
  ('STAT-AVL', m.avl::numeric), ('STAT-SLD', m.sold::numeric),
  (case when m.code = 'HV-SFO' then '40100' else '4000' end, m.rooms_rev),
  ('4100', m.fb_rev), ('4200', m.other_rev),
  ('5000', round(m.rooms_rev * (0.235 + (abs(hashtext(m.code || m.period_month::text || 'r')) % 30) / 1000.0), 2)),
  ('5100', round(m.fb_rev * (0.70 + (abs(hashtext(m.code || m.period_month::text || 'f')) % 60) / 1000.0), 2)),
  ('5200', round(m.other_rev * 0.48, 2)),
  ('6000', round(m.total_rev * 0.052, 2)),
  ('6010', round(m.total_rev * 0.034, 2)),
  ('6100', round(m.total_rev * 0.016, 2)),
  ('6200', round(m.total_rev * (0.068 + (abs(hashtext(m.code || m.period_month::text || 's')) % 20) / 1000.0), 2)),
  ('6300', round(m.total_rev * 0.044, 2)),
  ('6400', round(m.total_rev * (0.030 + 0.012 * abs(cos(2 * pi() * extract(month from m.period_month) / 12.0)))::numeric, 2)),
  ('7000', round(m.total_rev * 0.03, 2)),
  ('7100', round(case m.code when 'HV-SEA' then 61000 when 'HV-PDX' then 38000 when 'HV-SFO' then 72000 when 'HV-HNL' then 69000
                              when 'SP-DEN' then 54000 when 'SP-AUS' then 47000 else 58000 end, 2)),
  ('7200', round(case when m.code in ('HV-HNL', 'SP-MIA') then 46000 else 24000 end, 2)),
  ('7300', round(m.total_rev * 0.04, 2))
) x(src, amount);

-- Reports exist through last month; September 2026 is still a draft / in review.
insert into public.financial_reports (company_id, property_id, period_month, title, created_by, import_run_id)
select distinct m.company_id, m.property_id, m.period_month, format('P&L — %s', to_char(m.period_month, 'FMMonth YYYY')),
  case when m.company_id = '10000000-0000-4000-8000-000000000001' then '30000000-0000-4000-8000-000000000012'::uuid
       else '30000000-0000-4000-8000-000000000032'::uuid end, null::uuid
from seed_month m;

insert into public.financial_report_lines (company_id, property_id, financial_report_id, account_id, amount, source_account_code,
  source_account_name, source_value)
select l.company_id, l.property_id, r.id, sam.account_id, l.amount, l.src, sam.source_account_name, to_char(l.amount, 'FM999999990.00')
from seed_lines l
join public.financial_reports r on r.property_id = l.property_id and r.period_month = l.period_month
join public.source_account_mappings sam on sam.company_id = l.company_id and sam.source_account_code = l.src
  and (sam.property_id = l.property_id or (sam.property_id is null and not exists (
       select 1 from public.source_account_mappings o where o.company_id = l.company_id and o.property_id = l.property_id
       and o.source_account_code = l.src)));

-- Publish everything before the most recent month; latest month: HV-SEA in review, others draft.
update public.financial_reports set status = 'in_review', submitted_by = created_by, submitted_at = now() - interval '3 days'
where period_month < date_trunc('month', current_date)::date - interval '1 month'
   or (period_month = (date_trunc('month', current_date) - interval '1 month')::date and property_id = '20000000-0000-4000-8000-000000000101');
update public.financial_reports set status = 'published', published_by = created_by,
  published_at = (period_month + interval '1 month' + interval '17 days')
where period_month < date_trunc('month', current_date)::date - interval '1 month';

insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id, created_at)
select company_id, property_id, 'financial_report', id, revision, 'in_review', 'published', 'Monthly close', published_by, published_at
from public.financial_reports where status = 'published';

-- A correction: Seattle July 2026 republished as revision 2 (property tax accrual reclassified).
do $$
declare
  v_old uuid;
  v_new uuid;
begin
  select id into v_old from public.financial_reports
   where property_id = '20000000-0000-4000-8000-000000000101' and period_month = date '2026-07-01' and status = 'published';
  if v_old is null then return; end if;
  insert into public.financial_reports (company_id, property_id, period_month, revision, supersedes_id, correction_reason, title, created_by)
  values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', date '2026-07-01', 2, v_old,
          'Property tax accrual reclassified from June', 'P&L — July 2026', '30000000-0000-4000-8000-000000000012')
  returning id into v_new;
  insert into public.financial_report_lines (company_id, property_id, financial_report_id, account_id, amount, source_account_code, source_account_name, source_value)
  select company_id, property_id, v_new, account_id,
         case when source_account_code = '7100' then amount + 8400 else amount end,
         source_account_code, source_account_name,
         case when source_account_code = '7100' then to_char(amount + 8400, 'FM999999990.00') else source_value end
  from public.financial_report_lines where financial_report_id = v_old;
  update public.financial_reports set status = 'in_review', submitted_by = created_by, submitted_at = date '2026-08-28' where id = v_new;
  update public.financial_reports set status = 'superseded', superseded_at = date '2026-08-29' where id = v_old;
  update public.financial_reports set status = 'published', published_by = created_by, published_at = date '2026-08-29' where id = v_new;
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id, created_at) values
    ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'financial_report', v_old, 1, 'published', 'superseded', 'Superseded by revision 2', '30000000-0000-4000-8000-000000000012', date '2026-08-29'),
    ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'financial_report', v_new, 2, 'in_review', 'published', 'Corrected property tax accrual', '30000000-0000-4000-8000-000000000012', date '2026-08-29');
end $$;

-- -----------------------------------------------------------------------------
-- Budgets: FY2025 and FY2026 approved; Seattle FY2026 v1 superseded by v2; FY2027 draft
-- -----------------------------------------------------------------------------
insert into public.budget_versions (company_id, property_id, fiscal_year, version_number, name, created_by)
select p.company_id, p.id, fy, 1, format('FY%s Operating budget', fy),
  case when p.company_id = '10000000-0000-4000-8000-000000000001' then '30000000-0000-4000-8000-000000000012'::uuid
       else '30000000-0000-4000-8000-000000000032'::uuid end
from public.properties p cross join (values (2025), (2026)) y(fy);

insert into public.budget_versions (company_id, property_id, fiscal_year, version_number, name, created_by, notes) values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 2026, 2, 'FY2026 Reforecast (renovation displacement)', '30000000-0000-4000-8000-000000000012', 'Reflects January guest room renovation displacement.'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 2027, 1, 'FY2027 Draft budget', '30000000-0000-4000-8000-000000000012', 'Working draft — not yet approved.');

-- Budget = same month prior year (or modelled) × growth, per account (statistics included).
insert into public.budget_lines (company_id, property_id, budget_version_id, account_id, period_month, amount)
select v.company_id, v.property_id, v.id, fa.id, make_date(v.fiscal_year, mth, 1),
  round(
    coalesce(
      (select sum(l.amount) from seed_lines l join public.source_account_mappings sam
         on sam.company_id = l.company_id and sam.source_account_code = l.src and sam.account_id = fa.id
        where l.property_id = v.property_id and l.period_month = make_date(case when v.fiscal_year = 2025 then 2025 else v.fiscal_year - 1 end, mth, 1)),
      0)
    * case when v.fiscal_year = 2025 then (0.97 + (abs(hashtext(v.property_id::text || fa.code || mth::text)) % 60) / 1000.0)
           when fa.nature = 'statistic' and fa.code = 'ROOMS_AVAILABLE' then 1
           when fa.nature = 'statistic' then 1.01
           when fa.nature = 'revenue' then 1.045
           else 1.03 end
    * case when v.version_number = 2 and mth = 1 and fa.code in ('REV_ROOMS', 'ROOMS_SOLD', 'REV_FB') then 0.86 else 1 end
  , case when fa.nature = 'statistic' then 0 else 2 end)
from public.budget_versions v
join public.financial_accounts fa on fa.company_id = v.company_id
cross join generate_series(1, 12) mth;

-- Pad the FY2025 Portland room inventory change into the statistic budget is already captured by actuals.
delete from public.budget_lines where amount = 0;

update public.budget_versions set status = 'approved', approved_by = created_by, approved_at = make_date(fiscal_year - 1, 12, 15)
where version_number = 1 and fiscal_year in (2025, 2026)
  and not (property_id = '20000000-0000-4000-8000-000000000101' and fiscal_year = 2026);
update public.budget_versions set status = 'superseded', approved_by = created_by, approved_at = date '2025-12-15', superseded_at = date '2026-02-10'
where property_id = '20000000-0000-4000-8000-000000000101' and fiscal_year = 2026 and version_number = 1;
update public.budget_versions set status = 'approved', approved_by = created_by, approved_at = date '2026-02-10'
where property_id = '20000000-0000-4000-8000-000000000101' and fiscal_year = 2026 and version_number = 2;

-- -----------------------------------------------------------------------------
-- Document categories and documents (files are written by scripts/seed-local-files.ts)
-- -----------------------------------------------------------------------------
insert into public.document_categories (company_id, key, label, default_visibility, sort_order)
select c.id, k.key, k.label, k.vis::public.document_visibility, k.sort
from public.companies c cross join (values
  ('financial_statements', 'Financial statements', 'general', 10),
  ('owner_reports', 'Owner reports', 'general', 20),
  ('insurance', 'Insurance', 'owner', 30),
  ('contracts', 'Contracts & agreements', 'owner', 40),
  ('loan_documents', 'Loan documents', 'confidential', 50),
  ('tax', 'Tax documents', 'confidential', 60),
  ('warranties', 'Warranties', 'internal', 70),
  ('invoices', 'Invoices & receipts', 'internal', 80),
  ('capex', 'CapEx (quotes, photos)', 'owner', 90),
  ('other', 'Other', 'owner', 100)) k(key, label, vis, sort);

create temporary table seed_docs (id uuid, version_id uuid, company_id uuid, property_id uuid, category text, title text,
  visibility public.document_visibility, period date, filename text, content_type text);
insert into seed_docs values
  ('70000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'financial_statements', 'August 2026 P&L (PDF)', 'general', '2026-08-01', 'HV-SEA-PL-2026-08.pdf', 'application/pdf'),
  ('70000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'insurance', 'Property insurance certificate 2026', 'owner', null, 'HV-SEA-insurance-2026.pdf', 'application/pdf'),
  ('70000000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'loan_documents', 'Loan agreement & bank account details', 'confidential', null, 'HV-SEA-loan.pdf', 'application/pdf'),
  ('70000000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'warranties', 'Chiller warranty (internal)', 'internal', null, 'HV-SEA-chiller-warranty.pdf', 'application/pdf'),
  ('70000000-0000-4000-8000-000000000005', '71000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', 'financial_statements', 'August 2026 P&L (PDF)', 'general', '2026-08-01', 'HV-PDX-PL-2026-08.pdf', 'application/pdf'),
  ('70000000-0000-4000-8000-000000000006', '71000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', 'financial_statements', 'August 2026 P&L (PDF)', 'general', '2026-08-01', 'HV-SFO-PL-2026-08.pdf', 'application/pdf'),
  ('70000000-0000-4000-8000-000000000007', '71000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', null, 'other', 'Owner portal guide', 'general', null, 'owner-portal-guide.pdf', 'application/pdf'),
  ('70000000-0000-4000-8000-000000000008', '71000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000201', 'financial_statements', 'August 2026 P&L (PDF)', 'general', '2026-08-01', 'SP-DEN-PL-2026-08.pdf', 'application/pdf');

insert into public.documents (id, company_id, property_id, category_key, title, period_month, visibility, created_by)
select id, company_id, property_id, category, title, period, visibility,
  case when company_id = '10000000-0000-4000-8000-000000000001' then '30000000-0000-4000-8000-000000000012'::uuid
       else '30000000-0000-4000-8000-000000000032'::uuid end
from seed_docs;
insert into public.document_versions (id, company_id, property_id, document_id, version_number, storage_key, original_filename, content_type,
  size_bytes, sha256, scan_status, scan_detail, scanned_at, uploaded_by, upload_completed_at)
select version_id, company_id, property_id, id, 1, format('clean/%s/%s/%s/%s.pdf', company_id, coalesce(property_id::text, 'company'), id, version_id),
  filename, content_type, 2048, null, 'clean', 'Demo seed file', now(), null, now()
from seed_docs;
update public.documents d set current_version_id = s.version_id from seed_docs s where s.id = d.id;

-- A version still awaiting scan (only visible to document managers / uploader).
insert into public.document_versions (id, company_id, property_id, document_id, version_number, storage_key, original_filename, content_type,
  size_bytes, scan_status, uploaded_by, upload_completed_at)
values ('71000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101',
  '70000000-0000-4000-8000-000000000002', 2, 'quarantine/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000101/70000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000101.pdf',
  'HV-SEA-insurance-2026-v2.pdf', 'application/pdf', 2048, 'pending', '30000000-0000-4000-8000-000000000014', now());

-- Link the PDF to the already-published report (seed only: bypasses the immutability trigger).
set session_replication_role = replica;
update public.financial_reports r set document_id = '70000000-0000-4000-8000-000000000001'
where r.property_id = '20000000-0000-4000-8000-000000000101' and r.period_month = date '2026-08-01' and r.status = 'published';
set session_replication_role = origin;

-- -----------------------------------------------------------------------------
-- CapEx
-- -----------------------------------------------------------------------------
insert into public.capex_approval_thresholds (company_id, property_id, min_amount, max_amount, approver_type, approvals_required) values
  ('10000000-0000-4000-8000-000000000001', null, 0, null, 'corporate', 1),
  ('10000000-0000-4000-8000-000000000001', null, 25000, null, 'owner', 1),
  ('10000000-0000-4000-8000-000000000002', null, 0, 250000, 'corporate', 1),
  ('10000000-0000-4000-8000-000000000002', null, 250000, null, 'corporate', 2),
  ('10000000-0000-4000-8000-000000000002', null, 50000, null, 'owner', 1);

insert into public.capex_vendors (id, company_id, name, contact_email) values
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Northwind Interiors (fictional)', 'bids@northwind.example'),
  ('80000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Cascade Mechanical (fictional)', 'office@cascademech.example'),
  ('80000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Bright Path Electric (fictional)', 'jobs@brightpath.example'),
  ('80000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'Front Range Fitness Supply (fictional)', 'sales@frfs.example'),
  ('80000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', 'Biscayne Pool Works (fictional)', 'pm@biscaynepool.example');

select set_config('app.capex_approval_in_progress', 'on', false);

insert into public.capex_projects (id, company_id, property_id, project_number, title, category, description, status, priority,
  requested_budget, approved_budget, target_start, target_completion, actual_completion, percent_complete, created_by) values
  ('81000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'CPX-2026-0001',
   'Guest room soft goods refresh (floors 3–6)', 'guest_rooms', 'Replace carpet, drapery, bedding and lounge seating in 112 rooms.',
   'in_progress', 'high', 480000, 480000, '2026-01-05', '2026-11-30', null, 55, '30000000-0000-4000-8000-000000000013'),
  ('81000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'CPX-2026-0002',
   'Lobby lighting LED retrofit', 'public_areas', 'Convert lobby and corridor fixtures to LED with dimming controls.',
   'completed', 'normal', 18000, 18000, '2026-03-01', '2026-04-15', '2026-04-10', 100, '30000000-0000-4000-8000-000000000014'),
  ('81000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', 'CPX-2026-0003',
   'Cooling tower replacement', 'building_systems', 'Existing tower (2003) at end of life; failure risk during summer peak.',
   'pending_approval', 'urgent', 145000, 0, '2026-11-01', '2027-03-31', null, 0, '30000000-0000-4000-8000-000000000014'),
  ('81000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', 'CPX-2026-0004',
   'New wing FF&E (12 rooms)', 'guest_rooms', 'Furniture, fixtures and equipment for the 12-room expansion.',
   'completed', 'high', 410000, 425000, '2025-10-01', '2026-02-28', '2026-02-26', 100, '30000000-0000-4000-8000-000000000013'),
  ('81000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', 'CPX-2026-0005',
   'Restaurant patio enclosure', 'food_beverage', 'Retractable enclosure to extend patio season.',
   'draft', 'normal', 65000, 0, '2027-03-01', '2027-05-15', null, 0, '30000000-0000-4000-8000-000000000013'),
  ('81000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', 'CPX-2026-0006',
   'Elevator modernization', 'building_systems', 'Controller and cab modernization for two passenger elevators.',
   'in_progress', 'high', 390000, 390000, '2026-06-01', '2027-01-31', null, 35, '30000000-0000-4000-8000-000000000013'),
  ('81000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000201', 'CPX-2026-0001',
   'Fitness center refresh', 'public_areas', 'New cardio equipment, flooring and AV.',
   'pending_approval', 'normal', 85000, 0, '2026-12-01', '2027-01-31', null, 0, '30000000-0000-4000-8000-000000000031'),
  ('81000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000203', 'CPX-2026-0002',
   'Pool deck resurfacing', 'exterior', 'Resurface pool deck and replace loungers.',
   'approved', 'normal', 120000, 120000, '2026-11-15', '2027-01-15', null, 0, '30000000-0000-4000-8000-000000000031');

insert into public.capex_approval_requests (id, company_id, property_id, project_id, request_type, amount, new_approved_budget,
  previous_approved_budget, justification, status, required_steps, requested_by, created_at, decided_at) values
  ('82000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001',
   'initial', 480000, 480000, 0, 'Brand standards deadline and guest satisfaction scores for soft goods.', 'approved',
   '[{"approver_type":"corporate","approvals_required":1},{"approver_type":"owner","approvals_required":1}]', '30000000-0000-4000-8000-000000000013', '2025-11-10', '2025-11-20'),
  ('82000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000002',
   'initial', 18000, 18000, 0, 'Energy savings with an estimated 2.1-year payback.', 'approved',
   '[{"approver_type":"corporate","approvals_required":1}]', '30000000-0000-4000-8000-000000000014', '2026-02-10', '2026-02-12'),
  ('82000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000003',
   'initial', 145000, 145000, 0, 'Tower inspection report rates condition as poor; replacement before summer avoids outage risk.', 'pending',
   '[{"approver_type":"corporate","approvals_required":1},{"approver_type":"owner","approvals_required":1}]', '30000000-0000-4000-8000-000000000014', now() - interval '4 days', null),
  ('82000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', '81000000-0000-4000-8000-000000000004',
   'initial', 410000, 410000, 0, 'FF&E package for the approved 12-room expansion.', 'approved',
   '[{"approver_type":"corporate","approvals_required":1},{"approver_type":"owner","approvals_required":1}]', '30000000-0000-4000-8000-000000000013', '2025-08-01', '2025-08-12'),
  ('82000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', '81000000-0000-4000-8000-000000000004',
   'change_order', 15000, 425000, 410000, 'Upgraded blackout drapery required by brand after design review.', 'approved',
   '[{"approver_type":"corporate","approvals_required":1}]', '30000000-0000-4000-8000-000000000013', '2025-12-01', '2025-12-03'),
  ('82000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', '81000000-0000-4000-8000-000000000006',
   'initial', 390000, 390000, 0, 'Code compliance and reliability; parts no longer manufactured.', 'approved',
   '[{"approver_type":"corporate","approvals_required":1},{"approver_type":"owner","approvals_required":1}]', '30000000-0000-4000-8000-000000000013', '2026-04-01', '2026-04-20'),
  ('82000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000201', '81000000-0000-4000-8000-000000000007',
   'initial', 85000, 85000, 0, 'Fitness center is the lowest-rated amenity in guest surveys for two years.', 'pending',
   '[{"approver_type":"corporate","approvals_required":1},{"approver_type":"owner","approvals_required":1}]', '30000000-0000-4000-8000-000000000031', now() - interval '6 days', null),
  ('82000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000203', '81000000-0000-4000-8000-000000000008',
   'initial', 120000, 120000, 0, 'Deck surface failing; slip-hazard reports increasing.', 'approved',
   '[{"approver_type":"corporate","approvals_required":1},{"approver_type":"owner","approvals_required":1}]', '30000000-0000-4000-8000-000000000031', '2026-08-01', '2026-08-15');

insert into public.capex_approval_decisions (company_id, request_id, approver_type, decision, comment, decided_by, decided_at) values
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'corporate', 'approved', 'Within plan.', '30000000-0000-4000-8000-000000000012', '2025-11-12'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'owner', 'approved', 'Approved — please phase to limit displacement.', '30000000-0000-4000-8000-000000000021', '2025-11-20'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000002', 'corporate', 'approved', null, '30000000-0000-4000-8000-000000000013', '2026-02-12'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000003', 'corporate', 'approved', 'Inspection report attached; recommend approval.', '30000000-0000-4000-8000-000000000013', now() - interval '2 days'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000004', 'corporate', 'approved', null, '30000000-0000-4000-8000-000000000012', '2025-08-05'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000004', 'owner', 'approved', null, '30000000-0000-4000-8000-000000000021', '2025-08-12'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000005', 'corporate', 'approved', 'Under owner threshold.', '30000000-0000-4000-8000-000000000012', '2025-12-03'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000006', 'corporate', 'approved', null, '30000000-0000-4000-8000-000000000012', '2026-04-05'),
  ('10000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000006', 'owner', 'approved', 'Bay Lodging Partners approval on file.', '30000000-0000-4000-8000-000000000011', '2026-04-20'),
  ('10000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000008', 'corporate', 'approved', null, '30000000-0000-4000-8000-000000000032', '2026-08-05'),
  ('10000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000008', 'owner', 'approved', 'Front Range Capital consent received.', '30000000-0000-4000-8000-000000000031', '2026-08-15');

insert into public.capex_transactions (company_id, property_id, project_id, kind, status, vendor_id, reference, description, amount, transaction_date, created_by) values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001', 'quote', 'closed', '80000000-0000-4000-8000-000000000001', 'Q-1182', 'Soft goods package quote', 468000, '2025-10-20', '30000000-0000-4000-8000-000000000013'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001', 'commitment', 'open', '80000000-0000-4000-8000-000000000001', 'PO-2026-014', 'Floors 5–6 package', 236000, '2026-04-02', '30000000-0000-4000-8000-000000000013'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001', 'actual', 'closed', '80000000-0000-4000-8000-000000000001', 'INV-88213', 'Floors 3–4 delivered and installed', 221500, '2026-03-28', '30000000-0000-4000-8000-000000000013'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001', 'actual', 'closed', null, 'INV-LOCAL-22', 'Installation labor (floors 3–4)', 14800, '2026-04-05', '30000000-0000-4000-8000-000000000014'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000002', 'actual', 'closed', '80000000-0000-4000-8000-000000000003', 'INV-5521', 'LED fixtures and install', 17240, '2026-04-10', '30000000-0000-4000-8000-000000000014'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000003', 'quote', 'open', '80000000-0000-4000-8000-000000000002', 'Q-7740', 'Cooling tower replacement quote', 139500, now()::date - 10, '30000000-0000-4000-8000-000000000014'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', '81000000-0000-4000-8000-000000000004', 'actual', 'closed', '80000000-0000-4000-8000-000000000001', 'INV-90011', 'New wing FF&E', 419850, '2026-02-20', '30000000-0000-4000-8000-000000000013'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', '81000000-0000-4000-8000-000000000006', 'commitment', 'open', null, 'PO-2026-031', 'Elevator modernization contract (balance)', 253500, '2026-05-20', '30000000-0000-4000-8000-000000000013'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', '81000000-0000-4000-8000-000000000006', 'actual', 'closed', null, 'INV-EL-1', 'Mobilization and controller deposit', 136500, '2026-06-15', '30000000-0000-4000-8000-000000000013'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000203', '81000000-0000-4000-8000-000000000008', 'commitment', 'open', '80000000-0000-4000-8000-000000000005', 'PO-SP-118', 'Resurfacing contract', 104000, '2026-09-01', '30000000-0000-4000-8000-000000000031');

insert into public.capex_updates (company_id, property_id, project_id, body, percent_complete, visibility, created_by, created_at) values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001', 'Floors 3–4 complete and back in inventory. Floors 5–6 materials arriving in October; work phased two floors at a time to limit displacement.', 55, 'owner', '30000000-0000-4000-8000-000000000013', now() - interval '12 days'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '81000000-0000-4000-8000-000000000001', 'Vendor requested 3% escalation on floors 5–6; negotiating to hold the PO price.', null, 'internal', '30000000-0000-4000-8000-000000000012', now() - interval '6 days'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', '81000000-0000-4000-8000-000000000006', 'Car 1 controller replaced; car 2 scheduled for November.', 35, 'owner', '30000000-0000-4000-8000-000000000013', now() - interval '20 days');

select set_config('app.capex_approval_in_progress', 'off', false);

-- -----------------------------------------------------------------------------
-- Management commentary (last full month)
-- -----------------------------------------------------------------------------
insert into public.management_commentary (company_id, property_id, period_month, section, title, body, visibility, status, created_by, published_by, published_at)
select p.company_id, p.id, (date_trunc('month', current_date) - interval '2 month')::date, s.section, s.title, s.body, s.vis, 'published',
  case when p.company_id = '10000000-0000-4000-8000-000000000001' then '30000000-0000-4000-8000-000000000013'::uuid else '30000000-0000-4000-8000-000000000031'::uuid end,
  case when p.company_id = '10000000-0000-4000-8000-000000000001' then '30000000-0000-4000-8000-000000000013'::uuid else '30000000-0000-4000-8000-000000000031'::uuid end,
  now() - interval '20 days'
from public.properties p cross join (values
  ('executive_summary', 'Month in review', 'RevPAR finished ahead of prior year on stronger weekend transient rate. Group pace for Q4 remains slightly behind budget; sales team is targeting association business to backfill.', 'owner'),
  ('financial', 'Profitability', 'Flow-through was in line with expectations. Utilities ran above budget due to an extended cooling season; we expect normalization next month.', 'owner'),
  ('operations', 'Internal: staffing', 'Two front office supervisor vacancies; overtime elevated. Do not share externally until offers are accepted.', 'internal')
) s(section, title, body, vis);

-- -----------------------------------------------------------------------------
-- Ingestion configuration
-- -----------------------------------------------------------------------------
insert into public.ingestion_sources (id, company_id, name, channel, report_type, parser_key, revision_policy, expected_cadence, expected_by_local, expected_by_day, created_by) values
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Nightly PMS flash (email)', 'email', 'daily_performance', 'hop.daily_performance.v1', 'replace', 'daily', '11:00', null, '30000000-0000-4000-8000-000000000012'),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Monthly GL export', 'manual', 'monthly_actuals', 'hop.monthly_actuals.v1', 'require_review', 'monthly', null, 15, '30000000-0000-4000-8000-000000000012');
insert into public.ingestion_source_routes (source_id, company_id, inbound_token, allowed_senders) values
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'hvflash7k2m9', array['nightaudit@harborview.example', '@pms.harborview.example']),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'hvgl4p8q1z', array['controller@harborview.example']);
insert into public.ingestion_property_mappings (company_id, source_id, external_code, property_id) values
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'SEA01', '20000000-0000-4000-8000-000000000101'),
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'PDX01', '20000000-0000-4000-8000-000000000102'),
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'SFO01', '20000000-0000-4000-8000-000000000103'),
  ('10000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'HNL01', '20000000-0000-4000-8000-000000000104');

insert into public.integration_connections (company_id, kind, provider, status, settings) values
  ('10000000-0000-4000-8000-000000000001', 'pms', 'unspecified', 'not_configured', '{"note":"PMS vendor and API access to be confirmed."}'),
  ('10000000-0000-4000-8000-000000000002', 'accounting', 'unspecified', 'not_configured', '{}');

-- -----------------------------------------------------------------------------
-- Reporting package for the last full month, published through the real RPCs
-- (impersonating Harborview finance) so snapshots, events and notifications are genuine.
-- -----------------------------------------------------------------------------
do $$
declare
  v_pkg uuid;
  v_prop uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"30000000-0000-4000-8000-000000000012","role":"authenticated","aal":"aal2"}', true);
  foreach v_prop in array array['20000000-0000-4000-8000-000000000101', '20000000-0000-4000-8000-000000000102']::uuid[] loop
    v_pkg := public.create_reporting_package(v_prop, (date_trunc('month', current_date) - interval '2 month')::date, null);
    perform public.publish_reporting_package(v_pkg, 'Monthly owner package');
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

drop schema seed cascade;
