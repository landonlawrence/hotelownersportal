-- =============================================================================
-- Admin tools: email route token rotation, room inventory changes, route auditing
-- =============================================================================

-- Rotating the route token invalidates the old inbound address immediately.
create or replace function public.rotate_ingestion_route_token(p_source_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_token text := encode(extensions.gen_random_bytes(12), 'hex');
begin
  select company_id into v_company from public.ingestion_sources where id = p_source_id;
  if v_company is null or not app.has_permission('ingestion.manage', v_company) then
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

-- Change a property's room count from a date: closes the open period and starts a new one.
create or replace function public.set_room_inventory(p_property_id uuid, p_effective_from date, p_room_count integer, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_current public.room_inventory_history;
  v_id uuid;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('admin.company', v_company) then
    raise exception 'permission denied: admin.company' using errcode = '42501';
  end if;
  if p_room_count is null or p_room_count <= 0 or p_room_count >= 100000 then
    raise exception 'room count must be a positive number' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_current from public.room_inventory_history
   where property_id = p_property_id and effective_to is null for update;
  if found then
    if p_effective_from <= v_current.effective_from then
      raise exception 'new inventory must start after the current period (from %)', v_current.effective_from using errcode = '22023';
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

-- Row audits never copy secret-like columns (route tokens, verification tokens, token hashes).
create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_company uuid := nullif(v_row ->> 'company_id', '')::uuid;
  v_property uuid := case when v_row ? 'property_id' then nullif(v_row ->> 'property_id', '')::uuid end;
  v_id text := coalesce(v_row ->> 'id', v_row ->> 'source_id', v_row ->> 'property_id', v_row ->> 'company_id', v_row ->> 'user_id');
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into v_changes
    from jsonb_each(to_jsonb(new)) n
    where n.key not in ('updated_at', 'inbound_token', 'verification_token', 'token_hash')
      and n.value is distinct from (to_jsonb(old) -> n.key);
    if v_changes = '{}'::jsonb then
      return new;
    end if;
  end if;
  perform app.audit(v_company, lower(tg_op), tg_table_name, v_id,
                    case when tg_op = 'UPDATE' then jsonb_build_object('changes', v_changes)
                         when v_row ? 'inbound_token' or v_row ? 'token_hash' then jsonb_build_object('secret_fields', 'redacted')
                         else '{}'::jsonb end,
                    v_property);
  return coalesce(new, old);
end;
$$;

-- Allowed-sender changes are security relevant: audit them.
create trigger audit_ingestion_routes after insert or update or delete on public.ingestion_source_routes
  for each row execute function app.audit_row_change();

-- Property creation as an RPC: validates and returns the id (an INSERT … RETURNING
-- cannot satisfy the visibility policy for a row created in the same statement).
create or replace function public.create_property(
  p_company_id uuid, p_code text, p_name text, p_timezone text, p_status public.property_status default 'onboarding',
  p_brand text default null, p_city text default null, p_region text default null, p_opened_on date default null,
  p_country char(2) default 'US', p_currency char(3) default null
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
  insert into public.properties (company_id, code, name, timezone, status, brand, city, region, opened_on, country, currency)
  values (p_company_id, upper(trim(p_code)), trim(p_name), p_timezone, p_status, p_brand, p_city, p_region, p_opened_on, p_country,
          coalesce(p_currency, (select default_currency from public.companies where id = p_company_id)))
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.create_property(uuid, text, text, text, public.property_status, text, text, text, date, char, char) to authenticated;
