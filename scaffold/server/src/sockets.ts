import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { allowedOrigin, getSession } from './auth.ts';
import { framesAfter, latestSequence } from './events.ts';
import { knownWorkspace } from './inbox.ts';

export function attachSockets(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const abort = () => socket.destroy();
    socket.on('error', abort);
    const refuse = (status: string) => {
      socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return refuse('404 Not Found');
      if (!allowedOrigin(req.headers.origin)) return refuse('403 Forbidden');
      const user = await getSession(req.headers.cookie);
      if (!user) return refuse('401 Unauthorized');

      const workspace = url.searchParams.get('workspace');
      if (!knownWorkspace(workspace) || !user.workspaces.some(member => member.id === workspace)) {
        return refuse('403 Forbidden');
      }
      const after = url.searchParams.get('after');
      if (after !== null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) {
        return refuse('400 Bad Request');
      }
      const cursor = after === null ? await latestSequence(workspace) : Number(after);
      if (socket.destroyed) return;
      sockets.handleUpgrade(req, socket, head, ws => {
        socket.off('error', abort);
        stream(ws, workspace, cursor, req.headers.cookie);
      });
    } catch {
      return refuse('500 Internal Server Error');
    }
  });
}

function stream(ws: WebSocket, workspace: string, after: number, cookie: string | undefined) {
  let cursor = after;
  let timer: NodeJS.Timeout | undefined;
  let pong = true;

  const heartbeat = setInterval(async () => {
    try {
      if (!pong || !(await getSession(cookie))) {
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        pong = false;
        ws.ping();
      }
    } catch {
      ws.terminate();
    }
  }, 30_000).unref();

  ws.on('pong', () => { pong = true; });
  ws.on('error', () => ws.terminate());
  ws.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timer);
  });

  async function pump() {
    try {
      const frames = await framesAfter(workspace, cursor);
      for (const frame of frames) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 256_000) {
          ws.terminate();
          return;
        }
        ws.send(JSON.stringify(frame));
        cursor = frame.seq;
      }
      if (ws.readyState === WebSocket.OPEN) {
        timer = setTimeout(pump, frames.length === 100 ? 0 : 250).unref();
      }
    } catch {
      ws.terminate();
    }
  }
  void pump();
}
