import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infra, newTestDb, type TestDb } from '@auction/test-kit';
import { createMeili, ensureIndex } from '@auction/platform';
import type { z } from 'zod';
import { startApp, type RunningApp } from '../src/app.js';
import {
  financeReportSchema,
  moderationLotSchema,
  myBidsSchema,
  myFavoritesSchema,
  myLotsSchema,
  myNotificationsSchema,
  myWinsSchema,
  reconciliationSchema,
} from '../src/common/responses.js';
import { UAH, fund, loginAs, makeLot, register, testApiConfig } from './support.js';

let t: TestDb;
let app: RunningApp;
beforeAll(async () => {
  t = await newTestDb(60);
  await ensureIndex(createMeili(infra.meiliUrl, infra.meiliKey));
  app = await startApp(testApiConfig(t), 0);
});
afterAll(async () => {
  await app.close();
  await t.close();
});

/** Valid AND complete: a field the handler returns but the schema forgot would be stripped and differ. */
const matches = (schema: z.ZodType, body: unknown) => {
  const parsed = schema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(parsed.data).toEqual(body);
};

describe('response schemas describe what the handlers really return', () => {
  it('GET /me/bids, /me/lots, /me/wins, /me/favorites, /me/notifications', async () => {
    const seller = await register(app, 'sellerR');
    const buyer = await register(app, 'buyerR');
    await fund(t.pool, buyer.id, UAH(5000));
    const lot = await makeLot(t.pool, { sellerId: seller.id, reservePrice: UAH(500) });
    const won = await makeLot(t.pool, { sellerId: seller.id });
    await t.pool.query(
      `UPDATE lots SET status = 'awaiting_payment', buyer_id = $2, final_price = $3, sold_at = now(), payment_due_at = now() + interval '1 day' WHERE id = $1`,
      [won, buyer.id, UAH(120)],
    );
    expect(
      (
        await buyer.c.call('POST', `/lots/${lot}/bids`, {
          body: { kind: 'manual', amount: UAH(150) },
          idem: randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect((await buyer.c.call('PUT', `/me/favorites/${lot}`)).status).toBeLessThan(300);
    await t.pool.query(
      `INSERT INTO notifications (user_id, kind, payload) VALUES ($1, 'outbid', '{"lotId":"x"}')`,
      [buyer.id],
    );

    const bids = await buyer.c.call('GET', '/me/bids');
    expect(bids.body.length).toBeGreaterThan(0);
    matches(myBidsSchema, bids.body);
    const wins = await buyer.c.call('GET', '/me/wins');
    expect(wins.body.length).toBe(1);
    matches(myWinsSchema, wins.body);
    const favs = await buyer.c.call('GET', '/me/favorites');
    expect(favs.body.length).toBe(1);
    matches(myFavoritesSchema, favs.body);
    const notes = await buyer.c.call('GET', '/me/notifications');
    expect(notes.body.length).toBeGreaterThan(0);
    matches(myNotificationsSchema, notes.body);
    const lots = await seller.c.call('GET', '/me/lots');
    expect(lots.body.items.length).toBe(2);
    matches(myLotsSchema, lots.body);
  });

  it('GET /moderation/lots/{id}, /finance/report, /finance/reconciliation', async () => {
    const seller = await register(app, 'sellerM');
    const review = await makeLot(t.pool, { sellerId: seller.id, status: 'in_review' });
    await t.pool.query(
      `INSERT INTO lot_photos (lot_id, position, key, preview_key, content_type, size_bytes, status)
       VALUES ($1, 0, 'k/a.jpg', 'k/a-p.jpg', 'image/jpeg', 100, 'ready'), ($1, 1, 'k/b.jpg', 'k/b-p.jpg', 'image/jpeg', 100, 'ready')`,
      [review],
    );
    const mod = await loginAs(app, t, 'moderator');
    expect((await mod.c.call('POST', '/moderation/claim', { body: {} })).status).toBe(200);
    const view = await mod.c.call('GET', `/moderation/lots/${review}`);
    expect(view.status).toBe(200);
    expect(view.body.photos).toHaveLength(2);
    matches(moderationLotSchema, view.body);

    const paid = await makeLot(t.pool, { sellerId: seller.id });
    await t.pool.query(
      `UPDATE lots SET status = 'awaiting_payment', buyer_id = $3, final_price = $2, sold_at = now(), payment_due_at = now() + interval '1 day' WHERE id = $1`,
      [paid, UAH(300), (await register(app, 'buyerM')).id],
    );
    await t.pool.query(`UPDATE lots SET status = 'paid', paid_at = now() WHERE id = $1`, [paid]);
    const fin = await loginAs(app, t, 'finance');
    const day = new Date().toISOString().slice(0, 10);
    const report = await fin.c.call('GET', `/finance/report?from=${day}&to=${day}`);
    expect(report.status).toBe(200);
    expect(report.body.byCategory.length).toBeGreaterThan(0);
    matches(financeReportSchema, report.body);
    const rec = await fin.c.call('GET', '/finance/reconciliation');
    expect(rec.status).toBe(200);
    matches(reconciliationSchema, rec.body);
  });

  it('the schemas are not vacuous: a drifted body is rejected', () => {
    expect(myBidsSchema.safeParse([{ id: 1 }]).success).toBe(false);
    expect(myLotsSchema.safeParse([]).success).toBe(false);
    expect(reconciliationSchema.safeParse({}).success).toBe(false);
  });
});
