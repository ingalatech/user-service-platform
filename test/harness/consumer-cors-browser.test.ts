import { it } from 'vitest';
import { runConsumerCorsBrowserTest } from '../../scripts/consumer-cors-browser-test.js';

// Real browser + real built Worker/D1 at two distinct same-site hostnames
// (spec #164, ADR-0013). Proves the direct-browser credentialed-CORS lifecycle,
// actual emitted-mail verification, the service-only host-only session cookie
// scope and hostile-origin rejection. Specific ports on a single hostname
// cannot prove host isolation.
it('authenticates directly from an approved browser origin with a host-only service session', async () => {
  await runConsumerCorsBrowserTest();
}, 240_000);
