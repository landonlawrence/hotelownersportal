import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS, contrastRatio, type Role } from '@hop/core';
import { supabase } from '../../lib/supabase';
import { usePortal } from '../../state/portal';
import { Icon } from '../../components/icons';
import { Badge, Card, Empty, ErrorState, Loading, Modal, Notice, StatusBadge, TabPanel, Tabs, dbErrorMessage, fmtDate } from '../../components/ui';
import {
  Field, KeyTag, MODULES, SETUP_STEPS, STAGE_LABEL, SetupMeter, SignInPreview, emailValid, hexValid, inviteLink, stageOf,
  usePlatformCompany, type Branding, type CompanyDetail,
} from './shared';

type Tab = 'overview' | 'profile' | 'branding' | 'features' | 'domains' | 'admins' | 'support' | 'activity';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'admins', label: 'Administrators' },
  { id: 'branding', label: 'Branding' },
  { id: 'profile', label: 'Profile & status' },
  { id: 'features', label: 'Features' },
  { id: 'domains', label: 'Domains' },
  { id: 'support', label: 'Support access' },
  { id: 'activity', label: 'Activity' },
];

const ACTIVITY_LABEL: Record<string, string> = {
  'platform.company_provisioned': 'Company created',
  'platform.admin_invited': 'Administrator invitation issued',
  'platform.admin_invitation_revoked': 'Administrator invitation revoked',
  'platform.company_suspended': 'Company suspended',
  'platform.company_reactivated': 'Company reactivated',
  'platform.company_branding_changed': 'Branding changed',
  'platform.company_modules_changed': 'Features changed',
  'platform.company_domains_changed': 'Domains changed',
};

type Msg = { tone: 'good' | 'bad'; text: string } | null;

export function CompanyDetailPage() {
  const { id } = useParams();
  const q = usePlatformCompany(id);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview') as Tab;
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error ?? new Error('Company not found')} retry={() => void q.refetch()} />;
  const d = q.data;
  const stage = stageOf({ status: d.company.status, setup: d.setup });
  return (
    <div className="stack console-stack">
      <div className="small"><Link to="/platform/companies">← Companies</Link></div>
      <header className="company-head">
        <KeyTag slug={d.company.slug} color={d.branding?.primary_color} size="lg" />
        <div>
          <h1>{d.company.name}</h1>
          <p className="muted">
            {d.branding?.portal_name ?? d.company.name} — {STAGE_LABEL[stage]}
            {d.company.is_demo && ' — demo data'}
          </p>
        </div>
        <SetupMeter setup={d.setup} />
      </header>
      <Tabs label="Company sections" idPrefix="company" tabs={TABS} value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} />
      <TabPanel idPrefix="company" value={tab}>
      {tab === 'overview' && <OverviewTab d={d} go={(t) => setParams({ tab: t }, { replace: true })} />}
      {tab === 'admins' && <AdminsTab d={d} />}
      {tab === 'branding' && <BrandingTab d={d} />}
      {tab === 'profile' && <ProfileTab d={d} />}
      {tab === 'features' && <FeaturesTab d={d} />}
      {tab === 'domains' && <DomainsTab d={d} />}
      {tab === 'support' && <SupportTab d={d} />}
      {tab === 'activity' && <ActivityTab d={d} />}
      </TabPanel>
    </div>
  );
}

function useRefresh(id: string) {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: ['platform-company', id] });
    await qc.invalidateQueries({ queryKey: ['platform-companies'] });
  };
}

function OverviewTab({ d, go }: { d: CompanyDetail; go: (t: Tab) => void }) {
  const roles = Object.entries(d.members_by_role);
  return (
    <div className="console-grid">
      <Card title="Setup">
        <ol className="checklist">
          {SETUP_STEPS.map((s) => {
            const done = !!d.setup[s.key];
            return (
              <li key={s.key} className={done ? 'done' : ''}>
                <span className="check-dot" aria-hidden>{done ? <Icon name="check" size={14} /> : <span className="check-pending" />}</span>
                <div className="check-body"><strong>{s.label}</strong></div>
                <span className={`badge ${done ? 'badge-good' : 'badge-neutral'}`}>{done ? 'Done' : 'Not yet'}</span>
              </li>
            );
          })}
        </ol>
        {!d.setup.admin_joined && (
          <p style={{ marginBottom: 0 }}><button className="btn btn-sm" onClick={() => go('admins')}>Manage administrator invitations</button></p>
        )}
      </Card>
      <Card title="People">
        {roles.length === 0 ? (
          <Empty title="Nobody has joined yet">People appear here once they accept an invitation.</Empty>
        ) : (
          <dl className="kv">
            {roles.map(([role, n]) => (
              <span key={role} style={{ display: 'contents' }}>
                <dt>{ROLE_LABELS[role as Role] ?? role}</dt>
                <dd>{n}</dd>
              </span>
            ))}
          </dl>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>Names and emails stay private to the company; open a support session to see them.</p>
      </Card>
      <Card title={`Hotels (${d.properties.length})`} className="span-2" flush>
        {d.properties.length === 0 ? (
          <Empty title="No hotels yet">The company admin adds hotels under Administration → Properties.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Hotel</th><th>Code</th><th>Location</th><th>Status</th><th className="num">Rooms</th><th>Time zone</th></tr></thead>
              <tbody>
                {d.properties.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td>{p.code}</td>
                    <td>{[p.city, p.region].filter(Boolean).join(', ') || '—'}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td className="num">{p.rooms ?? '—'}</td>
                    <td className="small">{p.timezone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AdminsTab({ d }: { d: CompanyDetail }) {
  const { ctx } = usePortal();
  const refresh = useRefresh(d.company.id);
  const verified = ctx?.aal === 'aal2';
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [issued, setIssued] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const issue = async (to: string) => {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc('platform_invite_admin', { p_company_id: d.company.id, p_email: to });
    setBusy(false);
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    setIssued({ email: to, link: inviteLink(data as string) });
    setCopied(false);
    setEmail('');
    await refresh();
  };
  const revoke = async (invId: string) => {
    setMsg(null);
    const { error } = await supabase.rpc('platform_revoke_admin_invitation', { p_invitation_id: invId });
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    setMsg({ tone: 'good', text: 'Invitation revoked. The link no longer works.' });
    await refresh();
  };
  const state = (i: CompanyDetail['admin_invitations'][number]) =>
    i.accepted_at ? <Badge tone="good">Joined {fmtDate(i.accepted_at)}</Badge>
      : i.revoked_at ? <Badge>Revoked</Badge>
        : new Date(i.expires_at) < new Date() ? <Badge tone="bad">Expired {fmtDate(i.expires_at)}</Badge>
          : <Badge tone="warn">Pending until {fmtDate(i.expires_at)}</Badge>;
  return (
    <div className="stack">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {issued && (
        <Card className="invite-card" title={`New invitation for ${issued.email}`}>
          <div className="copy-row">
            <input readOnly value={issued.link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn-primary" onClick={() => void navigator.clipboard.writeText(issued.link).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Copied' : 'Copy link'}</button>
            <a className="btn" href={`mailto:${issued.email}?subject=${encodeURIComponent(`Your ${d.branding?.portal_name ?? d.company.name} administrator invitation`)}&body=${encodeURIComponent(`Create your administrator account here (the link works once and expires in 14 days):\n${issued.link}\n`)}`}>Email it</a>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>Shown only now. Any earlier pending link for this email stopped working.</p>
        </Card>
      )}
      <Card title="Invite an administrator">
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (emailValid(email)) void issue(email.trim().toLowerCase()); }}>
          <input type="email" aria-label="Administrator email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: '1 1 260px' }} />
          <button className="btn btn-primary" disabled={busy || !emailValid(email) || !verified}>{busy ? 'Issuing…' : 'Issue invitation'}</button>
        </form>
        {!verified && <p className="small muted" style={{ marginBottom: 0 }}>Needs a 2FA-verified session.</p>}
      </Card>
      <Card title="Administrator invitations" flush>
        {d.admin_invitations.length === 0 ? (
          <Empty title="No administrator invitations">Issue one above.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Email</th><th>Issued</th><th>Status</th><th /></tr></thead>
              <tbody>
                {d.admin_invitations.map((i) => {
                  const open = !i.accepted_at && !i.revoked_at;
                  return (
                    <tr key={i.id}>
                      <td><strong>{i.email}</strong></td>
                      <td>{fmtDate(i.created_at)}</td>
                      <td>{state(i)}</td>
                      <td><div className="cell-actions">
                        {!i.accepted_at && <button className="btn btn-sm" disabled={busy || !verified} onClick={() => void issue(i.email)} aria-label={`Send a new link to ${i.email}`}>New link</button>}
                        {open && new Date(i.expires_at) > new Date() && <button className="btn btn-sm btn-danger" disabled={!verified} onClick={() => void revoke(i.id)} aria-label={`Revoke invitation for ${i.email}`}>Revoke</button>}
                      </div></td>
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

function BrandingTab({ d }: { d: CompanyDetail }) {
  const { ctx } = usePortal();
  const refresh = useRefresh(d.company.id);
  const [b, setB] = useState<Partial<Branding>>(d.branding ?? {});
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setB(d.branding ?? {}), [d.branding]);
  const dirty = JSON.stringify(b) !== JSON.stringify(d.branding ?? {});
  const colorsOk = ['primary_color', 'accent_color', 'surface_color'].every((k) => hexValid((b as Record<string, string>)[k] ?? ''));
  const contrast = b.primary_color && hexValid(b.primary_color) ? Math.max(contrastRatio(b.primary_color, '#ffffff'), contrastRatio(b.primary_color, '#111827')) : 0;
  const urlOk = (v: string | null | undefined) => !v || /^(https:\/\/|\/)/.test(v);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    const patch = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' && k !== 'portal_name' ? null : v]));
    const { data, error } = await supabase.from('company_branding').update(patch).eq('company_id', d.company.id).select('company_id');
    setBusy(false);
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    if (!data?.length) return setMsg({ tone: 'bad', text: 'Nothing was saved. Verify with 2FA and try again.' });
    setMsg({ tone: 'good', text: 'Branding saved.' });
    await refresh();
  };
  const text = (k: keyof Branding, label: string, hint?: string) => (
    <Field label={label} hint={hint} error={(k.endsWith('_url') && !urlOk(b[k] as string)) ? 'Must start with https://' : null}>
      <input value={(b[k] as string | null) ?? ''} onChange={(e) => setB({ ...b, [k]: e.target.value })} />
    </Field>
  );
  return (
    <div className="brand-step">
      <Card title="Branding" actions={<button className="btn btn-primary" disabled={!dirty || busy || !colorsOk || ctx?.aal !== 'aal2'} onClick={() => void save()}>{busy ? 'Saving…' : 'Save branding'}</button>}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="form-grid">
          {text('portal_name', 'Portal name')}
          {text('support_email', 'Support email')}
          {text('login_headline', 'Sign-in headline')}
          {text('email_from_name', 'Email sender name')}
        </div>
        <Field label="Sign-in message"><textarea rows={2} value={b.login_message ?? ''} onChange={(e) => setB({ ...b, login_message: e.target.value })} /></Field>
        <div className="color-row">
          {([['primary_color', 'Main colour'], ['accent_color', 'Accent'], ['surface_color', 'Background']] as const).map(([k, label]) => (
            <label key={k} className="field color-field">
              {label}
              <span className="color-input">
                <input type="color" value={hexValid(b[k] ?? '') ? b[k] : '#000000'} onChange={(e) => setB({ ...b, [k]: e.target.value })} aria-label={`${label} picker`} />
                <input value={b[k] ?? ''} onChange={(e) => setB({ ...b, [k]: e.target.value })} aria-label={`${label} hex value`} />
              </span>
            </label>
          ))}
        </div>
        {contrast > 0 && contrast < 4.5 && <Notice tone="warn">Text on the main colour will be hard to read (contrast {contrast.toFixed(1)}:1).</Notice>}
        <div className="form-grid">
          {text('logo_url', 'Logo URL')}
          {text('logo_mark_url', 'Square logo URL', 'Used in the sidebar.')}
          {text('favicon_url', 'Favicon URL')}
          {text('report_footer', 'Report footer')}
        </div>
      </Card>
      <SignInPreview b={b} companyName={d.company.name} />
    </div>
  );
}

function ProfileTab({ d }: { d: CompanyDetail }) {
  const { ctx } = usePortal();
  const refresh = useRefresh(d.company.id);
  const verified = ctx?.aal === 'aal2';
  const [f, setF] = useState({ name: d.company.name, legal_name: d.company.legal_name ?? '', default_currency: d.company.default_currency, require_mfa_for_privileged: d.company.require_mfa });
  const [msg, setMsg] = useState<Msg>(null);
  const [statusModal, setStatusModal] = useState(false);
  const [reason, setReason] = useState('');
  const save = async () => {
    setMsg(null);
    const { data, error } = await supabase.from('companies').update({ ...f, name: f.name.trim(), legal_name: f.legal_name.trim() || null }).eq('id', d.company.id).select('id');
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    if (!data?.length) return setMsg({ tone: 'bad', text: 'Nothing was saved. Verify with 2FA and try again.' });
    setMsg({ tone: 'good', text: 'Profile saved.' });
    await refresh();
  };
  const suspended = d.company.status === 'suspended';
  const setStatus = async () => {
    const { error } = await supabase.rpc('platform_set_company_status', { p_company_id: d.company.id, p_status: suspended ? 'active' : 'suspended', p_reason: reason });
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    setStatusModal(false);
    setReason('');
    setMsg({ tone: 'good', text: suspended ? 'Company reactivated. Members have their access back.' : 'Company suspended. Members can no longer see its data.' });
    await refresh();
  };
  return (
    <div className="console-grid">
      <Card title="Profile">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Company name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Legal name"><input value={f.legal_name} onChange={(e) => setF({ ...f, legal_name: e.target.value })} /></Field>
          <Field label="Reporting currency"><input maxLength={3} value={f.default_currency} onChange={(e) => setF({ ...f, default_currency: e.target.value.toUpperCase() })} /></Field>
          <label className="module-option">
            <input type="checkbox" checked={f.require_mfa_for_privileged} onChange={(e) => setF({ ...f, require_mfa_for_privileged: e.target.checked })} />
            <span><strong>Require 2FA for privileged work</strong><span className="muted small">Administration, publishing and approvals.</span></span>
          </label>
          <button className="btn btn-primary" style={{ width: 'fit-content' }} disabled={!verified || f.name.trim().length < 2}>Save profile</button>
        </form>
      </Card>
      <Card title="Status">
        <p style={{ marginTop: 0 }}>
          {suspended
            ? 'Suspended. Nobody at this company can see its data. Nothing has been deleted.'
            : 'Active. Members sign in and work normally.'}
        </p>
        <button className={`btn ${suspended ? 'btn-primary' : 'btn-danger'}`} disabled={!verified || d.company.is_demo} onClick={() => setStatusModal(true)}>
          {suspended ? 'Reactivate company' : 'Suspend company'}
        </button>
        <p className="small muted" style={{ marginBottom: 0 }}>Created {fmtDate(d.company.created_at)}</p>
      </Card>
      {statusModal && (
        <Modal title={suspended ? `Reactivate ${d.company.name}` : `Suspend ${d.company.name}`} onClose={() => setStatusModal(false)}>
          <p>{suspended ? 'Members get their access back immediately.' : 'Every member loses access immediately, including admins. Data is kept and access returns when you reactivate.'}</p>
          <Field label="Reason (recorded in the audit log)"><input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="row">
            <button className={`btn ${suspended ? 'btn-primary' : 'btn-danger'}`} disabled={!reason.trim()} onClick={() => void setStatus()}>{suspended ? 'Reactivate' : 'Suspend'}</button>
            <button className="btn" onClick={() => setStatusModal(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FeaturesTab({ d }: { d: CompanyDetail }) {
  const { ctx } = usePortal();
  const refresh = useRefresh(d.company.id);
  const [msg, setMsg] = useState<Msg>(null);
  const toggle = async (module: string, enabled: boolean) => {
    setMsg(null);
    const { data, error } = await supabase.from('company_modules').update({ enabled }).eq('company_id', d.company.id).eq('module', module).select('module');
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    if (!data?.length) return setMsg({ tone: 'bad', text: 'Nothing changed. Verify with 2FA and try again.' });
    await refresh();
  };
  return (
    <Card title="Features">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="muted" style={{ marginTop: 0 }}>Turning a feature off hides it for everyone at the company. Data is kept.</p>
      <div className="module-list">
        {MODULES.map((m) => (
          <label key={m.key} className="module-option">
            <input type="checkbox" disabled={ctx?.aal !== 'aal2'} checked={d.modules[m.key] !== false} onChange={(e) => void toggle(m.key, e.target.checked)} />
            <span><strong>{m.label}</strong><span className="muted small">{m.detail}</span></span>
          </label>
        ))}
      </div>
    </Card>
  );
}

function DomainsTab({ d }: { d: CompanyDetail }) {
  const { ctx } = usePortal();
  const refresh = useRefresh(d.company.id);
  const verified = ctx?.aal === 'aal2';
  const [host, setHost] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const hostOk = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host.trim().toLowerCase());
  const run = async (p: PromiseLike<{ error: { message: string; code?: string } | null }>, ok: string) => {
    setMsg(null);
    const { error } = await p;
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    setMsg({ tone: 'good', text: ok });
    await refresh();
  };
  return (
    <div className="stack">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Card title="Add a domain">
        <p className="muted" style={{ marginTop: 0 }}>The company’s own address for the portal, e.g. owners.lakeviewhotels.com. They point it at the portal (CNAME) and add the TXT record below; mark it verified once both are in place.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(supabase.from('company_domains').insert({ company_id: d.company.id, hostname: host.trim().toLowerCase(), is_primary: d.domains.length === 0 }), 'Domain added.').then(() => setHost('')); }}>
          <input aria-label="Domain" placeholder="owners.company.com" value={host} onChange={(e) => setHost(e.target.value)} style={{ flex: '1 1 260px' }} />
          <button className="btn btn-primary" disabled={!hostOk || !verified}>Add domain</button>
        </form>
      </Card>
      <Card title="Domains" flush>
        {d.domains.length === 0 ? (
          <Empty title="No domains">Without one, the company uses the shared portal address and default branding on the sign-in page.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Domain</th><th>DNS TXT record</th><th>Status</th><th /></tr></thead>
              <tbody>
                {d.domains.map((x) => (
                  <tr key={x.id}>
                    <td><strong>{x.hostname}</strong>{x.is_primary && <> <Badge tone="info">Primary</Badge></>}</td>
                    <td className="small"><code className="wrap-anywhere">_hop-verify.{x.hostname} = {x.verification_token}</code></td>
                    <td><StatusBadge status={x.verification_status === 'verified' ? 'approved' : x.verification_status} label={x.verification_status} /></td>
                    <td><div className="cell-actions">
                      {x.verification_status !== 'verified' && <button className="btn btn-sm" disabled={!verified} onClick={() => void run(supabase.from('company_domains').update({ verification_status: 'verified' }).eq('id', x.id), `${x.hostname} marked verified.`)}>Mark verified</button>}
                      <button className="btn btn-sm btn-danger" disabled={!verified} aria-label={`Remove ${x.hostname}`} onClick={() => void run(supabase.from('company_domains').delete().eq('id', x.id), `${x.hostname} removed.`)}>Remove</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function SupportTab({ d }: { d: CompanyDetail }) {
  const { ctx } = usePortal();
  const refresh = useRefresh(d.company.id);
  const qc = useQueryClient();
  const verified = ctx?.aal === 'aal2';
  const [f, setF] = useState({ ticket: '', reason: '', hours: 2 });
  const [msg, setMsg] = useState<Msg>(null);
  const open = async () => {
    setMsg(null);
    const { error } = await supabase.rpc('open_support_session', { p_company_id: d.company.id, p_reason: f.reason, p_ticket_ref: f.ticket, p_hours: f.hours });
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    setMsg({ tone: 'good', text: 'Support session opened. Choose “Back to …” or reload to view the company read-only; its admins can see and end the session.' });
    await refresh();
    await qc.invalidateQueries({ queryKey: ['my-context'] });
  };
  return (
    <div className="console-grid">
      <Card title="Open a support session">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <p className="muted" style={{ marginTop: 0 }}>Read-only access for up to 8 hours, never confidential documents. The company’s admins can see and end it, and everything you view is audited.</p>
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void open(); }}>
          <Field label="Ticket reference"><input value={f.ticket} onChange={(e) => setF({ ...f, ticket: e.target.value })} /></Field>
          <Field label="Reason" hint="At least 10 characters."><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Field label="Hours"><input type="number" min={1} max={8} value={f.hours} onChange={(e) => setF({ ...f, hours: Number(e.target.value) })} /></Field>
          <button className="btn btn-primary" style={{ width: 'fit-content' }} disabled={!verified || f.reason.trim().length < 10 || f.ticket.trim().length < 2}>Open session</button>
        </form>
      </Card>
      <Card title="Recent sessions" flush>
        {d.support_sessions.length === 0 ? (
          <Empty title="No support sessions" />
        ) : (
          <table className="data">
            <thead><tr><th>Ticket</th><th>Started</th><th>Ends</th></tr></thead>
            <tbody>
              {d.support_sessions.map((s) => (
                <tr key={s.id}><td>{s.ticket_ref}</td><td>{fmtDate(s.starts_at)}</td><td>{s.ended_at ? `Ended ${fmtDate(s.ended_at)}` : fmtDate(s.expires_at)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function ActivityTab({ d }: { d: CompanyDetail }) {
  return (
    <Card title="Platform activity" flush>
      {d.activity.length === 0 ? (
        <Empty title="No platform activity yet" />
      ) : (
        <ul className="activity-list">
          {d.activity.map((a, i) => (
            <li key={i}>
              <span>{ACTIVITY_LABEL[a.action] ?? a.action.replace(/^platform\./, '').replace(/_/g, ' ')}</span>
              <time className="muted small" dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted" style={{ padding: '0 16px 12px', margin: 0 }}>Actions taken from this console. The company’s own audit log is visible to its admins.</p>
    </Card>
  );
}
