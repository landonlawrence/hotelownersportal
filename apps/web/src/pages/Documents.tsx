import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DOCUMENT_VISIBILITY_LABELS, clampVisibility, type DocumentVisibility } from '@hop/core';
import { supabase, unwrap } from '../lib/supabase';
import { apiJson, downloadDocumentVersion, uploadDocument } from '../lib/api';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, ErrorState, Loading, Modal, Notice, PageHeader, StatusBadge, errorMessage, fmtDate, fmtMonth } from '../components/ui';

interface Doc {
  id: string;
  property_id: string | null;
  category_key: string;
  title: string;
  description: string | null;
  period_month: string | null;
  visibility: DocumentVisibility;
  status: string;
  current_version_id: string | null;
  created_at: string;
  document_versions: Array<{ id: string; version_number: number; original_filename: string; size_bytes: number; scan_status: string; scan_detail: string | null; created_at: string; uploaded_by: string | null }>;
}

const fmtSize = (b: number) => (b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function DocumentsPage() {
  const { properties, canAny, can } = usePortal();
  const company = useCompany();
  const qc = useQueryClient();
  const [property, setProperty] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState<null | { documentId?: string; propertyId: string | null }>(null);
  const [error, setError] = useState<string | null>(null);
  const cats = useQuery({ queryKey: ['doc-categories', company.company_id], queryFn: async () => unwrap(await supabase.from('document_categories').select('key, label, default_visibility, sort_order').eq('company_id', company.company_id).order('sort_order')) as Array<{ key: string; label: string; default_visibility: DocumentVisibility }> });
  const docs = useQuery({
    queryKey: ['documents', company.company_id],
    queryFn: async () => unwrap(await supabase.from('documents').select('id, property_id, category_key, title, description, period_month, visibility, status, current_version_id, created_at, document_versions!document_versions_document_id_company_id_fkey(id, version_number, original_filename, size_bytes, scan_status, scan_detail, created_at, uploaded_by)').eq('company_id', company.company_id).order('created_at', { ascending: false })) as unknown as Doc[],
  });
  const rows = useMemo(() => (docs.data ?? []).filter((d) => (!property || (property === 'company' ? d.property_id === null : d.property_id === property)) && (!category || d.category_key === category) && (!search || d.title.toLowerCase().includes(search.toLowerCase()))), [docs.data, property, category, search]);
  const label = (k: string) => cats.data?.find((c) => c.key === k)?.label ?? k;
  const download = async (versionId: string) => {
    setError(null);
    try {
      await downloadDocumentVersion(versionId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="stack">
      <PageHeader title="Documents" subtitle="Private documents. Every download is authorized and logged; links expire after one minute." actions={canAny('documents.upload') && <button className="btn btn-primary" onClick={() => setUploading({ propertyId: null })}>Upload document</button>} />
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="filter-bar">
        <label className="field">Property<select value={property} onChange={(e) => setProperty(e.target.value)}><option value="">All</option><option value="company">Company-wide</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field">Category<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All</option>{cats.data?.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
        <label className="field">Search<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title" /></label>
      </div>
      <Card flush>
        {docs.isLoading ? <Loading /> : docs.error ? <ErrorState error={docs.error} /> : rows.length === 0 ? <Empty title="No documents found" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Document</th><th>Property</th><th>Category</th><th>Period</th><th>Visibility</th><th>Versions</th><th /></tr></thead>
              <tbody>
                {rows.map((d) => {
                  const versions = [...d.document_versions].sort((a, b) => b.version_number - a.version_number);
                  const current = versions.find((v) => v.id === d.current_version_id);
                  return (
                    <tr key={d.id}>
                      <td><strong>{d.title}</strong>{current && <div className="small muted">{current.original_filename} · {fmtSize(current.size_bytes)}</div>}</td>
                      <td>{d.property_id ? properties.find((p) => p.id === d.property_id)?.code : 'Company-wide'}</td>
                      <td>{label(d.category_key)}</td>
                      <td>{d.period_month ? fmtMonth(d.period_month) : '—'}</td>
                      <td>{DOCUMENT_VISIBILITY_LABELS[d.visibility]}</td>
                      <td>
                        {versions.map((v) => (
                          <div key={v.id} className="small">
                            v{v.version_number} · {fmtDate(v.created_at)} {v.scan_status !== 'clean' && <ScanStatus status={v.scan_status} detail={v.scan_detail} />}
                            {v.scan_status === 'skipped' && can('documents.manage', d.property_id ?? undefined) && <ReleaseButton versionId={v.id} />}
                          </div>
                        ))}
                      </td>
                      <td className="row" style={{ gap: 6 }}>
                        {d.current_version_id && <button className="btn btn-sm" onClick={() => download(d.current_version_id!)}>Download</button>}
                        {(d.property_id ? can('documents.upload', d.property_id) : company.all_properties && can('documents.upload')) && <button className="btn btn-sm btn-ghost" onClick={() => setUploading({ documentId: d.id, propertyId: d.property_id })}>New version</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {uploading && <UploadModal categories={cats.data ?? []} target={uploading} onClose={() => { setUploading(null); void qc.invalidateQueries({ queryKey: ['documents'] }); }} />}
    </div>
  );
}

/** Scan state of a version; failed scans say why instead of looking like they are still scanning. */
export function ScanStatus({ status, detail }: { status: string; detail: string | null }) {
  if (status === 'infected' || status === 'error') {
    return <StatusBadge status="rejected" label={`Rejected${detail ? ` — ${detail}` : ''}`} />;
  }
  if (status === 'pending') return <StatusBadge status="pending" label="scanning" />;
  if (status === 'awaiting_upload') return <StatusBadge status="awaiting_upload" label="upload not finished" />;
  if (status === 'skipped') return <StatusBadge status="skipped" label="awaiting manual release" />;
  return <StatusBadge status={status} />;
}

function ReleaseButton({ versionId }: { versionId: string }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          const note = window.prompt('Release without a malware scan? Record why this file was reviewed manually:');
          if (!note?.trim()) return;
          setErr(null);
          try {
            await apiJson(`/documents/versions/${versionId}/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
          } catch (e) {
            setErr(errorMessage(e));
          }
          await qc.invalidateQueries({ queryKey: ['documents'] });
        }}
      >
        Release
      </button>
      {err && <span role="alert" className="field-error">{err}</span>}
    </>
  );
}

function UploadModal({ categories, target, onClose }: { categories: Array<{ key: string; label: string; default_visibility: DocumentVisibility }>; target: { documentId?: string; propertyId: string | null }; onClose: () => void }) {
  const { properties, can } = usePortal();
  const company = useCompany();
  const eligible = properties.filter((p) => can('documents.upload', p.id));
  // Company-wide documents need access to every property (enforced in the database too).
  const canCompanyWide = company.all_properties && (can('documents.upload') || can('documents.manage'));
  const [f, setF] = useState({ property: target.propertyId ?? eligible[0]?.id ?? '', category: categories[0]?.key ?? 'other', title: '', visibility: (categories[0]?.default_visibility ?? 'owner') as DocumentVisibility, period: '' });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowedVis = (Object.keys(DOCUMENT_VISIBILITY_LABELS) as DocumentVisibility[]).filter((v) => can(({ general: 'documents.view', owner: 'documents.view_owner', internal: 'documents.view_internal', confidential: 'documents.view_confidential' } as const)[v], f.property || undefined) || can('documents.manage', f.property || undefined));
  // Keep the chosen visibility within what this person may upload for the chosen property,
  // never widening the audience: fall back to the closest more restrictive option.
  useEffect(() => {
    if (allowedVis.length > 0 && !allowedVis.includes(f.visibility)) {
      const v = clampVisibility(f.visibility, allowedVis);
      if (v) setF((x) => ({ ...x, visibility: v }));
    }
  }, [allowedVis, f.visibility]);
  const categoryDefault = categories.find((c) => c.key === f.category)?.default_visibility;
  const clampNote =
    categoryDefault && allowedVis.length > 0 && !allowedVis.includes(categoryDefault) && f.visibility === clampVisibility(categoryDefault, allowedVis)
      ? `Default for this category is ${DOCUMENT_VISIBILITY_LABELS[categoryDefault]}; you can’t use it, so ${DOCUMENT_VISIBILITY_LABELS[f.visibility]} was chosen.`
      : null;
  const maxBytes = 50 * 1024 * 1024;
  const titleOk = !f.title.trim() || (f.title.trim().length >= 2 && f.title.trim().length <= 200);
  const go = async () => {
    if (!file) return;
    if (file.size > maxBytes) return setErr(`This file is ${fmtSize(file.size)}; the limit is 50 MB.`);
    if (file.size === 0) return setErr('This file is empty.');
    setBusy(true);
    setErr(null);
    try {
      const r = await uploadDocument({ company_id: company.company_id, property_id: f.property || null, document_id: target.documentId ?? null, category_key: f.category, title: f.title || file.name, visibility: f.visibility, period_month: f.period ? `${f.period}-01` : null }, file);
      setResult(
        r.scan_status === 'clean'
          ? 'Uploaded and scanned. The document is now available to authorized users.'
          : r.scan_status === 'infected' || r.scan_status === 'error'
            ? 'The file was rejected by the security scan and will not be shared.'
            : r.scan_status === 'skipped'
              ? 'Uploaded. Scanning isn’t configured, so a document manager must release it before others can open it.'
              : 'Uploaded. The file is being scanned; it becomes available to others only if it passes.',
      );
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={target.documentId ? 'Upload new version' : 'Upload document'} onClose={onClose}>
      {err && <Notice tone="bad">{err}</Notice>}
      {result ? (
        <>
          <Notice tone="good">{result}</Notice>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </>
      ) : (
        <>
          <input type="file" aria-label="File" accept=".pdf,.xlsx,.docx,.csv,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="small muted">PDF, Excel, Word, CSV or images. Uploads are quarantined and scanned before release.</p>
          {!target.documentId && (
            <>
              <label className="field">Property<select value={f.property} onChange={(e) => setF({ ...f, property: e.target.value })}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}{canCompanyWide && <option value="">Company-wide</option>}</select></label>
              <label className="field">Category<select value={f.category} onChange={(e) => { const c = categories.find((x) => x.key === e.target.value); const wanted = c?.default_visibility ?? f.visibility; setF({ ...f, category: e.target.value, visibility: clampVisibility(wanted, allowedVis) ?? wanted }); }}>{categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
              <label className="field">Title<input value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />{!titleOk && <span className="field-error">Titles are 2–200 characters.</span>}</label>
              <label className="field">Visibility<select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as DocumentVisibility })}>{allowedVis.map((v) => <option key={v} value={v}>{DOCUMENT_VISIBILITY_LABELS[v]}</option>)}</select>{clampNote && <span className="small muted">{clampNote}</span>}</label>
              <label className="field">Reporting period (optional)<input type="month" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></label>
            </>
          )}
          <button className="btn btn-primary" disabled={!file || busy || !titleOk || (!target.documentId && !f.property && !canCompanyWide)} onClick={go}>{busy ? 'Uploading…' : 'Upload'}</button>
        </>
      )}
    </Modal>
  );
}
