import { PassThrough } from 'node:stream';
import {
  loadEnvironmentFile,
  environmentFilePath,
} from '../../scripts/deploy/environment-config.js';
import { resolveSmokeConfig, runSandboxSmokeWorkflow } from '../../scripts/smoke-sandbox.js';
import {
  runInteractiveSandboxSmoke,
  createLinePrompt,
  type InteractiveSmokePrompts,
} from '../../scripts/smoke-sandbox-interactive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const baseUrl = 'https://sandbox.example.test';
const email = 'qa@example.test';
const password = 'not-printed-password';
const token = 'not-printed-token';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function prompts(
  selection: number | undefined,
  hiddenValues: readonly (string | undefined)[],
): InteractiveSmokePrompts {
  let hiddenIndex = 0;
  return {
    isInteractive: true,
    chooseRecipient: vi.fn(() => Promise.resolve(selection)),
    readHidden: vi.fn(() => Promise.resolve(hiddenValues[hiddenIndex++])),
  };
}

function requestPath(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('prompt settlement timeout'));
        }, 100);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function expectCleanPromptStreams(input: PassThrough, output: PassThrough): void {
  const internalStreamEvents = (stream: PassThrough) =>
    stream.eventNames().filter((event) => event !== 'prefinish');
  expect(internalStreamEvents(input)).toEqual([]);
  expect(internalStreamEvents(output)).toEqual([]);
}

function fullWorkflowFetch(
  readerState: unknown = {
    readerState: 'header.payload.signature',
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  },
): typeof fetch {
  let anonymousMe = true;
  let verifiedLogin = false;
  let sessionActive = false;
  return (input) => {
    const path = new URL(requestPath(input)).pathname;
    if (path === '/v1/health') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
    if (path === '/v1/me') {
      if (anonymousMe && !sessionActive) {
        anonymousMe = false;
        return Promise.resolve(jsonResponse(401, { code: 'unauthenticated' }));
      }
      return Promise.resolve(
        sessionActive
          ? jsonResponse(200, { id: 'user' })
          : jsonResponse(401, { code: 'unauthenticated' }),
      );
    }
    if (path === '/v1/auth/register')
      return Promise.resolve(jsonResponse(201, { emailVerified: false }));
    if (path === '/v1/auth/login') {
      if (!verifiedLogin) {
        verifiedLogin = true;
        return Promise.resolve(jsonResponse(403, { code: 'email-verification-required' }));
      }
      sessionActive = true;
      return Promise.resolve(
        jsonResponse(200, { user: { id: 'user' } }, { 'set-cookie': 'session=opaque' }),
      );
    }
    if (path === '/v1/auth/request-verification')
      return Promise.resolve(jsonResponse(202, { status: 'ok' }));
    if (path === '/v1/auth/verify-email')
      return Promise.resolve(jsonResponse(200, { emailVerified: true }));
    if (path === '/v1/auth/reader-state')
      return Promise.resolve(
        sessionActive
          ? jsonResponse(200, readerState)
          : jsonResponse(401, { code: 'unauthenticated' }),
      );
    if (path === '/v1/auth/sign-out') {
      sessionActive = false;
      return Promise.resolve(jsonResponse(200, { status: 'ok' }));
    }
    throw new Error(`unexpected request ${path}`);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('interactive sandbox smoke', () => {
  it('selects an allowlisted recipient, hides prompts, continues token verification, and redacts output', async () => {
    const environmentFile = loadEnvironmentFile(environmentFilePath('.', 'sandbox'));
    const smokeEmail = environmentFile.AUTH_MAIL_ALLOWLIST.split(',')[0]?.trim() ?? email;
    const prompt = prompts(1, [password, token]);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      output.push(String(message));
    });

    await runInteractiveSandboxSmoke({
      environmentFile,
      prompts: prompt,
      fetchImpl: fullWorkflowFetch(),
    });

    expect(prompt.chooseRecipient).toHaveBeenCalledWith(3);
    expect(prompt.readHidden).toHaveBeenCalledTimes(2);
    expect(output.join('\n')).not.toContain(smokeEmail);
    expect(output.join('\n')).not.toContain(password);
    expect(output.join('\n')).not.toContain(token);
    expect(output.join('\n')).not.toMatch(/cookie|action.?url|response body/i);
  });

  it('runs the authenticated Reader State and logout lifecycle for an already-verified exact recipient', async () => {
    const environmentFile = loadEnvironmentFile(environmentFilePath('.', 'sandbox'));
    const smokeEmail = environmentFile.AUTH_MAIL_ALLOWLIST.split(',')[0]?.trim() ?? email;
    const prompt = prompts(1, [password]);
    const requests: { readonly request: string; readonly cookie: string | null }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const path = new URL(requestPath(input)).pathname;
      requests.push({
        request: `${init?.method ?? 'GET'} ${path}`,
        cookie: new Headers(init?.headers).get('cookie'),
      });
      if (path === '/v1/health') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
      if (path === '/v1/me') {
        return Promise.resolve(
          requests.filter(({ request }) => request.endsWith(' /v1/me')).length === 1
            ? jsonResponse(401, { code: 'unauthenticated' })
            : requests.some(({ request }) => request === 'POST /v1/auth/sign-out')
              ? requests.at(-1)?.cookie === 'session=opaque'
                ? jsonResponse(401, { code: 'unauthenticated' })
                : jsonResponse(200, { id: 'user' })
              : jsonResponse(200, { id: 'user' }),
        );
      }
      if (path === '/v1/auth/register')
        return Promise.resolve(jsonResponse(201, { emailVerified: false }));
      if (path === '/v1/auth/login')
        return Promise.resolve(
          jsonResponse(200, { user: { id: 'user' } }, { 'set-cookie': 'session=opaque' }),
        );
      if (path === '/v1/auth/request-verification')
        return Promise.resolve(jsonResponse(202, { status: 'ok' }));
      if (path === '/v1/auth/reader-state')
        return Promise.resolve(
          requests.some(({ request }) => request === 'POST /v1/auth/sign-out')
            ? requests.at(-1)?.cookie === 'session=opaque'
              ? jsonResponse(401, { code: 'unauthenticated' })
              : jsonResponse(200, {
                  readerState: 'header.payload.signature',
                  expiresAt: Math.floor(Date.now() / 1000) + 900,
                })
            : jsonResponse(200, {
                readerState: 'header.payload.signature',
                expiresAt: Math.floor(Date.now() / 1000) + 900,
              }),
        );
      if (path === '/v1/auth/sign-out') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
      throw new Error(`unexpected request ${path}`);
    };

    await runInteractiveSandboxSmoke({ environmentFile, prompts: prompt, fetchImpl });

    expect(requests.map(({ request }) => request)).toEqual([
      'GET /v1/health',
      'GET /v1/me',
      'POST /v1/auth/register',
      'POST /v1/auth/login',
      'GET /v1/me',
      'POST /v1/auth/request-verification',
      'POST /v1/auth/reader-state',
      'GET /v1/me',
      'POST /v1/auth/sign-out',
      'GET /v1/me',
      'POST /v1/auth/reader-state',
    ]);
    expect(requests.map(({ cookie }) => cookie)).toEqual([
      null,
      null,
      null,
      null,
      'session=opaque',
      null,
      'session=opaque',
      'session=opaque',
      'session=opaque',
      'session=opaque',
      'session=opaque',
    ]);
    expect(smokeEmail).toBeTruthy();
  });

  it('skips a supplied verification token when an exact recipient is already verified', async () => {
    const config = {
      ...resolveSmokeConfig({
        SMOKE_SANDBOX_BASE_URL: baseUrl,
        SMOKE_SANDBOX_EMAIL: email,
        SMOKE_PASSWORD: password,
      }),
      verificationToken: token,
    };
    const paths: string[] = [];
    let signedOut = false;

    await runSandboxSmokeWorkflow(config, {
      fetchImpl: (input, init) => {
        const path = new URL(requestPath(input)).pathname;
        paths.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/v1/health') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
        if (path === '/v1/me')
          return Promise.resolve(
            paths.filter((request) => request === 'GET /v1/me').length === 1
              ? jsonResponse(401, { code: 'unauthenticated' })
              : signedOut
                ? jsonResponse(401, { code: 'unauthenticated' })
                : jsonResponse(200, { id: 'user' }),
          );
        if (path === '/v1/auth/register')
          return Promise.resolve(jsonResponse(201, { emailVerified: false }));
        if (path === '/v1/auth/login')
          return Promise.resolve(
            jsonResponse(200, { user: { id: 'user' } }, { 'set-cookie': 'session=opaque' }),
          );
        if (path === '/v1/auth/request-verification')
          return Promise.resolve(jsonResponse(202, { status: 'ok' }));
        if (path === '/v1/auth/reader-state')
          return Promise.resolve(
            signedOut
              ? jsonResponse(401, { code: 'unauthenticated' })
              : jsonResponse(200, {
                  readerState: 'header.payload.signature',
                  expiresAt: Math.floor(Date.now() / 1000) + 900,
                }),
          );
        if (path === '/v1/auth/sign-out') {
          signedOut = true;
          return Promise.resolve(jsonResponse(200, { status: 'ok' }));
        }
        if (path === '/v1/auth/verify-email') throw new Error('verification token was replayed');
        throw new Error(`unexpected request ${path}`);
      },
    });

    expect(paths).not.toContain('POST /v1/auth/verify-email');
  });

  it.each([
    [{ readerState: 'not-compact', expiresAt: Math.floor(Date.now() / 1000) + 900 }],
    [{ readerState: 'header.payload.signature', expiresAt: 0 }],
    [{ readerState: 'header.payload.signature' }],
  ])('fails closed when Reader State response shape is invalid: %j', async (readerState) => {
    const environmentFile = loadEnvironmentFile(environmentFilePath('.', 'sandbox'));
    await expect(
      runInteractiveSandboxSmoke({
        environmentFile,
        prompts: prompts(1, [password, token]),
        fetchImpl: fullWorkflowFetch(readerState),
      }),
    ).rejects.toThrow('reader-state');
  });

  it('fails clearly for non-interactive input and cancellation without network IO', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const nonInteractive: InteractiveSmokePrompts = {
      isInteractive: false,
      chooseRecipient: vi.fn(() => Promise.resolve(undefined)),
      readHidden: vi.fn(() => Promise.resolve(undefined)),
    };

    await expect(
      runInteractiveSandboxSmoke({
        environmentFile: loadEnvironmentFile(environmentFilePath('.', 'sandbox')),
        prompts: nonInteractive,
        fetchImpl,
      }),
    ).rejects.toThrow(/requires a TTY/);
    await expect(
      runInteractiveSandboxSmoke({
        environmentFile: loadEnvironmentFile(environmentFilePath('.', 'sandbox')),
        prompts: prompts(undefined, []),
        fetchImpl,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid recipient selection before asking for secrets', async () => {
    const prompt = prompts(0, [password]);

    await expect(
      runInteractiveSandboxSmoke({
        environmentFile: loadEnvironmentFile(environmentFilePath('.', 'sandbox')),
        prompts: prompt,
        fetchImpl: vi.fn<typeof fetch>(),
      }),
    ).rejects.toThrow(/invalid recipient selection/);
    expect(prompt.readHidden).not.toHaveBeenCalled();
  });

  it('does not prompt for a token when the first HTTP phase fails', async () => {
    const prompt = prompts(1, [password]);
    const fetchImpl: typeof fetch = (input) => {
      const path = new URL(requestPath(input)).pathname;
      if (path === '/v1/health') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
      if (path === '/v1/me') return Promise.resolve(jsonResponse(401, { code: 'unauthenticated' }));
      return Promise.resolve(jsonResponse(500, { code: 'failed' }));
    };

    await expect(
      runInteractiveSandboxSmoke({
        environmentFile: loadEnvironmentFile(environmentFilePath('.', 'sandbox')),
        prompts: prompt,
        fetchImpl,
      }),
    ).rejects.toThrow(/register/);
    expect(prompt.readHidden).toHaveBeenCalledTimes(1);
  });

  it('keeps environment mode token-free behavior unchanged', async () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: baseUrl,
      SMOKE_SANDBOX_EMAIL: email,
      SMOKE_PASSWORD: password,
    });
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      output.push(String(message));
    });

    await runSandboxSmokeWorkflow(config, {
      fetchImpl: (input) => {
        const path = new URL(requestPath(input)).pathname;
        if (path === '/v1/health') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
        if (path === '/v1/me')
          return Promise.resolve(jsonResponse(401, { code: 'unauthenticated' }));
        if (path === '/v1/auth/register')
          return Promise.resolve(jsonResponse(201, { emailVerified: false }));
        if (path === '/v1/auth/login')
          return Promise.resolve(jsonResponse(403, { code: 'email-verification-required' }));
        return Promise.resolve(jsonResponse(202, { status: 'ok' }));
      },
    });

    expect(output.join('\n')).toContain('skipped-token-not-provided');
  });
});

describe('createLinePrompt readline seam', () => {
  it('returns a normal answer before readline close settles EOF', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = createLinePrompt(input, output)('selection: ');

    input.end('2\n');

    await expect(result).resolves.toBe('2');
  });

  it('returns undefined for an explicit cancel and EOF', async () => {
    const cancelledInput = new PassThrough();
    const cancelled = createLinePrompt(cancelledInput, new PassThrough())('selection: ');
    cancelledInput.end('q\n');

    const eofInput = new PassThrough();
    const eof = createLinePrompt(eofInput, new PassThrough())('selection: ');
    eofInput.end();

    await expect(cancelled).resolves.toBeUndefined();
    await expect(eof).resolves.toBeUndefined();
  });

  it.each(['input', 'output'] as const)(
    'rejects %s errors without uncaught throws or pending promises',
    async (kind) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const result = createLinePrompt(input, output)('selection: ');
      const error = new Error(`${kind} boom`);

      if (kind === 'input') input.emit('error', error);
      else output.emit('error', error);

      await expect(withTimeout(result)).rejects.toThrow(`${kind} boom`);
      expect(input.listenerCount('error')).toBe(0);
      expect(input.listenerCount('data')).toBe(0);
      expect(output.listenerCount('error')).toBe(0);
      expectCleanPromptStreams(input, output);
    },
  );

  it('settles only once when an interface error races close', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = createLinePrompt(input, output)('selection: ');

    input.emit('error', new Error('input boom'));
    input.end();

    await expect(withTimeout(result)).rejects.toThrow('input boom');
    expect(input.listenerCount('error')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
    expectCleanPromptStreams(input, output);
  });

  it('keeps the normal answer when answer and close race', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const result = createLinePrompt(input, output)('selection: ');

    input.end('2\n');

    await expect(withTimeout(result)).resolves.toBe('2');
    expect(input.listenerCount('error')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
    expectCleanPromptStreams(input, output);
  });
});
