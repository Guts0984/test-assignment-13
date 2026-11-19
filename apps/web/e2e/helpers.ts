import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
} from '@playwright/test';

export const signIn = async (
  browser: Browser,
  email: string,
): Promise<{ ctx: BrowserContext; page: Page }> => {
  const ctx = await browser.newContext();
  const res = await ctx.request.post('/api/auth/login', {
    data: { email, password: 'Passw0rd!' },
    headers: { 'x-requested-with': 'auction-web' },
  });
  expect(res.status()).toBe(200);
  return { ctx, page: await ctx.newPage() };
};

/** A running lot that still has hours left (so the test is not racing the clock), with no reserve surprises. */
export const pickLot = async (
  request: APIRequestContext,
): Promise<{ id: string; price: number }> => {
  const res = await request.get('/api/search?sort=newest&pageSize=100');
  const items = (await res.json()) as {
    items: { id: string; current_price: number; ends_at: number }[];
  };
  const soon = Date.now() / 1000 + 6 * 3600;
  const lot = items.items.find((l) => l.ends_at > soon && l.current_price < 200_000);
  if (!lot) throw new Error('no suitable lot in the seed');
  return { id: lot.id, price: lot.current_price };
};

export const uah = (kopecks: number): string => (kopecks / 100).toFixed(2).replace('.', ',');
