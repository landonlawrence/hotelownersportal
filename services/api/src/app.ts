import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { config } from './config.js';
import type { AppEnv } from './context.js';
import { HttpError } from './errors.js';
import { isAllowedOrigin, requestId, securityHeaders } from './middleware.js';
import { admin } from './routes/admin.js';
import { documents } from './routes/documents.js';
import { exportsRoute } from './routes/exports.js';
import { imports } from './routes/imports.js';
import { localStorageEnabled, localStorageRoutes } from './routes/localStorage.js';

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requestId);
  app.use('*', securityHeaders);
  // CORS with async origin validation (static patterns or verified tenant domains).
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = origin ? await isAllowedOrigin(origin) : false;
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403);
      return c.body(null, 204, {
        'access-control-allow-origin': origin!,
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-request-id',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }
    await next();
    if (allowed) {
      c.header('access-control-allow-origin', origin!);
      c.header('access-control-expose-headers', 'content-disposition, x-request-id');
      c.header('vary', 'Origin');
    }
  });

  app.get('/health', (c) => c.json({ ok: true, env: config().APP_ENV }));
  app.route('/documents', documents);
  app.route('/imports', imports);
  app.route('/exports', exportsRoute);
  app.route('/admin', admin);
  if (localStorageEnabled()) app.route('/local-storage', localStorageRoutes);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    if (err instanceof HTTPException) return c.json({ error: 'error', message: err.message }, err.status);
    console.error(JSON.stringify({ level: 'error', requestId: c.get('requestId'), message: err.message, stack: err.stack }));
    return c.json({ error: 'internal', message: 'Internal error', request_id: c.get('requestId') }, 500);
  });
  app.notFound((c) => c.json({ error: 'not_found', message: 'Not found' }, 404));
  return app;
}
