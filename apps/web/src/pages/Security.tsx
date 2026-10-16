import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { usePortal } from '../state/portal';
import { Icon } from '../components/icons';
import { Badge, Card, Notice, PageHeader, confirmAction, errorMessage, fmtDate } from '../components/ui';
import { MIN_PASSWORD_LENGTH, safeRedirect } from './Login';

/** Two-factor (TOTP) enrolment and step-up to aal2 for privileged actions. */
export function SecurityPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { ctx, company } = usePortal();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string; replaces?: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const factors = useQuery({ queryKey: ['mfa-factors'], queryFn: async () => (await supabase.auth.mfa.listFactors()).data });
  const verified = factors.data?.totp.filter((f) => f.status === 'verified') ?? [];
  const sessionVerified = ctx?.aal === 'aal2';
  const platformView = !!ctx?.is_platform_admin && (!company || company.access === 'support_session');
  const requires = platformView || company?.require_mfa_for_privileged;

  const start = async (replaces?: string) => {
    setMsg(null);
    // Abandoned enrolments leave unverified factors behind; clear them so a fresh QR code can be issued.
    for (const f of factors.data?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    // Friendly names must be unique per user: Replace right after enrolling would otherwise collide.
    const friendlyName = `Authenticator ${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${crypto.randomUUID().slice(0, 4)}`;
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
    if (error) {
      const mfaOff = /mfa.*(disabled|not enabled)|enroll_not_enabled/i.test(`${error.message} ${(error as { code?: string }).code ?? ''}`);
      return setMsg({ tone: 'bad', text: mfaOff ? `${errorMessage(error.message)} Authenticator-app 2FA may be switched off for this project (Supabase → Authentication → Multi-Factor).` : errorMessage(error.message) });
    }
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret, replaces });
  };
  const remove = async (factorId: string, isVerified: boolean) => {
    setMsg(null);
    if (isVerified && !sessionVerified) return setMsg({ tone: 'bad', text: 'Verify this session with your current code before removing an authenticator.' });
    if (isVerified && !confirmAction(verified.length === 1 ? 'Remove your only authenticator? Privileged sections will be locked until you set up a new one.' : 'Remove this authenticator?')) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) return setMsg({ tone: 'bad', text: errorMessage(error.message) });
    await supabase.auth.refreshSession();
    await qc.invalidateQueries();
    setMsg({ tone: 'good', text: 'Authenticator removed.' });
  };
  const verify = async (e: FormEvent, factorId: string) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId });
      if (e1) throw e1;
      const { error: e2 } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code: code.replace(/\s/g, '') });
      if (e2) throw e2;
      const replaced = enroll?.replaces;
      setEnroll(null);
      setCode('');
      if (replaced) await supabase.auth.mfa.unenroll({ factorId: replaced });
      await qc.invalidateQueries();
      if (replaced) {
        setMsg({ tone: 'good', text: 'New authenticator active; the old one was removed.' });
        return;
      }
      if (next && safeRedirect(next) === next) navigate(next);
      else setMsg({ tone: 'good', text: 'Verified. Administration, publishing and approvals are now available in this session.' });
    } catch (err) {
      const text = errorMessage(err);
      setMsg({ tone: 'bad', text: /invalid|expired/i.test(text) ? 'That code didn’t match. Codes change every 30 seconds — enter the current one from your app.' : text });
    } finally {
      setBusy(false);
    }
  };

  const codeForm = (factorId: string, label: string) => (
    <form className="row" onSubmit={(e) => verify(e, factorId)}>
      <input
        aria-label="Authenticator code"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123 456"
        maxLength={7}
        className="code-input"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
      />
      <button className="btn btn-primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? 'Checking…' : label}</button>
    </form>
  );

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      {/* Inside the platform console the console's h1 stays the only h1. */}
      <PageHeader title="Account security" subtitle={ctx?.email} as={embedded ? 'h2' : 'h1'} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {next && !sessionVerified && <Notice tone="info">That section needs a session verified with two-factor authentication. Finish the step below and you’ll be taken there.</Notice>}
      <Card
        title={<h2 className="row" style={{ gap: 8 }}><Icon name="shield" /> Two-factor authentication</h2>}
        actions={sessionVerified ? <Badge tone="good">This session is verified</Badge> : verified.length > 0 ? <Badge tone="warn">Verification needed</Badge> : <Badge tone="neutral">Not set up</Badge>}
      >
        <div className="stack">
          {requires && (
            <p className="muted" style={{ margin: 0 }}>
              {platformView
                ? 'Platform administrators must verify with 2FA to provision companies, change platform settings, and open or use support sessions.'
                : 'Your company requires 2FA for privileged work: administration, publishing reports, approving budgets and CapEx, and editing financials.'}
            </p>
          )}

          {verified.length === 0 && !enroll && (
            <ol className="steps">
              <li><strong>Install an authenticator app</strong> on your phone — Google Authenticator, Microsoft Authenticator, 1Password or Authy all work.</li>
              <li><strong>Scan the QR code</strong> we show you next.</li>
              <li><strong>Enter the 6-digit code</strong> from the app to finish.</li>
              <li style={{ listStyle: 'none', marginLeft: -20 }}>
                <button className="btn btn-primary" onClick={() => void start()}>Set up authenticator app</button>
              </li>
            </ol>
          )}

          {enroll && (
            <div className="enroll">
              <img src={enroll.qr} alt="QR code to add this account to your authenticator app" width={184} height={184} />
              <div className="stack" style={{ gap: 10 }}>
                <p style={{ margin: 0 }}><strong>Scan this code</strong> with your authenticator app, then enter the 6-digit code it shows.</p>
                <details className="small muted">
                  <summary>Can’t scan? Enter this key manually</summary>
                  <code className="secret">{enroll.secret}</code>
                </details>
                {codeForm(enroll.id, 'Activate')}
                <button className="btn btn-sm btn-ghost" style={{ width: 'fit-content' }} onClick={() => { const id = enroll.id; setEnroll(null); void supabase.auth.mfa.unenroll({ factorId: id }).then(() => qc.invalidateQueries({ queryKey: ['mfa-factors'] })); }}>Cancel</button>
              </div>
            </div>
          )}

          {verified.length > 0 && !sessionVerified && !enroll && (
            <div className="stack" style={{ gap: 8 }}>
              <p style={{ margin: 0 }}>Open your authenticator app and enter the current code to verify this session.</p>
              {codeForm(verified[0]!.id, 'Verify')}
            </div>
          )}

          {(factors.data?.all ?? []).length > 0 && !enroll && (
            <ul className="timeline">
              {(factors.data?.all ?? []).map((f) => (
                <li key={f.id} className="spread">
                  <span>
                    {f.friendly_name || 'Authenticator app'} <span className="small muted">· added {fmtDate(f.created_at)}</span>{' '}
                    {f.status !== 'verified' && <Badge tone="warn">setup not finished</Badge>}
                  </span>
                  <span className="row" style={{ gap: 4 }}>
                    {f.status === 'verified' && sessionVerified && <button className="btn btn-sm" onClick={() => void start(f.id)}>Replace</button>}
                    <button className="btn btn-sm btn-ghost" disabled={f.status === 'verified' && !sessionVerified} title={f.status === 'verified' && !sessionVerified ? 'Verify this session first' : undefined} onClick={() => void remove(f.id, f.status === 'verified')}>Remove</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {verified.length > 0 && (
            <p className="small muted" style={{ margin: 0 }}>
              {verified.length === 1 ? 'One authenticator app is linked to your account.' : `${verified.length} authenticator apps are linked to your account.`} You’ll be asked for a code after each sign-in when you open a protected section.
            </p>
          )}
        </div>
      </Card>
      <ChangePassword />
    </div>
  );
}

function ChangePassword() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const problem = password && password.length < MIN_PASSWORD_LENGTH ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : confirm && confirm !== password ? 'The passwords don’t match.' : null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !password) return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setMsg({ tone: 'bad', text: /reauthentic|recent/i.test(error.message) ? 'For security, sign out and sign in again, then change your password.' : errorMessage(error.message) });
    else {
      setPassword('');
      setConfirm('');
      setMsg({ tone: 'good', text: 'Password changed.' });
    }
  };
  return (
    <Card title="Change password">
      <form className="stack" style={{ gap: 10, maxWidth: 360 }} onSubmit={save}>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <label className="field">New password<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label className="field">Confirm new password<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {problem && <span className="field-error">{problem}</span>}
        <button className="btn" type="submit" disabled={busy || !password || !!problem || password !== confirm} style={{ width: 'fit-content' }}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Card>
  );
}
