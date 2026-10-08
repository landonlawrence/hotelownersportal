-- Product decision (2026-10-08): the portal will not integrate with Travera.
-- Remove the integration kind so no connection can be configured for it.
delete from public.integration_connections where kind = 'travera';
alter table public.integration_connections drop constraint if exists integration_connections_kind_check;
alter table public.integration_connections add constraint integration_connections_kind_check check (kind in ('pms', 'accounting'));
