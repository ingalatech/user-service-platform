import { describe, expect, it } from 'vitest';
import {
  buildApprovalDispatchArgs,
  filterPolledRunsForHint,
  parseDispatchHint,
} from '../../scripts/review/approve-agent-ci.js';

describe('approve-agent-ci dispatch creation-race recovery (ticket #47)', () => {
  it('builds a narrow manual dispatch hint without approving a run', () => {
    expect(
      buildApprovalDispatchArgs('o/r', {
        pr: 61,
        headSha: 'e0ee52f21ecd28279f3e0a9b0a8bbd2b4b87a039',
        ticket: 57,
      }),
    ).toEqual([
      'api',
      'repos/o/r/dispatches',
      '--method',
      'POST',
      '-F',
      'event_type=approve-agent-ci-request',
      '-F',
      'client_payload[pr]=61',
      '-F',
      'client_payload[head_sha]=e0ee52f21ecd28279f3e0a9b0a8bbd2b4b87a039',
      '-F',
      'client_payload[ticket]=57',
    ]);
  });

  it('parses and filters validated hints without trusting malformed fields', () => {
    const headSha = 'e0ee52f21ecd28279f3e0a9b0a8bbd2b4b87a039';
    const hint = parseDispatchHint({ pr: '61', head_sha: headSha.toUpperCase(), ticket: 57 });
    const runs = [
      { runId: 1, headSha, workflowName: 'ci', prNumbers: [61] },
      { runId: 2, headSha, workflowName: 'ci', prNumbers: [62] },
      { runId: 3, headSha: 'a'.repeat(40), workflowName: 'ci', prNumbers: [61] },
    ];

    expect(hint).toEqual({ pr: 61, headSha, ticket: 57 });
    expect(filterPolledRunsForHint(runs, hint)).toEqual([runs[0]]);
    expect(parseDispatchHint({ pr: 0, head_sha: 'abc', ticket: -1 })).toEqual({});
  });
});
