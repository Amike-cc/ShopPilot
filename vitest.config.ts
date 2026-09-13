import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// 与 electron.vite.config.ts 的 @shared 别名保持一致，单测才能导入主进程/shared 源码
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('packages/shared/src')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts']
  }
})
