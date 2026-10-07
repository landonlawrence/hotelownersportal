import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { config } from './config.js';

/** Client acting as the end user: every query is subject to RLS. */
export function userClient(accessToken: string): SupabaseClient {
  const cfg = config();
  return createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

let service: SupabaseClient | undefined;
let serviceKey: string | undefined;

async function resolveServiceKey(): Promise<string> {
  const cfg = config();
  if (serviceKey) return serviceKey;
  if (cfg.SUPABASE_SERVICE_ROLE_KEY) {
    serviceKey = cfg.SUPABASE_SERVICE_ROLE_KEY;
  } else if (cfg.SUPABASE_SERVICE_ROLE_SECRET_ARN) {
    const sm = new SecretsManagerClient({ region: cfg.AWS_REGION });
    const out = await sm.send(new GetSecretValueCommand({ SecretId: cfg.SUPABASE_SERVICE_ROLE_SECRET_ARN }));
    if (!out.SecretString) throw new Error('Service role secret is empty');
    serviceKey = out.SecretString.trim();
  } else {
    throw new Error('Service role key is not configured');
  }
  return serviceKey;
}

/**
 * Privileged client for background jobs and storage-key lookups. Callers MUST
 * perform explicit authorization (user-scoped RPC checks or svc_user_has_permission)
 * before acting on behalf of a user. Never exposed to browsers.
 */
export async function serviceClient(): Promise<SupabaseClient> {
  if (service) return service;
  const cfg = config();
  service = createClient(cfg.SUPABASE_URL, await resolveServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return service;
}

export function resetClientsForTests(): void {
  service = undefined;
  serviceKey = undefined;
}
