import parser from '@typescript-eslint/parser'
import e2 from './packages/eslint-plugin-e2/src/index.ts'

export default [
  {
    files: ['src/**/*.ts', 'packages/**/*.ts', 'examples/**/*.ts', 'scripts/**/*.ts'],
    // Fixtures are meant to fail; the spike is types-only.
    ignores: ['src/tests/diagnostics/**', 'spike/**', 'dist/**', '**/lib/**'],
    languageOptions: {
      parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { e2 },
    rules: {
      'e2/no-floating-fx': 'error',
    },
  },
]
