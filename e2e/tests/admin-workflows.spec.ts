import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('finance publishes a draft statement after review; owner then sees it', async ({ page, browser }) => {
  await login(page, 'finance@harborview.example');
  await page.getByRole('link', { name: 'Budgets & Financials' }).click();
  await page.getByLabel('Property').selectOption({ label: 'Harborview Seattle Waterfront' });
  await page.getByRole('row', { name: /in review/ }).getByRole('link').first().click();
  await expect(page.getByText('Draft — not visible to owners')).toBeVisible();
  const title = await page.getByRole('heading', { level: 1 }).textContent();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish statement' }).click();
  await expect(page.locator('.page-header .badge')).toContainText('published');

  const owner = await browser.newPage();
  await login(owner, 'olivia.owner@owners.example');
  await owner.getByRole('link', { name: 'Notifications' }).click();
  await expect(owner.getByRole('link', { name: /P&L — .* published/ }).first()).toBeVisible();
  await owner.getByRole('link', { name: /P&L — .* published/ }).first().click();
  await expect(owner.getByRole('heading', { level: 1 })).toHaveText(title!);
});

test('admin invites an owner who accepts and sees only the granted hotel; then access is revoked', async ({ page, browser }) => {
  const email = `e2e.owner.${Date.now()}@owners.example`;
  await login(page, 'admin@harborview.example');
  await page.getByRole('link', { name: 'Administration' }).click();
  await page.getByRole('tab', { name: 'Invitations' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Role').selectOption('owner');
  await page.getByLabel('Harborview Waikiki').check();
  await page.getByRole('button', { name: 'Send invitation' }).click();
  const link = await page.getByRole('link', { name: /accept-invite/ }).getAttribute('href');

  const invitee = await browser.newPage();
  await invitee.goto(link!);
  await invitee.getByLabel('Email').fill(email);
  await invitee.getByLabel('Password').fill('E2e-strong-pass-123');
  await invitee.getByRole('button', { name: 'Create account & accept' }).click();
  await expect(invitee.getByRole('link', { name: 'Harborview Waikiki' })).toBeVisible({ timeout: 20_000 });
  await expect(invitee.getByText('Harborview Seattle Waterfront')).toHaveCount(0);
  // Waikiki data is stale in the demo: freshness is flagged, not hidden.
  await expect(invitee.getByText(/Stale|Late/).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Users & access' }).click();
  await page.getByRole('row', { name: new RegExp(email.replace(/\./g, '\\.')) }).getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Revocation reason').fill('E2E test complete');
  await page.getByRole('button', { name: 'Revoke membership' }).click();

  await invitee.reload();
  await expect(invitee.getByText('No active access')).toBeVisible();
});

test('import upload with an invalid property is rejected with row-level issues', async ({ page }) => {
  await login(page, 'finance@harborview.example');
  await page.getByRole('link', { name: 'Data Imports' }).click();
  await page.getByRole('button', { name: 'Upload file' }).click();
  await page.getByLabel('Data file', { exact: true }).setInputFiles({
    name: 'bad-flash.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('property_code,business_date,rooms_sold,room_revenue\nSP-DEN,2026-01-05,100,10000\n'),
  });
  await page.getByRole('button', { name: 'Upload & validate' }).click();
  await expect(page.getByText('File received')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('link', { name: 'bad-flash.csv' }).click();
  await expect(page.locator('.page-header .badge')).toContainText('rejected', { timeout: 15_000 });
  await expect(page.getByText(/not mapped to a property of this company/)).toBeVisible();
});
