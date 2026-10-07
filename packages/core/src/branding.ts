/** Branding helpers (host normalisation, accessible text colours). */

export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** Hosts to try, most specific first: "a.b.com:5173" → ["a.b.com:5173", "a.b.com"]. */
export function hostCandidates(host: string): string[] {
  const h = normaliseHost(host);
  const noPort = h.replace(/:\d+$/, '');
  return h === noPort ? [h] : [h, noPort];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Invalid colour ${hex}`);
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Pick black or white text for a background to meet WCAG contrast. */
export function readableTextColor(background: string): '#ffffff' | '#111827' {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#111827') ? '#ffffff' : '#111827';
}

export interface BrandTheme {
  portalName: string;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  logoUrl?: string | null;
  logoMarkUrl?: string | null;
  faviconUrl?: string | null;
}

export const NEUTRAL_THEME: BrandTheme = {
  portalName: 'Owner Portal',
  primaryColor: '#1f2937',
  accentColor: '#2563eb',
  surfaceColor: '#f5f6f8',
};

export function themeCssVariables(t: BrandTheme): Record<string, string> {
  return {
    '--brand-primary': t.primaryColor,
    '--brand-on-primary': readableTextColor(t.primaryColor),
    '--brand-accent': t.accentColor,
    '--brand-on-accent': readableTextColor(t.accentColor),
    '--brand-surface': t.surfaceColor,
  };
}
