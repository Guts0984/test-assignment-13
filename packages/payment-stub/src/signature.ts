import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing, like real providers do it: HMAC-SHA256 over `<timestamp>.<raw body>`, the
 * timestamp travels in its own header, and the receiver rejects anything older than a few minutes
 * (so a captured webhook cannot be replayed forever).
 */
export const SIGNATURE_HEADER = 'x-provider-signature';
export const TIMESTAMP_HEADER = 'x-provider-timestamp';
export const DEFAULT_TOLERANCE_MS = 5 * 60_000;

export const signWebhook = (secret: string, timestampMs: number, body: string): string =>
  `v1=${createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex')}`;

export type VerifyInput = {
  readonly secret: string;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  /** The raw request body, byte for byte as received. */
  readonly body: string;
  readonly nowMs: number;
  readonly toleranceMs?: number;
};

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'missing' | 'stale' | 'bad_signature' };

export const verifyWebhook = (input: VerifyInput): VerifyResult => {
  if (!input.signature || !input.timestamp) return { ok: false, reason: 'missing' };
  if (!/^\d{10,16}$/.test(input.timestamp)) return { ok: false, reason: 'bad_signature' };
  const timestamp = Number(input.timestamp);
  if (Math.abs(input.nowMs - timestamp) > (input.toleranceMs ?? DEFAULT_TOLERANCE_MS)) {
    return { ok: false, reason: 'stale' };
  }
  const expected = Buffer.from(signWebhook(input.secret, timestamp, input.body));
  const given = Buffer.from(input.signature);
  // timingSafeEqual needs equal lengths; a different length is simply not a match.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
};
