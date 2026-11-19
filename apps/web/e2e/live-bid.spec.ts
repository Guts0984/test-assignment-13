import { expect, test } from '@playwright/test';
import { pickLot, signIn } from './helpers';

test('two browsers on one lot: a bid in the first updates price and bid count in the second without a reload', async ({
  browser,
  request,
}) => {
  const lot = await pickLot(request);
  const a = await signIn(browser, 'buyer1@seed.test');
  const b = await signIn(browser, 'buyer2@seed.test');
  await a.page.goto(`/en/lots/${lot.id}`);
  await b.page.goto(`/en/lots/${lot.id}`);
  await expect(b.page.getByTestId('price')).toBeVisible();
  const before = await b.page.getByTestId('price').textContent();
  const countBefore = Number(await b.page.getByTestId('bid-count').textContent());

  // The second browser must be live (socket connected) before the bid is placed.
  await expect(b.page.getByText(/Live updates/)).toBeVisible();

  const minimum = lot.price * 4 + 50_000; // far above any leftover autobid from earlier runs
  await a.page.locator('#amount').fill(String(minimum / 100));
  await a.page.getByRole('button', { name: 'Place bid' }).click();
  await expect(a.page.getByRole('status')).toContainText(/leading/i);

  // Acceptance: the other client sees it in under a second, with no navigation.
  await expect(b.page.getByTestId('price')).not.toHaveText(before ?? '', { timeout: 1500 });
  // An autobid answering the bid adds a second row, so assert "went up" rather than an exact number.
  await expect
    .poll(async () => Number(await b.page.getByTestId('bid-count').textContent()))
    .toBeGreaterThan(countBefore);
  expect(b.page.url()).toContain(`/lots/${lot.id}`);
  await a.ctx.close();
  await b.ctx.close();
});

test('a bid from the keyboard only: tab to the amount, type, press Enter', async ({
  browser,
  request,
}) => {
  const lot = await pickLot(request);
  const a = await signIn(browser, 'buyer3@seed.test');
  await a.page.goto(`/en/lots/${lot.id}`);
  await a.page.locator('#amount').focus();
  await a.page.keyboard.type(String((lot.price * 4 + 70_000) / 100));
  await a.page.keyboard.press('Enter');
  await expect(a.page.getByRole('status')).toContainText(/leading/i);
  await a.ctx.close();
});

test('bad bid amounts explain themselves in words, never "something went wrong"', async ({
  browser,
  request,
}) => {
  const lot = await pickLot(request);
  const a = await signIn(browser, 'buyer4@seed.test');
  await a.page.goto(`/en/lots/${lot.id}`);
  for (const [typed, message] of [
    ['abc', /Enter the amount in digits/],
    ['0', /must be above zero/],
    ['10.123', /at most two decimals/],
    ['999999999999999', /too large/],
  ] as const) {
    await a.page.locator('#amount').fill(typed);
    await a.page.keyboard.press('Enter');
    await expect(a.page.locator('#amount-error')).toContainText(message);
    await expect(a.page.locator('#amount-error')).not.toContainText(/went wrong/i);
  }
  await a.ctx.close();
});
