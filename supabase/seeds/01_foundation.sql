-- =============================================================================
-- DEMO SEED DATA — entirely fictional. Never load into staging/production with
-- real customers. Companies are flagged is_demo = true and the UI shows a
-- "Demo data" banner for them.
-- All demo users share the password: DemoPass!2026
-- =============================================================================

create schema if not exists seed;

create or replace function seed.user(p_id uuid, p_email text, p_name text) returns void
language sql as $$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
    email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email,
    extensions.crypt('DemoPass!2026', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', p_name), now(), now(), '', '', '', '');
  insert into auth.identities (user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (p_id, p_id::text, jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true),
    'email', now(), now(), now());
$$;

-- Users -----------------------------------------------------------------------
select seed.user('30000000-0000-4000-8000-000000000001', 'platform@portal.example', 'Pat Platform');
select seed.user('30000000-0000-4000-8000-000000000011', 'admin@harborview.example', 'Hannah Admin');
select seed.user('30000000-0000-4000-8000-000000000012', 'finance@harborview.example', 'Felix Finance');
select seed.user('30000000-0000-4000-8000-000000000013', 'ops@harborview.example', 'Opal Operations');
select seed.user('30000000-0000-4000-8000-000000000014', 'gm.seattle@harborview.example', 'Gabriel Manager');
select seed.user('30000000-0000-4000-8000-000000000021', 'olivia.owner@owners.example', 'Olivia Chen');
select seed.user('30000000-0000-4000-8000-000000000022', 'ian.investor@owners.example', 'Ian Investor');
select seed.user('30000000-0000-4000-8000-000000000023', 'revoked.owner@owners.example', 'Rita Revoked');
select seed.user('30000000-0000-4000-8000-000000000031', 'admin@summitpeak.example', 'Sam Summit');
select seed.user('30000000-0000-4000-8000-000000000032', 'finance@summitpeak.example', 'Fiona Peak');

insert into public.platform_admins (user_id) values ('30000000-0000-4000-8000-000000000001');

-- Companies -------------------------------------------------------------------
insert into public.companies (id, slug, name, legal_name, require_mfa_for_privileged, is_demo) values
  ('10000000-0000-4000-8000-000000000001', 'harborview', 'Harborview Hospitality Group', 'Harborview Hospitality Group LLC (fictional)', false, true),
  ('10000000-0000-4000-8000-000000000002', 'summit', 'Summit Peak Hotel Partners', 'Summit Peak Hotel Partners Inc. (fictional)', false, true);

insert into public.company_branding (company_id, portal_name, logo_url, logo_mark_url, favicon_url,
  primary_color, accent_color, surface_color, login_headline, login_message, support_email, email_from_name, report_footer) values
  ('10000000-0000-4000-8000-000000000001', 'Harborview Owner Portal', '/brands/harborview/logo.svg', '/brands/harborview/mark.svg', '/brands/harborview/favicon.svg',
   '#0f3d5e', '#2bb3a3', '#f3f7f9', 'Your portfolio, clearly.', 'Secure access for Harborview owners, investors and corporate teams.',
   'owner-support@harborview.example', 'Harborview Hospitality', 'Prepared by Harborview Hospitality Group. Confidential — for authorized recipients only.'),
  ('10000000-0000-4000-8000-000000000002', 'Summit Peak Investor Center', '/brands/summit/logo.svg', '/brands/summit/mark.svg', '/brands/summit/favicon.svg',
   '#1f4d3a', '#c27c3e', '#f6f5f1', 'Performance at altitude.', 'Investor and ownership reporting for Summit Peak hotels.',
   'investors@summitpeak.example', 'Summit Peak Hotel Partners', 'Summit Peak Hotel Partners — confidential owner reporting.');

insert into public.company_domains (company_id, hostname, is_primary, verification_status) values
  ('10000000-0000-4000-8000-000000000001', 'harborview.localhost:5173', true, 'verified'),
  ('10000000-0000-4000-8000-000000000001', 'harborview.localhost', false, 'verified'),
  ('10000000-0000-4000-8000-000000000001', 'owners.harborview.example', false, 'pending'),
  ('10000000-0000-4000-8000-000000000002', 'summit.localhost:5173', true, 'verified'),
  ('10000000-0000-4000-8000-000000000002', 'summit.localhost', false, 'verified');

insert into public.company_modules (company_id, module, enabled)
select c.id, m, not (c.slug = 'summit' and m = 'ingestion')
from public.companies c cross join unnest(enum_range(null::public.portal_module)) m;

-- Properties ------------------------------------------------------------------
insert into public.properties (id, company_id, code, name, brand, address_line1, city, region, country, timezone, opened_on) values
  ('20000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000001', 'HV-SEA', 'Harborview Seattle Waterfront', 'Independent', '1 Fictional Pier Way', 'Seattle', 'WA', 'US', 'America/Los_Angeles', '2015-06-01'),
  ('20000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000001', 'HV-PDX', 'Harborview Portland Pearl', 'Independent', '22 Imaginary Ave', 'Portland', 'OR', 'US', 'America/Los_Angeles', '2018-03-15'),
  ('20000000-0000-4000-8000-000000000103', '10000000-0000-4000-8000-000000000001', 'HV-SFO', 'Embarcadero Inn by Harborview', 'Independent', '300 Example St', 'San Francisco', 'CA', 'US', 'America/Los_Angeles', '2012-09-01'),
  ('20000000-0000-4000-8000-000000000104', '10000000-0000-4000-8000-000000000001', 'HV-HNL', 'Harborview Waikiki', 'Independent', '44 Sample Blvd', 'Honolulu', 'HI', 'US', 'Pacific/Honolulu', '2019-11-20'),
  ('20000000-0000-4000-8000-000000000201', '10000000-0000-4000-8000-000000000002', 'SP-DEN', 'Summit Denver Union Station', 'Summit Collection', '1600 Placeholder St', 'Denver', 'CO', 'US', 'America/Denver', '2016-04-01'),
  ('20000000-0000-4000-8000-000000000202', '10000000-0000-4000-8000-000000000002', 'SP-AUS', 'Summit Austin Riverside', 'Summit Collection', '9 Demo Dr', 'Austin', 'TX', 'US', 'America/Chicago', '2020-02-01'),
  ('20000000-0000-4000-8000-000000000203', '10000000-0000-4000-8000-000000000002', 'SP-MIA', 'Summit Miami Brickell', 'Summit Collection', '77 Mock Ave', 'Miami', 'FL', 'US', 'America/New_York', '2021-12-01');

-- Room inventory history (Portland added a 12-room wing on 2026-03-01).
insert into public.room_inventory_history (company_id, property_id, effective_from, effective_to, room_count, reason) values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '2015-06-01', null, 220, 'Opening inventory'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', '2018-03-15', '2026-03-01', 148, 'Opening inventory'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', '2026-03-01', null, 160, 'New wing (12 rooms)'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', '2012-09-01', null, 180, 'Opening inventory'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000104', '2019-11-20', null, 300, 'Opening inventory'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000201', '2016-04-01', null, 250, 'Opening inventory'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000202', '2020-02-01', null, 190, 'Opening inventory'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000203', '2021-12-01', null, 210, 'Opening inventory');

-- Ownership (legal) -------------------------------------------------------------
insert into public.ownership_groups (id, company_id, name, entity_type) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Chen Family Holdings LLC', 'LLC'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Cascade Hotel Fund II LP', 'LP'),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Bay Lodging Partners LLC', 'LLC'),
  ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'Chen Family Holdings LLC', 'LLC'),
  ('40000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', 'Front Range Capital LP', 'LP');

insert into public.ownership_group_members (company_id, ownership_group_id, member_name, member_type, interest_pct, user_id) values
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Olivia Chen', 'owner', 100, '30000000-0000-4000-8000-000000000021'),
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'Ian Investor', 'limited_partner', 12.5, '30000000-0000-4000-8000-000000000022'),
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'Cascade GP LLC', 'general_partner', 1, null),
  ('10000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000004', 'Olivia Chen', 'owner', 100, '30000000-0000-4000-8000-000000000021');

-- Multiple owners per property, effective dated.
insert into public.property_ownerships (company_id, property_id, ownership_group_id, ownership_pct, effective_from) values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000001', 60, '2015-06-01'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000002', 40, '2015-06-01'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000102', '40000000-0000-4000-8000-000000000001', 100, '2018-03-15'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000103', '40000000-0000-4000-8000-000000000003', 100, '2012-09-01'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000104', '40000000-0000-4000-8000-000000000002', 100, '2019-11-20'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000201', '40000000-0000-4000-8000-000000000004', 35, '2016-04-01'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000201', '40000000-0000-4000-8000-000000000005', 65, '2016-04-01'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000202', '40000000-0000-4000-8000-000000000005', 100, '2020-02-01'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000203', '40000000-0000-4000-8000-000000000005', 100, '2021-12-01');

-- Memberships -----------------------------------------------------------------
insert into public.company_memberships (id, company_id, user_id, role, all_properties, title) values
  ('50000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000011', 'company_admin', true, 'VP, Asset Management'),
  ('50000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000012', 'corporate_finance', true, 'Corporate Controller'),
  ('50000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000013', 'corporate_operations', true, 'Regional Director of Operations'),
  ('50000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000014', 'property_manager', false, 'General Manager, Seattle'),
  ('50000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000021', 'owner', false, null),
  ('50000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000022', 'investor', false, null),
  ('50000000-0000-4000-8000-000000000023', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000023', 'owner', false, null),
  ('50000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000031', 'company_admin', true, 'Chief Operating Officer'),
  ('50000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000032', 'corporate_finance', true, 'Director of Finance'),
  -- Olivia also owns a Summit-managed hotel: one login, two companies.
  ('50000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000021', 'owner', false, null);

insert into public.property_access_grants (company_id, membership_id, property_id, permissions) values
  ('10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000101', null),
  -- Olivia: Seattle + Portland only (NOT San Francisco or Waikiki).
  ('10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000101', null),
  ('10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000102', null),
  -- Ian: Seattle only, and restricted to performance + published reports.
  ('10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000101',
     array['performance.view', 'reports.view', 'commentary.view', 'documents.view']),
  ('10000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000041', '20000000-0000-4000-8000-000000000201', null);

-- Rita had Seattle access which was revoked; her membership is revoked too.
insert into public.property_access_grants (company_id, membership_id, property_id, revoked_at)
values ('10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000023', '20000000-0000-4000-8000-000000000101', now() - interval '10 days');
update public.company_memberships set status = 'revoked', revoked_at = now() - interval '10 days', revoke_reason = 'Sold ownership interest'
where id = '50000000-0000-4000-8000-000000000023';
