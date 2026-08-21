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
- 两个追踪断点:**A** 命令总线按约定派发(`command:send-message` → `handleSendMessageCommand`),字面量 grep
  与 go-to-definition 同时失效;**B** 旧路 IPC 六跳两次字符串键跨进程(platformApi → platform/electron → preload
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
| I4 | **间接层可被字面量 grep / IDE 穿透**:命令总线显式派发表;IPC 只剩 router 三件套(`shared/ipc/<d>.ts` + `backend/rpc/domains/<d>.ts` + `rpc.<d>`,同名);alias 由真 workspace 解析 | 派发表 `satisfies Record<SessionCommand['type'], …>`;`transport:gate` 改硬红;alias 表删除 |

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
4. 验收门:`git status` 干净;`bun run test` + `boundary:gate` + `ui:gate` + `session:gate` +
   `log:gate` + **`transport:gate`** 全绿。

### P0.5 断点 A 派发表 + transport 硬门(小,半天;08-21 新增)

1. `CoreStreamEngine` 的命令派发从按约定(`command:x` → `handleXCommand`)改为显式表
   `{ 'command:send-message': …, … } satisfies Record<SessionCommand['type'], Handler>`——
   字面量 grep 直接落在处理者上,类型穷尽顺带把 shared / core 的命令集对齐(I4)。
2. `transport:gate` 从"只许不升"改为**硬红**:`channels.ts` / `bridge.ts` / `web.ts` / `http.ts` 的手写段
   只许减不许增,任何新增直接 exit 1(棘轮基线仍保留作为下降的度量)。
3. 验收门:全量测试绿;`grep "'command:send-message'"` 在 core 引擎命中派发表;`transport:gate` 绿。

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

### P2 boundary 清偿 + parity 测试(2–3 天)

1. A 组两处一行修;D 组假阳性豁免;B/C 组逐条核对 check 语义后委派/下沉
   (C 组 sessions/plugins 只做最小修,大改留给 P4 吸收)。
2. 清零后简化 `boundary-gate.mjs`(删基线 diff 机制),删除基线文件;CLAUDE.md 同步。
3. 补 core↔shared session-events 注册表 parity 测试(core 内联字面量 ⊆ shared 注册表)。
4. 验收门:`bun run boundary` 0 failed;gate 退化为零基线模式;全量测试绿。

### P3' 归位:src/app → packages/backend + 领域折回(原"拆包",3–5 天;08-21 改拍)

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
   - P4b todo-plan 窗口面收尾(消灭骑墙);
   - P4c 其余 ~24 工厂域按"低风险→高风险"排(建议:themes/scratchpad/app-state 等小域先,
     sessions/chat/media 等大域后)。
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

08-21 已拍:组织原则 = 包按环境/依赖等级、包内按领域、文件名带角色(§0b.2);`app` 改名 `backend` 并瘦身;
P1→P1'、P3→P3'、新增 P0.5、P4a 前移(§0b.4)。

## 5. 风险与回退

- P1':workspace 化的风险全在 electron-builder 收集 workspace 包(07-29 bun collector 旧伤),`build:mac`
  冒烟是硬门;过不去回退到原正则塌缩(还原 aliases.ts 单文件)。exports 漏键在构建期显性报错,不会静默。
- P3':不再是单 commit——四批(a 薄壳 / b 厚孪生 / c plugins / d backend)各自独立 commit,任一批出问题单独
  revert。最大风险在 P3'c:core 与 app 同名文件的"契约 vs 实现"判定是人工判断,可能拖长;拖长就按拍板 #8 拆出。
  I3 把 `@shared/ipc` 准入从"按树"降到"按文件名",checker 规则变细但不变弱:非 wiring 文件 import wiring = 红。
- P0.5:派发表改造只动 core 引擎一处,类型穷尽检查会在编译期暴露 shared/core 命令集不一致——那是收益不是风险。
- P4:逐域独立 commit,任一域出问题单独 revert,不影响已迁域;
  `transport:gate` 棘轮防新增手写通道。
- 已知工期陷阱:server 单文件包对动态 import 的 TDZ 坑(toolkit 重建时踩过),
  P3/P4 动 backend.ts 静态 import 边时须保留既有注释语义。
