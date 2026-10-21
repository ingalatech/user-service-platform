import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  scripts?: Record<string, string>;
}

const packageManifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
const opencodeWorkflow = readFileSync('docs/agents/opencode.md', 'utf8');
const projectState = readFileSync('docs/agents/project-state.md', 'utf8');
const handoff = readFileSync('docs/agents/workflow-handoff.md', 'utf8');

describe('direct pane workflow contract', () => {
  it('does not expose retired automated reviewer or correction commands', () => {
    expect(packageManifest.scripts).not.toHaveProperty('review:cycle');
    expect(packageManifest.scripts).not.toHaveProperty('agent:fix-cycle-correction');
    expect(packageManifest.scripts).not.toHaveProperty('agent:ticket');
    expect(packageManifest.scripts).not.toHaveProperty('preagent:ticket');
    expect(existsSync('scripts/review-cycle.ts')).toBe(false);
    expect(existsSync('.opencode/commands/review-standards.md')).toBe(false);
    expect(existsSync('.opencode/commands/review-spec.md')).toBe(false);
    expect(existsSync('.opencode/commands/address-review.md')).toBe(false);
  });

  it('keeps safe branch publication as an independent capability', () => {
    expect(packageManifest.scripts?.['review:safe-push']).toBe('tsx scripts/safe-push.ts');
    expect(existsSync('scripts/safe-push.ts')).toBe(true);
    expect(existsSync('scripts/safe-push-guards.ts')).toBe(true);
  });

  it('documents the current p2, p3, and p1 handoff without loop language', () => {
    for (const document of [opencodeWorkflow, projectState, handoff]) {
      expect(document).toContain('p2 implements or corrects');
      expect(document).toContain('p3');
      expect(document).toContain('p1');
      expect(document).not.toMatch(/review:cycle|reviewer model/i);
    }
  });
});
