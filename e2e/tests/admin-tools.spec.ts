import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('company admin adds a property with opening inventory and changes its room count', async ({ page }) => {
  await login(page, 'admin@harborview.example');
  await page.getByRole('link', { name: 'Administration' }).click();
  await page.getByRole('tab', { name: 'Properties' }).click();
  await page.getByRole('button', { name: 'Add property' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Code (unique, e.g. HV-BOS)').fill('HV-AUS');
  await dialog.getByLabel('Name', { exact: true }).fill('Harborview Austin Lakeside');
  await dialog.getByLabel(/Time zone/).selectOption('America/Chicago');
  await dialog.getByLabel('Opened on').fill('2026-09-01');
  await dialog.getByLabel('Rooms at opening').fill('140');
  await dialog.getByRole('button', { name: 'Add property' }).click();
  const row = page.getByRole('row', { name: /Harborview Austin Lakeside/ });
  await expect(row).toContainText('140');

  await row.getByRole('button', { name: 'Room inventory' }).click();
  await page.getByRole('dialog').getByLabel('Effective from').fill('2026-10-01');
  await page.getByRole('dialog').getByLabel('Rooms', { exact: true }).fill('152');
  await page.getByRole('dialog').getByLabel('Reason').fill('Phase 2 rooms delivered');
  await page.getByRole('dialog').getByRole('button', { name: 'Save inventory change' }).click();
  await expect(row).toContainText('152');

  // New onboarding property does not make the portfolio "partial".
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible();
  await expect(page.getByText('Harborview Austin Lakeside')).toBeVisible();
});

test('ingestion manager adds an allowed sender and a property mapping', async ({ page }) => {
  await login(page, 'finance@harborview.example');
  await page.getByRole('link', { name: 'Data Imports' }).click();
  await page.getByRole('row', { name: /Nightly PMS flash/ }).getByRole('button', { name: 'Configure' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/reports\+[a-z0-9]+@inbound\.portal\.example/)).toBeVisible();
  await dialog.getByLabel('Allowed sender').fill('Backup@Harborview.example');
  await dialog.getByRole('button', { name: 'Add sender' }).click();
  await expect(dialog.getByText('backup@harborview.example')).toBeVisible();
  await dialog.getByLabel('Allowed sender').fill('not-an-email');
  await expect(dialog.getByRole('button', { name: 'Add sender' })).toBeDisabled();
  await dialog.getByLabel('External code').fill('SEA-ALT');
  await dialog.getByLabel('Property').selectOption({ label: 'Harborview Seattle Waterfront' });
  await dialog.getByRole('button', { name: 'Add mapping' }).click();
  await expect(dialog.getByRole('row', { name: /SEA-ALT/ })).toContainText('Harborview Seattle Waterfront');
});

test('owner downloads a branded statement PDF and turns off an email notification', async ({ page }) => {
  await login(page, 'olivia.owner@owners.example');
  await page.getByRole('link', { name: 'Budgets & Financials' }).click();
  await page.getByRole('link', { name: 'P&L — July 2026' }).first().click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  await page.getByRole('link', { name: 'Notifications' }).click();
  const toggle = page.getByLabel('Email: Owner report published');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.reload();
  await expect(page.getByLabel('Email: Owner report published')).not.toBeChecked();
});
