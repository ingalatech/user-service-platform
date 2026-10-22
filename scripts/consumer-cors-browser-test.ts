import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';

// Direct-browser consumer transport acceptance (spec #164, ADR-0013).
//
// A real Chromium document at one origin talks to a real built Worker/D1 at a
// different same-site origin using the exact credentialed-CORS contract. Two
// distinct hostnames (mapped to loopback through Chromium's own resolver, not
// `/etc/hosts`) are required: ports on a single hostname cannot prove the
// service-only session cookie never reaches the editorial hostname.
//
// No API responses are mocked; the fixture database is a disposable mkdtemp
// D1. Registration and email verification both run from the approved browser
// document through the real public HTTP seams. A fixture-only mailbox exposes
// the token captured by the injected AuthMailer; nothing synthesizes a token,
// seeds `email_verified` via SQL or mocks an Identity response.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Consumer CORS browser assertion: ${message}`);
}

async function command(label: string, args: string[]): Promise<void> {
  try {
    await exec(process.execPath, args, { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    throw new Error(`Consumer CORS browser setup failed: ${label}`, { cause });
  }
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
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

function startFrontend(port: number): Promise<HttpServer> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Editorial</title><h1>Editorial</h1>');
  });
  return new Promise<HttpServer>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      done(server);
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise<void>((done, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else done();
    }),
  );
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

interface RegisterResult {
  readonly registerStatus: number;
}

interface VerifyResult {
  readonly verifyStatus: number;
  readonly emailVerified: boolean;
}

interface AuthenticateResult {
  readonly loginStatus: number;
  readonly meStatus: number;
  readonly meEmail: string | null;
  readonly tokenStatus: number;
  readonly hasToken: boolean;
  readonly renewStatus: number;
  readonly hasRenewedToken: boolean;
  readonly jwksStatus: number;
  readonly hasScriptReadableSessionCookie: boolean;
}

interface RevokeResult {
  readonly signOutStatus: number;
  readonly tokenAfterStatus: number;
}

interface HostileResult {
  readonly getMe: string;
  readonly login: string;
}

export interface ConsumerCorsBrowserOptions {
  // Injected by the harness test so the exact reviewed source is exercised.
  readonly headless?: boolean;
}

export async function runConsumerCorsBrowserTest(
  options: ConsumerCorsBrowserOptions = {},
): Promise<void> {
  const state = await mkdtemp(join(tmpdir(), 'user-service-consumer-cors-'));
  let worker: ChildProcess | undefined;
  let browser: Browser | undefined;
  let frontend: HttpServer | undefined;
  let diagnosticPage: Page | undefined;
  let phase = 'setup';
  const frontendPort = await availablePort();
  const frontendBase = `http://www.rc.test:${String(frontendPort)}`;
  const hostileBase = `http://evil.rc.test:${String(frontendPort)}`;
  try {
    const config = join(state, 'wrangler.jsonc');
    const persist = join(state, 'd1');
    const envFile = join(state, '.env');
    const assets = join(state, 'assets');
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, 'index.html'), '<!doctype html><title>assets</title>');
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
    const serviceVars = `"ENVIRONMENT": "local", "AUTH_CONSUMER_ORIGINS": ${JSON.stringify(frontendBase)},`;
    await writeFile(
      config,
      original
        .replace('"main": "src/index.ts"', `"main": ${JSON.stringify(entry)}`)
        .replace('"directory": "./admin/dist"', `"directory": ${JSON.stringify(assets)}`)
        .replace(
          '"migrations_dir": "drizzle"',
          `"migrations_dir": ${JSON.stringify(join(root, 'drizzle'))}`,
        )
        .replace('"ENVIRONMENT": "local",', serviceVars),
    );
    const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
    const flags = ['--config', config, '--env-file', envFile, '--local', '--persist-to', persist];
    await command('isolated migrations', [cli, 'd1', 'migrations', 'apply', 'DB', ...flags]);
    const port = await availablePort();
    // A unique inspector port keeps this Worker from colliding with another
    // Wrangler dev instance in the same harness run (the pinned default
    // inspector port is shared, so two concurrent browser tests would make
    // one Worker exit immediately).
    const inspectorPort = await availablePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const serviceBase = `http://service.rc.test:${String(port)}`;
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
      { cwd: root, stdio: 'ignore', detached: process.platform !== 'win32' },
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

    const email = 'consumer-browser@example.com';
    const password = 'isolated-consumer-credential-41';

    phase = 'frontend origin';
    frontend = await startFrontend(frontendPort);

    phase = 'browser';
    const executablePath = [
      process.env.CHROME_PATH,
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((path) => path !== undefined && existsSync(path));
    if (executablePath === undefined) {
      await command('pinned Chromium installation', [
        join(root, 'node_modules/playwright-core/cli.js'),
        'install',
        'chromium',
        '--only-shell',
      ]);
    }
    const resolverRules = [
      'MAP www.rc.test 127.0.0.1',
      'MAP service.rc.test 127.0.0.1',
      'MAP evil.rc.test 127.0.0.1',
    ].join(',');
    browser = await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: options.headless ?? true,
      timeout: 30_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage', `--host-resolver-rules=${resolverRules}`],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    diagnosticPage = page;
    page.setDefaultTimeout(15_000);

    phase = 'editorial origin document';
    const editorial = await page.goto(`${frontendBase}/`);
    assert(editorial !== null && editorial.status() === 200, 'editorial document served');

    phase = 'direct-browser registration';
    const registered = await page.evaluate<RegisterResult>(`(async () => {
      const service = ${JSON.stringify(serviceBase)};
      const email = ${JSON.stringify(email)};
      const password = ${JSON.stringify(password)};
      const response = await fetch(service + '/v1/auth/register', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Consumer Browser', email, password })
      });
      await response.text();
      return { registerStatus: response.status };
    })()`);
    assert(registered.registerStatus === 201, 'registration from the approved origin succeeds');

    phase = 'direct-browser verification';
    const mailResponse = await http('/__fixture/verification-mail');
    const mail = (await mailResponse.json()) as { token?: unknown };
    assert(mailResponse.ok && typeof mail.token === 'string', 'verification mail captured');
    const verified = await page.evaluate<VerifyResult>(`(async () => {
      const service = ${JSON.stringify(serviceBase)};
      const token = ${JSON.stringify(mail.token)};
      const response = await fetch(service + '/v1/auth/verify-email', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const body = response.status === 200 ? await response.json() : null;
      return {
        verifyStatus: response.status,
        emailVerified: !!(body && body.emailVerified === true)
      };
    })()`);
    assert(
      verified.verifyStatus === 200 && verified.emailVerified,
      'actual verify-email from the approved origin succeeds',
    );

    phase = 'direct-browser lifecycle';
    const authenticated = await page.evaluate<AuthenticateResult>(`(async () => {
      const service = ${JSON.stringify(serviceBase)};
      const email = ${JSON.stringify(email)};
      const password = ${JSON.stringify(password)};
      const json = { 'content-type': 'application/json' };
      const login = await fetch(service + '/v1/auth/login', {
        method: 'POST', credentials: 'include', headers: json,
        body: JSON.stringify({ email, password })
      });
      const loginStatus = login.status;
      const me = await fetch(service + '/v1/me', { credentials: 'include' });
      const meStatus = me.status;
      const meBody = meStatus === 200 ? await me.json() : null;
      const token = await fetch(service + '/v1/auth/reader-state', {
        method: 'POST', credentials: 'include', headers: json, body: '{}'
      });
      const tokenStatus = token.status;
      const tokenBody = tokenStatus === 200 ? await token.json() : null;
      const renewed = await fetch(service + '/v1/auth/reader-state', {
        method: 'POST', credentials: 'include', headers: json, body: '{}'
      });
      const renewStatus = renewed.status;
      const renewBody = renewStatus === 200 ? await renewed.json() : null;
      const jwks = await fetch(service + '/v1/auth/jwks');
      const jwksStatus = jwks.status;
      return {
        loginStatus, meStatus,
        meEmail: meBody && typeof meBody.email === 'string' ? meBody.email : null,
        tokenStatus,
        hasToken: !!(tokenBody && typeof tokenBody.readerState === 'string'),
        renewStatus,
        hasRenewedToken: !!(renewBody && typeof renewBody.readerState === 'string'),
        jwksStatus,
        hasScriptReadableSessionCookie: document.cookie.includes('session_token')
      };
    })()`);
    assert(
      authenticated.loginStatus === 200,
      'credentialed login from the editorial origin succeeds',
    );
    assert(authenticated.meStatus === 200, 'credentialed /v1/me resolves the session');
    assert(authenticated.meEmail === email, 'resolved identity matches the fixture');
    assert(authenticated.tokenStatus === 200 && authenticated.hasToken, 'Reader State issued');
    assert(
      authenticated.renewStatus === 200 && authenticated.hasRenewedToken,
      'Reader State refreshed with the same live session',
    );
    assert(authenticated.jwksStatus === 200, 'public JWKS readable across origins');
    assert(
      !authenticated.hasScriptReadableSessionCookie,
      'service session cookie is not script-readable on the editorial origin',
    );

    phase = 'service-cookie hostname isolation';
    const serviceCookies = await context.cookies(`${serviceBase}/`);
    const session = serviceCookies.find((cookie) => cookie.name.includes('session_token'));
    assert(session !== undefined, 'browser stores the service session cookie');
    assert(session.httpOnly, 'service session cookie is HttpOnly');
    assert(
      session.domain === 'service.rc.test' && !session.domain.startsWith('.'),
      'service session cookie is host-only to the service hostname',
    );
    const editorialCookies = await context.cookies(`${frontendBase}/`);
    assert(
      !editorialCookies.some((cookie) => cookie.name.includes('session_token')),
      'editorial hostname never receives the service session cookie',
    );

    phase = 'sign-out revocation';
    const revoked = await page.evaluate<RevokeResult>(`(async () => {
      const service = ${JSON.stringify(serviceBase)};
      const json = { 'content-type': 'application/json' };
      const signOut = await fetch(service + '/v1/auth/sign-out', {
        method: 'POST', credentials: 'include', headers: json, body: '{}'
      });
      const signOutStatus = signOut.status;
      const tokenAfter = await fetch(service + '/v1/auth/reader-state', {
        method: 'POST', credentials: 'include', headers: json, body: '{}'
      });
      return { signOutStatus, tokenAfterStatus: tokenAfter.status };
    })()`);
    assert(revoked.signOutStatus === 200, 'sign-out succeeds from the editorial origin');
    assert(revoked.tokenAfterStatus === 401, 'sign-out prevents further issuance');

    phase = 'hostile origin';
    await page.goto(`${hostileBase}/`);
    const hostile = await page.evaluate<HostileResult>(`(async () => {
      const service = ${JSON.stringify(serviceBase)};
      const json = { 'content-type': 'application/json' };
      let getMe = 'resolved';
      try {
        const response = await fetch(service + '/v1/me', { credentials: 'include' });
        await response.text();
        getMe = 'resolved:' + response.status;
      } catch {
        getMe = 'blocked';
      }
      let login = 'resolved';
      try {
        const response = await fetch(service + '/v1/auth/login', {
          method: 'POST', credentials: 'include', headers: json, body: '{}'
        });
        await response.text();
        login = 'resolved:' + response.status;
      } catch {
        login = 'blocked';
      }
      return { getMe, login };
    })()`);
    assert(hostile.getMe === 'blocked', 'unapproved origin cannot read the identity response');
    assert(hostile.login === 'blocked', 'unapproved origin cannot perform the mutation');

    await context.close();
    console.log(
      'Consumer CORS browser acceptance passed: direct credentialed register/verify/login/me/Reader-State refresh/jwks/sign-out across distinct same-site origins, host-only service cookie, hostile-origin rejection.',
    );
  } catch (cause) {
    if (diagnosticPage !== undefined && !diagnosticPage.isClosed()) {
      // Metadata only: path and viewport. Cookie, storage, response-body and
      // token material never enter diagnostics, even though this scenario
      // expects no script-readable session cookie.
      const summary = await Promise.race([
        diagnosticPage
          .evaluate<string>(
            `JSON.stringify({ path: location.pathname, width: window.innerWidth, height: window.innerHeight })`,
          )
          .catch(() => 'Page diagnostics unavailable'),
        pause(2000).then(() => 'Page diagnostics timed out'),
      ]);
      console.info('Consumer CORS browser state:', summary.slice(0, 500));
    }
    throw new Error(`Consumer CORS browser acceptance failed during ${phase}`, { cause });
  } finally {
    try {
      await browser?.close();
    } finally {
      if (frontend !== undefined) await closeServer(frontend).catch(() => undefined);
      if (worker !== undefined) await stopWorker(worker);
      await rm(state, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsumerCorsBrowserTest().catch(() => {
    console.error(
      'Consumer CORS browser acceptance failed. Run the test harness for its bounded stage report.',
    );
    process.exitCode = 1;
  });
}
