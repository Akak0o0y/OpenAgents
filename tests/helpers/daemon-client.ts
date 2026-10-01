// Authenticated fixture clients. Security-negative tests import the real server and raw fetch/ws.
import { DaemonWsServer as Server } from '../../src/daemon/ws-server.js';
import Ws from 'ws';
export type { DaemonReadApi, WsCommand } from '../../src/daemon/ws-server.js';
const tokens = new Map<string, string>();
export function registerFixtureServer(port: number, server: Server) { tokens.set(String(port), server.authToken); }
export class DaemonWsServer extends Server {
  constructor(...args: ConstructorParameters<typeof Server>) {
    super(...args);
    registerFixtureServer(args[0] ?? 4001, this);
  }
}
export function fixtureFetch(input: string | URL, init: RequestInit = {}) {
  const url = new URL(input);
  url.hostname = '127.0.0.1';
  const headers = new Headers(init.headers);
  const token = tokens.get(url.port);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return globalThis.fetch(url, { ...init, headers });
}
export class FixtureWebSocket extends Ws {
  constructor(input: string) {
    const url = new URL(input); url.hostname = '127.0.0.1'; url.pathname = '/ws';
    super(url, { headers: { Authorization: `Bearer ${tokens.get(url.port) ?? ''}` } });
  }
}
