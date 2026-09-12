import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const desktopRoot = resolve('apps/desktop')

export default defineConfig({
  main: {
    // electron-updater 必须内联打包：electron-builder 24 + pnpm 的依赖收集会漏掉
    // 它的部分叶子依赖（tiny-typed-emitter / lodash.escaperegexp / lodash.isequal），
    // 导致打包态主进程 require 即崩（asar 内 MODULE_NOT_FOUND，dev 态符号链接正常）。
    plugins: [externalizeDepsPlugin({ exclude: ['electron-updater'] })],
    resolve: {
      alias: {
        '@shared': resolve('packages/shared/src')
      }
    },
    build: {
      outDir: resolve(desktopRoot, 'out/main'),
      rollupOptions: {
        input: resolve(desktopRoot, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('packages/shared/src')
      }
    },
    build: {
      outDir: resolve(desktopRoot, 'out/preload'),
      rollupOptions: {
        input: resolve(desktopRoot, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(desktopRoot, 'src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(desktopRoot, 'src/renderer/src'),
        '@shared': resolve('packages/shared/src')
      }
    },
    build: {
      outDir: resolve(desktopRoot, 'out/renderer'),
      rollupOptions: {
        input: resolve(desktopRoot, 'src/renderer/index.html')
      }
    }
  }
})
