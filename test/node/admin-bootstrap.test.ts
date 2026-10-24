import { describe, expect, it } from 'vitest';
import {
  assertSafeBootstrapTarget,
  resolveBootstrapConfig,
} from '../../scripts/bootstrap-admin.js';

// Seam under test: pure operator-input resolution for the first-admin
// bootstrap script (ticket #59). No network, no Worker, no secrets on disk;
// failures name variables and shapes, never values.
describe('admin bootstrap operator inputs', () => {
  it('resolves explicit operator inputs with a localhost default target', () => {
    expect(
      resolveBootstrapConfig({
        ADMIN_NAME: 'Site Admin',
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'Correct-horse-41',
      }),
    ).toEqual({
      baseUrl: 'http://localhost:8787',
      name: 'Site Admin',
      email: 'admin@example.com',
      password: 'Correct-horse-41',
    });
  });

  it('accepts an explicit target for sandbox use', () => {
    const config = resolveBootstrapConfig({
      ADMIN_BOOTSTRAP_BASE_URL: 'https://sandbox.example.com',
      ADMIN_NAME: 'Site Admin',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'Correct-horse-41',
    });
    expect(config.baseUrl).toBe('https://sandbox.example.com');
  });

  it.each([['ADMIN_NAME'], ['ADMIN_EMAIL'], ['ADMIN_PASSWORD']])(
    'fails closed without %s and never echoes values',
    (missing) => {
      const env = {
        ADMIN_NAME: 'Site Admin',
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'Correct-horse-41',
        [missing]: '',
      };
      let message = '';
      try {
        resolveBootstrapConfig(env);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain(missing);
      expect(message).not.toContain('Correct-horse-41');
      expect(message).not.toContain('admin@example.com');
    },
  );

  it('refuses non-HTTP(S) bootstrap targets', () => {
    expect(() => assertSafeBootstrapTarget('not-a-url')).toThrow();
    expect(() => assertSafeBootstrapTarget('ftp://example.com')).toThrow();
    expect(assertSafeBootstrapTarget('http://localhost:8787').origin).toBe('http://localhost:8787');
  });
});
