import type {
  ReleaseProcess,
  ReleaseProcessOptions,
  ReleaseProcessResult,
} from '../../scripts/deploy/process.js';
import type { ResolvedDeployment } from '../../scripts/deploy/environment-config.js';
import type { SessionFailureTailHandle } from '../../scripts/deploy/diagnostic-tail.js';

export interface RecordedProcessCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: ReleaseProcessOptions;
}

export interface TestReleaseProcessOptions {
  readonly respond?: (
    call: RecordedProcessCall,
  ) => ReleaseProcessResult | undefined | Promise<ReleaseProcessResult | undefined>;
  readonly startSessionFailureTail?: (
    resolved: ResolvedDeployment,
    configPath: string,
  ) => SessionFailureTailHandle | Promise<SessionFailureTailHandle>;
}

// Deterministic process adapter for release-execution tests. It records only
// process effects and lets each test provide the Cloudflare/Node outcome it
// needs; it never launches commands or inherits credentials.
export class TestReleaseProcess implements ReleaseProcess {
  readonly calls: RecordedProcessCall[] = [];
  readonly commands: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];

  constructor(private readonly options: TestReleaseProcessOptions = {}) {}

  async run(
    command: string,
    args: readonly string[],
    options?: ReleaseProcessOptions,
  ): Promise<ReleaseProcessResult> {
    const call: RecordedProcessCall = {
      command,
      args: [...args],
      ...(options === undefined ? {} : { options }),
    };
    this.calls.push(call);
    this.commands.push({
      command,
      args: [...args],
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    const customized = await this.options.respond?.(call);
    if (customized !== undefined) return customized;
    if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: '' };
    if (command === 'git' && args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n' };
    }
    if (command === 'git' && args[0] === 'branch') return { exitCode: 0, stdout: 'test/branch\n' };
    if (command === 'npx' && args.includes('deployments') && args.includes('list')) {
      return { exitCode: 0, stdout: '[]' };
    }
    if (command === 'npx' && args.includes('versions') && args.includes('list')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: 'existing-v1', metadata: { created_on: '2026-10-20T12:00:00Z' } },
        ]),
      };
    }
    return { exitCode: 0, stdout: '' };
  }

  async startSessionFailureTail(
    resolved: ResolvedDeployment,
    configPath: string,
  ): Promise<SessionFailureTailHandle> {
    const tail = await this.options.startSessionFailureTail?.(resolved, configPath);
    return (
      tail ?? {
        exitedBeforeSmoke: false,
        isLive: () => false,
        peekLines: () => [],
        stop: () => Promise.resolve([]),
      }
    );
  }
}
