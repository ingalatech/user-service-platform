import { approveWorkflowRun, evaluateAgentCiApproval } from './review/approve-agent-ci.js';
import { runCommand } from './review/runner.js';

// Trusted approver entrypoint (ticket #44). Runs from a trusted `main`
// checkout inside `.github/workflows/approve-agent-ci.yml` — never from PR
// code. It proves every provenance guard from GitHub-owned API reads and
// approves only the narrowly defined `/agent-ticket` CI runs. Any refusal
// fails closed with concise evidence and a zero exit code; only unexpected
// execution errors exit non-zero.
interface ApproverArgs {
  repo: string;
  runId: number;
  workflowName: string;
  conclusion: string;
  headSha: string;
  prNumbers: number[];
}

function parseArgs(argv: readonly string[]): ApproverArgs {
  let repo: string | undefined;
  let runId: number | undefined;
  let workflowName: string | undefined;
  let conclusion: string | undefined;
  let headSha: string | undefined;
  const prNumbers: number[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      repo = argv[index + 1];
      index += 1;
    } else if (arg === '--run-id') {
      const raw = argv[index + 1];
      runId = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      index += 1;
    } else if (arg === '--workflow') {
      workflowName = argv[index + 1];
      index += 1;
    } else if (arg === '--conclusion') {
      conclusion = argv[index + 1];
      index += 1;
    } else if (arg === '--head-sha') {
      headSha = argv[index + 1];
      index += 1;
    } else if (arg === '--pr') {
      const raw = argv[index + 1];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--pr requires a positive integer PR number, got ${raw ?? '(missing)'}`);
      }
      prNumbers.push(parsed);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: approve-agent-ci --repo <owner/repo> --run-id <id> --workflow <name> --conclusion <conclusion> --head-sha <sha> [--pr <number>]',
      );
      throw new HelpRequested();
    } else {
      throw new Error(`unknown argument: ${arg ?? '(missing)'}`);
    }
  }

  if (
    repo === undefined ||
    repo === '' ||
    runId === undefined ||
    !Number.isInteger(runId) ||
    runId <= 0 ||
    workflowName === undefined ||
    workflowName === '' ||
    conclusion === undefined ||
    conclusion === '' ||
    headSha === undefined ||
    headSha === ''
  ) {
    throw new Error(
      'usage: approve-agent-ci --repo <owner/repo> --run-id <id> --workflow <name> --conclusion <conclusion> --head-sha <sha> [--pr <number>]',
    );
  }

  return { repo, runId, workflowName, conclusion, headSha, prNumbers };
}

class HelpRequested extends Error {}

async function main(): Promise<void> {
  let args: ApproverArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  try {
    const decision = await evaluateAgentCiApproval(runCommand, {
      repoSlug: args.repo,
      runId: args.runId,
      workflowName: args.workflowName,
      runConclusion: args.conclusion,
      runHeadSha: args.headSha,
      pullRequestNumbers: args.prNumbers,
    });
    if (decision.approved) {
      console.log(decision.reason);
      await approveWorkflowRun(runCommand, args.repo, args.runId);
      console.log(`Approved workflow run ${String(args.runId)} for exact-HEAD CI.`);
    } else {
      console.log(decision.reason);
      console.log(`Refusing to approve workflow run ${String(args.runId)}.`);
    }
  } catch (error) {
    console.error(
      `approve-agent-ci failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

await main();
