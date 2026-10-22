import { describe, expect, it } from 'vitest';
import type { ConsumerClient, ConsumerReaderState } from '../client.js';
import { createIslandController } from './react-island.js';

const restoredSnapshot: ConsumerReaderState = {
  subject: 'reader-1',
  issuer: 'https://identity.example',
  audience: 'reader-state',
  issuedAt: 100,
  expiresAt: 200,
  entitlements: [],
  sessionStatus: 'unknown',
};

function clientWith(snapshot: ConsumerReaderState | null): ConsumerClient {
  return {
    login: () => Promise.reject(new Error('Not used.')),
    getSnapshot: () => Promise.resolve(snapshot),
    refreshReaderState: () =>
      snapshot === null ? Promise.reject(new Error('Not used.')) : Promise.resolve(snapshot),
    getSessionStatus: () => snapshot?.sessionStatus ?? 'anonymous',
    logout: () => Promise.resolve(),
    register: () => Promise.reject(new Error('Not used.')),
    verifyEmail: () => Promise.reject(new Error('Not used.')),
    requestVerification: () => Promise.reject(new Error('Not used.')),
    requestPasswordReset: () => Promise.reject(new Error('Not used.')),
    resetPassword: () => Promise.reject(new Error('Not used.')),
    observeReaderState: () => () => undefined,
  };
}

describe('React island Reader State presentation', () => {
  it('does not label restored presentation state as an authenticated session', async () => {
    const controller = createIslandController(clientWith(restoredSnapshot));

    await expect(controller.current()).resolves.toEqual({
      presentationStatus: 'available',
      sessionStatus: 'unknown',
      snapshot: restoredSnapshot,
    });
  });
});
