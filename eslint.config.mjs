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
  message: 'Register a command through Sessions.command, which says why one fails.',
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
  // Studio says why something failed in one place, and makes its commands in one.
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
    files: ['src/extension/sessions.ts'],
    rules: { 'no-restricted-syntax': ['error', ONLY, NOTIFIES] },
  },
  {
    files: ['src/**/*.svelte'],
    languageOptions: { parser: svelte, parserOptions: { parser: ts } },
  },
]
