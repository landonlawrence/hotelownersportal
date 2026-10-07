import { useEffect, useRef, useState } from 'react';
import type { PeriodView } from '@hop/core';
import type { Property } from '../state/portal';
import { Segmented } from './ui';

export function PropertyMultiSelect({ properties, selected, onChange }: { properties: Property[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const label = selected.length === 0 || selected.length === properties.length ? `All properties (${properties.length})` : selected.length === 1 ? properties.find((p) => p.id === selected[0])?.name : `${selected.length} properties`;
  const toggle = (id: string) => {
    const base = selected.length === 0 ? properties.map((p) => p.id) : selected;
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    onChange(next.length === properties.length ? [] : next);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <label className="field">
        Properties
        <button type="button" className="btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ minWidth: 220, justifyContent: 'space-between' }}>
          {label} <span aria-hidden>▾</span>
        </button>
      </label>
      {open && (
        <div className="card" role="listbox" aria-multiselectable style={{ position: 'absolute', zIndex: 10, top: '100%', marginTop: 4, minWidth: 280, padding: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>Select all</button>
          {properties.map((p) => (
            <label key={p.id} className="row" style={{ padding: '6px 4px', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.length === 0 || selected.includes(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.name}</span>
              <span className="muted small">{p.code}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export const VIEW_OPTIONS: Array<{ value: PeriodView; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'mtd', label: 'MTD' },
  { value: 'month', label: 'Month' },
  { value: 'ytd', label: 'YTD' },
];

export function PeriodFilter({ view, asOf, onView, onAsOf }: { view: PeriodView; asOf: string; onView: (v: PeriodView) => void; onAsOf: (d: string) => void }) {
  return (
    <>
      <label className="field">
        Period
        <Segmented label="Period" value={view} onChange={onView} options={VIEW_OPTIONS} />
      </label>
      <label className="field">
        {view === 'month' ? 'Month of' : 'As of business date'}
        <input type="date" value={asOf} max={new Date().toISOString().slice(0, 10)} onChange={(e) => e.target.value && onAsOf(e.target.value)} />
      </label>
    </>
  );
}
