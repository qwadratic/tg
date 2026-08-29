// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'data/**'] },
  eslint.configs.recommended,
  // Type-checked, not plain `recommended`: the rules worth having here
  // (no-floating-promises, no-misused-promises) need type information, and a
  // dropped await in an async CLI is exactly the defect class this catches.
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // tsconfig.json covers src only; this one also covers test/.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The point of the strictness phase: `any` cannot come back in silently.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Off deliberately: commander actions and runCommand callbacks must be
      // `async` to satisfy their signatures even when the body happens to be
      // synchronous. Here the flag would only report the signature, not a bug.
      '@typescript-eslint/require-await': 'off'
    }
  },
  {
    // A node:test idiom, not a defect: `test(...)` returns a promise nobody
    // awaits, because the runner does.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] }
      ]
    }
  }
)
