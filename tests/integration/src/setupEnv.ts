import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = JSON.parse(readFileSync(join(tmpdir(), 'hop-integration-env.json'), 'utf8')) as Record<string, string>;
Object.assign(process.env, env);
