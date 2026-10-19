import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// 与 electron.vite.config.ts 的 @shared 别名保持一致，单测才能导入主进程/shared 源码
// （vue() 用于直接挂载 .vue 组件的运行时测试，例如客服工作区移动抽屉）
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve('packages/shared/src')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts']
  }
})
