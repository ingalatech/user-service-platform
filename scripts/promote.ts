import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentTarget,
} from './deploy/environment-config.js';
import { listPromotionVersionsForSelection, runPromotion } from './deploy/orchestrate.js';
import { createChildProcessReleaseAdapter } from './deploy/process.js';
import { selectWithKeys } from './deploy/prompt.js';
import type { DeployableEnvironment } from './deploy/naming.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export { preparePromotionVersions } from './deploy/orchestrate.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const environments = [
    'sandbox',
    'production',
  ] as const satisfies readonly DeployableEnvironment[];
  const environmentOption = option('--env');
  const environment =
    environmentOption ??
    environments[await selectPromotionChoice('Select promotion environment', environments)];
  if (environment === undefined) throw new Error('No promotion environment selected.');
  // Promotion intentionally resolves only target identity. The selected
  // immutable version already contains its compiled application profile;
  // current non-secret environment values must not be re-materialized here.
  const resolved = resolveEnvironmentTarget(
    loadEnvironmentFile(environmentFilePath(repoRoot, environment)),
    { requireRemoteReady: true },
  );
  const processAdapter = createChildProcessReleaseAdapter();
  const prepared = await listPromotionVersionsForSelection(resolved, processAdapter);
  const selectedIndex = await selectPromotionChoice(
    'Select immutable Worker version',
    prepared.display,
  );
  const selected = prepared.versions[selectedIndex];
  if (selected === undefined) throw new Error('No immutable Version ID selected.');
  let confirm = option('--confirm');
  if (resolved.environment === 'production') {
    if (confirm === undefined) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        confirm = await readline.question(
          `Type exactly "${resolved.workerName}" to promote production: `,
        );
      } finally {
        readline.close();
      }
    }
  }
  await runPromotion(
    { resolved, versionId: selected.id, ...(confirm === undefined ? {} : { confirm }) },
    processAdapter,
  );
}

function isInteractive(): boolean {
  return (
    process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function'
  );
}

async function selectPromotionChoice(
  question: string,
  choices: readonly string[],
): Promise<number> {
  if (isInteractive()) {
    return selectWithKeys(process.stdin, process.stdout, question, choices);
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    choices.forEach((choice, index) => {
      process.stdout.write(`${String(index + 1)}. ${choice}\n`);
    });
    const answer = (await readline.question(`${question} [1-${String(choices.length)}]: `)).trim();
    const selected = Number(answer) - 1;
    if (!Number.isInteger(selected) || selected < 0 || selected >= choices.length) {
      throw new Error('No valid promotion selection was provided.');
    }
    return selected;
  } finally {
    readline.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown promotion failure');
    process.exitCode = 1;
  });
}
