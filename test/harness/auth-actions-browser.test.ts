import { it } from 'vitest';
import { runAuthActionsBrowserTest } from '../../scripts/auth-actions-browser-test.js';

it('executes the service-owned reset action in a real browser', async () => {
  await runAuthActionsBrowserTest();
}, 30_000);
