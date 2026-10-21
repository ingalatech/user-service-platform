import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (command: string, args: readonly string[]) => Promise<CommandResult>;

export async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export async function getCurrentBranch(execute: CommandExecutor = runCommand): Promise<string> {
  const { stdout } = await execute('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

export interface PrInfo {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url?: string;
}

interface GhPrView {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url?: unknown;
}

export async function getPrForBranch(
  prArg?: string,
  execute: CommandExecutor = runCommand,
): Promise<PrInfo> {
  const args =
    prArg !== undefined
      ? ['pr', 'view', prArg, '--json', 'number,headRefName,baseRefName,headRefOid,url']
      : ['pr', 'view', '--json', 'number,headRefName,baseRefName,headRefOid,url'];
  const { stdout } = await execute('gh', args);
  const parsed = JSON.parse(stdout) as GhPrView;
  return {
    number: parsed.number,
    headRefName: parsed.headRefName,
    baseRefName: parsed.baseRefName,
    headRefOid: parsed.headRefOid,
    ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
  };
}
