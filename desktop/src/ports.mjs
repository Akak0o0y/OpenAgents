/**
 * Choosing the daemon's port.
 *
 * A fixed port is a promise the machine does not have to keep. On Windows it
 * fails three different ways, and the old behaviour - refuse, and tell the
 * user to set OPENHOURS_PORT - is an instruction nobody who installed an app
 * can follow:
 *
 *   IN USE       another program, another copy of OpenAgents under a different
 *                Windows account (loopback ports are machine-wide), or a
 *                developer's own daemon.
 *   RESERVED     Hyper-V, WSL and Docker reserve port blocks, and the blocks
 *                move between reboots. A reserved port cannot be bound even
 *                though nothing is listening on it, so a connect() test says
 *                "free" and the daemon then fails to start. Only a real bind
 *                tells the truth.
 *   EPHEMERAL    49152-65535 is the range Windows hands out for OUTGOING
 *                connections, including this app's own. A fixed port up there
 *                can be taken at random, which is why "an unpopular high port"
 *                is the wrong instinct.
 *
 * So: a default below the ephemeral range, remembered once chosen, and a
 * verified replacement when it cannot be used. Remembering matters beyond
 * speed: the interface's local storage belongs to its origin, port included,
 * and a port that changed on every launch would look like losing the theme and
 * unsent drafts every time.
 */

import net from 'node:net';

/**
 * The installed app's default. Below the ephemeral range, clear of the usual
 * development ports, and deliberately not the development daemon's 4001 - so a
 * developer running `npm run daemon` does not collide with their installed copy.
 */
export const DESKTOP_DEFAULT_PORT = 41731;

/** Where a replacement is looked for: registered-port territory, below ephemeral. */
export const FALLBACK_RANGE = Object.freeze({ min: 20000, max: 48999 });

const validPort = (port) => Number.isInteger(port) && port > 0 && port <= 65535;

/**
 * Can this process listen on the port right now?
 *
 * False for a port in use AND for one Windows has reserved (EACCES) - the case
 * a connect test cannot see.
 */
export function canBind(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    if (!validPort(port)) {
      resolve(false);
      return;
    }
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A port the OS says is free this instant. The last resort, not the plan. */
export function osAssignedPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Pick the port to use.
 *
 *   1. A daemon for THIS profile already answering on the remembered or default
 *      port is attached to, not duplicated.
 *   2. Otherwise the first of those that can really be bound.
 *   3. Otherwise a random bindable port in FALLBACK_RANGE, which stays usable
 *      when remembered - an OS-assigned port is ephemeral and would not.
 *   4. Otherwise whatever the OS assigns.
 *
 * @param {object} options
 * @param {number | null | undefined} options.remembered
 * @param {number} options.preferred
 * @param {(port: number) => Promise<boolean>} options.isOurs
 * @returns {Promise<{ port: number, attach: boolean, replaced: boolean }>}
 */
export async function choosePort({ remembered, preferred, isOurs, bindable = canBind, assign = osAssignedPort, random = Math.random, attempts = 24 }) {
  const known = [...new Set([remembered, preferred].filter(validPort))];
  // One port at a time, remembered first. Probing every candidate before
  // binding any would ask the default port for our daemon on every launch -
  // and a program on that port that accepts connections without answering
  // holds each probe for its full timeout.
  for (const port of known) {
    if (await isOurs(port)) return { port, attach: true, replaced: false };
    if (await bindable(port)) return { port, attach: false, replaced: port !== remembered && remembered != null };
  }
  const span = FALLBACK_RANGE.max - FALLBACK_RANGE.min + 1;
  for (let i = 0; i < attempts; i++) {
    const port = FALLBACK_RANGE.min + Math.floor(random() * span);
    if (known.includes(port)) continue;
    if (await bindable(port)) return { port, attach: false, replaced: true };
  }
  return { port: await assign(), attach: false, replaced: true };
}
