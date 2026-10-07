export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'error',
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
export const forbidden = (what = 'Forbidden') => new HttpError(403, what, 'forbidden');
export const badRequest = (what: string) => new HttpError(400, what, 'bad_request');
export const conflict = (what: string) => new HttpError(409, what, 'conflict');

/** Map Postgres/PostgREST errors raised by RPCs to HTTP errors without leaking internals. */
export function fromPostgrest(err: { code?: string; message?: string } | null): HttpError {
  const msg = err?.message ?? 'Request failed';
  switch (err?.code) {
    case '42501':
      return new HttpError(403, msg, 'forbidden');
    case '22023':
    case '23514':
      return new HttpError(400, msg, 'bad_request');
    case '23505':
    case '55000':
      return new HttpError(409, msg, 'conflict');
    case '28000':
    case 'PGRST301':
      return new HttpError(401, 'Not authenticated', 'unauthenticated');
    default:
      return new HttpError(500, 'Request failed', 'internal');
  }
}
