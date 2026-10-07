import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import type { AppEnv } from '../context.js';
import { badRequest, fromPostgrest } from '../errors.js';
import { requireUser } from '../middleware.js';
import { serviceClient } from '../supabase.js';

export const admin = new Hono<AppEnv>();
admin.use('*', requireUser);

const inviteSchema = z.object({
  company_id: z.string().uuid(),
  email: z.string().email().max(254),
  role: z.enum(['company_admin', 'corporate_finance', 'corporate_operations', 'property_manager', 'owner', 'investor']),
  all_properties: z.boolean().default(false),
  property_ids: z.array(z.string().uuid()).default([]),
  expires_in_days: z.number().int().min(1).max(30).default(7),
});

/** Create an invitation (authorized in the database as the admin) and queue the branded email. */
admin.post('/invitations', async (c) => {
  const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const b = parsed.data;
  const { data, error } = await c.get('db').rpc('create_invitation', {
    p_company_id: b.company_id,
    p_email: b.email,
    p_role: b.role,
    p_all_properties: b.all_properties,
    p_property_ids: b.property_ids,
    p_expires_in_days: b.expires_in_days,
  });
  if (error) throw fromPostgrest(error);
  const { invitation_id, token } = data as { invitation_id: string; token: string };
  const cfg = config();
  const svc = await serviceClient();
  const { data: domain } = await svc
    .from('company_domains')
    .select('hostname')
    .eq('company_id', b.company_id)
    .eq('verification_status', 'verified')
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: brand } = await svc.from('company_branding').select('portal_name').eq('company_id', b.company_id).single();
  const host = (domain as { hostname: string } | null)?.hostname;
  const base = host ? `${host.includes('localhost') ? 'http' : 'https'}://${host}` : cfg.PUBLIC_APP_URL;
  const inviteUrl = `${base}/accept-invite#token=${token}`;
  const portal = (brand as { portal_name: string }).portal_name;
  await svc.from('notification_outbox').insert({
    company_id: b.company_id,
    to_email: b.email.toLowerCase(),
    subject: `You're invited to ${portal}`,
    body_text: `You have been invited to ${portal}.\n\nAccept your invitation (expires in ${b.expires_in_days} days):\n${inviteUrl}\n\nIf you did not expect this invitation, you can ignore this email.`,
  });
  const exposeLink = cfg.APP_ENV === 'local' || cfg.APP_ENV === 'test';
  return c.json({ invitation_id, ...(exposeLink ? { invite_url: inviteUrl } : {}) }, 201);
});
