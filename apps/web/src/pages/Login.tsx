import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { usePortal } from '../state/portal';
import { Notice, errorMessage } from '../components/ui';

export const MIN_PASSWORD_LENGTH = 10;

/** Only same-origin paths (not protocol-relative URLs) are followed after sign-in. */
export function safeRedirect(from: string | undefined | null): string {
  return from && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/\\') ? from : '/';
}

export function LoginPage() {
  const { session, hostBranding } = usePortal();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const location = useLocation();
  const state = location.state as { from?: string; reason?: string } | null;
  const from = safeRedirect(state?.from);
  const expired = state?.reason === 'expired';
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
    setError(null);
    setResetSent(false);
    const address = email.trim();
    if (!address) return setError('Enter your email address first, then choose “Forgot password?”.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return setError('Enter a valid email address.');
    setBusy(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(address, { redirectTo: `${window.location.origin}/reset-password` });
    setBusy(false);
    // Every outcome except rate limiting looks the same, so the form never reveals whether an account exists.
    if (err && (err.status === 429 || /rate|too many|seconds/i.test(err.message))) {
      setError('Too many reset requests. Wait a minute and try again.');
      return;
    }
    if (err) console.warn('Password reset request failed', err);
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
          {expired && !error && <Notice tone="warn">Your session has expired. Sign in again.</Notice>}
          {error && <Notice tone="bad">{error}</Notice>}
          {resetSent && <Notice tone="good">If an account exists for that address, a reset link has been sent.</Notice>}
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
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reset()}>
            Forgot password?
          </button>
        </form>
      </section>
    </div>
  );
}

/**
 * Landing page for password-recovery links: the link signs the user in with a
 * recovery session, and they choose a new password here.
 */
export function ResetPasswordPage() {
  const { session, sessionLoading, hostBranding } = usePortal();
  const navigate = useNavigate();
  const [recovery, setRecovery] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  const problem =
    password && password.length < MIN_PASSWORD_LENGTH ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : confirm && confirm !== password ? 'The passwords don’t match.' : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !password) return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setMsg({ tone: 'bad', text: errorMessage(error.message) });
    else {
      setMsg({ tone: 'good', text: 'Your password has been changed. Taking you to the portal…' });
      setTimeout(() => navigate('/', { replace: true }), 1200);
    }
  };
  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div className="logo">{hostBranding?.logo_url ? <img src={hostBranding.logo_url} alt={hostBranding.company_name} height={32} /> : <strong>Owner Portal</strong>}</div>
        <div className="stack"><h1>Choose a new password</h1></div>
        <div />
      </section>
      <section className="auth-panel">
        {sessionLoading ? (
          <p className="muted">Checking your reset link…</p>
        ) : !session ? (
          <div className="auth-form">
            <Notice tone="bad">This reset link is invalid or has expired.</Notice>
            <Link className="btn btn-primary" to="/login">Back to sign in and request a new link</Link>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit} aria-label="Set a new password">
            <div>
              <h2 style={{ fontSize: 22 }}>Set a new password</h2>
              <p className="muted">{recovery ? 'Your reset link worked.' : 'Signed in as'} {session.user.email}</p>
            </div>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            <label className="field">
              New password
              <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              Confirm new password
              <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {problem && <span className="field-error">{problem}</span>}
            <button className="btn btn-primary" type="submit" disabled={busy || !!problem || !password || password !== confirm}>
              {busy ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
