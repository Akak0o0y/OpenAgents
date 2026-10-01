/**
 * Where the daemon actually answers.
 *
 * Almost every request in this app is a same-origin relative path, and should
 * stay that way. This is for the one case that cannot be: a URL handed to
 * something OUTSIDE the app - a webhook - which has to name the daemon rather
 * than whatever happens to be serving the page.
 *
 * The page origin is wrong for that in two of the three ways this app runs:
 *
 *   served by the daemon      origin IS the daemon           - correct
 *   dev, served by Vite       origin is the Vite dev server  - wrong
 *   desktop shell in dev      origin is the Vite dev server  - wrong
 *
 * So it is asked rather than assumed: `/health` reports the port the daemon is
 * listening on, and that request goes through whatever proxy is in front of it,
 * which is exactly the indirection being resolved.
 */

const HEALTH_TIMEOUT_MS = 2000;

let cached: string | null = null;
let inFlight: Promise<string | null> | null = null;

/**
 * The daemon's origin, or null if it could not be established.
 *
 * Null rather than a guess: a webhook URL that silently points at the wrong
 * port is worse than no URL, because it fails only for whoever tries to call
 * it, days later.
 */
export async function daemonOrigin(): Promise<string | null> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch('/health', { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { service?: string; port?: number };
      if (body?.service !== 'openhours-daemon' || !Number.isFinite(body.port)) return null;
      // The hostname comes from the page, not the daemon: the daemon knows
      // which port it bound but not which name the operator reached it by, and
      // rewriting `localhost` to `127.0.0.1` (or the reverse) would break a
      // setup that deliberately uses one.
      cached = `${window.location.protocol}//${window.location.hostname}:${body.port}`;
      return cached;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test seam: forget what was resolved, so the next call asks again. */
export function resetDaemonOrigin(): void {
  cached = null;
  inFlight = null;
}

/**
 * True when a URL is only reachable from this machine.
 *
 * A webhook on loopback works - the daemon really does serve it - but only for
 * a caller on the same computer. Saying so is the difference between a control
 * that works and one that appears to.
 */
export function isLoopback(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}
