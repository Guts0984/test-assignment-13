import { expect, test } from '@playwright/test';

test('a seller creates a lot, sends it for review, and it shows in "My lots"', async ({ page }) => {
  await page.goto('/en/login');
  await page.fill('#email', 'seller1@seed.test');
  await page.fill('#password', 'Passw0rd!');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('whoami')).toContainText('seller1');
  await page.getByRole('link', { name: 'Sell' }).click();

  const title = `E2E lot ${Date.now()}`;
  await page.fill('#title', title);
  await page.fill('#description', 'Created by the e2e test');
  await page.fill('#startPrice', '1000000000000'); // absurdly large: must explain itself
  await page.getByRole('button', { name: 'Create lot' }).click();
  await expect(page.getByRole('alert').first()).toContainText(/too large|Maximum/);

  await page.fill('#startPrice', '250,50');
  await page.getByRole('button', { name: 'Create lot' }).click();
  await expect(page.getByRole('status')).toContainText(/Lot created/);
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('status')).toContainText(/Sent to a moderator/);
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.locator('li', { hasText: title })).toContainText('in_review');
});
