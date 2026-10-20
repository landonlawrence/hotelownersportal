-- =============================================================================
-- Platform console: onboarding and managing management companies.
-- Platform administrators see operational metadata only (counts, setup progress,
-- the admin invitations they issued, property names). No financial figures,
-- documents or tenant user lists outside an audited support session (ADR-008).
-- Reads need a platform-admin session; every write needs a 2FA-verified one.
-- =============================================================================

create or replace function app.require_platform_admin(p_write boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'only platform administrators can do this' using errcode = '42501';
  end if;
  if p_write and not app.privileged_aal_ok() then
    raise exception 'verify with two-factor authentication before changing companies' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function app.require_platform_admin(boolean) from public, anon, authenticated;

-- Setup progress for one company, as the platform sees it.
create or replace function app.platform_setup(p_company_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin_joined', exists (select 1 from public.company_memberships m
                            where m.company_id = p_company_id and m.status = 'active' and m.role = 'company_admin'),
    'properties', (select count(*) from public.properties p where p.company_id = p_company_id and p.status <> 'archived'),
    'rooms', exists (select 1 from public.room_inventory_history r where r.company_id = p_company_id),
    'branded', exists (select 1 from public.company_branding b where b.company_id = p_company_id
                       and (b.logo_url is not null or b.logo_mark_url is not null or lower(b.primary_color) <> '#1f3a5f')),
    'team', (select count(*) from public.company_memberships m where m.company_id = p_company_id and m.status = 'active') > 1,
    'data', exists (select 1 from public.import_runs i where i.company_id = p_company_id));
$$;
revoke execute on function app.platform_setup(uuid) from public, anon, authenticated;

create or replace function public.platform_companies() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin(false);
  return coalesce((
    select jsonb_agg(row order by row ->> 'name')
    from (
      select jsonb_build_object(
        'id', c.id, 'slug', c.slug, 'name', c.name, 'legal_name', c.legal_name, 'status', c.status,
        'is_demo', c.is_demo, 'created_at', c.created_at, 'default_currency', c.default_currency,
        'require_mfa', c.require_mfa_for_privileged,
        'portal_name', b.portal_name, 'primary_color', b.primary_color, 'accent_color', b.accent_color,
        'logo_mark_url', b.logo_mark_url,
        'members', (select count(*) from public.company_memberships m where m.company_id = c.id and m.status = 'active'),
        'pending_admin_invitations', (select count(*) from public.invitations i where i.company_id = c.id and i.role = 'company_admin'
                                        and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
        'expired_admin_invitations', (select count(*) from public.invitations i where i.company_id = c.id and i.role = 'company_admin'
                                        and i.accepted_at is null and i.revoked_at is null and i.expires_at <= now()),
        'active_support_sessions', (select count(*) from public.support_access_sessions s where s.company_id = c.id
                                      and s.ended_at is null and now() between s.starts_at and s.expires_at),
        'setup', app.platform_setup(c.id)) as row
      from public.companies c
      left join public.company_branding b on b.company_id = c.id
    ) x), '[]'::jsonb);
end;
$$;
grant execute on function public.platform_companies() to authenticated;

create or replace function public.platform_company_detail(p_company_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_platform_admin(false);
  select jsonb_build_object(
    'company', jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'legal_name', c.legal_name, 'status', c.status,
                                  'is_demo', c.is_demo, 'created_at', c.created_at, 'default_currency', c.default_currency,
                                  'require_mfa', c.require_mfa_for_privileged),
    'branding', (select to_jsonb(b) - 'company_id' - 'updated_at' from public.company_branding b where b.company_id = c.id),
    'modules', coalesce((select jsonb_object_agg(m.module, m.enabled) from public.company_modules m where m.company_id = c.id), '{}'::jsonb),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'hostname', d.hostname, 'is_primary', d.is_primary,
                                                             'verification_status', d.verification_status,
                                                             'verification_token', d.verification_token, 'created_at', d.created_at)
                                          order by d.is_primary desc, d.hostname)
                         from public.company_domains d where d.company_id = c.id), '[]'::jsonb),
    -- Only invitations a platform admin issued; once accepted the email is no longer shown
    -- (who the company's admins are is tenant data).
    'admin_invitations', coalesce((select jsonb_agg(jsonb_build_object('id', i.id,
                                                                       'email', case when i.accepted_at is null then i.email end,
                                                                       'created_at', i.created_at, 'expires_at', i.expires_at,
                                                                       'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at)
                                                    order by i.created_at desc)
                                   from public.invitations i
                                   where i.company_id = c.id and i.role = 'company_admin'
                                     and exists (select 1 from public.platform_admins pa where pa.user_id = i.invited_by)), '[]'::jsonb),
    'members_by_role', coalesce((select jsonb_object_agg(role, n) from (select m.role, count(*) n from public.company_memberships m
                                  where m.company_id = c.id and m.status = 'active' group by m.role) r), '{}'::jsonb),
    'properties', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'city', p.city,
                                                                'region', p.region, 'status', p.status, 'timezone', p.timezone,
                                                                'rooms', (select r.room_count from public.room_inventory_history r
                                                                          where r.property_id = p.id and r.effective_to is null limit 1))
                                             order by p.name)
                            from public.properties p where p.company_id = c.id), '[]'::jsonb),
    'support_sessions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'starts_at', s.starts_at, 'expires_at', s.expires_at,
                                                                      'ended_at', s.ended_at, 'ticket_ref', s.ticket_ref)
                                                   order by s.starts_at desc)
                                  from (select * from public.support_access_sessions s where s.company_id = c.id
                                        order by s.starts_at desc limit 10) s), '[]'::jsonb),
    -- Actions taken by platform staff (RPCs and console edits; row audits record them as platform_admin).
    'activity', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'entity_type', a.entity_type, 'created_at', a.created_at)
                                           order by a.created_at desc)
                          from (select * from public.audit_events a where a.company_id = c.id and a.actor_kind = 'platform_admin'
                                order by a.created_at desc limit 30) a), '[]'::jsonb),
    'setup', app.platform_setup(c.id))
  into v
  from public.companies c where c.id = p_company_id;
  if v is null then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
grant execute on function public.platform_company_detail(uuid) to authenticated;

-- One call creates a ready-to-use company: profile, branding, modules, security policy,
-- hotels with room counts, default chart of accounts and categories, and admin invitations.
create or replace function public.platform_provision_company(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_name text;
  v_slug text;
  v_currency text;
  v_b jsonb;
  v_admins text[];
  v_email text;
  v_token text;
  v_tokens jsonb := '[]'::jsonb;
  v_prop jsonb;
  v_prop_id uuid;
  v_rooms int;
  v_code text;
  v_codes text[] := '{}';
  v_country text;
  v_opened date;
  v_status text;
  v_modules text[];
  v_all_modules text[] := enum_range(null::public.portal_module)::text[];
  v_k text;
begin
  perform app.require_platform_admin(true);
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'send the company details as an object' using errcode = '22023';
  end if;
  v_name := trim(p ->> 'name');
  v_slug := lower(trim(p ->> 'slug'));
  v_currency := upper(coalesce(nullif(trim(p ->> 'currency'), ''), 'USD'));
  v_b := coalesce(p -> 'branding', '{}'::jsonb);

  if v_name is null or length(v_name) < 2 or length(v_name) > 200 then
    raise exception 'the company name must be 2–200 characters' using errcode = '22023';
  end if;
  if v_slug is null or v_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
    raise exception 'the short ID must be 2–63 lowercase letters, numbers or dashes' using errcode = '22023';
  end if;
  if exists (select 1 from public.companies where slug = v_slug) then
    raise exception 'the short ID "%" is already used by another company', v_slug using errcode = '23505';
  end if;
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'the currency must be a three-letter code such as USD' using errcode = '22023';
  end if;
  if p ? 'require_mfa' and jsonb_typeof(p -> 'require_mfa') <> 'boolean' then
    raise exception 'require_mfa must be true or false' using errcode = '22023';
  end if;
  if jsonb_typeof(v_b) <> 'object' then
    raise exception 'branding must be an object' using errcode = '22023';
  end if;
  if length(coalesce(v_b ->> 'portal_name', '')) > 120 then
    raise exception 'the portal name must be 120 characters or fewer' using errcode = '22023';
  end if;
  foreach v_k in array array['primary_color', 'accent_color', 'surface_color'] loop
    if nullif(v_b ->> v_k, '') is not null and (v_b ->> v_k) !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'colours must be hex values like #1f3a5f' using errcode = '22023';
    end if;
  end loop;
  foreach v_k in array array['logo_url', 'logo_mark_url'] loop
    if nullif(trim(v_b ->> v_k), '') is not null and trim(v_b ->> v_k) !~ '^(https://|/)' then
      raise exception 'logo addresses must start with https://' using errcode = '22023';
    end if;
  end loop;
  if nullif(trim(v_b ->> 'support_email'), '') is not null and trim(v_b ->> 'support_email') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'the support email is not a valid address' using errcode = '22023';
  end if;
  foreach v_k in array array['admins', 'modules', 'properties'] loop
    if p ? v_k and jsonb_typeof(p -> v_k) <> 'array' then
      raise exception '% must be a list', v_k using errcode = '22023';
    end if;
  end loop;

  -- Admins: at least one, valid, never a platform administrator (that would bypass support sessions).
  select array_agg(distinct lower(trim(e))) into v_admins
  from jsonb_array_elements_text(coalesce(p -> 'admins', '[]'::jsonb)) e where trim(e) <> '';
  if v_admins is null or cardinality(v_admins) = 0 then
    raise exception 'add at least one company administrator' using errcode = '22023';
  end if;
  if cardinality(v_admins) > 20 then
    raise exception 'invite at most 20 administrators at once' using errcode = '22023';
  end if;
  foreach v_email in array v_admins loop
    if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception '"%" is not a valid email address', v_email using errcode = '22023';
    end if;
    if exists (select 1 from public.profiles pr join public.platform_admins pa on pa.user_id = pr.id where lower(pr.email) = v_email) then
      raise exception '% is a platform administrator; use a support session instead of a company membership', v_email using errcode = '42501';
    end if;
  end loop;

  -- Modules: key absent = everything; otherwise exactly the listed ones (administration is always on).
  if p ? 'modules' then
    select coalesce(array_agg(m), '{}') into v_modules from jsonb_array_elements_text(p -> 'modules') m;
    if exists (select 1 from unnest(v_modules) m where not (m = any (v_all_modules))) then
      raise exception 'unknown feature in the list' using errcode = '22023';
    end if;
  else
    v_modules := v_all_modules;
  end if;

  -- Hotels: validate everything before writing anything.
  if jsonb_array_length(coalesce(p -> 'properties', '[]'::jsonb)) > 200 then
    raise exception 'add at most 200 hotels at once' using errcode = '22023';
  end if;
  for v_prop in select * from jsonb_array_elements(coalesce(p -> 'properties', '[]'::jsonb)) loop
    if jsonb_typeof(v_prop) <> 'object' then
      raise exception 'each hotel must be an object' using errcode = '22023';
    end if;
    v_code := upper(trim(coalesce(v_prop ->> 'code', '')));
    if v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
      raise exception 'hotel codes must be 2–32 letters, numbers, dashes or underscores (got "%")', v_prop ->> 'code' using errcode = '22023';
    end if;
    if v_code = any (v_codes) then
      raise exception 'two hotels use the code %', v_code using errcode = '22023';
    end if;
    v_codes := v_codes || v_code;
    if length(trim(coalesce(v_prop ->> 'name', ''))) not between 2 and 200 then
      raise exception 'enter a name for hotel %', v_code using errcode = '22023';
    end if;
    if not app.is_valid_timezone(coalesce(v_prop ->> 'timezone', '')) then
      raise exception 'unknown time zone for %', v_code using errcode = '22023';
    end if;
    if coalesce(nullif(v_prop ->> 'status', ''), 'onboarding') not in ('onboarding', 'active') then
      raise exception 'a new hotel starts as onboarding or active' using errcode = '22023';
    end if;
    if nullif(v_prop ->> 'rooms', '') is not null and (v_prop ->> 'rooms') !~ '^[0-9]{1,5}$' then
      raise exception 'rooms for % must be a whole number', v_code using errcode = '22023';
    end if;
    if nullif(v_prop ->> 'opened_on', '') is not null and (v_prop ->> 'opened_on') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'the opening date for % must look like 2024-05-01', v_code using errcode = '22023';
    end if;
    if upper(trim(coalesce(nullif(v_prop ->> 'country', ''), 'US'))) !~ '^[A-Z]{2}$' then
      raise exception 'the country for % must be a two-letter code such as US', v_code using errcode = '22023';
    end if;
  end loop;

  insert into public.companies (slug, name, legal_name, default_currency, require_mfa_for_privileged)
  values (v_slug, v_name, nullif(trim(p ->> 'legal_name'), ''), v_currency, coalesce((p ->> 'require_mfa')::boolean, true))
  returning id into v_company;

  insert into public.company_branding (company_id, portal_name, primary_color, accent_color, surface_color, logo_url, logo_mark_url,
                                       login_headline, login_message, support_email)
  values (v_company, coalesce(nullif(trim(v_b ->> 'portal_name'), ''), v_name),
          coalesce(nullif(v_b ->> 'primary_color', ''), '#1f3a5f'), coalesce(nullif(v_b ->> 'accent_color', ''), '#c8a24a'),
          coalesce(nullif(v_b ->> 'surface_color', ''), '#f6f7f9'),
          nullif(trim(v_b ->> 'logo_url'), ''), nullif(trim(v_b ->> 'logo_mark_url'), ''),
          nullif(trim(v_b ->> 'login_headline'), ''), nullif(trim(v_b ->> 'login_message'), ''),
          nullif(trim(v_b ->> 'support_email'), ''));

  insert into public.company_modules (company_id, module, enabled)
  select v_company, m, m::text = any (v_modules) or m = 'admin'
  from unnest(enum_range(null::public.portal_module)) m;

  perform app.seed_company_defaults(v_company);

  for v_prop in select * from jsonb_array_elements(coalesce(p -> 'properties', '[]'::jsonb)) loop
    v_rooms := nullif(v_prop ->> 'rooms', '')::int;
    v_opened := nullif(v_prop ->> 'opened_on', '')::date;
    v_country := upper(trim(coalesce(nullif(v_prop ->> 'country', ''), 'US')));
    v_status := coalesce(nullif(v_prop ->> 'status', ''), 'onboarding');
    if v_rooms is not null and (v_rooms <= 0 or v_rooms >= 100000) then
      raise exception 'rooms for % must be between 1 and 99,999', upper(trim(v_prop ->> 'code')) using errcode = '22023';
    end if;
    insert into public.properties (company_id, code, name, timezone, status, city, region, opened_on, country, currency)
    values (v_company, upper(trim(v_prop ->> 'code')), trim(v_prop ->> 'name'), v_prop ->> 'timezone',
            v_status::public.property_status, nullif(trim(v_prop ->> 'city'), ''), nullif(trim(v_prop ->> 'region'), ''),
            v_opened, v_country, v_currency)
    returning id into v_prop_id;
    if v_rooms is not null then
      insert into public.room_inventory_history (company_id, property_id, effective_from, room_count, reason, created_by)
      values (v_company, v_prop_id, coalesce(v_opened, current_date), v_rooms, 'Opening inventory', auth.uid());
    end if;
  end loop;

  foreach v_email in array v_admins loop
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.invitations (company_id, email, role, all_properties, token_hash, invited_by, expires_at)
    values (v_company, v_email, 'company_admin', true, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(),
            now() + interval '14 days');
    v_tokens := v_tokens || jsonb_build_object('email', v_email, 'token', v_token);
  end loop;

  perform app.audit(v_company, 'platform.company_provisioned', 'company', v_company::text,
                    jsonb_build_object('admins', cardinality(v_admins), 'properties', cardinality(v_codes)));
  return jsonb_build_object('company_id', v_company, 'invitations', v_tokens);
end;
$$;
grant execute on function public.platform_provision_company(jsonb) to authenticated;

-- Issue a company-administrator invitation while a company is being set up: before anyone
-- has joined as admin (also replaces a lost or expired link for the same email). Once a company
-- has an administrator, its own admins invite people; platform staff use a support session.
create or replace function public.platform_invite_admin(p_company_id uuid, p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  perform app.require_platform_admin(true);
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  if v_email is null or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'enter a valid email address' using errcode = '22023';
  end if;
  if exists (select 1 from public.company_memberships m where m.company_id = p_company_id and m.role = 'company_admin' and m.status = 'active') then
    raise exception 'this company already has an administrator, who invites further people; open a support session if they need help'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles pr join public.platform_admins pa on pa.user_id = pr.id where lower(pr.email) = v_email) then
    raise exception '% is a platform administrator; use a support session instead of a company membership', v_email using errcode = '42501';
  end if;
  if exists (select 1 from public.company_memberships m join public.profiles pr on pr.id = m.user_id
             where m.company_id = p_company_id and lower(pr.email) = v_email) then
    raise exception 'that person already has (or had) a membership at this company' using errcode = '42501';
  end if;
  update public.invitations set revoked_at = now()
   where company_id = p_company_id and email = v_email and role = 'company_admin' and accepted_at is null and revoked_at is null;
  insert into public.invitations (company_id, email, role, all_properties, token_hash, invited_by, expires_at)
  values (p_company_id, v_email, 'company_admin', true, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(),
          now() + interval '14 days')
  returning id into v_id;
  perform app.audit(p_company_id, 'platform.admin_invited', 'invitation', v_id::text, '{}'::jsonb);
  return v_token;
end;
$$;
grant execute on function public.platform_invite_admin(uuid, text) to authenticated;

create or replace function public.platform_revoke_admin_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  perform app.require_platform_admin(true);
  update public.invitations set revoked_at = now()
   where id = p_invitation_id and role = 'company_admin' and accepted_at is null and revoked_at is null
     and exists (select 1 from public.platform_admins pa where pa.user_id = invitations.invited_by)
  returning company_id into v_company;
  if v_company is null then
    raise exception 'that invitation is not pending' using errcode = '55000';
  end if;
  perform app.audit(v_company, 'platform.admin_invitation_revoked', 'invitation', p_invitation_id::text, '{}'::jsonb);
end;
$$;
grant execute on function public.platform_revoke_admin_invitation(uuid) to authenticated;

-- Suspending a company stops every member's access (permission checks require an active
-- company) without deleting anything; reactivating restores it.
create or replace function public.platform_set_company_status(p_company_id uuid, p_status public.company_status, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_old public.company_status;
begin
  perform app.require_platform_admin(true);
  if p_status is null then
    raise exception 'choose active or suspended' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select status into v_old from public.companies where id = p_company_id for update;
  if not found then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  if v_old = p_status then
    raise exception 'the company is already %', p_status using errcode = '55000';
  end if;
  update public.companies set status = p_status where id = p_company_id;
  perform app.audit(p_company_id, case when p_status = 'suspended' then 'platform.company_suspended' else 'platform.company_reactivated' end,
                    'company', p_company_id::text, jsonb_build_object('reason', trim(p_reason)));
end;
$$;
grant execute on function public.platform_set_company_status(uuid, public.company_status, text) to authenticated;

-- Postgres grants EXECUTE on new functions to PUBLIC; these are for signed-in platform admins only.
revoke execute on function public.platform_companies() from public, anon;
revoke execute on function public.platform_company_detail(uuid) from public, anon;
revoke execute on function public.platform_provision_company(jsonb) from public, anon;
revoke execute on function public.platform_invite_admin(uuid, text) from public, anon;
revoke execute on function public.platform_revoke_admin_invitation(uuid) from public, anon;
revoke execute on function public.platform_set_company_status(uuid, public.company_status, text) from public, anon;
