import { randomBytes } from 'node:crypto';

/**
 * Where the integration-test services listen (docker-compose.test.yml). Each value can be
 * overridden from the environment, which is how CI points the tests at its service containers.
 */
const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

export const infra = {
  redisUrl: env('TEST_REDIS_URL', 'redis://localhost:56379'),
  meiliUrl: env('TEST_MEILI_URL', 'http://localhost:57700'),
  meiliKey: env('TEST_MEILI_KEY', 'test-master-key-0123456789'),
  s3Endpoint: env('TEST_S3_ENDPOINT', 'http://localhost:59000'),
  s3AccessKey: env('TEST_S3_ACCESS_KEY', 'testminio'),
  s3SecretKey: env('TEST_S3_SECRET_KEY', 'testminio-secret'),
  smtpHost: env('TEST_SMTP_HOST', 'localhost'),
  smtpPort: Number(env('TEST_SMTP_PORT', '51025')),
  mailpitUrl: env('TEST_MAILPIT_URL', 'http://localhost:58025'),
} as const;

/** A name that is unique per test file, for indexes and buckets (parallel files share the services). */
export const uniqueName = (prefix: string): string => `${prefix}-${randomBytes(4).toString('hex')}`;

export type MailpitMessage = {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  MessageID: string;
};

export const mailpitMessages = async (): Promise<MailpitMessage[]> => {
  const res = await fetch(`${infra.mailpitUrl}/api/v1/messages?limit=500`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages;
};

export const mailpitDeleteAll = async (): Promise<void> => {
  await fetch(`${infra.mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
};

export const waitFor = async <T>(
  fn: () => Promise<T | undefined | false | null>,
  {
    timeoutMs = 10_000,
    intervalMs = 100,
    what = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};
