import { it } from 'vitest';
import {
  runConsumerCorsBrowserTest,
  startFrontend,
} from '../../scripts/consumer-cors-browser-test.js';

it('keeps the dynamically selected frontend port bound', async () => {
  const server = await startFrontend();
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Frontend must expose its bound TCP address');
    }
    if (!server.listening || address.port === 0) {
      throw new Error('Frontend must retain its dynamically allocated port');
    }
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/`);
    if (response.status !== 200) throw new Error('Frontend must serve on its bound port');
    await response.body?.cancel();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

// Real browser + real built Worker/D1 at two distinct same-site hostnames
// (spec #164, ADR-0013). Proves the direct-browser credentialed-CORS lifecycle,
// actual emitted-mail verification, the service-only host-only session cookie
// scope and hostile-origin rejection. Specific ports on a single hostname
// cannot prove host isolation.
it('authenticates directly from an approved browser origin with a host-only service session', async () => {
  await runConsumerCorsBrowserTest();
}, 240_000);
