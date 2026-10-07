import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../../..');

/**
 * Integration tests run against the LOCAL Supabase stack only (never a hosted
 * project). The database is reset to migrations + demo seed before the run.
 */
export default function setup() {
  const status = JSON.parse(execSync('npx supabase status -o json', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  if (!String(status.API_URL).includes('127.0.0.1') && !String(status.API_URL).includes('localhost')) {
    throw new Error('Refusing to run integration tests against a non-local Supabase');
  }
  if (process.env.SKIP_DB_RESET !== '1') {
    execSync('npx supabase db reset --local', { cwd: root, stdio: 'inherit' });
  }
  const storageDir = mkdtempSync(join(tmpdir(), 'hop-storage-'));
  const env = {
    APP_ENV: 'test',
    SUPABASE_URL: status.API_URL,
    SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: status.JWT_SECRET,
    DB_URL: status.DB_URL,
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: storageDir,
    QUEUE_DRIVER: 'local',
    SCAN_MODE: 'local',
    EMAIL_DRIVER: 'log',
    PUBLIC_API_URL: 'http://api.test',
    INBOUND_EMAIL_DOMAIN: 'inbound.portal.example',
  };
  writeFileSync(join(tmpdir(), 'hop-integration-env.json'), JSON.stringify(env));
}
