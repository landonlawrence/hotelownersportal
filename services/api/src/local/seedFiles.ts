/**
 * Writes fictional demo PDFs for seeded document versions into local storage.
 * Local development only. Run after `supabase db reset`.
 */
import { config } from '../config.js';
import { serviceClient } from '../supabase.js';
import { storage } from '../storage/index.js';
import { simplePdf } from './pdf.js';

export async function writeDemoFiles(): Promise<number> {
  const cfg = config();
  if (cfg.STORAGE_DRIVER !== 'local') throw new Error('seedFiles is for local storage only');
  const svc = await serviceClient();
  const { data, error } = await svc
    .from('document_versions')
    .select('id, storage_key, original_filename, size_bytes, documents!document_versions_document_id_company_id_fkey(title, companies(name)), properties(name)');
  if (error) throw error;
  for (const v of (data ?? []) as unknown as Array<{ id: string; storage_key: string; original_filename: string; documents: { title: string; companies: { name: string } }; properties: { name: string } | null }>) {
    const pdf = simplePdf([
      v.documents.title,
      `${v.documents.companies.name} — ${v.properties?.name ?? 'Company-wide'}`,
      'DEMO DOCUMENT — FICTIONAL DATA',
      `File: ${v.original_filename}`,
      'This file was generated for local development and testing only.',
    ]);
    await storage().put(cfg.DOCUMENTS_BUCKET, v.storage_key, pdf, 'application/pdf');
    await svc.from('document_versions').update({ size_bytes: pdf.byteLength }).eq('id', v.id);
  }
  return data?.length ?? 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  writeDemoFiles()
    .then((n) => console.info(`Wrote ${n} demo files to ${config().LOCAL_STORAGE_DIR}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
