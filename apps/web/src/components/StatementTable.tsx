import { formatCurrency, formatFraction, formatNumber, type Variance } from '@hop/core';
import type { StatementRow } from '../lib/statement';

function VarianceCells({ v, currency }: { v: Variance; currency: string }) {
  const cls = v.favourable === null ? '' : v.favourable ? 'delta-good' : 'delta-bad';
  const icon = v.favourable === null || v.amount === 0 ? '' : v.favourable ? '▲ ' : '▼ ';
  return (
    <>
      <td className={`num ${cls}`}>{v.amount === null ? '—' : <><span aria-hidden>{icon}</span>{formatCurrency(v.amount, currency)}</>}</td>
      <td className={`num ${cls}`}>{formatFraction(v.pct, 1, true)}</td>
    </>
  );
}

export function StatementTable({ rows, statistics, currency, showBudget = true, showPrior = true, onComment }: { rows: StatementRow[]; statistics?: StatementRow[]; currency: string; showBudget?: boolean; showPrior?: boolean; onComment?: (row: StatementRow) => void }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Actual</th>
            {showBudget && <><th className="num">Budget</th><th className="num">Var. $</th><th className="num">Var. %</th></>}
            {showPrior && <><th className="num">Prior year</th><th className="num">Var. $</th><th className="num">Var. %</th></>}
            {onComment && <th />}
          </tr>
        </thead>
        <tbody>
          {(statistics ?? []).length > 0 && (
            <>
              <tr className="section"><td colSpan={9}>Statistics</td></tr>
              {statistics!.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="num">{formatNumber(r.actual)}</td>
                  {showBudget && <><td className="num">{formatNumber(r.budget)}</td><td className="num">{r.vsBudget.amount === null ? '—' : formatNumber(r.vsBudget.amount)}</td><td className="num">{formatFraction(r.vsBudget.pct, 1, true)}</td></>}
                  {showPrior && <><td className="num">{formatNumber(r.priorYear)}</td><td className="num">{r.vsPriorYear.amount === null ? '—' : formatNumber(r.vsPriorYear.amount)}</td><td className="num">{formatFraction(r.vsPriorYear.pct, 1, true)}</td></>}
                  {onComment && <td />}
                </tr>
              ))}
            </>
          )}
          {rows.map((r) =>
            r.kind === 'section' ? (
              <tr key={r.key} className="section"><td colSpan={9}>{r.label}</td></tr>
            ) : (
              <tr key={r.key} className={r.kind === 'subtotal' ? 'subtotal' : ''}>
                <td>{r.label}{r.code && <span className="small muted"> {r.code}</span>}</td>
                <td className="num">{formatCurrency(r.actual, currency)}</td>
                {showBudget && <><td className="num">{formatCurrency(r.budget, currency)}</td><VarianceCells v={r.vsBudget} currency={currency} /></>}
                {showPrior && <><td className="num">{formatCurrency(r.priorYear, currency)}</td><VarianceCells v={r.vsPriorYear} currency={currency} /></>}
                {onComment && <td>{r.kind === 'line' && <button className="btn btn-ghost btn-sm" onClick={() => onComment(r)} aria-label={`Comment on ${r.label}`}>💬</button>}</td>}
              </tr>
            ),
          )}
        </tbody>
      </table>
      <p className="small muted" style={{ padding: '8px 12px' }}>
        Variance % = (actual − comparison) ÷ |comparison|. ▲ favourable / ▼ unfavourable (revenue above or expenses below comparison is favourable). “—” means unavailable.
      </p>
    </div>
  );
}
