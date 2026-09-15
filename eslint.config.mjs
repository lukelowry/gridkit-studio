import ts from '@typescript-eslint/parser'
import imports from 'eslint-plugin-simple-import-sort'
import svelte from 'svelte-eslint-parser'

export default [
  {
    files: ['src/**/*.ts', 'src/**/*.svelte', 'tests/**/*.ts', 'tests/**/*.mjs', '*.mjs', '*.ts'],
    languageOptions: { parser: ts },
    plugins: { imports },
    rules: {
      'imports/imports': 'error',
      'imports/exports': 'error',
      'one-var': ['error', 'never'],
    },
  },
  {
    files: ['src/**/*.svelte'],
    languageOptions: { parser: svelte, parserOptions: { parser: ts } },
  },
]
