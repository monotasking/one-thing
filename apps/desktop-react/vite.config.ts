import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { onethingDevApiProxy } from './vite/dev-api-proxy'

// 仓根:alias 一律指**源码目录**(apps/web 同款做法,见 apps/web/vite.config.ts)。
const repoRoot = resolve(__dirname, '../..')

/**
 * **一份配置两种壳**(运行时统一第四步 4a,2026-09-03;用户已拍「浏览器壳由 React 壳提供」)。
 *
 * 判据是 vite 的 `mode`,**不是** env:`--mode web` 是 vite 自己的一等参数,
 * `vite build --mode web` 与 `vite --mode web` 用同一个词,而 env 变量在
 * `vite build` 的子进程链上容易漏传。为了让门脚本与手起两条路都好走,
 * `ONETHING_SHELL=web` 也认 —— 两个口任一命中即为 web 模式,合并语义只在这一行。
 *
 * | | 桌面模式(缺省) | web 模式 |
 * |---|---|---|
 * | dev 端口 | 5175(与旧 Electron renderer 5173 / apps/web 5174 互不打架) | **5174**(接替 apps/web,4b 之后是唯一的那条) |
 * | `/api` | 不接 —— Electron 主进程经 `host:connection` 把 `{baseUrl, token}` 交给渲染层 | 动态代理插件(读发现文件 + 注入 Bearer,见 vite/dev-api-proxy.ts) |
 * | `build.outDir` | `apps/desktop-react/dist`(vite 缺省,主进程 `loadFile` 读它) | 仓根 `dist/web`(与 apps/web 今天的产物路径**同一个**) |
 *
 * 桌面那一列在本批**一个字都没动** —— 上面三格 web 侧的值全部挂在 `isWebShell`
 * 这一个布尔后面,缺省路径与 4a 之前逐字相同。
 *
 * `base: './'` 两边共用:桌面要它(生产窗口 `loadFile` 读本地文件,绝对路径进不去
 * asar),web 侧要它是为了「产物能被任何静态服务器托在任何前缀下」。
 */
export default defineConfig(({ mode }) => {
  const isWebShell = mode === 'web' || process.env.ONETHING_SHELL === 'web'

  return {
    // **显式钉 root**(4a 加):vite 的 `root` 缺省是 `process.cwd()`,而 web 模式的
    // 两条根脚本(`web:dev:react` / `web:build:react`)是在**仓根**起的 —— 不钉的话
    // vite 会拿仓根那份 `index.html`(Vue 宿主的)当入口。钉成配置自己所在的目录之后
    // 两条路(仓根起 / 本目录 `npm run dev` 起)同解;`cacheDir` / `publicDir` /
    // 相对 `outDir` 的落点与 4a 之前逐字相同,桌面泳道没有任何行为变化。
    root: __dirname,
    plugins: [react(), ...(isWebShell ? [onethingDevApiProxy()] : [])],
    resolve: {
      // `@onething/*` 一条 alias 都没有:core / runtime / backend / client 都是真
      // workspace 包,走 node 解析 + 各自 package.json 的 exports(从仓根
      // node_modules 命中软链)。
      //
      // C1 起 `@shared` 也是这里**唯一**的一条:指向 packages/renderer 的那两条
      // (它的包别名与它内部的自指别名)随「React 壳对 packages/renderer 零 import」
      // 一起删了 —— 壳的传输 / 域客户端 / 纯判据现在全部取自 `@onething/client`。
      alias: [
        { find: '@shared', replacement: resolve(repoRoot, 'packages/shared') },
      ],
    },
    server: {
      host: '127.0.0.1',
      // 5173 是旧 Electron renderer、5174 是浏览器壳;新壳的桌面泳道占 5175,
      // 三条泳道互不打架。web 模式接的就是 5174 那条(接替 apps/web)。
      port: isWebShell ? 5174 : 5175,
      strictPort: true,
      /**
       * **起服就开始转换首屏那张图,别等页面来敲门**(2026-09-15)。
       *
       * 病:`scripts/dev-app.mjs` 每次 `electron:dev` 都起一份**新**的 dev server,
       * 转换缓存是冷的;而 Electron 从 spawn 到 `loadURL` 要 ~0.8s、再加后端装配
       * ~1.7s,这两秒半里 vite 一个模块都没转。页面一来才开始冷转首屏静态 import
       * 图的 **873 个模块**(696 `/src` + 163 `@fs` 里的 packages,每个 tsx 还要过
       * `@vitejs/plugin-react` 的 Babel),空机 2.4–2.7s、满载 10s —— 同一台服务器
       * 热重载只要 0.39s,差的全是这一次冷转。
       *
       * `warmup.clientFiles` 就是「起服后立刻按这张单子 `transformRequest`」;vite 的
       * import 分析对每个被转换的模块都会**沿静态 import 继续预转换**下去
       * (`server.preTransformRequests` 缺省 true),所以单子上只要有入口,整张静态图
       * 都会被拖进转换缓存 —— 实测:起服后不接任何浏览器,6 秒内 client moduleGraph
       * 自己长到 870+ 个模块(见本批报告的 moduleGraph 读数)。
       *
       * 为什么只写 `./src/main.tsx` 一个:它就是 `index.html` 唯一的 `<script type=
       * "module">`,首屏那张图整个挂在它后面。多列一个入口只会让同一批模块被排两次
       * 队,少列一个(比如写某个具体面板)反而会漏掉根上的东西。这张单子要跟着
       * `index.html` 的入口走,不跟着「哪个面板慢」走。
       *
       * 为什么这份钱是白吃的:`dev-app.mjs` 里 vite 起在 Electron spawn **之前**
       * (同一批把 `createServer` 挪到了 `build-electron` 前面),warmup 花的 CPU
       * 全落在 Electron 起进程 + 装配 backend 的那两秒多里 —— 那段时间 vite 本来就
       * 闲着,页面还没有。最坏情况(页面比 warmup 先到)也只是两边抢同一个转换
       * 队列,vite 对同一个模块的 `transformRequest` 是共享 promise 的,不会转两次。
       *
       * 两种 mode 都开:web 壳(5174)是先起 vite 再由人手开浏览器,头更长,更划算。
       */
      warmup: { clientFiles: ['./src/main.tsx'] },
    },
    build: {
      // Electron 生产窗口用 loadFile 读本地文件,必须是相对路径。
      assetsDir: 'assets',
      // web 模式的产物落在**仓根 dist/web** —— 与 apps/web 今天的落点逐字相同,
      // 于是任何指着那个目录的东西(部署脚本、静态服务器)不必跟着改。
      ...(isWebShell ? { outDir: resolve(repoRoot, 'dist/web'), emptyOutDir: true } : {}),
    },
    base: './',
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }
})
