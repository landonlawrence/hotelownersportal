/**
 * Local development server: API + in-process queue worker + periodic jobs.
 * Uses local Supabase (supabase start) and the local filesystem storage driver.
 */
import { serve } from '@hono/node-server';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { handleJob } from '../jobs.js';
import { checkMissingReports } from '../ingestion/missingReports.js';
import { dispatchNotifications } from '../notifications/dispatcher.js';
import { LocalQueue, queue } from '../queue/index.js';

const cfg = config();
const q = queue();
if (q instanceof LocalQueue) q.setHandler(handleJob);

serve({ fetch: createApp().fetch, port: cfg.PORT, hostname: '0.0.0.0' }, (info) => {
  console.info(`API listening on http://localhost:${info.port} (${cfg.APP_ENV}, storage=${cfg.STORAGE_DRIVER}, queue=${cfg.QUEUE_DRIVER})`);
});

if (process.env.LOCAL_SCHEDULER !== 'off') {
  setInterval(() => void checkMissingReports().catch((e) => console.error('[scheduler] missing reports', e)), 15 * 60_000);
  setInterval(() => void dispatchNotifications().catch((e) => console.error('[scheduler] notifications', e)), 60_000);
}
