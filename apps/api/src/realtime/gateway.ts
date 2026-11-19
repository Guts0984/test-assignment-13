import { Inject, Injectable } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import { REALTIME_EVENTS, isPublicStatus, lotRoom, userRoom } from '@auction/shared';
import { createRedis, sessionRoom } from '@auction/platform';
import type { ServerOptions, Socket } from 'socket.io';
import { z } from 'zod';
import { CTX, type Ctx } from '../core/context.js';
import { SESSION_COOKIE, hashToken } from '../common/http.js';

const MAX_ROOMS = 50;
const EVENTS_PER_10S = 60;

/** Socket.IO over the Redis adapter: an event emitted by ANY api copy (or the worker) reaches sockets on every copy. */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  connectRedis(url: string): void {
    const pub = createRedis(url, 'io-pub');
    const sub = pub.duplicate();
    sub.on('error', () => undefined); // a duplicate has no handler of its own; Redis loss must not crash the process
    this.adapterConstructor = createAdapter(pub, sub);
  }
  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      transports: ['websocket'],
      serveClient: false,
      maxHttpBufferSize: 10_000,
    }) as { adapter: (a: unknown) => void };
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}

const cookieOf = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(';')
    .map((p) => p.trim().split('='))
    .find(([k]) => k === name)?.[1];

/**
 * Authentication happens on the server, from the session cookie of the handshake. A socket joins its OWN
 * private room automatically; there is no message that lets it join anyone else's. Lot rooms are joined
 * on request, only for lots the public may see.
 */
@Injectable()
@WebSocketGateway({ path: '/socket.io' })
export class LiveGateway implements OnGatewayConnection {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = cookieOf(socket.handshake.headers.cookie, SESSION_COOKIE);
      if (token && token.length >= 20 && token.length <= 100) {
        const { rows } = await this.ctx.pool.query<{ id: string; sid: string }>(
          `SELECT u.id, s.id AS sid FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2`,
          [hashToken(token), this.ctx.clock.now()],
        );
        const row = rows[0];
        if (row) {
          await socket.join([userRoom(row.id), sessionRoom(row.sid)]);
          // A logout that landed between the lookup and the join broadcast its disconnect to an empty room.
          const still = await this.ctx.pool.query('SELECT 1 FROM sessions WHERE id = $1', [
            row.sid,
          ]);
          if (still.rowCount === 0) {
            socket.disconnect(true);
            return;
          }
        }
      }
    } catch {
      socket.disconnect(true);
      return;
    }
    // Flood control: more than 60 messages in 10 s and the socket is dropped.
    let count = 0;
    const timer = setInterval(() => (count = 0), 10_000);
    socket.onAny(() => {
      if (++count > EVENTS_PER_10S) socket.disconnect(true);
    });
    socket.on('disconnect', () => clearInterval(timer));
  }

  @SubscribeMessage(REALTIME_EVENTS.subscribe)
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const parsed = z.object({ lotId: z.uuid() }).safeParse(body);
    if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
    const lotRooms = [...socket.rooms].filter((r) => r.startsWith('lot:'));
    if (lotRooms.length >= MAX_ROOMS) return { ok: false, code: 'RATE_LIMITED' };
    const { rows } = await this.ctx.pool.query<{ status: string; event_seq: number }>(
      'SELECT status, event_seq FROM lots WHERE id = $1',
      [parsed.data.lotId],
    );
    const lot = rows[0];
    if (!lot || !isPublicStatus(lot.status as never)) return { ok: false, code: 'NOT_FOUND' };
    await socket.join(lotRoom(parsed.data.lotId));
    return { ok: true, latestSeq: lot.event_seq, serverNow: this.ctx.clock.now().getTime() };
  }

  @SubscribeMessage(REALTIME_EVENTS.unsubscribe)
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const parsed = z.object({ lotId: z.uuid() }).safeParse(body);
    if (parsed.success) await socket.leave(lotRoom(parsed.data.lotId));
    return { ok: true };
  }
}
