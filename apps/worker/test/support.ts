import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { type Deps, createFakeClock, settleTopup } from '@auction/domain';
import {
  getPayment,
  verifyWebhook,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '@auction/payment-stub';
import { DEFAULT_TIMINGS } from '@auction/shared';
import { infra, uniqueName, type TestDb } from '@auction/test-kit';
import type { WorkerConfig } from '../src/config.js';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const PROVIDER_KEY = 'test-provider-api-key-0123456789';

export type TestEnv = { config: WorkerConfig; clockStart: number };

/** A worker config pointing at the test services, with fast loops and names unique to this file. */
export const testConfig = (t: TestDb, over: Partial<WorkerConfig> = {}): WorkerConfig => ({
  databaseUrl: t.url,
  // Worker tests flush Redis on purpose, so they get their own database number.
  redisUrl: `${infra.redisUrl}/2`,
  meili: { url: infra.meiliUrl, key: infra.meiliKey },
  s3: {
    endpoint: infra.s3Endpoint,
    accessKey: infra.s3AccessKey,
    secretKey: infra.s3SecretKey,
    privateBucket: uniqueName('wpriv'),
    publicBucket: uniqueName('wpub'),
  },
  smtp: { host: infra.smtpHost, port: infra.smtpPort, from: 'no-reply@auction.test' },
  webhookSecret: WEBHOOK_SECRET,
  provider: { baseUrl: 'http://127.0.0.1:1', apiKey: PROVIDER_KEY },
  timings: { ...DEFAULT_TIMINGS },
  intervals: {
    sweeperMs: 250,
    searchSyncMs: 250,
    webhookMs: 250,
    topupReconcileMs: 400,
    topupReconcileMinAgeMs: 60_000,
  },
  concurrency: 5,
  logLevel: 'error',
  indexUid: uniqueName('wlots'),
  ...over,
});

export const fakeClock = (start = Date.parse('2026-06-01T12:00:00Z')) => createFakeClock(start);

/**
 * A stand-in for the API's two provider-facing endpoints, written independently of the worker:
 *   POST /webhook                    verifies the signature, re-fetches the AUTHORITATIVE status, settles
 *   GET  /provider/payments/:id      the provider status API (Bearer key)
 * so the worker's webhook sender and reconciler are tested against the behaviour the real API has.
 */
export const startProviderApi = async (deps: Deps, now: () => Date) => {
  const log: { type: string; verdict: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.method === 'POST' && req.url === '/webhook') {
          const v = verifyWebhook({
            secret: WEBHOOK_SECRET,
            signature: req.headers[SIGNATURE_HEADER] as string | undefined,
            timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
            body,
            nowMs: now().getTime(),
          });
          if (!v.ok) {
            log.push({ type: 'rejected', verdict: v.reason });
            res.statusCode = 400;
            return res.end('bad signature');
          }
          const event = JSON.parse(body) as {
            type: string;
            data: { paymentId: string; reference: string };
          };
          const payment = await getPayment(deps.pool, event.data.paymentId);
          if (!payment) {
            res.statusCode = 404;
            return res.end();
          }
          // The webhook is only a hint: the provider's own record decides.
          if (payment.status !== 'pending') {
            await settleTopup(deps, { topupId: payment.reference, outcome: payment.status });
          }
          log.push({ type: event.type, verdict: payment.status });
          res.statusCode = 200;
          return res.end('ok');
        }
        const m = /^\/provider\/payments\/([0-9a-f-]{36})$/.exec(req.url ?? '');
        if (req.method === 'GET' && m) {
          if (req.headers.authorization !== `Bearer ${PROVIDER_KEY}`) {
            res.statusCode = 401;
            return res.end();
          }
          const p = await getPayment(deps.pool, m[1] as string);
          res.statusCode = p ? 200 : 404;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify(p ? { status: p.status, amount: p.amount } : {}));
        }
        res.statusCode = 404;
        res.end();
      })().catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    webhookUrl: `${base}/webhook`,
    log,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};

/** A TCP proxy we can switch off and on, to simulate a service going down and coming back. */
export const startToggleProxy = async (targetUrl: string) => {
  const target = new URL(targetUrl);
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  let port = 0;
  const listen = async () => {
    server = net.createServer((client) => {
      const upstream = net.connect(Number(target.port), target.hostname);
      sockets.add(client);
      sockets.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      const done = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on('error', done).on('close', done);
      upstream.on('error', done).on('close', done);
    });
    await new Promise<void>((r) => server?.listen(port, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  };
  await listen();
  return {
    url: () => `http://127.0.0.1:${port}`,
    down: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = null;
    },
    up: listen,
  };
};
