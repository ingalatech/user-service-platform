import { describe, expect, it } from 'vitest';
import { buildServiceRequest, isAllowedGatewayOrigin } from './same-origin-gateway.js';

// Seam under test (ticket #152 handoff): the pure same-origin gateway
// helpers. These tests prove exact-origin acceptance, wildcard rejection and
// cookie/Origin preservation without trusting forwarded-host headers.
describe('same-origin gateway helpers', () => {
  it('accepts the gateway origin and exact configured origins only', () => {
    const gateway = 'https://shop.example';
    expect(isAllowedGatewayOrigin('https://shop.example', gateway, [])).toBe(true);
    expect(isAllowedGatewayOrigin(null, gateway, [])).toBe(true);
    expect(isAllowedGatewayOrigin('https://api.example', gateway, ['https://api.example'])).toBe(
      true,
    );
    expect(isAllowedGatewayOrigin('https://evil.example', gateway, [])).toBe(false);
    expect(isAllowedGatewayOrigin('https://evil.example', gateway, ['https://api.example'])).toBe(
      false,
    );
    expect(isAllowedGatewayOrigin('https://shop.example.evil.com', gateway, [])).toBe(false);
    expect(isAllowedGatewayOrigin('*', gateway, [])).toBe(false);
  });

  it('forwards cookies and the original origin while dropping forwarded-host headers', async () => {
    const browser = new Request('https://shop.example/v1/auth/token', {
      method: 'POST',
      headers: {
        cookie: 'session=abc',
        origin: 'https://shop.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
      body: '{}',
    });
    const forwarded = buildServiceRequest(browser, '/v1/auth/token', {
      serviceBaseUrl: 'https://users.example.com',
      allowedOrigins: [],
    });
    expect(forwarded?.url).toBe('https://users.example.com/v1/auth/token');
    expect(forwarded?.headers.get('cookie')).toBe('session=abc');
    expect(forwarded?.headers.get('origin')).toBe('https://shop.example');
    expect(forwarded?.headers.get('x-forwarded-host')).toBeNull();
    expect(forwarded?.headers.get('x-forwarded-proto')).toBeNull();
    expect(await forwarded?.text()).toBe('{}');
  });

  it('refuses to forward non-service paths', () => {
    const browser = new Request('https://shop.example/admin', { method: 'GET' });
    expect(
      buildServiceRequest(browser, '/admin', {
        serviceBaseUrl: 'https://users.example.com',
        allowedOrigins: [],
      }),
    ).toBeNull();
  });
});
