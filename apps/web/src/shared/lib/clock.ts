'use client';
import { useEffect, useState } from 'react';

/**
 * Time left on a lot, computed on the SERVER's clock. `serverNow` came with the response; the client measures
 * how long the response took and assumes half of it was the trip back (NTP-style), so a wrong device clock
 * changes nothing.
 */
export const useServerCountdown = (
  endsAt: string | null,
  serverNow: number | undefined,
  receivedAt: number,
): number | null => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  if (endsAt === null || serverNow === undefined) return null;
  const offset = serverNow - receivedAt; // server minus device, at the moment the answer arrived
  return Math.max(0, new Date(endsAt).getTime() - (now + offset));
};

/** `days` formats the day count in the viewer's language ("2 д", "2d"). */
export const formatLeft = (ms: number, days: (n: number) => string): string => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d > 0
    ? `${days(d)} ${pad(h)}:${pad(m)}:${pad(s % 60)}`
    : `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
};
