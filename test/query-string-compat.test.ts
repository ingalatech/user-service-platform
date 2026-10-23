import { resolve } from 'node:path';
import { createServer } from 'vite';
import adminConfig from '../admin/vite.config';
import { describe, expect, it } from 'vitest';

type QueryParameters = (params: Record<string, string>) => string;
interface RaFetchModule {
  readonly queryParameters: QueryParameters;
}

interface QueryStringModule {
  readonly parse: (value: string) => Record<string, string>;
  readonly stringify: QueryParameters;
  readonly default: { readonly stringify: QueryParameters };
}

function assertQueryStringModule(value: unknown): asserts value is QueryStringModule {
  if (typeof value !== 'object' || value === null) throw new Error('invalid query-string module');
  const module = value as Partial<QueryStringModule>;
  if (
    typeof module.parse !== 'function' ||
    typeof module.stringify !== 'function' ||
    typeof module.default?.stringify !== 'function'
  ) {
    throw new Error('invalid query-string module');
  }
}

function assertRaFetchModule(value: unknown): asserts value is RaFetchModule {
  if (typeof value !== 'object' || value === null) throw new Error('invalid ra-core fetch module');
  const module = value as Partial<RaFetchModule>;
  if (typeof module.queryParameters !== 'function') {
    throw new Error('invalid ra-core fetch module');
  }
}

describe('React Admin query-string Vite compatibility', () => {
  it('resolves ra-core named imports through the admin alias', async () => {
    const server = await createServer({
      ...adminConfig,
      root: resolve(process.cwd(), 'admin'),
      ssr: { noExternal: ['ra-core'] },
    });

    try {
      const raFetch = await server.ssrLoadModule(
        resolve(process.cwd(), 'node_modules/ra-core/dist/dataProvider/fetch.js'),
      );
      const queryString = await server.ssrLoadModule('query-string');

      assertRaFetchModule(raFetch);
      expect(raFetch.queryParameters({ page: '2', filter: 'email' })).toBe('filter=email&page=2');
      assertQueryStringModule(queryString);
      expect(queryString.parse('?source=%7B%22email%22%3A%22a%40example.com%22%7D')).toEqual({
        source: '{"email":"a@example.com"}',
      });
      expect(queryString.default.stringify({ page: '2', filter: 'email' })).toBe(
        'filter=email&page=2',
      );
    } finally {
      await server.close();
    }
  });
});
