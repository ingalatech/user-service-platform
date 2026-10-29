import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminIdentity,
  adminUserDetail,
  adminUsers,
  ApiError,
  login,
} from '../../admin/src/api.js';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Admin HTTP adapter contract behavior', () => {
  it('validates and projects login input before making the request', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
      bodies.push(JSON.parse(body) as unknown);
      return Promise.resolve(jsonResponse({ status: 'ok' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await login({ email: 'ada@example.com', password: 'secret-password', extra: 'discard' });
    await expect(login({ email: 'not-an-email', password: '' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
    });

    expect(bodies).toEqual([{ email: 'ada@example.com', password: 'secret-password' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps valid Problem Details and ignores malformed problem payloads', async () => {
    let payload: unknown = {
      type: 'urn:problem:email-verification-required',
      title: 'Email verification required',
      status: 403,
      code: 'email-verification-required',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(payload, 403))),
    );

    await expect(
      login({ email: 'ada@example.com', password: 'secret-password' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'email-verification-required',
    });

    payload = { title: 'Malformed problem', status: 403, code: 'forbidden' };
    try {
      await login({ email: 'ada@example.com', password: 'secret-password' });
      throw new Error('Expected malformed Problem Details to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 403, code: undefined });
    }
  });

  it('parses and projects identity/list responses while rejecting mismatched detail', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/v1/admin/me') {
          return Promise.resolve(
            jsonResponse({
              id: 'admin-1',
              email: 'ada@example.com',
              emailVerified: true,
              realm: 'administrator',
              role: 'admin',
              privateInternalValue: 'strip me',
            }),
          );
        }
        if (url.startsWith('/v1/admin/users?')) {
          return Promise.resolve(
            jsonResponse({
              items: [
                {
                  id: 'user-1',
                  email: 'grace@example.com',
                  emailVerified: false,
                  realm: 'reader',
                  role: 'user',
                  privateInternalValue: 'strip me',
                },
              ],
              total: 1,
              privateInternalValue: 'strip me',
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            id: 'missing-role',
            email: 'user@example.com',
            emailVerified: true,
          }),
        );
      }),
    );

    await expect(adminIdentity()).resolves.toEqual({
      id: 'admin-1',
      email: 'ada@example.com',
      emailVerified: true,
      realm: 'administrator',
      role: 'admin',
    });
    await expect(adminUsers({ limit: 10, offset: 0, email: ' grace ' })).resolves.toEqual({
      items: [
        {
          id: 'user-1',
          email: 'grace@example.com',
          emailVerified: false,
          realm: 'reader',
          role: 'user',
        },
      ],
      total: 1,
    });
    await expect(adminUserDetail('')).rejects.toMatchObject({ status: 400 });
    await expect(adminUserDetail('u'.repeat(129))).rejects.toMatchObject({ status: 400 });
    await expect(adminUserDetail('user-2')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
    });

    expect(requests).toEqual([
      '/v1/admin/me',
      '/v1/admin/users?limit=10&offset=0&email=grace',
      '/v1/admin/users/user-2',
    ]);
  });
});
