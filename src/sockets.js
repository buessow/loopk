import { Server } from 'socket.io';
import { MSG } from './api3/tools.js';
import { Auth } from './auth/index.js';
import { COLLECTIONS } from './api3/collection.js';

function parseCookies (header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Socket.IO /storage namespace compatible with Nightscout APIv3: create,
 * update and delete broadcasts per collection. Native clients authenticate
 * with { accessToken }; the web UI with its session cookie.
 */
export function attachSockets (httpServer, ctx) {
  const io = new Server(httpServer, { allowEIO3: true, serveClient: true });
  const { auth, bus } = ctx;

  async function resolve (socket, message) {
    if (message?.accessToken) return auth.resolveToken(message.accessToken);
    const cookies = parseCookies(socket.request.headers.cookie);
    const user = await auth.userForSession(cookies[auth.sessionCookieName()]);
    if (user) return { user, permissions: Auth.userPermissions(user) };
    return null;
  }

  const storage = io.of('/storage');
  storage.on('connection', (socket) => {
    socket.on('subscribe', async (message, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      try {
        const a = await resolve(socket, message);
        if (!a) return reply({ success: false, message: MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
        const enabled = Object.keys(COLLECTIONS);
        const wanted = Array.isArray(message?.collections) ? message.collections : enabled;
        const subscribed = [];
        for (const col of wanted) {
          if (!enabled.includes(col)) continue;
          const perm = col === 'settings' ? `api:${col}:admin` : `api:${col}:read`;
          if (auth.can(a, perm)) {
            socket.join(col);
            subscribed.push(col);
          }
        }
        reply(subscribed.length
          ? { success: true, collections: subscribed }
          : { success: false, message: MSG.SOCKET_UNAUTHORIZED_TO_ANY });
      } catch (err) {
        console.error(err);
        reply({ success: false, message: MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
      }
    });
  });

  for (const [event, name] of [['storage-socket-create', 'create'], ['storage-socket-update', 'update'], ['storage-socket-delete', 'delete']]) {
    bus.on(event, (payload) => storage.to(payload.colName).emit(name, payload));
  }

  return io;
}
