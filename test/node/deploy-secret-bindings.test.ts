import { describe, expect, it } from 'vitest';
import {
  checkSecretTextBindings,
  parseSecretListOutput,
  secretListArgs,
} from '../../scripts/deploy/secret-bindings.js';

describe('secret binding boundary', () => {
  it('accepts only secret_text and never consumes values', () => {
    expect(secretListArgs('worker')).toContain('secret');
    const remote = parseSecretListOutput(
      JSON.stringify([{ name: 'A', type: 'secret_text', value: 'canary' }]),
    );
    expect(remote).toEqual([{ name: 'A', type: 'secret_text' }]);
    expect(checkSecretTextBindings(['A', 'B'], remote)).toEqual([
      { name: 'A', status: 'ok' },
      { name: 'B', status: 'missing' },
    ]);
  });
});
