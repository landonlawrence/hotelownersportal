import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatCurrency, formatNumber } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { useAccounts, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { OtherCompanyNotice } from '../components/OtherCompanyNotice';
import { Card, Empty, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate, dbErrorMessage, parseAmount } from '../components/ui';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function BudgetVersionPage() {
  const { id } = useParams();
  const { properties, can } = usePortal();
  const company = useCompany();
  const accounts = useAccounts(company.company_id);
  const qc = useQueryClient();
  const v = useQuery({
    queryKey: ['budget-version', id],
    queryFn: async () => unwrap(await supabase.from('budget_versions').select('id, company_id, property_id, fiscal_year, version_number, name, status, notes, approved_at').eq('id', id!).maybeSingle()) as { id: string; company_id: string; property_id: string; fiscal_year: number; version_number: number; name: string; status: string; notes: string | null; approved_at: string | null } | null,
  });
  const lines = useQuery({
    queryKey: ['budget-lines', id],
    enabled: !!v.data && v.data.company_id === company.company_id,
    queryFn: async () => unwrap(await supabase.from('budget_lines').select('account_id, period_month, amount').eq('budget_version_id', id!)) as Array<{ account_id: string; period_month: string; amount: number }>,
  });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  // Set when a save or approval failed because the version changed elsewhere (e.g. approved in another tab).
  const [conflict, setConflict] = useState(false);
  const reloadVersion = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['budget-version', id] }), qc.invalidateQueries({ queryKey: ['budget-lines', id] })]);
    const fresh = qc.getQueryData<{ status: string } | null>(['budget-version', id]);
    if (fresh && fresh.status !== 'draft') {
      setConflict(true);
      setErr(null);
      setEdits({});
      return true;
    }
    return false;
  };
  const grid = useMemo(() => {
    const m = new Map<string, number>();
    (lines.data ?? []).forEach((l) => m.set(`${l.account_id}|${Number(l.period_month.slice(5, 7))}`, Number(l.amount)));
    return m;
  }, [lines.data]);
  if (v.isLoading) return <Loading />;
  if (!v.data) return <Empty page title="Budget not found">It may not exist or you may not have access to drafts.</Empty>;
  const b = v.data;
  if (b.company_id !== company.company_id) return <OtherCompanyNotice companyId={b.company_id} propertyId={b.property_id} fallbackName={`FY${b.fiscal_year} budget`} />;
  const editable = b.status === 'draft' && can('budgets.edit', b.property_id);
  const property = properties.find((p) => p.id === b.property_id);
  const pendingEdits = Object.keys(edits).length > 0;
  // Each invalid cell named in a list the cell points to (aria-describedby), in grid order.
  const accountName = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
  const accountOrder = new Map((accounts.data ?? []).map((a, i) => [a.id, i]));
  const invalidCells = Object.entries(edits)
    .filter(([, val]) => val.trim() !== '' && parseAmount(val) === null)
    .map(([k]) => {
      const [accountId, m] = k.split('|');
      return { key: k, order: (accountOrder.get(accountId!) ?? 0) * 12 + Number(m), label: `${accountName.get(accountId!) ?? 'Account'}, ${MONTHS[Number(m) - 1]}: enter a number (e.g. 12,500), or clear the cell` };
    })
    .sort((x, y) => x.order - y.order);
  const cellErrorId = (k: string) => `budget-cell-error-${k.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const save = async () => {
    setErr(null);
    const entries = Object.entries(edits).map(([k, val]) => {
      const [accountId, m] = k.split('|');
      return { accountId: accountId!, period: `${b.fiscal_year}-${String(m).padStart(2, '0')}-01`, raw: val.trim() };
    });
    // A cleared cell removes that month's line instead of storing 0.
    const cleared = entries.filter((e) => e.raw === '');
    const rows = entries
      .filter((e) => e.raw !== '')
      .map((e) => ({ company_id: b.company_id, property_id: b.property_id, budget_version_id: b.id, account_id: e.accountId, period_month: e.period, amount: parseAmount(e.raw) }));
    if (invalidCells.length > 0) return setErr('Fix the cells listed below before saving.');
    const failed = async (error: { message: string; code?: string }) => {
      if (!(await reloadVersion())) setErr(dbErrorMessage(error));
    };
    if (rows.length) {
      const { error } = await supabase.from('budget_lines').upsert(rows, { onConflict: 'budget_version_id,account_id,period_month' });
      if (error) return failed(error);
    }
    for (const c of cleared) {
      const { error } = await supabase.from('budget_lines').delete().eq('budget_version_id', b.id).eq('account_id', c.accountId).eq('period_month', c.period);
      if (error) return failed(error);
    }
    setEdits({});
    await qc.invalidateQueries({ queryKey: ['budget-lines', id] });
  };
  return (
    <div className="stack">
      <div className="small"><Link to="/financials">← Budgets & financials</Link></div>
      <PageHeader
        title={`${property?.name ?? 'Budget'} — FY${b.fiscal_year} budget`}
        subtitle={<>v{b.version_number} · {b.name} · <StatusBadge status={b.status} />{b.approved_at && ` · approved ${fmtDate(b.approved_at)}`}</>}
        actions={
          <>
            {editable && pendingEdits && <button className="btn btn-primary" disabled={invalidCells.length > 0} aria-describedby={invalidCells.length > 0 ? 'budget-invalid-cells' : undefined} onClick={save}>Save {Object.keys(edits).length} change(s)</button>}
            {editable && pendingEdits && <button className="btn" onClick={() => { setEdits({}); setErr(null); }}>Discard changes</button>}
            {b.status === 'draft' && can('budgets.approve', b.property_id) && (
              <>
                <button className="btn btn-primary" disabled={pendingEdits} aria-describedby={pendingEdits ? 'budget-approve-hint' : undefined} onClick={() => setApproving(true)}>Approve</button>
                {pendingEdits && <span className="small muted" id="budget-approve-hint">Save or discard your changes first</span>}
              </>
            )}
          </>
        }
      />
      {b.notes && <Notice tone="info">{b.notes}</Notice>}
      {b.status !== 'draft' && (conflict ? (
        <Notice tone="warn">This budget was {b.status} elsewhere; it is now read-only.</Notice>
      ) : (
        <Notice tone="info">This version is {b.status} and locked. Create a new version to make changes.</Notice>
      ))}
      {err && <Notice tone="bad">{err}</Notice>}
      {invalidCells.length > 0 && (
        <Notice tone="bad">
          <span id="budget-invalid-cells">These cells aren’t valid amounts, so changes can’t be saved yet:</span>
          <ul style={{ margin: '4px 0 0' }}>{invalidCells.map((c) => <li key={c.key} id={cellErrorId(c.key)}>{c.label}</li>)}</ul>
        </Notice>
      )}
      <Card flush title="Monthly budget by account">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th>{MONTHS.map((m) => <th key={m} className="num">{m}</th>)}<th className="num">Year</th></tr></thead>
            <tbody>
              {(accounts.data ?? []).map((a) => {
                // Edited cells use the same parser as Save, so "12,500" and "(500)" count in the live total.
                const vals = MONTHS.map((_, i) => {
                  const k = `${a.id}|${i + 1}`;
                  return edits[k] !== undefined ? parseAmount(edits[k]) : grid.get(k) ?? null;
                });
                const total = vals.every((x) => x === null) ? null : vals.reduce<number>((s, x) => s + (x ?? 0), 0);
                const fmt = (x: number | null) => (a.nature === 'statistic' ? formatNumber(x) : formatCurrency(x));
                return (
                  <tr key={a.id}>
                    <td>{a.name}<div className="small muted">{a.code}</div></td>
                    {MONTHS.map((_, i) => {
                      const k = `${a.id}|${i + 1}`;
                      return (
                        <td key={k} className="num">
                          {editable ? (
                            (() => {
                              const invalid = edits[k] !== undefined && edits[k]!.trim() !== '' && vals[i] === null;
                              return (
                                <input
                                  aria-label={`${a.name} ${MONTHS[i]}`}
                                  aria-invalid={invalid || undefined}
                                  aria-describedby={invalid ? cellErrorId(k) : undefined}
                                  title={invalid ? 'Not a valid amount' : undefined}
                                  className={invalid ? 'cell-invalid' : undefined}
                                  style={{ width: 92, textAlign: 'right' }}
                                  inputMode="decimal"
                                  value={edits[k] ?? (grid.get(k) ?? '')}
                                  onChange={(e) => setEdits({ ...edits, [k]: e.target.value })}
                                />
                              );
                            })()
                          ) : fmt(vals[i] ?? null)}
                        </td>
                      );
                    })}
                    <td className="num"><strong>{fmt(total)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {approving && (
        <ApproveBudget
          id={b.id}
          onClose={() => setApproving(false)}
          onApproved={async () => {
            setApproving(false);
            setEdits({});
            await Promise.all([qc.invalidateQueries({ queryKey: ['budget-version', id] }), qc.invalidateQueries({ queryKey: ['budget-lines', id] })]);
          }}
          onFailed={async () => { if (await reloadVersion()) setApproving(false); }}
        />
      )}
    </div>
  );
}

function ApproveBudget({ id, onClose, onApproved, onFailed }: { id: string; onClose: () => void; onApproved: () => Promise<void>; onFailed: () => Promise<void> }) {
  const rpc = useRpc('approve_budget_version');
  const [comment, setComment] = useState('');
  return (
    <Modal title="Approve budget" onClose={onClose}>
      <p>Approving makes this the active budget for the fiscal year. Any previously approved version becomes superseded. Approved budgets cannot be edited.</p>
      {rpc.error && <Notice tone="bad">{errorMessage(rpc.error)}</Notice>}
      <label className="field">Comment<textarea value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={rpc.isPending} onClick={() => rpc.mutateAsync({ p_version_id: id, p_comment: comment || null }).then(onApproved, () => onFailed())}>Approve budget</button>
    </Modal>
  );
}
