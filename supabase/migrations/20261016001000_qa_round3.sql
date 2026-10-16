-- QA round 3 fixes (R3-xx ids in the fix list).
-- Nothing here deletes, archives or rewrites existing user data.

-- =============================================================================
-- R3-01 Property-scoped financials.edit / ingestion.manage holders write only
-- their own properties' rows; company-wide configuration needs company-wide access
-- R3-19 Property-specific mappings are readable only for permitted properties
-- =============================================================================
drop policy financial_accounts_write on public.financial_accounts;
create policy financial_accounts_write on public.financial_accounts for all to authenticated
  using (app.has_company_wide_permission('financials.edit', company_id))
  with check (app.has_company_wide_permission('financials.edit', company_id));

drop policy account_mappings_read on public.source_account_mappings;
create policy account_mappings_read on public.source_account_mappings for select to authenticated
  using (case when property_id is null
              then company_id = any ((select app.permitted_company_ids('financials.view_draft'))::uuid[])
                or company_id = any ((select app.permitted_company_ids('ingestion.view'))::uuid[])
              else property_id = any ((select app.permitted_property_ids('financials.view_draft'))::uuid[])
                or property_id = any ((select app.permitted_property_ids('ingestion.view'))::uuid[]) end);
drop policy account_mappings_write on public.source_account_mappings;
create policy account_mappings_write on public.source_account_mappings for all to authenticated
  using (case when property_id is null then app.has_company_wide_permission('financials.edit', company_id)
              else property_id = any ((select app.permitted_property_ids('financials.edit'))::uuid[]) end)
  with check (case when property_id is null then app.has_company_wide_permission('financials.edit', company_id)
                   else property_id = any ((select app.permitted_property_ids('financials.edit'))::uuid[]) end);

-- Sources stay readable company-wide (upload source picker); writing them is company-wide configuration.
drop policy ingestion_sources_write on public.ingestion_sources;
create policy ingestion_sources_write on public.ingestion_sources for all to authenticated
  using (app.has_company_wide_permission('ingestion.manage', company_id))
  with check (app.has_company_wide_permission('ingestion.manage', company_id));

drop policy ingestion_routes_manage on public.ingestion_source_routes;
create policy ingestion_routes_manage on public.ingestion_source_routes for all to authenticated
  using (app.has_company_wide_permission('ingestion.manage', company_id))
  with check (app.has_company_wide_permission('ingestion.manage', company_id));

drop policy ingestion_mappings_read on public.ingestion_property_mappings;
create policy ingestion_mappings_read on public.ingestion_property_mappings for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('ingestion.view'))::uuid[])
         or property_id = any ((select app.permitted_property_ids('ingestion.manage'))::uuid[]));
drop policy ingestion_mappings_write on public.ingestion_property_mappings;
create policy ingestion_mappings_write on public.ingestion_property_mappings for all to authenticated
  using (property_id = any ((select app.permitted_property_ids('ingestion.manage'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('ingestion.manage'))::uuid[]));

drop policy integrations_manage on public.integration_connections;
create policy integrations_manage on public.integration_connections for all to authenticated
  using (app.has_company_wide_permission('ingestion.manage', company_id))
  with check (app.has_company_wide_permission('ingestion.manage', company_id));

-- Rotating a source's route token is company-wide configuration as well.
create or replace function public.rotate_ingestion_route_token(p_source_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_token text := encode(extensions.gen_random_bytes(12), 'hex');
begin
  select company_id into v_company from public.ingestion_sources where id = p_source_id;
  if v_company is null or not app.has_company_wide_permission('ingestion.manage', v_company) then
    raise exception 'permission denied: ingestion.manage' using errcode = '42501';
  end if;
  insert into public.ingestion_source_routes (source_id, company_id, inbound_token)
  values (p_source_id, v_company, v_token)
  on conflict (source_id) do update set inbound_token = excluded.inbound_token;
  perform app.audit(v_company, 'ingestion.route_token_rotated', 'ingestion_source', p_source_id::text, '{}'::jsonb);
  return v_token;
end;
$$;
grant execute on function public.rotate_ingestion_route_token(uuid) to authenticated;

-- =============================================================================
-- R3-11 Allowed email senders change atomically (no read-modify-write from a tab)
-- =============================================================================
-- Security invoker: the route's RLS policy (company-wide ingestion.manage) applies.
create or replace function public.add_allowed_sender(p_source_id uuid, p_sender text) returns text[]
language plpgsql security invoker set search_path = '' as $$
declare
  v text := lower(trim(coalesce(p_sender, '')));
  v_out text[];
begin
  if v = '' or v !~ '^([^@\s]+@[^@\s]+\.[^@\s]+|@[^@\s]+\.[^@\s]+)$' then
    raise exception 'enter an email address or an @domain' using errcode = '22023';
  end if;
  update public.ingestion_source_routes
     set allowed_senders = case when v = any (allowed_senders) then allowed_senders else array_append(allowed_senders, v) end
   where source_id = p_source_id
  returning allowed_senders into v_out;
  if not found then
    raise exception 'permission denied: ingestion.manage' using errcode = '42501';
  end if;
  return v_out;
end;
$$;
revoke execute on function public.add_allowed_sender(uuid, text) from public, anon;
grant execute on function public.add_allowed_sender(uuid, text) to authenticated;

create or replace function public.remove_allowed_sender(p_source_id uuid, p_sender text) returns text[]
language plpgsql security invoker set search_path = '' as $$
declare v_out text[];
begin
  update public.ingestion_source_routes
     set allowed_senders = array_remove(allowed_senders, lower(trim(coalesce(p_sender, ''))))
   where source_id = p_source_id
  returning allowed_senders into v_out;
  if not found then
    raise exception 'permission denied: ingestion.manage' using errcode = '42501';
  end if;
  return v_out;
end;
$$;
revoke execute on function public.remove_allowed_sender(uuid, text) from public, anon;
grant execute on function public.remove_allowed_sender(uuid, text) to authenticated;

-- =============================================================================
-- R3-02 No money values in audit metadata; profiles visible to platform staff
-- only through a support session
-- =============================================================================
-- Keys that carry monetary figures anywhere in audit metadata.
create or replace function app.audit_money_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array['amount', 'requested_budget', 'approved_budget', 'new_approved_budget', 'previous_approved_budget',
               'min_amount', 'max_amount', 'source_value', 'actual', 'budget', 'actual_spend', 'open_commitments',
               'remaining', 'quotes'];
$$;

create or replace function app.audit_metadata_has_money(p_metadata jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_metadata ?| app.audit_money_keys(), false)
      or coalesce(jsonb_typeof(p_metadata -> 'changes') = 'object' and (p_metadata -> 'changes') ?| app.audit_money_keys(), false);
$$;

create or replace function app.audit_redact(p_metadata jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when p_metadata is null then '{}'::jsonb
    else (p_metadata - app.audit_money_keys())
      || case when p_metadata ? 'requested_budget' or p_metadata ? 'approved_budget' or p_metadata ? 'new_approved_budget'
              then jsonb_build_object('has_budget', coalesce(p_metadata ->> 'requested_budget', p_metadata ->> 'approved_budget',
                                                             p_metadata ->> 'new_approved_budget') is not null)
              else '{}'::jsonb end
      || case when jsonb_typeof(p_metadata -> 'changes') = 'object'
              then jsonb_build_object('changes', (p_metadata -> 'changes') - app.audit_money_keys())
              else '{}'::jsonb end
  end;
$$;

create or replace function app.audit(
  p_company_id uuid, p_action text, p_entity_type text, p_entity_id text,
  p_metadata jsonb default '{}'::jsonb, p_property_id uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := 'user';
begin
  if auth.uid() is null then
    v_kind := 'system';
  elsif p_company_id is not null
        and not exists (select 1 from public.company_memberships
                        where company_id = p_company_id and user_id = auth.uid() and status = 'active')
        and exists (select 1 from public.platform_admins where user_id = auth.uid()) then
    v_kind := case when exists (select 1 from public.support_access_sessions s
                                where s.company_id = p_company_id and s.user_id = auth.uid()
                                  and s.ended_at is null and now() between s.starts_at and s.expires_at)
                   then 'support' else 'platform_admin' end;
  end if;
  -- Audit metadata never carries financial figures (platform staff can read it).
  insert into public.audit_events (company_id, property_id, actor_user_id, actor_kind, action, entity_type, entity_id, metadata)
  values (p_company_id, p_property_id, auth.uid(), v_kind, p_action, p_entity_type, p_entity_id, app.audit_redact(p_metadata));
end;
$$;

create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_company uuid := nullif(v_row ->> 'company_id', '')::uuid;
  v_property uuid := case when v_row ? 'property_id' then nullif(v_row ->> 'property_id', '')::uuid end;
  v_id text := coalesce(v_row ->> 'id', v_row ->> 'source_id', v_row ->> 'property_id', v_row ->> 'company_id', v_row ->> 'user_id');
  v_secret text[] := array['inbound_token', 'verification_token', 'token_hash'];
  v_changes jsonb := '{}'::jsonb;
  v_changed text[] := '{}';
  v_secret_changed text[] := '{}';
  v_meta jsonb;
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into v_changed
    from jsonb_each(to_jsonb(new)) n
    where n.key <> 'updated_at' and not (n.key = any (v_secret))
      and n.value is distinct from (to_jsonb(old) -> n.key);
    -- Values of non-financial columns only; money columns are named in changed_fields.
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into v_changes
    from jsonb_each(to_jsonb(new)) n
    where n.key = any (v_changed) and not (n.key = any (app.audit_money_keys()));
    select coalesce(array_agg(n.key), '{}') into v_secret_changed
    from jsonb_each(to_jsonb(new)) n
    where n.key = any (v_secret) and n.value is distinct from (to_jsonb(old) -> n.key);
    if cardinality(v_changed) = 0 and cardinality(v_secret_changed) = 0 then
      return new;
    end if;
  end if;
  v_meta := app.audit_summary(tg_table_name, v_row);
  if tg_op = 'UPDATE' then
    v_meta := v_meta || jsonb_build_object('changes', v_changes, 'changed_fields', to_jsonb(v_changed));
    if cardinality(v_secret_changed) > 0 then
      v_meta := v_meta || jsonb_build_object('secret_changed', to_jsonb(v_secret_changed), 'token_changed', true);
    end if;
  elsif v_row ? 'inbound_token' or v_row ? 'token_hash' or v_row ? 'verification_token' then
    v_meta := v_meta || jsonb_build_object('secret_fields', 'redacted');
  end if;
  perform app.audit(v_company, lower(tg_op), tg_table_name, v_id, v_meta, v_property);
  return coalesce(new, old);
end;
$$;

-- audit_events is append-only, so events written before this migration are not rewritten.
-- Platform administrators (no support session) never see an event whose metadata carries a
-- money field; company users with audit.view keep seeing their company's full trail.
drop policy audit_read on public.audit_events;
create policy audit_read on public.audit_events for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('audit.view'))::uuid[])
         or ((select app.is_platform_admin()) and not app.audit_metadata_has_money(metadata)));

-- Platform staff in an active, 2FA-verified support session for the company.
create or replace function app.in_support_session(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.privileged_aal_ok() and exists (
    select 1 from public.support_access_sessions s
    join public.platform_admins pa on pa.user_id = s.user_id
    join public.companies c on c.id = s.company_id and c.status = 'active'
    where s.user_id = auth.uid() and s.company_id = p_company_id
      and s.ended_at is null and now() between s.starts_at and s.expires_at);
$$;
revoke execute on function app.in_support_session(uuid) from public, anon;
grant execute on function app.in_support_session(uuid) to authenticated;

-- A member of a company the current user is supporting (security definer: platform staff
-- cannot read company_memberships directly).
create or replace function app.support_session_covers_user(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_memberships m
                 where m.user_id = p_user and app.in_support_session(m.company_id));
$$;
revoke execute on function app.support_session_covers_user(uuid) from public, anon;
grant execute on function app.support_session_covers_user(uuid) to authenticated;

-- Tenant user profiles: company admins, or platform staff in an active support session.
drop policy profiles_admin on public.profiles;
create policy profiles_admin on public.profiles for select to authenticated
  using (exists (
    select 1 from public.company_memberships m
    where m.user_id = profiles.id
      and m.company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]))
    or ((select app.is_platform_admin()) and app.support_session_covers_user(profiles.id)));

-- =============================================================================
-- R3-04 Room inventory can be extended backwards before the first period
-- =============================================================================
create or replace function public.set_room_inventory(p_property_id uuid, p_effective_from date, p_room_count integer, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_current public.room_inventory_history;
  v_first public.room_inventory_history;
  v_id uuid;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('admin.company', v_company) then
    raise exception 'permission denied: admin.company' using errcode = '42501';
  end if;
  if p_effective_from is null then
    raise exception 'an effective date is required' using errcode = '22023';
  end if;
  if p_room_count is null or p_room_count <= 0 or p_room_count >= 100000 then
    raise exception 'room count must be a positive number' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  perform 1 from public.properties where id = p_property_id for update;
  select * into v_first from public.room_inventory_history
   where property_id = p_property_id order by effective_from limit 1;
  -- Earlier than all history: a closed period ending where the first one starts.
  if found and p_effective_from < v_first.effective_from then
    insert into public.room_inventory_history (company_id, property_id, effective_from, effective_to, room_count, reason, created_by)
    values (v_company, p_property_id, p_effective_from, v_first.effective_from, p_room_count, p_reason, auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  select * into v_current from public.room_inventory_history
   where property_id = p_property_id and effective_to is null for update;
  if found then
    if p_effective_from <= v_current.effective_from then
      raise exception 'new inventory must start after the current period (from %), or before the first period (from %)',
        v_current.effective_from, v_first.effective_from using errcode = '22023';
    end if;
    if p_room_count = v_current.room_count then
      raise exception 'room count is unchanged' using errcode = '22023';
    end if;
    update public.room_inventory_history set effective_to = p_effective_from where id = v_current.id;
  elsif exists (select 1 from public.room_inventory_history where property_id = p_property_id and effective_to > p_effective_from) then
    raise exception 'new inventory overlaps existing history' using errcode = '22023';
  end if;
  insert into public.room_inventory_history (company_id, property_id, effective_from, room_count, reason, created_by)
  values (v_company, p_property_id, p_effective_from, p_room_count, p_reason, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.set_room_inventory(uuid, date, integer, text) to authenticated;

-- Moving the opening date earlier also moves an untouched opening inventory with it.
create or replace function app.property_extend_opening_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_first public.room_inventory_history;
begin
  if new.opened_on is null or (old.opened_on is not null and new.opened_on >= old.opened_on) then
    return new;
  end if;
  select * into v_first from public.room_inventory_history where property_id = new.id order by effective_from limit 1;
  if found and v_first.reason = 'Opening inventory' and new.opened_on < v_first.effective_from then
    update public.room_inventory_history set effective_from = new.opened_on where id = v_first.id;
  end if;
  return new;
end;
$$;
revoke execute on function app.property_extend_opening_inventory() from public, anon, authenticated;
create trigger properties_extend_opening_inventory after update of opened_on on public.properties
  for each row execute function app.property_extend_opening_inventory();

-- =============================================================================
-- R3-06 Linked partial invoices reduce their commitment (no double counting)
-- =============================================================================
-- Open commitment = what is still to be invoiced on each open commitment.
create or replace function app.capex_open_commitments(p_project_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(greatest(c.amount - coalesce((
           select sum(a.amount) from public.capex_transactions a
           where a.related_commitment_id = c.id and a.kind = 'actual' and a.status <> 'void'), 0), 0)), 0)
  from public.capex_transactions c
  where c.project_id = p_project_id and c.kind = 'commitment' and c.status = 'open';
$$;
revoke execute on function app.capex_open_commitments(uuid) from public, anon, authenticated;

-- Security invoker: the caller sees only projects and transactions RLS allows; the
-- lateral below reads transactions through the same RLS.
create or replace function public.capex_project_summary(p_company_id uuid)
returns table (project_id uuid, property_id uuid, approved_budget numeric, actual_spend numeric, open_commitments numeric,
               remaining numeric, quotes numeric)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.property_id, p.approved_budget, s.actual, s.open_c, p.approved_budget - s.actual - s.open_c, s.quotes
  from public.capex_projects p
  cross join lateral (
    select
      coalesce((select sum(t.amount) from public.capex_transactions t
                where t.project_id = p.id and t.kind = 'actual' and t.status <> 'void'), 0) as actual,
      coalesce((select sum(greatest(c.amount - coalesce((
                  select sum(a.amount) from public.capex_transactions a
                  where a.related_commitment_id = c.id and a.kind = 'actual' and a.status <> 'void'), 0), 0))
                from public.capex_transactions c
                where c.project_id = p.id and c.kind = 'commitment' and c.status = 'open'), 0) as open_c,
      coalesce((select sum(t.amount) from public.capex_transactions t
                where t.project_id = p.id and t.kind = 'quote' and t.status <> 'void'), 0) as quotes
  ) s
  where p.company_id = p_company_id;
$$;
grant execute on function public.capex_project_summary(uuid) to authenticated;

-- =============================================================================
-- R3-06 / R3-23 Package snapshot: open commitments net of linked invoices;
-- variance commentary carries its account name
-- =============================================================================
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
           'account_id', m.account_id, 'account_name', a.name, 'account_code', a.code,
           'published_at', m.published_at) order by m.section, m.created_at), '[]'::jsonb)
  into v_comm from public.management_commentary m
  left join public.financial_accounts a on a.id = m.account_id
  where m.company_id = pk.company_id and (m.property_id = pk.property_id or m.property_id is null)
    and m.period_month = pk.period_month and m.visibility = 'owner' and m.status = 'published';

  select coalesce(jsonb_agg(jsonb_build_object('project_id', p.id, 'number', p.project_number, 'title', p.title,
           'status', p.status, 'approved_budget', p.approved_budget, 'actual_spend', s.actual_spend,
           'open_commitments', s.open_commitments, 'remaining', p.approved_budget - s.actual_spend - s.open_commitments,
           'percent_complete', p.percent_complete,
           'latest_update', (select u.body from public.capex_updates u where u.project_id = p.id and u.visibility = 'owner'
                             order by u.created_at desc limit 1)) order by p.project_number), '[]'::jsonb)
  into v_capex
  from public.capex_projects p
  cross join lateral (
    select coalesce((select sum(t.amount) from public.capex_transactions t
                     where t.project_id = p.id and t.kind = 'actual' and t.status <> 'void'), 0) as actual_spend,
           app.capex_open_commitments(p.id) as open_commitments
  ) s
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
      'capex_remaining', 'Approved budget − actual spend − open commitments (net of invoices against them)',
      'performance_status', 'Daily operating figures are provisional; financial statements are published accounting figures'));
end;
$$;

-- =============================================================================
-- R3-22 Investors with financials.view (no budgets.view) keep the published P&L
-- in packages; budget columns need budgets.view
-- =============================================================================
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
      s := s - 'financial_report' - 'budget_variance';
    elsif not app.has_permission('budgets.view', pk.company_id, pk.property_id) and jsonb_typeof(s -> 'budget_variance') = 'array' then
      -- Actuals only: drop budget figures and budget-only lines.
      s := jsonb_set(s, '{budget_variance}', coalesce((
        select jsonb_agg(e - 'budget' order by ord)
        from jsonb_array_elements(s -> 'budget_variance') with ordinality x(e, ord)
        where e ->> 'actual' is not null), '[]'::jsonb)) || jsonb_build_object('budget_hidden', true);
    end if;
    if not app.has_permission('capex.view', pk.company_id, pk.property_id) then
      s := s - 'capex';
    end if;
    if not app.has_permission('commentary.view', pk.company_id, pk.property_id) then
      s := s - 'commentary';
    end if;
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

-- =============================================================================
-- R3-07 Approving monthly actuals over a published statement lists the line diff
-- R3-24 Re-importing identical lines into a draft counts as unchanged
-- =============================================================================
-- The line diff of a pending revision holds unpublished figures, so it is kept out of
-- import_runs.result (readable with ingestion.view). Amounts live here, with no client
-- access, and are served by public.import_statement_diff to draft-financials readers.
create table public.import_statement_diffs (
  import_run_id uuid not null references public.import_runs (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  period_month date not null,
  line_changes jsonb not null,
  created_at timestamptz not null default now(),
  primary key (import_run_id, property_id, period_month)
);
alter table public.import_statement_diffs enable row level security;
revoke all on public.import_statement_diffs from public, anon, authenticated;

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
  v_diff jsonb;
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

    if found then
      v_existing := (select jsonb_agg(jsonb_build_object('code', source_account_code, 'amount', amount, 'account', account_id::text)
                                      order by source_account_code)
                     from public.financial_report_lines where financial_report_id = v_report.id);
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
          -- The file replaces the whole statement: list changed, added and removed accounts.
          select coalesce(jsonb_agg(jsonb_build_object('accountId', coalesce(o.account_id, n.account_id), 'code', a.code, 'name', a.name,
                   'change', case when o.account_id is null then 'added' when n.account_id is null then 'removed' else 'changed' end,
                   'old', o.amount, 'new', n.amount) order by a.sort_order, a.code), '[]'::jsonb)
          into v_diff
          from (select account_id, sum(amount) amount from public.financial_report_lines
                where financial_report_id = v_report.id group by 1) o
          full join (select (x ->> 'accountId')::uuid account_id, sum((x ->> 'amount')::numeric(16, 2)) amount
                     from jsonb_array_elements(g.lines) x group by 1) n on n.account_id = o.account_id
          join public.financial_accounts a on a.id = coalesce(o.account_id, n.account_id)
          where o.amount is distinct from n.amount;
          insert into public.import_statement_diffs (import_run_id, company_id, property_id, period_month, line_changes)
          values (v_run.id, v_run.company_id, g.property_id, g.period_month, v_diff)
          on conflict (import_run_id, property_id, period_month) do update set line_changes = excluded.line_changes, created_at = now();
          v_conflicts := v_conflicts || jsonb_build_object('propertyId', g.property_id, 'periodMonth', g.period_month,
            'reason', 'A published report exists; approve the import as a revision to replace it',
            'replacesStatement', true, 'revision', v_report.revision,
            -- Accounts and change types only; amounts come from public.import_statement_diff.
            'lineChanges', (select coalesce(jsonb_agg(d - 'old' - 'new'), '[]'::jsonb) from jsonb_array_elements(v_diff) d),
            'changed', (select count(*) from jsonb_array_elements(v_diff) d where d ->> 'change' = 'changed'),
            'added', (select count(*) from jsonb_array_elements(v_diff) d where d ->> 'change' = 'added'),
            'removed', (select count(*) from jsonb_array_elements(v_diff) d where d ->> 'change' = 'removed'));
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
      -- Draft: identical lines are left alone.
      if v_existing is not distinct from v_incoming then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
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

-- Amounts of a pending statement replacement, per property, for users who may see draft
-- financials (or edit them) at that property. Other properties in the run are omitted.
create or replace function public.import_statement_diff(p_run_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('propertyId', d.property_id, 'periodMonth', d.period_month, 'lineChanges', d.line_changes)
                            order by d.property_id, d.period_month), '[]'::jsonb)
  from public.import_statement_diffs d
  join public.import_runs r on r.id = d.import_run_id
  where d.import_run_id = p_run_id
    and app.can_view_import_run(r.company_id, r.property_ids)
    and (app.has_permission('financials.view_draft', d.company_id, d.property_id)
         or app.has_permission('financials.edit', d.company_id, d.property_id));
$$;
revoke all on function public.import_statement_diff(uuid) from public, anon;
grant execute on function public.import_statement_diff(uuid) to authenticated;

-- =============================================================================
-- R3-08 Author, approver and timestamp columns are set by the database
-- =============================================================================
-- Applies to client writes (role authenticated). Security-definer RPCs, the service
-- role and the seed run as other roles and keep the values they set.
create or replace function app.commentary_set_authorship() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    if new.status = 'published' then
      new.published_by := auth.uid();
      new.published_at := now();
    else
      new.published_by := null;
      new.published_at := null;
    end if;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if new.status is distinct from 'published' then
      new.published_by := null;
      new.published_at := null;
    elsif old.status is distinct from 'published' then
      new.published_by := auth.uid();
      new.published_at := now();
    else
      new.published_by := old.published_by;
      new.published_at := old.published_at;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function app.commentary_set_authorship() from public, anon, authenticated;
create trigger management_commentary_authorship before insert or update on public.management_commentary
  for each row execute function app.commentary_set_authorship();

create or replace function app.budget_version_set_authorship() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.approved_by := null;
    new.approved_at := null;
    new.superseded_at := null;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  end if;
  return new;
end;
$$;
revoke execute on function app.budget_version_set_authorship() from public, anon, authenticated;
create trigger budget_versions_authorship before insert or update on public.budget_versions
  for each row execute function app.budget_version_set_authorship();

create or replace function app.capex_row_set_authorship() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
revoke execute on function app.capex_row_set_authorship() from public, anon, authenticated;
create trigger capex_updates_authorship before insert or update on public.capex_updates
  for each row execute function app.capex_row_set_authorship();
create trigger capex_transactions_authorship before insert or update on public.capex_transactions
  for each row execute function app.capex_row_set_authorship();

-- =============================================================================
-- R3-20 A CapEx transaction's document must be on the same property (or company-wide)
-- and viewable by the person linking it
-- =============================================================================
create or replace function app.capex_transaction_document_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.document_id is null or (tg_op = 'UPDATE' and new.document_id is not distinct from old.document_id
                                 and new.property_id is not distinct from old.property_id) then
    return new;
  end if;
  if not exists (
    select 1 from public.documents d
    where d.id = new.document_id and d.company_id = new.company_id
      and (d.property_id is null or d.property_id = new.property_id)
      and (auth.uid() is null or app.can_view_document(d.company_id, d.property_id, d.visibility))) then
    -- One generic message: whether the id exists elsewhere is not disclosed.
    raise exception 'document not found for this property' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function app.capex_transaction_document_scope() from public, anon, authenticated;
create trigger capex_transactions_document_scope before insert or update of document_id, property_id
  on public.capex_transactions for each row execute function app.capex_transaction_document_scope();

-- =============================================================================
-- R3-09 The last holder of admin.users / admin.company cannot be denied it
-- =============================================================================
create or replace function public.set_permission_override(p_membership_id uuid, p_permission text, p_effect text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_m public.company_memberships;
begin
  select * into v_m from public.company_memberships where id = p_membership_id for update;
  if not found or not app.has_permission('admin.users', v_m.company_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_m.user_id = auth.uid() and p_effect = 'allow' then
    raise exception 'administrators cannot grant themselves extra permissions' using errcode = '42501';
  end if;
  if v_m.user_id = auth.uid() and p_effect = 'deny' and p_permission like 'admin.%' then
    raise exception 'you cannot remove your own administration access; ask another administrator' using errcode = '23514';
  end if;
  if p_effect = 'deny' and p_permission in ('admin.users', 'admin.company')
     and app.membership_allows_user(v_m.id, v_m.user_id, p_permission, 'any') then
    -- Serialize admin changes per company (same lock as app.assert_not_last_admin), then
    -- require another effective holder. Denying someone who does not hold it is always fine.
    perform pg_advisory_xact_lock(hashtext('company_admins:' || v_m.company_id::text));
    if not exists (
      select 1 from public.company_memberships o
      where o.company_id = v_m.company_id and o.status = 'active' and o.id <> v_m.id
        and app.membership_allows_user(o.id, o.user_id, p_permission, 'any')) then
      raise exception '%', case when p_permission = 'admin.users'
        then 'cannot remove the last company administrator''s user-management access'
        else 'cannot remove the last company administrator''s company-settings access' end
        using errcode = '23514';
    end if;
  end if;
  if p_effect = 'allow' and v_m.role in ('owner', 'investor') and app.is_internal_only_permission(p_permission) then
    raise exception '% is an internal permission and cannot be given to owners or investors', p_permission using errcode = '22023';
  end if;
  if p_effect is null then
    delete from public.membership_permission_overrides where membership_id = p_membership_id and permission_key = p_permission;
  elsif p_effect in ('allow', 'deny') then
    insert into public.membership_permission_overrides (membership_id, company_id, permission_key, effect, created_by)
    values (p_membership_id, v_m.company_id, p_permission, p_effect, auth.uid())
    on conflict (membership_id, permission_key) do update set effect = excluded.effect, created_by = excluded.created_by;
  else
    raise exception 'effect must be allow, deny or null' using errcode = '22023';
  end if;
end;
$$;
grant execute on function public.set_permission_override(uuid, text, text) to authenticated;

-- Revoking a membership or demoting a company admin uses the same rule as a deny override:
-- if the member effectively holds admin.users or admin.company, another active member must
-- hold it too. Same per-company lock, so concurrent role changes and denials cannot race.
create or replace function app.assert_not_last_admin(p_membership_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_m public.company_memberships;
  v_perm text;
begin
  select * into v_m from public.company_memberships where id = p_membership_id;
  if not found or v_m.status <> 'active' then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('company_admins:' || v_m.company_id::text));
  foreach v_perm in array array['admin.users', 'admin.company'] loop
    if app.membership_allows_user(v_m.id, v_m.user_id, v_perm, 'any') and not exists (
      select 1 from public.company_memberships o
      where o.company_id = v_m.company_id and o.status = 'active' and o.id <> v_m.id
        and app.membership_allows_user(o.id, o.user_id, v_perm, 'any')) then
      raise exception 'cannot remove the last company administrator' using errcode = '23514';
    end if;
  end loop;
end;
$$;
revoke execute on function app.assert_not_last_admin(uuid) from public, anon, authenticated;

-- =============================================================================
-- R3-39 Property-specific notifications name the property
-- =============================================================================
create or replace function app.notification_title(p_title text, p_property_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when p.name is null or position(p.name in coalesce(p_title, '')) > 0 then p_title
              else p_title || ' — ' || p.name end
  from (select (select name from public.properties where id = p_property_id) as name) p;
$$;
revoke execute on function app.notification_title(text, uuid) from public, anon, authenticated;

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
  v_title text := app.notification_title(p_title, p_property_id);
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
    values (p_company_id, r.user_id, p_property_id, p_kind, v_title, p_body, p_link, p_entity_type, p_entity_id)
    returning id into v_nid;
    if coalesce((select email_enabled from public.notification_preferences
                 where user_id = r.user_id and company_id = p_company_id and kind = p_kind), true) then
      insert into public.notification_outbox (notification_id, company_id, user_id, to_email, subject, body_text)
      values (v_nid, p_company_id, r.user_id, r.email, format('[%s] %s', v_portal, v_title),
              format(E'%s\n\nSign in to %s to view it securely.\n\nThis message was sent by %s. Financial documents are never attached to email.',
                     v_title, v_portal, v_from));
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function app.notify_permitted(uuid, uuid, text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;

create or replace function app.notify_user(
  p_company_id uuid, p_user_id uuid, p_property_id uuid, p_kind text, p_title text, p_body text,
  p_link text, p_entity_type text, p_entity_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_nid uuid;
  v_from text;
  v_portal text;
  v_email text;
  v_title text := app.notification_title(p_title, p_property_id);
begin
  if p_user_id is null or not exists (select 1 from public.company_memberships m
                                     where m.company_id = p_company_id and m.user_id = p_user_id and m.status = 'active') then
    return;
  end if;
  select email into v_email from public.profiles where id = p_user_id;
  select coalesce(b.email_from_name, c.name), coalesce(b.portal_name, c.name) into v_from, v_portal
  from public.companies c left join public.company_branding b on b.company_id = c.id where c.id = p_company_id;
  insert into public.notifications (company_id, user_id, property_id, kind, title, body, link_path, entity_type, entity_id)
  values (p_company_id, p_user_id, p_property_id, p_kind, v_title, p_body, p_link, p_entity_type, p_entity_id)
  returning id into v_nid;
  if v_email is not null and coalesce((select email_enabled from public.notification_preferences
               where user_id = p_user_id and company_id = p_company_id and kind = p_kind), true) then
    insert into public.notification_outbox (notification_id, company_id, user_id, to_email, subject, body_text)
    values (v_nid, p_company_id, p_user_id, v_email, format('[%s] %s', v_portal, v_title),
            format(E'%s\n\nSign in to %s to view it securely.\n\nThis message was sent by %s. Financial documents are never attached to email.',
                   v_title, v_portal, v_from));
  end if;
end;
$$;
revoke execute on function app.notify_user(uuid, uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
