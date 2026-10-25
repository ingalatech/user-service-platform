import { describe, expect, it } from 'vitest';
import * as consumerClient from './index.js';

describe('Consumer Identity supported interface', () => {
  it('exposes the controller, its error/evaluator, and RCH test storage compatibility only', () => {
    expect(Object.keys(consumerClient).sort()).toEqual([
      'ConsumerClientError',
      'createConsumerClient',
      'evaluatePassword',
      'readerStateStorageKey',
    ]);
  });
});
