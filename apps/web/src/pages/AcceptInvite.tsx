import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { usePortal } from '../state/portal';
import { Notice } from '../components/ui';

/** Invitation links carry the token in the URL fragment so it never reaches server logs. */
export function AcceptInvitePage() {
  const { session, hostBranding, setCompanyId } = usePortal();
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
    supabase.rpc('accept_invitation', { p_token: token }).then(async ({ data, error: err }) => {
      if (err) return setError(err.code === '42501' ? 'wrong_email' : err.code === '22023' ? 'invalid' : err.message);
      setDone(true);
      const { data: m } = await supabase.from('company_memberships').select('company_id').eq('id', data as string).maybeSingle();
      // Make sure the new membership is loaded before entering the portal, then open the company just joined.
      await qc.resetQueries({ queryKey: ['my-context'] });
      await qc.refetchQueries({ queryKey: ['my-context'] });
      if (m?.company_id) setCompanyId(m.company_id as string);
      await qc.invalidateQueries();
      navigate('/');
    });
  }, [session, token, done, navigate, qc, setCompanyId]);

  const signOutAndRetry = async () => {
    await supabase.auth.signOut();
    setError(null);
    setDone(false);
    setMode('signin');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const fn = mode === 'signup' ? supabase.auth.signUp({ email, password }) : supabase.auth.signInWithPassword({ email, password });
    const { error: err } = await fn;
    if (err) setError(/already registered|already exists/i.test(err.message) ? 'An account with this email already exists — choose “I already have an account” and sign in.' : /invalid login/i.test(err.message) ? 'Email or password is incorrect.' : err.message);
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
          {!token && (
            <>
              <Notice tone="bad">This invitation link is incomplete. Open the full link from your invitation email, or ask your administrator to resend it.</Notice>
              <Link className="btn" to="/login">Go to sign in</Link>
            </>
          )}
          {error === 'invalid' && (
            <>
              <Notice tone="bad">This invitation has already been used or has expired. Ask your administrator for a new one.</Notice>
              <Link className="btn" to="/">Go to the portal</Link>
            </>
          )}
          {error === 'wrong_email' && (
            <>
              <Notice tone="bad">This invitation was sent to a different email address. You’re signed in as {session?.user.email}.</Notice>
              <button className="btn btn-primary" onClick={() => void signOutAndRetry()}>Sign out and use another account</button>
              <Link className="btn" to="/">Go to the portal</Link>
            </>
          )}
          {error && error !== 'invalid' && error !== 'wrong_email' && <Notice tone="bad">{error}</Notice>}
          {/* Accepting failed after sign-in: say what to do next instead of leaving a dead end. */}
          {error && error !== 'invalid' && error !== 'wrong_email' && session && (
            <>
              <p className="small muted">Open the full link from your invitation email, or ask your administrator to resend it.</p>
              <Link className="btn" to="/login">Go to sign in</Link>
            </>
          )}
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
