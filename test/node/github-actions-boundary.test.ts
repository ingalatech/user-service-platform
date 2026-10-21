import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

describe('GitHub Actions CI-only boundary (issue #171)', () => {
  const workflowsDir = '.github/workflows';

  it('contains only the deterministic CI workflow', () => {
    expect(
      readdirSync(workflowsDir)
        .filter((file) => /\.ya?ml$/.test(file))
        .sort(),
    ).toEqual(['ci.yml']);
  });

  it('runs on main pushes and pull requests with read-only repository access', () => {
    const workflow = parseYaml(readFileSync(`${workflowsDir}/ci.yml`, 'utf8')) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, string>;
    };

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['pull_request', 'push']);
    expect(workflow.on?.push).toEqual({ branches: ['main'] });
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('runs the repository quality and generated-contract checks', () => {
    const workflow = readFileSync(`${workflowsDir}/ci.yml`, 'utf8');

    for (const command of [
      'npm ci',
      'npm run lint',
      'npm run format:check',
      'npm run typecheck',
      'npm run openapi:check',
      'npm run test',
      'npm run test:harness',
    ]) {
      expect(workflow).toContain(command);
    }
  });

  it('does not run agents, releases, deployment commands, or require runtime credentials', () => {
    const workflow = readFileSync(`${workflowsDir}/ci.yml`, 'utf8');

    expect(workflow).not.toMatch(/opencode|agent:ticket|agent:fix-cycle|review:cycle/i);
    expect(workflow).not.toMatch(
      /wrangler\s+(deploy|versions|deployments)|npm run (deploy|promote)/i,
    );
    expect(workflow).not.toMatch(/secrets\.|CLOUDFLARE|D1_DATABASE_ID|BETTER_AUTH_SECRET/i);
  });

  it('documents local isolated agent work and explicit local releases', () => {
    const opencode = readFileSync('docs/agents/opencode.md', 'utf8');
    const projectState = readFileSync('docs/agents/project-state.md', 'utf8');
    const adr = readFileSync(
      'docs/adr/0008-environment-isolation-and-release-promotion.md',
      'utf8',
    );
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');

    expect(opencode).toMatch(/OpenCode is used from an isolated ticket worktree/);
    expect(projectState).toMatch(/GitHub Actions contains only/);
    expect(adr).toMatch(/Sandbox and production releases are explicit local operator actions/);
    expect(runbook).toMatch(/Sandbox release \(local operator action\)/);
    expect(runbook).toMatch(/Promotion is an explicit local operator action/);
    expect(projectState).toMatch(
      /Product planning and implementation\s+tickets remain authoritative/,
    );
  });
});
