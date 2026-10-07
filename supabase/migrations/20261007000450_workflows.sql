-- =============================================================================
-- Notifications and workflow RPCs for budgets, financial reports and documents
-- =============================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  property_id uuid,
  kind text not null,
  title text not null,
  body text,
  link_path text check (link_path is null or link_path ~ '^/'),
  entity_type text,
  entity_id uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user on public.notifications (user_id, created_at desc);

create table public.notification_preferences (
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null,
  email_enabled boolean not null default true,
  primary key (user_id, company_id, kind)
);

-- Email outbox processed by the notification dispatcher (service role only).
-- Emails never carry financial figures or attachments — only a link to sign in.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notifications (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  to_email text not null,
  subject text not null,
  body_text text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notification_outbox_pending on public.notification_outbox (status, created_at) where status in ('pending', 'failed');

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_outbox enable row level security;
revoke all on public.notifications, public.notification_preferences, public.notification_outbox from anon, authenticated;

grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy notifications_own on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_mark_read on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.notification_preferences to authenticated;
create policy notification_prefs_own on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and (select app.is_member(company_id)));

-- Notify every active member holding p_perm on the property (or company).
create or replace function app.notify_permitted(
  p_company_id uuid, p_property_id uuid, p_perm text, p_kind text, p_title text, p_body text,
  p_link text, p_entity_type text, p_entity_id uuid, p_exclude_user uuid default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  r record;
  v_nid uuid;
  v_from text;
  v_portal text;
begin
  select coalesce(b.email_from_name, c.name), coalesce(b.portal_name, c.name) into v_from, v_portal
  from public.companies c left join public.company_branding b on b.company_id = c.id where c.id = p_company_id;

  for r in
    select distinct m.user_id, pr.email
    from public.company_memberships m
    join public.profiles pr on pr.id = m.user_id
    where m.company_id = p_company_id and m.status = 'active'
      and (p_exclude_user is null or m.user_id <> p_exclude_user)
      and app.user_has_permission(m.user_id, p_perm, p_company_id, p_property_id)
  loop
    insert into public.notifications (company_id, user_id, property_id, kind, title, body, link_path, entity_type, entity_id)
    values (p_company_id, r.user_id, p_property_id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id)
    returning id into v_nid;
    if coalesce((select email_enabled from public.notification_preferences
                 where user_id = r.user_id and company_id = p_company_id and kind = p_kind), true) then
      insert into public.notification_outbox (notification_id, company_id, user_id, to_email, subject, body_text)
      values (v_nid, p_company_id, r.user_id, r.email, format('[%s] %s', v_portal, p_title),
              format(E'%s\n\nSign in to %s to view it securely.\n\nThis message was sent by %s. Financial documents are never attached to email.',
                     p_title, v_portal, v_from));
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function app.notify_permitted(uuid, uuid, text, text, text, text, text, text, uuid, uuid) from authenticated;

create or replace function public.mark_all_notifications_read(p_company_id uuid) returns void
language sql security invoker set search_path = '' as $$
  update public.notifications set read_at = now()
  where user_id = auth.uid() and company_id = p_company_id and read_at is null;
$$;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated;

-- =============================================================================
-- Budgets
-- =============================================================================
create or replace function public.create_budget_version(
  p_property_id uuid, p_fiscal_year integer, p_name text, p_copy_from uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_id uuid;
  v_num integer;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('budgets.edit', v_company, p_property_id) then
    raise exception 'permission denied: budgets.edit' using errcode = '42501';
  end if;
  select coalesce(max(version_number), 0) + 1 into v_num from public.budget_versions
   where property_id = p_property_id and fiscal_year = p_fiscal_year;
  insert into public.budget_versions (company_id, property_id, fiscal_year, version_number, name, created_by)
  values (v_company, p_property_id, p_fiscal_year, v_num, coalesce(nullif(trim(p_name), ''), format('FY%s v%s', p_fiscal_year, v_num)), auth.uid())
  returning id into v_id;
  if p_copy_from is not null then
    if not exists (select 1 from public.budget_versions where id = p_copy_from and property_id = p_property_id) then
      raise exception 'source budget version not found for this property' using errcode = '22023';
    end if;
    insert into public.budget_lines (company_id, property_id, budget_version_id, account_id, period_month, amount)
    select company_id, property_id, v_id, account_id,
           make_date(p_fiscal_year, extract(month from period_month)::integer, 1), amount
    from public.budget_lines where budget_version_id = p_copy_from;
  end if;
  perform app.audit(v_company, 'budget.created', 'budget_version', v_id::text,
                    jsonb_build_object('fiscal_year', p_fiscal_year, 'version', v_num, 'copied_from', p_copy_from), p_property_id);
  return v_id;
end;
$$;
grant execute on function public.create_budget_version(uuid, integer, text, uuid) to authenticated;

create or replace function public.approve_budget_version(p_version_id uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.budget_versions;
begin
  select * into v from public.budget_versions where id = p_version_id for update;
  if not found or not app.has_permission('budgets.approve', v.company_id, v.property_id) then
    raise exception 'permission denied: budgets.approve' using errcode = '42501';
  end if;
  if v.status <> 'draft' then
    raise exception 'only draft budgets can be approved (current: %)', v.status using errcode = '55000';
  end if;
  if not exists (select 1 from public.budget_lines where budget_version_id = v.id) then
    raise exception 'budget has no lines' using errcode = '55000';
  end if;
  update public.budget_versions set status = 'superseded', superseded_at = now()
   where property_id = v.property_id and fiscal_year = v.fiscal_year and status = 'approved';
  update public.budget_versions set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = v.id;
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
  values (v.company_id, v.property_id, 'budget_version', v.id, v.version_number, 'draft', 'approved', p_comment, auth.uid());
  perform app.audit(v.company_id, 'budget.approved', 'budget_version', v.id::text,
                    jsonb_build_object('fiscal_year', v.fiscal_year, 'version', v.version_number), v.property_id);
  perform app.notify_permitted(v.company_id, v.property_id, 'budgets.view', 'budget_approved',
    format('FY%s budget approved', v.fiscal_year), v.name, '/budgets?property=' || v.property_id, 'budget_version', v.id, auth.uid());
end;
$$;
grant execute on function public.approve_budget_version(uuid, text) to authenticated;

-- Budget operating stats for KPI comparisons (approved versions only; RLS applies).
create or replace function public.budget_kpi_monthly(p_company_id uuid, p_from date, p_to date)
returns table (property_id uuid, period_month date, kpi_role text, amount numeric)
language sql stable security invoker set search_path = '' as $$
  select l.property_id, l.period_month, a.kpi_role, sum(l.amount)
  from public.budget_lines l
  join public.budget_versions v on v.id = l.budget_version_id and v.status = 'approved'
  join public.financial_accounts a on a.id = l.account_id and a.kpi_role is not null
  where l.company_id = p_company_id
    and l.period_month between date_trunc('month', p_from)::date and p_to
  group by 1, 2, 3;
$$;
grant execute on function public.budget_kpi_monthly(uuid, date, date) to authenticated;

-- =============================================================================
-- Financial reports
-- =============================================================================
create or replace function app.publication_event(
  p_company uuid, p_property uuid, p_type text, p_id uuid, p_rev integer, p_from text, p_to text, p_comment text
) returns void
language sql security definer set search_path = '' as $$
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
  values (p_company, p_property, p_type, p_id, p_rev, p_from, p_to, p_comment, auth.uid());
$$;

create or replace function public.create_financial_report(p_property_id uuid, p_period_month date, p_title text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_id uuid;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('financials.edit', v_company, p_property_id) then
    raise exception 'permission denied: financials.edit' using errcode = '42501';
  end if;
  if exists (select 1 from public.financial_reports where property_id = p_property_id and period_month = p_period_month) then
    raise exception 'a report already exists for this period; create a revision instead' using errcode = '23505';
  end if;
  insert into public.financial_reports (company_id, property_id, period_month, title, created_by)
  values (v_company, p_property_id, p_period_month,
          coalesce(p_title, format('P&L — %s', to_char(p_period_month, 'FMMonth YYYY'))), auth.uid())
  returning id into v_id;
  perform app.publication_event(v_company, p_property_id, 'financial_report', v_id, 1, null, 'draft', 'Created');
  return v_id;
end;
$$;
grant execute on function public.create_financial_report(uuid, date, text) to authenticated;

create or replace function public.submit_financial_report(p_report_id uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.financial_reports;
begin
  select * into r from public.financial_reports where id = p_report_id for update;
  if not found or not app.has_permission('financials.edit', r.company_id, r.property_id) then
    raise exception 'permission denied: financials.edit' using errcode = '42501';
  end if;
  if r.status <> 'draft' then
    raise exception 'only drafts can be submitted for review (current: %)', r.status using errcode = '55000';
  end if;
  if not exists (select 1 from public.financial_report_lines where financial_report_id = r.id) then
    raise exception 'report has no lines' using errcode = '55000';
  end if;
  update public.financial_reports set status = 'in_review', submitted_by = auth.uid(), submitted_at = now() where id = r.id;
  perform app.publication_event(r.company_id, r.property_id, 'financial_report', r.id, r.revision, 'draft', 'in_review', p_comment);
  perform app.audit(r.company_id, 'financial_report.submitted', 'financial_report', r.id::text, '{}'::jsonb, r.property_id);
  perform app.notify_permitted(r.company_id, r.property_id, 'financials.publish', 'financial_review_requested',
    format('%s ready for review', r.title), null, '/financials/reports/' || r.id, 'financial_report', r.id, auth.uid());
end;
$$;
grant execute on function public.submit_financial_report(uuid, text) to authenticated;

create or replace function public.return_financial_report(p_report_id uuid, p_comment text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.financial_reports;
begin
  select * into r from public.financial_reports where id = p_report_id for update;
  if not found or not app.has_permission('financials.publish', r.company_id, r.property_id) then
    raise exception 'permission denied: financials.publish' using errcode = '42501';
  end if;
  if r.status <> 'in_review' then
    raise exception 'only reports in review can be returned' using errcode = '55000';
  end if;
  if coalesce(trim(p_comment), '') = '' then
    raise exception 'a comment is required when returning a report' using errcode = '22023';
  end if;
  update public.financial_reports set status = 'draft' where id = r.id;
  perform app.publication_event(r.company_id, r.property_id, 'financial_report', r.id, r.revision, 'in_review', 'draft', p_comment);
end;
$$;
grant execute on function public.return_financial_report(uuid, text) to authenticated;

create or replace function public.publish_financial_report(p_report_id uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.financial_reports;
  v_prev uuid;
begin
  select * into r from public.financial_reports where id = p_report_id for update;
  if not found or not app.has_permission('financials.publish', r.company_id, r.property_id) then
    raise exception 'permission denied: financials.publish' using errcode = '42501';
  end if;
  if r.status <> 'in_review' then
    raise exception 'reports must be in review before publishing (current: %)', r.status using errcode = '55000';
  end if;
  select id into v_prev from public.financial_reports
   where property_id = r.property_id and period_month = r.period_month and report_type = r.report_type and status = 'published'
   for update;
  if v_prev is not null then
    update public.financial_reports set status = 'superseded', superseded_at = now() where id = v_prev;
    perform app.publication_event(r.company_id, r.property_id, 'financial_report', v_prev, null, 'published', 'superseded',
                                  format('Superseded by revision %s', r.revision));
  end if;
  update public.financial_reports set status = 'published', published_by = auth.uid(), published_at = now() where id = r.id;
  perform app.publication_event(r.company_id, r.property_id, 'financial_report', r.id, r.revision, 'in_review', 'published', p_comment);
  perform app.audit(r.company_id, 'financial_report.published', 'financial_report', r.id::text,
                    jsonb_build_object('revision', r.revision, 'superseded', v_prev), r.property_id);
  perform app.notify_permitted(r.company_id, r.property_id, 'financials.view', 'financial_report_published',
    case when r.revision > 1 then format('%s (revised) published', r.title) else format('%s published', r.title) end,
    null, '/financials/reports/' || r.id, 'financial_report', r.id, auth.uid());
end;
$$;
grant execute on function public.publish_financial_report(uuid, text) to authenticated;

create or replace function app.create_report_revision(p_report_id uuid, p_reason text, p_actor uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.financial_reports;
  v_id uuid;
  v_rev integer;
begin
  select * into r from public.financial_reports where id = p_report_id for update;
  if r.status <> 'published' then
    raise exception 'revisions can only be created from the published report' using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a correction reason is required' using errcode = '22023';
  end if;
  if exists (select 1 from public.financial_reports where property_id = r.property_id and period_month = r.period_month
             and report_type = r.report_type and status in ('draft', 'in_review')) then
    raise exception 'an open revision already exists for this period' using errcode = '23505';
  end if;
  select max(revision) + 1 into v_rev from public.financial_reports
   where property_id = r.property_id and period_month = r.period_month and report_type = r.report_type;
  insert into public.financial_reports (company_id, property_id, period_month, report_type, revision, supersedes_id,
    correction_reason, title, document_id, created_by)
  values (r.company_id, r.property_id, r.period_month, r.report_type, v_rev, r.id, p_reason, r.title, r.document_id, p_actor)
  returning id into v_id;
  insert into public.financial_report_lines (company_id, property_id, financial_report_id, account_id, amount,
    source_account_code, source_account_name, source_value, import_run_id)
  select company_id, property_id, v_id, account_id, amount, source_account_code, source_account_name, source_value, import_run_id
  from public.financial_report_lines where financial_report_id = r.id;
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
  values (r.company_id, r.property_id, 'financial_report', v_id, v_rev, null, 'draft', 'Revision created: ' || p_reason, p_actor);
  return v_id;
end;
$$;

create or replace function public.create_financial_report_revision(p_report_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.financial_reports;
  v_id uuid;
begin
  select * into r from public.financial_reports where id = p_report_id;
  if not found or not app.has_permission('financials.edit', r.company_id, r.property_id) then
    raise exception 'permission denied: financials.edit' using errcode = '42501';
  end if;
  v_id := app.create_report_revision(p_report_id, p_reason, auth.uid());
  perform app.audit(r.company_id, 'financial_report.revision_created', 'financial_report', v_id::text,
                    jsonb_build_object('supersedes', r.id, 'reason', p_reason), r.property_id);
  return v_id;
end;
$$;
grant execute on function public.create_financial_report_revision(uuid, text) to authenticated;

-- Aggregated statement (reporting accounts) for a report; RLS decides visibility.
create or replace function public.financial_report_statement(p_report_id uuid)
returns table (account_id uuid, code text, name text, nature text, section text, sort_order integer, amount numeric, source_lines integer)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.code, a.name, a.nature, a.section, a.sort_order, sum(l.amount), count(*)::integer
  from public.financial_report_lines l
  join public.financial_reports r on r.id = l.financial_report_id
  join public.financial_accounts a on a.id = l.account_id
  where l.financial_report_id = p_report_id
  group by a.id;
$$;
grant execute on function public.financial_report_statement(uuid) to authenticated;

-- Latest visible report per property/month for actual-vs-budget views.
-- Owners see the latest published revision; finance users can opt into drafts.
create or replace function public.financial_actuals_monthly(
  p_company_id uuid, p_from date, p_to date, p_include_drafts boolean default false
) returns table (property_id uuid, period_month date, account_id uuid, amount numeric, report_id uuid, report_status public.publication_status, revision integer)
language sql stable security invoker set search_path = '' as $$
  with ranked as (
    select r.*, row_number() over (
      partition by r.property_id, r.period_month
      order by case when r.status = 'published' then 1
                    when p_include_drafts and r.status in ('draft', 'in_review') then 0
                    else 9 end, r.revision desc) as rn
    from public.financial_reports r
    where r.company_id = p_company_id and r.period_month between p_from and p_to
      and (r.status = 'published' or (p_include_drafts and r.status in ('draft', 'in_review')))
  )
  select r.property_id, r.period_month, l.account_id, sum(l.amount), r.id, r.status, r.revision
  from ranked r join public.financial_report_lines l on l.financial_report_id = r.id
  where r.rn = 1
  group by r.property_id, r.period_month, l.account_id, r.id, r.status, r.revision;
$$;
grant execute on function public.financial_actuals_monthly(uuid, date, date, boolean) to authenticated;

create or replace function public.budget_monthly(p_company_id uuid, p_from date, p_to date)
returns table (property_id uuid, period_month date, account_id uuid, amount numeric, budget_version_id uuid)
language sql stable security invoker set search_path = '' as $$
  select l.property_id, l.period_month, l.account_id, sum(l.amount), v.id
  from public.budget_lines l
  join public.budget_versions v on v.id = l.budget_version_id and v.status = 'approved'
  where l.company_id = p_company_id and l.period_month between p_from and p_to
  group by l.property_id, l.period_month, l.account_id, v.id;
$$;
grant execute on function public.budget_monthly(uuid, date, date) to authenticated;

-- Service path: write validated monthly actuals into draft reports.
create or replace function public.svc_apply_monthly_actuals(p_import_run_id uuid, p_records jsonb, p_replace boolean, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.import_runs;
  g record;
  v_report public.financial_reports;
  v_report_id uuid;
  v_created integer := 0;
  v_updated integer := 0;
  v_revisions integer := 0;
  v_unchanged integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_incoming jsonb;
  v_existing jsonb;
begin
  select * into v_run from public.import_runs where id = p_import_run_id for update;
  if not found then raise exception 'import run not found'; end if;

  for g in
    select (e ->> 'propertyId')::uuid as property_id, (e ->> 'periodMonth')::date as period_month,
           jsonb_agg(e order by e ->> 'sourceAccountCode') as lines
    from jsonb_array_elements(p_records) e group by 1, 2
  loop
    if not exists (select 1 from public.properties where id = g.property_id and company_id = v_run.company_id) then
      raise exception 'property % does not belong to company', g.property_id using errcode = '42501';
    end if;
    v_incoming := (select jsonb_agg(jsonb_build_object('code', x ->> 'sourceAccountCode', 'amount', (x ->> 'amount')::numeric(16, 2),
                                                       'account', x ->> 'accountId') order by x ->> 'sourceAccountCode')
                   from jsonb_array_elements(g.lines) x);

    select * into v_report from public.financial_reports
     where property_id = g.property_id and period_month = g.period_month and report_type = 'monthly_pnl'
       and status in ('draft', 'in_review');
    if found and v_report.status = 'in_review' then
      v_conflicts := v_conflicts || jsonb_build_object('propertyId', g.property_id, 'periodMonth', g.period_month,
                                                       'reason', 'Report is in review; return it to draft before re-importing');
      continue;
    end if;

    if not found then
      select * into v_report from public.financial_reports
       where property_id = g.property_id and period_month = g.period_month and report_type = 'monthly_pnl' and status = 'published';
      if found then
        v_existing := (select jsonb_agg(jsonb_build_object('code', source_account_code, 'amount', amount, 'account', account_id::text)
                                        order by source_account_code)
                       from public.financial_report_lines where financial_report_id = v_report.id);
        if v_existing = v_incoming then
          v_unchanged := v_unchanged + 1;
          continue;
        end if;
        if not p_replace then
          v_conflicts := v_conflicts || jsonb_build_object('propertyId', g.property_id, 'periodMonth', g.period_month,
                                                           'reason', 'A published report exists; approve the import as a revision to replace it');
          continue;
        end if;
        v_revisions := v_revisions + 1;
        if p_dry_run then continue; end if;
        v_report_id := app.create_report_revision(v_report.id, format('Revised figures imported (run %s)', v_run.id), v_run.requested_by);
      else
        v_created := v_created + 1;
        if p_dry_run then continue; end if;
        insert into public.financial_reports (company_id, property_id, period_month, title, import_run_id, created_by)
        values (v_run.company_id, g.property_id, g.period_month,
                format('P&L — %s', to_char(g.period_month, 'FMMonth YYYY')), v_run.id, v_run.requested_by)
        returning id into v_report_id;
        insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
        values (v_run.company_id, g.property_id, 'financial_report', v_report_id, 1, null, 'draft', 'Created from import', v_run.requested_by);
      end if;
    else
      v_updated := v_updated + 1;
      if p_dry_run then continue; end if;
      v_report_id := v_report.id;
    end if;

    delete from public.financial_report_lines where financial_report_id = v_report_id;
    insert into public.financial_report_lines (company_id, property_id, financial_report_id, account_id, amount,
      source_account_code, source_account_name, source_value, import_run_id)
    select v_run.company_id, g.property_id, v_report_id, (x ->> 'accountId')::uuid, (x ->> 'amount')::numeric,
           x ->> 'sourceAccountCode', x ->> 'sourceAccountName', x ->> 'sourceValue', v_run.id
    from jsonb_array_elements(g.lines) x;
    update public.financial_reports set import_run_id = v_run.id where id = v_report_id;
  end loop;

  return jsonb_build_object('inserted', v_created, 'updated', v_updated + v_revisions, 'revisions', v_revisions,
                            'unchanged', v_unchanged, 'conflicts', jsonb_array_length(v_conflicts), 'conflictDetails', v_conflicts);
end;
$$;
revoke all on function public.svc_apply_monthly_actuals(uuid, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.svc_apply_monthly_actuals(uuid, jsonb, boolean, boolean) to service_role;

-- Service path: imported budgets always become a new draft version.
create or replace function public.svc_apply_budget(p_import_run_id uuid, p_records jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.import_runs;
  g record;
  v_id uuid;
  v_num integer;
  v_versions jsonb := '[]'::jsonb;
  v_lines integer := 0;
begin
  select * into v_run from public.import_runs where id = p_import_run_id for update;
  if not found then raise exception 'import run not found'; end if;
  for g in
    select (e ->> 'propertyId')::uuid as property_id, (e ->> 'fiscalYear')::integer as fy, jsonb_agg(e) as lines
    from jsonb_array_elements(p_records) e group by 1, 2
  loop
    if not exists (select 1 from public.properties where id = g.property_id and company_id = v_run.company_id) then
      raise exception 'property % does not belong to company', g.property_id using errcode = '42501';
    end if;
    v_lines := v_lines + jsonb_array_length(g.lines);
    if p_dry_run then continue; end if;
    select coalesce(max(version_number), 0) + 1 into v_num from public.budget_versions
     where property_id = g.property_id and fiscal_year = g.fy;
    insert into public.budget_versions (company_id, property_id, fiscal_year, version_number, name, import_run_id, created_by, notes)
    values (v_run.company_id, g.property_id, g.fy, v_num, format('FY%s v%s (imported)', g.fy, v_num), v_run.id, v_run.requested_by,
            'Imported from file; review and approve to make it the active budget.')
    returning id into v_id;
    insert into public.budget_lines (company_id, property_id, budget_version_id, account_id, period_month, amount)
    select v_run.company_id, g.property_id, v_id, (x ->> 'accountId')::uuid, (x ->> 'periodMonth')::date, (x ->> 'amount')::numeric
    from jsonb_array_elements(g.lines) x;
    v_versions := v_versions || jsonb_build_object('propertyId', g.property_id, 'fiscalYear', g.fy, 'budgetVersionId', v_id, 'version', v_num);
  end loop;
  return jsonb_build_object('inserted', v_lines, 'updated', 0, 'unchanged', 0, 'conflicts', 0, 'budgetVersions', v_versions);
end;
$$;
revoke all on function public.svc_apply_budget(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.svc_apply_budget(uuid, jsonb, boolean) to service_role;

-- =============================================================================
-- Documents
-- =============================================================================
create table public.allowed_document_types (
  content_type text primary key,
  extensions text[] not null,
  max_bytes bigint not null
);
insert into public.allowed_document_types values
  ('application/pdf', array['pdf'], 52428800),
  ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', array['xlsx'], 26214400),
  ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', array['docx'], 26214400),
  ('text/csv', array['csv'], 10485760),
  ('image/png', array['png'], 15728640),
  ('image/jpeg', array['jpg', 'jpeg'], 15728640);
alter table public.allowed_document_types enable row level security;
grant select on public.allowed_document_types to authenticated;
create policy allowed_types_read on public.allowed_document_types for select to authenticated using (true);

create or replace function public.create_document_upload(
  p_company_id uuid,
  p_property_id uuid,
  p_document_id uuid,
  p_category_key text,
  p_title text,
  p_description text,
  p_visibility public.document_visibility,
  p_period_month date,
  p_filename text,
  p_content_type text,
  p_size_bytes bigint,
  p_linked_entity_type text default null,
  p_linked_entity_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.documents;
  v_type public.allowed_document_types;
  v_ext text := lower(substring(p_filename from '\.([A-Za-z0-9]+)$'));
  v_version_id uuid := gen_random_uuid();
  v_num integer;
  v_key text;
begin
  if p_property_id is not null and not exists (select 1 from public.properties where id = p_property_id and company_id = p_company_id) then
    raise exception 'property does not belong to company' using errcode = '22023';
  end if;
  if not app.has_permission('documents.upload', p_company_id, p_property_id)
     and not app.has_permission('documents.manage', p_company_id, p_property_id) then
    raise exception 'permission denied: documents.upload' using errcode = '42501';
  end if;
  select * into v_type from public.allowed_document_types where content_type = p_content_type;
  if not found or v_ext is null or not (v_ext = any (v_type.extensions)) then
    raise exception 'file type % (.%) is not allowed', p_content_type, coalesce(v_ext, '?') using errcode = '22023';
  end if;
  if p_size_bytes <= 0 or p_size_bytes > v_type.max_bytes then
    raise exception 'file size must be between 1 byte and % bytes', v_type.max_bytes using errcode = '22023';
  end if;
  if length(p_filename) > 200 or p_filename ~ '[/\\]' then
    raise exception 'invalid file name' using errcode = '22023';
  end if;

  if p_document_id is null then
    -- Uploaders cannot create documents they themselves could not see.
    if not app.can_view_document(p_company_id, p_property_id, p_visibility) then
      raise exception 'you cannot upload a document with visibility %', p_visibility using errcode = '42501';
    end if;
    insert into public.documents (company_id, property_id, category_key, title, description, period_month, visibility,
      linked_entity_type, linked_entity_id, created_by)
    values (p_company_id, p_property_id, p_category_key, p_title, p_description, p_period_month, p_visibility,
      p_linked_entity_type, p_linked_entity_id, auth.uid())
    returning * into v_doc;
  else
    select * into v_doc from public.documents where id = p_document_id and company_id = p_company_id for update;
    if not found or v_doc.property_id is distinct from p_property_id
       or not app.can_view_document(v_doc.company_id, v_doc.property_id, v_doc.visibility) then
      raise exception 'document not found' using errcode = '42501';
    end if;
  end if;

  select coalesce(max(version_number), 0) + 1 into v_num from public.document_versions where document_id = v_doc.id;
  v_key := format('quarantine/%s/%s/%s/%s.%s', p_company_id, coalesce(p_property_id::text, 'company'), v_doc.id, v_version_id, v_ext);
  insert into public.document_versions (id, company_id, property_id, document_id, version_number, storage_key, original_filename,
    content_type, size_bytes, uploaded_by)
  values (v_version_id, p_company_id, p_property_id, v_doc.id, v_num, v_key, p_filename, p_content_type, p_size_bytes, auth.uid());
  perform app.audit(p_company_id, 'document.upload_started', 'document_version', v_version_id::text,
                    jsonb_build_object('document_id', v_doc.id, 'version', v_num, 'filename', p_filename, 'size', p_size_bytes), p_property_id);
  return jsonb_build_object('document_id', v_doc.id, 'version_id', v_version_id, 'version_number', v_num, 'max_bytes', v_type.max_bytes);
end;
$$;
grant execute on function public.create_document_upload(uuid, uuid, uuid, text, text, text, public.document_visibility, date, text, text, bigint, text, uuid) to authenticated;

-- Caller-scoped authorization for a download. Logs the decision. Returns true if allowed.
create or replace function public.authorize_document_download(p_version_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v public.document_versions;
  d public.documents;
  v_ok boolean;
begin
  select * into v from public.document_versions where id = p_version_id;
  if not found then
    return false;
  end if;
  select * into d from public.documents where id = v.document_id;
  v_ok := auth.uid() is not null
          and (d.status = 'active' or app.has_permission('documents.manage', d.company_id, d.property_id))
          and app.can_view_document(d.company_id, d.property_id, d.visibility)
          and (v.scan_status = 'clean' or (v.scan_status = 'skipped' and v.released_at is not null));
  perform app.audit(d.company_id, case when v_ok then 'document.download_authorized' else 'document.download_denied' end,
                    'document_version', v.id::text,
                    jsonb_build_object('document_id', d.id, 'version', v.version_number, 'scan_status', v.scan_status),
                    d.property_id);
  return v_ok;
end;
$$;
grant execute on function public.authorize_document_download(uuid) to authenticated;

create or replace function public.release_document_version(p_version_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.document_versions;
begin
  select * into v from public.document_versions where id = p_version_id for update;
  if not found or not app.has_permission('documents.manage', v.company_id, v.property_id) then
    raise exception 'permission denied: documents.manage' using errcode = '42501';
  end if;
  if v.scan_status <> 'skipped' then
    raise exception 'only versions whose scan was skipped can be manually released (current: %)', v.scan_status using errcode = '55000';
  end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'a release note is required' using errcode = '22023';
  end if;
  update public.document_versions set released_by = auth.uid(), released_at = now(), scan_detail = 'Manually released: ' || p_note
   where id = v.id;
  update public.documents set current_version_id = v.id where id = v.document_id;
  perform app.audit(v.company_id, 'document.released', 'document_version', v.id::text, jsonb_build_object('note', p_note), v.property_id);
end;
$$;
grant execute on function public.release_document_version(uuid, text) to authenticated;

create or replace function public.svc_complete_document_upload(p_version_id uuid, p_size_bytes bigint, p_sha256 text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.document_versions;
begin
  select * into v from public.document_versions where id = p_version_id for update;
  if not found then raise exception 'version not found'; end if;
  if v.scan_status <> 'awaiting_upload' then
    raise exception 'upload already completed' using errcode = '55000';
  end if;
  if p_size_bytes <> v.size_bytes then
    update public.document_versions set scan_status = 'error', scan_detail = 'Uploaded size does not match declared size'
     where id = v.id;
    return;
  end if;
  update public.document_versions set scan_status = 'pending', sha256 = p_sha256, upload_completed_at = now() where id = v.id;
end;
$$;
revoke all on function public.svc_complete_document_upload(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.svc_complete_document_upload(uuid, bigint, text) to service_role;

create or replace function public.svc_set_scan_result(p_version_id uuid, p_status public.scan_status, p_detail text, p_storage_key text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.document_versions;
begin
  select * into v from public.document_versions where id = p_version_id for update;
  if not found then raise exception 'version not found'; end if;
  if p_status not in ('clean', 'infected', 'error', 'skipped') then
    raise exception 'invalid scan result';
  end if;
  update public.document_versions
     set scan_status = p_status, scan_detail = p_detail, scanned_at = now(), storage_key = coalesce(p_storage_key, storage_key)
   where id = v.id;
  if p_status = 'clean' then
    update public.documents set current_version_id = v.id
     where id = v.document_id
       and (current_version_id is null
            or (select version_number from public.document_versions where id = current_version_id) < v.version_number);
  end if;
  perform app.audit(v.company_id, 'document.scanned', 'document_version', v.id::text,
                    jsonb_build_object('result', p_status, 'detail', p_detail), v.property_id);
end;
$$;
revoke all on function public.svc_set_scan_result(uuid, public.scan_status, text, text) from public, anon, authenticated;
grant execute on function public.svc_set_scan_result(uuid, public.scan_status, text, text) to service_role;
