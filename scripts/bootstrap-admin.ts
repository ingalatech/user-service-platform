// First-administrator bootstrap operator script (ticket #59, spec #8).
//
// Creates the first administrative User through the running Worker's public
// HTTP boundary (`POST /v1/auth/admin/bootstrap`) after the versioned D1
// migrations have been applied. Credentials travel only as explicit operator
// inputs; the repository defines no default admin password and this script
// stores none.
//
// Typical local use against fresh local D1 (ticket #57 canonical path):
//
// ```bash
// npm run db:local:reset
// npm run dev:local
// ADMIN_NAME="Site Admin" ADMIN_EMAIL="admin@example.com" \
//   ADMIN_PASSWORD="Correct-horse-41" npm run admin:bootstrap
// ```
//
// Redaction (ADR-0009): this script logs only HTTP method, path, status and
// stable problem codes. Names, email addresses, passwords, tokens, cookies,
// action URLs and message bodies never enter its output.

export interface BootstrapConfig {
  readonly baseUrl: string;
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

type BootstrapEnv = Pick<NodeJS.ProcessEnv, string> & {
  readonly ADMIN_BOOTSTRAP_BASE_URL?: string;
  readonly ADMIN_NAME?: string;
  readonly ADMIN_EMAIL?: string;
  readonly ADMIN_PASSWORD?: string;
};

function readEnv(env: BootstrapEnv, name: keyof BootstrapEnv): string {
  return (env[name] ?? '').trim();
}

// Resolves operator inputs. Every failure names the variable and the
// expected shape; values are never echoed, so a missing or invalid secret
// cannot leak through the error itself.
export function resolveBootstrapConfig(env: BootstrapEnv = process.env): BootstrapConfig {
  const baseUrl = readEnv(env, 'ADMIN_BOOTSTRAP_BASE_URL');
  const name = readEnv(env, 'ADMIN_NAME');
  const email = readEnv(env, 'ADMIN_EMAIL');
  const password = readEnv(env, 'ADMIN_PASSWORD');
  if (name.length === 0) {
    throw new Error('ADMIN_NAME is required (display name for the first administrator).');
  }
  if (email.length === 0) {
    throw new Error('ADMIN_EMAIL is required (email address for the first administrator).');
  }
  if (password.length === 0) {
    throw new Error('ADMIN_PASSWORD is required (password for the first administrator).');
  }
  return {
    baseUrl: baseUrl.length > 0 ? baseUrl : 'http://localhost:8787',
    name,
    email,
    password,
  };
}

export function assertSafeBootstrapTarget(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Refusing admin bootstrap without a valid ADMIN_BOOTSTRAP_BASE_URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Refusing admin bootstrap for a non-HTTP(S) target.');
  }
  return url;
}

interface ProblemShape {
  readonly code?: unknown;
  readonly status?: unknown;
}

function problemCode(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as ProblemShape).code;
    return typeof code === 'string' ? code : '<missing-code>';
  }
  return '<non-json>';
}

function fieldValue(payload: unknown, field: string): string {
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '<missing>';
  }
  return '<non-json>';
}

async function main(): Promise<void> {
  const config = resolveBootstrapConfig();
  const target = assertSafeBootstrapTarget(config.baseUrl);
  const origin = target.origin;

  const res = await fetch(`${origin}/v1/auth/admin/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: config.name, email: config.email, password: config.password }),
  });
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  // Success bodies carry the application-owned admin representation
  // (`role: "admin"`); failure bodies carry RFC 9457 stable `code`. Only the
  // stable machine value is logged, never names, addresses or passwords.
  const outcome = res.status === 201 ? fieldValue(payload, 'role') : problemCode(payload);
  console.log(
    JSON.stringify({ level: 'info', step: 'admin-bootstrap', status: res.status, outcome }),
  );

  if (res.status === 201 && outcome === 'admin') {
    // The created administrator still completes the deployment
    // email-verification policy before signing in.
    return;
  }
  if (res.status === 409) {
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ level: 'error', step: 'admin-bootstrap', detail: 'failed' }));
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1]?.endsWith('bootstrap-admin.ts') === true;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.log(JSON.stringify({ level: 'error', step: 'admin-bootstrap', detail: message }));
    process.exitCode = 1;
  });
}
