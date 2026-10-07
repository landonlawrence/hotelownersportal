import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalSetup() {
  if (process.env.SKIP_DB_RESET === '1') return;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const status = execSync('npx supabase status -o json', { cwd: root }).toString();
  if (!/127\.0\.0\.1|localhost/.test(JSON.parse(status).API_URL)) throw new Error('E2E must run against local Supabase');
  execSync('npx supabase db reset --local', { cwd: root, stdio: 'inherit' });
  execSync('npm run seed:files -w services/api', { cwd: root, stdio: 'inherit' });
}
