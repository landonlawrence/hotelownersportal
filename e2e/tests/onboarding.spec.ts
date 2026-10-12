import { expect, test } from '@playwright/test';
import { PASSWORD } from './helpers';

const BASE = 'http://localhost:5173';

test('platform admin provisions a company; its first admin gets a setup checklist with Administration locked behind 2FA', async ({ page, browser }) => {
  const stamp = Date.now();
  const adminEmail = `e2e.admin.${stamp}@newco.example`;

  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill('platform@portal.example');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Company name').fill(`E2E Hotels ${stamp}`);
  await expect(page.getByLabel('Short ID (slug)')).toHaveValue(`e2e-hotels-${stamp}`);
  await page.getByLabel('First admin’s email').fill(adminEmail);
  await page.getByRole('button', { name: 'Provision company' }).click();
  const link = await page.getByLabel('Invitation link').inputValue();
  expect(link).toContain('/accept-invite#token=');

  // The platform admin can reach their own 2FA settings without a company membership.
  await page.getByRole('link', { name: 'Account security' }).click();
  await expect(page.getByRole('button', { name: 'Set up authenticator app' })).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await admin.goto(link);
  await admin.getByLabel('Email').fill(adminEmail);
  await admin.getByLabel('Password').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Create account & accept' }).click();

  await expect(admin.getByRole('heading', { name: /ready$/ })).toBeVisible();
  await expect(admin.getByText('0 of 6 steps done')).toBeVisible();
  // Privileged sections are visible but locked until the session is verified with 2FA.
  const adminLink = admin.getByRole('link', { name: 'Administration' });
  await expect(adminLink).toHaveAttribute('href', '/security?next=%2Fadmin');
  await adminLink.click();
  await expect(admin.getByText('That section needs a session verified with two-factor authentication')).toBeVisible();

  // Property sections explain what to do instead of showing empty tables.
  await admin.getByRole('link', { name: 'Performance' }).click();
  await expect(admin.getByText('Add a hotel first')).toBeVisible();
});
