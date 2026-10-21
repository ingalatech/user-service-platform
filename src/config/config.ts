import {
  LOCAL_PROFILE,
  NON_SECRET_VAR_NAMES,
  parseNonSecretProfile,
  type CanonicalEnvironment,
  type NonSecretProfile,
} from './profiles.js';

declare const __USER_SERVICE_COMPILED_CONFIG__: NonSecretProfile | undefined;

const warnedRuntimeBindings = new WeakMap<NonSecretProfile, Set<string>>();

// Resolved operational context. `test` is the isolated automated-test
// context: it reuses the local non-secret shape but is never a deployment
// target. The legacy `staging` runtime value normalizes to `sandbox`; no
// staging profile, variable or documentation is introduced.
export type ResolvedEnvironment = CanonicalEnvironment | 'test';

export interface EffectiveConfig {
  readonly environment: ResolvedEnvironment;
  // Merged non-secret configuration only. Secrets passed alongside the
  // runtime input are never copied here; callers hand them directly to the
  // identity resolvers that require them.
  readonly config: NonSecretProfile;
}

export interface ResolveEffectiveConfigInput {
  readonly environment?: string;
  // Test/release seam for the same profile Wrangler injects through `define`.
  // Production callers omit this and receive the bundled value automatically.
  readonly compiledProfile?: NonSecretProfile;
  // Raw runtime values (Worker bindings or `.env` overrides). They are merged
  // only when no compiled profile is present; compiled deployments ignore
  // same-name runtime bindings. Secrets and unknown keys are ignored.
  readonly runtime?: Record<string, unknown>;
}

function readCompiledProfile(): NonSecretProfile | undefined {
  if (typeof __USER_SERVICE_COMPILED_CONFIG__ === 'undefined') {
    return undefined;
  }
  return parseNonSecretProfile(__USER_SERVICE_COMPILED_CONFIG__);
}

export function readEffectiveEnvironment(
  runtime: {
    readonly ENVIRONMENT?: unknown;
  } = {},
): string {
  return (
    readCompiledProfile()?.ENVIRONMENT ??
    (typeof runtime.ENVIRONMENT === 'string' ? runtime.ENVIRONMENT : 'local')
  );
}

function warnIgnoredRuntimeBindings(
  compiledProfile: NonSecretProfile,
  runtime: Record<string, unknown>,
): void {
  const bindings = NON_SECRET_VAR_NAMES.filter((name) =>
    Object.prototype.hasOwnProperty.call(runtime, name),
  );
  if (bindings.length === 0) return;
  const signature = bindings.join('\u0000');
  const warned = warnedRuntimeBindings.get(compiledProfile);
  if (warned?.has(signature)) return;
  if (warned === undefined) {
    warnedRuntimeBindings.set(compiledProfile, new Set([signature]));
  } else {
    warned.add(signature);
  }
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'config.runtime-binding-ignored',
      bindings,
    }),
  );
}

// Normalizes a raw environment name (`parseDontValidate`: returns the
// refined value instead of check-and-forget). Unknown names fail early with
// a redacted error that names the canonical environments but never echoes
// the offending value.
function normalizeEnvironmentName(value: string | undefined): ResolvedEnvironment {
  const normalized = (value ?? 'local').trim().toLowerCase();
  if (normalized === 'local') {
    return 'local';
  }
  if (normalized === 'sandbox') {
    return 'sandbox';
  }
  if (normalized === 'production') {
    return 'production';
  }
  if (normalized === 'staging') {
    return 'sandbox';
  }
  if (normalized === 'test') {
    return 'test';
  }
  throw new Error(
    'Configuration error: ENVIRONMENT must be one of "local", "sandbox" or "production".',
  );
}

function parseBooleanFlag(name: string, value: string): void {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'false') {
    return;
  }
  throw new Error(`Configuration error: ${name} must be "true" or "false".`);
}

function validateProfile(config: NonSecretProfile): void {
  parseBooleanFlag('AUTH_REGISTRATION_ENABLED', config.AUTH_REGISTRATION_ENABLED);
  parseBooleanFlag('AUTH_EMAIL_PASSWORD_ENABLED', config.AUTH_EMAIL_PASSWORD_ENABLED);
  parseBooleanFlag('AUTH_REQUIRE_EMAIL_VERIFICATION', config.AUTH_REQUIRE_EMAIL_VERIFICATION);
  const transport = config.AUTH_MAIL_TRANSPORT.trim().toLowerCase();
  if (
    transport !== '' &&
    transport !== 'inmemory' &&
    transport !== 'resend' &&
    transport !== 'smtp'
  ) {
    throw new Error(
      'Configuration error: AUTH_MAIL_TRANSPORT must be "inmemory", "resend" or "smtp" when set.',
    );
  }
  const secure = config.SMTP_SECURE.trim().toLowerCase();
  if (secure !== '' && secure !== 'true' && secure !== 'false') {
    throw new Error('Configuration error: SMTP_SECURE must be "true" or "false" when set.');
  }
  validateAuthActionUrl(
    'AUTH_VERIFY_EMAIL_ACTION_URL',
    config.AUTH_VERIFY_EMAIL_ACTION_URL,
    config.ENVIRONMENT,
  );
  validateAuthActionUrl(
    'AUTH_RESET_PASSWORD_ACTION_URL',
    config.AUTH_RESET_PASSWORD_ACTION_URL,
    config.ENVIRONMENT,
  );
}

// Loopback hosts permitted for plain-HTTP action pages in local/test
// development (ticket #77): `localhost`, the IPv4 loopback range and the IPv6
// loopback address. Bracketed IPv6 literals are unwrapped before comparison.
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

// Validates one canonical auth action URL slot (ticket #77). Empty means the
// service-owned fallback page. Configured values must be absolute http(s)
// action-page URLs without credentials or fragments; sandbox/production
// custom targets require HTTPS while local/test allow plain HTTP only for
// localhost/loopback development. Every failure names only the variable and
// the expected shape, never the supplied value.
function validateAuthActionUrl(name: string, value: string, environment: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Configuration error: ${name} must be an absolute http(s) action URL without credentials or fragments.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Configuration error: ${name} must be an absolute http(s) action URL without credentials or fragments.`,
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
    throw new Error(
      `Configuration error: ${name} must be an absolute http(s) action URL without credentials or fragments.`,
    );
  }
  const normalizedEnv = environment.trim().toLowerCase();
  const productionLike =
    normalizedEnv === 'sandbox' || normalizedEnv === 'staging' || normalizedEnv === 'production';
  if (productionLike) {
    if (parsed.protocol !== 'https:') {
      throw new Error(
        `Configuration error: ${name} must be an absolute https action URL without credentials or fragments.`,
      );
    }
    return;
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `Configuration error: ${name} must be an absolute https action URL or an http action URL for localhost/loopback development without credentials or fragments.`,
    );
  }
}

// Resolves the effective non-secret configuration. Remote bundles use the
// complete profile substituted by Wrangler; local/test execution uses the
// local profile with same-name runtime values overlaid. This is the single
// parse-and-validate entry point; every failure is a redacted `Error` carrying
// variable names and expected shapes, never runtime values.
export function resolveEffectiveConfig(input: ResolveEffectiveConfigInput): EffectiveConfig {
  const compiledProfile =
    input.compiledProfile === undefined
      ? readCompiledProfile()
      : parseNonSecretProfile(input.compiledProfile);
  const environment = normalizeEnvironmentName(compiledProfile?.ENVIRONMENT ?? input.environment);
  const runtime = input.runtime ?? {};
  const merged: NonSecretProfile = compiledProfile
    ? { ...compiledProfile }
    : {
        ...LOCAL_PROFILE,
        ENVIRONMENT: environment === 'test' ? 'local' : environment,
      };
  if (compiledProfile !== undefined) {
    warnIgnoredRuntimeBindings(compiledProfile, runtime);
  } else {
    for (const name of NON_SECRET_VAR_NAMES) {
      const value: unknown = runtime[name];
      if (typeof value === 'string') {
        merged[name] = value;
      }
    }
  }
  validateProfile(merged);
  return { environment, config: merged };
}

// Application-boundary guard for request paths that still consume raw Worker
// bindings: parses and validates the effective non-secret configuration once
// and fails early. Secrets in the input are ignored here and continue to
// flow directly to the identity resolvers.
export function assertValidNonSecretConfig(runtime: Record<string, unknown>): void {
  const environment: unknown = runtime.ENVIRONMENT;
  resolveEffectiveConfig({
    environment: typeof environment === 'string' ? environment : undefined,
    runtime,
  });
}
