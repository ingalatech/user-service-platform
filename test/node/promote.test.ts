import { describe, expect, it } from 'vitest';
import { preparePromotionVersions } from '../../scripts/promote.js';

describe('promotion CLI version selection', () => {
  it('renders and selects the id from a Wrangler version record', () => {
    const prepared = preparePromotionVersions([
      {
        id: 'immutable-v1',
        metadata: { created_on: '2026-10-20T12:00:00Z' },
        annotations: {
          'workers/message': 'commit=abc branch=main',
          'workers/tag': 'candidate',
        },
      },
    ]);

    expect(prepared.display).toEqual([
      '1) immutable-v1 2026-10-20T12:00:00Z workers/message=commit=abc branch=main workers/tag=candidate',
    ]);
    expect(prepared.versions[0]?.id).toBe('immutable-v1');
  });
});
