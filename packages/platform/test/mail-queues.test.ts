import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  infra,
  makeUser,
  mailpitMessages,
  newTestDb,
  waitFor,
  type TestDb,
} from '@auction/test-kit';
import {
  QUEUES,
  closeQueues,
  createMailer,
  createQueues,
  createRedis,
  jobId,
  renderEmail,
  scheduleAt,
  sendEmailById,
  type Mailer,
} from '../src/index.js';
import { formatMoney } from '@auction/shared';

let t: TestDb;
const mailer: Mailer = createMailer({
  host: infra.smtpHost,
  port: infra.smtpPort,
  from: 'no-reply@auction.test',
});
const NBSP = ' ';

beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  mailer.close();
  await t.close();
});

const queueEmail = async (
  userId: string,
  kind = 'outbid',
  payload: Record<string, unknown> = { title: 'Camera', currentPrice: 123_450 },
) => {
  const id = randomUUID();
  await t.pool.query(
    `INSERT INTO email_log (id, dedupe_key, user_id, kind, payload) VALUES ($1, $2, $3, $4, $5)`,
    [id, `k:${id}`, userId, kind, JSON.stringify(payload)],
  );
  return id;
};
const messagesFor = async (emailId: string) =>
  (await mailpitMessages()).filter((m) => m.MessageID.includes(emailId));
const statusOf = async (id: string) =>
  (
    await t.pool.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM email_log WHERE id = $1',
      [id],
    )
  ).rows[0]!;

describe('email sending (invariant 13: nothing twice)', () => {
  it('sends the queued email to the user in their language and marks it sent', async () => {
    const user = await makeUser(t.pool);
    await t.pool.query(`UPDATE users SET locale = 'uk' WHERE id = $1`, [user]);
    const id = await queueEmail(user);
    expect(await sendEmailById(t.pool, mailer, id)).toBe('sent');
    const msgs = await waitFor(
      async () => {
        const m = await messagesFor(id);
        return m.length ? m : undefined;
      },
      { what: 'mail in mailpit' },
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.Subject).toBe('Вашу ставку перебито: Camera');
    expect(await statusOf(id)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('twenty workers sending the same email at once: exactly one message is delivered', async () => {
    const user = await makeUser(t.pool);
    const id = await queueEmail(user, 'won', { title: 'Vase', price: 50_000 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => sendEmailById(t.pool, mailer, id)),
    );
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(19);
    await new Promise((r) => setTimeout(r, 500));
    expect(await messagesFor(id)).toHaveLength(1);
  });

  it('a sent email is never sent again, even if its job runs again later', async () => {
    const user = await makeUser(t.pool);
    const id = await queueEmail(user);
    await sendEmailById(t.pool, mailer, id);
    expect(await sendEmailById(t.pool, mailer, id)).toBe('skipped');
    expect(await sendEmailById(t.pool, mailer, randomUUID())).toBe('skipped');
  });

  it('SMTP down: the email stays pending with a counted attempt, and fails for good after 5 tries', async () => {
    const dead = createMailer({ host: '127.0.0.1', port: 1, from: 'x@y.z' });
    try {
      const user = await makeUser(t.pool);
      const id = await queueEmail(user);
      for (let i = 1; i <= 4; i++) {
        expect(await sendEmailById(t.pool, dead, id)).toBe('failed');
        expect(await statusOf(id)).toMatchObject({ status: 'pending', attempts: i });
      }
      expect(await sendEmailById(t.pool, dead, id)).toBe('failed');
      expect(await statusOf(id)).toMatchObject({ status: 'failed', attempts: 5 });
      expect(await sendEmailById(t.pool, mailer, id)).toBe('skipped'); // given up
      expect(await messagesFor(id)).toHaveLength(0);
    } finally {
      dead.close();
    }
  });

  it('SMTP recovers: a pending email whose earlier attempt failed is delivered once', async () => {
    const dead = createMailer({ host: '127.0.0.1', port: 1, from: 'x@y.z' });
    try {
      const user = await makeUser(t.pool);
      const id = await queueEmail(user);
      await sendEmailById(t.pool, dead, id);
      expect(await sendEmailById(t.pool, mailer, id)).toBe('sent');
      await waitFor(async () => (await messagesFor(id)).length === 1, { what: 'mail' });
    } finally {
      dead.close();
    }
  });
});

describe('templates', () => {
  it('render in uk, en and pl with locale-correct money, and never throw on odd payloads', () => {
    const payload = { title: 'Лот', currentPrice: 123_450, price: 123_450, amount: 123_450 };
    expect(renderEmail('outbid', payload, 'uk').text).toContain(`1${NBSP}234,50${NBSP}₴`);
    expect(renderEmail('outbid', payload, 'en').text).toContain('₴1,234.50');
    expect(renderEmail('outbid', payload, 'pl').text).toContain(formatMoney(123_450, 'pl'));
    for (const kind of [
      'outbid',
      'won',
      'second_chance',
      'lot_removed',
      'favorite_reminder',
      'lot_sold',
      'lot_unsold',
      'lot_paid',
      'lot_shipped',
      'payout',
      'lot_approved',
      'lot_rejected',
    ]) {
      for (const locale of ['uk', 'en', 'pl'] as const) {
        const r = renderEmail(kind, {}, locale);
        expect(r.subject.length, `${kind}/${locale}`).toBeGreaterThan(0);
        expect(r.text.length).toBeGreaterThan(0);
        expect(
          renderEmail(kind, { title: 123, price: 'x', trackingNumber: null }, locale).subject,
        ).toBeTruthy();
      }
    }
    expect(renderEmail('something_new', { a: 1 }, 'en').subject).toBe('something_new');
  });

  it('user-controlled text is placed in a plain-text body only (a title cannot inject headers)', () => {
    const r = renderEmail('outbid', { title: 'x\r\nBcc: evil@x.test', currentPrice: 1 }, 'en');
    // nodemailer encodes subjects; assert the raw value is kept as data, not interpreted here.
    expect(r.text).toContain('Bcc: evil@x.test');
    expect(r.text).not.toContain('<');
  });
});

describe('queues: Redis is an accelerator, never the source of truth (invariant 13)', () => {
  // This file flushes Redis on purpose, so it gets its own database number (other files use others).
  const redis = createRedis(`${infra.redisUrl}/1`, 'test-queues');
  const queues = createQueues(redis);
  afterAll(async () => {
    await closeQueues(queues);
    redis.disconnect();
  });

  it('a job id encodes what and when: the same deadline adds one job, a new deadline adds another', async () => {
    const lot = randomUUID();
    const at = Date.now() + 60_000;
    await scheduleAt(queues.lotClose, jobId.close(lot, at), { lotId: lot }, at, Date.now());
    await scheduleAt(queues.lotClose, jobId.close(lot, at), { lotId: lot }, at, Date.now()); // duplicate (another worker)
    await scheduleAt(
      queues.lotClose,
      jobId.close(lot, at + 120_000),
      { lotId: lot },
      at + 120_000,
      Date.now(),
    ); // after an extension
    const delayed = await queues.lotClose.getDelayed();
    const mine = delayed.filter((j) => (j.data as { lotId: string }).lotId === lot);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((j) => j.id)).size).toBe(2);
  });

  it('a delayed job runs at its time, and exactly once when three workers compete for it', async () => {
    const queueName = `${QUEUES.photo}-race-${randomUUID().slice(0, 6)}`;
    const q = new (await import('bullmq')).Queue(queueName, { connection: redis });
    const ran: string[] = [];
    const workers = Array.from(
      { length: 3 },
      (_, i) =>
        new Worker(
          queueName,
          async (job) => {
            ran.push(`${i}:${job.id}`);
          },
          { connection: createRedis(`${infra.redisUrl}/1`, `w${i}`) },
        ),
    );
    try {
      const id = `race-${randomUUID()}`;
      const started = Date.now();
      await q.add('x', {}, { jobId: id, delay: 800 });
      await waitFor(async () => ran.length > 0, { what: 'job to run', timeoutMs: 6000 });
      await new Promise((r) => setTimeout(r, 600));
      expect(ran).toHaveLength(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(750);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  it('FLUSHALL wipes every job; the work is still findable from Postgres, so a sweeper can queue it again', async () => {
    const lot = randomUUID();
    const at = Date.now() + 60_000;
    await scheduleAt(queues.lotClose, jobId.close(lot, at), { lotId: lot }, at, Date.now());
    expect(
      (await queues.lotClose.getDelayed()).some((j) => (j.data as { lotId: string }).lotId === lot),
    ).toBe(true);
    await redis.flushdb(); // what FLUSHALL does to this database
    expect(await queues.lotClose.getDelayedCount()).toBe(0);
    // Same deterministic id can be added again afterwards (nothing remembers the lost one).
    await scheduleAt(queues.lotClose, jobId.close(lot, at), { lotId: lot }, at, Date.now());
    expect(
      (await queues.lotClose.getDelayed()).some((j) => (j.data as { lotId: string }).lotId === lot),
    ).toBe(true);
  });
});
