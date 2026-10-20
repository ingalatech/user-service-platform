import { describe, expect, it } from 'vitest';
import { runAgentTicket } from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';
import type { WorkflowHandoffRecord } from '../../scripts/review/workflow-handoff.js';
import {
  HANDOFF_PATCH_PATH,
  HANDOFF_RECORD_PATH,
  TRUSTED_PUBLICATION_MARKER,
  buildHandoffRecord,
  buildWorkflowDiffArgs,
  buildWorkflowPatchArgs,
  formatHandoffAction,
  formatHandoffReason,
  isWorkflowFile,
  listWorkflowFiles,
  parseNameOnlyOutput,
} from '../../scripts/review/workflow-handoff.js';

// Seam under test: deterministic workflow-file handoff detection (ticket #36).
// Local agent corrections that touch `.github/workflows/**` stop before push
// and leave a reproducible patch/metadata bundle for operator review.
describe('workflow-file detection', () => {
  it('matches files under .github/workflows/', () => {
    expect(isWorkflowFile('.github/workflows/agent-ticket.yml')).toBe(true);
    expect(isWorkflowFile('.github/workflows/nested/extra.yml')).toBe(true);
  });

  it('ignores non-workflow paths', () => {
    expect(isWorkflowFile('scripts/agent/ticket-flow.ts')).toBe(false);
    expect(isWorkflowFile('.github/CODEOWNERS')).toBe(false);
    expect(isWorkflowFile('.github/workflows')).toBe(false);
    expect(isWorkflowFile('')).toBe(false);
  });

  it('normalizes leading ./ and surrounding whitespace', () => {
    expect(isWorkflowFile('  ./.github/workflows/ci.yml  ')).toBe(true);
  });

  it('filters, dedupes, and sorts workflow paths', () => {
    expect(
      listWorkflowFiles([
        'scripts/x.ts',
        '.github/workflows/b.yml',
        '.github/workflows/a.yml',
        '.github/workflows/b.yml',
        '',
      ]),
    ).toEqual(['.github/workflows/a.yml', '.github/workflows/b.yml']);
  });

  it('parses git --name-only output into clean paths', () => {
    expect(
      parseNameOnlyOutput('.github/workflows/a.yml\nscripts/x.ts\n\n  \n.github/workflows/b.yml\n'),
    ).toEqual(['.github/workflows/a.yml', 'scripts/x.ts', '.github/workflows/b.yml']);
  });
});

describe('workflow handoff commands and evidence', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);

  it('builds a deterministic name-only diff scoped to workflows', () => {
    expect(buildWorkflowDiffArgs(base, head)).toEqual([
      'diff',
      '--name-only',
      `${base}...${head}`,
      '--',
      '.github/workflows/',
    ]);
  });

  it('builds a deterministic patch diff preserving the full correction', () => {
    // The handoff bundle must reproduce the complete correction, not just
    // the workflow files, while the record files list still identifies the
    // workflow files that triggered trusted handoff.
    expect(buildWorkflowPatchArgs(base, head)).toEqual(['diff', `${base}...${head}`, '--']);
  });

  it('marks the handoff reason as trusted-publication-required with file names', () => {
    const reason = formatHandoffReason(['.github/workflows/agent-fix-cycle.yml']);

    expect(reason).toContain(TRUSTED_PUBLICATION_MARKER);
    expect(reason).toContain('.github/workflows/agent-fix-cycle.yml');
    expect(reason).not.toMatch(/push refused|safe-push/i);
  });

  it('directs the correction to a trusted publisher without widening credentials', () => {
    const action = formatHandoffAction();

    expect(action).toMatch(/trusted/i);
    expect(action).toMatch(/publish/i);
    expect(action).not.toMatch(/grant workflows|workflows:\s*write|\bbearer\b/i);
  });

  it('pins the handoff bundle paths under the repository worktree', () => {
    expect(HANDOFF_PATCH_PATH).toBe('.agent-ticket/workflow-handoff.patch');
    expect(HANDOFF_RECORD_PATH).toBe('.agent-ticket/workflow-handoff.json');
  });

  it('builds a deterministic handoff record with exact base/head metadata', () => {
    const record = buildHandoffRecord({
      branch: 'ticket/36-workflow-handoff',
      base,
      head,
      files: ['.github/workflows/agent-fix-cycle.yml'],
      createdAt: '2026-09-12T00:00:00.000Z',
    });

    expect(record).toMatchObject({
      version: 1,
      branch: 'ticket/36-workflow-handoff',
      base,
      head,
      files: ['.github/workflows/agent-fix-cycle.yml'],
      patchPath: HANDOFF_PATCH_PATH,
    });
    expect(JSON.stringify(record)).toContain(TRUSTED_PUBLICATION_MARKER);
  });
});

describe('agent:ticket workflow handoff at the push stage', () => {
  const MAIN_HEAD = 'a'.repeat(40);
  const NEXT_HEAD = 'b'.repeat(40);
  const BRANCH = 'ticket/10-register-and-verify-an-email-identity';
  const ISSUE_VIEW = JSON.stringify({
    number: 10,
    title: 'Register and verify an email identity',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
  });
  const WORKFLOW_FILE = '.github/workflows/agent-fix-cycle.yml';

  function handoffFixture(captured: {
    pushes: string[];
    handoffs: { record: WorkflowHandoffRecord; patch: string }[];
    outcomes: { outcome: string; stage: string; actionRequired?: string }[];
    bodies: string[];
  }): CommandExecutor {
    let headCalls = 0;
    const execute: CommandExecutor = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      if (command === 'gh' && args[0] === 'api') {
        const bodyArg = args.find((arg) => arg.startsWith('body='));
        captured.bodies.push(bodyArg === undefined ? '' : bodyArg.slice('body='.length));
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      // Ticket #82: the handoff run leaves a machine-readable marker comment
      // on the source ticket via `gh issue comment`.
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        const bodyIndex = args.indexOf('--body');
        captured.bodies.push(bodyIndex === -1 ? '' : (args[bodyIndex + 1] ?? ''));
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (key === `git diff --name-only ${MAIN_HEAD}...${NEXT_HEAD} -- .github/workflows/`) {
        return Promise.resolve({ stdout: `${WORKFLOW_FILE}\n`, stderr: '' });
      }
      if (key === `git diff ${MAIN_HEAD}...${NEXT_HEAD} --`) {
        return Promise.resolve({
          stdout:
            'diff --git a/.github/workflows/agent-fix-cycle.yml b/.github/workflows/agent-fix-cycle.yml\n' +
            'diff --git a/scripts/x.ts b/scripts/x.ts\n',
          stderr: '',
        });
      }
      if (key.startsWith('git push')) {
        captured.pushes.push(key);
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      const staticOutputs: Record<string, string> = {
        'git rev-parse --abbrev-ref HEAD': 'main\n',
        'git status --porcelain': '',
        'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
        'gh issue view 10 --json number,title,state,labels': `${ISSUE_VIEW}\n`,
        'git checkout -b ticket/10-register-and-verify-an-email-identity': '',
        'npm run lint': '',
        'npm run format:check': '',
        'npm run typecheck': '',
        'npm run openapi:check': '',
        'npm run test': '',
        'npm run test:harness': '',
      };
      if (key === `git show-ref --verify refs/heads/${BRANCH}`) {
        return Promise.reject(new Error(`fatal: '${BRANCH}' - not a valid ref`));
      }
      const output = staticOutputs[key];
      if (output !== undefined) {
        return Promise.resolve({ stdout: output, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
    return execute;
  }

  it('stops before the generic push and leaves a trusted-publication handoff', async () => {
    const captured = { pushes: [], handoffs: [], outcomes: [], bodies: [] } as {
      pushes: string[];
      handoffs: { record: WorkflowHandoffRecord; patch: string }[];
      outcomes: { outcome: string; stage: string; actionRequired?: string }[];
      bodies: string[];
    };

    const result = await runAgentTicket('10', {
      execute: handoffFixture(captured),
      runWorker: () => Promise.resolve({ stdout: '', stderr: '' }),
      status: { commentId: 1, repoSlug: 'o/r', runUrl: 'https://github.com/o/r/actions/runs/1' },
      recordOutcome: (record) => {
        captured.outcomes.push({
          outcome: record.outcome,
          stage: record.stage,
          ...(record.actionRequired === undefined ? {} : { actionRequired: record.actionRequired }),
        });
      },
      writeHandoff: (input) => {
        captured.handoffs.push(input);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('push');
    expect(result.branch).toBe(BRANCH);
    expect(result.reason).toContain(TRUSTED_PUBLICATION_MARKER);
    expect(result.reason).toContain(WORKFLOW_FILE);
    expect(captured.pushes).toEqual([]);
    expect(captured.handoffs).toHaveLength(1);
    expect(captured.handoffs[0]?.record).toMatchObject({
      version: 1,
      branch: BRANCH,
      base: MAIN_HEAD,
      head: NEXT_HEAD,
      files: [WORKFLOW_FILE],
    });
    expect(captured.handoffs[0]?.patch).toContain(
      'diff --git a/.github/workflows/agent-fix-cycle.yml',
    );
    expect(captured.handoffs[0]?.patch).toContain('diff --git a/scripts/x.ts');
    // Ticket #82: the run also leaves the machine-readable marker for the
    // trusted approver alongside the human-readable BLOCKED message.
    expect(captured.bodies.some((body) => body.includes('trusted-workflow-handoff:v1'))).toBe(true);
    expect(captured.outcomes).toHaveLength(1);
    expect(captured.outcomes[0]).toMatchObject({ outcome: 'BLOCKED', stage: 'push' });
    expect(captured.outcomes[0]?.actionRequired).toMatch(/trusted/i);
    const terminal = captured.bodies[captured.bodies.length - 1] ?? '';
    expect(terminal).toContain('BLOCKED');
    expect(terminal).toContain(TRUSTED_PUBLICATION_MARKER);
    expect(terminal).toContain('@JonatanGarbuyo');
  });
});
