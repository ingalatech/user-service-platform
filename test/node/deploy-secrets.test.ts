import { describe, expect, it } from 'vitest';
import { requiredWorkerSecrets } from '../../scripts/deploy/secrets.js';

describe('required Worker secret contract', () => {
  it('derives the auth and selected mail transport names', () => {
    expect(
      requiredWorkerSecrets({ environment: 'sandbox', vars: { AUTH_MAIL_TRANSPORT: 'smtp' } }),
    ).toEqual(['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD']);
    expect(
      requiredWorkerSecrets({ environment: 'production', vars: { AUTH_MAIL_TRANSPORT: 'resend' } }),
    ).toEqual(['BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
  });
});
