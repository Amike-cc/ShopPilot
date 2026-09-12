import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const desktopRoot = resolve('apps/desktop')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
