/**
 * Upload validation and malware scanning.
 *
 * AWS: GuardDuty Malware Protection for S3 scans objects written under
 * `quarantine/` and emits EventBridge events handled by handleGuardDutyResult().
 * Local: a deterministic scanner checks file signatures and the EICAR test string.
 * Unscanned files are never released to owners/investors.
 */
import { config } from '../config.js';
import { serviceClient } from '../supabase.js';
import { storage } from '../storage/index.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Check the leading bytes match the declared content type. */
export function signatureMatches(contentType: string, bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 8));
  switch (contentType) {
    case 'application/pdf':
      return head.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    case 'text/csv': {
      // Text only: no NUL bytes in the first 4 KB.
      return !bytes.subarray(0, 4096).includes(0);
    }
    default:
      return false;
  }
}

export function localScan(contentType: string, bytes: Uint8Array): { status: 'clean' | 'infected' | 'error'; detail: string } {
  if (Buffer.from(bytes).includes(EICAR)) return { status: 'infected', detail: 'EICAR test signature detected' };
  if (!signatureMatches(contentType, bytes)) return { status: 'error', detail: `File content does not match declared type ${contentType}` };
  return { status: 'clean', detail: 'Local signature scan passed' };
}

export function cleanKeyFor(quarantineKey: string): string {
  return quarantineKey.replace(/^quarantine\//, 'clean/');
}

interface VersionRow {
  id: string;
  storage_key: string;
  content_type: string;
  scan_status: string;
}

async function loadVersion(versionId: string): Promise<VersionRow | null> {
  const svc = await serviceClient();
  const { data } = await svc.from('document_versions').select('id, storage_key, content_type, scan_status').eq('id', versionId).maybeSingle();
  return data as VersionRow | null;
}

async function setResult(versionId: string, status: 'clean' | 'infected' | 'error' | 'skipped', detail: string, key: string | null) {
  const svc = await serviceClient();
  const { error } = await svc.rpc('svc_set_scan_result', { p_version_id: versionId, p_status: status, p_detail: detail, p_storage_key: key });
  if (error) throw new Error(`svc_set_scan_result failed: ${error.message}`);
}

/** Job handler for local / no-scanner modes. Idempotent. */
export async function scanDocumentVersion(versionId: string): Promise<void> {
  const cfg = config();
  const v = await loadVersion(versionId);
  if (!v || v.scan_status !== 'pending') return;
  if (cfg.SCAN_MODE === 'guardduty') return; // GuardDuty drives the result asynchronously.
  if (cfg.SCAN_MODE === 'none') {
    await setResult(v.id, 'skipped', 'Malware scanning is not configured; a document manager must release this file', null);
    return;
  }
  const bytes = await storage().get(cfg.DOCUMENTS_BUCKET, v.storage_key);
  const result = localScan(v.content_type, bytes);
  if (result.status === 'clean') {
    const cleanKey = cleanKeyFor(v.storage_key);
    await storage().move(cfg.DOCUMENTS_BUCKET, v.storage_key, cleanKey);
    await setResult(v.id, 'clean', result.detail, cleanKey);
  } else {
    await setResult(v.id, result.status, result.detail, null);
  }
}

export interface GuardDutyScanEvent {
  detail?: {
    s3ObjectDetails?: { bucketName?: string; objectKey?: string };
    scanResultDetails?: { scanResultStatus?: string };
  };
}

/** EventBridge handler for "GuardDuty Malware Protection Object Scan Result". */
export async function handleGuardDutyResult(event: GuardDutyScanEvent): Promise<void> {
  const cfg = config();
  const key = event.detail?.s3ObjectDetails?.objectKey;
  const status = event.detail?.scanResultDetails?.scanResultStatus;
  if (!key || !key.startsWith('quarantine/')) return;
  const svc = await serviceClient();
  const { data } = await svc.from('document_versions').select('id, storage_key, content_type, scan_status').eq('storage_key', key).maybeSingle();
  const v = data as VersionRow | null;
  if (!v || v.scan_status !== 'pending') return;
  if (status === 'NO_THREATS_FOUND') {
    const bytes = await storage().get(cfg.DOCUMENTS_BUCKET, key);
    if (!signatureMatches(v.content_type, bytes)) {
      await setResult(v.id, 'error', `File content does not match declared type ${v.content_type}`, null);
      return;
    }
    const cleanKey = cleanKeyFor(key);
    await storage().move(cfg.DOCUMENTS_BUCKET, key, cleanKey);
    await setResult(v.id, 'clean', 'GuardDuty: no threats found', cleanKey);
  } else if (status === 'THREATS_FOUND') {
    await setResult(v.id, 'infected', 'GuardDuty: threats found', null);
  } else {
    await setResult(v.id, 'error', `GuardDuty scan status: ${status ?? 'unknown'}`, null);
  }
}
