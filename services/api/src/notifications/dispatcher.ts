/** Sends queued notification emails. Emails contain no financial figures or attachments. */
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { config } from '../config.js';
import { serviceClient } from '../supabase.js';

export interface EmailSender {
  send(to: string, subject: string, text: string, fromName: string): Promise<void>;
}

class SesSender implements EmailSender {
  private readonly ses = new SESv2Client({});
  async send(to: string, subject: string, text: string, fromName: string) {
    const cfg = config();
    await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: `"${fromName.replace(/"/g, '')}" <${cfg.EMAIL_FROM_ADDRESS}>`,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      }),
    );
  }
}

export const sentLog: Array<{ to: string; subject: string; text: string }> = [];
class LogSender implements EmailSender {
  async send(to: string, subject: string, text: string) {
    sentLog.push({ to, subject, text });
    if (config().APP_ENV === 'local') console.info(`[email] to=${to} subject=${subject}`);
  }
}

export async function dispatchNotifications(limit = 50, sender?: EmailSender): Promise<{ sent: number; failed: number }> {
  const cfg = config();
  const s = sender ?? (cfg.EMAIL_DRIVER === 'ses' ? new SesSender() : new LogSender());
  const svc = await serviceClient();
  const { data: rows } = await svc
    .from('notification_outbox')
    .select('id, company_id, to_email, subject, body_text, attempts, companies(name, company_branding(email_from_name))')
    .in('status', ['pending', 'failed'])
    .lt('attempts', 5)
    .order('created_at')
    .limit(limit);
  let sent = 0;
  let failed = 0;
  for (const r of (rows ?? []) as unknown as Array<{
    id: string;
    to_email: string;
    subject: string;
    body_text: string;
    attempts: number;
    companies: { name: string; company_branding: { email_from_name: string | null } | null } | null;
  }>) {
    // Claim the row to avoid double sends from concurrent dispatchers.
    const { data: claimed } = await svc
      .from('notification_outbox')
      .update({ status: 'sending', attempts: r.attempts + 1 })
      .eq('id', r.id)
      .in('status', ['pending', 'failed'])
      .select('id');
    if (!claimed?.length) continue;
    try {
      const fromName = r.companies?.company_branding?.email_from_name ?? r.companies?.name ?? 'Owner Portal';
      await s.send(r.to_email, r.subject, r.body_text, fromName);
      await svc.from('notification_outbox').update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null }).eq('id', r.id);
      sent++;
    } catch (e) {
      await svc.from('notification_outbox').update({ status: 'failed', last_error: (e as Error).message.slice(0, 500) }).eq('id', r.id);
      failed++;
    }
  }
  return { sent, failed };
}
