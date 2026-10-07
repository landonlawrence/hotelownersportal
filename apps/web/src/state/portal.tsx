import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionSet, type Permission } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { applyTheme, resolveHostBranding, toTheme, type HostBranding } from '../lib/tenant';

export interface CompanyContext {
  company_id: string;
  company_slug: string;
  company_name: string;
  is_demo: boolean;
  access: 'membership' | 'support_session';
  membership_id?: string;
  support_session_id?: string;
  support_expires_at?: string;
  role: string | null;
  all_properties: boolean;
  require_mfa_for_privileged?: boolean;
  branding: (Partial<HostBranding> & { report_footer?: string | null }) | null;
  modules: Record<string, boolean>;
  company_permissions: string[];
  mfa_blocked_permissions: string[];
}

export interface PortalContextData {
  user_id: string;
  email: string;
  full_name: string | null;
  aal: string;
  is_platform_admin: boolean;
  cross_company_rollups_enabled: boolean;
  companies: CompanyContext[];
}

export interface Property {
  id: string;
  company_id: string;
  code: string;
  name: string;
  city: string | null;
  region: string | null;
  timezone: string;
  status: string;
  opened_on: string | null;
  brand: string | null;
  currency: string;
}

interface PortalState {
  session: Session | null;
  sessionLoading: boolean;
  hostBranding: HostBranding | null | undefined;
  ctx: PortalContextData | undefined;
  ctxLoading: boolean;
  company: CompanyContext | undefined;
  setCompanyId: (id: string) => void;
  properties: Property[];
  perms: PermissionSet;
  can: (perm: Permission, propertyId?: string) => boolean;
  canAny: (perm: Permission) => boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<PortalState | null>(null);
const storageKey = (uid: string) => `hop.activeCompany.${uid}`;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

export function PortalProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [companyId, setCompanyIdState] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Drop all cached data on sign-out (keep presentation-only host branding).
      if (event === 'SIGNED_OUT') qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'host-branding' });
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  const hostQ = useQuery({ queryKey: ['host-branding'], queryFn: resolveHostBranding, staleTime: Infinity });

  const ctxQ = useQuery({
    queryKey: ['my-context', session?.user.id, session?.access_token ? 'auth' : 'anon'],
    enabled: !!session,
    queryFn: async () => unwrap(await supabase.rpc('my_context')) as PortalContextData,
  });

  const ctx = ctxQ.data;
  const company = useMemo(() => {
    if (!ctx || ctx.companies.length === 0) return undefined;
    const stored = companyId ?? safeGet(storageKey(ctx.user_id));
    return (
      ctx.companies.find((c) => c.company_id === stored) ??
      ctx.companies.find((c) => c.company_id === hostQ.data?.company_id) ??
      ctx.companies[0]
    );
  }, [ctx, companyId, hostQ.data]);

  const propsQ = useQuery({
    queryKey: ['properties', company?.company_id],
    enabled: !!company,
    queryFn: async () =>
      unwrap(
        await supabase
          .from('properties')
          .select('id, company_id, code, name, city, region, timezone, status, opened_on, brand, currency')
          .eq('company_id', company!.company_id)
          .order('name'),
      ) as Property[],
  });

  const permsQ = useQuery({
    queryKey: ['property-permissions', company?.company_id, ctx?.aal],
    enabled: !!company,
    queryFn: async () =>
      unwrap(await supabase.rpc('my_property_permissions', { p_company_id: company!.company_id })) as Array<{ property_id: string; permission_key: string }>,
  });

  const perms = useMemo(() => new PermissionSet(company?.company_permissions ?? [], permsQ.data ?? []), [company, permsQ.data]);

  // Branding: the active company's branding once signed in, otherwise the host's.
  useEffect(() => {
    applyTheme(toTheme(company?.branding ?? hostQ.data ?? null));
  }, [company, hostQ.data]);

  const value: PortalState = {
    session,
    sessionLoading,
    hostBranding: hostQ.data,
    ctx,
    ctxLoading: ctxQ.isLoading,
    company,
    setCompanyId: (id) => {
      if (ctx) safeSet(storageKey(ctx.user_id), id);
      setCompanyIdState(id);
      // Never mix data from different companies in caches.
      qc.removeQueries({ predicate: (q) => !['my-context', 'host-branding'].includes(String(q.queryKey[0])) });
    },
    properties: propsQ.data ?? [],
    perms,
    can: (perm, propertyId) => perms.has(perm, propertyId),
    canAny: (perm) => perms.any(perm) || (/^(admin|audit|ingestion)\./.test(perm) && perms.has(perm)),
    refresh: async () => {
      await qc.invalidateQueries();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePortal(): PortalState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePortal outside provider');
  return v;
}

/** Active company (guaranteed inside the authenticated shell). */
export function useCompany(): CompanyContext {
  const { company } = usePortal();
  if (!company) throw new Error('No active company');
  return company;
}
