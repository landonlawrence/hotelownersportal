export interface PresignedUpload {
  url: string;
  method: 'POST' | 'PUT';
  /** Form fields for POST uploads (S3 presigned POST). */
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  expiresAt: string;
}

export interface ObjectInfo {
  size: number;
  contentType?: string;
}

export interface ObjectStorage {
  presignUpload(bucket: string, key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload>;
  presignDownload(bucket: string, key: string, opts: { filename: string; contentType: string; ttlSeconds: number }): Promise<{ url: string; expiresAt: string }>;
  head(bucket: string, key: string): Promise<ObjectInfo | null>;
  get(bucket: string, key: string): Promise<Uint8Array>;
  put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  move(bucket: string, fromKey: string, toKey: string): Promise<void>;
}

export function contentDisposition(filename: string): string {
  const safe = filename.replace(/[^\w.\- ]+/g, '_');
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
