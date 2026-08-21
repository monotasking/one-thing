# 结构债治理方案(2026-08-19,现状复审 2026-08-21)

> 起因:用户判断"代码组织很乱"。四路并行摸底 + 亲跑 checker 验证后,把"乱"拆成三种性质:
> **表层卫生**(截图/杂物/在途批次)、**结构债**(五笔有名有姓的旧债)、**体量**(单层目录过大,本方案不治)。
> 本文是结构债 + 卫生的完整分期方案。执行分工:Fable 拆分/设计/review,opus 逐期执行。

## 0a. 2026-08-21 现状复审(HEAD `b795b2d0`)

§1 的结构事实逐条重跑,**结论全部成立**,数字按下表更新;§1.6 与 §2 P0 已过期,按本节重写。

| 项 | 08-19 文档 | 08-21 实测 | 备注 |
| --- | --- | --- | --- |
| shared 通道常量 | ~342 | 342 | — |
| src/ipc | 31 文件 / 2550 行 | 31 / 2550 | — |
| main/ipc | 38 / 6543 | 37 / 6581 | — |
| bridge.ts / web.ts | 1905 / 1801 | 1900 / 1801 | — |
| 已迁 router 域 | ~11 | **12** | L2/L3 新增 `logs` 域,走的是正道 |
| 六裸写域 handle 数 | 15/14/10/2/2/8 | 一致 | collab/evals/practice/notify/deeplink/music |
| runtime→app 反向边 | 0 | 0 | 拆包零纠缠不变 |
| app 层文件数 | ~595 | **681** | 拆包体量 +15%,结论不变 |
| alias 条目 | ~110 | **241**(runtime 族 118) | 原文只数了 runtime 族;塌缩收益更大 |
| boundary 红 | 13 | 13,none new | — |
| ui:gate / session:gate / log:gate | 81 / — / — | 81 / 0 / 4,全绿 | 后两道是方案写后新加的门 |
| **transport:gate** | (写时未跑) | **红** | 见下 |
| dirty tree | 47 项 | **12 项** | 仅剩 compact 一批(+ 未跟踪 `compact-merge.md`) |

**发生了什么**(方案没看到的两天):

1. **P0 没有按"逐批归属、确认后分批提交"执行**,而是被 `2603c665 chore: 本地全量备份`(08-19,
   576 文件 / +46505 −8433)一笔吞掉,其后两天又叠了 ~30 个提交(S1/S2a/S3 事件溯源、L0–L5 日志、
   U 线文档、消息引用等)。"diff 归属"难题实质已不存在,但分批可追溯性也没了——已成事实,不回溯。
2. **卫生项落地**:截图入 `TMP/`(未跟踪、被 ignore)✅;CHANGES 两份已删 ✅;hermes 已搬
   `docs/reference/` ✅;`.gitignore` 根图片规则 ✅。**未做**:`todo.md` / `todo2.md` 仍 tracked
   (拍板 #4 没落);CLAUDE.md 没有"npm 是打包/rebuild 权威"那一行。
3. **`transport:gate` 红,且红在已提交历史里**:
   `bridge.ts 1737→1901 (+164)`、`web.ts 1718→1802 (+84)`、`channels.ts 535→558 (+23)`、
   `http.ts 1989→2028 (+39)`。来源查清:
   - channels.ts +23 = **7 个新手写常量**,全部来自 `2603c665`:`SPACES_GET/SET_PROVIDER_SETTINGS`、
     `SPACES_SET_CREDENTIAL_POOL`、`SPACES_CHANGED`(spaces 在途批)+
     `TODO_PLAN_MINIMIZE/ZOOM/DRAG_WINDOW`(todo-plan 窗口面——§1.1 点名的"骑墙"那一侧又加了三条);
   - bridge.ts +164 / web.ts +84 几乎全在 `2603c665`(306/137、254/170),不是日志迁移
     (L4 对 bridge 只 −5);
   - http.ts +39 来自 L0/L1 的 server 请求日志,正当(是日志不是新通道)。
   - 基线 `docs/audit/transport-baseline-2026-08-14.txt` 自 08-19 后既没收紧也没抬。
   **解读**:方案写完当天的 dump 提交同时做了两件与方案相反的事——绕过 P0 逐批落库,并往五重镜像里
   新增 spaces 与 todo-plan 窗口两个域的手写通道。棘轮按设计报了红,只是没人响应。

**对方案的修订**(已反映到 §1.6 / §2 P0 / §4):P0 改写为"收尾"四件事;P4 已被自然推进一域(logs),
证明路是通的,但**必须先把 transport:gate 修绿再开 P4**,否则棘轮失去意义。
**08-21 第二轮复审(§0b)进一步推翻了 P1/P3 的做法**——见下。

## 0b. 组织原则与目标树(2026-08-21 拍定)

> 起因:用户指出"core 和 runtime 下有同名目录,不知道找哪一个;追到事件提交 / electron api 就追不动"。
> 复核结论:这不是观感问题,是结构事实——**一个领域被横切成三片,其中一片叫 `app`,这个词什么都没说**。
> 用户明确要求**不靠外部文档缓解**,治法必须在代码里。

### 0b.1 诊断数据(08-21 实测,非测试 .ts 行数)

- core / runtime/src / runtime/src/app 三层共 60 个顶层目录名,**38 个在两层以上重复**,17 个三层以上
  (plugins / logging / tools / toolkit / storage / providers / mcp / events / agent-loop / auth / voice /
  media / music / skills / search / todo-plan / ipc)。
- app 层 45 个目录两极分化:**13 个厚**(≥1.1k 行:collab 14.3k、server 10.4k、engine 7.0k、plugins 5.0k、
  session 4.5k、providers 3.7k、toolkit 3.1k、stores 1.9k、logging 1.7k、rpc 1.5k、mcp 1.4k、voice 1.4k、
  channel 1.2k,合计 ~57k 行——**这是后端本体,不是装配胶水**);**32 个薄**(≤800 行,多为 1–6 文件:
  themes 10 行、media 38、prompts 86、acp 107、auth 112、todo-plan 130 …——只因"接线必须住 app"而存在的同名空壳)。
- 最坏案例:**plugins 三处同名且文件名同名**——`core/plugins/{loader,manager,lifecycle,install,llm,sessions,
  status,store,webview,…}.ts` 与 `app/plugins/` 同一批文件名各一份,加 `runtime/plugins` 第三份(15k / 3k / 5k 行);
  collab 的 rt 与 app 共享 `agent-session/mentions/reactions/reply-quote.ts`;引擎是三棵树三个类的继承链
  `CoreStreamEngine → OnethingStreamEngine → StreamEngine`。路径和文件名都不携带角色,所以"不知道找哪一个"。
- 支撑 app 树存在的规则("只有 app 可 import `@shared/ipc`")只覆盖 138/359 文件;215 个 app 文件根本不碰
  `@shared`,住在 app 只是树的规定不是依赖;runtime 产品层碰 `@shared` 的只有 8 个文件。
- 两个追踪断点:**A** 命令总线——(08-21 开工时纠正:字面量订阅点是存在的,
  `core/engine/headless-stream-engine.ts:201` `eventBus.onAnySession('command:send-message', …)`,
  grep 落得到;真正的摩擦是之后的 **四类三树 override 链**:`HeadlessStreamEngine.handleSendMessageCommand`(抽象)
  → `CoreStreamEngine.handleSendMessageCommand` → `handleSendMessage` → `runtime/stream-engine.ts OnethingStreamEngine`
  → `app/engine/stream-engine.ts StreamEngine.handleSendMessage`(override + super),每一跳换一棵树——
  这是 I1/I2 的问题,归 P3'd 引擎归位,**不是派发表问题**,原 P0.5 第 1 项撤销);
  **B** 旧路 IPC 六跳两次字符串键跨进程(platformApi → platform/electron → preload
  bridge `invoke(IPC_CHANNELS.X)` → `ipcMain.handle(IPC_CHANNELS.X)` → src/ipc 工厂 → 实现),bridge.ts 375 处
  `IPC_CHANNELS.`、main/ipc 64 个 handle;router 域(12 个)是 3 跳且类型贯通,追起来明显顺。

### 0b.2 组织原则:包按环境/依赖等级,包内按领域,文件名带角色

硬约束决定第一条轴:同一领域的代码要跑在不同环境(core 零依赖、被 renderer 复用;runtime Electron-free、
server/CLI 也跑;backend 可碰 `@shared/ipc`;apps 才能碰 electron),"能不能 import electron"靠包边界 +
checker 强制,做不到按领域切 → **最外层只能按环境切**。读代码的人找的是领域 → **包内必须按领域,一个领域一个家**。
"这个文件是契约/实现/接线"这条信息现在靠"住哪棵树"表达(所以才三棵同名树)→ 改为**靠文件名表达**。

目标树:

```
packages/
  core/        内核,零依赖。目录 = 领域。契约 + 与产品无关的机制
               engine/ session/ permission/ toolkit/ plugins/ events/ logging/ agent-loop/ …
  runtime/     产品,Electron-free。目录 = 领域,每个领域唯一的家
               plugins/ collab/ providers/ toolkit/ sessions/ prompts/ skills/ themes/ voice/ music/ …
               领域内: loader.ts(实现) / loader.wiring.ts(接线,唯一允许 @shared/ipc 的文件形态)
  backend/     后端脊柱——只放没有领域孪生的东西
               backend.ts(装配配方) engine/ server/(HTTP+SSE) rpc/domains/ stores/ events/ channel/ headless/
  shared/      跨进程契约:ipc/(router 定义) events/(事件词汇) defaults/ types/
  renderer/    UI,按 UI 自己的逻辑:components/ stores/ composables/ platform/
  gateway/     独立产品
apps/
  electron/  server/  web/     薄壳:窗口 / preload / 进程 shell
```

依赖单向:`core ← runtime ← backend ← apps`;`shared` 是类型叶子;`renderer` 只认 `shared` + `platform`。

### 0b.3 四条不变量(全部由测试 / checker 守,不靠文字)

| # | 不变量 | 守法 |
| --- | --- | --- |
| I1 | **一个领域一个家**:领域目录名在 `core` 之外只出现一次;`core/<d>` 是契约,`runtime/<d>` 是全部实现 | `architecture-boundaries.test.ts` 新断言:枚举 runtime/backend 顶层目录名,交集为空 |
| I2 | **相对路径不得跨包重复**:`core/plugins/loader.ts` 与 `runtime/plugins/loader.ts` 不得并存(`index.ts`/`types.ts` 除外);要么合并,要么名字带角色 | 同上,新断言 |
| I3 | **角色在文件名**:`*.wiring.ts` 才能 import `@shared/ipc`;非 wiring 文件不得 import wiring 文件 | `checkRuntimeHostBoundary` 从 `startsWith(appRoot)` 改为文件名模式 |
| I4 | **间接层可被字面量 grep / IDE 穿透**:命令总线字面量订阅点已有(`headless-stream-engine.ts`),其后的引擎 override 链由 I1/I2 归位;IPC 只剩 router 三件套(`shared/ipc/<d>.ts` + `backend/rpc/domains/<d>.ts` + `rpc.<d>`,同名);alias 由真 workspace 解析 | `transport:gate` 改硬红;alias 表删除;引擎链归 P3'd |

读代码的固定路线(由上面四条保证走得通):自顶向下 `apps/electron → backend/backend.ts → backend/engine →
runtime/<d> → core/<d>`,每步是 import;从 UI 追一个动作 `renderer 组件 → platform/rpc.<d>.m() → shared/ipc/<d>.ts
→ backend/rpc/domains/<d>.ts → runtime/<d>`,三跳一个名字;从命令追 `grep 'command:x' → 派发表 → handleX`。

**不按什么组织**:不按线/期(S/L/U 是工作组织,只出现在提交和文档里);runtime 根下不设技术类型目录
(`utils/ types/ stores/`;renderer 内部可以);不按"谁先写的"(`app` 本质是"从主进程迁过来的",是历史不是结构)。

### 0b.4 对原分期的改动

- **P1 改为 P1' workspace 化**:不做"正则塌缩",做真 workspace 包,241 条 alias 表整张删除;
- **新增 P0.5**:断点 A 派发表 + transport 硬门(小,先做);
- **P3 改为 P3' 归位**:不再是"原样搬 595 文件",而是 app → `backend` 并瘦身、32 薄壳折回领域、厚孪生合并、
  三条新断言落地。估 3–5 天,plugins 三合一单独一批;
- **P4a 前移**到 P1' 之前:它治的是"读",是用户每天撞的墙。

## 0. 结论速览

- **最大的债不是"一包两层"**——拆包被证实零纠缠,是 1–2 天的机械活。
- **最大的债是传输面五重镜像**:一个传统 IPC 域最多被描述在 5 处(shared 类型 → src/ipc 工厂 →
  main/ipc 适配 → preload bridge 手写枚举 → web.ts 手写 HTTP 镜像)。终点早已钦定
  (router/RPC,`apps/electron/src/main/ipc/rpc.ts` 头注释自称"@main 最后一个 handler 文件"),
  但只迁了 ~11 域,剩 ~30 域。
- ~~推荐顺序:P0 卫生落库 → P1 alias 塌缩 → P2 boundary 清偿 → P3 拆包 → P4 传输面迁移~~
  **08-21 改拍(§0b.4 / §3)**:P0 收尾 → P0.5 派发表+硬门 → P4a 六裸写域 → P1' workspace 化 →
  P2 boundary 清偿 → P3' 归位(app → backend + 领域折回)→ P4b/c。组织原则见 §0b。

## 1. 摸底事实(2026-08-19,均已验证)

### 1.1 传输面(最大债)

- 传统域全链路 5 处描述:`packages/shared/ipc/*`(契约,~342 通道常量)→
  `apps/electron/src/ipc/*`(纯函数 DI 工厂,31 文件 ~2550 行)→
  `apps/electron/src/main/ipc/*`(适配,38 文件 ~6543 行)→
  `apps/electron/src/preload/bridge.ts`(1905 行,~353 个手写 invoke 点)→
  `packages/renderer/platform/web.ts`(1801 行 HTTP 镜像,后端孪生 `apps/server/src/http.ts`)。
- router/RPC 模型已存在且好用:`defineRouter`(`packages/core/ipc/index.ts`)自动派生通道名,
  单一 `RPC_INVOKE` 分发(`main/ipc/rpc.ts`),preload wrapper 自动生成
  (`preload/create-api.ts` `createRouterAPI`),web 侧同构(`renderer/platform/router-client.ts`)。
  已迁 ~11 域(agents/goal/markdown/prompts/providers/permission-grants/session-events/todo-plan/usage/models/channel-identity)。
- 未迁 ~30 域,其中 **6 个裸写域连工厂都没有**:collab(15 handle)、evals(14)+evals-workbench(11)、
  practice(10)、notify(2)、deeplink(2);music 混搭(8 裸 + 工厂)。
- `todo-plan` 骑墙:数据面已走 router,窗口面还在旧路(`renderer/platform/electron.ts` 有注释)。
- src/ipc ↔ main/ipc 的工厂/适配分层**本身是正当的**(可独立测试的缝),不互相合并;
  它们的消亡路径是被 router 迁移整体吸收。

### 1.2 一包两层(拆包,零纠缠)

- 反向边 0(runtime 产品层无一处 import app 层,含相对路径形式);跨包相对路径穿墙全仓 0 处。
- app→runtime 390 条 import 已是包说明符形式,拆包后零改动;仅 16 条相对逃逸边(7 文件,
  目标 `plugins/themes/auth/toolkit` 全部已在 exports/alias 中)。
- 宿主 163 个 `@onething/app` subpath import 一字不用改(保住包名即可)。
- 配置面:`onething.aliases.ts` 1 处 + `tsconfig.json` 1 处;四份 vite/vitest 配置全部继承
  aliases.ts,零直接引用。
- boundary checker:层边界核心只有 `checkRuntimeHostBoundary()` 一个函数的 `startsWith(appRoot)`
  分叉,拆包后退化为两包各跑一套;其余 ~240 处 src/app 路径字符串为功能性断言,机械替换。
- 唯一风险:新 `packages/app/package.json` 的 exports 需覆盖 163 subpath(照抄 alias 表)。

### 1.3 alias 手工表

- 110 条里**仅 1 条不规则映射**:`@onething/runtime/gateway` → `src/gateway-runtime.ts`;
  其余全部同形,可塌缩为每族一条正则(sessions 家族 L265 已示范正则写法)。
- 事故根因:vite 显式表与 tsconfig 通配(`@onething/runtime/*` → `src/*`)语义不一致,
  typecheck 全放行、漏登记只在构建/运行时炸;boundary-check 只验"表内条目 target 存在",
  不反查 import 是否登记。
- 各包 package.json 的 exports 已经很规整(runtime 73 键、32 通配,已正确处理 gateway/barrel),
  可作进阶方案的唯一事实源。
- 附带发现:登记动作兼任"边界门禁"副作用(aliases.ts L260-262 注释),塌缩后此职责需显式移交。

### 1.4 boundary 13 红(全部存活)

2026-08-19 亲跑 `bun run boundary`,13 条与基线逐条一致,无一自愈(check 校验委派符号,
不校验旧路径,"文件搬迁自愈"推断已被证伪)。分组:

| 组 | 内容 | 改法 |
| --- | --- | --- |
| A | gateway 2 处越权 import(`permission-coordinator.ts:6`、`bridge.ts:10`) | 从 `gateway-runtime` 入口再导出,各改一行 |
| B | 宿主未委派 4 条(window menu、main-window binding、entrypoint、core-system 裸 import) | 逐条委派/下沉,或按符号名核对 check 是否过期后重录 |
| C | runtime 未收口 5 条(sessions 校验、settings、plugins、SQLite×2) | 下沉;其中 sessions/plugins 两条会被 P4 迁移自然吸收,只做最小修 |
| D | 测试注释/path.join 假阳性 2 条 | 改措辞或加 checker 豁免 |

清零后 `scripts/boundary-gate.mjs` 可删除整套基线 diff 机制(~40 行)退化为"任一 failed 即 exit 1",
删 `docs/audit/boundary-baseline-2026-08-07.txt`。

### 1.5 事件双份 & UI 存量(小项)

- `stream-chunks`:shared 是纯类型 re-export,无债。
- `session-events`:core/shared 分裂是"core 禁 @shared"边界的必然产物,**不可消**;
  缺口是 core ~25 个内联事件字面量与 shared 50 项注册表之间无 parity 测试(小时级可补)。
- UI 76 条 surface-literal:散在 42 文件,前 5 文件(EvalsWorkbench 8 / RoundTimeline 5 /
  ImagePreviewWindow 4 / IncidentTranscript 4 / RoomSurface 4)占 1/3;evals 三件套最肥。
  5 条语义保留(title-attr×2 / transition×1 / focus-bare×2)维持豁免。
  **不属结构债,单独排期,本方案不含**(待拍板确认)。

### 1.6 卫生面(08-21 更新)

- 已落库(随 `2603c665`):28 张根目录截图移入
  `TMP/root-screenshots-2026-08/`(未跟踪、被 ignore);`.gitignore` 改为根目录图片一律忽略
  (删 5 条逐个点名);两份 5 月过期会话记录(CHANGES_DETAILED/CHANGES_LOG)已删;
  hermes 研究文档已在 `docs/reference/`。
- **package-lock.json 判定:保留**。package.json scripts 全走 npm、
  `npm rebuild better-sqlite3` 是 test/postinstall 硬依赖、electron-builder 的
  node-module-collector 按锁文件探测包管理器——正是 07-29"bun collector 打包缺依赖"的变通,
  08-14 仍有真实提交维护。治理动作只有一条:在 CLAUDE.md 记一行"npm 是打包/rebuild 权威,
  bun 用于日常 dev/test 执行",消灭"看起来像误跑残留"的歧义。
- todo.md / todo2.md(2026-07 任务清单,批次已执行完):仍 tracked,去向待拍板(归档进 `plans/` 或删)。
- 在途批次:~~dirty tree 47 项~~ → 08-21 仅剩 **12 项**,全是 compact 一批
  (`packages/core/engine` ×4 + 未跟踪 `content/compact-merge.md`、runtime ×3、shared ×2、renderer ×1、
  `docs/design/context-compact-capability-2026-08.md`),单批可直接提交。
  原 47 项已随 `2603c665` 一次性落库(见 §0a)。
- **transport:gate 红**(见 §0a 第 3 条):7 条新手写通道(spaces ×4、todo-plan 窗口 ×3)+ 对应的
  bridge.ts / web.ts 手写段,已在历史里;基线未动。

## 2. 分期计划

### P0 收尾(08-21 改写;原"卫生落库"的主体已随 `2603c665` 落库,半天以内)

1. ~~diff 归属分析 47 项~~ → 提交 compact 一批(12 文件,单 commit)。
2. todo.md / todo2.md 按拍板结果处置;CLAUDE.md 补一行双锁文件说明("npm 是打包/rebuild 权威,
   bun 用于日常 dev/test 执行")。
3. **修绿 `transport:gate`**(08-21 开工时按现场改判):
   - spaces 不是"4 条新通道"而是**整域裸写**(13 invoke + 1 广播,`shared/ipc/spaces.ts` 只有类型没有 router,
     web 端是 soft-fail 桩)→ **整域迁 router**,兼作 P4a 第一个模板(`spacesRouter` 13 方法;
     `spaces:changed` 广播是宿主推送,router 尚无推送面,暂留该一条常量)。
   - todo-plan 窗口 3 条(minimize / zoom / drag)操作 BrowserWindow,`app/rpc/domains/todo-plan.ts` 头注释
     早有裁定"宿主原生,永远不该进 router",web 端实现是页内事件(`dispatchTodoPlanWindowAction`)——
     它们属于 P4 终态"`main/ipc/` 仅剩 rpc.ts 与少数真窗口系 handler"的**残留集**,不是迁移对象。
     **新拍板 #10**:窗口系通道需要自己的典型形态(一个宿主壳 `shell`/`window` 路由 + sender 上下文),
     在 P4 终态前统一处理;transport 门应区分"域通道"(禁增)与"窗口系通道"(白名单)。
   - 迁完 spaces 重测;若 bridge/web 行数仍高于 08-14 基线(`2603c665` 还带入了 import 块与注释重排),
     **允许按项重写基线,但基线文件里必须逐项注明差额来源**(todo-plan 窗口 3 条 + 重排行数),
     之后由 P0.5 改硬红。http.ts +39 是 server 请求日志,同样注明。
   - **08-21 落地记录**:spaces 整域迁完(`shared/ipc/spaces.ts` `spacesRouter` 13 方法 +
     `app/rpc/domains/spaces.ts` + `renderer/platform/spaces-client.ts`;删 `apps/electron/src/ipc/spaces*.ts`、
     bridge 13 条、web 13 条桩 + `softJson`、channels 13 常量;`main/ipc/spaces.ts` 只剩广播;server 零改动)。
     重测:channels 337→329、web 1718→1707 **跌破基线**;bridge 1737→1855 经逐行归类 = import/type 块 +51、
     注释 +20、包装体 +63、**通道引用净 −9**(净新增手写通道引用只有 `SPACES_CHANGED` 广播 + todo-plan 窗口 3 条);
     http +39 = 日志;channels.ts +6 = 3 窗口常量 + 广播 + 注释。基线已按项注明重写(见基线文件头),门绿。
     **拍板 #11(行为变化,按判例处理但须知会)**:web 端原来的 13 条 `/api/spaces*` 桩打的是 server 上不存在的路由,
     必然失败 → 降级"只有默认空间";迁 router 后 web 经 `POST /api/rpc` **真的拿到空间列表与 per-space provider 设置**。
     与 agents / models 迁移时"server 收敛到同一份 store"同一判例,桌面行为零变化;若要保持 web 降级需人为关闭,
     默认不做。另:`getProviderSettings`/`setProviderSettings` 两处 `as` 强转是把 runtime(`Record<string, unknown>`,
     存储层故意不透明)与契约(`Record<string, ProviderConfig>`)之间原本藏在 controller `unknown` 里的缝写到明面,
     根治要两侧共用一份形状——另一个决定,未自行裁定。
4. 验收门:`git status` 干净;`bun run test` + `boundary:gate` + `ui:gate` + `session:gate` +
   `log:gate` + **`transport:gate`** 全绿。

### P0.5 transport 硬门(小;08-21 新增,同日收窄)

1. ~~`CoreStreamEngine` 显式派发表~~ —— **撤销**(08-21 开工时查实:字面量订阅点已在
   `headless-stream-engine.ts:201`,断点 A 的真相是四类三树的 override 链,见 §0b.1;归 P3'd)。
2. ~~`transport:gate` 改硬红~~ —— 查实它**本来就是增即红**(`compare()` 上升即 regression → exit 1,
   `--self-test` 用例 2 就是这条)。真正的缺口在别处:**CI(`.github/workflows/test.yml`)只跑
   `bun run test`,boundary / ui / log / session / transport 五道门一道都不在 CI 里**——门红两天没人理,
   是因为它只在有人手动跑时才说话。
3. **把五道门进 CI**:test.yml 加一个 `gates` job(`boundary:gate` / `ui:gate` / `log:gate` / `session:gate` /
   `transport:gate`,有 `sessions:verify:gate` 也加),任一红则 PR 红。
4. transport 基线按 P0.3 的规矩逐项注明差额来源后重写一次,此后不再手改,只由 `--write-baseline` 在下降时收紧。
5. 验收门:五道门本地全绿;CI 配置里能看到五条 run;人为加一条 `IPC_CHANNELS` 常量(不提交)本地门能红。
6. **08-21 落地记录**:`test.yml` 新增 `gates` job(boundary / transport / ui / log / session 五道;
   `sessions:verify:gate` 依赖本机 store 不进 CI);transport 基线按项注明重写一次后门绿
   (`IPC_CHANNELS 329,四壳 6131 行`);"升即红"由脚本 `--self-test` 用例 2 保证,不另验。

### P1' workspace 化(原"alias 塌缩",1 天;08-21 改拍)

1. core / runtime / backend(P3' 之前仍叫 app,先以 `packages/onething-runtime` 内子路径形式)/ shared /
   gateway / renderer 成为**真 workspace 包**:各自 `package.json` 的 `exports` 生效
   (runtime 73 键 + 32 通配已很规整,作为唯一事实源),根 `package.json` 声明 workspaces。
2. `onething.aliases.ts` **整张删除**(241 条);四份 vite/vitest 配置与 tsconfig `paths` 不再手工登记,
   统一走 node 解析 → IDE go-to-definition / find-references、vitest、vite、tsc 用同一套解析(I4)。
3. 保留的唯一显式映射:`@onething/runtime/gateway` → `src/gateway-runtime.ts`(写进 exports)。
4. 验收门:`build:check` + `web:build` + `server:build` + `bun run test` 全绿;**`build:mac` 冒烟**
   (electron-builder 对 workspace 包的收集是 07-29 旧伤所在;打包过不去 → 回退到原"正则塌缩"方案,
   本期目标降级为删除 alias 表中的冗余条目)。
5. 门禁移交:boundary-check 的"登记即门禁"副作用改为"枚举全仓 `@onething/*` import → 逐条实际解析"。
6. **08-21 可行性调研结论**(只读,源码级证据):
   - **不会卡在 electron-builder**。三证:`externalizeDepsPlugin` 读的是根 `package.json.dependencies`
     (`electron-vite/dist/chunks/lib-*.js` `loadPackageData()` 无参 = 仓库根),根里没有 `@onething/*`,
     所以它们今天就是被 bundle 进 `out/main/index.js` 的,加 `workspaces` 不改变这一点;app-builder-lib 的
     `npmNodeModulesCollector.isProdDependency` 按根 `_dependencies` 过滤,`@onething/*` 不进 production graph
     不进 asar;`scripts/run-electron-builder.mjs` preflight 闭包只 walk 根 deps,包数不变。
   - **两条红线**:① 根 `package.json.dependencies` 里**不许出现** `@onething/*`(一出现就被 externalize,
     而 exports 指向 `.ts` 源,asar 里没有可执行文件 → 运行时 `Cannot find module`);② workspaces **不许写
     `apps/*`** glob(会拖进 `apps/mobile` 的 expo + react-native),逐个列包。
   - **唯一须实测的风险**:vite SSR(`apps/server` 与 electron main 段)对 symlink 包的 linked-package 判定;
     兜底一行 `ssr.noExternal: [/^@onething\//]`。脚本级验收:`rg -c "@onething/" dist/server/main.js` 与
     `rg -c "@onething" out/main/index.js` 必须为 0;preflight 包数与今天一致。
   - **exports 不是要新写,是要救活**:core 24 / runtime 74(32 通配)/ gateway 5 / electron-host 73 条已在,
     与 alias 表漂移 38 条(core 7 / runtime 19 / electron-host 12)——两年没人同步,正是"exports 是死的"的量化。
     `moduleResolution` 三份 tsconfig 全是 `bundler`,`.js` 后缀(`@onething/app/**` 142 条)用
     `"./app/*.js": "./src/app/*.ts"` 同位模式吃下,**零 import 改写**。真正的收益不是删 241 行,是消灭一类 bug:
     前缀匹配的"叶子必须排在 barrel 之上"顺序陷阱在精确匹配的 exports 下不存在,缺条目从"只在 build/run 炸"
     变成"typecheck 就红"。
   - **不动的**:`@shared`(不是合法 npm scope 名,542 处 import;只是 4 条单行声明,不是债)、`@`/`@main`/`@preload`;
     顺手删 `@renderer` 死别名(0 处 import)。**`@onething/electron-host` 不包化**:它是 `apps/electron/src/<d>/<f>.ts`
     的内部路径别名(83 条 per-file),tsconfig 已是一条通配,vite 侧 2 条(正则 + `window` 走 index 的例外)即可,
     收进 `electron.vite.config.ts` 局部 alias,与 workspace 化完全解耦。
   - **boundary checker:退役不移植**。74 个函数 / 158 条 "missing X alias" 断言 / 149 处文件引用,本质是
     "exports 死了"的代偿;exports 活过来后缺条目 typecheck 即红,门禁职能被语言接管。删 `checkAliasTargetsExist()`
     与基线 ok 行。
   - **分期**:P1'-0 electron-host 83→2(0.5d,独立验证)→ P1'-1 最小切片 core + gateway 变真包(0.5d;
     根 workspaces 只列这两个、core exports 补 7 条、删 alias 32 行 + tsconfig 8 条、`npm install` 生成
     `node_modules/@onething/{core,gateway}` symlink、改 6 条 checker 断言;验收见上)→ P1'-2 runtime 变真包
     (124 条 alias → ~40 条 exports,1–1.5d)→ P1'-3 checker 退役 + 基线(0.5–1d)。合计 3–4d。
   - **P1'-0 落地记录(08-21)**:`onething.aliases.ts` 304→242 行,electron-host 83 条 → 独立导出
     `electronHostAliases()` 2 条(`window` barrel **锚定正则**在上——字符串 find 是前缀匹配,会把
     `…/window/types` 吞成 `…/window/index.ts/types`;`apps/electron/src/$1.ts` catch-all 在下),只有
     `electron.vite.config.ts`(三段)与 `vitest.config.ts` spread;`headless-boundary-check.ts` −637 行
     (60 个 `checkElectronHostOwns*` 里 133 条"missing … alias"登记断言 + 238 条空声明),ok 行数 192 与基线一致、
     13 红无变化无 healed;`out/main|preload/index.js` 零 `@onething/electron-host` 残留,`build`/`server:build`/
     `web:build` 全绿。CLAUDE.md Alias Registry 段同步。遗留:`sessions-delete-cascade.test.ts` 全量跑偶发
     1s 超时(fs 级联时序 flake,单跑 3/3 过)——与本线无关,记一笔。
   - **P1'-1 落地记录(08-21)**:`packages/core` + `packages/gateway` 变**真 workspace 包**。根
     `package.json` 加 `"workspaces": ["packages/core","packages/gateway"]`(逐个列包,不写 glob);
     根 `dependencies` 一个 `@onething/*` 都没加(红线①)。`packages/core/package.json` exports 24 → 31,
     补齐与 alias 表漂移的 7 条:`./engine/agent-loop-turn`、`./interaction`、`./toolkit`、
     `./plugins/{deep-link,notify-sound,request-channel,sessions}`;gateway 5 条 exports 与 alias 0 缺口,
     只把 `dependencies["@onething/core"]` 从 `file:../core` 改成 `"*"`(npm 不认 `workspace:` 协议)。
     `onething.aliases.ts` 242 → 194 行(core 27 + gateway 5 条连注释块整片删除),`tsconfig.json` 删 6 条
     paths、`tsconfig.web.json` 删 2 条;`headless-boundary-check.ts` −55 行(11 条查 aliases.ts/tsconfig
     "登记"的断言:gateway-runtime 3、gateway/config 3、web tsconfig `@onething/core/*` 1、core/json 2、
     core/ipc 2 —— 查 `package.json` exports 的那几条**保留**,那才是新的事实源;外加随之变死的 11 条
     变量声明,eslint 该文件告警 25 → 23)。
     `.js` 后缀零命中(`rg "@onething/(core|gateway)/[^']*\.js"` = 0),core 不需要 `"./*.js"` 通配。
   - **锁文件(Fable 复核纠正)**:`package-lock.json` 因根 package.json 早已漂移(`npm ci` 在 HEAD 就 ERESOLVE,
     `--legacy-peer-deps` 会 removed 120),执行者按 npm 11.9 lockfileVersion 3 的 workspace 记录格式手工补写
     4 条(+23 行 0 删),`require.resolve` 八子路径全通;**但 `bun.lock` 不能不动**——执行者判断"bun 会自愈",
     Fable 在临时目录复现 `bun install --frozen-lockfile` → **"lockfile had changes, but lockfile is frozen"**,
     而 CI 三条 workflow 都以 `bun install`(test.yml 带 `--frozen-lockfile`)起步,不改即 CI 红。
     用 `bun install --lockfile-only` 在临时目录生成后拷回:只多 4 条 workspace 记录(+15 行),frozen 通过。
     **遗留单独立项**:根 package.json ↔ package-lock.json 的既有漂移(与结构债无关,`npm ci` 已红)。
   - **零 import 改写、零 `noExternal` 兜底**:`dist/server/main.js` 的 `@onething/` = **0**,
     `out/main/index.js` / `out/preload/index.js` 的 `@onething` = **0 / 0** —— vite SSR 与 electron main
     都把 symlink 包当 linked package 走源码,那条"唯一须实测的风险"实测不存在。
   - **打包判据**:`run-electron-builder.mjs --dir` 改动前后 preflight 都是 **286 个包(采集器 = npm)**,
     asar 里 `node_modules/@onething` = 0 条。electron-builder 26.4 新打一行
     `detected workspace root for project`,但闭包不变 —— 调研结论(`isProdDependency` 按根 `_dependencies`
     过滤)得到实证。
   - **门禁**:`boundary` ok **192**、failed **13**,与改动前逐字一致(删的是 check 内部的断言、不是整条
     check,所以 ok 行数没变);`boundary:gate` 绿;`transport:gate` 无上升。
   - **锁文件的坑**:本仓 `package.json` 与 `package-lock.json` 早已漂移 —— 在**未改动**的树上
     `npm install --dry-run` 直接 ERESOLVE(tiptap peer 冲突),`--legacy-peer-deps` 会 removed 120、
     `--force` 会 removed 30 / changed 39,全是与 workspace 化无关的既有漂移。为了不把这坨 churn 混进本
     切片,workspace 的四条 lock 记录(`node_modules/@onething/{core,gateway}` link + `packages/{core,
     gateway}` + 根 entry 的 `workspaces`)按 npm 11.9 的 lockfileVersion 3 格式逐条补写(格式先在 /tmp
     用一个最小 offline workspace 跑真 `npm install` 取到,不是手编),symlink 手工建;`package-lock.json`
     净 +23 行 0 删除。`bun.lock` 未变(bun 从 `package.json` 直接认出
     `@onething/core@workspace:packages/core`,会自愈)。**遗留:根 package.json ↔ package-lock.json 的
     既有漂移应单独立一条治,别夹带在结构债线里 —— `npm ci --dry-run` 在**未改动的树上**就已经
     ERESOLVE 红(已 stash 实证),不是本切片弄红的。**
   - 遗留同 P1'-0:`sessions-delete-cascade.test.ts` 全量跑偶发失败(单跑 3/3 过),与本线无关。
   - **P1'-2 落地记录(08-21)**:`packages/onething-runtime` 变**真 workspace 包**。根 `package.json`
     的 `workspaces` 追加 `"packages/onething-runtime"`(逐个列包,红线②);根 `dependencies` 依旧一个
     `@onething/*` 都没有(红线①)。`packages/onething-runtime/package.json` exports **74 → 92**:补
     22 条(`./collab` `./collab/actors` `./collab/*`、`./spaces` `./spaces/*`、`./toolkit` `./toolkit/*`、
     `./tasks` `./tasks/*`、`./toc` `./toc/*`、`./scratchpad` `./scratchpad/*`、`./logging` `./logging/*`、
     `./agent-loop/*`、`./goals/*`、`./practice/*`、`./variables/providers`、`./evals/trace-store`),删
     2 条死条目(`./memory` / `./memory/*` —— soul-memory 2026-08-06 退役后目录早就不在);
     `dependencies["@onething/core"]` `file:../core` → `"*"`。**`./evals` 那颗 barrel 仍然不开**:
     alias 表里当初的注释说得对(整套评估台会被拖进每个宿主的包),只开 `./evals/trace-store` 这一片叶子。
     判据是脚本枚举全仓 226 条 `@onething/{runtime,app}` 字面量 import(含 `vi.mock`)逐条按 node
     exports 语义解析 —— **0 条落空**。
   - **`@onething/app` 不能进 exports(调研前提的一处错)**:任务书假设它是 runtime 的子族、
     `"./app/*.js": "./src/app/*.ts"` 能吃下那 142 处带 `.js` 后缀的 import。实测 `require.resolve` 直接
     打脸:`@onething/app` 是一个**包名**,node 解析 `@onething/app/x` 只看
     `node_modules/@onething/app/package.json`,`@onething/runtime` 的 exports 写多少 `"./app/*"` 都够不着。
     出路只有两条:(a) 往 `packages/onething-runtime/src/app/` 里塞一份 package.json,把 src 的一个子目录
     变成嵌套包;(b) 等 P3' 把 `src/app` 整体搬到 `packages/backend`,那时它自然就是真包。(a) 是 P3' 上来
     就要删的临时物,且会在 vite SSR 的 linked-package 判定上再开一个未测风险面,**所以 P1'-2 不做** ——
     `onething.aliases.ts` 保留这**唯一一条**前缀 alias(`@onething/app` → `src/app`)+ tsconfig 两条
     paths,理由写进文件头。`@onething/runtime/app` 的两条 exports 保持原样(无人使用,不新增)。
   - **表与配置**:`onething.aliases.ts` **202 → 53 行**,`find:` **129 → 4 条**(app 1 + electron-host 2
     + 接口声明里的 1 处 `find` 字段)—— runtime 族 124 条 + `sessions` 那条正则 + `@onething/app` 之外
     全删。`tsconfig.json` 删 `@onething/runtime` / `@onething/runtime/*` / `@onething/app/*` 三条、改回
     显式两条 `@onething/app` + `@onething/app/*`(bare specifier 之前没有 paths,靠 exports 兜不住,补上);
     `tsconfig.web.json` 删 2 条(renderer 不吃 `@onething/app`)。四份配置里 `apps/web/vite.config.ts`
     **整条 import 删掉**(renderer 一处 `@onething/app` 都不 import),`apps/server` / `vitest` /
     `electron.vite`(只 main + preload 两段,renderer 段不再 spread)保留。
   - **checker**:`checkRuntimeSubpathAliasesCoverSourceImports()` **整函数删**(36 行 + 调用 1 行 ——
     它的职能被 exports + typecheck 接管);7 个 `checkRuntimeOwns*` 里的 **14 条**"missing … alias"
     登记断言删(voice-providers / voice-text / search-protocol / headless / ripgrep / sandbox-runtime /
     edit-engine,各 vite + vitest 两条),连带 28 条随之变死的 `viteConfig`/`vitestConfig`/`viteContent`/
     `vitestContent` 声明 —— 共 **−107 行**。查 `package.json` exports 的断言(如 `"./voice/*"`)**保留**,
     那才是新的事实源;`checkAliasTargetsExist()` **保留**(表里还剩 3 条 resolve() 条目,`count===0`
     的"could not be parsed"分支不会触发)。基线文件未动。
   - **验收(原始数字)**:`typecheck` 绿;`bun run test` **1149 文件 / 11106 通过 / 8 skipped,0 失败**
     (48.9s);`web:build` 绿;`server:build` 绿且 `rg -c "@onething/" dist/server/main.js` = **0**;
     `build` 绿且 `out/main/index.js` = **0**、`out/preload/index.js` = **0** —— **不需要
     `ssr.noExternal` 兜底**(与 P1'-1 同结论);`run-electron-builder.mjs --dir` preflight 改前改后都是
     **286 个包(采集器 = npm)**,asar 里 `@onething` = **0** 条。门禁:`boundary` 改前 ok **196**/failed
     **9** → 改后 ok **195**/failed **9**,**healed 0、new 0**,ok −1 正是被删掉的那一条 check;
     `boundary:gate` / `transport:gate`(IPC_CHANNELS 304 / 四壳 5929 行)/ `ui:gate`(81)/ `log:gate`(4)
     / `session:gate`(0)全绿。`ls node_modules/@onething/` = core / gateway / runtime 三条 symlink,
     `packages/onething-runtime/node_modules` **未被创建**。
   - **锁文件**:同 P1'-1 的手法(`npm install` 依旧不能跑)——`package-lock.json` 手工补 3 处
     (根 entry 的 `workspaces` 加一行、`node_modules/@onething/runtime` 的 `link: true`、
     `packages/onething-runtime` 节点连 7 条 dependencies),净 **+18 行 0 删除**;
     `node_modules/@onething/runtime → ../../packages/onething-runtime` symlink 手工建。
     **`bun.lock` 这次必须动**:在临时目录(根 package.json + bun.lock + 三个子包 package.json)跑
     `bun install --lockfile-only`,只多 2 处(`packages/onething-runtime` 节点 + workspace 解析行,
     **+15 行**),拷回后在同一临时目录 `bun install --frozen-lockfile --dry-run` 复验 —— **不再报
     "lockfile had changes"**。
   - **遗留**:① `@onething/app` 那一条 alias(等 P3');② 根 package.json ↔ package-lock.json 的既有漂移
     (P1'-1 已立,未动);③ 本切片执行期间工作树里有另一条 P2 线的在途改动(`apps/electron/src/{app,
     window,main/ipc}`、`packages/gateway/src`、runtime 的 `{plugins,sessions}/ipc-operations.ts`),
     boundary 的 failed 因此从基线的 13 掉到 9 —— **与本切片无关**,前后对比已用 `git stash` 隔离实证。

### P2 boundary 清偿 + parity 测试(2–3 天)

1. A 组两处一行修;D 组假阳性豁免;B/C 组逐条核对 check 语义后委派/下沉
   (C 组 sessions/plugins 只做最小修,大改留给 P4 吸收)。
2. 清零后简化 `boundary-gate.mjs`(删基线 diff 机制),删除基线文件;CLAUDE.md 同步。
3. 补 core↔shared session-events 注册表 parity 测试(core 内联字面量 ⊆ shared 注册表)。
4. 验收门:`bun run boundary` 0 failed;gate 退化为零基线模式;全量测试绿。
5. **08-21 A/B/C 落地记录**:13 → 9 failed(gate "4 healed, none new"),4 条以改源修绿、行为逐字不变——
   A 组 gateway 三处改走 `gateway-runtime` 唯一入口(再导出 `Unsubscribe` / slash-commands 四符号三类型 /
   `ConsoleSink`/`LoggerRoot`/`Logger`/`LogLevel`/`LogRecord`);B 组待办窗预热策略收进 `window/index.ts`
   `warmTodoPlanWindowForStartup()`;C 组会话创建请求校验(UUID / 不认领已存在 / kind 只认 room)下沉
   `runtime/sessions/ipc-operations.ts` `describeInvalidOnethingCreateSessionRequestForIpc`,插件"未装配→空命令表"
   降级与生命周期载荷下沉 `runtime/plugins/ipc-operations.ts`。
   **余 9 条全部判定为断言过期 / 假阳性,归 D 组改 checker**(处方):#3 应用菜单逐字字面量拆三段;
   #4/#10 `GET_NETWORK_INTERFACES` / `listOnethingNetworkInterfacesForIpc` 全仓 0 命中(603582d9 删),两符号断言删;
   #5 "runtime/src/app/index.ts 再导出 @onething/electron-host/app/main-process" 与 `checkRuntimeHostBoundary`
   的禁令互斥,删;#6/#7 "via public entrypoints" 15 条命中全是注释/路径串(src/app 本就住在
   packages/onething-runtime/src 下,自指必须豁免),改为只匹配 import/require 说明符;#8 `MAIN_CORE_SYSTEM_DIRS`
   摘掉 `apps/electron/src/main/bridges`(Electron 桥禁 electron 是反的),fs/path 禁令只留真无 IO 目录;
   #12/#13 SQLite 三文件 072e96b4 后不存在、会话存储 07 月已 jsonl,整条删。D 组在 P1'-2 的 checker 改动入库后做,
   同时删基线 diff 机制与基线文件。
6. **08-21 D 组 + P1'-3 落地记录**(HEAD `a34f12fc` 之上;不改任何产品源文件,只改 checker / gate / 基线 / 文档):
   9 条断言过期红逐条改在 `scripts/headless-boundary-check.ts`,**干净 worktree 上 boundary 从 9 failed / 192 ok
   → 0 failed / 203 ok**(9 条转绿;#12/#13 两条 check 整条删,所以 ok 净 +7;全绿时检查器多打一行
   `headless core boundary checks passed` 汇总,+1),checker 10295 → 10285 行。
   - #3 `checkElectronHostOwnsApplicationMenu`:逐字断言 `setupElectronApplicationMenu({ mainWindow, openSettingsWindow })`
     → 三段 `includes`(`setupElectronApplicationMenu(` / `mainWindow,` / `openSettingsWindow`)。真实调用早已是多行
     形态且多传 browser / webPreview 两组回调,断言语义收窄为"调用存在且传了这两个参数"。
   - #4 `checkElectronHostOwnsSettingsIpcHost`:`requiredFacadeSymbols` 摘掉 `IPC_CHANNELS.GET_NETWORK_INTERFACES`
     (603582d9 退役,全仓 0 命中);同函数其余 17 条 host + 8 条 facade 断言原样保留。
   - #10 `checkRuntimeOwnsSettingsSaveOrchestration`:`requiredRuntimeIpcSymbols` 摘掉
     `listOnethingNetworkInterfacesForIpc`(同上),其余三条保留。
   - #5 `checkElectronHostOwnsMainEntry`:删两条 legacy facade 断言(`packages/onething-runtime/src/app/index.ts`
     须再导出 `@onething/electron-host/app/main-process`、且须 ≤5 行)。该文件早已不存在,且断言与
     `checkRuntimeHostBoundary` 的 `APP_ASSEMBLY_FORBIDDEN_PATTERNS`(装配层禁 import electron-host)
     互斥。宿主侧三条真断言(`startOnethingElectronMain` / `./app/main-process.js` /
     `export function startOnethingElectronMain`)与 vite 入口断言保留。
   - #6/#7 `checkMainUsesRuntimePackageImports` / `checkMainUsesCorePackageImports`(顺手 #Gateway 那条同类):
     新增 `matchingImportSpecifierLines()` + `importSpecifiersInCode()`,先剥注释(复用 `codeOnlyLines`)再抠
     `from '…'` / `import('…')` / `import '…'` / `require('…')` 的说明符,**只拿说明符过模式**。15 条命中全是
     注释交叉引用与 `path.join(REPO_ROOT, 'packages/core/plugins')` 这类静态扫描测试的工作对象;`src/app`
     的相对自指天然不含这串字面量,自动豁免。断言语义回到"不许深路径 import,要走包公开入口"。
   - #8 `checkMainCoreSystemAdapters`:一张名单拆两级。`MAIN_CORE_SYSTEM_DIRS`(全套禁令:electron + fs/path +
     better-sqlite3 + MCP/ACP SDK)**最终名单 6 个** —— `app/{agent-loop,engine,events,storage,permission,tools}`;
     新增 `MAIN_FILE_IO_SYSTEM_DIRS`(只禁宿主与原生 SDK,fs/path 放行)**4 个** —— `app/{session,stores,mcp,plugins}`,
     它们本职就是文件 IO(会话事件日志 + blob 仓、会话仓储、MCP OAuth 凭证盘存、插件 loader/tarball/install/webview)。
     `apps/electron/src/main/bridges` **整个摘除**:那是 Electron 宿主自己的桥,禁它 import electron 是反的。
     `MAIN_ADAPTER_ALLOWLIST`(`app/mcp/client.ts` 放行 MCP SDK)保留。
   - #12/#13 `checkRuntimeOwnsSqliteSessionRepository` / `checkRuntimeOwnsSessionSqliteFailoverPolicy` **整条删除**
     (含 `MAIN_SQLITE_REPOSITORY_FORBIDDEN_PATTERNS` 24 条与 `MAIN_SESSIONS_SQLITE_FAILOVER_FORBIDDEN_PATTERNS`
     6 条两张死表、两处调用),原址留一段注释说明为什么删。
   - **P1'-3**:复核后"missing … alias"登记断言**余量为 0** —— 133 条已随 P1'-0 删、14 条已随 P1'-2 删,本期无可删。
     `checkAliasTargetsExist()` **保留**:alias 表虽只剩 3 条,但 `@onething/electron-host` 不是包而是路径别名,
     tsconfig 通配符对任何子路径都放行,死目标只在 build/run 炸、typecheck 永远不报,这条 check 是它唯一的门。
     顺手把 P1'-2 删断言时遗留在 `checkNoRawControlCharacters` 头上的孤儿注释块搬回它本主并按现状重写。
     `package.json` 的 `exports` 断言按拍板保留。
   - **基线机制退役**:`scripts/boundary-gate.mjs` 87 → 76 行,删掉整套基线读取 + fresh/healed diff,退化为
     "任一 `[boundary] failed:` 行即 exit 1";保留两道防呆——缺 `[boundary] complete:` 标记(检查器半程崩)
     与一条 `[boundary] ok:` 都解析不出(输出格式变了)都判红。删除 `docs/audit/boundary-baseline-2026-08-07.txt`
     (237 行)。`package.json` 的两条 script 无基线相关参数,不需改。CLAUDE.md Guardrails 段与命令表同步为"零基线硬门"。
     `.github/workflows/test.yml` 的 gates job 仍跑 `bun run boundary:gate`,无需改。
   - **验收**(在 `git worktree` 干净副本 + 重接 `node_modules/@onething/*` symlink 到副本自身的 packages 上跑,
     避开 P4c 在途改动):`bun run boundary` = **0 failed / 203 ok**、`bun run boundary:gate` 绿、
     `vitest run` 全量 **1146 passed / 3 skipped**,`packages/core/__tests__/architecture-boundaries.test.ts`
     10 tests 全过;副本里另有 3 个文件红,全是副本环境自身的产物(`apps/mobile` 没有它自己的
     `node_modules`,解析不到 `expo/tsconfig.base`;system-prompt 基线快照里烤死了仓库绝对路径),
     这 3 个文件在主仓单跑 3/3 过。gate 的三条路径逐个打桩验过(缺 complete → 红、无 ok 行 → 红、
     有 failed 行(含 ANSI 上色)→ 红)。
     主仓工作树里另有 5 条红全部来自 P4c 在途的 scheduler / variables 域 router 迁移
     (`apps/electron/src/{ipc,main/ipc}/{scheduler,variables}.ts` 正被删除),不属本期,不修。
   - **遗留(交给 P4)**:门变硬之后,**P4 每迁一个域都必须在同一个 commit 里退掉该域的 checker 断言**。
     checker 里有一批 `checkElectronHostOwns<域>IpcHost` / `checkRuntimeOwns<域>IpcOperations`,断言的是
     "`apps/electron/src/ipc/<域>.ts` + `apps/electron/src/main/ipc/<域>.ts` 这条旧路存在且形状正确" ——
     那正是 P4 要删的东西。旧路一删,断言必红;以前有基线兜着,现在没有了。这不是坏事,是把
     "迁移必须连门一起改"变成硬约束,但排期上要算进 P4 每一域的工作量里。
   - 另有 23 条 `@typescript-eslint/no-unused-vars` 警告(P1'-0 / P1'-2 删断言时留下的空模式表),
     本期前后数量一致,未动。

### P3' 归位:src/app → packages/backend + 领域折回(原"拆包",3–5 天;08-21 改拍)

> **08-21 开工前量测,修正 P3'a 前提(拍板 #25)**:25 个"薄壳"目录里 **17 个依赖后端脊柱**
> (`app/stores` 设置缓存、`app/store`、`app/logging`、`app/session`、`app/events`、`app/rpc`),
> 只有 themes / practice / acp / auth / agent-loop / terminal(/ utils / deeplink)脊柱零依赖。
> 整目录折进 runtime 会造出 runtime→backend 反向边,P3'd 拆包成环——原 `app` 树"接线依赖脊柱"是有
> 依赖学理由的,不是纯历史。**修正**:原则不变(包按依赖等级、包内按领域、角色进路径/文件名),
> 归位单位从"目录"改为"**文件**":一个文件 import 了脊柱或宿主端口 → 接线,归 `backend/wiring/<d>/`
> (路径自带角色,不与 `runtime/<d>` 同名;P3'd 前暂住 `src/app/wiring/<d>/`);不 import 脊柱 → 逻辑,
> 归 `runtime/<d>/`(其中 import `@shared/ipc|events` 的文件按 I3 带 `.wiring.ts` 后缀)。
> "哪一个"的答案固定三句:**契约在 `core/<d>`,逻辑在 `runtime/<d>`,接进后端在 `backend/wiring/<d>`**。
> I1 相应改写为"**逻辑**一领域一家":`runtime/<d>` 之外不得再有同名逻辑目录,`backend/wiring/<d>` 只许
> 接线(断言:其下每个文件至少 import 一个脊柱模块或 `@onething/runtime/<d>`;不得被 runtime 反向 import)。
> 执行分两拨:P3'a-1 六个脊柱零依赖目录 → runtime(验证机制);P3'a-2 其余按文件分拣。

#### P3'a-1 落地记录(2026-08-21,六个"脊柱零依赖"目录,未提交)

**先证伪了前提**。开工第一步逐文件重算依赖(直接 import + app 内传递闭包),六个目录里
**真正零 app 依赖的只有 terminal 一个**;08-21 的量测只数了"直接 import 脊柱",漏掉了
"经 app 同级目录传递到脊柱":

| 目录 | 复核结论 |
| --- | --- |
| themes | `app/themes/builtin/` 是 `runtime/src/themes/builtin/` 的逐字副本(index.ts 一字不差,两个 json 还停在旧版),**全仓零 import** —— 不是"要搬的逻辑",是死副本 |
| practice | `index.ts` import `../stores/paths.js` = **脊柱**(`app/stores`),按规则留在 app |
| acp | 5 文件里 4 个是 `export … from '@onething/runtime/acp'` 的转发门面(I2 同名重复);`permission-bridge.ts` 传递依赖 `app/{permission,toolkit,session,stores,logging,channel}`,留 app |
| auth | 6 文件里 2 个是转发门面;`auth-service.ts` 经 `app/providers/bound-fetch.ts` 依赖 `app/{stores,logging}`,留 app;其余 3 个真零依赖 |
| agent-loop | 8 个实现文件里 **7 个**经 `app/providers/bound-fetch.ts` / `app/auth/auth-service.ts` / `app/external-agents` 依赖脊柱,留 app;只有 `providers/acp.ts` 在 acp 门面删掉后变成零依赖 |
| terminal | 3 文件 + 2 测试全零 app 依赖,整目录搬走 ✅ |

**实际动作**(按文件,不按目录):

- **搬进 runtime**(7 个实现 + 3 个测试):
  `app/terminal/{pty-backend.ts, service.ts→service.wiring.ts, spawn-profile.ts→spawn-profile.wiring.ts}`
  + 两个测试 → `runtime/src/terminal/`;
  `app/auth/host-ports.ts` → `runtime/src/auth/host-ports.ts`;
  `app/auth/token-store.ts` → `runtime/src/auth/token-store.wiring.ts`(I2 改名:runtime 已有
  `token-store.ts`,搬来的是 `OAuthToken` 具化的宿主端口子类 + 单例,且 import `@shared/ipc` → 走 I3 后缀);
  `app/auth/types.ts` → `runtime/src/auth/types.wiring.ts`(同上);
  `app/agent-loop/providers/acp.ts` → `runtime/src/agent-loop/providers/acp-manager-bound.ts`
  (I2 改名:runtime 已有参数化的 `acp.ts`,搬来的是"绑定到进程内 ACPManager 单例"的默认绑定,
  不是 wiring,所以用角色名);测试 `acp-provider.test.ts` → `agent-loop/__tests__/acp-manager-bound.test.ts`,
  `auth/__tests__/auth-registry.test.ts` → `runtime/src/auth/__tests__/registry-codex-flow.test.ts`。
- **删除**(I2 同一概念合并,调用点直接 import 真身):`app/themes/`(整目录)、
  `app/acp/{client,manager,types,index}.ts`、`app/auth/{auth-registry,callback-server}.ts` —— 共 7 个文件 + 15 个 json。
- **留在 app**:`app/practice/index.ts`、`app/acp/permission-bridge.ts`、`app/auth/auth-service.ts`、
  `app/agent-loop/{index.ts, providers/{claude,codex,deepseek,factory,gemini,openai-compatible}.ts}` + 17 个测试。
  themes / terminal 两个目录消失,其余四个只剩接线。
- **调用点 import 改写 30 处**(app 层 24 / apps/electron 4 / 测试 mock 2),另有被搬文件内部相对 import 5 处、注释引用 3 处;
  `packages/onething-runtime/package.json` 新增一条 exports:`"./terminal/*"`
  (`./auth/*`、`./agent-loop/providers/*`、`./acp` 已有)。**坑**:runtime 子路径写法**不带 `.js`**
  (`"./auth/*": "./src/auth/*.ts"` 对 `…/host-ports.js` 会解析成 `host-ports.js.ts`,typecheck 直接红)。

**checker(I3 落地)**:`checkRuntimeHostBoundary` 从"按目录(`startsWith(appRoot)`)"改为**按文件名**——
`packages/onething-runtime/src` 里 `*.wiring.ts` 用 `RUNTIME_WIRING_FORBIDDEN_PATTERNS`
(= `HOST_BOUNDARY_FORBIDDEN_PATTERNS` 减掉 shared 契约那四条),electron / `@main` / `@preload` / cordis
照旧禁;新增 `checkRuntimeWiringModulesStayAtTheEdge`:非 wiring 的产品文件不得 import `*.wiring` 模块
(`__tests__` 与 `*.test.ts` 豁免 —— 测试是那个模块的验证,不是产品对它的依赖)。两条都用探针文件验过会真红。
另外三处路径断言随搬家改指:auth token-store 两处指向 `runtime/src/auth/token-store.wiring.ts`;
acp 四个门面、`app/auth/callback-server.ts`、`app/themes/builtin/index.ts` 从"必须存在且要瘦"翻成
"**回来才算红**"(沿用 `checkRuntimeOwnsThemeRuntime` 的 mainHelperFiles 判例)。
`architecture-boundaries.test.ts` **不用改** —— 它对 runtime 只禁 electron/宿主,从来没有 `@shared/ipc` 那一条。

**验收**(全绿):`typecheck` 0 错;`test` 1149/1153 文件通过,唯一红是
`app/stores/__tests__/sessions-delete-cascade.test.ts` 的 `waitGone` 在满负载下超时,**单跑即过**,与本批无关;
`boundary` 199 ok / 0 failed、`boundary:gate` 0 failures、`transport:gate`(279 常量 / 5521 行)、
`ui:gate` 81、`log:gate` 4、`session:gate` 0 全部 none new;`build` / `server:build` / `web:build` 三宿主打包绿。

**留给 P3'a-2 的判断题**:`app/practice/index.ts` 唯一的脊柱边是 `getStorePath`,而
`app/stores/paths.ts` 里它就是 `getOnethingStorePath` 的一行转发 —— 改 import 指向
`@onething/runtime/storage` 即可整只搬成 `runtime/src/practice/service.wiring.ts`。
本批按"import 脊柱就留下"的机械规则没动它;`app/stores/paths.ts` 整个文件都是这种转发,
**它到底算不算脊柱**要先拍。同理 `app/providers/{bound-fetch,request-dump}.ts` 是 agent-loop
六个 provider 包装留在 app 的唯一原因,它们真依赖设置缓存与日志,是真脊柱。

原 P3 的"零纠缠、1–2 天机械活"前提是**原样搬**;P3' 要归位(§0b.3 I1/I2/I3),不再是机械活。分四批,每批独立 commit:

1. **P3'a 薄壳折回**:app 层 32 个 ≤800 行的领域目录(themes / media / prompts / acp / auth / todo-plan /
   scratchpad / project-dirs / practice / markdown / toc / tasks / usage / search / skills / agents /
   scheduler / agent-loop / external-agents / goals / variables / permission / interaction / storage / tools /
   headless / features / deeplink / terminal / utils / …)并回 `runtime/src/<d>/`,接线文件改名 `*.wiring.ts`
   (或 `wiring/` 子目录);宿主 `@onething/app/<d>` import 改为 `@onething/runtime/<d>/wiring`
   (163 条中的相应部分);`checkRuntimeHostBoundary` 从 `startsWith(appRoot)` 改为文件名模式(I3),
   `import-side-effect-free.test.ts` 的范围改为 wiring 文件。
2. **P3'b 厚孪生合并**:collab(rt 16k / app 14k)、providers、toolkit、music、logging、mcp、voice 按 I1 并回
   `runtime/<d>`,同名文件(collab 的 `agent-session/mentions/reactions/reply-quote.ts`)按 I2 合并或带角色改名。
   collab 最大,单独 commit。
3. **P3'c plugins 三合一**(单独一批):core 15k / rt 3k / app 5k,core 与 app 同名文件逐个判定"契约还是实现"
   ——契约留 core,实现全部进 `runtime/plugins`,不允许第三处;I2 断言在此批落地。
4. **P3'd backend 成包**:剩下的脊柱(`backend.ts` / engine / server / rpc / stores / events / channel /
   session / headless)→ `packages/backend`(name `@onething/backend`);引擎三层继承链保留但路径变为
   `core/engine`(内核)/ `runtime/stream-engine.ts`(产品)/ `backend/engine`(后端)。
   三条新断言进 `architecture-boundaries.test.ts`:I1 领域名交集为空、I2 跨包相对路径唯一、产品层不 import backend。
5. 文档提及(~140 处)只改 CLAUDE.md 与活跃设计文档,历史 audit 不动。
6. 验收门:`build:check` + `test` + `boundary` 全绿;三条新断言通过;electron / server / web 三宿主冒烟;
   `for d in runtime/src/*/; do test ! -d backend/$d; done` 式的 I1 检查为空。

### P4 传输面 router 迁移(主线,1–2 周,逐域可暂停;08-21:**P4a 前移到 P1' 之前**)

0. 08-21 改拍:P4a(六裸写域)紧跟 P0.5 做——它治的是"读"(断点 B),是用户每天撞的墙;
   P0.5 已把 transport 门改硬,P4a 的每一域都能用门的下降验收。P4b/c 仍排在 P3' 之后。
1. 前置拍板:RpcRequest 是否加 context 字段(T1 遗留,见传输面统一记录)。
2. Fable 出**每域迁移契约模板**(defineRouter 定义 → `app/rpc/domains/<域>` 注册 →
   删工厂+适配 → 削 bridge.ts/web.ts 对应段 → 测试迁移),并 review 每域产出;opus 逐域执行。
3. 批次顺序:
   - P4a 六个裸写域(collab / evals+workbench / practice / notify / deeplink / music 混搭部分)
     ——无工厂层,纯增益,先趟模板;
     **08-21 逐通道盘点结果**(68 invoke + 10 push;A 纯数据面 / B 需宿主端口 / C 窗口系 / D 推送):

     | 域 | invoke | push | A | B | C | D | 顺序 |
     | --- | --- | --- | --- | --- | --- | --- | --- |
     | practice | 10 | 1 | 10 | 0 | 0 | 1(已是端口) | **1**(纯改善:web 桩原来回假 idle) |
     | collab | 15 | 0 | 15 | 0 | 0 | 0 | **2**(web 有 `collabRooms` 能力位,迁时不动它 → 零行为变化;放开列拍板 #12) |
     | music | 8 裸 + 6 工厂 | 4 | 14 | 0 | 0 | 4(已是端口) | **3**(web 会能遥控桌面播放器,拍板 #13 后再动;顺手删 `apps/electron/src/music/ipc.ts` 工厂与其 alias) |
     | evals + workbench | 14 + 11 | 1 + 2 | 15 | 9(`app.isPackaged` 传染) | 1(`EVALS_RUN_START` 取 sender 窗推进度) | 3 | **4**(要新开 `configure*Host` 端口 + 先把定向推送改全窗;大 payload;"server 上跑 evals"是未答的产品问题) |
     | notify | 2 | 1 | 0 | 0 | 2(Notification + sender 窗 + dock) | 1 | 不迁;**渲染侧零调用点,疑为死码**(拍板 #14) |
     | deeplink | 2 | 1 | 0 | 0 | 2(OS scheme,`@onething/electron-host`) | 1 | 不迁(窗口系残留集) |

     **落地记录**:practice 已迁(`practiceRouter` 10 方法 + `app/rpc/domains/practice.ts` +
     `renderer/platform/practice-client.ts`;`main/ipc/practice.ts` 98→18 行只剩广播注入;web 从"永远 idle 的
     说谎桩"变为真状态;transport 基线收紧 channels 329→319 / bridge 1855→1816 / web 1707→1681)。
     模板已被两个域验证,每域 ~1 小时 opus 执行 + review。
     collab 已迁(`collabRouter` 15 方法;`main/ipc/collab.ts` 整文件删除、449 行旧测试搬进域测试 48 例;
     `messageReact` actor 仍由处理者钉死;结构化克隆防线从 preload 桥挪到调用点;web `collabRooms` 能力位保持
     false —— 放开只需 `web.ts:97` 一行,拍板 #12;transport 收紧 channels 319→304、**bridge 1816→1736 已低于
     08-14 起点 1737**、web 1681→1666、channels.ts 533→499)。P4a 剩余:music(拍板 #13)、evals(拍板 #15:
     web 端 evals 桩删除后浏览器将真能跑 evals,"server 上跑 evals"是产品问题;技术上需 `configureEvalsHost`
     端口承 `app.isPackaged` + 三条推送改注入广播)。**推送面裁定(代码级,Fable 拍)**:router 暂不开推送面,
     main→renderer 推送统一用已被 practice/music/spaces 验证的注入广播端口形状(`configureXxxBroadcaster`),
     宿主决定送往哪个窗口;evals 的定向推送改全窗广播。
     横向观察:10 条推送里 **6 条已是注入端口形状**(practice 1 + music 4 + spaces 的 `SPACES_CHANGED`),
     只有 evals 3 + notify/deeplink 2 真绑 BrowserWindow —— router 补推送面时照这个形状抄即可,不必从零设计。
     纪律一条:`COLLAB_MESSAGE_REACT` 的 actor 由主进程钉死 `{type:'user'}`、忽略 wire 值,router 的 context 没有
     "我是谁",handler 必须继续硬编码。
   - P4b todo-plan 窗口面收尾(消灭骑墙);
   - P4c 其余 ~24 工厂域按"低风险→高风险"排(建议:themes/scratchpad/app-state 等小域先,
     sessions/chat/media 等大域后)。
     **08-21 逐通道盘点**(25 工厂域 ≈208 invoke + 8 push;A ≈134 / C 残留 ≈42 / 需拍板 ≈32):

     | 批 | 域(invoke) | 类 | web 变化 | server 镜像可删 |
     | --- | --- | --- | --- | --- |
     | **1 零行为变化,已派** | scheduler(9,渲染侧 0 调用点)/ variables(3)/ app-state(2)/ permission(2,respond 走命令总线不碰)/ scratchpad(4,push 已端口)/ project-dirs(5,web 开始真传 workspaceId=变对) | A | 否 | 24 条 + 1 正则 |
     | **前置:`configureShellHost({openPath, openExternal, revealPath})`** | 解锁 files(14)/ skills(12)/ themes(5)/ oauth(6+2 push)共 37 条 | B→A | themes:server 顺带获得插件主题 override(`main/ipc/themes.ts:71-81` 在 @main 拼);oauth 换到桌面 authService | 是 |
     | 2 换实现(server facade 自有一套 → 同一 backend) | acp(8)/ mcp(16)/ gateway(8,需 `configureGatewayHost`) | A/B | ⚠️ web 从 server 那套切到桌面同一套 | 是(`runtime.ts:3944/4288/4489/4672` 四份 adapter) |
     | 3 权限面 | tools(7:`executeTool` 直跑)/ files(13 条 fs) | A | ⚠️ `DESKTOP_RPC_CONTEXT` unconfined vs server `RpcContext` sandbox root——**安全面不是传输面** | 是 |
     | 4 大域 | sessions(26,含 4 条字面量通道)/ media(14,含 5 条字面量、3 条 C)/ chat(7:`resumeAfterToolConfirm` 递 sender,web 早走命令总线——应删 invoke 改总线而非迁 router) | A | 否 | 是 |
     | 需拍板 | plugins(19+1:web 长出 install/uninstall/config/market 全套写能力,与"插件只在桌面执行"方案 A 冲突;server 写路由改的是 `owners/<uid>/<wid>/plugin-store` 另一棵树)/ interaction(2:web 从"桩掉靠 deadline"变"真能应答")/ terminal(7+2:内核在 app 层,技术可迁,政策冻结 `terminal:false`) | — | ⚠️⚠️ | — |
     | 残留集 C | browser(19+1)/ shell(4 条**字面量**通道,不在 `IPC_CHANNELS`)/ todo-plan 窗口(7+1)/ window(1)/ search 窗口 3 条 | C | — | — |
     | 不是迁移对象 | session-command(命令总线入口;web=`POST /api/sessions/:id/commands`) | 总线 | — | — |

     **第一批落地记录(08-21)**:六域 25 方法迁完;`http.ts` 2028→1839(−189:24 条路由 + 1 正则块 +
     只服务它们的 handler)、`runtime.ts` 删 scheduler 整台 per-owner `Scheduler` / `ServerProjectDirsStore` 类 /
     variables·app-state·permission·scratchpad adapter;`core/runtime-facade.ts` 删三个 Adapter 接口、两个砍到只剩
     respond/subscribeChanged(`RuntimeAppStateAdapter` 因位置泛型暂留空格);checker 整删 5 条
     `checkElectronHostOwns<域>IpcHost`、6 条退掉"旧文件缺席=红"分支、1 条改指 `app/rpc/domains/scheduler.ts`
     → boundary 198 ok / 0 failed;transport channels 304→279、bridge 1736→1631、web 1666→1577;全量 11127 用例绿。
     project-dirs 做成"带 context 的安全域"(`resolveRpcSandbox`:ipc 不夹、http 夹 sandboxRoot)。
     **语义变化两处(拍板 #23/#24)**:permission.getPending/clearSession 在 server 上失去 per-owner 护栏(桌面线从来
     没有;server 单用户、owner 头是脚手架,但这是本批唯一安全语义削弱);app-state web 将 hydrate 桌面真实页签树
     (与 #11 同型)。variables / scheduler 从 server 自有 per-owner 实例换成引擎真正在用的 app 单例(修正)。
     另:`main/ipc/` 下无工厂的漏网 handler:**settings.ts**(8 条,`SHOW_OPEN_DIALOG` 渲染侧 21 调用点全仓最高,
     `OPEN_SETTINGS_WINDOW` C)、**voice.ts**(12 条,`configureVoiceHost` 已在,web 全套 REST);13 条**字面量通道**
     (shell 4 / sessions 4 / media 5)在契约表外、transport 门统计不到——终态前补进契约或明确豁免(拍板 #22)。
4. 每域验收门:该域全部通道走 RPC_INVOKE;工厂/适配文件删除;bridge.ts/web.ts 无该域手写段;
   `transport:gate` 棘轮下降;desktop+web 双端该域功能冒烟。
5. 终态:`main/ipc/` 仅剩 rpc.ts 与少数真窗口系 handler;`src/ipc/` 目录删除;
   CLAUDE.md 的"添加 IPC 通道五步"改写为"defineRouter 一步"。

### 明确不做

- 不合并 src/ipc ↔ main/ipc(会丢可测缝,且方向违背钦定终点);
- 不消除 session-events 的 core/shared 分裂(边界规则必然产物);
- 不在本方案内做 UI surface-literal 清零与目录内聚重组(单独排期);
- 不切换 npm/bun 双锁现状(记录即可)。

## 3. 顺序与依赖

08-21 改拍后的顺序:

```
P0 收尾 ──► P0.5 派发表+硬门 ──► P4a 六裸写域 ──► P1' workspace 化 ──► P2 boundary 清偿
(硬前置)    (小,治"读")        (router 模板,     (删 alias 表,      (旧路径上修完)
                                 门验收)           IDE 跳转全通)
        ──► P3' 归位(a 薄壳折回 / b 厚孪生 / c plugins 三合一 / d backend 成包) ──► P4b/c 其余域
            (I1/I2/I3 三断言落地,估 3–5 天)                                    (终态)
```

原顺序(P0 → P1 → P2 → P3 → P4)保留作对照:

```
P0 卫生落库 ──► P1 alias 塌缩 ──► P2 boundary 清偿 ──► P3 拆包 ──► P4 传输面迁移
 (硬前置)      (P3 新包受益)      (旧路径上修完,       (checker 已零红,
                                  P3 只做机械替换)      纯机械搬迁)
```

- P0 必须最先:任何结构手术不能在未提交改动上进行(08-21:只剩 compact 一批),且 transport:gate
  必须先绿——P4 的每域验收靠这道棘轮下降来证明,红着开工等于没有验收。
- P2 中 C 组两条红与 P4 有重叠,P2 只做最小修,避免过度投资即将被删的文件。
- P4 独立于 P1–P3,理论上可提前;但排最后是因为它最长,且前面全绿后每域迁移的回归信号最干净。

## 4. 待拍板

| # | 决策 | 默认建议 | 08-21 状态 |
| --- | --- | --- | --- |
| 1 | P4 现在启动,还是先只做 P0–P3(约一周)? | 先 P0–P3,P4 另起一轮 | 未拍;logs 域已自然走 router,P4 路通 |
| 2 | P1 门禁形态:登记式 → boundary-check 显式解析检查 | 同意迁移 | 未拍 |
| 3 | UI 76 条 surface-literal 单独排期 | 同意,不捎带 | 未拍;ui:gate 81 不变 |
| 4 | todo.md / todo2.md 去向 | 归档进 plans/ | 未拍,文件仍 tracked |
| 5 | P4 前置:RpcRequest 加 context 字段与否 | P4 启动时再议 | 未拍 |
| 6 | **(新)transport 红的处置**:7 条手写通道改走 router vs 抬基线 | 改走 router,不抬基线(见 P0.3) | 待拍 |
| 7 | **(新)P1' workspace 化是否接受 electron-builder 打包风险** | 接受,`build:mac` 冒烟守;过不去退回正则塌缩 | 待拍 |
| 8 | **(新)plugins 三合一(P3'c)放 P3' 内还是单独一期** | 放 P3' 内单独一批;若 core/app 同名文件判定拖长则拆出 | 待拍 |
| 9 | **(新)薄壳接线的落位形态**:`<d>/*.wiring.ts` 后缀 vs `<d>/wiring/` 子目录 | 后缀(一两个文件时不值得开目录;≥3 个文件再开 `wiring/`) | 待拍 |
| 10 | **(新)窗口系通道的典型形态**(todo-plan minimize/zoom/drag 等操作 BrowserWindow 的通道):宿主壳自己的 `shell`/`window` 路由 + sender 上下文 vs 维持手写 | P4 终态前统一成一个宿主壳路由;transport 门区分"域通道"(禁增)与"窗口系"(白名单) | 待拍 |
| 11 | **(新)spaces 迁 router 后 web 端从"必然降级"变为"真拿到空间"** | 按 agents/models 收敛判例接受,不人为关闭 | 已按默认执行,待知会确认 |
| 12 | **(新)collab 迁 router 后,web 的 `collabRooms` 能力位是否放开**(放开 = 浏览器里能用协作房间) | 迁移时**不动**能力位(零行为变化);放开另议 | 待拍 |
| 13 | **(新)music 迁 router 后 web 能遥控桌面播放器**(今天 web 桩回"仅桌面可用") | 符合"一个 core 任何 UI",但用户可感知 → 先拍再迁 | 待拍,music 迁移暂缓 |
| 14 | **(新)notify 域(`NOTIFY_SHOW/BADGE/ACTIVATE`)渲染侧零调用点,疑为死码** | 确认无主进程外调用后整域删除(不是迁移) | 待拍 |
| 15 | **(新)evals 迁 router 后 web 端从"Evals is not supported in the web build"桩变为真能跑 evals**(repoDir 在服务器机器上解析) | 先拍再迁;若不想放开,迁移时保留一颗 `evals` 能力位关 UI | 待拍,evals 迁移暂缓 |
| 16 | **(新,P4c)plugins 迁 router = web 长出 install/uninstall/config 写/market 全套真能力**,与"插件只在桌面执行(方案 A)"冲突;server 现有 enable/disable 写路由改的是 `owners/<uid>/<wid>/plugin-store` 另一棵树 | 不迁写面;只迁只读面(list/commands)并保留桌面专属写面,或整域留到方案 A 重议 | 待拍 |
| 17 | **(新,P4c)interaction 迁 router = web 从"桩掉靠 deadline 超时"变为"真能应答 agent 提问"** | 这是 `web.ts:461-465` 注释里的待办,建议放开 | 待拍 |
| 18 | **(新,P4c)terminal 内核已在 app 层,技术上可迁,但 `terminal:false` 政策冻结** | 维持冻结,不迁 | 待拍 |
| 19 | **(新,P4c)tools(`executeTool` 直跑)/ files(13 条 fs)迁 router 后权限边界从 `DESKTOP_RPC_CONTEXT`(unconfined)变为 server `RpcContext` sandbox root 语义** | 安全面:迁前先把 sandbox root 语义逐条对清,桌面保持 unconfined | 待拍 |
| 20 | **(新,P4c)acp / mcp / gateway / oauth / themes 迁 router = 删 server facade 自有的那份镜像实现,web 改吃桌面同一套**(themes 还让 server 获得插件主题 override) | 这正是"五重镜像"要消的债,按 agents/models 判例逐域接受 | 待拍(可一次性拍) |
| 21 | **(新,P4c)chat 的 `resumeAfterToolConfirm` invoke 往引擎递 sender;web 同名方法早已走命令总线** | 不迁 router,删 invoke、桌面也走命令总线 | 待拍 |
| 22 | **(新,P4c)13 条字面量通道(shell 4 / sessions 4 / media 5)不在 `IPC_CHANNELS`,transport 门统计不到** | sessions/media 的随域迁移消失;shell 4 条补进契约表并按项注明基线 | 待拍 |
| 23 | **(新,P4c-1 已发生)permission.getPending/clearSession 在 server 上失去 per-owner 护栏**(旧 adapter 查"会话属于此 owner",桌面线无此检查;单用户 server 下无实际影响) | 接受(server 单用户是既定前提);若将来多租户,在 RpcContext 上加 owner 校验而不是回到每域手写 | 已按默认执行,待知会 |
| 24 | **(新,P4c-1 已发生)app-state 迁 router 后 web 端 hydrate 桌面真实 `app-state.json`(页签树/侧栏状态),不再是 server 现场拼的恒定单页签** | 与 #11 同型接受 | 已按默认执行,待知会 |
| 25 | **(新,P3')归位单位从"目录"改为"文件":依赖脊柱的接线归 `backend/wiring/<d>/`,逻辑归 `runtime/<d>/`;I1 改为"逻辑一领域一家"**(量测:25 薄目录 17 个依赖脊柱,整目录折回会成环) | 按修正执行;P3'a-1 先做 6 个脊柱零依赖目录验证机制 | 已按默认开工,待知会 |

08-21 已拍:组织原则 = 包按环境/依赖等级、包内按领域、文件名带角色(§0b.2);`app` 改名 `backend` 并瘦身;
P1→P1'、P3→P3'、新增 P0.5、P4a 前移(§0b.4)。

## 5. 风险与回退

- P1':workspace 化的风险全在 electron-builder 收集 workspace 包(07-29 bun collector 旧伤),`build:mac`
  冒烟是硬门;过不去回退到原正则塌缩(还原 aliases.ts 单文件)。exports 漏键在构建期显性报错,不会静默。
- P3':不再是单 commit——四批(a 薄壳 / b 厚孪生 / c plugins / d backend)各自独立 commit,任一批出问题单独
  revert。最大风险在 P3'c:core 与 app 同名文件的"契约 vs 实现"判定是人工判断,可能拖长;拖长就按拍板 #8 拆出。
  I3 把 `@shared/ipc` 准入从"按树"降到"按文件名",checker 规则变细但不变弱:非 wiring 文件 import wiring = 红。
- P0.5:只剩硬门一项;风险是基线重写那一次必须逐项注明,否则就是"抬基线"。
- P4:逐域独立 commit,任一域出问题单独 revert,不影响已迁域;
  `transport:gate` 棘轮防新增手写通道。
- 已知工期陷阱:server 单文件包对动态 import 的 TDZ 坑(toolkit 重建时踩过),
  P3/P4 动 backend.ts 静态 import 边时须保留既有注释语义。
