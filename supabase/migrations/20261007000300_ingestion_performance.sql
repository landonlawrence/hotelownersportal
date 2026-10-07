-- =============================================================================
-- Milestone 2 — Ingestion pipeline records and daily operating performance
-- =============================================================================

create type public.report_type as enum ('daily_performance', 'monthly_actuals', 'budget');
create type public.import_status as enum (
  'received', 'queued', 'processing', 'needs_review', 'completed', 'failed', 'rejected', 'duplicate'
);

-- -----------------------------------------------------------------------------
-- Ingestion sources and routes
-- -----------------------------------------------------------------------------
create table public.ingestion_sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  channel text not null check (channel in ('manual', 'email', 'integration')),
  report_type public.report_type not null,
  parser_key text not null,
  -- How conflicting values for already-loaded dates/periods are handled.
  revision_policy text not null default 'require_review' check (revision_policy in ('replace', 'require_review')),
  expected_cadence text not null default 'none' check (expected_cadence in ('none', 'daily', 'monthly')),
  -- For daily cadence: local time by which yesterday's report must arrive.
  -- For monthly cadence: day of the following month by which the report is due.
  expected_by_local time,
  expected_by_day smallint check (expected_by_day is null or expected_by_day between 1 and 28),
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, name)
);
create trigger ingestion_sources_touch before update on public.ingestion_sources
  for each row execute function app.touch_updated_at();

-- Email routing secrets kept apart so they are visible to ingestion managers only.
create table public.ingestion_source_routes (
  source_id uuid primary key,
  company_id uuid not null,
  inbound_token text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  allowed_senders text[] not null default '{}',
  require_spf_dkim_pass boolean not null default true,
  foreign key (source_id, company_id) references public.ingestion_sources (id, company_id) on delete cascade,
  check (array_position(allowed_senders, null) is null)
);

create table public.ingestion_property_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  source_id uuid not null,
  external_code text not null,
  property_id uuid not null,
  created_at timestamptz not null default now(),
  unique (source_id, external_code),
  foreign key (source_id, company_id) references public.ingestion_sources (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);

create table public.source_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  source_id uuid,
  storage_key text not null unique,
  original_filename text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  received_via text not null check (received_via in ('upload', 'email', 'integration')),
  sender text,
  email_message_id text,
  uploaded_by uuid references auth.users (id),
  received_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (source_id, company_id) references public.ingestion_sources (id, company_id)
);
create index source_files_hash on public.source_files (company_id, sha256);

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  source_id uuid,
  source_file_id uuid not null,
  report_type public.report_type not null,
  parser_key text not null,
  status public.import_status not null default 'received',
  -- Explicit rule for revised data: replace existing values (keeping history)?
  replace_existing boolean not null default false,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  duplicate_of_run_id uuid references public.import_runs (id),
  period_start date,
  period_end date,
  property_ids uuid[] not null default '{}',
  rows_total integer,
  rows_valid integer,
  rows_inserted integer,
  rows_updated integer,
  rows_unchanged integer,
  conflicts integer,
  issues_errors integer not null default 0,
  issues_warnings integer not null default 0,
  -- For budget imports: target fiscal year/version created.
  result jsonb not null default '{}'::jsonb,
  requested_by uuid references auth.users (id),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (source_file_id, company_id) references public.source_files (id, company_id),
  foreign key (source_id, company_id) references public.ingestion_sources (id, company_id)
);
create index import_runs_company on public.import_runs (company_id, created_at desc);
create index import_runs_file on public.import_runs (source_file_id);
create trigger import_runs_touch before update on public.import_runs
  for each row execute function app.touch_updated_at();

create table public.import_validation_issues (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  import_run_id uuid not null,
  severity text not null check (severity in ('error', 'warning')),
  row_number integer,
  field text,
  code text not null,
  message text not null,
  foreign key (import_run_id, company_id) references public.import_runs (id, company_id) on delete cascade
);
create index import_validation_issues_run on public.import_validation_issues (import_run_id);

create table public.ingestion_alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  source_id uuid not null,
  property_id uuid,
  alert_type text not null check (alert_type in ('missing_report', 'repeated_failure')),
  expected_for date not null,
  message text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (source_id, company_id) references public.ingestion_sources (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create unique index ingestion_alerts_unique on public.ingestion_alerts
  (source_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid), alert_type, expected_for);

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null check (kind in ('pms', 'accounting', 'travera')),
  provider text not null,
  status text not null default 'not_configured' check (status in ('not_configured', 'configured', 'disabled', 'error')),
  settings jsonb not null default '{}'::jsonb,
  -- Reference (ARN/name) to AWS Secrets Manager; secrets are never stored here.
  secret_ref text,
  last_sync_at timestamptz,
  last_error text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, kind, provider)
);

-- -----------------------------------------------------------------------------
-- Daily operating performance (provisional, PMS-sourced)
-- -----------------------------------------------------------------------------
create table public.daily_performance (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  business_date date not null,
  physical_rooms integer not null check (physical_rooms > 0),
  rooms_out_of_order integer not null default 0 check (rooms_out_of_order >= 0),
  rooms_sold integer not null check (rooms_sold >= 0),
  rooms_comp integer not null default 0 check (rooms_comp >= 0),
  room_revenue numeric(14, 2) not null check (room_revenue >= 0),
  fb_revenue numeric(14, 2),
  other_revenue numeric(14, 2),
  total_revenue numeric(14, 2) check (total_revenue is null or total_revenue >= 0),
  -- Source-reported metrics preserved verbatim (may use different conventions).
  source_metrics jsonb not null default '{}'::jsonb,
  revision integer not null default 1,
  import_run_id uuid,
  source_file_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, business_date),
  check (rooms_out_of_order <= physical_rooms),
  check (rooms_sold + rooms_comp <= physical_rooms),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  foreign key (import_run_id, company_id) references public.import_runs (id, company_id),
  foreign key (source_file_id, company_id) references public.source_files (id, company_id)
);
create index daily_performance_company_date on public.daily_performance (company_id, business_date);
create trigger daily_performance_touch before update on public.daily_performance
  for each row execute function app.touch_updated_at();

create table public.daily_performance_revisions (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  property_id uuid not null,
  business_date date not null,
  revision integer not null,
  previous_values jsonb not null,
  previous_import_run_id uuid,
  replaced_by_import_run_id uuid,
  replaced_at timestamptz not null default now(),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create index daily_performance_revisions_lookup on public.daily_performance_revisions (property_id, business_date);

-- =============================================================================
-- Performance read RPCs (SECURITY INVOKER — RLS applies)
-- =============================================================================

-- Summed KPI components per property and bucket. Ratios are computed by the
-- caller from these sums (see packages/core/src/kpi.ts), never averaged.
create or replace function public.performance_rollup(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_grain text default 'total',
  p_property_ids uuid[] default null
) returns table (
  property_id uuid,
  bucket date,
  available_room_nights bigint,
  rooms_sold bigint,
  room_revenue numeric,
  total_revenue numeric,
  total_revenue_days integer,
  reported_days integer
)
language sql stable security invoker set search_path = '' as $$
  select
    d.property_id,
    case p_grain
      when 'day' then d.business_date
      when 'month' then date_trunc('month', d.business_date)::date
      else p_from
    end as bucket,
    sum(case when coalesce(cfg.ooo_treatment, 'exclude') = 'exclude'
             then d.physical_rooms - d.rooms_out_of_order else d.physical_rooms end)::bigint,
    sum(case when coalesce(cfg.comp_treatment, 'exclude') = 'include'
             then d.rooms_sold + d.rooms_comp else d.rooms_sold end)::bigint,
    sum(d.room_revenue),
    sum(d.total_revenue),
    count(d.total_revenue)::integer,
    count(*)::integer
  from public.daily_performance d
  left join public.property_reporting_config cfg on cfg.property_id = d.property_id
  where d.company_id = p_company_id
    and d.business_date between p_from and p_to
    and (p_property_ids is null or d.property_id = any (p_property_ids))
    and p_grain in ('day', 'month', 'total')
  group by 1, 2;
$$;
grant execute on function public.performance_rollup(uuid, date, date, text, uuid[]) to authenticated;

create or replace function public.performance_freshness(p_company_id uuid)
returns table (property_id uuid, latest_business_date date, last_loaded_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select d.property_id, max(d.business_date), max(d.updated_at)
  from public.daily_performance d
  where d.company_id = p_company_id
  group by d.property_id;
$$;
grant execute on function public.performance_freshness(uuid) to authenticated;

-- =============================================================================
-- Service-role write path for validated imports (called by the worker only)
-- =============================================================================

-- Writes validated daily records idempotently.
--   * identical values           → unchanged
--   * no existing row            → inserted
--   * different values, replace  → previous values moved to history, row updated
--   * different values, no replace → counted as conflict, nothing written
-- Returns counts and conflicting keys. All-or-nothing per call.
create or replace function public.svc_apply_daily_performance(
  p_import_run_id uuid, p_records jsonb, p_replace boolean, p_dry_run boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.import_runs;
  r jsonb;
  v_existing public.daily_performance;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_prop uuid;
  v_date date;
  v_new jsonb;
  v_old jsonb;
begin
  select * into v_run from public.import_runs where id = p_import_run_id for update;
  if not found then
    raise exception 'import run not found';
  end if;

  for r in select * from jsonb_array_elements(p_records) loop
    v_prop := (r ->> 'propertyId')::uuid;
    v_date := (r ->> 'businessDate')::date;
    -- The property must belong to the run's company (composite FK also enforces this).
    if not exists (select 1 from public.properties where id = v_prop and company_id = v_run.company_id) then
      raise exception 'property % does not belong to company %', v_prop, v_run.company_id using errcode = '42501';
    end if;
    v_new := jsonb_build_object(
      'physical_rooms', (r ->> 'physicalRooms')::integer,
      'rooms_out_of_order', (r ->> 'roomsOutOfOrder')::integer,
      'rooms_sold', (r ->> 'roomsSold')::integer,
      'rooms_comp', (r ->> 'roomsComp')::integer,
      'room_revenue', (r ->> 'roomRevenue')::numeric(14, 2),
      'fb_revenue', (r ->> 'fbRevenue')::numeric(14, 2),
      'other_revenue', (r ->> 'otherRevenue')::numeric(14, 2),
      'total_revenue', (r ->> 'totalRevenue')::numeric(14, 2),
      'source_metrics', coalesce(r -> 'sourceMetrics', '{}'::jsonb));

    select * into v_existing from public.daily_performance
     where property_id = v_prop and business_date = v_date for update;

    if not found then
      v_inserted := v_inserted + 1;
      if not p_dry_run then
        insert into public.daily_performance (company_id, property_id, business_date, physical_rooms, rooms_out_of_order,
          rooms_sold, rooms_comp, room_revenue, fb_revenue, other_revenue, total_revenue, source_metrics, import_run_id, source_file_id)
        values (v_run.company_id, v_prop, v_date, (v_new ->> 'physical_rooms')::integer, (v_new ->> 'rooms_out_of_order')::integer,
          (v_new ->> 'rooms_sold')::integer, (v_new ->> 'rooms_comp')::integer, (v_new ->> 'room_revenue')::numeric,
          (v_new ->> 'fb_revenue')::numeric, (v_new ->> 'other_revenue')::numeric, (v_new ->> 'total_revenue')::numeric,
          v_new -> 'source_metrics', v_run.id, v_run.source_file_id);
      end if;
      continue;
    end if;

    v_old := jsonb_build_object(
      'physical_rooms', v_existing.physical_rooms,
      'rooms_out_of_order', v_existing.rooms_out_of_order,
      'rooms_sold', v_existing.rooms_sold,
      'rooms_comp', v_existing.rooms_comp,
      'room_revenue', v_existing.room_revenue,
      'fb_revenue', v_existing.fb_revenue,
      'other_revenue', v_existing.other_revenue,
      'total_revenue', v_existing.total_revenue,
      'source_metrics', v_existing.source_metrics);

    if v_old = v_new then
      v_unchanged := v_unchanged + 1;
    elsif p_replace then
      v_updated := v_updated + 1;
      if not p_dry_run then
        insert into public.daily_performance_revisions (company_id, property_id, business_date, revision, previous_values,
          previous_import_run_id, replaced_by_import_run_id)
        values (v_run.company_id, v_prop, v_date, v_existing.revision, v_old, v_existing.import_run_id, v_run.id);
        update public.daily_performance set
          physical_rooms = (v_new ->> 'physical_rooms')::integer,
          rooms_out_of_order = (v_new ->> 'rooms_out_of_order')::integer,
          rooms_sold = (v_new ->> 'rooms_sold')::integer,
          rooms_comp = (v_new ->> 'rooms_comp')::integer,
          room_revenue = (v_new ->> 'room_revenue')::numeric,
          fb_revenue = (v_new ->> 'fb_revenue')::numeric,
          other_revenue = (v_new ->> 'other_revenue')::numeric,
          total_revenue = (v_new ->> 'total_revenue')::numeric,
          source_metrics = v_new -> 'source_metrics',
          revision = v_existing.revision + 1,
          import_run_id = v_run.id,
          source_file_id = v_run.source_file_id
        where id = v_existing.id;
      end if;
    else
      v_conflicts := v_conflicts || jsonb_build_object('propertyId', v_prop, 'businessDate', v_date,
                                                       'existing', v_old, 'incoming', v_new);
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'unchanged', v_unchanged,
                            'conflicts', jsonb_array_length(v_conflicts), 'conflictDetails', v_conflicts);
end;
$$;
revoke all on function public.svc_apply_daily_performance(uuid, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.svc_apply_daily_performance(uuid, jsonb, boolean, boolean) to service_role;

-- Permission check for a specific user (worker re-validates the requester).
create or replace function public.svc_user_has_permission(p_user uuid, p_perm text, p_company_id uuid, p_property_id uuid default null)
returns boolean
language sql stable security definer set search_path = '' as $$
  select app.user_has_permission(p_user, p_perm, p_company_id, p_property_id);
$$;
revoke all on function public.svc_user_has_permission(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.svc_user_has_permission(uuid, text, uuid, uuid) to service_role;

-- Caller's own permission (safe to expose: reveals only the caller's rights).
create or replace function public.check_permission(p_perm text, p_company_id uuid, p_property_id uuid default null)
returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_permission(p_perm, p_company_id, p_property_id);
$$;
grant execute on function public.check_permission(text, uuid, uuid) to authenticated;

create or replace function public.svc_audit(
  p_company_id uuid, p_action text, p_entity_type text, p_entity_id text, p_metadata jsonb,
  p_property_id uuid default null, p_actor uuid default null
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (company_id, property_id, actor_user_id, actor_kind, action, entity_type, entity_id, metadata)
  values (p_company_id, p_property_id, p_actor, case when p_actor is null then 'system' else 'user' end,
          p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;
revoke all on function public.svc_audit(uuid, text, text, text, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.svc_audit(uuid, text, text, text, jsonb, uuid, uuid) to service_role;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.ingestion_sources enable row level security;
alter table public.ingestion_source_routes enable row level security;
alter table public.ingestion_property_mappings enable row level security;
alter table public.source_files enable row level security;
alter table public.import_runs enable row level security;
alter table public.import_validation_issues enable row level security;
alter table public.ingestion_alerts enable row level security;
alter table public.integration_connections enable row level security;
alter table public.daily_performance enable row level security;
alter table public.daily_performance_revisions enable row level security;

revoke all on public.ingestion_sources, public.ingestion_source_routes, public.ingestion_property_mappings,
  public.source_files, public.import_runs, public.import_validation_issues, public.ingestion_alerts,
  public.integration_connections, public.daily_performance, public.daily_performance_revisions
  from anon, authenticated;

grant select, insert, update on public.ingestion_sources to authenticated;
create policy ingestion_sources_read on public.ingestion_sources for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.view'))::uuid[]));
create policy ingestion_sources_write on public.ingestion_sources for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]));

grant select, insert, update on public.ingestion_source_routes to authenticated;
create policy ingestion_routes_manage on public.ingestion_source_routes for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]));

grant select, insert, update, delete on public.ingestion_property_mappings to authenticated;
create policy ingestion_mappings_read on public.ingestion_property_mappings for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.view'))::uuid[]));
create policy ingestion_mappings_write on public.ingestion_property_mappings for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]));

grant select on public.source_files, public.import_runs, public.import_validation_issues, public.ingestion_alerts
  to authenticated;
-- Import data is visible to ingestion managers company-wide, otherwise only when
-- every property in the run is within the viewer's ingestion.view properties.
create or replace function app.can_view_import_run(p_company_id uuid, p_property_ids uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_company_id = any (app.permitted_company_ids('ingestion.manage'))
      or (cardinality(p_property_ids) > 0 and p_property_ids <@ app.permitted_property_ids('ingestion.view'));
$$;
grant execute on function app.can_view_import_run(uuid, uuid[]) to authenticated;

create policy import_runs_read on public.import_runs for select to authenticated
  using (app.can_view_import_run(company_id, property_ids));
create policy source_files_read on public.source_files for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[])
         or exists (select 1 from public.import_runs r where r.source_file_id = source_files.id));
create policy import_issues_read on public.import_validation_issues for select to authenticated
  using (exists (select 1 from public.import_runs r where r.id = import_validation_issues.import_run_id));
create policy ingestion_alerts_read on public.ingestion_alerts for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[])
         or property_id = any ((select app.permitted_property_ids('ingestion.view'))::uuid[]));

grant select, insert, update on public.integration_connections to authenticated;
create policy integrations_manage on public.integration_connections for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('ingestion.manage'))::uuid[]));

grant select on public.daily_performance to authenticated;
create policy daily_performance_read on public.daily_performance for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('performance.view'))::uuid[]));

grant select on public.daily_performance_revisions to authenticated;
create policy daily_performance_revisions_read on public.daily_performance_revisions for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('ingestion.view'))::uuid[]));

create trigger audit_ingestion_sources after insert or update or delete on public.ingestion_sources
  for each row execute function app.audit_row_change();
create trigger audit_ingestion_mappings after insert or update or delete on public.ingestion_property_mappings
  for each row execute function app.audit_row_change();
create trigger audit_integration_connections after insert or update or delete on public.integration_connections
  for each row execute function app.audit_row_change();
