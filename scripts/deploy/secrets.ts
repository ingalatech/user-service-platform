// Required Worker secret names for materialized Wrangler configs (ticket #104).
//
// A missing runtime secret (for example `BETTER_AUTH_SECRET`) previously surfaced
// only as a request-time Identity 500 (`session.resolve-failed phase=config`).
// Declaring `secrets.required` in the materialized target config makes `wrangler
// deploy` validate secret presence by name before Worker promotion/smoke.
//
// Secret boundary: this module derives secret *names* only from the canonical
// environment plus the effective mail transport. It never reads, prints,
// compares, uploads, or commits secret values, and the deployer never fetches
// secret values through the Cloudflare API: `wrangler deploy` remains the sole
// enforcement point and existing configured secrets are left untouched.
export interface RequiredSecretsInput {
  readonly environment: string;
  readonly vars: Record<string, string>;
}

// Derives the required Worker secret names for a deployment from the canonical
// environment plus the effective `AUTH_MAIL_TRANSPORT` (versioned profile with
// same-name target vars overlaid, resolved through the single
// `resolveEffectiveConfig` entry point so deploy validation cannot drift from
// runtime behavior):
//
// - `BETTER_AUTH_SECRET` is required for the canonical remote environments
//   (`sandbox` and `production`; legacy `staging` normalizes to `sandbox`).
// - `SMTP_USER` + `SMTP_PASSWORD` are required when the effective transport is
//   `smtp`; `RESEND_API_KEY` when it is `resend`.
// - Mail-provider secrets follow the selected transport only: an unset or
//   `inmemory` transport requires no provider secret.
// - `local`/`test` stay credential-free unless they explicitly opt into a real
//   provider transport (`smtp`/`resend`).
export function requiredWorkerSecrets(input: RequiredSecretsInput): string[] {
  const required: string[] = [];
  if (input.environment === 'sandbox' || input.environment === 'production') {
    required.push('BETTER_AUTH_SECRET');
  }
  const transport = (input.vars.AUTH_MAIL_TRANSPORT ?? '').trim().toLowerCase();
  if (transport === 'smtp') {
    required.push('SMTP_USER', 'SMTP_PASSWORD');
  } else if (transport === 'resend') {
    required.push('RESEND_API_KEY');
  }
  return required;
}
