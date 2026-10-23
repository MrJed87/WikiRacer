import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The race, wiki and llm layers must stay DOM-free so they run in Node.
    files: ['src/race/**/*.ts', 'src/wiki/**/*.ts', 'src/llm/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'This layer must not touch the DOM.' },
        { name: 'window', message: 'This layer must not touch the DOM.' },
        { name: 'DOMParser', message: 'This layer must not touch the DOM.' },
      ],
    },
  },
);
