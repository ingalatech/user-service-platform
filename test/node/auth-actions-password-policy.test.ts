import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createAuthActionsRouter } from '../../src/features/identity/auth-actions.js';

interface SubmitEventLike {
  preventDefault(): void;
}

describe('password reset action-page policy', () => {
  it('renders canonical requirements and displays the server policy result', async () => {
    const page = await createAuthActionsRouter().request('/reset-password?token=reset-token');
    expect(page.status).toBe(200);
    const html = await page.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    if (script === undefined) throw new Error('Expected the reset page script.');

    const status = { textContent: '', className: '' };
    const password = { value: 'Ab1!' };
    const requirementItems: string[] = [];
    const requirements = {
      replaceChildren: () => requirementItems.splice(0),
      append: (item: { textContent: string }) => requirementItems.push(item.textContent),
    };
    let submitHandler: ((event: SubmitEventLike) => Promise<void>) | undefined;
    const form = {
      hidden: false,
      addEventListener: (_type: string, handler: (event: SubmitEventLike) => Promise<void>) => {
        submitHandler = handler;
      },
    };
    const document = {
      getElementById: (id: string) => {
        switch (id) {
          case 'reset-form':
            return form;
          case 'new-password':
            return password;
          case 'status':
            return status;
          case 'requirements':
            return requirements;
          default:
            return null;
        }
      },
      createElement: () => ({ textContent: '' }),
    };
    const requests: { readonly input: string; readonly init?: RequestInit }[] = [];
    const policy = {
      minLength: 8,
      maxLength: 8,
      minUppercase: 1,
      minLowercase: 1,
      minDigits: 1,
      minSymbols: 1,
    };
    let resetAttempts = 0;
    const fetch = (input: string, init?: RequestInit) => {
      requests.push({ input, ...(init === undefined ? {} : { init }) });
      if (input === '/v1/auth/config') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ passwordPolicy: policy }),
        });
      }
      resetAttempts += 1;
      return resetAttempts === 1
        ? Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'password-policy-violation' }),
          })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
    };

    runInNewContext(script, {
      document,
      fetch,
      history: { replaceState: () => undefined },
      location: { search: '?token=reset-token', pathname: '/auth-actions/reset-password' },
      URLSearchParams,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requirementItems).toEqual([
      'Use at least 8 characters',
      'Use no more than 8 characters',
      'Use at least 1 uppercase letter(s)',
      'Use at least 1 lowercase letter(s)',
      'Use at least 1 digit(s)',
      'Use at least 1 symbol(s)',
    ]);
    expect(submitHandler).toBeDefined();
    if (submitHandler === undefined) throw new Error('Expected a reset form submit handler.');

    await submitHandler({ preventDefault: () => undefined });

    expect(requests.map(({ input }) => input)).toEqual([
      '/v1/auth/config',
      '/v1/auth/reset-password',
    ]);
    const resetRequest = requests[1];
    expect(resetRequest?.init?.body).toBe(
      JSON.stringify({ token: 'reset-token', newPassword: 'Ab1!' }),
    );
    expect(status.textContent).toBe('Your password does not meet the current requirements.');
    expect(status.className).toBe('status error');
    expect(form.hidden).toBe(false);

    password.value = 'A\u{10428}2\u{1F4A5}wxyz';
    await submitHandler({ preventDefault: () => undefined });

    expect(requests[2]?.input).toBe('/v1/auth/reset-password');
    expect(requests[2]?.init?.body).toBe(
      JSON.stringify({ token: 'reset-token', newPassword: password.value }),
    );
    expect(status.textContent).toBe('Your password was reset. You can now sign in.');
    expect(status.className).toBe('status ok');
    expect(form.hidden).toBe(true);
  });
});
