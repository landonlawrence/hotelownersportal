-- =============================================================================
-- Milestone 1 — Foundation
-- Companies, branding, domains, modules, profiles, memberships, permissions,
-- properties, room inventory, reporting config, ownership, access grants,
-- support access sessions, invitations and audit events.
--
-- Security model summary (see docs/SECURITY.md):
--   * Every table in `public` has RLS enabled.
--   * Permission logic lives in the non-exposed `app` schema as SECURITY DEFINER
--     functions with an empty search_path.
--   * Property-scoped rows reference properties(id, company_id) so a row can
--     never point at another company's property.
-- =============================================================================

create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Nothing created by migrations is reachable by client roles unless granted explicitly.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

create schema if not exists app;
alter default privileges in schema app revoke all on functions from public, anon;
alter default privileges in schema app grant execute on functions to authenticated, service_role;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------
create type public.membership_role as enum (
  'company_admin', 'corporate_finance', 'corporate_operations', 'property_manager', 'owner', 'investor'
);
create type public.membership_status as enum ('active', 'revoked');
create type public.company_status as enum ('active', 'suspended');
create type public.property_status as enum ('onboarding', 'active', 'sold', 'archived');
create type public.portal_module as enum (
  'performance', 'financials', 'capex', 'documents', 'reports', 'ingestion', 'admin'
);

-- -----------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function app.is_valid_timezone(tz text) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  perform now() at time zone tz;
  return true;
exception when others then
  return false;
end;
$$;

-- -----------------------------------------------------------------------------
-- Platform
-- -----------------------------------------------------------------------------
create table public.platform_settings (
  id boolean primary key default true check (id),
  cross_company_rollups_enabled boolean not null default false,
  max_support_session_hours integer not null default 8 check (max_support_session_hours between 1 and 24),
  updated_at timestamptz not null default now()
);
insert into public.platform_settings default values;

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'full_name', null))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- -----------------------------------------------------------------------------
-- Companies, branding, domains, modules
-- -----------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (length(trim(name)) between 2 and 200),
  legal_name text,
  status public.company_status not null default 'active',
  default_currency char(3) not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  require_mfa_for_privileged boolean not null default true,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger companies_touch before update on public.companies
  for each row execute function app.touch_updated_at();

create table public.company_branding (
  company_id uuid primary key references public.companies (id) on delete cascade,
  portal_name text not null check (length(trim(portal_name)) between 2 and 120),
  logo_url text check (logo_url is null or logo_url ~ '^(https://|/)'),
  logo_mark_url text check (logo_mark_url is null or logo_mark_url ~ '^(https://|/)'),
  favicon_url text check (favicon_url is null or favicon_url ~ '^(https://|/)'),
  primary_color text not null default '#1f3a5f' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color text not null default '#c8a24a' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  surface_color text not null default '#f6f7f9' check (surface_color ~ '^#[0-9a-fA-F]{6}$'),
  login_headline text,
  login_message text,
  support_email text check (support_email is null or support_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  email_from_name text,
  report_footer text,
  updated_at timestamptz not null default now()
);
create trigger company_branding_touch before update on public.company_branding
  for each row execute function app.touch_updated_at();

create table public.company_domains (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  hostname text not null unique check (hostname = lower(hostname) and hostname ~ '^[a-z0-9.-]+(:[0-9]+)?$'),
  is_primary boolean not null default false,
  verification_status text not null default 'pending' check (verification_status in ('pending', 'verified', 'failed')),
  verification_token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);
create unique index company_domains_one_primary on public.company_domains (company_id) where is_primary;

create table public.company_modules (
  company_id uuid not null references public.companies (id) on delete cascade,
  module public.portal_module not null,
  enabled boolean not null default true,
  primary key (company_id, module)
);

-- -----------------------------------------------------------------------------
-- Permission catalogue
-- -----------------------------------------------------------------------------
create table public.permissions (
  key text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  module public.portal_module not null,
  description text not null,
  privileged boolean not null default false
);

insert into public.permissions (key, module, description, privileged) values
  ('performance.view',            'performance', 'View daily operating performance and KPIs', false),
  ('financials.view',             'financials',  'View published financial statements', false),
  ('financials.view_draft',       'financials',  'View draft / in-review financial statements', true),
  ('financials.edit',             'financials',  'Import and edit financial actuals and mappings', true),
  ('financials.publish',          'financials',  'Review and publish financial statements', true),
  ('budgets.view',                'financials',  'View approved budgets and variances', false),
  ('budgets.edit',                'financials',  'Create and edit draft budgets', true),
  ('budgets.approve',             'financials',  'Approve budget versions', true),
  ('documents.view',              'documents',   'View general documents', false),
  ('documents.view_owner',        'documents',   'View owner-restricted documents', false),
  ('documents.view_internal',     'documents',   'View internal management documents', false),
  ('documents.view_confidential', 'documents',   'View confidential documents (bank, loan, tax)', false),
  ('documents.upload',            'documents',   'Upload documents', false),
  ('documents.manage',            'documents',   'Manage documents, visibility and quarantine', true),
  ('capex.view',                  'capex',       'View CapEx projects', false),
  ('capex.edit',                  'capex',       'Create and update CapEx projects and spending', false),
  ('capex.approve',               'capex',       'Approve or reject CapEx requests', true),
  ('reports.view',                'reports',     'View published owner reporting packages', false),
  ('reports.edit',                'reports',     'Prepare reporting packages', true),
  ('reports.publish',             'reports',     'Publish reporting packages', true),
  ('commentary.view',             'reports',     'View owner-facing management commentary', false),
  ('commentary.view_internal',    'reports',     'View internal management notes', false),
  ('commentary.edit',             'reports',     'Write management commentary', false),
  ('ingestion.view',              'ingestion',   'View import runs and validation issues', false),
  ('ingestion.manage',            'ingestion',   'Manage ingestion sources, mappings and retries', true),
  ('ownership.view',              'admin',       'View ownership groups and percentages', false),
  ('admin.users',                 'admin',       'Invite users, manage memberships and access', true),
  ('admin.company',               'admin',       'Manage company settings, branding and modules', true),
  ('audit.view',                  'admin',       'View audit events', true);

create table public.role_permission_defaults (
  role public.membership_role not null,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role, permission_key)
);

insert into public.role_permission_defaults (role, permission_key)
select 'company_admin'::public.membership_role, key from public.permissions
union all
select 'corporate_finance', unnest(array[
  'performance.view', 'financials.view', 'financials.view_draft', 'financials.edit', 'financials.publish',
  'budgets.view', 'budgets.edit', 'budgets.approve', 'documents.view', 'documents.view_owner',
  'documents.view_internal', 'documents.view_confidential', 'documents.upload', 'documents.manage',
  'capex.view', 'capex.edit', 'capex.approve', 'reports.view', 'reports.edit', 'reports.publish',
  'commentary.view', 'commentary.view_internal', 'commentary.edit', 'ingestion.view', 'ingestion.manage',
  'ownership.view'])
union all
select 'corporate_operations', unnest(array[
  'performance.view', 'financials.view', 'financials.view_draft', 'budgets.view', 'documents.view',
  'documents.view_owner', 'documents.view_internal', 'documents.upload', 'capex.view', 'capex.edit',
  'capex.approve', 'reports.view', 'reports.edit', 'commentary.view', 'commentary.view_internal',
  'commentary.edit', 'ingestion.view'])
union all
select 'property_manager', unnest(array[
  'performance.view', 'financials.view', 'budgets.view', 'documents.view', 'documents.view_owner',
  'documents.view_internal', 'documents.upload', 'capex.view', 'capex.edit', 'reports.view',
  'commentary.view', 'commentary.view_internal', 'commentary.edit', 'ingestion.view'])
union all
select 'owner', unnest(array[
  'performance.view', 'financials.view', 'budgets.view', 'documents.view', 'documents.view_owner',
  'capex.view', 'capex.approve', 'reports.view', 'commentary.view', 'ownership.view'])
union all
select 'investor', unnest(array[
  'performance.view', 'financials.view', 'documents.view', 'reports.view', 'commentary.view']);

-- -----------------------------------------------------------------------------
-- Memberships
-- -----------------------------------------------------------------------------
create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null,
  status public.membership_status not null default 'active',
  all_properties boolean not null default false,
  title text,
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  revoke_reason text,
  unique (company_id, user_id),
  unique (id, company_id),
  check ((status = 'revoked') = (revoked_at is not null)),
  -- Owners and investors never receive implicit company-wide property access.
  check (not (all_properties and role in ('owner', 'investor')))
);
create index company_memberships_user on public.company_memberships (user_id) where status = 'active';
create trigger company_memberships_touch before update on public.company_memberships
  for each row execute function app.touch_updated_at();

create table public.membership_permission_overrides (
  membership_id uuid not null,
  company_id uuid not null,
  permission_key text not null references public.permissions (key) on delete cascade,
  effect text not null check (effect in ('allow', 'deny')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (membership_id, permission_key),
  foreign key (membership_id, company_id) references public.company_memberships (id, company_id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- Properties
-- -----------------------------------------------------------------------------
create table public.properties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name text not null check (length(trim(name)) between 2 and 200),
  brand text,
  address_line1 text,
  city text,
  region text,
  country char(2) not null default 'US',
  timezone text not null check (app.is_valid_timezone(timezone)),
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  status public.property_status not null default 'active',
  opened_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code),
  unique (id, company_id)
);
create trigger properties_touch before update on public.properties
  for each row execute function app.touch_updated_at();

create table public.room_inventory_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  effective_from date not null,
  effective_to date,
  room_count integer not null check (room_count > 0 and room_count < 100000),
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  check (effective_to is null or effective_to > effective_from),
  exclude using gist (
    property_id with =,
    daterange(effective_from, effective_to, '[)') with &&
  )
);

create table public.property_reporting_config (
  property_id uuid primary key,
  company_id uuid not null,
  -- Out-of-order rooms: 'exclude' removes them from available room nights (default, USALI style).
  ooo_treatment text not null default 'exclude' check (ooo_treatment in ('exclude', 'include')),
  -- Complimentary rooms: 'exclude' removes them from rooms sold so they do not dilute ADR.
  comp_treatment text not null default 'exclude' check (comp_treatment in ('exclude', 'include')),
  fiscal_year_start_month smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  expects_daily_report boolean not null default true,
  daily_report_deadline_local time not null default '11:00',
  updated_at timestamptz not null default now(),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);

create or replace function app.create_property_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.property_reporting_config (property_id, company_id)
  values (new.id, new.company_id) on conflict do nothing;
  return new;
end;
$$;
create trigger properties_defaults after insert on public.properties
  for each row execute function app.create_property_defaults();

-- -----------------------------------------------------------------------------
-- Ownership (legal) — deliberately separate from software access
-- -----------------------------------------------------------------------------
create table public.ownership_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  entity_type text,
  notes text,
  created_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, name)
);

create table public.ownership_group_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  ownership_group_id uuid not null,
  member_name text not null,
  member_type text not null default 'investor' check (member_type in ('owner', 'investor', 'general_partner', 'limited_partner', 'lender', 'other')),
  interest_pct numeric(7, 4) check (interest_pct is null or (interest_pct > 0 and interest_pct <= 100)),
  -- Optional link to a portal user. This does NOT grant access to anything.
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (ownership_group_id, company_id) references public.ownership_groups (id, company_id) on delete cascade
);

create table public.property_ownerships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  ownership_group_id uuid not null,
  ownership_pct numeric(7, 4) not null check (ownership_pct > 0 and ownership_pct <= 100),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  foreign key (ownership_group_id, company_id) references public.ownership_groups (id, company_id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- Property access grants (software access)
-- -----------------------------------------------------------------------------
create table public.property_access_grants (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  membership_id uuid not null,
  property_id uuid not null,
  -- NULL = membership permissions apply; otherwise the intersection with this list.
  permissions text[],
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  foreign key (membership_id, company_id) references public.company_memberships (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create unique index property_access_grants_active
  on public.property_access_grants (membership_id, property_id) where revoked_at is null;
create index property_access_grants_property on public.property_access_grants (property_id);

create or replace function app.validate_grant_permissions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.permissions is not null and exists (
    select 1 from unnest(new.permissions) p where p not in (select key from public.permissions)
  ) then
    raise exception 'unknown permission in grant' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger property_access_grants_validate before insert or update on public.property_access_grants
  for each row execute function app.validate_grant_permissions();

-- -----------------------------------------------------------------------------
-- Support access sessions (deliberate, time boxed, audited)
-- -----------------------------------------------------------------------------
create table public.support_access_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null check (length(trim(reason)) >= 10),
  ticket_ref text not null check (length(trim(ticket_ref)) >= 2),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > starts_at and expires_at <= starts_at + interval '24 hours')
);
create index support_access_sessions_user on public.support_access_sessions (user_id, company_id);

-- Permissions a support session may exercise: read-only and never confidential.
create table public.support_session_permissions (
  permission_key text primary key references public.permissions (key)
);
insert into public.support_session_permissions values
  ('performance.view'), ('financials.view'), ('financials.view_draft'), ('budgets.view'),
  ('documents.view'), ('capex.view'), ('reports.view'), ('commentary.view'), ('ingestion.view');

-- -----------------------------------------------------------------------------
-- Invitations
-- -----------------------------------------------------------------------------
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null check (email = lower(email) and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.membership_role not null,
  all_properties boolean not null default false,
  property_ids uuid[] not null default '{}',
  token_hash text not null unique,
  invited_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  revoked_at timestamptz,
  check (not (all_properties and role in ('owner', 'investor')))
);
create index invitations_company on public.invitations (company_id);

-- -----------------------------------------------------------------------------
-- Audit events (append only)
-- -----------------------------------------------------------------------------
create table public.audit_events (
  id bigint generated always as identity primary key,
  company_id uuid references public.companies (id) on delete set null,
  property_id uuid,
  actor_user_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'system', 'support', 'platform_admin')),
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_company on public.audit_events (company_id, created_at desc);
create index audit_events_entity on public.audit_events (entity_type, entity_id);

create or replace function app.prevent_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function app.prevent_mutation();

-- =============================================================================
-- Permission engine
-- =============================================================================

create or replace function app.current_aal() returns text
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1');
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- Does an active membership (role + overrides) include a permission, honouring
-- company modules, company status and MFA requirements? Property access is NOT
-- evaluated here. p_aal = 'any' skips the MFA check (used for notifications and
-- background jobs that act for a user whose request was already verified).
create or replace function app.membership_allows_user(p_membership_id uuid, p_user uuid, p_perm text, p_aal text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.company_memberships m
    join public.companies c on c.id = m.company_id and c.status = 'active'
    join public.permissions p on p.key = p_perm
    where m.id = p_membership_id
      and m.status = 'active'
      and m.user_id = p_user
      -- module enabled (admin module can never be disabled)
      and (p.module = 'admin' or coalesce((
            select cm.enabled from public.company_modules cm
            where cm.company_id = m.company_id and cm.module = p.module), true))
      -- MFA for privileged permissions
      and (not p.privileged or not c.require_mfa_for_privileged or p_aal in ('aal2', 'any'))
      -- role default or explicit allow, and no explicit deny
      and (
        exists (select 1 from public.role_permission_defaults d where d.role = m.role and d.permission_key = p_perm)
        or exists (select 1 from public.membership_permission_overrides o
                   where o.membership_id = m.id and o.permission_key = p_perm and o.effect = 'allow')
      )
      and not exists (select 1 from public.membership_permission_overrides o
                      where o.membership_id = m.id and o.permission_key = p_perm and o.effect = 'deny')
  );
$$;

create or replace function app.membership_allows(p_membership_id uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.membership_allows_user(p_membership_id, auth.uid(), p_perm, app.current_aal());
$$;

-- Property ids on which a user holds a permission through memberships + grants.
create or replace function app.user_property_ids(p_user uuid, p_perm text, p_aal text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct p.id), '{}'::uuid[])
  from public.company_memberships m
  join public.properties p on p.company_id = m.company_id
  where m.user_id = p_user
    and m.status = 'active'
    and app.membership_allows_user(m.id, p_user, p_perm, p_aal)
    and (
      m.all_properties
      or exists (
        select 1 from public.property_access_grants g
        where g.membership_id = m.id
          and g.property_id = p.id
          and g.revoked_at is null
          and (g.expires_at is null or g.expires_at > now())
          and (g.permissions is null or p_perm = any (g.permissions))
      )
    );
$$;

-- Background-job / notification check for a specific user (MFA not applicable).
create or replace function app.user_has_permission(p_user uuid, p_perm text, p_company_id uuid, p_property_id uuid default null)
returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_user is null or p_company_id is null then false
    when p_property_id is null then exists (
      select 1 from public.company_memberships m
      where m.user_id = p_user and m.company_id = p_company_id and m.status = 'active'
        and app.membership_allows_user(m.id, p_user, p_perm, 'any'))
    else exists (select 1 from public.properties p where p.id = p_property_id and p.company_id = p_company_id)
         and p_property_id = any (app.user_property_ids(p_user, p_perm, 'any'))
  end;
$$;

-- Active support session for the current user in a company?
create or replace function app.support_session_allows(p_company_id uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
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

-- All property ids (across companies) on which the current user holds p_perm.
create or replace function app.permitted_property_ids(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct pid), '{}'::uuid[]) from (
    select unnest(app.user_property_ids(auth.uid(), p_perm, app.current_aal())) as pid
    union
    select p.id
    from public.support_access_sessions s
    join public.properties p on p.company_id = s.company_id
    where s.user_id = auth.uid() and app.support_session_allows(s.company_id, p_perm)
  ) x;
$$;

-- Company ids on which the current user holds p_perm at company level.
create or replace function app.permitted_company_ids(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct cid), '{}'::uuid[]) from (
    select m.company_id as cid from public.company_memberships m
    where m.user_id = auth.uid() and m.status = 'active' and app.membership_allows(m.id, p_perm)
    union
    select s.company_id from public.support_access_sessions s
    where s.user_id = auth.uid() and app.support_session_allows(s.company_id, p_perm)
  ) x;
$$;

-- Scalar check. With a property id, property access is required as well.
create or replace function app.has_permission(p_perm text, p_company_id uuid, p_property_id uuid default null)
returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null or p_company_id is null then false
    when p_property_id is null then p_company_id = any (app.permitted_company_ids(p_perm))
    else exists (select 1 from public.properties p where p.id = p_property_id and p.company_id = p_company_id)
         and p_property_id = any (app.permitted_property_ids(p_perm))
  end;
$$;

create or replace function app.is_member(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_memberships
                 where company_id = p_company_id and user_id = auth.uid() and status = 'active')
      or exists (select 1 from public.support_access_sessions s
                 where s.company_id = p_company_id and s.user_id = auth.uid()
                   and s.ended_at is null and now() between s.starts_at and s.expires_at);
$$;

-- Property ids visible at all (any property-scoped view permission).
create or replace function app.visible_property_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x), '{}'::uuid[]) from (
    select unnest(app.permitted_property_ids('performance.view')) x
    union select unnest(app.permitted_property_ids('financials.view'))
    union select unnest(app.permitted_property_ids('financials.view_draft'))
    union select unnest(app.permitted_property_ids('documents.view'))
    union select unnest(app.permitted_property_ids('capex.view'))
    union select unnest(app.permitted_property_ids('reports.view'))
    union select unnest(app.permitted_property_ids('admin.users'))
  ) s;
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
  insert into public.audit_events (company_id, property_id, actor_user_id, actor_kind, action, entity_type, entity_id, metadata)
  values (p_company_id, p_property_id, auth.uid(), v_kind, p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- Generic audit trigger for configuration tables.
create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_company uuid := nullif(v_row ->> 'company_id', '')::uuid;
  v_property uuid := case when v_row ? 'property_id' then nullif(v_row ->> 'property_id', '')::uuid end;
  v_id text := coalesce(v_row ->> 'id', v_row ->> 'property_id', v_row ->> 'company_id', v_row ->> 'user_id');
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into v_changes
    from jsonb_each(to_jsonb(new)) n
    where n.key not in ('updated_at') and n.value is distinct from (to_jsonb(old) -> n.key);
    if v_changes = '{}'::jsonb then
      return new;
    end if;
  end if;
  perform app.audit(v_company, lower(tg_op), tg_table_name, v_id,
                    case when tg_op = 'UPDATE' then jsonb_build_object('changes', v_changes) else '{}'::jsonb end,
                    v_property);
  return coalesce(new, old);
end;
$$;

create trigger audit_companies after insert or update or delete on public.companies
  for each row execute function app.audit_row_change();
create trigger audit_company_branding after insert or update on public.company_branding
  for each row execute function app.audit_row_change();
create trigger audit_company_domains after insert or update or delete on public.company_domains
  for each row execute function app.audit_row_change();
create trigger audit_company_modules after insert or update or delete on public.company_modules
  for each row execute function app.audit_row_change();
create trigger audit_memberships after insert or update or delete on public.company_memberships
  for each row execute function app.audit_row_change();
create trigger audit_overrides after insert or update or delete on public.membership_permission_overrides
  for each row execute function app.audit_row_change();
create trigger audit_grants after insert or update or delete on public.property_access_grants
  for each row execute function app.audit_row_change();
create trigger audit_properties after insert or update or delete on public.properties
  for each row execute function app.audit_row_change();
create trigger audit_property_config after update on public.property_reporting_config
  for each row execute function app.audit_row_change();
create trigger audit_room_inventory after insert or update or delete on public.room_inventory_history
  for each row execute function app.audit_row_change();
create trigger audit_support_sessions after insert or update on public.support_access_sessions
  for each row execute function app.audit_row_change();
create trigger audit_platform_admins after insert or delete on public.platform_admins
  for each row execute function app.audit_row_change();

-- =============================================================================
-- Row level security
-- =============================================================================
alter table public.platform_settings enable row level security;
alter table public.platform_admins enable row level security;
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.company_branding enable row level security;
alter table public.company_domains enable row level security;
alter table public.company_modules enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permission_defaults enable row level security;
alter table public.company_memberships enable row level security;
alter table public.membership_permission_overrides enable row level security;
alter table public.properties enable row level security;
alter table public.room_inventory_history enable row level security;
alter table public.property_reporting_config enable row level security;
alter table public.ownership_groups enable row level security;
alter table public.ownership_group_members enable row level security;
alter table public.property_ownerships enable row level security;
alter table public.property_access_grants enable row level security;
alter table public.support_access_sessions enable row level security;
alter table public.support_session_permissions enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_events enable row level security;

-- Start from zero privileges; grant only what policies are written for.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon;
revoke all on all functions in schema app from public;
grant execute on all functions in schema app to authenticated, service_role;
-- Functions that evaluate permissions for an arbitrary user are not callable by clients.
revoke execute on function app.membership_allows_user(uuid, uuid, text, text) from authenticated;
revoke execute on function app.user_property_ids(uuid, text, text) from authenticated;
revoke execute on function app.user_has_permission(uuid, text, uuid, uuid) from authenticated;

grant select on public.platform_settings, public.permissions, public.role_permission_defaults,
  public.support_session_permissions to authenticated;

create policy platform_settings_read on public.platform_settings for select to authenticated using (true);
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_defaults_read on public.role_permission_defaults for select to authenticated using (true);
create policy support_perms_read on public.support_session_permissions for select to authenticated using (true);

grant select on public.platform_admins to authenticated;
create policy platform_admins_read on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_platform_admin()));

-- Profiles: self, or members of a company the viewer administers.
grant select, update (full_name) on public.profiles to authenticated;
create policy profiles_self on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_admin on public.profiles for select to authenticated
  using (exists (
    select 1 from public.company_memberships m
    where m.user_id = profiles.id
      and m.company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[])
  ) or (select app.is_platform_admin()));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Companies: members see their companies; platform admins manage all.
grant select, insert, update on public.companies to authenticated;
create policy companies_member_read on public.companies for select to authenticated
  using ((select app.is_member(id)) or (select app.is_platform_admin()));
create policy companies_platform_insert on public.companies for insert to authenticated
  with check ((select app.is_platform_admin()));
create policy companies_admin_update on public.companies for update to authenticated
  using (id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin()))
  with check (id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin()));
-- Company admins may not flip platform-controlled columns.
revoke update on public.companies from authenticated;
grant update (name, legal_name, default_currency, require_mfa_for_privileged) on public.companies to authenticated;

grant select, insert, update on public.company_branding to authenticated;
create policy branding_read on public.company_branding for select to authenticated
  using ((select app.is_member(company_id)) or (select app.is_platform_admin()));
create policy branding_write on public.company_branding for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin()))
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin()));

-- Domains: only platform admins create/verify; company admins can read theirs.
grant select, insert, update, delete on public.company_domains to authenticated;
create policy domains_read on public.company_domains for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]) or (select app.is_platform_admin()));
create policy domains_platform_write on public.company_domains for all to authenticated
  using ((select app.is_platform_admin())) with check ((select app.is_platform_admin()));

grant select, insert, update on public.company_modules to authenticated;
create policy modules_read on public.company_modules for select to authenticated
  using ((select app.is_member(company_id)) or (select app.is_platform_admin()));
create policy modules_platform_write on public.company_modules for all to authenticated
  using ((select app.is_platform_admin())) with check ((select app.is_platform_admin()));

-- Memberships: own rows, or company admins.
grant select on public.company_memberships to authenticated;
create policy memberships_self on public.company_memberships for select to authenticated
  using (user_id = (select auth.uid()));
create policy memberships_admin on public.company_memberships for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));

grant select on public.membership_permission_overrides to authenticated;
create policy overrides_read on public.membership_permission_overrides for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[])
         or membership_id in (select id from public.company_memberships where user_id = (select auth.uid())));

-- Properties: visible when the user has any property-scoped permission on it.
grant select, insert, update on public.properties to authenticated;
create policy properties_read on public.properties for select to authenticated
  using (id = any ((select app.visible_property_ids())::uuid[]));
create policy properties_admin_insert on public.properties for insert to authenticated
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]));
create policy properties_admin_update on public.properties for update to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]));

grant select, insert, update on public.room_inventory_history to authenticated;
create policy room_inventory_read on public.room_inventory_history for select to authenticated
  using (property_id = any ((select app.visible_property_ids())::uuid[]));
create policy room_inventory_write on public.room_inventory_history for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]));

grant select, update on public.property_reporting_config to authenticated;
create policy reporting_config_read on public.property_reporting_config for select to authenticated
  using (property_id = any ((select app.visible_property_ids())::uuid[]));
create policy reporting_config_write on public.property_reporting_config for update to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]));

-- Ownership
grant select, insert, update, delete on public.ownership_groups, public.ownership_group_members,
  public.property_ownerships to authenticated;
create policy ownership_groups_read on public.ownership_groups for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[])
         or exists (select 1 from public.property_ownerships po
                    where po.ownership_group_id = ownership_groups.id
                      and po.property_id = any ((select app.permitted_property_ids('ownership.view'))::uuid[])));
create policy ownership_groups_write on public.ownership_groups for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));
create policy ownership_members_read on public.ownership_group_members for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));
create policy ownership_members_write on public.ownership_group_members for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));
create policy property_ownerships_read on public.property_ownerships for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[])
         or property_id = any ((select app.permitted_property_ids('ownership.view'))::uuid[]));
create policy property_ownerships_write on public.property_ownerships for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));

-- Access grants: read own + admins. Writes only through RPCs.
grant select on public.property_access_grants to authenticated;
create policy grants_self on public.property_access_grants for select to authenticated
  using (membership_id in (select id from public.company_memberships where user_id = (select auth.uid())));
create policy grants_admin on public.property_access_grants for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));

grant select on public.support_access_sessions to authenticated;
create policy support_sessions_read on public.support_access_sessions for select to authenticated
  using (user_id = (select auth.uid())
         or (select app.is_platform_admin())
         or company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));

grant select on public.invitations to authenticated;
create policy invitations_admin_read on public.invitations for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.users'))::uuid[]));

grant select on public.audit_events to authenticated;
create policy audit_read on public.audit_events for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('audit.view'))::uuid[]) or (select app.is_platform_admin()));
