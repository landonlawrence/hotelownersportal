import type { Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from './auth.js';

export interface AppEnv {
  Variables: {
    auth: AuthContext;
    db: SupabaseClient;
    requestId: string;
  };
}

export type AppContext = Context<AppEnv>;
