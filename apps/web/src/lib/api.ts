import { supabase } from './supabase';

const base = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError(401, 'Your session has expired. Please sign in again.');
  return data.session.access_token;
}

/** Calls the AWS API with the user's access token. The API re-authorizes every request. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${await token()}`);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  return (await res.json()) as T;
}

export async function downloadFromApi(path: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(path);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Request a short-lived signed URL (authorized server side) and open it. */
export async function downloadDocumentVersion(versionId: string): Promise<void> {
  const { url } = await apiJson<{ url: string }>(`/documents/versions/${versionId}/download`);
  window.location.assign(url);
}

/** Upload: register (authorized), PUT/POST to the signed URL, then confirm for scanning. */
export async function uploadDocument(meta: Record<string, unknown>, file: File): Promise<{ version_id: string; scan_status: string }> {
  const start = await apiJson<{ version_id: string; upload: { url: string; method: 'PUT' | 'POST'; fields?: Record<string, string>; headers?: Record<string, string> } }>(
    '/documents/uploads',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...meta, filename: file.name, content_type: file.type || guessType(file.name), size_bytes: file.size }),
    },
  );
  const u = start.upload;
  let res: Response;
  if (u.method === 'POST' && u.fields) {
    const form = new FormData();
    Object.entries(u.fields).forEach(([k, v]) => form.append(k, v));
    form.append('file', file);
    res = await fetch(u.url, { method: 'POST', body: form });
  } else {
    res = await fetch(u.url, { method: 'PUT', body: file, headers: u.headers });
  }
  if (!res.ok) throw new ApiError(res.status, 'Upload was rejected by storage (type or size not allowed).');
  return apiJson(`/documents/versions/${start.version_id}/complete`, { method: 'POST' });
}

export function guessType(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  return (
    {
      pdf: 'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      csv: 'text/csv',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
    } as Record<string, string>
  )[ext ?? ''] ?? 'application/octet-stream';
}
