import { expect, test } from '@playwright/test';
import { login } from './helpers';

const SFO = '20000000-0000-4000-8000-000000000103';

test.describe('owner authorized for two hotels cannot reach a third (UI)', () => {
  test('third hotel never appears and direct URLs show no data', async ({ page }) => {
    await login(page, 'olivia.owner@owners.example');
    await expect(page.getByRole('link', { name: 'Harborview Seattle Waterfront', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Harborview Portland Pearl', exact: true })).toBeVisible();
    await expect(page.getByText('Embarcadero')).toHaveCount(0);

    await page.goto(`/properties/${SFO}`);
    await expect(page.getByText('Property not found')).toBeVisible();
    await expect(page.getByText('Embarcadero')).toHaveCount(0);

    await page.goto('/documents');
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'HV-SFO' })).toHaveCount(0);
    await expect(page.getByText('Loan agreement')).toHaveCount(0); // confidential

    await page.goto('/financials');
    await expect(page.getByRole('cell', { name: 'Embarcadero Inn by Harborview' })).toHaveCount(0);

    await page.goto('/capex');
    await expect(page.getByText('Elevator modernization')).toHaveCount(0);

    // Property picker never offers the third hotel.
    await page.goto('/');
    await page.locator('button[aria-haspopup="listbox"]').click();
    await expect(page.getByRole('listbox')).not.toContainText('Embarcadero');
  });
});
