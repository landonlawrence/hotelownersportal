import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from '../lib/supabase';
import { useCompany } from '../state/portal';
import { Card, Empty, Loading, PageHeader, fmtDate } from '../components/ui';

export function NotificationsPage() {
  const company = useCompany();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications', company.company_id],
    queryFn: async () => unwrap(await supabase.from('notifications').select('id, kind, title, body, link_path, created_at, read_at').eq('company_id', company.company_id).order('created_at', { ascending: false }).limit(100)) as Array<{ id: string; kind: string; title: string; body: string | null; link_path: string | null; created_at: string; read_at: string | null }>,
  });
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
        {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? <Empty title="You’re all caught up" /> : (
          <table className="data">
            <tbody>
              {q.data!.map((n) => (
                <tr key={n.id} style={{ fontWeight: n.read_at ? 400 : 600 }}>
                  <td style={{ width: 12 }}>{!n.read_at && <span aria-label="unread" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: 'var(--brand-accent)' }} />}</td>
                  <td>{n.link_path ? <Link to={n.link_path} onClick={() => markRead(n.id)}>{n.title}</Link> : n.title}{n.body && <div className="small muted" style={{ fontWeight: 400 }}>{n.body}</div>}</td>
                  <td className="small muted">{fmtDate(n.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td>{!n.read_at && <button className="btn btn-ghost btn-sm" onClick={() => markRead(n.id)}>Mark read</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
