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
  },
  overrides: [
    {
      // 2026-09-26 审计 P2：`packages/shared` 是**两个进程共用的纯规则与契约**，
      // 这里的 any 会同时污染主进程与渲染层的类型判断，所以在这一层把显式 any 直接当错误
      // （其它层仍是 warn 的存量技术债）。例外只有 contracts/ipc.ts 的 IPC 信封默认泛型，
      // 它在文件内用 eslint-disable + 说明标注。
      files: ['packages/shared/src/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'error'
      }
    }
  ]
}
