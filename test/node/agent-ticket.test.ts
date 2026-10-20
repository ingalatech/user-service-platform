import { describe, expect, it, vi } from 'vitest';
import { checkSafePush } from '../../scripts/review/safe-push.js';
import {
  buildImplementArgs,
  buildPrCreateArgs,
  buildReviewCycleArgs,
  checkInitialPush,
  checkMainCurrency,
  checkStartState,
  checkTicketIssue,
  extractSummaryPath,
  formatPrBody,
  formatPrTitle,
  getRemoteMainHead,
  parseIssueView,
  parseTicketArg,
  runAgentTicket,
  slugifyTitle,
  ticketBranchName,
  type AgentTicketDeps,
} from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';

// Seam under test: deterministic ticket orchestration (ticket #23).
// `npm run agent:ticket -- <issue>` must drive branch creation ->
// `/implement` -> gates -> safe push -> draft PR -> `review:cycle` without
// manual handoffs, reusing the existing safe-push guards, gate list and
// review:cycle run evidence instead of reimplementing them. Long-running
// workers (`/implement`, `review:cycle`) run headlessly via
// `opencode run --auto --command ...` with no `--agent` flag: each command's
// frontmatter remains the source of truth for its model.
describe('agent:ticket state validation', () => {
  it('parses a plain issue number', () => {
    expect(parseTicketArg('10')).toBe(10);
  });

  it.each([undefined, '', '  ', 'abc', '0', '-3', '10.5', '10extra', '#10'])(
    'refuses an invalid ticket argument %s',
    (raw) => {
      expect(() => parseTicketArg(raw)).toThrow(/ticket/i);
    },
  );

  it('requires starting from a clean main worktree', () => {
    expect(checkStartState({ currentBranch: 'main', worktreeClean: true }).ok).toBe(true);
  });

  it('refuses to start from a ticket branch', () => {
    const result = checkStartState({ currentBranch: 'ticket/10-x', worktreeClean: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/main/i);
    }
  });

  it('refuses to start with uncommitted changes', () => {
    const result = checkStartState({ currentBranch: 'main', worktreeClean: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/clean/i);
    }
  });

  it('derives a deterministic ticket branch from the issue title', () => {
    expect(ticketBranchName(10, 'Register and verify an email identity')).toBe(
      'ticket/10-register-and-verify-an-email-identity',
    );
  });

  it('keeps generated branch names inside the safe-push ticket convention', () => {
    const branch = ticketBranchName(23, 'Automate ticket implementation through review-ready PR!');

    expect(checkSafePush).toBeDefined();
    expect(branch.startsWith('ticket/23-')).toBe(true);
  });

  it('slugifies titles without leaking unsafe characters', () => {
    expect(slugifyTitle('Register & verify: an email identity?!')).toBe(
      'register-verify-an-email-identity',
    );
    expect(slugifyTitle('')).toBe('ticket');
  });
});

describe('agent:ticket command construction', () => {
  it('runs /implement headlessly without --agent (frontmatter owns the model)', () => {
    expect(buildImplementArgs(10)).toEqual([
      'run',
      '--auto',
      '--format',
      'json',
      '--command',
      'implement',
      '10',
    ]);
    expect(buildImplementArgs(10)).not.toContain('--agent');
  });

  it('invokes the existing review:cycle without duplicating its flags', () => {
    expect(buildReviewCycleArgs()).toEqual(['run', 'review:cycle']);
  });

  it('creates a draft PR against main that references the ticket', () => {
    const args = buildPrCreateArgs({
      branch: 'ticket/10-register-and-verify-an-email-identity',
      title: 'Register and verify an email identity',
      ticket: 10,
    });

    expect(args).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'ticket/10-register-and-verify-an-email-identity',
      '--draft',
      '--title',
      'Register and verify an email identity (#10)',
      '--body',
      formatPrBody(10),
    ]);
    expect(formatPrBody(10)).toContain('#10');
  });

  it('formats PR titles deterministically from the issue title', () => {
    expect(formatPrTitle('Register and verify an email identity', 10)).toBe(
      'Register and verify an email identity (#10)',
    );
  });

  it('only accepts OPEN ready-for-agent tickets', () => {
    const ready = checkTicketIssue(
      parseIssueView(
        JSON.stringify({
          number: 10,
          title: 'Register and verify an email identity',
          state: 'OPEN',
          labels: [{ name: 'ready-for-agent' }],
        }),
      ),
    );

    expect(ready.ok).toBe(true);
  });

  it('refuses closed tickets', () => {
    const result = checkTicketIssue({
      number: 10,
      title: 'Register and verify an email identity',
      state: 'CLOSED',
      labels: ['ready-for-agent'],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses tickets missing the ready-for-agent label', () => {
    const result = checkTicketIssue({
      number: 10,
      title: 'Register and verify an email identity',
      state: 'OPEN',
      labels: ['needs-triage'],
    });

    expect(result.ok).toBe(false);
  });

  it('surfaces the review:cycle run-summary path from worker output', () => {
    expect(
      extractSummaryPath('READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n'),
    ).toBe('.review-cycle/latest.json');
    expect(extractSummaryPath('no summary here')).toBeUndefined();
  });
});

describe('agent:ticket branch and push safety', () => {
  it('allows the initial push for a clean ticket branch targeting main', () => {
    expect(
      checkInitialPush({ currentBranch: 'ticket/10-register-and-verify', worktreeClean: true }).ok,
    ).toBe(true);
  });

  it('refuses the initial push from main itself', () => {
    const result = checkInitialPush({ currentBranch: 'main', worktreeClean: true });

    expect(result.ok).toBe(false);
  });

  it('refuses the initial push for non-ticket branches', () => {
    const result = checkInitialPush({
      currentBranch: 'experiment/quick-hack',
      worktreeClean: true,
    });

    expect(result.ok).toBe(false);
  });

  it('refuses the initial push with uncommitted changes', () => {
    const result = checkInitialPush({
      currentBranch: 'ticket/10-register-and-verify',
      worktreeClean: false,
    });

    expect(result.ok).toBe(false);
  });
});

interface ScriptedCall {
  command: string;
  args: readonly string[];
}

function scriptedDeps(script: Record<string, unknown>, overrides: Partial<AgentTicketDeps> = {}) {
  const calls: ScriptedCall[] = [];
  const execute: CommandExecutor = (command, args) => {
    calls.push({ command, args: [...args] });
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
  const workerCalls: { command: string; args: readonly string[]; label: string }[] = [];
  const runWorker: NonNullable<AgentTicketDeps['runWorker']> = (command, args, label) => {
    workerCalls.push({ command, args: [...args], label });
    const key = `worker ${command} ${args.join(' ')}`;
    const scripted = script[key];
    if (scripted instanceof Error) {
      return Promise.reject(scripted);
    }
    if (typeof scripted === 'string') {
      return Promise.resolve({ stdout: scripted, stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { calls, workerCalls, execute, runWorker, overrides };
}

const ISSUE_VIEW = JSON.stringify({
  number: 10,
  title: 'Register and verify an email identity',
  state: 'OPEN',
  labels: [{ name: 'ready-for-agent' }],
});

const MAIN_HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

function successScript(): Record<string, unknown> {
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
    'worker opencode run --auto --format json --command implement 10': '',
    'worker npm run review:cycle':
      'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
  };
}

describe('agent:ticket success orchestration', () => {
  it('drives branch -> implement -> gates -> push -> draft PR -> review:cycle', async () => {
    const script = successScript();
    // /implement lands exactly one local commit on the new branch.
    let headCalls = 0;
    const fixture = scriptedDeps(script);
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };

    const result = await runAgentTicket('10', {
      execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(0);
    expect(result.branch).toBe('ticket/10-register-and-verify-an-email-identity');
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe('https://github.com/o/r/pull/42');
    expect(result.summaryPath).toBe('.review-cycle/latest.json');

    const chronological: string[] = [];
    const orderedHeads: string[] = [];
    const orderedExecute: CommandExecutor = (command, args) => {
      chronological.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        orderedHeads.push('x');
        return Promise.resolve({
          stdout: orderedHeads.length === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };
    const orderedWorker: NonNullable<AgentTicketDeps['runWorker']> = (command, args, label) => {
      chronological.push(`worker ${command} ${args.join(' ')}`);
      return fixture.runWorker(command, args, label);
    };

    const ordered = await runAgentTicket('10', {
      execute: orderedExecute,
      runWorker: orderedWorker,
    });

    expect(ordered.exitCode).toBe(0);
    const sequence = chronological.join('\n');
    expect(sequence.indexOf('git checkout -b')).toBeLessThan(sequence.indexOf('worker opencode'));
    expect(sequence.indexOf('worker opencode')).toBeLessThan(sequence.indexOf('npm run lint'));
    expect(sequence.indexOf('npm run lint')).toBeLessThan(sequence.indexOf('git push -u origin'));
    expect(sequence.indexOf('git push -u origin')).toBeLessThan(sequence.indexOf('gh pr create'));
    expect(sequence.indexOf('gh pr create')).toBeLessThan(sequence.indexOf('worker npm'));
  });

  it('does not dispatch hosted approval requests from the local ticket flow', async () => {
    const fixture = scriptedDeps(successScript());
    const commands: string[] = [];
    let headCalls = 0;
    const execute: CommandExecutor = (command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };

    const result = await runAgentTicket('10', { execute, runWorker: fixture.runWorker });

    expect(result.exitCode).toBe(0);
    expect(commands.some((command) => command.includes('/dispatches'))).toBe(false);
  });

  it('never merges, deploys, publishes or touches secrets', async () => {
    const script = successScript();
    let headCalls = 0;
    const fixture = scriptedDeps(script);
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };

    await runAgentTicket('10', { execute, runWorker: fixture.runWorker });

    const invocations = [
      ...fixture.calls.map((call) => `${call.command} ${call.args.join(' ')}`),
      ...fixture.workerCalls.map((call) => `${call.command} ${call.args.join(' ')}`),
    ];
    for (const invocation of invocations) {
      expect(invocation).not.toMatch(/merge|deploy|publish|secret|\.env|dev\.vars/i);
    }
    expect(invocations.some((invocation) => invocation.startsWith('git push'))).toBe(true);
    for (const invocation of invocations.filter((item) => item.startsWith('git push'))) {
      expect(invocation).not.toContain('main');
    }
  });
});

describe('agent:ticket failure and escalation paths', () => {
  it('stops before creating a branch when the worktree is dirty', async () => {
    const fixture = scriptedDeps({
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': ' M dirty.ts\n',
    });

    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('start-state');
    expect(result.branch).toBeUndefined();
    expect(fixture.calls.some((call) => call.args.includes('checkout'))).toBe(false);
  });

  it('stops when the ticket is not ready-for-agent', async () => {
    const fixture = scriptedDeps({
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
      'gh issue view 10 --json number,title,state,labels':
        '{"number":10,"title":"T","state":"OPEN","labels":[]}\n',
    });

    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('ticket');
  });

  it('refuses to reuse an existing branch instead of repairing it', async () => {
    const fixture = scriptedDeps({
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
      'gh issue view 10 --json number,title,state,labels': `${ISSUE_VIEW}\n`,
      'git show-ref --verify refs/heads/ticket/10-register-and-verify-an-email-identity': '',
    });

    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('branch');
    expect(result.branch).toBe('ticket/10-register-and-verify-an-email-identity');
  });

  it('stops with durable branch evidence when /implement fails', async () => {
    const script = successScript();
    script['worker opencode run --auto --format json --command implement 10'] = Object.assign(
      new Error('opencode run --auto --command implement 10 failed (exit 1)'),
      { code: 1 },
    );
    const fixture = scriptedDeps(script);

    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('implement');
    expect(result.branch).toBe('ticket/10-register-and-verify-an-email-identity');
  });

  it('stops when /implement produces no local commits', async () => {
    const fixture = scriptedDeps(successScript());

    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('implement');
    expect(result.reason).toMatch(/commit/i);
  });

  it('stops when quality gates fail', async () => {
    const script = successScript();
    script['npm run typecheck'] = new Error('typecheck failed');
    let headCalls = 0;
    const fixture = scriptedDeps(script);
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };

    const result = await runAgentTicket('10', { execute, runWorker: fixture.runWorker });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('gates');
    expect(result.branch).toBe('ticket/10-register-and-verify-an-email-identity');
    expect(fixture.calls.some((call) => call.command === 'git' && call.args[0] === 'push')).toBe(
      false,
    );
  });

  it('stops with branch evidence when the initial push is refused by git', async () => {
    const script = successScript();
    script['git push -u origin ticket/10-register-and-verify-an-email-identity'] = new Error(
      'push rejected',
    );
    let headCalls = 0;
    const fixture = scriptedDeps(script);
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };

    const result = await runAgentTicket('10', { execute, runWorker: fixture.runWorker });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('push');
    expect(result.branch).toBe('ticket/10-register-and-verify-an-email-identity');
  });

  it('stops with branch evidence when draft PR creation fails', async () => {
    const script = successScript();
    script[
      'gh pr create --base main --head ticket/10-register-and-verify-an-email-identity --draft --title Register and verify an email identity (#10) --body Automated implementation of #10 via `npm run agent:ticket`.'
    ] = new Error('pr create failed');
    let headCalls = 0;
    const fixture = scriptedDeps(script);
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };

    const result = await runAgentTicket('10', { execute, runWorker: fixture.runWorker });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('pr');
    expect(result.branch).toBe('ticket/10-register-and-verify-an-email-identity');
  });

  it('propagates review:cycle escalation with PR evidence preserved', async () => {
    const script = successScript();
    const reviewError = Object.assign(
      new Error('npm run review:cycle failed (exit 2): NEEDS-DECISION'),
      { code: 2 },
    );
    script['worker npm run review:cycle'] = reviewError;
    let headCalls = 0;
    const fixture = scriptedDeps(script);
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };
    const runWorker: NonNullable<AgentTicketDeps['runWorker']> = (command, args, label) => {
      if (command === 'npm') {
        return Promise.reject(reviewError);
      }
      return fixture.runWorker(command, args, label);
    };

    const result = await runAgentTicket('10', { execute, runWorker });

    expect(result.exitCode).toBe(2);
    expect(result.failedStage).toBe('review-cycle');
    expect(result.branch).toBe('ticket/10-register-and-verify-an-email-identity');
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe('https://github.com/o/r/pull/42');
  });

  it('reports unavailable hosted approval as a recoverable local BLOCKED state', async () => {
    const script = successScript();
    const approvalWaiting = new Error(
      'npm run review:cycle failed (exit 1): REVIEW-CYCLE BLOCKED: CI checks for the reviewed HEAD require an unavailable hosted approval (action_required); resolve the run outside the local review flow and rerun review:cycle',
    );
    script['worker npm run review:cycle'] = approvalWaiting;
    let headCalls = 0;
    const fixture = scriptedDeps(script);
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return fixture.execute(command, args);
    };
    const runWorker: NonNullable<AgentTicketDeps['runWorker']> = (command, args, label) => {
      if (command === 'npm') {
        return Promise.reject(approvalWaiting);
      }
      return fixture.runWorker(command, args, label);
    };
    const outcomes: string[] = [];
    const result = await runAgentTicket('10', {
      execute,
      runWorker,
      recordOutcome: (record) => {
        outcomes.push(record.outcome);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('review-cycle');
    expect(result.timedOut).toBeUndefined();
    expect(outcomes).toEqual(['BLOCKED']);
  });

  it('uses an injectable worker seam so tests never spawn subprocesses', async () => {
    const runWorker = vi.fn(() => Promise.resolve({ stdout: '', stderr: '' }));
    const fixture = scriptedDeps(successScript());

    await runAgentTicket('10', { execute: fixture.execute, runWorker });

    expect(runWorker).toHaveBeenCalledWith('opencode', buildImplementArgs(10), 'implement');
  });
});

describe('agent:ticket main currency', () => {
  it('accepts a local main that matches origin/main', () => {
    expect(checkMainCurrency({ localHead: MAIN_HEAD, remoteHead: MAIN_HEAD }).ok).toBe(true);
  });

  it('refuses a stale or diverged local main without mutating anything', () => {
    const result = checkMainCurrency({ localHead: MAIN_HEAD, remoteHead: NEXT_HEAD });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/origin\/main/);
      expect(result.reason).toMatch(/stale/i);
    }
  });

  it('resolves the remote main HEAD without touching local refs', async () => {
    const fixture = scriptedDeps({
      'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
    });

    await expect(getRemoteMainHead(fixture.execute)).resolves.toBe(MAIN_HEAD);
    expect(fixture.calls).toEqual([
      { command: 'git', args: ['ls-remote', 'origin', 'refs/heads/main'] },
    ]);
  });

  it('treats unparseable remote output as unresolvable', async () => {
    const fixture = scriptedDeps({ 'git ls-remote origin refs/heads/main': '\n' });

    await expect(getRemoteMainHead(fixture.execute)).rejects.toThrow(/origin\/main/);
  });

  it('stops before branch creation when local main is behind origin/main', async () => {
    const fixture = scriptedDeps({
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': `${NEXT_HEAD}\trefs/heads/main\n`,
    });

    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('start-state');
    expect(result.reason).toMatch(/origin\/main/);
    expect(result.branch).toBeUndefined();
    expect(fixture.calls.some((call) => call.args.includes('checkout'))).toBe(false);
  });

  it('stops when origin/main cannot be resolved', async () => {
    const fixture = scriptedDeps({
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': new Error('network unreachable'),
    });

    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('start-state');
    expect(result.reason).toMatch(/origin\/main/);
    expect(result.branch).toBeUndefined();
    expect(fixture.calls.some((call) => call.args.includes('checkout'))).toBe(false);
  });
});
