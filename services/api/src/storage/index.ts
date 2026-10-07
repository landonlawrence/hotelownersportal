import { config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { ObjectStorage } from './types.js';

let instance: ObjectStorage | undefined;

export function storage(): ObjectStorage {
  if (instance) return instance;
  const cfg = config();
  instance = cfg.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(cfg.LOCAL_STORAGE_DIR, cfg.LOCAL_SIGNING_SECRET, cfg.PUBLIC_API_URL);
  return instance;
}

export function localStorageDriver(): LocalStorage | null {
  const s = storage();
  return s instanceof LocalStorage ? s : null;
}

export function resetStorageForTests(): void {
  instance = undefined;
}

export * from './types.js';
