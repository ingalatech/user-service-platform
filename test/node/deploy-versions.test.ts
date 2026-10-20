import { describe, expect, it } from 'vitest';
import { parseWorkerVersions } from '../../scripts/deploy/versions.js';

describe('Wrangler Worker version payloads', () => {
  it('reads the pinned Wrangler 4.130.0 version shape', () => {
    expect(
      parseWorkerVersions([
        {
          id: 'immutable-v1',
          metadata: { created_on: '2026-10-20T12:00:00Z' },
          annotations: { 'workers/message': 'commit=abc branch=main', 'workers/tag': 'candidate' },
        },
      ]),
    ).toEqual([
      {
        id: 'immutable-v1',
        createdOn: '2026-10-20T12:00:00Z',
        annotations: 'workers/message=commit=abc branch=main workers/tag=candidate',
      },
    ]);
  });

  it('ignores malformed entries without accepting legacy version_id fields', () => {
    expect(parseWorkerVersions([{ version_id: 'legacy' }])).toEqual([]);
  });
});
