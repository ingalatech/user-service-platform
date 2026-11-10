import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page, type Request as BrowserRequest } from 'playwright-core';
import {
  AdminAdministratorMessageSchema,
  AdminReaderDetailSchema,
  AdminReaderSessionRevocationSchema,
  AdminReaderSessionsSchema,
  AdminReaderSocialIdentityUnlinkSchema,
} from '../admin/src/generated/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Administration browser assertion: ${message}`);
}

async function waitForLocatorCount(page: Page, selector: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await page.locator(selector).count()) === expected) return;
    await pause(50);
  }
  assert(
    (await page.locator(selector).count()) === expected,
    'browser locator reaches expected count',
  );
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

const invitationToken = 'fixture-admin-invitation-token-0123456789abcdef0123456789abcdef';
const invitationFixture = {
  id: 'fixture-invitation-1',
  email: 'new-admin@example.test',
  state: 'pending',
  expiresAt: '2027-01-02T03:04:05.000Z',
  revision: 1,
  createdAt: '2026-11-09T03:04:05.000Z',
};

function fixtureProblem(status: number, code: string) {
  return {
    type: `urn:problem:${code}`,
    title: 'Fixture problem',
    status,
    code,
    detail: 'private fixture detail',
  };
}

async function administratorInvitationAcceptance(
  page: Page,
  base: string,
  browser: Browser,
  setPhase: (value: string) => void,
): Promise<void> {
  let state = 'pending';
  let revision = 1;
  let itemEmail = invitationFixture.email;
  let createCount = 0;
  let resendCount = 0;
  let cancelCount = 0;
  let acceptCount = 0;
  const getAcceptCount = () => acceptCount;
  let forceConflict = false;
  const requests: {
    path: string;
    method: string;
    key?: string;
    ifMatch?: string;
    body?: string;
  }[] = [];
  await page.context().route('**/v1/admin/administrator-invitations**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postData() ?? undefined;
    requests.push({
      path: url.pathname,
      method,
      key: request.headers()['idempotency-key'],
      ifMatch: request.headers()['if-match'],
      body,
    });
    const respond = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers,
        body: JSON.stringify(value),
      });
    if (method === 'GET') {
      const item = { ...invitationFixture, email: itemEmail, state, revision };
      const requestedState = url.searchParams.get('state');
      const matches = requestedState === null || requestedState === state;
      const items = matches ? [item] : [];
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      await respond(200, {
        items: items.slice(offset, offset + limit),
        total: items.length,
      });
    } else if (method === 'POST' && url.pathname === '/v1/admin/administrator-invitations') {
      createCount += 1;
      itemEmail = 'normalized@example.test';
      if (forceConflict) await respond(409, fixtureProblem(409, 'email-conflict'));
      else if (createCount === 1)
        await respond(503, fixtureProblem(503, 'delivery-scheduling-failed'));
      else await respond(201, { ...invitationFixture, email: itemEmail });
    } else if (method === 'POST' && url.pathname.endsWith('/messages')) {
      resendCount += 1;
      if (resendCount === 1) await respond(503, fixtureProblem(503, 'delivery-scheduling-failed'));
      else if (resendCount === 2)
        await respond(202, {
          id: invitationFixture.id,
          state: 'scheduled',
          cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        });
      else await respond(429, fixtureProblem(429, 'cooldown-active'), { 'retry-after': '17' });
    } else if (method === 'DELETE') {
      cancelCount += 1;
      if (cancelCount === 1) {
        revision += 1;
        await respond(412, fixtureProblem(412, 'stale-revision'));
      } else {
        state = 'cancelled';
        revision += 1;
        await respond(200, { ...invitationFixture, email: itemEmail, state, revision });
      }
    } else await respond(404, fixtureProblem(404, 'not-found'));
  });
  await page.context().route('**/v1/admin/auth/invitations/**', async (route) => {
    const url = new URL(route.request().url());
    const requestBody = route.request().postData() ?? '{}';
    const submitted = (JSON.parse(requestBody) as { token?: unknown }).token;
    const respond = (status: number, value: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname.endsWith('/inspect')) {
      if (submitted !== invitationToken)
        await respond(404, fixtureProblem(404, 'verification-invalid'));
      else
        await respond(200, {
          email: 'n•••@example.test',
          state,
          expiresAt: invitationFixture.expiresAt,
        });
    } else if (url.pathname.endsWith('/accept')) {
      acceptCount += 1;
      state = 'accepted';
      await respond(200, { accepted: true });
    } else await respond(404, fixtureProblem(404, 'not-found'));
  });
  await page.context().route('**/v1/auth/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        capabilities: {
          registration: true,
          emailPassword: true,
          emailVerification: true,
          passwordReset: true,
        },
        passwordPolicy: {
          minLength: 12,
          maxLength: 128,
          minUppercase: 1,
          minLowercase: 1,
          minDigits: 1,
          minSymbols: 1,
        },
      }),
    }),
  );

  setPhase('invitation fixtures and management route');
  await page.goto(`${base}/admin/administrators`);
  await page.getByRole('heading', { name: 'Invitaciones de Administrator', exact: true }).waitFor();
  setPhase('invitation create retry');
  await page.getByLabel('Correo electrónico', { exact: true }).fill('NORMALIZED@example.test');
  await page.getByLabel('Correo electrónico', { exact: true }).press('Enter');
  await page
    .getByText(
      'No pudimos confirmar la programación. La invitación queda pendiente; reintenta con el mismo intento.',
      { exact: true },
    )
    .waitFor();
  await page.getByText('Pendiente', { exact: true }).waitFor();
  await page
    .getByText('Programación del correo sin confirmar; reintenta con el mismo intento.', {
      exact: true,
    })
    .waitFor();
  assert(!(await page.getByText(/entregado|entregada/i).count()), '503 never claims delivery');
  await page.getByRole('button', { name: 'Reintentar programación', exact: true }).click();
  await page
    .getByText(
      'Invitación creada. La programación del correo quedó aceptada; la entrega no está confirmada.',
      { exact: true },
    )
    .waitFor();
  await page.getByText('normalized@example.test', { exact: true }).waitFor();
  const createRequests = requests.filter(
    (request) =>
      request.method === 'POST' && request.path === '/v1/admin/administrator-invitations',
  );
  assert(
    createRequests.length === 2 && createRequests[0]?.key === createRequests[1]?.key,
    'create scheduling retry reuses the same idempotency key',
  );
  assert(
    createRequests[0]?.body?.includes('normalized@example.test') === true,
    'email is normalized before create request submission',
  );
  assert(
    !(await page.getByText(/entregado|entregada/i).count()),
    'creation avoids delivery claims',
  );
  setPhase('invitation reservation conflict');
  forceConflict = true;
  await page.getByLabel('Correo electrónico', { exact: true }).fill('reserved@example.test');
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await page
    .getByText('Ese correo ya está reservado o pertenece a un Administrator.', { exact: true })
    .waitFor();
  forceConflict = false;

  setPhase('invitation resend retry and cooldown');
  await page.getByRole('button', { name: 'Reenviar invitación', exact: true }).click();
  await page
    .getByText(
      'No pudimos confirmar la programación. La invitación sigue pendiente; reintenta con el mismo intento.',
      { exact: true },
    )
    .waitFor();
  await page.getByRole('button', { name: 'Reintentar reenvío', exact: true }).click();
  await page
    .getByText('Reenvío aceptado para programación; la entrega no está confirmada.', {
      exact: true,
    })
    .waitFor();
  const resendRequests = requests.filter((request) => request.path.endsWith('/messages'));
  assert(
    resendRequests.length === 2 && resendRequests[0]?.key === resendRequests[1]?.key,
    'resend retry reuses idempotency key',
  );
  assert(
    resendRequests.every((request) => request.ifMatch === undefined),
    'resend does not send If-Match',
  );
  assert(
    await page.getByRole('button', { name: 'Reenviar invitación', exact: true }).isDisabled(),
    'cooldown prevents immediate resend',
  );
  assert(
    (await page.getByText(/^Reenvío disponible en \d+ s\.$/).count()) === 1,
    'successful resend displays its cooldown countdown',
  );
  assert(!(await page.getByText(/entregado/i).count()), 'resend avoids delivery claims');
  await page.evaluate(() => {
    sessionStorage.removeItem('admin-invitation:cooldown:fixture-invitation-1');
  });
  await page.reload();
  await page.getByRole('button', { name: 'Reenviar invitación', exact: true }).click();
  await page.getByText('Espera 17 segundos antes de reenviar.', { exact: true }).waitFor();
  await page.getByText(/^Reenvío disponible en (?:1[0-7]|[1-9]) s\.$/).waitFor();

  setPhase('invitation resend not-found');
  await page.evaluate(() => {
    sessionStorage.removeItem('admin-invitation:cooldown:fixture-invitation-1');
  });
  await page.reload();
  await page.getByRole('heading', { name: 'Invitaciones de Administrator', exact: true }).waitFor();
  let invitationListReads = 0;
  const countInvitationListRead = (request: BrowserRequest) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/v1/admin/administrator-invitations') {
      invitationListReads += 1;
    }
  };
  page.on('request', countInvitationListRead);
  let resendNotFound = true;
  await page.route(
    '**/v1/admin/administrator-invitations/fixture-invitation-1/messages',
    async (route) => {
      if (!resendNotFound) {
        await route.continue();
        return;
      }
      resendNotFound = false;
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(fixtureProblem(404, 'invitation-not-found')),
      });
    },
  );
  const listReadsBeforeResendNotFound = invitationListReads;
  await page.getByRole('button', { name: 'Reenviar invitación', exact: true }).click();
  await page
    .getByText('No encontramos esta invitación. Actualizamos el listado.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Reenviar invitación', exact: true }).waitFor();
  assert(
    invitationListReads > listReadsBeforeResendNotFound,
    'resend invitation-not-found refreshes the authoritative list',
  );
  await page.unroute('**/v1/admin/administrator-invitations/fixture-invitation-1/messages');

  setPhase('invitation cancel not-found');
  let cancelNotFound = true;
  await page.route('**/v1/admin/administrator-invitations/fixture-invitation-1', async (route) => {
    if (!cancelNotFound || route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    cancelNotFound = false;
    await route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      body: JSON.stringify(fixtureProblem(404, 'invitation-not-found')),
    });
  });
  const listReadsBeforeCancelNotFound = invitationListReads;
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Confirmar cancelación', exact: true })
    .click();
  await page
    .getByText('No encontramos esta invitación. Actualizamos el listado.', { exact: true })
    .waitFor();
  assert(
    (await page.getByRole('alertdialog').count()) === 0,
    'cancel invitation-not-found closes the confirmation dialog',
  );
  assert(
    invitationListReads > listReadsBeforeCancelNotFound,
    'cancel invitation-not-found refreshes the authoritative list',
  );
  await page.unroute('**/v1/admin/administrator-invitations/fixture-invitation-1');
  page.off('request', countInvitationListRead);

  setPhase('invitation stale cancellation command');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Confirmar cancelación', exact: true })
    .click();
  await page
    .getByText('La invitación cambió. Revisa el estado actualizado y decide de nuevo.', {
      exact: true,
    })
    .waitFor();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Confirmar cancelación', exact: true })
    .click();
  await page.getByText('Invitación cancelada.', { exact: true }).waitFor();
  setPhase('invitation cancellation command assertions');
  const cancelRequests = requests.filter((request) => request.method === 'DELETE');
  assert(
    cancelRequests.length === 2 &&
      cancelRequests[0]?.ifMatch === '"1"' &&
      cancelRequests[1]?.ifMatch === '"2"',
    'stale cancellation refetches current ETag/revision',
  );
  assert(
    cancelRequests[0].key !== cancelRequests[1].key,
    'stale cancellation starts with a new idempotency key',
  );
  setPhase('invitation terminal history and responsive view');
  await page.getByRole('button', { name: 'Historial terminal', exact: true }).click();
  await page.getByText('Cancelada', { exact: true }).waitFor();
  assert(
    await page.evaluate<boolean>(`(() => {
      const section = document.querySelector('#administrator-invitations-title')?.closest('section');
      return section !== null && section !== undefined && section.getBoundingClientRect().right <= window.innerWidth + 1;
    })()`),
    'invitation management fits mobile viewport',
  );
  assert(
    (await page.getByRole('button', { name: 'Cancelar', exact: true }).count()) === 0,
    'terminal invitation has no action',
  );

  setPhase('invitation pagination edges');
  const paginationBase = Date.parse('2026-11-01T12:00:00.000Z');
  const paginationInvitation = (
    state: 'pending' | 'accepted' | 'cancelled' | 'superseded' | 'expired',
    index: number,
    order: number,
  ) => ({
    id: `page-${state}-${String(index)}`,
    email: `page-${state}-${String(index)}@example.test`,
    state,
    expiresAt: '2027-06-01T00:00:00.000Z',
    revision: 1,
    createdAt: new Date(paginationBase - order * 60_000).toISOString(),
  });
  const paginationData: Readonly<Record<string, ReturnType<typeof paginationInvitation>[]>> = {
    pending: Array.from({ length: 23 }, (_, index) =>
      paginationInvitation('pending', index, index),
    ),
    accepted: Array.from({ length: 4 }, (_, index) =>
      paginationInvitation('accepted', index, 100 + index),
    ),
    cancelled: Array.from({ length: 4 }, (_, index) =>
      paginationInvitation('cancelled', index, 200 + index),
    ),
    superseded: Array.from({ length: 2 }, (_, index) =>
      paginationInvitation('superseded', index, 300 + index),
    ),
    expired: [paginationInvitation('expired', 0, 400)],
  };
  let paginationEmpty = false;
  await page.route('**/v1/admin/administrator-invitations**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(fixtureProblem(404, 'not-found')),
      });
      return;
    }
    const state = url.searchParams.get('state');
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const source = paginationEmpty || state === null ? [] : (paginationData[state] ?? []);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: source.slice(offset, offset + limit), total: source.length }),
    });
  });
  const invitationSection = page.locator(
    'section[aria-labelledby="administrator-invitations-title"]',
  );
  const invitationRows = invitationSection.locator('ul[aria-label="Invitaciones"] li');
  setPhase('pending pagination page one');
  await invitationSection.getByRole('button', { name: 'Pendientes', exact: true }).click();
  await page.getByText('23 invitaciones encontradas', { exact: true }).waitFor();
  await waitForLocatorCount(
    page,
    'section[aria-labelledby="administrator-invitations-title"] ul[aria-label="Invitaciones"] li',
    10,
  );
  await invitationSection.getByText('page-pending-0@example.test', { exact: true }).waitFor();
  assert(
    (await invitationSection.getByText('page-pending-10@example.test', { exact: true }).count()) ===
      0,
    'pending page one excludes the next page',
  );
  setPhase('pending pagination page two');
  await invitationSection.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await invitationSection.getByText('page-pending-10@example.test', { exact: true }).waitFor();
  assert((await invitationRows.count()) === 10, 'pending page two is full');
  setPhase('pending pagination short final page');
  await invitationSection.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await invitationSection.getByText('page-pending-22@example.test', { exact: true }).waitFor();
  assert((await invitationRows.count()) === 3, 'short final pending page is accurate');
  assert(
    await invitationSection.getByRole('button', { name: 'Siguiente', exact: true }).isDisabled(),
    'pending pagination stops at the last page',
  );

  setPhase('terminal history pagination page one');
  await invitationSection.getByRole('button', { name: 'Historial terminal', exact: true }).click();
  await page.getByText('11 invitaciones encontradas', { exact: true }).waitFor();
  await invitationSection.getByText('page-accepted-0@example.test', { exact: true }).waitFor();
  assert((await invitationRows.count()) === 10, 'terminal page one combines terminal states');
  assert(
    (await invitationSection.getByText('page-expired-0@example.test', { exact: true }).count()) ===
      0,
    'terminal page one does not include the short final page',
  );
  await invitationSection.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await invitationSection.getByText('page-expired-0@example.test', { exact: true }).waitFor();
  assert((await invitationRows.count()) === 1, 'short final terminal page is accurate');
  assert(
    await invitationSection.getByRole('button', { name: 'Siguiente', exact: true }).isDisabled(),
    'terminal pagination stops at the last page',
  );

  setPhase('invitation empty-page edge');
  paginationEmpty = true;
  await invitationSection.getByRole('button', { name: 'Pendientes', exact: true }).click();
  await page.getByText('No hay invitaciones pendientes.', { exact: true }).waitFor();
  assert((await invitationRows.count()) === 0, 'empty pending list renders no stale rows');
  assert(
    (await invitationSection.getByRole('button', { name: 'Siguiente', exact: true }).count()) === 0,
    'empty pending list hides pagination',
  );
  await invitationSection.getByRole('button', { name: 'Historial terminal', exact: true }).click();
  await page.getByText('No hay historial terminal.', { exact: true }).waitFor();
  assert((await invitationRows.count()) === 0, 'empty terminal history renders no stale rows');
  assert(
    (await invitationSection.getByRole('button', { name: 'Siguiente', exact: true }).count()) === 0,
    'empty terminal history hides pagination',
  );
  await page.unroute('**/v1/admin/administrator-invitations**');

  setPhase('public invitation inspection and acceptance');
  const publicContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const publicInspectRequests: { method: string; url: string; body: string }[] = [];
  await publicContext.route('**/v1/admin/auth/invitations/**', async (route) => {
    const url = new URL(route.request().url());
    const requestBody = route.request().postData() ?? '{}';
    const submitted = (JSON.parse(requestBody) as { token?: unknown }).token;
    if (url.pathname.endsWith('/inspect')) {
      publicInspectRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: requestBody,
      });
    }
    const respond = (status: number, value: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname.endsWith('/inspect')) {
      if (submitted !== invitationToken)
        await respond(404, fixtureProblem(404, 'verification-invalid'));
      else
        await respond(200, {
          email: 'n•••@example.test',
          state,
          expiresAt: invitationFixture.expiresAt,
        });
    } else if (url.pathname.endsWith('/accept')) {
      acceptCount += 1;
      state = 'accepted';
      await respond(200, { accepted: true });
    } else await respond(404, fixtureProblem(404, 'not-found'));
  });
  await publicContext.route('**/v1/auth/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        capabilities: {
          registration: true,
          emailPassword: true,
          emailVerification: true,
          passwordReset: true,
        },
        passwordPolicy: {
          minLength: 12,
          maxLength: 128,
          minUppercase: 1,
          minLowercase: 1,
          minDigits: 1,
          minSymbols: 1,
        },
      }),
    }),
  );
  const publicPage = await publicContext.newPage();
  publicPage.setDefaultTimeout(15_000);
  await publicPage.addInitScript(`(() => {
    const observations = [];
    Object.defineProperty(window, '__invitationPrivacyObservations', { value: observations });
    const record = (kind, value) =>
      observations.push({ kind, value, text: document.body?.textContent ?? '' });
    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      record('replaceState', String(url ?? location.href));
      originalReplaceState(data, unused, url);
    };
    for (const storage of [localStorage, sessionStorage]) {
      const originalSetItem = storage.setItem.bind(storage);
      storage.setItem = (key, value) => {
        record('storage', key + '=' + value);
        originalSetItem(key, value);
      };
    }
    new MutationObserver(() => record('dom', document.documentElement?.innerHTML ?? '')).observe(
      document,
      { childList: true, subtree: true, characterData: true },
    );
  })()`);
  const emitted: string[] = [];
  publicPage.on('console', (message) => emitted.push(message.text()));
  publicPage.on('pageerror', (error) => emitted.push(error.message));
  state = 'pending';
  await publicPage.goto(
    `${base}/admin/aceptar-invitacion?token=${encodeURIComponent(invitationToken)}`,
  );
  await publicPage.getByText('n•••@example.test').waitFor();
  assert(!publicPage.url().includes(invitationToken), 'token is scrubbed from the visible URL');
  const privacyObservations = await publicPage.evaluate<
    { kind: string; value: string; text: string }[]
  >('window.__invitationPrivacyObservations');
  const scrub = privacyObservations.find((observation) => observation.kind === 'replaceState');
  assert(scrub !== undefined, 'history is scrubbed synchronously at route module entry');
  assert(
    !scrub.value.includes(invitationToken) && !scrub.text.includes(invitationToken),
    'earliest history replacement and DOM contain no raw invitation token',
  );
  assert(
    privacyObservations.every(
      (observation) =>
        !observation.value.includes(invitationToken) && !observation.text.includes(invitationToken),
    ),
    'instrumented storage and DOM never observe the raw token',
  );
  assert(
    publicInspectRequests.length === 1 &&
      publicInspectRequests[0]?.method === 'POST' &&
      !publicInspectRequests[0].url.includes(invitationToken) &&
      (JSON.parse(publicInspectRequests[0].body) as { token?: string }).token === invitationToken,
    'inspection sends the captured token only in one POST body, not its URL',
  );
  const inspectedText = await publicPage.locator('body').innerText();
  assert(
    !inspectedText.includes('new-admin@example.test') &&
      !inspectedText.includes(invitationFixture.id) &&
      !inspectedText.includes(invitationToken),
    'public inspect displays neither full email, internal invitation id, nor token',
  );
  await publicPage.getByLabel('Nombre visible').fill('Invited Admin');
  await publicPage.getByLabel('Contraseña', { exact: true }).fill('short');
  await publicPage.getByLabel('Confirmar contraseña').fill('different');
  await publicPage.getByRole('button', { name: 'Aceptar invitación', exact: true }).click();
  await publicPage.getByText(/no cumple los requisitos actuales/i).waitFor();
  assert(getAcceptCount() === 0, 'invalid client-side password does not consume invitation');
  await publicPage.getByLabel('Contraseña', { exact: true }).fill('Valid-Password-41!');
  await publicPage.getByLabel('Confirmar contraseña').fill('Valid-Password-41?');
  await publicPage.getByRole('button', { name: 'Aceptar invitación', exact: true }).click();
  await publicPage.getByText('Las contraseñas no coinciden.', { exact: true }).waitFor();
  assert(getAcceptCount() === 0, 'password mismatch does not consume invitation');
  await publicPage.getByLabel('Confirmar contraseña').fill('Valid-Password-41!');
  await publicPage.getByRole('button', { name: 'Aceptar invitación', exact: true }).click();
  await publicPage.getByText(/Invitación aceptada/).waitFor();
  assert(getAcceptCount() === 1, 'accept flow submits exactly once');
  const stored = await publicPage.evaluate(
    () => `${JSON.stringify(localStorage)} ${JSON.stringify(sessionStorage)}`,
  );
  assert(
    !stored.includes(invitationToken) && !stored.includes('Valid-Password-41!'),
    'token and password are absent from local and session storage',
  );
  assert(
    emitted.every((value) => !value.includes(invitationToken)),
    'token is absent from console and page errors',
  );
  assert(
    emitted.every((value) => !value.includes('Valid-Password-41!')),
    'password is absent from console and page errors',
  );
  assert(
    (await publicPage
      .getByRole('button', { name: 'Ir al inicio de sesión', exact: true })
      .count()) === 1,
    'acceptance explicitly links to login',
  );
  assert(
    (await publicContext.cookies()).every((cookie) => !cookie.name.endsWith('session_token')),
    'public acceptance does not establish an Administrator session',
  );
  setPhase('public invitation privacy and login navigation');
  await publicPage.getByRole('button', { name: 'Ir al inicio de sesión', exact: true }).click();
  await publicPage.waitForURL('**/admin/login');
  await publicPage.goBack();
  assert(
    !publicPage.url().includes(invitationToken),
    'back navigation does not restore invitation token',
  );
  for (const terminalState of ['accepted', 'cancelled', 'superseded', 'expired']) {
    state = terminalState;
    await publicPage.goto(
      `${base}/admin/aceptar-invitacion?token=${encodeURIComponent(invitationToken)}`,
    );
    await publicPage
      .getByText('Esta invitación ya no se puede aceptar.', { exact: false })
      .waitFor();
    assert(
      (await publicPage
        .getByRole('button', { name: 'Aceptar invitación', exact: true })
        .count()) === 0,
      `${terminalState} invitation is terminal on repeat inspection`,
    );
    assert(
      (await publicPage
        .getByRole('link', { name: 'Ir al inicio de sesión de Administrator', exact: true })
        .count()) === 1,
      `${terminalState} invitation offers Administrator login`,
    );
  }
  await publicPage.goto(`${base}/admin/aceptar-invitacion?token=invalid-short-token`);
  await publicPage
    .getByText('La invitación no está disponible o no es válida.', { exact: true })
    .waitFor();
  assert(!publicPage.url().includes('invalid-short-token'), 'invalid token is scrubbed from URL');
  assert(
    (await publicPage.getByText('new-admin@example.test', { exact: true }).count()) === 0,
    'invalid token reveals no email',
  );
  assert(
    (await publicPage
      .getByRole('link', { name: 'Volver al inicio de sesión', exact: true })
      .count()) === 1,
    'invalid invitation offers Administrator login',
  );
  await publicPage.goto(`${base}/admin/aceptar-invitacion`);
  await publicPage
    .getByText('La invitación no está disponible o no es válida.', { exact: true })
    .waitFor();
  assert(
    (await publicPage
      .getByRole('link', { name: 'Volver al inicio de sesión', exact: true })
      .count()) === 1,
    'direct navigation without a token offers Administrator login',
  );
  assert(
    await publicPage.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
    'public flow fits mobile viewport',
  );
  await publicPage.close();
  await publicContext.close();
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
    await writeFile(
      join(state, '.dev.vars'),
      'AUTH_SOCIAL_PROVIDERS=google\nAUTH_REQUIRE_EMAIL_VERIFICATION=false\n',
    );
    const original = await readFile(join(root, 'wrangler.jsonc'), 'utf8');
    // Preserve all routing/binding configuration; relocate only file paths so
    // local-secret discovery and storage also live in the disposable directory.
    await writeFile(
      config,
      original
        .replace(
          '"ENVIRONMENT": "local",',
          '"ENVIRONMENT": "local",\n    "AUTH_SOCIAL_PROVIDERS": "google",',
        )
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
    const readerSessionLogin = await http('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: regular, password }),
    });
    assert(readerSessionLogin.status === 200, 'Reader session fixture created through public HTTP');
    const readerCookie = readerSessionLogin.headers.get('set-cookie')?.split(';')[0];
    assert(readerCookie !== undefined && readerCookie.length > 0, 'Reader session cookie captured');
    const readerSession = await http('/v1/me', { headers: { cookie: readerCookie } });
    assert(readerSession.status === 200, 'Reader session is valid before social unlink');
    await readerSession.arrayBuffer();
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
    await sql(
      `INSERT INTO admin_user (id, name, email, email_verified, created_at, updated_at, role, banned)
       VALUES ('qa-verification-noop-admin', 'QA Verification No-op', 'qa-verification-noop@example.com', 0, 1700000000, 1700000000, 'admin', 0)`,
    );
    await sql(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES ('qa-verification-noop-admin', 'active', 1, 1700000000000)`,
    );
    const auditOccurredAt = Date.now();
    await sql(
      `INSERT INTO identity_event
       (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
        result, request_id, problem_code, metadata)
       VALUES ('browser-audit-safe', 1, 'access-attempt', ${String(auditOccurredAt)},
        'administrator', 'qa-disabled-admin', 'reader', 'opaque-reader-subject', 'failure',
        'browser-audit-request', 'stale-revision',
         '{"changed":false,"token":"browser-secret-token","email":"browser-secret@example.com","emailBody":"browser-private-email-body-secret"}')`,
    );
    await sql(
      `INSERT INTO identity_event
       (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
        result, request_id, problem_code, metadata)
       VALUES ('browser-audit-anonymous', 1, 'administrator-invitation-attempt', ${String(auditOccurredAt + 1)},
        'anonymous', 'anonymous', NULL, NULL, 'failure',
        'browser-anonymous-request', 'verification-invalid',
         '{"token":"anonymous-secret-token","email":"anonymous-secret@example.com"}')`,
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
    let administratorDetailRefreshes = 0;
    const countAdministratorDetailRefresh = (request: BrowserRequest) => {
      const url = new URL(request.url());
      if (
        request.method() === 'GET' &&
        url.pathname === '/v1/admin/administrators/qa-disabled-admin'
      ) {
        administratorDetailRefreshes++;
      }
    };
    page.on('request', countAdministratorDetailRefresh);
    let administratorVerificationRequestCount = 0;
    await page.route(
      '**/v1/admin/administrators/qa-disabled-admin/email-verification/messages',
      async (route) => {
        administratorVerificationRequestCount++;
        administratorVerificationKeys.push(route.request().headers()['idempotency-key'] ?? '');
        if (administratorVerificationRequestCount === 1) {
          await route.fulfill({
            status: 429,
            headers: { 'retry-after': '1' },
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'urn:problem:cooldown-active',
              title: 'Cooldown active',
              status: 429,
              code: 'cooldown-active',
              detail: 'private cooldown detail',
            }),
          });
          return;
        }
        if (administratorVerificationRequestCount === 2) {
          const now = Date.now();
          await sql(
            `INSERT INTO administrator_message_workflow
             (id, user_id, kind, state, cooldown_until, created_at, updated_at, last_scheduled_at)
             VALUES ('qa-admin-verification-workflow', 'qa-disabled-admin', 'email-verification',
               'scheduling-failed', ${String(now + 60_000)}, ${String(now)}, ${String(now)}, NULL)
             ON CONFLICT(user_id, kind) DO UPDATE SET state='scheduling-failed',
               cooldown_until=excluded.cooldown_until, updated_at=excluded.updated_at,
               last_scheduled_at=NULL`,
          );
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
        const now = Date.now();
        await sql(
          `UPDATE administrator_message_workflow SET state='scheduled', cooldown_until=${String(now + 60_000)},
             updated_at=${String(now)}, last_scheduled_at=${String(now)}
           WHERE id='qa-admin-verification-workflow'`,
        );
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            workflowId: 'qa-admin-verification-workflow',
            kind: 'email-verification',
            state: 'scheduled',
            cooldownUntil: new Date(now + 60_000).toISOString(),
            revision: 4,
          }),
        });
      },
    );
    await adminVerificationButton.click();
    await page
      .getByText('Espera 1 segundo antes de volver a intentarlo.', { exact: true })
      .waitFor();
    assert(
      await adminVerificationButton.isDisabled(),
      'Retry-After cooldown disables verification',
    );
    for (
      let attempt = 0;
      attempt < 100 && (await adminVerificationButton.isDisabled());
      attempt++
    ) {
      await pause(50);
    }
    assert(!(await adminVerificationButton.isDisabled()), 'verification cooldown expires');
    await adminVerificationButton.click();
    await page
      .getByText('Programación fallida. Reintenta con el mismo intento.', { exact: true })
      .waitFor();
    await page
      .getByText('la programación falló; el mensaje no está confirmado.', { exact: false })
      .waitFor();
    assert(
      !(await page.locator('body').innerText()).includes('private cooldown detail'),
      'cooldown Problem Details are not shown',
    );
    await page.reload();
    await visible(page, 'Detalle de administrador');
    await page
      .getByText('la programación falló; el mensaje no está confirmado.', { exact: false })
      .waitFor();
    assert(
      await page.getByText(/Podrás reenviar la verificación en/).isVisible(),
      'persisted verification cooldown is visible after reload',
    );
    const administratorVerificationRetry = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith('/v1/admin/administrators/qa-disabled-admin/email-verification/messages'),
    );
    const adminVerificationRetryButton = page.getByRole('button', {
      name: 'Reintentar verificación',
      exact: true,
    });
    assert(
      !(await adminVerificationRetryButton.isDisabled()),
      'uncertain command can retry in cooldown',
    );
    await adminVerificationRetryButton.click();
    assert(
      (await administratorVerificationRetry).status() === 202,
      'Admin verification retry accepted',
    );
    assert(
      administratorVerificationKeys.length === 3 &&
        administratorVerificationKeys[1] !== '' &&
        administratorVerificationKeys[1] === administratorVerificationKeys[2] &&
        administratorVerificationKeys[0] !== administratorVerificationKeys[1],
      'Admin verification retry preserves its idempotency key',
    );
    await page
      .getByText('mensaje aceptado para programación; entrega no confirmada.', { exact: false })
      .waitFor();
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
    await page
      .getByText(
        'Solicitud aceptada para programar el correo de recuperación; la entrega no está confirmada.',
        { exact: true },
      )
      .waitFor();
    assert(await adminRecoveryButton.isDisabled(), 'recovery cooldown disables repeat action');
    assert(administratorDetailRefreshes >= 2, 'message success refreshes canonical Admin detail');
    page.off('request', countAdministratorDetailRefresh);
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
    const disabledAdminBody = await page.locator('body').innerText();
    phase = 'verify persisted Administrator message workflow copy';
    assert(
      disabledAdminBody.includes(
        'Verificación: mensaje aceptado para programación; entrega no confirmada.',
      ) &&
        disabledAdminBody.includes(
          'Recuperación: mensaje aceptado para programación; entrega no confirmada.',
        ),
      'authoritative message workflows render as scheduled, not delivered',
    );
    phase = 'verify disabled Administrator reassurance copy';
    assert(
      disabledAdminBody.includes('deshabilitada ni restaura sesiones'),
      'message copy does not imply account rehabilitation or session restoration',
    );
    phase = 'verify Administrator message privacy';
    assert(!disabledAdminBody.includes('browser-secret-token'), 'Admin UI hides token material');
    phase = 'verify Administrator action URL privacy';
    assert(!disabledAdminBody.includes('actionUrl'), 'Admin UI hides action URL material');
    phase = 'verify Administrator email body privacy';
    assert(
      !disabledAdminBody.includes('browser-private-email-body-secret'),
      'Admin UI hides email content',
    );
    const administratorStoredValues = await page.evaluate<string>(
      `JSON.stringify([...Object.values(localStorage), ...Object.values(sessionStorage)])`,
    );
    phase = 'verify Admin storage privacy';
    assert(
      !administratorStoredValues.includes('browser-secret-token') &&
        !administratorStoredValues.includes('browser-private-email-body-secret') &&
        !administratorStoredValues.includes('actionUrl'),
      'message credentials and content are absent from browser storage',
    );
    phase = 'seed local pending workflow and serve safe pending detail';
    const pendingAt = Date.now();
    await sql(
      `UPDATE administrator_message_workflow SET state='pending', cooldown_until=${String(pendingAt + 60_000)},
         updated_at=${String(pendingAt)}, last_scheduled_at=NULL
       WHERE user_id='qa-disabled-admin' AND kind='email-verification'`,
    );
    await page.route('**/v1/admin/administrators/**', async (route) => {
      if (
        new URL(route.request().url()).pathname !== '/v1/admin/administrators/qa-disabled-admin'
      ) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'qa-disabled-admin',
          email: 'qa-disabled-admin@example.com',
          emailVerified: false,
          realm: 'administrator',
          role: 'admin',
          access: { state: 'disabled' },
          revision: 4,
          summary: {
            createdAt: new Date(pendingAt).toISOString(),
            updatedAt: new Date(pendingAt).toISOString(),
          },
          methods: [{ type: 'password' }],
          messageWorkflows: {
            emailVerification: {
              kind: 'email-verification',
              state: 'pending',
              cooldownUntil: new Date(pendingAt + 60_000).toISOString(),
              lastScheduledAt: null,
              updatedAt: new Date(pendingAt).toISOString(),
            },
            passwordRecovery: null,
          },
        }),
      });
    });
    phase = 'reload pending Administrator detail projection';
    await page.reload();
    await visible(page, 'Detalle de administrador');
    await page
      .getByText('programación en curso; el resultado aún no está confirmado.', { exact: false })
      .waitFor();
    assert(
      await page.getByText(/Podrás reenviar la verificación en/).isVisible(),
      'pending verification workflow and cooldown render from reloaded detail',
    );
    const pendingVerificationButton = page.getByRole('button', {
      name: 'Reenviar verificación',
      exact: true,
    });
    assert(
      await pendingVerificationButton.isDisabled(),
      'a pending workflow blocks a new scheduling command while its claim may be active',
    );
    await pendingVerificationButton.click({ force: true });
    assert(
      administratorVerificationRequestCount === 3,
      'pending-state UI does not dispatch another scheduling request',
    );
    const pendingAdminBody = await page.locator('body').innerText();
    assert(
      !pendingAdminBody.includes('la programación falló') &&
        !pendingAdminBody.includes('entrega confirmada') &&
        !pendingAdminBody.includes('browser-secret-token') &&
        !pendingAdminBody.includes('actionUrl'),
      'pending state is neither failure nor delivery and exposes no message secrets',
    );
    await page.unroute('**/v1/admin/administrators/**');
    await page.reload();
    await visible(page, 'Detalle de administrador');
    await page
      .getByText('Recuperación: mensaje aceptado para programación; entrega no confirmada.', {
        exact: false,
      })
      .waitFor();
    await page.getByText('Deshabilitado', { exact: true }).waitFor();
    assert(
      await page.getByText(/Podrás reenviar la recuperación en/).isVisible(),
      'recovery schedule and cooldown survive reload without changing disabled access',
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
    phase = 'verified Administrator verification no-op';
    await page.goto(`${base}/admin/administrators/qa-verification-noop-admin`);
    await visible(page, 'Detalle de administrador');
    const staleUnverifiedAction = page.getByRole('button', {
      name: 'Reenviar verificación',
      exact: true,
    });
    assert(
      !(await staleUnverifiedAction.isDisabled()),
      'unverified view allows verification request',
    );
    await sql(`UPDATE admin_user SET email_verified = 1 WHERE id = 'qa-verification-noop-admin'`);
    const verifiedNoOpResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith(
            '/v1/admin/administrators/qa-verification-noop-admin/email-verification/messages',
          ),
    );
    await staleUnverifiedAction.click();
    const verifiedNoOpValue = await verifiedNoOpResponse;
    assert(verifiedNoOpValue.status() === 200, 'verified target produces the current-state no-op');
    const verifiedNoOpPayload: unknown = await verifiedNoOpValue.json();
    const verifiedNoOpContract = AdminAdministratorMessageSchema.safeParse(verifiedNoOpPayload);
    assert(
      verifiedNoOpContract.success && verifiedNoOpContract.data.state === 'verified',
      'verified no-op response is contract-validated and not reported as scheduled',
    );
    await page
      .getByText('El correo ya estaba verificado; no se programó otro mensaje.', { exact: true })
      .waitFor();
    assert(
      (await page.locator('body').innerText()).includes('Correo verificado'),
      'canonical verification state refreshes after the no-op',
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
    assert(
      filteredResponse.headers()['cache-control'] === 'private, no-store',
      'browser-observed Administrative Audit is private and no-store',
    );
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
      'browser-private-email-body-secret',
      'browser-audit-safe',
    ]) {
      assert(!auditText.includes(secret), 'Audit UI renders only the safe projection');
    }
    phase = 'public/system audit event without an actor id';
    const anonymousActorLookups: string[] = [];
    const recordAnonymousLookup = (request: BrowserRequest) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/v1/admin/administrators/')) {
        anonymousActorLookups.push(url.pathname);
      }
    };
    page.on('request', recordAnonymousLookup);
    await auditActorFilter.fill('');
    await page
      .getByRole('textbox', { name: 'Acción (tipo exacto)', exact: true })
      .fill('administrator-invitation-attempt');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page.getByText('browser-anonymous-request', { exact: true }).waitFor();
    await page.getByText('Sistema público', { exact: false }).first().waitFor();
    const anonymousAuditText = await page.locator('body').innerText();
    assert(
      !anonymousAuditText.includes('undefined') &&
        !anonymousAuditText.includes('anonymous-secret-token') &&
        !anonymousAuditText.includes('anonymous-secret@example.com') &&
        !anonymousAuditText.includes('browser-audit-anonymous'),
      'anonymous audit event renders no synthetic id, actor lookup or token/email',
    );
    assert(
      anonymousActorLookups.length === 0,
      'anonymous audit actor triggers no Administrator detail lookup',
    );
    page.off('request', recordAnonymousLookup);
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
    const usersListResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/v1/admin/users',
    );
    await page.goto(`${base}/admin/users`);
    const usersListResponseValue = await usersListResponse;
    assert(
      usersListResponseValue.status() === 200 &&
        usersListResponseValue.headers()['cache-control'] === 'private, no-store',
      'browser-observed Reader list is private and no-store',
    );
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
    phase = 'verified Reader password-recovery message request';
    const recoveryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/v1/admin/users/${unverifiedId}/password-recovery/messages`),
    );
    await page.getByRole('tab', { name: 'Acceso', exact: true }).click();
    await page.getByRole('button', { name: 'Enviar recuperación', exact: true }).click();
    assert(
      (await recoveryResponse).status() === 202,
      'password recovery accepted when locally usable',
    );
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
    await sql(`DELETE FROM "user" WHERE id = '${emailChangeReaderId}'`);
    await page.goto(`${base}/admin/users`);
    phase = 'user list after email-change cleanup';
    await visible(page, 'Usuarios');
    phase = 'social fixture Reader lookup';
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
    phase = 'Reader session fixture seeding';
    const sessionNow = Math.floor(Date.now() / 1_000);
    const sessionFixtureIds = Array.from({ length: 27 }, () => crypto.randomUUID());
    const sessionFixtureValues = sessionFixtureIds.map((id, index) => {
      const timestamp = sessionNow - index;
      return `('${id}', 'session-token-private-${String(index)}', '${regularDetailId}', ${String(timestamp)}, ${String(timestamp)}, ${String(sessionNow + 3_600)}, '198.51.100.${String(index + 1)}', 'session-user-agent-private-${String(index)}')`;
    });
    await sql(
      `INSERT INTO session (id, token, user_id, created_at, updated_at, expires_at, ip_address, user_agent)
       VALUES ${sessionFixtureValues.join(',')}`,
    );
    phase = 'Reader session safe HTTP projection';
    const sessionsResponse = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/sessions?limit=50`,
      { headers: { cookie: cookieHeader } },
    );
    phase = `Reader session list HTTP status ${String(sessionsResponse.status)}`;
    assert(sessionsResponse.status === 200, 'Reader session page is available through Admin API');
    const sessionsText = await sessionsResponse.text();
    phase = 'Reader session response privacy projection';
    for (const secret of [
      ...sessionFixtureIds,
      ...sessionFixtureIds.map((_, index) => `session-token-private-${String(index)}`),
      ...sessionFixtureIds.map((_, index) => `session-user-agent-private-${String(index)}`),
      ...sessionFixtureIds.map((_, index) => `198.51.100.${String(index + 1)}`),
    ]) {
      assert(!sessionsText.includes(secret), 'session API never exposes IDs or connection data');
    }
    const sessionsPayload: unknown = JSON.parse(sessionsText);
    const sessionsContract = AdminReaderSessionsSchema.safeParse(sessionsPayload);
    phase = 'Reader session generated-contract projection';
    if (!sessionsContract.success) {
      phase = `session contract mismatch: ${sessionsContract.error.issues.map((issue) => issue.path.join('.')).join(',')}`;
      assert(false, 'session page matches the generated Admin contract');
    }
    phase = 'Reader session projection safety assertions';
    assert(
      sessionsContract.data.items.length === sessionsContract.data.total &&
        sessionsContract.data.total >= 27 &&
        sessionsContract.data.items.every(
          (session) =>
            Object.keys(session).sort().join('|') === 'createdAt|expiresAt|selector|updatedAt',
        ),
      'session projection contains only safe fields for all active Reader sessions',
    );
    const firstFixtureSession = sessionsContract.data.items.find(
      (session) => session.createdAt === new Date(sessionNow * 1_000).toISOString(),
    );
    const absentFixtureSession = sessionsContract.data.items.find(
      (session) => session.createdAt === new Date((sessionNow - 1) * 1_000).toISOString(),
    );
    assert(
      firstFixtureSession !== undefined && absentFixtureSession !== undefined,
      'session fixtures are present in the newest-first page',
    );
    phase = 'Reader detail remains available after sessions fixture setup';
    const postSessionFixtureDetail = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}`,
      { headers: { cookie: cookieHeader } },
    );
    assert(
      postSessionFixtureDetail.status === 200,
      'Reader detail remains readable after session setup',
    );
    await postSessionFixtureDetail.arrayBuffer();
    phase = 'social fixture D1 seed';
    const socialAssociationIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const [noOpAssociation, facebookAssociation, finalGoogleAssociation] = socialAssociationIds;
    assert(
      noOpAssociation !== undefined &&
        facebookAssociation !== undefined &&
        finalGoogleAssociation !== undefined,
      'social selectors allocated',
    );
    const socialCreatedAt = Math.floor(Date.now() / 1000) - 3600;
    await sql(
      `INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token,
       access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
       VALUES ('${noOpAssociation}', 'external-google-a-secret', 'google', '${regularDetailId}', 'social-access-secret', 'social-refresh-secret', 'social-id-secret', ${String(socialCreatedAt + 3600)}, ${String(socialCreatedAt + 7200)}, 'profile email secret-scope', NULL, ${String(socialCreatedAt)}, ${String(socialCreatedAt)}),
              ('${facebookAssociation}', 'external-facebook-secret', 'facebook', '${regularDetailId}', 'facebook-access-secret', 'facebook-refresh-secret', 'facebook-id-secret', ${String(socialCreatedAt + 3600)}, ${String(socialCreatedAt + 7200)}, 'email secret-scope', NULL, ${String(socialCreatedAt + 1)}, ${String(socialCreatedAt + 1)}),
              ('${finalGoogleAssociation}', 'external-google-b-secret', 'google', '${regularDetailId}', 'google-b-access-secret', 'google-b-refresh-secret', 'google-b-id-secret', ${String(socialCreatedAt + 3600)}, ${String(socialCreatedAt + 7200)}, 'profile secret-scope', NULL, ${String(socialCreatedAt + 2)}, ${String(socialCreatedAt + 2)})`,
    );
    phase = 'social projection privacy';
    const socialProjectionResponse = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}`,
      { headers: { cookie: cookieHeader } },
    );
    phase = 'social safe projection response';
    assert(
      socialProjectionResponse.status === 200,
      'safe social detail is readable through Worker',
    );
    const socialProjectionText = await socialProjectionResponse.text();
    phase = 'social projection secret redaction';
    for (const secret of [
      'external-google-a-secret',
      'external-facebook-secret',
      'social-access-secret',
      'social-refresh-secret',
      'social-id-secret',
      'facebook-access-secret',
      'facebook-refresh-secret',
      'facebook-id-secret',
      'secret-scope',
    ]) {
      assert(
        !socialProjectionText.includes(secret),
        'social detail omits provider credentials and scopes',
      );
    }
    const socialDetailResult = AdminReaderDetailSchema.safeParse(JSON.parse(socialProjectionText));
    phase = 'social projection generated contract';
    if (!socialDetailResult.success) {
      phase = `social Admin schema mismatch: ${socialDetailResult.error.issues.map((issue) => issue.path.join('.')).join(',')}`;
      assert(false, 'social detail matches generated Admin runtime contract');
    }
    assert(
      socialDetailResult.data.socialIdentities.length === 3 &&
        socialDetailResult.data.socialIdentities.every(
          (identity) => identity.state === 'unavailable',
        ),
      'social detail projects only configured local identities',
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
    await page.getByText('Contraseña', { exact: false }).waitFor();
    const uiSessionsResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/v1/admin/users/${regularDetailId}/sessions`,
    );
    await selectTab(page, 'Sesiones');
    const uiSessionsResponseValue = await uiSessionsResponse;
    phase = 'Reader session UI response contract';
    assert(uiSessionsResponseValue.status() === 200, 'Sessions tab loads its own session list');
    const uiSessionsPayload: unknown = await uiSessionsResponseValue.json();
    const uiSessionsContract = AdminReaderSessionsSchema.safeParse(uiSessionsPayload);
    assert(
      uiSessionsContract.success,
      'Sessions tab response matches the generated Admin contract',
    );
    const firstUiFixtureSession = uiSessionsContract.data.items.find(
      (session) => session.createdAt === new Date(sessionNow * 1_000).toISOString(),
    );
    const absentUiFixtureSession = uiSessionsContract.data.items.find(
      (session) => session.createdAt === new Date((sessionNow - 1) * 1_000).toISOString(),
    );
    assert(
      firstUiFixtureSession !== undefined && absentUiFixtureSession !== undefined,
      'UI session response contains both timestamp-correlated fixtures',
    );
    phase = 'Reader sessions list, pagination and privacy';
    await page.getByRole('heading', { name: 'Sesiones Reader', exact: true }).waitFor();
    await page
      .getByText(`${String(sessionsContract.data.total)} sesiones activas`, { exact: true })
      .waitFor();
    const sessionRows = page.locator('section[aria-labelledby="reader-sessions-title"] li');
    await waitForLocatorCount(page, 'section[aria-labelledby="reader-sessions-title"] li', 25);
    const sessionBody = await page.locator('body').innerText();
    for (const secret of [
      ...sessionFixtureIds,
      ...sessionFixtureIds.map((_, index) => `session-token-private-${String(index)}`),
      ...sessionFixtureIds.map((_, index) => `session-user-agent-private-${String(index)}`),
      ...sessionFixtureIds.map((_, index) => `198.51.100.${String(index + 1)}`),
    ]) {
      assert(!sessionBody.includes(secret), 'session UI never renders IDs or connection details');
    }
    assert(
      sessionBody.includes(firstUiFixtureSession.selector.slice(0, 7)) &&
        sessionBody.includes('Última actualización') &&
        sessionBody.includes('Creada') &&
        sessionBody.includes('Expira'),
      'session UI renders abbreviated selectors and only approved timestamps',
    );
    await page.getByRole('button', { name: 'Cargar más sesiones', exact: true }).click();
    await waitForLocatorCount(
      page,
      'section[aria-labelledby="reader-sessions-title"] li',
      sessionsContract.data.total,
    );

    phase = 'individual Reader session revoke confirmation and failure retry';
    let failSessionRevokeOnce = true;
    const sessionRevokeRequests: {
      readonly url: string;
      readonly headers: Record<string, string>;
    }[] = [];
    await page.route(
      `**/v1/admin/users/${regularDetailId}/sessions/${firstUiFixtureSession.selector}`,
      async (route) => {
        sessionRevokeRequests.push({
          url: route.request().url(),
          headers: route.request().headers(),
        });
        if (failSessionRevokeOnce) {
          failSessionRevokeOnce = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'urn:problem:internal-error',
              title: 'Internal Server Error',
              status: 503,
              code: 'internal-error',
              detail: 'private-session-problem-detail',
            }),
          });
        } else {
          await route.continue();
        }
      },
    );
    let detailReadsAfterSessionMutation = 0;
    let sessionReadsAfterSessionMutation = 0;
    const countSessionRefresh = (request: BrowserRequest) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === `/v1/admin/users/${regularDetailId}`) {
        detailReadsAfterSessionMutation++;
      }
      if (
        request.method() === 'GET' &&
        url.pathname === `/v1/admin/users/${regularDetailId}/sessions`
      ) {
        sessionReadsAfterSessionMutation++;
      }
    };
    page.on('request', countSessionRefresh);
    const firstSessionRow = sessionRows.filter({
      hasText: `${firstUiFixtureSession.selector.slice(0, 7)}…${firstUiFixtureSession.selector.slice(-4)}`,
    });
    const firstSessionAction = firstSessionRow.getByRole('button', {
      name: /^Revocar sesión /,
    });
    assert(
      !(await firstSessionAction.isDisabled()),
      'individual revoke is enabled when sessions exist',
    );
    await firstSessionAction.click();
    const revokeOneDialog = page.getByRole('alertdialog', {
      name: 'Confirmar revocación de sesión',
    });
    await revokeOneDialog.waitFor();
    const revokeOneCopy = await revokeOneDialog.innerText();
    assert(
      revokeOneCopy.includes('Se revocará solo la sesión') &&
        revokeOneCopy.includes('podrá iniciar sesión de nuevo si el acceso lo permite.') &&
        !revokeOneCopy.includes('private-session-problem-detail'),
      'individual confirmation describes one-session scope and future login semantics',
    );
    const sessionMutationBeforeConfirmation = sessionRevokeRequests.length;
    assert(sessionMutationBeforeConfirmation === 0, 'individual revoke waits for confirmation');
    await revokeOneDialog
      .getByRole('button', { name: 'Confirmar revocación', exact: true })
      .click();
    await page
      .getByText(
        'No recibimos una respuesta definitiva. Reintenta la misma revocación para comprobar el resultado.',
        { exact: true },
      )
      .waitFor();
    assert(
      !(await page.locator('body').innerText()).includes('private-session-problem-detail'),
      'session failure detail is never rendered',
    );
    await page
      .getByRole('button', { name: 'Reintentar revocación pendiente', exact: true })
      .click();
    const retrySessionDialog = page.getByRole('alertdialog', {
      name: 'Confirmar revocación de sesión',
    });
    await retrySessionDialog.waitFor();
    await retrySessionDialog.getByText(/misma revocación pendiente/).waitFor();
    const successfulSessionRevoke = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname ===
          `/v1/admin/users/${regularDetailId}/sessions/${firstUiFixtureSession.selector}`,
    );
    const refreshedSessionsResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/v1/admin/users/${regularDetailId}/sessions`,
    );
    await retrySessionDialog
      .getByRole('button', { name: 'Confirmar reintento', exact: true })
      .click();
    assert((await successfulSessionRevoke).status() === 200, 'individual session retry succeeds');
    const refreshedSessionsResponseValue = await refreshedSessionsResponse;
    assert(
      refreshedSessionsResponseValue.status() === 200,
      'successful revoke refreshes session list',
    );
    const refreshedSessionsPayload: unknown = await refreshedSessionsResponseValue.json();
    const refreshedSessionsContract = AdminReaderSessionsSchema.safeParse(refreshedSessionsPayload);
    assert(refreshedSessionsContract.success, 'refreshed session list matches Admin contract');
    const refreshedAbsentUiFixtureSession = refreshedSessionsContract.data.items.find(
      (session) => session.createdAt === new Date((sessionNow - 1) * 1_000).toISOString(),
    );
    assert(
      refreshedAbsentUiFixtureSession !== undefined,
      'refreshed UI list retains the absent-session fixture',
    );
    await page
      .getByText(
        'La sesión se revocó. El Reader podrá iniciar sesión de nuevo si el acceso lo permite.',
        { exact: true },
      )
      .waitFor();
    await firstSessionRow.waitFor({ state: 'detached' });
    assert(
      sessionRevokeRequests.length === 2 &&
        sessionRevokeRequests[0]?.url === sessionRevokeRequests[1]?.url &&
        sessionRevokeRequests.every(
          ({ headers }) =>
            headers['if-match'] === undefined && headers['idempotency-key'] === undefined,
        ) &&
        detailReadsAfterSessionMutation > 0 &&
        sessionReadsAfterSessionMutation >= 2,
      'retry repeats the same selector without mutation headers and refreshes sessions and Reader detail',
    );
    page.off('request', countSessionRefresh);
    await page.unroute(
      `**/v1/admin/users/${regularDetailId}/sessions/${firstUiFixtureSession.selector}`,
    );

    phase = 'absent Reader session no-op convergence';
    const absentSessionRow = sessionRows.filter({
      hasText: `${refreshedAbsentUiFixtureSession.selector.slice(0, 7)}…${refreshedAbsentUiFixtureSession.selector.slice(-4)}`,
    });
    const absentSessionId = sessionFixtureIds[1];
    assert(absentSessionId !== undefined, 'absent session fixture ID exists');
    await sql(
      `DELETE FROM session WHERE id = '${absentSessionId}' AND user_id = '${regularDetailId}'`,
    );
    await absentSessionRow.getByRole('button', { name: /^Revocar sesión / }).click();
    const absentSessionDialog = page.getByRole('alertdialog', {
      name: 'Confirmar revocación de sesión',
    });
    await absentSessionDialog.waitFor();
    const absentSessionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname ===
          `/v1/admin/users/${regularDetailId}/sessions/${refreshedAbsentUiFixtureSession.selector}`,
    );
    await absentSessionDialog
      .getByRole('button', { name: 'Confirmar revocación', exact: true })
      .click();
    const absentSessionResponseValue = await absentSessionResponse;
    assert(
      absentSessionResponseValue.status() === 200,
      'absent session selector converges with 200',
    );
    const absentSessionPayload: unknown = await absentSessionResponseValue.json();
    const absentSessionResult = AdminReaderSessionRevocationSchema.safeParse(absentSessionPayload);
    assert(
      absentSessionResult.success && !absentSessionResult.data.changed,
      'absent session result is the contract-validated no-op',
    );
    await absentSessionRow.waitFor({ state: 'detached' });
    await page
      .getByText('La sesión ya no estaba activa; el estado se actualizó.', { exact: true })
      .waitFor();

    phase = 'Reader revoke all and empty state';
    const revokeAllButton = page.getByRole('button', {
      name: 'Revocar todas las sesiones',
      exact: true,
    });
    await revokeAllButton.click();
    const revokeAllDialog = page.getByRole('alertdialog', {
      name: 'Confirmar revocación de sesión',
    });
    await revokeAllDialog.waitFor();
    const revokeAllCopy = await revokeAllDialog.innerText();
    assert(
      revokeAllCopy.includes('Se revocarán todas las sesiones activas del Reader.') &&
        revokeAllCopy.includes('podrá iniciar sesión de nuevo si el acceso lo permite.'),
      'revoke-all confirmation states scope and future login semantics',
    );
    const revokeAllResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname === `/v1/admin/users/${regularDetailId}/sessions`,
    );
    await revokeAllDialog
      .getByRole('button', { name: 'Confirmar revocación', exact: true })
      .click();
    const revokeAllResponseValue = await revokeAllResponse;
    assert(revokeAllResponseValue.status() === 200, 'revoke-all request succeeds');
    const revokeAllPayload: unknown = await revokeAllResponseValue.json();
    const revokeAllResult = AdminReaderSessionRevocationSchema.safeParse(revokeAllPayload);
    assert(
      revokeAllResult.success && revokeAllResult.data.changed,
      'revoke-all response confirms a changed state',
    );
    await page.getByText('No hay sesiones Reader activas.', { exact: true }).waitFor();
    await page
      .getByText(
        'Se revocaron las sesiones activas. El Reader podrá iniciar sesión de nuevo si el acceso lo permite.',
        { exact: true },
      )
      .waitFor();
    phase = `revoke-all refresh counts ${String(detailReadsAfterSessionMutation)}/${String(sessionReadsAfterSessionMutation)}`;
    assert(
      detailReadsAfterSessionMutation > 0 && sessionReadsAfterSessionMutation >= 3,
      'revoke-all refreshes authoritative Reader detail and sessions',
    );

    await page.getByText('No hay sesiones Reader activas.', { exact: true }).waitFor();
    const revokeAllWhenEmpty = page.getByRole('button', {
      name: 'Revocar todas las sesiones',
      exact: true,
    });
    assert(
      await revokeAllWhenEmpty.isDisabled(),
      'revoke-all is disabled when active total is zero',
    );
    const browserStorage = await page.evaluate<string>(
      `JSON.stringify({ local: Object.values(localStorage), session: Object.values(sessionStorage) })`,
    );
    assert(
      !browserStorage.includes('session-token-private') &&
        !browserStorage.includes('private-session-problem-detail'),
      'session token and private error detail never enter browser storage',
    );
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).click();
    await selectTab(page, 'Ciclo de vida');
    phase = 'deletion lifecycle panel visible';
    await page.getByRole('heading', { name: 'Solicitud de eliminación', exact: true }).waitFor();
    phase = 'social association safe projection';
    await page.getByRole('heading', { name: 'Identidades sociales', exact: true }).waitFor();
    await page
      .getByText('external-google-a-secret', { exact: true })
      .waitFor()
      .catch(() => undefined);
    assert(
      !(await page.locator('body').innerText()).includes('external-google-a-secret') &&
        !(await page.locator('body').innerText()).includes('social-access-secret') &&
        !(await page.locator('body').innerText()).includes('secret-scope'),
      'Admin social projection never renders provider ids, tokens or scopes',
    );
    phase = 'social availability label';
    await page.getByText('No disponible en esta configuración', { exact: true }).first().waitFor();

    phase = 'social verified unlink confirmation';
    const verifiedCard = page.locator('li').filter({ hasText: facebookAssociation });
    const socialRequestsBeforeConfirmation = { count: 0 };
    const countSocialRequest = (request: BrowserRequest) => {
      if (request.method() === 'DELETE' && request.url().includes('/social-identities/')) {
        socialRequestsBeforeConfirmation.count++;
      }
    };
    page.on('request', countSocialRequest);
    phase = 'open verified unlink confirmation';
    await verifiedCard
      .getByRole('button', { name: 'Desvincular Social provider', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    const noOpDialog = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Social provider',
    });
    await noOpDialog.waitFor();
    phase = 'verify verified unlink copy';
    const verifiedConfirmationText = await noOpDialog.innerText();
    const verifiedConfirmation = verifiedConfirmationText.replace(/\s+/g, ' ').trim();
    assert(
      verifiedConfirmation.includes('revocarán todas las sesiones Reader.') &&
        verifiedConfirmation.includes(
          'Se programará un aviso de seguridad porque el correo canónico está verificado.',
        ) &&
        verifiedConfirmation.includes('No se revocarán permisos en Social provider.') &&
        !verifiedConfirmation.includes(regular) &&
        !verifiedConfirmation.includes('social-access-secret') &&
        !verifiedConfirmation.includes('secret-scope'),
      'verified unlink confirmation explains the notice condition without exposing account or provider details',
    );
    phase = 'verify no social mutation before confirmation';
    assert(
      socialRequestsBeforeConfirmation.count === 0,
      'unlink does not send before confirmation',
    );
    await noOpDialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    phase = 'set unverified Reader email fixture';
    await sql(`UPDATE "user" SET email_verified = 0 WHERE id = '${regularDetailId}'`);
    phase = 'reload unverified Reader detail';
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).waitFor();
    phase = 'select lifecycle for unverified Reader';
    await selectTab(page, 'Ciclo de vida');
    const unverifiedCard = page.locator('li').filter({ hasText: facebookAssociation });
    phase = 'open unverified social unlink dialog';
    await unverifiedCard
      .getByRole('button', { name: 'Desvincular Social provider', exact: true })
      .click();
    const unverifiedDialog = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Social provider',
    });
    await unverifiedDialog.waitFor();
    phase = 'verify unverified unlink copy';
    const unverifiedConfirmation = (await unverifiedDialog.innerText()).replace(/\s+/g, ' ').trim();
    assert(
      unverifiedConfirmation.includes(
        'No se puede programar un aviso automático porque el correo canónico no está verificado.',
      ) &&
        unverifiedConfirmation.includes('No se revocarán permisos en Social provider.') &&
        !unverifiedConfirmation.includes(regular) &&
        !unverifiedConfirmation.includes('social-access-secret') &&
        !unverifiedConfirmation.includes('secret-scope'),
      'unverified unlink confirmation states no automatic notice and exposes no account or provider details',
    );
    phase = 'cancel unverified unlink confirmation';
    await unverifiedDialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    phase = 'restore verified Reader email fixture';
    await sql(`UPDATE "user" SET email_verified = 1 WHERE id = '${regularDetailId}'`);
    phase = 'reload verified Reader detail after unverified copy';
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).waitFor();
    phase = 'select lifecycle after restoring verified email';
    await selectTab(page, 'Ciclo de vida');
    phase = 'open no-op unlink confirmation';
    const noOpCard = page.locator('li').filter({ hasText: noOpAssociation });
    await noOpCard.getByRole('button', { name: 'Desvincular Google', exact: true }).click();
    phase = 'wait for no-op unlink confirmation';
    const noOpConfirmation = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Google',
    });
    await noOpConfirmation.waitFor();
    phase = 'delete social association during no-op confirmation';
    await sql(
      `DELETE FROM account WHERE id = '${noOpAssociation}' AND user_id = '${regularDetailId}'`,
    );
    const noOpRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        request.url() ===
          new URL(
            `/v1/admin/users/${encodeURIComponent(regularDetailId)}/social-identities/${encodeURIComponent(noOpAssociation)}`,
            base,
          ).toString(),
    );
    const noOpResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url() ===
          new URL(
            `/v1/admin/users/${encodeURIComponent(regularDetailId)}/social-identities/${encodeURIComponent(noOpAssociation)}`,
            base,
          ).toString(),
    );
    let noOpDetailRefreshes = 0;
    const countNoOpDetailRefresh = (request: BrowserRequest) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === `/v1/admin/users/${regularDetailId}`) {
        noOpDetailRefreshes++;
      }
    };
    page.on('request', countNoOpDetailRefresh);
    await noOpConfirmation
      .getByRole('button', { name: 'Confirmar desvinculación de Google', exact: true })
      .click();
    phase = 'receive no-op social unlink response';
    const [noOpRequestValue, noOpResponseValue] = await Promise.all([noOpRequest, noOpResponse]);
    phase = 'verify exact no-op social unlink URL';
    page.off('request', countSocialRequest);
    const expectedNoOpUrl = new URL(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/social-identities/${encodeURIComponent(noOpAssociation)}`,
      base,
    ).toString();
    assert(
      noOpRequestValue.url() === expectedNoOpUrl && noOpResponseValue.url() === expectedNoOpUrl,
      'no-op unlink uses the exact scoped DELETE URL',
    );
    phase = 'verify no-op social unlink response';
    assert(noOpResponseValue.status() === 200, 'missing association is an HTTP no-op');
    assert(
      noOpRequestValue.headers()['if-match'] === '"1"' &&
        (noOpRequestValue.headers()['idempotency-key'] ?? '').length > 0,
      'no-op unlink carries the account ETag and Idempotency-Key',
    );
    const noOpResult = (await noOpResponseValue.json()) as unknown;
    assert(
      AdminReaderSocialIdentityUnlinkSchema.safeParse(noOpResult).success &&
        typeof noOpResult === 'object' &&
        noOpResult !== null &&
        'changed' in noOpResult &&
        noOpResult.changed === false,
      'no-op is presented as changed false, never as a committed unlink',
    );
    phase = 'wait for stable no-op message';
    await page
      .getByText('Esta asociación ya no estaba vinculada; no se aplicó ningún cambio.', {
        exact: true,
      })
      .waitFor();
    phase = 'wait for no-op row removal';
    await noOpCard.waitFor({ state: 'detached' });
    phase = 'verify no-op authoritative refresh';
    assert(noOpDetailRefreshes > 0, 'no-op unlink refreshes authoritative Reader detail');
    page.off('request', countNoOpDetailRefresh);
    phase = 'verify stable no-op status';
    assert(
      await page
        .getByText('Esta asociación ya no estaba vinculada; no se aplicó ningún cambio.', {
          exact: true,
        })
        .isVisible(),
      'no-op status survives removal of the stale association row',
    );
    phase = 'verify no-op privacy';
    const noOpBody = await page.locator('body').innerText();
    phase = 'verify no-op privacy';
    assert(
      !noOpBody.includes('social-access-secret') &&
        !noOpBody.includes('secret-scope') &&
        !noOpBody.includes('external-google-a-secret'),
      'no-op unlink status and refreshed detail expose no provider secrets',
    );
    phase = 'establish Reader session for no-op preservation check';
    const readerSessionAfterNoOpLogin = await http('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: regular, password }),
    });
    assert(
      readerSessionAfterNoOpLogin.status === 200,
      'Reader can sign in after session revocation',
    );
    const readerCookieAfterSessionRevoke = readerSessionAfterNoOpLogin.headers
      .get('set-cookie')
      ?.split(';')[0];
    assert(
      readerCookieAfterSessionRevoke !== undefined && readerCookieAfterSessionRevoke.length > 0,
      'fresh Reader session cookie captured for no-op preservation check',
    );
    const readerSessionAfterNoOp = await http('/v1/me', {
      headers: { cookie: readerCookieAfterSessionRevoke },
    });
    assert(readerSessionAfterNoOp.status === 200, 'no-op leaves Reader session active');
    await readerSessionAfterNoOp.arrayBuffer();
    const noOpActivity = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/activity?limit=25`,
      { headers: { cookie: cookieHeader } },
    );
    assert(noOpActivity.status === 200, 'Reader activity remains readable after no-op');
    assert(
      !(await noOpActivity.text()).includes('social-identity-unlinked'),
      'no-op creates no lifecycle activity event',
    );

    phase = 'social unlink active-deletion policy';
    const deletionForSocial = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/deletion-requests`,
      {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/json',
          'if-match': '"1"',
          'idempotency-key': 'browser-social-active-deletion',
        },
        body: JSON.stringify({}),
      },
    );
    phase = 'social active-deletion request committed';
    if (deletionForSocial.status !== 201) {
      const deletionProblem = (await deletionForSocial.json()) as { code?: unknown };
      phase = `social active-deletion response ${String(deletionForSocial.status)} ${String(deletionProblem.code)}`;
      assert(false, 'deletion suspension fixture is committed by Worker');
    }
    const socialDeletion = (await deletionForSocial.json()) as { requestId: string };
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await selectTab(page, 'Ciclo de vida');
    phase = 'social unlink blocked by active deletion';
    const facebookCardDuringDeletion = page.locator('li').filter({ hasText: facebookAssociation });
    await facebookCardDuringDeletion
      .getByRole('button', { name: 'Desvincular Social provider', exact: true })
      .click();
    const deletionBlockDialog = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Social provider',
    });
    await deletionBlockDialog.waitFor();
    const deletionBlockedRequest = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/social-identities/${facebookAssociation}`),
    );
    await deletionBlockDialog
      .getByRole('button', { name: 'Confirmar desvinculación de Social provider', exact: true })
      .click();
    const deletionBlockedResponse = await deletionBlockedRequest;
    assert(
      deletionBlockedResponse.status() === 409,
      'active deletion blocks social unlink at Worker',
    );
    await page
      .getByText(
        'No se pueden administrar asociaciones mientras una solicitud de eliminación esté activa.',
        { exact: true },
      )
      .waitFor();
    const cancelSocialDeletion = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/deletion-requests/${encodeURIComponent(socialDeletion.requestId)}/status`,
      {
        method: 'PUT',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/json',
          'if-match': '"1"',
          'idempotency-key': 'browser-social-cancel-deletion',
        },
        body: JSON.stringify({ state: 'cancelled' }),
      },
    );
    assert(cancelSocialDeletion.status === 200, 'social test deletion suspension is cancelled');
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await selectTab(page, 'Ciclo de vida');

    phase = 'social unlink stale account ETag';
    const beforeStaleAccess = await http(`/v1/admin/users/${encodeURIComponent(regularDetailId)}`, {
      headers: { cookie: cookieHeader },
    });
    phase = 'social stale ETag detail lookup';
    assert(beforeStaleAccess.status === 200, 'current account revision is available');
    const staleEtag = beforeStaleAccess.headers.get('etag');
    assert(staleEtag !== null, 'current account ETag is present before the race');
    await beforeStaleAccess.arrayBuffer();
    const accessBeforeStale = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/access`,
      {
        method: 'PUT',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/json',
          'if-match': staleEtag,
        },
        body: JSON.stringify({ state: 'disabled' }),
      },
    );
    phase = 'social stale ETag concurrent account update';
    assert(
      accessBeforeStale.status === 200,
      'Reader is disabled through public Admin access route',
    );
    const staleFacebookCard = page.locator('li').filter({ hasText: facebookAssociation });
    phase = 'social stale ETag unlink mutation';
    await staleFacebookCard
      .getByRole('button', { name: 'Desvincular Social provider', exact: true })
      .click();
    const staleDialog = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Social provider',
    });
    await staleDialog.waitFor();
    const staleSocialResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/social-identities/${facebookAssociation}`),
    );
    await staleDialog
      .getByRole('button', { name: 'Confirmar desvinculación de Social provider', exact: true })
      .click();
    assert((await staleSocialResponse).status() === 412, 'stale unlink ETag is rejected by Worker');
    await page
      .getByText('La cuenta cambió. Actualiza los datos antes de volver a intentarlo.', {
        exact: true,
      })
      .waitFor();

    phase = 'social unlink required account ETag';
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await selectTab(page, 'Ciclo de vida');
    let stripIfMatchOnce = true;
    await page.route(
      `**/v1/admin/users/${regularDetailId}/social-identities/${facebookAssociation}`,
      async (route) => {
        if (stripIfMatchOnce) {
          stripIfMatchOnce = false;
          const headers = { ...route.request().headers() };
          delete headers['if-match'];
          await route.continue({ headers });
        } else {
          await route.continue();
        }
      },
    );
    const preconditionCard = page.locator('li').filter({ hasText: facebookAssociation });
    await preconditionCard
      .getByRole('button', { name: 'Desvincular Social provider', exact: true })
      .click();
    const preconditionDialog = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Social provider',
    });
    await preconditionDialog.waitFor();
    const missingMatchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/social-identities/${facebookAssociation}`),
    );
    await preconditionDialog
      .getByRole('button', { name: 'Confirmar desvinculación de Social provider', exact: true })
      .click();
    assert(
      (await missingMatchResponse).status() === 428,
      'missing account ETag is rejected by Worker',
    );
    await page
      .getByText(
        'Falta la revisión de la cuenta. Actualiza los datos antes de volver a intentarlo.',
        { exact: true },
      )
      .waitFor();
    await page.unroute(
      `**/v1/admin/users/${regularDetailId}/social-identities/${facebookAssociation}`,
    );

    phase = 'social unlink ambiguous committed retry';
    const rehabilitateRevision = Number(staleEtag.replaceAll('"', '')) + 1;
    const rehabilitated = await http(
      `/v1/admin/users/${encodeURIComponent(regularDetailId)}/access`,
      {
        method: 'PUT',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/json',
          'if-match': `"${String(rehabilitateRevision)}"`,
        },
        body: JSON.stringify({ state: 'active' }),
      },
    );
    assert(rehabilitated.status === 200, 'disabled Reader remains manageable and is rehabilitated');
    const relogin = await http('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: regular, password }),
    });
    assert(relogin.status === 200, 'Reader can sign in again before final social unlink');
    const socialReaderCookie = relogin.headers.get('set-cookie')?.split(';')[0];
    assert(
      socialReaderCookie !== undefined && socialReaderCookie.length > 0,
      'fresh Reader session captured',
    );
    const activeReaderSession = await http('/v1/me', { headers: { cookie: socialReaderCookie } });
    assert(activeReaderSession.status === 200, 'Reader session is live before successful unlink');
    await activeReaderSession.arrayBuffer();
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await page.getByRole('tab', { name: 'Ciclo de vida', exact: true }).waitFor();
    await selectTab(page, 'Ciclo de vida');
    const unlinkKeys: string[] = [];
    const unlinkEtags: string[] = [];
    let hideCommittedResponseOnce = true;
    await page.route(
      `**/v1/admin/users/${regularDetailId}/social-identities/${facebookAssociation}`,
      async (route) => {
        unlinkKeys.push(route.request().headers()['idempotency-key'] ?? '');
        unlinkEtags.push(route.request().headers()['if-match'] ?? '');
        if (hideCommittedResponseOnce) {
          hideCommittedResponseOnce = false;
          const committed = await route.fetch();
          assert(
            committed.status() === 200,
            'actual D1 unlink commits before simulated lost response',
          );
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
        } else {
          await route.continue();
        }
      },
    );
    const facebookCard = page.locator('li').filter({ hasText: facebookAssociation });
    await facebookCard
      .getByRole('button', { name: 'Desvincular Social provider', exact: true })
      .click();
    const successDialog = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Social provider',
    });
    await successDialog.waitFor();
    await successDialog
      .getByRole('button', { name: 'Confirmar desvinculación de Social provider', exact: true })
      .click();
    await page
      .getByText(
        'La asociación se quitó, pero no se pudo programar el aviso de seguridad. Reintenta el mismo comando.',
        { exact: true },
      )
      .waitFor();
    const retryUnlinkResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/social-identities/${facebookAssociation}`),
    );
    await facebookCard
      .getByRole('button', { name: 'Reintentar desvinculación pendiente', exact: true })
      .click();
    assert(
      (await retryUnlinkResponse).status() === 200,
      'retry replays the committed unlink response',
    );
    assert(
      unlinkKeys.length === 2 &&
        unlinkKeys[0] !== '' &&
        unlinkKeys[0] === unlinkKeys[1] &&
        unlinkEtags.length === 2 &&
        unlinkEtags[0] === unlinkEtags[1],
      'ambiguous social unlink retry preserves exact Idempotency-Key and account ETag',
    );
    await page.unroute(
      `**/v1/admin/users/${regularDetailId}/social-identities/${facebookAssociation}`,
    );
    const revokedReaderSession = await http('/v1/me', { headers: { cookie: socialReaderCookie } });
    assert(
      revokedReaderSession.status === 401,
      'successful social unlink revokes the Reader session',
    );
    await revokedReaderSession.arrayBuffer();
    await page.getByText(facebookAssociation, { exact: true }).waitFor({ state: 'hidden' });

    phase = 'social unlink last usable login policy';
    await sql(
      `DELETE FROM account WHERE user_id = '${regularDetailId}' AND provider_id = 'credential'`,
    );
    await page.reload();
    await visible(page, 'Detalle de usuario');
    await selectTab(page, 'Ciclo de vida');
    const lastSocialCard = page.locator('li').filter({ hasText: finalGoogleAssociation });
    await lastSocialCard.getByRole('button', { name: 'Desvincular Google', exact: true }).click();
    const lastMethodDialog = page.getByRole('alertdialog', {
      name: 'Confirmar desvinculación de Google',
    });
    await lastMethodDialog.waitFor();
    const lastMethodResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/social-identities/${finalGoogleAssociation}`),
    );
    await lastMethodDialog
      .getByRole('button', { name: 'Confirmar desvinculación de Google', exact: true })
      .click();
    assert(
      (await lastMethodResponse).status() === 409,
      'Worker protects the final usable login method',
    );
    await page
      .getByText('No se puede quitar el último método de acceso utilizable del Reader.', {
        exact: true,
      })
      .waitFor();
    await sql(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       SELECT '${crypto.randomUUID()}', '${regularDetailId}', 'credential', '${regularDetailId}', password, created_at, updated_at
       FROM account WHERE provider_id = 'credential' AND user_id <> '${regularDetailId}' LIMIT 1`,
    );

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
    phase = 'Administrator invitation browser acceptance';
    await administratorInvitationAcceptance(page, base, browser, (value) => {
      phase = value;
    });
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
