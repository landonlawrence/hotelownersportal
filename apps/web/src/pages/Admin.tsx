import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSION_KEYS, ROLE_LABELS, ROLES, contrastRatio, type Role } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { apiJson } from '../lib/api';
import { useDisplayNames, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate } from '../components/ui';

type Tab = 'users' | 'invitations' | 'branding' | 'audit' | 'support' | 'platform';

export function AdminPage() {
  const { can, ctx } = usePortal();
  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'users', label: 'Users & access', show: can('admin.users') },
    { id: 'invitations', label: 'Invitations', show: can('admin.users') },
    { id: 'branding', label: 'Branding', show: can('admin.company') },
    { id: 'audit', label: 'Audit log', show: can('audit.view') },
    { id: 'support', label: 'Support access', show: can('admin.users') },
    { id: 'platform', label: 'Platform', show: !!ctx?.is_platform_admin },
  ];
  const visible = tabs.filter((t) => t.show);
  const [chosen, setTab] = useState<Tab | null>(null);
  const tab: Tab = chosen && visible.some((t) => t.id === chosen) ? chosen : visible[0]?.id ?? 'users';
  if (visible.length === 0) return <Empty title="No administrative access" />;
  return (
    <div className="stack">
      <PageHeader title="Administration" subtitle="Changes to access, branding and settings are recorded in the audit log." />
      <div className="tabs" role="tablist">{visible.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
      {tab === 'users' && <Users />}
      {tab === 'invitations' && <Invitations />}
      {tab === 'branding' && <Branding />}
      {tab === 'audit' && <Audit />}
      {tab === 'support' && <Support />}
      {tab === 'platform' && <Platform />}
    </div>
  );
}

interface Member {
  id: string; user_id: string; role: Role; status: string; all_properties: boolean; title: string | null; created_at: string; revoked_at: string | null; revoke_reason: string | null;
  property_access_grants: Array<{ id: string; property_id: string; permissions: string[] | null; revoked_at: string | null; expires_at: string | null }>;
  membership_permission_overrides: Array<{ permission_key: string; effect: string }>;
}

function Users() {
  const company = useCompany();
  const { properties, ctx } = usePortal();
  const q = useQuery({
    queryKey: ['members', company.company_id],
    refetchOnMount: 'always',
    queryFn: async () => unwrap(await supabase.from('company_memberships').select('id, user_id, role, status, all_properties, title, created_at, revoked_at, revoke_reason, property_access_grants(id, property_id, permissions, revoked_at, expires_at), membership_permission_overrides(permission_key, effect)').eq('company_id', company.company_id).order('status').order('role')) as unknown as Member[],
  });
  const profiles = useQuery({
    queryKey: ['member-profiles', company.company_id, q.data?.map((m) => m.user_id).join(',')],
    enabled: !!q.data,
    queryFn: async () => new Map((unwrap(await supabase.from('profiles').select('id, email, full_name').in('id', q.data!.map((m) => m.user_id))) as Array<{ id: string; email: string; full_name: string | null }>).map((p) => [p.id, p])),
  });
  const [editing, setEditing] = useState<Member | null>(null);
  if (q.isLoading) return <Loading />;
  return (
    <Card flush title="Members">
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>User</th><th>Role</th><th>Property access</th><th>Overrides</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(q.data ?? []).map((m) => {
              const p = profiles.data?.get(m.user_id);
              const active = m.property_access_grants.filter((g) => !g.revoked_at);
              return (
                <tr key={m.id} style={{ opacity: m.status === 'revoked' ? 0.6 : 1 }}>
                  <td><strong>{p?.full_name ?? p?.email ?? '—'}</strong><div className="small muted">{p?.email}{m.title && ` · ${m.title}`}</div></td>
                  <td>{ROLE_LABELS[m.role]}</td>
                  <td className="small">{m.all_properties ? 'All properties' : active.length === 0 ? 'None' : active.map((g) => `${properties.find((x) => x.id === g.property_id)?.code ?? '?'}${g.permissions ? ' (limited)' : ''}`).join(', ')}</td>
                  <td className="small">{m.membership_permission_overrides.map((o) => `${o.effect === 'deny' ? '−' : '+'}${o.permission_key}`).join(', ') || '—'}</td>
                  <td><StatusBadge status={m.status} />{m.revoke_reason && <div className="small muted">{m.revoke_reason}</div>}</td>
                  <td>{m.status === 'active' && m.user_id !== ctx?.user_id && <button className="btn btn-sm" onClick={() => setEditing(m)}>Manage</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <ManageMember member={editing} email={profiles.data?.get(editing.user_id)?.email ?? ''} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function ManageMember({ member, email, onClose }: { member: Member; email: string; onClose: () => void }) {
  const { properties } = usePortal();
  const qc = useQueryClient();
  const [role, setRole] = useState<Role>(member.role);
  const [all, setAll] = useState(member.all_properties);
  const [err, setErr] = useState<string | null>(null);
  const [grantProp, setGrantProp] = useState('');
  const [limited, setLimited] = useState<string[]>([]);
  const [override, setOverride] = useState({ perm: '', effect: 'deny' });
  const [reason, setReason] = useState('');
  const run = async (fn: string, args: Record<string, unknown>) => {
    setErr(null);
    const { error } = await supabase.rpc(fn, args);
    if (error) setErr(error.message);
    await qc.invalidateQueries({ queryKey: ['members'] });
    return !error;
  };
  const active = member.property_access_grants.filter((g) => !g.revoked_at);
  return (
    <Modal title={`Manage ${email}`} onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      <h3>Role</h3>
      <div className="row">
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
        {!['owner', 'investor'].includes(role) && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All properties</label>}
        <button className="btn btn-sm" onClick={() => run('update_membership', { p_membership_id: member.id, p_role: role, p_all_properties: ['owner', 'investor'].includes(role) ? false : all, p_title: null })}>Save role</button>
      </div>
      <h3>Property access</h3>
      <ul className="timeline">
        {active.map((g) => (
          <li key={g.id} className="spread">
            <span>{properties.find((p) => p.id === g.property_id)?.name}{g.permissions && <span className="small muted"> — limited to {g.permissions.join(', ')}</span>}</span>
            <button className="btn btn-sm btn-danger" onClick={() => run('revoke_property_access', { p_grant_id: g.id })}>Revoke</button>
          </li>
        ))}
        {active.length === 0 && <li className="muted">No property-specific grants.</li>}
      </ul>
      <div className="row">
        <select aria-label="Property to grant" value={grantProp} onChange={(e) => setGrantProp(e.target.value)}><option value="">Grant property…</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <details><summary className="small">Limit permissions</summary>
          <div style={{ maxHeight: 160, overflowY: 'auto' }}>{PERMISSION_KEYS.filter((k) => !k.startsWith('admin') && !k.startsWith('audit')).map((k) => <label key={k} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={limited.includes(k)} onChange={(e) => setLimited(e.target.checked ? [...limited, k] : limited.filter((x) => x !== k))} />{k}</label>)}</div>
        </details>
        <button className="btn btn-sm" disabled={!grantProp} onClick={() => run('grant_property_access', { p_membership_id: member.id, p_property_id: grantProp, p_permissions: limited.length ? limited : null, p_expires_at: null }).then(() => { setGrantProp(''); setLimited([]); })}>Grant</button>
      </div>
      <h3>Permission override</h3>
      <div className="row">
        <select aria-label="Permission" value={override.perm} onChange={(e) => setOverride({ ...override, perm: e.target.value })}><option value="">Permission…</option>{PERMISSION_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <select aria-label="Effect" value={override.effect} onChange={(e) => setOverride({ ...override, effect: e.target.value })}><option value="deny">Deny</option><option value="allow">Allow</option><option value="">Remove override</option></select>
        <button className="btn btn-sm" disabled={!override.perm} onClick={() => run('set_permission_override', { p_membership_id: member.id, p_permission: override.perm, p_effect: override.effect || null })}>Apply</button>
      </div>
      <h3>Revoke all access</h3>
      <div className="row">
        <input aria-label="Revocation reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn btn-danger" disabled={!reason.trim()} onClick={() => run('revoke_membership', { p_membership_id: member.id, p_reason: reason }).then((ok) => ok && onClose())}>Revoke membership</button>
      </div>
    </Modal>
  );
}

function Invitations() {
  const company = useCompany();
  const { properties } = usePortal();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invitations', company.company_id], queryFn: async () => unwrap(await supabase.from('invitations').select('id, email, role, all_properties, property_ids, created_at, expires_at, accepted_at, revoked_at').eq('company_id', company.company_id).order('created_at', { ascending: false })) as Array<{ id: string; email: string; role: Role; all_properties: boolean; property_ids: string[]; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }> });
  const [f, setF] = useState({ email: '', role: 'owner' as Role, all: false, props: [] as string[] });
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string; link?: string } | null>(null);
  const revoke = useRpc('revoke_invitation');
  const send = async () => {
    setMsg(null);
    try {
      const res = await apiJson<{ invitation_id: string; invite_url?: string }>('/admin/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company_id: company.company_id, email: f.email, role: f.role, all_properties: f.all, property_ids: f.props }) });
      setMsg({ tone: 'good', text: `Invitation sent to ${f.email}.`, link: res.invite_url });
      setF({ email: '', role: 'owner', all: false, props: [] });
      await qc.invalidateQueries({ queryKey: ['invitations'] });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  };
  const status = (i: { accepted_at: string | null; revoked_at: string | null; expires_at: string }) => (i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at) < new Date() ? 'expired' : 'pending');
  const ownerLike = ['owner', 'investor'].includes(f.role);
  return (
    <div className="stack">
      <Card title="Invite a user">
        {msg && <Notice tone={msg.tone}>{msg.text}{msg.link && <> Local development link: <a href={msg.link}>{msg.link}</a></>}</Notice>}
        <div className="filter-bar" style={{ border: 0, padding: 0 }}>
          <label className="field">Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field">Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role, all: false })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></label>
          {!ownerLike && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.all} onChange={(e) => setF({ ...f, all: e.target.checked })} /> All properties</label>}
        </div>
        {!f.all && (
          <fieldset style={{ border: 0, padding: 0, marginTop: 8 }}>
            <legend className="small muted">Properties</legend>
            <div className="row">{properties.map((p) => <label key={p.id} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={f.props.includes(p.id)} onChange={(e) => setF({ ...f, props: e.target.checked ? [...f.props, p.id] : f.props.filter((x) => x !== p.id) })} />{p.name}</label>)}</div>
          </fieldset>
        )}
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!f.email || (!f.all && f.props.length === 0)} onClick={send}>Send invitation</button>
      </Card>
      <Card flush title="Invitations">
        <table className="data">
          <thead><tr><th>Email</th><th>Role</th><th>Access</th><th>Sent</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(q.data ?? []).map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td><td>{ROLE_LABELS[i.role]}</td>
                <td className="small">{i.all_properties ? 'All properties' : i.property_ids.map((id) => properties.find((p) => p.id === id)?.code).join(', ')}</td>
                <td>{fmtDate(i.created_at)}</td><td><StatusBadge status={status(i) === 'pending' ? 'pending' : status(i) === 'accepted' ? 'completed' : 'cancelled'} label={status(i)} /></td>
                <td>{status(i) === 'pending' && <button className="btn btn-sm btn-danger" onClick={() => revoke.mutate({ p_invitation_id: i.id })}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Branding() {
  const company = useCompany();
  const { refresh } = usePortal();
  const q = useQuery({ queryKey: ['branding', company.company_id], queryFn: async () => unwrap(await supabase.from('company_branding').select('*').eq('company_id', company.company_id).single()) as Record<string, string | null> });
  const domains = useQuery({ queryKey: ['domains', company.company_id], queryFn: async () => unwrap(await supabase.from('company_domains').select('hostname, is_primary, verification_status, verification_token').eq('company_id', company.company_id)) as Array<{ hostname: string; is_primary: boolean; verification_status: string; verification_token: string }> });
  const modules = useQuery({ queryKey: ['modules', company.company_id], queryFn: async () => unwrap(await supabase.from('company_modules').select('module, enabled').eq('company_id', company.company_id)) as Array<{ module: string; enabled: boolean }> });
  const [edit, setEdit] = useState<Record<string, string | null> | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const b = edit ?? q.data;
  if (!b) return <Loading />;
  const set = (k: string, v: string) => setEdit({ ...(edit ?? q.data!), [k]: v || null });
  const contrast = b.primary_color ? Math.max(contrastRatio(b.primary_color, '#ffffff'), contrastRatio(b.primary_color, '#111827')) : 0;
  const save = async () => {
    const { company_id: _c, updated_at: _u, ...patch } = edit!;
    const { error } = await supabase.from('company_branding').update(patch).eq('company_id', company.company_id);
    if (error) setMsg({ tone: 'bad', text: error.message });
    else { setMsg({ tone: 'good', text: 'Branding saved.' }); setEdit(null); await refresh(); }
  };
  const fields: Array<[string, string, string?]> = [
    ['portal_name', 'Portal name'], ['login_headline', 'Login headline'], ['login_message', 'Login message'], ['support_email', 'Support email'], ['email_from_name', 'Email sender name'],
    ['logo_url', 'Logo URL (https:// or /path)'], ['logo_mark_url', 'Logo mark URL'], ['favicon_url', 'Favicon URL'], ['report_footer', 'Report footer'],
  ];
  return (
    <div className="grid grid-2">
      <Card title="Branding" actions={edit && <button className="btn btn-primary" onClick={save}>Save</button>}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="stack" style={{ gap: 10 }}>
          {fields.map(([k, label]) => <label key={k} className="field">{label}<input value={b[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></label>)}
          <div className="row">
            {['primary_color', 'accent_color', 'surface_color'].map((k) => <label key={k} className="field">{k.replace('_color', '').replace(/^./, (c) => c.toUpperCase())}<input type="color" value={b[k] ?? '#000000'} onChange={(e) => set(k, e.target.value)} /></label>)}
          </div>
          <p className="small muted">Text on the primary colour is chosen automatically for contrast ({contrast.toFixed(1)}:1).</p>
        </div>
      </Card>
      <div className="stack">
        <Card title="Preview">
          <div style={{ background: b.primary_color ?? '#000', color: contrastRatio(b.primary_color ?? '#000000', '#ffffff') >= contrastRatio(b.primary_color ?? '#000000', '#111827') ? '#fff' : '#111827', borderRadius: 8, padding: 16 }}>
            {b.logo_url && <img src={b.logo_url} alt="" height={28} style={{ background: '#fff', borderRadius: 6, padding: 4 }} />}
            <h2 style={{ marginTop: 8 }}>{b.login_headline ?? b.portal_name}</h2>
            <p style={{ opacity: 0.85 }}>{b.login_message}</p>
            <span style={{ background: b.accent_color ?? '#000', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>Accent</span>
          </div>
        </Card>
        <Card title="Domains">
          <table className="data"><tbody>{(domains.data ?? []).map((d) => <tr key={d.hostname}><td>{d.hostname}{d.is_primary && <span className="small muted"> · primary</span>}</td><td><StatusBadge status={d.verification_status === 'verified' ? 'completed' : 'pending'} label={d.verification_status} /></td><td className="small muted">{d.verification_status !== 'verified' && `TXT _hop-verify=${d.verification_token}`}</td></tr>)}</tbody></table>
          <p className="small muted">Custom domains are added and verified by the platform team (DNS TXT record + certificate). Domains select branding only; they never grant access.</p>
        </Card>
        <Card title="Modules">
          <div className="row">{(modules.data ?? []).map((m) => <StatusBadge key={m.module} status={m.enabled ? 'active' : 'cancelled'} label={`${m.module}${m.enabled ? '' : ' (off)'}`} />)}</div>
          <p className="small muted">Modules are configured per company by the platform team.</p>
        </Card>
      </div>
    </div>
  );
}

function Audit() {
  const company = useCompany();
  const [action, setAction] = useState('');
  const q = useQuery({
    queryKey: ['audit', company.company_id, action],
    queryFn: async () => {
      let qb = supabase.from('audit_events').select('id, created_at, actor_user_id, actor_kind, action, entity_type, entity_id, property_id, metadata').eq('company_id', company.company_id).order('created_at', { ascending: false }).limit(200);
      if (action) qb = qb.ilike('action', `%${action}%`);
      return unwrap(await qb) as Array<{ id: number; created_at: string; actor_user_id: string | null; actor_kind: string; action: string; entity_type: string; entity_id: string | null; metadata: Record<string, unknown> }>;
    },
  });
  const names = useDisplayNames((q.data ?? []).map((a) => a.actor_user_id));
  return (
    <Card flush title={<label className="field">Filter action<input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. download, published, grant" /></label>}>
      <div className="table-wrap" style={{ maxHeight: 600 }}>
        <table className="data">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
          <tbody>
            {(q.data ?? []).map((a) => (
              <tr key={a.id}>
                <td className="small">{new Date(a.created_at).toLocaleString()}</td>
                <td className="small">{a.actor_user_id ? names.data?.get(a.actor_user_id) ?? a.actor_user_id.slice(0, 8) : 'system'}{a.actor_kind !== 'user' && <> <StatusBadge status="pending" label={a.actor_kind} /></>}</td>
                <td>{a.action}</td>
                <td className="small">{a.entity_type}</td>
                <td className="small muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>{JSON.stringify(a.metadata)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Support() {
  const company = useCompany();
  const end = useRpc('end_support_session');
  const q = useQuery({ queryKey: ['support-sessions', company.company_id], queryFn: async () => unwrap(await supabase.from('support_access_sessions').select('id, user_id, reason, ticket_ref, starts_at, expires_at, ended_at').eq('company_id', company.company_id).order('starts_at', { ascending: false })) as Array<{ id: string; user_id: string; reason: string; ticket_ref: string; starts_at: string; expires_at: string; ended_at: string | null }> });
  const names = useDisplayNames((q.data ?? []).map((s) => s.user_id));
  return (
    <Card flush title="Platform support sessions">
      <p className="small muted" style={{ padding: '0 16px' }}>Platform support staff have no standing access to your data. A support session is opened deliberately with a reason and ticket, expires automatically, is read-only, excludes confidential documents, and can be ended by you at any time.</p>
      {(q.data ?? []).length === 0 ? <Empty title="No support sessions" /> : (
        <table className="data">
          <thead><tr><th>Support user</th><th>Ticket</th><th>Reason</th><th>Window</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data!.map((s) => {
            const live = !s.ended_at && new Date(s.expires_at) > new Date();
            return <tr key={s.id}><td>{names.data?.get(s.user_id) ?? '—'}</td><td>{s.ticket_ref}</td><td>{s.reason}</td><td className="small">{new Date(s.starts_at).toLocaleString()} – {new Date(s.expires_at).toLocaleString()}</td><td><StatusBadge status={live ? 'in_progress' : 'completed'} label={live ? 'active' : 'ended'} /></td><td>{live && <button className="btn btn-sm btn-danger" onClick={() => end.mutate({ p_session_id: s.id })}>End now</button>}</td></tr>;
          })}</tbody>
        </table>
      )}
    </Card>
  );
}

export function Platform() {
  const qc = useQueryClient();
  const { ctx } = usePortal();
  const companies = useQuery({ queryKey: ['platform-companies'], queryFn: async () => unwrap(await supabase.from('companies').select('id, slug, name, status, is_demo').order('name')) as Array<{ id: string; slug: string; name: string; status: string; is_demo: boolean }> });
  const [support, setSupport] = useState({ company: '', reason: '', ticket: '', hours: 2 });
  const [prov, setProv] = useState({ slug: '', name: '', portal: '', email: '' });
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const call = async (fn: string, args: Record<string, unknown>, ok: string) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) setMsg({ tone: 'bad', text: error.message });
    else { setMsg({ tone: 'good', text: ok + (fn === 'provision_company' ? ` Admin invitation token: ${(data as { token: string }).token}` : '') }); await qc.invalidateQueries(); }
  };
  return (
    <div className="stack">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {ctx?.aal !== 'aal2' && <Notice tone="warn">Support sessions require two-factor verification (Account security).</Notice>}
      <Card title="Open a support session">
        <div className="filter-bar" style={{ border: 0, padding: 0 }}>
          <label className="field">Company<select value={support.company} onChange={(e) => setSupport({ ...support, company: e.target.value })}><option value="">Select…</option>{companies.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">Ticket<input value={support.ticket} onChange={(e) => setSupport({ ...support, ticket: e.target.value })} /></label>
          <label className="field">Reason<input value={support.reason} onChange={(e) => setSupport({ ...support, reason: e.target.value })} /></label>
          <label className="field">Hours<input type="number" min={1} max={8} value={support.hours} onChange={(e) => setSupport({ ...support, hours: Number(e.target.value) })} /></label>
          <button className="btn btn-primary" disabled={!support.company || support.reason.length < 10 || !support.ticket} onClick={() => call('open_support_session', { p_company_id: support.company, p_reason: support.reason, p_ticket_ref: support.ticket, p_hours: support.hours }, 'Support session opened (audited; company admins can see and end it).')}>Open session</button>
        </div>
      </Card>
      <Card title="Provision a management company">
        <div className="filter-bar" style={{ border: 0, padding: 0 }}>
          <label className="field">Slug<input value={prov.slug} onChange={(e) => setProv({ ...prov, slug: e.target.value })} /></label>
          <label className="field">Name<input value={prov.name} onChange={(e) => setProv({ ...prov, name: e.target.value })} /></label>
          <label className="field">Portal name<input value={prov.portal} onChange={(e) => setProv({ ...prov, portal: e.target.value })} /></label>
          <label className="field">First admin email<input type="email" value={prov.email} onChange={(e) => setProv({ ...prov, email: e.target.value })} /></label>
          <button className="btn btn-primary" disabled={!prov.slug || !prov.name || !prov.email} onClick={() => call('provision_company', { p_slug: prov.slug, p_name: prov.name, p_portal_name: prov.portal || prov.name, p_admin_email: prov.email }, 'Company provisioned.')}>Provision</button>
        </div>
      </Card>
      <Card flush title="Companies">
        <table className="data"><tbody>{companies.data?.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.slug}</td><td><StatusBadge status={c.status} /></td><td>{c.is_demo && 'Demo'}</td></tr>)}</tbody></table>
      </Card>
    </div>
  );
}
