import { describe, expect, it } from 'vitest';
import {
  assertRequiredSecretBindings,
  parseWorkerVersionDetails,
  parseWorkerVersions,
} from '../../scripts/deploy/versions.js';

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

  it('retains the full viewed version id and only secret binding types', () => {
    const details = parseWorkerVersionDetails({
      id: '12345678-1234-1234-1234-123456789abc',
      metadata: { created_on: '2026-10-20T12:00:00Z' },
      preview_url: 'https://12345678-worker.example.workers.dev',
      resources: {
        bindings: [
          { name: 'BETTER_AUTH_SECRET', type: 'secret_text', text: 'must-not-be-retained' },
          { name: 'SMTP_USER', type: 'secret_text' },
          { name: 'SMTP_PASSWORD', type: 'secret_text' },
          { name: 'PUBLIC_VALUE', type: 'plain_text', text: 'public' },
        ],
      },
    });

    expect(details?.id).toBe('12345678-1234-1234-1234-123456789abc');
    expect(details?.previewUrl).toBe('https://12345678-worker.example.workers.dev');
    expect([...(details?.secretBindings.keys() ?? [])]).toEqual([
      'BETTER_AUTH_SECRET',
      'SMTP_USER',
      'SMTP_PASSWORD',
    ]);
    expect(JSON.stringify(details)).not.toContain('must-not-be-retained');
    expect(() => {
      if (details === undefined) throw new Error('version details were not parsed');
      assertRequiredSecretBindings(details, ['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD']);
    }).not.toThrow();
  });

  it('fails closed when a required binding is not encrypted secret_text', () => {
    const details = parseWorkerVersionDetails({
      id: '12345678-1234-1234-1234-123456789abc',
      resources: { bindings: [{ name: 'SMTP_PASSWORD', type: 'plain_text' }] },
    });
    expect(details).toBeDefined();
    expect(() => {
      if (details === undefined) throw new Error('version details were not parsed');
      assertRequiredSecretBindings(details, ['SMTP_PASSWORD']);
    }).toThrow(/SMTP_PASSWORD/);
  });
});
