// Application-owned auth-mail templates (ADR-0010, ticket #13). Verification
// and password-reset messages are rendered here from deployment branding
// inputs. Provider SDKs never construct message content: the transport
// adapter receives a finished subject/html/text payload, so switching
// providers cannot change user-facing copy or require feature-code changes.

export interface AuthMailTemplateInput {
  readonly appName: string;
  readonly url: string;
}

export interface EmailChangeNoticeTemplateInput {
  readonly appName: string;
  readonly previousEmail: string;
  readonly newEmail: string;
}

export interface SocialIdentityUnlinkNoticeTemplateInput {
  readonly appName: string;
  readonly providerDisplayName: 'Google' | 'Facebook';
}

export interface AuthMailTemplate {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderVerificationEmail(input: AuthMailTemplateInput): AuthMailTemplate {
  const appName = input.appName;
  return {
    subject: `Verify your ${appName} email`,
    text:
      `Welcome to ${appName}. Verify your email address by opening this link:\n\n` +
      `${input.url}\n\n` +
      `If you did not create an account, you can ignore this message.`,
    html:
      `<p>Welcome to ${escapeHtml(appName)}. Verify your email address:</p>` +
      `<p><a href="${escapeHtml(input.url)}">Verify email address</a></p>` +
      `<p>If you did not create an account, you can ignore this message.</p>`,
  };
}

export function renderPasswordResetEmail(input: AuthMailTemplateInput): AuthMailTemplate {
  const appName = input.appName;
  return {
    subject: `Reset your ${appName} password`,
    text:
      `You requested a password reset for ${appName}. Open this link to choose a new password:\n\n` +
      `${input.url}\n\n` +
      `If you did not request a reset, you can ignore this message.`,
    html:
      `<p>You requested a password reset for ${escapeHtml(appName)}:</p>` +
      `<p><a href="${escapeHtml(input.url)}">Choose a new password</a></p>` +
      `<p>If you did not request a reset, you can ignore this message.</p>`,
  };
}

export function renderEmailChangeNotice(input: EmailChangeNoticeTemplateInput): AuthMailTemplate {
  return {
    subject: `Email change requested for ${input.appName}`,
    text:
      `A request was made to change the ${input.appName} email address from ` +
      `${input.previousEmail} to ${input.newEmail}.\n\n` +
      `If you did not request this change, contact support.`,
    html:
      `<p>A request was made to change the ${escapeHtml(input.appName)} email address from ` +
      `<strong>${escapeHtml(input.previousEmail)}</strong> to ` +
      `<strong>${escapeHtml(input.newEmail)}</strong>.</p>` +
      '<p>If you did not request this change, contact support.</p>',
  };
}

export function renderSocialIdentityUnlinkNotice(
  input: SocialIdentityUnlinkNoticeTemplateInput,
): AuthMailTemplate {
  const provider = input.providerDisplayName;
  return {
    subject: `A ${provider} sign-in was removed from ${input.appName}`,
    text: `A ${provider} sign-in association was removed from your ${input.appName} account. If you did not expect this change, contact support.`,
    html: `<p>A ${provider} sign-in association was removed from your ${escapeHtml(input.appName)} account.</p><p>If you did not expect this change, contact support.</p>`,
  };
}
