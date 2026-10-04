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
- **换过 Electron 二进制之后,第一次起桌面必须人手起,并在钥匙串弹框上点「始终允许」**。`safeStorage` 是 Keychain
  的门面,绑 app 的代码签名身份;`sign:dev:mac` 打的是 ad-hoc 签名,换一份二进制就换了身份,钥匙串条目的 ACL 不再
  匹配,macOS 弹授权框。脚本起的进程没人点那个框,`safeStorage.isEncryptionAvailable()` 永不返回:表现是装配停在
  `migrateProviderConfigToDefaultSpace()`、进程 0% CPU、不报错、`<store>/log/*.jsonl` 一行没有、窗口不开。这不是回归,
  是 macOS 的凭证隔离按设计工作(与 `apps/desktop-react/electron/main.ts` 文件头「子进程是另一个 app 身份」同一机制)。
- **端口**:React 桌面的渲染层 dev server 是 5175(`electron:dev`),浏览器壳是 5174(`web:dev`)。后端 HTTP/SSE 端口是
  **动态的**:谁在服务这个 store,谁写 `<store>/run/http.json`;浏览器壳的 dev `/api` 代理
  (`apps/desktop-react/vite/dev-api-proxy.ts`,做成插件是因为 vite 自带代理在创建时就钉死目标)**每个请求重读**这份
  文件并注入 Bearer token,读不到才回落 `ONETHING_API_URL` || `http://127.0.0.1:8787`。`bun run dev` 带桌面泳道时
  **不起第二个 server 进程** —— 桌面自己就是后端。

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

# 构建
bun run build              # 桌面构建(scripts/build-desktop.mjs:dist/cli/main.cjs → apps/desktop-react/{dist,dist-electron})
bun run build:cli          # 只构建 CLI → dist/cli/main.cjs
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

onething 是一个多服务商、带工具调用、事件驱动流式引擎的 AI 聊天应用。产品在 packages 里,apps 都是薄壳。

| 位置 | 是什么 |
| --- | --- |
| `packages/backend`(`@onething/backend`) | **唯一的后端包**:装配配方 + 一个功能一个目录 + 界面连进来的 HTTP 服务器 |
| `packages/shared`(`@shared`) | 后端与界面之间的契约(RPC 路由契约、事件词汇、发现文件形状),加上两边必须算得一样的纯逻辑(会话投影、引用、效果表……)。**只引自己**,不引 node、不引 `@onething/*` |
| `packages/backend-client`(`@onething/backend-client`) | 连后端用的 SDK:`Transport`(fetch + fetch 流式 SSE + Bearer)、`client.api(router)`、事件中心。Node 与浏览器同一份代码 |
| `apps/desktop-react` | **唯一的桌面**(Electron + React),`--mode web` 时也是浏览器壳。主进程自己装配一份后端并挂上 HTTP 面;渲染层只走 HTTP/SSE |
| `apps/backend-server` | 不带界面单独跑的后端的进程壳(`main.ts` + `index.ts`);HTTP 面本身在 `packages/backend/http-server/` |
| `apps/cli` | CLI 守护进程与命令(`bin/onething.mjs` → `dist/cli/main.cjs`) |
| `apps/mobile` | Expo 客户端,不是 workspace 成员 |

依赖方向:界面一侧(`apps/desktop-react/src`、`apps/mobile`、`packages/backend-client`)只许引 `@shared/*` 与
`@onething/backend-client`;`packages/shared` 只许引自己;后端可以引 `@shared`。这三条由 `boundary:gate` 守。

**`packages/backend` 内部**:

- **包根只有组装配方**:`backend.ts`(`createOnethingBackend` / `OnethingBackend.assemble`,唯一的装配配方)、
  `backend-assemble-engine.ts`(装引擎:引擎层、端口接线、内置触发器)、`backend-current.ts`(唯一的进程槽:当前实例,
  以及 `getStreamEngine()`)、`backend-host-ports.ts`(宿主端口表)、`backend-shutdown.ts`(关机阶段表)、
  `backend-types.d.ts`,加 `http-server/` 与 `__tests__/`。
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
  (`packages/backend/search/index/search-index-worker.ts`)、ACP 宿主工具桥、独立网关
  `packages/backend/gateway/gateway-standalone-main.ts`、`scripts/gate-*/` 下的被测产物入口。它们按路径直接指要的模块,
  而且**不许被任何文件 import**。
- **`http-server/`**:界面连进来的那台 HTTP 服务器(收请求、SSE 事件流、发现文件、来访者身份与本机信任、按名册分发),
  入口 `packages/backend/http-server/http-server.ts`。它不认识具体功能,只读两张名册:
  `http-server-client-api-roster.ts`(每个 RPC 域一行,顺序 = 挂载顺序)与 `http-server-runtime-roster.ts`
  (各功能 server 门面的安装 / 拆除顺序)。

**层次**(D23,层次表 `docs/audit/feature-layers-2026-10.json`,每个功能一行 `{feature, layer, why}`):

| 层 | 名字 | 含义 | 例子 |
| --- | --- | --- | --- |
| L0 | 基础件 | 不认识任何产品概念 | storage、logging、network、lifecycle、memory、shell、dialog |
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
  也要说清是什么(`backend-client`、`backend-server`)。

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

下表除 `provider:drill` 外都在 CI(`.github/workflows/test.yml`)里跑;CI 另外还跑根与壳的单测和壳的 `ui:consume`。「零基线硬闸」= 一处命中就红;「棘轮」= 按基线计数,只许降(降了用 `--write-baseline`
收紧)。

**结构门**(后端):

| 命令 | 判什么 | 类型 |
| --- | --- | --- |
| `bun run boundary:gate` | `scripts/headless-boundary-check.ts` 的全部断言(`bun run boundary` 打全量):后端不引 electron / `@main` / `@preload` / 渲染层别名,功能目录不引 cordis(`feature-registry/` 除外),shared 只引自己,界面一侧只引 shared 与 backend-client,Vue 宿主不许复活,检索只有一条查询路径。没打出完成标记或一行 ok 都没有也算红 | 零基线硬闸 |
| `bun run entry:gate` | 从功能外引入口以外的文件;进程入口被 import;功能主入口里的 `export * from`;功能内非测试文件引自家主入口(`entry:check` 打全表) | 非测试深层引用、进程入口、主入口 `export *`、自引入口四条硬闸 / 测试深层引用棘轮(`docs/audit/feature-entry-baseline-2026-10.txt`) |
| `bun run cycle:gate` | 运行期值引用图里含功能入口的强连通分量(只引类型、动态 `import()`、测试不成边);红时打出最短环 | 零基线硬闸 |
| `bun run layer:gate` | 低层引高层的值边;层次表里没登记的功能 | 零基线硬闸 |
| `bun run name:gate` | N1 重名、N2 功能名打头、N3 `index.ts`、N4 泛名 | 零基线硬闸 |
| `bun run cohesion:gate` | 文件内聚(D225 / D229,判据 `docs/design/oversized-files-2026-10.md` §1):顶层声明为点、引用为边(≤ 3 行的叶子常量不连边),至少两块且第二块 ≥ 150 行 = 一只文件里住着两件不相干的事。不设行数上限。`cohesion:check` 打块表,`cohesion:report` 另打形状 B / C(长函数里几组嵌套函数各管各的 `let`、一只类里几组方法各管各的字段)的报表,只报不判。拆分时用 `bun run split:prove <拆前文件> <拆后文件…>` 证明纯搬家(每条顶层声明的源文本拆前拆后多重集相等) | 新文件零基线硬闸 / 立门时命中的文件记在已知名单里只许减(今天 1 只,理由写在名单文件头,`docs/audit/cohesion-baseline-2026-10.txt`) |
| `bun run client-api:gate` | 第二入口与装配入口只被允许的人引;名字带 `-client-api` 却不合形状;少于 40 只 client-api 算红(防假绿) | 零基线硬闸 |
| `bun run feature-map:check` | `docs/architecture/feature-map.md` 与代码一致 | 一致性 |
| `bun run assembly:gate` | 每只非测试文件的模块级 `let` 个数(`backend-current.ts` 豁免);新状态挂在 `OnethingBackend` 实例上并 `own()` | 棘轮(`docs/audit/assembly-baseline-2026-09-02.txt`) |
| `bun run transport:gate` | 手写通道常量个数与壳文件行数;`http-server/` 与全部 client-api 里读 `context.transport` 的处数;React 壳的 `ipcMain` 注册 ≤ 2 | 棘轮(`docs/audit/transport-forks-baseline-2026-09-03.txt` 等) |
| `bun run provider:gate` | 某家服务商的 id 出现在它自己的 `provider/vendors/<id>/` 之外(按 TypeScript 解析,注释不算;名册、壳的 i18n 与图标、`provider/model-families/`、协议名等豁免) | 棘轮(`docs/audit/provider-vendor-baseline-2026-10.txt`) |
| `bun run provider:drill` | 在临时 worktree 里加一家虚构服务商,断言目录外只动了两份名册与壳的两份 i18n | 演练 |
| `bun run log:gate` | 非测试源码里 `console.*` 的处数(`scripts/` 与 `apps/cli/src/stdout.ts` 除外);新代码用 `getLogger` | 棘轮(`docs/audit/log-gate-baseline-2026-08-20.txt`) |
| `bun run session:gate` | `session.messages` 只出现在白名单文件、消息字段只在 reducer 里赋值(`session:check` 打全表) | 零基线硬闸 |

除 `boundary:gate`(全量用 `bun run boundary`)与 `transport:gate` 外,每道 `*:gate` 都有对应的 `*:check` 打出全部命中。

**运行时与真机门**(不在 CI 里,手跑或发布前跑,多数要先构建):

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
- `bun run gate:packaged` —— `build:unpack` 后在临时 store 上起打包的 .app:`run/http.json` → `/api` → 窗口 → 干净退出;
  并断言 `search.status` 的 `mode === 'owner'`、`vector: 'off'`、`vectorExtension: 'loadable'`(证明 `asarUnpack` 还在)。
- `bun run gate:web-shell` —— React 浏览器壳:真 server 产物 + `/api` 代理 + 无头 Chromium,流式回复上屏,且 token 不进 URL。
- `bun run gate:notes`(只读、只碰开着的库,Obsidian 没跑就 skipped)、`bun run gate:store-backup`(先 `build:cli`,只在隔离
  目录里跑 CLI 的 store 备份)、`bun run log:smoke`(断言 `server.jsonl`)。
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
  在装配时构造并当场 `own()`,所以拆除不依赖 `start()` 有没有跑完;`mcpAcp: true`(CLI 守护)时装配自己等 `start()`,别的
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

| 宿主 | 装配处 | 要点 |
| --- | --- | --- |
| React 桌面 | `apps/desktop-react/electron/main.ts` | `host: createShellHostPorts()`(`apps/desktop-react/electron/host-ports.ts`;没有的能力逐格写 `null`,那张列表就是壳的能力缺口);`toolRegistry: 'full'`;窗口起来后 `own()` 内嵌 HTTP 面与发现文件、定时任务、MCP、ACP、`installBrowserHost()`;起这些服务前先等 `electron/login-shell-env.ts` 拿登录 shell 的 PATH;`run/http.json` 已指向一个活着的后端时直接连它,不再装配 |
| 不带界面的 server | `packages/backend/http-server/http-server-standalone-backend.ts`(`createRealServerBackend`)→ `createOnethingServerRuntimeOverBackend` | 只有 sandbox 与 storePath 是真的;`ONETHING_SERVER_TOOLS=readonly` 时 `'readonly'`,否则 `'full'` |
| CLI 守护 | `packages/backend/headless/headless-backend.ts`(`HeadlessBackend`,`apps/cli/src/daemon-server.ts` 用) | `toolRegistry: 'headless'`、`mcpAcp: true`、`collab: true`;退出 = `backend.dispose()` |

## 7. 怎么加一个东西

**加一个后端功能**(先做「陌生能力演练」,答案应当是「能力自己的模块 + 壳渲染模块 + 各一行注册」):

1. 先在 `docs/audit/feature-layers-2026-10.json` 登记一行 `{feature, layer, why}`(没登记 = `layer:gate` 红);`why` 写一句人话。
   拿不准层次,按「它引谁、谁引它」判,低层不许引高层。
2. 建 `packages/backend/<功能>/`(单数名词),入口 `<功能>/<功能>.ts`:文件头写 R3 说明书,只用具名导出、按类分组,
   只交外面真在用的名字。
3. 在 `packages/backend/package.json` 的 exports 里加**一把**键 `"./<功能>": "./<功能>/<功能>.ts"`(exports 只认精确键,
   缺键在 typecheck 就红;不要为外面的读者开深层键 —— 外面要的名字进入口)。
4. 文件叫 `<功能>-<做什么>.ts`,测试叫 `<被测文件名>.test.ts` 放 `__tests__/`;功能内部引兄弟文件,不引自家入口。
5. 要被别的功能用到时,做成在它们的注册表里**登记一行**,不去改它们的代码;装配期的状态挂在实例上并 `own()`,或者
   放首次用到才建的 `const` 持有器。
6. 要开给界面:加第二入口(见下「加一个 RPC 域」)。要宿主能力:加宿主端口(见下)。
7. `bun run feature-map` 重生成功能地图,然后跑 `name:gate`、`entry:gate`、`cycle:gate`、`layer:gate`、`client-api:gate`、
   `feature-map:check`、`assembly:gate`、`boundary:gate`。

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
辅助模型、鉴权解析)在 `packages/backend/provider-call/`,凭证池与轮换在 `packages/backend/credentials/`,模型目录服务在
`settings/settings-model-registry-service.ts`,受管 fetch 与代理规则在 `packages/backend/network/`。外面只经
`@onething/backend/provider` 一个入口;通用代码不点名服务商,某家自己的特殊行为做成名册钩子。

**插件**(`packages/backend/plugin/`,宿主与插件约定的词汇在 `packages/backend/plugin-contract/`,正本
`docs/design/plugin-system-redesign-2026-08.md`,作者指南 `docs/guides/plugin-authoring.md`):插件的全部能力是注入的 `api`
对象。规矩:UI 只在宿主命名的锚点上放声明式描述树(**可以放在 composer 旁边,永远不进 composer**,也不接管消息列表);配置类
交互进设置页,面板只放活内容;主题覆盖作为参数传进主题计算,不铺在算好的 CSS 变量上;安装只经 npm 账本
(`--ignore-scripts`、SRI 校验、失败回滚);开放新的宿主登记表之前先读 `plugin-contract/plugin-contract-policy.ts` 的
`PLUGIN_DEFERRED_REGISTRIES`。插件只在装了插件管理器的进程里执行;今天 React 壳与 CLI 都不装,插件域的写操作结构化地答
「只在桌面宿主」。

**MCP / ACP / 外部 agent**:MCP 客户端、管理器、OAuth 与跨进程工具桥在 `packages/backend/mcp/`;ACP 是外部 agent 的唯一通路
(Claude Code 也走 ACP,正本 `docs/design/acp-integration-2026-09.md`),在 `packages/backend/acp/`;连接器登记在
`packages/backend/external-agent/`。

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
AI 经 `browser:` 资源读写它,导航算 `browser_navigate` 效果(带着用户自己的 cookie,与匿名 fetch 不是一回事);进程外可以让
chrome-devtools-mcp 连 CDP 端口,但它的 `new_page` 在 Electron 上不可用(`Target.createTarget: Not supported`),开标签要走内置浏览器。
渲染层里只有 `apps/desktop-react/src/content/terminal/screen.ts` 在运行期 import `@xterm/*`。用官方 Electron,
不用 castlabs。

## 9. 进程与数据流

**一个 store 只有一个后端**(正本 `docs/design/one-core-2026-08.md`):HTTP/SSE 面是 `packages/backend/http-server/` 的代码,
`apps/backend-server/src/main.ts` 是它外面的进程壳,桌面主进程把**同一份**代码挂在自己的后端上,所以浏览器壳订阅的是桌面的
事件流。谁服务这个 store,谁写 `<store>/run/http.json = {port, host, token, pid, startedAt, owner}`(0600),退出时只删
`pid` 是自己的那份;端口动态,除非 `ONETHING_SERVER_PORT` 钉死(钉死且被占 = 明确报错,不静默换端口);`server:start` 遇到
活着的、`owner` 不是 server 的记录就拒绝启动。token = `ONETHING_SERVER_TOKEN` 或每次启动新铸。server 单用户,绑非回环地址
又没设 token 会警告。

**React 桌面是它自己后端的 HTTP 客户端**:渲染层只走 `POST /api/rpc` 与 `GET /api/events`;它只有两条 IPC 通道,都不是数据
通道 —— `host:connection` 交 `{ baseUrl, token }`(发现文件是 0600,渲染层不读盘),`host:native-view` 是窗口系统给原生视图
用的管道。因为桌面也走 HTTP,判「这个来访者是不是本机」不能看 `context.transport`,看本机信任声明(桌面是
`desktop-embedded`,回环 server 是 `loopback-server`);`GET /api/capabilities` 从同样的判据推导,界面的能力位与后端的守卫
不会不一致。

**发一条消息**:界面 `client.api(sessionCommandRouter).emit(...)` → `POST /api/rpc` →
`packages/backend/session/session-client-api-commands.ts` → 事件总线 → `ProductStreamEngine` 落盘并发事件与流块 →
`GET /api/events` SSE(`?after=` 从环形缓冲回放)。工具要授权时:`Permission.ask` → `permission:request` 事件(带
`targetChannel`)→ 界面 → `command:permission-respond`(通道必须一致)→ 工具执行。

**store**:根目录按 `ONETHING_STORE_PATH` → `~/.onething` 解析(`packages/backend/storage/storage-paths.ts`),所有路径都经
`getOnethingStorePath()` 与它的 `getOnething*Path` 系列,不许写死。单实例靠 `StoreLock`(`desktop` / `daemon`);`apps/backend-server`
**有意不拿锁**(`bun run dev` 里桌面与 dev server 共用 `~/.onething`,两个写者的风险是接受了的)。server 的 HTTP 会话面用的是引擎
同一份进程内会话表 —— 在同一批文件上再开一个仓库会把内存里的真相分叉。

**别名**:每个 `@onething/*` 都是真 workspace 包(根 `package.json` 的 `workspaces` 逐个列出,不用 `packages/*` 通配,否则会把
`apps/mobile` 的 expo 拖进来);`@onething/backend` 按自己 `package.json` 的 exports **精确键**解析(没有通配),缺键在
typecheck 就红;`@onething/*` 永远不进根 `package.json` 的 dependencies。唯一的非包别名是 `@shared`。

**构建产物**:`apps/desktop-react/dist` 与 `dist-electron/`(`main.cjs` / `preload.cjs` / `search-worker.cjs`)、`dist/cli/`、`dist/web/`、
`dist/server/`(单文件 SSR 包,钉 `inlineDynamicImports` —— 拆块加顶层 await 会让模块求值死锁)。

## 10. 已退役

下面这些已经删掉,代码里不许复活,来历见存档:Vue 宿主(`apps/electron` / `packages/renderer` / `apps/web`,
`shell:invoke` 通道、`macos_panel`,`checkVueHostStaysRetired` 守着)与它的 `ui:gate`;`core/` / `runtime/` / `wiring/` 三层
与 `*.wiring.ts` 后缀;总桶 `runtime/index.ts` 与兼容桶 `store.ts`;better-sqlite3;soul-memory 插件(没有 memory 子系统,
`usage` 仍认 `source: 'memory'` 以便旧账本行解析);Claude SDK 连接器(Claude Code 只走 ACP);旧的检索扫描路径与
`search:parity-*` 门;`find` / `grep` / `glob` 等工具(用 bash 的 rg / fd)。
