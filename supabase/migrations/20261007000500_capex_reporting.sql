-- =============================================================================
-- Milestone 4 — CapEx, management commentary, reporting packages
-- =============================================================================

create type public.capex_status as enum (
  'draft', 'pending_approval', 'approved', 'in_progress', 'on_hold', 'completed', 'cancelled', 'rejected'
);

create table public.capex_projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  project_number text not null,
  title text not null check (length(trim(title)) between 3 and 200),
  category text not null check (category in ('guest_rooms', 'public_areas', 'building_systems', 'life_safety', 'technology',
                                             'food_beverage', 'exterior', 'brand_standards', 'other')),
  description text,
  status public.capex_status not null default 'draft',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  requested_budget numeric(14, 2) not null check (requested_budget > 0),
  -- Only changed by the approval workflow (see trigger).
  approved_budget numeric(14, 2) not null default 0 check (approved_budget >= 0),
  target_start date,
  target_completion date,
  actual_completion date,
  percent_complete smallint not null default 0 check (percent_complete between 0 and 100),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, project_number),
  unique (id, company_id),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  check (target_completion is null or target_start is null or target_completion >= target_start)
);
create trigger capex_projects_touch before update on public.capex_projects
  for each row execute function app.touch_updated_at();

create table public.capex_vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  contact_email text,
  unique (company_id, name),
  unique (id, company_id)
);

create table public.capex_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  project_id uuid not null,
  kind text not null check (kind in ('quote', 'commitment', 'actual')),
  -- commitments: open until invoiced/closed; quotes are informational; actuals are spend.
  status text not null default 'open' check (status in ('open', 'closed', 'void')),
  vendor_id uuid,
  reference text,
  description text,
  amount numeric(14, 2) not null check (amount <> 0),
  transaction_date date not null,
  related_commitment_id uuid references public.capex_transactions (id),
  document_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (project_id, company_id) references public.capex_projects (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  foreign key (vendor_id, company_id) references public.capex_vendors (id, company_id),
  foreign key (document_id, company_id) references public.documents (id, company_id)
);
create index capex_transactions_project on public.capex_transactions (project_id);

create table public.capex_approval_thresholds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid,
  min_amount numeric(14, 2) not null default 0 check (min_amount >= 0),
  max_amount numeric(14, 2) check (max_amount is null or max_amount > min_amount),
  approver_type text not null check (approver_type in ('corporate', 'owner')),
  approvals_required smallint not null default 1 check (approvals_required between 1 and 5),
  created_at timestamptz not null default now(),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);

create table public.capex_approval_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  project_id uuid not null,
  request_type text not null check (request_type in ('initial', 'change_order')),
  -- Amount evaluated against thresholds (initial: total; change order: increase).
  amount numeric(14, 2) not null check (amount > 0),
  -- Approved budget the project will have if approved.
  new_approved_budget numeric(14, 2) not null check (new_approved_budget > 0),
  previous_approved_budget numeric(14, 2) not null default 0,
  justification text not null check (length(trim(justification)) >= 10),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  -- Snapshot of required steps at submission: [{"approver_type": "corporate", "approvals_required": 1}, ...]
  required_steps jsonb not null,
  requested_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (id, company_id),
  foreign key (project_id, company_id) references public.capex_projects (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);
create unique index capex_requests_one_pending on public.capex_approval_requests (project_id) where status = 'pending';

create table public.capex_approval_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  request_id uuid not null,
  approver_type text not null check (approver_type in ('corporate', 'owner')),
  decision text not null check (decision in ('approved', 'rejected')),
  comment text,
  decided_by uuid not null references auth.users (id),
  decided_at timestamptz not null default now(),
  -- One decision per person per request: duplicate decisions are impossible.
  unique (request_id, decided_by),
  foreign key (request_id, company_id) references public.capex_approval_requests (id, company_id) on delete cascade
);
create trigger capex_decisions_append_only before update or delete on public.capex_approval_decisions
  for each row execute function app.prevent_mutation();

create table public.capex_updates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  project_id uuid not null,
  body text not null,
  percent_complete smallint check (percent_complete between 0 and 100),
  visibility text not null default 'owner' check (visibility in ('owner', 'internal')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (project_id, company_id) references public.capex_projects (id, company_id) on delete cascade,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade
);

-- Approved amounts are only changed by the approval workflow, and request
-- amounts are immutable after submission.
create or replace function app.capex_project_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.property_id <> old.property_id or new.company_id <> old.company_id then
    raise exception 'a project cannot move between properties' using errcode = '55000';
  end if;
  if new.approved_budget is distinct from old.approved_budget
     and coalesce(current_setting('app.capex_approval_in_progress', true), '') <> 'on' then
    raise exception 'approved budget can only change through an approval request' using errcode = '55000';
  end if;
  if new.requested_budget is distinct from old.requested_budget and old.status <> 'draft'
     and coalesce(current_setting('app.capex_approval_in_progress', true), '') <> 'on' then
    raise exception 'requested budget is locked after submission; submit a change order' using errcode = '55000';
  end if;
  if new.status is distinct from old.status
     and coalesce(current_setting('app.capex_approval_in_progress', true), '') <> 'on' then
    -- Workflow statuses are owned by the approval process.
    -- Allowed manual transitions: draft/rejected → cancelled, and between the
    -- execution statuses of an approved project.
    if not (
      (old.status in ('draft', 'rejected') and new.status = 'cancelled')
      or (old.status in ('approved', 'in_progress', 'on_hold')
          and new.status in ('in_progress', 'on_hold', 'completed', 'cancelled'))
    ) then
      raise exception 'status % → % must go through the approval workflow', old.status, new.status using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
create trigger capex_projects_guard before update on public.capex_projects
  for each row execute function app.capex_project_guard();

create or replace function app.capex_request_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.amount <> old.amount or new.new_approved_budget <> old.new_approved_budget
     or new.required_steps <> old.required_steps or new.project_id <> old.project_id then
    raise exception 'approval request amounts and routing are immutable' using errcode = '55000';
  end if;
  if old.status <> 'pending' then
    raise exception 'decided approval requests are immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger capex_requests_guard before update on public.capex_approval_requests
  for each row execute function app.capex_request_guard();

-- Approver type for the current user on a property (owners/investors approve as owners).
create or replace function app.capex_approver_type(p_company_id uuid, p_property_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not app.has_permission('capex.approve', p_company_id, p_property_id) then null
    when exists (select 1 from public.company_memberships m where m.company_id = p_company_id and m.user_id = auth.uid()
                 and m.status = 'active' and m.role in ('owner', 'investor')) then 'owner'
    else 'corporate'
  end;
$$;

create or replace function app.required_capex_steps(p_company_id uuid, p_property_id uuid, p_amount numeric) returns jsonb
language sql stable security definer set search_path = '' as $$
  with pool as (
    select * from public.capex_approval_thresholds t
    where t.company_id = p_company_id
      and (case when exists (select 1 from public.capex_approval_thresholds x
                             where x.company_id = p_company_id and x.property_id = p_property_id)
                then t.property_id = p_property_id else t.property_id is null end)
      and p_amount >= t.min_amount and (t.max_amount is null or p_amount < t.max_amount)
  )
  select coalesce(jsonb_agg(jsonb_build_object('approver_type', approver_type, 'approvals_required', max_req)
                            order by approver_type), '[]'::jsonb)
  from (select approver_type, max(approvals_required) as max_req from pool group by approver_type) s;
$$;

create or replace function public.create_capex_project(
  p_property_id uuid, p_title text, p_category text, p_description text, p_requested_budget numeric,
  p_target_start date default null, p_target_completion date default null, p_priority text default 'normal'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_id uuid;
  v_num text;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('capex.edit', v_company, p_property_id) then
    raise exception 'permission denied: capex.edit' using errcode = '42501';
  end if;
  select format('CPX-%s-%s', extract(year from now())::integer, lpad((count(*) + 1)::text, 4, '0'))
    into v_num from public.capex_projects where company_id = v_company;
  insert into public.capex_projects (company_id, property_id, project_number, title, category, description, requested_budget,
    target_start, target_completion, priority, created_by)
  values (v_company, p_property_id, v_num, p_title, p_category, p_description, p_requested_budget,
    p_target_start, p_target_completion, p_priority, auth.uid())
  returning id into v_id;
  perform app.audit(v_company, 'capex.project_created', 'capex_project', v_id::text,
                    jsonb_build_object('requested_budget', p_requested_budget), p_property_id);
  return v_id;
end;
$$;
grant execute on function public.create_capex_project(uuid, text, text, text, numeric, date, date, text) to authenticated;

-- Submit an approval request. Initial requests approve the requested budget;
-- change orders raise an approved budget to a new total.
create or replace function public.submit_capex_request(p_project_id uuid, p_new_total numeric, p_justification text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p public.capex_projects;
  v_type text;
  v_amount numeric;
  v_steps jsonb;
  v_id uuid;
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
  perform app.notify_permitted(p.company_id, p.property_id, 'capex.approve', 'capex_approval_requested',
    format('Approval requested: %s', p.title), null, '/capex/' || p.id, 'capex_project', p.id, auth.uid());
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
    raise exception 'a % approval is not required for this request', v_type using errcode = '42501';
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
  return (select status from public.capex_approval_requests where id = rq.id);
end;
$$;
grant execute on function public.decide_capex_request(uuid, text, text) to authenticated;

create or replace function public.cancel_capex_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare rq public.capex_approval_requests;
begin
  select * into rq from public.capex_approval_requests where id = p_request_id for update;
  if not found or not app.has_permission('capex.edit', rq.company_id, rq.property_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if rq.status <> 'pending' then
    raise exception 'only pending requests can be cancelled' using errcode = '55000';
  end if;
  perform set_config('app.capex_approval_in_progress', 'on', true);
  update public.capex_approval_requests set status = 'cancelled', decided_at = now() where id = rq.id;
  update public.capex_projects set status = 'draft' where id = rq.project_id and status = 'pending_approval';
  perform set_config('app.capex_approval_in_progress', 'off', true);
  perform app.audit(rq.company_id, 'capex.request_cancelled', 'capex_approval_request', rq.id::text, '{}'::jsonb, rq.property_id);
end;
$$;
grant execute on function public.cancel_capex_request(uuid) to authenticated;

-- Funds summary with the remaining-funds definition applied consistently.
create or replace function public.capex_project_summary(p_company_id uuid)
returns table (project_id uuid, property_id uuid, approved_budget numeric, actual_spend numeric, open_commitments numeric,
               remaining numeric, quotes numeric)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.property_id, p.approved_budget,
    coalesce(sum(t.amount) filter (where t.kind = 'actual' and t.status <> 'void'), 0),
    coalesce(sum(t.amount) filter (where t.kind = 'commitment' and t.status = 'open'), 0),
    p.approved_budget
      - coalesce(sum(t.amount) filter (where t.kind = 'actual' and t.status <> 'void'), 0)
      - coalesce(sum(t.amount) filter (where t.kind = 'commitment' and t.status = 'open'), 0),
    coalesce(sum(t.amount) filter (where t.kind = 'quote' and t.status <> 'void'), 0)
  from public.capex_projects p
  left join public.capex_transactions t on t.project_id = p.id
  where p.company_id = p_company_id
  group by p.id;
$$;
grant execute on function public.capex_project_summary(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Management commentary
-- -----------------------------------------------------------------------------
create table public.management_commentary (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  property_id uuid,
  period_month date not null check (extract(day from period_month) = 1),
  section text not null check (section in ('executive_summary', 'performance', 'financial', 'variance', 'capex',
                                           'sales_marketing', 'operations', 'other')),
  account_id uuid,
  title text,
  body text not null check (length(trim(body)) > 0),
  visibility text not null default 'owner' check (visibility in ('owner', 'internal')),
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_by uuid references auth.users (id),
  published_at timestamptz,
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  foreign key (account_id, company_id) references public.financial_accounts (id, company_id)
);
create index management_commentary_lookup on public.management_commentary (company_id, property_id, period_month);
create trigger management_commentary_touch before update on public.management_commentary
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Reporting packages
-- -----------------------------------------------------------------------------
create table public.reporting_packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  property_id uuid not null,
  period_month date not null check (extract(day from period_month) = 1),
  revision integer not null default 1,
  status public.publication_status not null default 'draft',
  supersedes_id uuid references public.reporting_packages (id),
  correction_reason text,
  title text not null,
  summary text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_by uuid references auth.users (id),
  published_at timestamptz,
  superseded_at timestamptz,
  unique (property_id, period_month, revision),
  unique (id, company_id),
  foreign key (property_id, company_id) references public.properties (id, company_id) on delete cascade,
  check (revision = 1 or (supersedes_id is not null and correction_reason is not null))
);
create unique index reporting_packages_one_published on public.reporting_packages (property_id, period_month) where status = 'published';
create unique index reporting_packages_one_open on public.reporting_packages (property_id, period_month) where status in ('draft', 'in_review');
create trigger reporting_packages_touch before update on public.reporting_packages
  for each row execute function app.touch_updated_at();

create table public.reporting_package_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  package_id uuid not null,
  item_type text not null check (item_type in ('performance_summary', 'budget_variance', 'financial_report', 'commentary',
                                               'capex_update', 'document')),
  ref_id uuid,
  title text not null,
  sort_order integer not null default 100,
  foreign key (package_id, company_id) references public.reporting_packages (id, company_id) on delete cascade
);

-- Snapshot frozen at publication; read only through get_reporting_package().
create table public.reporting_package_snapshots (
  package_id uuid primary key references public.reporting_packages (id) on delete cascade,
  company_id uuid not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function app.package_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status in ('published', 'superseded') then
    if new.status = 'superseded' and old.status = 'published'
       and (to_jsonb(new) - 'status' - 'superseded_at' - 'updated_at') = (to_jsonb(old) - 'status' - 'superseded_at' - 'updated_at') then
      return new;
    end if;
    raise exception 'published packages are immutable; create a revision' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger reporting_packages_guard before update on public.reporting_packages
  for each row execute function app.package_guard();

create or replace function app.package_items_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select status from public.reporting_packages where id = coalesce(new.package_id, old.package_id)) not in ('draft') then
    raise exception 'package items can only change while the package is a draft' using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger reporting_package_items_guard before insert or update or delete on public.reporting_package_items
  for each row execute function app.package_items_guard();

create or replace function public.create_reporting_package(p_property_id uuid, p_period_month date, p_title text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_id uuid;
  v_prev public.reporting_packages;
begin
  select company_id into v_company from public.properties where id = p_property_id;
  if v_company is null or not app.has_permission('reports.edit', v_company, p_property_id) then
    raise exception 'permission denied: reports.edit' using errcode = '42501';
  end if;
  if exists (select 1 from public.reporting_packages where property_id = p_property_id and period_month = p_period_month) then
    raise exception 'a package already exists for this period; create a revision instead' using errcode = '23505';
  end if;
  insert into public.reporting_packages (company_id, property_id, period_month, title, created_by)
  values (v_company, p_property_id, p_period_month,
          coalesce(p_title, format('Owner report — %s', to_char(p_period_month, 'FMMonth YYYY'))), auth.uid())
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

create or replace function public.add_package_document(p_package_id uuid, p_document_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  pk public.reporting_packages;
  d public.documents;
  v_id uuid;
begin
  select * into pk from public.reporting_packages where id = p_package_id;
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
  insert into public.reporting_package_items (company_id, package_id, item_type, ref_id, title, sort_order)
  values (pk.company_id, pk.id, 'document', d.id, d.title, 60) returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.add_package_document(uuid, uuid) to authenticated;

-- Build the frozen snapshot for a package (definer: called only from publish).
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

  select coalesce(jsonb_agg(jsonb_build_object('document_id', d.id, 'title', d.title, 'visibility', d.visibility)), '[]'::jsonb)
  into v_docs from public.reporting_package_items i join public.documents d on d.id = i.ref_id
  where i.package_id = pk.id and i.item_type = 'document';

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

create or replace function public.publish_reporting_package(p_package_id uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pk public.reporting_packages;
  v_prev uuid;
begin
  select * into pk from public.reporting_packages where id = p_package_id for update;
  if not found or not app.has_permission('reports.publish', pk.company_id, pk.property_id) then
    raise exception 'permission denied: reports.publish' using errcode = '42501';
  end if;
  if pk.status not in ('draft', 'in_review') then
    raise exception 'package is already %', pk.status using errcode = '55000';
  end if;
  -- Owner packages may only reference published financial statements.
  if exists (select 1 from public.reporting_package_items i join public.financial_reports r on r.id = i.ref_id
             where i.package_id = pk.id and i.item_type = 'financial_report' and r.status <> 'published') then
    raise exception 'package references an unpublished financial report' using errcode = '55000';
  end if;
  select id into v_prev from public.reporting_packages where property_id = pk.property_id and period_month = pk.period_month
   and status = 'published' for update;
  if v_prev is not null then
    update public.reporting_packages set status = 'superseded', superseded_at = now() where id = v_prev;
    insert into public.publication_events (company_id, property_id, entity_type, entity_id, from_status, to_status, comment, actor_user_id)
    values (pk.company_id, pk.property_id, 'reporting_package', v_prev, 'published', 'superseded', format('Superseded by revision %s', pk.revision), auth.uid());
  end if;
  insert into public.reporting_package_snapshots (package_id, company_id, snapshot)
  values (pk.id, pk.company_id, app.build_package_snapshot(pk));
  update public.reporting_packages set status = 'published', published_by = auth.uid(), published_at = now() where id = pk.id;
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
  values (pk.company_id, pk.property_id, 'reporting_package', pk.id, pk.revision, pk.status::text, 'published', p_comment, auth.uid());
  perform app.audit(pk.company_id, 'reporting_package.published', 'reporting_package', pk.id::text,
                    jsonb_build_object('revision', pk.revision, 'superseded', v_prev), pk.property_id);
  perform app.notify_permitted(pk.company_id, pk.property_id, 'reports.view', 'reporting_package_published',
    case when pk.revision > 1 then format('%s (revised) is available', pk.title) else format('%s is available', pk.title) end,
    null, '/reports/' || pk.id, 'reporting_package', pk.id, auth.uid());
end;
$$;
grant execute on function public.publish_reporting_package(uuid, text) to authenticated;

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
  from public.reporting_package_items where package_id = pk.id;
  insert into public.publication_events (company_id, property_id, entity_type, entity_id, revision, from_status, to_status, comment, actor_user_id)
  values (pk.company_id, pk.property_id, 'reporting_package', v_id, v_rev, null, 'draft', 'Revision created: ' || p_reason, auth.uid());
  return v_id;
end;
$$;
grant execute on function public.create_reporting_package_revision(uuid, text) to authenticated;

-- Returns a package with snapshot sections filtered by the caller's permissions.
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
  end if;
  return jsonb_build_object('package', to_jsonb(pk), 'snapshot', s, 'is_preview', pk.status not in ('published', 'superseded'),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.sort_order), '[]'::jsonb) from public.reporting_package_items i where i.package_id = pk.id));
end;
$$;
grant execute on function public.get_reporting_package(uuid) to authenticated;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.capex_projects enable row level security;
alter table public.capex_vendors enable row level security;
alter table public.capex_transactions enable row level security;
alter table public.capex_approval_thresholds enable row level security;
alter table public.capex_approval_requests enable row level security;
alter table public.capex_approval_decisions enable row level security;
alter table public.capex_updates enable row level security;
alter table public.management_commentary enable row level security;
alter table public.reporting_packages enable row level security;
alter table public.reporting_package_items enable row level security;
alter table public.reporting_package_snapshots enable row level security;

revoke all on public.capex_projects, public.capex_vendors, public.capex_transactions, public.capex_approval_thresholds,
  public.capex_approval_requests, public.capex_approval_decisions, public.capex_updates, public.management_commentary,
  public.reporting_packages, public.reporting_package_items, public.reporting_package_snapshots from anon, authenticated;

grant select on public.capex_projects to authenticated;
grant update (title, description, category, priority, target_start, target_completion, actual_completion, percent_complete, status, requested_budget)
  on public.capex_projects to authenticated;
create policy capex_projects_read on public.capex_projects for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('capex.view'))::uuid[]));
create policy capex_projects_update on public.capex_projects for update to authenticated
  using (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[]));

grant select, insert on public.capex_vendors to authenticated;
create policy capex_vendors_read on public.capex_vendors for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('capex.view'))::uuid[]));
create policy capex_vendors_insert on public.capex_vendors for insert to authenticated
  with check (company_id = any ((select app.permitted_company_ids('capex.edit'))::uuid[]));

grant select, insert on public.capex_transactions to authenticated;
grant update (status, description, reference) on public.capex_transactions to authenticated;
create policy capex_tx_read on public.capex_transactions for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('capex.view'))::uuid[]));
create policy capex_tx_write on public.capex_transactions for insert to authenticated
  with check (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[]) and created_by = (select auth.uid()));
create policy capex_tx_update on public.capex_transactions for update to authenticated
  using (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[]));

grant select, insert, update, delete on public.capex_approval_thresholds to authenticated;
create policy capex_thresholds_read on public.capex_approval_thresholds for select to authenticated
  using (company_id = any ((select app.permitted_company_ids('capex.view'))::uuid[]));
create policy capex_thresholds_write on public.capex_approval_thresholds for all to authenticated
  using (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]))
  with check (company_id = any ((select app.permitted_company_ids('admin.company'))::uuid[]));

grant select on public.capex_approval_requests, public.capex_approval_decisions to authenticated;
create policy capex_requests_read on public.capex_approval_requests for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('capex.view'))::uuid[]));
create policy capex_decisions_read on public.capex_approval_decisions for select to authenticated
  using (exists (select 1 from public.capex_approval_requests r where r.id = capex_approval_decisions.request_id));

grant select, insert on public.capex_updates to authenticated;
create policy capex_updates_read on public.capex_updates for select to authenticated
  using ((visibility = 'owner' and property_id = any ((select app.permitted_property_ids('capex.view'))::uuid[]))
         or (visibility = 'internal' and property_id = any ((select app.permitted_property_ids('commentary.view_internal'))::uuid[])
             and property_id = any ((select app.permitted_property_ids('capex.view'))::uuid[])));
create policy capex_updates_insert on public.capex_updates for insert to authenticated
  with check (property_id = any ((select app.permitted_property_ids('capex.edit'))::uuid[]) and created_by = (select auth.uid()));

grant select, insert, update, delete on public.management_commentary to authenticated;
create policy commentary_read on public.management_commentary for select to authenticated
  using (
    (status = 'published' and visibility = 'owner' and (
      (property_id is not null and property_id = any ((select app.permitted_property_ids('commentary.view'))::uuid[]))
      or (property_id is null and company_id = any ((select app.permitted_company_ids('commentary.view'))::uuid[]))))
    or (property_id is not null and property_id = any ((select app.permitted_property_ids('commentary.view_internal'))::uuid[]))
    or (property_id is null and company_id = any ((select app.permitted_company_ids('commentary.view_internal'))::uuid[]))
    or (property_id is not null and property_id = any ((select app.permitted_property_ids('commentary.edit'))::uuid[])));
create policy commentary_write on public.management_commentary for all to authenticated
  using ((property_id is not null and property_id = any ((select app.permitted_property_ids('commentary.edit'))::uuid[]))
         or (property_id is null and company_id = any ((select app.permitted_company_ids('commentary.edit'))::uuid[])))
  with check ((property_id is not null and property_id = any ((select app.permitted_property_ids('commentary.edit'))::uuid[]))
         or (property_id is null and company_id = any ((select app.permitted_company_ids('commentary.edit'))::uuid[])));

grant select on public.reporting_packages to authenticated;
grant update (title, summary) on public.reporting_packages to authenticated;
create policy packages_read_published on public.reporting_packages for select to authenticated
  using (status in ('published', 'superseded') and property_id = any ((select app.permitted_property_ids('reports.view'))::uuid[]));
create policy packages_read_edit on public.reporting_packages for select to authenticated
  using (property_id = any ((select app.permitted_property_ids('reports.edit'))::uuid[]));
create policy packages_update on public.reporting_packages for update to authenticated
  using (status = 'draft' and property_id = any ((select app.permitted_property_ids('reports.edit'))::uuid[]))
  with check (property_id = any ((select app.permitted_property_ids('reports.edit'))::uuid[]));

grant select, delete on public.reporting_package_items to authenticated;
create policy package_items_read on public.reporting_package_items for select to authenticated
  using (exists (select 1 from public.reporting_packages p where p.id = reporting_package_items.package_id));
create policy package_items_delete on public.reporting_package_items for delete to authenticated
  using (exists (select 1 from public.reporting_packages p where p.id = reporting_package_items.package_id
                 and p.property_id = any ((select app.permitted_property_ids('reports.edit'))::uuid[])));
-- No client access to snapshots (read through get_reporting_package()).

create trigger audit_capex_projects after insert or update on public.capex_projects
  for each row execute function app.audit_row_change();
create trigger audit_capex_thresholds after insert or update or delete on public.capex_approval_thresholds
  for each row execute function app.audit_row_change();
create trigger audit_capex_transactions after insert or update on public.capex_transactions
  for each row execute function app.audit_row_change();
