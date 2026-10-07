import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { usePortal } from '../state/portal';
import { Notice } from '../components/ui';

/** Invitation links carry the token in the URL fragment so it never reaches server logs. */
export function AcceptInvitePage() {
  const { session, hostBranding } = usePortal();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    if (!session || !token || done) return;
    supabase.rpc('accept_invitation', { p_token: token }).then(({ error: err }) => {
      if (err) setError(err.message);
      else {
        setDone(true);
        void qc.invalidateQueries();
        setTimeout(() => navigate('/'), 800);
      }
    });
  }, [session, token, done, navigate, qc]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const fn = mode === 'signup' ? supabase.auth.signUp({ email, password }) : supabase.auth.signInWithPassword({ email, password });
    const { error: err } = await fn;
    if (err) setError(err.message);
  };

  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div className="logo">{hostBranding?.logo_url ? <img src={hostBranding.logo_url} alt="" height={32} /> : <strong>Owner Portal</strong>}</div>
        <h1>You’ve been invited to {hostBranding?.portal_name ?? 'the owner portal'}</h1>
        <span />
      </section>
      <section className="auth-panel">
        <div className="auth-form">
          {!token && <Notice tone="bad">This invitation link is incomplete.</Notice>}
          {error && <Notice tone="bad">{error}</Notice>}
          {done && <Notice tone="good">Invitation accepted. Redirecting…</Notice>}
          {!session && token && (
            <form className="stack" onSubmit={submit}>
              <p className="muted">Use the email address the invitation was sent to.</p>
              <label className="field">
                Email
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
              </label>
              <label className="field">
                Password
                <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
              </label>
              <button className="btn btn-primary" type="submit">{mode === 'signup' ? 'Create account & accept' : 'Sign in & accept'}</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}>
                {mode === 'signup' ? 'I already have an account' : 'Create a new account'}
              </button>
            </form>
          )}
          {session && !done && !error && <p>Accepting invitation…</p>}
        </div>
      </section>
    </div>
  );
}
