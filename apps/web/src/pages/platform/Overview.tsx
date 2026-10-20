import { Link } from 'react-router-dom';
import { Icon } from '../../components/icons';
import { Badge, Card, Empty, ErrorState, Loading, fmtDate } from '../../components/ui';
import { KeyTag, SETUP_STEPS, STAGE_LABEL, SetupMeter, stageOf, usePlatformCompanies, type CompanyRow, type Stage } from './shared';

interface Attention {
  company: CompanyRow;
  reason: string;
  action: string;
}

function attentionFor(c: CompanyRow): Attention | null {
  if (c.is_demo || c.status === 'suspended') return null;
  if (!c.setup.admin_joined && c.pending_admin_invitations === 0) {
    return { company: c, reason: c.expired_admin_invitations > 0 ? 'The admin invitation expired before anyone joined.' : 'No admin has joined and no invitation is pending.', action: 'Send a new invitation' };
  }
  if (!c.setup.admin_joined) return { company: c, reason: 'Invitation sent; the admin hasn’t joined yet.', action: 'Check invitation' };
  const missing = SETUP_STEPS.find((s) => !c.setup[s.key]);
  if (missing && missing.key !== 'data') return { company: c, reason: `Setup stalled at “${missing.label.toLowerCase()}”.`, action: 'Open company' };
  return null;
}

export function PlatformOverview() {
  const q = usePlatformCompanies();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const all = (q.data ?? []).filter((c) => !c.is_demo);
  const count = (s: Stage) => all.filter((c) => stageOf(c) === s).length;
  const attention = all.map(attentionFor).filter((a): a is Attention => !!a);
  const recent = [...all].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5);
  const supportOpen = all.filter((c) => c.active_support_sessions > 0);

  return (
    <div className="stack console-stack">
      <section className="console-hero">
        <div>
          <h1>{all.length === 0 ? 'Bring on your first company' : `${all.length} ${all.length === 1 ? 'company' : 'companies'} on the portal`}</h1>
          <p>Onboard management companies, follow their setup, and step in when something stalls. You see setup and access, never their financials.</p>
        </div>
        <Link to="/platform/onboard" className="btn btn-brass btn-lg">
          <Icon name="users" size={18} /> Onboard a company
        </Link>
      </section>

      <div className="stage-strip" role="list" aria-label="Companies by stage">
        {(['invited', 'setting_up', 'live', 'suspended'] as Stage[]).map((s) => (
          <Link key={s} to={`/platform/companies?stage=${s}`} className={`stage-cell stage-${s}`} role="listitem">
            <span className="stage-count">{count(s)}</span>
            <span className="stage-name">{STAGE_LABEL[s]}</span>
          </Link>
        ))}
      </div>

      <div className="console-grid">
        <Card title="Needs attention">
          {attention.length === 0 ? (
            <Empty title="Nothing is waiting on you">Companies that stall during setup or whose invitation expires show up here.</Empty>
          ) : (
            <ul className="attention-list">
              {attention.map((a) => (
                <li key={a.company.id}>
                  <KeyTag slug={a.company.slug} color={a.company.primary_color} size="sm" />
                  <div>
                    <strong>{a.company.name}</strong>
                    <span className="muted small">{a.reason}</span>
                  </div>
                  <Link className="btn btn-sm" to={`/platform/companies/${a.company.id}`}>{a.action}</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recently onboarded" actions={<Link to="/platform/companies" className="small">All companies</Link>}>
          {recent.length === 0 ? (
            <Empty title="No companies yet">Use “Onboard a company” to create the first one.</Empty>
          ) : (
            <ul className="recent-list">
              {recent.map((c) => (
                <li key={c.id}>
                  <Link to={`/platform/companies/${c.id}`} className="recent-link">
                    <KeyTag slug={c.slug} color={c.primary_color} size="sm" />
                    <span className="recent-name">{c.name}</span>
                  </Link>
                  <SetupMeter setup={c.setup} />
                  <span className="muted small">{fmtDate(c.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
          {supportOpen.length > 0 && (
            <p className="small" style={{ marginBottom: 0 }}>
              <Badge tone="info">Support</Badge> Open support sessions: {supportOpen.map((c) => c.name).join(', ')}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
