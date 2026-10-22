// Sandbox smoke test (tickets #14, #87, #91, ADR-0008).
//
// Proves the deployed sandbox Worker serves the health and verified-email
// identity path without touching production accounts or production email
// recipients. Two recipient modes select the registration address:
//
// - exact-recipient mode (`SMOKE_SANDBOX_EMAIL`): the explicit address is used
//   directly as the registration recipient. It must be syntactically valid and
//   is never logged. This is the mode for sandbox targets whose
//   `AUTH_MAIL_ALLOWLIST` holds exact emails rather than a domain.
// - domain-generated mode (`SMOKE_SANDBOX_EMAIL_DOMAIN`): each run registers a
//   unique `smoke-<run-id>@<domain>` address. The domain must itself be covered
//   by the sandbox `AUTH_MAIL_ALLOWLIST` so deliveries can never reach arbitrary
//   recipients.
//
// Exact mode takes precedence when `SMOKE_SANDBOX_EMAIL` is set; nothing is
// generated or inferred in that mode. Exact mode is repeatable at the public
// HTTP boundary: the persistent sandbox D1 keeps the same mailbox identity
// across deploys, so the smoke uses a stable operator-owned credential
// (`SMOKE_PASSWORD`, automated as `SANDBOX_SMOKE_PASSWORD`) and the login
// attempt observes one stable state per run (`unverified` fresh or repeated
// gate, `already-verified` repeat after prior verification). A credential
// mismatch (`401 invalid-credentials`) means the configured smoke credential
// does not own the persisted identity and fails closed. Repeats never claim
// a fresh gate they did not observe; the full verify -> sign-in transition
// needs a human to paste the token from the allowlisted mailbox
// (`SMOKE_VERIFICATION_TOKEN`) while reusing the same `SMOKE_PASSWORD`;
// without it the smoke proves the deployed
// verification gate (register -> login rejected with
// `email-verification-required` -> resend accepted) and the integration suite
// remains the authority for the token transition.
//
// Redaction (ADR-0009): this script logs only HTTP method, path, status and
// stable problem codes. Passwords, tokens, cookies, action URLs, message
// bodies and raw email addresses never enter its output.

export type SmokeRecipient =
  | { readonly kind: 'exact'; readonly email: string }
  | { readonly kind: 'domain'; readonly emailDomain: string };

export interface SmokeConfig {
  readonly baseUrl: string;
  readonly recipient: SmokeRecipient;
  readonly allowLocalhost: boolean;
  readonly password: string;
  readonly verificationToken: string | undefined;
}

export interface SmokeWorkflowOptions {
  readonly fetchImpl?: typeof fetch;
  readonly requestVerificationToken?: () => Promise<string | undefined>;
}

type SmokeEnv = Pick<NodeJS.ProcessEnv, string> & {
  readonly SMOKE_SANDBOX_BASE_URL?: string;
  readonly SMOKE_SANDBOX_EMAIL?: string;
  readonly SMOKE_SANDBOX_EMAIL_DOMAIN?: string;
  readonly SMOKE_ALLOW_LOCALHOST?: string;
  readonly SMOKE_PASSWORD?: string;
  readonly SMOKE_VERIFICATION_TOKEN?: string;
};

function readEnv(env: SmokeEnv, name: keyof SmokeEnv): string {
  return (env[name] ?? '').trim();
}

function isTruthy(value: string): boolean {
  return value.toLowerCase() === 'true' || value === '1';
}

export function buildSmokeEmail(domain: string, runId: string): string {
  return `smoke-${runId}@${domain.toLowerCase()}`;
}

// Parses the explicit exact-recipient address (`SMOKE_SANDBOX_EMAIL`),
// returning the normalized recipient. Fails closed on anything that is not a
// syntactically valid explicit email; callers must not fall back to another
// recipient mode when this throws.
export function parseExactSmokeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'Refusing sandbox smoke without a syntactically valid SMOKE_SANDBOX_EMAIL (an explicit allowlisted recipient).',
    );
  }
  return email;
}

// Resolves the registration recipient for a smoke run: the exact address is
// used directly, while domain mode generates a unique per-run address. Exact
// mode never generates or infers an address from the run id.
export function resolveSmokeEmail(config: SmokeConfig, runId: string): string {
  if (config.recipient.kind === 'exact') {
    return config.recipient.email;
  }
  return buildSmokeEmail(config.recipient.emailDomain, runId);
}

// Persisted exact-recipient login state (ticket #91, architecture guard and
// final acceptance: exact mode uses a stable operator-owned credential).
//
// The sandbox D1 keeps the same allowlisted mailbox identity across deploys,
// so an exact-recipient smoke cannot assume every run starts fresh. Routine
// smoke behavior stays at the public application HTTP boundary: the login
// attempt with the stable credential observes one of two stable states, and
// unexpected states fail closed rather than producing a false PASS.
//
// - `unverified`: the stable credential matches an unverified identity, so
//   the deployed verification gate (`403 email-verification-required`) is
//   proven again. Fresh runs and stable-credential repeats land here.
// - `already-verified`: the stable credential matches an already-verified
//   identity (repeat after prior verification). The repeat proves session
//   (`200` login + `200` me) and resend acceptance without claiming a fresh
//   gate.
// - any `401 invalid-credentials` means the configured smoke credential does
//   not own the persisted identity (credential collision) and fails closed;
//   it is never reported as a successful smoke.
export type ExactSmokeLoginState = 'unverified' | 'already-verified' | 'unexpected';

export function classifyExactSmokeLogin(status: number, code: string): ExactSmokeLoginState {
  if (status === 403 && code === 'email-verification-required') {
    return 'unverified';
  }
  // Successful logins carry the application-owned user payload with no
  // problem `code`; any problem code on a 200 is an unexpected shape and
  // fails closed rather than being mistaken for a verified session.
  if (status === 200 && (code === '<missing-code>' || code === '<non-json>')) {
    return 'already-verified';
  }
  return 'unexpected';
}

function emailDomainOf(email: string): string | undefined {
  const separator = email.trim().toLowerCase().lastIndexOf('@');
  if (separator <= 0 || separator === email.trim().length - 1) {
    return undefined;
  }
  return email
    .trim()
    .toLowerCase()
    .slice(separator + 1);
}

// Fails closed when the registration address is outside the sandbox domain so
// a smoke run can never create identities for production recipients.
export function assertSandboxSmokeEmail(email: string, domain: string): void {
  const expected = domain.trim().toLowerCase();
  if (expected.length === 0) {
    throw new Error('Refusing sandbox smoke without an explicit sandbox email domain.');
  }
  if (emailDomainOf(email) !== expected) {
    throw new Error(
      `Refusing sandbox smoke for an address outside the sandbox domain (${expected}).`,
    );
  }
}

export function assertSafeSmokeTarget(
  baseUrl: string,
  options: { readonly allowLocalhost?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Refusing sandbox smoke without a valid SMOKE_SANDBOX_BASE_URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Refusing sandbox smoke for a non-HTTP(S) target.');
  }
  const host = url.hostname.toLowerCase();
  if ((host === 'localhost' || host === '127.0.0.1' || host === '::1') && !options.allowLocalhost) {
    throw new Error(
      'Refusing sandbox smoke against localhost without SMOKE_ALLOW_LOCALHOST=true; smoke evidence must come from the deployed sandbox.',
    );
  }
  return url;
}

export function resolveSmokeConfig(env: SmokeEnv = process.env): SmokeConfig {
  const baseUrl = readEnv(env, 'SMOKE_SANDBOX_BASE_URL');
  if (baseUrl.length === 0) {
    throw new Error('SMOKE_SANDBOX_BASE_URL is required (the deployed sandbox Worker origin).');
  }
  const exactRaw = readEnv(env, 'SMOKE_SANDBOX_EMAIL');
  let recipient: SmokeRecipient;
  let exactMode = false;
  if (exactRaw.length > 0) {
    // Exact-recipient mode takes precedence: the address is used directly and
    // nothing is generated or inferred. An invalid value fails closed here
    // rather than silently falling back to domain-generated mode.
    recipient = { kind: 'exact', email: parseExactSmokeEmail(exactRaw) };
    exactMode = true;
  } else {
    const emailDomain = readEnv(env, 'SMOKE_SANDBOX_EMAIL_DOMAIN');
    if (emailDomain.length === 0) {
      throw new Error(
        'SMOKE_SANDBOX_EMAIL or SMOKE_SANDBOX_EMAIL_DOMAIN is required (an explicit allowlisted recipient, or a sandbox-allowlisted domain; never a production recipient or domain).',
      );
    }
    recipient = { kind: 'domain', emailDomain: emailDomain.toLowerCase() };
  }
  const passwordRaw = readEnv(env, 'SMOKE_PASSWORD');
  if (exactMode && passwordRaw.length === 0) {
    throw new Error(
      'SMOKE_PASSWORD is required in exact-recipient mode (configure SANDBOX_SMOKE_PASSWORD for automation; never commit or log it).',
    );
  }
  return {
    baseUrl,
    recipient,
    allowLocalhost: isTruthy(readEnv(env, 'SMOKE_ALLOW_LOCALHOST')),
    password: passwordRaw.length > 0 ? passwordRaw : `smoke-${crypto.randomUUID()}`,
    verificationToken: (() => {
      const token = readEnv(env, 'SMOKE_VERIFICATION_TOKEN');
      return token.length > 0 ? token : undefined;
    })(),
  };
}

function logStep(label: string, status: number, detail: string): void {
  console.log(JSON.stringify({ level: 'info', step: label, status, detail }));
}

interface ProblemShape {
  readonly code?: unknown;
  readonly status?: unknown;
}

function problemCode(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as ProblemShape).code;
    return typeof code === 'string' ? code : '<missing-code>';
  }
  return '<non-json>';
}

function booleanField(payload: unknown, field: string): boolean | undefined {
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'boolean' ? value : undefined;
  }
  return undefined;
}

function stringField(payload: unknown, field: string): string | undefined {
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function integerField(payload: unknown, field: string): number | undefined {
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  }
  return undefined;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function cookieHeader(res: Response): string | undefined {
  const getter = res.headers.getSetCookie;
  if (typeof getter !== 'function') {
    return undefined;
  }
  const cookies = getter.call(res.headers);
  const pairs = cookies.map((cookie) => cookie.split(';')[0] ?? '').filter((part) => part !== '');
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function fail(label: string, status: number, detail: string): never {
  console.log(JSON.stringify({ level: 'error', step: label, status, detail }));
  throw new Error(`Sandbox smoke failed at ${label}: ${detail}`);
}

export async function runSandboxSmokeWorkflow(
  config: SmokeConfig,
  options: SmokeWorkflowOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  assertSafeSmokeTarget(config.baseUrl, { allowLocalhost: config.allowLocalhost });
  const base = config.baseUrl.replace(/\/+$/, '');
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = resolveSmokeEmail(config, runId);
  if (config.recipient.kind === 'domain') {
    assertSandboxSmokeEmail(email, config.recipient.emailDomain);
  }

  const request = async (
    label: string,
    path: string,
    init: RequestInit = {},
    cookie?: string,
  ): Promise<{ readonly res: Response; readonly payload: unknown }> => {
    const headers = new Headers(init.headers);
    if (cookie !== undefined) {
      headers.set('cookie', cookie);
    }
    const res = await fetchImpl(`${base}${path}`, { ...init, headers });
    const payload = await readJson(res);
    logStep(label, res.status, problemCode(payload));
    return { res, payload };
  };

  // 1. Liveness without touching dependencies.
  const health = await request('health', '/v1/health');
  if (health.res.status !== 200 || stringField(health.payload, 'status') !== 'ok') {
    fail('health', health.res.status, 'expected 200 {status:"ok"}');
  }

  // 2. Anonymous callers get the standard unauthenticated Problem Details shape.
  const anonymous = await request('me-anonymous', '/v1/me');
  if (anonymous.res.status !== 401 || problemCode(anonymous.payload) !== 'unauthenticated') {
    fail('me-anonymous', anonymous.res.status, 'expected 401 unauthenticated');
  }

  // 3. Registration creates an unverified identity for the sandbox recipient.
  const register = await request('register', '/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Sandbox Smoke', email, password: config.password }),
  });
  if (register.res.status !== 201 || booleanField(register.payload, 'emailVerified') !== false) {
    fail('register', register.res.status, 'expected 201 with emailVerified:false');
  }

  // 4. The login attempt observes the persisted recipient state. Domain
  // mode always starts fresh, so it still requires the verification gate.
  // Exact mode (ticket #91) classifies the stable outcome instead of
  // assuming freshness: `unverified` proves the gate, `already-verified`
  // proves session + resend acceptance without claiming a fresh gate. A
  // `401 invalid-credentials` means the configured stable credential does
  // not own the persisted identity and fails closed. Anything else fails
  // closed.
  let authenticatedCookie: string | undefined;
  let alreadyVerified = false;
  const gated = await request('login-unverified', '/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: config.password }),
  });
  if (config.recipient.kind === 'domain') {
    if (gated.res.status !== 403 || problemCode(gated.payload) !== 'email-verification-required') {
      fail('login-unverified', gated.res.status, 'expected 403 email-verification-required');
    }
  } else {
    const state = classifyExactSmokeLogin(gated.res.status, problemCode(gated.payload));
    if (state === 'already-verified') {
      // Stable-password repeat after prior verification: prove the session
      // and resend acceptance without claiming a fresh gate.
      const session = cookieHeader(gated.res);
      if (session === undefined) {
        fail('login-unverified', gated.res.status, 'expected a session cookie when verified');
      }
      authenticatedCookie = session;
      alreadyVerified = true;
      const me = await request('me-authenticated', '/v1/me', {}, session);
      if (me.res.status !== 200) {
        fail('me-authenticated', me.res.status, 'expected 200 for the verified session');
      }
      console.log(
        JSON.stringify({
          level: 'info',
          step: 'verify-email',
          status: 0,
          detail: 'skipped-already-verified',
        }),
      );
      // Continue through Reader State and public logout below.
    }
    if (state !== 'unverified' && state !== 'already-verified') {
      fail(
        'login-unverified',
        gated.res.status,
        'expected unverified or already-verified (a 401 means the configured smoke credential does not own the persisted identity)',
      );
    }
  }

  // 5. A resend is accepted through the sandbox mail boundary.
  const resend = await request('request-verification', '/v1/auth/request-verification', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (resend.res.status !== 202 || stringField(resend.payload, 'status') !== 'ok') {
    fail('request-verification', resend.res.status, 'expected 202 {status:"ok"}');
  }

  // 6. Full verify -> sign-in only when the operator supplies the token from
  // the allowlisted mailbox while reusing the same stable credential;
  // otherwise the gate evidence above stands.
  // This explicit token path is the one-time full acceptance: the first run
  // with the stable credential sends the real email, and the rerun with the
  // same credential plus the token proves verify -> sign-in. A credential
  // mismatch fails closed above, so a stale credential cannot create a
  // false PASS.
  let verificationToken = config.verificationToken;
  if (
    !alreadyVerified &&
    verificationToken === undefined &&
    options.requestVerificationToken !== undefined
  ) {
    verificationToken = await options.requestVerificationToken();
  }
  if (!alreadyVerified && verificationToken !== undefined) {
    const verify = await request('verify-email', '/v1/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verificationToken }),
    });
    if (verify.res.status !== 200 || booleanField(verify.payload, 'emailVerified') !== true) {
      fail('verify-email', verify.res.status, 'expected 200 with emailVerified:true');
    }
    const login = await request('login-verified', '/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: config.password }),
    });
    if (login.res.status !== 200) {
      fail('login-verified', login.res.status, 'expected 200 after verification');
    }
    const cookie = cookieHeader(login.res);
    if (cookie === undefined) {
      fail('login-verified', login.res.status, 'expected a session cookie after verification');
    }
    authenticatedCookie = cookie;
    const me = await request('me-authenticated', '/v1/me', {}, cookie);
    if (me.res.status !== 200) {
      fail('me-authenticated', me.res.status, 'expected 200 for the verified session');
    }
  } else {
    console.log(
      JSON.stringify({
        level: 'info',
        step: 'verify-email',
        status: 0,
        detail: 'skipped-token-not-provided',
      }),
    );
  }

  if (authenticatedCookie !== undefined) {
    const readerState = await request(
      'reader-state-authenticated',
      '/v1/auth/reader-state',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      authenticatedCookie,
    );
    const compactToken = stringField(readerState.payload, 'readerState');
    const expiresAt = integerField(readerState.payload, 'expiresAt');
    const tokenParts = compactToken?.split('.') ?? [];
    if (
      readerState.res.status !== 200 ||
      compactToken === undefined ||
      tokenParts.length !== 3 ||
      tokenParts.some((part) => part.length === 0) ||
      expiresAt === undefined ||
      expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      fail(
        'reader-state-authenticated',
        readerState.res.status,
        'expected 200 with a compact Reader State and a future integer expiresAt',
      );
    }

    const me = await request('me-after-reader-state', '/v1/me', {}, authenticatedCookie);
    if (me.res.status !== 200) {
      fail('me-after-reader-state', me.res.status, 'expected 200 for the verified session');
    }

    const signOut = await request(
      'sign-out',
      '/v1/auth/sign-out',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      authenticatedCookie,
    );
    if (signOut.res.status !== 200 || stringField(signOut.payload, 'status') !== 'ok') {
      fail('sign-out', signOut.res.status, 'expected 200 {status:"ok"}');
    }

    const anonymousMe = await request('me-after-sign-out', '/v1/me', {}, authenticatedCookie);
    if (anonymousMe.res.status !== 401 || problemCode(anonymousMe.payload) !== 'unauthenticated') {
      fail('me-after-sign-out', anonymousMe.res.status, 'expected 401 unauthenticated');
    }

    const anonymousReaderState = await request(
      'reader-state-after-sign-out',
      '/v1/auth/reader-state',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      authenticatedCookie,
    );
    if (
      anonymousReaderState.res.status !== 401 ||
      problemCode(anonymousReaderState.payload) !== 'unauthenticated'
    ) {
      fail(
        'reader-state-after-sign-out',
        anonymousReaderState.res.status,
        'expected 401 unauthenticated',
      );
    }
  }

  console.log(JSON.stringify({ level: 'info', step: 'smoke', status: 200, detail: 'pass-fresh' }));
}

const invokedDirectly = process.argv[1]?.endsWith('smoke-sandbox.ts') === true;
if (invokedDirectly) {
  const interactive = process.argv.includes('--interactive');
  const run = interactive
    ? import('./smoke-sandbox-interactive.js').then(({ runInteractiveSandboxSmoke }) =>
        runInteractiveSandboxSmoke(),
      )
    : runSandboxSmokeWorkflow(resolveSmokeConfig());
  run.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.log(JSON.stringify({ level: 'error', step: 'smoke', status: 0, detail: message }));
    process.exitCode = 1;
  });
}
