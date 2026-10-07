import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { bearerToken, verifyAccessToken } from './auth.js';
import { config } from './config.js';
import type { AppEnv } from './context.js';
import { serviceClient, userClient } from './supabase.js';

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.header('x-request-id') ?? randomUUID();
  c.set('requestId', id);
  await next();
  c.header('x-request-id', id);
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('cache-control', c.res.headers.get('cache-control') ?? 'no-store');
  c.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
  c.header('x-frame-options', 'DENY');
};

/** Requires a valid Supabase session; attaches an RLS-scoped database client. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await verifyAccessToken(bearerToken(c.req.header('authorization')));
  c.set('auth', auth);
  c.set('db', userClient(auth.token));
  await next();
};

function patternToRegex(p: string): RegExp {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+');
  return new RegExp(`^${esc}$`, 'i');
}

const verifiedCache = new Map<string, { ok: boolean; at: number }>();

/**
 * CORS: static patterns (local/dev) or a verified tenant custom domain.
 * CORS is not an authorization control — every endpoint still authenticates.
 */
export async function isAllowedOrigin(origin: string): Promise<boolean> {
  const cfg = config();
  if (cfg.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean).some((p) => patternToRegex(p).test(origin))) return true;
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    host = u.host.toLowerCase();
  } catch {
    return false;
  }
  const hit = verifiedCache.get(host);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  const svc = await serviceClient();
  const { data } = await svc.from('company_domains').select('id').eq('hostname', host).eq('verification_status', 'verified').maybeSingle();
  const ok = !!data;
  verifiedCache.set(host, { ok, at: Date.now() });
  return ok;
}
