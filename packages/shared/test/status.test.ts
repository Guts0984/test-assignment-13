import { describe, expect, it } from 'vitest';
import {
  canTransition,
  findTransition,
  isPublicStatus,
  isTerminalStatus,
  LOT_STATUSES,
  LOT_TRANSITIONS,
  lotEditPolicy,
  maskName,
} from '../src/index.js';

describe('lot status machine', () => {
  it('every transition references real statuses and is unique per (from, action)', () => {
    const seen = new Set<string>();
    for (const t of LOT_TRANSITIONS) {
      expect(LOT_STATUSES).toContain(t.from);
      expect(LOT_STATUSES).toContain(t.to);
      const key = `${t.from}:${t.action}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('every status is reachable from draft', () => {
    const reached = new Set(['draft']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of LOT_TRANSITIONS) {
        if (reached.has(t.from) && !reached.has(t.to)) {
          reached.add(t.to);
          grew = true;
        }
      }
    }
    expect([...reached].sort()).toEqual([...LOT_STATUSES].sort());
  });

  it('only the right actor may perform an action', () => {
    expect(canTransition('in_review', 'approve', 'moderator')).toBe(true);
    expect(canTransition('in_review', 'approve', 'seller')).toBe(false);
    expect(canTransition('active', 'remove', 'seller')).toBe(false);
    expect(canTransition('active', 'close_sold', 'buyer')).toBe(false);
    expect(canTransition('shipped', 'confirm', 'seller')).toBe(false);
    expect(canTransition('paid', 'ship', 'seller')).toBe(true);
  });

  it('impossible jumps do not exist', () => {
    expect(findTransition('draft', 'approve')).toBeUndefined();
    expect(findTransition('active', 'pay')).toBeUndefined();
    expect(findTransition('completed', 'remove')).toBeUndefined();
    expect(findTransition('removed', 'submit')).toBeUndefined();
    // Buy-now and moderator removal only from active.
    for (const s of LOT_STATUSES.filter((x) => x !== 'active')) {
      expect(findTransition(s, 'buy_now')).toBeUndefined();
      expect(findTransition(s, 'remove')).toBeUndefined();
    }
  });

  it('terminal statuses', () => {
    expect(LOT_STATUSES.filter(isTerminalStatus).sort()).toEqual([
      'completed',
      'ended_unsold',
      'removed',
    ]);
  });

  it('drafts, reviews, rejections and removed lots are not public', () => {
    expect(LOT_STATUSES.filter((s) => !isPublicStatus(s)).sort()).toEqual([
      'draft',
      'in_review',
      'rejected',
      'removed',
    ]);
  });

  it('edit policy: anything before the first bid, append-only after, nothing once closed', () => {
    expect(lotEditPolicy('draft', 0)).toBe('full');
    expect(lotEditPolicy('rejected', 0)).toBe('full');
    expect(lotEditPolicy('active', 0)).toBe('full');
    expect(lotEditPolicy('active', 1)).toBe('append_description');
    expect(lotEditPolicy('in_review', 0)).toBe('none');
    for (const s of [
      'ended_unsold',
      'awaiting_payment',
      'paid',
      'shipped',
      'completed',
      'removed',
    ] as const) {
      expect(lotEditPolicy(s, 5)).toBe('none');
    }
  });
});

describe('maskName', () => {
  it.each([
    ['olena_7', 'o***7'],
    ['Олена7', 'о***7'],
    ['A', 'a***a'],
    ['  bob  ', 'b***b'],
    ['', '***'],
    ['   ', '***'],
    ['😀abc😎', '😀***😎'],
  ])('%j → %j', (name, masked) => expect(maskName(name)).toBe(masked));

  it('never leaks the middle of the name', () => {
    expect(maskName('secretive-person-42')).not.toContain('secret');
  });
});
