import { describe, expect, it } from 'vitest';
import { checkSafePush } from '../../scripts/safe-push-guards.js';

// Seam under test: deterministic push guards (ticket #16).
// Models never receive generic `git push` permission; only this narrow script
// may push, and only from a ticket branch to its own PR (base `main`).
describe('safe-push guards', () => {
  const valid = {
    currentBranch: 'chore/16-safe-push',
    prHead: 'chore/16-safe-push',
    prBase: 'main',
    pushTarget: 'origin',
    worktreeClean: true,
  };

  it('allows a clean ticket branch whose PR head matches and targets main', () => {
    expect(checkSafePush(valid).ok).toBe(true);
  });

  it('accepts the ticket/<number>-... branch convention used by the workflow', () => {
    const result = checkSafePush({
      ...valid,
      currentBranch: 'ticket/10-register-verify',
      prHead: 'ticket/10-register-verify',
    });

    expect(result.ok).toBe(true);
  });

  it('refuses to push from main itself', () => {
    const result = checkSafePush({ ...valid, currentBranch: 'main', prHead: 'main' });

    expect(result.ok).toBe(false);
  });

  it('refuses when the PR head does not match the current branch', () => {
    const result = checkSafePush({ ...valid, prHead: 'chore/99-other' });

    expect(result.ok).toBe(false);
  });

  it('refuses when the PR base is not main', () => {
    const result = checkSafePush({ ...valid, prBase: 'staging' });

    expect(result.ok).toBe(false);
  });

  it('refuses when the worktree has uncommitted changes', () => {
    const result = checkSafePush({ ...valid, worktreeClean: false });

    expect(result.ok).toBe(false);
  });

  it('refuses a non-ticket branch name', () => {
    const result = checkSafePush({
      ...valid,
      currentBranch: 'experiment/quick-hack',
      prHead: 'experiment/quick-hack',
    });

    expect(result.ok).toBe(false);
  });
});
