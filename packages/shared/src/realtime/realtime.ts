/**
 * Socket.IO contract shared by api, worker and web: room names and event names. Rooms:
 *   lot:<id>   public updates of one lot (anyone may subscribe to a public lot)
 *   user:<id>  private notifications; the SERVER joins a socket to its own room from the session,
 *              clients cannot join it
 */
export const lotRoom = (lotId: string): string => `lot:${lotId}`;
export const userRoom = (userId: string): string => `user:${userId}`;

export const REALTIME_EVENTS = {
  /** server → client: one numbered change of a lot. */
  lotEvent: 'lot:event',
  /** server → client: a private notification. */
  notification: 'notification',
  /** client → server: start/stop watching a lot. */
  subscribe: 'lot:subscribe',
  unsubscribe: 'lot:unsubscribe',
} as const;

export type LotEventMessage = {
  readonly lotId: string;
  /** Per-lot sequence number with no gaps: a client that sees a hole asks the API for the missing ones. */
  readonly seq: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Server clock when the event was published, for the client's offset estimate. */
  readonly serverNow: number;
};

export type NotificationMessage = {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly serverNow: number;
};
