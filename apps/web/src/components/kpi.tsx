import { formatCurrency, formatFraction, formatPercent, formatPoints, kpiDelta, type Coverage, type Freshness } from '@hop/core';
import { Badge } from './ui';

export type KpiKind = 'pct' | 'money' | 'money_cents' | 'count';

export function fmtKpi(v: number | null, kind: KpiKind, currency = 'USD'): string {
  if (kind === 'pct') return formatPercent(v);
  if (kind === 'money') return formatCurrency(v, currency, { compact: v !== null && Math.abs(v) >= 1_000_000 });
  if (kind === 'money_cents') return formatCurrency(v, currency, { cents: true });
  return v === null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(v));
}

function DeltaLine({ label, current, comparison, kind }: { label: string; current: number | null; comparison: number | null; kind: KpiKind }) {
  const d = kpiDelta(current, comparison, kind === 'pct');
  if (d.change === null) return <span className="delta-flat">{label}: unavailable</span>;
  const good = d.change > 0;
  const cls = d.change === 0 ? 'delta-flat' : good ? 'delta-good' : 'delta-bad';
  const arrow = d.change === 0 ? '→' : good ? '▲' : '▼';
  const text = kind === 'pct' ? formatPoints(d.change) : formatFraction(d.changePct, 1, true);
  return (
    <span className={cls}>
      <span aria-hidden>{arrow}</span> {text} <span className="muted">{label}</span>
    </span>
  );
}

export function KpiCard({
  label,
  value,
  kind,
  priorYear,
  budget,
  currency,
  partial,
  hint,
  comparisonNote,
}: {
  label: string;
  value: number | null;
  kind: KpiKind;
  priorYear?: number | null;
  budget?: number | null;
  currency?: string;
  partial?: boolean;
  hint?: string;
  /** Replaces comparisons when they would be misleading (e.g. totals with partial coverage). */
  comparisonNote?: string;
}) {
  return (
    <div className="card kpi" title={hint}>
      <div className="spread">
        <span className="label">{label}</span>
        {partial && <Badge tone="warn">partial</Badge>}
      </div>
      <span className="value">{fmtKpi(value, kind, currency)}</span>
      <div className="deltas">
        {comparisonNote && <span className="delta-flat">{comparisonNote}</span>}
        {!comparisonNote && priorYear !== undefined && <DeltaLine label="vs prior year" current={value} comparison={priorYear} kind={kind} />}
        {!comparisonNote && budget !== undefined && <DeltaLine label="vs budget" current={value} comparison={budget} kind={kind} />}
      </div>
    </div>
  );
}

export function CoverageBadge({ coverage }: { coverage: Coverage }) {
  if (coverage.expectedDays === 0) return <Badge tone="neutral">No data expected</Badge>;
  if (coverage.complete) return <Badge tone="good">✓ Complete</Badge>;
  return (
    <Badge tone="warn" title={`${coverage.reportedDays} of ${coverage.expectedDays} property-days reported`}>
      ! {coverage.reportedDays}/{coverage.expectedDays} days
    </Badge>
  );
}

const FRESH_LABEL: Record<Freshness['status'], string> = {
  current: 'Current',
  pending: 'Due today',
  late: 'Late',
  stale: 'Stale',
  no_data: 'No data',
};

export function FreshnessBadge({ f }: { f: Freshness }) {
  const tone = f.status === 'current' ? 'good' : f.status === 'pending' ? 'info' : f.status === 'late' ? 'warn' : 'bad';
  const icon = tone === 'good' ? '✓' : tone === 'bad' ? '✕' : '!';
  const title = f.latestBusinessDate
    ? `Latest business date ${f.latestBusinessDate}; expected ${f.expectedBusinessDate}${f.lagDays ? ` (${f.lagDays} day(s) behind)` : ''}`
    : 'No operating data loaded';
  return (
    <Badge tone={tone} title={title}>
      <span aria-hidden>{icon}</span> {FRESH_LABEL[f.status]}
      {f.lagDays ? ` · ${f.lagDays}d` : ''}
    </Badge>
  );
}
