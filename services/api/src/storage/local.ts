/**
 * Local filesystem storage for development and tests. Mirrors S3 semantics:
 * private objects, short-lived HMAC-signed URLs for upload and download, and
 * size/content-type enforcement on upload. Never used outside local/test.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import type { ObjectStorage, PresignedUpload } from './types.js';

export interface LocalSignedParams {
  op: 'get' | 'put';
  bucket: string;
  key: string;
  exp: number;
  ct: string;
  max?: number;
  fn?: string;
}

export class LocalStorage implements ObjectStorage {
  private readonly root: string;
  constructor(
    rootDir: string,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = resolve(rootDir);
  }

  private pathFor(bucket: string, key: string): string {
    const p = normalize(join(this.root, bucket, key));
    if (!p.startsWith(join(this.root, bucket))) throw new Error('Invalid key');
    return p;
  }

  sign(params: LocalSignedParams): string {
    const payload = [params.op, params.bucket, params.key, params.exp, params.ct, params.max ?? '', params.fn ?? ''].join('\n');
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  verify(params: LocalSignedParams, sig: string, now = Date.now()): boolean {
    if (!sig || params.exp * 1000 < now) return false;
    const expected = Buffer.from(this.sign(params), 'hex');
    const given = Buffer.from(sig, 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private url(params: LocalSignedParams): string {
    const q = new URLSearchParams({
      op: params.op,
      bucket: params.bucket,
      key: params.key,
      exp: String(params.exp),
      ct: params.ct,
      ...(params.max !== undefined ? { max: String(params.max) } : {}),
      ...(params.fn ? { fn: params.fn } : {}),
      sig: this.sign(params),
    });
    return `${this.publicBaseUrl}/local-storage/object?${q.toString()}`;
  }

  async presignUpload(bucket: string, key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return {
      url: this.url({ op: 'put', bucket, key, exp, ct: contentType, max: maxBytes }),
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async presignDownload(bucket: string, key: string, opts: { filename: string; contentType: string; ttlSeconds: number }) {
    const exp = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
    return { url: this.url({ op: 'get', bucket, key, exp, ct: opts.contentType, fn: opts.filename }), expiresAt: new Date(exp * 1000).toISOString() };
  }

  async head(bucket: string, key: string) {
    try {
      const s = await stat(this.pathFor(bucket, key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(bucket, key)));
  }

  async put(bucket: string, key: string, body: Uint8Array): Promise<void> {
    const p = this.pathFor(bucket, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async move(bucket: string, fromKey: string, toKey: string): Promise<void> {
    const to = this.pathFor(bucket, toKey);
    await mkdir(dirname(to), { recursive: true });
    await rename(this.pathFor(bucket, fromKey), to);
  }
}
