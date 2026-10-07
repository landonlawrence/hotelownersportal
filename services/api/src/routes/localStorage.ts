/** Local-only endpoints that emulate S3 presigned URLs. Not mounted outside local/test. */
import { Hono } from 'hono';
import { config } from '../config.js';
import type { AppEnv } from '../context.js';
import { localStorageDriver } from '../storage/index.js';
import { contentDisposition } from '../storage/types.js';

export const localStorageRoutes = new Hono<AppEnv>();

function params(q: Record<string, string>) {
  return {
    op: q.op as 'get' | 'put',
    bucket: q.bucket ?? '',
    key: q.key ?? '',
    exp: Number(q.exp),
    ct: q.ct ?? '',
    max: q.max ? Number(q.max) : undefined,
    fn: q.fn,
  };
}

localStorageRoutes.put('/object', async (c) => {
  const drv = localStorageDriver();
  const q = c.req.query();
  const p = params(q);
  if (!drv || p.op !== 'put' || !drv.verify(p, q.sig ?? '')) return c.text('Forbidden', 403);
  if ((c.req.header('content-type') ?? '').split(';')[0] !== p.ct) return c.text('Content-Type mismatch', 400);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength === 0 || (p.max !== undefined && body.byteLength > p.max)) return c.text('Size not allowed', 400);
  await drv.put(p.bucket, p.key, body);
  return c.body(null, 200);
});

localStorageRoutes.get('/object', async (c) => {
  const drv = localStorageDriver();
  const q = c.req.query();
  const p = params(q);
  if (!drv || p.op !== 'get' || !drv.verify(p, q.sig ?? '')) return c.text('Forbidden', 403);
  try {
    const bytes = await drv.get(p.bucket, p.key);
    return new Response(bytes, {
      headers: { 'content-type': p.ct, 'content-disposition': contentDisposition(p.fn ?? 'download'), 'cache-control': 'no-store' },
    });
  } catch {
    return c.text('Not found', 404);
  }
});

export function localStorageEnabled(): boolean {
  return config().STORAGE_DRIVER === 'local';
}
