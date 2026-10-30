import { execFile, spawn, type ChildProcess } from 'node:child_process';
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
  if (!condition) throw new Error(`Administration prototype assertion: ${message}`);
}

async function command(label: string, args: string[]): Promise<void> {
  try {
    await exec(process.execPath, args, { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    throw new Error(`Administration prototype setup failed: ${label}`, { cause });
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
  await new Promise<void>((done, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else done();
    });
  });
  return port;
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let index = 0; index < 20 && child.exitCode === null; index++) await pause(100);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
}

async function visible(page: Page, name: string): Promise<void> {
  await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 15_000 });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  assert(
    await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
    'narrow viewport has no horizontal overflow',
  );
}

export async function runAdminPrototypeBrowserTest(): Promise<void> {
  const state = await mkdtemp(join(tmpdir(), 'user-service-admin-prototype-'));
  const frontendPort = await availablePort();
  const workerPort = await availablePort();
  const workerBase = `http://127.0.0.1:${String(workerPort)}`;
  const frontendBase = `http://127.0.0.1:${String(frontendPort)}`;
  let worker: ChildProcess | undefined;
  let frontend: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const config = join(state, 'wrangler.jsonc');
    const persist = join(state, 'd1');
    const envFile = join(state, '.env');
    await writeFile(envFile, '');
    await writeFile(join(state, '.dev.vars'), '');
    const original = await readFile(join(root, 'wrangler.jsonc'), 'utf8');
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
    worker = spawn(
      process.execPath,
      [cli, 'dev', ...flags, '--ip', '127.0.0.1', '--port', String(workerPort)],
      {
        cwd: root,
        stdio: 'ignore',
        detached: true,
      },
    );
    const health = async () => {
      try {
        const response = await fetch(`${workerBase}/v1/health`);
        await response.arrayBuffer();
        return response.ok;
      } catch {
        return false;
      }
    };
    for (let index = 0; index < 240 && !(await health()); index++) await pause(250);
    assert(await health(), 'isolated Worker readiness');

    const password = 'Prototype-browser-credential-41';
    const admin = 'prototype-admin@example.com';
    const user = 'prototype-user@example.com';
    for (const [path, name, email] of [
      ['/v1/admin/auth/bootstrap', 'Prototype Administrator', admin],
      ['/v1/auth/register', 'Prototype User', user],
    ] as const) {
      const response = await fetch(`${workerBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      assert(response.status === 201, `${path} fixture creation`);
      await response.arrayBuffer();
    }
    await sql(`UPDATE "admin_user" SET email_verified = 1 WHERE email = '${admin}'`);
    await sql(`UPDATE "user" SET email_verified = 1 WHERE email = '${user}'`);
    const loginProbe = await fetch(`${workerBase}/v1/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: admin, password }),
    });
    assert(
      loginProbe.status === 200,
      `isolated admin login probe returned ${String(loginProbe.status)}`,
    );
    const setCookie = loginProbe.headers.get('set-cookie') ?? '';
    const cookiePair = setCookie.split(';', 1)[0] ?? '';
    const separator = cookiePair.indexOf('=');
    assert(separator > 0, 'isolated admin login returned a session cookie');
    const sessionCookie = {
      name: cookiePair.slice(0, separator),
      value: cookiePair.slice(separator + 1),
      domain: '127.0.0.1',
      path: '/v1/admin',
    };
    await loginProbe.arrayBuffer();

    const vite = join(root, 'node_modules/vite/bin/vite.js');
    frontend = spawn(
      process.execPath,
      [vite, '--host', '127.0.0.1', '--port', String(frontendPort)],
      {
        cwd: join(root, 'admin'),
        env: { ...process.env, ADMIN_API_PROXY: workerBase, ADMIN_PROTOTYPE_BROWSER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    frontend.stderr?.on('data', (chunk: Buffer) =>
      process.stderr.write(`prototype Vite: ${String(chunk)}`),
    );
    for (let index = 0; index < 120; index++) {
      try {
        const response = await fetch(`${frontendBase}/admin/`);
        if (response.ok) break;
      } catch {
        /* Still starting. */
      }
      await pause(250);
    }
    const browserPath = process.env.CHROME_PATH;
    browser = await chromium.launch({
      ...(browserPath === undefined ? {} : { executablePath: browserPath }),
      headless: true,
      timeout: 30_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([sessionCookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${frontendBase}/admin/`);
    await visible(page, 'Sesión de administración');

    const cookies = await context.cookies();
    const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const lookup = await fetch(`${workerBase}/v1/admin/users?email=${encodeURIComponent(user)}`, {
      headers: { cookie: cookieHeader },
    });
    const payload = (await lookup.json()) as { items?: { id?: unknown }[] };
    const userId = payload.items?.[0]?.id;
    const resolvedUserId = typeof userId === 'string' ? userId : '';
    assert(resolvedUserId.length > 0, 'prototype User fixture identifier');
    const accountDetails = await fetch(
      `${workerBase}/v1/admin/users/${encodeURIComponent(resolvedUserId)}/account-details`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
        body: JSON.stringify({
          firstName: 'Ada',
          lastName: 'Lovelace',
          birthDate: '1815-12-10',
          phone: '+44 20 7946 0958',
          image: 'https://images.example.test/ada.png',
        }),
      },
    );
    assert(accountDetails.status === 200, 'prototype Account Details fixture');
    await accountDetails.arrayBuffer();

    await page.goto(`${frontendBase}/admin/users/${encodeURIComponent(resolvedUserId)}/show`);
    await visible(page, 'Detalle de usuario');
    await page.getByRole('link', { name: 'Editar datos de cuenta', exact: true }).waitFor();
    const tabs = page.getByRole('tab');
    assert(
      (await tabs.count()) > 0,
      `development prototype tabs rendered: ${await page.locator('body').innerText()}`,
    );
    const tabLabels = (await tabs.allTextContents()).map((label) => label.trim()).join('|');
    assert(
      tabLabels === 'Resumen|Acceso|Sesiones|Ciclo de vida|Actividad',
      `exact User tab order: ${tabLabels}`,
    );
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).click();
    await page.waitForURL(/tab=ciclo-de-vida/);
    await page.getByRole('heading', { name: 'Estado de la cuenta', exact: true }).waitFor();
    assert(new URL(page.url()).searchParams.get('tab') === 'ciclo-de-vida', 'tab search parameter');
    await page.reload();
    await page
      .getByRole('button', { name: `Deshabilitar cuenta de ${user}`, exact: true })
      .waitFor();
    await page.goBack();
    await page.getByRole('tab', { name: 'Resumen', exact: true }).waitFor();

    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).click();
    await page.waitForURL(/tab=ciclo-de-vida/);
    await page.getByRole('heading', { name: 'Estado de la cuenta', exact: true }).waitFor();
    const lifecycleOrder = await page.locator('h3, button, p').allTextContents();
    const order = lifecycleOrder.join(' | ');
    assert(
      order.indexOf('Estado de la cuenta') < order.indexOf(`Deshabilitar cuenta de ${user}`) &&
        order.indexOf(`Deshabilitar cuenta de ${user}`) <
          order.indexOf('Solicitud de eliminación') &&
        order.indexOf('Solicitud de eliminación') <
          order.indexOf(`Registrar solicitud de eliminación de ${user}`) &&
        order.indexOf(`Registrar solicitud de eliminación de ${user}`) <
          order.indexOf('Resultado de revisión'),
      `lifecycle visible order: ${order}`,
    );
    const disable = page.getByRole('button', {
      name: `Deshabilitar cuenta de ${user}`,
      exact: true,
    });
    await disable.click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await disable.waitFor({ state: 'visible' });
    const focusedElement = await page.evaluate<string>(
      'document.activeElement?.outerHTML?.slice(0, 300) ?? ""',
    );
    assert(
      focusedElement.includes(`Deshabilitar cuenta de ${user}`),
      `dialog focus restoration: ${focusedElement}`,
    );
    await page.getByRole('tab', { name: 'Resumen', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert(
      (await page.locator(':focus').innerText()) === 'Acceso',
      'keyboard tab arrow navigation',
    );

    await page.goto(`${frontendBase}/admin/administrators`);
    await visible(page, 'Administradores');
    await page.getByRole('tab', { name: 'Cuentas', exact: true }).waitFor();
    const prototypeAdministratorEmail = 'admin@example.com';
    await page
      .getByRole('link', { name: `Ver detalle de ${prototypeAdministratorEmail}`, exact: true })
      .click();
    await visible(page, 'Detalle de administrador');
    await page.getByRole('tab', { name: 'Acceso', exact: true }).click();
    await page
      .getByRole('button', {
        name: `Reenviar verificación para ${prototypeAdministratorEmail}`,
        exact: true,
      })
      .waitFor();
    await page.getByRole('link', { name: 'Administradores', exact: true }).first().click();
    await page.getByRole('tab', { name: 'Invitaciones', exact: true }).click();
    await page
      .getByRole('button', { name: /Reenviar invitación para reviewer@example.com/ })
      .waitFor();
    await page.goto(`${frontendBase}/admin/audit`);
    await visible(page, 'Auditoría administrativa');
    await page.goto(`${frontendBase}/admin/users/does-not-exist-41/show`);
    await page.getByRole('heading', { name: 'Usuario no encontrado', exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(
      `${frontendBase}/admin/users/${encodeURIComponent(resolvedUserId)}/show?tab=actividad`,
    );
    await visible(page, 'Detalle de usuario');
    await assertNoHorizontalOverflow(page);
  } finally {
    await browser?.close();
    await stopProcess(frontend);
    await stopProcess(worker);
    await rm(state, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  await runAdminPrototypeBrowserTest();
  console.log('Administration prototype browser acceptance passed.');
}
