/**
 * Scheduled report emails. SES receives mail for reports+<token>@<inbound domain>,
 * stores the raw MIME in a private bucket and invokes the email Lambda.
 *
 * An email is accepted only if ALL of the following hold:
 *   - the recipient token matches an active email ingestion route,
 *   - the From address matches the route's allowed senders,
 *   - SES reports SPF or DKIM PASS (when the route requires it),
 *   - attachments are CSV/XLSX within size limits.
 * Property authorization then comes from the route's explicit property mappings.
 * The sender alone never authorizes an import.
 */
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { serviceClient } from '../supabase.js';
import { fileKind } from './tables.js';
import { intakeFile, type IntakeResult } from './intake.js';

export interface InboundEnvelope {
  recipients: string[];
  spfVerdict?: string;
  dkimVerdict?: string;
  messageId?: string;
}

export interface EmailOutcome {
  accepted: boolean;
  reason?: string;
  companyId?: string;
  runs: IntakeResult[];
}

export function routeTokenFromRecipient(recipient: string, inboundDomain: string): string | null {
  const m = /^reports\+([a-z0-9]{8,64})@(.+)$/i.exec(recipient.trim());
  if (!m || m[2]!.toLowerCase() !== inboundDomain.toLowerCase()) return null;
  return m[1]!.toLowerCase();
}

export function senderAllowed(sender: string, allowed: string[]): boolean {
  const s = sender.trim().toLowerCase();
  return allowed.some((a) => {
    const rule = a.trim().toLowerCase();
    return rule.startsWith('@') ? s.endsWith(rule) : s === rule;
  });
}

async function audit(companyId: string | null, action: string, metadata: Record<string, unknown>) {
  const svc = await serviceClient();
  await svc.rpc('svc_audit', {
    p_company_id: companyId,
    p_action: action,
    p_entity_type: 'inbound_email',
    p_entity_id: (metadata.messageId as string) ?? null,
    p_metadata: metadata,
    p_property_id: null,
    p_actor: null,
  });
}

export async function handleInboundEmail(raw: Uint8Array, env: InboundEnvelope): Promise<EmailOutcome> {
  const cfg = config();
  const svc = await serviceClient();
  const token = env.recipients.map((r) => routeTokenFromRecipient(r, cfg.INBOUND_EMAIL_DOMAIN)).find(Boolean) ?? null;
  if (!token) {
    await audit(null, 'ingestion.email_rejected', { reason: 'unknown_recipient', recipients: env.recipients, messageId: env.messageId });
    return { accepted: false, reason: 'unknown_recipient', runs: [] };
  }
  const { data: route } = await svc
    .from('ingestion_source_routes')
    .select('source_id, company_id, allowed_senders, require_spf_dkim_pass, ingestion_sources!inner(id, active, channel, report_type, parser_key)')
    .eq('inbound_token', token)
    .maybeSingle();
  const r = route as
    | { source_id: string; company_id: string; allowed_senders: string[]; require_spf_dkim_pass: boolean; ingestion_sources: { active: boolean; channel: string; report_type: 'daily_performance' | 'monthly_actuals' | 'budget'; parser_key: string } }
    | null;
  if (!r || !r.ingestion_sources.active || r.ingestion_sources.channel !== 'email') {
    await audit(r?.company_id ?? null, 'ingestion.email_rejected', { reason: 'inactive_or_unknown_route', messageId: env.messageId });
    return { accepted: false, reason: 'inactive_or_unknown_route', runs: [] };
  }

  const mail = await simpleParser(Buffer.from(raw));
  const from = mail.from?.value[0]?.address ?? '';
  if (!from || !senderAllowed(from, r.allowed_senders)) {
    await audit(r.company_id, 'ingestion.email_rejected', { reason: 'sender_not_allowed', from, messageId: env.messageId });
    return { accepted: false, reason: 'sender_not_allowed', companyId: r.company_id, runs: [] };
  }
  if (r.require_spf_dkim_pass && env.spfVerdict !== 'PASS' && env.dkimVerdict !== 'PASS') {
    await audit(r.company_id, 'ingestion.email_rejected', { reason: 'authentication_failed', from, spf: env.spfVerdict, dkim: env.dkimVerdict, messageId: env.messageId });
    return { accepted: false, reason: 'authentication_failed', companyId: r.company_id, runs: [] };
  }

  const attachments = mail.attachments.filter((a) => a.filename && fileKind(a.filename, a.contentType));
  if (attachments.length === 0) {
    await audit(r.company_id, 'ingestion.email_rejected', { reason: 'no_supported_attachments', from, messageId: env.messageId });
    return { accepted: false, reason: 'no_supported_attachments', companyId: r.company_id, runs: [] };
  }
  const runs: IntakeResult[] = [];
  for (const a of attachments) {
    runs.push(
      await intakeFile({
        companyId: r.company_id,
        sourceId: r.source_id,
        reportType: r.ingestion_sources.report_type,
        parserKey: r.ingestion_sources.parser_key,
        filename: a.filename!,
        bytes: new Uint8Array(a.content),
        receivedVia: 'email',
        sender: from,
        emailMessageId: env.messageId ?? mail.messageId ?? null,
        requestedBy: null,
      }),
    );
  }
  return { accepted: true, companyId: r.company_id, runs };
}
