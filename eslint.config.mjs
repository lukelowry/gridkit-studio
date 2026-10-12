import ts from '@typescript-eslint/parser'
import imports from 'eslint-plugin-simple-import-sort'
import svelte from 'svelte-eslint-parser'

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
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name=/^(test|it|suite|describe)$/][property.name='only']",
          message: 'Run one test with GRIDKIT_TEST_GREP, or vitest -t, never .only.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.svelte'],
    languageOptions: { parser: svelte, parserOptions: { parser: ts } },
  },
]
