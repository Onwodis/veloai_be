/**
 * WebSocket endpoint: /api/v1/ws
 *
 * Protocol (JSON text frames)
 *   client → { type: 'auth', token }                       first frame, within 10 s
 *   server → { type: 'ready' }
 *   client → { type: 'watch', kind, workspaceId, projectId }  (repeatable)
 *   client → { type: 'unwatch', kind, projectId }
 *   server → { type: 'progress', event }                    see realtime/events.ts
 *   server → { type: 'error', message }
 *
 * The access token travels in the first frame, not the URL, so it never lands
 * in proxy or server logs. Each watch is checked against workspace
 * membership. The browser Origin must be one of CORS_ORIGINS.
 *
 * One Redis subscriber per API process fans events out to the sockets
 * watching that project; a ping every 30 s drops dead connections.
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { requireMembership } from '../services/workspace.service.js';
import { logger } from '../utils/logger.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { PROGRESS_CHANNEL, type ProgressEvent } from './events.js';

const PATH = '/api/v1/ws';
const MAX_WATCHES = 20;

const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4000) }),
  z.object({ type: z.literal('watch'), kind: z.enum(['reels', 'studio']), workspaceId: z.uuid(), projectId: z.uuid() }),
  z.object({ type: z.literal('unwatch'), kind: z.enum(['reels', 'studio']), projectId: z.uuid() }),
]);

interface Client {
  socket: WebSocket;
  userId: string | null;
  role: string | null;
  watching: Set<string>;
  alive: boolean;
}

const send = (socket: WebSocket, payload: unknown): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
};

export function attachRealtime(server: Server): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const watchers = new Map<string, Set<Client>>();
  const clients = new Map<WebSocket, Client>();
  const origins = new Set(env.CORS_ORIGINS.map((origin) => origin.replace(/\/+$/, '')));

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== PATH) return; // not ours: leave it for anything else
    const origin = request.headers.origin?.replace(/\/+$/, '');
    if (origin && !origins.has(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });

  const unwatchAll = (client: Client): void => {
    for (const entry of client.watching) {
      const key = entry.split('@')[0]!;
      const set = watchers.get(key);
      set?.delete(client);
      if (set?.size === 0) watchers.delete(key);
    }
    client.watching.clear();
  };

  wss.on('connection', (socket: WebSocket) => {
    const client: Client = { socket, userId: null, role: null, watching: new Set(), alive: true };
    clients.set(socket, client);
    const authTimer = setTimeout(() => {
      if (!client.userId) socket.close(4401, 'auth timeout');
    }, 10_000);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      unwatchAll(client);
      clients.delete(socket);
    });
    socket.on('message', (raw) => {
      void (async () => {
        let parsed: z.infer<typeof message>;
        try {
          parsed = message.parse(JSON.parse(String(raw)));
        } catch {
          send(socket, { type: 'error', message: 'Bad message' });
          return;
        }
        if (parsed.type === 'auth') {
          try {
            const claims = verifyAccessToken(parsed.token);
            client.userId = claims.sub;
            client.role = claims.role;
            clearTimeout(authTimer);
            send(socket, { type: 'ready' });
          } catch {
            socket.close(4401, 'invalid token');
          }
          return;
        }
        if (!client.userId) {
          socket.close(4401, 'not authenticated');
          return;
        }
        const key = `${parsed.kind}:${parsed.projectId}`;
        if (parsed.type === 'unwatch') {
          watchers.get(key)?.delete(client);
          for (const entry of client.watching) if (entry.startsWith(`${key}@`)) client.watching.delete(entry);
          return;
        }
        if (client.watching.size >= MAX_WATCHES) {
          send(socket, { type: 'error', message: 'Too many watched projects' });
          return;
        }
        if (client.role !== 'SUPER_ADMIN') {
          try {
            await requireMembership(client.userId, parsed.workspaceId);
          } catch {
            send(socket, { type: 'error', message: 'Not a member of that workspace' });
            return;
          }
        }
        // The event's workspaceId is re-checked on delivery, so a project id from another workspace never leaks.
        client.watching.add(`${key}@${parsed.workspaceId}`);
        const set = watchers.get(key) ?? new Set<Client>();
        set.add(client);
        watchers.set(key, set);
      })();
    });
  });

  // Redis: one dedicated subscriber connection per API process.
  const subscriber = redis.duplicate();
  subscriber.subscribe(PROGRESS_CHANNEL).catch((error: unknown) => logger.error({ err: error }, 'progress channel subscribe failed'));
  subscriber.on('message', (_channel: string, payload: string) => {
    let event: ProgressEvent;
    try {
      event = JSON.parse(payload) as ProgressEvent;
    } catch {
      return;
    }
    const set = watchers.get(`${event.kind}:${event.projectId}`);
    if (!set) return;
    for (const client of set) {
      if (client.watching.has(`${event.kind}:${event.projectId}@${event.workspaceId}`)) send(client.socket, { type: 'progress', event });
    }
  });

  const heartbeat = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive) {
        socket.terminate();
        continue;
      }
      client.alive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  logger.info({ path: PATH }, 'realtime websocket ready');

  return async () => {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.close(1001, 'server shutting down');
    wss.close();
    await subscriber.quit().catch(() => undefined);
  };
}
