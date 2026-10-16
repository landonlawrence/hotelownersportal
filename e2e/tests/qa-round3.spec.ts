import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { HV, login } from './helpers';

/** Regression tests for QA round 3 findings (R3-xx ids in the fix list). */

const HARBORVIEW = '10000000-0000-4000-8000-000000000001';
const SUMMIT = '10000000-0000-4000-8000-000000000002';
const SEA = '20000000-0000-4000-8000-000000000101';
const PDX = '20000000-0000-4000-8000-000000000102';

let svc: { url: string; key: string } | undefined;
/** Test-only: the local Supabase REST API with the local service key (never a hosted project). */
async function rest(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}) {
  if (!svc) {
    const status = JSON.parse(execSync('npx supabase status -o json', { cwd: '..', stdio: ['ignore', 'pipe', 'ignore'] }).toString()) as Record<string, string>;
    svc = { url: status['API_URL']!, key: status['SERVICE_ROLE_KEY']! };
  }
  const res = await fetch(`${svc.url}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: { apikey: svc.key, authorization: `Bearer ${svc.key}`, 'content-type': 'application/json', prefer: init.prefer ?? 'return=representation' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  expect(res.ok, `${init.method ?? 'GET'} ${path}: ${res.status}`).toBe(true);
  const text = await res.text();
  return text ? (JSON.parse(text) as Array<Record<string, unknown>>) : [];
}

async function noHorizontalScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width);
}

test('R3-17 phone width: no page-level horizontal scroll on Home, a property and Invitations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin@harborview.example');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await noHorizontalScroll(page);
  await page.goto(`${HV}/properties/${SEA}`);
  await expect(page.getByRole('heading', { name: 'Harborview Seattle Waterfront', level: 1 })).toBeVisible();
  await expect(page.getByRole('table').first()).toBeVisible();
  await noHorizontalScroll(page);
  await page.goto(`${HV}/admin?tab=invitations`);
  await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible();
  await noHorizontalScroll(page);
});

test('R3-29 / R3-31 filter captions are not labels; pages have their own title and focus moves to the h1', async ({ page }) => {
  await login(page, 'finance@harborview.example');
  await expect(page.getByRole('heading', { name: 'Portfolio overview', level: 1 })).toBeVisible();
  const mtd = page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'MTD' });
  await expect(mtd).toHaveAttribute('aria-pressed', 'true');
  // Clicking the caption does nothing (it used to activate "Day").
  await page.locator('.filter-bar div.field > span', { hasText: 'Period' }).click();
  await expect(mtd).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Properties: All properties \(\d+\)$/ })).toBeVisible();
  await expect(page.getByRole('listbox')).toHaveCount(0);

  await expect(page).toHaveTitle(/^Portfolio overview – /);
  await page.getByRole('link', { name: 'Documents' }).click();
  await expect(page).toHaveTitle(/^Documents – /);
  await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeFocused();
});

test('R3-05 a deep link to another company’s budget offers to switch', async ({ page }) => {
  const [budget] = await rest(`budget_versions?company_id=eq.${SUMMIT}&status=eq.approved&select=id&limit=1`);
  await login(page, 'olivia.owner@owners.example');
  await page.goto(`${HV}/financials/budgets/${budget!.id}`);
  await expect(page.getByRole('heading', { level: 1, name: /belongs to Summit/ })).toBeVisible();
  await expect(page.getByText('undefined')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Switch to Summit/ })).toBeVisible();
});

test('R3-15 Approve waits for unsaved budget edits; invalid cells are named', async ({ page }) => {
  const [v] = await rest('budget_versions', { method: 'POST', body: { company_id: HARBORVIEW, property_id: PDX, fiscal_year: 2031, version_number: 1, name: 'QA3 draft', status: 'draft' } });
  try {
    await login(page, 'finance@harborview.example');
    await page.goto(`${HV}/financials/budgets/${v!.id}`);
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeEnabled();
    await page.getByLabel('Rooms revenue Jan').fill('12x');
    await expect(approve).toBeDisabled();
    await expect(page.getByText('Save or discard your changes first')).toBeVisible();
    await expect(page.getByText('Rooms revenue, Jan: enter a number')).toBeVisible();
    await expect(page.getByLabel('Rooms revenue Jan')).toHaveAttribute('aria-describedby', /budget-cell-error/);
    await page.getByRole('button', { name: 'Discard changes' }).click();
    // An empty budget cannot be approved: the reason is worded for people.
    await approve.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve budget' }).click();
    await expect(page.getByRole('dialog').getByText('Enter and save at least one budget line before approving.')).toBeVisible();
  } finally {
    await rest(`budget_versions?id=eq.${v!.id}`, { method: 'DELETE' });
  }
});

test('R3-16 a failed notifications request is an error with Try again, not “all caught up”', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await page.route(/\/rest\/v1\/notifications\?select=id%2Ckind/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }));
  await page.goto(`${HV}/notifications`);
  await expect(page.getByText('We couldn’t load this.').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('You’re all caught up')).toHaveCount(0);
  await page.unroute(/\/rest\/v1\/notifications\?select=id%2Ckind/);
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await expect(page.getByText('We couldn’t load this.')).toHaveCount(0);
});

test('R3-18 closing an instant-save dialog does not ask to discard', async ({ page }) => {
  let asked = false;
  page.on('dialog', (d) => {
    asked = true;
    void d.dismiss();
  });
  await login(page, 'finance@harborview.example');
  await page.getByRole('link', { name: 'Data imports' }).click();
  await page.getByRole('button', { name: 'Configure Monthly GL export' }).click();
  const dialog = page.getByRole('dialog');
  const policy = dialog.getByLabel('Revision policy');
  const before = await policy.inputValue();
  await policy.selectOption(before === 'replace' ? 'require_review' : 'replace');
  await policy.selectOption(before);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(asked).toBe(false);
});

test('R3-10 a property edit from a stale copy is refused, not silently applied', async ({ page }) => {
  await login(page, 'admin@harborview.example');
  await page.goto(`${HV}/admin?tab=properties`);
  await page.getByRole('button', { name: 'Edit Harborview Portland Pearl' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Harborview Portland Pearl');
  // Someone else saves meanwhile.
  const [p] = await rest(`properties?id=eq.${PDX}&select=region`);
  await rest(`properties?id=eq.${PDX}`, { method: 'PATCH', body: { region: p!.region } });
  await dialog.getByLabel('City', { exact: true }).fill('Portland (QA3)');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('This property was changed by someone else. Reload to see the latest.')).toBeVisible();
  const [after] = await rest(`properties?id=eq.${PDX}&select=city`);
  expect(after!.city).not.toBe('Portland (QA3)');
});

test('R3-35 a module switched off reads as not enabled, with an h1', async ({ page }) => {
  await rest(`company_modules?company_id=eq.${HARBORVIEW}&module=eq.capex`, { method: 'PATCH', body: { enabled: false } });
  try {
    await login(page, 'admin@harborview.example');
    await page.goto(`${HV}/capex`);
    await expect(page.getByRole('heading', { level: 1, name: /CapEx isn’t enabled for Harborview/ })).toBeVisible();
    await expect(page.getByText('Your platform administrator can turn it on.')).toBeVisible();
  } finally {
    await rest(`company_modules?company_id=eq.${HARBORVIEW}&module=eq.capex`, { method: 'PATCH', body: { enabled: true } });
  }
});

test('R3-36 an incomplete invitation link explains what to do', async ({ page }) => {
  await page.goto(`${HV}/accept-invite`);
  await expect(page.getByText('Open the full link from your invitation email, or ask your administrator to resend it.')).toBeVisible();
  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
