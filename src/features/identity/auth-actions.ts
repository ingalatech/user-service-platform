import { Hono } from 'hono';
import type { Env } from '../../env.js';
import { RESET_PASSWORD_ACTION_PATH, VERIFY_EMAIL_ACTION_PATH } from './action-urls.js';

// Service-owned fallback browser action pages (ticket #77).
//
// Operational/default UX for deployments without branded consumer action
// pages: when `AUTH_VERIFY_EMAIL_ACTION_URL` / `AUTH_RESET_PASSWORD_ACTION_URL`
// are unset, mail targets these routes on the request origin. Each page reads
// the `token` query parameter in the browser and completes through the
// existing application-owned POST contracts (`POST /v1/auth/verify-email`,
// `POST /v1/auth/reset-password`). They are plain server-rendered documents,
// not a new SPA/framework, and consumer sites may replace them by configuring
// the action URLs.
//
// These routes are intentionally plain Hono handlers, not OpenAPI operations:
// they serve `text/html` documents and must never appear in the generated
// OpenAPI contract (existing JSON contracts remain unchanged).
//
// Security boundary:
// - `Cache-Control: no-store` so completed actions are never cached;
// - `Referrer-Policy: no-referrer` so the token query never leaks via Referer;
// - restrictive same-origin CSP for the minimal inline page;
// - the server never reads, logs or renders token values: the documents are
//   static and the token is consumed client-side only;
// - request telemetry continues to log pathname only (composition root), so
//   `?token=...` never enters logs.
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
} as const;

const PAGE_STYLE =
  'body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:32rem;padding:0 1rem}' +
  '.error{color:#7a1f1f}.ok{color:#14532d}';

function verifyEmailPage(): string {
  return (
    '<!doctype html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Verify email</title>' +
    `<style>${PAGE_STYLE}</style></head>` +
    '<body><main><h1>Verify your email</h1>' +
    '<p id="status" role="status">Verifying your email address.</p></main>' +
    '<script>(async()=>{' +
    'const status=document.getElementById("status");' +
    'const token=new URLSearchParams(window.location.search).get("token");' +
    'window.history.replaceState(null,"",window.location.pathname);' +
    'if(!token){status.textContent="This verification link is invalid or has expired.";status.className="error";return;}' +
    'try{' +
    'const res=await fetch("/v1/auth/verify-email",{method:"POST",' +
    'headers:{"content-type":"application/json"},body:JSON.stringify({token})});' +
    'if(res.ok){status.textContent="Your email address is verified. You can now sign in.";status.className="ok";}' +
    'else{status.textContent="This verification link is invalid or has expired.";status.className="error";}' +
    '}catch{' +
    'status.textContent="This verification link is invalid or has expired.";status.className="error";' +
    '}' +
    '})();</script></body></html>'
  );
}

function resetPasswordPage(): string {
  return (
    '<!doctype html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Choose a new password</title>' +
    `<style>${PAGE_STYLE}</style></head>` +
    '<body><main><h1>Choose a new password</h1>' +
    '<form id="reset-form"><label for="new-password">New password</label>' +
    '<input id="new-password" name="new-password" type="password" autocomplete="new-password" required>' +
    '<ul id="requirements" aria-live="polite"></ul>' +
    '<button type="submit">Set new password</button></form>' +
    '<p id="status" role="status"></p></main>' +
    '<script>(()=>{' +
    'const form=document.getElementById("reset-form");' +
    'const password=document.getElementById("new-password");' +
    'const status=document.getElementById("status");' +
    'const requirements=document.getElementById("requirements");' +
    'const token=new URLSearchParams(window.location.search).get("token");' +
    'window.history.replaceState(null,"",window.location.pathname);' +
    'if(!token){status.textContent="This password-reset link is invalid or has expired.";status.className="error";form.remove();return;}' +
    'let policy=null;' +
    'const renderPolicy=()=>{if(!policy)return;password.minLength=policy.minLength;password.maxLength=policy.maxLength;requirements.innerHTML="";' +
    'const rules=[`Use at least ${policy.minLength} characters`,`Use no more than ${policy.maxLength} characters`];' +
    'if(policy.minUppercase>0)rules.push(`Use at least ${policy.minUppercase} uppercase letter(s)`);' +
    'if(policy.minLowercase>0)rules.push(`Use at least ${policy.minLowercase} lowercase letter(s)`);' +
    'if(policy.minDigits>0)rules.push(`Use at least ${policy.minDigits} digit(s)`);' +
    'if(policy.minSymbols>0)rules.push(`Use at least ${policy.minSymbols} symbol(s)`);' +
    'for(const rule of rules){const item=document.createElement("li");item.textContent=rule;requirements.append(item);}};' +
    'fetch("/v1/auth/config").then((response)=>response.ok?response.json():null).then((config)=>{policy=config?.passwordPolicy??null;renderPolicy();}).catch(()=>{});' +
    'form.addEventListener("submit",async(event)=>{' +
    'event.preventDefault();' +
    'if(policy){const points=[...password.value];const upper=points.filter((value)=>/\\p{Lu}/u.test(value)).length;const lower=points.filter((value)=>/\\p{Ll}/u.test(value)).length;const digits=points.filter((value)=>/\\p{Nd}/u.test(value)).length;const symbols=points.filter((value)=>!/[\\p{L}\\p{N}]/u.test(value)&&!/\\s/u.test(value)).length;if(points.length<policy.minLength||points.length>policy.maxLength||upper<policy.minUppercase||lower<policy.minLowercase||digits<policy.minDigits||symbols<policy.minSymbols){status.textContent="Your password does not meet the current requirements.";status.className="error";return;}}' +
    'status.textContent="Setting your new password.";status.className="";' +
    'try{' +
    'const res=await fetch("/v1/auth/reset-password",{method:"POST",' +
    'headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({token,newPassword:password.value})});' +
    'if(res.ok){status.textContent="Your password was reset. You can now sign in.";status.className="ok";form.remove();}' +
    'else{status.textContent="This password-reset link is invalid or has expired.";status.className="error";}' +
    '}catch{' +
    'status.textContent="This password-reset link is invalid or has expired.";status.className="error";' +
    '}' +
    '});' +
    '})();</script></body></html>'
  );
}

// Fallback action-page router mounted at `/auth-actions` by the composition
// root. Plain HTML handlers only; no contract, persistence or mail behaviour
// lives here.
export function createAuthActionsRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();

  router.get(VERIFY_EMAIL_ACTION_PATH.replace('/auth-actions', ''), (c) =>
    c.html(verifyEmailPage(), 200, { ...SECURITY_HEADERS }),
  );
  router.get(RESET_PASSWORD_ACTION_PATH.replace('/auth-actions', ''), (c) =>
    c.html(resetPasswordPage(), 200, { ...SECURITY_HEADERS }),
  );

  return router;
}
