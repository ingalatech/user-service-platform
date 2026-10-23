# Dependency Audit

Ticket: #38. Scope: dependency/tooling hygiene only; no User Service product or
API behavior changes.

Audited: 2026-10-22, Node 24.22.1, npm 11.19.1, clean `npm ci` install.

## Result

Both `npm audit` and `npm audit --omit=dev` report **0 vulnerabilities**.
The result depends on the controlled resolutions below. Re-run the audit after
upgrading any owning package and remove an override as soon as its upstream
release makes it unnecessary.

## Controlled Resolutions

- `source-map-js@1.2.2` is forced globally. It is compatible with the Tailwind,
  PostCSS and Vite consumers and fixes the indexed source-map advisory.
- `ra-core` resolves `query-string` through the root `$query-string` reference
  at `9.5.1`. That version uses fixed `decode-uri-component@0.5.0`, but its ESM
  package exposes the API through `default` while React Admin imports named
  `parse` and `stringify` exports. The admin Vite config aliases the exact
  package import to `admin/src/query-string-compat.ts`, which preserves both
  named and default forms. `test/query-string-compat.test.ts` covers the
  relevant parse/stringify behavior.
- `@cloudflare/vitest-pool-workers@0.23.0` resolves only its `miniflare`
  dependency to `5.20261019.2-beta`. Its nested Wrangler remains the package's
  declared `4.124.0`; the root Wrangler is `4.152.0`. The targeted Miniflare
  resolution supplies `sharp@0.35.5`, `undici@7.29.1`, and
  `workerd@1.20261019.1`.
- `@esbuild-kit/core-utils` resolves its deprecated loader's esbuild copy to
  the already-installed compatible `esbuild@0.25.12`. `npm run db:generate`,
  typecheck and tests validate the migration-loader path.
- `vitest` resolves Vite to `7.3.7`, preserving the repository's Vite 7 policy
  instead of selecting Vite 8 through peer resolution.
- The admin kit no longer depends on the vulnerable shadcn CLI. The required
  CSS subset is vendored at `admin/src/kit/shadcn-tailwind.css`, derived from
  `shadcn@4.22.1` under its MIT license. The source import and provenance are
  documented in `admin/README.md`.

These are package-manager or build-tool boundaries only; no production service
business behavior was changed.

## Deprecated Packages

`npm ci` still reports these upstream deprecations:

- `@esbuild-kit/esm-loader@2.6.5` and `@esbuild-kit/core-utils@3.3.2`, retained
  by the stable `drizzle-kit@0.31.11` line. The audit-safe esbuild resolution is
  tested through `npm run db:generate`; remove the override when Drizzle Kit
  drops the deprecated loader.
- `@cloudflare/vitest-pool-workers@0.23.0`, renamed upstream to
  `@cloudflare/vitest-plugin`. Migration is deferred because it is a separate
  test-runner migration and the current package passes the Workers suite with
  the targeted Miniflare resolution.

## Install Scripts

The repository already had an explicit `allowScripts` policy before this audit;
it was not introduced by this change. Stale approvals for uninstalled
`esbuild@0.18.20` and `workerd@1.20260908.1` were removed. The only new approval
is `workerd@1.20261019.1`, required by the root Wrangler and the resolved
Miniflare runtime. `npm ls` confirms the remaining approved versions are
installed, and `npm install-scripts ls` reports no unreviewed scripts.

No blanket script approval was added. Re-review and remove an approval only
after `npm ls` confirms that version is no longer installed.

## Verification

- `npm ci`
- `npm audit`
- `npm audit --omit=dev`
- `npm ls`
- `npm install-scripts ls`
- `npm run check`
- `npm run typecheck`
- `npm run build:admin`
- `npm run db:generate`
- `npm test`
- `npm run test:harness`
- `npm run openapi:check`
- `npm run consumer:check`
