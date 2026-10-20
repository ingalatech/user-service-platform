import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  parseFixCyclePr,
  runFixCycleCorrection,
  FIX_CYCLE_TIMEOUT_MESSAGE,
  FIX_CYCLE_TIMEOUT_SENTINEL,
} from '../../scripts/agent/fix-cycle-correction.js';
import { runAgentTicket, type AgentTicketOutcome } from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';
import {
  buildEvidenceInvocation,
  commandSessionExporter,
  createEvidenceCapture,
  finalizeSkillEvidence,
  isJsonWorkerEventLine,
  persistSkillEvidence,
  primarySessionIdFromLines,
  suppressJsonWorkerLines,
  withJsonFormat,
} from '../../scripts/review/evidence-worker.js';
import { buildSkillEvidence } from '../../scripts/review/skill-evidence.js';
import { buildAddressReviewArgs, buildReviewAxisArgs } from '../../scripts/review/runner.js';
import { buildImplementArgs } from '../../scripts/agent/ticket-flow.js';
import { runWorkerStream, type SpawnedWorker } from '../../scripts/review/worker-stream.js';
import { isWorkerTimeout, WorkerTimeoutError } from '../../scripts/review/worker-timeout.js';

// Seam under test: evidence-capable worker routing (ticket #116).
// Agent worker execution uses the deterministic evidence-capable seam, and
// evidence finalization must never mask the worker outcome.
function toolLine(call: string, session: string): string {
  return JSON.stringify({
    type: 'tool_use',
    timestamp: 1_700_000_000_000,
    sessionID: session,
    part: {
      id: call,
      sessionID: session,
      messageID: 'msg-1',
      type: 'tool',
      tool: 'skill',
      state: {
        status: 'completed',
        input: { name: 'implement' },
        metadata: { name: 'implement', dir: '.agents/skills/implement' },
      },
    },
  });
}

describe('evidence worker invocation shape', () => {
  it('adds --format json additively without --agent or model changes', () => {
    expect(withJsonFormat(['run', '--auto', '--command', 'implement', '10'])).toEqual([
      'run',
      '--auto',
      '--format',
      'json',
      '--command',
      'implement',
      '10',
    ]);
    expect(withJsonFormat(['run', '--format', 'json'])).toEqual(['run', '--format', 'json']);
    expect(withJsonFormat(['run', '--command', 'implement', '10'])).toEqual([
      'run',
      '--command',
      'implement',
      '10',
      '--format',
      'json',
    ]);
    expect(buildAddressReviewArgs(7)).toContain('--format');
    expect(buildAddressReviewArgs(7)).not.toContain('--agent');
    // The shipped builders share the single helper seam, so the flag
    // invariant is protected where the code runs, not only on the helper.
    expect(buildImplementArgs(10)).toEqual(
      withJsonFormat(['run', '--auto', '--command', 'implement', '10']),
    );
    expect(buildReviewAxisArgs('review-standards', 17)).toEqual(
      withJsonFormat(['run', '--auto', '--command', 'review-standards', '17']),
    );
    expect(buildAddressReviewArgs(7)).toEqual(
      withJsonFormat(['run', '--auto', '--command', 'address-review', '7']),
    );
  });

  it('attributes invocations to worker/command/axis/attempt/HEAD with unknown GitHub IDs locally', () => {
    const invocation = buildEvidenceInvocation({
      worker: 'review-cycle',
      command: 'review-standards',
      axis: 'standards',
      attempt: 2,
      workerStartHead: 'a'.repeat(40),
      env: {},
    });

    expect(invocation).toMatchObject({
      worker: 'review-cycle',
      command: 'review-standards',
      axis: 'standards',
      attempt: 2,
      githubRunId: 'unknown',
    });
  });

  it('resolves the primary session from real tool records only', () => {
    expect(primarySessionIdFromLines([toolLine('c1', 'ses-1'), 'not json'])).toBe('ses-1');
    expect(primarySessionIdFromLines(['{"type":"text"}'])).toBeNull();
  });
});

describe('evidence finalization preserves the worker outcome', () => {
  it('persists minimal evidence on success without secrets', async () => {
    const written = new Map<string, string>();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'agent-ticket',
            command: 'implement',
            axis: 'implement',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines: [toolLine('c1', 'ses-1')],
        },
        {
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );

      expect(result.evidencePath).toContain('skill-evidence');
      expect(result.record.events).toHaveLength(1);
      const raw = [...written.values()].join('\n');
      expect(raw).not.toMatch(/sk-ant-|ghp_|OPENCODE_ZEN_API_KEY/);
      expect(raw).not.toContain('Loaded skill');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('records export failures as incomplete coverage, not zero use', async () => {
    const taskLine = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses-1',
      part: {
        id: 'task-1',
        sessionID: 'ses-1',
        messageID: 'msg-2',
        type: 'tool',
        tool: 'task',
        state: { status: 'completed', metadata: { sessionId: 'ses-child' } },
      },
    });
    const result = await finalizeSkillEvidence(
      {
        invocation: buildEvidenceInvocation({
          worker: 'agent-ticket',
          command: 'implement',
          axis: 'implement',
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
          env: {},
        }),
        lines: [taskLine],
        exporter: () => Promise.resolve(null),
      },
      {
        mkdir: () => Promise.resolve(),
        writeFile: () => Promise.resolve(),
      },
    );

    expect(result.record.coverage.status).toBe('incomplete');
    expect(result.record.coverage.reasons.join(' ')).toMatch(/missing export/);
  });
});

describe('fix-cycle correction seam', () => {
  it('documents an explicit local correction utility and local timeout marker', () => {
    const source = readFileSync('scripts/agent/fix-cycle-correction.ts', 'utf8');

    expect(source).toContain('Explicit bounded local fix-cycle correction');
    expect(source).toContain('operator-visible local marker');
    expect(source).not.toContain('Remote `/agent-fix-cycle`');
    expect(source).not.toContain('workflow terminal step');
  });

  it('validates the PR number without side effects', () => {
    expect(parseFixCyclePr('42')).toBe(42);
    expect(() => parseFixCyclePr('0')).toThrow(/PR number/);
    expect(() => parseFixCyclePr(undefined)).toThrow(/PR number/);
  });

  it('routes the correction through the evidence-capable worker args', async () => {
    const seen: { command: string; args: readonly string[] }[] = [];
    const finalized: string[] = [];
    const result = await runFixCycleCorrection('42', {
      runWorker: (command, args) => {
        seen.push({ command, args: [...args] });
        return Promise.resolve();
      },
      finalizeEvidence: (input) => {
        finalized.push(`${input.worker}/${input.command}/${input.axis}/${String(input.attempt)}`);
        return Promise.resolve('.agent-ticket/skill-evidence/address-review-1.json');
      },
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(0);
    expect(result.evidencePath).toContain('skill-evidence');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe('opencode');
    expect(seen[0]?.args).toEqual(buildAddressReviewArgs(42));
    expect(finalized).toEqual(['agent-fix-cycle/address-review/address-review/1']);
  });

  it('keeps a distinct timeout with the sentinel while preserving evidence', async () => {
    const { WorkerTimeoutError } = await import('../../scripts/review/worker-timeout.js');
    const written = new Map<string, string>();
    const result = await runFixCycleCorrection('42', {
      runWorker: () => {
        return Promise.reject(new WorkerTimeoutError('address-review', 1_200_000, 'opencode'));
      },
      finalizeEvidence: () => Promise.resolve(undefined),
      writeSentinel: (path, contents) => {
        written.set(path, contents);
        return Promise.resolve();
      },
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(written.get(FIX_CYCLE_TIMEOUT_SENTINEL)).toBe(FIX_CYCLE_TIMEOUT_MESSAGE);
  });

  it('never lets evidence failure mask a correction failure', async () => {
    const result = await runFixCycleCorrection('42', {
      runWorker: () => Promise.reject(new Error('model blew up')),
      finalizeEvidence: () => Promise.reject(new Error('disk gone')),
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBeUndefined();
    expect(result.reason).toMatch(/model blew up/);
  });
});

describe('ticket implement evidence pointer', () => {
  const MAIN_HEAD = 'a'.repeat(40);
  const NEXT_HEAD = 'b'.repeat(40);
  const ISSUE_VIEW = JSON.stringify({
    number: 10,
    title: 'Register and verify an email identity',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
  });

  function evidenceScript(): Record<string, unknown> {
    return {
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
      'gh issue view 10 --json number,title,state,labels': `${ISSUE_VIEW}\n`,
      'git show-ref --verify refs/heads/ticket/10-register-and-verify-an-email-identity': new Error(
        "fatal: 'refs/heads/ticket/10-register-and-verify-an-email-identity' - not a valid ref",
      ),
      'git checkout -b ticket/10-register-and-verify-an-email-identity': '',
      'npm run lint': '',
      'npm run format:check': '',
      'npm run typecheck': '',
      'npm run openapi:check': '',
      'npm run test': '',
      'npm run test:harness': '',
      [`git diff --name-only ${MAIN_HEAD}...${NEXT_HEAD} -- .github/workflows/`]: '',
      'git push -u origin ticket/10-register-and-verify-an-email-identity': '',
      'gh pr create --base main --head ticket/10-register-and-verify-an-email-identity --draft --title Register and verify an email identity (#10) --body Automated implementation of #10 via `npm run agent:ticket`.':
        'https://github.com/o/r/pull/42\n',
      'gh pr view --json number,headRefName,baseRefName,headRefOid,url':
        '{"number":42,"headRefName":"ticket/10-register-and-verify-an-email-identity","baseRefName":"main","headRefOid":"bbb","url":"https://github.com/o/r/pull/42"}\n',
    };
  }

  function evidenceDeps(script: Record<string, unknown>, implementStdout: string) {
    let headCalls = 0;
    const finalized: { command: string; axis: string; lines: number }[] = [];
    const outcomes: AgentTicketOutcome[] = [];
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      if (command === 'gh' && args[0] === 'repo') {
        return Promise.resolve({ stdout: 'o/r\n', stderr: '' });
      }
      if (command === 'gh' && args[0] === 'api') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      const key = `${command} ${args.join(' ')}`;
      const scripted = script[key];
      if (scripted instanceof Error) {
        return Promise.reject(scripted);
      }
      if (typeof scripted === 'string') {
        return Promise.resolve({ stdout: scripted, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
    return {
      finalized,
      outcomes,
      execute,
      runWorker: (command: string, args: readonly string[]) => {
        const key = `worker ${command} ${args.join(' ')}`;
        if (key.startsWith('worker opencode run --auto --format json --command implement')) {
          return Promise.resolve({ stdout: implementStdout, stderr: '' });
        }
        if (key === 'worker npm run review:cycle') {
          return Promise.resolve({
            stdout: 'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
            stderr: '',
          });
        }
        throw new Error(`unexpected worker in test script: ${key}`);
      },
      finalizeEvidence: (input: { command: string; axis: string; lines: readonly string[] }) => {
        finalized.push({ command: input.command, axis: input.axis, lines: input.lines.length });
        return Promise.resolve('.agent-ticket/skill-evidence/implement-implement-1.json');
      },
      recordOutcome: (record: AgentTicketOutcome) => {
        outcomes.push(record);
      },
    };
  }

  it('finalizes implement evidence and points the outcome record at it', async () => {
    const implementStdout = `${toolLine('c1', 'ses-1')}\n`;
    const deps = evidenceDeps(evidenceScript(), implementStdout);

    const result = await runAgentTicket('10', deps);

    expect(result.exitCode).toBe(0);
    expect(deps.finalized).toEqual([{ command: 'implement', axis: 'implement', lines: 2 }]);
    expect(deps.outcomes.at(-1)).toMatchObject({
      outcome: 'READY',
      skillEvidencePath: '.agent-ticket/skill-evidence/implement-implement-1.json',
    });
  });

  it('finalizes evidence on implement failure without masking the outcome', async () => {
    const implementStdout = '';
    const deps = evidenceDeps(evidenceScript(), implementStdout);
    const failing = {
      ...deps,
      runWorker: () => Promise.reject(new Error('boom')),
    };

    const result = await runAgentTicket('10', failing);

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('implement');
    expect(deps.finalized).toEqual([{ command: 'implement', axis: 'implement', lines: 0 }]);
    expect(deps.outcomes.at(-1)).toMatchObject({
      outcome: 'BLOCKED',
      skillEvidencePath: '.agent-ticket/skill-evidence/implement-implement-1.json',
    });
  });
});

describe('evidence-enabled worker diagnostics', () => {
  it('classifies structured worker event lines for log suppression', () => {
    expect(isJsonWorkerEventLine(toolLine('c1', 'ses-1'))).toBe(true);
    expect(isJsonWorkerEventLine(JSON.stringify({ type: 'text', part: { text: 'hi' } }))).toBe(
      true,
    );
    expect(isJsonWorkerEventLine(JSON.stringify({ type: 'reasoning', part: {} }))).toBe(true);
    expect(isJsonWorkerEventLine('plain progress line')).toBe(false);
    expect(isJsonWorkerEventLine('')).toBe(false);
    expect(suppressJsonWorkerLines(toolLine('c1', 'ses-1'))).toBe(false);
    expect(suppressJsonWorkerLines('plain progress line')).toBe(true);
  });

  it('captures raw JSON through the spawned stream without logging payloads', async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as SpawnedWorker;
    child.stdout = stdout;
    child.stderr = stderr;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const seen: string[] = [];
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto', '--format', 'json'],
        { label: 'implement', stdoutLogFilter: suppressJsonWorkerLines },
        () => child,
        {
          onStdoutLine: (line) => {
            seen.push(line);
          },
        },
      );
      const sentinelTool = toolLine('c-sentinel', 'ses-1').replace(
        '"name":"implement"',
        '"name":"implement","debug":"sk-ant-testsecret"',
      );
      stdout.emit('data', `${sentinelTool}\nplain progress\n`);
      child.emit('close', 0);
      const result = await pending;

      // Both lines are captured for evidence, but the raw JSON payload —
      // including tool arguments — never reaches the console.
      expect(seen).toHaveLength(2);
      expect(result.stdout).toContain('plain progress');
      expect(result.stdout).toContain('c-sentinel');
      expect(logSpy).toHaveBeenCalledWith('[implement] started: opencode run --auto --format json');
      expect(logSpy).toHaveBeenCalledWith('[implement] plain progress');
      expect(logSpy).toHaveBeenCalledWith('[implement] completed (exit 0)');
      const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain('sk-ant-testsecret');
      expect(logged).not.toContain('c-sentinel');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('propagates capture truncation through finalization to the persisted artifact', async () => {
    const capture = createEvidenceCapture();
    capture.pushLine(toolLine('c0', 'ses-1'));
    capture.pushLine(`${toolLine('c1', 'ses-1')} ${'x'.repeat(70_000)}`);
    expect(capture.wasTruncated()).toBe(true);

    const written = new Map<string, string>();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'review-cycle',
            command: 'review-standards',
            axis: 'standards',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines: capture.lines,
          truncatedStream: capture.wasTruncated(),
        },
        {
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );

      expect(result.record.coverage.status).toBe('incomplete');
      expect(result.record.coverage.reasons.join(' ')).toMatch(/truncated/);
      // The overlong line was sliced, so it no longer parses — but the bound
      // itself is reported honestly instead of claiming completeness.
      expect(result.evidencePath).toContain('review-cycle-review-standards-standards-1.json');
      const persisted = [...written.values()].join('\n');
      expect(persisted).toContain('"status": "incomplete"');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports the primary-stream bound once through capture -> finalizer -> artifact', async () => {
    const lines = Array.from({ length: 600 }, (_, index) =>
      toolLine(`c-bound-${String(index)}`, 'ses-1'),
    );
    const capture = createEvidenceCapture();
    for (const line of lines) {
      capture.pushLine(line);
    }
    expect(capture.wasTruncated()).toBe(false);

    const written = new Map<string, string>();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'agent-ticket',
            command: 'implement',
            axis: 'implement',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines: capture.lines,
          truncatedStream: capture.wasTruncated(),
        },
        {
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );

      expect(result.record.coverage.status).toBe('incomplete');
      const boundReasons = result.record.coverage.reasons.filter(
        (reason) => reason === 'primary stream truncated at bound',
      );
      expect(boundReasons).toHaveLength(1);
      const persisted = written.get(result.evidencePath ?? '') ?? [...written.values()].join('\n');
      expect(persisted).toContain('primary stream truncated at bound');
      const persistedCount = persisted.split('primary stream truncated at bound').length - 1;
      expect(persistedCount).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keeps separate correction invocations in distinct artifacts', async () => {
    const written = new Map<string, string>();
    const deps = {
      mkdir: () => Promise.resolve(),
      writeFile: (path: string, contents: string) => {
        written.set(path, contents);
        return Promise.resolve();
      },
    };
    const first = await persistSkillEvidence(
      buildSkillEvidence({
        invocation: buildEvidenceInvocation({
          worker: 'agent-fix-cycle',
          command: 'address-review',
          axis: 'address-review',
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
          env: {},
        }),
        primaryLines: [toolLine('c1', 'ses-1')],
        primarySessionId: 'ses-1',
        childExports: {},
      }),
      deps,
    );
    const second = await persistSkillEvidence(
      buildSkillEvidence({
        invocation: buildEvidenceInvocation({
          worker: 'review-cycle',
          command: 'address-review',
          axis: 'address-review',
          attempt: 1,
          workerStartHead: 'b'.repeat(40),
          env: {},
        }),
        primaryLines: [toolLine('c2', 'ses-2')],
        primarySessionId: 'ses-2',
        childExports: {},
      }),
      deps,
    );

    expect(first.evidencePath).not.toBe(second.evidencePath);
    expect(written.has(first.evidencePath)).toBe(true);
    expect(written.has(second.evidencePath)).toBe(true);
    expect(written.get(first.evidencePath)).toContain('c1');
    expect(written.get(second.evidencePath)).toContain('c2');
  });
});

describe('bounded session export seam', () => {
  it('treats a hung export as an honest failure and cleans up', async () => {
    const exporter = commandSessionExporter(() => new Promise<never>(() => undefined), {
      timeoutMs: 20,
    });

    const started = Date.now();
    const result = await exporter('ses-hung');
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('bounds oversized export output before parsing', async () => {
    const oversized = `${JSON.stringify({ info: { id: 'ses-big' }, messages: [] })}${' '.repeat(100)}`;
    const exporter = commandSessionExporter(
      () => Promise.resolve({ stdout: oversized, stderr: '' }),
      { maxBytes: 10 },
    );

    expect(await exporter('ses-big')).toBeNull();
  });

  it('still exports small bounded payloads', async () => {
    const payload = JSON.stringify({ info: { id: 'ses-1' }, messages: [] });
    const exporter = commandSessionExporter(() => Promise.resolve({ stdout: payload, stderr: '' }));

    expect(await exporter('ses-1')).toEqual({ info: { id: 'ses-1' }, messages: [] });
  });
});

describe('implement error finalization keeps observed evidence', () => {
  it('finalizes partial stdout attached to a worker failure without masking it', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const MAIN_HEAD = 'a'.repeat(40);
    const ISSUE_VIEW = JSON.stringify({
      number: 10,
      title: 'Register and verify an email identity',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
    });
    const script: Record<string, unknown> = {
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
      'gh issue view 10 --json number,title,state,labels': `${ISSUE_VIEW}\n`,
      'git show-ref --verify refs/heads/ticket/10-register-and-verify-an-email-identity': new Error(
        "fatal: 'refs/heads/ticket/10-register-and-verify-an-email-identity' - not a valid ref",
      ),
      'git checkout -b ticket/10-register-and-verify-an-email-identity': '',
    };
    const execute: CommandExecutor = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      const scripted = script[key];
      if (scripted instanceof Error) {
        return Promise.reject(scripted);
      }
      if (typeof scripted === 'string') {
        return Promise.resolve({ stdout: scripted, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
    const finalized: { lines: readonly string[] }[] = [];
    const failing = Object.assign(new Error('boom'), { stdout: `${toolLine('c1', 'ses-1')}\n` });
    const result = await runAgentTicket('10', {
      execute,
      runWorker: () => Promise.reject(failing),
      finalizeEvidence: (input) => {
        finalized.push({ lines: input.lines });
        return Promise.resolve(undefined);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('implement');
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.lines.join('\n')).toContain('c1');
  });
});

describe('persisted lifecycle diagnostics', () => {
  it('distinguishes no captured stdout from protocol progress without tool calls', async () => {
    const persist = async (lines: readonly string[]) => {
      const written = new Map<string, string>();
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'review-cycle',
            command: 'review-standards',
            axis: 'standards',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines,
        },
        {
          dir: '.test-evidence',
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
          now: () => '2026-10-12T00:00:00.000Z',
        },
      );
      const persisted = JSON.parse(
        written.get(result.evidencePath ?? '.test-evidence/missing') ?? '{}',
      ) as Record<string, unknown>;
      return { result, persisted };
    };

    const silent = await persist([]);
    const blank = await persist(['   ']);
    const progress = await persist([
      JSON.stringify({
        type: 'step_start',
        sessionID: 'synthetic-session',
        timestamp: 1_700_000_000_000,
        text: 'sk-ant-secret-sentinel-must-not-persist',
        input: { email: 'private@example.test', token: 'ghp_secret-sentinel' },
      }),
    ]);

    expect(silent.result.record.events).toEqual([]);
    expect(silent.result.record.lifecycle).toMatchObject({
      capturedLineCount: 0,
      eventCounts: {},
      toolCounts: {},
      status: 'unavailable',
    });
    expect(blank.result.record.lifecycle).toMatchObject({
      capturedLineCount: 1,
      eventCounts: {},
      status: 'incomplete',
      reasons: ['no recognized worker events captured'],
    });
    expect(progress.result.record.events).toEqual([]);
    expect(progress.result.record.coverage.primarySessionId).toBeNull();
    expect(progress.result.record.lifecycle).toMatchObject({
      capturedLineCount: 1,
      eventCounts: { step_start: 1 },
      toolCounts: {},
      firstTimestamp: new Date(1_700_000_000_000).toISOString(),
      lastTimestamp: new Date(1_700_000_000_000).toISOString(),
      durationMs: 0,
      status: 'complete',
    });
    expect(JSON.stringify(silent.persisted)).toContain('"lifecycle"');
    expect(JSON.stringify(progress.persisted)).not.toMatch(
      /sk-ant-secret-sentinel|ghp_secret-sentinel|private@example\.test|synthetic-session/,
    );
  });

  it('marks bounded or malformed lifecycle capture honestly', async () => {
    const result = await finalizeSkillEvidence(
      {
        invocation: buildEvidenceInvocation({
          worker: 'agent-fix-cycle',
          command: 'address-review',
          axis: 'address-review',
          attempt: 1,
          workerStartHead: 'b'.repeat(40),
          env: {},
        }),
        lines: [
          'not-json',
          JSON.stringify({
            type: 'unsupported_event',
            timestamp: 'not-a-timestamp',
            payload: 'raw-field-must-not-persist',
          }),
        ],
        truncatedStream: true,
      },
      {
        dir: '.test-evidence',
        mkdir: () => Promise.resolve(),
        writeFile: () => Promise.resolve(),
      },
    );

    expect(result.record.lifecycle).toMatchObject({
      capturedLineCount: 2,
      malformed: 1,
      unknownEvents: 1,
      firstTimestamp: null,
      lastTimestamp: null,
      durationMs: null,
      captureTruncated: true,
      status: 'incomplete',
    });
    expect(JSON.stringify(result.record.lifecycle)).not.toContain('not-json');
    expect(JSON.stringify(result.record.lifecycle)).not.toContain('unsupported_event');
    expect(JSON.stringify(result.record.lifecycle)).not.toContain('raw-field-must-not-persist');
  });

  it('rejects out-of-range timestamps before accumulation at the persistence seam', async () => {
    const written = new Map<string, string>();
    const result = await finalizeSkillEvidence(
      {
        invocation: buildEvidenceInvocation({
          worker: 'review-cycle',
          command: 'review-standards',
          axis: 'standards',
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
          env: {},
        }),
        lines: [
          JSON.stringify({ type: 'step_start', timestamp: 1_700_000_000_000 }),
          JSON.stringify({ type: 'step_finish', timestamp: 1e100 }),
          JSON.stringify({ type: 'step_finish', timestamp: 1_700_000_001_000 }),
        ],
      },
      {
        dir: '.test-evidence',
        mkdir: () => Promise.resolve(),
        writeFile: (path: string, contents: string) => {
          written.set(path, contents);
          return Promise.resolve();
        },
      },
    );

    expect(result.record.lifecycle).toMatchObject({
      capturedLineCount: 3,
      eventCounts: { step_start: 1, step_finish: 2 },
      firstTimestamp: new Date(1_700_000_000_000).toISOString(),
      lastTimestamp: new Date(1_700_000_001_000).toISOString(),
      durationMs: 1000,
      status: 'incomplete',
    });
    expect(result.record.lifecycle?.reasons.join(' ')).toMatch(/invalid worker timestamps/);
    const persisted = JSON.parse(
      written.get(result.evidencePath ?? '.test-evidence/missing') ?? '{}',
    ) as { lifecycle?: { lastTimestamp?: string | null; durationMs?: number | null } };
    expect(persisted.lifecycle?.lastTimestamp).toBe(new Date(1_700_000_001_000).toISOString());
    expect(persisted.lifecycle?.durationMs).toBe(1000);
  });

  it('keeps attributable tool evidence when its timestamp is out of range', async () => {
    const invalidToolLine = JSON.stringify({
      type: 'tool_use',
      timestamp: 1e100,
      sessionID: 'ses-1',
      part: {
        id: 'c1',
        sessionID: 'ses-1',
        messageID: 'msg-1',
        type: 'tool',
        tool: 'skill',
        state: {
          status: 'completed',
          input: { name: 'implement' },
          metadata: { name: 'implement', dir: '.agents/skills/implement' },
        },
      },
    });
    const written = new Map<string, string>();
    const result = await finalizeSkillEvidence(
      {
        invocation: buildEvidenceInvocation({
          worker: 'agent-ticket',
          command: 'implement',
          axis: 'implement',
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
          env: {},
        }),
        lines: [invalidToolLine],
      },
      {
        dir: '.test-evidence',
        mkdir: () => Promise.resolve(),
        writeFile: (path: string, contents: string) => {
          written.set(path, contents);
          return Promise.resolve();
        },
      },
    );

    expect(result.record.events).toHaveLength(1);
    expect(result.record.events[0]?.timestamp).toBeNull();
    expect(result.record.lifecycle?.eventCounts).toMatchObject({ tool_use: 1 });
    expect(result.record.lifecycle?.reasons.join(' ')).toMatch(/invalid worker timestamps/);
    expect(written.size).toBeGreaterThan(0);
  });
});

describe('real subprocess lifecycle regression (ticket #135)', () => {
  const SILENT_CHILD = 'setInterval(() => undefined, 50);';
  const PROGRESS_CHILD = `console.log(JSON.stringify({type:'step_start',sessionID:'synthetic-fixture',timestamp:1700000000000})); setInterval(() => undefined, 50);`;

  async function runControlledChild(script: string): Promise<{
    lines: string[];
    timeout: unknown;
  }> {
    const capture = createEvidenceCapture();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        process.execPath,
        ['-e', script],
        {
          label: 'lifecycle-fixture',
          timeoutMs: 500,
          killGraceMs: 500,
          groupPollMs: 20,
          stdoutLogFilter: suppressJsonWorkerLines,
        },
        undefined,
        {
          onStdoutLine: (line) => {
            capture.pushLine(line);
          },
        },
      );
      const timeout = await pending.then(
        () => null,
        (error: unknown) => error,
      );
      return { lines: [...capture.lines], timeout };
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }

  async function finalizeToMemory(lines: readonly string[]) {
    const written = new Map<string, string>();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'review-cycle',
            command: 'review-standards',
            axis: 'standards',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines,
        },
        {
          dir: '.test-evidence',
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );
      const persisted = JSON.parse(
        written.get(result.evidencePath ?? '.test-evidence/missing') ?? '{}',
      ) as Record<string, unknown>;
      return { result, persisted };
    } finally {
      logSpy.mockRestore();
    }
  }

  it('distinguishes silent and progress-only streams with bounded TIMEOUT', async () => {
    const silent = await runControlledChild(SILENT_CHILD);
    const progress = await runControlledChild(PROGRESS_CHILD);

    expect(isWorkerTimeout(silent.timeout)).toBe(true);
    expect(isWorkerTimeout(progress.timeout)).toBe(true);
    expect(silent.timeout).toMatchObject({ terminated: true });
    expect(progress.timeout).toMatchObject({ terminated: true });

    const silentFinal = await finalizeToMemory(silent.lines);
    const progressFinal = await finalizeToMemory(progress.lines);

    expect(silentFinal.result.record.lifecycle).toMatchObject({
      capturedLineCount: 0,
      eventCounts: {},
      status: 'unavailable',
    });
    expect(progressFinal.result.record.lifecycle).toMatchObject({
      capturedLineCount: 1,
      eventCounts: { step_start: 1 },
      firstTimestamp: new Date(1_700_000_000_000).toISOString(),
      status: 'complete',
    });
    expect(progressFinal.result.record.events).toEqual([]);
    expect(JSON.stringify(silentFinal.persisted)).toContain('"lifecycle"');
    expect(JSON.stringify(progressFinal.persisted)).toContain('"step_start"');
    expect(JSON.stringify(silentFinal.persisted.lifecycle)).not.toBe(
      JSON.stringify(progressFinal.persisted.lifecycle),
    );
  }, 15000);
});

describe('lifecycle persistence at real call sites', () => {
  const PROGRESS_LINE = JSON.stringify({
    type: 'step_start',
    sessionID: 'synthetic-fixture',
    timestamp: 1_700_000_000_000,
  });

  function realFinalizer(written: Map<string, string>) {
    return async (input: {
      worker: 'agent-fix-cycle';
      command: string;
      axis: string;
      attempt: number;
      workerStartHead: string;
      lines: readonly string[];
      truncatedStream?: boolean;
    }): Promise<string | undefined> => {
      const { finalizeSkillEvidence: finalize, buildEvidenceInvocation: buildInvocation } =
        await import('../../scripts/review/evidence-worker.js');
      const result = await finalize(
        {
          invocation: buildInvocation({
            worker: input.worker,
            command: input.command,
            axis: input.axis,
            attempt: input.attempt,
            workerStartHead: input.workerStartHead,
            env: {},
          }),
          lines: input.lines,
          ...(input.truncatedStream === undefined
            ? {}
            : { truncatedStream: input.truncatedStream }),
        },
        {
          dir: '.test-evidence',
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );
      return result.evidencePath;
    };
  }

  it('persists lifecycle on fix-cycle success through the real finalizer', async () => {
    const written = new Map<string, string>();
    const result = await runFixCycleCorrection('42', {
      runWorker: (_command, _args, onLine) => {
        onLine(PROGRESS_LINE);
        return Promise.resolve();
      },
      finalizeEvidence: realFinalizer(written),
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(0);
    expect(result.evidencePath).toContain('agent-fix-cycle-address-review');
    const persisted = JSON.parse([...written.values()].at(0) ?? '{}') as {
      lifecycle?: Record<string, unknown>;
    };
    expect(persisted.lifecycle).toMatchObject({ eventCounts: { step_start: 1 } });
  });

  it('persists lifecycle on fix-cycle failure without masking the outcome', async () => {
    const written = new Map<string, string>();
    const result = await runFixCycleCorrection('42', {
      runWorker: (_command, _args, onLine) => {
        onLine(PROGRESS_LINE);
        return Promise.reject(new Error('boom'));
      },
      finalizeEvidence: realFinalizer(written),
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toMatch(/boom/);
    expect(result.evidencePath).toContain('agent-fix-cycle-address-review');
    const persisted = JSON.parse([...written.values()].at(0) ?? '{}') as {
      lifecycle?: Record<string, unknown>;
    };
    expect(persisted.lifecycle).toMatchObject({ eventCounts: { step_start: 1 } });
  });

  it('persists lifecycle on fix-cycle timeout with bounded termination', async () => {
    const written = new Map<string, string>();
    const sentinels = new Map<string, string>();
    const result = await runFixCycleCorrection('42', {
      runWorker: (_command, _args, onLine) => {
        onLine(PROGRESS_LINE);
        return Promise.reject(new WorkerTimeoutError('address-review', 500, 'opencode', true));
      },
      finalizeEvidence: realFinalizer(written),
      writeSentinel: (path, contents) => {
        sentinels.set(path, contents);
        return Promise.resolve();
      },
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(sentinels.get(FIX_CYCLE_TIMEOUT_SENTINEL)).toBe(FIX_CYCLE_TIMEOUT_MESSAGE);
    const persisted = JSON.parse([...written.values()].at(0) ?? '{}') as {
      lifecycle?: Record<string, unknown>;
    };
    expect(persisted.lifecycle).toMatchObject({ eventCounts: { step_start: 1 } });
  });

  it('persists lifecycle for review invocations through the shared finalizer', async () => {
    const cases = [
      { worker: 'review-cycle', command: 'review-standards', axis: 'standards' },
      { worker: 'review-cycle', command: 'review-spec', axis: 'spec' },
      { worker: 'review-cycle', command: 'address-review', axis: 'address-review' },
    ] as const;
    for (const invocation of cases) {
      const written = new Map<string, string>();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const result = await finalizeSkillEvidence(
          {
            invocation: buildEvidenceInvocation({
              ...invocation,
              attempt: 1,
              workerStartHead: 'a'.repeat(40),
              env: {},
            }),
            lines: [PROGRESS_LINE],
          },
          {
            dir: '.test-evidence',
            mkdir: () => Promise.resolve(),
            writeFile: (path: string, contents: string) => {
              written.set(path, contents);
              return Promise.resolve();
            },
          },
        );
        expect(result.evidencePath).toContain('.test-evidence');
        const persisted = JSON.parse(written.get(result.evidencePath ?? '') ?? '{}') as {
          lifecycle?: Record<string, unknown>;
        };
        expect(persisted.lifecycle).toMatchObject({ eventCounts: { step_start: 1 } });
      } finally {
        logSpy.mockRestore();
      }
    }
  });
});
