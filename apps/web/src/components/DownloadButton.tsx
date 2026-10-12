import { useState } from 'react';
import { ApiError } from '../lib/api';
import { errorMessage } from './ui';

/** A button that runs a download/export, shows progress, and explains failures instead of failing silently. */
export function DownloadButton({ label, run, className = 'btn', busyLabel = 'Preparing…' }: { label: string; run: () => Promise<void>; className?: string; busyLabel?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await run();
    } catch (e) {
      setErr(e instanceof ApiError && e.status >= 500 ? 'Couldn’t generate the file — try again.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="stack" style={{ gap: 2, display: 'inline-flex' }}>
      <button type="button" className={className} disabled={busy} aria-busy={busy} onClick={() => void go()}>
        {busy ? busyLabel : label}
      </button>
      {err && (
        <span role="alert" className="field-error">
          {err}
        </span>
      )}
    </span>
  );
}
