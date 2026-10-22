import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Fixture-owned issuer/audience: the disposable Worker configures its own
// values and the shipped client verifies exactly them. Production token
// lifetime is unchanged; the fixture uses a short TTL plus stored-expiry
// manipulation instead of long real waits.
const FIXTURE_ISSUER = 'https://consumer-fixture.example';
const FIXTURE_AUDIENCE = 'consumer-fixture-reader-state';
const FIXTURE_TTL_SECONDS = '120';
// Two separate real document URLs on the Worker origin. These service-owned
// fallback pages need no frontend build and make no requests without a query
// token, so every counted identity call comes from the shipped client.
const DOC_A = '/auth-actions/verify-email';
const DOC_B = '/auth-actions/reset-password';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Consumer browser assertion: ${message}`);
}

async function command(label: string, args: string[]): Promise<void> {
  try {
    await exec(process.execPath, args, { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    // Command output can contain fixture data: expose only a stable stage.
    throw new Error(`Consumer browser setup failed: ${label}`, { cause });
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'TCP port allocated');
  const port = address.port;
  await new Promise<void>((done, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else done();
    }),
  );
  return port;
}

async function stopWorker(child: ChildProcess): Promise<void> {
  const running = () => {
    if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!running()) return;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* Already exited. */
    }
  };
  kill('SIGTERM');
  for (let i = 0; i < 20 && running(); i++) await pause(100);
  if (running()) kill('SIGKILL');
}

interface TrackedRequests {
  readonly me: number;
  readonly readerState: number;
  readonly jwks: number;
}

// Request observation across real page navigations. Counts live behind a
// snapshot boundary so single-page assertions never fight control-flow
// narrowing; every counted call is a genuine client request, never a mock.
function createTracker() {
  let me = 0;
  let readerState = 0;
  let jwks = 0;
  return {
    watch(page: Page): void {
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/v1/me') me += 1;
        else if (pathname === '/v1/auth/reader-state') readerState += 1;
        else if (pathname === '/v1/auth/jwks') jwks += 1;
      });
    },
    reset(): void {
      me = 0;
      readerState = 0;
      jwks = 0;
    },
    snapshot(): TrackedRequests {
      return { me, readerState, jwks };
    },
  };
}

// Installs the shipped client bundle and fixture scope once per document,
// then runs one action and returns its JSON outcome. Browser code travels as
// strings (the repository compiles without DOM globals); only request counts
// and stable outcomes cross back — never raw tokens.
async function browserJson(page: Page, body: string): Promise<unknown> {
  const raw = await page.evaluate<string>(
    `(async () => { ${ENSURE_CLIENT} ${body} })().then((value) => JSON.stringify(value ?? null))`,
  );
  return JSON.parse(raw) as unknown;
}

const ENSURE_CLIENT = `
  window.__consumer = window.__consumer ?? ConsumerClient.createConsumerClient({
    baseUrl: window.location.origin,
    issuer: window.__cfg.issuer,
    audience: window.__cfg.audience,
    nowSeconds: () => Math.floor(Date.now() / 1000) + (window.__clockOffset ?? 0),
    fetchImpl: async (request, init) => {
      const response = await fetch(request, init);
       if (new URL(request.url).pathname === '/v1/auth/reader-state' && response.ok) window.__clockOffset = 0;
      return response;
    },
  });
  const client = window.__consumer;
`;

async function installClient(page: Page, bundle: string): Promise<void> {
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    `window.__cfg = ${JSON.stringify({ issuer: FIXTURE_ISSUER, audience: FIXTURE_AUDIENCE })};`,
  );
}

function outcomeOf(expression: string): string {
  return `
    try {
      const value = await (${expression});
      return { ok: true, value };
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'unknown-error';
      return { ok: false, code };
    }
  `;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Real shipped-client + real built Worker/D1 browser fixture. Two document
// URLs exercise actual localStorage across full navigations, reloads and tabs;
// every Identity and Reader State renewal call is observed, never mocked. Fixture-only
// mail capture uses the public AuthMailer injection seam in a temporary
// Worker entrypoint. Registration, verification and login use the real API;
// the mailbox route exists only in this disposable loopback fixture.
export async function runConsumerBrowserTest(): Promise<void> {
  const state = await mkdtemp(join(tmpdir(), 'user-service-consumer-'));
  let worker: ChildProcess | undefined;
  let browser: Browser | undefined;
  let diagnosticPage: Page | undefined;
  let phase = 'setup';
  try {
    const config = join(state, 'wrangler.jsonc');
    const persist = join(state, 'd1');
    const envFile = join(state, '.env');
    const assetsDir = join(state, 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(envFile, '');
    await writeFile(join(state, '.dev.vars'), '');
    const entry = join(state, 'fixture-worker.ts');
    await writeFile(
      entry,
      `
import { createApp } from ${JSON.stringify(join(root, 'src/app.ts'))};
import { InMemoryAuthMailer } from ${JSON.stringify(join(root, 'src/features/identity/index.ts'))};
const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });
export default {
  fetch(request, env, context) {
    if (new URL(request.url).pathname === '/__fixture/verification-mail') {
      const message = mailer.sent.at(-1);
      return Response.json({ token: message?.token ?? null }, { headers: { 'cache-control': 'no-store' } });
    }
    return app.fetch(request, env, context);
  }
};
`,
    );
    const original = await readFile(join(root, 'wrangler.jsonc'), 'utf8');
    await writeFile(
      config,
      original
        .replace('"main": "src/index.ts"', `"main": ${JSON.stringify(entry)}`)
        .replace('"directory": "./admin/dist"', `"directory": ${JSON.stringify(assetsDir)}`)
        .replace(
          '"migrations_dir": "drizzle"',
          `"migrations_dir": ${JSON.stringify(join(root, 'drizzle'))}`,
        )
        .replace(
          '"ENVIRONMENT": "local",',
          `"ENVIRONMENT": "local",\n    "AUTH_JWT_ISSUER": ${JSON.stringify(FIXTURE_ISSUER)},\n    "AUTH_READER_STATE_AUDIENCE": ${JSON.stringify(FIXTURE_AUDIENCE)},\n    "AUTH_READER_STATE_TTL_SECONDS": ${JSON.stringify(FIXTURE_TTL_SECONDS)},`,
        ),
    );
    const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
    const flags = ['--config', config, '--env-file', envFile, '--local', '--persist-to', persist];
    await command('isolated migrations', [cli, 'd1', 'migrations', 'apply', 'DB', ...flags]);
    const port = await availablePort();
    const inspectorPort = await availablePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const processState = { spawnFailed: false };
    worker = spawn(
      process.execPath,
      [
        cli,
        'dev',
        ...flags,
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        String(inspectorPort),
      ],
      {
        cwd: root,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
      },
    );
    worker.once('error', () => {
      processState.spawnFailed = true;
    });
    const http = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
    let ready = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      assert(
        !processState.spawnFailed && worker.exitCode === null && worker.signalCode === null,
        'Worker stays running',
      );
      try {
        const health = await http('/v1/health');
        await health.arrayBuffer();
        ready = health.ok;
      } catch {
        /* Still starting. */
      }
      if (ready) break;
      await pause(250);
    }
    assert(ready, 'Worker readiness within 60 seconds');
    phase = 'bundle shipped client';
    const bundlePath = join(state, 'consumer-client.js');
    await exec(join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
      join(root, 'src', 'features', 'identity', 'consumer-client', 'index.ts'),
      '--bundle',
      '--format=iife',
      '--global-name=ConsumerClient',
      '--platform=browser',
      `--outfile=${bundlePath}`,
      '--log-level=error',
    ]);
    const bundle = await readFile(bundlePath, 'utf8');
    assert(bundle.includes('createConsumerClient'), 'bundle exposes the shipped entrypoint');

    const executablePath = [
      process.env.CHROME_PATH,
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((path) => path !== undefined && existsSync(path));
    if (executablePath === undefined)
      await command('pinned Chromium installation', [
        join(root, 'node_modules/playwright-core/cli.js'),
        'install',
        'chromium',
        '--only-shell',
      ]);
    browser = await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: true,
      timeout: 30_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    diagnosticPage = page;
    page.setDefaultTimeout(15_000);
    const tracker = createTracker();
    tracker.watch(page);

    phase = 'register and login';
    const email = 'fixture-reader@example.com';
    const password = 'isolated-consumer-credential-41';
    await page.goto(`${base}${DOC_A}`);
    await installClient(page, bundle);
    const registered = await browserJson(
      page,
      outcomeOf(
        `client.register({ name: 'Fixture Reader', email: '${email}', password: '${password}' })`,
      ),
    );
    assert(asRecord(registered)?.ok === true, 'register through typed API');
    const verifyLatestEmail = async (): Promise<void> => {
      const mailResponse = await http('/__fixture/verification-mail');
      const mail = asRecord(await mailResponse.json());
      assert(mailResponse.ok && typeof mail?.token === 'string', 'verification mail captured');
      const verified = await browserJson(
        page,
        outcomeOf(`client.verifyEmail(${JSON.stringify(mail.token)})`),
      );
      assert(asRecord(verified)?.ok === true, 'verify through typed API');
    };
    await verifyLatestEmail();
    const loggedIn = await browserJson(
      page,
      outcomeOf(`client.login({ email: '${email}', password: '${password}' })`),
    );
    const loginRecord = asRecord(asRecord(loggedIn)?.value);
    assert(asRecord(loggedIn)?.ok === true, 'login obtains Reader State');
    assert(loginRecord !== null, 'login returns presentation state');
    assert(typeof loginRecord.subject === 'string', 'Reader State carries an opaque subject');
    assert(loginRecord.sessionStatus === 'authenticated', 'login confirms the live session');
    assert(typeof loginRecord.expiresAt === 'number', 'Reader State carries expiry');

    phase = 'valid Reader State navigation performs zero identity calls';
    tracker.reset();
    await page.goto(`${base}${DOC_B}`);
    await installClient(page, bundle);
    const navigated = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(navigated)?.ok === true, 'snapshot resolves after navigation');
    assert(
      (asRecord(asRecord(navigated)?.value)?.subject as string) === loginRecord.subject,
      'same presentation subject after navigation',
    );
    assert(
      tracker.snapshot().me === 0 && tracker.snapshot().readerState === 0,
      'zero /me/token calls on navigation',
    );
    assert(tracker.snapshot().jwks <= 1, 'bounded initial JWKS behavior');
    await page.reload();
    await installClient(page, bundle);
    tracker.reset();
    const reloaded = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(reloaded)?.ok === true, 'snapshot resolves after reload');
    assert(
      tracker.snapshot().me === 0 && tracker.snapshot().readerState === 0,
      'zero /me/token calls on reload',
    );
    assert(tracker.snapshot().jwks === 0, 'cached keys verify without refetch');
    await page.goto(`${base}${DOC_A}`);
    await installClient(page, bundle);
    tracker.reset();
    const backAgain = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(backAgain)?.ok === true, 'snapshot resolves after second navigation');
    assert(
      tracker.snapshot().me === 0 && tracker.snapshot().readerState === 0,
      'zero /me/token calls across documents',
    );
    assert(tracker.snapshot().jwks === 0, 'cached keys shared across documents');

    phase = 'concurrent consumers renew exactly once after expiry';
    await browserJson(
      page,
      outcomeOf(`
        (() => {
           const key = ConsumerClient.readerStateStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
           const stored = JSON.parse(window.localStorage.getItem(key));
          window.__clockOffset = stored.expiresAt - Math.floor(Date.now() / 1000) + 1;
          return stored.expiresAt;
        })()
      `),
    );
    tracker.reset();
    const renewed = await browserJson(
      page,
      outcomeOf(
        'Promise.all([client.getSnapshot(), client.getSnapshot(), client.getSnapshot(), client.getSnapshot(), client.getSnapshot()])',
      ),
    );
    assert(asRecord(renewed)?.ok === true, 'concurrent renewal resolves');
    assert(tracker.snapshot().readerState === 1, 'exactly one renewal for concurrent consumers');
    assert(tracker.snapshot().me === 0, 'renewal performs no /me call');

    phase = 'invalid signature is discarded without renewal';
    tracker.reset();
    await browserJson(
      page,
      outcomeOf(`
        (() => {
           const key = ConsumerClient.readerStateStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
           const stored = JSON.parse(window.localStorage.getItem(key));
           stored.readerState = stored.readerState.slice(0, -4) + 'AAAA';
           window.localStorage.setItem(key, JSON.stringify(stored));
           return stored.readerState.length;
        })()
      `),
    );
    const tampered = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(
      asRecord(tampered)?.ok === true && asRecord(tampered)?.value === null,
      'tampered Reader State is discarded',
    );
    assert(tracker.snapshot().readerState === 0, 'no renewal for invalid Reader State');

    phase = 'second user replaces previous state live in an open tab';
    const restoredBeforeReplacement = await browserJson(
      page,
      outcomeOf('client.refreshReaderState()'),
    );
    assert(asRecord(restoredBeforeReplacement)?.ok === true, 'restore state before replacement');
    const previousSubject = asRecord(asRecord(restoredBeforeReplacement)?.value)?.subject;
    const second = await context.newPage();
    const secondTracker = createTracker();
    secondTracker.watch(second);
    await second.goto(`${base}${DOC_A}`);
    await installClient(second, bundle);
    const restoredSecondTab = await browserJson(second, outcomeOf('client.getSnapshot()'));
    assert(asRecord(restoredSecondTab)?.ok === true, 'open second tab restores Reader State');
    assert(
      asRecord(asRecord(restoredSecondTab)?.value)?.subject === previousSubject,
      'open second tab starts with the previous presentation subject',
    );
    await browserJson(
      second,
      'client.observeReaderState((state) => { if (state !== null) window.__replacementSubject = state.subject; }); return null;',
    );
    secondTracker.reset();
    const otherEmail = 'fixture-second@example.com';
    const otherRegistered = await browserJson(
      page,
      outcomeOf(
        `client.register({ name: 'Second Reader', email: '${otherEmail}', password: '${password}' })`,
      ),
    );
    assert(asRecord(otherRegistered)?.ok === true, 'second registration');
    await verifyLatestEmail();
    const otherLogin = await browserJson(
      page,
      outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`),
    );
    assert(asRecord(otherLogin)?.ok === true, 'later login replaces Reader State');
    assert(
      asRecord(asRecord(otherLogin)?.value)?.subject !== loginRecord.subject,
      'replacement carries the new opaque subject',
    );
    const replacementSubject = asRecord(asRecord(otherLogin)?.value)?.subject;
    assert(typeof replacementSubject === 'string', 'replacement subject is available');
    await second.waitForFunction(
      `window.__replacementSubject === ${JSON.stringify(replacementSubject)}`,
    );
    const liveReplacement = await browserJson(second, outcomeOf('client.getSnapshot()'));
    assert(
      asRecord(asRecord(liveReplacement)?.value)?.subject === replacementSubject,
      'replacement propagates to the already-open second tab',
    );
    assert(
      asRecord(asRecord(liveReplacement)?.value)?.sessionStatus === 'unknown',
      'cross-tab replacement does not claim a live session',
    );
    assert(
      secondTracker.snapshot().me === 0 && secondTracker.snapshot().readerState === 0,
      'live replacement performs no credentialed Identity calls in the second tab',
    );

    phase = 'manual refresh propagates live to an already-current tab';
    await browserJson(
      second,
      'window.__manualRefreshIssuedAt = undefined; client.observeReaderState((state) => { if (state !== null) window.__manualRefreshIssuedAt = state.issuedAt; }); return null;',
    );
    await pause(1100);
    const manualRefresh = await browserJson(page, outcomeOf('client.refreshReaderState()'));
    assert(asRecord(manualRefresh)?.ok === true, 'manual Reader State refresh succeeds');
    const manualRefreshIssuedAt = asRecord(asRecord(manualRefresh)?.value)?.issuedAt;
    assert(typeof manualRefreshIssuedAt === 'number', 'manual refresh has a new issue time');
    await second.waitForFunction(
      `window.__manualRefreshIssuedAt === ${String(manualRefreshIssuedAt)}`,
    );
    assert(
      (await browserJson(second, 'return window.__manualRefreshIssuedAt;')) ===
        manualRefreshIssuedAt,
      'manual refresh replacement propagates to the already-current tab',
    );

    phase = 'newer replacement wins over a delayed login response';
    let releaseDelayedReplacementLogin: () => void = () => undefined;
    let delayedReplacementLoginReady: () => void = () => undefined;
    const delayedReplacementLoginBlocked = new Promise<void>((resolve) => {
      releaseDelayedReplacementLogin = resolve;
    });
    const delayedReplacementLoginResponse = new Promise<void>((resolve) => {
      delayedReplacementLoginReady = resolve;
    });
    await page.route('**/v1/auth/login', async (route) => {
      const response = await route.fetch();
      delayedReplacementLoginReady();
      await delayedReplacementLoginBlocked;
      await route.fulfill({ response });
    });
    const delayedReplacementLogin = browserJson(
      page,
      outcomeOf(`client.login({ email: '${email}', password: '${password}' })`),
    );
    await delayedReplacementLoginResponse;
    const newerLogin = browserJson(
      second,
      outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`),
    );
    await pause(100);
    releaseDelayedReplacementLogin();
    await delayedReplacementLogin;
    const newerLoginOutcome = await newerLogin;
    assert(asRecord(newerLoginOutcome)?.ok === true, 'newer replacement login succeeds');
    await page.unroute('**/v1/auth/login');
    const replacementAfterDelayedLogin = await browserJson(
      second,
      outcomeOf('client.refreshReaderState()'),
    );
    assert(
      asRecord(asRecord(replacementAfterDelayedLogin)?.value)?.subject === replacementSubject,
      'Reader State refresh retains the newer replacement session',
    );

    phase = 'logout wins over a delayed login response';
    let releaseDelayedLogoutLogin: () => void = () => undefined;
    let delayedLogoutLoginReady: () => void = () => undefined;
    const delayedLogoutLoginBlocked = new Promise<void>((resolve) => {
      releaseDelayedLogoutLogin = resolve;
    });
    const delayedLogoutLoginResponse = new Promise<void>((resolve) => {
      delayedLogoutLoginReady = resolve;
    });
    await page.route('**/v1/auth/login', async (route) => {
      const response = await route.fetch();
      delayedLogoutLoginReady();
      await delayedLogoutLoginBlocked;
      await route.fulfill({ response });
    });
    const delayedLogoutLogin = browserJson(
      page,
      outcomeOf(`client.login({ email: '${email}', password: '${password}' })`),
    );
    await delayedLogoutLoginResponse;
    const laterLogout = browserJson(second, outcomeOf('client.logout()'));
    await pause(100);
    releaseDelayedLogoutLogin();
    await delayedLogoutLogin;
    const laterLogoutOutcome = await laterLogout;
    assert(asRecord(laterLogoutOutcome)?.ok === true, 'later logout succeeds');
    await page.unroute('**/v1/auth/login');
    const localStateAfterDelayedLoginLogout = await browserJson(
      second,
      outcomeOf(`
        (async () => {
          const scope = { service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience };
          const key = ConsumerClient.readerStateStorageKey(scope);
          return {
            snapshot: await client.getSnapshot(),
            stored: window.localStorage.getItem(key),
          };
        })()
      `),
    );
    assert(
      asRecord(asRecord(localStateAfterDelayedLoginLogout)?.value)?.snapshot === null &&
        asRecord(asRecord(localStateAfterDelayedLoginLogout)?.value)?.stored === null,
      'serialized logout owns final local Reader State cleanup',
    );
    const refreshAfterDelayedLogin = await browserJson(
      second,
      outcomeOf('client.refreshReaderState()'),
    );
    assert(
      asRecord(refreshAfterDelayedLogin)?.ok === false &&
        asRecord(refreshAfterDelayedLogin)?.code === 'unauthenticated',
      'Reader State refresh cannot resurrect the delayed login after logout',
    );
    const restoreReplacement = await browserJson(
      second,
      outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`),
    );
    assert(asRecord(restoreReplacement)?.ok === true, 'restore replacement after ordering tests');

    phase = 'refresh after logout marker cannot survive delayed server sign-out';
    await browserJson(
      second,
      'window.__logoutRaceStates = []; client.observeReaderState((state) => { window.__logoutRaceStates.push(state?.subject ?? null); }); return null;',
    );
    let releaseDelayedSignOut: () => void = () => undefined;
    let delayedSignOutReady: () => void = () => undefined;
    const delayedSignOutBlocked = new Promise<void>((resolve) => {
      releaseDelayedSignOut = resolve;
    });
    const delayedSignOutRequest = new Promise<void>((resolve) => {
      delayedSignOutReady = resolve;
    });
    await page.route('**/v1/auth/sign-out', async (route) => {
      delayedSignOutReady();
      await delayedSignOutBlocked;
      await route.continue();
    });
    const delayedSignOut = browserJson(page, outcomeOf('client.logout()'));
    await delayedSignOutRequest;
    await second.waitForFunction('window.__logoutRaceStates.includes(null)');
    const refreshBetweenMarkerAndSignOut = await browserJson(
      second,
      outcomeOf('client.refreshReaderState()'),
    );
    assert(
      asRecord(refreshBetweenMarkerAndSignOut)?.ok === true,
      'refresh starts after logout marker while the authoritative session is still live',
    );
    releaseDelayedSignOut();
    const delayedSignOutOutcome = await delayedSignOut;
    assert(asRecord(delayedSignOutOutcome)?.ok === true, 'delayed server sign-out succeeds');
    await page.unroute('**/v1/auth/sign-out');
    await second.waitForFunction('window.__logoutRaceStates.at(-1) === null');
    const stateAfterDelayedSignOut = await browserJson(
      second,
      outcomeOf(`
        (async () => {
          const scope = { service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience };
          return {
            snapshot: await client.getSnapshot(),
            stored: window.localStorage.getItem(ConsumerClient.readerStateStorageKey(scope)),
          };
        })()
      `),
    );
    assert(
      asRecord(asRecord(stateAfterDelayedSignOut)?.value)?.snapshot === null &&
        asRecord(asRecord(stateAfterDelayedSignOut)?.value)?.stored === null,
      'logout completion owns final local clear after an intervening refresh',
    );

    const restoreAfterLogoutRace = await browserJson(
      second,
      outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`),
    );
    assert(
      asRecord(restoreAfterLogoutRace)?.ok === true,
      'login after completed logout remains valid',
    );

    phase = 'unavailable JWKS refresh recovers without credentialed renewal';
    await browserJson(
      page,
      outcomeOf(`
        (() => {
          const scope = { service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience };
          window.localStorage.removeItem(ConsumerClient.jwksStorageKey(scope));
          window.__consumer = undefined;
          return true;
        })()
      `),
    );
    await page.route('**/v1/auth/jwks', (route) => route.abort());
    tracker.reset();
    const keysUnavailable = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(keysUnavailable)?.ok === false, 'unavailable verification keys surface');
    assert(
      asRecord(keysUnavailable)?.code === 'service-unavailable',
      'unavailable verification keys keep a stable code',
    );
    assert(tracker.snapshot().readerState === 0, 'JWKS outage never triggers credentialed renewal');
    await page.unroute('**/v1/auth/jwks');
    await browserJson(
      page,
      outcomeOf('(() => { window.__clockOffset = 61; return window.__clockOffset; })()'),
    );
    const keysRestored = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(keysRestored)?.ok === true, 'verification recovers after JWKS returns');
    assert(
      asRecord(asRecord(keysRestored)?.value)?.subject === replacementSubject,
      'restored key refresh verifies the retained Reader State',
    );
    assert(tracker.snapshot().readerState === 0, 'key-refresh restoration performs no renewal');
    await browserJson(page, outcomeOf('(() => { window.__clockOffset = 0; return true; })()'));

    phase = 'lost renewal session clears expired authentication';
    await context.clearCookies();
    await browserJson(
      page,
      outcomeOf(`
        (() => {
           const key = ConsumerClient.readerStateStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
           const stored = JSON.parse(window.localStorage.getItem(key));
          window.__clockOffset = stored.expiresAt - Math.floor(Date.now() / 1000) + 1;
          return true;
        })()
      `),
    );
    tracker.reset();
    const revoked = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(
      asRecord(revoked)?.ok === true && asRecord(revoked)?.value === null,
      'denied renewal resolves anonymous',
    );
    assert(tracker.snapshot().readerState === 1, 'one denied renewal attempt');
    const cleared = await browserJson(
      page,
      outcomeOf(`
        (() => {
           const key = ConsumerClient.readerStateStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
           return window.localStorage.getItem(key);
        })()
      `),
    );
    assert(
      asRecord(cleared)?.ok === true && asRecord(cleared)?.value === null,
      'stale storage cannot resurrect the prior user',
    );

    phase = 'service and network failure yield unavailable';
    await page.goto(`${base}${DOC_B}`);
    await installClient(page, bundle);
    const relogin = await browserJson(
      page,
      outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`),
    );
    assert(asRecord(relogin)?.ok === true, 'login again for outage coverage');
    await browserJson(
      page,
      outcomeOf(`
        (() => {
           const key = ConsumerClient.readerStateStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
           const stored = JSON.parse(window.localStorage.getItem(key));
          window.__clockOffset = stored.expiresAt - Math.floor(Date.now() / 1000) + 1;
          return true;
        })()
      `),
    );
    await page.route('**/v1/auth/reader-state', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: '{"type":"urn:problem:internal-error","title":"Internal Server Error","status":500,"code":"internal-error"}',
      }),
    );
    const outage = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(outage)?.ok === false, 'service failure surfaces');
    assert(asRecord(outage)?.code === 'service-unavailable', 'stable unavailable code');
    await page.unroute('**/v1/auth/reader-state');
    await page.route('**/v1/auth/reader-state', (route) => route.abort());
    const offline = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(offline)?.ok === false, 'network failure surfaces');
    assert(asRecord(offline)?.code === 'network-unavailable', 'stable network code');
    await page.unroute('**/v1/auth/reader-state');

    phase = 'separate deployment stays isolated';
    tracker.reset();
    const foreign = await browserJson(
      page,
      outcomeOf(`
        ConsumerClient.createConsumerClient({
          baseUrl: window.location.origin,
          issuer: 'https://unrelated.example',
          audience: 'unrelated-web',
        }).getSnapshot()
      `),
    );
    assert(
      asRecord(foreign)?.ok === true && asRecord(foreign)?.value === null,
      'unrelated deployment has no credentials',
    );
    assert(
      tracker.snapshot().me === 0 && tracker.snapshot().readerState === 0,
      'no probing for unrelated deployments',
    );

    phase = 'logout propagates credential-free to the open second tab';
    secondTracker.reset();
    await browserJson(
      second,
      'client.observeReaderState((state) => { if (state === null) window.__consumerLoggedOut = true; }); return null;',
    );
    await browserJson(page, outcomeOf('client.logout()'));
    await second.waitForFunction('window.__consumerLoggedOut === true');
    const propagated = await browserJson(second, outcomeOf('client.getSnapshot()'));
    assert(
      asRecord(propagated)?.ok === true && asRecord(propagated)?.value === null,
      'logout notification clears the second tab',
    );
    assert(
      secondTracker.snapshot().me === 0 && secondTracker.snapshot().readerState === 0,
      'propagated logout performs no identity calls',
    );

    phase = 'failed server logout stays visible';
    const finalLogin = await browserJson(
      page,
      outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`),
    );
    assert(asRecord(finalLogin)?.ok === true, 'login again for logout-failure coverage');
    await page.route('**/v1/auth/sign-out', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: '{"type":"urn:problem:internal-error","title":"Internal Server Error","status":500,"code":"internal-error"}',
      }),
    );
    const failedLogout = await browserJson(page, outcomeOf('client.logout()'));
    assert(asRecord(failedLogout)?.ok === false, 'failed logout surfaces');
    assert(asRecord(failedLogout)?.code === 'logout-failed', 'stable logout-failed code');
    await second.waitForFunction('window.__logoutRaceStates.at(-1) === null');
    const stateAfterFailedLogout = await browserJson(second, outcomeOf('client.getSnapshot()'));
    assert(
      asRecord(stateAfterFailedLogout)?.ok === true &&
        asRecord(stateAfterFailedLogout)?.value === null,
      'failed server logout still owns final cross-tab local clear',
    );
    await page.unroute('**/v1/auth/sign-out');

    phase = 'unsupported browser auth mutations fail closed after local logout';
    const unsupported = await context.newPage();
    await unsupported.goto(`${base}${DOC_A}`);
    await installClient(unsupported, bundle);
    const unsupportedOutcomes = await browserJson(
      unsupported,
      `
        const originalLocks = navigator.locks;
        const originalStorage = window.localStorage;
        const requests = [];
        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
          const path = new URL(input instanceof Request ? input.url : input, window.location.href).pathname;
          if (path === '/v1/auth/login' || path === '/v1/auth/sign-out') requests.push(path);
          return originalFetch(input, init);
        };
        const makeStore = () => {
          const values = new Map();
          return {
            values,
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, value),
            removeItem: (key) => values.delete(key),
          };
        };
        const run = async (locks, storage) => {
          Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
          Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
          const store = makeStore();
          const client = ConsumerClient.createConsumerClient({
            baseUrl: window.location.origin,
            issuer: window.__cfg.issuer,
            audience: window.__cfg.audience,
            readerStateStore: store,
            broadcast: null,
          });
          const scope = { service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience };
          const stateKey = ConsumerClient.readerStateStorageKey(scope);
          store.setItem(stateKey, 'locally-retained-state');
          const login = await (async () => { ${outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`)} })();
          const retainedBeforeLogout = store.getItem(stateKey);
          const logout = await (async () => { ${outcomeOf('client.logout()')} })();
          return { login, logout, retainedBeforeLogout, storedAfterLogout: store.getItem(stateKey) };
        };
        const rejectedLocks = { request: () => Promise.reject(new Error('lock denied')) };
        const failingStorage = {
          getItem: () => { throw new Error('storage denied'); },
          setItem: () => { throw new Error('storage denied'); },
          removeItem: () => { throw new Error('storage denied'); },
        };
        const outcomes = {
          absentLocks: await run(undefined, originalStorage),
          rejectedLocks: await run(rejectedLocks, originalStorage),
          unavailableStorage: await run(originalLocks, undefined),
          failingStorage: await run(originalLocks, failingStorage),
        };
        Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks });
        Object.defineProperty(window, 'localStorage', { configurable: true, value: originalStorage });
        window.fetch = originalFetch;
        return { outcomes, requests };
      `,
    );
    const unsupportedRecord = asRecord(asRecord(unsupportedOutcomes)?.outcomes);
    for (const scenario of [
      'absentLocks',
      'rejectedLocks',
      'unavailableStorage',
      'failingStorage',
    ]) {
      const result = asRecord(unsupportedRecord?.[scenario]);
      assert(
        asRecord(result?.login)?.code === 'unsupported-browser',
        `${scenario} login has stable unsupported-browser code`,
      );
      assert(
        result?.retainedBeforeLogout === 'locally-retained-state',
        `${scenario} login fails closed before changing local state`,
      );
      assert(
        asRecord(result.logout)?.code === 'unsupported-browser',
        `${scenario} logout reports server revocation did not run`,
      );
      assert(result.storedAfterLogout === null, `${scenario} logout clears local state first`);
    }
    assert(
      Array.isArray(asRecord(unsupportedOutcomes)?.requests) &&
        (asRecord(unsupportedOutcomes)?.requests as unknown[]).length === 0,
      'unsupported browser performs no login or server sign-out mutation',
    );
    await unsupported.close();

    await second.close();
    await context.close();
    console.log(
      'Consumer browser acceptance passed: zero-call navigation/reload, one renewal, revocation, outage, isolation and logout propagation.',
    );
  } catch (cause) {
    if (diagnosticPage !== undefined && !diagnosticPage.isClosed()) {
      const summary = await Promise.race([
        diagnosticPage
          .evaluate<string>(`JSON.stringify({ path: location.pathname, title: document.title })`)
          .catch(() => 'Page diagnostics unavailable'),
        pause(2000).then(() => 'Page diagnostics timed out'),
      ]);
      // Only fixed document labels; no fixture values, cookies, storage,
      // response bodies or tokens are inspected here.
      console.info('Consumer browser state:', summary.slice(0, 500));
    }
    throw new Error(`Consumer browser acceptance failed during ${phase}`, { cause });
  } finally {
    try {
      await browser?.close();
    } finally {
      if (worker !== undefined) await stopWorker(worker);
      await rm(state, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsumerBrowserTest().catch(() => {
    // Raw browser/transport exceptions can carry fixture values; no raw output.
    console.error(
      'Consumer browser acceptance failed. Run the test harness for its bounded stage report.',
    );
    process.exitCode = 1;
  });
}
