import {
  createConsumerClient,
  type ConsumerClient,
  type ConsumerIdentitySnapshot,
} from '../index.js';

// Shared consumption pattern for React islands on cached editorial pages
// (spec #150, ticket #152). Islands must not each own a client: they share
// the tab singleton from `./astro-page-script.js` (or one built here) so
// concurrent islands coalesce into a single lazy renewal. This module is
// framework-neutral on purpose — no React import — and maps onto island state
// with the host's subscription primitive (wire `current`/`observe` to the
// host primitive, such as `useSyncExternalStore` in the consumer app).
export interface IslandConsumerState {
  readonly status: 'anonymous' | 'authenticated' | 'unavailable';
  readonly snapshot: ConsumerIdentitySnapshot | null;
}

export interface IslandController {
  readonly client: ConsumerClient;
  current(): Promise<IslandConsumerState>;
  refresh(): Promise<IslandConsumerState>;
  signOut(): Promise<IslandConsumerState>;
  observe(listener: () => void): () => void;
  dispose(): void;
}

function toState(snapshot: ConsumerIdentitySnapshot | null): IslandConsumerState {
  return snapshot === null
    ? { status: 'anonymous', snapshot: null }
    : { status: 'authenticated', snapshot };
}

function unavailable(): IslandConsumerState {
  return { status: 'unavailable', snapshot: null };
}

// Builds an island controller around one shared client instance. Pass the tab
// singleton so islands never split renewal or storage.
export function createIslandController(client: ConsumerClient): IslandController {
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  // Cross-tab logout clears the shared client state internally; re-emit so
  // islands on this tab re-render without polling Identity.
  const stopBroadcast = client.observeLogout(() => {
    emit();
  });
  return {
    client,
    current: async () => {
      try {
        return toState(await client.getSnapshot());
      } catch {
        return unavailable();
      }
    },
    refresh: async () => {
      try {
        return toState(await client.recoverSession());
      } catch {
        return unavailable();
      }
    },
    signOut: async () => {
      try {
        await client.logout();
      } catch {
        return unavailable();
      }
      emit();
      return toState(null);
    },
    observe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      stopBroadcast();
      listeners.clear();
    },
  };
}

export function islandClient(input: {
  baseUrl: string;
  issuer: string;
  audience: string;
}): ConsumerClient {
  return createConsumerClient({
    baseUrl: input.baseUrl,
    issuer: input.issuer,
    audience: input.audience,
  });
}
