import { createInterface } from 'node:readline';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentTarget,
  type EnvironmentFile,
} from './deploy/environment-config.js';
import { isAllowlisted, parseAllowlist } from '../src/features/identity/resend-transport.js';
import {
  buildSmokeEmail,
  parseExactSmokeEmail,
  runSandboxSmokeWorkflow,
  type SmokeConfig,
} from './smoke-sandbox.js';

export interface InteractiveSmokePrompts {
  readonly isInteractive: boolean;
  readonly chooseRecipient: (count: number) => Promise<number | undefined>;
  readonly readHidden: (label: string) => Promise<string | undefined>;
}

export interface InteractiveSmokeOptions {
  readonly environmentFile?: EnvironmentFile;
  readonly prompts?: InteractiveSmokePrompts;
  readonly fetchImpl?: typeof fetch;
}

function cancelled(): Error {
  return new Error('Interactive sandbox smoke cancelled.');
}

function allowlistedRecipients(value: string, runId: string): string[] {
  const allowlist = parseAllowlist(value);
  const recipients = allowlist.map((entry) =>
    entry.includes('@')
      ? parseExactSmokeEmail(entry)
      : parseExactSmokeEmail(buildSmokeEmail(entry, runId)),
  );
  if (recipients.length === 0) {
    throw new Error(
      'Interactive sandbox smoke requires at least one recipient in AUTH_MAIL_ALLOWLIST.',
    );
  }
  return [...new Set(recipients)];
}

function createLinePrompt(): (question: string) => Promise<string | undefined> {
  return (question) =>
    new Promise((resolve) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      readline.question(question, (answer) => {
        readline.close();
        const normalized = answer.trim();
        resolve(
          normalized.toLowerCase() === 'q' || normalized.toLowerCase() === 'cancel'
            ? undefined
            : normalized,
        );
      });
      readline.on('close', () => {
        resolve(undefined);
      });
    });
}

function createHiddenPrompt(): (label: string) => Promise<string | undefined> {
  return (label) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return Promise.reject(
        new Error('Interactive sandbox smoke requires a TTY; use the environment mode in CI.'),
      );
    }
    const input = process.stdin;
    const output = process.stdout;
    return new Promise((resolve, reject) => {
      let value = '';
      const cleanup = (): void => {
        input.setRawMode(false);
        input.pause();
        input.removeListener('data', onData);
      };
      const finish = (result: string | undefined): void => {
        cleanup();
        output.write('\n');
        resolve(result);
      };
      const onData = (chunk: Buffer | string): void => {
        const text = chunk.toString();
        for (const character of text) {
          if (character === '\u0003') {
            cleanup();
            output.write('\n');
            reject(cancelled());
            return;
          }
          if (character === '\r' || character === '\n') {
            finish(value.length === 0 ? undefined : value);
            return;
          }
          if (character === '\u007f') {
            value = value.slice(0, -1);
            continue;
          }
          value += character;
        }
      };
      output.write(label);
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
    });
  };
}

function defaultPrompts(): InteractiveSmokePrompts {
  const line = createLinePrompt();
  const hidden = createHiddenPrompt();
  return {
    isInteractive: process.stdin.isTTY && process.stdout.isTTY,
    chooseRecipient: async (count) => {
      const answer = await line(
        `Select an allowlisted recipient [1-${String(count)}] (q cancels): `,
      );
      if (answer === undefined) return undefined;
      const selection = Number.parseInt(answer, 10);
      return Number.isInteger(selection) ? selection : Number.NaN;
    },
    readHidden: hidden,
  };
}

export async function runInteractiveSandboxSmoke(
  options: InteractiveSmokeOptions = {},
): Promise<void> {
  const prompts = options.prompts ?? defaultPrompts();
  if (!prompts.isInteractive) {
    throw new Error('Interactive sandbox smoke requires a TTY; use the environment mode in CI.');
  }

  const environment =
    options.environmentFile ?? loadEnvironmentFile(environmentFilePath(process.cwd(), 'sandbox'));
  const target = resolveEnvironmentTarget(environment);
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const recipients = allowlistedRecipients(environment.AUTH_MAIL_ALLOWLIST, runId);
  const secrets: {
    email: string;
    password: string;
    token: string;
    config?: SmokeConfig;
  } = { email: '', password: '', token: '' };
  try {
    const selection = await prompts.chooseRecipient(recipients.length);
    if (selection === undefined) throw cancelled();
    if (!Number.isInteger(selection) || selection < 1 || selection > recipients.length) {
      throw new Error('Interactive sandbox smoke received an invalid recipient selection.');
    }
    secrets.email = recipients[selection - 1] ?? '';
    if (!isAllowlisted(secrets.email, parseAllowlist(environment.AUTH_MAIL_ALLOWLIST))) {
      throw new Error('Interactive sandbox smoke refused a recipient outside AUTH_MAIL_ALLOWLIST.');
    }

    const passwordInput = await prompts.readHidden('Password (hidden): ');
    if (passwordInput === undefined || passwordInput.length === 0) throw cancelled();
    secrets.password = passwordInput;
    secrets.config = {
      baseUrl: target.workerUrl,
      recipient: { kind: 'exact', email: secrets.email },
      allowLocalhost: false,
      password: secrets.password,
      verificationToken: undefined,
    };
    await runSandboxSmokeWorkflow(secrets.config, {
      fetchImpl: options.fetchImpl,
      requestVerificationToken: async () => {
        const tokenInput = await prompts.readHidden('Verification token (hidden): ');
        if (tokenInput === undefined || tokenInput.length === 0) throw cancelled();
        secrets.token = tokenInput;
        return secrets.token;
      },
    });
  } finally {
    secrets.token = '';
    secrets.password = '';
    secrets.email = '';
    secrets.config = undefined;
  }
}
