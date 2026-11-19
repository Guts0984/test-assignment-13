import { expect, test, type Page } from '@playwright/test';

const found = (page: Page) => page.locator('section p.mb-3').first();

test('category filter returns only that category, survives reload, and Back steps through the filter changes', async ({
  page,
}) => {
  await page.goto('/en');
  const boxes = page.locator('fieldset input[type=checkbox]');
  await expect(boxes.first()).toBeVisible();
  const click = async (i: number) => boxes.nth(i).click({ noWaitAfter: true });

  await click(0);
  await expect(page).toHaveURL(/category=1$/);
  await expect(found(page)).toContainText(/Found: \d+/);
  const one = await found(page).textContent();

  // Every card on screen belongs to the chosen category (the card shows its category name).
  const names = await page.locator('ul li p.text-gray-500').allTextContents();
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names).size).toBe(1);

  await click(1);
  await expect(page).toHaveURL(/category=1%2C2/);
  await expect(found(page)).not.toHaveText(one ?? '');

  await page.reload();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();

  await page.goBack();
  await expect(page).toHaveURL(/category=1$/);
  await expect(found(page)).toHaveText(one ?? '');
});

test('sort and "no bids" live in the URL', async ({ page }) => {
  await page.goto('/en?sort=price_asc&noBids=true');
  await expect(page.getByLabel('Sort')).toHaveValue('price_asc');
  await expect(page.getByLabel('No bids')).toBeChecked();
  const prices = await page.locator('ul li p:not(.text-sm)').allTextContents();
  const nums = prices.map((p) => Number(p.replace(/[^0-9.]/g, '')));
  expect(nums).toEqual([...nums].sort((a, b) => a - b));
});

test('the same search renders in each language with its own wording and money format', async ({
  page,
}) => {
  await page.goto('/uk');
  await expect(page.getByText(/Знайдено: \d+/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('ul li').first()).toContainText('₴');
  await page.goto('/pl');
  await expect(page.getByText(/Znaleziono: \d+/)).toBeVisible({ timeout: 15_000 });
  await page.goto('/en');
  await expect(page.getByText(/Found: \d+/)).toBeVisible({ timeout: 15_000 });
});
