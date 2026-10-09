# CLAUDE.md
组件化而不是创建新的组件。
**加功能不许改骨架**(09-02 立法,起因:检索方案 v2 被用户拿 symbol 能力一问就露出 feed 与 Target 两个枚举点):任何架构方案交卷前必须做「陌生能力演练」——拿一个设计时没想过的能力列出要改的文件,答案不是「能力自己的模块 + 它的壳渲染模块 + 各一行注册」就是骨架没抽到位,打回。手段只有一个:凡「按能力枚举」的地方改成「能力自述、别人读表」(manifest + 注册表),core 里不出现任何能力的名字。
**原生模块只许 N-API,且不许靠注释证明 ABI**(09-02 立法,起因:electron-builder.yml 写着「better-sqlite3 已按 Electron ABI 编好」,实测它按 Node 22 v127 编、在 castlabs Electron 41 v145 下加载失败,这句假话活了两个月没人发现;而 node-pty / sherpa-onnx / macos_panel 三个 N-API 插件一块二进制同时服务 Node 与 Electron 两个运行时,从没出过事):同一份 node_modules 要同时喂桌面(Electron)与 server / CLI / vitest(Node),两个运行时 ABI 不同,V8 ABI 专属的 `.node` 在结构上就不可能两边都对;所以①新原生依赖必须是 N-API(或 SQLite 这类内建/纯 C 扩展),②`.node` 能不能在两个运行时下加载要由门跑出来,不许写在注释里。
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

这份文件只写**现行**的规则与结构。每条规则的来历、施工记录、2026-10-04 之前的旧结构描述都在存档
`docs/architecture/claude-md-archive-2026-10-04.md`;后端结构为什么这样分,给人读的完整说明在
`docs/architecture/backend-structure.md`,逐条决策在 `docs/design/backend-structure-decisions-2026-10.md`(下文的
「D26」这类编号都指那里)。React 壳自己的施工规范在 `apps/desktop-react/CLAUDE.md`。

## 1. 环境硬约束

- **两份锁文件,各有权威**:`package-lock.json` 是打包的权威 —— package.json 的脚本全走 npm,electron-builder 按锁文件
  探测包管理器(bun 的收集器打包时会缺依赖);`bun.lock` 只服务日常 dev / test。两份都提交,不是误跑残留。
- **bun 必须用提升式布局**:`bunfig.toml` 钉 `linker = "hoisted"`,别删。bun 1.3 对带 workspaces 的仓缺省走隔离式
  (`node_modules/.bun`),根目录就没有 `@onething/*`;`apps/desktop-react` 不是 workspace 成员、靠向上解析,隔离式下
  esbuild 直接报 `Could not resolve @onething/backend/...`。
- **Node 版本**:`.nvmrc` = `24`(Electron 41 内嵌的就是 Node 24 / ABI 145,开发机与桌面运行时同一个大版本);
  `engines.node` = `>=22.13 <26`,22.13 是 `node:sqlite` 不用 `--experimental` 标志的第一个版本。
  `postinstall` 只做 `fix:node-pty-perms`,`test` 直接 `vitest run`(所有原生模块都是 N-API,不需要重编)。
- **钥匙串:凭证主密钥归后端,`security` 带 3 秒硬超时**(第④步批 0)。凭证池用后端自己的主密钥加密
  (`packages/backend/credentials/credentials-master-key.ts`),档位看 `ONETHING_CREDENTIALS_KEYRING`:不设时 macOS 是
  `keychain`(登录钥匙串里 service `onething-credentials`、account `store-<store 路径哈希>` 一条,经 `/usr/bin/security`)、
  别的平台是 `file`(`<store>/credentials-master.key`,0600),**永远不是 `none`**。`security` 子进程到点就杀、stdin 不继承、
  永不抛 —— 钥匙串弹框没人点时装配最多在凭证那一步多等 3 秒,然后进「凭证已锁定」(顶部横幅 + 重试),不再像从前
  `safeStorage.isEncryptionAvailable()` 那样挂死在 `migrateProviderConfigToDefaultSpace()`。**测试与门绝不碰真钥匙串**:
  vitest 全局 setup 强制 `none`,钥匙串门面在 vitest 里拒起真 `security`;起 server / Electron 的门脚本一律显式设
  `ONETHING_CREDENTIALS_KEYRING: 'file'` 并指临时 store。Electron 的 `safeStorage` 从此只用在**先读后交**(第④步批 2b):
  还有 `encryption: 'safeStorage'` 的旧文件时,Electron 在拉起后端之前用它解开(`apps/desktop-react/electron/legacy-credentials.ts`),
  后端就绪后经 `spaces.handOverLegacyCredentials`(只给本机信任的来访者)交进去,后端封进主密钥信封、旧文件改名
  `.safestorage-backup` 留底;没有旧文件就一次都不问 `safeStorage`。换过 Electron 二进制之后,那次读仍要 Electron 的 app 身份,
  第一次起桌面照旧人手起、在授权框上点「始终允许」(`sign:dev:mac` 的 ad-hoc 签名每换一次二进制就换一次身份;后端的 `security`
  条目信任的也是这只二进制,同一个机制)。
- **端口**:React 桌面的渲染层 dev server 是 5175(`electron:dev`),浏览器壳是 5174(`web:dev`)。后端 HTTP/SSE 端口是
  **动态的**:谁在服务这个 store,谁写 `<store>/run/http.json`;浏览器壳的 dev `/api` 代理
  (`apps/desktop-react/vite/dev-api-proxy.ts`,做成插件是因为 vite 自带代理在创建时就钉死目标)**每个请求重读**这份
  文件并注入 Bearer token,读不到才回落 `ONETHING_API_URL` || `http://127.0.0.1:8787`。`bun run dev` 带桌面泳道时
  **不起第二个 server 进程** —— 桌面拉起的后端子进程(Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 跑 `dist-electron/backend.cjs`,
  `apps/desktop-react/electron/backend-process.ts`)就是这个 store 的后端。改了 `packages/backend` 要重跑 `electron:build`
  (或整条泳道)再在设置 → 通用里点「重启后端」。

## 2. 命令

```bash
# 开发
bun run dev                # 桌面 + 浏览器壳 + server 一起起(scripts/dev-unified.mjs)
bun run dev:electron       # 只起桌面泳道(可与 dev:web 并跑)
bun run dev:web            # 只起浏览器壳 :5174 + 不带界面的 server :8787
bun run electron:dev       # 只起 React 桌面(apps/desktop-react/scripts/dev-app.mjs:vite :5175 + Electron)
bun run web:dev            # React 壳的浏览器形态(--mode web → :5174,带动态 /api 代理)
bun run server:start       # node dist/server/main.js(先 server:build;已有桌面服务这个 store 时拒绝启动,--force 越过)
bun run gateway:start      # 独立 IM 网关进程(要 ONETHING_GATEWAY_RUNTIME_MODULE,缺了打一行 fatal 退出 1)
onething backend start|stop|status|restart|logs   # CLI 管这个 store 的后端进程(stop 只停 CLI 自己拉起的那台;旧名 daemon 留一版)
onething <命令> --spawn     # 没有活后端时自己拉起一台(= ONETHING_CLI_BACKEND=spawn);缺省只连、没有就报错

# 构建
bun run build              # 桌面构建(scripts/build-desktop.mjs:dist/cli/main.cjs → apps/desktop-react/{dist,dist-electron})
bun run build:cli          # 构建 CLI → dist/cli/main.cjs,连带 dist/server(CLI 没装 app 时拉起的就是它)
bun run server:build       # 不带界面的 server → dist/server/main.js + dist/server/search-worker.cjs
bun run web:build          # 浏览器壳 → dist/web
bun run build:check        # typecheck + build
bun run build:unpack       # build + electron-builder --dir;build:mac / build:win / build:linux 同理
bun run sign:dev:mac       # 给 dev 二进制签名

# 检查与测试
bun run lint               # eslint --fix;lint:ci = eslint . --max-warnings 200
bun run typecheck          # typecheck:node + typecheck:desktop
bun run test               # vitest run;test:watch 为监听模式

# 日志与诊断
bun run log:tail           # 美化并跟随 <store>/log/app.jsonl([--ns engine.*] [--level warn] [--session id])
bun run memory:report      # 运行中后端的内存用量([--json] [--trim [soft]])

# 评估
bun run evals              # bun evals/run.mjs;evals:diagnose = scripts/diagnose-weekly.mjs
```

门见第 5 节;`sessions:blob-gc` / `sessions:storage-report` / `migrate:sessions:events` / `sessions:shadow-*` 是按需手跑的维护脚本。

## 3. 结构

onething 是一个多服务商、带工具调用、事件驱动流式引擎的 AI 聊天应用。产品在 packages 里,apps 都是薄壳,只放客户端(桌面、CLI、手机);不带界面的后端进程也住在后端包里。

| 位置 | 是什么 |
| --- | --- |
| `packages/backend`(`@onething/backend`) | **唯一的后端包**:装配配方 + 一个功能一个目录 + 界面连进来的 HTTP 服务器 + 不带界面的后端进程入口(`backend-standalone-main.ts`) |
| `packages/shared`(`@shared`) | 后端与界面之间的契约(RPC 路由契约、事件词汇、发现文件形状),加上两边必须算得一样的纯逻辑(会话投影、引用、效果表……)。**只引自己**,不引 node、不引 `@onething/*` |
| `packages/backend-client`(`@onething/backend-client`) | 连后端用的 SDK:`Transport`(fetch + fetch 流式 SSE + Bearer)、`client.api(router)`、事件中心。Node 与浏览器同一份代码 |
| `apps/desktop-react` | **唯一的桌面**(Electron + React),`--mode web` 时也是浏览器壳。主进程**不装配后端**:它拉起、发现、监督、停止一个后端子进程(`electron/backend-process.ts`),自己是那台后端的 HTTP 客户端(内置浏览器以壳的身份认领 `browser:`);渲染层只走 HTTP/SSE。`electron/**` 对 `@onething/backend` 只许 `import type`(日志一族除外,`boundary:gate`) |
| `apps/cli` | CLI(`bin/onething.mjs` → `dist/cli/main.cjs`):后端的 HTTP 客户端(`backend-connect.ts` 读发现文件连 / 拉起,`backend-requests.ts` 是方法 → RPC 表);`store` / `trace` / `plugin` 三条离线命令仍直接读盘(带一部分后端代码) |
| `apps/mobile` | Expo 客户端,不是 workspace 成员 |

依赖方向:界面一侧(`apps/desktop-react/src`、`apps/mobile`、`packages/backend-client`)只许引 `@shared/*` 与
`@onething/backend-client`;`packages/shared` 只许引自己;后端可以引 `@shared`。这三条由 `boundary:gate` 守。

**`packages/backend` 内部**:

- **包根只有组装配方**:`backend.ts`(`createOnethingBackend` / `OnethingBackend.assemble`,唯一的装配配方)、
  `backend-assemble-engine.ts`(装引擎:引擎层、端口接线、内置触发器)、`backend-current.ts`(唯一的进程槽:当前实例,
  以及 `getStreamEngine()`)、`backend-host-ports.ts`(宿主端口表)、`backend-shutdown.ts`(关机阶段表)、
  `backend-types.d.ts`、`backend-standalone-main.ts`(不带界面的后端进程入口,见下面「进程入口」)、`backend-launcher.ts`
  (那个进程的档位:`ONETHING_BACKEND_LAUNCHER=desktop|cli|none` 的唯一读处,档位 → 装配开关 / 宿主表两格 / 装配后起的几件 /
  日志与发现文件 owner;第④步批 2a),加 `http-server/` 与 `__tests__/`。
- **`packages/backend/<功能>/`:一个功能一个目录,平铺**。目录名是单数名词(`session`、`provider`;`settings` 这类
  习惯复数的保持原样)。`http-server/`、`__tests__/` 以外的每个目录都是功能(`scripts/lib/backend-structure.mjs` 的
  `NON_FEATURE_DIRS`)。功能里的逻辑、内核、接线放在一起,不再按层分子目录;只给一个功能用的内核可以放
  `<功能>/kernel/`,那是普通子目录。集合目录(`provider/vendors/`、`gateway/channels/`、`music/providers/`)的子目录
  保持复数,每个条目一个子目录。
- **入口 `<功能>/<功能>.ts`**:功能对外的唯一主入口,说明符 `@onething/backend/<功能>`,`packages/backend/package.json`
  的 exports 里一把键 `"./<功能>": "./<功能>/<功能>.ts"`。
- **第二入口 `<功能>/<功能>-client-api[-<方面>].ts`**:这个功能开放给界面调用的操作(RPC 域的处理函数,导出一行
  `defineClientApi(...)` 名册行),以及只有 HTTP 服务器用的门面、投影与投递件。只许 `http-server/` 与同功能的另一只
  client-api 引(D26)。
- **装配入口 `<功能>/<功能>-configure.ts`**:装配期才建的状态与接线 API。今天只有
  `packages/backend/logging/logging-configure.ts`(`configureLogging()`、文件 sink、目录管家、崩溃钩子);只许包根、
  `http-server/`、两种第二入口、L4 功能与 apps 引(D191)。
- **进程入口**:被构建配方或真机门当作独立进程 / 线程起的文件 —— 检索 Worker
  (`packages/backend/search/index/search-index-worker.ts`)、ACP 宿主工具桥、不带界面的后端进程
  `packages/backend/backend-standalone-main.ts`(`server:build` 打成 `dist/server/main.js`,`server:start` 与真机门跑它;
  vite 配置内联在 `scripts/build-server.mjs`;桌面构建 `build-electron.mjs` 另打一份 `dist-electron/backend.cjs`,桌面用
  Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 拉起它,`gate:backend-process` 也跑它)、独立网关 `packages/backend/gateway/gateway-standalone-main.ts`、
  `scripts/gate-*/` 下的被测产物入口。它们按路径直接指要的模块,
  而且**不许被任何文件 import**。
- **`http-server/`**:界面连进来的那台 HTTP 服务器(收请求、SSE 事件流、发现文件、来访者身份与本机信任、按名册分发),
  入口 `packages/backend/http-server/http-server.ts`。它不认识具体功能,只读两张名册:
  `http-server-client-api-roster.ts`(每个 RPC 域一行,顺序 = 挂载顺序)与 `http-server-runtime-roster.ts`
  (各功能 server 门面的安装 / 拆除顺序)。

**层次**(D23,层次表 `docs/audit/feature-layers-2026-10.json`,每个功能一行 `{feature, layer, why}`):

| 层 | 名字 | 含义 | 例子 |
| --- | --- | --- | --- |
| L0 | 基础件 | 不认识任何产品概念 | storage、logging、network、lifecycle、memory、process-env |
| L1 | 领域事实 | 纯事实与纯逻辑,不读用户存储、不起服务 | provider、agent-loop、tool、prompt、theme、event |
| L2 | 能力 | 有自己的存储或服务 | session、settings、credentials、provider-call、toolkit、search、plugin、mcp、acp …… |
| L3 | 编排 | 把多个能力接成一台机器 | engine、collab、gateway |
| L4 | 对外接口 | HTTP 服务器、装配配方、开给界面的操作 | http-server、包根、headless、各功能的 client-api |

只许高层引低层;同层之间经入口且不成环;L0 不引任何功能。每个功能做什么、依赖谁、入口交出几个名字,看生成出来的
**功能地图 `docs/architecture/feature-map.md`**(不要手改,`bun run feature-map` 重生成)。

## 4. 规则

**可读性判据(D20)** —— 每一步结构改动的去处选择与验收都按它判,无环但读不懂的方案不选:

- **R1 找得到**:问「X 在哪」,看 `packages/backend/` 的目录列表就能答出一个目录;一个功能不散在两个以上目录。
- **R2 名字说人话**:目录名是说得清的功能名词,文件名说清它做什么;不用 `rpc` / `server` / `runtime` / `wiring` /
  `host` / `bound` / `app` / `assembly` 这类层字眼,不用只有作者懂的缩写。
- **R3 入口即说明书**:入口文件头用几句人话写它做什么、交出哪几类东西、依赖哪些功能;交出的名字按类分组。
- **R4 方向一眼看得出**:功能地图由代码生成,门保证它与代码一致(`feature-map:check`)。
- **R5 一个功能能单独读懂**:读一个功能不需要先读另一个功能的内部文件;功能之间只经入口(`entry:gate`)。
- **R6 小而完整的对外面**:入口交出的名字越少越好,只交外面真在用的。

**命名(D22,`name:gate` 零基线硬闸,同时判 N1–N4)**:

- **N1** 文件名在 `packages/backend` 全包唯一,按文件名搜索只出一个结果。
- **N2** 全小写、连字符分词、**功能名打头**:`<功能>-<做什么>.ts`(功能子目录里 `<功能>-<子目录>-<做什么>.ts`,
  包根散文件 `backend-*.ts`,`http-server/` 里 `http-server-*.ts`,集合目录的条目里以条目名打头,如
  `provider/vendors/claude/claude-dialect.ts`)。点号只用于固定后缀 `.test.ts`、`.d.ts`。
- **N3** 入口叫 `<功能>.ts`,不用 `index.ts`(功能子目录的入口叫 `<功能>-<子目录>.ts`);**只用具名导出、按类分组,
  不用 `export *`**,只交外面真在用的名字。门:`entry:gate`(D228 / D235 / D241,主入口里的 `export * from` 一条就红,
  零基线;`export * as <名字>` 是具名的命名空间导出,不算)。
- **N4** 泛名不单独作文件名:index / types / utils / helpers / service / manager / runtime / registry / store / core /
  common / misc 只能跟在功能名后面(`provider-types.ts`)。
- **N5** 目录用单数名词;**N6** 测试叫 `<被测文件名>.test.ts`,放在功能目录下的 `__tests__/`;**N7** 包名、应用名
  也要说清是什么(`backend-client`、`desktop-react`)。

**入口规矩**:

- **只经入口**:功能目录之外(包根、别的功能、apps、scripts、evals)只许引 `<功能>/<功能>.ts`,第二入口与装配入口按
  上一节的规则。门:`entry:gate` —— 非测试的深层引用**一处就红**;测试的深层引用按功能计数,只许降。
- **功能内只引兄弟**:功能内部文件按相对路径引同目录的兄弟文件,**不引自家入口**(D126)。门:`entry:gate`(D228 / D236 /
  D241,功能内非测试文件引自家主入口一处就红,零基线)。测试替身打在入口上的,先把替身改打声明那个名字的兄弟文件,再改引兄弟。
- **入口不成环**:入口之间的运行期值引用必须是有向无环图(D19)。门:`cycle:gate`。起因是一个入口卷进加载期的环
  之后,`class extends` 在加载期读到 `undefined`,继承没法惰性化。
- **进程入口不经功能入口**:进程入口按文件路径指它要的模块,并且不许被任何文件 import。门:`entry:gate`
  (名册从构建配方 `apps/desktop-react/scripts/build-electron.mjs` 的 `*_ENTRY` 常量与 `*-standalone-main.ts` 现读)。
- **import 不做事**:import 任何后端模块都不许做配置、不许读设置、不许建仓库;模块要状态就在**首次用到时**经一只
  `const` 持有器建,不用模块级 `let`。门:`packages/backend/__tests__/import-side-effect-free.test.ts`(数构造次数)
  与 `assembly:gate`(模块级 `let` 只许降)。
- **功能目录里的非测试相对 import 不出功能目录**;要包根文件或 `http-server/` 的小件,写包说明符
  (`@onething/backend/backend-current.js`)。会话的内部模块(命令门、读门、账本写门与它们背后的缓存,名单是
  `scripts/lib/backend-public-boundary.mjs` 的 `privateSessionFiles`)没有 exports 键,只许 `session/` 里的非测试文件引。
  门:`packages/backend/__tests__/architecture-boundaries.test.ts`。
- **I1**:包根文件与非功能目录不许与功能同名。门同上。

**能力自述、别人读表**:凡是「按能力枚举」的地方(一个 `switch` 列出所有服务商、一张表写死所有工具、内核里点名某个
功能),改成能力自己登记一行、别人读注册表。例子:服务商名册 `provider/vendors/provider-vendor-manifests.ts`、
client-api 名册、资源 scheme 的提供者、协作四只工具由 `registerCollabTools(catalog, tier)` 自登记、检索能力的
`manifest.retrievers`。低层引高层的值边(`layer:gate` 零基线)只有两种治法:把文件搬到它依赖的层次,或者改成登记。

## 5. 门

下表全部在 CI(`.github/workflows/test.yml` 的 gates job)里跑;CI 另外还跑根与壳的单测和壳的 `ui:consume`。「零基线硬闸」= 一处命中就红;「棘轮」= 按基线计数,只许降(降了用 `--write-baseline`
收紧)。

**结构门**(后端):

| 命令 | 判什么 | 类型 |
| --- | --- | --- |
| `bun run boundary:gate` | `scripts/headless-boundary-check.ts` 的全部断言(`bun run boundary` 打全量):后端不引 electron / `@main` / `@preload` / 渲染层别名、非测试源码零出现 `dialog.showOpenDialog` / `shell.openExternal` / `shell.openPath` / `shell.showItemInFolder`(剥注释后判),功能目录不引 cordis(`feature-registry/` 除外),shared 只引自己,界面一侧只引 shared 与 backend-client,Vue 宿主不许复活,检索只有一条查询路径。没打出完成标记或一行 ok 都没有也算红 | 零基线硬闸 |
| `bun run entry:gate` | 从功能外引入口以外的文件;进程入口被 import;功能主入口里的 `export * from`;功能内非测试文件引自家主入口(`entry:check` 打全表) | 非测试深层引用、进程入口、主入口 `export *`、自引入口四条硬闸 / 测试深层引用棘轮(`docs/audit/feature-entry-baseline-2026-10.txt`) |
| `bun run cycle:gate` | 运行期值引用图里含功能入口的强连通分量(只引类型、动态 `import()`、测试不成边);红时打出最短环 | 零基线硬闸 |
| `bun run layer:gate` | 低层引高层的值边;层次表里没登记的功能 | 零基线硬闸 |
| `bun run name:gate` | N1 重名、N2 功能名打头、N3 `index.ts`、N4 泛名 | 零基线硬闸 |
| `bun run cohesion:gate` | 文件内聚(D225 / D229,判据 `docs/design/oversized-files-2026-10.md` §1):顶层声明为点、引用为边(≤ 3 行的叶子常量不连边),至少两块且第二块 ≥ 150 行 = 一只文件里住着两件不相干的事。不设行数上限。`cohesion:check` 打块表,`cohesion:report` 另打形状 B / C(长函数里几组嵌套函数各管各的 `let`、一只类里几组方法各管各的字段)的报表,只报不判。拆分时用 `bun run split:prove <拆前文件> <拆后文件…>` 证明纯搬家(每条顶层声明的源文本拆前拆后多重集相等) | 新文件零基线硬闸 / 立门时命中的文件记在已知名单里只许减(今天 1 只,理由写在名单文件头,`docs/audit/cohesion-baseline-2026-10.txt`) |
| `bun run client-api:gate` | 第二入口与装配入口只被允许的人引;名字带 `-client-api` 却不合形状;少于 40 只 client-api 算红(防假绿) | 零基线硬闸 |
| `bun run feature-map:check` | `docs/architecture/feature-map.md` 与代码一致 | 一致性 |
| `bun run assembly:gate` | 每只非测试文件的模块级 `let` 个数(`backend-current.ts` 豁免);新状态挂在 `OnethingBackend` 实例上并 `own()` | 棘轮(`docs/audit/assembly-baseline-2026-09-02.txt`) |
| `bun run transport:gate` | 手写通道常量个数与壳文件行数;`http-server/` 与全部 client-api 里读 `context.transport` 的处数;React 壳的 `ipcMain` 注册 ≤ 3(第三条 `host:client-action` 是第④步批 1 用户拍定的一次放宽,理由在基线文件头) | 棘轮(`docs/audit/transport-forks-baseline-2026-09-03.txt` 等) |
| `bun run provider:gate` | 某家服务商的 id 出现在它自己的 `provider/vendors/<id>/` 之外(按 TypeScript 解析,注释不算;名册、壳的 i18n 与图标、`provider/model-families/`、协议名等豁免) | 棘轮(`docs/audit/provider-vendor-baseline-2026-10.txt`) |
| `bun run provider:drill` | 在临时 worktree 里加一家虚构服务商,断言目录外只动了两份名册与壳的两份 i18n | 演练 |
| `bun run feature:drill` | 在临时 worktree 里加一个虚构功能「秒表」(主入口、内部文件、经 storage 入口落盘、`@shared/ipc` 契约 + client-api 一行、一份测试),断言功能目录外恰好只动了契约、层次表一行、名册一行、exports 一把键与生成的功能地图;node typecheck 与十三道结构门全绿;演练测试经名册与 RPC 分发表调到它,名册测试多了一行照旧绿(D250–D254) | 演练 |
| `bun run log:gate` | 非测试源码里 `console.*` 的处数(`scripts/` 与 `apps/cli/src/stdout.ts` 除外);新代码用 `getLogger` | 棘轮(`docs/audit/log-gate-baseline-2026-08-20.txt`) |
| `bun run session:gate` | `session.messages` 只出现在白名单文件、消息字段只在 reducer 里赋值(`session:check` 打全表) | 零基线硬闸 |
| `node scripts/gate-backend-process.mjs --build --runtimes=node` | 后端进程能独当一面(第④步批 2a)的系统 Node 那一半,全量见下面「运行时与真机门」的 `gate:backend-process` | 行为门 |
| `bun run gate:cli-http` | CLI 走 HTTP(第④步批 3):真 CLI 产物对真 `dist/server`,不开窗、临时 store、`file` 档 —— 依附活后端时 `session new` / `ask`(假服务商,`--json` 与人读两种输出)/ `resource list|read` / `onething mcp`(stdio 握手、改名落地、审计账主体 `system:mcp:*`);空 store 缺省档报错且非零、`--spawn` 拉得起(owner `backend` + `launcher: 'cli'`)、`backend status|stop|start`、旧名 `daemon`;别人的后端(`server:start`、桌面档)`backend stop` 被拒且还活着。`--build` 先跑 `build:cli` | 行为门 |
| `bun run gate:credentials` | 凭证归后端(第④步批 0):只用 node、`file` 档、临时 store 跑七项 —— `safeStorage` 旧密文迁进主密钥信封且条目逐条相等、旧文件改名 `.safestorage-backup` 字节不变、口令导出→换 store 导入相等、`none` 档答 `none`、钥匙串超时→`credentials:locked`→重试成功、另一个活后端在时拒绝迁移、`security` 挂住不挂死(钥匙串那一档用假 `security` 脚本,不碰真钥匙串) | 行为门 |
| `bun run gate:plugin` | 插件挂后端(第④步批 4):真 `dist/server` 的桌面档 / CLI 档 —— `pluginsManage` 为真、没有开关记录与记成 `false` 的插件不跑、`plugins.install` 新装当场记 `enabled: true`、插件命令经 `exec` 跑通只在登录 shell PATH 里的探针(假登录 shell)、`file-pick` 字节形 / 路径形交回、SIGTERM 5 秒内退;CLI 档证 execa 在 vite 包里能用;缺省档逐字不变。只用 node、临时 store、npm 离线 | 行为门 |
| `bun run gate:gateway` | 网关跟着后端(第④步批 4):假服务商 + 127.0.0.1 上的假 iLink(微信渠道的 HTTP 协议)—— 设置开 → 后端起来自动连、一条消息进一条回复出、SIGTERM 收得干净;设置关 → 零请求;缺省档不起。不连任何真渠道 | 行为门 |

除 `boundary:gate`(全量用 `bun run boundary`)与 `transport:gate` 外,每道 `*:gate` 都有对应的 `*:check` 打出全部命中。

**运行时与真机门**(不在 CI 里,手跑或发布前跑,多数要先构建):

- `bun run gate:backend-process` —— 第④步批 2a 不开窗的那一半:先 `electron:build`(或带 `--build` 用同一组 esbuild 选项打进门
  自己的缓存目录),用 **Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`** 与**系统 Node** 各跑一遍 `backend.cjs` 的桌面档(临时 store、
  `ONETHING_CREDENTIALS_KEYRING=file`):发现文件 `owner === 'backend'`、capabilities 的 terminal / localFileSystem 为真、
  一份假的 stdio MCP 真连上、预置的定时任务进了调度器、日志进 `app.jsonl` 且 stdout 不回显、进程名 `onething-backend`、
  再起一台缺省档会让位、SIGTERM 后 5 秒内退出且发现文件删掉;外加缺省档对照(owner `server`、MCP 不连、任务不进、两台缺省档
  互相让位)。第④步批 2b 加**监督那一半**(`--no-supervisor` 跳过):同一个运行时起一只驱动
  (`scripts/gate-backend-process/supervisor-entry.ts`),由它驱动桌面真用的那只 `BackendProcess` 拉起真 `backend.cjs` ——
  `kill -9` 后 D11 重拉且端口 / token 不变、60 秒内第 4 次封顶、「重启」、`leave()` 后驱动退出而后端留着、再起一程借它、`stop()`
  宽限内收掉。`--timing=N` 报「spawn 到发现文件活着」的中位数。第④步批 3 加 **CLI 档对照**(owner `backend` + `launcher: 'cli'`、
  MCP 真连、任务不进、`app.jsonl`、`backend.shutdown` 收尾)。CI 只跑系统 Node 那一半(见上表)。

- `bun run gate:native` —— N-API 法的「跑出来」那一半:逐个原生二进制(`fsevents`、`node-pty`、`sherpa-onnx-node` 与平台包、
  `sqlite-vec` 的 `vec0.dylib`、`onnxruntime-node`、`@img/sharp-*`)在系统 Node 与 `ELECTRON_RUN_AS_NODE=1` 的 Electron 下各
  `require` 一次,macOS 上再 `nm -u` 查有没有 V8 私有符号。SQLite 扩展换尺子:真 `loadExtension` 并 `select vec_version()`,
  静态只许 `sqlite3_*` 与 libc 符号。**判的是装了 / 打包了什么,不是用了什么**。加原生依赖就要过这道门。
- `bun run gate:embed-runtime` —— 用产品自己的 `createTransformersOnnxEmbedder` 在两个运行时下各跑 40 批变长文本;任一非零
  退出或 Electron 峰值 RSS > 800MB 即红。守的是 `search-embedding-transformers-onnx.ts` 里 `enableCpuMemArena: false` 那一格
  (ORT 的 CPU 内存池翻倍不还,在 Electron 的 PartitionAlloc 下 `posix_memalign(2GiB)` 直接 SIGTRAP)。入口只 import 产品的
  embedder,**不抄一份 pipeline 选项**。模型不在就 skipped。
- `bun run gate:client` —— `@onething/backend-client` 在系统 Node 与 Electron 自带的 Node 下都真跑一遍。
- `bun run gate:search-index` —— 在临时 store 上起真 `dist/server`:索引 Worker 是唯一写者、刚发的消息搜得到、改名 / 归档 /
  删除经 feed 落地、主线程延迟在预算内、语义召回端到端(假 embedder)、开关热生效、模型下载走应用代理且 Worker 的日志进宿主
  文件、开关开着但模型不在时零网络请求。真模型那一步要 `ONETHING_GATE_REAL_EMBEDDER=1`。只能用 node 跑(bun 没有 `node:sqlite`)。
- `bun run gate:acp` —— 真 `dist/server` + 假 ACP agent:握手、`session/new`、未绑定目录拒绝、流式、`-32601`;
  `ONETHING_GATE_REAL_ACP=1` 时跑真 claude-agent-acp。
- `bun run gate:packaged` —— `build:unpack` 后在临时 store 上起打包的 .app(离屏):`run/http.json` 的 owner `backend` 且 pid 不是
  app 自己(证 `RunAsNode` 保险丝开着、`backend.cjs` 解包了)→ `/api` → 窗口 → SIGTERM 后 app 与后端都退;并断言 `search.status` 的
  `mode === 'owner'`、`vector: 'off'`、`vectorExtension: 'loadable'`(证明 `asarUnpack` 还在);⑦「退出后继续运行」档(打开开关 → 退 app
  后端留着 → 再起 app 借它、不拉第二台 → 门收尾;`--no-keep-running` 跳过)。
- `bun run gate:web-shell` —— React 浏览器壳:真 server 产物 + `/api` 代理 + 无头 Chromium,流式回复上屏,且 token 不进 URL。
- `bun run gate:notes`(只读、只碰开着的库,Obsidian 没跑就 skipped)、`bun run gate:store-backup`(先 `build:cli`,只在隔离
  目录里跑 CLI 的 store 备份)、`bun run log:smoke`(断言 `server.jsonl`)。
- `bun run gate:codex-computer-use` —— 真 `dist/server`(CLI 档)对着 Codex 装在本机的那台闭源 Computer Use MCP:签名
  `codex sandbox` 跳板连上、十只工具列得出、`list_apps` 真答(没有 -10000)、经 RPC 直接调 `get_app_state` 时服务器的
  elicitation 被结构化拒绝(没有会话坐标 → 不出卡、不碰 app)、SIGTERM 5 秒内收掉整棵子进程树。ChatGPT.app 或
  Computer Use 不在 → skipped。**绝不碰用户的「始终允许」名单**。
- 会话账本:`sessions:shadow-report`(真 store 上重折不一致 = 0 且写失败 = 0)、`sessions:shadow-battery`(真 server + 假服务商
  跑场景矩阵)、`sessions:hydration-contract`、`sessions:verify` 与它的棘轮 `sessions:verify:gate`
  (`docs/audit/session-verify-baseline-2026-08-20.txt`)、`sessions:events-selfcheck`。

**界面门**都在 `apps/desktop-react` 下(`npm run ui:consume` / `squeeze-gate` / `motion-gate` 是棘轮,`gate:squeeze` /
`gate:a11y` / `gate:motion` / `gate:focus` 等是真机门,`npm run verify` 汇总),规范见 `docs/design/ui-system.md` 与
`apps/desktop-react/CLAUDE.md`。**同名的门有两半就跑两半**:真机量重叠,棘轮抓源码违例。

## 6. 装配

`packages/backend/backend.ts`。每个宿主都经 `OnethingBackend.assemble(options)`(别名 `createOnethingBackend`)起后端;
装配顺序的约束(变量先于工具、引擎先于权限……)只写在这里。

- **`OnethingBackend` 是一个类**:装配产物是它的字段(`eventBus` / `streamChannel` / `sessionManager` / `engine` / `runtime` /
  `options`),由纯工厂造出、一步传一步。唯一的进程槽是 `backend-current.ts`:各处的 `getXxx()` 读的都是当前实例,装配前或
  字段还没建时抛 `BackendNotAssembledError`;已有实例时再装配抛 `BackendAlreadyAssembledError`;装配中途失败会跑已登记的
  拆除并清槽再抛。要「当前引擎」的人读槽,不 import 装引擎的文件。
- **`own(disposer, label)` / `dispose()`**:谁起了留尾巴的东西,就在起它的那一行旁边登记拆除;`dispose()` 逆序跑、各自
  try/catch、幂等。`dispose()` 开始之后再 `own()` 会**当场**跑那个拆除(防止晚到的登记漏掉已起的子进程)。宿主在装配之后
  起的一切(内嵌 HTTP 面、用户定时任务、监听器、MCP / ACP、网关、内置浏览器)都在起点 `own()`,所以每个宿主的退出都是一句
  `await backend.dispose()`。
- **选项**:`host`(必填,宿主端口表)、`toolRegistry`(`'full'` 全部内置工具 / `'headless'` 缩减集,缺省 / `'readonly'`
  零本地副作用)、`promptVersion`、`sessionSkills` / `collab` / `mcpAcp`、`sender`(观察事件总线的宿主传 noop)、
  `hooks: { afterSettings, afterEngine, afterTools }`(钩子拿到实例,因为那时 `assemble` 还没返回;钩子里起的监听器必须
  `backend.own()`)。
- **MCP / ACP 是实例拥有的子系统**(`packages/backend/mcp/mcp-subsystem.ts`、`packages/backend/acp/acp-subsystem.ts`):
  在装配时构造并当场 `own()`,所以拆除不依赖 `start()` 有没有跑完;`mcpAcp: true` 时装配自己等 `start()`(第④步批 3 起没有宿主这样传了),
  宿主在就绪后调 `backend.mcp.start()`。拆除时每个子系统最多等 3 秒,超时记一行日志继续 —— 会话数据的落盘比一个 MCP 子进程
  重要,这个上限也在 server 5 秒的 SIGTERM 期限之内。
- `configureAppRuntimeAdapters()` 是装配第一步,里面是一组**幂等闩**(内部适配绑定、凭证的两只闩、登记类端口),不 `own()`。

**宿主端口表 `OnethingHostPorts`**(`packages/backend/backend-host-ports.ts`)是宿主把 Electron 独有能力递进后端的唯一
办法(后端不 import electron)。**每一格都必填**,没有那件能力就显式写 `null`;`null` 表示 `applyHostPorts` 不调对应的
`configure*`,端口保持「从未注入」(结构化降级或 noop)。漏写一格是 `tsc` 错误
(`packages/backend/__tests__/backend-host-ports.type.test.ts`)。**每一格都可还原**:模块在 `configure*` 旁边导出
`reset*`,`applyHostPorts` 返回的还原函数逆序撤销这次真写过的格,`dispose()` 之后进程回到「没有宿主注入过任何东西」。
表外的 `configure*`:`configureLogging`(宿主在装配**之前**调,日志文件与目录管家比后端活得久)、窗口系统的几只端口、
server runtime 自己填的 `configureServer*Port`。
凭证那一格(第④步批 0):`auth` 只剩 `{ authFetch }`;落盘加密不在任何一格里 —— 主密钥归后端自己。旧 `safeStorage`
密文不再经宿主端口(批 2b 删了 `legacySafeStorageForMigration` 那一格):由 Electron 先读后交(见 §1);没人交时遇到旧密文就答
「已锁定 · 旧密文待迁移」。
**表里没有「只在用户屏幕上发生」的事**(第④步批 1):对话框、打开外链、打开路径、在访达中显示由客户端自己做
(桌面经 preload 的 `host:client-action`,见 §9),深浅色由客户端自己读,改设置后重套代理由 Electron 主进程那台客户端订
SSE 上的 `settings:changed` 自己做(`electron/core-client.ts` 的 `createSettingsFeed`);后端非测试源码零出现 `dialog.showOpenDialog` / `shell.openExternal` / `shell.openPath` /
`shell.showItemInFolder`(`boundary:gate`)。后端要请客户端做一件事,走 `home: 'shell'` 的资源做法(shell dispatch,见 §9),
不加宿主端口。

| 宿主 | 装配处 | 要点 |
| --- | --- | --- |
| React 桌面 | **不装配**:`apps/desktop-react/electron/main.ts` 拉起「不带界面的 server」那一行的**桌面档** | 开窗 → 发现文件活着就连它(上一次「继续运行」留下的、或别人的 `server:start`)→ 否则 `BackendProcess.start()` 拉起子进程(`ONETHING_BACKEND_LAUNCHER=desktop`,token 由 Electron 铸,打包态递 `ONETHING_RESOURCES_PATH`)→ 连。崩了删 pid 对得上的发现文件、重拉(端口与 token 不变),60 秒内最多 3 次,再崩亮「后端已停止。」横幅(D11)。Quit 缺省 SIGTERM 后端、等 11 秒(后端排空 8 + 1 秒,再留 2 秒)再 SIGKILL;设置 `general.backendKeepRunningAfterQuit` 开着就不发信号。Electron 不是正常退出时(被强杀、崩溃)后端自己发现:桌面档每秒看一次父进程,父进程没了且开关没开 → 自己收尾退出(与 SIGTERM 同一条路),开着 → 留下、不再看(`backend-launcher.ts` 的 `startParentWatch`,10-09)。macOS 关最后一扇窗不退。主进程自己的日志是 `shell.jsonl` |
| 不带界面的 server | 进程入口 `packages/backend/backend-standalone-main.ts` → `packages/backend/http-server/http-server-standalone-backend.ts`(`createRealServerBackend`)→ `createOnethingServerRuntimeOverBackend` | 档位由 `ONETHING_BACKEND_LAUNCHER` 定(`packages/backend/backend-launcher.ts`)。**缺省档**(不设 / `none`):只有 sandbox 与 storePath 是真的,`ONETHING_SERVER_TOOLS=readonly` 时 `'readonly'` 否则 `'full'`,MCP 客户端缺省是不联网的那一种,日志 `server.jsonl`。**桌面档**(`desktop`,桌面拉起的就是它,`gate:backend-process` 也跑它):装配开关逐格是 `electron/own-core-options.ts` 那五格(D14,测试对比),`speechOutput` 由后端自己交,`ONETHING_RESOURCES_PATH` 设了 = 打包资源目录;建 runtime 之前补好登录 shell 的 PATH,MCP 用桌面那种客户端,装配后 `own()` 定时任务 / 电台 / 首启模型拉取;日志 `app.jsonl` 不回显,发现文件 owner `backend` + `launcher: 'desktop'`,进程名 `onething-backend`。**CLI 档**(`cli`,第④步批 3,D7:从前 CLI 守护进程那一份):`toolRegistry: 'headless'`、`collab`、`sessionSkills`,MCP 真连,装配之前声明无人值守(`system` 主体的卡 60 秒自动拒)与「卡最多等 60 秒」(任何主体),不起定时任务 / 电台 / 模型拉取;日志 `app.jsonl` 不回显,发现文件 owner `backend` + `launcher: 'cli'`,进程名 `onething-backend`。**桌面档与 CLI 档**另起插件管理器与 IM 网关(第④步批 4,档案两格 `plugins` / `gateway`;宿主表的 `plugins` / `gateway` 两格由后端自己填,缺省档照旧 `null`、不起):插件按 `plugin-settings.json` 的开关跑、没有记录的用户插件算关,网关按设置里的微信开关自动连,两者起点 `own()`、各 3 秒上限。三档的终端都照旧看 `ONETHING_SERVER_TERMINAL=1`;`backend.shutdown` RPC 走与 SIGTERM 同一条收尾路(进程入口登记在 `lifecycle` 的那一格) |
| CLI | **不装配**:`apps/cli/src/backend-connect.ts` 读发现文件连活着的后端(桌面开着就是桌面那台);`--spawn` / `ONETHING_CLI_BACKEND=spawn` / `onething backend start` 时没有就拉起「不带界面的 server」那一行的 **CLI 档**(先找装好的 onething.app 用 Electron + `ELECTRON_RUN_AS_NODE=1` 跑它的 `backend.cjs`,找不到用当前 node 跑 CLI 包自带的 `dist/server/main.js`;D12) | 方法 → RPC 表在 `apps/cli/src/backend-requests.ts`,流式回答走 `GET /api/events`;`onething mcp` 的主体经请求头 `X-Onething-Acting-System` 降成 `system:mcp:*`;`backend stop` 只停 `launcher: 'cli'` 的那台 |

## 7. 怎么加一个东西

**加一个后端功能**(`bun run feature:drill` 实测过的步骤,D250–D251;答案是「能力自己的模块 + 壳渲染模块 + 各一行注册」):

1. 在 `docs/audit/feature-layers-2026-10.json` 登记**一行** `{feature, layer, why}`(没登记 = `layer:gate` 红);`why` 写一句人话。
   拿不准层次,按「它引谁、谁引它」判,低层不许引高层(有自己的存储或服务 = L2)。
2. 建 `packages/backend/<功能>/`(单数名词),入口 `<功能>/<功能>.ts`:文件头写 R3 说明书,只用具名导出、按类分组,
   只交外面真在用的名字。内部文件叫 `<功能>-<做什么>.ts`,互相按相对路径引兄弟,不引自家入口。
3. 用下层功能只经它的入口(`@onething/backend/storage` 这类);状态落在 store 里时用 `getOnethingStorePath()` 拼自己的
   子目录,不必去 storage 加 getter。状态在首次用到时读 / 建(`const` 持有器),不写模块级 `let` —— 这样**不用碰
   `backend.ts`**。真要在装配时建、要 `own()` 拆的东西,今天只能写进 `backend.ts` 的装配顺序(D253 ①,没有登记表)。
4. 在 `packages/backend/package.json` 的 exports 里加**一把**键 `"./<功能>": "./<功能>/<功能>.ts"`(按字母序;exports 只认
   精确键,缺键在 typecheck 就红;不要为外面的读者开深层键 —— 外面要的名字进入口)。
5. 要开给界面:按下面「加一个 RPC 域」写 `@shared/ipc/<域>.ts` 契约、第二入口 `<功能>-client-api.ts` 与名册一行
   (`@shared/ipc/index.ts` 那只桶不用加)。要宿主能力:加宿主端口(见下)。要被别的功能用到时,在它们的注册表里
   **登记一行**,不去改它们的代码。
6. 测试叫 `<被测文件名>.test.ts` 放 `<功能>/__tests__/`;经界面调的,装上真名册(`registerAppRpcDomains`)再经
   `dispatchRpc` 发信封,store 指临时目录(样例:`scripts/feature-drill/stopwatch/__tests__/`)。
7. `bun run feature-map` 重生成功能地图,然后跑 `name:gate`、`entry:gate`、`cycle:gate`、`layer:gate`、`client-api:gate`、
   `feature-map:check`、`assembly:gate`、`boundary:gate`。名册测试
   `http-server/__tests__/http-server-client-api-roster.test.ts` 从名册本身读期望,加一行不用改它;它只断言名册注释里写明的
   顺序约束(logs 第一、host-mcp 紧跟 acp、notes 紧跟 search、resources 是最后一个域、self-evolution 最后,D252)。

以上就是全部改动:功能目录之外只有契约文件、层次表一行、名册一行、exports 一把键与生成的功能地图;`backend.ts`、
`http-server/` 其余文件、门的名单、壳的文件、名册测试都不用改。

**加一家服务商**:建 `packages/backend/provider/vendors/<id>/`,放 `<id>-manifest.ts`(纯数据:名字、方言、鉴权、模型来源、
档位、环境变量、模型规则表……)与行为文件(方言、思考线型、`<id>-runtime.ts` 里的 `createProvider` / `quotaSources` /
`oauth` / `createModelsFetcher` / `fallbackModels`;这一家自己的特殊能力填 `VendorRuntime` 的可选钩子,如 `nativeTools`);
在 `provider/vendors/provider-vendor-manifests.ts` 与 `provider/vendors/provider-vendor-runtimes.ts` 各加一行;壳的
`apps/desktop-react/src/i18n/zh.ts` 与 `en.ts` 各加一行名字(图标可选)。通用代码不许出现这一家的名字(`provider:gate`);
只测这一家的测试放 `vendors/<id>/__tests__/`。`bun run provider:drill` 证明以上就是全部改动。

**加一个 RPC 域**(请求 / 应答永远不开新通道,唯一的数据通道是 `POST /api/rpc`):

1. 在 `packages/shared/ipc/<域>.ts` 用 `defineRouter` 写契约。
2. 在所属功能的第二入口 `<功能>/<功能>-client-api[-<方面>].ts` 写处理函数,导出
   `export const <域>_CLIENT_API = defineClientApi({ id: 'rpc:<域>', router, handlers })`。
3. 在 `packages/backend/http-server/http-server-client-api-roster.ts` 按挂载顺序加一行(行上方写为什么排在这里)。

界面直接 `client.api(<域>Router)`,不用写客户端文件,也不改壳。处理函数里只许为两件事读 `context.transport`:挑回复走哪条
总线通道,以及决定离开进程的载荷要不要脱敏;「这台宿主有没有 X」问宿主端口(`hasTerminalHost()` 这类),「这个来访者
能不能做 X」问本机信任(`isHostLocallyTrusted()`)。调用上下文由宿主在自己的鉴权之后铸造,**永远不从信封里读**。

**加一个宿主端口**:在端口所属功能里写 `configure<X>Host` 与 `reset<X>Host`(单槽,未注入即结构化降级);在
`backend-host-ports.ts` 的 `OnethingHostPorts` 加一格(可缺的能力类型写 `| null`)并在 `applyHostPorts` 里对非 `null` 调
`configure*`、把 `reset*` 记进还原表;然后在三处宿主表各填这一格:`apps/desktop-react/electron/host-ports.ts`、
`packages/backend/http-server/http-server-standalone-backend.ts`、`packages/backend/headless/headless-backend.ts`
(漏填就是 `tsc` 错误)。前端要据此显示能力时,`GET /api/capabilities` 从同一个判据推导,别另写一份。

## 8. 关键系统

每段只写现行事实与硬规矩;细节看指向的正本文档。

**引擎**(`packages/backend/engine/`,L3):`ProductStreamEngine`(`engine/engine-stream-dispatcher.ts`)独占活动流的生命周期:
收命令 → 跑一轮 → 落盘 → 发事件。一轮怎么跑的内核(`CoreStreamEngine`、执行器、历史重建、上下文压缩、工具编排、触发器表)
在 `packages/backend/agent-loop/`(L1)。引擎从装配拿的东西全走六个**可选端口**(`agent-loop/agent-loop-engine-ports.ts`:
router / roomIngress / pluginIntercept / agentBinding / steeringDelivery / collabDrive):**端口缺席 = 那项能力不存在**,
从不换一个替代实现。端口由 `backend-assemble-engine.ts` 的 `createBoundStreamEngine` 填;引擎不 import 这个装配文件。

**事件**(`packages/backend/event/`):带每会话环形缓冲与序号的发布订阅总线。会话专用的类叫 `EventBus` / `StreamChannel`,
自带消息类型的泛型基类叫 `GenericEventBus` / `GenericStreamChannel` / `GenericRingBuffer`(同名不同物曾经造成误引)。
`SessionStreamCoalescer`(`event/event-stream-coalescer.ts`)把文本 / 推理 / 工具输入的增量按 16ms 有序合批,并在任何会话
事件发出前先冲掉积压。全局事件(`settings:changed`,以及 `@shared/events` 的 `GLOBAL_EVENT_LEAVES_PROCESS` 允许出进程的那些)
也走 `GET /api/events`,但不进合批器、不带 `id:`、`?after=` 不回放它们 —— 序号和环形缓冲都是按会话的。

**会话账本**(`packages/backend/session/`,正本 `docs/design/session-event-sourcing-2026-08.md` §17):每个事实是一条事件;
`sessions/<id>/events.jsonl` 是**磁盘上唯一的真相**,内存里的 `session.messages` 只是投影(归约器在
`packages/shared/session/projection/`,壳折同一份账本)。事件 / blob 写失败一律抛进命令,不吞;检测到外来写者也抛;所有读路径
只读投影。每轮结束重折账本文件字节与内存投影比对,不一致记进 `<store>/log/session-shadow.jsonl`;比对口径只有
`session/projection/session-projection-canonical.ts` 一处,要豁免就扩那个文件,不加局部例外。`meta.json` 是唯一还经存储驱动写的
文件;超过 64KB 的内容进 `blobs/`;旧的整文件 `sessions/<id>.json` 在第一次碰到时同步迁移进账本。
**写只有一个面、读只有一个面**:`sessionCommands`(`session/session-commands.ts`)与 `sessionReads`(`session/session-reads.ts`);
`session.messages` 只许出现在 `scripts/session-check.mjs` 列出的白名单文件里,消息字段只在 `session/session-message-shapes.ts`
的归约器里赋值(`session:gate`);dev / vitest 下交出去的消息深冻结,就地改当场抛 TypeError。**坑**:命令是写时复制的,先拿
`session.messages`、再 `await`、再读那个变量会拿到旧数组 —— await 之后重读。账本今天**不**保证:`events.jsonl` 与 `meta.json` 走
两条独立写队列;两个 `server:start` 进程不会互相拒绝(外来写者检测事后才抓到)。
**轨迹**(`session/trace/session-trace-assemble.ts`)是账本上的只读查询面,三个出口:`onething trace <sessionId>`、
`sessionEvents` RPC 域、轨迹面板;不为它加专门的 REST 路由。

**检索**(`packages/backend/search/`,正本 `docs/design/search-index-2026-09.md`):跨会话检索读一份**派生索引**
`<store>/index/search.v1.sqlite`(账本的投影,删了会自己重建,别处不读它)。引擎是内建 `node:sqlite`,数据库句柄**只在
`worker_threads` 的 Worker 里**(同步 API 放主线程会冻住桌面),主线程每个变化的会话只发一条 `postMessage`。每个宿主的构建
配方都产出一份 `search-worker.cjs` 并放在宿主入口旁边,装配按 `import.meta.url` 找它;桌面里它被 `asarUnpack`。
**只有一条查询路径**:`search` RPC 域 → `SearchService` → 能力登记表 → 能力;旧的扫描路径与它的形状不许长回来(`boundary:gate`),
守它的是 `search/__tests__/golden-snapshot.test.ts`。授权是查询输入(范围编译成 `docId IN (…)`,不用 `JOIN` 后过滤)。
**语义召回**是同一索引上的第二个检索器,**默认关**:开关与模型下载是两件事(开关打开不下载;模型有自己的状态与下载 / 取消 /
删除三个动词,下载完整以下载结束后写的 manifest 为准,不以文件在不在判);开关热生效,换 Worker 时先停旧的再起新的(两个
Worker 就是两个写者);Worker 的下载走与服务商同一份受管 fetch(`network/network-managed-fetch.ts`),日志转发回宿主文件(两个别再踩的坑:npm undici 8
下给 Node **全局** fetch 传 `init.dispatcher` 不生效,要用 `undici.fetch`;应答要重新包成**全局** `Response`,因为 transformers
按 `response instanceof Response` 决定写不写磁盘缓存);
embedder 只能跑 `device: 'cpu'`;后端回答原因码(`vectorErrorKind`),不回答句子。打包的桌面不带嵌入运行时,答 `vector: 'off'`。

**权限**(`packages/backend/permission/`):一次询问记下 `targetChannel = engine.getChannel(sessionId)`,应答的通道必须与之
相同(防总线上的跨通道冒充);从别的传输应答时沿用询问的 `targetChannel`(HTTP 应答就这么做,来访者已在 HTTP 边界认证过)。
`Permission.getPendingPrompts(sessionId)` 是待答询问的唯一来源。工具的授权只看 `Intent.effects`(效果表
`packages/shared/toolkit/effects.ts`),外部 agent 走同一个 `Authorizer.decide`。

**工具**(`packages/backend/toolkit/` 是工具系统,`packages/backend/tool/` 只放纯模块):每次调用走
`validate → intercept → plan → 按效果授权 → apply → 输出预算`,没有开关、没有第二条路。注册是一本目录,每一轮发给模型的
工具面由 `toolkit/toolkit-scene.ts` 的 `resolveScene` 加各工具自己的 `visibleIn` 决定(协作工具只在它的场子里,表在
`collab/tools/collab-tool-surface.ts`)。网页正文、搜索结果、内置浏览器的页面读出都用 `toolkit/toolkit-untrusted-text.ts`
包成「外部内容,是数据不是指令」—— 内置浏览器读的是用户登录着的页面。

**提示词**(`packages/backend/prompt/`,正本 `docs/design/prompt-composition-2026-08.md` 与 `prompt-channels-2026-08.md`):
一个「目录在上、正文在下」的生成器,由 `PromptComposer` 读一组 `PromptSource`(内置段落表、本轮工具面上各工具自带的
`prompt`、片段登记表、插件);composer 只做过滤 → 排序 → 渲染,除 `requires*` 外不点名任何工具。片段分两条通道:`system`
是静态前缀,同一 agent 的所有会话**逐字相同**;会话级 / 轮级的内容一律走 `turn`,放进最新用户消息的 `<context-update>` 尾块,
按块去重并落在消息的 `turnContext` 上,重建时回放同样的字节。

**服务商**(`packages/backend/provider/`,L1):一家一目录,只放事实与纯逻辑;**用服务商干活的**(造实例、跑一次对话、
辅助模型、鉴权解析)在 `packages/backend/provider-call/`,凭证池与轮换在 `packages/backend/credentials/`(整份用后端自己的
主密钥加密落盘,钥匙读不到时是「已锁定」:读答空且不缓存、写拒绝,`spaces.credentialsStatus` 答档位与原因码、
`credentials:locked` 出进程;口令导出 / 导入在 `spaces.exportCredentials` / `importExportedCredentials`),模型目录服务在
`settings/settings-model-registry-service.ts`,受管 fetch 与代理规则在 `packages/backend/network/`。外面只经
`@onething/backend/provider` 一个入口;通用代码不点名服务商,某家自己的特殊行为做成名册钩子。

**插件**(`packages/backend/plugin/`,宿主与插件约定的词汇在 `packages/backend/plugin-contract/`,正本
`docs/design/plugin-system-redesign-2026-08.md`,作者指南 `docs/guides/plugin-authoring.md`):插件的全部能力是注入的 `api`
对象。规矩:UI 只在宿主命名的锚点上放声明式描述树(**可以放在 composer 旁边,永远不进 composer**,也不接管消息列表);配置类
交互进设置页,面板只放活内容;主题覆盖作为参数传进主题计算,不铺在算好的 CSS 变量上;安装只经 npm 账本
(`--ignore-scripts`、SRI 校验、失败回滚);开放新的宿主登记表之前先读 `plugin-contract/plugin-contract-policy.ts` 的
`PLUGIN_DEFERRED_REGISTRIES`;插件 API 不暴露凭证原文。插件只在装了插件管理器的进程里执行:第④步批 4 起是**后端进程**的
桌面档与 CLI 档(`backend-launcher.ts` 装配后起,`plugin/plugin-backend-host.ts`),缺省档(`server:start`)不装,那里插件域的写操作
照旧结构化地答「只在桌面宿主」(那几句只剩缺省档走得到,D342)。**开关**:`plugin-settings.json` 里 `enabled: true` 的跑、`false` 的
不跑,**没有记录的用户插件算关**(用户 10-07 拍定;内置插件缺省开;从设置里新装的那一次当场记 `enabled: true`)。插件命令的 `exec`
由后端进程自己起子进程(execa,PATH 是后端的,桌面档补过登录 shell);`file-pick` 的对话框在客户端开,选好的文件经
`plugins.pickFile` 的 `file` 一格交回(本机路径只认本机可信的来访者,或字节),后端过闸、拷进插件数据目录、只答 `storage:` 地址。
门 `gate:plugin`。React 壳今天还没有插件页,也不渲染插件描述树。

**IM 网关**(`packages/backend/gateway/`,L3):渠道(微信 / Telegram)、白名单与限流、网关桥。两种跑法:**跟着后端**(第④步批 4,
`gateway/gateway-host.ts` 的 `createBackendGatewayHost` 实现 `GatewayHostPorts`,对话 runtime 是进程内的引擎;桌面档与 CLI 档起,
后端起来时 `settings.channels.wechat.enabled` 开着就自动连,设置一改跟着起停,**只认设置不认环境变量**;退出 onething 时没开
「退出后让后端继续运行」网关就一起断),与独立网关进程 `gateway-standalone-main.ts`(按环境变量,要 `ONETHING_GATEWAY_RUNTIME_MODULE`)。
门 `gate:gateway` 用 127.0.0.1 上的假 iLink,**绝不连真渠道**。React 壳今天没有网关设置页(「通用」页只有一行说明)。

**MCP / ACP / 外部 agent**:MCP 客户端、管理器、OAuth 与跨进程工具桥在 `packages/backend/mcp/`;ACP 是外部 agent 的唯一通路
(Claude Code 也走 ACP,正本 `docs/design/acp-integration-2026-09.md`),在 `packages/backend/acp/`;连接器登记在
`packages/backend/external-agent/`。**MCP 服务器反向问人**(`elicitation/create`,10-08,正本
`docs/design/computer-use-2026-10.md`):客户端声明 `elicitation.form`,处理函数在 `mcp/mcp-elicitation.ts` —— 只答空表单,
画成 `type: 'mcp_consent'` 的权限卡(卡的标题是服务器那句原话),「本会话 / 本工作目录」由 onething 自己记 grant
(pattern = 服务器 id × 那句话),URL 模式、带字段的表单、没有在飞调用的自发询问一律结构化拒绝并记日志。发问落到哪个会话靠
工具调用随身的坐标:`McpTool.apply` 从 `RunContext` 填 `caller`,一路递到客户端运行时,在调用期间挂在 `inFlightCall` 上
(同一台服务器的调用串行,所以最多一条)。Codex 装在本机的 Computer Use MCP 就是这样接的(签名 `codex sandbox` 当跳板,
配方在正本 §3.1,门 `gate:codex-computer-use`)。**已知的本机服务器默认填好**(10-09):`mcp/mcp-known-servers.ts` 一张表,
`McpSubsystem.start()` 起 manager 之前经 `prepareSettings` 把检测到、设置里没有、用户没删过的填进 `servers` 并落盘;用户删掉
一台已知服务器记进 `mcp.dismissedKnownServers`,不再填回来。再接一台 = 表上一行。

**日志**(`packages/backend/logging/`,正本 `docs/design/logging-system-2026-08.md`):产品代码只调 `getLogger(ns)`
(经 `@onething/backend/logging`);`msg` 是固定短句,变量放 `fields`,错误放 `err`。`configureLogging()` 是唯一接线点
(幂等,在 `logging-configure.ts`,宿主在装配前调)。文件是 JSONL:`<store>/log/app.jsonl`(桌面与 CLI)、`server.jsonl`、
`daemon.jsonl`。级别用 `ONETHING_LOG='info,engine.*=debug'`;设置里的诊断模式 = 全域 debug + 服务商请求转储,关掉回到环境
变量的级别。请求转储**默认关**(曾写出 1.1G)。`log/` 只有一个管家(`LogDirJanitor`),它只删归档与转储,从不碰会话账本、
用量账本这类产品数据。崩溃钩子记 fatal 并同步冲盘,不改 Node 自己的崩溃行为。渲染层日志走 `logs` RPC 域,接收端自己盖上
`ns` 前缀、`src` 与调用方(发送方不能自报身份)。网关在构造时拿 logger,零 `console.*`。**给人 / 管道看的输出用 CLI 的
`stdout()`,给排障看的用 `getLogger`**。

**笔记**(`packages/backend/note/`,正本 `docs/design/notes-obsidian-cli-2026-09.md`):笔记库是一个领域,Obsidian 与普通目录
是它的两种驱动。Obsidian 走官方 CLI:退出码恒为 0(错误在 stdout 第一行)、stdout 必须读到底、**以能否连上
`~/.obsidian-cli.sock` 判活,连不上就一条命令都不发**(app 没开时发命令会把它拉起);只有 `openInApp` 允许拉起 app。
`noteRootsNow()` 是「笔记根」的唯一定义,沙箱根、检索范围、`@` 文件提及、附件、技能根都读它;接入的目录是权限面,不是笔记根。

**内存治理**(`packages/backend/memory/`):模块里可重建的内存数据实现 `MemoryHolder` 并在装配处一行 `registerHolder` 登记;
`trim` 只许释放能重建的东西(不是唯一副本、不在运行中的任务用着);登记表不点名任何 holder。调度器每 30 秒采样,超预算
(`ONETHING_MEMORY_SOFT_MB` / `ONETHING_MEMORY_HARD_MB`,缺省 1024 / 1536)才请 holder 释放。`memory` RPC 域的 `trim` 只给本机
信任的来访者。

**终端与内置浏览器**(正本 `apps/desktop-react/docs/terminal-browser-2026-09.md`):终端的 PTY、16ms 分批、序号、回放环与带代数(generation)
的流控在 `packages/backend/terminal/`,输出经全局事件 `terminal:data` / `terminal:exit` 走 SSE,不开手写推送通道。内置浏览器
是主进程模块 `apps/desktop-react/electron/browser/`:每个标签一个 `WebContentsView`、用到才建;网页权限缺省拒绝,只有少数几项
可问;**调试端口缺省关**,`run/http.json` 里的 `cdp` 字段以命令行是否真开了端口为准;只有 `index.ts` import electron。
第④步批 2b 起 `browser:` 是**壳侧命名空间**(每条做法 `home: 'shell'`):主进程经 `electron/shell-resources.ts` 以一扇壳的身份
`resources.mountShell` 认领、收 `resource:shell-command`、回执、报事实(后端重拉后立刻重登记);「人零效果、模型顶格」与
`respondPermission` 只许人答(自述 `userOnly`)在 core 的 `ShellResourceProvider.plan` 判;标签页内存由 Electron 自己按预算释放。
AI 经 `browser:` 资源读写它,导航算 `browser_navigate` 效果(带着用户自己的 cookie,与匿名 fetch 不是一回事);进程外可以让
chrome-devtools-mcp 连 CDP 端口,但它的 `new_page` 在 Electron 上不可用(`Target.createTarget: Not supported`),开标签要走内置浏览器。
渲染层里只有 `apps/desktop-react/src/content/terminal/screen.ts` 在运行期 import `@xterm/*`。用官方 Electron,
不用 castlabs。

## 9. 进程与数据流

**一个 store 只有一个后端**(正本 `docs/design/one-core-2026-08.md`):HTTP/SSE 面是 `packages/backend/http-server/` 的代码,
`packages/backend/backend-standalone-main.ts` 是它外面的进程入口;桌面拉起的后端、`server:start`、真机门跑的都是这只入口(档位不同),
所以浏览器壳与桌面订阅的是同一台后端的事件流。谁服务这个 store,谁写 `<store>/run/http.json = {port, host, token, pid, startedAt, owner}`(0600),退出时只删
`pid` 是自己的那份;端口动态,除非 `ONETHING_SERVER_PORT` 钉死(钉死且被占 = 明确报错,不静默换端口);`server:start` 遇到
**活着的**记录就拒绝启动,不看 owner(第④步批 2a,D6;`--force` 越过)。owner 有四种:`backend`(桌面拉起的后端,桌面档)、
`server`(`server:start`)、`shell`(批 2b 之前桌面进程内装配时写的,今天只有冒烟探针还写)、`desktop`(旧名)。桌面只停 owner
`backend` 的那台(它自己拉起的,或上一次「继续运行」留下的),别人的 `server:start` 它只借、不停、不重启;记录上 `launcher: 'cli'`
的那台是 CLI 拉起的(第④步批 3),桌面同样只借不停,由 `onething backend stop` 去停。token = `ONETHING_SERVER_TOKEN` 或每次启动新铸。server 单用户,绑非回环地址
又没设 token 会警告。

**插件与网关住在后端里**(第④步批 4):插件管理器与 IM 网关是这个 store 那台后端(桌面档 / CLI 档)的子系统,不在任何客户端里;
客户端只经 `plugins` / `gateway` 两个 RPC 域看它们、改它们。所以它们的寿命就是后端的寿命:桌面 Quit 时若没开
`general.backendKeepRunningAfterQuit`,后端收 SIGTERM,插件与网关一起拆(各 3 秒上限);开着就留着,下次桌面借回同一台。

**React 桌面是它拉起的那台后端的 HTTP 客户端**:渲染层只走 `POST /api/rpc` 与 `GET /api/events`,主进程也是(`electron/core-client.ts`:
终端 `detachAll`、`browser:` 的壳侧登记、设置订阅、先读后交);它只有三条 IPC 通道,都不是数据
通道 —— `host:connection` 交 `{ baseUrl, token }`(发现文件是 0600,渲染层不读盘;后端重拉时地址与 token 不变,这个承诺只答一次),`host:native-view` 是窗口系统给原生视图
用的管道,`host:client-action`(第④步批 1,D5 用户 10-06 拍定)是**只在用户屏幕上发生的事**:原生打开对话框、把网址交给
系统浏览器、用默认程序打开路径、在访达中定位,以及第④步批 2b 加的三个只有拉起后端的宿主答得出的动词(后端状态 / 重启后端 /
定位后端日志)(七个动词在载荷里,契约 `@shared/contracts/client-action`,主进程逐格校验在
`electron/client-action.ts`)。它不是数据通道:它答的是只有宿主答得出的事,请求 / 应答的数据照旧只走 `POST /api/rpc`;
`transport:gate` 的 `ipcMain` 钉在 3。主进程往渲染层另有两条单向推送(`webContents.send`,不是 `ipcMain` 口):全屏态
`host:fullscreen` 与后端状态 `host:backend-state`(设置页状态行、「正在重新连接后端。」、「后端已停止。」横幅读它)。浏览器壳没有这条口,判「这台客户端做不做得到」只看它在不在(壳的
`platform/host.ts` 的 `canRunClientActions()`),按钮不画或答一句结构化的「这台客户端做不了」。

**CLI 也是那台后端的 HTTP 客户端**(第④步批 3):守护进程与 unix socket 退役,`onething` 读发现文件、连活着的后端,
每条命令是 `POST /api/rpc` 上的域方法、`ask` 的流从 `GET /api/events` 来。桌面开着时 CLI 用的就是桌面那台(`full` 工具、
窗口里也能答卡、CLI 建的会话出现在桌面列表里);没有活后端时缺省报「后端没在运行」并非零退出,`--spawn` 才自己拉起一台
CLI 档。新契约只有一条 `backend.shutdown`(本机信任的来访者、且只在独立后端进程上答应);`onething mcp` 的桥要替外面的
agent 说话,经请求头 `X-Onething-Acting-System` 把主体**降**成 `system:mcp:<名字>`(`http-server-principal.ts`,只能降不能升)。

**后端请客户端执行**(shell dispatch,`packages/backend/resource/resource-shell-*.ts`):客户端经 `resources.mountShell`
认领命名空间 —— 整个住在壳里的(`workbench:`),或 core 命名空间里 `home: 'shell'` 的那几条做法(`dir:` 的 `reveal`);
core 照旧 plan、授权、审计,执行那一步经全局事件 `resource:shell-command` 发给一扇认领者(命令带 core 那份 plan 的载荷,
所以壳拿到的是夹过沙箱的路径)。好几扇壳可以认领同一份自述;**发给谁**(D8):用户在某扇壳里点出来的发回那一扇
(客户端每条请求带 `X-Onething-Shell-Id`,HTTP 边界铸进 `callerId`,永不从信封里读),AI 发起的发给最近一次有活动的那一扇
(登记、报事实、亲手发起资源调用算活动,心跳不算);没有认领者 = 当场 `ResourceHomeUnavailableError`。因为桌面也走 HTTP,判「这个来访者是不是本机」不能看 `context.transport`,看本机信任声明(回环后端 —— 桌面拉起的那台与 `server:start` 同样 —— 是 `loopback-server`;`desktop-embedded` 只剩进程内嵌入
的冒烟探针在写;起本机进程那道闸(mcp 的 stdio probe)从第④步批 2a 起与别的闸同判据
`isHostLocallyTrusted()`,两种可信不再分档,D9);`GET /api/capabilities` 从同样的判据推导,界面的能力位与后端的守卫
不会不一致。

**发一条消息**:界面 `client.api(sessionCommandRouter).emit(...)` → `POST /api/rpc` →
`packages/backend/session/session-client-api-commands.ts` → 事件总线 → `ProductStreamEngine` 落盘并发事件与流块 →
`GET /api/events` SSE(`?after=` 从环形缓冲回放)。工具要授权时:`Permission.ask` → `permission:request` 事件(带
`targetChannel`)→ 界面 → `command:permission-respond`(通道必须一致)→ 工具执行。

**store**:根目录按 `ONETHING_STORE_PATH` → `~/.onething` 解析(`packages/backend/storage/storage-paths.ts`),所有路径都经
`getOnethingStorePath()` 与它的 `getOnething*Path` 系列,不许写死。第④步批 3 之后没有进程拿 `StoreLock`(从前只有 CLI 守护进程以 `daemon` 拿;`StoreLock` 类留给 `onething store lock` 维护命令与备份);不带界面的后端进程(`backend-standalone-main.ts`,桌面拉起的那台也是它)
**有意不拿锁**,单写者靠发现文件让位(`bun run dev` 里桌面与 dev server 共用 `~/.onething`,两个写者的风险是接受了的)。server 的 HTTP 会话面用的是引擎
同一份进程内会话表 —— 在同一批文件上再开一个仓库会把内存里的真相分叉。

**别名**:每个 `@onething/*` 都是真 workspace 包(根 `package.json` 的 `workspaces` 逐个列出,不用 `packages/*` 通配,否则会把
`apps/mobile` 的 expo 拖进来);`@onething/backend` 按自己 `package.json` 的 exports **精确键**解析(没有通配),缺键在
typecheck 就红;`@onething/*` 永远不进根 `package.json` 的 dependencies。唯一的非包别名是 `@shared`。

**构建产物**:`apps/desktop-react/dist` 与 `dist-electron/`(`main.cjs` / `preload.cjs` / `backend.cjs`(桌面拉起的后端进程,asarUnpack)/ `search-worker.cjs` / `acp-mcp-bridge.cjs`)、`dist/cli/`、`dist/web/`、
`dist/server/`(单文件 SSR 包,钉 `inlineDynamicImports` —— 拆块加顶层 await 会让模块求值死锁)。

## 10. 已退役

下面这些已经删掉,代码里不许复活,来历见存档:Vue 宿主(`apps/electron` / `packages/renderer` / `apps/web`,
`shell:invoke` 通道、`macos_panel`,`checkVueHostStaysRetired` 守着)与它的 `ui:gate`;`core/` / `runtime/` / `wiring/` 三层
与 `*.wiring.ts` 后缀;总桶 `runtime/index.ts` 与兼容桶 `store.ts`;better-sqlite3;soul-memory 插件(没有 memory 子系统,
`usage` 仍认 `source: 'memory'` 以便旧账本行解析);Claude SDK 连接器(Claude Code 只走 ACP);旧的检索扫描路径与
`search:parity-*` 门;`find` / `grep` / `glob` 等工具(用 bash 的 rg / fd);CLI 守护进程(`HeadlessBackend` / `packages/backend/headless/`、`daemon-server.ts` / `daemon-client.ts` / `ndjson.ts`、`daemon.sock`、`@shared/cli/protocol.ts`,第④步批 3,`checkCliDaemonStaysRetired` 守着)。
