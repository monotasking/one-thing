# 运行时统一(2026-09)—— 四步的总账与第三、四步方案

> 起因:09-02 深夜勘察发现仓里两个运行时(桌面 = Electron,server / CLI / vitest = 系统 Node)共用一份
> node_modules,而 better-sqlite3 这类 V8 ABI 专属插件结构上不可能两边都对;electron-builder.yml 一句
> 「已按 Electron ABI 编好」的假话活了两个月。用户 09-03 拍:去 castlabs 换官方 Electron、原生只许 N-API、
> Node 钉 24、壳只留 React。**统一不可能在运行时层做(桌面永远 Electron,server 永远 Node),只能在
> 依赖层(N-API / 内建)与版本层(Node 24)做,再把壳收成一个。**

## 0. 四步总账

| 步 | 内容 | 状态 |
| --- | --- | --- |
| ① 原生清账 | 官方 Electron 41.1.1、删 better-sqlite3 及脚本、`gate:native` 双运行时门、`.nvmrc` 24 / engines ≥22.13、删 experiment/castlabs-electron 分支 | **入库 ae4eadd5**;顺带 bunfig.toml 钉 hoisted(618479ea) |
| ② 客户端 SDK | `@onething/client`(C0 26293417)→ React 壳零 @renderer(C1 1cab7a17)→ Vue renderer 改消费(C2 752c8203) | **入库**,方案 docs/design/client-sdk-2026-09.md |
| ③ 换主 | 根脚本、`main` 字段、electron-builder 输入、dev 泳道、CLI 构建全部指向 React 壳;Vue 宿主降为 `vue:*` 别名 | 本文 §1 |
| ④ 退役 | **4a**(建设性):CLI 搬到 `apps/cli`、React 壳长出 web 模式接管浏览器壳、新门 `gate:web-shell:react` / **4b**(破坏性):删 apps/electron、packages/renderer、apps/web、vue/pinia/electron-vite/plugin-vue 依赖、server `?token=` 口与两道 Vue 真机门 | 4a **已做**(本文 §2.1);4b 方案 §2.2,待派 |

## 1. 第三步:换主(本批)

### 1.1 现状(只列会动的)

- 根 `package.json`:`"main": "./out/main/index.js"`(Vue 宿主 electron-vite 产物);`build` = `electron:build` = `build:native:mac && electron-vite build`;`electron:dev` = `dev-with-logging.mjs dev`(electron-vite dev);`dev-unified.mjs` 的 Electron 泳道 spawn `electron:dev`;`build:unpack` / `build:mac|win|linux` 都先 `npm run build`。
- `electron-builder.yml`:`files: out/**` + `package.json`;`extraResources` 五项(templates / docs / skills / native / models);`asarUnpack` sherpa 与 node-pty;`directories.buildResources: build`(icon.icns / ico / png 在根 `build/`);mac / win / linux target 表。
- React 壳:`apps/desktop-react` 自己有 `app:dev`(`scripts/dev-app.mjs`)与 `app:build`(vite build → `dist/` + esbuild → `dist-electron/{main,preload}.cjs`,`base: './'`,主进程 `loadFile(appRoot/dist/index.html)`,`host-ports.ts` 已把 `app.isPackaged` / `process.resourcesPath` 交给 backend 的路径解析);**没有打包配置**。
- CLI:`bin/onething.mjs` → `../out/main/cli.js`,那份 js 由 Vue 宿主的 `electron.vite.config.ts` 的第二入口(`apps/electron/src/main/cli/index.ts`)打出来。CLI 源码只 import `./daemon-client` / `./paths` / `./stdout` / `@shared/cli/protocol`,不吃 Vue 宿主任何东西;daemon 侧吃 `@onething/backend` 的 HeadlessBackend。
- 原生 `macos_panel.node`:Vue 宿主的窗口用;React 壳未引用;`build:native:mac` 仍要跑(它产出 `resources/native/macos_panel.node` 进 extraResources,第四步再定去留)。

### 1.2 改法

1. **根 `package.json`**
   - `"main": "apps/desktop-react/dist-electron/main.cjs"`。
   - `build` = `build:native:mac && build:cli && (cd apps/desktop-react && npm run app:build)`(写成一个 `scripts/build-desktop.mjs`,不用 shell `&&` 串 cd;`build:check` / `build:unpack` / `build:mac|win|linux` 不改,它们只认 `build`)。
   - `electron:dev` → `node apps/desktop-react/scripts/dev-app.mjs`;`dev-unified.mjs` 的 Electron 泳道 spawn 它(端口约定:React 渲染 dev server 5173 不变);`dev-with-logging.mjs` 若只为 electron-vite 而存在则退役,否则改包 React 的 dev。
   - Vue 宿主的三条留别名:`vue:dev`(原 electron-vite dev)、`vue:build`(原 electron-vite build)、`vue:unpack`(临时 electron-builder 配置见 1.2.3);`gate:vue-host` / `gate:web-shell` 改调它们。第四步整批删。
   - `typecheck` 加 `typecheck:desktop`(`tsc --noEmit -p apps/desktop-react`),根级 typecheck 覆盖唯一的桌面壳。
2. **CLI 构建脱离 electron-vite**:新 `scripts/build-cli.mjs`,复用 `apps/desktop-react/scripts/build-electron.mjs` 已导出的 `shellEsbuildOptions`(node 平台、`node-pty` 等原生模块 external、`import.meta.url` 垫片)把 `apps/electron/src/main/cli/index.ts` 打成 `dist/cli/main.cjs`;`bin/onething.mjs` 改 import 它;`package.json` 的 `bin` 若指向 out 一并改。**CLI 源码本批不搬**(第四步搬到 `apps/cli`),只换产物路径。
3. **`electron-builder.yml`**:`files` → `apps/desktop-react/dist/**`、`apps/desktop-react/dist-electron/**`、`package.json`,其余排除项照旧;`extraResources` / `asarUnpack` / `buildResources` / 三平台 target **一字不动**;头部注释加一行「主入口 = React 壳」。Vue 的 `vue:unpack` 用一份 `electron-builder.vue.yml`(`files: out/**`,其余 `extends` 主文件)撑到第四步。
4. **打包门 `scripts/gate-packaged.mjs`(`gate:packaged`)**:跑 `build:unpack` → 起 `release/mac-arm64/onething.app/Contents/MacOS/onething`(`ONETHING_STORE_PATH` 临时目录、临时 user-data-dir)→ 等 `<store>/run/http.json` 出现 → 用其 token 打 `/api/capabilities` 与 `POST /api/rpc sessions.list` → 断言窗口存在(CDP `--remote-debugging-port`)→ 退出 → 断言 `run/http.json` 已删、零残留。**这是第三步唯一的真验收**:asar 内 `loadFile` 路径、preload 路径、`resourcesPath` 下的 skills / templates / models、node-pty 解包,全靠它一次证。
5. 文档:CLAUDE.md 「Build & Development Commands」段与 Process model 段改现状(Vue 宿主行改 `vue:*`);apps/desktop-react/CLAUDE.md 若写了「没有打包配置」改掉。

### 1.3 门

`bun run build` 绿;`gate:packaged` 绿(首次跑会遇钥匙串框——打包出来的 app 是新签名身份,须用户点一次「始终允许」,门里检测到 `SecurityAgent` 就明说而不是挂死);`vue:build` 仍绿(退役前的最低要求);`bin/onething.mjs --help` 与 `onething daemon status` 在新产物上跑通;`dev-unified.mjs` 起 React 泳道 + web 泳道,web 连到桌面 core(`run/http.json` owner 判据不变);既有 verify / 各 gate 不变;`gate:native` 绿。反证:`main` 改回 `out/main/index.js` → `gate:packaged` 起的是 Vue 宿主(窗口标题 / `owner` 不同)红;`files` 少 `dist-electron/**` → 包起不来红。

### 1.4 留账

- `macos_panel.node` 在 React 壳里无消费者,第四步决定删或留(留的理由只有「将来 React 壳要浮窗面板」)。
- 第四步之前 `out/` 与 `dist/cli` 并存;`.gitignore` 两处都在。

## 2. 第四步:退役 Vue 宿主

第四步拆成两半派工:**4a = 建设性的前半**(把要留下来的东西先搬出来、建起来),
**4b = 破坏性的后半**(删 Vue)。这个顺序不是排期偏好,是因果:4b 要删的目录里
今天还住着两样必须活下来的东西 —— CLI 源码,和「浏览器壳」这个能力。

### 2.1 4a 已做(2026-09-03)

用户拍板:**浏览器壳由 React 壳提供**(不是另立一个 app)。

1. **CLI 搬家**:`apps/electron/src/main/cli/` 整目录 `git mv` 到 `apps/cli/src/`
   (含 `__tests__`,以及原本住在 `apps/electron/src/main/__tests__/` 的
   `cli-trace-format.test.ts` → `apps/cli/src/__tests__/trace-format.test.ts`)。
   它的 import 闭包本来就只有 `@onething/backend` / `@onething/core` /
   `@onething/runtime` / `@shared` / node 内建 —— 没有一条边通向 Vue 宿主,
   所以搬家是纯移动,零源码改写(只有那一条测试的相对路径变了)。
   跟着改路径的有五处:`scripts/build-cli.mjs` 的 entry、`electron.vite.config.ts`
   的第二入口(`vue:build` 仍要能跑到 4b)、`tsconfig.node.json` 的 include、
   `eslint.config.js` 的 `no-console` 分区(CLI 单独一格,`stdout.ts` 是白名单)、
   `scripts/log-check.mjs` 的 ROOTS + 白名单。vitest 的 include 是
   `apps/**/*.test.ts` 通配,不用改。
2. **React 浏览器壳**:`apps/web/dev-api-proxy.ts` **复制**(不是移动)到
   `apps/desktop-react/vite/dev-api-proxy.ts`(为什么是复制:那份原件活不过 4b,
   而 import 一个即将被删的目录等于给 4b 埋雷;理由写在新文件头)。
   `apps/desktop-react/vite.config.ts` 长出 **web 模式**(判据 `mode === 'web'`
   或 `ONETHING_SHELL=web`):启用代理、端口钉 5174、`build.outDir` 指仓根
   `dist/web`(与 apps/web 今天的落点逐字相同)。桌面模式三格全部不动。
   配置另加一句 `root: __dirname` —— 两条根脚本是在仓根起的,不钉 root 的话
   vite 会拿仓根那份 Vue 的 `index.html` 当入口;钉了之后仓根起与本目录起同解,
   桌面泳道零行为变化。
   根脚本 `web:dev:react` / `web:build:react` 新增,**旧 `web:dev` / `web:build`
   本批一字不改**(4b 改名接管)。`dev-unified.mjs` 的 web 泳道加 env 开关
   `ONETHING_WEB_SHELL=react`,缺省仍是 Vue;它的残留进程清扫改成两个壳都认得,
   免得换过一次 env 之后上一轮那只 vite 一直蹲在 5174 上。
3. **修了一个真 bug**(不是接线,是壳在浏览器里根本收不到推送):
   `apps/desktop-react/src/platform/connection.ts` 在无宿主时把 `baseUrl` 留成
   **空串**。`fetch('/api/rpc')` 照打没事,但 `createHttpTransport` 的 SSE 分支要挂
   `?after=` 所以走 `new URL(...)`,而 **`new URL('/api/events')` 没有 base 会当场抛
   `TypeError: Invalid URL`**;那一抛落在 `eventLoop` 自己的 try 里,被记成一次
   「流断了」然后无限退避重连 —— 表现是浏览器里 RPC 全通、推送**永远**收不到,
   日志上只有一串看不出根因的 `event stream dropped`。改法与 Vue 渲染层
   (`packages/renderer/platform/client.ts` 的 `webBaseUrl()`)同一条判据:
   无宿主时取**本页 origin**(同源、根绝对路径,打出去是同一个请求,dev 代理照旧接得住)。
   `src/platform/host.ts` 复核过:它只碰 `matchMedia`,没有 matchMedia 就交 noop
   退订 —— 浏览器下本来就安全。
4. **新门 `gate:web-shell:react`**(`scripts/gate-web-shell-react.mjs`):
   与 Vue 那道 `gate:web-shell` 逐条同构、端口刻意错开、`gate:web-shell` 一字未动。
   隔离 store + 固定端口 + 假 provider,真 `server:build` 产物 + 真 `web:dev:react`
   + 无头 Chromium:发一条消息收到**流式**回复上屏;并断言 `GET /api/events` 在
   浏览器那一跳的 URL 里**没有** `token=`,而 dev 代理转给真 server 的那一跳带着
   正确的 `Authorization: Bearer`(靠一台插在中间的记录型反向代理看清)。

**4a 明确不做**:不删任何 Vue 目录 / 依赖 / 脚本;不改 `web:dev` / `web:build`
两个名字;不动 `gate:web-shell` / `gate:vue-host`;`bin/onething.mjs` 不动。

**留账**:
- `dist/web` 今天**没有任何进程静态托管它** —— 复核过 `packages/backend/server/http.ts`,
  它只有路由表 + 未命中一律 404 JSON,一行静态文件服务都没有。所以浏览器壳的产物
  在开发期靠 vite dev server、在部署期靠仓外的静态服务器。`base: './'` 两个模式共用,
  于是产物挂在任何前缀下都能加载 —— 但「起 server 直接开 `/` 能看到页面」这件事
  **今天不成立,也不是本批引入的**。要它成立需要给 server 加一段静态托管,那是另一件事。
- 两份 `dev-api-proxy.ts` 在 4a→4b 之间并存。4b 删 apps/web 时,那份原件随目录一起走。

### 2.2 4b 待做(方案)

删:`apps/electron`(CLI 已在 4a 搬到 `apps/cli/`)、`packages/renderer`、`apps/web`(Vue 构建;浏览器壳已在 4a 由 React 壳的 web 模式接管 —— `web:dev:react` / `web:build:react` 此时改名接管 `web:dev` / `web:build`,`dev-unified.mjs` 的 `ONETHING_WEB_SHELL` 开关随之退役)、`electron.vite.config.ts`、`electron-builder.vue.yml`、`vue:*` 脚本、`gate:vue-host` / `gate:web-shell`、依赖 vue / pinia / electron-vite / @vitejs/plugin-vue / vue-tsc 及只被它们引的包(逐个 `rg` 证零消费者)、`onething.aliases.ts` 的 `@renderer` / `@` / `electronHostAliases`、boundary 检查器里针对 renderer 的规则(改成守 React 壳)、server `GET /api/events` 的 `?token=` 口、`ui:gate` 的 Vue 基线(`docs/audit/ui-baseline-2026-08-13.txt`)、`@shared` 里只被 Vue 用的类型桶(`packages/renderer/types` 那张 `ElectronAPI` 大表若被 backend 引则先断)。
门:全仓 typecheck / vitest / boundary / 各 gate 绿;`rg -i 'vue|pinia' package.json` = 0;锁文件净减;`bun run build` + `gate:packaged` 绿;CLI 从 `apps/cli` 打出并跑通。
拍点:~~`apps/web` 删掉后浏览器壳由谁提供~~(2026-09-03 用户已拍:**React 壳**,4a 已落地);`macos_panel` 去留。
