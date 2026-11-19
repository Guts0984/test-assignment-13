'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { REALTIME_EVENTS, type LotEventMessage } from '@auction/shared';
import {
  catalogControllerEvents,
  getCatalogControllerBidsQueryKey,
  getCatalogControllerLotQueryKey,
} from '../../shared/api/generated/client';

export type LivePatch = {
  currentPrice: number;
  bidCount: number;
  endsAt: string | null;
  reserveMet: boolean | null;
  seq: number;
};

/**
 * Live updates for one lot. Events are numbered; if one is missing (a hole, or after a reconnect) the client asks
 * the API for everything after the last number it applied, so it never shows a stale price.
 */
export const useLiveLot = (
  lotId: string,
  startSeq: number | undefined,
): { patch: LivePatch | null; connected: boolean } => {
  const qc = useQueryClient();
  const [patch, setPatch] = useState<LivePatch | null>(null);
  const [connected, setConnected] = useState(false);
  const last = useRef<number | undefined>(startSeq);
  useEffect(() => {
    last.current ??= startSeq;
  }, [startSeq]);

  useEffect(() => {
    const socket = io({ path: '/socket.io', transports: ['websocket'] });
    const apply = (seq: number, p: Record<string, unknown>) => {
      last.current = seq;
      setPatch({
        currentPrice: p['currentPrice'] as number,
        bidCount: p['bidCount'] as number,
        endsAt: (p['endsAt'] as string | null | undefined) ?? null,
        reserveMet: (p['reserveMet'] as boolean | null | undefined) ?? null,
        seq,
      });
      void qc.invalidateQueries({ queryKey: getCatalogControllerBidsQueryKey(lotId) });
    };
    const catchUp = async () => {
      const r = await catalogControllerEvents(lotId, { after: String(last.current ?? 0) });
      for (const e of r.events) {
        if (e.type === 'bid' || e.type === 'closed') apply(e.seq, e.payload);
        else last.current = e.seq;
      }
      if (r.events.length === 0)
        void qc.invalidateQueries({ queryKey: getCatalogControllerLotQueryKey(lotId) });
    };
    socket.on('connect', () => {
      setConnected(true);
      socket.emit(
        REALTIME_EVENTS.subscribe,
        { lotId },
        () => void catchUp().catch(() => undefined),
      );
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on(REALTIME_EVENTS.lotEvent, (m: LotEventMessage) => {
      const expected = (last.current ?? m.seq - 1) + 1;
      if (m.seq > expected)
        void catchUp().catch(() => undefined); // a hole: fetch what was missed
      else if (m.seq === expected && (m.type === 'bid' || m.type === 'closed'))
        apply(m.seq, m.payload as Record<string, unknown>);
      else if (m.seq === expected) last.current = m.seq;
    });
    return () => {
      socket.close();
    };
  }, [lotId, qc]);
  return { patch, connected };
};
