/**
 * Can this workspace reach a model at all?
 *
 * A fresh install has a bot and no provider. Sending it a message then fails
 * with a provider error, which reads as "the app is broken" to someone nobody
 * told a provider was needed. So the sidebar says so first, with the way to
 * fix it.
 *
 * Counted as set up: any enabled connection with a stored key, or a provider
 * key in the daemon's environment - which is how development runs, and where a
 * banner asking for a provider would be wrong.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './transport.js';

export function useProviderSetup(): { needed: boolean; refresh: () => void } {
  const [needed, setNeeded] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Started inside a promise so a transport without this call (a test double)
    // is a quiet "not needed", not a render error.
    void Promise.resolve()
      .then(() => api.providers())
      .then((body) => {
        if (cancelled) return;
        const usable = body.connections.some((connection) => connection.enabled && connection.hasKey);
        setNeeded(!usable && !(body.environmentCredentials?.length));
      })
      .catch(() => {
        if (!cancelled) setNeeded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { needed, refresh };
}
