import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { publicAddress, resolveAddresses } from './web-research.js';

/** Browser-owned proxy: pin DNS at the connection, including TLS tunnels. No public listener or proxy credentials. */
export async function browserEgress(previewOrigins: string[] = []) {
  const sockets = new Set<net.Socket>();
  let received = 0;
  const lifetime = new AbortController();
  const account = (chunk: Buffer) => { received += chunk.length; if (received > 32 * 1024 * 1024) { lifetime.abort(); for (const socket of sockets) socket.destroy(); } };
  const track = (s: net.Socket) => { if (sockets.has(s)) return s; sockets.add(s); s.on('error', () => s.destroy()); s.once('close', () => sockets.delete(s)); s.setTimeout(30000, () => s.destroy()); return s; };
  const resolve = async (url: URL) => {
    lifetime.signal.throwIfAborted();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported destination');
    const preview = previewOrigins.includes(url.origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await resolveAddresses(host, lifetime.signal);
    if (!addresses.length || (!preview && addresses.some(a => !publicAddress(a.address)))) throw new Error('Blocked destination');
    return addresses[0];
  };
  const server = http.createServer(async (req, res) => {
    req.on('error', () => res.destroy()); res.on('error', () => res.destroy());
    try {
      const url = new URL(req.url!); const address = await resolve(url);
      lifetime.signal.throwIfAborted();
      if (req.destroyed || res.destroyed) return;
      if (url.protocol !== 'http:') throw new Error('Use CONNECT for TLS');
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const out = http.request(url, { method: req.method, headers, family: address.family,
        lookup: (_host, _opts, callback) => callback(null, address.address, address.family) }, upstream => {
        upstream.on('error', () => res.destroy());
        upstream.on('data', account); if (!res.destroyed) { res.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(res); }
      });
      out.on('socket', track); out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.once('close', () => out.destroy()); req.pipe(out);
    } catch { if (!res.destroyed) { res.writeHead(403); res.end('Browser network policy refused this destination.'); } }
  });
  server.on('connection', socket => { if (lifetime.signal.aborted || sockets.size >= 64) socket.destroy(); else track(socket); });
  server.on('connect', async (req, socket, head) => {
    try {
      const url = new URL(`https://${req.url}`); const address = await resolve(url);
      if (socket.destroyed || lifetime.signal.aborted) return;
      const upstream = track(net.connect({ host: address.address, port: Number(url.port || 443), family: address.family }));
      upstream.on('data', account);
      upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
      upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: () => new Promise<void>(resolve => {
    lifetime.abort();
    for (const socket of sockets) socket.destroy(); server.close(() => resolve());
  }) };
}
