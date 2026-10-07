import { hostCandidates, NEUTRAL_THEME, themeCssVariables, type BrandTheme } from '@hop/core';
import { supabase } from './supabase';

export interface HostBranding {
  company_id: string;
  company_slug: string;
  company_name: string;
  portal_name: string;
  logo_url: string | null;
  logo_mark_url: string | null;
  favicon_url: string | null;
  primary_color: string;
  accent_color: string;
  surface_color: string;
  login_headline: string | null;
  login_message: string | null;
  support_email: string | null;
  is_demo: boolean;
}

/**
 * Resolve presentation-only branding for the current host. Local development uses
 * *.localhost hosts (e.g. harborview.localhost:5173). The result never grants access.
 */
export async function resolveHostBranding(): Promise<HostBranding | null> {
  const override = import.meta.env.VITE_DEV_BRAND_HOST;
  const host = override || window.location.host;
  for (const candidate of hostCandidates(host)) {
    const { data } = await supabase.rpc('resolve_branding', { p_host: candidate });
    if (data) return data as HostBranding;
  }
  return null;
}

export function toTheme(b: Partial<HostBranding> | null | undefined): BrandTheme {
  if (!b || !b.primary_color) return NEUTRAL_THEME;
  return {
    portalName: b.portal_name ?? NEUTRAL_THEME.portalName,
    primaryColor: b.primary_color,
    accentColor: b.accent_color ?? NEUTRAL_THEME.accentColor,
    surfaceColor: b.surface_color ?? NEUTRAL_THEME.surfaceColor,
    logoUrl: b.logo_url,
    logoMarkUrl: b.logo_mark_url,
    faviconUrl: b.favicon_url,
  };
}

export function applyTheme(theme: BrandTheme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeCssVariables(theme))) root.style.setProperty(k, v);
  document.title = theme.portalName;
  const icon = document.getElementById('favicon') as HTMLLinkElement | null;
  if (icon) icon.href = theme.faviconUrl ?? '/brands/default/favicon.svg';
}
