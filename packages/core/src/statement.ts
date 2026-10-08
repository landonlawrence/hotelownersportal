import { variance, type AccountNature, type Variance } from './variance.js';

export interface Account {
  id: string;
  code: string;
  name: string;
  nature: AccountNature;
  section: string;
  sort_order: number;
}

export interface StatementRow {
  kind: 'section' | 'line' | 'subtotal';
  key: string;
  label: string;
  nature: AccountNature;
  actual: number | null;
  budget: number | null;
  priorYear: number | null;
  vsBudget: Variance;
  vsPriorYear: Variance;
  accountId?: string;
  code?: string;
}

const SECTION_ORDER = ['Revenue', 'Departmental expenses', 'Undistributed expenses', 'Management fees', 'Fixed charges'];

function sum(vals: Array<number | null>): number | null {
  const present = vals.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}
const sub = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

/**
 * Builds a USALI-style summary statement with derived subtotals:
 * Total revenue, Departmental profit, Gross operating profit (GOP) and Net
 * operating income (NOI = GOP − management fees − fixed charges).
 */
export function buildStatement(accounts: Account[], actual: Map<string, number>, budget: Map<string, number>, prior: Map<string, number>): { rows: StatementRow[]; statistics: StatementRow[] } {
  const get = (m: Map<string, number>, id: string) => (m.has(id) ? m.get(id)! : null);
  const line = (a: Account): StatementRow => {
    const ac = get(actual, a.id), bu = get(budget, a.id), py = get(prior, a.id);
    return { kind: 'line', key: a.id, label: a.name, code: a.code, accountId: a.id, nature: a.nature, actual: ac, budget: bu, priorYear: py, vsBudget: variance(ac, bu, a.nature), vsPriorYear: variance(ac, py, a.nature) };
  };
  const total = (key: string, label: string, nature: AccountNature, a: number | null, b: number | null, p: number | null): StatementRow => ({
    kind: 'subtotal', key, label, nature, actual: a, budget: b, priorYear: p, vsBudget: variance(a, b, nature), vsPriorYear: variance(a, p, nature),
  });
  const sorted = [...accounts].sort((a, b) => a.sort_order - b.sort_order);
  const statistics = sorted.filter((a) => a.nature === 'statistic').map(line);
  const bySection = new Map<string, StatementRow[]>();
  for (const a of sorted.filter((x) => x.nature !== 'statistic')) {
    if (!bySection.has(a.section)) bySection.set(a.section, []);
    bySection.get(a.section)!.push(line(a));
  }
  const sectionTotals = (s: string) => {
    const rs = bySection.get(s) ?? [];
    return [sum(rs.map((r) => r.actual)), sum(rs.map((r) => r.budget)), sum(rs.map((r) => r.priorYear))] as const;
  };
  const rows: StatementRow[] = [];
  const pushSection = (s: string, totalLabel: string, nature: AccountNature) => {
    const rs = bySection.get(s);
    if (!rs?.length) return;
    rows.push({ kind: 'section', key: `s-${s}`, label: s, nature, actual: null, budget: null, priorYear: null, vsBudget: variance(null, null, nature), vsPriorYear: variance(null, null, nature) });
    rows.push(...rs);
    const [a, b, p] = sectionTotals(s);
    rows.push(total(`t-${s}`, totalLabel, nature, a, b, p));
  };
  pushSection('Revenue', 'Total revenue', 'revenue');
  pushSection('Departmental expenses', 'Total departmental expenses', 'expense');
  const [ra, rb, rp] = sectionTotals('Revenue');
  const [da, db, dp] = sectionTotals('Departmental expenses');
  rows.push(total('dept-profit', 'Departmental profit', 'revenue', sub(ra, da), sub(rb, db), sub(rp, dp)));
  pushSection('Undistributed expenses', 'Total undistributed expenses', 'expense');
  const [ua, ub, up] = sectionTotals('Undistributed expenses');
  const gop = [sub(sub(ra, da), ua), sub(sub(rb, db), ub), sub(sub(rp, dp), up)] as const;
  rows.push(total('gop', 'Gross operating profit (GOP)', 'revenue', ...gop));
  pushSection('Management fees', 'Total management fees', 'expense');
  pushSection('Fixed charges', 'Total fixed charges', 'expense');
  const [ma, mb, mp] = sectionTotals('Management fees');
  const [fa, fb, fp] = sectionTotals('Fixed charges');
  rows.push(total('noi', 'Net operating income (NOI)', 'revenue', sub(sub(gop[0], ma), fa), sub(sub(gop[1], mb), fb), sub(sub(gop[2], mp), fp)));
  for (const [s, rs] of bySection) if (!SECTION_ORDER.includes(s)) rows.push(...rs);
  return { rows, statistics };
}
