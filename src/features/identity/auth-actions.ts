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
// - restrictive same-origin CSP with hashes for the inline page assets;
// - the server never reads, logs or renders token values: the documents are
//   static and the token is consumed client-side only;
// - request telemetry continues to log pathname only (composition root), so
//   `?token=...` never enters logs.
// Visual traceability: tokens and layout mirror admin/src/kit/index.css and
// admin/src/styles.css; control dimensions mirror the admin Input/Button kit.
const PAGE_STYLE = String.raw`
:root{color-scheme:light dark;--radius:.625rem;--background:oklch(1 0 0);--foreground:oklch(.145 0 0);--card:oklch(1 0 0);--card-foreground:oklch(.145 0 0);--popover:oklch(1 0 0);--popover-foreground:oklch(.145 0 0);--primary:oklch(.205 0 0);--primary-foreground:oklch(.985 0 0);--muted:oklch(.97 0 0);--muted-foreground:oklch(.556 0 0);--destructive:oklch(.577 .245 27.325);--border:oklch(.922 0 0);--input:oklch(.922 0 0);--ring:oklch(.708 0 0)}
*{box-sizing:border-box}html{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:var(--background);color:var(--foreground);font-size:1rem;line-height:1.5}.auth-screen{min-height:100svh;display:grid;place-items:center;padding:1.5rem;background:var(--muted)}.auth-card{width:min(100%,32rem);padding:clamp(1.5rem,5vw,2.5rem);border:1px solid var(--border);border-radius:1rem;background:var(--card);color:var(--card-foreground)}h1{margin:0 0 1rem;font-size:clamp(1.5rem,4vw,1.9rem);font-weight:650;line-height:1.25}.auth-description{margin:0;color:var(--muted-foreground);line-height:1.6}.login-form{display:grid;gap:1.4rem;margin-top:1.8rem}label{display:grid;gap:.5rem;font-size:.875rem;font-weight:500}input{height:2.25rem;width:100%;min-width:0;border:1px solid var(--input);border-radius:.375rem;background:transparent;color:var(--foreground);padding:.25rem .625rem;font:inherit;outline:none}input::placeholder{color:var(--muted-foreground)}input:focus-visible,button:focus-visible{border-color:var(--ring);outline:3px solid color-mix(in oklch,var(--ring),transparent 50%);outline-offset:1px}button{height:2.25rem;width:100%;border:1px solid transparent;border-radius:.375rem;background:var(--primary);color:var(--primary-foreground);cursor:pointer;font:500 .875rem/1.25rem inherit;padding:.25rem .625rem}button:hover{background:color-mix(in oklch,var(--primary),var(--primary-foreground) 20%)}ul{margin:-.5rem 0 0;padding:0;list-style:none;color:var(--muted-foreground);font-size:.875rem}li{margin:.25rem 0}.status{margin:1.5rem 0 0;border-radius:.375rem;padding:.75rem;background:var(--muted);color:var(--muted-foreground)}.error{background:color-mix(in oklch,var(--destructive),var(--background) 90%);color:var(--destructive)}.ok{background:color-mix(in oklch,var(--primary),var(--background) 90%);color:var(--foreground)}[hidden]{display:none!important}@media (prefers-color-scheme:dark){:root{--background:oklch(.145 0 0);--foreground:oklch(.985 0 0);--card:oklch(.205 0 0);--card-foreground:oklch(.985 0 0);--popover:oklch(.205 0 0);--popover-foreground:oklch(.985 0 0);--primary:oklch(.922 0 0);--primary-foreground:oklch(.205 0 0);--muted:oklch(.269 0 0);--muted-foreground:oklch(.708 0 0);--destructive:oklch(.704 .191 22.216);--border:oklch(1 0 0 / 10%);--input:oklch(1 0 0 / 15%);--ring:oklch(.556 0 0)}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

const VERIFY_SCRIPT = String.raw`(async()=>{const status=document.getElementById("status"),token=new URLSearchParams(location.search).get("token");history.replaceState(null,"",location.pathname);if(!token){status.textContent="This verification link is invalid or has expired.";status.className="status error";return}try{const response=await fetch("/v1/auth/verify-email",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});if(!response.ok)throw new Error();status.textContent="Your email address is verified. You can now sign in.";status.className="status ok"}catch{status.textContent="This verification link is invalid or has expired.";status.className="status error"}})();`;

const RESET_SCRIPT = String.raw`(()=>{const form=document.getElementById("reset-form"),password=document.getElementById("new-password"),status=document.getElementById("status"),requirements=document.getElementById("requirements"),token=new URLSearchParams(location.search).get("token");history.replaceState(null,"",location.pathname);if(!token){status.textContent="This password-reset link is invalid or has expired.";status.className="status error";form.hidden=true;return}let policy=null;const renderPolicy=()=>{if(!policy)return;password.minLength=policy.minLength;password.maxLength=policy.maxLength;requirements.replaceChildren();const rules=["Use at least "+policy.minLength+" characters","Use no more than "+policy.maxLength+" characters"];if(policy.minUppercase>0)rules.push("Use at least "+policy.minUppercase+" uppercase letter(s)");if(policy.minLowercase>0)rules.push("Use at least "+policy.minLowercase+" lowercase letter(s)");if(policy.minDigits>0)rules.push("Use at least "+policy.minDigits+" digit(s)");if(policy.minSymbols>0)rules.push("Use at least "+policy.minSymbols+" symbol(s)");for(const rule of rules){const item=document.createElement("li");item.textContent=rule;requirements.append(item)}};fetch("/v1/auth/config").then(response=>response.ok?response.json():null).then(config=>{policy=config?.passwordPolicy??null;renderPolicy()}).catch(()=>{});form.addEventListener("submit",async event=>{event.preventDefault();if(policy){const points=[...password.value],upper=points.filter(value=>/\p{Lu}/u.test(value)).length,lower=points.filter(value=>/\p{Ll}/u.test(value)).length,digits=points.filter(value=>/\p{Nd}/u.test(value)).length,symbols=points.filter(value=>!/[\p{L}\p{N}]/u.test(value)&&!/\s/u.test(value)).length;if(points.length<policy.minLength||points.length>policy.maxLength||upper<policy.minUppercase||lower<policy.minLowercase||digits<policy.minDigits||symbols<policy.minSymbols){status.textContent="Your password does not meet the current requirements.";status.className="status error";return}}status.textContent="Setting your new password.";status.className="status pending";try{const response=await fetch("/v1/auth/reset-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token,newPassword:password.value})});if(!response.ok)throw new Error();status.textContent="Your password was reset. You can now sign in.";status.className="status ok";form.hidden=true}catch{status.textContent="This password-reset link is invalid or has expired.";status.className="status error"}})})();`;

async function sourceHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

async function securityHeaders(script: string): Promise<Record<string, string>> {
  const [styleHash, scriptHash] = await Promise.all([sourceHash(PAGE_STYLE), sourceHash(script)]);
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      `script-src 'sha256-${scriptHash}'`,
      `style-src 'sha256-${styleHash}'`,
      "connect-src 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
  };
}

function pageShell(title: string, content: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><main class="auth-screen"><section class="auth-card">${content}</section></main><script>${script}</script></body></html>`;
}

function verifyEmailPage(): string {
  return pageShell(
    'Verify email',
    '<h1>Verify your email</h1><p class="auth-description">We are confirming your email address. This page will update automatically.</p><p id="status" class="status" role="status" aria-live="polite">Verifying your email address.</p>',
    VERIFY_SCRIPT,
  );
}

function resetPasswordPage(): string {
  return pageShell(
    'Choose a new password',
    '<h1>Choose a new password</h1><p class="auth-description">Set a new password for your account.</p><form id="reset-form" class="login-form"><label for="new-password">New password<input id="new-password" name="new-password" type="password" autocomplete="new-password" required aria-describedby="requirements"></label><ul id="requirements" aria-live="polite"></ul><button type="submit">Set new password</button></form><p id="status" role="status" aria-live="polite"></p>',
    RESET_SCRIPT,
  );
}

// Fallback action-page router mounted at `/auth-actions` by the composition
// root. Plain HTML handlers only; no contract, persistence or mail behaviour
// lives here.
export function createAuthActionsRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();

  router.get(VERIFY_EMAIL_ACTION_PATH.replace('/auth-actions', ''), async (c) =>
    c.html(verifyEmailPage(), 200, await securityHeaders(VERIFY_SCRIPT)),
  );
  router.get(RESET_PASSWORD_ACTION_PATH.replace('/auth-actions', ''), async (c) =>
    c.html(resetPasswordPage(), 200, await securityHeaders(RESET_SCRIPT)),
  );

  return router;
}
