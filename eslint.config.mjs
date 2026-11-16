import ts from '@typescript-eslint/parser'
import imports from 'eslint-plugin-simple-import-sort'
import svelte from 'svelte-eslint-parser'

const ONLY = {
  selector: "MemberExpression[object.name=/^(test|it|suite|describe)$/][property.name='only']",
  message: 'Run one test with GRIDKIT_TEST_GREP, or vitest -t, never .only.',
}
const NOTIFIES = {
  selector: 'CallExpression[callee.property.name=/^show(Error|Warning|Information)Message$/]',
  message: 'Only the Reporter tells the user why something failed: src/extension/report.ts.',
}
const REGISTERS = {
  selector: "CallExpression[callee.property.name='registerCommand']",
  message: 'Register commands through Studio.command, which reports their errors.',
}

export default [
  {
    files: [
      'src/**/*.ts',
      'src/**/*.svelte',
      'tests/**/*.ts',
      'tests/**/*.mjs',
      'scripts/**/*.mjs',
      '*.mjs',
      '*.ts',
    ],
    languageOptions: { parser: ts },
    plugins: { imports },
    rules: {
      'imports/imports': 'error',
      'imports/exports': 'error',
      'one-var': ['error', 'never'],
      'no-restricted-syntax': ['error', ONLY],
    },
  },
  // Notifications are shown only from report.ts, and commands registered only in studio.ts.
  {
    files: ['src/**/*.ts', 'src/**/*.svelte'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ONLY, NOTIFIES, REGISTERS] },
  },
  {
    files: ['src/extension/report.ts'],
    rules: { 'no-restricted-syntax': ['error', ONLY, REGISTERS] },
  },
  {
    files: ['src/extension/studio.ts'],
    rules: { 'no-restricted-syntax': ['error', ONLY, NOTIFIES] },
  },
  {
    files: ['src/**/*.svelte'],
    languageOptions: { parser: svelte, parserOptions: { parser: ts } },
  },
]
