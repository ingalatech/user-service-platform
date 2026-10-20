import { describe, expect, it } from 'vitest';
import {
  checkFixCyclePr,
  checkTicketIssue,
  concurrencyGroupFor,
  isAuthorizedAssociation,
  parseAgentCommand,
} from '../../scripts/agent/command-guard.js';

describe('local agent command guards', () => {
  it('parses only the supported exact commands', () => {
    expect(parseAgentCommand('/agent-ticket')).toBe('agent-ticket');
    expect(parseAgentCommand('/agent-fix-cycle')).toBe('agent-fix-cycle');
    for (const body of [
      '',
      'please run /agent-ticket',
      '/agent-ticket 171',
      '/agent-ticket #171',
      '/agent-ticket; rm -rf /',
      '$(/agent-ticket)',
      '`/agent-ticket`',
      '/Agent-Ticket',
      '/agent-fix-cycle\n/agent-ticket',
    ]) {
      expect(parseAgentCommand(body)).toBeUndefined();
    }
    expect(parseAgentCommand('  /agent-ticket  \n')).toBe('agent-ticket');
    expect(parseAgentCommand('/agent-ticket\nextra text')).toBe('agent-ticket');
  });

  it('authorizes only repository members and collaborators', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(isAuthorizedAssociation(association)).toBe(true);
    }
    for (const association of ['CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'owner']) {
      expect(isAuthorizedAssociation(association)).toBe(false);
    }
    expect(isAuthorizedAssociation('FIRST_TIME_CONTRIBUTOR')).toBe(false);
  });

  it('requires an open same-repository PR to main with a full commit SHA', () => {
    const valid = {
      isPullRequest: true,
      state: 'OPEN',
      isFork: false,
      baseRef: 'main',
      headSha: 'a'.repeat(40),
    };
    expect(checkFixCyclePr(valid).ok).toBe(true);
    expect(checkFixCyclePr({ ...valid, isFork: true }).ok).toBe(false);
    expect(checkFixCyclePr({ ...valid, baseRef: 'other' }).ok).toBe(false);
    for (const headSha of ['', 'short', 'a'.repeat(39), 'z'.repeat(40), 'HEAD', 'main']) {
      expect(checkFixCyclePr({ ...valid, headSha }).ok).toBe(false);
    }
    expect(checkFixCyclePr({ ...valid, isPullRequest: false }).ok).toBe(false);
    expect(checkFixCyclePr({ ...valid, state: 'CLOSED' }).ok).toBe(false);
  });

  it('requires an open issue carrying the ready-for-agent label', () => {
    expect(
      checkTicketIssue({ isPullRequest: false, state: 'OPEN', labels: ['ready-for-agent'] }).ok,
    ).toBe(true);
    expect(
      checkTicketIssue({ isPullRequest: false, state: 'OPEN', labels: ['needs-triage'] }).ok,
    ).toBe(false);
    expect(
      checkTicketIssue({ isPullRequest: true, state: 'OPEN', labels: ['ready-for-agent'] }).ok,
    ).toBe(false);
    expect(
      checkTicketIssue({ isPullRequest: false, state: 'CLOSED', labels: ['ready-for-agent'] }).ok,
    ).toBe(false);
  });

  it('keeps local command concurrency keys scoped to the issue or PR', () => {
    expect(concurrencyGroupFor('agent-ticket', 171)).toBe('agent-ticket-issue-171');
    expect(concurrencyGroupFor('agent-fix-cycle', 28)).toBe('agent-fix-cycle-pr-28');
    for (const number of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => concurrencyGroupFor('agent-ticket', number)).toThrow(/number/i);
    }
  });
});
