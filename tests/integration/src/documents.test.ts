import { beforeAll, describe, expect, it } from 'vitest';
import { simplePdf } from '@hop/api';
import { call, COMPANY, drainQueue, ensureDemoFiles, PROPERTY, serviceDb, signIn, USER } from './helpers';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

beforeAll(ensureDemoFiles);

async function startUpload(token: string, body: Record<string, unknown>) {
  const res = await call('/documents/uploads', { method: 'POST', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { version_id: string; document_id: string; upload: { url: string; method: string; headers?: Record<string, string> }; message?: string } };
}

async function putBytes(upload: { url: string; headers?: Record<string, string> }, bytes: Uint8Array, contentType: string) {
  const u = new URL(upload.url);
  return call(`${u.pathname}${u.search}`, { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
}

const base = {
  company_id: COMPANY.harborview,
  property_id: PROPERTY.sea,
  category_key: 'insurance',
  title: 'Umbrella policy 2026',
  visibility: 'owner',
  filename: 'umbrella-2026.pdf',
  content_type: 'application/pdf',
};

describe('document upload, quarantine and scanning', () => {
  it('uploads go to quarantine, are scanned, then become downloadable by authorized owners only', async () => {
    const gm = await signIn(USER.hvGm);
    const pdf = simplePdf(['Umbrella policy', 'Fictional']);
    const start = await startUpload(gm.token, { ...base, size_bytes: pdf.byteLength });
    expect(start.status).toBe(201);
    expect(start.body.upload.url).toContain('quarantine%2F');
    expect((await putBytes(start.body.upload, pdf, 'application/pdf')).status).toBe(200);

    // Before completion/scan the owner cannot see the version.
    const owner = await signIn(USER.olivia);
    expect((await owner.db.from('document_versions').select('id').eq('id', start.body.version_id)).data).toEqual([]);
    expect((await call(`/documents/versions/${start.body.version_id}/download`, { token: owner.token })).status).toBe(404);

    // Only the uploader can complete.
    expect((await call(`/documents/versions/${start.body.version_id}/complete`, { method: 'POST', token: owner.token })).status).toBe(404);
    const done = await call(`/documents/versions/${start.body.version_id}/complete`, { method: 'POST', token: gm.token });
    expect(done.status).toBe(200);
    await drainQueue();
    const { data: v } = await serviceDb().from('document_versions').select('scan_status, storage_key, sha256').eq('id', start.body.version_id).single();
    expect(v).toMatchObject({ scan_status: 'clean' });
    expect(v!.storage_key.startsWith('clean/')).toBe(true);
    expect(v!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const dl = await call(`/documents/versions/${start.body.version_id}/download`, { token: owner.token });
    expect(dl.status).toBe(200);
    const { url } = (await dl.json()) as { url: string };
    const file = await call(new URL(url).pathname + new URL(url).search);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);

    // Investor (general visibility only) cannot download owner-only documents.
    const ian = await signIn(USER.ian);
    expect((await call(`/documents/versions/${start.body.version_id}/download`, { token: ian.token })).status).toBe(404);
    const admin = await signIn(USER.hvAdmin);
    const { data: audit } = await admin.db.from('audit_events').select('action').eq('entity_id', start.body.version_id);
    expect(audit!.map((a) => a.action)).toEqual(expect.arrayContaining(['document.upload_started', 'document.scanned', 'document.download_authorized', 'document.download_denied']));
  });

  it('infected files and content-type mismatches are never released', async () => {
    const gm = await signIn(USER.hvGm);
    const owner = await signIn(USER.olivia);
    const eicar = new TextEncoder().encode(`%PDF-1.4\n${EICAR}\n`);
    const s1 = await startUpload(gm.token, { ...base, title: 'Suspicious', size_bytes: eicar.byteLength });
    await putBytes(s1.body.upload, eicar, 'application/pdf');
    await call(`/documents/versions/${s1.body.version_id}/complete`, { method: 'POST', token: gm.token });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const s2 = await startUpload(gm.token, { ...base, title: 'Mislabeled', size_bytes: png.byteLength });
    await putBytes(s2.body.upload, png, 'application/pdf');
    await call(`/documents/versions/${s2.body.version_id}/complete`, { method: 'POST', token: gm.token });
    await drainQueue();
    const { data } = await serviceDb().from('document_versions').select('id, scan_status').in('id', [s1.body.version_id, s2.body.version_id]);
    const status = Object.fromEntries(data!.map((d) => [d.id, d.scan_status]));
    expect(status[s1.body.version_id]).toBe('infected');
    expect(status[s2.body.version_id]).toBe('error');
    for (const id of [s1.body.version_id, s2.body.version_id]) {
      expect((await call(`/documents/versions/${id}/download`, { token: owner.token })).status).toBe(404);
      expect((await call(`/documents/versions/${id}/download`, { token: gm.token })).status).toBe(404);
    }
  });

  it('validates file type, size and declared size', async () => {
    const gm = await signIn(USER.hvGm);
    expect((await startUpload(gm.token, { ...base, filename: 'tool.exe', content_type: 'application/x-msdownload', size_bytes: 10 })).status).toBe(400);
    expect((await startUpload(gm.token, { ...base, filename: 'doc.pdf.exe', size_bytes: 10 })).status).toBe(400);
    expect((await startUpload(gm.token, { ...base, size_bytes: 60 * 1024 * 1024 })).status).toBe(400);
    const s = await startUpload(gm.token, { ...base, size_bytes: 10 });
    const big = simplePdf(['x'.repeat(50)]);
    expect((await putBytes(s.body.upload, big, 'application/pdf')).status).toBe(400); // exceeds declared size
    expect((await putBytes(s.body.upload, new Uint8Array(5), 'image/png')).status).toBe(400); // content-type mismatch
  });

  it('upload permission and visibility rules are enforced in the database', async () => {
    const owner = await signIn(USER.olivia);
    expect((await startUpload(owner.token, { ...base, size_bytes: 100 })).status).toBe(403); // owners cannot upload
    const gm = await signIn(USER.hvGm);
    expect((await startUpload(gm.token, { ...base, visibility: 'confidential', size_bytes: 100 })).status).toBe(403); // cannot create what they cannot see
    expect((await startUpload(gm.token, { ...base, property_id: PROPERTY.pdx, size_bytes: 100 })).status).toBe(403); // not their property
    expect((await startUpload(gm.token, { ...base, company_id: COMPANY.summit, property_id: PROPERTY.sea, size_bytes: 100 })).status).toBe(400);
  });

  it('confidential documents are not available to owners, but are to finance', async () => {
    const owner = await signIn(USER.olivia);
    const fin = await signIn(USER.hvFinance);
    const confidential = '71000000-0000-4000-8000-000000000003';
    expect((await call(`/documents/versions/${confidential}/download`, { token: owner.token })).status).toBe(404);
    expect((await call(`/documents/versions/${confidential}/download`, { token: fin.token })).status).toBe(200);
  });

  it('unscanned files require an explicit manager release when scanning is not configured', async () => {
    const svc = serviceDb();
    const fin = await signIn(USER.hvFinance);
    const pdf = simplePdf(['skip']);
    const s = await startUpload(fin.token, { ...base, title: 'Skip scan', size_bytes: pdf.byteLength });
    await putBytes(s.body.upload, pdf, 'application/pdf');
    await svc.rpc('svc_complete_document_upload', { p_version_id: s.body.version_id, p_size_bytes: pdf.byteLength, p_sha256: 'a'.repeat(64) });
    await svc.rpc('svc_set_scan_result', { p_version_id: s.body.version_id, p_status: 'skipped', p_detail: 'not configured', p_storage_key: null });
    const owner = await signIn(USER.olivia);
    expect((await call(`/documents/versions/${s.body.version_id}/download`, { token: owner.token })).status).toBe(404);
    expect((await owner.db.rpc('release_document_version', { p_version_id: s.body.version_id, p_note: 'ok' })).error?.code).toBe('42501');
    expect((await fin.db.rpc('release_document_version', { p_version_id: s.body.version_id, p_note: '' })).error?.code).toBe('22023');
    const release = await call(`/documents/versions/${s.body.version_id}/release`, {
      method: 'POST', token: fin.token, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Reviewed manually; scanner not yet configured in this environment' }),
    });
    expect(release.status).toBe(200);
    expect((await call(`/documents/versions/${s.body.version_id}/download`, { token: owner.token })).status).toBe(200);
  });
});
