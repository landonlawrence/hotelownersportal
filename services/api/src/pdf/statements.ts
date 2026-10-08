import {
  buildStatement,
  computeKpis,
  formatCurrency,
  formatFraction,
  formatNumber,
  formatPercent,
  formatPoints,
  kpiDelta,
  REMAINING_FUNDS_DEFINITION,
  type Account,
  type StatementRow,
} from '@hop/core';
import { BrandedPdf, type Branding, type Column, type TableRow } from './document.js';

const money = (v: number | null, c: string) => formatCurrency(v, c);

function statementRows(rows: StatementRow[], statistics: StatementRow[], currency: string, withBudget: boolean): TableRow[] {
  const out: TableRow[] = [];
  if (statistics.length) {
    out.push({ cells: ['Statistics'], style: 'section' });
    for (const s of statistics) {
      out.push({ cells: [s.label, formatNumber(s.actual), ...(withBudget ? [formatNumber(s.budget), s.vsBudget.amount === null ? '-' : formatNumber(s.vsBudget.amount), formatFraction(s.vsBudget.pct, 1, true)] : [])] });
    }
  }
  for (const r of rows) {
    if (r.kind === 'section') out.push({ cells: [r.label], style: 'section' });
    else
      out.push({
        cells: [r.label, money(r.actual, currency), ...(withBudget ? [money(r.budget, currency), money(r.vsBudget.amount, currency), formatFraction(r.vsBudget.pct, 1, true)] : [])],
        style: r.kind === 'subtotal' ? 'bold' : 'normal',
      });
  }
  return out;
}

const STATEMENT_COLUMNS = (withBudget: boolean): Column[] =>
  withBudget
    ? [
        { header: 'Account', width: 0.4 },
        { header: 'Actual', width: 0.16, align: 'right' },
        { header: 'Budget', width: 0.16, align: 'right' },
        { header: 'Var. $', width: 0.16, align: 'right' },
        { header: 'Var. %', width: 0.12, align: 'right' },
      ]
    : [
        { header: 'Account', width: 0.6 },
        { header: 'Actual', width: 0.4, align: 'right' },
      ];

export interface StatementInput {
  brand: Branding;
  propertyName: string;
  propertyCode: string;
  periodLabel: string;
  title: string;
  status: string;
  revision: number;
  publishedAt: string | null;
  correctionReason: string | null;
  currency: string;
  accounts: Account[];
  actual: Map<string, number>;
  budget: Map<string, number>;
  generatedFor: string;
}

export async function renderStatementPdf(i: StatementInput): Promise<Uint8Array> {
  const published = i.status === 'published' || i.status === 'superseded';
  const pdf = await BrandedPdf.create(i.brand, `${i.propertyCode} ${i.title}`, published ? (i.status === 'superseded' ? 'SUPERSEDED' : null) : 'DRAFT - NOT FOR DISTRIBUTION');
  pdf.heading(`${i.propertyName} - ${i.periodLabel}`);
  pdf.line(`${i.title} · Revision ${i.revision} · ${i.status.replace('_', ' ').toUpperCase()}${i.publishedAt ? ` · Published ${i.publishedAt.slice(0, 10)}` : ''}`, { muted: true });
  if (i.correctionReason) pdf.line(`Correction: ${i.correctionReason}`, { muted: true });
  pdf.space(6);
  const { rows, statistics } = buildStatement(i.accounts, i.actual, i.budget, new Map());
  const withBudget = i.budget.size > 0;
  pdf.table(STATEMENT_COLUMNS(withBudget), statementRows(rows, statistics, i.currency, withBudget));
  pdf.line('Variance % = (actual - budget) / |budget|. Revenue above or expenses below budget are favourable. "-" means unavailable. GOP and NOI are derived subtotals.', { size: 7.5, muted: true });
  return pdf.finish(i.generatedFor);
}

interface PerfSnap { available_room_nights: number | null; rooms_sold: number | null; room_revenue: number | null; total_revenue: number | null; reported_days: number; expected_days: number }

export interface PackageInput {
  brand: Branding;
  title: string;
  status: string;
  revision: number;
  publishedAt: string | null;
  correctionReason: string | null;
  periodLabel: string;
  currency: string;
  snapshot: {
    property: { name: string; code: string };
    performance?: PerfSnap;
    performance_prior_year?: PerfSnap;
    financial_report?: { title: string; revision: number } | null;
    budget_variance?: Array<{ account_id: string; code: string; name: string; nature: Account['nature']; section: string; sort_order: number; actual: number | null; budget: number | null }>;
    commentary?: Array<{ section: string; title: string | null; body: string }>;
    capex?: Array<{ number: string; title: string; status: string; approved_budget: number; actual_spend: number; open_commitments: number; remaining: number; percent_complete: number; latest_update: string | null }>;
    documents?: Array<{ title: string }>;
    definitions?: Record<string, string>;
  };
  generatedFor: string;
}

const perfKpis = (p?: PerfSnap) =>
  p && p.reported_days > 0
    ? computeKpis({ availableRoomNights: Number(p.available_room_nights), roomsSold: Number(p.rooms_sold), roomRevenue: Number(p.room_revenue), totalRevenue: p.total_revenue === null ? null : Number(p.total_revenue) })
    : computeKpis(null);

export async function renderPackagePdf(i: PackageInput): Promise<Uint8Array> {
  const s = i.snapshot;
  const published = i.status === 'published' || i.status === 'superseded';
  const pdf = await BrandedPdf.create(i.brand, `${s.property.code} ${i.title}`, published ? (i.status === 'superseded' ? 'SUPERSEDED' : null) : 'PREVIEW - NOT PUBLISHED');
  pdf.heading(`${s.property.name} - ${i.periodLabel}`);
  pdf.line(`${i.title} · Revision ${i.revision}${i.publishedAt ? ` · Published ${i.publishedAt.slice(0, 10)}` : ''}`, { muted: true });
  if (i.correctionReason) pdf.line(`Revision note: ${i.correctionReason}`, { muted: true });
  pdf.space(8);

  if (s.performance) {
    const cur = perfKpis(s.performance);
    const py = perfKpis(s.performance_prior_year);
    const partial = s.performance.reported_days < s.performance.expected_days;
    pdf.subheading('Performance summary');
    pdf.line(`Provisional daily operating figures · ${s.performance.reported_days} of ${s.performance.expected_days} days reported${partial ? ' (incomplete period)' : ''}`, { size: 8, muted: true });
    const pct = (a: number | null, b: number | null) => formatFraction(kpiDelta(a, b).changePct, 1, true);
    pdf.tiles([
      { label: 'Occupancy', value: formatPercent(cur.occupancyPct), note: `${formatPoints(kpiDelta(cur.occupancyPct, py.occupancyPct, true).change)} vs PY` },
      { label: 'ADR', value: formatCurrency(cur.adr, i.currency, { cents: true }), note: `${pct(cur.adr, py.adr)} vs PY` },
      { label: 'RevPAR', value: formatCurrency(cur.revpar, i.currency, { cents: true }), note: `${pct(cur.revpar, py.revpar)} vs PY` },
      { label: 'Total revenue', value: formatCurrency(cur.totalRevenue, i.currency, { compact: true }), note: partial ? 'partial period' : `${pct(cur.totalRevenue, py.totalRevenue)} vs PY` },
    ]);
  }
  if (s.commentary?.length) {
    pdf.subheading('Management commentary');
    for (const c of s.commentary) {
      pdf.line(c.title ?? c.section.replace('_', ' '), { bold: true });
      pdf.line(c.body);
      pdf.space(4);
    }
    pdf.space(6);
  }
  if (s.budget_variance?.length) {
    pdf.subheading(`Budget variances${s.financial_report ? ` (${s.financial_report.title}, revision ${s.financial_report.revision})` : ' (no published statement for this period)'}`);
    const accounts = s.budget_variance.map((b) => ({ id: b.account_id, code: b.code, name: b.name, nature: b.nature, section: b.section, sort_order: b.sort_order }));
    const actual = new Map(s.budget_variance.filter((b) => b.actual !== null).map((b) => [b.account_id, Number(b.actual)]));
    const budget = new Map(s.budget_variance.filter((b) => b.budget !== null).map((b) => [b.account_id, Number(b.budget)]));
    const { rows, statistics } = buildStatement(accounts, actual, budget, new Map());
    pdf.table(STATEMENT_COLUMNS(true), statementRows(rows, statistics, i.currency, true));
  }
  if (s.capex?.length) {
    pdf.subheading('CapEx update');
    pdf.table(
      [
        { header: 'Project', width: 0.34 },
        { header: 'Status', width: 0.14 },
        { header: 'Approved', width: 0.13, align: 'right' },
        { header: 'Spent', width: 0.13, align: 'right' },
        { header: 'Committed', width: 0.13, align: 'right' },
        { header: 'Remaining', width: 0.13, align: 'right' },
      ],
      s.capex.map((c) => ({ cells: [`${c.number} ${c.title} (${c.percent_complete}%)`, c.status.replace('_', ' '), money(Number(c.approved_budget), i.currency), money(Number(c.actual_spend), i.currency), money(Number(c.open_commitments), i.currency), money(Number(c.remaining), i.currency)] })),
    );
    pdf.line(REMAINING_FUNDS_DEFINITION, { size: 7.5, muted: true });
    pdf.space(6);
  }
  if (s.documents?.length) {
    pdf.subheading('Supporting documents (available in the portal)');
    for (const d of s.documents) pdf.line(`- ${d.title}`);
    pdf.space(6);
  }
  if (s.definitions) {
    pdf.subheading('Definitions');
    for (const [k, v] of Object.entries(s.definitions)) pdf.line(`${k.replace(/_/g, ' ')}: ${v}`, { size: 8, muted: true });
  }
  return pdf.finish(i.generatedFor);
}
