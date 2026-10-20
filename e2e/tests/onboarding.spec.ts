import { expect, test } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { PASSWORD } from './helpers';

const BASE = 'http://localhost:5173';

test('platform admin provisions a company; its first admin gets a setup checklist with Administration locked behind 2FA', async ({ page, browser }) => {
  const stamp = Date.now();
  const adminEmail = `e2e.admin.${stamp}@newco.example`;

  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill('platform@portal.example');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Platform admins land in the operator console; changes need a 2FA-verified session.
  await expect(page).toHaveURL(/\/platform$/);
  await expect(page.getByText('You’re signed in with a password only.')).toBeVisible();
  await page.getByRole('navigation', { name: 'Platform navigation' }).getByRole('link', { name: 'Account security' }).click();
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  await page.getByText('Can’t scan? Enter this key manually').click();
  const secret = (await page.locator('code.secret').textContent())!.trim();
  await page.getByLabel('Authenticator code').fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate());
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('This session is verified')).toBeVisible();

  // Onboarding wizard: company → branding → hotels → access → review.
  await page.getByRole('navigation', { name: 'Platform navigation' }).getByRole('link', { name: 'Onboard a company' }).click();
  await page.getByLabel('Company name').fill(`E2E Hotels ${stamp}`);
  await expect(page.getByLabel('Short ID', { exact: true })).toHaveValue(`e2e-hotels-${stamp}`);
  await page.getByRole('button', { name: 'Continue to branding' }).click();
  await expect(page.getByRole('figure', { name: 'Preview of the company sign-in page' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to hotels' }).click();
  await page.getByRole('button', { name: 'Continue to access' }).click();
  await page.getByLabel('Administrator 1 email').fill(adminEmail);
  await page.getByRole('button', { name: 'Continue to review' }).click();
  await page.getByRole('button', { name: `Create E2E Hotels ${stamp}` }).click();
  const link = await page.getByLabel(`Invitation link for ${adminEmail}`).inputValue();
  expect(link).toContain('/accept-invite#token=');

  // The new company is listed, waiting for its admin.
  await page.getByRole('navigation', { name: 'Platform navigation' }).getByRole('link', { name: 'Companies' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`E2E Hotels ${stamp}.*Waiting for admin`) })).toBeVisible();

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
