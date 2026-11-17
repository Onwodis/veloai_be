/**
 * Process-wide TCP settings. Import this FIRST in every entry point (API,
 * worker, scripts): it must run before any socket is opened.
 *
 * Node races a host's addresses ("happy eyeballs", autoSelectFamily) and by
 * default gives each address only 250 ms to answer before abandoning it. On a
 * slow or distant link (e.g. ~340 ms to Neon from a dev machine, or across an
 * ocean in production) every attempt is abandoned before the server replies
 * and the connect fails with `AggregateError ETIMEDOUT`, intermittently: the
 * request that happened to get a warm pooled connection works, the one that
 * needed a new connection 500s. 2.5 s per address keeps the fallback useful
 * (a dead IPv6 route still falls through to IPv4) without that failure; the
 * overall connect is still bounded by each client's own timeout.
 */
import net from 'node:net';

const ATTEMPT_TIMEOUT_MS = 2500;

if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(ATTEMPT_TIMEOUT_MS);
}

export const NETWORK_ATTEMPT_TIMEOUT_MS = ATTEMPT_TIMEOUT_MS;
