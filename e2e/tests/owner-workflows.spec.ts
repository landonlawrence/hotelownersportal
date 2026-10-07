import { expect, test } from '@playwright/test';
import { HV, SP, login } from './helpers';

test('branded login per tenant host; domain does not grant access', async ({ page }) => {
  await page.goto(`${HV}/login`);
  await expect(page.getByRole('heading', { name: 'Your portfolio, clearly.' })).toBeVisible();
  await expect(page).toHaveTitle('Harborview Owner Portal');
  await page.goto(`${SP}/login`);
  await expect(page.getByRole('heading', { name: 'Performance at altitude.' })).toBeVisible();
  await expect(page).toHaveTitle('Summit Peak Investor Center');
  // A Harborview-only investor signing in on the Summit domain still sees only Harborview data.
  await login(page, 'ian.investor@owners.example', SP);
  await expect(page.locator('aside.sidebar')).toContainText('Harborview Owner Portal');
  await expect(page.getByText('Summit Denver')).toHaveCount(0);
});

test('owner dashboard, published statement, owner package and document download', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible();
  await expect(page.getByText('DEMO DATA')).toBeVisible();
  for (const label of ['Occupancy', 'ADR', 'RevPAR', 'Room revenue', 'Total revenue']) {
    await expect(page.locator('.kpi .label', { hasText: new RegExp(`^${label}$`, 'i') })).toBeVisible();
  }
  // Chart has a table view.
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.locator('table.data th', { hasText: 'Prior year' })).toBeVisible();

  // Financial statements: only published/superseded for owners.
  await page.getByRole('link', { name: 'Budgets & Financials' }).click();
  await expect(page.getByRole('tab', { name: 'Financial statements' })).toBeVisible();
  await expect(page.locator('table.data')).not.toContainText('draft');
  await expect(page.locator('table.data')).not.toContainText('in review');
  await page.getByRole('link', { name: 'P&L — July 2026' }).first().click();
  await expect(page.getByText('Net operating income (NOI)')).toBeVisible();

  // Owner report.
  await page.getByRole('link', { name: 'Owner Reports' }).click();
  await page.getByRole('link', { name: /Owner report/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Performance summary' })).toBeVisible();
  await expect(page.getByText('staffing')).toHaveCount(0); // internal note never shown

  // Document download goes through a short-lived signed URL.
  await page.getByRole('link', { name: 'Documents' }).click();
  const row = page.getByRole('row', { name: /August 2026 P&L \(PDF\).*HV-SEA/ });
  const download = page.waitForEvent('download').catch(() => null);
  const responsePromise = page.waitForResponse((r) => r.url().includes('/download'));
  await row.getByRole('button', { name: 'Download' }).click();
  const res = await responsePromise;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { url: string; expires_at: string };
  expect(new Date(body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
  await download;
});

test('multi-company owner switches companies with branding and data scoped', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await expect(page.locator('aside.sidebar')).toContainText('Harborview Owner Portal');
  await page.getByLabel('Switch company').selectOption({ label: 'Summit Peak Hotel Partners' });
  await expect(page.locator('aside.sidebar')).toContainText('Summit Peak Investor Center');
  await expect(page.getByRole('link', { name: 'Summit Denver Union Station' })).toBeVisible();
  await expect(page.getByText('Harborview Seattle Waterfront')).toHaveCount(0);
  const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim());
  expect(primary).toBe('#1f4d3a');
});

test('owner approves a CapEx request that requires owner approval', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await page.getByRole('link', { name: 'CapEx' }).click();
  await page.getByRole('link', { name: 'Cooling tower replacement' }).click();
  await page.getByRole('button', { name: 'Review & decide' }).click();
  await page.getByLabel('Comment (required to reject)').fill('Approved for winter install.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.page-header .badge')).toContainText('approved');
  await expect(page.getByRole('button', { name: 'Review & decide' })).toHaveCount(0);
  await expect(page.locator('.kpi', { hasText: 'Approved budget' })).toContainText('$145,000');
});
