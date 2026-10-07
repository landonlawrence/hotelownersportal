import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';
import { HttpError } from './errors.js';

export interface AuthContext {
  userId: string;
  email: string | null;
  aal: string;
  token: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * Verify a Supabase access token. The API never trusts client-supplied user ids:
 * identity comes only from a valid, unexpired token with the `authenticated` role.
 */
export async function verifyAccessToken(token: string): Promise<AuthContext> {
  const cfg = config();
  let payload: JWTPayload;
  try {
    const { alg } = decodeProtectedHeader(token);
    if (alg === 'HS256') {
      // Legacy shared-secret projects only; asymmetric keys are preferred.
      if (!cfg.SUPABASE_JWT_SECRET) throw new Error('HS256 tokens not accepted');
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(cfg.SUPABASE_JWT_SECRET), {
        algorithms: ['HS256'],
        audience: 'authenticated',
      }));
    } else {
      jwks ??= createRemoteJWKSet(new URL(`${cfg.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
      ({ payload } = await jwtVerify(token, jwks, {
        algorithms: ['ES256', 'RS256'],
        audience: 'authenticated',
        issuer: `${cfg.SUPABASE_URL}/auth/v1`,
      }));
    }
  } catch {
    throw new HttpError(401, 'Invalid or expired session', 'unauthenticated');
  }
  if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') {
    throw new HttpError(401, 'Invalid session', 'unauthenticated');
  }
  return {
    userId: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    aal: typeof payload.aal === 'string' ? payload.aal : 'aal1',
    token,
  };
}

export function bearerToken(header: string | undefined | null): string {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) throw new HttpError(401, 'Missing bearer token', 'unauthenticated');
  return m[1]!.trim();
}
