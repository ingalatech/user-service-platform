import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
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
