import { getCurrentBranch, getPrForBranch } from './repository-command.js';
import { safePushBranch } from './safe-push-guards.js';

// Deterministic safe-push path (ticket #16). Models never receive generic
// `git push` permission; only this script may push, and only when the current
// branch is a ticket branch, the PR head matches it, the base is `main`, the
// worktree is clean, and the push cannot target `main` itself.
async function main(): Promise<void> {
  const branch = await getCurrentBranch();
  const pr = await getPrForBranch();
  const pushed = await safePushBranch();
  if (!pushed.ok) {
    console.error(`SAFE-PUSH REFUSED: ${pushed.reason}`);
    console.error(`branch=${branch} prHead=${pr.headRefName} prBase=${pr.baseRefName}`);
    process.exitCode = 1;
    return;
  }

  console.log(`SAFE-PUSH OK: origin/${pushed.branch} (PR #${String(pr.number)}, base main)`);
}

await main();
