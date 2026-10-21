import { it } from 'vitest';
import { runConsumerBrowserTest } from '../../scripts/consumer-browser-test.js';

// Shipped-client + real built Worker/D1 multi-document acceptance (spec #150,
// ticket #152): register/login through public HTTP, repeated navigations and
// reloads with an unexpired stored token performing zero identity/token
// calls, bounded JWKS caching, exactly one renewal for concurrent consumers,
// revocation/outage/isolation/logout propagation. Mail is captured at the
// public AuthMailer seam and verified through the real verifyEmail API.
it('reuses consumer JWTs across page navigations without per-page identity calls', async () => {
  await runConsumerBrowserTest();
}, 240_000);
