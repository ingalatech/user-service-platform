# Administración web

React + TypeScript + Vite SPA under `/admin`, served by the existing Hono
Worker's Static Assets binding on the same origin. This first slice signs in
an existing verified administrator, shows the real identity, restores access
on reload and signs out. The Users resource (#125) reads real accounts with
server-side literal email search and bounded pagination. User detail belongs
to #126; Profile is deferred.

## Kit provenance and maintenance

The real Marmelab [Shadcn Admin Kit](https://marmelab.com/shadcn-admin-kit/docs/install/)
is distributed as source registry components, not as the community npm package
named `shadcn-admin-kit`. `src/kit` vendors the 38-file transitive closure used
by Admin, Layout, TextInput and Button from upstream tag **v2.0.0**, commit
[`11983abe4afc60a3904991820526aafe4d0588d3`](https://github.com/marmelab/shadcn-admin-kit/tree/11983abe4afc60a3904991820526aafe4d0588d3/src).
The upstream Marmelab MIT license is preserved in `src/kit/LICENSE`.

The kit's actual Admin, Layout, authProvider facilities, form/input and UI
components are used. `src/login-page.tsx` adapts its login form for Spanish
copy, email/password fields and safe inline errors. These vendored adaptations
are intentionally small and must be retained when updating the pinned source:

- `app-sidebar.tsx`: replace demo branding and check an optional resource safely.
- `theme-mode-toggle.tsx` and `ui/sidebar.tsx`: Spanish visible/accessibility labels.
- `user-menu.tsx`: accessible Spanish menu label and safe logout failure notification.
- `refresh-button.tsx`: accessible Spanish label.

Other kit files retain upstream content and formatting. The vendor subtree is
excluded from repository formatter/lint rewriting; the complete imported code
is still typechecked and bundled. All owned TS/TSX files have typed lint gates.
Dependencies are pinned in `package.json` and the root lock. Tailwind/static CSS
provides styling; no Emotion, MUI or other CSS-in-JS library is installed.
The `src/kit/shadcn-tailwind.css` file vendors the complete `dist/tailwind.css`
from `shadcn@4.22.1`; the vulnerable shadcn CLI is not needed at install time.
Its complete upstream license and copyright attribution are preserved separately
in `src/kit/SHADCN-LICENSE.md`; this does not replace the Marmelab license in
`src/kit/LICENSE`. The upstream registry URL is
`https://registry.npmjs.org/shadcn/-/shadcn-4.22.1.tgz`, the repository is
`https://github.com/shadcn-ui/ui/tree/shadcn@4.22.1`, and the upstream file's
SHA-256 is
`4c371f7a1ff5d219ae2f7ff28bd256b4346fd546fe46fbae22092e57db2f0fae`.
React Admin's named `query-string` imports are routed through the local Vite
`src/query-string-compat.ts` adapter, backed by the fixed
`query-string@9.5.1` package and preserving both named and default exports.

## Authentication

`src/api.ts` consumes the runtime contracts owned by Identity; it never maintains
a second API schema. Same-origin `fetch` uses HttpOnly session cookies with
`credentials: include`. No authentication data is stored in localStorage or
sessionStorage. The kit receives an in-memory store and telemetry is disabled.
`GET /v1/admin/me` is the permission authority; public `/v1/me` stays unchanged.
The outer BrowserRouter owns the `/admin` basename (the kit default is a hash
router). Shared React Query/form dependencies are pinned to one compatible
version and Vite deduplicates their contexts.

ra-core's default `requireAuth` failure path invokes logout on every rejection.
Our small protected route uses its `useAuthState` without automatic logout and
wraps the real kit Layout: 401 shows login, 403 shows access denial preserving
the regular User's session, and 500/transport failure offers retry preserving
the cookie. The authProvider implements real login/identity/logout operations.
Spanish strings used by these slices are defined in `src/i18n.ts` and the owned
resource views. The Users resource has no mutation or detail controls.

`src/data-provider.ts` adapts the exact Identity-owned `GET /v1/admin/users`
representation to ra-core list metadata. It supports only User listing;
unsupported operations reject without making an HTTP request. Runtime parsing
and TypeScript types reuse the source contracts (`schemaInference`). Requests
carry bounded limit/offset and an optional literal email substring. Changing
search resets the page, cancels obsolete requests and hides previous results
while the new query is pending. Search terms and result contents are never logged.

## Run locally

Use the repository-pinned Node/npm versions, then from the repository root:

```sh
npm ci
npm run build:admin
npm run db:local:migrate
npm run dev:local
```

Open `http://localhost:8787/admin/`. Use `npm run admin:bootstrap`; that one command
creates the first administrator and requests its verification email. Complete the
existing verification procedure to prepare a local administrator. If delivery
fails, use the request-verification operation to resend. Local mail is a
metadata-only sink; use the isolated browser test for automated fixture setup.
For frontend live reload, run `npm run dev --workspace admin` alongside the
Worker; Vite proxies `/v1` and `/auth-actions` to the local Worker.

## Verification

`npm run test` builds assets before Workers tests. `npm run test:harness` rebuilds
them and includes a real Chromium acceptance test against a private temporary
Worker/D1 database. It never resets ordinary local D1 or uses remote resources.
A system Chromium is used if present (`CHROME_PATH` may select one); otherwise
the pinned Playwright CLI installs its headless Chromium. An environment must
allow local listeners/processes and have Chromium's system libraries.

`npm run test:admin:browser` runs the same browser acceptance directly after a
fresh `npm run build:admin`. It covers administrator login/reload/logout, wrong
password, unverified login, regular-User denial without session loss, an actual
storage failure/retry, expired/revoked sessions, exact HTTP identity shapes,
asset/API routing, keyboard focus and a narrow viewport. No API response mocks.
It also exercises real User listing, case-insensitive email search, no matches,
clear, pagination, search reset from the second page, actual service failure
and retry, and regular-User rejection.

## Short operator smoke after sandbox deployment

1. Open `<sandbox-origin>/admin/login`; sign in with the existing verified admin.
2. Confirm the email, `admin` role and verified state; reload and confirm access.
3. Open Usuarios, inspect real email/verification/role, search by part of an
   existing email, then a nonexistent one; clear the search. Page forward/back
   if the environment contains more than ten Users. Search from a later page
   and confirm it resets to page one. Reload `/admin/users` and confirm access.
4. Sign out; reload `/admin/users` and confirm the login page.
5. Sign in with a verified regular User; confirm `/admin/users` denies access and `/v1/me`
   still returns 200 in that same browser session, then sign out.

Do not share passwords, cookies or action tokens in issues or screenshots.
