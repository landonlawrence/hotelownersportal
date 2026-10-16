import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtKpi, type KpiKind } from './kpi';
import { Segmented } from './ui';

export interface TrendPoint {
  label: string;
  actual: number | null;
  priorYear: number | null;
  budget: number | null;
  /** Not every operating hotel reported for this point. */
  partial?: boolean;
}

const SERIES = [
  { key: 'actual', name: 'Actual', color: '#2a78d6', dash: undefined },
  { key: 'priorYear', name: 'Prior year', color: '#eb6834', dash: undefined },
  { key: 'budget', name: 'Budget', color: '#1baf7a', dash: '6 4' },
] as const;

/**
 * Single-axis trend chart (actual vs prior year vs budget) with a crosshair
 * tooltip, a legend, and an equivalent table view. Missing points are gaps,
 * never zeros.
 */
export function TrendChart({ data, kind, title, currency }: { data: TrendPoint[]; kind: KpiKind; title: string; currency?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const visible = SERIES.filter((s) => data.some((d) => d[s.key] !== null));
  const anyPartial = data.some((d) => d.partial && d.actual !== null);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="spread">
        <div className="chart-legend" aria-label="Legend">
          {visible.map((s) => (
            <span key={s.key}>
              <i className="legend-line" style={{ borderTopColor: s.color, borderTopStyle: s.dash ? 'dashed' : 'solid' }} />
              {s.name}
            </span>
          ))}
          {anyPartial && (
            <span className="trend-partial">
              <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="#ffffff" stroke="#2a78d6" strokeWidth="1.5" /></svg> partial — period in progress or not every expected day reported
            </span>
          )}
        </div>
        <Segmented
          label={`${title} view`}
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </div>
      {view === 'chart' ? (
        <div style={{ width: '100%', height: 280 }} role="img" aria-label={`${title} trend chart; switch to table view for values`}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
              <CartesianGrid stroke="#e1e0d9" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#5f6672', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#d1d5db' }} minTickGap={16} />
              <YAxis
                tick={{ fill: '#5f6672', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => fmtKpi(v, kind === 'money_cents' ? 'money' : kind, currency)}
                domain={kind === 'pct' ? [0, 100] : ['auto', 'auto']}
              />
              <Tooltip
                cursor={{ stroke: '#898781', strokeWidth: 1 }}
                content={({ active, payload, label }) =>
                  active && payload ? (
                    <div className="chart-tooltip">
                      <div className="muted" style={{ marginBottom: 4 }}>
                        {label}
                        {data.find((d) => d.label === label)?.partial && ' · partial (not all hotels reported)'}
                      </div>
                      {visible.map((s) => {
                        const p = payload.find((x) => x.dataKey === s.key);
                        return (
                          <div className="row-t" key={s.key}>
                            <i className="legend-line" style={{ borderTopColor: s.color }} />
                            <strong>{fmtKpi((p?.value as number | null) ?? null, kind, currency)}</strong>
                            <span className="muted">{s.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null
                }
              />
              {visible.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dash}
                  dot={
                    s.key === 'actual'
                      ? (props: { cx?: number; cy?: number; index?: number; key?: string }) => {
                          const pt = props.index === undefined ? undefined : data[props.index];
                          if (!pt?.partial || pt.actual === null || props.cx === undefined || props.cy === undefined) return <g key={props.key} />;
                          return <circle key={props.key} cx={props.cx} cy={props.cy} r={3.5} fill="#ffffff" stroke={s.color} strokeWidth={1.5} />;
                        }
                      : false
                  }
                  activeDot={{ r: 4, strokeWidth: 2, stroke: '#ffffff' }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 280 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Period</th>
                {visible.map((s) => (
                  <th key={s.key} className="num">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>
                    {d.label}
                    {d.partial && d.actual !== null && <span className="trend-partial" title="Not all hotels reported"> · partial</span>}
                  </td>
                  {visible.map((s) => (
                    <td key={s.key} className="num">{fmtKpi(d[s.key], kind, currency)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
