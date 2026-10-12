import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSION_KEYS, ROLE_LABELS, ROLES, contrastRatio, isInternalOnlyPermission, type Role } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { apiJson, fetchMeta } from '../lib/api';
import { useDisplayNames, useRpc } from '../lib/hooks';
import { usePortal, useCompany } from '../state/portal';
import { AdminProperties } from './AdminProperties';
import { Badge, Card, Empty, Loading, Modal, Notice, PageHeader, StatusBadge, TabPanel, Tabs, confirmAction, dbErrorMessage, errorMessage, fmtDate, localToday } from '../components/ui';

type Tab = 'users' | 'invitations' | 'properties' | 'branding' | 'audit' | 'support' | 'platform';

export function AdminPage() {
  const { can, ctx, mfaLocked } = usePortal();
  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'users', label: 'Users & access', show: can('admin.users') },
    { id: 'invitations', label: 'Invitations', show: can('admin.users') },
    { id: 'properties', label: 'Properties', show: can('admin.company') },
    { id: 'branding', label: 'Branding', show: can('admin.company') },
    { id: 'audit', label: 'Audit log', show: can('audit.view') },
    { id: 'support', label: 'Support access', show: can('admin.users') },
    { id: 'platform', label: 'Platform', show: !!ctx?.is_platform_admin },
  ];
  const visible = tabs.filter((t) => t.show);
  const [params, setParams] = useSearchParams();
  const chosen = params.get('tab') as Tab | null;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  const tab: Tab = chosen && visible.some((t) => t.id === chosen) ? chosen : visible[0]?.id ?? 'users';
  if (visible.length === 0) {
    return mfaLocked('admin.users') || mfaLocked('admin.company') ? (
      <Card>
        <Empty title="Verify with two-factor authentication to open Administration">
          Your company protects user, property and branding settings with 2FA.
          <span className="row" style={{ justifyContent: 'center', marginTop: 8 }}><Link className="btn btn-primary" to="/security?next=/admin">Verify with 2FA</Link></span>
        </Empty>
      </Card>
    ) : (
      <Empty title="No administrative access" />
    );
  }
  return (
    <div className="stack">
      <PageHeader title="Administration" subtitle="Changes to access, branding and settings are recorded in the audit log." />
      <Tabs label="Administration sections" idPrefix="admin" tabs={visible} value={tab} onChange={setTab} />
      <TabPanel idPrefix="admin" value={tab}>
        {tab === 'users' && <Users />}
        {tab === 'invitations' && <Invitations />}
        {tab === 'properties' && <AdminProperties />}
        {tab === 'branding' && <Branding />}
        {tab === 'audit' && <Audit />}
        {tab === 'support' && <Support />}
        {tab === 'platform' && <Platform />}
      </TabPanel>
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
  // Keep only the id so the dialog always shows the live membership after each change.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = q.data?.find((m) => m.id === editingId) ?? null;
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
                  <td>{m.status === 'active' && m.user_id !== ctx?.user_id && <button className="btn btn-sm" onClick={() => setEditingId(m.id)}>Manage</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <ManageMember member={editing} email={profiles.data?.get(editing.user_id)?.email ?? ''} onClose={() => setEditingId(null)} />}
    </Card>
  );
}

function ManageMember({ member, email, onClose }: { member: Member; email: string; onClose: () => void }) {
  const { properties } = usePortal();
  const qc = useQueryClient();
  const [role, setRole] = useState<Role>(member.role);
  const [all, setAll] = useState(member.all_properties);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [grantProp, setGrantProp] = useState('');
  const [limited, setLimited] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const [override, setOverride] = useState({ perm: '', effect: 'deny' });
  const [reason, setReason] = useState('');
  const ownerLike = ['owner', 'investor'].includes(member.role);
  const run = async (fn: string, args: Record<string, unknown>, success: string) => {
    setMsg(null);
    setBusy(true);
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    setMsg(error ? { tone: 'bad', text: dbErrorMessage(error)! } : { tone: 'good', text: success });
    await qc.invalidateQueries({ queryKey: ['members'] });
    return !error;
  };
  const active = member.property_access_grants.filter((g) => !g.revoked_at);
  const existing = active.find((g) => g.property_id === grantProp);
  const propName = (id: string) => properties.find((p) => p.id === id)?.name ?? 'property';
  const describe = (perms: string[] | null) => (perms ? perms.join(', ') : 'all of the member’s role permissions');
  const grant = async () => {
    const perms = limited.length ? limited : null;
    if (existing && !confirmAction(`${propName(grantProp)} already has a grant.\n\nCurrent: ${describe(existing.permissions)}${existing.expires_at ? ` (expires ${fmtDate(existing.expires_at)})` : ''}\nNew: ${describe(perms)}${expires ? ` (expires ${fmtDate(expires)})` : ''}\n\nReplace it?`)) return;
    const ok = await run('grant_property_access', { p_membership_id: member.id, p_property_id: grantProp, p_permissions: perms, p_expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null }, existing ? `Replaced access to ${propName(grantProp)}.` : `Granted access to ${propName(grantProp)}.`);
    if (ok) {
      setGrantProp('');
      setLimited([]);
      setExpires('');
    }
  };
  const today = localToday();
  const overrideOptions = PERMISSION_KEYS.filter((k) => !(ownerLike && override.effect === 'allow' && isInternalOnlyPermission(k)));
  return (
    <Modal title={`Manage ${email}`} onClose={onClose}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <h3>Role</h3>
      <div className="row">
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
        {!['owner', 'investor'].includes(role) && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All properties</label>}
        <button className="btn btn-sm" disabled={busy} onClick={() => void run('update_membership', { p_membership_id: member.id, p_role: role, p_all_properties: ['owner', 'investor'].includes(role) ? false : all, p_title: null }, 'Role saved.')}>Save role</button>
      </div>
      <h3>Property access</h3>
      <ul className="timeline">
        {active.map((g) => (
          <li key={g.id} className="spread">
            <span>
              {propName(g.property_id)}
              <span className="small muted"> — {g.permissions ? `limited to ${g.permissions.join(', ')}` : 'full role permissions'}{g.expires_at && `, expires ${fmtDate(g.expires_at)}`}</span>
            </span>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirmAction(`Revoke access to ${propName(g.property_id)}?`) && void run('revoke_property_access', { p_grant_id: g.id }, `Revoked access to ${propName(g.property_id)}.`)}>Revoke</button>
          </li>
        ))}
        {active.length === 0 && <li className="muted">No property-specific grants.</li>}
      </ul>
      <div className="row">
        <select aria-label="Property to grant" value={grantProp} onChange={(e) => setGrantProp(e.target.value)}>
          <option value="">Grant property…</option>
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}{active.some((g) => g.property_id === p.id) ? ' (has access)' : ''}</option>)}
        </select>
        <details><summary className="small">Limit permissions</summary>
          <div style={{ maxHeight: 160, overflowY: 'auto' }}>{PERMISSION_KEYS.filter((k) => !k.startsWith('admin') && !k.startsWith('audit')).map((k) => <label key={k} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={limited.includes(k)} onChange={(e) => setLimited(e.target.checked ? [...limited, k] : limited.filter((x) => x !== k))} />{k}</label>)}</div>
        </details>
        <label className="field small">Expires (optional)<input type="date" min={today} value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        <button className="btn btn-sm" disabled={!grantProp || busy || (!!expires && expires < today)} onClick={() => void grant()}>{existing ? 'Replace grant' : 'Grant'}</button>
      </div>
      {existing && <p className="small muted" style={{ margin: 0 }}>This member already has access to {propName(grantProp)} ({describe(existing.permissions)}). Granting again replaces it.</p>}
      <h3>Permission override</h3>
      <div className="row">
        <select aria-label="Permission" value={override.perm} onChange={(e) => setOverride({ ...override, perm: e.target.value })}><option value="">Permission…</option>{overrideOptions.map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <select aria-label="Effect" value={override.effect} onChange={(e) => setOverride({ perm: e.target.value === 'allow' && ownerLike && isInternalOnlyPermission(override.perm) ? '' : override.perm, effect: e.target.value })}><option value="deny">Deny</option><option value="allow">Allow</option><option value="">Remove override</option></select>
        <button className="btn btn-sm" disabled={!override.perm || busy} onClick={() => void run('set_permission_override', { p_membership_id: member.id, p_permission: override.perm, p_effect: override.effect || null }, 'Override saved.')}>Apply</button>
      </div>
      {ownerLike && <p className="small muted" style={{ margin: 0 }}>Owners and investors can’t be given administration, audit or internal-only permissions.</p>}
      <h3>Revoke all access</h3>
      <div className="row">
        <input aria-label="Revocation reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn btn-danger" disabled={!reason.trim() || busy} onClick={() => void run('revoke_membership', { p_membership_id: member.id, p_reason: reason }, 'Membership revoked.').then((ok) => ok && onClose())}>Revoke membership</button>
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
  const meta = useQuery({ queryKey: ['api-meta'], staleTime: 60_000, queryFn: fetchMeta, retry: false });
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  const send = async () => {
    setMsg(null);
    setCopied(false);
    setSending(true);
    try {
      const to = f.email.trim();
      const res = await apiJson<{ invitation_id: string; invite_url?: string }>('/admin/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company_id: company.company_id, email: to, role: f.role, all_properties: f.all, property_ids: f.props }) });
      const emailed = meta.data?.emailEnabled === true;
      setMsg({
        tone: 'good',
        text: emailed ? `Invitation sent to ${to}.` : `Email isn’t configured, so no message was sent. Copy this link and send it to ${to} yourself.`,
        link: res.invite_url,
      });
      setF({ email: '', role: 'owner', all: false, props: [] });
      await qc.invalidateQueries({ queryKey: ['invitations'] });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setSending(false);
    }
  };
  const status = (i: { accepted_at: string | null; revoked_at: string | null; expires_at: string }) => (i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at) < new Date() ? 'expired' : 'pending');
  const ownerLike = ['owner', 'investor'].includes(f.role);
  return (
    <div className="stack">
      <Card title="Invite a user">
        {msg && (
          <Notice tone={msg.tone}>
            {msg.text}
            {msg.link && (
              <span className="copy-row" style={{ marginTop: 8 }}>
                <a href={msg.link} className="token">{msg.link}</a>
                <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(msg.link!).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Copied' : 'Copy link'}</button>
              </span>
            )}
          </Notice>
        )}
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
        {f.email.trim() && !emailOk && <span className="field-error">Enter a valid email address.</span>}
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={sending || !emailOk || (!f.all && f.props.length === 0)} onClick={() => void send()}>{sending ? 'Sending…' : 'Send invitation'}</button>
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
                <td>{status(i) === 'pending' && <button className="btn btn-sm btn-danger" onClick={() => confirmAction(`Revoke the invitation for ${i.email}?`) && revoke.mutate({ p_invitation_id: i.id })}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

const INK = '#111827';
const onColor = (bg: string) => (contrastRatio(bg, '#ffffff') >= contrastRatio(bg, INK) ? '#ffffff' : INK);
const bestContrast = (bg: string) => Math.max(contrastRatio(bg, '#ffffff'), contrastRatio(bg, INK));

function Branding() {
  const company = useCompany();
  const { refresh } = usePortal();
  const q = useQuery({ queryKey: ['branding', company.company_id], queryFn: async () => unwrap(await supabase.from('company_branding').select('*').eq('company_id', company.company_id).single()) as Record<string, string | null> });
  const domains = useQuery({ queryKey: ['domains', company.company_id], queryFn: async () => unwrap(await supabase.from('company_domains').select('hostname, is_primary, verification_status, verification_token').eq('company_id', company.company_id)) as Array<{ hostname: string; is_primary: boolean; verification_status: string; verification_token: string }> });
  const modules = useQuery({ queryKey: ['modules', company.company_id], queryFn: async () => unwrap(await supabase.from('company_modules').select('module, enabled').eq('company_id', company.company_id)) as Array<{ module: string; enabled: boolean }> });
  const [edit, setEdit] = useState<Record<string, string | null> | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const b = edit ?? q.data;
  if (!b) return <Loading />;
  const set = (k: string, v: string) => setEdit({ ...(edit ?? q.data!), [k]: v || null });
  const primary = b.primary_color ?? '#1f3a5f';
  const accent = b.accent_color ?? '#c8a24a';
  const surface = b.surface_color ?? '#f6f7f9';
  const checks = [
    { label: 'Text on the page background', ratio: contrastRatio(surface, INK), min: 4.5, block: 3 },
    { label: 'Text on the primary colour', ratio: bestContrast(primary), min: 4.5, block: 0 },
    { label: 'Text on the accent colour', ratio: bestContrast(accent), min: 4.5, block: 0 },
  ];
  const weak = checks.filter((c) => c.ratio < c.min);
  const blocking = checks.filter((c) => c.block > 0 && c.ratio < c.block);
  const fieldErrors: Record<string, string | null> = {
    portal_name: !b.portal_name || b.portal_name.trim().length < 2 || b.portal_name.trim().length > 120 ? 'Portal name must be 2–120 characters.' : null,
    support_email: b.support_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.support_email) ? 'Enter a valid email address.' : null,
    logo_url: b.logo_url && !/^(https:\/\/|\/)/.test(b.logo_url) ? 'Must start with https:// or /' : null,
    logo_mark_url: b.logo_mark_url && !/^(https:\/\/|\/)/.test(b.logo_mark_url) ? 'Must start with https:// or /' : null,
    favicon_url: b.favicon_url && !/^(https:\/\/|\/)/.test(b.favicon_url) ? 'Must start with https:// or /' : null,
  };
  const invalid = Object.values(fieldErrors).some(Boolean) || blocking.length > 0;
  const save = async () => {
    if (!edit || invalid) return;
    setSaving(true);
    const { company_id: _c, updated_at: _u, ...patch } = edit;
    const { error } = await supabase.from('company_branding').update(patch).eq('company_id', company.company_id);
    setSaving(false);
    if (error) setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    else { setMsg({ tone: 'good', text: 'Branding saved.' }); setEdit(null); await refresh(); }
  };
  const fields: Array<[string, string]> = [
    ['portal_name', 'Portal name'], ['login_headline', 'Login headline'], ['login_message', 'Login message'], ['support_email', 'Support email'], ['email_from_name', 'Email sender name'],
    ['logo_url', 'Logo URL (https:// or /path)'], ['logo_mark_url', 'Logo mark URL'], ['favicon_url', 'Favicon URL'], ['report_footer', 'Report footer'],
  ];
  return (
    <div className="grid grid-2">
      <Card title="Branding" actions={edit && <span className="row" style={{ gap: 6 }}><button className="btn" onClick={() => { setEdit(null); setMsg(null); }}>Discard changes</button><button className="btn btn-primary" disabled={invalid || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button></span>}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="stack" style={{ gap: 10 }}>
          {fields.map(([k, label]) => <label key={k} className="field">{label}<input value={b[k] ?? ''} onChange={(e) => set(k, e.target.value)} />{fieldErrors[k] && <span className="field-error">{fieldErrors[k]}</span>}</label>)}
          <div className="row">
            {['primary_color', 'accent_color', 'surface_color'].map((k) => <label key={k} className="field">{k.replace('_color', '').replace(/^./, (c) => c.toUpperCase())}<input type="color" value={b[k] ?? '#000000'} onChange={(e) => set(k, e.target.value)} /></label>)}
          </div>
          {weak.length > 0 ? (
            <Notice tone={blocking.length ? 'bad' : 'warn'}>
              Low contrast: {weak.map((c) => `${c.label.toLowerCase()} is ${c.ratio.toFixed(1)}:1`).join('; ')} (4.5:1 recommended{blocking.length ? '; the page background needs at least 3:1 to save' : ''}).
            </Notice>
          ) : (
            <p className="small muted">Contrast checks pass: page text {checks[0]!.ratio.toFixed(1)}:1, primary {checks[1]!.ratio.toFixed(1)}:1, accent {checks[2]!.ratio.toFixed(1)}:1.</p>
          )}
        </div>
      </Card>
      <div className="stack">
        <Card title="Preview">
          <div style={{ background: surface, borderRadius: 8, padding: 12, color: INK }}>
            <div style={{ background: primary, color: onColor(primary), borderRadius: 8, padding: 16 }}>
              {b.logo_url && <img src={b.logo_url} alt="" height={28} style={{ background: '#fff', borderRadius: 6, padding: 4 }} />}
              <h2 style={{ marginTop: 8 }}>{b.login_headline ?? b.portal_name}</h2>
              <p style={{ opacity: 0.85 }}>{b.login_message}</p>
              <span style={{ background: accent, color: onColor(accent), padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>Accent</span>
            </div>
            <p style={{ margin: '10px 0 0' }}>Page text on the surface colour.</p>
          </div>
        </Card>
        <Card title="Domains">
          <div className="table-wrap">
            <table className="data"><tbody>{(domains.data ?? []).map((d) => (
              <tr key={d.hostname}>
                <td>{d.hostname}{d.is_primary && <span className="small muted"> · primary</span>}</td>
                <td><StatusBadge status={d.verification_status === 'verified' ? 'completed' : 'pending'} label={d.verification_status} /></td>
                <td className="small muted" style={{ whiteSpace: 'normal' }}>
                  {d.verification_status !== 'verified' && (
                    <span className="row" style={{ gap: 6 }}>
                      <code className="token">_hop-verify={d.verification_token}</code>
                      <button className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard.writeText(`_hop-verify=${d.verification_token}`)}>Copy</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}</tbody></table>
          </div>
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

interface AuditRow { id: number; created_at: string; actor_user_id: string | null; actor_kind: string; action: string; entity_type: string; entity_id: string | null; metadata: Record<string, unknown> }

const PAGE = 100;

function describeAudit(a: AuditRow): string {
  const m = a.metadata ?? {};
  const parts: string[] = [];
  const who = m.user_email as string | undefined;
  if (m.permission) parts.push(`${m.effect === 'deny' ? 'deny' : 'allow'} ${String(m.permission)}`);
  if (Array.isArray(m.permissions)) parts.push(`limited to ${(m.permissions as string[]).join(', ')}`);
  else if ('permissions' in m || a.entity_type === 'property_access_grants') parts.push('full role permissions');
  if (m.role) parts.push(`role ${String(m.role)}`);
  if (m.external_code) parts.push(`code ${String(m.external_code)}`);
  if (m.reason) parts.push(`reason: ${String(m.reason)}`);
  if (m.ticket_ref) parts.push(`ticket ${String(m.ticket_ref)}`);
  if (m.expires_at) parts.push(`expires ${fmtDate(String(m.expires_at))}`);
  if (m.revoked_at) parts.push('revoked');
  if (m.token_changed) parts.push('secret changed (value not recorded)');
  if (m.changes && typeof m.changes === 'object') parts.push(`changed ${Object.keys(m.changes as object).join(', ')}`);
  return [who && `for ${who}`, ...parts].filter(Boolean).join(' · ');
}

function Audit() {
  const company = useCompany();
  const { properties } = usePortal();
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const term = search.trim().toLowerCase();
  const q = useQuery({
    queryKey: ['audit', company.company_id, term, from, to, limit],
    queryFn: async () => {
      let qb = supabase.from('audit_events').select('id, created_at, actor_user_id, actor_kind, action, entity_type, entity_id, property_id, metadata').eq('company_id', company.company_id).order('created_at', { ascending: false }).limit(limit + 1);
      if (term) qb = qb.ilike('search_text', `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`);
      if (from) qb = qb.gte('created_at', new Date(`${from}T00:00:00`).toISOString());
      if (to) qb = qb.lt('created_at', new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString());
      return unwrap(await qb) as AuditRow[];
    },
  });
  const rows = (q.data ?? []).slice(0, limit);
  const more = (q.data ?? []).length > limit;
  const names = useDisplayNames(rows.map((a) => a.actor_user_id));
  const entity = (a: AuditRow) => {
    const pid = (a.metadata?.property_id as string | undefined) ?? undefined;
    const prop = pid ? properties.find((p) => p.id === pid)?.code : undefined;
    return `${a.entity_type.replace(/_/g, ' ')}${a.entity_id ? ` ${a.entity_id.slice(0, 8)}` : ''}${prop ? ` · ${prop}` : ''}`;
  };
  return (
    <Card
      flush
      title={
        <div className="filter-bar" style={{ border: 0, padding: 0 }}>
          <label className="field">Search<input value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }} placeholder="action, type, email, code…" /></label>
          <label className="field">From<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setLimit(PAGE); }} /></label>
          <label className="field">To<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setLimit(PAGE); }} /></label>
        </div>
      }
    >
      {q.isLoading ? <Loading /> : rows.length === 0 ? <Empty title="No audit events match">Try a different search or date range.</Empty> : (
        <div className="table-wrap" style={{ maxHeight: 600 }}>
          <table className="data">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="small">{new Date(a.created_at).toLocaleString()}</td>
                  <td className="small">{a.actor_user_id ? names.data?.get(a.actor_user_id) ?? a.actor_user_id.slice(0, 8) : 'system'}{a.actor_kind !== 'user' && <> <StatusBadge status="pending" label={a.actor_kind} /></>}</td>
                  <td>{a.action}</td>
                  <td className="small" title={a.entity_id ?? undefined}>{entity(a)}</td>
                  <td className="small muted" style={{ maxWidth: 420, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{describeAudit(a) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && <div style={{ padding: 12 }}><button className="btn btn-sm" onClick={() => setLimit(limit + PAGE)}>Load more</button></div>}
    </Card>
  );
}

function Support() {
  const company = useCompany();
  const end = useRpc('end_support_session');
  const q = useQuery({ queryKey: ['support-sessions', company.company_id], queryFn: async () => unwrap(await supabase.from('support_access_sessions').select('id, user_id, reason, ticket_ref, starts_at, expires_at, ended_at').eq('company_id', company.company_id).order('starts_at', { ascending: false })) as Array<{ id: string; user_id: string; reason: string; ticket_ref: string; starts_at: string; expires_at: string; ended_at: string | null }> });
  // Admins may read the identity of support staff who opened sessions on their company.
  const people = useQuery({
    queryKey: ['support-people', (q.data ?? []).map((s) => s.user_id).join(',')],
    enabled: (q.data ?? []).length > 0,
    queryFn: async () => new Map((unwrap(await supabase.from('profiles').select('id, email, full_name').in('id', [...new Set(q.data!.map((s) => s.user_id))])) as Array<{ id: string; email: string; full_name: string | null }>).map((p) => [p.id, p])),
  });
  return (
    <Card flush title="Platform support sessions">
      <p className="small muted" style={{ padding: '0 16px' }}>Platform support staff have no standing access to your data. A support session is opened deliberately with a reason and ticket, expires automatically, is read-only, excludes confidential documents, and can be ended by you at any time. Administrators are notified when one opens.</p>
      {end.error && <div style={{ padding: '0 16px' }}><Notice tone="bad">{errorMessage(end.error)}</Notice></div>}
      {(q.data ?? []).length === 0 ? <Empty title="No support sessions" /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Support user</th><th>Ticket</th><th>Reason</th><th>Window</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data!.map((s) => {
              const live = !s.ended_at && new Date(s.expires_at) > new Date();
              const p = people.data?.get(s.user_id);
              return (
                <tr key={s.id}>
                  <td>{p ? <><strong>{p.full_name ?? p.email}</strong><div className="small muted">{p.email}</div></> : '—'}</td>
                  <td>{s.ticket_ref}</td>
                  <td>{s.reason}</td>
                  <td className="small">{new Date(s.starts_at).toLocaleString()} – {new Date(s.expires_at).toLocaleString()}{s.ended_at && <div className="muted">Ended {new Date(s.ended_at).toLocaleString()}</div>}</td>
                  <td><StatusBadge status={live ? 'in_progress' : 'completed'} label={live ? 'active' : s.ended_at ? 'ended' : 'expired'} /></td>
                  <td>{live && <button className="btn btn-sm btn-danger" disabled={end.isPending} onClick={() => confirmAction('End this support session now? Support staff lose access immediately.') && end.mutate({ p_session_id: s.id })}>End now</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Platform() {
  const qc = useQueryClient();
  const { ctx } = usePortal();
  const companies = useQuery({ queryKey: ['platform-companies'], queryFn: async () => unwrap(await supabase.from('companies').select('id, slug, name, status, is_demo, created_at').order('name')) as Array<{ id: string; slug: string; name: string; status: string; is_demo: boolean; created_at: string }> });
  const [support, setSupport] = useState({ company: '', reason: '', ticket: '', hours: 2 });
  const [prov, setProv] = useState({ slug: '', name: '', portal: '', email: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [invite, setInvite] = useState<{ company: string; email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40);
  const slugOk = /^[a-z0-9][a-z0-9-]{1,39}$/.test(prov.slug) && !prov.slug.endsWith('-');
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(prov.email.trim());
  const verified = ctx?.aal === 'aal2';
  const [busy, setBusy] = useState(false);
  const provision = async () => {
    setMsg(null);
    setBusy(true);
    const { data, error } = await supabase.rpc('provision_company', { p_slug: prov.slug, p_name: prov.name.trim(), p_portal_name: prov.portal.trim() || prov.name.trim(), p_admin_email: prov.email.trim() });
    setBusy(false);
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    setInvite({ company: prov.name.trim(), email: prov.email.trim(), link: `${window.location.origin}/accept-invite#token=${(data as { token: string }).token}` });
    setCopied(false);
    setProv({ slug: '', name: '', portal: '', email: '' });
    setSlugEdited(false);
    await qc.invalidateQueries({ queryKey: ['platform-companies'] });
  };
  const openSupport = async () => {
    setMsg(null);
    const { error } = await supabase.rpc('open_support_session', { p_company_id: support.company, p_reason: support.reason, p_ticket_ref: support.ticket, p_hours: support.hours });
    if (error) return setMsg({ tone: 'bad', text: dbErrorMessage(error)! });
    setMsg({ tone: 'good', text: 'Support session opened (audited; company admins can see and end it).' });
    await qc.invalidateQueries();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite!.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="stack">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {invite && (
        <Card className="invite-card" title={`${invite.company} is ready`}>
          <div className="stack" style={{ gap: 10 }}>
            <p style={{ margin: 0 }}>Send this invitation link to <strong>{invite.email}</strong>. It works once and expires in 14 days. They’ll create their password and become the company administrator.</p>
            <div className="copy-row">
              <input readOnly value={invite.link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-primary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>This link is shown only now. If it’s lost, provision again with a different slug or ask an engineer to reissue it.</p>
          </div>
        </Card>
      )}
      <Card title="Provision a management company">
        {!verified && <Notice tone="warn">Provisioning needs a 2FA-verified session. <Link to="/security">Verify with 2FA</Link>.</Notice>}
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void provision(); }}>
          <label className="field">Company name<input required placeholder="Greyridge Hospitality" value={prov.name} onChange={(e) => setProv({ ...prov, name: e.target.value, slug: slugEdited ? prov.slug : slugify(e.target.value) })} /></label>
          <label className="field">
            Short ID (slug)
            <input required pattern="[a-z0-9\-]{2,40}" placeholder="greyridge" value={prov.slug} onChange={(e) => { setSlugEdited(true); setProv({ ...prov, slug: slugify(e.target.value) }); }} />
            <span className={prov.slug && !slugOk ? 'field-error' : 'small muted'}>{prov.slug && !slugOk ? 'Use 2–40 lowercase letters, numbers or dashes; start and end with a letter or number.' : 'Lowercase letters, numbers and dashes. Other characters are converted to dashes.'}</span>
          </label>
          <label className="field">Portal name<input placeholder={prov.name ? `${prov.name} Owner Portal` : 'Shown on the sign-in page'} value={prov.portal} onChange={(e) => setProv({ ...prov, portal: e.target.value })} /></label>
          <label className="field">First admin’s email<input required type="email" placeholder="admin@company.com" value={prov.email} onChange={(e) => setProv({ ...prov, email: e.target.value })} />{prov.email && !emailOk && <span className="field-error">Enter a valid email address.</span>}</label>
          <div className="form-actions"><button className="btn btn-primary" disabled={busy || !slugOk || prov.name.trim().length < 2 || !emailOk || !verified}>{busy ? 'Provisioning…' : 'Provision company'}</button></div>
        </form>
      </Card>
      <Card title="Open a support session">
        <div className="stack" style={{ gap: 10 }}>
          {ctx?.aal !== 'aal2' && <Notice tone="warn">Support sessions need a 2FA-verified session. <Link to="/security">Set up or verify 2FA</Link>.</Notice>}
          <p className="muted small" style={{ margin: 0 }}>Read-only access to one company for up to 8 hours. The company’s admins can see and end it, and everything is audited.</p>
          <div className="form-grid">
            <label className="field">Company<select value={support.company} onChange={(e) => setSupport({ ...support, company: e.target.value })}><option value="">Select…</option>{companies.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">Ticket reference<input value={support.ticket} onChange={(e) => setSupport({ ...support, ticket: e.target.value })} /></label>
            <label className="field">Reason (10+ characters)<input value={support.reason} onChange={(e) => setSupport({ ...support, reason: e.target.value })} /></label>
            <label className="field">Hours<input type="number" min={1} max={8} value={support.hours} onChange={(e) => setSupport({ ...support, hours: Number(e.target.value) })} /></label>
            <div className="form-actions"><button className="btn" disabled={!support.company || support.reason.length < 10 || !support.ticket || ctx?.aal !== 'aal2'} onClick={openSupport}>Open session</button></div>
          </div>
        </div>
      </Card>
      <Card flush title={`Companies (${companies.data?.length ?? 0})`}>
        {companies.data?.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>{companies.data.map((c) => <tr key={c.id}><td><strong>{c.name}</strong>{c.is_demo && <> <Badge>Demo</Badge></>}</td><td className="muted">{c.slug}</td><td><StatusBadge status={c.status} /></td><td>{fmtDate(c.created_at)}</td></tr>)}</tbody>
            </table>
          </div>
        ) : (
          <Empty title="No companies yet">Provision the first management company above.</Empty>
        )}
      </Card>
    </div>
  );
}
