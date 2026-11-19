import { expect, test } from '@playwright/test';

const signIn = async (page: import('@playwright/test').Page, email: string) => {
  await page.goto('/en/login');
  await page.fill('#email', email);
  await page.fill('#password', 'Passw0rd!');
  await page.keyboard.press('Enter');
};

test('finance sees turnover, commission, the unpaid share, a category table and the reconciliation result', async ({
  page,
}) => {
  await signIn(page, 'finance1@seed.test');
  await expect(page).toHaveURL(/\/en\/finance/);
  await expect(page.getByTestId('fin-turnover')).toContainText('₴');
  await expect(page.getByTestId('fin-commission')).toContainText('₴');
  await expect(page.getByTestId('fin-unpaid')).toContainText('%');
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('recon')).toContainText(/No discrepancies/);
  // The period is in the URL and survives a reload.
  await page.fill('#from', '2026-01-01');
  await expect(page).toHaveURL(/from=2026-01-01/);
  await page.reload();
  await expect(page.locator('#from')).toHaveValue('2026-01-01');
});

test('finance cannot see the wallet or sell; the nav only offers what the role can do', async ({
  page,
}) => {
  await signIn(page, 'finance1@seed.test');
  await expect(page.getByRole('link', { name: 'Wallet' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sell' })).toHaveCount(0);
});

test('moderator can take down a published lot from its page, with a reason', async ({
  page,
  request,
}) => {
  const res = await request.get('/api/search?sort=newest&pageSize=20');
  const lot = ((await res.json()) as { items: { id: string; ends_at: number }[] }).items.find(
    (l) => l.ends_at > Date.now() / 1000 + 6 * 3600,
  );
  await signIn(page, 'moderator1@seed.test');
  await expect(page).toHaveURL(/moderation/);
  await page.goto(`/en/lots/${lot?.id}`);
  const remove = page.getByRole('button', { name: 'Remove lot' });
  await expect(remove).toBeDisabled();
  await page.fill('#why', 'Prohibited item (e2e)');
  await remove.click();
  await expect(page.getByRole('status').filter({ hasText: 'Lot removed' })).toBeVisible();
});
