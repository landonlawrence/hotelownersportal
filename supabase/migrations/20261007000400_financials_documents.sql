-- =============================================================================
-- Milestone 3 — Chart of accounts, mappings, budgets, monthly actuals with a
-- draft → review → publish workflow, and private documents.
-- =============================================================================

create type public.publication_status as enum ('draft', 'in_review', 'published', 'superseded');
create type public.budget_status as enum ('draft', 'approved', 'superseded');
create type public.document_visibility as enum ('general', 'owner', 'internal', 'confidential');
create type public.scan_status as enum ('awaiting_upload', 'pending', 'clean', 'infected', 'error', 'skipped');

-- -----------------------------------------------------------------------------
-- Reporting structure
-- -----------------------------------------------------------------------------
create table public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_.-]{2,40}$'),
  name text not null,
  nature text not null check (nature in ('revenue', 'expense', 'statistic', 'other')),
  section text not null,
  sort_order integer not null,
  -- KPI roles let budgets drive operating comparisons (rooms available/sold, revenue).
  kpi_role text check (kpi_role in ('rooms_available', 'rooms_sold', 'room_revenue', 'total_revenue')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code),
  unique (id, company_id)
);
create unique index financial_accounts_kpi_role on public.financial_accounts (company_id, kpi_role) where kpi_role is not null;

create table public.source_account_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid,
  source_system text not null default 'standard',
  source_account_code text not null,
  source_account_name text,
  account_id uuid not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (account_id, company_id) references public.financial_accounts (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create unique index source_account_mappings_unique on public.source_account_mappings
  (company_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid), source_system, source_account_code);

-- -----------------------------------------------------------------------------
-- Budgets
-- -----------------------------------------------------------------------------
create table public.budget_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  fiscal_year integer not null check (fiscal_year between 2000 and 2100),
  version_number integer not null,
  name text not null,
  status public.budget_status not null default 'draft',
  notes text,
  import_run_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  superseded_at timestamptz,
  unique (property_id, fiscal_year, version_number),
  unique (id, company_id),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  foreign key (import_run_id, company_id) references public.import_runs (id, company_id)
);
create unique index budget_versions_one_approved on public.budget_versions (property_id, fiscal_year) where status = 'approved';

create table public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  budget_version_id uuid not null,
  account_id uuid not null,
  period_month date not null check (extract(day from period_month) = 1),
  amount numeric(16, 2) not null,
  unique (budget_version_id, account_id, period_month),
  foreign key (budget_version_id, company_id) references public.budget_versions (id, company_id) on delete cascade,
  foreign key (account_id, company_id) references public.financial_accounts (id, company_id),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create index budget_lines_lookup on public.budget_lines (property_id, period_month);

create or replace function app.budget_line_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.budget_versions;
begin
  select * into v from public.budget_versions where id = coalesce(new.budget_version_id, old.budget_version_id);
  if v.status <> 'draft' and coalesce(current_setting('app.bypass_budget_guard', true), 'off') <> 'on' then
    raise exception 'budget version % is %; create a new version to change it', v.version_number, v.status using errcode = '55000';
  end if;
  if tg_op <> 'DELETE' then
    if new.property_id <> v.property_id then
      raise exception 'budget line property must match its version' using errcode = '23514';
    end if;
    if extract(year from new.period_month) <> v.fiscal_year then
      raise exception 'budget line period must fall in fiscal year %', v.fiscal_year using errcode = '23514';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger budget_lines_guard before insert or update or delete on public.budget_lines
  for each row execute function app.budget_line_guard();

-- -----------------------------------------------------------------------------
-- Financial reports (structured actuals) with publication workflow
-- -----------------------------------------------------------------------------
create table public.financial_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  period_month date not null check (extract(day from period_month) = 1),
  report_type text not null default 'monthly_pnl' check (report_type in ('monthly_pnl')),
  revision integer not null default 1,
  status public.publication_status not null default 'draft',
  supersedes_id uuid references public.financial_reports (id),
  correction_reason text,
  title text not null,
  internal_notes text,
  import_run_id uuid,
  -- Optional published P&L document (PDF) shown alongside structured data.
  document_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz,
  published_by uuid references auth.users (id),
  published_at timestamptz,
  superseded_at timestamptz,
  unique (property_id, period_month, report_type, revision),
  unique (id, company_id),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  foreign key (import_run_id, company_id) references public.import_runs (id, company_id),
  check (revision = 1 or (supersedes_id is not null and correction_reason is not null))
);
create unique index financial_reports_one_published on public.financial_reports (property_id, period_month, report_type)
  where status = 'published';
create unique index financial_reports_one_open on public.financial_reports (property_id, period_month, report_type)
  where status in ('draft', 'in_review');
create trigger financial_reports_touch before update on public.financial_reports
  for each row execute function app.touch_updated_at();

create table public.financial_report_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  financial_report_id uuid not null,
  account_id uuid not null,
  amount numeric(16, 2) not null,
  -- Original source values are preserved for lineage.
  source_account_code text not null,
  source_account_name text,
  source_value text,
  import_run_id uuid,
  created_at timestamptz not null default now(),
  unique (financial_report_id, source_account_code),
  foreign key (financial_report_id, company_id) references public.financial_reports (id, company_id) on delete cascade,
  foreign key (account_id, company_id) references public.financial_accounts (id, company_id),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create index financial_report_lines_report on public.financial_report_lines (financial_report_id);

create or replace function app.financial_line_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.financial_reports;
begin
  select * into v from public.financial_reports where id = coalesce(new.financial_report_id, old.financial_report_id);
  if v.status <> 'draft' then
    raise exception 'financial report is %; lines can only change while in draft', v.status using errcode = '55000';
  end if;
  if tg_op <> 'DELETE' and new.property_id <> v.property_id then
    raise exception 'line property must match report property' using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger financial_report_lines_guard before insert or update or delete on public.financial_report_lines
  for each row execute function app.financial_line_guard();

-- Published/superseded reports are immutable except for supersession bookkeeping.
create or replace function app.financial_report_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status in ('published', 'superseded') then
    if new.status = 'superseded' and old.status = 'published'
       and (to_jsonb(new) - 'status' - 'superseded_at' - 'updated_at') = (to_jsonb(old) - 'status' - 'superseded_at' - 'updated_at') then
      return new;
    end if;
    raise exception 'published financial reports are immutable; create a revision instead' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger financial_reports_guard before update on public.financial_reports
  for each row execute function app.financial_report_guard();

create table public.publication_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid,
  entity_type text not null check (entity_type in ('financial_report', 'reporting_package', 'budget_version')),
  entity_id uuid not null,
  revision integer,
  from_status text,
  to_status text not null,
  comment text,
  actor_user_id uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index publication_events_entity on public.publication_events (entity_type, entity_id);
create trigger publication_events_append_only before update or delete on public.publication_events
  for each row execute function app.prevent_mutation();

-- -----------------------------------------------------------------------------
-- Documents
-- -----------------------------------------------------------------------------
create table public.document_categories (
  company_id uuid not null references public.companies (id) on delete cascade,
  key text not null check (key ~ '^[a-z_]{2,40}$'),
  label text not null,
  default_visibility public.document_visibility not null default 'owner',
  sort_order integer not null default 100,
  primary key (company_id, key)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid,
  category_key text not null,
  title text not null check (length(trim(title)) between 2 and 200),
  description text,
  period_month date check (period_month is null or extract(day from period_month) = 1),
  visibility public.document_visibility not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  current_version_id uuid,
  linked_entity_type text check (linked_entity_type in ('financial_report', 'capex_project', 'reporting_package', 'capex_transaction')),
  linked_entity_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (company_id, category_key) references public.document_categories (company_id, key),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create index documents_company_property on public.documents (company_id, property_id, category_key);
create trigger documents_touch before update on public.documents
  for each row execute function app.touch_updated_at();

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid,
  document_id uuid not null,
  version_number integer not null,
  storage_key text not null unique,
  original_filename text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 104857600),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  scan_status public.scan_status not null default 'awaiting_upload',
  scan_detail text,
  scanned_at timestamptz,
  -- When scanning is not configured, a document manager must explicitly release a file.
  released_by uuid references auth.users (id),
  released_at timestamptz,
  uploaded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  upload_completed_at timestamptz,
  unique (document_id, version_number),
  unique (id, company_id),
  foreign key (document_id, company_id) references public.documents (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);

alter table public.documents
  add constraint documents_current_version_fk foreign key (current_version_id) references public.document_versions (id);
alter table public.financial_reports
  add constraint financial_reports_document_fk foreign key (document_id, company_id) references public.documents (id, company_id);

create or replace function app.document_version_property_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.property_id is distinct from (select property_id from public.documents where id = new.document_id) then
    raise exception 'version property must match document property' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger document_versions_property_guard before insert or update on public.document_versions
  for each row execute function app.document_version_property_guard();

-- Is a version downloadable at all (independent of the viewer)?
create or replace function app.version_is_releasable(v public.document_versions) returns boolean
language sql immutable set search_path = '' as $$
  select v.scan_status = 'clean' or (v.scan_status = 'skipped' and v.released_at is not null);
$$;

-- Can the current user see a document with this scope and visibility?
create or replace function app.can_view_document(p_company_id uuid, p_property_id uuid, p_visibility public.document_visibility)
returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_visibility
    when 'general' then app.has_permission('documents.view', p_company_id, p_property_id)
    when 'owner' then app.has_permission('documents.view_owner', p_company_id, p_property_id)
    when 'internal' then app.has_permission('documents.view_internal', p_company_id, p_property_id)
    when 'confidential' then app.has_permission('documents.view_confidential', p_company_id, p_property_id)
  end
  or app.has_permission('documents.manage', p_company_id, p_property_id);
$$;
grant execute on function app.can_view_document(uuid, uuid, public.document_visibility) to authenticated;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.financial_accounts enable row level security;
alter table public.source_account_mappings enable row level security;
alter table public.budget_versions enable row level security;
alter table public.budget_lines enable row level security;
alter table public.financial_reports enable row level security;
alter table public.financial_report_lines enable row level security;
alter table public.publication_events enable row level security;
alter table public.document_categories enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;

revoke all on public.financial_accounts, public.source_account_mappings, public.budget_versions, public.budget_lines,
  public.financial_reports, public.financial_report_lines, public.publication_events, public.document_categories,
  public.documents, public.document_versions from anon, authenticated;

-- Chart of accounts: readable by anyone with any financial visibility in the company.
grant select, insert, update on public.financial_accounts to authenticated;
create policy financial_accounts_read on public.financial_accounts for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('financials.view'))::uuid[])
         or company_id = any ((select app.permitted_company_ids('budgets.view'))::uuid[])
         or company_id = any ((select app.permitted_company_ids('financials.view_draft'))::uuid[]));
create policy financial_accounts_write on public.financial_accounts for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('financials.edit'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('financials.edit'))::uuid[]));

grant select, insert, update, delete on public.source_account_mappings to authenticated;
create policy account_mappings_read on public.source_account_mappings for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('financials.view_draft'))::uuid[])
         or company_id = any ((select app.permitted_company_ids('ingestion.view'))::uuid[]));
create policy account_mappings_write on public.source_account_mappings for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('financials.edit'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('financials.edit'))::uuid[]));

-- Budgets: approved/superseded visible with budgets.view; drafts with edit/approve.
grant select, insert, update on public.budget_versions to authenticated;
create policy budget_versions_read on public.budget_versions for select to authenticated
  using ((status in ('approved', 'superseded') and property_id = any ((select app.permitted_property_ids('budgets.view'))::uuid[]))
         or property_id = any ((select app.permitted_property_ids('budgets.edit'))::uuid[])
         or property_id = any ((select app.permitted_property_ids('budgets.approve'))::uuid[]));
create policy budget_versions_insert on public.budget_versions for insert to authenticated
  with check (status = 'draft' and property_id = any ((select app.permitted_property_ids('budgets.edit'))::uuid[]));
create policy budget_versions_update on public.budget_versions for update to authenticated
  using (status = 'draft' and property_id = any ((select app.permitted_property_ids('budgets.edit'))::uuid[]))
  with check (status = 'draft' and property_id = any ((select app.permitted_property_ids('budgets.edit'))::uuid[]));
-- Status changes go through approve_budget_version().
revoke update on public.budget_versions from authenticated;
grant update (name, notes) on public.budget_versions to authenticated;

grant select, insert, update, delete on public.budget_lines to authenticated;
create policy budget_lines_read on public.budget_lines for select to authenticated
  using (exists (select 1 from public.budget_versions v where v.id = budget_lines.budget_version_id));
create policy budget_lines_write on public.budget_lines for all to authenticated
  using (property_id = any ((select app.permitted_property_ids('budgets.edit'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('budgets.edit'))::uuid[]));

-- Financial reports: owners/investors only ever see published (or previously published) revisions.
grant select on public.financial_reports to authenticated;
grant update (title, internal_notes, document_id) on public.financial_reports to authenticated;
create policy financial_reports_read_published on public.financial_reports for select to authenticated
  using (status in ('published', 'superseded')
         and property_id = any ((select app.permitted_property_ids('financials.view'))::uuid[]));
create policy financial_reports_read_draft on public.financial_reports for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('financials.view_draft'))::uuid[]));
create policy financial_reports_update_draft on public.financial_reports for update to authenticated
  using (status in ('draft', 'in_review') and property_id = any ((select app.permitted_property_ids('financials.edit'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('financials.edit'))::uuid[]));

grant select, insert, update, delete on public.financial_report_lines to authenticated;
create policy financial_lines_read on public.financial_report_lines for select to authenticated
  using (exists (select 1 from public.financial_reports r where r.id = financial_report_lines.financial_report_id));
create policy financial_lines_write on public.financial_report_lines for all to authenticated
  using (property_id = any ((select app.permitted_property_ids('financials.edit'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('financials.edit'))::uuid[]));

grant select on public.publication_events to authenticated;
create policy publication_events_read on public.publication_events for select to authenticated
  using ((entity_type = 'financial_report' and exists (select 1 from public.financial_reports r where r.id = publication_events.entity_id))
         or (entity_type = 'budget_version' and exists (select 1 from public.budget_versions b where b.id = publication_events.entity_id))
         or (entity_type = 'reporting_package' and property_id = any ((select app.permitted_property_ids('reports.edit'))::uuid[])));

grant select, insert, update on public.document_categories to authenticated;
create policy document_categories_read on public.document_categories for select to authenticated
  using ((select app.is_member(company_id)));
create policy document_categories_write on public.document_categories for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]));

-- Documents: visibility-specific permission on the document's property (or company
-- for company-level documents). Archived documents are visible to managers only.
grant select on public.documents to authenticated;
grant update (title, description, visibility, status, category_key, period_month) on public.documents to authenticated;
create policy documents_read on public.documents for select to authenticated
  using (
    (status = 'active' and (
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
create policy documents_manage_update on public.documents for update to authenticated
  using ((property_id is not null and property_id = any ((select app.permitted_property_ids('documents.manage'))::uuid[]))
         or (property_id is null and company_id = any ((select app.permitted_company_ids('documents.manage'))::uuid[])))
  with check ((property_id is not null and property_id = any ((select app.permitted_property_ids('documents.manage'))::uuid[]))
         or (property_id is null and company_id = any ((select app.permitted_company_ids('documents.manage'))::uuid[])));

-- Versions: the document must be visible; unscanned/infected versions only to
-- document managers and the uploader. storage_key is never granted to clients.
grant select (id, company_id, property_id, document_id, version_number, original_filename, content_type, size_bytes,
  sha256, scan_status, scan_detail, scanned_at, released_by, released_at, uploaded_by, created_at, upload_completed_at)
  on public.document_versions to authenticated;
create policy document_versions_read on public.document_versions for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_versions.document_id)
         and ((scan_status = 'clean' or (scan_status = 'skipped' and released_at is not null))
              or uploaded_by = (select auth.uid())
              or (property_id is not null and property_id = any ((select app.permitted_property_ids('documents.manage'))::uuid[]))
              or (property_id is null and company_id = any ((select app.permitted_company_ids('documents.manage'))::uuid[]))));

create trigger audit_financial_accounts after insert or update or delete on public.financial_accounts
  for each row execute function app.audit_row_change();
create trigger audit_account_mappings after insert or update or delete on public.source_account_mappings
  for each row execute function app.audit_row_change();
create trigger audit_documents after insert or update on public.documents
  for each row execute function app.audit_row_change();
