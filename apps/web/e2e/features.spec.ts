import { expect, test, type Page } from '@playwright/test';
import { pickLot, signIn } from './helpers';

const CSRF = { 'x-requested-with': 'auction-web' };

test.describe('registration', () => {
  test('a new account is created, signed in and sent to the wallet', async ({ page }) => {
    const email = `reg-${Date.now()}@e2e.test`;
    await page.goto('/en/register');
    await page.fill('#displayName', 'Newcomer');
    await page.fill('#email', email);
    await page.fill('#password', 'Passw0rd!');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/en\/wallet/);
    await expect(page.getByTestId('whoami')).toContainText('Newcomer');
    // Still signed in after a reload (a real session, not page state).
    await page.reload();
    await expect(page.getByTestId('whoami')).toContainText('Newcomer');
  });

  test('errors appear at the fields, in the viewer language', async ({ page }) => {
    await page.goto('/uk/register');
    await page.fill('#displayName', 'A');
    await page.fill('#email', 'not-an-email');
    await page.fill('#password', 'short');
    await page.keyboard.press('Enter');
    await expect(page.locator('#email-error')).toContainText('Вкажіть коректну пошту');
    await expect(page.locator('#password-error')).toContainText('щонайменше 8 символів');
    await expect(page.locator('#displayName-error')).toContainText("Вкажіть ім'я");

    await page.fill('#displayName', 'Taken');
    await page.fill('#email', 'buyer1@seed.test');
    await page.fill('#password', 'Passw0rd!');
    await page.keyboard.press('Enter');
    await expect(page.locator('#email-error')).toContainText('Ця пошта вже зареєстрована');
  });
});

test.describe('translated errors (uk)', () => {
  test('login form: no raw codes, no English validation text', async ({ page }) => {
    await page.goto('/uk/login');
    await page.fill('#email', 'abc');
    await page.keyboard.press('Enter');
    const alerts = page.locator('form [role=alert]');
    await expect(alerts.first()).toContainText('Вкажіть коректну пошту');
    await expect(alerts.nth(1)).toContainText('Введіть пароль');
    await expect(page.locator('form')).not.toContainText(/INVALID_EMAIL|Too small|Invalid/);
  });

  test('a locked account is told to try later, not "wrong password"', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'ACCOUNT_LOCKED', message: 'account temporarily locked' },
          requestId: 'x',
        }),
      }),
    );
    await page.goto('/uk/login');
    await page.fill('#email', 'buyer1@seed.test');
    await page.fill('#password', 'whatever');
    await page.keyboard.press('Enter');
    const alert = page.locator('form [role=alert]').last();
    await expect(alert).toContainText('Забагато невдалих спроб');
    await expect(alert).not.toContainText('Невірна пошта');
  });

  test('bid errors are translated and the minimum bid is formatted money', async ({
    browser,
    request,
  }) => {
    const lot = await pickLot(request);
    const a = await signIn(browser, 'buyer4@seed.test');
    const fail = async (code: string, meta?: Record<string, number>) => {
      await a.page.route('**/api/lots/*/bids', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                error: { code, message: `raw english ${code}`, meta },
                requestId: 'x',
              }),
            })
          : route.fallback(),
      );
      await a.page.locator('#amount').fill('9000');
      await a.page.keyboard.press('Enter');
    };
    await a.page.goto(`/uk/lots/${lot.id}`);
    const err = a.page.locator('#amount-error');
    await fail('BID_TOO_LOW', { minNextBid: 32500 });
    await expect(err).toContainText(/мінімум 325,00\s₴/);
    await fail('BID_NOT_ABOVE_OWN_MAX');
    await expect(err).toContainText('вищою за вашу попередню максимальну');
    await fail('LOT_NOT_ACTIVE');
    await expect(err).toContainText('не приймає ставок');
    await expect(err).not.toContainText(/raw english|bid not|lot not/i);
    await fail('SOMETHING_NEW');
    await expect(err).toContainText('Щось пішло не так');
    await a.ctx.close();
  });

  test('bid count uses plural forms, days are localised, wallet kinds and dates are translated', async ({
    browser,
    request,
  }) => {
    const res = await request.get('/api/search?sort=newest&pageSize=100');
    const items = ((await res.json()) as { items: { id: string; ends_at: number }[] }).items;
    const far = items.find((l) => l.ends_at > Date.now() / 1000 + 2 * 86400);
    if (!far) throw new Error('no lot ending in 2+ days');
    const a = await signIn(browser, 'buyer1@seed.test');
    await a.page.goto(`/uk/lots/${far.id}`);
    await expect(a.page.getByTestId('bid-count')).toHaveText(/^\d+ (ставка|ставки|ставок)$/);
    await expect(a.page.getByTestId('time-left')).toHaveText(/^\d+ д \d\d:\d\d:\d\d$/);
    await a.page.goto(`/pl/lots/${far.id}`);
    await expect(a.page.getByTestId('bid-count')).toHaveText(/^\d+ (oferta|oferty|ofert)$/);
    await a.page.goto('/uk/wallet');
    const rows = a.page.locator('ul.divide-y li');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().locator('time')).toHaveAttribute('datetime', /^\d{4}-/);
    const text = (await rows.allTextContents()).join(' ');
    expect(text).not.toMatch(/\b(hold|sale|release|topup|payout)\b/);
    expect(text).toMatch(/Застава|Повернення застави|Поповнення|Продаж|Оплата/);
    await a.ctx.close();
  });
});

test.describe('favourites', () => {
  test('the heart toggles, persists, and the lot shows on the favourites page', async ({
    browser,
    request,
  }) => {
    const lot = await pickLot(request);
    const a = await signIn(browser, 'buyer3@seed.test');
    await a.page.goto(`/en/lots/${lot.id}`);
    const heart = a.page.getByRole('button', { name: /favourites/ });
    await expect(heart).toBeVisible();
    // Start from "not a favourite", whatever earlier runs left behind.
    if ((await heart.getAttribute('aria-pressed')) === 'true') await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'false');

    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'true');
    await a.page.reload();
    await expect(a.page.getByRole('button', { name: /favourites/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await a.page.goto('/en/favorites');
    await expect(
      a.page.locator(`[data-testid=favorites] a[href$="/lots/${lot.id}"]`),
    ).toBeVisible();

    await a.page.goto(`/en/lots/${lot.id}`);
    await a.page.getByRole('button', { name: /favourites/ }).click();
    await expect(a.page.getByRole('button', { name: /favourites/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await a.page.goto('/en/favorites');
    await expect(a.page.locator(`[data-testid=favorites] a[href$="/lots/${lot.id}"]`)).toHaveCount(
      0,
    );
    await a.ctx.close();
  });
});

test.describe('notifications', () => {
  test('an outbid user sees the bell count and the message without reloading', async ({
    browser,
    request,
  }) => {
    const lot = await pickLot(request);
    const a = await signIn(browser, 'buyer5@seed.test');
    const b = await signIn(browser, 'buyer2@seed.test');
    await a.ctx.request.post('/api/me/notifications/read', { headers: CSRF });
    await a.page.goto(`/en/lots/${lot.id}`);
    await expect(a.page.getByText(/Live updates/)).toBeVisible();
    await expect(a.page.getByTestId('whoami')).toBeVisible();
    await expect(a.page.getByTestId('unread-count')).toHaveCount(0);
    await a.page.waitForTimeout(500); // let the private socket finish connecting

    const bid = (who: typeof a, amount: number) =>
      who.ctx.request.post(`/api/lots/${lot.id}/bids`, {
        headers: { ...CSRF, 'Idempotency-Key': crypto.randomUUID() },
        data: { kind: 'manual', amount },
      });
    const first = await bid(a, lot.price * 4 + 120_000);
    expect(first.ok()).toBe(true);
    const second = await bid(b, lot.price * 8 + 300_000);
    expect(second.ok()).toBe(true);

    // No navigation, no reload: the header bell learns about it through the socket.
    await expect(a.page.getByTestId('unread-count')).toBeVisible({ timeout: 5000 });
    await a.page.getByRole('link', { name: /Notifications, unread/ }).click();
    const outbid = a.page.locator('[data-testid=notifications] li[data-unread]').first();
    await expect(outbid).toContainText(/You were outbid on/);
    await a.page.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(a.page.getByTestId('unread-count')).toHaveCount(0);
    await a.ctx.close();
    await b.ctx.close();
  });

  test('notification texts follow the language', async ({ browser, request }) => {
    // Create the notification ourselves: buyer1 bids, buyer3 outbids, so buyer1 has an "outbid" message.
    const lot = await pickLot(request);
    const a = await signIn(browser, 'buyer5@seed.test');
    const b = await signIn(browser, 'buyer2@seed.test');
    const bid = (ctx: typeof a.ctx, amount: number) =>
      ctx.request.post(`/api/lots/${lot.id}/bids`, {
        data: { kind: 'manual', amount },
        headers: { ...CSRF, 'Idempotency-Key': crypto.randomUUID() },
      });
    expect((await bid(a.ctx, lot.price * 20 + 1_000_000)).status()).toBe(200);
    expect((await bid(b.ctx, lot.price * 40 + 2_000_000)).status()).toBe(200);
    await a.page.goto('/uk/notifications');
    await expect(a.page.locator('[data-testid=notifications] li').first()).toBeVisible();
    const text = await a.page.locator('[data-testid=notifications]').innerText();
    expect(text).not.toMatch(/\b(outbid|lot_removed|topup_succeeded)\b/);
    await a.ctx.close();
    await b.ctx.close();
  });
});

const prices = async (page: Page): Promise<number[]> =>
  (await page.locator('ul li p:not(.text-sm)').allTextContents()).map((p) =>
    Number(p.replace(/[^0-9.]/g, '')),
  );

test.describe('search state', () => {
  test('focusing the search box and tabbing away changes nothing: same page, same history', async ({
    page,
  }) => {
    await page.goto('/en?sort=newest&page=3');
    await expect(page.locator('section p.mb-3').first()).toContainText(/Found/);
    const before = await page.evaluate(() => history.length);
    await page.locator('#q').focus();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    expect(page.url()).toMatch(/page=3/);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('a real change of the query keeps other params and resets the page', async ({ page }) => {
    await page.goto('/en?sort=newest&page=3');
    await page.locator('#q').fill('phone');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/q=phone/);
    expect(page.url()).toMatch(/sort=newest/);
    expect(page.url()).not.toMatch(/page=3/);
  });

  test('invalid URL params say so, and the pager buttons have names', async ({ page }) => {
    await page.goto('/en?page=abc&sort=bogus');
    await expect(page.getByTestId('invalid-params')).toContainText(/invalid/i);
    await page.goto('/uk?priceMin=-5');
    await expect(page.getByTestId('invalid-params')).toContainText('Некоректні параметри');
    await page.goto('/en');
    await expect(page.getByRole('button', { name: 'Next page' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  test('city, condition and price range filter the results and live in the URL; the language switch keeps them', async ({
    page,
  }) => {
    await page.goto('/en');
    await expect(page.getByLabel('Price from, ₴')).toBeVisible();
    const city = page.locator('fieldset', { hasText: 'City' }).locator('input').first();
    await expect(city).toBeVisible();
    await city.click({ noWaitAfter: true });
    await expect(page).toHaveURL(/city=\d+/);
    const cond = page.locator('fieldset', { hasText: 'Condition' }).locator('input').first();
    await cond.click({ noWaitAfter: true });
    await expect(page).toHaveURL(/condition=[a-z_]+/);

    await page.getByLabel('Price from, ₴').fill('100');
    await page.getByLabel('Price to, ₴').fill('5000');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/priceMin=10000/);
    expect(page.url()).toMatch(/priceMax=500000/);
    await expect(page.locator('section p.mb-3').first()).toContainText(/Found: \d+/);
    const nums = await prices(page);
    expect(nums.length).toBeGreaterThan(0);
    for (const n of nums) {
      expect(n).toBeGreaterThanOrEqual(100);
      expect(n).toBeLessThanOrEqual(5000);
    }
    const query = new URL(page.url()).search;

    await page.getByRole('link', { name: 'PL' }).click();
    await expect(page).toHaveURL(/\/pl\?/);
    expect(new URL(page.url()).search).toBe(query);
    await expect(page.getByText(/Znaleziono: \d+/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#priceMin')).toHaveValue('100');
    await expect(
      page.locator('fieldset', { hasText: 'Miasto' }).locator('input:checked'),
    ).toHaveCount(1);
  });

  test('a bad price range explains itself and does not change the URL', async ({ page }) => {
    await page.goto('/en');
    await page.getByLabel('Price from, ₴').fill('abc');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#price-error')).toContainText(/digits/);
    await page.getByLabel('Price from, ₴').fill('900');
    await page.getByLabel('Price to, ₴').fill('100');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#price-error')).toContainText(/cannot be above/);
    expect(page.url()).not.toMatch(/price/);
  });
});

test('the countdown on a lot page moves', async ({ request, page }) => {
  const lot = await pickLot(request);
  await page.goto(`/en/lots/${lot.id}`);
  const left = page.getByTestId('time-left');
  await expect(left).toHaveText(/\d\d:\d\d:\d\d/);
  const first = await left.textContent();
  await page.waitForTimeout(3000);
  const later = await left.textContent();
  expect(later).not.toBe(first);
});
