import {
  getCurrentBranch,
  getPrForBranch,
  runCommand,
  type CommandExecutor,
} from './repository-command.js';

export interface SafePushState {
  currentBranch: string;
  prHead: string;
  prBase: string;
  pushTarget: string;
  worktreeClean: boolean;
}

export type SafePushCheck = { ok: true } | { ok: false; reason: string };

const TICKET_BRANCH_PATTERN = /^(feat|fix|chore|ticket)\/\d+-[a-z0-9-]+$/;

export function isTicketBranch(branch: string): boolean {
  return TICKET_BRANCH_PATTERN.test(branch);
}

export function checkSafePush(state: SafePushState): SafePushCheck {
  if (state.currentBranch === 'main' || state.currentBranch === 'master') {
    return { ok: false, reason: 'refusing to push from the protected branch itself' };
  }
  if (!isTicketBranch(state.currentBranch)) {
    return { ok: false, reason: `not a ticket branch: ${state.currentBranch}` };
  }
  if (state.prHead !== state.currentBranch) {
    return {
      ok: false,
      reason: `PR head ${state.prHead} does not match current branch ${state.currentBranch}`,
    };
  }
  if (state.prBase !== 'main') {
    return { ok: false, reason: `PR base must be main, got ${state.prBase}` };
  }
  if (!state.worktreeClean) {
    return { ok: false, reason: 'worktree has uncommitted changes' };
  }
  if (state.pushTarget === 'main' || state.pushTarget.endsWith('/main')) {
    return { ok: false, reason: 'push must never target main directly' };
  }
  return { ok: true };
}

export type SafePushOutcome = { ok: true; branch: string } | { ok: false; reason: string };

// The only automated push path: deterministic guards first, then a plain
// `git push` of the current ticket branch. Never targets `main` itself.
export async function safePushBranch(
  prArg?: string,
  execute: CommandExecutor = runCommand,
): Promise<SafePushOutcome> {
  const branch = await getCurrentBranch(execute);
  const pr = await getPrForBranch(prArg, execute);
  const { stdout } = await execute('git', ['status', '--porcelain']);
  const check = checkSafePush({
    currentBranch: branch,
    prHead: pr.headRefName,
    prBase: pr.baseRefName,
    pushTarget: 'origin',
    worktreeClean: stdout.trim() === '',
  });
  if (!check.ok) {
    return check;
  }
  await execute('git', ['push', 'origin', branch]);
  return { ok: true, branch };
}
