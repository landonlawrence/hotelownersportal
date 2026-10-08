import { Hono } from 'hono';
import { z } from 'zod';
import {
  computeKpis,
  formatNumber,
  isIsoDate,
  rowToComponents,
  summarizePeriod,
  toCsv,
  type RollupRow,
} from '@hop/core';
import type { AppEnv } from '../context.js';
import { badRequest, forbidden, fromPostgrest, notFound } from '../errors.js';
import { requireUser } from '../middleware.js';
import { serviceClient } from '../supabase.js';
import { renderPackagePdf, renderStatementPdf, type PackageInput } from '../pdf/statements.js';
import type { Branding } from '../pdf/document.js';

export const exportsRoute = new Hono<AppEnv>();
exportsRoute.use('*', requireUser);

async function brandingFor(db: import('@supabase/supabase-js').SupabaseClient, companyId: string) {
  const { data } = await db.from('company_branding').select('portal_name, report_footer, primary_color, accent_color').eq('company_id', companyId).maybeSingle();
  return (data as { portal_name: string; report_footer: string | null; primary_color: string; accent_color: string } | null) ?? { portal_name: 'Owner Portal', report_footer: null, primary_color: '#1f2937', accent_color: '#2563eb' };
}

async function pdfBranding(db: import('@supabase/supabase-js').SupabaseClient, companyId: string): Promise<Branding> {
  const b = await brandingFor(db, companyId);
  const { data } = await db.from('companies').select('name').eq('id', companyId).maybeSingle();
  return { portalName: b.portal_name, companyName: (data as { name: string } | null)?.name ?? '', primaryColor: b.primary_color, accentColor: b.accent_color, reportFooter: b.report_footer };
}

function pdfResponse(bytes: Uint8Array, filename: string) {
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'no-store',
    },
  });
}

const monthLabel = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));

function csvResponse(body: string, filename: string) {
  return new Response(`\uFEFF${body}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'no-store',
    },
  });
}

const fmt = (v: number | null, d = 2) => (v === null ? '' : v.toFixed(d));

/**
 * Performance export. Every query runs as the user (RLS). Requested properties
 * are additionally checked explicitly so a forbidden property yields 403 rather
 * than a silently filtered file.
 */
exportsRoute.get('/performance.csv', async (c) => {
  const q = z
    .object({
      company_id: z.string().uuid(),
      from: z.string().refine(isIsoDate),
      to: z.string().refine(isIsoDate),
      grain: z.enum(['day', 'month', 'total']).default('total'),
      property_ids: z.string().optional(),
    })
    .safeParse(c.req.query());
  if (!q.success || q.data.from > q.data.to) throw badRequest('company_id, from, to (YYYY-MM-DD) are required');
  const db = c.get('db');
  const { company_id, from, to, grain } = q.data;
  const requested = q.data.property_ids ? q.data.property_ids.split(',').filter(Boolean) : null;
  if (requested && !requested.every((id) => z.string().uuid().safeParse(id).success)) throw badRequest('invalid property_ids');

  const { data: canView, error: permErr } = await db.rpc('check_permission', { p_perm: 'performance.view', p_company_id: company_id, p_property_id: null });
  if (permErr) throw fromPostgrest(permErr);
  if (!canView) throw forbidden('No access to this company');
  if (requested) {
    for (const pid of requested) {
      const { data: ok } = await db.rpc('check_permission', { p_perm: 'performance.view', p_company_id: company_id, p_property_id: pid });
      if (!ok) throw forbidden('No access to one or more requested properties');
    }
  }
  const { data: props, error: propErr } = await db.from('properties').select('id, code, name, opened_on, status').eq('company_id', company_id).order('code');
  if (propErr) throw fromPostgrest(propErr);
  let properties = (props ?? []) as Array<{ id: string; code: string; name: string; opened_on: string | null; status: string }>;
  if (requested) properties = properties.filter((p) => requested.includes(p.id));
  const { data: rows, error } = await db.rpc('performance_rollup', {
    p_company_id: company_id,
    p_from: from,
    p_to: to,
    p_grain: grain,
    p_property_ids: properties.map((p) => p.id),
  });
  if (error) throw fromPostgrest(error);
  const rollup = (rows ?? []) as RollupRow[];
  const brand = await brandingFor(db, company_id);
  const byId = new Map(properties.map((p) => [p.id, p]));

  const out: Array<Array<string | number | null>> = [
    [brand.portal_name],
    [`Operating performance ${from} to ${to} (provisional daily figures)`],
    [`Generated ${new Date().toISOString()}`],
    [],
    ['property_code', 'property_name', 'period', 'available_room_nights', 'rooms_sold', 'occupancy_pct', 'adr', 'revpar', 'room_revenue', 'total_revenue', 'reported_days'],
  ];
  for (const r of rollup.sort((a, b) => (byId.get(a.property_id)?.code ?? '').localeCompare(byId.get(b.property_id)?.code ?? '') || a.bucket.localeCompare(b.bucket))) {
    const p = byId.get(r.property_id);
    if (!p) continue;
    const k = computeKpis(rowToComponents(r));
    out.push([p.code, p.name, grain === 'total' ? `${from}..${to}` : r.bucket, k.availableRoomNights, k.roomsSold, fmt(k.occupancyPct, 1), fmt(k.adr), fmt(k.revpar), fmt(k.roomRevenue), fmt(k.totalRevenue), r.reported_days]);
  }
  if (grain === 'total') {
    const s = summarizePeriod(rollup, properties.map((p) => ({ id: p.id, openedOn: p.opened_on, status: p.status })), { from, to }, to);
    out.push([
      'PORTFOLIO',
      s.partial ? `Partial coverage: ${s.coverage.reportedDays}/${s.coverage.expectedDays} property-days` : 'All properties',
      `${from}..${to}`,
      s.kpis.availableRoomNights,
      s.kpis.roomsSold,
      fmt(s.kpis.occupancyPct, 1),
      fmt(s.kpis.adr),
      fmt(s.kpis.revpar),
      fmt(s.kpis.roomRevenue),
      fmt(s.kpis.totalRevenue),
      s.coverage.reportedDays,
    ]);
  }
  out.push([], ['Occupancy = rooms sold / available room nights; ADR = room revenue / rooms sold; RevPAR = room revenue / available room nights. Blank = unavailable.']);
  if (brand.report_footer) out.push([brand.report_footer]);

  const svc = await serviceClient();
  await svc.rpc('svc_audit', {
    p_company_id: company_id,
    p_action: 'export.performance',
    p_entity_type: 'export',
    p_entity_id: null,
    p_metadata: { from, to, grain, properties: properties.map((p) => p.code) },
    p_property_id: null,
    p_actor: c.get('auth').userId,
  });
  return csvResponse(toCsv(out), `performance_${from}_${to}.csv`);
});

/** Financial statement export: only reports visible to the user (drafts require view_draft via RLS). */
exportsRoute.get('/financial-reports/:id', async (c) => {
  const raw = c.req.param('id');
  const asPdf = raw.endsWith('.pdf');
  const id = raw.replace(/\.(csv|pdf)$/, '');
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  const db = c.get('db');
  const { data: report } = await db
    .from('financial_reports')
    .select('id, company_id, property_id, period_month, title, revision, status, published_at, correction_reason, properties(code, name, currency)')
    .eq('id', id)
    .maybeSingle();
  if (!report) throw notFound('Report not found');
  const r = report as unknown as {
    id: string; company_id: string; property_id: string; period_month: string; title: string; revision: number; status: string;
    published_at: string | null; properties: { code: string; name: string; currency: string };
  };
  const { data: lines, error } = await db.rpc('financial_report_statement', { p_report_id: id });
  if (error) throw fromPostgrest(error);
  if (asPdf) {
    const [{ data: accounts }, { data: budgetRows }] = await Promise.all([
      db.from('financial_accounts').select('id, code, name, nature, section, sort_order').eq('company_id', r.company_id),
      db.rpc('budget_monthly', { p_company_id: r.company_id, p_from: r.period_month, p_to: r.period_month }),
    ]);
    const actual = new Map<string, number>();
    for (const l of (lines ?? []) as Array<{ account_id: string; amount: number }>) actual.set(l.account_id, Number(l.amount));
    const budget = new Map<string, number>();
    for (const b of (budgetRows ?? []) as Array<{ property_id: string; account_id: string; amount: number }>) if (b.property_id === r.property_id) budget.set(b.account_id, Number(b.amount));
    const bytes = await renderStatementPdf({
      brand: await pdfBranding(db, r.company_id),
      propertyName: r.properties.name,
      propertyCode: r.properties.code,
      periodLabel: monthLabel(r.period_month),
      title: r.title,
      status: r.status,
      revision: r.revision,
      publishedAt: r.published_at,
      correctionReason: (report as { correction_reason?: string | null }).correction_reason ?? null,
      currency: r.properties.currency,
      accounts: (accounts ?? []) as never,
      actual,
      budget,
      generatedFor: c.get('auth').email ?? c.get('auth').userId,
    });
    await (await serviceClient()).rpc('svc_audit', {
      p_company_id: r.company_id, p_action: 'export.financial_report_pdf', p_entity_type: 'financial_report', p_entity_id: r.id,
      p_metadata: { status: r.status, revision: r.revision }, p_property_id: r.property_id, p_actor: c.get('auth').userId,
    });
    return pdfResponse(bytes, `${r.properties.code}_${r.period_month.slice(0, 7)}_rev${r.revision}.pdf`);
  }
  const brand = await brandingFor(db, r.company_id);
  const statement = ((lines ?? []) as Array<{ code: string; name: string; section: string; nature: string; sort_order: number; amount: number }>).sort((a, b) => a.sort_order - b.sort_order);
  const out: Array<Array<string | number | null>> = [
    [brand.portal_name],
    [`${r.properties.name} (${r.properties.code}) — ${r.title}`],
    [`Status: ${r.status.toUpperCase()}${r.status !== 'published' ? ' — NOT FOR DISTRIBUTION' : ''}; revision ${r.revision}${r.published_at ? `; published ${r.published_at.slice(0, 10)}` : ''}`],
    [],
    ['section', 'account_code', 'account_name', 'amount'],
    ...statement.map((l) => [l.section, l.code, l.name, l.nature === 'statistic' ? formatNumber(Number(l.amount)) : Number(l.amount).toFixed(2)]),
  ];
  if (brand.report_footer) out.push([], [brand.report_footer]);
  const svc = await serviceClient();
  await svc.rpc('svc_audit', {
    p_company_id: r.company_id,
    p_action: 'export.financial_report',
    p_entity_type: 'financial_report',
    p_entity_id: r.id,
    p_metadata: { status: r.status, revision: r.revision },
    p_property_id: r.property_id,
    p_actor: c.get('auth').userId,
  });
  return csvResponse(toCsv(out), `${r.properties.code}_${r.period_month.slice(0, 7)}_rev${r.revision}.csv`);
});

/** Owner reporting package PDF. The filtered snapshot comes from get_reporting_package() as the user. */
exportsRoute.get('/packages/:id', async (c) => {
  const id = c.req.param('id').replace(/\.pdf$/, '');
  if (!z.string().uuid().safeParse(id).success) throw notFound();
  const db = c.get('db');
  const { data, error } = await db.rpc('get_reporting_package', { p_package_id: id });
  if (error) throw fromPostgrest(error);
  const pkgData = data as { package: { id: string; company_id: string; property_id: string; title: string; status: string; revision: number; published_at: string | null; correction_reason: string | null; period_month: string }; snapshot: PackageInput['snapshot'] | null } | null;
  if (!pkgData?.snapshot) throw notFound('Report not found');
  const { package: pkg, snapshot } = pkgData;
  const { data: prop } = await db.from('properties').select('currency').eq('id', pkg.property_id).maybeSingle();
  const bytes = await renderPackagePdf({
    brand: await pdfBranding(db, pkg.company_id),
    title: pkg.title,
    status: pkg.status,
    revision: pkg.revision,
    publishedAt: pkg.published_at,
    correctionReason: pkg.correction_reason,
    periodLabel: monthLabel(pkg.period_month),
    currency: (prop as { currency: string } | null)?.currency ?? 'USD',
    snapshot,
    generatedFor: c.get('auth').email ?? c.get('auth').userId,
  });
  await (await serviceClient()).rpc('svc_audit', {
    p_company_id: pkg.company_id, p_action: 'export.reporting_package_pdf', p_entity_type: 'reporting_package', p_entity_id: pkg.id,
    p_metadata: { revision: pkg.revision, status: pkg.status }, p_property_id: pkg.property_id, p_actor: c.get('auth').userId,
  });
  return pdfResponse(bytes, `${snapshot.property.code}_${pkg.period_month.slice(0, 7)}_owner_report_rev${pkg.revision}.pdf`);
});
