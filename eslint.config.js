import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['eslint.config.js', '**/dist/**', '**/node_modules/**', 'infra/cdk.out/**', '**/coverage/**', 'e2e/test-results/**', 'e2e/playwright-report/**', '.local-storage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': ['error', { selector: "Literal[value=/SERVICE_ROLE/]", message: 'Service-role credentials must never be referenced in client code.' }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['services/**', 'infra/**', 'tests/**', 'e2e/**', 'packages/**', 'scripts/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
