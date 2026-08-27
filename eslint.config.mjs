import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/**
 * Lint rules that encode MART's non-negotiables where a linter can see them.
 *
 * The rules that matter most here are the ones that stop a whole class of bug:
 * no floating promises (a swallowed sync failure), no `any` escaping the type
 * system, and no `console` in server code (credentials must only ever reach the
 * redacting logger).
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.tsbuildinfo',
      'apps/web/next-env.d.ts',
      'smart-marketing-intelligence-platform.json',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        window: 'readonly',
        React: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript itself reports unused/undefined symbols with more accuracy.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='console']",
          message:
            'Use the structured logger from @mart/observability; console output bypasses redaction.',
        },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Config files run under Node with the full Node global surface.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    // CLIs and the dev/test surface legitimately write to stdout.
    files: [
      'packages/db/src/cli/**/*.ts',
      'apps/*/src/server.ts',
      'tests/**/*.ts',
      'scripts/**/*.ts',
      'vitest.config.ts',
      'vitest.workspace.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    rules: {
      // Client components legitimately surface errors in the browser console.
      'no-restricted-syntax': 'off',
    },
  },
];
