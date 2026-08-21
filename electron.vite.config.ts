import { resolve } from 'path'
import {
  onethingPackageAliases as createOnethingPackageAliases,
  electronHostAliases as createElectronHostAliases
} from './onething.aliases'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// `@onething/{core,gateway,runtime}` 一条 alias 都不需要 —— 真 workspace 包,走各自
// package.json 的 exports。表里只剩装配层 `@onething/app`(包名不是 runtime 子路径)。
const onethingPackageAliases = createOnethingPackageAliases(__dirname)
// apps/electron 的内部路径别名(@onething/electron-host/*)只在这份配置和 vitest
// 里出现 —— 它是宿主自己的目录写法,不是一个跨宿主的包,不该躺在包表里。
const electronHostAliases = createElectronHostAliases(__dirname)

// 自举开发的第二条泳道(scripts/dev-self.mjs)要能和日常 dev 并行:
// 渲染进程端口和 main/preload 产物目录都可用 env 错开,缺省与从前完全一致。
// 端口变了主进程不用改 —— electron-vite 会把实际端口写进 ELECTRON_RENDERER_URL。
const rendererPort = Number(process.env.ONETHING_RENDERER_PORT) || 5173
const outDirRoot = process.env.ONETHING_ELECTRON_OUT_DIR
const scopedOutDir = (scope: string) =>
  outDirRoot ? { outDir: resolve(__dirname, outDirRoot, scope) } : {}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      ...scopedOutDir('main'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/electron/src/main.ts'),
          cli: resolve(__dirname, 'apps/electron/src/main/cli/index.ts')
        }
      }
    },
    resolve: {
      alias: [
        ...onethingPackageAliases,
        ...electronHostAliases,
        { find: '@main', replacement: resolve(__dirname, 'apps/electron/src/main') },
        { find: '@shared', replacement: resolve(__dirname, 'packages/shared') }
      ]
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      ...scopedOutDir('preload'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/electron/src/preload.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    },
    resolve: {
      alias: [
        ...onethingPackageAliases,
        ...electronHostAliases,
        { find: '@shared', replacement: resolve(__dirname, 'packages/shared') }
      ]
    }
  },
  renderer: {
    root: '.',
    build: {
      ...scopedOutDir('renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    },
    resolve: {
      alias: [
        ...electronHostAliases,
        { find: '@', replacement: resolve(__dirname, 'packages/renderer') },
        { find: '@renderer', replacement: resolve(__dirname, 'packages/renderer') },
        { find: '@shared', replacement: resolve(__dirname, 'packages/shared') }
      ]
    },
    plugins: [vue()],
    server: {
      host: '127.0.0.1',
      port: rendererPort
    }
  }
})
