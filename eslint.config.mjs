import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // The pinned upstream kit is source-faithful third-party code (admin/README.md).
    ignores: [
      'coverage/**',
      '**/dist/**',
      '.wrangler/**',
      '**/node_modules/**',
      'admin/src/kit/**',
      // Generated consumer TypeScript contracts are openapi-typescript
      // outputs (ADR-0007, ticket #152); drift is enforced by
      // `npm run consumer:check`, not by lint.
      'src/features/identity/consumer-client/generated/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
  },
  {
    // Typed linting (ADR-0006): mandatory now that the application TypeScript
    // project exists. Runs in CI with zero warnings via `npm run lint`.
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
    },
  },
  eslintConfigPrettier,
);
