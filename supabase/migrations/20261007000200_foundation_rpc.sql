-- =============================================================================
-- Milestone 1 — RPC endpoints (PostgREST /rpc/*)
-- All functions validate permissions explicitly; SECURITY DEFINER functions use
-- an empty search_path and fully qualified names.
-- =============================================================================

-- Public branding lookup by host. Returns presentation fields only.
create or replace function public.resolve_branding(p_host text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'company_id', c.id,
    'company_slug', c.slug,
    'company_name', c.name,
    'portal_name', b.portal_name,
    'logo_url', b.logo_url,
    'logo_mark_url', b.logo_mark_url,
    'favicon_url', b.favicon_url,
    'primary_color', b.primary_color,
    'accent_color', b.accent_color,
    'surface_color', b.surface_color,
    'login_headline', b.login_headline,
    'login_message', b.login_message,
    'support_email', b.support_email,
    'is_demo', c.is_demo
  )
  from public.company_domains d
  join public.companies c on c.id = d.company_id and c.status = 'active'
  join public.company_branding b on b.company_id = c.id
  where d.hostname = lower(trim(p_host))
    and d.verification_status = 'verified'
  limit 1;
$$;
grant execute on function public.resolve_branding(text) to anon, authenticated;

-- Everything the shell needs: memberships, branding, permission summary.
create or replace function public.my_context()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select jsonb_build_object(
    'user_id', v_uid,
    'email', (select email from public.profiles where id = v_uid),
    'full_name', (select full_name from public.profiles where id = v_uid),
    'aal', app.current_aal(),
    'is_platform_admin', app.is_platform_admin(),
    'cross_company_rollups_enabled', (select cross_company_rollups_enabled from public.platform_settings),
    'companies', coalesce((
      select jsonb_agg(x order by x ->> 'company_name') from (
        select jsonb_build_object(
          'company_id', c.id,
          'company_slug', c.slug,
          'company_name', c.name,
          'is_demo', c.is_demo,
          'access', 'membership',
          'membership_id', m.id,
          'role', m.role,
          'all_properties', m.all_properties,
          'require_mfa_for_privileged', c.require_mfa_for_privileged,
          'branding', to_jsonb(b) - 'company_id' - 'updated_at',
          'modules', (select coalesce(jsonb_object_agg(cm.module, cm.enabled), '{}'::jsonb)
                      from public.company_modules cm where cm.company_id = c.id),
          'company_permissions', (select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb)
                                  from public.permissions p where app.membership_allows(m.id, p.key)),
          'mfa_blocked_permissions', (
            select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb)
            from public.permissions p
            where p.privileged and c.require_mfa_for_privileged and app.current_aal() <> 'aal2'
              and (exists (select 1 from public.role_permission_defaults d where d.role = m.role and d.permission_key = p.key)
                   or exists (select 1 from public.membership_permission_overrides o
                              where o.membership_id = m.id and o.permission_key = p.key and o.effect = 'allow'))
              and not exists (select 1 from public.membership_permission_overrides o
                              where o.membership_id = m.id and o.permission_key = p.key and o.effect = 'deny'))
        ) as x
        from public.company_memberships m
        join public.companies c on c.id = m.company_id and c.status = 'active'
        left join public.company_branding b on b.company_id = c.id
        where m.user_id = v_uid and m.status = 'active'
        union all
        select jsonb_build_object(
          'company_id', c.id,
          'company_slug', c.slug,
          'company_name', c.name,
          'is_demo', c.is_demo,
          'access', 'support_session',
          'support_session_id', s.id,
          'support_expires_at', s.expires_at,
          'role', null,
          'all_properties', true,
          'branding', to_jsonb(b) - 'company_id' - 'updated_at',
          'modules', (select coalesce(jsonb_object_agg(cm.module, cm.enabled), '{}'::jsonb)
                      from public.company_modules cm where cm.company_id = c.id),
          'company_permissions', (select coalesce(jsonb_agg(sp.permission_key order by sp.permission_key), '[]'::jsonb)
                                  from public.support_session_permissions sp
                                  where app.support_session_allows(c.id, sp.permission_key)),
          'mfa_blocked_permissions', '[]'::jsonb
        )
        from public.support_access_sessions s
        join public.companies c on c.id = s.company_id and c.status = 'active'
        left join public.company_branding b on b.company_id = c.id
        where s.user_id = v_uid and s.ended_at is null and now() between s.starts_at and s.expires_at
          and not exists (select 1 from public.company_memberships m2
                          where m2.company_id = c.id and m2.user_id = v_uid and m2.status = 'active')
      ) q
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
grant execute on function public.my_context() to authenticated;

-- Effective permissions per accessible property in a company (UI gating only;
-- the database enforces the same rules independently).
create or replace function public.my_property_permissions(p_company_id uuid)
returns table (property_id uuid, permission_key text)
language sql stable security definer set search_path = '' as $$
  select p.id, perm.key
  from public.properties p
  cross join public.permissions perm
  where p.company_id = p_company_id
    and p.id = any (app.permitted_property_ids(perm.key));
$$;
grant execute on function public.my_property_permissions(uuid) to authenticated;

-- Display names for users who share an active company with the caller.
create or replace function public.user_display_names(p_user_ids uuid[])
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select pr.id, coalesce(pr.full_name, split_part(pr.email, '@', 1))
  from public.profiles pr
  where pr.id = any (p_user_ids)
    and (pr.id = auth.uid() or app.is_platform_admin() or exists (
      select 1 from public.company_memberships a
      join public.company_memberships b on b.company_id = a.company_id and b.status = 'active'
      where a.user_id = auth.uid() and a.status = 'active' and b.user_id = pr.id));
$$;
grant execute on function public.user_display_names(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- Invitations
-- -----------------------------------------------------------------------------
create or replace function public.create_invitation(
  p_company_id uuid,
  p_email text,
  p_role public.membership_role,
  p_all_properties boolean default false,
  p_property_ids uuid[] default '{}',
  p_expires_in_days integer default 7
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
  v_email text := lower(trim(p_email));
begin
  if not app.has_permission('admin.users', p_company_id) then
    raise exception 'permission denied: admin.users' using errcode = '42501';
  end if;
  if p_expires_in_days not between 1 and 30 then
    raise exception 'expiry must be between 1 and 30 days' using errcode = '22023';
  end if;
  if p_role in ('owner', 'investor') and p_all_properties then
    raise exception 'owners and investors must be granted specific properties' using errcode = '22023';
  end if;
  if not p_all_properties and coalesce(array_length(p_property_ids, 1), 0) = 0 then
    raise exception 'select at least one property or company-wide access' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_property_ids) pid
             where not exists (select 1 from public.properties p where p.id = pid and p.company_id = p_company_id)) then
    raise exception 'property does not belong to company' using errcode = '22023';
  end if;
  if exists (select 1 from public.company_memberships m join public.profiles pr on pr.id = m.user_id
             where m.company_id = p_company_id and pr.email = v_email and m.status = 'active') then
    raise exception 'user is already an active member' using errcode = '23505';
  end if;

  update public.invitations set revoked_at = now()
  where company_id = p_company_id and email = v_email and accepted_at is null and revoked_at is null;

  insert into public.invitations (company_id, email, role, all_properties, property_ids, token_hash, invited_by, expires_at)
  values (p_company_id, v_email, p_role, p_all_properties, coalesce(p_property_ids, '{}'),
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(), now() + make_interval(days => p_expires_in_days))
  returning id into v_id;

  perform app.audit(p_company_id, 'invitation.created', 'invitation', v_id::text,
                    jsonb_build_object('email', v_email, 'role', p_role, 'all_properties', p_all_properties,
                                       'property_count', coalesce(array_length(p_property_ids, 1), 0)));
  -- The token is returned once so the API/notification layer can email the link.
  return jsonb_build_object('invitation_id', v_id, 'token', v_token);
end;
$$;
grant execute on function public.create_invitation(uuid, text, public.membership_role, boolean, uuid[], integer) to authenticated;

create or replace function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invitations;
  v_email text;
  v_membership uuid;
  v_pid uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_inv from public.invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if not found or v_inv.revoked_at is not null or v_inv.accepted_at is not null or v_inv.expires_at < now() then
    raise exception 'invitation is invalid or expired' using errcode = '22023';
  end if;
  select email into v_email from public.profiles where id = auth.uid();
  if v_email is distinct from v_inv.email then
    raise exception 'invitation was issued to a different email address' using errcode = '42501';
  end if;

  insert into public.company_memberships (company_id, user_id, role, all_properties, invited_by)
  values (v_inv.company_id, auth.uid(), v_inv.role, v_inv.all_properties, v_inv.invited_by)
  on conflict (company_id, user_id) do update
    set role = excluded.role, all_properties = excluded.all_properties, status = 'active',
        revoked_at = null, revoked_by = null, revoke_reason = null
  returning id into v_membership;

  foreach v_pid in array v_inv.property_ids loop
    insert into public.property_access_grants (company_id, membership_id, property_id, granted_by)
    values (v_inv.company_id, v_membership, v_pid, v_inv.invited_by)
    on conflict (membership_id, property_id) where revoked_at is null do nothing;
  end loop;

  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_inv.id;
  perform app.audit(v_inv.company_id, 'invitation.accepted', 'invitation', v_inv.id::text, '{}'::jsonb);
  return v_membership;
end;
$$;
grant execute on function public.accept_invitation(text) to authenticated;

create or replace function public.revoke_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.invitations where id = p_invitation_id;
  if v_company is null or not app.has_permission('admin.users', v_company) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  update public.invitations set revoked_at = now() where id = p_invitation_id and accepted_at is null;
  perform app.audit(v_company, 'invitation.revoked', 'invitation', p_invitation_id::text, '{}'::jsonb);
end;
$$;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Membership administration
-- -----------------------------------------------------------------------------
create or replace function app.assert_not_last_admin(p_membership_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_m public.company_memberships;
begin
  select * into v_m from public.company_memberships where id = p_membership_id;
  if v_m.role = 'company_admin' and v_m.status = 'active' and not exists (
    select 1 from public.company_memberships
    where company_id = v_m.company_id and role = 'company_admin' and status = 'active' and id <> v_m.id) then
    raise exception 'cannot remove the last company administrator' using errcode = '23514';
  end if;
end;
$$;

create or replace function public.revoke_membership(p_membership_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_m public.company_memberships;
begin
  select * into v_m from public.company_memberships where id = p_membership_id for update;
  if not found or not app.has_permission('admin.users', v_m.company_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_m.status = 'revoked' then
    return;
  end if;
  perform app.assert_not_last_admin(p_membership_id);
  update public.company_memberships
     set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason
   where id = p_membership_id;
  update public.property_access_grants set revoked_at = now(), revoked_by = auth.uid()
   where membership_id = p_membership_id and revoked_at is null;
  perform app.audit(v_m.company_id, 'membership.revoked', 'company_membership', p_membership_id::text,
                    jsonb_build_object('reason', p_reason, 'user_id', v_m.user_id));
end;
$$;
grant execute on function public.revoke_membership(uuid, text) to authenticated;

create or replace function public.update_membership(
  p_membership_id uuid, p_role public.membership_role, p_all_properties boolean, p_title text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_m public.company_memberships;
begin
  select * into v_m from public.company_memberships where id = p_membership_id for update;
  if not found or not app.has_permission('admin.users', v_m.company_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_m.role = 'company_admin' and p_role <> 'company_admin' then
    perform app.assert_not_last_admin(p_membership_id);
  end if;
  if p_role in ('owner', 'investor') and p_all_properties then
    raise exception 'owners and investors must be granted specific properties' using errcode = '22023';
  end if;
  update public.company_memberships
     set role = p_role, all_properties = p_all_properties, title = coalesce(p_title, title)
   where id = p_membership_id;
end;
$$;
grant execute on function public.update_membership(uuid, public.membership_role, boolean, text) to authenticated;

create or replace function public.grant_property_access(
  p_membership_id uuid, p_property_id uuid, p_permissions text[] default null, p_expires_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_m public.company_memberships;
  v_id uuid;
begin
  select * into v_m from public.company_memberships where id = p_membership_id;
  if not found or not app.has_permission('admin.users', v_m.company_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_m.status <> 'active' then
    raise exception 'membership is not active' using errcode = '22023';
  end if;
  if not exists (select 1 from public.properties where id = p_property_id and company_id = v_m.company_id) then
    raise exception 'property does not belong to company' using errcode = '22023';
  end if;
  update public.property_access_grants set revoked_at = now(), revoked_by = auth.uid()
   where membership_id = p_membership_id and property_id = p_property_id and revoked_at is null;
  insert into public.property_access_grants (company_id, membership_id, property_id, permissions, granted_by, expires_at)
  values (v_m.company_id, p_membership_id, p_property_id, p_permissions, auth.uid(), p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.grant_property_access(uuid, uuid, text[], timestamptz) to authenticated;

create or replace function public.revoke_property_access(p_grant_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.property_access_grants where id = p_grant_id;
  if v_company is null or not app.has_permission('admin.users', v_company) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  update public.property_access_grants set revoked_at = now(), revoked_by = auth.uid()
   where id = p_grant_id and revoked_at is null;
end;
$$;
grant execute on function public.revoke_property_access(uuid) to authenticated;

create or replace function public.set_permission_override(p_membership_id uuid, p_permission text, p_effect text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_m public.company_memberships;
begin
  select * into v_m from public.company_memberships where id = p_membership_id;
  if not found or not app.has_permission('admin.users', v_m.company_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_m.user_id = auth.uid() and p_effect = 'allow' then
    raise exception 'administrators cannot grant themselves extra permissions' using errcode = '42501';
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

-- -----------------------------------------------------------------------------
-- Support access
-- -----------------------------------------------------------------------------
create or replace function public.open_support_session(
  p_company_id uuid, p_reason text, p_ticket_ref text, p_hours integer default 2
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_max integer;
begin
  if not app.is_platform_admin() then
    raise exception 'only platform administrators can open support sessions' using errcode = '42501';
  end if;
  if app.current_aal() <> 'aal2' and coalesce(current_setting('app.allow_support_without_mfa', true), 'off') <> 'on' then
    raise exception 'MFA (aal2) is required to open a support session' using errcode = '42501';
  end if;
  select max_support_session_hours into v_max from public.platform_settings;
  if p_hours < 1 or p_hours > v_max then
    raise exception 'support session length must be between 1 and % hours', v_max using errcode = '22023';
  end if;
  update public.support_access_sessions set ended_at = now()
   where user_id = auth.uid() and company_id = p_company_id and ended_at is null;
  insert into public.support_access_sessions (company_id, user_id, reason, ticket_ref, expires_at)
  values (p_company_id, auth.uid(), p_reason, p_ticket_ref, now() + make_interval(hours => p_hours))
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.open_support_session(uuid, text, text, integer) to authenticated;

create or replace function public.end_support_session(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.support_access_sessions set ended_at = now()
   where id = p_session_id and ended_at is null
     and (user_id = auth.uid()
          or company_id = any (app.permitted_company_ids('admin.users')));
  if not found then
    raise exception 'session not found or not permitted' using errcode = '42501';
  end if;
end;
$$;
grant execute on function public.end_support_session(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Platform: company provisioning
-- -----------------------------------------------------------------------------
create or replace function public.provision_company(
  p_slug text, p_name text, p_portal_name text, p_admin_email text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_inv jsonb;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_inv_id uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'only platform administrators can provision companies' using errcode = '42501';
  end if;
  insert into public.companies (slug, name) values (p_slug, p_name) returning id into v_company;
  insert into public.company_branding (company_id, portal_name) values (v_company, p_portal_name);
  insert into public.company_modules (company_id, module)
  select v_company, m from unnest(enum_range(null::public.portal_module)) m;
  insert into public.invitations (company_id, email, role, all_properties, token_hash, invited_by, expires_at)
  values (v_company, lower(trim(p_admin_email)), 'company_admin', true,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(), now() + interval '14 days')
  returning id into v_inv_id;
  return jsonb_build_object('company_id', v_company, 'invitation_id', v_inv_id, 'token', v_token);
end;
$$;
grant execute on function public.provision_company(text, text, text, text) to authenticated;
