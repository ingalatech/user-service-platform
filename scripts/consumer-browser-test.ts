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
const FIXTURE_AUDIENCE = 'consumer-fixture-web';
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
  readonly token: number;
  readonly jwks: number;
}

// Request observation across real page navigations. Counts live behind a
// snapshot boundary so single-page assertions never fight control-flow
// narrowing; every counted call is a genuine client request, never a mock.
function createTracker() {
  let me = 0;
  let token = 0;
  let jwks = 0;
  return {
    watch(page: Page): void {
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/v1/me') me += 1;
        else if (pathname === '/v1/auth/token') token += 1;
        else if (pathname === '/v1/auth/jwks') jwks += 1;
      });
    },
    reset(): void {
      me = 0;
      token = 0;
      jwks = 0;
    },
    snapshot(): TrackedRequests {
      return { me, token, jwks };
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
      if (new URL(request.url).pathname === '/v1/auth/token' && response.ok) window.__clockOffset = 0;
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
// URLs exercise actual sessionStorage across full navigations and reloads;
// every identity/token/renewal call is observed, never mocked. Fixture-only
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
          `"ENVIRONMENT": "local",\n    "AUTH_JWT_ISSUER": ${JSON.stringify(FIXTURE_ISSUER)},\n    "AUTH_JWT_AUDIENCE": ${JSON.stringify(FIXTURE_AUDIENCE)},\n    "AUTH_JWT_TTL_SECONDS": ${JSON.stringify(FIXTURE_TTL_SECONDS)},`,
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
    assert(asRecord(loggedIn)?.ok === true, 'login obtains the JWT snapshot');
    assert(loginRecord !== null, 'login returns an identity snapshot');
    assert(loginRecord.email === email, 'shared identity snapshot');
    assert(typeof loginRecord.expiresAt === 'number', 'snapshot carries token expiry');

    phase = 'valid-token navigation performs zero identity calls';
    tracker.reset();
    await page.goto(`${base}${DOC_B}`);
    await installClient(page, bundle);
    const navigated = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(navigated)?.ok === true, 'snapshot resolves after navigation');
    assert(
      (asRecord(asRecord(navigated)?.value)?.email as string) === email,
      'same user after navigation',
    );
    assert(
      tracker.snapshot().me === 0 && tracker.snapshot().token === 0,
      'zero /me/token calls on navigation',
    );
    assert(tracker.snapshot().jwks <= 1, 'bounded initial JWKS behavior');
    await page.reload();
    await installClient(page, bundle);
    tracker.reset();
    const reloaded = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(reloaded)?.ok === true, 'snapshot resolves after reload');
    assert(
      tracker.snapshot().me === 0 && tracker.snapshot().token === 0,
      'zero /me/token calls on reload',
    );
    assert(tracker.snapshot().jwks === 0, 'cached keys verify without refetch');
    await page.goto(`${base}${DOC_A}`);
    await installClient(page, bundle);
    tracker.reset();
    const backAgain = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(backAgain)?.ok === true, 'snapshot resolves after second navigation');
    assert(
      tracker.snapshot().me === 0 && tracker.snapshot().token === 0,
      'zero /me/token calls across documents',
    );
    assert(tracker.snapshot().jwks === 0, 'cached keys shared across documents');

    phase = 'concurrent consumers renew exactly once after expiry';
    await browserJson(
      page,
      outcomeOf(`
        (() => {
          const key = ConsumerClient.tokenStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
          const stored = JSON.parse(window.sessionStorage.getItem(key));
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
    assert(tracker.snapshot().token === 1, 'exactly one renewal for concurrent consumers');
    assert(tracker.snapshot().me === 0, 'renewal performs no /me call');

    phase = 'invalid signature is discarded without renewal';
    tracker.reset();
    await browserJson(
      page,
      outcomeOf(`
        (() => {
          const key = ConsumerClient.tokenStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
          const stored = JSON.parse(window.sessionStorage.getItem(key));
          stored.accessToken = stored.accessToken.slice(0, -4) + 'AAAA';
          window.sessionStorage.setItem(key, JSON.stringify(stored));
          return stored.accessToken.length;
        })()
      `),
    );
    const tampered = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(
      asRecord(tampered)?.ok === true && asRecord(tampered)?.value === null,
      'tampered token resolves anonymous',
    );
    assert(tracker.snapshot().token === 0, 'no renewal for invalid credentials');

    phase = 'second user replaces previous state';
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
    assert(
      (asRecord(asRecord(otherLogin)?.value)?.email as string) === otherEmail,
      'later login replaces state',
    );

    phase = 'lost renewal session clears expired authentication';
    await context.clearCookies();
    await browserJson(
      page,
      outcomeOf(`
        (() => {
          const key = ConsumerClient.tokenStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
          const stored = JSON.parse(window.sessionStorage.getItem(key));
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
    assert(tracker.snapshot().token === 1, 'one denied renewal attempt');
    const cleared = await browserJson(
      page,
      outcomeOf(`
        (() => {
          const key = ConsumerClient.tokenStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
          return window.sessionStorage.getItem(key);
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
          const key = ConsumerClient.tokenStorageKey({ service: window.location.origin, issuer: window.__cfg.issuer, audience: window.__cfg.audience });
          const stored = JSON.parse(window.sessionStorage.getItem(key));
          window.__clockOffset = stored.expiresAt - Math.floor(Date.now() / 1000) + 1;
          return true;
        })()
      `),
    );
    await page.route('**/v1/auth/token', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: '{"type":"urn:problem:internal-error","title":"Internal Server Error","status":500,"code":"internal-error"}',
      }),
    );
    const outage = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(outage)?.ok === false, 'service failure surfaces');
    assert(asRecord(outage)?.code === 'service-unavailable', 'stable unavailable code');
    await page.unroute('**/v1/auth/token');
    await page.route('**/v1/auth/token', (route) => route.abort());
    const offline = await browserJson(page, outcomeOf('client.getSnapshot()'));
    assert(asRecord(offline)?.ok === false, 'network failure surfaces');
    assert(asRecord(offline)?.code === 'network-unavailable', 'stable network code');
    await page.unroute('**/v1/auth/token');

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
      tracker.snapshot().me === 0 && tracker.snapshot().token === 0,
      'no probing for unrelated deployments',
    );

    phase = 'logout propagates credential-free to the second tab';
    const second = await context.newPage();
    const secondTracker = createTracker();
    secondTracker.watch(second);
    await second.goto(`${base}${DOC_A}`);
    await installClient(second, bundle);
    const secondLogin = await browserJson(
      second,
      outcomeOf(`client.login({ email: '${otherEmail}', password: '${password}' })`),
    );
    assert(asRecord(secondLogin)?.ok === true, 'second tab holds its own credentials');
    secondTracker.reset();
    await browserJson(
      second,
      'client.observeLogout(() => { window.__consumerLoggedOut = true; }); return null;',
    );
    await browserJson(page, outcomeOf('client.logout()'));
    await second.waitForFunction('window.__consumerLoggedOut === true');
    const propagated = await browserJson(second, outcomeOf('client.getSnapshot()'));
    assert(
      asRecord(propagated)?.ok === true && asRecord(propagated)?.value === null,
      'logout notification clears the second tab',
    );
    assert(
      secondTracker.snapshot().me === 0 && secondTracker.snapshot().token === 0,
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
    await page.unroute('**/v1/auth/sign-out');

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
