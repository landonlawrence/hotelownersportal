import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { HV, PASSWORD, login } from './helpers';

/** Regression tests for QA round 2 findings (R2-xx ids in the fix list). */

const HARBORVIEW = '10000000-0000-4000-8000-000000000001';

/** Test-only: flip a company setting through the local Supabase REST API with the local service key. */
async function setRequireMfa(value: boolean) {
  const status = JSON.parse(execSync('npx supabase status -o json', { cwd: '..', stdio: ['ignore', 'pipe', 'ignore'] }).toString()) as Record<string, string>;
  const key = status['SERVICE_ROLE_KEY']!;
  const res = await fetch(`${status['API_URL']}/rest/v1/companies?id=eq.${HARBORVIEW}`, {
    method: 'PATCH',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ require_mfa_for_privileged: value }),
  });
  expect(res.ok).toBe(true);
}

async function fillLogin(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('R2-02 a failing my_context shows a way out, and Try again recovers', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await page.route('**/rest/v1/rpc/my_context', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"upstream unavailable"}' }));
  await page.reload();
  await expect(page.getByText('We couldn’t load your account.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.unroute('**/rest/v1/rpc/my_context');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible();
});

test('R2-02 a rejected token signs out with a session-expired message', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await page.route('**/rest/v1/rpc/my_context', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"PGRST301","message":"JWT expired"}' }));
  await page.reload();
  await expect(page.getByText('Your session has expired. Sign in again.')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/login$/);
});

test('R2-10 a failed properties request is an error, not "nothing shared"', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await page.route(/\/rest\/v1\/properties\?/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }));
  await page.reload();
  await expect(page.getByText('We couldn’t load your properties.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Nothing has been shared with you yet')).toHaveCount(0);
  await page.unroute(/\/rest\/v1\/properties\?/);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible();
});

test('R2-07 forgot password looks the same whether or not the account exists', async ({ page }) => {
  await page.goto(`${HV}/login`);
  await page.route('**/auth/v1/recover**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"code":500,"msg":"Error sending recovery email"}' }));
  await page.getByLabel('Email').fill('olivia.owner@owners.example');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByText('If an account exists for that address, a reset link has been sent.')).toBeVisible();
  await expect(page.getByText(/couldn’t send a reset email/)).toHaveCount(0);
  await page.unroute('**/auth/v1/recover**');
  await page.route('**/auth/v1/recover**', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: '{"code":429,"msg":"For security purposes, you can only request this after 60 seconds."}' }));
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByText('Too many reset requests. Wait a minute and try again.')).toBeVisible();
});

test('R2-25 sign-in returns to the full original URL', async ({ page }) => {
  await page.goto(`${HV}/admin?tab=audit`);
  await expect(page).toHaveURL(/\/login/);
  await fillLogin(page, 'admin@harborview.example');
  await expect(page).toHaveURL(/\/admin\?tab=audit$/);
  await expect(page.getByRole('tab', { name: 'Audit log' })).toHaveAttribute('aria-selected', 'true');
});

test('R2-04 a GM uploading a loan document defaults to Internal, never owners', async ({ page }) => {
  await login(page, 'gm.seattle@harborview.example');
  await page.getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Upload document' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Category').selectOption({ label: 'Loan documents' });
  await expect(dialog.getByLabel('Visibility')).toHaveValue('internal');
  await expect(dialog.getByText(/Default for this category is Confidential; you can’t use it, so Internal \(management\) was chosen\./)).toBeVisible();
});

test('R2-19 Escape asks before discarding typed input', async ({ page }) => {
  await login(page, 'gm.seattle@harborview.example');
  await page.getByRole('link', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Upload document' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('Half-typed title');
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.keyboard.press('Escape');
  await expect.poll(() => asked).toBe('Discard what you entered?');
  await expect(dialog).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('R2-05 double-clicking Create draft project creates one project', async ({ page }) => {
  await login(page, 'finance@harborview.example');
  let calls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/rest/v1/rpc/create_capex_project') && r.method() === 'POST') calls++;
  });
  await page.getByRole('link', { name: 'CapEx' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('QA R2 double click');
  await dialog.getByLabel('Requested budget').fill('12,500');
  await dialog.getByRole('button', { name: 'Create draft project' }).dblclick();
  await expect(page.getByRole('heading', { name: 'QA R2 double click' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls).toBe(1);
});

test('R2-09 Create draft is enabled after loading /reports directly', async ({ page }) => {
  await login(page, 'finance@harborview.example');
  await page.goto(`${HV}/reports`);
  await page.getByRole('button', { name: 'New package' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Property')).not.toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Create draft' })).toBeEnabled();
});

test('R2-27 a future asOf in the URL is dropped', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await page.goto(`${HV}/?asOf=2040-06-15&view=ytd`);
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible();
  await expect(page).not.toHaveURL(/asOf=/);
  await expect(page).toHaveURL(/view=ytd/);
  await expect(page.locator('.page-header p')).toContainText('Year to date');
});

test('R2-06 portfolio footer hides PY and budget deltas over partial coverage', async ({ page }) => {
  await login(page, 'finance@harborview.example');
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible();
  const foot = page.locator('table.data tfoot tr');
  await expect(foot).toBeVisible();
  const partial = (await foot.locator('td').first().textContent())?.includes('(partial)');
  test.skip(!partial, 'Demo data currently has complete coverage for this period');
  const hidden = foot.locator('td[title^="Comparison hidden"]');
  await expect(hidden).toHaveCount(2);
  await expect(hidden.first()).toHaveText(/—/);
});

test('R2-08 approvers without a 2FA-verified session are told to verify', async ({ page }) => {
  await setRequireMfa(true);
  try {
    await login(page, 'finance@harborview.example');
    await page.getByRole('link', { name: 'CapEx' }).click();
    const notice = page.locator('.notice', { hasText: 'Some data and actions need a 2FA-verified session.' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('link', { name: 'Verify with 2FA' })).toHaveAttribute('href', '/security?next=%2Fcapex');
    await page.goto(`${HV}/reports`);
    await expect(page.getByText(/Draft packages, new packages and publishing need a 2FA-verified session/)).toBeVisible();
  } finally {
    await setRequireMfa(false);
  }
});

test.describe('R2-14 phone-width navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('closed drawer is not focusable; skip link first; Escape closes', async ({ page }) => {
    await login(page, 'olivia.owner@owners.example');
    const aside = page.locator('aside.sidebar');
    await expect(aside).toHaveAttribute('inert', '');
    // Fresh load: the first Tab stop must be visible (the skip link), not a hidden drawer link.
    await page.reload();
    await expect(page.locator('header.topbar')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
    await expect(aside).not.toHaveAttribute('inert', '');
    await expect(aside.getByRole('link', { name: 'Home' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(aside).toHaveAttribute('inert', '');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  });
});
