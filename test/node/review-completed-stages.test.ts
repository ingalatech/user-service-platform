import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAgentTicket } from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';
import { createRunSummaryRecorder } from '../../scripts/review/run-summary.js';

// Seam under test: local durable completed-stage state. The review cycle must
// accumulate completed stages instead of resetting them.

function readReviewCycleSource(): string {
  return readFileSync('scripts/review-cycle.ts', 'utf8');
}

describe('review-cycle accumulated completed stages', () => {
  it('accumulates completed stages as the cycle advances instead of resetting', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.setStage('Standards review');
    expect(recorder.snapshot().completedStages).toEqual([]);

    recorder.setStage('gates');
    expect(recorder.snapshot().completedStages).toEqual(['Standards review']);

    recorder.setStage('exact-HEAD CI');
    expect(recorder.snapshot().completedStages).toEqual(['Standards review', 'gates']);
  });

  it('persists accumulated completed stages in the terminal summary', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.setReviewedHead('a'.repeat(40));
    recorder.setStage('Standards review');
    recorder.setStage('gates');
    recorder.setStage('final acceptance-ready');
    const summary = recorder.finish('READY', 'ready for final acceptance');

    expect(summary.completedStages).toEqual(['Standards review', 'gates']);
    expect(summary.stage).toBe('final acceptance-ready');
  });

  it('does not duplicate stages when the same stage is published twice', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.setStage('Standards review');
    recorder.setStage('Standards review');
    recorder.setStage('gates');

    expect(recorder.snapshot().completedStages).toEqual(['Standards review']);
  });

  it('publishes accumulated stages instead of resetting to an empty list', () => {
    const source = readReviewCycleSource();

    expect(source).not.toMatch(/completedStages:\s*\[\]/);
  });
});

describe('agent:ticket outcome completed stages', () => {
  it('records accumulated completed stages on the success path', async () => {
    const fixture = successFixture();
    const records: { outcome: string; stage: string; completedStages?: string[] }[] = [];
    const result = await runAgentTicket('10', {
      execute: fixture,
      runWorker: (command) => {
        if (command === 'npm') {
          return Promise.resolve({
            stdout: 'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
      recordOutcome: (record) => {
        records.push({
          outcome: record.outcome,
          stage: record.stage,
          completedStages: [...record.completedStages],
        });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.completedStages).toEqual([
      'implementation',
      'gates',
      'push',
      'PR creation',
      'review',
    ]);
  });
});

const MAIN_HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const ISSUE_VIEW = JSON.stringify({
  number: 10,
  title: 'Register and verify an email identity',
  state: 'OPEN',
  labels: [{ name: 'ready-for-agent' }],
});

function successFixture(): CommandExecutor {
  const script: Record<string, unknown> = {
    'git rev-parse --abbrev-ref HEAD': 'main\n',
    'git status --porcelain': '',
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
  let headCalls = 0;
  const execute: CommandExecutor = (command, args) => {
    if (command === 'gh' && args[0] === 'api') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
      headCalls += 1;
      return Promise.resolve({
        stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
        stderr: '',
      });
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
  return execute;
}
