import { describe, expect, it } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  buildSessionFailureTailArgs,
  buildSessionFailureTailCommand,
  formatSafeSessionFailure,
  parseTailLine,
  parseTailLines,
  resolveWranglerCliPath,
  SESSION_FAILURE_TAIL_KILL_SETTLE_MS,
  SESSION_FAILURE_TAIL_MAX_DURATION_MS,
  SESSION_FAILURE_TAIL_READY_GRACE_MS,
  SESSION_FAILURE_TAIL_START_TIMEOUT_MS,
  SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS,
  startSessionFailureTail,
  summarizeSessionFailures,
  withTimeout,
} from '../../scripts/deploy/diagnostic-tail.js';
import {
  planDeploymentSteps,
  runDeployment,
  type DeployCommandRunner,
  type DeployIo,
} from '../../scripts/deploy/orchestrate.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import { CONTRACT_SANDBOX_DATABASE_ID } from './deploy-test-utils.js';

// Seams under test (ticket #96, ADR-0009):
// 1. `scripts/deploy/diagnostic-tail.ts` — pure whitelist boundary for the
//    already-redacted `session.resolve-failed` Worker event. Only `event`,
//    `phase`, and optional `requestId`/`environment` correlation may surface;
//    exception text, cookies, credentials, tokens, emails, URLs and bodies
//    never surface.
// 2. `scripts/deploy/orchestrate.ts` — sandbox deploy boundary starts a
//    bounded diagnostic tail immediately before `smoke-sandbox` and always
//    terminates it afterward. A failed smoke reports the safe phase
//    (`config`|`auth`|`session`) or `phase unavailable`; a successful smoke
//    never fails for missing events; production never tails.

const SANDBOX: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
};

const DIRECT = JSON.stringify({
  level: 'error',
  event: 'session.resolve-failed',
  phase: 'config',
  requestId: 'req-123',
  environment: 'sandbox',
});

function envelopeWith(message: string): string {
  return JSON.stringify({
    outcome: 'ok',
    scriptName: 'rch-rugbychampagne-user-service-sandbox',
    exceptions: [],
    logs: [{ message: [message], level: 'log', timestamp: 1758500000000 }],
    eventTimestamp: 1758500000000,
    event: { request: { url: 'https://sandbox.workers.dev/v1/me', method: 'GET' } },
  });
}

describe('session failure tail args (ticket #96)', () => {
  it('tails the sandbox Worker filtered to the safe event with the target config', () => {
    const args = buildSessionFailureTailArgs(SANDBOX, '/tmp/wrangler.sandbox.json');
    expect(args).toEqual([
      'tail',
      'rch-rugbychampagne-user-service-sandbox',
      '--format',
      'json',
      '--search',
      'session.resolve-failed',
      '--config',
      '/tmp/wrangler.sandbox.json',
    ]);
  });

  it('never embeds secrets or email addresses in the tail invocation', () => {
    const args = buildSessionFailureTailArgs(SANDBOX, '/tmp/wrangler.sandbox.json');
    const text = args.join(' ');
    expect(text).not.toMatch(/SECRET/i);
    expect(text).not.toMatch(/SMTP/i);
    expect(text).not.toMatch(/@/);
  });
});

describe('session failure whitelist parsing (ticket #96, ADR-0009)', () => {
  it('parses the direct redacted Worker event', () => {
    expect(parseTailLine(DIRECT)).toEqual({
      event: 'session.resolve-failed',
      phase: 'config',
      requestId: 'req-123',
      environment: 'sandbox',
    });
  });

  it('extracts the safe event from a wrangler tail JSON envelope', () => {
    const inner = JSON.stringify({ event: 'session.resolve-failed', phase: 'auth' });
    expect(parseTailLine(envelopeWith(inner))).toEqual({
      event: 'session.resolve-failed',
      phase: 'auth',
    });
  });

  it('supports every stable phase without leaking extra fields', () => {
    for (const phase of ['config', 'auth', 'session'] as const) {
      const parsed = parseTailLine(
        JSON.stringify({ level: 'error', event: 'session.resolve-failed', phase }),
      );
      expect(parsed).toEqual({ event: 'session.resolve-failed', phase });
    }
    const withSecrets = parseTailLine(
      JSON.stringify({
        level: 'error',
        event: 'session.resolve-failed',
        phase: 'session',
        requestId: 'req-9',
        environment: 'sandbox',
        message: 'boom: connection refused',
        stack: 'Error: boom',
        email: 'probe@ops.example.org',
        token: 'secret-token',
        cookie: 'better-auth.session_token=abc',
        url: 'https://example.com/?token=abc',
      }),
    );
    expect(withSecrets).toEqual({
      event: 'session.resolve-failed',
      phase: 'session',
      requestId: 'req-9',
      environment: 'sandbox',
    });
  });

  it('rejects non-matching events, unknown phases, and non-JSON lines', () => {
    expect(
      parseTailLine(JSON.stringify({ level: 'info', event: 'smoke', status: 200 })),
    ).toBeNull();
    expect(
      parseTailLine(JSON.stringify({ event: 'session.resolve-failed', phase: 'mailer' })),
    ).toBeNull();
    expect(parseTailLine('not json at all')).toBeNull();
    expect(parseTailLine('')).toBeNull();
    expect(parseTailLine(JSON.stringify({ outcome: 'ok', logs: [], exceptions: [] }))).toBeNull();
  });

  it('collects only the safe events from a tail window', () => {
    const lines = [
      DIRECT,
      JSON.stringify({ level: 'info', step: 'health', status: 200 }),
      envelopeWith(JSON.stringify({ event: 'session.resolve-failed', phase: 'session' })),
      'garbage line',
    ];
    const events = parseTailLines(lines);
    expect(events.map((entry) => entry.phase)).toEqual(['config', 'session']);
  });
});

describe('session failure summary redaction (ticket #96, ADR-0009)', () => {
  it('reports the observed phase without raw log text', () => {
    const summary = summarizeSessionFailures([{ event: 'session.resolve-failed', phase: 'auth' }]);
    expect(summary).toMatch(/auth/);
    expect(summary).not.toMatch(/boom|token|cookie|@/i);
  });

  it('reports phase unavailable when no safe event was observed', () => {
    const summary = summarizeSessionFailures([]);
    expect(summary).toMatch(/phase unavailable/i);
  });

  it('formats only whitelisted fields', () => {
    const formatted = formatSafeSessionFailure({
      event: 'session.resolve-failed',
      phase: 'session',
      requestId: 'req-7',
      environment: 'sandbox',
    });
    expect(JSON.parse(formatted)).toEqual({
      event: 'session.resolve-failed',
      phase: 'session',
      requestId: 'req-7',
      environment: 'sandbox',
    });
  });
});

describe('session failure tail bounds (ticket #96)', () => {
  it('declares finite start/stop/maximum timeouts', () => {
    for (const bound of [
      SESSION_FAILURE_TAIL_START_TIMEOUT_MS,
      SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS,
      SESSION_FAILURE_TAIL_MAX_DURATION_MS,
    ]) {
      expect(Number.isFinite(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
    }
    expect(SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS).toBeLessThan(SESSION_FAILURE_TAIL_MAX_DURATION_MS);
  });

  it('resolves when the wrapped promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'tail stop')).resolves.toBe('ok');
  });

  it('rejects instead of hanging when the wrapped promise never settles', async () => {
    await expect(withTimeout(new Promise<never>(() => undefined), 20, 'tail stop')).rejects.toThrow(
      /tail stop.*timed out/,
    );
  });
});

describe('sandbox smoke diagnostic tail lifecycle (ticket #96)', () => {
  interface TailHarness {
    io: DeployIo;
    runner: DeployCommandRunner;
    logs: string[];
    started: number;
    stopped: number;
    tailLines: string[];
    startFails: boolean;
  }

  function createTailHarness(options: {
    smokeFails?: boolean;
    tailLines?: string[];
    startFails?: boolean;
  }): TailHarness {
    const harness: TailHarness = {
      io: undefined as unknown as DeployIo,
      runner: (command, args) => {
        if (args.includes('versions') && args.includes('list')) {
          return Promise.resolve({ exitCode: 0, stdout: '[{"version_id":"existing"}]' });
        }
        if (command === 'npm' && args.join(' ').includes('smoke:sandbox')) {
          if (options.smokeFails === true) {
            return Promise.resolve({ exitCode: 1 });
          }
          return Promise.resolve({ exitCode: 0 });
        }
        return Promise.resolve({ exitCode: 0 });
      },
      logs: [],
      started: 0,
      stopped: 0,
      tailLines: options.tailLines ?? [],
      startFails: options.startFails ?? false,
    };
    harness.io = {
      materialize: () => '/tmp/wrangler.tail-test.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        harness.logs.push(message);
      },
      startSessionFailureTail: () => {
        harness.started += 1;
        if (harness.startFails) {
          return Promise.reject(new Error('tail unavailable'));
        }
        return Promise.resolve({
          exitedBeforeSmoke: false,
          isLive: () => true,
          peekLines: () => [...harness.tailLines],
          stop: () => {
            harness.stopped += 1;
            return Promise.resolve([...harness.tailLines]);
          },
        });
      },
    };
    return harness;
  }

  it('keeps sandbox smoke as the last planned step', () => {
    expect(planDeploymentSteps({ resolved: SANDBOX }).at(-1)).toBe('smoke-sandbox');
  });

  it('starts the tail before smoke and always terminates it on failure', async () => {
    const harness = createTailHarness({
      smokeFails: true,
      tailLines: [JSON.stringify({ event: 'session.resolve-failed', phase: 'session' })],
    });
    await expect(runDeployment({ resolved: SANDBOX }, harness.io, harness.runner)).rejects.toThrow(
      /smoke-sandbox/,
    );
    expect(harness.started).toBe(1);
    expect(harness.stopped).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/session/);
  });

  it('reports phase unavailable instead of dumping unfiltered logs when smoke fails with no event', async () => {
    const harness = createTailHarness({ smokeFails: true, tailLines: [] });
    await expect(runDeployment({ resolved: SANDBOX }, harness.io, harness.runner)).rejects.toThrow(
      /smoke-sandbox/,
    );
    expect(harness.stopped).toBe(1);
    const transcript = harness.logs.join('\n');
    expect(transcript).toMatch(/phase unavailable/i);
  });

  it('does not fail a successful smoke when no diagnostic event was observed', async () => {
    const harness = createTailHarness({ smokeFails: false, tailLines: [] });
    await expect(
      runDeployment({ resolved: SANDBOX }, harness.io, harness.runner),
    ).resolves.toMatchObject({ workerName: SANDBOX.workerName });
    expect(harness.started).toBe(1);
    expect(harness.stopped).toBe(1);
  });

  it('still runs smoke when tail startup fails', async () => {
    const harness = createTailHarness({ smokeFails: false, startFails: true });
    await expect(
      runDeployment({ resolved: SANDBOX }, harness.io, harness.runner),
    ).resolves.toMatchObject({ workerName: SANDBOX.workerName });
    expect(harness.started).toBe(1);
    expect(harness.stopped).toBe(0);
  });

  it('never starts a diagnostic tail for production', async () => {
    const harness = createTailHarness({ smokeFails: false });
    const production: ResolvedDeployment = {
      ...SANDBOX,
      environment: 'production',
      workerName: 'rch-rugbychampagne-user-service-production',
      databaseName: 'rch-rugbychampagne-user-service-production-db',
    };
    await runDeployment(
      { resolved: production, confirm: production.workerName },
      harness.io,
      harness.runner,
    );
    expect(harness.started).toBe(0);
    expect(harness.stopped).toBe(0);
  });
});

// Lifecycle under test (ticket #98): the diagnostic tail child must be the
// actual controlled process (no `npx`/wrapper descendant that can outlive
// `stop`), `stop()` must complete within its bound and release stdio, the
// hard maximum must terminate the tail even when `stop()` is never called,
// and startup must wait a bounded readiness grace so the tail does not race
// the fast health -> anonymous `/v1/me` smoke sequence. These tests drive the
// real lifecycle against stub `node -e` children with injected short bounds
// so a regression hangs the assertion, never the suite.
describe('sandbox diagnostic tail process lifecycle (ticket #98)', () => {
  const IGNORE_SIGTERM =
    'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 50);';
  const COOPERATIVE = 'console.log("stub ready"); setInterval(() => undefined, 50);';

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        return true;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    return !isAlive(pid);
  }

  it('resolves the repository-pinned wrangler CLI entry instead of an npx wrapper', () => {
    const cliPath = resolveWranglerCliPath();
    expect(cliPath.endsWith('wrangler-dist/cli.js')).toBe(true);
    expect(cliPath).not.toMatch(/\.bin/);
    expect(existsSync(cliPath)).toBe(true);
  });

  it('builds a direct tail command with no unmanaged wrapper hop', () => {
    const command = buildSessionFailureTailCommand(SANDBOX, '/tmp/wrangler.sandbox.json');
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toBe(resolveWranglerCliPath());
    expect(command.args).toEqual([
      resolveWranglerCliPath(),
      'tail',
      'rch-rugbychampagne-user-service-sandbox',
      '--format',
      'json',
      '--search',
      'session.resolve-failed',
      '--config',
      '/tmp/wrangler.sandbox.json',
    ]);
    expect(`${command.command} ${command.args.join(' ')}`).not.toMatch(/\bnpx\b/);
  });

  it('declares a readiness grace and kill settle bounded well inside the hard maximum', () => {
    for (const bound of [
      SESSION_FAILURE_TAIL_READY_GRACE_MS,
      SESSION_FAILURE_TAIL_KILL_SETTLE_MS,
    ]) {
      expect(Number.isFinite(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
    }
    expect(SESSION_FAILURE_TAIL_READY_GRACE_MS).toBeLessThan(SESSION_FAILURE_TAIL_START_TIMEOUT_MS);
    expect(SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS + SESSION_FAILURE_TAIL_KILL_SETTLE_MS).toBeLessThan(
      SESSION_FAILURE_TAIL_MAX_DURATION_MS,
    );
  });

  it('spawns the pinned entry directly as the controlled child', async () => {
    let spawned: { command: string; args: string[] } | undefined;
    const seen: ChildProcess[] = [];
    const handle = await startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      readyGraceMs: 5,
      startTimeoutMs: 5000,
      stopTimeoutMs: 1000,
      killSettleMs: 500,
      maxDurationMs: 30_000,
      spawnFn: (command, args, options) => {
        spawned = { command, args: [...args] };
        // Capture the requested invocation; run a harmless stub child instead
        // of the real Wrangler tail so the test stays hermetic.
        const child = nodeSpawn(process.execPath, ['-e', COOPERATIVE], options);
        seen.push(child);
        return child;
      },
    });
    try {
      expect(spawned?.command).toBe(process.execPath);
      expect(spawned?.args[0]).toBe(resolveWranglerCliPath());
      expect(`${spawned?.command ?? ''} ${(spawned?.args ?? []).join(' ')}`).not.toMatch(/\bnpx\b/);
      expect(seen).toHaveLength(1);
    } finally {
      await handle.stop();
    }
  });

  it('waits the bounded readiness grace before resolving startup', async () => {
    const started = Date.now();
    const handle = await startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      readyGraceMs: 200,
      startTimeoutMs: 5000,
      stopTimeoutMs: 1000,
      killSettleMs: 500,
      maxDurationMs: 10_000,
      command: process.execPath,
      args: ['-e', COOPERATIVE],
    });
    try {
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    } finally {
      await handle.stop();
    }
  });

  it('stop() captures output and terminates a cooperative child with no leaked handles', async () => {
    let child: ChildProcess | undefined;
    const handle = await startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      // Grace comfortably covers stub interpreter startup so the ready line
      // is printed before `stop()`; production uses the 5s documented grace.
      readyGraceMs: 1000,
      startTimeoutMs: 5000,
      stopTimeoutMs: 2000,
      killSettleMs: 1000,
      maxDurationMs: 30_000,
      spawnFn: (command, args, options) => {
        child = nodeSpawn(command, args, options);
        return child;
      },
      command: process.execPath,
      args: ['-e', COOPERATIVE],
    });
    const lines = await handle.stop();
    expect(lines.join('\n')).toMatch(/stub ready/);
    expect(child?.stdout?.destroyed).toBe(true);
    expect(child?.stderr?.destroyed).toBe(true);
    expect(child !== undefined && (child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
    if (child?.pid !== undefined) {
      expect(isAlive(child.pid)).toBe(false);
    }
    // A second stop is a fast idempotent no-op, never a second kill window.
    await expect(handle.stop()).resolves.toEqual([...lines]);
  });

  it('stop() force-terminates a SIGTERM-ignoring child within bounds', async () => {
    let child: ChildProcess | undefined;
    const handle = await startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      // Grace covers stub interpreter startup so the SIGTERM handler is
      // installed before `stop()`; otherwise an early SIGTERM would
      // (correctly but unhelpfully) terminate the stub via SIGTERM.
      readyGraceMs: 1000,
      startTimeoutMs: 5000,
      stopTimeoutMs: 300,
      killSettleMs: 1000,
      maxDurationMs: 30_000,
      spawnFn: (command, args, options) => {
        child = nodeSpawn(command, args, options);
        return child;
      },
      command: process.execPath,
      args: ['-e', IGNORE_SIGTERM],
    });
    const started = Date.now();
    const lines = await handle.stop();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(Array.isArray(lines)).toBe(true);
    expect(child?.signalCode).toBe('SIGKILL');
    expect(child?.stdout?.destroyed).toBe(true);
    expect(child?.stderr?.destroyed).toBe(true);
    if (child?.pid !== undefined) {
      expect(isAlive(child.pid)).toBe(false);
    }
  });

  it('hard maximum terminates a SIGTERM-ignoring child even when stop() is never called', async () => {
    let child: ChildProcess | undefined;
    const handle = await startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      readyGraceMs: 5,
      startTimeoutMs: 5000,
      stopTimeoutMs: 200,
      killSettleMs: 500,
      maxDurationMs: 500,
      spawnFn: (command, args, options) => {
        child = nodeSpawn(command, args, options);
        return child;
      },
      command: process.execPath,
      args: ['-e', IGNORE_SIGTERM],
    });
    try {
      expect(child?.pid).toBeDefined();
      expect(await waitForDeath(child?.pid ?? -1, 8000)).toBe(true);
      expect(child?.stdout?.destroyed).toBe(true);
      expect(child?.stderr?.destroyed).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});

// Liveness under test (ticket #100): a failed sandbox smoke must always make
// the deploy promise reject (nonzero exit upstream) even while the diagnostic
// tail teardown is still in progress. The live false-green in deploy run
// 35548407940 ended SUCCESS after `Sandbox smoke failed at me-anonymous` with
// neither the `sandbox smoke diagnostic` summary nor `deployment complete`
// output — consistent with the awaited tail child plus awaited lifecycle timers
// all being `unref()`'d so Node exited 0 while the catch/stop/rethrow chain was
// still pending. These tests pin the awaited path to referenced handles using
// the real `runDeployment` orchestration shape plus the real tail lifecycle.
describe('smoke failure liveness (ticket #100)', () => {
  // Intercepts `unref()` on timers created while the capture is active so a
  // test can prove which awaited delays stay referenced. Returns the observed
  // unref'd delays plus a restore thunk; callers restore in `finally`.
  function captureUnrefedDelays(): { unrefDelays: number[]; restore: () => void } {
    const unrefDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, delayMs: number) => {
      const timer = originalSetTimeout(callback, delayMs) as unknown as {
        unref: () => unknown;
      };
      const originalUnref = timer.unref.bind(timer);
      timer.unref = () => {
        unrefDelays.push(delayMs);
        originalUnref();
      };
      return timer;
    }) as typeof setTimeout;
    return {
      unrefDelays,
      restore: () => {
        globalThis.setTimeout = originalSetTimeout;
      },
    };
  }

  it('withTimeout keeps its awaited timer referenced until settlement', async () => {
    const capture = captureUnrefedDelays();
    try {
      await expect(
        withTimeout(
          new Promise<string>((resolvePromise) => {
            setTimeout(() => {
              resolvePromise('ok');
            }, 20);
          }),
          5000,
          'liveness probe',
        ),
      ).resolves.toBe('ok');
    } finally {
      capture.restore();
    }
    expect(capture.unrefDelays).toEqual([]);
  });

  it('keeps the awaited tail child and readiness grace referenced until stop()', async () => {
    const STUB_ALIVE = 'setInterval(() => undefined, 50);';
    const capture = captureUnrefedDelays();
    let childUnrefCalls = 0;
    try {
      const handle = await startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
        readyGraceMs: 777,
        startTimeoutMs: 5000,
        stopTimeoutMs: 1000,
        killSettleMs: 500,
        maxDurationMs: 30_000,
        command: process.execPath,
        args: ['-e', STUB_ALIVE],
        spawnFn: (command, args, options) => {
          const child = nodeSpawn(command, args, options);
          const originalUnref = child.unref.bind(child);
          child.unref = () => {
            childUnrefCalls += 1;
            originalUnref();
          };
          return child;
        },
      });
      try {
        // The awaited stop() path loses liveness when the controlled child is
        // unref'd: Node may exit 0 while teardown is still pending.
        expect(childUnrefCalls).toBe(0);
        // The readiness grace is awaited by startup, so unref'ing it lets the
        // same early-exit happen before the smoke even runs. The hard-maximum
        // backstop (30s here) may stay unref'd: it is never awaited and the
        // referenced child keeps the deploy alive until it fires.
        expect(capture.unrefDelays).not.toContain(777);
        expect(capture.unrefDelays).not.toContain(5000);
      } finally {
        await handle.stop();
      }
    } finally {
      capture.restore();
    }
  });

  it('rejects a failed smoke after an asynchronous tail stop with the diagnostic first', async () => {
    const logs: string[] = [];
    let stopped = 0;
    const io: DeployIo = {
      materialize: () => '/tmp/wrangler.tail-liveness.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        logs.push(message);
      },
      startSessionFailureTail: () =>
        Promise.resolve({
          exitedBeforeSmoke: false,
          isLive: () => true,
          peekLines: () => [],
          stop: () => {
            stopped += 1;
            // Teardown is asynchronous in production (SIGTERM grace, stream
            // flush); the deploy must stay alive through it and still reject.
            return new Promise<readonly string[]>((resolvePromise) => {
              setTimeout(() => {
                resolvePromise([
                  JSON.stringify({ event: 'session.resolve-failed', phase: 'session' }),
                ]);
              }, 50);
            });
          },
        }),
    };
    const runner: DeployCommandRunner = (command, args) => {
      if (args.includes('versions') && args.includes('list')) {
        return Promise.resolve({ exitCode: 0, stdout: '[{"version_id":"existing"}]' });
      }
      if (command === 'npm' && args.join(' ').includes('smoke:sandbox')) {
        return Promise.resolve({ exitCode: 1 });
      }
      return Promise.resolve({ exitCode: 0 });
    };
    await expect(runDeployment({ resolved: SANDBOX }, io, runner)).rejects.toThrow(/smoke-sandbox/);
    expect(stopped).toBe(1);
    const transcript = logs.join('\n');
    expect(transcript).toMatch(/sandbox smoke diagnostic/);
    expect(transcript).toMatch(/session/);
    // The failure path rethrows before the success summary: no green
    // `deployed worker=` line may follow a failed smoke.
    expect(transcript).not.toMatch(/deployed worker=/);
  });
});

// Post-failure drain under test (ticket #102): the live tail must stay open for
// a bounded drain window after the smoke client already observed the 500 so the
// asynchronous Cloudflare invocation envelope can arrive. Startup must detect a
// child that exits during the readiness grace and classify it as unavailable
// rather than a live empty tail. All waits stay bounded and referenced.
describe('sandbox diagnostic tail post-failure drain (ticket #102)', () => {
  const COOPERATIVE = 'setInterval(() => undefined, 50);';
  const EXIT_IMMEDIATELY = 'process.exit(1);';
  const DELAYED_EVENT = (delayMs: number, phase = 'session'): string =>
    `setTimeout(() => console.log(JSON.stringify({ event: 'session.resolve-failed', phase: '${phase}' })), ${String(delayMs)}); setInterval(() => undefined, 50);`;

  function failingRunner(): DeployCommandRunner {
    return (command, args) => {
      if (args.includes('versions') && args.includes('list')) {
        return Promise.resolve({ exitCode: 0, stdout: '[{"version_id":"existing"}]' });
      }
      if (command === 'npm' && args.join(' ').includes('smoke:sandbox')) {
        return Promise.resolve({ exitCode: 1 });
      }
      return Promise.resolve({ exitCode: 0 });
    };
  }

  function passingRunner(): DeployCommandRunner {
    return (_command, args) =>
      Promise.resolve({
        exitCode: 0,
        ...(args.includes('versions') && args.includes('list')
          ? { stdout: '[{"version_id":"existing"}]' }
          : {}),
      });
  }

  it('declares a small bounded drain window well inside existing lifecycle bounds', async () => {
    const module = await import('../../scripts/deploy/diagnostic-tail.js');
    expect(Number.isFinite(module.SESSION_FAILURE_TAIL_DRAIN_MS)).toBe(true);
    expect(module.SESSION_FAILURE_TAIL_DRAIN_MS).toBeGreaterThan(0);
    expect(module.SESSION_FAILURE_TAIL_DRAIN_MS).toBeLessThanOrEqual(3000);
    expect(module.SESSION_FAILURE_TAIL_DRAIN_MS).toBeGreaterThanOrEqual(1000);
    expect(module.SESSION_FAILURE_TAIL_DRAIN_POLL_MS).toBeGreaterThan(0);
    expect(module.SESSION_FAILURE_TAIL_DRAIN_POLL_MS).toBeLessThan(
      module.SESSION_FAILURE_TAIL_DRAIN_MS,
    );
    expect(
      module.SESSION_FAILURE_TAIL_DRAIN_MS +
        module.SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS +
        module.SESSION_FAILURE_TAIL_KILL_SETTLE_MS,
    ).toBeLessThan(module.SESSION_FAILURE_TAIL_MAX_DURATION_MS);
  });

  it('detects a child that exits during readiness as unavailable, never a live empty tail', async () => {
    const module = await import('../../scripts/deploy/diagnostic-tail.js');
    const handle = await module.startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      readyGraceMs: 200,
      startTimeoutMs: 5000,
      stopTimeoutMs: 1000,
      killSettleMs: 500,
      maxDurationMs: 30_000,
      command: process.execPath,
      args: ['-e', EXIT_IMMEDIATELY],
    });
    try {
      expect(handle.exitedBeforeSmoke).toBe(true);
      expect(handle.isLive()).toBe(false);
    } finally {
      const lines = await handle.stop();
      expect(Array.isArray(lines)).toBe(true);
    }
  });

  it('marks a live child as ready with incremental peek access', async () => {
    const module = await import('../../scripts/deploy/diagnostic-tail.js');
    const handle = await module.startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      readyGraceMs: 200,
      startTimeoutMs: 5000,
      stopTimeoutMs: 1000,
      killSettleMs: 500,
      maxDurationMs: 30_000,
      command: process.execPath,
      args: ['-e', COOPERATIVE],
    });
    try {
      expect(handle.exitedBeforeSmoke).toBe(false);
      expect(handle.isLive()).toBe(true);
      expect(Array.isArray(handle.peekLines())).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('drains early once the whitelisted event arrives after smoke failure', async () => {
    const module = await import('../../scripts/deploy/diagnostic-tail.js');
    const handle = await module.startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      readyGraceMs: 50,
      startTimeoutMs: 5000,
      stopTimeoutMs: 2000,
      killSettleMs: 500,
      maxDurationMs: 30_000,
      command: process.execPath,
      args: ['-e', DELAYED_EVENT(150, 'auth')],
    });
    const started = Date.now();
    const outcome = await module.drainSessionFailureTail(handle, {
      drainMs: 2000,
      pollMs: 50,
    });
    const waited = Date.now() - started;
    try {
      expect(outcome.observedEvent).toBe(true);
      expect(outcome.lines.join('\n')).toMatch(/auth/);
      expect(module.parseTailLines([...outcome.lines]).map((entry) => entry.phase)).toContain(
        'auth',
      );
      // Early exit: well under the full drain window.
      expect(waited).toBeLessThan(2000);
      expect(outcome.liveThroughDrain).toBe(true);
    } finally {
      // drain helper already stopped the child; second stop stays idempotent.
      await handle.stop();
    }
  });

  it('times out to phase-unavailable when no event arrives but proves liveness', async () => {
    const module = await import('../../scripts/deploy/diagnostic-tail.js');
    const handle = await module.startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
      readyGraceMs: 50,
      startTimeoutMs: 5000,
      stopTimeoutMs: 2000,
      killSettleMs: 500,
      maxDurationMs: 30_000,
      command: process.execPath,
      args: ['-e', COOPERATIVE],
    });
    const outcome = await module.drainSessionFailureTail(handle, {
      drainMs: 300,
      pollMs: 50,
    });
    expect(outcome.observedEvent).toBe(false);
    expect(module.parseTailLines([...outcome.lines])).toEqual([]);
    expect(outcome.liveThroughDrain).toBe(true);
    expect(outcome.drainWaitedMs).toBeGreaterThanOrEqual(200);
    expect(outcome.drainWaitedMs).toBeLessThan(2000);
  });

  it('keeps the drain timer referenced until settlement', async () => {
    const module = await import('../../scripts/deploy/diagnostic-tail.js');
    const unrefDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, delayMs: number) => {
      const timer = originalSetTimeout(callback, delayMs) as unknown as {
        unref: () => unknown;
      };
      const originalUnref = timer.unref.bind(timer);
      timer.unref = () => {
        unrefDelays.push(delayMs);
        originalUnref();
      };
      return timer;
    }) as typeof setTimeout;
    try {
      const handle = await module.startSessionFailureTail(SANDBOX, '/tmp/wrangler.sandbox.json', {
        readyGraceMs: 50,
        startTimeoutMs: 5000,
        stopTimeoutMs: 1000,
        killSettleMs: 500,
        maxDurationMs: 30_000,
        command: process.execPath,
        args: ['-e', COOPERATIVE],
      });
      try {
        await module.drainSessionFailureTail(handle, { drainMs: 321, pollMs: 50 });
      } finally {
        await handle.stop();
      }
      expect(unrefDelays).not.toContain(321);
      expect(unrefDelays).not.toContain(50);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('captures an event that arrives after the smoke process already returned nonzero', async () => {
    const logs: string[] = [];
    let stopped = 0;
    // Fake tail whose event materializes only after the smoke runner resolved:
    // the first peek is empty, the second (during drain) carries the envelope.
    let peeks = 0;
    const io: DeployIo = {
      materialize: () => '/tmp/wrangler.tail-drain.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        logs.push(message);
      },
      startSessionFailureTail: () =>
        Promise.resolve({
          exitedBeforeSmoke: false,
          isLive: () => true,
          peekLines: () => {
            peeks += 1;
            if (peeks === 1) {
              return [];
            }
            return [
              JSON.stringify({
                outcome: 'ok',
                logs: [
                  {
                    message: [JSON.stringify({ event: 'session.resolve-failed', phase: 'config' })],
                  },
                ],
              }),
            ];
          },
          stop: () => {
            stopped += 1;
            return Promise.resolve([
              JSON.stringify({
                outcome: 'ok',
                logs: [
                  {
                    message: [JSON.stringify({ event: 'session.resolve-failed', phase: 'config' })],
                  },
                ],
              }),
            ]);
          },
        }),
    };
    await expect(runDeployment({ resolved: SANDBOX }, io, failingRunner())).rejects.toThrow(
      /smoke-sandbox/,
    );
    expect(stopped).toBe(1);
    expect(logs.join('\n')).toMatch(/phase=config/);
    expect(logs.join('\n')).not.toMatch(/phase unavailable/i);
  });

  it('reports phase unavailable with liveness proof when the drain expires with no event', async () => {
    const logs: string[] = [];
    const io: DeployIo = {
      materialize: () => '/tmp/wrangler.tail-drain-empty.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        logs.push(message);
      },
      startSessionFailureTail: () =>
        Promise.resolve({
          exitedBeforeSmoke: false,
          isLive: () => true,
          peekLines: () => [],
          stop: () => Promise.resolve([]),
        }),
    };
    await expect(runDeployment({ resolved: SANDBOX }, io, failingRunner())).rejects.toThrow(
      /smoke-sandbox/,
    );
    const transcript = logs.join('\n');
    expect(transcript).toMatch(/phase unavailable/i);
    expect(transcript).toMatch(/live through.*drain/i);
    expect(transcript).not.toMatch(/deployed worker=/);
  });

  it('classifies a tail that exited before smoke as unavailable without raw text', async () => {
    const logs: string[] = [];
    let stopped = 0;
    const io: DeployIo = {
      materialize: () => '/tmp/wrangler.tail-exited.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        logs.push(message);
      },
      startSessionFailureTail: () =>
        Promise.resolve({
          exitedBeforeSmoke: true,
          isLive: () => false,
          peekLines: () => [],
          stop: () => {
            stopped += 1;
            return Promise.resolve([]);
          },
        }),
    };
    await expect(runDeployment({ resolved: SANDBOX }, io, failingRunner())).rejects.toThrow(
      /smoke-sandbox/,
    );
    expect(stopped).toBe(1);
    const transcript = logs.join('\n');
    expect(transcript).toMatch(/exited before smoke/i);
    expect(transcript).not.toMatch(/Error: |boom|token|@/i);
  });

  it('does not delay a successful smoke waiting for a failure event', async () => {
    const logs: string[] = [];
    let drainPeeks = 0;
    const io: DeployIo = {
      materialize: () => '/tmp/wrangler.tail-success.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        logs.push(message);
      },
      startSessionFailureTail: () =>
        Promise.resolve({
          exitedBeforeSmoke: false,
          isLive: () => true,
          peekLines: () => {
            drainPeeks += 1;
            return [];
          },
          stop: () => Promise.resolve([]),
        }),
    };
    const started = Date.now();
    await expect(runDeployment({ resolved: SANDBOX }, io, passingRunner())).resolves.toMatchObject({
      workerName: SANDBOX.workerName,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(drainPeeks).toBe(0);
    expect(logs.join('\n')).toMatch(/no session\.resolve-failed event observed/);
  });

  it('never exposes raw tail payloads on the failure path', async () => {
    const logs: string[] = [];
    const io: DeployIo = {
      materialize: () => '/tmp/wrangler.tail-redaction.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        logs.push(message);
      },
      startSessionFailureTail: () =>
        Promise.resolve({
          exitedBeforeSmoke: false,
          isLive: () => true,
          peekLines: () => [],
          stop: () =>
            Promise.resolve([
              JSON.stringify({
                event: 'session.resolve-failed',
                phase: 'session',
                requestId: 'req-drain-1',
                environment: 'sandbox',
                secret: 'must-never-surface',
                cookie: 'better-auth.session_token=abc',
              }),
            ]),
        }),
    };
    await expect(runDeployment({ resolved: SANDBOX }, io, failingRunner())).rejects.toThrow(
      /smoke-sandbox/,
    );
    const transcript = logs.join('\n');
    expect(transcript).toMatch(/phase=session/);
    expect(transcript).not.toMatch(/must-never-surface|better-auth|@/i);
  });
});
