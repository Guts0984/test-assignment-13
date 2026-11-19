import { expect, test } from '@playwright/test';

test('sign in shows who you are, a second visit to the login page says you are signed in, sign out works', async ({
  page,
}) => {
  await page.goto('/en/login');
  await page.fill('#email', 'buyer1@seed.test');
  await page.fill('#password', 'Passw0rd!');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/en\/wallet/);
  await expect(page.getByTestId('whoami')).toContainText('buyer1');

  await page.goto('/en/login');
  await expect(page.getByRole('status')).toContainText(/already signed in as buyer1/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('whoami')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('a wrong password shows a message at the form, not a crash', async ({ page }) => {
  await page.goto('/en/login');
  await page.fill('#email', 'buyer1@seed.test');
  await page.fill('#password', 'wrong-password');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('alert').filter({ hasText: /wrong email or password/i }),
  ).toBeVisible();
});

test('a moderator lands on the moderation page and can take a lot from the queue', async ({
  page,
}) => {
  await page.goto('/en/login');
  await page.fill('#email', 'moderator1@seed.test');
  await page.fill('#password', 'Passw0rd!');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/en\/moderation/);
  await page.getByRole('button', { name: 'Take next lot' }).click();
  await expect(page.locator('article h2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeDisabled(); // a reason is required
});

test('wallet: balance is shown; a top-up above the limit explains itself', async ({ page }) => {
  await page.goto('/en/login');
  await page.fill('#email', 'buyer2@seed.test');
  await page.fill('#password', 'Passw0rd!');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/wallet/);
  await expect(page.locator('dl')).toContainText('₴');
  await page.fill('#topup', '2000000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').first()).toContainText(/Maximum top-up is/);
  for (const [typed, message] of [
    ['99999999999', /Maximum top-up is/],
    ['abc', /Enter the amount in digits/],
    ['0', /Minimum top-up is/],
    ['10.123', /at most two decimals/],
  ] as const) {
    await page.fill('#topup', typed);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert').first()).toContainText(message);
    await expect(page.getByRole('alert').first()).not.toContainText(/went wrong/i);
  }
});
