import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePortal } from '../state/portal';
import { supabase, unwrap } from '../lib/supabase';
import { useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, PageHeader, fmtDate } from '../components/ui';

export function NotificationsPage() {
  const company = useCompany();
  const { properties } = usePortal();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications', company.company_id],
    queryFn: async () => unwrap(await supabase.from('notifications').select('id, kind, title, body, link_path, created_at, read_at, property_id').eq('company_id', company.company_id).order('created_at', { ascending: false }).limit(100)) as Array<{ id: string; kind: string; title: string; body: string | null; link_path: string | null; created_at: string; read_at: string | null; property_id: string | null }>,
  });
  // Older notifications were stored without the property in the title.
  const titleOf = (n: { title: string; property_id: string | null }) => {
    const name = properties.find((p) => p.id === n.property_id)?.name;
    return name && !n.title.includes(name) ? `${n.title} — ${name}` : n.title;
  };
  const markRead = async (id?: string) => {
    if (id) await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
    else await supabase.rpc('mark_all_notifications_read', { p_company_id: company.company_id });
    await qc.invalidateQueries({ queryKey: ['notifications'] });
    await qc.invalidateQueries({ queryKey: ['unread'] });
  };
  return (
    <div className="stack">
      <PageHeader title="Notifications" subtitle="Publication, approval and data alerts for this company." actions={<button className="btn" onClick={() => markRead()}>Mark all read</button>} />
      <Card flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <Empty title="You’re all caught up" /> : (
          <table className="data">
            <tbody>
              {q.data!.map((n) => (
                <tr key={n.id} style={{ fontWeight: n.read_at ? 400 : 600 }}>
                  <td style={{ width: 12 }}>{!n.read_at && <span role="img" aria-label="Unread" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: 'var(--brand-accent)' }} />}</td>
                  <td>{n.link_path ? <Link to={n.link_path} onClick={() => markRead(n.id)}>{titleOf(n)}</Link> : titleOf(n)}{n.body && <div className="small muted" style={{ fontWeight: 400 }}>{n.body}</div>}</td>
                  <td className="small muted">{fmtDate(n.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td>{!n.read_at && <button className="btn btn-ghost btn-sm" aria-label={`Mark read: ${titleOf(n)}`} onClick={() => markRead(n.id)}>Mark read</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <EmailPreferences />
    </div>
  );
}

/** Email notification kinds a user may receive (in-app notifications are always kept). */
const EMAIL_KINDS: Array<{ kind: string; label: string; perm?: string }> = [
  { kind: 'financial_report_published', label: 'Financial statement published', perm: 'financials.view' },
  { kind: 'reporting_package_published', label: 'Owner report published', perm: 'reports.view' },
  { kind: 'budget_approved', label: 'Budget approved', perm: 'budgets.view' },
  { kind: 'capex_approval_requested', label: 'CapEx approval requested', perm: 'capex.approve' },
  { kind: 'financial_review_requested', label: 'Financial statement ready for review', perm: 'financials.publish' },
  { kind: 'capex_request_decided', label: 'Your CapEx request was approved or rejected', perm: 'capex.edit' },
  { kind: 'support_session_opened', label: 'Platform support access opened', perm: 'admin.users' },
];

function EmailPreferences() {
  const company = useCompany();
  const { ctx, canAny } = usePortal();
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: ['notification-prefs', company.company_id],
    queryFn: async () => new Map((unwrap(await supabase.from('notification_preferences').select('kind, email_enabled').eq('company_id', company.company_id)) as Array<{ kind: string; email_enabled: boolean }>).map((p) => [p.kind, p.email_enabled])),
  });
  const kinds = EMAIL_KINDS.filter((k) => !k.perm || canAny(k.perm as never));
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const toggle = async (kind: string, enabled: boolean) => {
    // Reflect the change immediately; roll back if the save fails.
    setLocal((l) => ({ ...l, [kind]: enabled }));
    const { error } = await supabase.from('notification_preferences').upsert({ user_id: ctx!.user_id, company_id: company.company_id, kind, email_enabled: enabled }, { onConflict: 'user_id,company_id,kind' });
    if (error) setLocal((l) => ({ ...l, [kind]: !enabled }));
    await qc.invalidateQueries({ queryKey: ['notification-prefs', company.company_id] });
  };
  return (
    <Card title="Email preferences">
      <p className="small muted">Choose which events also send an email to {ctx?.email}. Emails contain a sign-in link only — never figures or attachments. In-app notifications are always kept.</p>
      {prefs.isLoading ? <Loading /> : prefs.error ? <ErrorState error={prefs.error} retry={() => void prefs.refetch()} /> : (
        <table className="data">
          <tbody>
            {kinds.map((k) => {
              const on = local[k.kind] ?? prefs.data?.get(k.kind) ?? true;
              return (
                <tr key={k.kind}>
                  <td>{k.label}</td>
                  <td style={{ width: 120 }}>
                    <label className="row small" style={{ gap: 6 }}>
                      <input type="checkbox" checked={on} onChange={(e) => toggle(k.kind, e.target.checked)} aria-label={`Email: ${k.label}`} /> Email
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
