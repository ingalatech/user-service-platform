import {
  loadEnvironmentFile,
  environmentFilePath,
} from '../../scripts/deploy/environment-config.js';
import { resolveSmokeConfig, runSandboxSmokeWorkflow } from '../../scripts/smoke-sandbox.js';
import {
  runInteractiveSandboxSmoke,
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

function fullWorkflowFetch(): typeof fetch {
  let anonymousMe = true;
  let verifiedLogin = false;
  return (input) => {
    const path = new URL(requestPath(input)).pathname;
    if (path === '/v1/health') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
    if (path === '/v1/me') {
      if (anonymousMe) {
        anonymousMe = false;
        return Promise.resolve(jsonResponse(401, { code: 'unauthenticated' }));
      }
      return Promise.resolve(jsonResponse(200, { id: 'user' }));
    }
    if (path === '/v1/auth/register')
      return Promise.resolve(jsonResponse(201, { emailVerified: false }));
    if (path === '/v1/auth/login') {
      if (!verifiedLogin) {
        verifiedLogin = true;
        return Promise.resolve(jsonResponse(403, { code: 'email-verification-required' }));
      }
      return Promise.resolve(
        jsonResponse(200, { user: { id: 'user' } }, { 'set-cookie': 'session=opaque' }),
      );
    }
    if (path === '/v1/auth/request-verification')
      return Promise.resolve(jsonResponse(202, { status: 'ok' }));
    if (path === '/v1/auth/verify-email')
      return Promise.resolve(jsonResponse(200, { emailVerified: true }));
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
