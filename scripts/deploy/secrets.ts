export interface RequiredSecretsInput {
  readonly environment: string;
  readonly vars: Record<string, string>;
}

export function requiredWorkerSecrets(input: RequiredSecretsInput): string[] {
  const required: string[] = [];
  if (input.environment === 'sandbox' || input.environment === 'production') {
    required.push('BETTER_AUTH_SECRET');
  }
  const transport = (input.vars.AUTH_MAIL_TRANSPORT ?? '').trim().toLowerCase();
  if (transport === 'smtp') required.push('SMTP_USER', 'SMTP_PASSWORD');
  if (transport === 'resend') required.push('RESEND_API_KEY');
  return required;
}
