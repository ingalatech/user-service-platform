import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { AdminReaderDetailSchema } from '../admin/src/generated/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Administration browser assertion: ${message}`);
}

async function command(label: string, args: string[]): Promise<void> {
  try {
    await exec(process.execPath, args, { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    // Command output can contain fixture data: expose only a stable stage.
    throw new Error(`Administration browser setup failed: ${label}`, { cause });
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

async function visible(page: Page, name: string): Promise<void> {
  await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 15_000 });
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click();
  await page.waitForFunction<boolean>(
    `(tabName) => [...document.querySelectorAll('[role="tab"]')].some((tab) =>
      tab.offsetParent !== null && tab.getAttribute('aria-selected') === 'true' &&
      tab.textContent?.trim() === tabName)`,
    name,
  );
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await visible(page, 'Administración');
  await page.getByRole('textbox', { name: 'Correo electrónico', exact: true }).fill(email);
  // getByLabel includes the kit's visually required marker in label text,
  // even though that marker is aria-hidden in the accessible name.
  await page.getByLabel(/^Contraseña(?:\s*\*)?$/).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
}

// Real browser + real built Worker/D1. Fixture-only SQL is restricted to a
// fresh mkdtemp database; ordinary local state and remote resources are untouched.
// No API response mocks, copied account tokens, or default-database reset.
export async function runAdminBrowserTest(): Promise<void> {
  assert(existsSync(join(root, 'admin/dist/index.html')), 'current frontend build exists');
  const state = await mkdtemp(join(tmpdir(), 'user-service-admin-'));
  let worker: ChildProcess | undefined;
  let browser: Browser | undefined;
  let diagnosticPage: Page | undefined;
  let phase = 'setup';
  try {
    const config = join(state, 'wrangler.jsonc');
    const persist = join(state, 'd1');
    const envFile = join(state, '.env');
    await writeFile(envFile, '');
    await writeFile(join(state, '.dev.vars'), '');
    const original = await readFile(join(root, 'wrangler.jsonc'), 'utf8');
    // Preserve all routing/binding configuration; relocate only file paths so
    // local-secret discovery and storage also live in the disposable directory.
    await writeFile(
      config,
      original
        .replace('"main": "src/index.ts"', `"main": ${JSON.stringify(join(root, 'src/index.ts'))}`)
        .replace(
          '"directory": "./admin/dist"',
          `"directory": ${JSON.stringify(join(root, 'admin/dist'))}`,
        )
        .replace(
          '"migrations_dir": "drizzle"',
          `"migrations_dir": ${JSON.stringify(join(root, 'drizzle'))}`,
        ),
    );
    const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
    const flags = ['--config', config, '--env-file', envFile, '--local', '--persist-to', persist];
    const sql = async (statement: string) =>
      command('isolated fixture SQL', [
        cli,
        'd1',
        'execute',
        'DB',
        ...flags,
        '--command',
        statement,
      ]);
    await command('isolated migrations', [cli, 'd1', 'migrations', 'apply', 'DB', ...flags]);
    const port = await availablePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const processState = { spawnFailed: false };
    worker = spawn(
      process.execPath,
      [cli, 'dev', ...flags, '--ip', '127.0.0.1', '--port', String(port)],
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
    const password = 'Isolated-browser-credential-41';
    const admin = 'qa-admin@example.com';
    const regular = 'qa-user@example.com';
    const unverified = 'qa-unverified@example.com';
    const lifecycleReader = 'qa-lifecycle-reader@example.com';
    for (const [path, name, email] of [
      ['/v1/admin/auth/bootstrap', 'QA Administrator', admin],
      ['/v1/auth/register', 'QA User', regular],
      ['/v1/auth/register', 'QA Unverified', unverified],
    ]) {
      const response = await http(path ?? '', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      assert(response.status === 201, 'fixture created through public HTTP');
      await response.arrayBuffer();
    }
    // Actual verify-email transitions are covered by Workers-runtime tests.
    await sql(`UPDATE "admin_user" SET email_verified = 1 WHERE email = '${admin}'`);
    await sql(`UPDATE "user" SET email_verified = 1 WHERE email = '${regular}'`);
    phase = 'assets';
    for (const path of ['/admin', '/admin/', '/admin/login', '/admin/denegado']) {
      const response = await http(path);
      assert(
        response.status === 200 && response.headers.get('content-type')?.includes('text/html'),
        'SPA deep links return HTML',
      );
      const html = await response.text();
      for (const asset of html.matchAll(/(?:src|href)="(\/admin\/assets\/[^"]+)"/g)) {
        const result = await http(asset[1] ?? '');
        assert(
          result.ok && !result.headers.get('content-type')?.includes('text/html'),
          'built scripts/styles resolve',
        );
        await result.arrayBuffer();
      }
    }
    const missingAsset = await http('/admin/assets/not-a-real-hash.js');
    assert(missingAsset.status === 404, 'missing hashed asset stays 404');
    await missingAsset.arrayBuffer();
    const unknown = await http('/v1/not-a-real-operation');
    assert(
      unknown.status === 404 &&
        unknown.headers.get('content-type')?.includes('application/problem+json'),
      'unknown API remains JSON',
    );
    await unknown.arrayBuffer();
    const action = await http('/auth-actions/verify-email');
    assert(
      action.status === 200 && action.headers.get('content-type')?.includes('text/html'),
      'existing auth action remains HTML',
    );
    await action.arrayBuffer();

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
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    diagnosticPage = page;
    page.on('pageerror', () => {
      phase = 'frontend runtime error';
    });
    page.setDefaultTimeout(15_000);
    phase = 'administrator login';
    await page.goto(`${base}/admin/unknown-route`);
    await visible(page, 'Administración');
    await page.keyboard.press('Tab');
    assert(
      await page.evaluate<boolean>(`(() => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active !== document.body && getComputedStyle(active).outlineStyle !== 'none';
    })()`),
      'keyboard focus visible',
    );
    await signIn(page, admin, 'wrong-password-99');
    await page.getByRole('alert').filter({ hasText: 'Credenciales inválidas' }).waitFor();
    await signIn(page, admin, password);
    await visible(page, 'Sesión de administración');
    await page.getByText(admin, { exact: true }).first().waitFor();
    await page.getByText('Correo verificado', { exact: true }).waitFor();
    await page.reload();
    await visible(page, 'Sesión de administración');
    await page.goto(`${base}/admin/unknown-route`);
    await visible(page, 'Página no encontrada');
    assert(
      (await page.getByRole('button', { name: 'Menú de usuario', exact: true }).count()) === 1,
      'unknown route has a single kit layout',
    );
    await page.getByRole('link', { name: 'Volver al inicio', exact: true }).click();
    await visible(page, 'Sesión de administración');
    const cookies = await context.cookies();
    let token = cookies.find((cookie) => cookie.name.endsWith('session_token'));
    assert(
      token?.httpOnly && token.path === '/v1/admin',
      'Admin cookie is HttpOnly and path-scoped',
    );
    const credentials = JSON.stringify({ password, token: token.value });
    assert(
      await page.evaluate<boolean>(`(() => {
      const credentials = ${credentials};
      const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].join(' ');
      return !stored.includes(credentials.password) && !stored.includes(credentials.token) && !document.cookie.includes('session_token');
    })()`),
      'UI storage contains no password or session token',
    );
    let cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    let administratorId = '';
    for (const [path, fields] of [
      ['/v1/admin/me', ['email', 'emailVerified', 'id', 'realm', 'role']],
    ] as const) {
      const response = await http(path, { headers: { cookie: cookieHeader } });
      assert(response.status === 200, 'authenticated HTTP identity');
      const payload: unknown = await response.json();
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'id' in payload &&
        typeof payload.id === 'string'
      ) {
        administratorId = payload.id;
      }
      assert(
        typeof payload === 'object' &&
          payload !== null &&
          Object.keys(payload).sort().join(',') === fields.join(','),
        'exact application-owned identity fields',
      );
    }
    assert(administratorId.length > 0, 'Administrator opaque id resolved');
    const readerMe = await http('/v1/me', { headers: { cookie: cookieHeader } });
    assert(readerMe.status === 401, 'Administrator cookie is not a Reader session');
    await readerMe.arrayBuffer();
    phase = 'canonical administration hierarchy';
    await page.getByRole('link', { name: 'Administradores', exact: true }).click();
    await visible(page, 'Administradores');
    await page.getByText('1 administrador en total', { exact: true }).waitFor();
    await visible(page, 'Activos');
    await page.getByText(admin, { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Ver detalle', exact: true }).click();
    await visible(page, 'Detalle de administrador');
    await page
      .getByText('Esta es tu cuenta. La autodeshabilitación no está disponible.', { exact: true })
      .waitFor();
    assert(
      (await page
        .getByRole('button', { name: /Deshabilitar acceso|Rehabilitar acceso/ })
        .count()) === 0,
      'own access mutation remains hidden',
    );
    await sql(
      `INSERT INTO admin_user (id, name, email, email_verified, created_at, updated_at, role, banned)
       VALUES ('qa-disabled-admin', 'QA Disabled Administrator', 'qa-disabled-admin@example.com', 0, 1700000000, 1700000000, 'admin', 0)`,
    );
    await sql(
      `INSERT INTO admin_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ('qa-disabled-account', 'qa-disabled-admin', 'credential', 'qa-disabled-admin', 'fixture-password-hash', 1700000000, 1700000000)`,
    );
    await sql(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES ('qa-disabled-admin', 'disabled', 4, 1700000000000)`,
    );
    await sql(
      `INSERT INTO admin_user (id, name, email, email_verified, created_at, updated_at, role, banned)
       VALUES ('qa-no-password-admin', 'QA No Password Administrator', 'qa-no-password-admin@example.com', 1, 1700000000, 1700000000, 'admin', 0)`,
    );
    await sql(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES ('qa-no-password-admin', 'disabled', 4, 1700000000000)`,
    );
    const auditOccurredAt = Date.now();
    await sql(
      `INSERT INTO identity_event
       (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
        result, request_id, problem_code, metadata)
       VALUES ('browser-audit-safe', 1, 'access-attempt', ${String(auditOccurredAt)},
        'administrator', 'qa-disabled-admin', 'reader', 'opaque-reader-subject', 'failure',
        'browser-audit-request', 'stale-revision',
        '{"changed":false,"token":"browser-secret-token","email":"browser-secret@example.com","emailBody":"private body"}')`,
    );
    phase = 'Administrator verification and recovery actions';
    await page.goto(`${base}/admin/administrators/qa-disabled-admin`);
    await visible(page, 'Detalle de administrador');
    await page.getByText('Deshabilitado', { exact: true }).waitFor();
    const adminVerificationButton = page.getByRole('button', {
      name: 'Reenviar verificación',
      exact: true,
    });
    const adminRecoveryButton = page.getByRole('button', {
      name: 'Enviar recuperación',
      exact: true,
    });
    assert(
      !(await adminVerificationButton.isDisabled()),
      'disabled unverified Admin can request verification',
    );
    assert(
      !(await adminRecoveryButton.isDisabled()),
      'disabled credentialed Admin can request recovery',
    );
    const administratorVerificationKeys: string[] = [];
    let rejectAdministratorVerification = true;
    await page.route(
      '**/v1/admin/administrators/qa-disabled-admin/email-verification/messages',
      async (route) => {
        administratorVerificationKeys.push(route.request().headers()['idempotency-key'] ?? '');
        if (rejectAdministratorVerification) {
          rejectAdministratorVerification = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'urn:problem:delivery-scheduling-failed',
              title: 'Delivery scheduling failed',
              status: 503,
              code: 'delivery-scheduling-failed',
            }),
          });
          return;
        }
        await route.continue();
      },
    );
    await adminVerificationButton.click();
    await page
      .getByText('No pudimos programar el envío. Reintenta con el mismo intento.', { exact: true })
      .waitFor();
    const administratorVerificationRetry = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith('/v1/admin/administrators/qa-disabled-admin/email-verification/messages'),
    );
    await adminVerificationButton.click();
    assert(
      (await administratorVerificationRetry).status() === 202,
      'Admin verification retry accepted',
    );
    assert(
      administratorVerificationKeys.length === 2 &&
        administratorVerificationKeys[0] !== '' &&
        administratorVerificationKeys[0] === administratorVerificationKeys[1],
      'Admin verification retry preserves its idempotency key',
    );
    assert(
      await adminVerificationButton.isDisabled(),
      'verification cooldown disables repeat action',
    );
    await page.unroute('**/v1/admin/administrators/qa-disabled-admin/email-verification/messages');
    const administratorRecoveryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith('/v1/admin/administrators/qa-disabled-admin/password-recovery/messages'),
    );
    await adminRecoveryButton.click();
    assert((await administratorRecoveryResponse).status() === 202, 'Admin recovery accepted');
    assert(await adminRecoveryButton.isDisabled(), 'recovery cooldown disables repeat action');
    const disabledAdministratorDetail = await http('/v1/admin/administrators/qa-disabled-admin', {
      headers: { cookie: cookieHeader },
    });
    assert(disabledAdministratorDetail.status === 200, 'disabled Administrator remains readable');
    const disabledAdministrator = (await disabledAdministratorDetail.json()) as {
      access?: { state?: unknown };
      emailVerified?: unknown;
    };
    assert(
      disabledAdministrator.access?.state === 'disabled' &&
        disabledAdministrator.emailVerified === false,
      'message actions neither rehabilitate nor verify the Administrator',
    );
    await page.goto(`${base}/admin/administrators/qa-no-password-admin`);
    await visible(page, 'Detalle de administrador');
    assert(
      await page.getByRole('button', { name: 'Reenviar verificación', exact: true }).isDisabled(),
      'verified Administrator cannot request verification again',
    );
    assert(
      await page.getByRole('button', { name: 'Enviar recuperación', exact: true }).isDisabled(),
      'Administrator without password cannot request recovery',
    );
    await page.getByRole('link', { name: 'Auditoría administrativa', exact: true }).click();
    await visible(page, 'Auditoría administrativa');
    phase = 'global Administrative Audit filter controls';
    const auditActorFilter = page.getByRole('textbox', {
      name: 'Administrator actor ID',
      exact: true,
    });
    await auditActorFilter.fill('qa-disabled-admin');
    await page
      .getByRole('textbox', { name: 'Acción (tipo exacto)', exact: true })
      .fill('access-attempt');
    await page.getByRole('combobox', { name: 'Resultado', exact: true }).selectOption('failure');
    await page.getByLabel('Desde', { exact: true }).fill('2000-01-01T00:00');
    await page.getByLabel('Hasta', { exact: true }).fill('2099-01-01T00:00');
    let releaseAuditRequest: (() => void) | undefined;
    const auditRequestGate = new Promise<void>((resolve) => {
      releaseAuditRequest = resolve;
    });
    await page.route('**/v1/admin/audit-events*', async (route) => {
      await auditRequestGate;
      await route.continue();
    });
    phase = 'global Administrative Audit apply filters';
    const filteredAuditResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().startsWith(`${base}/v1/admin/audit-events?`),
    );
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    phase = 'global Administrative Audit loading announcement';
    await page.getByText('Cargando auditoría…', { exact: true }).waitFor();
    releaseAuditRequest?.();
    phase = 'global Administrative Audit response arrival';
    const filteredResponse = await filteredAuditResponse;
    phase = 'global Administrative Audit response status';
    assert(filteredResponse.status() === 200, 'approved audit filters return 200');
    phase = 'global Administrative Audit response projection';
    const filteredAudit = (await filteredResponse.json()) as { items: { id: string }[] };
    phase = 'global Administrative Audit fixture selection';
    assert(
      filteredAudit.items.some((event) => event.id === 'browser-audit-safe'),
      'actor, action, result, and time filters select the fixture row',
    );
    phase = 'global Administrative Audit filtered request row';
    await page.getByText('browser-audit-request', { exact: true }).waitFor();
    await page.unroute('**/v1/admin/audit-events*');
    phase = 'global Administrative Audit actor lookup';
    await page.getByText('qa-disabled-admin@example.com', { exact: true }).waitFor();
    const auditText = await page.locator('body').innerText();
    for (const secret of [
      'browser-secret-token',
      'browser-secret@example.com',
      'private body',
      'browser-audit-safe',
    ]) {
      assert(!auditText.includes(secret), 'Audit UI renders only the safe projection');
    }
    await auditActorFilter.fill('actor-with-no-audit-events');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page
      .getByText('No hay eventos de auditoría para estos filtros.', { exact: true })
      .waitFor();
    await page.route('**/v1/admin/audit-events*', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:problem:internal-error',
          title: 'Internal Server Error',
          status: 500,
          code: 'internal-error',
          detail: 'private backend diagnostic',
        }),
      });
    });
    await auditActorFilter.fill('trigger-audit-error');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page
      .getByText('No pudimos completar la consulta. Tu sesión se conserva.', { exact: true })
      .waitFor();
    assert(
      !(await page.locator('body').innerText()).includes('private backend diagnostic'),
      'audit UI never renders Problem Details detail text',
    );
    await page.unroute('**/v1/admin/audit-events*');
    const cursorAuditEvent = {
      id: 'browser-cursor-event',
      version: 1,
      type: 'access-attempt',
      occurredAt: new Date(auditOccurredAt).toISOString(),
      actor: { id: 'qa-disabled-admin', realm: 'administrator' },
      subject: null,
      result: 'success',
      requestId: 'browser-cursor-request',
      problemCode: null,
      metadata: null,
    };
    await page.route('**/v1/admin/audit-events*', async (route) => {
      const url = new URL(route.request().url());
      const cursorPage = url.searchParams.has('cursor');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          cursorPage
            ? { items: [cursorAuditEvent], nextCursor: null }
            : { items: [], nextCursor: 'opaque-cursor-next' },
        ),
      });
    });
    await auditActorFilter.fill('cursor-empty-page');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page
      .getByText(
        'No hay eventos visibles en esta página. Continúa para consultar los siguientes.',
        {
          exact: true,
        },
      )
      .waitFor();
    await page.getByRole('button', { name: 'Cargar más', exact: true }).click();
    await page.getByText('browser-cursor-request', { exact: true }).waitFor();
    await page.unroute('**/v1/admin/audit-events*');

    await page.route('**/v1/admin/audit-events*', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:problem:unauthenticated',
          title: 'Unauthenticated',
          status: 401,
          code: 'unauthenticated',
          detail: 'private 401 detail',
        }),
      });
    });
    await auditActorFilter.fill('unauthenticated-audit-query');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page
      .getByText('La sesión terminó. Inicia sesión de nuevo para consultar la auditoría.', {
        exact: true,
      })
      .waitFor();
    assert(
      !(await page.locator('body').innerText()).includes('private 401 detail'),
      'unauthenticated audit error uses status/code, not detail',
    );
    await page.unroute('**/v1/admin/audit-events*');

    await page.route('**/v1/admin/audit-events*', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:problem:administrator-disabled',
          title: 'Administrator disabled',
          status: 403,
          code: 'administrator-disabled',
          detail: 'private 403 detail',
        }),
      });
    });
    await auditActorFilter.fill('disabled-audit-query');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page.getByText('La cuenta Administrator está deshabilitada.', { exact: true }).waitFor();
    assert(
      !(await page.locator('body').innerText()).includes('private 403 detail'),
      'disabled Administrator audit error uses status/code, not detail',
    );
    await page.unroute('**/v1/admin/audit-events*');
    phase = 'user list, search and pagination';
    for (let i = 0; i < 12; i++) {
      const email = `qa-list-${String(i).padStart(2, '0')}@example.com`;
      const response = await http('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `QA List ${String(i)}`, email, password }),
      });
      assert(response.status === 201, 'list fixture created through public HTTP');
      await response.arrayBuffer();
    }
    await page.goto(`${base}/admin/users`);
    await visible(page, 'Usuarios');
    await page.getByText('14 usuarios en total', { exact: true }).waitFor();
    await page.getByText('1-10 de 14', { exact: true }).waitFor();
    const table = page.getByRole('table', { name: 'Listado de usuarios', exact: true });
    await table.waitFor();
    assert(
      (await table.getByText(admin, { exact: true }).count()) === 0,
      'Admin identity is not a Reader row',
    );
    await table.getByText('Correo sin verificar', { exact: true }).first().waitFor();
    const listHeaders = (await table.getByRole('columnheader').allTextContents()).join(' ');
    assert(
      !/fecha de nacimiento|teléfono|referencia de imagen/i.test(listHeaders),
      'User list keeps Account Details private',
    );
    const searchBox = page.getByRole('textbox', {
      name: 'Buscar por correo electrónico',
      exact: true,
    });
    await searchBox.fill(`  ${regular.toUpperCase()}  `);
    await page.getByText('1 usuario en total', { exact: true }).waitFor();
    await page.getByText('1-1 de 1', { exact: true }).waitFor();
    await table.getByText(regular, { exact: true }).waitFor();
    await table.getByText('Correo verificado', { exact: true }).waitFor();
    assert((await table.getByText(admin, { exact: true }).count()) === 0, 'search replaces rows');
    await searchBox.fill('no-such-user@example.com');
    await visible(page, 'Sin resultados');
    await searchBox.fill('   ');
    await page.getByText('14 usuarios en total', { exact: true }).waitFor();
    await page.getByText('1-10 de 14', { exact: true }).waitFor();
    assert((await page.getByRole('alert').count()) === 0, 'whitespace-only search is empty');
    await page.getByRole('button', { name: 'Limpiar búsqueda', exact: true }).click();
    await page.getByText('14 usuarios en total', { exact: true }).waitFor();
    await page
      .getByRole('navigation', { name: 'pagination' })
      .getByText('2', { exact: true })
      .click();
    await page.getByText('11-14 de 14', { exact: true }).waitFor();
    assert(
      (await table.getByText(admin, { exact: true }).count()) === 0,
      'next page has no stale rows',
    );
    await table.getByText('qa-list-11@example.com', { exact: true }).waitFor();
    await searchBox.fill(regular);
    await page.getByText('1 usuario en total', { exact: true }).waitFor();
    await page.getByText('1-1 de 1', { exact: true }).waitFor();
    await table.getByText(regular, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Limpiar búsqueda', exact: true }).click();
    await page.getByText('1-10 de 14', { exact: true }).waitFor();
    assert(
      (await table.getByText(admin, { exact: true }).count()) === 0,
      'Admin identity stays outside Reader listing',
    );
    const deletedEmail = 'qa-deleted-on-save@example.com';
    const deletedRegistration = await http('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'QA Deleted', email: deletedEmail, password }),
    });
    assert(deletedRegistration.status === 201, 'deleted User fixture created');
    await deletedRegistration.arrayBuffer();
    await sql(`UPDATE "user" SET email_verified = 1 WHERE email = '${deletedEmail}'`);
    const deletedLookup = await http(`/v1/admin/users?email=${encodeURIComponent(deletedEmail)}`, {
      headers: { cookie: cookieHeader },
    });
    assert(deletedLookup.status === 200, 'deleted User detail lookup');
    const deletedPayload = (await deletedLookup.json()) as {
      items?: { id?: unknown }[];
    };
    const deletedId = deletedPayload.items?.[0]?.id;
    assert(
      typeof deletedId === 'string' && deletedId.length > 0,
      'deleted User identifier resolved',
    );
    await page.goto(`${base}/admin/users/${encodeURIComponent(deletedId)}/edit`);
    await visible(page, 'Editar datos de cuenta');
    await sql(`DELETE FROM "user" WHERE id = '${deletedId}'`);
    await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Deleted');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await page.getByText('Usuario no encontrado', { exact: true }).waitFor();
    phase = 'Reader verification and recovery lifecycle actions';
    const lifecycleRegistration = await http('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'QA Lifecycle Reader', email: lifecycleReader, password }),
    });
    assert(lifecycleRegistration.status === 201, 'lifecycle Reader fixture created');
    await lifecycleRegistration.arrayBuffer();
    const unverifiedLookup = await http(
      `/v1/admin/users?email=${encodeURIComponent(lifecycleReader)}`,
      {
        headers: { cookie: cookieHeader },
      },
    );
    assert(unverifiedLookup.status === 200, 'unverified Reader detail lookup');
    const unverifiedPayload = (await unverifiedLookup.json()) as {
      items?: { id?: unknown }[];
    };
    const unverifiedIdValue = unverifiedPayload.items?.[0]?.id;
    assert(
      typeof unverifiedIdValue === 'string' && unverifiedIdValue.length > 0,
      'unverified Reader identifier resolved',
    );
    const unverifiedId = unverifiedIdValue;
    await page.goto(`${base}/admin/users/${encodeURIComponent(unverifiedId)}`);
    await visible(page, 'Detalle de usuario');
    await page.getByRole('tab', { name: 'Acceso', exact: true }).click();
    const verificationKeys: string[] = [];
    let rejectVerificationScheduling = true;
    await page.route('**/v1/admin/users/*/email-verification/messages', async (route) => {
      verificationKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (rejectVerificationScheduling) {
        rejectVerificationScheduling = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Delivery scheduling failed',
            status: 503,
            code: 'delivery-scheduling-failed',
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Reenviar verificación', exact: true }).click();
    await page
      .getByText(
        'No pudimos programar el envío. Reintenta con el mismo intento para evitar un duplicado.',
        { exact: true },
      )
      .waitFor();
    const verificationRetryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/v1/admin/users/${unverifiedId}/email-verification/messages`),
    );
    await page.getByRole('button', { name: 'Reenviar verificación', exact: true }).click();
    assert((await verificationRetryResponse).status() === 202, 'verification retry accepted');
    const refreshedUnverified = await http(`/v1/admin/users/${encodeURIComponent(unverifiedId)}`, {
      headers: { cookie: cookieHeader },
    });
    assert(refreshedUnverified.status === 200, 'scheduled workflow detail remains readable');
    await refreshedUnverified.arrayBuffer();
    await page.getByRole('tab', { name: 'Acceso', exact: true }).click();
    await page
      .getByText(/^Correo programado\./)
      .first()
      .waitFor();
    assert(
      verificationKeys.length === 2 && verificationKeys[0] === verificationKeys[1],
      'verification scheduling retry preserves the idempotency key',
    );
    await page.unroute('**/v1/admin/users/*/email-verification/messages');
    const recoveryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/v1/admin/users/${unverifiedId}/password-recovery/messages`),
    );
    await page.getByRole('tab', { name: 'Acceso', exact: true }).click();
    await page.getByRole('button', { name: 'Enviar recuperación', exact: true }).click();
    assert((await recoveryResponse).status() === 202, 'password recovery accepted');
    const forceVerificationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/v1/admin/users/${unverifiedId}/email-verification`),
    );
    await page.getByRole('tab', { name: 'Acceso', exact: true }).click();
    await page.getByRole('button', { name: 'Marcar correo como verificado', exact: true }).click();
    assert((await forceVerificationResponse).status() === 200, 'force verification accepted');
    const verifiedDetail = await http(`/v1/admin/users/${encodeURIComponent(unverifiedId)}`, {
      headers: { cookie: cookieHeader },
    });
    assert(verifiedDetail.status === 200, 'verified Reader detail remains readable');
    await verifiedDetail.arrayBuffer();
    await sql(`DELETE FROM "user" WHERE id = '${unverifiedId}'`);
    const emailChangeReaderEmail = 'qa-email-change-reader@example.com';
    const emailChangeRegistration = await http('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'QA Email Change Reader',
        email: emailChangeReaderEmail,
        password,
      }),
    });
    assert(emailChangeRegistration.status === 201, 'email-change Reader fixture created');
    const emailChangeReader = (await emailChangeRegistration.json()) as { id: string };
    await sql(`UPDATE "user" SET email_verified = 1 WHERE id = '${emailChangeReader.id}'`);
    const emailChangeReaderId = emailChangeReader.id;
    await page.goto(`${base}/admin/users/${encodeURIComponent(emailChangeReaderId)}`);
    await visible(page, 'Detalle de usuario');
    phase = 'Reader administrative email-change create, replace, resend, and cancel';
    const canonicalReaderEmail = emailChangeReaderEmail;
    phase = 'Reader email-change account ETag lookup';
    const accountBeforeCreate = await http(
      `/v1/admin/users/${encodeURIComponent(emailChangeReaderId)}`,
      {
        headers: { cookie: cookieHeader },
      },
    );
    assert(accountBeforeCreate.status === 200, 'email-change account revision available');
    const initialAccountEtag = accountBeforeCreate.headers.get('etag');
    assert(initialAccountEtag !== null, 'email-change creation receives account ETag');
    await accountBeforeCreate.arrayBuffer();
    const emailChangeKeys: string[] = [];
    const emailChangeEtags: string[] = [];
    let rejectEmailChangeScheduling = true;
    await page.route(`**/v1/admin/users/${emailChangeReaderId}/email-changes`, async (route) => {
      emailChangeKeys.push(route.request().headers()['idempotency-key'] ?? '');
      emailChangeEtags.push(route.request().headers()['if-match'] ?? '');
      if (rejectEmailChangeScheduling) {
        rejectEmailChangeScheduling = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'urn:problem:delivery-scheduling-failed',
            title: 'Delivery scheduling failed',
            status: 503,
            code: 'delivery-scheduling-failed',
          }),
        });
        return;
      }
      await route.continue();
    });
    phase = 'Reader email-change lifecycle controls';
    await selectTab(page, 'Ciclo de vida');
    phase = 'Reader email-change render pending state';
    await page
      .getByText('No hay una solicitud de cambio de correo pendiente.', { exact: true })
      .waitFor();
    phase = 'Reader email-change input';
    await page
      .getByLabel('Nuevo correo', { exact: true })
      .fill('qa-email-change-first@example.com');
    phase = 'Reader email-change initial 503 request';
    const failedCreate = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/email-changes'),
    );
    await page.getByRole('button', { name: 'Iniciar cambio', exact: true }).click();
    phase = 'Reader email-change 503 response arrival';
    const failedCreateResponse = await failedCreate;
    phase = `Reader email-change scheduling status ${String(failedCreateResponse.status())}`;
    assert(failedCreateResponse.status() === 503, 'email-change scheduling failure is retryable');
    phase = 'Reader email-change 503 status message';
    await page
      .getByText('No pudimos programar los avisos. Reintenta con la misma solicitud.', {
        exact: true,
      })
      .waitFor();
    phase = 'Reader email-change retry';
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/email-changes'),
    );
    const createDetailRefresh = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().endsWith(`/v1/admin/users/${emailChangeReaderId}`),
    );
    await page.getByRole('button', { name: 'Reintentar solicitud', exact: true }).click();
    const createdEmailChange = await createResponse;
    assert(createdEmailChange.status() === 201, 'email-change retry creates the workflow');
    const createdChange = (await createdEmailChange.json()) as {
      workflowId: string;
      email: string;
      state: string;
      revision: number;
    };
    const refreshedCreateDetail = await createDetailRefresh;
    assert(
      refreshedCreateDetail.status() === 200,
      'successful retry refreshes committed Reader detail',
    );
    const refreshedCreateBody: unknown = await refreshedCreateDetail.json();
    const refreshedCreateParse = AdminReaderDetailSchema.safeParse(refreshedCreateBody);
    assert(refreshedCreateParse.success, 'committed email-change detail matches Admin contract');
    assert(
      refreshedCreateParse.data.activeWorkflows.some(
        (workflow) =>
          workflow.type === 'email-change' &&
          workflow.id === createdChange.workflowId &&
          workflow.email === createdChange.email,
      ),
      'committed detail refresh projects the new pending email-change workflow',
    );
    await selectTab(page, 'Ciclo de vida');
    assert(
      emailChangeKeys.length === 2 &&
        emailChangeKeys[0] !== '' &&
        emailChangeKeys[0] === emailChangeKeys[1] &&
        emailChangeEtags.every((etag) => etag === initialAccountEtag),
      'create retry preserves its Idempotency-Key and account ETag',
    );
    assert(
      createdChange.email === 'qa-email-change-first@example.com' &&
        createdChange.state === 'pending' &&
        createdChange.revision === 1,
      'created response exposes only safe email-change state',
    );
    assert(
      !/token|actionUrl|password|emailBody/i.test(JSON.stringify(createdChange)),
      'email-change response contains no secrets or message body',
    );
    phase = 'Reader email-change pending projection';
    await page.getByText('qa-email-change-first@example.com', { exact: true }).waitFor();
    await page.getByText('Expira', { exact: true }).waitFor();
    await page.getByText('Revisión del workflow', { exact: true }).waitFor();
    const canonicalAfterCreate = await http(
      `/v1/admin/users/${encodeURIComponent(emailChangeReaderId)}`,
      {
        headers: { cookie: cookieHeader },
      },
    );
    assert(canonicalAfterCreate.status === 200, 'canonical Reader remains readable after create');
    const canonicalAfterCreateBody = (await canonicalAfterCreate.json()) as { email?: unknown };
    assert(
      canonicalAfterCreateBody.email === canonicalReaderEmail,
      'create keeps the old canonical email',
    );

    const accountBeforeReplace = await http(
      `/v1/admin/users/${encodeURIComponent(emailChangeReaderId)}`,
      {
        headers: { cookie: cookieHeader },
      },
    );
    assert(accountBeforeReplace.status === 200, 'replacement account revision available');
    const replacementAccountEtag = accountBeforeReplace.headers.get('etag');
    assert(replacementAccountEtag !== null, 'replacement receives current account ETag');
    await accountBeforeReplace.arrayBuffer();
    await page
      .getByLabel('Reemplazar con otro correo', { exact: true })
      .fill('qa-email-change-replacement@example.com');
    const replacementRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/email-changes'),
    );
    const replacementResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/email-changes'),
    );
    await page.getByRole('button', { name: 'Reemplazar solicitud', exact: true }).click();
    const replacementReq = await replacementRequest;
    const replacedEmailChange = await replacementResponse;
    assert(replacedEmailChange.status() === 200, 'pending email change is replaced');
    assert(
      replacementReq.headers()['if-match'] === replacementAccountEtag &&
        (replacementReq.headers()['idempotency-key'] ?? '').length > 0,
      'replacement uses account ETag and Idempotency-Key',
    );
    const replacementBody = (await replacedEmailChange.json()) as {
      workflowId: string;
      email: string;
      revision: number;
    };
    assert(
      replacementBody.workflowId !== createdChange.workflowId &&
        replacementBody.email === 'qa-email-change-replacement@example.com' &&
        replacementBody.revision === 1,
      'replacement supersedes the prior workflow with a new safe workflow',
    );
    await selectTab(page, 'Ciclo de vida');
    const canonicalAfterReplace = await http(
      `/v1/admin/users/${encodeURIComponent(emailChangeReaderId)}`,
      {
        headers: { cookie: cookieHeader },
      },
    );
    assert(canonicalAfterReplace.status === 200, 'canonical Reader remains readable after replace');
    const canonicalAfterReplaceBody = (await canonicalAfterReplace.json()) as { email?: unknown };
    assert(
      canonicalAfterReplaceBody.email === canonicalReaderEmail,
      'replace keeps the old canonical email',
    );

    await sql(
      `UPDATE reader_email_change_workflow SET cooldown_until = ${String(Date.now() - 1)} WHERE id = '${replacementBody.workflowId}'`,
    );
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).click();
    await page.getByText('Disponible para reenviar', { exact: true }).waitFor();
    const resendRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().endsWith(`/email-changes/${replacementBody.workflowId}/messages`),
    );
    const resendResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/email-changes/${replacementBody.workflowId}/messages`),
    );
    await page.getByRole('button', { name: 'Reenviar avisos', exact: true }).click();
    const resendReq = await resendRequest;
    const resent = await resendResponse;
    assert(resent.status() === 202, 'email-change resend is accepted');
    assert(
      (resendReq.headers()['idempotency-key'] ?? '').length > 0,
      'email-change resend carries Idempotency-Key',
    );
    const resendBody = (await resent.json()) as { workflowId: string; revision: number };
    assert(
      resendBody.workflowId === replacementBody.workflowId && resendBody.revision === 2,
      'resend returns the current workflow revision',
    );
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).click();
    await page.getByText('qa-email-change-replacement@example.com', { exact: true }).waitFor();
    await page.getByText('Revisión del workflow', { exact: true }).waitFor();
    assert(
      await page.getByRole('button', { name: 'Cancelar solicitud', exact: true }).isEnabled(),
      'a reloaded pending workflow is immediately cancellable using its persisted revision',
    );
    const cancelRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        request.url().endsWith(`/email-changes/${replacementBody.workflowId}`),
    );
    const cancelResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/email-changes/${replacementBody.workflowId}`),
    );
    await page.getByRole('button', { name: 'Cancelar solicitud', exact: true }).click();
    const cancelReq = await cancelRequest;
    const cancelled = await cancelResponse;
    assert(cancelled.status() === 200, 'email-change cancellation is committed');
    assert(
      cancelReq.headers()['if-match'] === '"2"' &&
        (cancelReq.headers()['idempotency-key'] ?? '').length > 0,
      'cancellation uses workflow ETag and Idempotency-Key',
    );
    const cancelledBody: unknown = await cancelled.json();
    assert(
      typeof cancelledBody === 'object' &&
        cancelledBody !== null &&
        'state' in cancelledBody &&
        cancelledBody.state === 'cancelled',
      'terminal cancellation state is rendered by the UI',
    );
    await page
      .getByText('Estado terminal de la solicitud anterior: cancelled.', { exact: true })
      .waitFor();
    await page.unroute(`**/v1/admin/users/${emailChangeReaderId}/email-changes`);
    phase = 'user detail, reload, back and direct navigation';
    await page.goto(`${base}/admin/users`);
    phase = 'user list after email-change cleanup';
    await visible(page, 'Usuarios');
    await sql(`DELETE FROM "user" WHERE id = '${emailChangeReaderId}'`);
    const detailLookup = await http(`/v1/admin/users?email=${encodeURIComponent(regular)}`, {
      headers: { cookie: cookieHeader },
    });
    assert(detailLookup.status === 200, 'admin detail lookup for fixture');
    const detailPayload = (await detailLookup.json()) as {
      items?: { id?: unknown; email?: unknown }[];
    };
    const regularDetailId = detailPayload.items?.[0]?.id;
    assert(
      typeof regularDetailId === 'string' && regularDetailId.length > 0,
      'regular detail identifier resolved',
    );
    await searchBox.fill(regular);
    await page.getByText('1 usuario en total', { exact: true }).waitFor();
    await table.getByText(regular, { exact: true }).waitFor();
    phase = 'regular Reader detail after email-change flow';
    let detailAccountDetailsReads = 0;
    await page.route('**/v1/admin/users/*/account-details', async (route) => {
      detailAccountDetailsReads++;
      await route.continue();
    });
    await page.getByRole('link', { name: 'Ver detalle', exact: true }).click();
    phase = 'regular Reader detail fields';
    await visible(page, 'Detalle de usuario');
    await page.getByText(regular, { exact: true }).waitFor();
    await page.getByText('Correo verificado', { exact: true }).waitFor();
    await page.getByText('Identificador', { exact: true }).waitFor();
    await page.getByText('Rol', { exact: true }).waitFor();
    const tabs = page.getByRole('tab');
    assert(
      (await tabs.allTextContents()).join('|') ===
        'Resumen|Acceso|Sesiones|Ciclo de vida|Actividad',
      'Reader detail exposes the approved tab order',
    );
    await selectTab(page, 'Acceso');
    await page.getByText('Permitido', { exact: true }).waitFor();
    await page.getByText('Contraseña', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Sesiones', exact: true }).click();
    await page
      .getByText('La consulta y gestión de sesiones estará disponible en una próxima entrega.', {
        exact: true,
      })
      .waitFor();
    await selectTab(page, 'Ciclo de vida');
    phase = 'deletion lifecycle panel visible';
    await page.getByRole('heading', { name: 'Solicitud de eliminación', exact: true }).waitFor();
    const deletionNote = 'Browser acceptance private decision note';
    await page.getByLabel('Nota (opcional)', { exact: true }).fill(deletionNote);
    const deletionCreateRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/deletion-requests'),
    );
    const deletionCreateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/deletion-requests'),
    );
    await page.getByRole('button', { name: 'Crear solicitud', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Confirmar acción' }).waitFor();
    assert(
      await page.getByRole('button', { name: 'Confirmar', exact: true }).isVisible(),
      'create requires accessible confirmation',
    );
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    phase = 'deletion create response';
    const createRequest = await deletionCreateRequest;
    const deletionCreatedResponse = await deletionCreateResponse;
    assert(
      deletionCreatedResponse.status() === 201,
      'deletion request is created through real Worker/D1',
    );
    assert(
      (createRequest.headers()['if-match'] ?? '').length > 0 &&
        (createRequest.headers()['idempotency-key'] ?? '').length > 0,
      'create uses account ETag and Idempotency-Key',
    );
    const createdDeletion = (await deletionCreatedResponse.json()) as {
      requestId: string;
      revision: number;
      previousAccessState: string;
    };
    assert(
      createdDeletion.previousAccessState === 'active' && createdDeletion.revision === 1,
      'request snapshots prior access',
    );
    const createdDeletionDetail = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}`,
      { headers: { cookie: cookieHeader } },
    );
    assert(createdDeletionDetail.status === 200, 'created deletion detail remains readable');
    const createdDeletionProjection = (await createdDeletionDetail.json()) as {
      deletionState?: unknown;
      access?: { state?: unknown; effectiveState?: unknown };
      activeWorkflows?: { type?: unknown; id?: unknown; previousAccessState?: unknown }[];
    };
    assert(
      createdDeletionProjection.deletionState === 'pending_review' &&
        createdDeletionProjection.access?.effectiveState === 'suspended' &&
        createdDeletionProjection.activeWorkflows?.some(
          (workflow) =>
            workflow.type === 'deletion-request' && workflow.id === createdDeletion.requestId,
        ),
      'detail projects the active deletion workflow and suspension after commit',
    );
    await page.reload();
    phase = 'deletion detail reload heading';
    await visible(page, 'Detalle de usuario');
    phase = 'deletion lifecycle after reload';
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).click();
    phase = 'deletion snapshot after reload';
    await page.getByText('Acceso previo (snapshot): Activo', { exact: true }).waitFor();
    assert(
      await page.getByRole('button', { name: 'Aprobar solicitud', exact: true }).isDisabled(),
      'approval requires a non-empty note',
    );
    phase = 'deletion access control blocking';
    const accessPage = await page.context().newPage();
    await accessPage.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}`);
    await visible(accessPage, 'Detalle de usuario');
    await selectTab(accessPage, 'Acceso');
    assert(
      await accessPage
        .getByRole('button', { name: 'Deshabilitar acceso', exact: true })
        .isDisabled(),
      'active deletion blocks access changes',
    );
    await accessPage.close();
    const activeAfterAccessRead = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}`,
      { headers: { cookie: cookieHeader } },
    );
    assert(
      activeAfterAccessRead.status === 200,
      'Reader detail remains readable after access-control check',
    );
    const activeAfterAccessBody = (await activeAfterAccessRead.json()) as {
      deletionState?: unknown;
    };
    assert(
      activeAfterAccessBody.deletionState === 'pending_review',
      'access-control check leaves deletion workflow active',
    );
    assert(
      await page.getByRole('button', { name: 'Iniciar cambio', exact: true }).isDisabled(),
      'active deletion blocks email changes',
    );
    phase = 'deletion decision note and transition';
    await page
      .getByLabel('Nota (obligatoria para aprobar o rechazar)', { exact: true })
      .fill(deletionNote);
    await page.getByRole('button', { name: 'Aprobar solicitud', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Confirmar acción' }).waitFor();
    await page.getByRole('button', { name: 'Volver', exact: true }).click();
    const decisionRequest = page.waitForRequest(
      (request) =>
        request.method() === 'PUT' &&
        request.url().endsWith(`/deletion-requests/${createdDeletion.requestId}/status`),
    );
    const decisionKeys: string[] = [];
    const decisionBodies: string[] = [];
    let failDecisionOnce = true;
    await page.route(
      `**/v1/admin/users/${regularDetailId}/deletion-requests/${createdDeletion.requestId}/status`,
      async (route) => {
        decisionKeys.push(route.request().headers()['idempotency-key'] ?? '');
        decisionBodies.push(JSON.stringify(route.request().postDataJSON()));
        if (failDecisionOnce) {
          failDecisionOnce = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({ status: 503, code: 'internal-error' }),
          });
        } else {
          await route.continue();
        }
      },
    );
    await page.getByRole('button', { name: 'Rechazar solicitud', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Confirmar acción' }).waitFor();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await page
      .getByText(
        'No recibimos una respuesta definitiva. Reintenta esta misma acción para comprobar el resultado.',
        { exact: true },
      )
      .waitFor();
    phase = 'deletion retry payload freeze draft edit';
    await page
      .locator('#deletion-decision-note')
      .fill('Changed draft must not alter the pending command');
    const retryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/deletion-requests/${createdDeletion.requestId}/status`),
    );
    phase = 'deletion retry payload freeze response';
    await page.getByRole('button', { name: 'Reintentar acción pendiente', exact: true }).click();
    const transitionResponse = await retryResponse;
    assert(
      transitionResponse.status() === 200,
      'ambiguous transition retries to committed Worker response',
    );
    assert(
      decisionKeys.length === 2 && decisionKeys[0] !== '' && decisionKeys[0] === decisionKeys[1],
      'ambiguous transition retry reuses Idempotency-Key',
    );
    assert(
      decisionBodies.length === 2 &&
        decisionBodies[0] === decisionBodies[1] &&
        decisionBodies[0]?.includes(deletionNote) === true &&
        !decisionBodies[1]?.includes('Changed draft'),
      'ambiguous transition retry sends the frozen original body despite draft edits',
    );
    await page.unroute(
      `**/v1/admin/users/${regularDetailId}/deletion-requests/${createdDeletion.requestId}/status`,
    );
    const transitionRequest = await decisionRequest;
    assert(transitionResponse.status() === 200, 'review transition commits');
    assert(
      transitionRequest.headers()['if-match'] === '"1"' &&
        (transitionRequest.headers()['idempotency-key'] ?? '').length > 0,
      'transition uses workflow ETag and Idempotency-Key',
    );
    const transitioned = (await transitionResponse.json()) as { state: string; changed: boolean };
    assert(
      transitioned.state === 'rejected' && transitioned.changed,
      'reject is an observable transition',
    );
    phase = 'rejection committed detail refresh';
    await page
      .getByText(
        'No hay una solicitud activa. Crear una suspende el acceso y revoca las sesiones.',
        { exact: true },
      )
      .waitFor();
    const rejectedLedger = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/activity?limit=25`,
      { headers: { cookie: cookieHeader } },
    );
    const rejectedLedgerText = await rejectedLedger.text();
    assert(
      !rejectedLedgerText.includes(deletionNote),
      'decision note is absent from activity projection',
    );
    phase = 'rejection reload restoration';
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByRole('tab', { name: 'Acceso', exact: true }).click();
    await page.getByText('Permitido', { exact: true }).waitFor();
    assert(
      (await page.locator('body').innerText()).includes('Activo'),
      'rejection restores active access after reload',
    );
    phase = 'rejection restored';
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).click();
    await page.getByRole('button', { name: 'Crear solicitud', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Confirmar acción' }).waitFor();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await page.getByText('Acceso previo (snapshot): Activo', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancelar solicitud', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Confirmar acción' }).waitFor();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await page
      .getByText(
        'No hay una solicitud activa. Crear una suspende el acceso y revoca las sesiones.',
        { exact: true },
      )
      .waitFor();
    phase = 'deletion request and rejection activity';
    await page.getByRole('tab', { name: 'Actividad', exact: true }).click();
    await page.getByText('deletion-requested', { exact: true }).first().waitFor();
    await page.getByText('deletion-rejected', { exact: true }).waitFor();
    phase = 'deletion activity privacy';
    assert(
      !(await page.locator('body').innerText()).includes(deletionNote),
      'activity omits arbitrary decision note',
    );
    const activityValues = Array.from({ length: 26 }, (_, index) => {
      const number = index + 1;
      const type = number === 26 ? 'email-verified' : 'access-disabled';
      return `('browser-event-${String(number).padStart(2, '0')}', 1, '${type}', ${String(1_700_000_000_000 + number)}, 'administrator', '${administratorId}', 'reader', '${regularDetailId}', 'success', 'browser-request-${String(number)}', NULL, '{"token":"not-projected"}')`;
    }).join(',');
    await sql(
      `INSERT INTO identity_event (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id, result, request_id, problem_code, metadata) VALUES ${activityValues}`,
    );
    await page.reload();
    phase = 'regular Reader activity detail reload';
    await visible(page, 'Detalle de usuario');
    let releaseActivity: (() => void) | undefined;
    const activityGate = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    await page.route('**/v1/admin/users/*/activity*', async (route) => {
      await activityGate;
      await route.continue();
    });
    await page.getByRole('tab', { name: 'Actividad', exact: true }).click();
    await page.getByText('Cargando actividad…', { exact: true }).waitFor();
    releaseActivity?.();
    await page.getByText('access-disabled', { exact: true }).first().waitFor();
    assert(
      (await page.getByText('not-projected', { exact: false }).count()) === 0,
      'activity never renders ledger metadata',
    );
    await page.unroute('**/v1/admin/users/*/activity*');
    await page.getByRole('button', { name: 'Cargar más', exact: true }).click();
    await page.getByText('email-verified', { exact: true }).waitFor();

    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.route('**/v1/admin/users/*/activity*', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:problem:internal-error',
          title: 'Internal Server Error',
          status: 500,
          code: 'internal-error',
        }),
      });
    });
    await page.getByRole('tab', { name: 'Actividad', exact: true }).click();
    await page
      .getByText('No pudimos cargar la actividad. Tu sesión se conserva.', { exact: true })
      .waitFor();
    await page.unroute('**/v1/admin/users/*/activity*');
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await page.getByText('access-disabled', { exact: true }).first().waitFor();
    assert(
      page.url().includes(`/admin/users/${encodeURIComponent(regularDetailId)}`) &&
        !page.url().includes('/show'),
      'list preserves the established User detail route',
    );
    assert(detailAccountDetailsReads === 0, 'safe User detail does not depend on Account Details');
    await page.unroute('**/v1/admin/users/*/account-details');
    await page.getByRole('link', { name: 'Volver a la lista', exact: true }).click();
    await visible(page, 'Usuarios');
    assert((await searchBox.inputValue()).trim().toLowerCase() === regular, 'back restores search');
    await page.getByText('1 usuario en total', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Ver detalle', exact: true }).click();
    await visible(page, 'Detalle de usuario');
    await page.getByRole('link', { name: 'Editar datos de cuenta', exact: true }).click();
    await visible(page, 'Editar datos de cuenta');
    assert(
      page.url().includes(`/admin/users/${encodeURIComponent(regularDetailId)}/edit`),
      'account details use an explicit edit route',
    );
    const firstNameInput = page.getByRole('textbox', { name: 'Nombre', exact: true });
    await firstNameInput.waitFor();
    assert((await firstNameInput.inputValue()) === '', 'missing Account Details render empty');
    await firstNameInput.fill('Ada');
    await page.getByRole('textbox', { name: 'Apellidos', exact: true }).fill('Lovelace');
    await page.getByLabel('Fecha de nacimiento', { exact: true }).fill('1815-12-10');
    await page.getByRole('textbox', { name: 'Teléfono', exact: true }).fill('+44 20 7946 0958');
    await page
      .getByRole('textbox', { name: 'Referencia de imagen HTTPS', exact: true })
      .fill('https://images.example.test/ada.png');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await page.getByRole('status').getByText('Cambios guardados.', { exact: true }).waitFor();
    const accountDetailsPath = `/v1/admin/users/${encodeURIComponent(regularDetailId)}/account-details`;
    const accountDetailsResponse = await http(accountDetailsPath, {
      headers: { cookie: cookieHeader },
    });
    assert(accountDetailsResponse.status === 200, 'administrator reads edited Account Details');
    const accountDetails = (await accountDetailsResponse.json()) as {
      firstName?: unknown;
      lastName?: unknown;
      birthDate?: unknown;
      phone?: unknown;
      image?: unknown;
    };
    assert(
      accountDetails.firstName === 'Ada' &&
        accountDetails.lastName === 'Lovelace' &&
        accountDetails.birthDate === '1815-12-10' &&
        accountDetails.phone === '+44 20 7946 0958' &&
        accountDetails.image === 'https://images.example.test/ada.png',
      'Admin form persisted real Account Details through HTTP',
    );
    phase = 'account edit authorization failures';
    await firstNameInput.fill('Grace');
    await sql('UPDATE "admin_session" SET expires_at = 0');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await visible(page, 'Administración');
    await signIn(page, admin, password);
    await visible(page, 'Sesión de administración');
    cookieHeader = (await context.cookies())
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    token = (await context.cookies()).find((cookie) => cookie.name.endsWith('session_token'));
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}/edit`);
    await visible(page, 'Editar datos de cuenta');
    const activeToken = token;
    assert(activeToken !== undefined, 'refreshed Admin cookie is available');
    await page
      .getByRole('textbox', { name: 'Referencia de imagen HTTPS', exact: true })
      .fill('http://images.example.test/insecure.png');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await page
      .getByRole('alert')
      .getByText('Revisa la fecha y los datos introducidos.', { exact: true })
      .waitFor();
    const afterInvalidEdit = await http(accountDetailsPath, {
      headers: { cookie: cookieHeader },
    });
    assert(afterInvalidEdit.status === 200, 'Account Details remain readable after invalid edit');
    const unchangedDetails = (await afterInvalidEdit.json()) as { image?: unknown };
    assert(
      unchangedDetails.image === 'https://images.example.test/ada.png',
      'invalid HTTPS reference does not partially update Account Details',
    );
    const adminSessionAfterEdit = await http('/v1/admin/me', {
      headers: { cookie: cookieHeader },
    });
    assert(adminSessionAfterEdit.status === 200, 'Admin session remains valid after target update');
    await page.reload();
    await visible(page, 'Editar datos de cuenta');
    await page.getByText(regular, { exact: true }).waitFor();
    assert(
      (await page.getByRole('textbox', { name: 'Nombre', exact: true }).inputValue()) === 'Ada' &&
        (await page.getByRole('textbox', { name: 'Apellidos', exact: true }).inputValue()) ===
          'Lovelace' &&
        (await page.getByLabel('Fecha de nacimiento', { exact: true }).inputValue()) ===
          '1815-12-10',
      'Account Details reload from saved Worker values',
    );
    await page.goto(`${base}/admin/users`);
    await visible(page, 'Usuarios');
    await page.getByText('14 usuarios en total', { exact: true }).waitFor();
    await searchBox.fill(regular);
    await page.getByText('1 usuario en total', { exact: true }).waitFor();
    await table.getByText(regular, { exact: true }).waitFor();
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}`);
    await visible(page, 'Detalle de usuario');
    await page.getByText(regular, { exact: true }).waitFor();
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByText(regular, { exact: true }).waitFor();
    await page.goto(`${base}/admin/users/does-not-exist-41/edit`);
    await visible(page, 'Editar datos de cuenta');
    await page.getByText('Usuario no encontrado', { exact: true }).waitFor();
    await page.goto(`${base}/admin/users/does-not-exist-41/show`);
    await visible(page, 'Usuario no encontrado');
    await page.getByRole('link', { name: 'Volver a la lista', exact: true }).click();
    await visible(page, 'Usuarios');
    await page.getByText('14 usuarios en total', { exact: true }).waitFor();
    phase = 'retryable User list failure';
    await sql('ALTER TABLE "admin_session" RENAME TO "admin_session_qa_list_unavailable"');
    try {
      await page
        .getByRole('navigation', { name: 'pagination' })
        .getByText('2', { exact: true })
        .click();
      await page
        .getByRole('alert')
        .getByText('No pudimos cargar los usuarios. Tu sesión se conserva.', { exact: true })
        .waitFor();
      assert((await page.getByRole('table').count()) === 0, 'list error hides previous page');
    } finally {
      await sql('ALTER TABLE "admin_session_qa_list_unavailable" RENAME TO "admin_session"');
    }
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'pagination' })
      .getByText('2', { exact: true })
      .click();
    await page.getByText('11-14 de 14', { exact: true }).waitFor();
    await table.getByText('qa-list-11@example.com', { exact: true }).waitFor();
    await page
      .getByRole('navigation', { name: 'pagination' })
      .getByText('1', { exact: true })
      .click();
    await page.getByText('1-10 de 14', { exact: true }).waitFor();
    assert(
      (await table.getByText(admin, { exact: true }).count()) === 0,
      'Admin identity is not listed as a Reader',
    );
    await page.goto(`${base}/admin/`);
    await visible(page, 'Sesión de administración');
    phase = 'retryable service failure';
    await sql('ALTER TABLE "admin_session" RENAME TO "admin_session_qa_unavailable"');
    try {
      await page.reload();
      await visible(page, 'El servicio no está disponible');
      assert(
        (await context.cookies()).some(
          (cookie) => cookie.name === activeToken.name && cookie.value === activeToken.value,
        ),
        'server failure preserves cookie',
      );
    } finally {
      await sql('ALTER TABLE "admin_session_qa_unavailable" RENAME TO "admin_session"');
    }
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await visible(page, 'Sesión de administración');
    phase = 'administrator logout';
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await visible(page, 'Administración');
    for (const path of ['/v1/me', '/v1/admin/me']) {
      const response = await http(path, { headers: { cookie: cookieHeader } });
      assert(response.status === 401, 'logout revokes old cookie');
      await response.arrayBuffer();
    }
    await page.goto(`${base}/admin/`);
    await visible(page, 'Administración');
    phase = 'regular User login and denial';
    const readerLogin = await context.request.post(`${base}/v1/auth/login`, {
      data: { email: regular, password },
    });
    assert(readerLogin.status() === 200, 'Reader credentials establish only a Reader session');
    await readerLogin.body();
    await page.goto(`${base}/admin/`);
    await visible(page, 'Acceso denegado');
    await page.reload();
    await visible(page, 'Acceso denegado');
    await page.goto(`${base}/admin/unknown-route`);
    await visible(page, 'Acceso denegado');
    assert(
      (await page.getByRole('button', { name: 'Menú de usuario', exact: true }).count()) === 0,
      'denied route does not expose administrative layout',
    );
    const regularResponse = await context.request.get(`${base}/v1/me`);
    assert(regularResponse.status() === 200, '403 denial preserves regular User session');
    const deniedResponse = await context.request.get(`${base}/v1/admin/me`);
    assert(deniedResponse.status() === 403, 'server remains permission authority');
    await page.goto(`${base}/admin/users`);
    await visible(page, 'Acceso denegado');
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}/show`);
    await visible(page, 'Acceso denegado');
    await page.goto(`${base}/admin/denegado`);
    await visible(page, 'Acceso denegado');
    assert(
      (await page.getByRole('button', { name: 'Menú de usuario', exact: true }).count()) === 0,
      'denied route does not expose administrative layout',
    );
    const deniedList = await context.request.get(`${base}/v1/admin/users`);
    assert(deniedList.status() === 403, 'user list stays protected for regular Users');
    await deniedList.body();
    const readerLogout = await context.request.post(`${base}/v1/auth/sign-out`, { data: {} });
    assert(readerLogout.status() === 200, 'Reader logout targets Reader session only');
    await readerLogout.body();
    await visible(page, 'Administración');
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}`);
    await visible(page, 'Administración');
    phase = 'unverified login';
    const unverifiedLogin = await context.request.post(`${base}/v1/auth/login`, {
      data: { email: unverified, password },
    });
    assert(unverifiedLogin.status() === 403, 'unverified Reader remains blocked by Reader policy');
    await unverifiedLogin.body();
    phase = 'expired session';
    await signIn(page, admin, password);
    await visible(page, 'Sesión de administración');
    await sql('UPDATE "admin_session" SET expires_at = 0');
    await page.reload();
    await visible(page, 'Administración');
    const expired = await context.request.get(`${base}/v1/admin/me`);
    assert(expired.status() === 401, 'expired cookie is rejected');
    phase = 'expiry between authorization and identity';
    await signIn(page, admin, password);
    await visible(page, 'Sesión de administración');
    let identityReads = 0;
    await page.route('**/v1/admin/me', async (route) => {
      identityReads++;
      if (identityReads === 2) await sql('UPDATE "admin_session" SET expires_at = 0');
      await route.continue();
    });
    // Delay only a real request to mutate isolated D1 between the two reads;
    // no response is fulfilled or mocked.
    await page.reload();
    await visible(page, 'Administración');
    assert(identityReads >= 2, 'identity read observes expiration after authorization');
    await page.unroute('**/v1/admin/me');
    phase = 'mobile layout';
    await page.setViewportSize({ width: 360, height: 740 });
    await page.reload();
    await visible(page, 'Administración');
    assert(
      await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
      'narrow login fits viewport',
    );
    await signIn(page, admin, password);
    await page.goto(`${base}/admin/users`);
    await visible(page, 'Usuarios');
    await page.getByRole('button', { name: 'Alternar menú', exact: true }).click();
    await page.getByRole('link', { name: 'Inicio', exact: true }).click();
    await visible(page, 'Sesión de administración');
    await page.getByRole('button', { name: 'Alternar menú', exact: true }).click();
    await page.getByRole('link', { name: 'Usuarios', exact: true }).click();
    await visible(page, 'Usuarios');
    await page.getByRole('table').waitFor();
    assert(
      await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
      'narrow user list fits viewport',
    );
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}/show`);
    await visible(page, 'Detalle de usuario');
    await page.locator('[data-slot="tabs-trigger"]').first().waitFor();
    assert(
      (await page.locator('[data-slot="tabs-trigger"]').count()) === 5,
      'all Reader detail tabs remain available on mobile',
    );
    const detailOverflow = await page.evaluate<{
      fits: boolean;
      offenders: string[];
    }>(`(() => ({
      fits: document.documentElement.scrollWidth <= window.innerWidth,
      offenders: [...document.querySelectorAll('*')]
        .filter(node => node.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5)
        .map(node => node.getAttribute('data-slot') || node.tagName)
    }))()`);
    assert(
      detailOverflow.fits,
      `narrow user detail fits viewport (${detailOverflow.offenders.join(',')})`,
    );
    await context.close();
    console.log(
      'Administration browser acceptance passed: admin, list/detail, regular denial, retry, expiry, logout, routing and keyboard/mobile.',
    );
  } catch (cause) {
    if (diagnosticPage !== undefined && !diagnosticPage.isClosed()) {
      const summary = await Promise.race([
        diagnosticPage
          .evaluate<string>(
            `JSON.stringify({
        path: location.pathname,
        headings: [...document.querySelectorAll('h1')].map(node => node.textContent),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
        text: document.body.innerText.slice(0, 1200),
      })`,
          )
          .catch(() => 'Page diagnostics unavailable'),
        pause(2000).then(() => 'Page diagnostics timed out'),
      ]);
      // Only fixed UI labels; fixture emails are redacted and no form values,
      // cookies, storage, response bodies or action URLs are inspected here.
      console.info(
        'Administration browser state:',
        summary.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[fixture]').slice(0, 1800),
      );
    }
    throw new Error(`Administration browser acceptance failed during ${phase}`, { cause });
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
  runAdminBrowserTest().catch((cause: unknown) => {
    // Raw browser/transport exceptions can carry fixture values; no raw output.
    console.error(
      cause instanceof Error ? cause.message : 'Administration browser acceptance failed.',
    );
    process.exitCode = 1;
  });
}
