import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const expectedCiSteps = [
  {
    name: 'Check out',
    uses: 'actions/checkout@v7',
    with: {
      ref: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
      'fetch-depth': 0,
    },
  },
  {
    name: 'Set up Node.js',
    uses: 'actions/setup-node@v7',
    with: { 'node-version-file': '.nvmrc', cache: 'npm' },
  },
  { name: 'Install dependencies', run: 'npm ci' },
  { name: 'Lint (zero warnings)', run: 'npm run lint' },
  { name: 'Format check', run: 'npm run format:check' },
  { name: 'Typecheck', run: 'npm run typecheck' },
  { name: 'OpenAPI drift check', run: 'npm run openapi:check' },
  { name: 'Admin contract drift check', run: 'npm run admin:contracts:check' },
  { name: 'Workers runtime tests', run: 'npm run test' },
  { name: 'Node harness tests', run: 'npm run test:harness' },
] as const;

function assertAllowedCiSteps(steps: unknown): void {
  expect(steps).toEqual(expectedCiSteps);
}

function assertOnlyGatesJob(jobs: unknown): void {
  expect(Object.keys(jobs as Record<string, unknown>).sort()).toEqual(['gates']);
}

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

  it('allows exactly the pinned quality-gates steps, commands and order', () => {
    const workflow = parseYaml(readFileSync(`${workflowsDir}/ci.yml`, 'utf8')) as {
      jobs?: Record<string, { steps?: unknown }>;
    };

    assertOnlyGatesJob(workflow.jobs);
    assertAllowedCiSteps(workflow.jobs?.gates?.steps);
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
    const operatingAgreement =
      projectState.split('## Operating agreement')[1]?.split('## Architecture and toolchain')[0] ??
      '';
    const releaseBoundary = projectState.split('## Release boundary')[1] ?? '';
    expect(operatingAgreement).toMatch(/P2 works one approved.*isolated worktree/s);
    expect(operatingAgreement).toMatch(
      /No automated review\/correction\s+workers or release commands run from repository CI/,
    );
    expect(releaseBoundary).toMatch(
      /Deploy, promotion and provisioning are explicit local P1 operations\./,
    );
    expect(releaseBoundary).toMatch(/CI runs\s+deterministic[\s\S]+generated-contract checks/);
    expect(releaseBoundary).toMatch(/Worker\s+tests and harness tests only/);
    expect(releaseBoundary).toMatch(/it does not mutate Cloudflare/);
    expect(adr).toMatch(/Sandbox and production releases are explicit local operator actions/);
    expect(runbook).toMatch(/Sandbox release \(local operator action\)/);
    expect(runbook).toMatch(/Promotion is an explicit local operator action/);
    expect(projectState).toMatch(
      /Configurable Profile and the D1 collections engine remain in planning under\s+Wayfinder issues #208 and #216/,
    );
  });
});
