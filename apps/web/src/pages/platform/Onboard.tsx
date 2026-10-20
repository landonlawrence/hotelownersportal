import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { contrastRatio } from '@hop/core';
import { supabase } from '../../lib/supabase';
import { usePortal } from '../../state/portal';
import { Icon } from '../../components/icons';
import { Card, Notice, PageHeader, dbErrorMessage } from '../../components/ui';
import { Field, KeyTag, MODULES, SignInPreview, emailValid, hexValid, inviteLink, slugValid, slugify, type Branding } from './shared';

const TIMEZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu', 'UTC'];
const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'MXN', 'AUD'];

interface Hotel { code: string; name: string; city: string; region: string; timezone: string; rooms: string; opened_on: string; status: 'onboarding' | 'active' }
const emptyHotel = (): Hotel => ({ code: '', name: '', city: '', region: '', timezone: 'America/New_York', rooms: '', opened_on: '', status: 'onboarding' });

const STEPS = ['Company', 'Branding', 'Hotels', 'Access', 'Review'] as const;

interface Result { companyId: string; name: string; invitations: Array<{ email: string; token: string }> }

export function OnboardPage() {
  const { ctx } = usePortal();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const verified = ctx?.aal === 'aal2';
  const [step, setStep] = useState(0);
  const [company, setCompany] = useState({ name: '', slug: '', legal_name: '', currency: 'USD' });
  const [slugEdited, setSlugEdited] = useState(false);
  const [brand, setBrand] = useState<Partial<Branding>>({ portal_name: '', primary_color: '#1f3a5f', accent_color: '#c8a24a', surface_color: '#f6f7f9', logo_url: '', login_headline: '', login_message: '', support_email: '' });
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [admins, setAdmins] = useState<string[]>(['']);
  const [requireMfa, setRequireMfa] = useState(true);
  const [modules, setModules] = useState<string[]>(MODULES.map((m) => m.key));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const companyErrors = {
    name: company.name.trim().length >= 2 ? null : 'Enter the company name.',
    slug: slugValid(company.slug) ? null : 'Use 2–40 lowercase letters, numbers or dashes.',
  };
  const contrast = brand.primary_color && hexValid(brand.primary_color) ? Math.max(contrastRatio(brand.primary_color, '#ffffff'), contrastRatio(brand.primary_color, '#111827')) : 0;
  const brandErrors = {
    colors: ['primary_color', 'accent_color', 'surface_color'].every((k) => hexValid((brand as Record<string, string>)[k] ?? '')) ? null : 'Colours must be hex values like #1f3a5f.',
    logo: !brand.logo_url || /^(https:\/\/|\/)/.test(brand.logo_url) ? null : 'Logo URLs must start with https://',
    support: !brand.support_email || emailValid(brand.support_email) ? null : 'Enter a valid support email or leave it blank.',
  };
  const hotelErrors = hotels.map((h) => (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/.test(h.code.trim()) ? 'Code: 2–32 letters, numbers, dashes.'
      : h.name.trim().length < 2 ? 'Enter the hotel name.'
        : h.rooms && !(Number.isInteger(Number(h.rooms)) && Number(h.rooms) > 0 && Number(h.rooms) < 100000) ? 'Rooms must be a whole number.'
          : null));
  const dupCodes = new Set(hotels.map((h) => h.code.trim().toUpperCase()).filter((c, i, a) => c && a.indexOf(c) !== i));
  const adminList = admins.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const accessError = adminList.length === 0 ? 'Add at least one company administrator.' : adminList.find((a) => !emailValid(a)) ? 'One of the admin emails isn’t valid.' : null;
  const stepValid = [
    !companyErrors.name && !companyErrors.slug,
    !brandErrors.colors && !brandErrors.logo && !brandErrors.support,
    hotelErrors.every((e) => !e) && dupCodes.size === 0,
    !accessError,
    true,
  ];

  const create = async () => {
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('platform_provision_company', {
      p: {
        name: company.name.trim(),
        slug: company.slug,
        legal_name: company.legal_name.trim() || null,
        currency: company.currency,
        require_mfa: requireMfa,
        modules,
        admins: adminList,
        branding: { ...brand, portal_name: brand.portal_name?.trim() || company.name.trim() },
        properties: hotels.map((h) => ({ ...h, code: h.code.trim().toUpperCase(), rooms: h.rooms ? Number(h.rooms) : null, opened_on: h.opened_on || null })),
      },
    });
    setBusy(false);
    if (e) return setError(dbErrorMessage(e));
    const r = data as { company_id: string; invitations: Array<{ email: string; token: string }> };
    setResult({ companyId: r.company_id, name: company.name.trim(), invitations: r.invitations });
    await qc.invalidateQueries({ queryKey: ['platform-companies'] });
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  };

  if (result) {
    return (
      <div className="stack console-stack">
        <section className="onboard-done">
          <KeyTag slug={company.slug} color={brand.primary_color} size="lg" />
          <h1>{result.name} is on the portal</h1>
          <p>Send each administrator their invitation link. Links work once and expire in 14 days. Each link is shown only here; you can issue a new one from the company page at any time.</p>
        </section>
        <Card title="Invitation links">
          <ul className="invite-list">
            {result.invitations.map((i) => {
              const link = inviteLink(i.token);
              return (
                <li key={i.email}>
                  <strong>{i.email}</strong>
                  <div className="copy-row">
                    <input readOnly value={link} aria-label={`Invitation link for ${i.email}`} onFocus={(e) => e.currentTarget.select()} />
                    <button className="btn btn-primary" onClick={() => void copy(link, i.email)}>{copied === i.email ? 'Copied' : 'Copy link'}</button>
                    <a className="btn" href={`mailto:${i.email}?subject=${encodeURIComponent(`Your ${brand.portal_name || result.name} administrator invitation`)}&body=${encodeURIComponent(`You've been set up as an administrator of ${brand.portal_name || result.name}.\n\nCreate your account here (the link works once and expires in 14 days):\n${link}\n`)}`}>Email it</a>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
        <div className="row">
          <button className="btn btn-brass" onClick={() => navigate(`/platform/companies/${result.companyId}`)}>Open {result.name}</button>
          <button className="btn" onClick={() => { setResult(null); setStep(0); setCompany({ name: '', slug: '', legal_name: '', currency: 'USD' }); setSlugEdited(false); setHotels([]); setAdmins(['']); }}>Onboard another company</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack console-stack">
      <PageHeader title="Onboard a company" subtitle="Everything a new management company needs on day one: profile, brand, hotels and its first administrators." />
      {!verified && <Notice tone="warn">Creating a company needs a 2FA-verified session. <Link to="/platform/security">Verify with 2FA</Link>, then come back; your answers stay here.</Notice>}
      <ol className="wizard-steps" aria-label="Onboarding steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
            <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}>
              <span className="wizard-dot" aria-hidden>{i < step ? <Icon name="check" size={13} /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      <form
        className="wizard-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!stepValid[step]) return;
          if (step < STEPS.length - 1) setStep(step + 1);
          else void create();
        }}
      >
        {step === 0 && (
          <Card title="The company">
            <div className="form-grid">
              <Field label="Company name" error={company.name && companyErrors.name}>
                <input autoFocus required placeholder="Lakeview Hospitality" value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value, slug: slugEdited ? company.slug : slugify(e.target.value) })} />
              </Field>
              <Field label="Short ID" hint="Used in links and on the key tag. Lowercase letters, numbers and dashes." error={company.slug && companyErrors.slug}>
                <input required value={company.slug} onChange={(e) => { setSlugEdited(true); setCompany({ ...company, slug: slugify(e.target.value) }); }} />
              </Field>
              <Field label="Legal name" hint="Optional. Shown on statements and packages.">
                <input value={company.legal_name} onChange={(e) => setCompany({ ...company, legal_name: e.target.value })} />
              </Field>
              <Field label="Reporting currency">
                <select value={company.currency} onChange={(e) => setCompany({ ...company, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
              </Field>
            </div>
            {company.slug && slugValid(company.slug) && <p className="small muted" style={{ marginBottom: 0 }}>Key tag preview: <KeyTag slug={company.slug} color={brand.primary_color} size="sm" /></p>}
          </Card>
        )}

        {step === 1 && (
          <div className="brand-step">
            <Card title="How the portal looks to their owners">
              <div className="form-grid">
                <Field label="Portal name" hint="The title owners see when they sign in.">
                  <input placeholder={`${company.name || 'Company'} Owner Portal`} value={brand.portal_name ?? ''} onChange={(e) => setBrand({ ...brand, portal_name: e.target.value })} />
                </Field>
                <Field label="Support email" error={brandErrors.support}>
                  <input type="email" placeholder="owners@company.com" value={brand.support_email ?? ''} onChange={(e) => setBrand({ ...brand, support_email: e.target.value })} />
                </Field>
              </div>
              <div className="color-row">
                {([['primary_color', 'Main colour'], ['accent_color', 'Accent'], ['surface_color', 'Background']] as const).map(([k, label]) => (
                  <label key={k} className="field color-field">
                    {label}
                    <span className="color-input">
                      <input type="color" value={hexValid(brand[k] ?? '') ? brand[k] : '#000000'} onChange={(e) => setBrand({ ...brand, [k]: e.target.value })} aria-label={`${label} picker`} />
                      <input value={brand[k] ?? ''} onChange={(e) => setBrand({ ...brand, [k]: e.target.value })} aria-label={`${label} hex value`} />
                    </span>
                  </label>
                ))}
              </div>
              {brandErrors.colors && <p className="field-error">{brandErrors.colors}</p>}
              {contrast > 0 && contrast < 4.5 && <Notice tone="warn">Text on the main colour will be hard to read (contrast {contrast.toFixed(1)}:1). Pick a darker or lighter shade.</Notice>}
              <div className="form-grid">
                <Field label="Logo URL" hint="Optional. A wide logo on a transparent background works best." error={brandErrors.logo}>
                  <input placeholder="https://…" value={brand.logo_url ?? ''} onChange={(e) => setBrand({ ...brand, logo_url: e.target.value })} />
                </Field>
                <Field label="Sign-in headline">
                  <input placeholder="Hotel ownership reporting" value={brand.login_headline ?? ''} onChange={(e) => setBrand({ ...brand, login_headline: e.target.value })} />
                </Field>
              </div>
              <Field label="Sign-in message">
                <textarea rows={2} placeholder="Sign in to view the properties, financial information and documents you are authorized to access." value={brand.login_message ?? ''} onChange={(e) => setBrand({ ...brand, login_message: e.target.value })} />
              </Field>
            </Card>
            <SignInPreview b={{ ...brand, portal_name: brand.portal_name || company.name }} companyName={company.name} />
          </div>
        )}

        {step === 2 && (
          <Card title="Their hotels" actions={<button type="button" className="btn btn-sm" onClick={() => setHotels([...hotels, emptyHotel()])}>Add a hotel</button>}>
            <p className="muted" style={{ marginTop: 0 }}>Optional. Adding hotels now lets the company import data on day one; their admin can add more later. Room counts apply from the opening date, or from today if it’s blank.</p>
            {hotels.length === 0 ? (
              <button type="button" className="hotel-empty" onClick={() => setHotels([emptyHotel()])}>
                <Icon name="building" size={22} />
                Add the first hotel
              </button>
            ) : (
              <div className="hotel-rows">
                {hotels.map((h, i) => {
                  const set = (patch: Partial<Hotel>) => setHotels(hotels.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <fieldset key={i} className="hotel-row">
                      <legend>Hotel {i + 1}</legend>
                      <Field label="Code"><input value={h.code} placeholder="LV-ASP" onChange={(e) => set({ code: e.target.value.toUpperCase() })} /></Field>
                      <Field label="Name"><input value={h.name} placeholder="Lakeview Aspen Lodge" onChange={(e) => set({ name: e.target.value })} /></Field>
                      <Field label="City"><input value={h.city} onChange={(e) => set({ city: e.target.value })} /></Field>
                      <Field label="State/region"><input value={h.region} onChange={(e) => set({ region: e.target.value })} /></Field>
                      <Field label="Time zone"><select value={h.timezone} onChange={(e) => set({ timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</select></Field>
                      <Field label="Rooms"><input inputMode="numeric" value={h.rooms} onChange={(e) => set({ rooms: e.target.value.replace(/[^0-9]/g, '') })} /></Field>
                      <Field label="Opened on"><input type="date" value={h.opened_on} onChange={(e) => set({ opened_on: e.target.value })} /></Field>
                      <Field label="Status">
                        <select value={h.status} onChange={(e) => set({ status: e.target.value as Hotel['status'] })}>
                          <option value="onboarding">Onboarding</option>
                          <option value="active">Active</option>
                        </select>
                      </Field>
                      <div className="hotel-row-foot">
                        {(hotelErrors[i] || dupCodes.has(h.code.trim().toUpperCase())) && <span className="field-error">{hotelErrors[i] ?? 'Two hotels share this code.'}</span>}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHotels(hotels.filter((_, j) => j !== i))}>Remove</button>
                      </div>
                    </fieldset>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {step === 3 && (
          <div className="grid grid-2">
            <Card title="Company administrators">
              <p className="muted" style={{ marginTop: 0 }}>They manage hotels, users, branding and data for this company. You’ll get an invitation link for each.</p>
              <div className="stack" style={{ gap: 8 }}>
                {admins.map((a, i) => (
                  <div className="row" key={i}>
                    <input type="email" aria-label={`Administrator ${i + 1} email`} placeholder="name@company.com" value={a} style={{ flex: 1 }} onChange={(e) => setAdmins(admins.map((x, j) => (j === i ? e.target.value : x)))} />
                    {admins.length > 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdmins(admins.filter((_, j) => j !== i))}>Remove</button>}
                  </div>
                ))}
                <button type="button" className="btn btn-sm" style={{ width: 'fit-content' }} onClick={() => setAdmins([...admins, ''])}>Add another administrator</button>
                {accessError && adminList.length > 0 && <span className="field-error">{accessError}</span>}
              </div>
            </Card>
            <Card title="Features and security">
              <fieldset className="module-list">
                <legend className="sr-only">Features</legend>
                {MODULES.map((m) => (
                  <label key={m.key} className="module-option">
                    <input type="checkbox" checked={modules.includes(m.key)} onChange={(e) => setModules(e.target.checked ? [...modules, m.key] : modules.filter((x) => x !== m.key))} />
                    <span><strong>{m.label}</strong><span className="muted small">{m.detail}</span></span>
                  </label>
                ))}
              </fieldset>
              <label className="module-option" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} />
                <span><strong>Require 2FA for privileged work</strong><span className="muted small">Administration, publishing and approvals need an authenticator app. Recommended.</span></span>
              </label>
            </Card>
          </div>
        )}

        {step === 4 && (
          <div className="review-grid">
            <Card title="Review">
              <dl className="kv">
                <dt>Company</dt><dd><strong>{company.name}</strong>{company.legal_name && ` (${company.legal_name})`}</dd>
                <dt>Short ID</dt><dd><KeyTag slug={company.slug} color={brand.primary_color} size="sm" /></dd>
                <dt>Currency</dt><dd>{company.currency}</dd>
                <dt>Portal name</dt><dd>{brand.portal_name || company.name}</dd>
                <dt>Hotels</dt><dd>{hotels.length === 0 ? 'None yet' : hotels.map((h) => `${h.name} (${h.code}${h.rooms ? `, ${h.rooms} rooms` : ''})`).join('; ')}</dd>
                <dt>Administrators</dt><dd>{adminList.join(', ')}</dd>
                <dt>Features</dt><dd>{MODULES.filter((m) => modules.includes(m.key)).map((m) => m.label).join(', ') || 'Administration only'}</dd>
                <dt>2FA</dt><dd>{requireMfa ? 'Required for privileged work' : 'Not required'}</dd>
              </dl>
              <p className="small muted" style={{ marginBottom: 0 }}>The company also gets a standard chart of accounts and document categories, which its admin can adjust.</p>
            </Card>
            <SignInPreview b={{ ...brand, portal_name: brand.portal_name || company.name }} companyName={company.name} />
          </div>
        )}

        {error && <Notice tone="bad">{error}</Notice>}
        <div className="wizard-nav">
          {step > 0 && <button type="button" className="btn" onClick={() => setStep(step - 1)}>Back</button>}
          <span className="spacer" />
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" disabled={!stepValid[step]}>Continue to {STEPS[step + 1]?.toLowerCase()}</button>
          ) : (
            <button className="btn btn-brass" disabled={busy || !verified}>{busy ? 'Creating…' : `Create ${company.name || 'company'}`}</button>
          )}
        </div>
      </form>
    </div>
  );
}
