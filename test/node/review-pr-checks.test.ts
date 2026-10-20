import { describe, expect, it } from 'vitest';
import { decideStartSync } from '../../scripts/review/cycle-policy.js';
import {
  CHECK_POLL_ATTEMPTS,
  CHECK_POLL_DELAY_MS,
  commitChecksPass,
  decideCheckPoll,
  MAX_CONSECUTIVE_CHECK_READ_ERRORS,
  pollCommitCheckRunsWithReadRecovery,
  type CommitCheckRun,
} from '../../scripts/review/pr-checks.js';

// Seam under test: HEAD-sync and exact-SHA CI verification (PR #17 final
// acceptance blocker 2). The loop must never report READY for a local HEAD
// that the PR/CI does not point at.
describe('review start HEAD sync', () => {
  const localHead = 'a'.repeat(40);

  it('is in sync when the PR head already matches the local HEAD', () => {
    expect(decideStartSync({ localHead, prHeadOid: localHead, push: true }).kind).toBe('in-sync');
  });

  it('pushes and refreshes when heads diverge and push is enabled', () => {
    expect(decideStartSync({ localHead, prHeadOid: 'b'.repeat(40), push: true }).kind).toBe(
      'push-and-refresh',
    );
  });

  it('aborts instead of reviewing when heads diverge under --no-push', () => {
    const decision = decideStartSync({ localHead, prHeadOid: 'b'.repeat(40), push: false });

    expect(decision.kind).toBe('abort-diverged');
  });
});

describe('exact-SHA commit checks', () => {
  it('passes when every check run completed successfully', () => {
    expect(
      commitChecksPass([
        { name: 'quality gates', status: 'completed', conclusion: 'success' },
        { name: 'quality gates', status: 'completed', conclusion: 'success' },
      ]),
    ).toBe(true);
  });

  it('fails when any check is still pending', () => {
    expect(
      commitChecksPass([
        { name: 'quality gates', status: 'completed', conclusion: 'success' },
        { name: 'quality gates', status: 'in_progress', conclusion: null },
      ]),
    ).toBe(false);
  });

  it('fails when any check concluded unsuccessfully', () => {
    expect(
      commitChecksPass([{ name: 'quality gates', status: 'completed', conclusion: 'failure' }]),
    ).toBe(false);
  });

  it('fails when no check runs are registered yet (no vacuous pass)', () => {
    expect(commitChecksPass([])).toBe(false);
  });
});

describe('check polling policy', () => {
  it('passes when every check run completed successfully', () => {
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'completed', conclusion: 'success' }]),
    ).toBe('pass');
  });

  it('waits while checks are pending or absent', () => {
    expect(decideCheckPoll([])).toBe('pending');
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'in_progress', conclusion: null }]),
    ).toBe('pending');
  });

  it('fails fast when any completed check did not succeed', () => {
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'completed', conclusion: 'failure' }]),
    ).toBe('fail');
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'completed', conclusion: null }]),
    ).toBe('fail');
  });

  it('fails fast when exact-HEAD checks require unavailable hosted approval', () => {
    // A local review cannot resolve hosted approval requirements.
    expect(
      decideCheckPoll([
        { name: 'quality gates', status: 'completed', conclusion: 'action_required' },
      ]),
    ).toBe('fail');
    expect(
      commitChecksPass([
        { name: 'quality gates', status: 'completed', conclusion: 'action_required' },
      ]),
    ).toBe(false);
  });

  it('fails fast when approval and a genuine CI failure are both present', () => {
    expect(
      decideCheckPoll([
        { name: 'quality gates', status: 'completed', conclusion: 'action_required' },
        { name: 'other', status: 'completed', conclusion: 'failure' },
      ]),
    ).toBe('fail');
  });

  it('keeps bounded polling within the established CI observation window', () => {
    expect(CHECK_POLL_DELAY_MS).toBe(10000);
    expect(CHECK_POLL_ATTEMPTS * CHECK_POLL_DELAY_MS).toBeGreaterThanOrEqual(12 * 60 * 1000);
  });
});

function successfulRun(name = 'quality gates'): CommitCheckRun[] {
  return [{ name, status: 'completed', conclusion: 'success' }];
}

function pendingRun(): CommitCheckRun[] {
  return [{ name: 'quality gates', status: 'in_progress', conclusion: null }];
}

function failedRun(): CommitCheckRun[] {
  return [{ name: 'quality gates', status: 'completed', conclusion: 'failure' }];
}

function readError(): Error {
  return new Error('gh: failed check-runs query (fixture read error)');
}

interface ScriptedPoll {
  fetch: () => Promise<CommitCheckRun[]>;
  sleeps: number[];
  observations: { decision: string; attempt: number }[];
}

// Seam under test: bounded exact-HEAD check-run read recovery (ticket #141).
// The shipped poll implementation is exercised directly with controlled I/O
// and clock so the 72-attempt/10-second budget is asserted without waiting;
// the real review-cycle CLI proves the wiring in
// review-cycle-check-read-recovery.test.ts.
function scriptedPoll(sequence: (CommitCheckRun[] | Error)[]): ScriptedPoll {
  let index = 0;
  const sleeps: number[] = [];
  const observations: { decision: string; attempt: number }[] = [];
  return {
    sleeps,
    observations,
    fetch: () => {
      const next = sequence[Math.min(index, sequence.length - 1)] ?? [];
      index += 1;
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve(next);
    },
  };
}

describe('bounded check-run read recovery (ticket #141)', () => {
  it('pins the operator-approved three-consecutive-error bound', () => {
    expect(MAX_CONSECUTIVE_CHECK_READ_ERRORS).toBe(3);
  });

  it('passes immediately on a successful first read with no wait', async () => {
    const poll = scriptedPoll([successfulRun()]);

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
      onChecksObserved: ({ decision, attempt }) => {
        poll.observations.push({ decision, attempt });
      },
    });

    expect(result.outcome).toBe('pass');
    expect(result.runs).toEqual(successfulRun());
    expect(result.attemptsUsed).toBe(1);
    expect(result.failedReads).toBe(0);
    expect(poll.sleeps).toEqual([]);
    expect(poll.observations).toEqual([{ decision: 'pass', attempt: 0 }]);
  });

  it('recovers after a single failed read and waits once', async () => {
    const poll = scriptedPoll([readError(), successfulRun()]);

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(result.outcome).toBe('pass');
    expect(result.attemptsUsed).toBe(2);
    expect(result.failedReads).toBe(1);
    expect(poll.sleeps).toEqual([CHECK_POLL_DELAY_MS]);
  });

  it('recovers after two consecutive failed reads', async () => {
    const poll = scriptedPoll([readError(), readError(), successfulRun()]);

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(result.outcome).toBe('pass');
    expect(result.attemptsUsed).toBe(3);
    expect(result.failedReads).toBe(2);
    expect(poll.sleeps).toEqual([CHECK_POLL_DELAY_MS, CHECK_POLL_DELAY_MS]);
  });

  it('stops unreadable on the third consecutive failed read with no final wait', async () => {
    const poll = scriptedPoll([readError(), readError(), readError(), successfulRun()]);

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(result.outcome).toBe('unreadable');
    expect(result.attemptsUsed).toBe(3);
    expect(result.failedReads).toBe(3);
    expect(result.runs).toEqual([]);
    expect(result.readError).toMatch(/fixture read error/);
    expect(poll.sleeps).toEqual([CHECK_POLL_DELAY_MS, CHECK_POLL_DELAY_MS]);
  });

  it('still fails fast on genuine CI failure without extra reads', async () => {
    const immediate = scriptedPoll([failedRun()]);

    const immediateResult = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: immediate.fetch,
      sleep: (milliseconds) => {
        immediate.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(immediateResult.outcome).toBe('fail');
    expect(immediateResult.attemptsUsed).toBe(1);
    expect(immediateResult.failedReads).toBe(0);
    expect(immediate.sleeps).toEqual([]);

    const afterError = scriptedPoll([readError(), failedRun(), successfulRun()]);

    const afterErrorResult = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: afterError.fetch,
      sleep: (milliseconds) => {
        afterError.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(afterErrorResult.outcome).toBe('fail');
    expect(afterErrorResult.attemptsUsed).toBe(2);
    expect(afterErrorResult.failedReads).toBe(1);
    expect(afterError.sleeps).toEqual([CHECK_POLL_DELAY_MS]);
  });

  it('resets the consecutive-error state on any successful read, even pending ones', async () => {
    // Three failed reads separated by valid pending observations must recover.
    // A non-resetting counter would stop unreadable at the third error.
    const poll = scriptedPoll([
      readError(),
      pendingRun(),
      readError(),
      [],
      readError(),
      pendingRun(),
      successfulRun(),
    ]);

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
      onChecksObserved: ({ decision, attempt }) => {
        poll.observations.push({ decision, attempt });
      },
    });

    expect(result.outcome).toBe('pass');
    expect(result.attemptsUsed).toBe(7);
    expect(result.failedReads).toBe(3);
    expect(poll.sleeps).toEqual([
      CHECK_POLL_DELAY_MS,
      CHECK_POLL_DELAY_MS,
      CHECK_POLL_DELAY_MS,
      CHECK_POLL_DELAY_MS,
      CHECK_POLL_DELAY_MS,
      CHECK_POLL_DELAY_MS,
    ]);
    expect(poll.observations.map((observation) => observation.decision)).toEqual([
      'pending',
      'pending',
      'pending',
      'pass',
    ]);
  });

  it('exhausts the existing 72-attempt budget on pending reads with no final wait', async () => {
    const poll = scriptedPoll(Array.from({ length: CHECK_POLL_ATTEMPTS }, () => pendingRun()));

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(result.outcome).toBe('pending');
    expect(result.attemptsUsed).toBe(CHECK_POLL_ATTEMPTS);
    expect(result.failedReads).toBe(0);
    expect(poll.sleeps).toHaveLength(CHECK_POLL_ATTEMPTS - 1);
    expect(poll.sleeps.every((delay) => delay === CHECK_POLL_DELAY_MS)).toBe(true);
  });

  it('counts failed reads against the same budget and stays unreadable when the last read fails', async () => {
    const sequence: (CommitCheckRun[] | Error)[] = Array.from(
      { length: CHECK_POLL_ATTEMPTS - 1 },
      (_, index) => (index % 2 === 0 ? readError() : pendingRun()),
    );
    sequence.push(readError());
    const poll = scriptedPoll(sequence);

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(result.outcome).toBe('unreadable');
    expect(result.attemptsUsed).toBe(CHECK_POLL_ATTEMPTS);
    // Alternating error/pending never reaches three consecutive errors, so the
    // budget — not the consecutive bound — stops the poll after 72 attempts:
    // 36 alternating errors plus the final unreadable read.
    expect(result.failedReads).toBe(37);
    expect(poll.sleeps).toHaveLength(CHECK_POLL_ATTEMPTS - 1);
  });

  it('reports observed pending when the budget ends on a readable pending read', async () => {
    const sequence: (CommitCheckRun[] | Error)[] = Array.from(
      { length: CHECK_POLL_ATTEMPTS - 1 },
      (_, index) => (index % 2 === 0 ? readError() : pendingRun()),
    );
    sequence.push(pendingRun());
    const poll = scriptedPoll(sequence);

    const result = await pollCommitCheckRunsWithReadRecovery({
      fetchChecks: poll.fetch,
      sleep: (milliseconds) => {
        poll.sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(result.outcome).toBe('pending');
    expect(result.attemptsUsed).toBe(CHECK_POLL_ATTEMPTS);
    expect(result.failedReads).toBe(36);
    expect(result.readError).toBeUndefined();
    expect(poll.sleeps).toHaveLength(CHECK_POLL_ATTEMPTS - 1);
  });
});
