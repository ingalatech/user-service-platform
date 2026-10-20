import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { CommandExecutor } from '../../scripts/review/runner.js';
import {
  RECOVERY_MAX_BYTES_PER_FILE,
  RECOVERY_MAX_TOTAL_BYTES,
  formatRecoverySummary,
  isEligibleRecoveryPath,
  summarizeWorkerLifecycle,
  type ImplementationRecoveryRecord,
} from '../../scripts/review/implementation-recovery.js';

function testRecoveryRecord(
  overrides: Partial<ImplementationRecoveryRecord> & { base: string; branch: string },
): ImplementationRecoveryRecord {
  return {
    version: 1,
    head: 'b'.repeat(40),
    status: 'complete',
    reasons: [],
    counts: { committed: 1, uncommitted: 0, untracked: 0, included: 1, excluded: 0 },
    workflowFiles: [],
    truncated: false,
    combinedPatch: 'diff --git a/src/x.ts b/src/x.ts\n',
    patchTruncated: false,
    untrackedFiles: [],
    untrackedTruncated: false,
    diagnostics: summarizeWorkerLifecycle([]),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Seam under test (ticket #127): bounded implementation recovery evidence.
// Pure allowlist/diagnostic seams first (tracer bullet 1): eligible source
// paths are admitted, secret-bearing/runtime/outside-worktree paths are not,
// and lifecycle metadata carries only allowlisted names/counts/timings.
describe('implementation recovery path eligibility', () => {
  it('admits source, test, docs and config roots', () => {
    expect(isEligibleRecoveryPath('src/features/health/route.ts')).toBe(true);
    expect(isEligibleRecoveryPath('scripts/review/runner.ts')).toBe(true);
    expect(isEligibleRecoveryPath('test/node/agent-ticket.test.ts')).toBe(true);
    expect(isEligibleRecoveryPath('docs/agents/opencode.md')).toBe(true);
    expect(isEligibleRecoveryPath('drizzle/0001_glorious_barracuda.sql')).toBe(true);
    expect(isEligibleRecoveryPath('package.json')).toBe(true);
    // `.env.example` is denied like every other dotenv-shaped file: a failed
    // worker's modified copy may carry secret values, so the committed
    // template being non-secret does not make the worktree copy safe.
    expect(isEligibleRecoveryPath('.env.example')).toBe(false);
    expect(isEligibleRecoveryPath('src/.env.example')).toBe(false);
    expect(isEligibleRecoveryPath('src/nested/.env.example')).toBe(false);
  });

  it('excludes nested env/dev-vars, logs, runtime state and credentials by path', () => {
    expect(isEligibleRecoveryPath('src/.env')).toBe(false);
    expect(isEligibleRecoveryPath('src/nested/.env.local')).toBe(false);
    expect(isEligibleRecoveryPath('config/.dev.vars')).toBe(false);
    expect(isEligibleRecoveryPath('docs/.dev.vars.preview')).toBe(false);
    expect(isEligibleRecoveryPath('src/debug.log')).toBe(false);
    expect(isEligibleRecoveryPath('src/local.sqlite')).toBe(false);
    expect(isEligibleRecoveryPath('src/key.pem')).toBe(false);
    expect(isEligibleRecoveryPath('node_modules/pkg/index.js')).toBe(false);
    expect(isEligibleRecoveryPath('dist/bundle.js')).toBe(false);
    // `.npmrc` commonly carries `_authToken` lines once modified, so even the
    // committed benign copy is not eligible for recovery snapshots.
    expect(isEligibleRecoveryPath('.npmrc')).toBe(false);
    expect(isEligibleRecoveryPath('src/sub/.npmrc')).toBe(false);
  });

  it('excludes children of secret-named directories, not only the basename', () => {
    // The deny rules must apply to every path segment: a directory itself
    // named after a secret/runtime/credential pattern must not admit children.
    expect(isEligibleRecoveryPath('src/.env/foo.ts')).toBe(false);
    expect(isEligibleRecoveryPath('src/nested/.env/settings.ts')).toBe(false);
    expect(isEligibleRecoveryPath('src/nested/.dev.vars/copy.md')).toBe(false);
    expect(isEligibleRecoveryPath('docs/debug.log/notes.md')).toBe(false);
    expect(isEligibleRecoveryPath('src/.npmrc/x.ts')).toBe(false);
    expect(isEligibleRecoveryPath('src/certs/key.pem/readme.md')).toBe(false);
    expect(isEligibleRecoveryPath('src/state/local.sqlite/x.sql')).toBe(false);
  });

  it('excludes workflow files, evidence dirs and outside-worktree paths', () => {
    expect(isEligibleRecoveryPath('.github/workflows/agent-ticket.yml')).toBe(false);
    expect(isEligibleRecoveryPath('.agent-ticket/outcome.json')).toBe(false);
    expect(isEligibleRecoveryPath('.review-cycle/latest.json')).toBe(false);
    expect(isEligibleRecoveryPath('../outside/repo.ts')).toBe(false);
    expect(isEligibleRecoveryPath('/tmp/abs.ts')).toBe(false);
    expect(isEligibleRecoveryPath('')).toBe(false);
  });

  it('keeps legitimate secret-named source files eligible (exclusion is path-based, not word-based)', () => {
    expect(isEligibleRecoveryPath('test/node/deploy-secret-bindings.test.ts')).toBe(true);
    expect(isEligibleRecoveryPath('scripts/provision.ts')).toBe(true);
  });
});

function toolLine(call: string, session: string, tool = 'read'): string {
  return JSON.stringify({
    type: 'tool_use',
    timestamp: 1_700_000_000_000,
    sessionID: session,
    part: {
      id: call,
      sessionID: session,
      messageID: 'msg-1',
      type: 'tool',
      tool,
      state: { status: 'completed', input: {}, metadata: {} },
    },
  });
}

describe('implementation recovery worker lifecycle diagnostics', () => {
  it('retains bounded allowlisted names, counts and timings without payload content', () => {
    const lines = [
      toolLine('c1', 'ses-1', 'read'),
      toolLine('c2', 'ses-1', 'edit'),
      JSON.stringify({ type: 'step_start', timestamp: 1_700_000_000_100 }),
      JSON.stringify({ type: 'step_finish', timestamp: 1_700_000_001_100 }),
    ];
    const summary = summarizeWorkerLifecycle(lines);

    expect(summary.totalLines).toBe(4);
    expect(summary.eventCounts.tool_use).toBe(2);
    expect(summary.eventCounts.step_start).toBe(1);
    expect(summary.toolCounts.read).toBe(1);
    expect(summary.toolCounts.edit).toBe(1);
    expect(summary.status).toBe('complete');
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('sk-ant-');
    expect(serialized).not.toContain('ghp_');
  });

  it('excludes sentinel payloads in text, reasoning, inputs, outputs and bash commands', () => {
    const sentinel = 'sk-ant-sentinel-secret-value';
    const lines = [
      JSON.stringify({ type: 'text', part: { text: sentinel } }),
      JSON.stringify({ type: 'reasoning', part: { text: sentinel } }),
      JSON.stringify({
        type: 'tool_use',
        timestamp: 1_700_000_000_000,
        sessionID: 'ses-1',
        part: {
          id: 'c-bash',
          sessionID: 'ses-1',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: `echo ${sentinel}` }, metadata: {} },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        timestamp: 1_700_000_000_000,
        sessionID: 'ses-1',
        part: {
          id: 'c-read',
          sessionID: 'ses-1',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: '/repo/src/a.ts' },
            output: sentinel,
            metadata: {},
          },
        },
      }),
    ];
    const summary = summarizeWorkerLifecycle(lines);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('echo');
    // The bash tool name itself is still useful bounded metadata.
    expect(summary.toolCounts.bash).toBe(1);
  });

  it('fails closed on unknown/malformed records with honest coverage metadata', () => {
    const summary = summarizeWorkerLifecycle(['not json at all', '{"type":"mystery-event"}']);

    expect(summary.status).toBe('incomplete');
    expect(summary.malformed).toBeGreaterThan(0);
    expect(summary.reasons.join(' ')).toMatch(/malformed|unknown/i);
  });
});

describe('implementation recovery summary surface', () => {
  it('exposes only fixed safe summaries without patch content', () => {
    const summary = formatRecoverySummary(
      testRecoveryRecord({
        base: 'a'.repeat(40),
        branch: 'ticket/127-x',
        counts: { committed: 1, uncommitted: 1, untracked: 1, included: 3, excluded: 2 },
        combinedPatch: 'diff --git secret-patch-content\n',
        untrackedFiles: [{ path: 'src/new.ts', content: 'secret-patch-content' }],
      }),
    );

    expect(summary).toMatch(/recovery/i);
    expect(summary).toContain('complete');
    expect(summary).not.toContain('secret-patch-content');
  });

  it('truncates an oversized tracked patch at the byte bound with honest metadata', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const oversized = 'x'.repeat(RECOVERY_MAX_TOTAL_BYTES + 100);
    const execute: CommandExecutor = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git rev-parse HEAD') {
        return Promise.resolve({ stdout: `${head}\n`, stderr: '' });
      }
      if (key === 'git rev-parse --abbrev-ref HEAD') {
        return Promise.resolve({ stdout: 'ticket/127-x\n', stderr: '' });
      }
      if (key === `git diff --name-only --no-renames ${base}..${head} --`) {
        return Promise.resolve({ stdout: 'src/big.ts\n', stderr: '' });
      }
      if (key === 'git status --porcelain -uall') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (key.startsWith(`git diff ${base} --`)) {
        return Promise.resolve({ stdout: oversized, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
    const record = await captureImplementationRecovery(
      { base, branch: 'ticket/127-x', lines: [] },
      { execute },
    );

    expect(record.combinedPatch).toHaveLength(RECOVERY_MAX_TOTAL_BYTES);
    expect(record.patchTruncated).toBe(true);
    expect(record.truncated).toBe(true);
    expect(record.status).toBe('incomplete');
    expect(record.reasons.join(' ')).toMatch(/byte bound/);
  });

  it('truncates an oversized untracked file at the per-file bound', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-bounds-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'new.ts'), 'y'.repeat(RECOVERY_MAX_BYTES_PER_FILE + 10));
      const base = 'a'.repeat(40);
      const head = 'b'.repeat(40);
      const execute: CommandExecutor = (command, args) => {
        const key = `${command} ${args.join(' ')}`;
        if (key === 'git rev-parse HEAD') {
          return Promise.resolve({ stdout: `${head}\n`, stderr: '' });
        }
        if (key === 'git rev-parse --abbrev-ref HEAD') {
          return Promise.resolve({ stdout: 'ticket/127-x\n', stderr: '' });
        }
        if (key === `git diff --name-only --no-renames ${base}..${head} --`) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (key === 'git status --porcelain -uall') {
          return Promise.resolve({ stdout: '?? src/new.ts\n', stderr: '' });
        }
        throw new Error(`unexpected command in test script: ${key}`);
      };
      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute },
      );

      expect(record.untrackedFiles).toHaveLength(1);
      expect(record.untrackedFiles[0]?.content).toHaveLength(RECOVERY_MAX_BYTES_PER_FILE);
      expect(record.untrackedTruncated).toBe(true);
      expect(record.truncated).toBe(true);
      expect(record.status).toBe('incomplete');
      expect(record.reasons.join(' ')).toMatch(/truncated at bound/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces UTF-8 byte budgets for multibyte content without splitting characters', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-multibyte-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      // `é` is 1 UTF-16 unit but 2 UTF-8 bytes: 20_000 units exceed the
      // 32 KiB byte bound while staying under the old unit bound.
      writeFileSync(join(dir, 'src', 'new.ts'), 'é'.repeat(20_000));
      const base = 'a'.repeat(40);
      const head = 'b'.repeat(40);
      const execute: CommandExecutor = (command, args) => {
        const key = `${command} ${args.join(' ')}`;
        if (key === 'git rev-parse HEAD') {
          return Promise.resolve({ stdout: `${head}\n`, stderr: '' });
        }
        if (key === 'git rev-parse --abbrev-ref HEAD') {
          return Promise.resolve({ stdout: 'ticket/127-x\n', stderr: '' });
        }
        if (key === `git diff --name-only --no-renames ${base}..${head} --`) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (key === 'git status --porcelain -uall') {
          return Promise.resolve({ stdout: '?? src/new.ts\n', stderr: '' });
        }
        throw new Error(`unexpected command in test script: ${key}`);
      };
      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute },
      );

      expect(record.untrackedFiles).toHaveLength(1);
      const content = record.untrackedFiles[0]?.content ?? '';
      // Actual UTF-8 bytes, not UTF-16 units, stay within the per-file bound.
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(RECOVERY_MAX_BYTES_PER_FILE);
      expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(0);
      // Round-trip: no split surrogate or replacement character from truncation.
      expect(content).not.toContain('�');
      expect(/^é+$/u.test(content)).toBe(true);
      expect(record.untrackedTruncated).toBe(true);
      expect(record.status).toBe('incomplete');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates a multibyte tracked patch at the UTF-8 total byte bound', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    // Each `é` is 2 UTF-8 bytes: the patch exceeds 256 KiB in bytes while the
    // old unit-length check would need twice as many characters.
    const oversized = 'é'.repeat(RECOVERY_MAX_TOTAL_BYTES);
    const execute: CommandExecutor = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git rev-parse HEAD') {
        return Promise.resolve({ stdout: `${head}\n`, stderr: '' });
      }
      if (key === 'git rev-parse --abbrev-ref HEAD') {
        return Promise.resolve({ stdout: 'ticket/127-x\n', stderr: '' });
      }
      if (key === `git diff --name-only --no-renames ${base}..${head} --`) {
        return Promise.resolve({ stdout: 'src/big.ts\n', stderr: '' });
      }
      if (key === 'git status --porcelain -uall') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (key.startsWith(`git diff ${base} --`)) {
        return Promise.resolve({ stdout: oversized, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
    const record = await captureImplementationRecovery(
      { base, branch: 'ticket/127-x', lines: [] },
      { execute },
    );

    expect(Buffer.byteLength(record.combinedPatch, 'utf8')).toBeLessThanOrEqual(
      RECOVERY_MAX_TOTAL_BYTES,
    );
    expect(record.combinedPatch).not.toContain('�');
    expect(record.patchTruncated).toBe(true);
    expect(record.status).toBe('incomplete');
  });

  it('times out a stalled untracked read instead of hanging terminal reporting', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-stall-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'new.ts'), 'export const x = 1;\n');
      const base = 'a'.repeat(40);
      const head = 'b'.repeat(40);
      const execute: CommandExecutor = (command, args) => {
        const key = `${command} ${args.join(' ')}`;
        if (key === 'git rev-parse HEAD') {
          return Promise.resolve({ stdout: `${head}\n`, stderr: '' });
        }
        if (key === 'git rev-parse --abbrev-ref HEAD') {
          return Promise.resolve({ stdout: 'ticket/127-x\n', stderr: '' });
        }
        if (key === `git diff --name-only --no-renames ${base}..${head} --`) {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (key === 'git status --porcelain -uall') {
          return Promise.resolve({ stdout: '?? src/new.ts\n', stderr: '' });
        }
        throw new Error(`unexpected command in test script: ${key}`);
      };
      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        {
          execute,
          // Never-resolving read simulates a stalled filesystem; capture must
          // degrade to honest incomplete metadata within its finite deadline.
          readFile: () => new Promise<string>(() => undefined),
          readTimeoutMs: 50,
        },
      );

      expect(record.untrackedFiles).toEqual([]);
      expect(record.status).toBe('incomplete');
      expect(record.reasons.join(' ')).toMatch(/unreadable/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'recovery-test']);
  git(dir, ['config', 'user.email', 'recovery-test@example.com']);
}

function realExecutor(cwd: string): CommandExecutor {
  return (command, args) =>
    new Promise((resolve, reject) => {
      try {
        const stdout = execFileSync(command, [...args], { cwd, encoding: 'utf8' });
        resolve({ stdout, stderr: '' });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
}

describe('implementation recovery portable snapshot (real temporary Git worktree)', () => {
  it('captures the actual failed-worktree state and reconstructs it on a clean worktree', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-worktree-'));
    try {
      initRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'tracked.ts'), 'export const v = 1;\n');
      writeFileSync(join(dir, 'src', 'deleted.ts'), 'export const gone = true;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-qm', 'base']);
      const base = git(dir, ['rev-parse', 'HEAD']).trim();

      // Simulated failed worker: one local commit + uncommitted edit +
      // deletion + one eligible untracked source file.
      writeFileSync(join(dir, 'src', 'tracked.ts'), 'export const v = 2;\n');
      git(dir, ['commit', '-qam', 'worker commit']);
      writeFileSync(join(dir, 'src', 'tracked.ts'), 'export const v = 3;\n');
      rmSync(join(dir, 'src', 'deleted.ts'));
      writeFileSync(join(dir, 'src', 'added.ts'), 'export const added = true;\n');

      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute: realExecutor(dir) },
      );

      expect(record.base).toBe(base);
      expect(record.head).not.toBe(base);
      expect(record.head).toBe(git(dir, ['rev-parse', 'HEAD']).trim());
      expect(record.counts.committed).toBeGreaterThan(0);
      expect(record.counts.uncommitted).toBeGreaterThan(0);
      expect(record.counts.untracked).toBe(1);
      expect(record.status).not.toBe('unavailable');

      // Reconstruction on a separate clean worktree based on the recorded
      // base proves portability rather than asserting serialized strings.
      const clean = mkdtempSync(join(tmpdir(), 'recovery-clean-'));
      try {
        initRepo(clean);
        mkdirSync(join(clean, 'src'), { recursive: true });
        writeFileSync(join(clean, 'src', 'tracked.ts'), 'export const v = 1;\n');
        writeFileSync(join(clean, 'src', 'deleted.ts'), 'export const gone = true;\n');
        git(clean, ['add', '.']);
        git(clean, ['commit', '-qm', 'base']);
        if (record.combinedPatch !== '') {
          const patchPath = join(tmpdir(), `recovery-${String(Date.now())}.patch`);
          writeFileSync(patchPath, record.combinedPatch);
          try {
            git(clean, ['apply', patchPath]);
          } finally {
            rmSync(patchPath, { force: true });
          }
        }
        for (const file of record.untrackedFiles) {
          writeFileSync(join(clean, file.path), file.content);
        }
        expect(readFileSync(join(clean, 'src', 'tracked.ts'), 'utf8')).toContain('v = 3');
        expect(readFileSync(join(clean, 'src', 'added.ts'), 'utf8')).toContain('added');
        let deletedExists = true;
        try {
          readFileSync(join(clean, 'src', 'deleted.ts'));
        } catch {
          deletedExists = false;
        }
        expect(deletedExists).toBe(false);
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures eligible untracked files inside a wholly-new directory', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-newdir-'));
    try {
      initRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'tracked.ts'), 'export const v = 1;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-qm', 'base']);
      const base = git(dir, ['rev-parse', 'HEAD']).trim();

      // Simulated failed worker: a brand-new feature-slice directory with
      // two eligible untracked source files (git `-u normal` reports this as
      // a single `dir/` entry; recovery must list individual files via `-uall`).
      mkdirSync(join(dir, 'src', 'new-slice'), { recursive: true });
      writeFileSync(join(dir, 'src', 'new-slice', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'src', 'new-slice', 'b.ts'), 'export const b = 2;\n');

      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute: realExecutor(dir) },
      );

      const paths = record.untrackedFiles.map((file) => file.path).sort();
      expect(paths).toEqual(['src/new-slice/a.ts', 'src/new-slice/b.ts']);
      expect(record.counts.untracked).toBe(2);
      expect(record.status).toBe('complete');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes sentinel secrets, runtime state and symlinks without Git mutation', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-secrets-'));
    try {
      initRepo(dir);
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'src', 'tracked.ts'), 'export const v = 1;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-qm', 'base']);
      const base = git(dir, ['rev-parse', 'HEAD']).trim();

      const sentinel = 'sk-ant-sentinel-secret-value';
      writeFileSync(join(dir, 'src', '.env'), `TOKEN=${sentinel}\n`);
      writeFileSync(join(dir, 'src', 'nested', '.dev.vars.preview'), `KEY=${sentinel}\n`);
      writeFileSync(join(dir, 'src', 'debug.log'), sentinel);
      // Eligible source stays exactly recoverable; it carries only a benign
      // marker so the sentinel assertion below proves path-based exclusion
      // (secret-bearing paths) rather than content censoring.
      writeFileSync(join(dir, 'src', 'real.ts'), 'export const real = true;\n');
      symlinkSync('/etc/hostname', join(dir, 'src', 'linked.ts'));

      const seen: string[] = [];
      const watching: CommandExecutor = (command, args) => {
        seen.push(`${command} ${args.join(' ')}`);
        return realExecutor(dir)(command, args);
      };
      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute: watching },
      );
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(sentinel);
      expect(record.untrackedFiles.some((file) => file.path.endsWith('.env'))).toBe(false);
      expect(record.untrackedFiles.some((file) => file.path.endsWith('.log'))).toBe(false);
      expect(record.untrackedFiles.some((file) => file.path.includes('linked'))).toBe(false);
      for (const invocation of seen) {
        expect(invocation).not.toMatch(/push|commit|stage|reset|clean|checkout|merge/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes a tracked worker-modified root .env.example and nested variants', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-dotenv-'));
    try {
      initRepo(dir);
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'src', 'tracked.ts'), 'export const v = 1;\n');
      // Committed non-secret template, as in the real repository.
      writeFileSync(join(dir, '.env.example'), 'PLACEHOLDER=example\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-qm', 'base']);
      const base = git(dir, ['rev-parse', 'HEAD']).trim();

      // Failed worker modifies the tracked template with a sentinel and adds
      // nested dotenv variants: none of these copies is safe to publish.
      const sentinel = 'sk-ant-sentinel-secret-value';
      writeFileSync(join(dir, '.env.example'), `TOKEN=${sentinel}\n`);
      writeFileSync(join(dir, 'src', 'nested', '.env.example'), `KEY=${sentinel}\n`);
      writeFileSync(join(dir, 'src', 'nested', '.env.local'), `KEY=${sentinel}\n`);

      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute: realExecutor(dir) },
      );
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(sentinel);
      expect(record.combinedPatch).not.toContain(sentinel);
      expect(record.untrackedFiles.some((file) => file.path.includes('.env'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decodes git C-quoted octal status paths instead of dropping eligible source', async () => {
    const { parseRecoveryStatus } = await import('../../scripts/review/implementation-recovery.js');
    // `é` (U+00E9) is quoted by git as octal UTF-8 bytes when core.quotepath is on.
    const parsed = parseRecoveryStatus('?? "src/\\303\\251clair.ts"\n');
    expect(parsed.untracked).toEqual(['src/éclair.ts']);
  });

  it('keeps both sides of a porcelain rename so the deletion is not lost', async () => {
    const { parseRecoveryStatus } = await import('../../scripts/review/implementation-recovery.js');
    const parsed = parseRecoveryStatus('R  src/old.ts -> src/new.ts\n');
    expect(parsed.tracked).toContain('src/old.ts');
    expect(parsed.tracked).toContain('src/new.ts');
  });

  it('reconstructs a committed rename without leaving the old path behind', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-rename-'));
    try {
      initRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'old.ts'), 'export const v = 1;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-qm', 'base']);
      const base = git(dir, ['rev-parse', 'HEAD']).trim();

      // Simulated failed worker: pure rename committed on the ticket branch.
      git(dir, ['mv', 'src/old.ts', 'src/new.ts']);
      git(dir, ['commit', '-qm', 'worker rename']);

      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute: realExecutor(dir) },
      );

      const clean = mkdtempSync(join(tmpdir(), 'recovery-rename-clean-'));
      try {
        initRepo(clean);
        mkdirSync(join(clean, 'src'), { recursive: true });
        writeFileSync(join(clean, 'src', 'old.ts'), 'export const v = 1;\n');
        git(clean, ['add', '.']);
        git(clean, ['commit', '-qm', 'base']);
        if (record.combinedPatch !== '') {
          const patchPath = join(tmpdir(), `recovery-rename-${String(Date.now())}.patch`);
          writeFileSync(patchPath, record.combinedPatch);
          try {
            git(clean, ['apply', patchPath]);
          } finally {
            rmSync(patchPath, { force: true });
          }
        }
        let oldExists = true;
        try {
          readFileSync(join(clean, 'src', 'old.ts'));
        } catch {
          oldExists = false;
        }
        expect(oldExists).toBe(false);
        expect(readFileSync(join(clean, 'src', 'new.ts'), 'utf8')).toContain('v = 1');
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports disk-level rejections with reasons and excluded counts, not complete', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-disk-'));
    try {
      initRepo(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'tracked.ts'), 'export const v = 1;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-qm', 'base']);
      const base = git(dir, ['rev-parse', 'HEAD']).trim();

      // One eligible untracked source plus one path-eligible symlink leaf that
      // fails the disk check (never followed).
      writeFileSync(join(dir, 'src', 'real.ts'), 'export const real = true;\n');
      symlinkSync('/etc/hostname', join(dir, 'src', 'linked.ts'));

      const record = await captureImplementationRecovery(
        { base, branch: 'ticket/127-x', lines: [], worktreeRoot: dir },
        { execute: realExecutor(dir) },
      );
      expect(record.untrackedFiles.some((file) => file.path === 'src/real.ts')).toBe(true);
      expect(record.untrackedFiles.some((file) => file.path.includes('linked'))).toBe(false);
      // The symlink was listed by git status but could not be captured: it
      // must be counted and explained, never silently dropped as complete.
      expect(record.counts.excluded).toBeGreaterThanOrEqual(1);
      expect(record.status).toBe('incomplete');
      expect(record.reasons.join(' ')).toMatch(/excluded|ineligible|symlink|disk/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds snapshots and preserves the original failure on command/filesystem errors', async () => {
    const { captureImplementationRecovery } =
      await import('../../scripts/review/implementation-recovery.js');
    const failing: CommandExecutor = () => Promise.reject(new Error('git gone'));
    const record = await captureImplementationRecovery(
      { base: 'a'.repeat(40), branch: 'ticket/127-x', lines: ['not json'] },
      { execute: failing, readFile: () => Promise.reject(new Error('disk gone')) },
    );

    expect(record.status).toBe('incomplete');
    expect(record.reasons.join(' ')).toMatch(/unavailable|malformed|HEAD/i);
    expect(record.combinedPatch).toBe('');
    expect(record.untrackedFiles).toEqual([]);
  });
});

describe('implementation recovery ticket-flow wiring', () => {
  const MAIN_HEAD = 'a'.repeat(40);
  const ISSUE_VIEW = JSON.stringify({
    number: 10,
    title: 'Register and verify an email identity',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
  });

  function wiringScript(): Record<string, unknown> {
    return {
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
      'gh issue view 10 --json number,title,state,labels': `${ISSUE_VIEW}\n`,
      'git show-ref --verify refs/heads/ticket/10-register-and-verify-an-email-identity': new Error(
        "fatal: 'refs/heads/ticket/10-register-and-verify-an-email-identity' - not a valid ref",
      ),
      'git checkout -b ticket/10-register-and-verify-an-email-identity': '',
    };
  }

  function wiringExecute(script: Record<string, unknown>): CommandExecutor {
    return (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      const key = `${command} ${args.join(' ')}`;
      const scripted = script[key];
      if (scripted instanceof Error) {
        return Promise.reject(scripted);
      }
      if (typeof scripted === 'string') {
        return Promise.resolve({ stdout: scripted, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
  }

  it('embeds the actual failed-worktree recovery in a TIMEOUT without changing the outcome', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const { WorkerTimeoutError } = await import('../../scripts/review/worker-timeout.js');
    const { summarizeWorkerLifecycle } =
      await import('../../scripts/review/implementation-recovery.js');
    const actualHead = 'b'.repeat(40);
    const captured: { base: string; branch: string }[] = [];
    const outcomes: { outcome: string; stage: string; recovery?: unknown }[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await runAgentTicket('10', {
        execute: wiringExecute(wiringScript()),
        runWorker: () =>
          Promise.reject(new WorkerTimeoutError('implement', 1_800_000, 'opencode run')),
        captureRecovery: (input) => {
          captured.push({ base: input.base, branch: input.branch });
          return Promise.resolve(
            testRecoveryRecord({
              base: input.base,
              branch: input.branch,
              head: actualHead,
              diagnostics: summarizeWorkerLifecycle(input.lines),
            }),
          );
        },
        recordOutcome: (record) => {
          outcomes.push({
            outcome: record.outcome,
            stage: record.stage,
            recovery: record.recovery,
          });
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(true);
      expect(result.failedStage).toBe('implement');
      // The capture ran against the recorded base on the ticket branch, and
      // the outcome carries the actual failed-worktree HEAD — never the
      // start HEAD presented as proof of no progress.
      expect(captured).toEqual([
        { base: MAIN_HEAD, branch: 'ticket/10-register-and-verify-an-email-identity' },
      ]);
      expect(result.recovery?.head).toBe(actualHead);
      expect(outcomes.at(-1)).toMatchObject({ outcome: 'TIMEOUT', stage: 'implementation' });
      const recorded = outcomes.at(-1)?.recovery as { head?: string } | undefined;
      expect(recorded?.head).toBe(actualHead);
      // Console carries only the fixed safe summary; patch content stays in
      // the local outcome record.
      const errors = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(errors).toContain('implementation recovery');
      expect(errors).not.toContain('diff --git');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retains unavailable recovery without capturing when worker termination is unconfirmed', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const { WorkerTimeoutError } = await import('../../scripts/review/worker-timeout.js');
    const outcomes: { outcome: string; stage: string; recovery?: unknown }[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let captureCalls = 0;
      const result = await runAgentTicket('10', {
        execute: wiringExecute(wiringScript()),
        runWorker: () =>
          Promise.reject(new WorkerTimeoutError('implement', 1_800_000, 'opencode run', false)),
        captureRecovery: () => {
          captureCalls += 1;
          return Promise.reject(new Error('must not capture a still-writing worktree'));
        },
        recordOutcome: (record) => {
          outcomes.push({
            outcome: record.outcome,
            stage: record.stage,
            recovery: record.recovery,
          });
        },
      });

      // The original TIMEOUT is preserved, but no worktree read was attempted:
      // the record is honest unavailable evidence, not a torn snapshot.
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(true);
      expect(captureCalls).toBe(0);
      expect(result.recovery?.status).toBe('unavailable');
      expect(result.recovery?.reasons.join(' ') ?? '').toMatch(/termination/i);
      expect(outcomes.at(-1)).toMatchObject({ outcome: 'TIMEOUT', stage: 'implementation' });
      expect(outcomes.at(-1)?.recovery).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps BLOCKED semantics and a recovery next action on implement failure', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const outcomes: { outcome: string; actionRequired?: string; recovery?: unknown }[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await runAgentTicket('10', {
        execute: wiringExecute(wiringScript()),
        runWorker: () => Promise.reject(new Error('model blew up')),
        captureRecovery: (input) =>
          Promise.resolve(
            testRecoveryRecord({
              base: input.base,
              branch: input.branch,
              head: '(unknown)',
              status: 'unavailable',
              reasons: ['actual HEAD unavailable'],
              counts: { committed: 0, uncommitted: 0, untracked: 0, included: 0, excluded: 0 },
              combinedPatch: '',
              diagnostics: summarizeWorkerLifecycle([]),
            }),
          ),
        recordOutcome: (record) => {
          outcomes.push({
            outcome: record.outcome,
            actionRequired: record.actionRequired,
            recovery: record.recovery,
          });
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.failedStage).toBe('implement');
      expect(result.timedOut).toBeUndefined();
      expect(outcomes.at(-1)?.outcome).toBe('BLOCKED');
      expect(outcomes.at(-1)?.recovery).toBeDefined();
      // The operator action distinguishes recovery from a blind rerun.
      expect(outcomes.at(-1)?.actionRequired ?? '').toMatch(/recovery|reapply/i);
      expect(outcomes.at(-1)?.actionRequired ?? '').not.toMatch(/rerun \/agent-ticket once/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retains unavailable recovery without capturing when plain failure termination is unconfirmed', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const outcomes: { outcome: string; stage: string; recovery?: unknown }[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let captureCalls = 0;
      const failure = Object.assign(new Error('opencode run --auto failed (exit 1)'), {
        terminated: false,
      });
      const result = await runAgentTicket('10', {
        execute: wiringExecute(wiringScript()),
        runWorker: () => Promise.reject(failure),
        captureRecovery: () => {
          captureCalls += 1;
          return Promise.reject(new Error('must not capture a still-writing worktree'));
        },
        recordOutcome: (record) => {
          outcomes.push({
            outcome: record.outcome,
            stage: record.stage,
            recovery: record.recovery,
          });
        },
      });

      // The original BLOCKED is preserved, but no worktree read was attempted:
      // the record is honest unavailable evidence, not a torn snapshot.
      expect(result.exitCode).toBe(1);
      expect(result.failedStage).toBe('implement');
      expect(result.timedOut).toBeUndefined();
      expect(captureCalls).toBe(0);
      expect(result.recovery?.status).toBe('unavailable');
      expect(result.recovery?.reasons.join(' ') ?? '').toMatch(/termination/i);
      expect(outcomes.at(-1)).toMatchObject({ outcome: 'BLOCKED', stage: 'implementation' });
      expect(outcomes.at(-1)?.recovery).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('preserves the original failure when the capture itself throws', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const outcomes: { outcome: string; recovery?: unknown }[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await runAgentTicket('10', {
        execute: wiringExecute(wiringScript()),
        runWorker: () => Promise.reject(new Error('model blew up')),
        captureRecovery: () => Promise.reject(new Error('disk gone')),
        recordOutcome: (record) => {
          outcomes.push({ outcome: record.outcome, recovery: record.recovery });
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.failedStage).toBe('implement');
      expect(outcomes.at(-1)?.outcome).toBe('BLOCKED');
      expect(outcomes.at(-1)?.recovery).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('leaves successful implementation behavior unchanged (no recovery field)', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const NEXT_HEAD = 'b'.repeat(40);
    const script = wiringScript();
    const outcomes: { outcome: string; recovery?: unknown }[] = [];
    let headCalls = 0;
    const execute: CommandExecutor = (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (command === 'gh' && args[0] === 'repo') {
        return Promise.resolve({ stdout: 'o/r\n', stderr: '' });
      }
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      return wiringExecute({
        ...script,
        'npm run lint': '',
        'npm run format:check': '',
        'npm run typecheck': '',
        'npm run openapi:check': '',
        'npm run test': '',
        'npm run test:harness': '',
        [`git diff --name-only ${MAIN_HEAD}...${NEXT_HEAD} -- .github/workflows/`]: '',
        'git push -u origin ticket/10-register-and-verify-an-email-identity': '',
        'gh pr create --base main --head ticket/10-register-and-verify-an-email-identity --draft --title Register and verify an email identity (#10) --body Automated implementation of #10 via `npm run agent:ticket`.':
          'https://github.com/o/r/pull/42\n',
        'gh pr view --json number,headRefName,baseRefName,headRefOid,url':
          '{"number":42,"headRefName":"ticket/10-register-and-verify-an-email-identity","baseRefName":"main","headRefOid":"bbb","url":"https://github.com/o/r/pull/42"}\n',
      })(command, args);
    };
    const result = await runAgentTicket('10', {
      execute,
      runWorker: (command) => {
        if (command === 'npm') {
          return Promise.resolve({
            stdout: 'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
      recordOutcome: (record) => {
        outcomes.push({ outcome: record.outcome, recovery: record.recovery });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(outcomes.at(-1)?.outcome).toBe('READY');
    expect(outcomes.at(-1)?.recovery).toBeUndefined();
  });

  it('persists the recovery payload through the local outcome record', async () => {
    const { writeAgentTicketOutcome } = await import('../../scripts/agent/ticket-flow.js');
    const written = new Map<string, string>();
    await writeAgentTicketOutcome(
      {
        outcome: 'TIMEOUT',
        stage: 'implementation',
        reason: 'implement timed out',
        recovery: testRecoveryRecord({ base: MAIN_HEAD, branch: 'ticket/10-x' }),
      },
      {
        mkdir: () => Promise.resolve(),
        writeFile: (path: string, contents: string) => {
          written.set(path, contents);
          return Promise.resolve();
        },
      },
    );

    const raw = written.get('.agent-ticket/outcome.json') ?? '';
    expect(JSON.parse(raw)).toMatchObject({ outcome: 'TIMEOUT', recovery: { version: 1 } });
    expect(raw).toContain('diff --git');
    // The outcome record stays in the failed isolated worktree for local
    // operator inspection and reapplication.
  });

  it('keeps recovery guidance on the active local contract', () => {
    const guidance = readFileSync('docs/agents/implementation-recovery.md', 'utf8');
    const implementation = readFileSync('scripts/review/implementation-recovery.ts', 'utf8');

    expect(guidance).toContain('failed isolated worktree for the operator');
    expect(guidance).toContain('Keep the failed isolated worktree intact');
    expect(guidance).not.toContain(
      "Download `.agent-ticket/outcome.json` from the failed run's artifacts",
    );
    expect(guidance).not.toContain('already-uploaded `.agent-ticket/outcome.json` artifact');
    expect(implementation).toContain(
      'record stays in the local\n// `.agent-ticket/outcome.json` outcome file',
    );
    expect(implementation).not.toContain('uploaded `.agent-ticket/outcome.json` artifact');
  });
});

describe('implementation recovery symlink guard', () => {
  it('never follows symlinks when resolving eligibility on disk', async () => {
    const { isEligibleRecoveryFile } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-symlink-'));
    try {
      const outside = join(dir, 'outside.ts');
      writeFileSync(outside, 'export const x = 1;\n');
      const linkDir = join(dir, 'src');
      mkdirSync(linkDir, { recursive: true });
      symlinkSync(outside, join(linkDir, 'linked.ts'));
      await expect(isEligibleRecoveryFile(join(linkDir, 'linked.ts'), dir)).resolves.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects files under an intermediate symlinked directory', async () => {
    const { isEligibleRecoveryFile } =
      await import('../../scripts/review/implementation-recovery.js');
    const dir = mkdtempSync(join(tmpdir(), 'recovery-symlink-dir-'));
    try {
      const outsideDir = mkdtempSync(join(tmpdir(), 'recovery-outside-'));
      try {
        writeFileSync(join(outsideDir, 'evil.ts'), 'export const evil = 1;\n');
        const srcDir = join(dir, 'src');
        mkdirSync(srcDir, { recursive: true });
        symlinkSync(outsideDir, join(srcDir, 'linkdir'));
        await expect(isEligibleRecoveryFile(join(srcDir, 'linkdir', 'evil.ts'), dir)).resolves.toBe(
          false,
        );
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
