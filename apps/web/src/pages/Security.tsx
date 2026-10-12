import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { usePortal } from '../state/portal';
import { Icon } from '../components/icons';
import { Badge, Card, Notice, PageHeader, errorMessage } from '../components/ui';

/** Two-factor (TOTP) enrolment and step-up to aal2 for privileged actions. */
export function SecurityPage() {
  const { ctx, company } = usePortal();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const factors = useQuery({ queryKey: ['mfa-factors'], queryFn: async () => (await supabase.auth.mfa.listFactors()).data });
  const verified = factors.data?.totp.filter((f) => f.status === 'verified') ?? [];
  const sessionVerified = ctx?.aal === 'aal2';
  const requires = company?.require_mfa_for_privileged ?? ctx?.is_platform_admin;

  const start = async () => {
    setMsg(null);
    // Abandoned enrolments leave unverified factors behind; clear them so a fresh QR code can be issued.
    for (const f of factors.data?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16)}` });
    if (error) return setMsg({ tone: 'bad', text: `${error.message}. If this keeps happening, authenticator-app 2FA may be switched off for this project (Supabase → Authentication → Multi-Factor).` });
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
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
      setEnroll(null);
      setCode('');
      await qc.invalidateQueries();
      if (next && next.startsWith('/')) navigate(next);
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
      <PageHeader title="Account security" subtitle={ctx?.email} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {next && !sessionVerified && <Notice tone="info">That section needs a session verified with two-factor authentication. Finish the step below and you’ll be taken there.</Notice>}
      <Card
        title={<h2 className="row" style={{ gap: 8 }}><Icon name="shield" /> Two-factor authentication</h2>}
        actions={sessionVerified ? <Badge tone="good">This session is verified</Badge> : verified.length > 0 ? <Badge tone="warn">Verification needed</Badge> : <Badge tone="neutral">Not set up</Badge>}
      >
        <div className="stack">
          {requires && (
            <p className="muted" style={{ margin: 0 }}>
              {ctx?.is_platform_admin && !company
                ? 'Platform administrators must verify with 2FA before opening a support session.'
                : 'Your company requires 2FA for privileged work: administration, publishing reports, approving budgets and CapEx, and editing financials.'}
            </p>
          )}

          {verified.length === 0 && !enroll && (
            <ol className="steps">
              <li><strong>Install an authenticator app</strong> on your phone — Google Authenticator, Microsoft Authenticator, 1Password or Authy all work.</li>
              <li><strong>Scan the QR code</strong> we show you next.</li>
              <li><strong>Enter the 6-digit code</strong> from the app to finish.</li>
              <li style={{ listStyle: 'none', marginLeft: -20 }}>
                <button className="btn btn-primary" onClick={start}>Set up authenticator app</button>
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
                <button className="btn btn-sm btn-ghost" style={{ width: 'fit-content' }} onClick={() => setEnroll(null)}>Cancel</button>
              </div>
            </div>
          )}

          {verified.length > 0 && !sessionVerified && (
            <div className="stack" style={{ gap: 8 }}>
              <p style={{ margin: 0 }}>Open your authenticator app and enter the current code to verify this session.</p>
              {codeForm(verified[0]!.id, 'Verify')}
            </div>
          )}

          {verified.length > 0 && (
            <p className="small muted" style={{ margin: 0 }}>
              {verified.length === 1 ? 'One authenticator app is linked to your account.' : `${verified.length} authenticator apps are linked to your account.`} You’ll be asked for a code after each sign-in when you open a protected section.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
