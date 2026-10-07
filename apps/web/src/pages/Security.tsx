import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { usePortal, useCompany } from '../state/portal';
import { Card, Notice, PageHeader, errorMessage } from '../components/ui';

/** Two-factor (TOTP) enrolment and step-up to aal2 for privileged actions. */
export function SecurityPage() {
  const { ctx } = usePortal();
  const company = useCompany();
  const qc = useQueryClient();
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const factors = useQuery({ queryKey: ['mfa-factors'], queryFn: async () => (await supabase.auth.mfa.listFactors()).data });
  const verified = factors.data?.totp.filter((f) => f.status === 'verified') ?? [];

  const start = async () => {
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    if (error) return setMsg({ tone: 'bad', text: error.message });
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };
  const verify = async (factorId: string) => {
    try {
      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId });
      if (e1) throw e1;
      const { error: e2 } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code: code.trim() });
      if (e2) throw e2;
      setMsg({ tone: 'good', text: 'Verified. Privileged actions are now available for this session.' });
      setEnroll(null);
      setCode('');
      await qc.invalidateQueries();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  };

  return (
    <div className="stack">
      <PageHeader title="Account security" subtitle={ctx?.email} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Card title="Two-factor authentication">
        <div className="stack">
          <p className="muted">
            Session assurance: <strong>{ctx?.aal === 'aal2' ? 'Verified with 2FA' : 'Password only'}</strong>.{' '}
            {company.require_mfa_for_privileged && 'This company requires 2FA for privileged actions (publishing, approvals, administration, editing financials).'}
          </p>
          {company.mfa_blocked_permissions.length > 0 && (
            <Notice tone="warn">Verify with 2FA to enable: {company.mfa_blocked_permissions.join(', ')}</Notice>
          )}
          {verified.length > 0 && ctx?.aal !== 'aal2' && (
            <div className="row">
              <input aria-label="Authenticator code" inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn btn-primary" onClick={() => verify(verified[0]!.id)}>Verify</button>
            </div>
          )}
          {verified.length === 0 && !enroll && (
            <button className="btn btn-primary" onClick={start} style={{ width: 'fit-content' }}>Set up authenticator app</button>
          )}
          {enroll && (
            <div className="stack">
              <p>Scan this code with your authenticator app, then enter the 6-digit code.</p>
              <img src={enroll.qr} alt="Authenticator QR code" width={180} height={180} />
              <code className="small">{enroll.secret}</code>
              <div className="row">
                <input aria-label="Authenticator code" inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
                <button className="btn btn-primary" onClick={() => verify(enroll.id)}>Activate</button>
              </div>
            </div>
          )}
          {verified.length > 0 && <p className="small muted">{verified.length} authenticator(s) enrolled.</p>}
        </div>
      </Card>
    </div>
  );
}
