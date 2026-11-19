/**
 * Chaos mode: how the provider misbehaves when delivering webhooks. Pure: the random source and
 * the clock are passed in, so every behaviour is testable and reproducible.
 *
 *   lost          the webhook is never sent (the reconciler must find the payment)
 *   duplicate     the same webhook is sent twice
 *   delayed       sent up to 60 s late
 *   out of order  a contradicting event (failed after succeeded, or the reverse) follows
 */
export type Outcome = 'succeeded' | 'failed';
export type WebhookEventName = 'payment.succeeded' | 'payment.failed';
export type PlannedDelivery = { readonly event: WebhookEventName; readonly deliverAt: Date };

export type ChaosRates = { lost: number; duplicate: number; delayed: number; outOfOrder: number };

export const DEFAULT_CHAOS: ChaosRates = {
  lost: 0.15,
  duplicate: 0.3,
  delayed: 0.4,
  outOfOrder: 0.25,
};

const eventFor = (outcome: Outcome): WebhookEventName =>
  outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed';
const oppositeEvent = (outcome: Outcome): WebhookEventName =>
  outcome === 'succeeded' ? 'payment.failed' : 'payment.succeeded';

export const MAX_DELAY_MS = 60_000;

export const planDeliveries = (
  outcome: Outcome,
  options: { chaos: boolean; now: Date; random: () => number; rates?: ChaosRates },
): PlannedDelivery[] => {
  const at = (offsetMs: number) => new Date(options.now.getTime() + offsetMs);
  if (!options.chaos) return [{ event: eventFor(outcome), deliverAt: options.now }];

  const rates = options.rates ?? DEFAULT_CHAOS;
  const r = options.random;
  if (r() < rates.lost) return [];

  const delay = r() < rates.delayed ? Math.floor(r() * MAX_DELAY_MS) : 0;
  const plan: PlannedDelivery[] = [{ event: eventFor(outcome), deliverAt: at(delay) }];
  if (r() < rates.duplicate) {
    plan.push({ event: eventFor(outcome), deliverAt: at(delay + Math.floor(r() * 20_000)) });
  }
  if (r() < rates.outOfOrder) {
    // A contradicting event arriving AFTER the real one: the receiver must not trust it.
    plan.push({
      event: oppositeEvent(outcome),
      deliverAt: at(delay + 1000 + Math.floor(r() * 15_000)),
    });
  }
  return plan;
};
