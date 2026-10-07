import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { usePortal } from '../state/portal';
import { Notice } from '../components/ui';

export function LoginPage() {
  const { session, hostBranding } = usePortal();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (session) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError('Email or password is incorrect.');
  };
  const reset = async () => {
    if (!email) return setError('Enter your email first.');
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/security` });
    setResetSent(true);
  };
  const b = hostBranding;
  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div className="logo">
          {b?.logo_url ? <img src={b.logo_url} alt={b.company_name} height={32} /> : <strong>Owner Portal</strong>}
        </div>
        <div className="stack">
          <h1>{b?.login_headline ?? 'Hotel ownership reporting'}</h1>
          <p>{b?.login_message ?? 'Sign in to view the properties, financial information and documents you are authorized to access.'}</p>
        </div>
        <div className="small" style={{ opacity: 0.7 }}>
          {b?.is_demo && 'Demo environment — fictional data. '}
          {b?.support_email && <>Need help? {b.support_email}</>}
        </div>
      </section>
      <section className="auth-panel">
        <form className="auth-form" onSubmit={submit} aria-label="Sign in">
          <div>
            <h2 style={{ fontSize: 22 }}>Sign in</h2>
            <p className="muted">{b?.portal_name ?? 'Owner Portal'}</p>
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          {resetSent && <Notice tone="good">If an account exists, a reset link has been sent.</Notice>}
          <label className="field">
            Email
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            Password
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
            Forgot password?
          </button>
        </form>
      </section>
    </div>
  );
}
