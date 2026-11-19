// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Project rule: classes are allowed only where NestJS requires them (apps/api, apps/worker).
 * Everything else — shared rules, db, domain, web, tests — is functional.
 */
const noClasses = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ClassDeclaration',
      message: 'Classes are reserved for NestJS (apps/api, apps/worker). Use functions and data.',
    },
    {
      selector: 'ClassExpression',
      message: 'Classes are reserved for NestJS (apps/api, apps/worker). Use functions and data.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/next-env.d.ts',
      'apps/web/postcss.config.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', 'packages/*/*.ts', 'apps/*/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['packages/**/*.ts', 'apps/web/**/*.{ts,tsx}'],
    rules: noClasses,
  },
  {
    // Tests may assert presence with `!` and use expression-bodied callbacks in it.each.
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    // NestJS needs classes and decorators.
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-unsafe-class-instance-assignment': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
    },
  },
  {
    files: ['*.js', '**/*.config.{js,ts,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
