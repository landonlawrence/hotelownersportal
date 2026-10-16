import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { fetchMeta } from '../lib/api';
import { usePortal, useCompany } from '../state/portal';
import { Icon, type IconName } from '../components/icons';
import { Card, Empty, Loading, Notice, PageHeader } from '../components/ui';
import { PropertiesErrorState } from '../components/NoProperties';
import { OverviewPage } from './Overview';

const DEFAULT_PRIMARY = '#1f3a5f';

/** Any branding change counts: logo, colour, sign-in headline or message, or a portal name of its own. */
function brandingCustomised(b: ReturnType<typeof useCompany>['branding'], companyName: string): boolean {
  if (!b) return false;
  return (
    !!(b.logo_url || b.logo_mark_url) ||
    (!!b.primary_color && b.primary_color.toLowerCase() !== DEFAULT_PRIMARY) ||
    !!b.login_headline?.trim() ||
    !!b.login_message?.trim() ||
    (!!b.portal_name && b.portal_name.trim() !== companyName.trim())
  );
}


interface Step {
  id: string;
  icon: IconName;
  title: string;
  detail: string;
  done: boolean;
  action?: { label: string; to: string };
  note?: string;
}

/** Setup checklist for company administrators; disappears once everything is done. */
export function GettingStarted({ compact = false }: { compact?: boolean }) {
  const { properties, isCompanyAdmin } = usePortal();
  const company = useCompany();
  const id = company.company_id;
  const status = useQuery({
    queryKey: ['setup-status', id, properties.length],
    enabled: isCompanyAdmin,
    queryFn: async () => {
      // Counts come from one RPC that works before 2FA, so steps don't flip after verifying.
      const [factors, res] = await Promise.all([supabase.auth.mfa.listFactors(), supabase.rpc('company_setup_status', { p_company_id: id })]);
      if (res.error) throw res.error;
      const c = (res.data ?? {}) as { rooms?: number; other_members?: number; pending_invitations?: number; sources?: number; import_runs?: number };
      return {
        mfa: (factors.data?.totp ?? []).some((f) => f.status === 'verified'),
        rooms: c.rooms ?? 0,
        // Your own (accepted) invitation doesn't count: other members or invitations still pending.
        team: (c.other_members ?? 0) + (c.pending_invitations ?? 0),
        data: (c.sources ?? 0) + (c.import_runs ?? 0),
      };
    },
  });
  const meta = useQuery({ queryKey: ['api-meta'], staleTime: 60_000, queryFn: fetchMeta, retry: false });
  const hideKey = `hop.setupHidden.${id}`;
  const [hidden, setHiddenState] = useState(() => {
    try {
      return localStorage.getItem(hideKey) === '1';
    } catch {
      return false;
    }
  });
  const setHidden = (v: boolean) => {
    setHiddenState(v);
    try {
      localStorage.setItem(hideKey, v ? '1' : '0');
    } catch {
      /* storage unavailable: hide for this visit only */
    }
  };
  if (!isCompanyAdmin || !status.data || (compact && hidden)) return null;

  const b = company.branding;
  const steps: Step[] = [
    {
      id: 'mfa', icon: 'shield', title: 'Secure your account with two-factor authentication',
      detail: 'Required for administration, publishing and approvals. Takes two minutes with any authenticator app.',
      done: status.data.mfa,
      action: { label: 'Set up 2FA', to: '/security' },
    },
    {
      id: 'property', icon: 'building', title: 'Add your hotels',
      detail: 'Name, code, time zone and status for each property.',
      done: properties.length > 0,
      action: { label: 'Add a property', to: '/admin?tab=properties' },
    },
    {
      id: 'rooms', icon: 'bed', title: 'Set room counts',
      detail: 'Room inventory drives occupancy, ADR and RevPAR.',
      done: status.data.rooms > 0,
      action: { label: 'Set rooms', to: '/admin?tab=properties' },
    },
    {
      id: 'brand', icon: 'palette', title: 'Brand your portal',
      detail: 'Logo, colours and the sign-in message your owners see.',
      done: brandingCustomised(b, company.company_name),
      action: { label: 'Edit branding', to: '/admin?tab=branding' },
    },
    {
      id: 'team', icon: 'users', title: 'Invite your team and owners',
      detail: 'Choose each person’s role and which hotels they can see.',
      done: status.data.team > 0,
      action: { label: 'Invite people', to: '/admin?tab=invitations' },
      note: meta.data && !meta.data.emailEnabled ? 'Email sending isn’t set up yet, so the invitation link is shown to you to send yourself.' : undefined,
    },
    {
      id: 'data', icon: 'upload', title: 'Bring in your numbers',
      detail: 'Upload a daily performance, monthly P&L or budget file, or set up an email feed from your PMS.',
      done: status.data.data > 0,
      action: { label: 'Go to Data imports', to: '/imports' },
    },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.find((s) => !s.done)!;

  return (
    <Card className="setup-card">
      <div className="spread">
        <div>
          <h2>Get {company.branding?.portal_name ?? company.company_name} ready</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>{done} of {steps.length} steps done · next: {next.title.toLowerCase()}</p>
        </div>
        {compact && <button className="btn btn-sm btn-ghost" onClick={() => setHidden(true)}>Hide for now</button>}
      </div>
      <div className="progress" style={{ margin: '12px 0 4px' }} aria-label={`${done} of ${steps.length} setup steps complete`}>
        <div style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      {meta.data && meta.data.serverReady === false && (
        <Notice tone="warn">
          Server setup isn’t finished: uploads, exports and invitations will fail until the Supabase service key is stored in AWS Secrets Manager (see the deployment guide).
        </Notice>
      )}
      <ol className="checklist">
        {steps.map((s) => (
          <li key={s.id} className={s.done ? 'done' : s.id === next.id ? 'current' : ''}>
            <span className="check-dot" aria-hidden>{s.done ? <Icon name="check" size={14} /> : <Icon name={s.icon} size={15} />}</span>
            <div className="check-body">
              <strong>{s.title}</strong>
              {!s.done && <span className="muted small">{s.detail}</span>}
              {!s.done && s.note && <span className="small check-note">{s.note}</span>}
            </div>
            {s.done ? (
              <span className="badge badge-good">Done</span>
            ) : (
              s.action && (
                <Link to={s.action.to} className={`btn btn-sm ${s.id === next.id ? 'btn-primary' : ''}`}>
                  {s.action.label} <Icon name="arrow" size={14} />
                </Link>
              )
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function HomePage() {
  const { ctx, properties, propertiesError, propertiesLoading, refetchProperties, canAny, isCompanyAdmin } = usePortal();
  const company = useCompany();
  const firstName = ctx?.full_name?.split(' ')[0];
  const canSeePerformance = canAny('performance.view') && company.modules.performance !== false;
  if (propertiesLoading) return <Loading />;

  if (properties.length > 0 && canSeePerformance) {
    return (
      // The setup checklist goes below the page heading (one h1, first).
      <OverviewPage intro={<GettingStarted compact />} />
    );
  }

  return (
    <div className="stack">
      <PageHeader title={firstName ? `Welcome, ${firstName}` : 'Welcome'} subtitle={company.branding?.portal_name ?? company.company_name} />
      {propertiesError ? (
        <Card>
          <PropertiesErrorState error={propertiesError} retry={() => void refetchProperties()} />
        </Card>
      ) : isCompanyAdmin ? (
        <GettingStarted />
      ) : (
        <Card>
          <Empty title={properties.length === 0 ? 'Nothing has been shared with you yet' : 'Your properties'}>
            {properties.length === 0 ? (
              <>Once {company.company_name} gives you access to a hotel, its performance, financials and documents will appear here. Questions? Contact {company.branding?.support_email ?? 'your management company'}.</>
            ) : (
              <Link to="/properties">See the {properties.length === 1 ? 'property' : `${properties.length} properties`} you can access</Link>
            )}
          </Empty>
        </Card>
      )}
    </div>
  );
}
