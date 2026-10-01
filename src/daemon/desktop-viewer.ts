import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DesktopEndpoint } from './bot-desktop.js';

export type DesktopAccess = (agentId: string) => DesktopEndpoint | null;
function route(url: string) {
  const match = /^\/api\/desktop\/([^/?]+)\/(.+)$/.exec(url);
  if (!match) return null;
  try {
    const file = match[2];
    if (!/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(file) || file.split('/').includes('..')) return null;
    return { agentId: decodeURIComponent(match[1]), file };
  } catch { return null; }
}
/** Called only AFTER daemon host/origin and session authentication checks. */
export function desktopHttp(req: IncomingMessage, res: ServerResponse, access: DesktopAccess, observe?: DesktopAccess) {
  const watching=route(req.url??'');
  if(watching?.file==='observe'){
    const endpoint=observe?.(watching.agentId);
    if(req.method!=='GET'||!endpoint){res.writeHead(403);res.end('No desktop available to observe.');return;}
    // Only this fixed read-only upstream. Never forward client data, credentials or VNC messages.
    const upstream=http.get(endpoint.base+'/observe',{headers:{Authorization:'Bearer '+endpoint.token},timeout:10000},peer=>{
      if(peer.statusCode!==200){res.writeHead(503);res.end('Desktop observation unavailable.');peer.destroy();return;}
      upstream.setTimeout(0);
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});peer.pipe(res);
    });
    const timer=setInterval(()=>{if(observe?.(watching.agentId)!==endpoint)res.destroy();},250);timer.unref();
    res.on('close',()=>{clearInterval(timer);upstream.destroy();});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end();});upstream.on('timeout',()=>upstream.destroy());
    return;
  }
  const match = route(req.url ?? ''), endpoint = match && access(match.agentId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!endpoint || req.method !== 'GET') { res.writeHead(403); res.end('Take control of the bot browser or open sign-in first.'); return; }
  if (match.file === 'viewer.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'" });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden;background:#171717}#status{position:absolute;top:8px;left:8px;color:white;font:14px sans-serif}</style></head><body><div id="screen"></div><div id="status">Connecting to bot desktop…</div><script type="module" src="viewer.js"></script></body></html>');
    return;
  }
  if (match.file === 'viewer.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    const password = JSON.stringify(endpoint.password);
    res.end(`import RFB from './core/rfb.js';
const url=new URL('websockify',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
const rfb=new RFB(document.getElementById('screen'),url.href,{credentials:{password:${password}}});
rfb.scaleViewport=true;rfb.resizeSession=false;
rfb.addEventListener('connect',()=>document.getElementById('status').textContent='');
rfb.addEventListener('disconnect',()=>document.getElementById('status').textContent='Desktop disconnected. Return to OpenAgents to reconnect.');
rfb.addEventListener('securityfailure',()=>document.getElementById('status').textContent='Desktop authentication failed.');`);
    return;
  }
  const upstream = http.get(endpoint.base + '/viewer/' + match.file, { headers: { Authorization: 'Bearer ' + endpoint.token }, timeout: 5000 }, response => {
    res.writeHead(response.statusCode ?? 502, { 'Content-Type': response.headers['content-type'] ?? 'application/octet-stream' }); response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => upstream.destroy());
}

export function desktopUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, access: DesktopAccess, onRevoke?: (agentId: string, close: () => void) => () => void) {
  const match = route(req.url ?? ''), endpoint = match?.file === 'websockify' && access(match.agentId);
  if (!endpoint) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const upstream = http.request(endpoint.base + '/viewer/websockify', { headers: {
    Authorization: 'Bearer ' + endpoint.token, Upgrade: 'websocket', Connection: 'Upgrade',
    'Sec-WebSocket-Key': req.headers['sec-websocket-key']!, 'Sec-WebSocket-Version': '13',
    ...(req.headers['sec-websocket-protocol'] ? { 'Sec-WebSocket-Protocol': req.headers['sec-websocket-protocol'] } : {}),
  }, timeout: 10000 });
  // Revocation/Resume must close an already-open viewer, not only deny new ones.
  const timer = setInterval(() => { if (access(match.agentId) !== endpoint) socket.destroy(); }, 250);
  const unsubscribe = onRevoke?.(match.agentId, () => socket.destroy());
  timer.unref();
  socket.on('close', () => { unsubscribe?.(); clearInterval(timer); upstream.destroy(); });
  upstream.on('upgrade', (response, peer, pending) => {
    upstream.setTimeout(0); peer.setTimeout(0);
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
    if (head.length) peer.write(head); if (pending.length) socket.write(pending);
    socket.pipe(peer).pipe(socket);
    socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
    socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
  });
  upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy());
  upstream.on('timeout', () => upstream.destroy()); upstream.end();
}
