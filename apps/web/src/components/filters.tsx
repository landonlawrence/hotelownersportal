import { useEffect, useRef, useState } from 'react';
import type { PeriodView } from '@hop/core';
import type { Property } from '../state/portal';
import { Segmented } from './ui';

export function PropertyMultiSelect({ properties, selected, onChange }: { properties: Property[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const label = selected.length === 0 || selected.length === properties.length ? `All properties (${properties.length})` : selected.length === 1 ? properties.find((p) => p.id === selected[0])?.name : `${selected.length} properties`;
  const toggle = (id: string) => {
    const base = selected.length === 0 ? properties.map((p) => p.id) : selected;
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    // An empty selection means "all"; never let unchecking the last hotel flip to everything.
    if (next.length === 0) return;
    onChange(next.length === properties.length ? [] : next);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <label className="field">
        Properties
        <button ref={trigger} type="button" className="btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ minWidth: 220, justifyContent: 'space-between' }}>
          {label} <span aria-hidden>▾</span>
        </button>
      </label>
      {open && (
        <div className="card" role="listbox" aria-multiselectable style={{ position: 'absolute', zIndex: 10, top: '100%', marginTop: 4, minWidth: 280, padding: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>Select all</button>
          {properties.map((p) => {
            const checked = selected.length === 0 || selected.includes(p.id);
            const onlyOne = checked && (selected.length === 1 || (selected.length === 0 && properties.length === 1));
            return (
            <label key={p.id} className="row" style={{ padding: '6px 4px', gap: 8, cursor: onlyOne ? 'default' : 'pointer' }} title={onlyOne ? 'At least one property must stay selected' : undefined}>
              <input type="checkbox" checked={checked} disabled={onlyOne} onChange={() => toggle(p.id)} />
              <span>{p.name}</span>
              <span className="muted small">{p.code}</span>
            </label>
            );
          })}
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

/** Yesterday in the browser's local calendar (the latest business date that can have been reported). */
export function localYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function PeriodFilter({ view, asOf, onView, onAsOf, max }: { view: PeriodView; asOf: string; onView: (v: PeriodView) => void; onAsOf: (d: string) => void; max?: string }) {
  return (
    <>
      <label className="field">
        Period
        <Segmented label="Period" value={view} onChange={onView} options={VIEW_OPTIONS} />
      </label>
      <label className="field">
        {view === 'month' ? 'Month of' : 'As of business date'}
        <input type="date" value={asOf} max={max ?? localYesterday()} onChange={(e) => e.target.value && onAsOf(e.target.value)} />
      </label>
    </>
  );
}
