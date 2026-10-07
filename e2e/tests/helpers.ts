import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'DemoPass!2026';
export const HV = 'http://harborview.localhost:5173';
export const SP = 'http://summit.localhost:5173';

export async function login(page: Page, email: string, base = HV) {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).or(page.locator('aside.sidebar'))).toBeVisible();
}
