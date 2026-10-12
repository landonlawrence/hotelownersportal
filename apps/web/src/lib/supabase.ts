import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see apps/web/.env.example)');
}

/** Browser client: publishable key + the user's session. All data access is governed by RLS. */
export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export class DbError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** Unwrap a supabase-js response, throwing a readable error. */
export function unwrap<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new DbError(res.error.message, res.error.code);
  return res.data as T;
}

/** A rejected or expired token: signing in again is the only way out. */
export function isAuthError(e: unknown): boolean {
  if (!e) return false;
  const code = e instanceof DbError ? e.code : undefined;
  const msg = e instanceof Error ? e.message : String(e);
  return code === 'PGRST301' || code === 'PGRST302' || /\bJWT\b|invalid claim|token is expired/i.test(msg);
}
