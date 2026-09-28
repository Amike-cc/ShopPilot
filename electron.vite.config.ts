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
    // 店铺页面是主窗口里的真实 Electron <webview>（webPreferences.webviewTag: true）。
    // Vue 默认把未知小写标签当组件解析，会在开发态刷 "Failed to resolve component: webview"
    // 并把 :partition / @did-attach 当组件 props/emit 处理；声明成自定义元素后
    // 这些绑定按原生属性与 DOM 事件落到元素上，正是 webview 需要的语义。
    plugins: [vue({ template: { compilerOptions: { isCustomElement: tag => tag === 'webview' } } })],
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
