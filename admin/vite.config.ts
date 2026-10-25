import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

function adminContractDependencyCheck(): Plugin {
  return {
    name: 'admin-contract-dependency-check',
    generateBundle(_options, bundle) {
      const moduleIds = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk'
          ? [...Object.keys(output.modules), ...output.imports, ...output.dynamicImports]
          : [],
      );
      const forbidden = moduleIds.filter(
        (id) =>
          id.includes('/src/features/identity/') ||
          id.includes('/src/shared/problem.ts') ||
          id.startsWith('@hono/') ||
          /(?:^|\/)hono(?:\/|$)/.test(id),
      );
      if (forbidden.length > 0) {
        throw new Error(
          `Admin browser bundle includes server-only modules: ${forbidden.join(', ')}`,
        );
      }
    },
  };
}

export default defineConfig({
  base: '/admin/',
  plugins: [adminContractDependencyCheck(), react(), tailwindcss()],
  resolve: {
    dedupe: [
      'react',
      'react-dom',
      'react-router',
      'react-router-dom',
      '@tanstack/react-query',
      'react-hook-form',
    ],
    alias: {
      '@': fileURLToPath(new URL('./src/kit', import.meta.url)),
      'query-string': fileURLToPath(new URL('./src/query-string-compat.ts', import.meta.url)),
    },
  },
  server: { proxy: { '/v1': 'http://127.0.0.1:8787', '/auth-actions': 'http://127.0.0.1:8787' } },
});
