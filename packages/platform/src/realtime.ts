import {
  REALTIME_EVENTS,
  lotRoom,
  userRoom,
  type LotEventMessage,
  type NotificationMessage,
} from '@auction/shared';
import type { Effects } from '@auction/domain';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';

/**
 * Pushes domain effects to connected clients through Redis, so it works from ANY process (the
 * worker has no sockets of its own): the Socket.IO Redis adapter in each api copy receives the
 * message and delivers it to its local sockets. Emitting is best-effort: the events are also in
 * Postgres, and a client that missed one catches up by sequence number.
 */
export type RealtimeEmitter = {
  readonly emit: (effects: Effects, serverNow: number) => void;
  /** Disconnects every socket (on every api copy) that authenticated with this session. Best effort. */
  readonly disconnectSession: (sessionId: string) => void;
};

/** Every socket joins the room of the session it authenticated with, so logout can drop exactly those. */
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

export const createRealtimeEmitter = (redis: Redis): RealtimeEmitter => {
  const emitter = new Emitter(redis);
  return {
    disconnectSession: (sessionId) => {
      try {
        emitter.in(sessionRoom(sessionId)).disconnectSockets(true);
      } catch {
        // Best effort, like emit.
      }
    },
    emit: (effects, serverNow) => {
      try {
        for (const e of effects.events) {
          const message: LotEventMessage = {
            lotId: e.lotId,
            seq: e.seq,
            type: e.type,
            payload: e.payload,
            serverNow,
          };
          emitter.to(lotRoom(e.lotId)).emit(REALTIME_EVENTS.lotEvent, message);
        }
        for (const n of effects.notifications) {
          const message: NotificationMessage = { kind: n.kind, payload: n.payload, serverNow };
          emitter.to(userRoom(n.userId)).emit(REALTIME_EVENTS.notification, message);
        }
      } catch {
        // Best effort by design (see above).
      }
    },
  };
};
