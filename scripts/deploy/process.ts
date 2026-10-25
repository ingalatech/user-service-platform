import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResolvedDeployment, DeploymentTarget } from './environment-config.js';
import { startSessionFailureTail, type SessionFailureTailHandle } from './diagnostic-tail.js';

const execFileAsync = promisify(execFile);

export interface ReleaseProcessResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ReleaseProcessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly output?: 'inherit';
}

// The release module's process seam covers captured and inherited child
// commands plus the optional streaming diagnostic child. Tests replace this
// adapter with a deterministic recorder; command selection and ordering stay
// with ReleaseExecution, while terminal confirmation stays with the CLI.
export interface ReleaseProcess {
  run(
    command: string,
    args: readonly string[],
    options?: ReleaseProcessOptions,
  ): Promise<ReleaseProcessResult>;
  readonly startSessionFailureTail?: (
    resolved: ResolvedDeployment,
    configPath: string,
  ) => Promise<SessionFailureTailHandle>;
}

function executable(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function stderrFrom(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

function inheritedProcess(
  command: string,
  args: readonly string[],
  options: ReleaseProcessOptions,
): Promise<ReleaseProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable(command), [...args], {
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ['inherit', 'inherit', 'ignore'],
    });
    child.on('error', () => {
      resolveResult({ exitCode: 1 });
    });
    child.on('close', (code) => {
      resolveResult({ exitCode: code ?? 1 });
    });
  });
}

export function createChildProcessReleaseAdapter(): ReleaseProcess {
  return {
    async run(command, args, options = {}) {
      if (options.output === 'inherit') return inheritedProcess(command, args, options);
      try {
        const result = await execFileAsync(command, [...args], {
          env: options.env ?? process.env,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        });
        return { exitCode: 0, stdout: result.stdout };
      } catch (error: unknown) {
        return { exitCode: 1, stdout: '', stderr: stderrFrom(error) };
      }
    },

    startSessionFailureTail(resolved, configPath) {
      return startSessionFailureTail(resolved, configPath);
    },
  };
}

export function releaseEnvironment(target: DeploymentTarget): NodeJS.ProcessEnv {
  return target.accountId === ''
    ? process.env
    : { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId };
}
