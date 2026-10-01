/** Only the authenticated bot viewer may be embedded, and only same-origin. */
function isDesktopViewer(url, port, isDev, devUrl) {
  try {
    const target = new URL(url);
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    if (isDev) origins.push(new URL(devUrl).origin);
    return origins.includes(target.origin) && !target.username && !target.password &&
      /^\/api\/desktop\/[^/]+\/viewer\.html$/.test(target.pathname);
  } catch { return false; }
}

// Applied per response by the shell, including embedded viewer documents.
// Startup has its own file-page meta policy. Dev additionally needs Vite HMR.
export function contentSecurityPolicy({ port, url = '', isDev = false, devUrl = '' }) {
  const daemon = `http://127.0.0.1:${port} ws://127.0.0.1:${port} http://localhost:${port} ws://localhost:${port}`;
  const directives = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${daemon}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    isDesktopViewer(url, port, isDev, devUrl) ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
  ];
  if (isDev) {
    const vite = new URL(devUrl).host;
    directives[directives.findIndex(d => d.startsWith('connect-src'))] =
      `connect-src 'self' ${daemon} http://${vite} ws://${vite}`;
    directives[0] = `default-src 'self' http://${vite}`;
  }
  return directives.join('; ');
}
