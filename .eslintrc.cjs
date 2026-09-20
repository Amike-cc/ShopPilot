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
    'no-unused-vars': 'off', // 由 @typescript-eslint/no-unused-vars 接管
    'no-undef': 'off', // TypeScript 编译器已检查
    'no-empty': ['error', { allowEmptyCatch: true }], // 允许空 catch 块但其他空块报错
    'no-extra-semi': 'warn',
    'no-useless-escape': 'warn',
    'vue/multi-word-component-names': 'off',
    '@typescript-eslint/no-explicit-any': 'warn', // 鼓励使用具体类型
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
  }
}
