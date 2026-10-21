import { createConsumerClient, type ConsumerClient } from '../index.js';

// Shared per-tab consumer client for Astro page scripts (spec #150,
// ticket #152). Astro serves shared editorial HTML; each inline
// `<script>` and each React island imports this module, so the tab holds one
// controller, one token and one JWKS cache. Full document navigations reuse
// the stored token without an identity request; renewal is lazy and shared.
//
// Usage in an Astro component (see docs/operations/consumer-client.md):
//
// ```astro
// <script>
//   import { consumerClient, snapshotText } from './astro-page-script.js';
//   const client = consumerClient({ baseUrl: location.origin, issuer, audience });
//   const text = await snapshotText(client, { anonymousText: '', unavailableText: '' });
// </script>
// ```
const SINGLETON_KEY = '__userServiceConsumerClient';

export interface AstroConsumerConfig {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly audience: string;
}

// Returns the tab-shared client, creating it once. Module state survives
// across Astro scripts on the same document; sessionStorage carries the token
// across full document navigations and reloads within the tab.
export function consumerClient(config: AstroConsumerConfig): ConsumerClient {
  const globals = globalThis as Record<string, unknown>;
  const key = `${SINGLETON_KEY}:${config.baseUrl}:${config.issuer}:${config.audience}`;
  const existing = globals[key];
  if (typeof existing === 'object' && existing !== null) {
    return existing as ConsumerClient;
  }
  const created = createConsumerClient({
    baseUrl: config.baseUrl,
    issuer: config.issuer,
    audience: config.audience,
  });
  globals[key] = created;
  return created;
}

// Resolves the locally verified snapshot for rendering. Anonymous visitors
// make no identity request; failures surface as text for the page shell to
// render instead of user data.
export async function snapshotText(
  client: ConsumerClient,
  input: { anonymousText: string; unavailableText: string },
): Promise<string> {
  try {
    const snapshot = await client.getSnapshot();
    if (snapshot === null) {
      return input.anonymousText;
    }
    return snapshot.email;
  } catch {
    return input.unavailableText;
  }
}
