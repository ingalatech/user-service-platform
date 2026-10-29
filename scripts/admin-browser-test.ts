import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';

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
    for (const [path, fields] of [
      ['/v1/admin/me', ['email', 'emailVerified', 'id', 'realm', 'role']],
    ] as const) {
      const response = await http(path, { headers: { cookie: cookieHeader } });
      assert(response.status === 200, 'authenticated HTTP identity');
      const payload: unknown = await response.json();
      assert(
        typeof payload === 'object' &&
          payload !== null &&
          Object.keys(payload).sort().join(',') === fields.join(','),
        'exact application-owned identity fields',
      );
    }
    const readerMe = await http('/v1/me', { headers: { cookie: cookieHeader } });
    assert(readerMe.status === 401, 'Administrator cookie is not a Reader session');
    await readerMe.arrayBuffer();
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
    const tableRegion = page.getByRole('region', { name: 'Listado de usuarios', exact: true });
    await tableRegion.waitFor();
    const table = tableRegion.getByRole('table');
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
    await page.goto(`${base}/admin/users/${encodeURIComponent(deletedId)}`);
    await visible(page, 'Editar datos de cuenta');
    await sql(`DELETE FROM "user" WHERE id = '${deletedId}'`);
    await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Deleted');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await page.getByText('Usuario no encontrado', { exact: true }).waitFor();
    phase = 'user detail, reload, back and direct navigation';
    await page.goto(`${base}/admin/users`);
    await visible(page, 'Usuarios');
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
    await page.getByRole('link', { name: 'Ver detalle', exact: true }).click();
    await visible(page, 'Detalle de usuario');
    await page.getByText(regular, { exact: true }).waitFor();
    await page.getByText('Correo verificado', { exact: true }).waitFor();
    await page.getByText('Identificador', { exact: true }).waitFor();
    await page.getByText('Rol', { exact: true }).waitFor();
    assert(
      page.url().endsWith(`/admin/users/${encodeURIComponent(regularDetailId)}/show`),
      'show uses canonical resource route',
    );
    await page.getByRole('link', { name: 'Editar datos de cuenta', exact: true }).click();
    await visible(page, 'Editar datos de cuenta');
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
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}`);
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
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}/show`);
    await visible(page, 'Detalle de usuario');
    await page.getByText(regular, { exact: true }).waitFor();
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByText(regular, { exact: true }).waitFor();
    await page.goto(`${base}/admin/users/does-not-exist-41`);
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
    await page.getByRole('table').waitFor();
    assert(
      await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
      'narrow user list fits viewport',
    );
    await page.goto(`${base}/admin/users/${encodeURIComponent(regularDetailId)}/show`);
    await visible(page, 'Detalle de usuario');
    assert(
      await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
      'narrow user detail fits viewport',
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
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent)
      })`,
          )
          .catch(() => 'Page diagnostics unavailable'),
        pause(2000).then(() => 'Page diagnostics timed out'),
      ]);
      // Only fixed UI labels; fixture emails are redacted and no form values,
      // cookies, storage, response bodies or action URLs are inspected here.
      console.info(
        'Administration browser state:',
        summary.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[fixture]').slice(0, 1000),
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
  runAdminBrowserTest().catch(() => {
    // Raw browser/transport exceptions can carry fixture values; no raw output.
    console.error(
      'Administration browser acceptance failed. Run the test harness for its bounded stage report.',
    );
    process.exitCode = 1;
  });
}
