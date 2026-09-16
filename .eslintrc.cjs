/* eslint-env node */

module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    browser: true
  },
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-essential',
    '@vue/eslint-config-typescript/recommended'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  ignorePatterns: [
    'node_modules/**',
    'apps/desktop/out/**',
    'release/**',
    'artifacts/**',
    'logs/**',
    'wx-invite-test/**',
    '.npm-cache/**'
  ],
  rules: {
    'no-unused-vars': 'off',
    'no-undef': 'off',
    'no-empty': 'off',
    'no-extra-semi': 'off',
    'no-useless-escape': 'off',
    'vue/multi-word-component-names': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
  }
}
