import { it } from 'vitest';
import { runConsumerBrowserTest } from '../../scripts/consumer-browser-test.js';

// Shipped-client + real built Worker/D1 multi-document acceptance (spec #195,
// ticket #196): register/login through public HTTP, navigation, reload and a
// second tab with verified Reader State performing zero Identity calls,
// bounded JWKS caching, exactly one lazy refresh for concurrent consumers,
// conservative invalid/outage behavior, live cross-tab replacement/logout and
// JWKS outage recovery. Mail is captured at the public AuthMailer seam and
// verified through the real verifyEmail API.
it('reuses verified Reader State across documents and tabs without Identity calls', async () => {
  await runConsumerBrowserTest();
}, 240_000);
