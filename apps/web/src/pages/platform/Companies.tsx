import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../../components/icons';
import { Badge, Card, Empty, ErrorState, Loading, PageHeader, fmtDate } from '../../components/ui';
import { KeyTag, STAGE_LABEL, SetupMeter, stageOf, usePlatformCompanies, type Stage } from './shared';

const FILTERS: Array<{ value: Stage | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'invited', label: STAGE_LABEL.invited },
  { value: 'setting_up', label: STAGE_LABEL.setting_up },
  { value: 'live', label: STAGE_LABEL.live },
  { value: 'suspended', label: STAGE_LABEL.suspended },
];

const STAGE_TONE: Record<Stage, 'warn' | 'info' | 'good' | 'bad'> = { invited: 'warn', setting_up: 'info', live: 'good', suspended: 'bad' };

export function CompaniesPage() {
  const q = usePlatformCompanies();
  const [params, setParams] = useSearchParams();
  const stage = (params.get('stage') as Stage | null) ?? 'all';
  const search = params.get('q') ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (!v || v === 'all') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((c) => stage === 'all' || stageOf(c) === stage)
      .filter((c) => !term || [c.name, c.slug, c.legal_name ?? '', c.portal_name ?? ''].some((v) => v.toLowerCase().includes(term)));
  }, [q.data, stage, search]);

  return (
    <div className="stack console-stack">
      <PageHeader
        title="Companies"
        subtitle="Every management company on the portal, where it is in setup, and who is waiting on whom."
        actions={<Link to="/platform/onboard" className="btn btn-brass"><Icon name="users" size={16} /> Onboard a company</Link>}
      />
      <div className="filter-bar">
        <label className="field" style={{ flex: '1 1 240px' }}>
          Search
          <input type="search" placeholder="Name, short ID or portal name" value={search} onChange={(e) => set('q', e.target.value)} />
        </label>
        <div className="segmented" role="group" aria-label="Filter by stage">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" aria-pressed={stage === f.value} onClick={() => set('stage', f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <Card flush>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <Empty title={(q.data ?? []).length === 0 ? 'No companies yet' : 'No companies match'}>
            {(q.data ?? []).length === 0 ? 'Onboard the first management company to get started.' : 'Try another search or stage.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data company-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Stage</th>
                  <th>Setup</th>
                  <th className="num">Hotels</th>
                  <th className="num">People</th>
                  <th>Admin invitation</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const st = stageOf(c);
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/platform/companies/${c.id}`} className="company-cell">
                          <KeyTag slug={c.slug} color={c.primary_color} size="sm" />
                          <span>
                            <strong>{c.name}</strong>
                            <span className="muted small">{c.portal_name ?? c.name}</span>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <Badge tone={STAGE_TONE[st]}>{STAGE_LABEL[st]}</Badge>
                        {c.is_demo && <> <Badge>Demo</Badge></>}
                      </td>
                      <td><SetupMeter setup={c.setup} /></td>
                      <td className="num">{c.setup.properties}</td>
                      <td className="num">{c.members}</td>
                      <td className="small">
                        {c.setup.admin_joined
                          ? 'Accepted'
                          : c.pending_admin_invitations > 0
                            ? 'Pending'
                            : c.expired_admin_invitations > 0
                              ? <span className="text-bad">Expired</span>
                              : <span className="text-bad">None</span>}
                      </td>
                      <td className="small">{fmtDate(c.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
