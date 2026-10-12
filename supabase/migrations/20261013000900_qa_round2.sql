-- QA round 2 fixes (R2-xx ids in the fix list).

-- =============================================================================
-- R2-01 New companies get the standard chart of reporting accounts and
-- document categories (previously only present in demo seed data)
-- =============================================================================
create or replace function app.seed_company_defaults(p_company_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.financial_accounts (company_id, code, name, nature, section, sort_order, kpi_role)
  select p_company_id, a.code, a.name, a.nature, a.section, a.sort_order, a.kpi_role
  from (values
    ('ROOMS_AVAILABLE', 'Rooms available', 'statistic', 'Statistics', 10, 'rooms_available'),
    ('ROOMS_SOLD', 'Rooms sold', 'statistic', 'Statistics', 20, 'rooms_sold'),
    ('REV_ROOMS', 'Rooms revenue', 'revenue', 'Revenue', 100, 'room_revenue'),
    ('REV_FB', 'Food & beverage revenue', 'revenue', 'Revenue', 110, null),
    ('REV_OTHER', 'Other operated departments', 'revenue', 'Revenue', 120, null),
    ('EXP_ROOMS', 'Rooms expense', 'expense', 'Departmental expenses', 200, null),
    ('EXP_FB', 'Food & beverage expense', 'expense', 'Departmental expenses', 210, null),
    ('EXP_OTHER_DEPT', 'Other departmental expense', 'expense', 'Departmental expenses', 220, null),
    ('EXP_AG', 'Administrative & general', 'expense', 'Undistributed expenses', 300, null),
    ('EXP_IT', 'Information & telecom systems', 'expense', 'Undistributed expenses', 310, null),
    ('EXP_SM', 'Sales & marketing', 'expense', 'Undistributed expenses', 320, null),
    ('EXP_POM', 'Property operations & maintenance', 'expense', 'Undistributed expenses', 330, null),
    ('EXP_UTIL', 'Utilities', 'expense', 'Undistributed expenses', 340, null),
    ('EXP_MGMT_FEE', 'Base management fee', 'expense', 'Management fees', 400, null),
    ('EXP_PROP_TAX', 'Property & other taxes', 'expense', 'Fixed charges', 500, null),
    ('EXP_INSURANCE', 'Insurance', 'expense', 'Fixed charges', 510, null),
    ('EXP_FFE_RESERVE', 'FF&E reserve', 'expense', 'Fixed charges', 520, null)
  ) a(code, name, nature, section, sort_order, kpi_role)
  -- A company may already use a KPI role on a custom account; keep theirs.
  where a.kpi_role is null or not exists (
    select 1 from public.financial_accounts f where f.company_id = p_company_id and f.kpi_role = a.kpi_role)
  on conflict (company_id, code) do nothing;

  insert into public.document_categories (company_id, key, label, default_visibility, sort_order)
  select p_company_id, k.key, k.label, k.vis::public.document_visibility, k.sort
  from (values
    ('financial_statements', 'Financial statements', 'general', 10),
    ('owner_reports', 'Owner reports', 'general', 20),
    ('insurance', 'Insurance', 'owner', 30),
    ('contracts', 'Contracts & agreements', 'owner', 40),
    ('loan_documents', 'Loan documents', 'confidential', 50),
    ('tax', 'Tax documents', 'confidential', 60),
    ('warranties', 'Warranties', 'internal', 70),
    ('invoices', 'Invoices & receipts', 'internal', 80),
    ('capex', 'CapEx (quotes, photos)', 'owner', 90),
    ('other', 'Other', 'owner', 100)
  ) k(key, label, vis, sort)
  on conflict (company_id, key) do nothing;
end;
$$;
revoke execute on function app.seed_company_defaults(uuid) from public;

create or replace function public.provision_company(
  p_slug text, p_name text, p_portal_name text, p_admin_email text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_inv_id uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'only platform administrators can provision companies' using errcode = '42501';
  end if;
  if not app.privileged_aal_ok() then
    raise exception 'verify with two-factor authentication (aal2) before provisioning a company' using errcode = '42501';
  end if;
  insert into public.companies (slug, name) values (p_slug, p_name) returning id into v_company;
  insert into public.company_branding (company_id, portal_name) values (v_company, p_portal_name);
  insert into public.company_modules (company_id, module)
  select v_company, m from unnest(enum_range(null::public.portal_module)) m;
  perform app.seed_company_defaults(v_company);
  insert into public.invitations (company_id, email, role, all_properties, token_hash, invited_by, expires_at)
  values (v_company, lower(trim(p_admin_email)), 'company_admin', true,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(), now() + interval '14 days')
  returning id into v_inv_id;
  return jsonb_build_object('company_id', v_company, 'invitation_id', v_inv_id, 'token', v_token);
end;
$$;
grant execute on function public.provision_company(text, text, text, text) to authenticated;

-- Backfill companies provisioned before this fix.
select app.seed_company_defaults(c.id) from public.companies c
 where not exists (select 1 from public.financial_accounts f where f.company_id = c.id)
    or not exists (select 1 from public.document_categories k where k.company_id = c.id);

-- =============================================================================
-- R2-03 Owner packages only include documents with a released current version
-- =============================================================================
create or replace function app.document_is_released(p_document_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.documents d join public.document_versions v on v.id = d.current_version_id
    where d.id = p_document_id and d.status = 'active' and app.version_is_releasable(v));
$$;

create or replace function public.add_package_document(p_package_id uuid, p_document_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  pk public.reporting_packages;
  d public.documents;
  v_id uuid;
begin
  select * into pk from public.reporting_packages where id = p_package_id for update;
  if not found or not app.has_permission('reports.edit', pk.company_id, pk.property_id) then
    raise exception 'permission denied: reports.edit' using errcode = '42501';
  end if;
  select * into d from public.documents where id = p_document_id and company_id = pk.company_id;
  if not found or (d.property_id is not null and d.property_id <> pk.property_id) then
    raise exception 'document not found for this property' using errcode = '22023';
  end if;
  if d.visibility in ('internal', 'confidential') then
    raise exception 'internal or confidential documents cannot be included in owner packages' using errcode = '22023';
  end if;
  if not app.document_is_released(d.id) then
    raise exception 'document has no released version (scan pending or rejected)' using errcode = '22023';
  end if;
  select id into v_id from public.reporting_package_items
   where package_id = pk.id and item_type = 'document' and ref_id = d.id;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.reporting_package_items (company_id, package_id, item_type, ref_id, title, sort_order)
  values (pk.company_id, pk.id, 'document', d.id, d.title, 60) returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.add_package_document(uuid, uuid) to authenticated;

create or replace function public.get_reporting_package(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pk public.reporting_packages;
  s jsonb;
  v_can_draft boolean;
begin
  select * into pk from public.reporting_packages where id = p_package_id;
  if not found then return null; end if;
  v_can_draft := app.has_permission('reports.edit', pk.company_id, pk.property_id);
  if not (v_can_draft or (pk.status in ('published', 'superseded') and app.has_permission('reports.view', pk.company_id, pk.property_id))) then
    return null;
  end if;
  select snapshot into s from public.reporting_package_snapshots where package_id = pk.id;
  if s is null and v_can_draft then
    s := app.build_package_snapshot(pk);
  end if;
  if s is not null then
    if not app.has_permission('performance.view', pk.company_id, pk.property_id) then
      s := s - 'performance' - 'performance_prior_year';
    end if;
    if not app.has_permission('financials.view', pk.company_id, pk.property_id) then
      s := s - 'financial_report';
    end if;
    if not (app.has_permission('budgets.view', pk.company_id, pk.property_id) and app.has_permission('financials.view', pk.company_id, pk.property_id)) then
      s := s - 'budget_variance';
    end if;
    if not app.has_permission('capex.view', pk.company_id, pk.property_id) then
      s := s - 'capex';
    end if;
    if not app.has_permission('commentary.view', pk.company_id, pk.property_id) then
      s := s - 'commentary';
    end if;
    -- Documents: only those the viewer could open themselves (current visibility)
    -- and, unless they manage documents, only with a released current version.
    if s ? 'documents' then
      s := jsonb_set(s, '{documents}', coalesce((
        select jsonb_agg(e)
        from jsonb_array_elements(s -> 'documents') e
        join public.documents d on d.id = (e ->> 'document_id')::uuid
        where app.can_view_document(d.company_id, d.property_id, d.visibility)
          and (app.document_is_released(d.id) or app.has_permission('documents.manage', d.company_id, d.property_id))), '[]'::jsonb));
    end if;
  end if;
  return jsonb_build_object('package', to_jsonb(pk), 'snapshot', s, 'is_preview', pk.status not in ('published', 'superseded'),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.sort_order), '[]'::jsonb)
              from public.reporting_package_items i
              where i.package_id = pk.id
                and (i.item_type <> 'document' or exists (
                  select 1 from public.documents d where d.id = i.ref_id
                    and app.can_view_document(d.company_id, d.property_id, d.visibility)
                    and (app.document_is_released(d.id) or app.has_permission('documents.manage', d.company_id, d.property_id))))));
end;
$$;
grant execute on function public.get_reporting_package(uuid) to authenticated;

create or replace function app.build_package_snapshot(pk public.reporting_packages) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := pk.period_month;
  v_to date := (pk.period_month + interval '1 month - 1 day')::date;
  v_py_from date := (pk.period_month - interval '1 year')::date;
  v_py_to date := ((pk.period_month - interval '1 year') + interval '1 month - 1 day')::date;
  v_perf jsonb;
  v_py jsonb;
  v_budget jsonb;
  v_fin jsonb;
  v_comm jsonb;
  v_capex jsonb;
  v_docs jsonb;
  v_prop jsonb;
  v_report_id uuid;
begin
  select jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'timezone', p.timezone) into v_prop
  from public.properties p where p.id = pk.property_id;

  select jsonb_build_object(
    'available_room_nights', sum(case when coalesce(c.ooo_treatment, 'exclude') = 'exclude' then d.physical_rooms - d.rooms_out_of_order else d.physical_rooms end),
    'rooms_sold', sum(case when coalesce(c.comp_treatment, 'exclude') = 'include' then d.rooms_sold + d.rooms_comp else d.rooms_sold end),
    'room_revenue', sum(d.room_revenue),
    'total_revenue', case when count(d.total_revenue) = count(*) then sum(d.total_revenue) end,
    'reported_days', count(*),
    'expected_days', (v_to - v_from + 1))
  into v_perf
  from public.daily_performance d left join public.property_reporting_config c on c.property_id = d.property_id
  where d.property_id = pk.property_id and d.business_date between v_from and v_to;

  select jsonb_build_object(
    'available_room_nights', sum(case when coalesce(c.ooo_treatment, 'exclude') = 'exclude' then d.physical_rooms - d.rooms_out_of_order else d.physical_rooms end),
    'rooms_sold', sum(case when coalesce(c.comp_treatment, 'exclude') = 'include' then d.rooms_sold + d.rooms_comp else d.rooms_sold end),
    'room_revenue', sum(d.room_revenue),
    'total_revenue', case when count(d.total_revenue) = count(*) then sum(d.total_revenue) end,
    'reported_days', count(*),
    'expected_days', (v_py_to - v_py_from + 1))
  into v_py
  from public.daily_performance d left join public.property_reporting_config c on c.property_id = d.property_id
  where d.property_id = pk.property_id and d.business_date between v_py_from and v_py_to;

  select id into v_report_id from public.financial_reports
   where property_id = pk.property_id and period_month = pk.period_month and status = 'published';

  select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'code', a.code, 'name', a.name, 'nature', a.nature,
           'section', a.section, 'sort_order', a.sort_order, 'kpi_role', a.kpi_role,
           'actual', act.amount, 'budget', bud.amount) order by a.sort_order), '[]'::jsonb)
  into v_budget
  from public.financial_accounts a
  left join (select l.account_id, sum(l.amount) amount from public.financial_report_lines l
             where l.financial_report_id = v_report_id group by 1) act on act.account_id = a.id
  left join (select l.account_id, sum(l.amount) amount from public.budget_lines l
             join public.budget_versions v on v.id = l.budget_version_id and v.status = 'approved'
             where l.property_id = pk.property_id and l.period_month = pk.period_month group by 1) bud on bud.account_id = a.id
  where a.company_id = pk.company_id and (act.amount is not null or bud.amount is not null);

  select case when r.id is null then null else jsonb_build_object('id', r.id, 'title', r.title, 'revision', r.revision,
           'published_at', r.published_at) end
  into v_fin from public.financial_reports r where r.id = v_report_id;

  select coalesce(jsonb_agg(jsonb_build_object('section', m.section, 'title', m.title, 'body', m.body,
           'published_at', m.published_at) order by m.section, m.created_at), '[]'::jsonb)
  into v_comm from public.management_commentary m
  where m.company_id = pk.company_id and (m.property_id = pk.property_id or m.property_id is null)
    and m.period_month = pk.period_month and m.visibility = 'owner' and m.status = 'published';

  select coalesce(jsonb_agg(jsonb_build_object('project_id', s.project_id, 'number', p.project_number, 'title', p.title,
           'status', p.status, 'approved_budget', s.approved_budget, 'actual_spend', s.actual_spend,
           'open_commitments', s.open_commitments, 'remaining', s.remaining, 'percent_complete', p.percent_complete,
           'latest_update', (select u.body from public.capex_updates u where u.project_id = p.id and u.visibility = 'owner'
                             order by u.created_at desc limit 1)) order by p.project_number), '[]'::jsonb)
  into v_capex
  from public.capex_projects p
  join lateral (
    select p.id as project_id, p.approved_budget,
      coalesce(sum(t.amount) filter (where t.kind = 'actual' and t.status <> 'void'), 0) as actual_spend,
      coalesce(sum(t.amount) filter (where t.kind = 'commitment' and t.status = 'open'), 0) as open_commitments,
      p.approved_budget - coalesce(sum(t.amount) filter (where t.kind = 'actual' and t.status <> 'void'), 0)
        - coalesce(sum(t.amount) filter (where t.kind = 'commitment' and t.status = 'open'), 0) as remaining
    from public.capex_transactions t where t.project_id = p.id
  ) s on true
  where p.property_id = pk.property_id and p.status not in ('draft', 'cancelled', 'rejected');

  -- Only documents with a released (clean) current version are frozen into the package.
  select coalesce(jsonb_agg(jsonb_build_object('document_id', d.id, 'title', d.title, 'visibility', d.visibility)), '[]'::jsonb)
  into v_docs from public.reporting_package_items i join public.documents d on d.id = i.ref_id
  where i.package_id = pk.id and i.item_type = 'document' and app.document_is_released(d.id);

  return jsonb_build_object(
    'property', v_prop, 'period_month', pk.period_month, 'generated_at', now(),
    'performance', v_perf, 'performance_prior_year', v_py,
    'financial_report', v_fin, 'budget_variance', v_budget,
    'commentary', v_comm, 'capex', v_capex, 'documents', v_docs,
    'definitions', jsonb_build_object(
      'occupancy', 'Rooms sold / available room nights × 100',
      'adr', 'Room revenue / rooms sold',
      'revpar', 'Room revenue / available room nights',
      'capex_remaining', 'Approved budget − actual spend − open commitments',
      'performance_status', 'Daily operating figures are provisional; financial statements are published accounting figures'));
end;
$$;

create or replace function public.create_reporting_package_revision(p_package_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  pk public.reporting_packages;
  v_id uuid;
  v_rev integer;
begin
  select * into pk from public.reporting_packages where id = p_package_id;
  if not found or not app.has_permission('reports.edit', pk.company_id, pk.property_id) then
    raise exception 'permission denied: reports.edit' using errcode = '42501';
  end if;
  if pk.status <> 'published' then
    raise exception 'revisions are created from the published package' using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a correction reason is required' using errcode = '22023';
  end if;
  select max(revision) + 1 into v_rev from public.reporting_packages where property_id = pk.property_id and period_month = pk.period_month;
  insert into public.reporting_packages (company_id, property_id, period_month, revision, supersedes_id, correction_reason, title, summary, created_by)
  values (pk.company_id, pk.property_id, pk.period_month, v_rev, pk.id, p_reason, pk.title, pk.summary, auth.uid())
  returning id into v_id;
  insert into public.reporting_package_items (company_id, package_id, item_type, ref_id, title, sort_order)
  select company_id, v_id, item_type,
         case when item_type = 'financial_report' then
           coalesce((select r.id from public.financial_reports r where r.property_id = pk.property_id
                       and r.period_month = pk.period_month and r.status = 'published'), ref_id)
         else ref_id end,
         title, sort_order
  from public.reporting_package_items
  where package_id = pk.id
    and (item_type <> 'document' or app.document_is_released(ref_id));
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
  values (pk.company_id, pk.property_id, 'reporting_package', v_id, v_rev, null, 'draft', 'Revision created: ' || p_reason, auth.uid());
  return v_id;
end;
$$;
grant execute on function public.create_reporting_package_revision(uuid, text) to authenticated;

-- =============================================================================
-- R2-16 The two-year opening guard also runs when a property becomes active
-- R2-21 Room-count error names the full range
-- =============================================================================
create or replace function app.property_opened_on_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_first date;
  v_opened_changed boolean := tg_op = 'INSERT' or new.opened_on is distinct from old.opened_on;
  v_status_changed boolean := tg_op = 'INSERT' or new.status is distinct from old.status;
begin
  if new.opened_on is null or not (v_opened_changed or v_status_changed) then
    return new;
  end if;
  if new.status = 'active' and new.opened_on > current_date + interval '2 years' then
    raise exception 'an active property cannot open more than two years from now' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and v_opened_changed then
    select min(business_date) into v_first from public.daily_performance where property_id = new.id;
    if v_first is not null and new.opened_on > v_first then
      raise exception 'daily data exists from %; the opening date must be on or before it', v_first using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.create_property(
  p_company_id uuid, p_code text, p_name text, p_timezone text, p_status public.property_status default 'onboarding',
  p_brand text default null, p_city text default null, p_region text default null, p_opened_on date default null,
  p_country char(2) default 'US', p_currency char(3) default null, p_room_count integer default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not app.has_permission('admin.company', p_company_id) then
    raise exception 'permission denied: admin.company' using errcode = '42501';
  end if;
  if not app.is_valid_timezone(p_timezone) then
    raise exception 'unknown time zone %', p_timezone using errcode = '22023';
  end if;
  if p_room_count is not null and (p_room_count <= 0 or p_room_count >= 100000) then
    raise exception 'rooms must be a whole number between 1 and 99,999' using errcode = '22023';
  end if;
  insert into public.properties (company_id, code, name, timezone, status, brand, city, region, opened_on, country, currency)
  values (p_company_id, upper(trim(p_code)), trim(p_name), p_timezone, p_status, nullif(trim(p_brand), ''), nullif(trim(p_city), ''),
          nullif(trim(p_region), ''), p_opened_on, p_country,
          coalesce(p_currency, (select default_currency from public.companies where id = p_company_id)))
  returning id into v_id;
  if p_room_count is not null then
    insert into public.room_inventory_history (company_id, property_id, effective_from, room_count, reason, created_by)
    values (p_company_id, v_id, coalesce(p_opened_on, current_date), p_room_count, 'Opening inventory', auth.uid());
  end if;
  return v_id;
end;
$$;
grant execute on function public.create_property(uuid, text, text, text, public.property_status, text, text, text, date, char, char, integer) to authenticated;
