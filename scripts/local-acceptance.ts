// Local Identity release acceptance runner (ticket #60, spec #8).
//
// Exercises the complete first Identity release through the running Worker's
// public HTTP boundary against a freshly initialized local D1 database with a
// real configured transactional-mail transport. The operator prepares the
// environment first (`npm run db:local:reset`, `npm run dev:local` with a real
// `AUTH_MAIL_TRANSPORT`), then runs this script once; the runner pauses
// mid-run and prompts for the delivered verification/reset tokens, so a single
// fresh-DB pass completes the real email flows. Tokens may also be
// pre-supplied as environment inputs for a non-interactive run. The runner
// never bypasses those steps through test-only transport state or direct
// database mutation.
//
// Typical local use from a clean clone (each step documented in
// `docs/operations/local-acceptance.md`):
//
// ```bash
// cp .env.example .env
// # select AUTH_MAIL_TRANSPORT=smtp or resend with local-only secrets
// npm run db:local:reset
// npm run dev:local
// ACCEPTANCE_EMAIL="acceptance@example.com" \
//   ACCEPTANCE_PASSWORD="correct-horse-60" \
//   ACCEPTANCE_NEW_PASSWORD="correct-horse-61" \
//   ADMIN_NAME="Site Admin" ADMIN_EMAIL="admin@example.com" \
//   ADMIN_PASSWORD="Correct-horse-41" \
//   npm run acceptance:local
// ```
//
// When the runner reaches each mail stage it prints a prompt naming the
// expected token variable; paste the `token` query parameter from the
// delivered action URL. Terminal echo stays disabled while pasting, so token
// contents never appear in the visible transcript. Pre-supplying
// `ACCEPTANCE_VERIFICATION_TOKEN` and/or `ACCEPTANCE_RESET_TOKEN` in the
// environment skips the corresponding prompt.
//
// Redaction (ADR-0009, ADR-0010): this script logs only HTTP method, path,
// status and stable problem codes plus the non-secret evidence summary
// (commit, transport name, stage outcomes). Names, email addresses,
// passwords, tokens, cookies, action URLs and message bodies never enter its
// output. Automated suites stay deterministic and credential-free on the
// in-memory transport; this operational runner is distinct from ordinary CI
// tests and never runs there.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Ordered runner stages (ticket #60). The reset/migrations/boot prerequisites
// (`npm run db:local:reset` reapplies the canonical migrations;
// `npm run dev:local` boots the Worker) are operator-executed steps evidenced
// via the retained terminal transcript; the runner executes and records every
// stage listed here through the public HTTP boundary, and the machine
// `acceptance-summary` covers exactly these stages.
export const ACCEPTANCE_STAGES = [
  'health',
  'me-anonymous',
  'register',
  'login-unverified',
  'verify-email',
  'login-verified',
  'me-authenticated',
  'sign-out',
  'me-after-sign-out',
  'request-password-reset',
  'reset-password',
  'login-old-rejected',
  'login-new',
  'admin-bootstrap',
] as const;

export type AcceptanceStage = (typeof ACCEPTANCE_STAGES)[number];

export interface LocalAcceptanceConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly newPassword: string;
  readonly verificationToken: string | undefined;
  readonly resetToken: string | undefined;
}

export interface LocalAcceptanceAdmin {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

type AcceptanceEnv = Pick<NodeJS.ProcessEnv, string> & {
  readonly ACCEPTANCE_BASE_URL?: string;
  readonly ACCEPTANCE_EMAIL?: string;
  readonly ACCEPTANCE_PASSWORD?: string;
  readonly ACCEPTANCE_NEW_PASSWORD?: string;
  readonly ACCEPTANCE_VERIFICATION_TOKEN?: string;
  readonly ACCEPTANCE_RESET_TOKEN?: string;
  readonly ADMIN_NAME?: string;
  readonly ADMIN_EMAIL?: string;
  readonly ADMIN_PASSWORD?: string;
};

function readEnv(env: AcceptanceEnv, name: keyof AcceptanceEnv): string {
  return (env[name] ?? '').trim();
}

// Resolves the human-supplied acceptance inputs. Identity and password
// inputs are required before any HTTP stage executes; email-action tokens are
// optional upfront because neither token exists on a freshly reset D1 until
// the runner itself triggers the corresponding real email mid-run. A
// pre-supplied token skips its mid-run prompt; otherwise the runner prompts
// interactively at the stage that needs it. Every failure names the variable
// and the expected shape; values are never echoed, so a missing secret or
// token cannot leak through the error itself.
export function resolveLocalAcceptanceConfig(
  env: AcceptanceEnv = process.env,
): LocalAcceptanceConfig {
  const baseUrl = readEnv(env, 'ACCEPTANCE_BASE_URL');
  const email = readEnv(env, 'ACCEPTANCE_EMAIL');
  const password = readEnv(env, 'ACCEPTANCE_PASSWORD');
  const newPassword = readEnv(env, 'ACCEPTANCE_NEW_PASSWORD');
  if (email.length === 0) {
    throw new Error('ACCEPTANCE_EMAIL is required (address that receives real delivery).');
  }
  if (password.length === 0) {
    throw new Error('ACCEPTANCE_PASSWORD is required (initial sign-in password).');
  }
  if (newPassword.length === 0) {
    throw new Error('ACCEPTANCE_NEW_PASSWORD is required (password set by the reset action).');
  }
  return {
    baseUrl: baseUrl.length > 0 ? baseUrl : 'http://localhost:8787',
    email,
    password,
    newPassword,
    verificationToken: resolveEmailActionToken(env, 'ACCEPTANCE_VERIFICATION_TOKEN'),
    resetToken: resolveEmailActionToken(env, 'ACCEPTANCE_RESET_TOKEN'),
  };
}

export type EmailActionTokenName = 'ACCEPTANCE_VERIFICATION_TOKEN' | 'ACCEPTANCE_RESET_TOKEN';

// Reads an optional email-action token without ever logging its value. An
// empty or missing variable resolves to undefined so the runner can prompt
// for it when its mail stage is reached.
export function resolveEmailActionToken(
  env: AcceptanceEnv = process.env,
  name: EmailActionTokenName,
): string | undefined {
  const value = readEnv(env, name);
  return value.length > 0 ? value : undefined;
}

// Requires an email-action token at the stage that consumes it. Failures name
// the variable and the expected shape; values are never echoed.
export function requireEmailActionToken(
  token: string | undefined,
  name: EmailActionTokenName,
): string {
  if (token === undefined || token.length === 0) {
    throw new Error(`${name} is required (token from the delivered email).`);
  }
  return token;
}

export interface HiddenPromptStreams {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

function isTtyInput(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as { readonly isTTY?: unknown }).isTTY === true
  );
}

// Reads one line without echoing its contents to the terminal. The prompt is
// written to `output`, while readline's own echo goes to a muted sink so
// pasted token contents never appear in the visible transcript. Terminal mode
// keeps the terminal emulator's own echo disabled while reading, which is the
// defect the previous `output: process.stdout` prompt had: the terminal
// echoed every pasted character. Callers must still check for a TTY before
// prompting; this helper only performs the hidden read.
export async function readHiddenLine(
  prompt: string,
  streams: HiddenPromptStreams = {},
): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  output.write(prompt);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input, output: muted, terminal: true });
  try {
    return (await rl.question('')).trim();
  } finally {
    rl.close();
    output.write('\n');
  }
}

// Prompts the operator for a delivered email-action token mid-run. The prompt
// names only the variable; terminal echo stays disabled while the value is
// pasted, so token contents never appear in the visible transcript, and the
// pasted value is never written into logs.
export function promptForEmailActionToken(
  name: EmailActionTokenName,
  streams: HiddenPromptStreams = {},
): Promise<string> {
  const input = streams.input ?? process.stdin;
  if (!isTtyInput(input)) {
    throw new Error(
      `${name} is required (token from the delivered email); re-run with it set in the environment.`,
    );
  }
  const prompt =
    `Open the delivered email, extract the token query parameter from its action URL, ` +
    `and paste it as ${name}: `;
  return readHiddenLine(prompt, streams).then((answer) =>
    requireEmailActionToken(answer.length > 0 ? answer : undefined, name),
  );
}

// Returns the pre-supplied token when present, otherwise prompts mid-run so a
// single fresh-DB pass can complete the real verification/reset flows.
async function resolveInteractiveToken(
  supplied: string | undefined,
  name: EmailActionTokenName,
): Promise<string> {
  if (supplied !== undefined && supplied.length > 0) {
    return supplied;
  }
  const fromEnv = resolveEmailActionToken(process.env, name);
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return promptForEmailActionToken(name);
}

// Resolves the explicit first-admin inputs for the closing bootstrap stage.
// Same redacted-error contract as the standalone bootstrap script; no default
// credential is defined here.
export function resolveLocalAcceptanceAdmin(
  env: AcceptanceEnv = process.env,
): LocalAcceptanceAdmin {
  const name = readEnv(env, 'ADMIN_NAME');
  const email = readEnv(env, 'ADMIN_EMAIL');
  const password = readEnv(env, 'ADMIN_PASSWORD');
  if (name.length === 0) {
    throw new Error('ADMIN_NAME is required (display name for the first administrator).');
  }
  if (email.length === 0) {
    throw new Error('ADMIN_EMAIL is required (email address for the first administrator).');
  }
  if (password.length === 0) {
    throw new Error('ADMIN_PASSWORD is required (password for the first administrator).');
  }
  return { name, email, password };
}

// Local acceptance must target the locally running Worker. Any non-localhost
// target fails closed so real acceptance credentials and email-action tokens
// cannot be sent to a deployed environment from this runner.
export function assertSafeLocalAcceptanceTarget(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Refusing local acceptance without a valid ACCEPTANCE_BASE_URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Refusing local acceptance for a non-HTTP(S) target.');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      'Refusing local acceptance against a non-local target; run sandbox acceptance instead.',
    );
  }
  return url;
}

export interface AcceptanceStageResult {
  readonly stage: string;
  readonly status: number;
  readonly outcome: string;
}

export interface AcceptanceSummaryInput {
  readonly commit: string;
  readonly transport: string;
  readonly results: readonly AcceptanceStageResult[];
  readonly success: boolean;
}

export interface AcceptanceSummary {
  readonly commit: string;
  readonly transport: string;
  readonly stages: readonly string[];
  readonly stageResults: readonly AcceptanceStageResult[];
  readonly success: boolean;
  readonly eligibility: 'eligible' | 'ineligible';
}

// Non-secret evidence record: identifies the exact tested commit, the
// selected transport by name only, and whether each executed stage passed.
// Any failure marks the commit ineligible for sandbox promotion with no
// partial-success interpretation. Only stable stage names, HTTP statuses and
// stable outcomes cross this boundary; secrets and personal data never do.
export function formatAcceptanceSummary(input: AcceptanceSummaryInput): AcceptanceSummary {
  return {
    commit: input.commit,
    transport: input.transport,
    stages: input.results.map((result) => result.stage),
    stageResults: input.results.map((result) => ({
      stage: result.stage,
      status: result.status,
      outcome: result.outcome,
    })),
    success: input.success,
    eligibility: input.success ? 'eligible' : 'ineligible',
  };
}

function resolveTestedCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Minimal dotenv lookup for the ignored local overrides file (ticket #75).
// The documented local procedure keeps `AUTH_MAIL_TRANSPORT` (and local
// secrets) in the root `.env` consumed by `npm run dev:local` via
// `wrangler dev --env-file .env`; the separate `tsx` acceptance process does
// not inherit that file, so transport provenance falls back to reading it
// here. Only the requested non-secret name is ever returned; every other
// entry (notably secrets) is skipped, and no value is ever logged.
export function parseDotEnvValue(content: string, name: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const assignment = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const separator = assignment.indexOf('=');
    if (separator < 0) {
      continue;
    }
    if (assignment.slice(0, separator).trim() !== name) {
      continue;
    }
    let value = assignment.slice(separator + 1).trim();
    const quote = value.charAt(0);
    if (quote === '"' || quote === "'") {
      const closing = value.indexOf(quote, 1);
      value = closing > 0 ? value.slice(1, closing) : value.slice(1);
    } else {
      const comment = value.indexOf('#');
      value = (comment >= 0 ? value.slice(0, comment) : value).trim();
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

const acceptanceRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Resolves the real mail transport name for the acceptance summary. The
// process environment wins so explicit overrides keep working; otherwise the
// documented ignored local overrides file (`<repo>/.env`, the same file
// `npm run dev:local` loads) supplies the name, so the documented command
// works from a clean clone without duplicating the variable. Only the
// transport name crosses this boundary; every other entry from that file
// is discarded, and no secret is ever retained or logged. A
// missing/unreadable file falls through to `unknown` rather than failing
// the run.
export function resolveTransportName(
  env: AcceptanceEnv = process.env,
  rootDir: string = acceptanceRepoRoot,
): string {
  const direct = readEnv(env, 'AUTH_MAIL_TRANSPORT');
  if (direct.length > 0) {
    return direct;
  }
  try {
    const fromFile = parseDotEnvValue(
      readFileSync(resolve(rootDir, '.env'), 'utf8'),
      'AUTH_MAIL_TRANSPORT',
    );
    if (fromFile !== undefined && fromFile.length > 0) {
      return fromFile;
    }
  } catch {
    // No readable overrides file; fall through to unknown.
  }
  return 'unknown';
}

function logStep(label: string, status: number, detail: string): void {
  console.log(JSON.stringify({ level: 'info', step: label, status, detail }));
}

interface ProblemShape {
  readonly code?: unknown;
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

// Compares an application-owned identity address against the acceptance
// address without logging either value; mismatches fail with a static detail.
function isExpectedIdentity(payload: unknown, email: string): boolean {
  return stringField(payload, 'email')?.trim().toLowerCase() === email.trim().toLowerCase();
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
  throw new Error(`Local acceptance failed at ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const config = resolveLocalAcceptanceConfig();
  const admin = resolveLocalAcceptanceAdmin();
  assertSafeLocalAcceptanceTarget(config.baseUrl);
  const base = config.baseUrl.replace(/\/+$/, '');
  const commit = resolveTestedCommit();
  const transport = resolveTransportName();
  const results: AcceptanceStageResult[] = [];
  const record = (stage: string, status: number, outcome: string): void => {
    results.push({ stage, status, outcome });
  };

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
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const payload = await readJson(res);
    // Successful (2xx) stages record a stable pass; failures record the
    // stable problem code so per-stage evidence shows whether each stage
    // passed without carrying secrets or personal data.
    const outcome = res.ok ? 'pass' : problemCode(payload);
    logStep(label, res.status, outcome);
    record(label, res.status, outcome);
    return { res, payload };
  };

  try {
    // Health through the running Worker before Identity steps begin.
    const health = await request('health', '/v1/health');
    if (health.res.status !== 200 || stringField(health.payload, 'status') !== 'ok') {
      fail('health', health.res.status, 'expected 200 {status:"ok"}');
    }

    // Anonymous identity boundary.
    const anonymous = await request('me-anonymous', '/v1/me');
    if (anonymous.res.status !== 401 || problemCode(anonymous.payload) !== 'unauthenticated') {
      fail('me-anonymous', anonymous.res.status, 'expected 401 unauthenticated');
    }

    // Registration through the public API; the real verification email leaves
    // through the locally selected SMTP or Resend transport.
    const register = await request('register', '/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Local Acceptance',
        email: config.email,
        password: config.password,
      }),
    });
    if (register.res.status !== 201 || booleanField(register.payload, 'emailVerified') !== false) {
      fail('register', register.res.status, 'expected 201 with emailVerified:false');
    }
    if (!isExpectedIdentity(register.payload, config.email)) {
      fail('register', register.res.status, 'expected the registered application-owned identity');
    }

    // Verification gate while the policy requires verified email.
    const gated = await request('login-unverified', '/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    if (gated.res.status !== 403 || problemCode(gated.payload) !== 'email-verification-required') {
      fail('login-unverified', gated.res.status, 'expected 403 email-verification-required');
    }

    // Human-completed verification from the delivered email. The token does
    // not exist until this run's registration email arrives, so resolve it
    // here: use the pre-supplied environment value when present, otherwise
    // pause and prompt mid-run for a single fresh-DB pass.
    const verificationToken = await resolveInteractiveToken(
      config.verificationToken,
      'ACCEPTANCE_VERIFICATION_TOKEN',
    );
    const verify = await request('verify-email', '/v1/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verificationToken }),
    });
    if (verify.res.status !== 200 || booleanField(verify.payload, 'emailVerified') !== true) {
      fail('verify-email', verify.res.status, 'expected 200 with emailVerified:true');
    }

    // Sign in after verification and resolve the application-owned identity.
    const login = await request('login-verified', '/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    if (login.res.status !== 200) {
      fail('login-verified', login.res.status, 'expected 200 after verification');
    }
    const session = cookieHeader(login.res);
    if (session === undefined) {
      fail('login-verified', login.res.status, 'expected a session cookie after verification');
    }
    const me = await request('me-authenticated', '/v1/me', {}, session);
    if (me.res.status !== 200) {
      fail('me-authenticated', me.res.status, 'expected 200 for the verified session');
    }
    if (
      !isExpectedIdentity(me.payload, config.email) ||
      booleanField(me.payload, 'emailVerified') !== true
    ) {
      fail('me-authenticated', me.res.status, 'expected the verified application-owned identity');
    }

    // Sign-out invalidates the current session.
    const signOut = await request('sign-out', '/v1/auth/sign-out', { method: 'POST' }, session);
    if (signOut.res.status !== 200) {
      fail('sign-out', signOut.res.status, 'expected 200 on sign-out');
    }
    const afterSignOut = await request('me-after-sign-out', '/v1/me', {}, session);
    if (afterSignOut.res.status !== 401) {
      fail(
        'me-after-sign-out',
        afterSignOut.res.status,
        'expected the signed-out session to stop resolving',
      );
    }

    // Password recovery without account-enumeration leakage, through the same
    // real transport. The unknown address must answer identically.
    const recovery = await request('request-password-reset', '/v1/auth/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: config.email }),
    });
    if (recovery.res.status !== 202) {
      fail('request-password-reset', recovery.res.status, 'expected 202 {status:"ok"}');
    }
    const unknownRecovery = await request(
      'request-password-reset',
      '/v1/auth/request-password-reset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `unknown-${crypto.randomUUID()}@example.invalid` }),
      },
    );
    if (unknownRecovery.res.status !== 202) {
      fail(
        'request-password-reset',
        unknownRecovery.res.status,
        'expected identical 202 for unknown addresses',
      );
    }

    // Human-completed reset from the delivered email. Like verification, the
    // token only exists after this run's recovery email arrives, so resolve
    // it here with an optional mid-run prompt.
    const resetToken = await resolveInteractiveToken(config.resetToken, 'ACCEPTANCE_RESET_TOKEN');
    const reset = await request('reset-password', '/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: config.newPassword }),
    });
    if (reset.res.status !== 200) {
      fail('reset-password', reset.res.status, 'expected 200 on password reset');
    }

    // Old password rejected, new password establishes a session.
    const oldLogin = await request('login-old-rejected', '/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    if (oldLogin.res.status !== 401 || problemCode(oldLogin.payload) !== 'invalid-credentials') {
      fail('login-old-rejected', oldLogin.res.status, 'expected 401 invalid-credentials');
    }
    const newLogin = await request('login-new', '/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.newPassword }),
    });
    if (newLogin.res.status !== 200) {
      fail('login-new', newLogin.res.status, 'expected 200 with the new password');
    }
    if (
      !isExpectedIdentity(newLogin.payload, config.email) ||
      booleanField(newLogin.payload, 'emailVerified') !== true
    ) {
      fail('login-new', newLogin.res.status, 'expected the verified application-owned identity');
    }

    // First-admin bootstrap against the same fresh environment.
    const bootstrap = await request('admin-bootstrap', '/v1/auth/admin/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: admin.name, email: admin.email, password: admin.password }),
    });
    if (bootstrap.res.status !== 201 || stringField(bootstrap.payload, 'role') !== 'admin') {
      fail('admin-bootstrap', bootstrap.res.status, 'expected 201 with role:admin');
    }

    console.log(
      JSON.stringify({
        level: 'info',
        step: 'acceptance-summary',
        ...formatAcceptanceSummary({ commit, transport, results, success: true }),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'error',
        step: 'acceptance-summary',
        ...formatAcceptanceSummary({ commit, transport, results, success: false }),
      }),
    );
    throw error instanceof Error ? error : new Error('Local acceptance failed.');
  }
}

const invokedDirectly = process.argv[1]?.endsWith('local-acceptance.ts') === true;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.log(JSON.stringify({ level: 'error', step: 'acceptance', status: 0, detail: message }));
    process.exitCode = 1;
  });
}
