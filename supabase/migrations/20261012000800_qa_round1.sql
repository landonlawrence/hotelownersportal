-- =============================================================================
-- QA round 1 fixes (security, workflow integrity and data hygiene).
-- Each section references the QA finding id (R1-xx).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

-- A session verified with MFA (aal2), or the explicit local-only bypass used by
-- tests and scripts (a transaction-local setting; never set by clients).
create or replace function app.privileged_aal_ok() returns boolean
language sql stable set search_path = '' as $$
  select app.current_aal() = 'aal2'
      or coalesce(current_setting('app.allow_support_without_mfa', true), 'off') = 'on';
$$;

-- Platform administrator acting with a 2FA-verified session (R1-04).
create or replace function app.is_platform_admin_mfa() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_platform_admin() and app.privileged_aal_ok();
$$;

-- Company-wide (property_id IS NULL) writes require a membership with access to
-- every property, not merely a company-level role permission (R1-06).
create or replace function app.has_company_wide_permission(p_perm text, p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_company_id is not null and (
    exists (select 1 from public.company_memberships m
            where m.company_id = p_company_id and m.user_id = auth.uid() and m.status = 'active'
              and m.all_properties and app.membership_allows(m.id, p_perm))
    or app.support_session_allows(p_company_id, p_perm));
$$;

-- One in-app notification (+ email unless opted out) for a single user.
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
begin
  if p_user_id is null or not exists (select 1 from public.company_memberships m
                                     where m.company_id = p_company_id and m.user_id = p_user_id and m.status = 'active') then
    return;
  end if;
  select email into v_email from public.profiles where id = p_user_id;
  select coalesce(b.email_from_name, c.name), coalesce(b.portal_name, c.name) into v_from, v_portal
  from public.companies c left join public.company_branding b on b.company_id = c.id where c.id = p_company_id;
  insert into public.notifications (company_id, user_id, property_id, kind, title, body, link_path, entity_type, entity_id)
  values (p_company_id, p_user_id, p_property_id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id)
  returning id into v_nid;
  if v_email is not null and coalesce((select email_enabled from public.notification_preferences
               where user_id = p_user_id and company_id = p_company_id and kind = p_kind), true) then
    insert into public.notification_outbox (notification_id, company_id, user_id, to_email, subject, body_text)
    values (v_nid, p_company_id, p_user_id, v_email, format('[%s] %s', v_portal, p_title),
            format(E'%s\n\nSign in to %s to view it securely.\n\nThis message was sent by %s. Financial documents are never attached to email.',
                   p_title, v_portal, v_from));
  end if;
end;
$$;
revoke execute on function app.notify_user(uuid, uuid, uuid, text, text, text, text, text, uuid) from authenticated;

-- =============================================================================
-- R1-01 Support sessions require an aal2 session on every use, not only to open
-- =============================================================================
create or replace function app.support_session_allows(p_company_id uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.privileged_aal_ok() and exists (
    select 1 from public.support_access_sessions s
    join public.platform_admins pa on pa.user_id = s.user_id
    join public.companies c on c.id = s.company_id and c.status = 'active'
    join public.permissions p on p.key = p_perm
    where s.user_id = auth.uid()
      and s.company_id = p_company_id
      and s.ended_at is null
      and now() between s.starts_at and s.expires_at
      and p_perm in (select permission_key from public.support_session_permissions)
      and coalesce((select cm.enabled from public.company_modules cm
                    where cm.company_id = s.company_id and cm.module = p.module), true)
  );
$$;

create or replace function app.is_member(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_memberships
                 where company_id = p_company_id and user_id = auth.uid() and status = 'active')
      or (app.privileged_aal_ok() and exists (
            select 1 from public.support_access_sessions s
            join public.platform_admins pa on pa.user_id = s.user_id
            where s.company_id = p_company_id and s.user_id = auth.uid()
              and s.ended_at is null and now() between s.starts_at and s.expires_at));
$$;

-- my_context: support-session companies only with a verified session; otherwise
-- they are listed under support_sessions_awaiting_mfa so the shell can prompt.
create or replace function public.my_context()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_mfa boolean := app.privileged_aal_ok();
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
    'support_sessions_awaiting_mfa', case when v_mfa then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('support_session_id', s.id, 'company_id', c.id, 'company_name', c.name,
                                          'support_expires_at', s.expires_at) order by c.name)
      from public.support_access_sessions s
      join public.companies c on c.id = s.company_id and c.status = 'active'
      where s.user_id = v_uid and s.ended_at is null and now() between s.starts_at and s.expires_at
        and exists (select 1 from public.platform_admins pa where pa.user_id = v_uid)
        and not exists (select 1 from public.company_memberships m2
                        where m2.company_id = c.id and m2.user_id = v_uid and m2.status = 'active')), '[]'::jsonb) end,
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
        where v_mfa and s.user_id = v_uid and s.ended_at is null and now() between s.starts_at and s.expires_at
          and exists (select 1 from public.platform_admins pa where pa.user_id = v_uid)
          and not exists (select 1 from public.company_memberships m2
                          where m2.company_id = c.id and m2.user_id = v_uid and m2.status = 'active')
      ) q
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
grant execute on function public.my_context() to authenticated;

-- =============================================================================
-- R1-09 Opening a support session notifies company admins; admins can see who
-- =============================================================================
create or replace function public.open_support_session(
  p_company_id uuid, p_reason text, p_ticket_ref text, p_hours integer default 2
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_max integer;
  v_expires timestamptz;
  v_who text;
begin
  if not app.is_platform_admin() then
    raise exception 'only platform administrators can open support sessions' using errcode = '42501';
  end if;
  if not app.privileged_aal_ok() then
    raise exception 'MFA (aal2) is required to open a support session' using errcode = '42501';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id and status = 'active') then
    raise exception 'company not found' using errcode = '22023';
  end if;
  select max_support_session_hours into v_max from public.platform_settings;
  if p_hours is null or p_hours < 1 or p_hours > v_max then
    raise exception 'support session length must be between 1 and % hours', v_max using errcode = '22023';
  end if;
  update public.support_access_sessions set ended_at = now()
   where user_id = auth.uid() and company_id = p_company_id and ended_at is null;
  v_expires := now() + make_interval(hours => p_hours);
  insert into public.support_access_sessions (company_id, user_id, reason, ticket_ref, expires_at)
  values (p_company_id, auth.uid(), p_reason, p_ticket_ref, v_expires)
  returning id into v_id;
  select coalesce(full_name, email) into v_who from public.profiles where id = auth.uid();
  perform app.notify_permitted(p_company_id, null, 'admin.users', 'support_session_opened',
    'Support access opened',
    format('%s opened read-only support access (ticket %s) until %s UTC. Reason: %s',
           coalesce(v_who, 'Platform support'), trim(p_ticket_ref), to_char(v_expires at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), trim(p_reason)),
    '/admin?tab=support', 'support_session', v_id, null);
  return v_id;
end;
$$;
grant execute on function public.open_support_session(uuid, text, text, integer) to authenticated;

create policy profiles_support_admin on public.profiles for select to authenticated
  using (exists (
    select 1 from public.support_access_sessions s
    where s.user_id = profiles.id
      and s.company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[])));

-- =============================================================================
-- R1-04 Platform-admin writes require a 2FA-verified session
-- =============================================================================
drop policy companies_platform_insert on public.companies;
create policy companies_platform_insert on public.companies for insert to authenticated
  with check ((select app.is_platform_admin_mfa()));
drop policy companies_admin_update on public.companies;
create policy companies_admin_update on public.companies for update to authenticated
  using (id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin_mfa()))
  with check (id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin_mfa()));

drop policy branding_write on public.company_branding;
create policy branding_write on public.company_branding for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin_mfa()))
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin_mfa()));

drop policy domains_platform_write on public.company_domains;
create policy domains_platform_write on public.company_domains for all to authenticated
  using ((select app.is_platform_admin_mfa())) with check ((select app.is_platform_admin_mfa()));

drop policy modules_platform_write on public.company_modules;
create policy modules_platform_write on public.company_modules for all to authenticated
  using ((select app.is_platform_admin_mfa())) with check ((select app.is_platform_admin_mfa()));

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
  insert into public.invitations (company_id, email, role, all_properties, token_hash, invited_by, expires_at)
  values (v_company, lower(trim(p_admin_email)), 'company_admin', true,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(), now() + interval '14 days')
  returning id into v_inv_id;
  return jsonb_build_object('company_id', v_company, 'invitation_id', v_inv_id, 'token', v_token);
end;
$$;
grant execute on function public.provision_company(text, text, text, text) to authenticated;

-- =============================================================================
-- R1-02 CapEx rows must belong to the same property as their project
-- R1-53 Quotes and commitments are positive amounts
-- =============================================================================
-- Existing rows must already satisfy the new constraints. Stop with a clear message
-- rather than deleting anyone's data; fix offending rows by hand and re-run.
do $$
begin
  if exists (select 1 from public.capex_transactions t join public.capex_projects p on p.id = t.project_id where p.property_id <> t.property_id)
     or exists (select 1 from public.capex_updates u join public.capex_projects p on p.id = u.project_id where p.property_id <> u.property_id)
     or exists (select 1 from public.capex_approval_requests r join public.capex_projects p on p.id = r.project_id where p.property_id <> r.property_id) then
    raise exception 'capex rows reference a project on another property; correct them before applying this migration';
  end if;
  if exists (select 1 from public.capex_transactions where kind in ('quote', 'commitment') and amount <= 0) then
    raise exception 'capex quotes/commitments with zero or negative amounts exist; correct them before applying this migration';
  end if;
end;
$$;

alter table public.capex_projects add constraint capex_projects_id_company_property_key unique (id, company_id, property_id);
alter table public.capex_transactions drop constraint capex_transactions_project_id_company_id_fkey;
alter table public.capex_transactions add constraint capex_transactions_project_fkey
  foreign key (project_id, company_id, property_id) references public.capex_projects (id, company_id, property_id) on delete cascade;
alter table public.capex_updates drop constraint capex_updates_project_id_company_id_fkey;
alter table public.capex_updates add constraint capex_updates_project_fkey
  foreign key (project_id, company_id, property_id) references public.capex_projects (id, company_id, property_id) on delete cascade;
alter table public.capex_approval_requests drop constraint capex_approval_requests_project_id_company_id_fkey;
alter table public.capex_approval_requests add constraint capex_approval_requests_project_fkey
  foreign key (project_id, company_id, property_id) references public.capex_projects (id, company_id, property_id) on delete cascade;

alter table public.capex_transactions add constraint capex_transactions_positive_quotes_commitments
  check (kind = 'actual' or amount > 0);

drop policy capex_tx_write on public.capex_transactions;
create policy capex_tx_write on public.capex_transactions for insert to authenticated
  with check (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[])
              and created_by = (select auth.uid())
              and exists (select 1 from public.capex_projects p
                          where p.id = capex_transactions.project_id and p.property_id = capex_transactions.property_id));
-- Spend may only settle a commitment on the same project (a trigger: a policy reading
-- capex_transactions from its own policy would recurse).
create or replace function app.capex_commitment_same_project() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.related_commitment_id is not null and not exists (
    select 1 from public.capex_transactions c
    where c.id = new.related_commitment_id and c.project_id = new.project_id and c.kind = 'commitment') then
    raise exception 'the related commitment must belong to the same project' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function app.capex_commitment_same_project() from public, anon, authenticated;
create trigger capex_transactions_commitment_same_project before insert or update of related_commitment_id, project_id
  on public.capex_transactions for each row execute function app.capex_commitment_same_project();

drop policy capex_tx_update on public.capex_transactions;
create policy capex_tx_update on public.capex_transactions for update to authenticated
  using (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[])
              and exists (select 1 from public.capex_projects p
                          where p.id = capex_transactions.project_id and p.property_id = capex_transactions.property_id));
drop policy capex_updates_insert on public.capex_updates;
create policy capex_updates_insert on public.capex_updates for insert to authenticated
  with check (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[])
              and created_by = (select auth.uid())
              and exists (select 1 from public.capex_projects p
                          where p.id = capex_updates.project_id and p.property_id = capex_updates.property_id));

-- =============================================================================
-- R1-02 / R1-06 / R1-18 Document uploads: linked entity must be in scope;
-- company-wide documents need company-wide access
-- =============================================================================
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
  if p_property_id is null then
    if not app.has_company_wide_permission('documents.upload', p_company_id)
       and not app.has_company_wide_permission('documents.manage', p_company_id) then
      raise exception 'company-wide documents can only be uploaded by users with access to every property' using errcode = '42501';
    end if;
  elsif not app.has_permission('documents.upload', p_company_id, p_property_id)
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
    if not exists (select 1 from public.document_categories where company_id = p_company_id and key = p_category_key) then
      raise exception 'unknown document category' using errcode = '22023';
    end if;
    if (p_linked_entity_type is null) <> (p_linked_entity_id is null) then
      raise exception 'linked entity type and id must be given together' using errcode = '22023';
    end if;
    if p_linked_entity_type is not null and not (
      (p_linked_entity_type = 'capex_project' and exists (
         select 1 from public.capex_projects x where x.id = p_linked_entity_id and x.company_id = p_company_id
           and x.property_id is not distinct from p_property_id))
      or (p_linked_entity_type = 'capex_transaction' and exists (
         select 1 from public.capex_transactions x where x.id = p_linked_entity_id and x.company_id = p_company_id
           and x.property_id is not distinct from p_property_id))
      or (p_linked_entity_type = 'financial_report' and exists (
         select 1 from public.financial_reports x where x.id = p_linked_entity_id and x.company_id = p_company_id
           and x.property_id is not distinct from p_property_id))
      or (p_linked_entity_type = 'reporting_package' and exists (
         select 1 from public.reporting_packages x where x.id = p_linked_entity_id and x.company_id = p_company_id
           and x.property_id is not distinct from p_property_id))) then
      raise exception 'the linked % was not found for this property', replace(p_linked_entity_type, '_', ' ') using errcode = '22023';
    end if;
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

-- Viewers only see documents that have a released version (uploaders and
-- document managers still see pending/rejected ones).
drop policy documents_read on public.documents;
create policy documents_read on public.documents for select to authenticated
  using (
    (status = 'active' and (current_version_id is not null or created_by = (select auth.uid())) and (
      (property_id is not null and (
        (visibility = 'general' and property_id = any ((select app.permitted_property_ids('documents.view'))::uuid[]))
        or (visibility = 'owner' and property_id = any ((select app.permitted_property_ids('documents.view_owner'))::uuid[]))
        or (visibility = 'internal' and property_id = any ((select app.permitted_property_ids('documents.view_internal'))::uuid[]))
        or (visibility = 'confidential' and property_id = any ((select app.permitted_property_ids('documents.view_confidential'))::uuid[]))))
      or (property_id is null and (
        (visibility = 'general' and company_id = any ((select app.permitted_company_ids('documents.view'))::uuid[]))
        or (visibility = 'owner' and company_id = any ((select app.permitted_company_ids('documents.view_owner'))::uuid[]))
        or (visibility = 'internal' and company_id = any ((select app.permitted_company_ids('documents.view_internal'))::uuid[]))
        or (visibility = 'confidential' and company_id = any ((select app.permitted_company_ids('documents.view_confidential'))::uuid[]))))))
    or (property_id is not null and property_id = any ((select app.permitted_property_ids('documents.manage'))::uuid[]))
    or (property_id is null and company_id = any ((select app.permitted_company_ids('documents.manage'))::uuid[]))
  );

drop policy documents_manage_update on public.documents;
create policy documents_manage_update on public.documents for update to authenticated
  using ((property_id is not null and property_id = any ((select app.permitted_property_ids('documents.manage'))::uuid[]))
         or (property_id is null and app.has_company_wide_permission('documents.manage', company_id)))
  with check ((property_id is not null and property_id = any ((select app.permitted_property_ids('documents.manage'))::uuid[]))
         or (property_id is null and app.has_company_wide_permission('documents.manage', company_id)));

-- R1-06 Company-wide commentary needs company-wide access.
drop policy commentary_write on public.management_commentary;
create policy commentary_write on public.management_commentary for all to authenticated
  using ((property_id is not null and property_id = any ((select app.permitted_property_ids('commentary.edit'))::uuid[]))
         or (property_id is null and app.has_company_wide_permission('commentary.edit', company_id)))
  with check ((property_id is not null and property_id = any ((select app.permitted_property_ids('commentary.edit'))::uuid[]))
         or (property_id is null and app.has_company_wide_permission('commentary.edit', company_id)));

-- =============================================================================
-- R1-03 Import visibility covers every row in the file; uploaders see their runs
-- =============================================================================
drop policy import_runs_read on public.import_runs;
create policy import_runs_read on public.import_runs for select to authenticated
  using (app.can_view_import_run(company_id, property_ids)
         or (requested_by = (select auth.uid()) and (select app.is_member(company_id))));

-- Runs whose rows failed validation may mention other properties: restrict to
-- ingestion managers (and the requester) until reprocessed.
update public.import_runs r set property_ids = '{}'
 where cardinality(r.property_ids) > 0
   and exists (select 1 from public.import_validation_issues i
               where i.import_run_id = r.id and i.severity = 'error' and i.row_number is not null);

-- =============================================================================
-- R1-05 Owners see only publication outcomes, not internal review history
-- =============================================================================
drop policy publication_events_read on public.publication_events;
create policy publication_events_read on public.publication_events for select to authenticated
  using ((entity_type = 'financial_report'
          and exists (select 1 from public.financial_reports r where r.id = publication_events.entity_id)
          and ((to_status in ('published', 'superseded'))
               or property_id = any ((select app.permitted_property_ids('financials.view_draft'))::uuid[])))
         or (entity_type = 'budget_version'
          and exists (select 1 from public.budget_versions b where b.id = publication_events.entity_id)
          and ((to_status in ('approved', 'superseded'))
               or property_id = any ((select app.permitted_property_ids('budgets.edit'))::uuid[])
               or property_id = any ((select app.permitted_property_ids('budgets.approve'))::uuid[])))
         or (entity_type = 'reporting_package' and property_id = any ((select app.permitted_property_ids('reports.edit'))::uuid[])));

-- =============================================================================
-- R1-08 Grants cannot expire in the past
-- =============================================================================
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
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'the access expiry must be in the future' using errcode = '22023';
  end if;
  if p_permissions is not null and cardinality(p_permissions) = 0 then
    raise exception 'choose at least one permission, or grant the membership''s full permissions' using errcode = '22023';
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

-- =============================================================================
-- R1-11 Owners and investors cannot be given internal-only permissions
-- =============================================================================
create or replace function app.is_internal_only_permission(p_perm text) returns boolean
language sql immutable set search_path = '' as $$
  select p_perm like 'admin.%' or p_perm in (
    'audit.view', 'ingestion.manage', 'financials.view_draft', 'financials.edit', 'financials.publish',
    'budgets.edit', 'reports.edit', 'reports.publish', 'documents.manage', 'documents.view_internal',
    'commentary.view_internal', 'commentary.edit');
$$;

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
  if p_role in ('owner', 'investor') then
    delete from public.membership_permission_overrides
     where membership_id = p_membership_id and effect = 'allow' and app.is_internal_only_permission(permission_key);
  end if;
end;
$$;
grant execute on function public.update_membership(uuid, public.membership_role, boolean, text) to authenticated;

delete from public.membership_permission_overrides o
 using public.company_memberships m
 where m.id = o.membership_id and m.role in ('owner', 'investor') and o.effect = 'allow'
   and app.is_internal_only_permission(o.permission_key);

-- =============================================================================
-- R1-12 Route tokens change only through rotate_ingestion_route_token()
-- =============================================================================
revoke insert, update on public.ingestion_source_routes from authenticated;
grant update (allowed_senders, require_spf_dkim_pass) on public.ingestion_source_routes to authenticated;

-- =============================================================================
-- R1-34 Row audits carry a whitelisted, non-financial summary; secret changes
-- are recorded as a marker (never the value)
-- =============================================================================
create or replace function app.audit_summary(p_table text, p_row jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  v_user uuid;
begin
  case p_table
    when 'property_access_grants' then
      v := jsonb_build_object('membership_id', p_row -> 'membership_id', 'property_id', p_row -> 'property_id',
                              'permissions', p_row -> 'permissions', 'expires_at', p_row -> 'expires_at', 'revoked_at', p_row -> 'revoked_at');
    when 'membership_permission_overrides' then
      v := jsonb_build_object('membership_id', p_row -> 'membership_id', 'permission', p_row -> 'permission_key', 'effect', p_row -> 'effect');
    when 'company_memberships' then
      v := jsonb_build_object('user_id', p_row -> 'user_id', 'role', p_row -> 'role', 'all_properties', p_row -> 'all_properties',
                              'status', p_row -> 'status');
    when 'ingestion_property_mappings' then
      v := jsonb_build_object('source_id', p_row -> 'source_id', 'external_code', p_row -> 'external_code', 'property_id', p_row -> 'property_id');
    when 'ingestion_source_routes' then
      v := jsonb_build_object('allowed_senders', p_row -> 'allowed_senders', 'require_spf_dkim_pass', p_row -> 'require_spf_dkim_pass');
    when 'support_access_sessions' then
      v := jsonb_build_object('user_id', p_row -> 'user_id', 'reason', p_row -> 'reason', 'ticket_ref', p_row -> 'ticket_ref',
                              'expires_at', p_row -> 'expires_at', 'ended_at', p_row -> 'ended_at');
    when 'room_inventory_history' then
      v := jsonb_build_object('effective_from', p_row -> 'effective_from', 'effective_to', p_row -> 'effective_to',
                              'room_count', p_row -> 'room_count', 'reason', p_row -> 'reason');
    when 'properties' then
      v := jsonb_build_object('code', p_row -> 'code', 'name', p_row -> 'name', 'status', p_row -> 'status');
    when 'source_account_mappings' then
      v := jsonb_build_object('source_account_code', p_row -> 'source_account_code', 'account_id', p_row -> 'account_id',
                              'property_id', p_row -> 'property_id');
    else
      v := '{}'::jsonb;
  end case;
  if p_table in ('property_access_grants', 'membership_permission_overrides') then
    select m.user_id into v_user from public.company_memberships m where m.id = (p_row ->> 'membership_id')::uuid;
    if v_user is not null then
      v := v || jsonb_build_object('user_id', v_user,
                                   'user_email', (select email from public.profiles where id = v_user));
    end if;
  elsif p_table in ('company_memberships', 'support_access_sessions') and p_row ? 'user_id' then
    v := v || jsonb_build_object('user_email', (select email from public.profiles where id = (p_row ->> 'user_id')::uuid));
  end if;
  return jsonb_strip_nulls(v);
end;
$$;
revoke execute on function app.audit_summary(text, jsonb) from authenticated;

create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_company uuid := nullif(v_row ->> 'company_id', '')::uuid;
  v_property uuid := case when v_row ? 'property_id' then nullif(v_row ->> 'property_id', '')::uuid end;
  v_id text := coalesce(v_row ->> 'id', v_row ->> 'source_id', v_row ->> 'property_id', v_row ->> 'company_id', v_row ->> 'user_id');
  v_secret text[] := array['inbound_token', 'verification_token', 'token_hash'];
  v_changes jsonb := '{}'::jsonb;
  v_secret_changed text[] := '{}';
  v_meta jsonb;
begin
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into v_changes
    from jsonb_each(to_jsonb(new)) n
    where n.key <> 'updated_at' and not (n.key = any (v_secret))
      and n.value is distinct from (to_jsonb(old) -> n.key);
    select coalesce(array_agg(n.key), '{}') into v_secret_changed
    from jsonb_each(to_jsonb(new)) n
    where n.key = any (v_secret) and n.value is distinct from (to_jsonb(old) -> n.key);
    if v_changes = '{}'::jsonb and cardinality(v_secret_changed) = 0 then
      return new;
    end if;
  end if;
  v_meta := app.audit_summary(tg_table_name, v_row);
  if tg_op = 'UPDATE' then
    v_meta := v_meta || jsonb_build_object('changes', v_changes);
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

-- Full-text-ish filter column for the audit log screen (append-only table; the
-- column is generated, so no row is ever updated).
alter table public.audit_events add column search_text text
  generated always as (lower(action || ' ' || entity_type || ' ' || coalesce(entity_id, '') || ' ' || metadata::text)) stored;

-- =============================================================================
-- R1-13 Package documents follow the viewer's document visibility; no duplicates
-- =============================================================================
delete from public.reporting_package_items a
 using public.reporting_package_items b
 where a.package_id = b.package_id and a.item_type = 'document' and b.item_type = 'document'
   and a.ref_id = b.ref_id and a.id > b.id
   and (select status from public.reporting_packages where id = a.package_id) = 'draft';

-- Historical duplicates in published packages cannot be removed (items are frozen),
-- so uniqueness is enforced for new inserts by the RPC and a trigger.
create or replace function app.package_document_unique() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.item_type = 'document' and exists (
    select 1 from public.reporting_package_items i
    where i.package_id = new.package_id and i.item_type = 'document' and i.ref_id = new.ref_id and i.id <> new.id) then
    raise exception 'this document is already in the package' using errcode = '23505';
  end if;
  return new;
end;
$$;
create trigger reporting_package_items_unique_document before insert on public.reporting_package_items
  for each row execute function app.package_document_unique();

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
    -- Documents: only those the viewer could open themselves (current visibility).
    if s ? 'documents' then
      s := jsonb_set(s, '{documents}', coalesce((
        select jsonb_agg(e)
        from jsonb_array_elements(s -> 'documents') e
        join public.documents d on d.id = (e ->> 'document_id')::uuid
        where app.can_view_document(d.company_id, d.property_id, d.visibility)
          and (d.status = 'active' or app.has_permission('documents.manage', d.company_id, d.property_id))), '[]'::jsonb));
    end if;
  end if;
  return jsonb_build_object('package', to_jsonb(pk), 'snapshot', s, 'is_preview', pk.status not in ('published', 'superseded'),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.sort_order), '[]'::jsonb)
              from public.reporting_package_items i
              where i.package_id = pk.id
                and (i.item_type <> 'document' or exists (
                  select 1 from public.documents d where d.id = i.ref_id
                    and app.can_view_document(d.company_id, d.property_id, d.visibility)))));
end;
$$;
grant execute on function public.get_reporting_package(uuid) to authenticated;

drop policy package_items_read on public.reporting_package_items;
create policy package_items_read on public.reporting_package_items for select to authenticated
  using (exists (select 1 from public.reporting_packages p where p.id = reporting_package_items.package_id)
         and (item_type <> 'document'
              or exists (select 1 from public.documents d where d.id = reporting_package_items.ref_id)));

-- =============================================================================
-- R1-14 CapEx routing: validate eligible approvers, notify only the needed
-- approver types, tell the requester the outcome
-- R1-16 Project numbers are allocated under a per-company lock
-- =============================================================================
create or replace function app.capex_eligible_approvers(p_company_id uuid, p_property_id uuid, p_type text, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.user_id), '{}'::uuid[])
  from public.company_memberships m
  where m.company_id = p_company_id and m.status = 'active'
    and (p_exclude is null or m.user_id <> p_exclude)
    and (case when m.role in ('owner', 'investor') then 'owner' else 'corporate' end) = p_type
    and app.user_has_permission(m.user_id, 'capex.approve', p_company_id, p_property_id);
$$;
revoke execute on function app.capex_eligible_approvers(uuid, uuid, text, uuid) from authenticated;

create or replace function public.create_capex_project(
  p_property_id uuid, p_title text, p_category text, p_description text, p_requested_budget numeric,
  p_target_start date default null, p_target_completion date default null, p_priority text default 'normal'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_id uuid;
  v_year integer := extract(year from now())::integer;
  v_next integer;
  v_num text;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('capex.edit', v_company, p_property_id) then
    raise exception 'permission denied: capex.edit' using errcode = '42501';
  end if;
  -- Serialize numbering per company so concurrent creates never collide.
  perform pg_advisory_xact_lock(hashtext('capex_number:' || v_company::text));
  select coalesce(max(substring(project_number from '^CPX-\d{4}-(\d+)$')::integer), 0) + 1 into v_next
    from public.capex_projects
   where company_id = v_company and project_number ~ ('^CPX-' || v_year || '-\d+$');
  v_num := format('CPX-%s-%s', v_year, lpad(v_next::text, 4, '0'));
  insert into public.capex_projects (company_id, property_id, project_number, title, category, description, requested_budget,
    target_start, target_completion, priority, created_by)
  values (v_company, p_property_id, v_num, trim(p_title), p_category, p_description, p_requested_budget,
    p_target_start, p_target_completion, coalesce(p_priority, 'normal'), auth.uid())
  returning id into v_id;
  perform app.audit(v_company, 'capex.project_created', 'capex_project', v_id::text,
                    jsonb_build_object('requested_budget', p_requested_budget), p_property_id);
  return v_id;
end;
$$;
grant execute on function public.create_capex_project(uuid, text, text, text, numeric, date, date, text) to authenticated;

create or replace function public.submit_capex_request(p_project_id uuid, p_new_total numeric, p_justification text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p public.capex_projects;
  v_type text;
  v_amount numeric;
  v_steps jsonb;
  v_step jsonb;
  v_id uuid;
  v_eligible uuid[];
  v_code text;
  v_user uuid;
begin
  select * into p from public.capex_projects where id = p_project_id for update;
  if not found or not app.has_permission('capex.edit', p.company_id, p.property_id) then
    raise exception 'permission denied: capex.edit' using errcode = '42501';
  end if;
  if exists (select 1 from public.capex_approval_requests where project_id = p.id and status = 'pending') then
    raise exception 'an approval request is already pending for this project' using errcode = '23505';
  end if;
  if p.status in ('draft', 'rejected') then
    v_type := 'initial';
    v_amount := p_new_total;
  elsif p.status in ('approved', 'in_progress', 'on_hold') then
    v_type := 'change_order';
    if p_new_total <= p.approved_budget then
      raise exception 'a change order must increase the approved budget (currently %)', p.approved_budget using errcode = '22023';
    end if;
    v_amount := p_new_total - p.approved_budget;
  else
    raise exception 'cannot request approval for a % project', p.status using errcode = '55000';
  end if;
  v_steps := app.required_capex_steps(p.company_id, p.property_id, v_amount);
  if jsonb_array_length(v_steps) = 0 then
    v_steps := '[{"approver_type": "corporate", "approvals_required": 1}]'::jsonb;
  end if;
  -- Every step must be completable by people other than the requester.
  select code into v_code from public.properties where id = p.property_id;
  for v_step in select * from jsonb_array_elements(v_steps) loop
    v_eligible := app.capex_eligible_approvers(p.company_id, p.property_id, v_step ->> 'approver_type', auth.uid());
    if cardinality(v_eligible) < (v_step ->> 'approvals_required')::integer then
      raise exception '%', case when v_step ->> 'approver_type' = 'owner'
        then format('No owner can approve CapEx requests for %s — add an owner grant with CapEx approval, or adjust the approval thresholds', v_code)
        else format('Not enough corporate approvers for %s (%s needed, excluding you) — grant CapEx approval to another user, or adjust the approval thresholds',
                    v_code, v_step ->> 'approvals_required') end
        using errcode = '22023';
    end if;
  end loop;
  insert into public.capex_approval_requests (company_id, property_id, project_id, request_type, amount, new_approved_budget,
    previous_approved_budget, justification, required_steps, requested_by)
  values (p.company_id, p.property_id, p.id, v_type, v_amount, p_new_total, p.approved_budget, p_justification, v_steps, auth.uid())
  returning id into v_id;
  perform set_config('app.capex_approval_in_progress', 'on', true);
  update public.capex_projects
     set status = case when v_type = 'initial' then 'pending_approval'::public.capex_status else status end,
         requested_budget = case when v_type = 'initial' then p_new_total else requested_budget end
   where id = p.id;
  perform set_config('app.capex_approval_in_progress', 'off', true);
  perform app.audit(p.company_id, 'capex.approval_requested', 'capex_approval_request', v_id::text,
                    jsonb_build_object('project_id', p.id, 'type', v_type, 'amount', v_amount, 'steps', v_steps), p.property_id);
  -- Notify only approvers whose type is required for this request.
  for v_step in select * from jsonb_array_elements(v_steps) loop
    foreach v_user in array app.capex_eligible_approvers(p.company_id, p.property_id, v_step ->> 'approver_type', auth.uid()) loop
      perform app.notify_user(p.company_id, v_user, p.property_id, 'capex_approval_requested',
        format('Approval requested: %s', p.title), null, '/capex/' || p.id, 'capex_project', p.id);
    end loop;
  end loop;
  return v_id;
end;
$$;
grant execute on function public.submit_capex_request(uuid, numeric, text) to authenticated;

create or replace function public.decide_capex_request(p_request_id uuid, p_decision text, p_comment text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  rq public.capex_approval_requests;
  v_type text;
  v_step jsonb;
  v_needed integer;
  v_have integer;
  v_complete boolean := true;
  v_title text;
  v_final text;
begin
  select * into rq from public.capex_approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'request not found' using errcode = '42501';
  end if;
  v_type := app.capex_approver_type(rq.company_id, rq.property_id);
  if v_type is null then
    raise exception 'permission denied: capex.approve' using errcode = '42501';
  end if;
  if rq.status <> 'pending' then
    raise exception 'this request has already been %', rq.status using errcode = '55000';
  end if;
  if rq.requested_by = auth.uid() then
    raise exception 'you cannot decide on your own request' using errcode = '42501';
  end if;
  if exists (select 1 from public.capex_approval_decisions where request_id = rq.id and decided_by = auth.uid()) then
    raise exception 'you have already recorded a decision on this request' using errcode = '23505';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;
  select s into v_step from jsonb_array_elements(rq.required_steps) s where s ->> 'approver_type' = v_type;
  if v_step is null then
    raise exception '%', case when v_type = 'owner' then 'An owner approval is not required for this request'
                              else 'A corporate approval is not required for this request' end using errcode = '42501';
  end if;
  if (select count(*) from public.capex_approval_decisions where request_id = rq.id and approver_type = v_type and decision = 'approved')
     >= (v_step ->> 'approvals_required')::integer then
    raise exception 'the % approval step is already complete', v_type using errcode = '55000';
  end if;
  if p_decision = 'rejected' and coalesce(trim(p_comment), '') = '' then
    raise exception 'a comment is required when rejecting' using errcode = '22023';
  end if;

  insert into public.capex_approval_decisions (company_id, request_id, approver_type, decision, comment, decided_by)
  values (rq.company_id, rq.id, v_type, p_decision, p_comment, auth.uid());

  perform set_config('app.capex_approval_in_progress', 'on', true);
  if p_decision = 'rejected' then
    update public.capex_approval_requests set status = 'rejected', decided_at = now() where id = rq.id;
    update public.capex_projects set status = case when rq.request_type = 'initial' then 'rejected'::public.capex_status else status end
     where id = rq.project_id;
  else
    for v_step in select * from jsonb_array_elements(rq.required_steps) loop
      v_needed := (v_step ->> 'approvals_required')::integer;
      select count(*) into v_have from public.capex_approval_decisions
       where request_id = rq.id and approver_type = v_step ->> 'approver_type' and decision = 'approved';
      if v_have < v_needed then v_complete := false; end if;
    end loop;
    if v_complete then
      update public.capex_approval_requests set status = 'approved', decided_at = now() where id = rq.id;
      update public.capex_projects
         set approved_budget = rq.new_approved_budget,
             status = case when status in ('pending_approval', 'draft', 'rejected') then 'approved'::public.capex_status else status end
       where id = rq.project_id;
    end if;
  end if;
  perform set_config('app.capex_approval_in_progress', 'off', true);

  perform app.audit(rq.company_id, 'capex.decision', 'capex_approval_request', rq.id::text,
                    jsonb_build_object('decision', p_decision, 'approver_type', v_type, 'project_id', rq.project_id), rq.property_id);
  v_final := (select status from public.capex_approval_requests where id = rq.id);
  if v_final in ('approved', 'rejected') and app.user_has_permission(rq.requested_by, 'capex.view', rq.company_id, rq.property_id) then
    select title into v_title from public.capex_projects where id = rq.project_id;
    perform app.notify_user(rq.company_id, rq.requested_by, rq.property_id, 'capex_request_decided',
      case when v_final = 'approved' then format('CapEx request approved: %s', v_title)
           else format('CapEx request rejected: %s', v_title) end,
      case when v_final = 'rejected' then format('Reason: %s', p_comment) end,
      '/capex/' || rq.project_id, 'capex_project', rq.project_id);
  end if;
  return v_final;
end;
$$;
grant execute on function public.decide_capex_request(uuid, text, text) to authenticated;

-- =============================================================================
-- R1-19 No statements or owner packages for future months
-- =============================================================================
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
  if p_period_month is null or p_period_month <> date_trunc('month', p_period_month)::date then
    raise exception 'choose a month (the first day of the period)' using errcode = '22023';
  end if;
  if p_period_month > date_trunc('month', now())::date then
    raise exception 'statements cannot be created for a future month' using errcode = '22023';
  end if;
  if exists (select 1 from public.financial_reports where property_id = p_property_id and period_month = p_period_month) then
    raise exception 'a report already exists for this period; create a revision instead' using errcode = '23505';
  end if;
  insert into public.financial_reports (company_id, property_id, period_month, title, created_by)
  values (v_company, p_property_id, p_period_month,
          coalesce(nullif(trim(p_title), ''), format('P&L — %s', to_char(p_period_month, 'FMMonth YYYY'))), auth.uid())
  returning id into v_id;
  perform app.publication_event(v_company, p_property_id, 'financial_report', v_id, 1, null, 'draft', 'Created');
  return v_id;
end;
$$;
grant execute on function public.create_financial_report(uuid, date, text) to authenticated;

create or replace function public.create_reporting_package(p_property_id uuid, p_period_month date, p_title text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_id uuid;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('reports.edit', v_company, p_property_id) then
    raise exception 'permission denied: reports.edit' using errcode = '42501';
  end if;
  if p_period_month is null or p_period_month <> date_trunc('month', p_period_month)::date then
    raise exception 'choose a month (the first day of the period)' using errcode = '22023';
  end if;
  if p_period_month > date_trunc('month', now())::date then
    raise exception 'owner packages cannot be created for a future month' using errcode = '22023';
  end if;
  if exists (select 1 from public.reporting_packages where property_id = p_property_id and period_month = p_period_month) then
    raise exception 'a package already exists for this period; create a revision instead' using errcode = '23505';
  end if;
  insert into public.reporting_packages (company_id, property_id, period_month, title, created_by)
  values (v_company, p_property_id, p_period_month,
          coalesce(nullif(trim(p_title), ''), format('Owner report — %s', to_char(p_period_month, 'FMMonth YYYY'))), auth.uid())
  returning id into v_id;
  insert into public.reporting_package_items (company_id, package_id, item_type, title, sort_order) values
    (v_company, v_id, 'performance_summary', 'Performance summary', 10),
    (v_company, v_id, 'budget_variance', 'Budget variances', 20),
    (v_company, v_id, 'commentary', 'Management commentary', 40),
    (v_company, v_id, 'capex_update', 'CapEx update', 50);
  insert into public.reporting_package_items (company_id, package_id, item_type, ref_id, title, sort_order)
  select v_company, v_id, 'financial_report', r.id, r.title, 30 from public.financial_reports r
   where r.property_id = p_property_id and r.period_month = p_period_month and r.status = 'published';
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
  values (v_company, p_property_id, 'reporting_package', v_id, 1, null, 'draft', 'Created', auth.uid());
  return v_id;
end;
$$;
grant execute on function public.create_reporting_package(uuid, date, text) to authenticated;

create or replace function app.reject_future_package_publish() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' and new.period_month > date_trunc('month', now())::date then
    raise exception 'owner packages for a future month cannot be published' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger reporting_packages_no_future_publish before update on public.reporting_packages
  for each row execute function app.reject_future_package_publish();

-- =============================================================================
-- R1-22 Setup checklist counts (non-sensitive; works before 2FA)
-- =============================================================================
create or replace function public.company_setup_status(p_company_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.company_memberships m
                 where m.company_id = p_company_id and m.user_id = auth.uid() and m.status = 'active'
                   and (app.membership_allows_user(m.id, auth.uid(), 'admin.users', 'any')
                        or app.membership_allows_user(m.id, auth.uid(), 'admin.company', 'any'))) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'rooms', (select count(*) from public.room_inventory_history where company_id = p_company_id),
    'other_members', (select count(*) from public.company_memberships where company_id = p_company_id and status = 'active' and user_id <> auth.uid()),
    'pending_invitations', (select count(*) from public.invitations where company_id = p_company_id
                              and accepted_at is null and revoked_at is null and expires_at > now()),
    'sources', (select count(*) from public.ingestion_sources where company_id = p_company_id),
    'import_runs', (select count(*) from public.import_runs where company_id = p_company_id));
end;
$$;
grant execute on function public.company_setup_status(uuid) to authenticated;

-- =============================================================================
-- R1-23 Create a property and its opening inventory atomically
-- R1-50 Opened-on cannot be after data already loaded, nor far in the future
-- =============================================================================
drop function public.create_property(uuid, text, text, text, public.property_status, text, text, text, date, char, char);
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
    raise exception 'rooms must be a whole number of at least 1' using errcode = '22023';
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

create or replace function app.property_opened_on_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_first date;
begin
  if new.opened_on is null or (tg_op = 'UPDATE' and new.opened_on is not distinct from old.opened_on) then
    return new;
  end if;
  if new.status = 'active' and new.opened_on > current_date + interval '2 years' then
    raise exception 'an active property cannot open more than two years from now' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then
    select min(business_date) into v_first from public.daily_performance where property_id = new.id;
    if v_first is not null and new.opened_on > v_first then
      raise exception 'daily data exists from %; the opening date must be on or before it', v_first using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger properties_opened_on_guard before insert or update on public.properties
  for each row execute function app.property_opened_on_guard();

-- =============================================================================
-- R1-27 Budget approval notifications link to the budget version
-- =============================================================================
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
    format('FY%s budget approved', v.fiscal_year), v.name, '/financials/budgets/' || v.id, 'budget_version', v.id, auth.uid());
end;
$$;
grant execute on function public.approve_budget_version(uuid, text) to authenticated;

update public.notifications
   set link_path = case when entity_type = 'budget_version' and entity_id is not null
                        then '/financials/budgets/' || entity_id else '/financials?tab=budgets' end
 where link_path like '/budgets?property=%';

-- =============================================================================
-- R1-28 Account mappings need a source code
-- =============================================================================
delete from public.source_account_mappings where length(trim(source_account_code)) = 0;
update public.source_account_mappings set source_account_code = trim(source_account_code)
 where source_account_code <> trim(source_account_code);
alter table public.source_account_mappings add constraint source_account_mappings_code_present
  check (length(trim(source_account_code)) > 0);

-- =============================================================================
-- R1-31 Property-code mappings are case-insensitive and normalised
-- =============================================================================
delete from public.ingestion_property_mappings a
 using public.ingestion_property_mappings b
 where a.source_id = b.source_id and upper(trim(a.external_code)) = upper(trim(b.external_code))
   and (a.created_at, a.id) > (b.created_at, b.id);
update public.ingestion_property_mappings set external_code = upper(trim(external_code))
 where external_code <> upper(trim(external_code));

create or replace function app.normalise_mapping_code() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.external_code := upper(trim(new.external_code));
  if new.external_code = '' then
    raise exception 'external code is required' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger ingestion_property_mappings_normalise before insert or update on public.ingestion_property_mappings
  for each row execute function app.normalise_mapping_code();
create unique index ingestion_property_mappings_code_ci on public.ingestion_property_mappings (company_id, source_id, upper(external_code));
