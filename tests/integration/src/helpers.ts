import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { createApp, handleJob, LocalQueue, setQueue, writeDemoFiles } from '@hop/api';

export const PASSWORD = 'DemoPass!2026';

export const COMPANY = {
  harborview: '10000000-0000-4000-8000-000000000001',
  summit: '10000000-0000-4000-8000-000000000002',
} as const;

export const PROPERTY = {
  sea: '20000000-0000-4000-8000-000000000101',
  pdx: '20000000-0000-4000-8000-000000000102',
  sfo: '20000000-0000-4000-8000-000000000103',
  hnl: '20000000-0000-4000-8000-000000000104',
  den: '20000000-0000-4000-8000-000000000201',
  aus: '20000000-0000-4000-8000-000000000202',
  mia: '20000000-0000-4000-8000-000000000203',
} as const;

export const USER = {
  platform: 'platform@portal.example',
  hvAdmin: 'admin@harborview.example',
  hvFinance: 'finance@harborview.example',
  hvOps: 'ops@harborview.example',
  hvGm: 'gm.seattle@harborview.example',
  olivia: 'olivia.owner@owners.example',
  ian: 'ian.investor@owners.example',
  rita: 'revoked.owner@owners.example',
  spAdmin: 'admin@summitpeak.example',
  spFinance: 'finance@summitpeak.example',
} as const;

export const MEMBERSHIP = {
  oliviaHv: '50000000-0000-4000-8000-000000000021',
  ianHv: '50000000-0000-4000-8000-000000000022',
  hvAdmin: '50000000-0000-4000-8000-000000000011',
  hvGm: '50000000-0000-4000-8000-000000000014',
} as const;

export function anonClient(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function serviceDb(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Session {
  db: SupabaseClient;
  token: string;
  userId: string;
}

const sessions = new Map<string, Session>();

export async function signIn(email: string, password = PASSWORD, fresh = false): Promise<Session> {
  if (!fresh && sessions.has(email)) return sessions.get(email)!;
  const db = anonClient();
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign in failed for ${email}: ${error?.message}`);
  const s = { db, token: data.session.access_token, userId: data.user.id };
  if (!fresh) sessions.set(email, s);
  return s;
}

let pool: pg.Pool | undefined;
export function sql(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.DB_URL, max: 2 });
  return pool;
}

let app: ReturnType<typeof createApp> | undefined;
let q: LocalQueue | undefined;

/** API app wired to an in-process queue whose handler runs the real worker code. */
export function api() {
  if (!app) {
    q = new LocalQueue(3, 10);
    q.setHandler(handleJob);
    setQueue(q);
    app = createApp();
  }
  return app;
}

export async function drainQueue() {
  await q?.drain();
}

export function localQueue() {
  api();
  return q!;
}

export async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  return api().request(`http://api.test${path}`, { ...init, headers });
}

let filesWritten = false;
export async function ensureDemoFiles() {
  if (!filesWritten) {
    await writeDemoFiles();
    filesWritten = true;
  }
}

export function csvFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/csv' });
}
