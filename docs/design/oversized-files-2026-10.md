# 大文件拆不拆:判据、逐文件决定、批次(s37,2026-10-04)

只读分析,不改仓库。数据来自 `s37-fable/analyze.mjs`(顶层声明 + 文件内引用图的连通块 + 类成员按共享私有字段分组)、`inner.mjs`(类方法表 / 闭包内嵌套函数与它们读写的 `let`)、`uses.mjs`(谁引这只文件、引了哪些名字、`vi.mock` 打在哪),HEAD = `996e8e212`。

## 0. 结论一页

| 文件 | 行 | 里面有几件事 | 决定 | 批 |
| --- | --- | --- | --- | --- |
| `agent-loop/agent-loop-executor.ts` | 2738 | 6 件(内容部件 / 工具步骤 / 流块 / 收尾 / 回复后钩子 / 助手写者),74 个接口与函数一一对应 | **拆成 6 只**(纯函数,无闭包无模块态) | 1 |
| `session/session-store-helpers.ts` | 1260 | 12 个互不引用的块(最大那块里又是元数据 / 详情 / 用量 / 建删四件事),名字还是 N4 的坏味 | **拆成 5 只,按内容起名** | 1 |
| `agent-loop/agent-loop-runtime.ts` | 1456 | 4 件(准备 / 预算 / 压缩 / 回合前后) | **拆成 4 只** | 1 |
| `theme/theme-resolver.ts` | 2480 | 5 件(词表 / 解析核 / 色彩语义 / UI 样式推导 / 高亮推导 / 预览色) | **拆成 6 只**(纯函数) | 1 |
| `theme/theme-role-mapping.ts` | 1193 | 2 件(颜色数学 / 角色推导) | **拆出颜色数学一只** | 1 |
| `engine/engine-agent-loop-stream-runtime.ts` | 1424 | 2 件(适配器形状 + 工厂 / 543 行的装配函数) | **只拆出适配器那半(~360 行)**;装配函数不拆(顺序即规格,D220) | 1 |
| `plugin/plugin-api-builder.ts` | 1982 | 一只 1540 行闭包建一个 34 格的对象,格子按面成组 | **按面拆成 5 只建造件 + 1 只上下文 + 原文件只剩拼装**(闭包变量 → 上下文对象;两个大形状并进已有的 `plugin-api-types.ts`) | 2 |
| `session/session-store.ts` | 1365 | 门面:会话读写 / 会话字段 / 用量 / **消息更新(18 只)** / 模型与 agent | **只拆出消息更新那块**;35 处 `vi.mock` 先跑清单脚本 | 2 |
| `collab/actors/collab-actors-runtime.ts` | 2072 | 生命周期与单例 / 房间与 agent 条目 / 发言与投递 / 公开操作 / 预算 / **四个 host 适配器** | **先设计再拆 host 适配器**:它们按参数拿 `runtime`,但调的 `roomOverBudget / scheduleJudgment / postToRoom / ensureAgent` 都读模块单例,直接搬就是兄弟环;单例所在的生命周期不拆 | 3 |
| `agent-loop/agent-loop-stream-engine.ts` | 2198 | 一只 1771 行的类:五个命令 + 标题生成 + 压缩闸 + 服务商解析 | **设计后拆三个协作件(标题生成并进已有的 `agent-loop-title.ts` / 压缩闸 / 服务商解析)**,五个命令留在类里;250 行接口可在批 1 先机械外移 | 3(类型 1) |
| `acp/acp-client.ts` | 2007 | 一只 1548 行的协议状态机 + 给 SDK 的回调面(权限 / 问答 / 文件 / 终端) | **设计后只拆回调面**;连接 ↔ 会话 ↔ 提示那台状态机不拆 | 3 |
| `music/music-radio.ts` | 1940 | 一只 1803 行闭包,7 个 `let` 把它分成 DJ 会话 / 播放 / 点歌 / 歌词 / 反向识别 | **拆歌词与反向识别两段**(各自的 `let` 自成一组);播放与 DJ 会话暂留 | 3 |
| `collab/actors/collab-actors-room-rules.ts` | 1431 | 一台账本 reducer | **不拆** | — |
| `backend.ts` | 1391 | 装配配方(`assembleSteps` 745 行,80 条 `own()`) | **不拆** | — |

其余 1000 行以上的:`session-repository`(一只类,一份缓存一条写队列)、`search-index-sqlite`(一只类,一个库句柄)、`session-event-log`(一本账本一个写者)、`provider-openai-responses-wire`(`parseStream` 601 行是一台 SSE 解析状态机)、`music-resource-spec`(一张 564 行的数据表)、`plugin-manager-base`(一只类)、`engine-agent-loop-executor` / `engine-stream-session-event-recorder`(各一只编排函数)—— **都不拆**,理由在第 1 节「不拆的形状」。`skill-review-core`、`provider-model-registry`、`agent-loop-tool-orchestration`、`credentials-pool`、`settings-factory-defaults` 有可拆的小块(第 2.4 节),不进这三批。

## 1. 判据

### 1.1 该拆的三种形状

用户的四个问题(几件事 / 读一处要不要先读另一处 / 改一处碰不碰别处 / 测试能不能单测)对应到可以量的东西:

- **形状 A「两件不相干的事住一起」**:把文件的顶层声明当节点、谁引用谁当边(不分方向),算连通块;**≥ 2 块、且第二大的块 ≥ 150 行**。读其中一块不需要读另一块,改一块碰不到另一块,测试可以按块。注意把**叶子常量**(≤ 3 行、不是函数也不是对象字面量的 `const`,例如 `log`、超时毫秒)排除在边之外 —— 不排除的话每只文件都是一个块,因为人人都引 `log`。这一条**可以写成门**:纯结构,不要人判断。
- **形状 B「一只函数 / 闭包里住着几台机器」**:一只 ≥ 400 行的函数,它里面的嵌套函数按**共用哪些 `let`** 分组,分出 ≥ 2 组、第二组 ≥ 100 行。例子:`music-radio` 的歌词段只碰 `currentLyrics`、反向识别段只碰 `lastObservedTitle / identifiedCurrent / lastWatchedSample`。
- **形状 C「一只类里住着几台机器」**:类的方法按**共用哪些私有字段**(加上互相调用)分组,分出 ≥ 2 组、第二组 ≥ 100 行。例子:`CoreStreamEngine` 的标题生成只碰 `sessionTitleGenerations / titleGenerationSeq`,压缩闸只碰 `activeCompactions / compactionGates`。

形状 B、C **不写成门,只做评审规则**:它们能探出「有几组」,但拆出来叫什么、各自要一个什么样的端口(port,即它向外要的那几个函数),要人来定;门判不了「端口起得对不对」。同一只脚本把 B、C 打出来当报表,但不判红。

### 1.2 不拆的形状(为什么不用行数上限)

这几种形状再长也是一件事,用行数上限会把它们误伤,所以行数不做门:

1. **一个 reducer 管一份状态**:每个 `apply*` 都读同一份账本形状,拆开就要读两只文件才能看懂一次状态跃迁。`collab-actors-room-rules`(房账:席位 / 租约 / 举手 / 裁决)、`session-repository`(缓存 + 写队列 + 墓碑)、`SqliteIndex`(一个句柄)、`OpenAIResponsesWire.parseStream`(SSE 解析状态机)。
2. **顺序就是规格的装配函数**:`backend.ts` 的 `assembleSteps`(CLAUDE.md:「顺序约束住在这里,别处没有」)、`buildOnethingAgentLoopStreamRuntime`(十二槽按序装)、`http-server-runtime-roster`(D220:发明机制复原顺序比写出来更难读)。
3. **数据表**:`music-resource-spec`(564 行的 spec 对象)、`theme-resolver` 里 647 行的 `fallbackUIStyle` switch(每个 token 一条配方;改成查表是改行为,不做)。

### 1.3 门的写法(建议 `bun run split:gate`)

- 扫 `packages/backend` 非测试 `.ts`;每只文件用 TypeScript 解析顶层声明,按 1.1 形状 A 算块;**红 = 形状 A 成立**。脚本家族同 `name:gate`(`scripts/lib/backend-structure.mjs` 已经有解析与遍历)。
- 今天按这个口径只红两只:`agent-loop-executor`(第二块 264 行)、`session-store-helpers`(156 行)。批 1 做完后改零基线硬闸。
- 诚实说明它探不到的:`theme-resolver`、`music-radio`、`plugin-api-builder`、`CoreStreamEngine` 都是**一个块**(大家经同一批私有 helper 连着),它们靠形状 B / C 的报表和评审。

### 1.4 「行为零变化」的证明方法(建议 `bun run split:prove <旧文件> <新文件…>`)

从 git 里取拆分前那只文件,从工作树取拆出来的几只,各自抽出**每个顶层声明的源文本**(去掉 `import` 行、去掉 `export` 关键字、去掉空白差异),断言两边是同一个多重集。满足它 = 每个函数 / 类 / 类型一字未改、只是换了住处。批 1 以它为交卷条件;批 2 / 3 不能满足(闭包变量变成了上下文对象、类方法变成了协作件),所以它们靠测试与真机门。

## 2. 逐文件

### 2.1 批 1:纯搬家(无闭包、无模块态、`split:prove` 能过)

**`agent-loop/agent-loop-executor.ts`(2738 行)**。74 个接口 + 5 个类型别名(34–1090 行,约 1050 行全是形状)+ 52 个函数;外面非测试只有 `agent-loop-session-stream-emitter.ts` 引两个类型,其余全经入口 `agent-loop.ts:158/170` 转交(真正的使用者是 `engine/stream/engine-agent-loop-executor.ts`);`vi.mock` 0;测试 `agent-loop-executor.test.ts` 引 ~40 个名字。里面六件事,函数名已经把它们分好了:

| 新文件 | 内容(行号按今天) | 约行 |
| --- | --- | --- |
| `agent-loop-executor-turn-state.ts` | 回合状态与各家共用的端口形状:`CoreAgentLoopExecutorTurnState`、`CoreAgentLoopContentPartStore / Emitter`、`CoreAgentLoopToolExecutionStore / Emitter`、`CoreAgentLoopToolInputProcessor`、`createAgentLoopExecutorTurnState`、`rememberAgentLoopToolStepId`、`appendAgentLoopTurnToolCallOnce` | 150 |
| `agent-loop-executor-content-parts.ts` | 有序内容部件:`appendOrderedPart`、`planAgentLoopToolContentPartsDispatch`、`planAgentLoopTurnContentPersistence`、`dispatch… / persist…WithAdapters`、`hasAgentLoopVisibleTurnActivity`、`getAgentLoopReasoningPlacement` 与它们的接口 | 250 |
| `agent-loop-executor-tool-steps.ts` | 工具步骤(1514–2065):`resultText`、`structuredToolResult`、`changesFromMetadata`、`applyAgentLoopToolMetadata`、`settleAgentLoopToolCallResult`、`buildAgentLoopToolResultPresentation`、`startAgentLoopToolExecution`、`settle… / applyAgentLoopToolInput{Start,Delta,End} / ToolCallFallback / ToolResult / ToolMetadata / ToolPartialResult …WithAdapters`、`planAgentLoopToolCallFallback`、`isSkillManageToolCall` + 对应的 ~30 个接口 | 900 |
| `agent-loop-executor-stream-chunks.ts` | 流块(2067–2451):`planAgentLoopProviderData`、`applyAgentLoopProviderDataWithAdapters`、`applyAgentLoopTurnStartWithAdapters`、`applyAgentLoopStreamChunkWithAdapters`(201 行的分发)、`executeAgentLoopStreamLifecycleWithAdapters`、`applyAgentLoopText / ReasoningChunkWithAdapters` + 接口 | 550 |
| `agent-loop-executor-finish.ts` | 收尾(1139–1353 与 2612–2738):`createAgentLoopAssistantMessage`、`createAgentLoopNextAssistantWriterPlan`、`buildAgentLoopFinalMessageUpdate`、`finalizeLingeringAgentLoopToolWork`、`emitAgentLoopFinalMessageUpdateWithAdapters`、`completeAgentLoopStreamWithAdapters`、`planAgentLoopFinishChunk`、`applyAgentLoopFinishChunkWithAdapters`、用量 / 收尾计划接口 | 500 |
| `agent-loop-executor-post-response.ts` | 回复后钩子(2453–2610,今天就是一个独立连通块 264 行):`enabledToolNames`、`lastUserMessageText`、`buildAgentLoopPostResponseContexts`、`runAgentLoopPostResponseHooksWithAdapters` + 7 个接口 | 300 |

每个接口跟着**吃它的函数**走;只有被两处以上吃的(回合状态、store / emitter 端口)进 `-turn-state.ts`。2677–2684 行那段 `export … from` 转交随内容走。入口 `agent-loop.ts` 两段转交改成六段,**入口交出的名字集合一字不变**(`entry:gate` / R6 的证据)。测试按 N6 拆成六只,断言一字不动、只重算相对路径(D48 口径)。**标识符一个不改名**:`Core*` 前缀留着,N2 管的是文件名,改名与搬家分开(D89)。风险:无闭包、无模块 `let`、无 `vi.mock`,能过 `split:prove`。

**`session/session-store-helpers.ts`(1260 行)**。96 个导出、12 个互不引用的块、非测试引用 9 处、`vi.mock` 0、`session:gate` 名单上没有它(名单按文件路径,`RULE_A/B/C_ALLOWED`,它不在)。最大那块(642 行、48 个声明)经 `CoreSessionMeta` 这个形状连在一起,打开看是四件事:元数据与字段设置、详情投影、用量折叠、建 / 删会话。名字是 N4 的坏味(`helpers`),拆开顺手改成内容名(都查过,不撞已有文件):

| 新文件 | 内容 | 约行 |
| --- | --- | --- |
| `session-meta.ts` | `CoreSessionMeta`(52 行)与索引元数据:`findSessionMeta`、`prependSessionMeta`、`updateSessionIndexMeta`、`applySessionIndexMetaMutationWithAdapters`、`applySessionUpdatedAtToMeta`、`applySessionMessageAppendToMeta`;列表投影与预览(583–670:`deriveSessionLastMessagePreview`、`applySessionListProjectionToMeta`);字段设置器 `applySessionName / Pin / ArchiveState / PermissionMode / WorkingDirectory(Roots) / PromptContext / Summary / Model / Agent`、`applyInheritedSessionWorkingDirectory`、`normalizeSessionVariables` / `applySessionVariables`(变量也是会话字段)、`extractSessionMeta`(42 行)、`applyDefaultAgentIdToSessionMetas` | 420 |
| `session-load.ts` | 带适配器的装载与同步(今天的 156 + 52 + 26 行三个块):`loadSessionWithAdapters`、`CoreSessionCacheAdapter`、`normalizeWorkingDirectoryRoots`、`applySessionMetadataMutationWithAdapters`、`applySessionSideEffectMutationWithAdapters`、`syncSessionSideEffectWithReadyAdapters` | 250 |
| `session-details.ts` | 详情投影:`CoreSessionDetails*`、`mergeSessionDetails`、`resolveSessionDetailsSnapshot`、`findLastPreviewableMessage`、`getDisplayContent`,以及 38 行的 `CoreSessionMessageWithId` 一家形状(它们被详情与装载共用;**不**并进 `session-message-shapes.ts`,那只在 `session:gate` 名单上) | 130 |
| `session-usage.ts`(**已有**,先读它的头;是同一件事就并进去,不是就叫 `session-usage-fold.ts`) | 用量折叠:`CoreSessionTokenUsage / LastTurnUsage / UsageFields / UsageSnapshot`、`hasSessionUsageDetails`、`applySessionTokenUsage`、`landSessionAccountUsage`、`applySessionContextSize`、`getSessionTokenUsageSnapshot`、`sumSessionMessageUsage`、`subtractSessionMessageUsage` | 150 |
| `session-create-delete.ts`(不叫 `-lifecycle`,`session-lifecycle.ts` 已有) | `createCoreSessionRecord`、`createCoreBranchSessionRecord`、`createSessionWithAdapters`、`createBranchSessionWithAdapters`、`collectChildSessionIds`、`collectSessionCascadeDeleteIds`、`planSessionCascadeDelete`、`deleteSessionWithAdapters` 与它们的选项形状 | 220 |

入口 `session.ts:274/329` 两段转交改五段,交出的名字集合不变。引它的 9 处非测试(`session-repository` 等)改路径。`session:check` 文件头提到「泛化的 store-helpers」是解释,不是名单。

**`agent-loop/agent-loop-runtime.ts`(1456 行)**。55 个类型 + 28 个函数;只有入口 `agent-loop.ts:187/207` 引它;`vi.mock` 0。四件事:

| 新文件 | 内容 |
| --- | --- |
| `agent-loop-runtime-preparation.ts` | 准备计划 + 提示词选项 + 工具计划 + 技能 + 直接工具(595–826,含今天独立的 95 行直接工具块、92 行技能块、53 行提示词块) |
| `agent-loop-runtime-budget.ts` | 上下文预算(828–941:`resolveAgentLoopContextBudgetValues / WithRegistry`、`clampAgentLoopRequestMaxTokens`、`providerReportedInputTokens`) |
| `agent-loop-runtime-compaction.ts` | 压缩(943–1193 + 类型 447–563:`planAgentLoopContextCompactPass`、`maybeCompactAgentLoopContextWithAdapters` 148 行、事件计划) |
| `agent-loop-runtime-turn.ts` | 回合前后 + 待注入消息 + 瞬态尾块(1195–1456) |

共用的 `CoreAgentLoopProviderConfig*` / `CoreAgentLoopRuntime*Like` 形状进 `-preparation.ts`(它们被准备计划定义)。

**`theme/theme-resolver.ts`(2480 行)**。77 个顶层声明是一个块(大家经 `resolvedMap` / `getResolvedThemeValue` 连着),所以形状 A 探不到,是形状「按内容分层」:词表 → 解析核 → 三条推导线。非测试引用 4 处(`theme.ts` 入口、`theme-css-mapper`、`theme-debug`、`theme-base46-parser`),`vi.mock` 0,6 只测试。

| 新文件 | 内容 | 约行 |
| --- | --- | --- |
| `theme-semantic-tokens.ts` | 45–340 + 445–551:`SEMANTIC_HIGHLIGHT_TOKENS`、`SEMANTIC_UI_TOKENS`(124 行)、`DEFAULT_HIGHLIGHT_ALIASES`、状态 / 中性色 token、fallback 路径表与默认值表、`Resolved*` 形状 | 420 |
| `theme-resolver.ts`(保留名) | 解析核:`resolveColorValue`、`flattenObject`、`resolveTheme`、`pickRootThemeTokenOverrides` / `seed…` / `apply…`、`buildResolvedMap`、`selectModeValue`、`resolveThemeDefinitionColors`、`getResolvedThemeValue`(344–430、859–1095) | 350 |
| `theme-color-semantics.ts` | 553–858:`applyThemeColorSemantics`(111 行)、`resolveThemeColorSemantics`、`resolveThemeColorScaleDiagnostics`、色阶生成 | 310 |
| `theme-ui-styles.ts` | 1095–1326 的 surface role 推导 + `fallbackUIStyle`(647 行 switch,原样)+ `resolveThemeUI`(2234–2370) | 1100 |
| `theme-highlight-styles.ts` | 1042–1083 + 1975–2227:`resolveHighlightStyle`、`fallbackHighlightStyle`、`readableSyntaxColor`、`ensureHighlightContrast`、`resolveThemeHighlights` | 300 |
| `theme-preview-colors.ts` | `extractPreviewColors`(105 行) | 110 |

依赖成 DAG:词表 ← 解析核 ← 语义 ← {UI 样式, 高亮, 预览}。几只今天私有的 helper(`getResolvedThemeValue`、`firstSolidColor`、`onSolidColor`、`contrastForColor`)要加 `export` 给兄弟用 —— 功能内部兄弟互引,不经入口,合规。`theme-ui-styles.ts` 仍 1100 行,但那 647 行是一张表(1.2 第 3 条),不再往下拆。使用者改路径(22 个导出里非测试用到 13 个):`theme-css-mapper`(三张 token 表 + `ResolvedHighlightStyle / ResolvedUIStyle / ThemeNeutralColorToken` → `-semantic-tokens`)、`theme-debug`(`ResolvedUIStyle` → `-semantic-tokens`)、`theme-base46-parser`(`selectPrimary / StatusColorSemantics` → `-color-semantics`)、入口 `theme.ts:23` 一段转交改成五段(`resolveTheme` 留原名文件,`resolveThemeColorScaleDiagnostics` → `-color-semantics`,`resolveThemeUI` → `-ui-styles`,`resolveThemeHighlights` → `-highlight-styles`,`extractPreviewColors` → `-preview-colors`),入口交出的名字不变;6 只测试只用 `resolveTheme / resolveThemeUI / resolveThemeHighlights / resolveThemeColorSemantics / extractPreviewColors / SURFACE_GUARD_MIN_DELTA_L / THEME_STATUS_COLOR_TOKENS`,按新住处重算路径,断言不动。

**`theme/theme-role-mapping.ts`(1193 行)**。两件事:纯颜色数学(223–445:`parseCssColor`、`compositeColor`、`relativeLuminance`、`contrastRatio`、`mixCssColors`、`readableAgainst` … 约 230 行,`theme-resolver` 也在用)与角色推导(`deriveSurfaceRoles` 101 行、`deriveNeutralTextRamp`、`deriveStateOverlays` …)。拆出 `theme-color-math.ts`,角色推导留在原名。非测试引用 3 处、`vi.mock` 0。

**`engine/engine-agent-loop-stream-runtime.ts`(1424 行)**。`OnethingAgentLoopRuntimeAdapters`(131 行)、`OnethingAgentLoopRuntimeHostAdapters`(122 行)、`createOnethingAgentLoopRuntimeAdapters`(104 行)是「适配器长什么样、怎么造」,543 行的 `buildOnethingAgentLoopStreamRuntime` 是「十二槽按什么顺序装」。拆出 `engine-agent-loop-runtime-adapters.ts`(~360 行);装配函数不拆(1.2 第 2 条)。

### 2.2 批 2:闭包变量变上下文对象、模块替身要核对

**`plugin/plugin-api-builder.ts`(1982 行)**。`createCorePluginAPI` 一只 1540 行闭包建一个 34 格的 `api` 对象;闭包里共享的只有 `reportFailure / reportSuccess / requireStorage / requireMessageState / requireFiles / withStorageFailureReport / rejectDisposedWrite / rejectLateCall / requireSessionsPeek / state` 和一个 `let lateWarned`;对象里 `api.` 自引用 4 处**全在注释里**;测试只对 `api.llm` 查过 `Object.keys`。非测试引用 1 处(`plugin-api.ts`),19 只测试,`package.json` 有深键 `./plugin/plugin-api-builder`(**文件名与导出不动**)。按面拆:

| 新文件 | 格子 | 约行 |
| --- | --- | --- |
| `plugin-api-context.ts` | 上面那串共享 helper + `lateWarned` 做成 `PluginApiBuildContext`(运行期的东西) | 130 |
| `plugin-api-types.ts`(**已有**,763 行的插件形状) | `CorePluginAPIHost`(187 行)与 `CreateCorePluginAPIOptions`(87 行)两个形状并进去 —— 形状住形状的地方,不另开第三只 | +274 |
| `plugin-api-build-capabilities.ts` | `registerTool`、`on`、`registerCommand`、`registerPromptContextProvider`、`beforeContextCompact`、`afterAssistantResponse`、三个 `intercept*`、`registerSkillRoot`、`registerRequestHandler`、`scheduler` | 220 |
| `plugin-api-build-sessions.ts` | `steer`、`followUp`、`sendMessage`(53)、`sessions`、`isIdle`、`llm`、`resources`(94) | 230 |
| `plugin-api-build-ui.ts` | `registerWorkspacePanel`(77)、`registerUiSlot`(95)、`status`、`theme`、`ui`、`events` | 300 |
| `plugin-api-build-storage.ts` | `storage`(111)、`store`、`settings` | 140 |
| `plugin-api-build-registries.ts` | `registerIMConnector`、`registerSearchProvider`、`registerDeepLinkAction`、`registerCredentialStrategy` | 230 |
| `plugin-api-builder.ts`(保留名) | `executeCorePluginTool` + `createCorePluginAPI` = 建上下文、调六个建造件、`{ id, ...a, ...b }`、冻结 | 120 |

风险:键的**插入顺序**随拼装顺序走 —— 按今天对象里的顺序拼就一样;`plugin-freeze` 冻结的是拼好的对象,不变。不能过 `split:prove`(闭包 → 参数),靠 19 只测试 + CI 的 teardown 测试。

**`session/session-store.ts`(1365 行)**。门面,79 只函数,66 个导出;一个模块 `let sessionWorkdirBackfilled`;非测试引用 13 处,其中 `session-layer` / `session-caller-ops` / `session-reads` 用 **`import * as store` 整模块**;**35 处 `vi.mock`** 用工厂替身整模块(多数只给 `getSession / getSessionsList / createSession / updateSessionAgent / resolveSessionSpaceId` 几只)。能拆的只有一块:**消息更新**(1041–1279,18 只 `updateMessage* / addMessage* / updateStepsUsageByTurn`,约 250 行,今天 `updateStepsUsageByTurn` 已是独立块)→ `session-store-messages.ts`。做之前跑一只清单脚本,对每处 `vi.mock`算两个集合:(搬走的名字 ∩ 工厂给的名字)—— 非空就得给新路径也打替身;(搬走的名字 ∩ 被测代码可达的名字)—— 工厂没给又可达的,从前就会在 vitest 里抛「没有这个导出」,所以今天就没人调,安全。三处 `import * as` 要改路径。`assembly:gate` 基线那一行(`session-store.ts 1`)不变,因为 `let` 不搬。

### 2.3 批 3:要先设计端口,再拆

**`collab/actors/collab-actors-runtime.ts`(2072 行)**。模块单例 `let state`(43 处读)+ `booting` + `eventOrdinal`;约 70 只函数。看起来能搬的是四个 host 适配器(`roomHost(runtime)` 49、`agentHost(runtime)` 45、`refereeHost(getRuntime)` 50、`boardPort(runtime)` + `handleBoardEvent` 36 + 36,连同 `buildV3RoomContext` / `formatV3SteerBody` / `takeCollabV3AdoptedEcho`,1601–2000 约 400 行),它们按参数拿 `runtime`;**但查过它们调什么**:`roomHost` 调 `roomMembersOf / roomOverBudget / budgetCell / budgetLimitOf / roomHasReferee / scheduleJudgment / ensureAgent`,`agentHost` 调 `postToRoom`,`handleBoardEvent` 调 `runtimeAccepting / postToAgent / postToRoom` —— 这些都是读模块单例(或缺省 `runtime = state`)的同文件函数。直接搬 = 新文件引回运行时文件、运行时文件(`boot`)又引新文件,一只不经入口的兄弟环(`cycle:gate` 只打不判),而且单例的读者散到两只文件。所以不是机械搬:要先把这七八只 helper 改成按参数拿 `runtime`、或把它们做成 host 向外要的端口,再搬。`assembly:gate` 基线行 `collab-actors-runtime.ts 3` 届时不变(三个 `let` 不动)。非测试引用 3 处(`collab-room-config`、`collab-rooms` 入口转交、`collab-actors-stop-door`)、`vi.mock` 0、有深键 `./collab/actors/collab-actors-runtime`(名字与导出不动)。没有真机门,靠四只生命周期测试。

**`agent-loop/agent-loop-stream-engine.ts`(2198 行)**。`CoreStreamEngine` 1771 行、63 个方法、12 个字段;按共享字段分组:主体(五个 `perform*`:send 206 / edit 105 / retry 110 / resume 122 / compact 73,共用 `activeStreams / sessionChannels / steeringQueues / followUpQueues`)、**标题生成**(`generateAndApplySessionTitle` 50 + `generateSessionTitle` 52,只碰 `sessionTitleGenerations / titleGenerationSeq`)、**压缩闸**(`maybeCompactBeforeSend` 163 + `openCompactionGate` 17 + `waitForCompactionIdle` 31 + `runContextCompact` 53,只碰 `activeCompactions / compactionGates`)、**服务商解析**(`resolveProvider` 11 + `resolveProviderOrFailure` 66 + `failRunWithProviderError` 54)。子类 `engine-stream-dispatcher.ts` 从基类调的只有 `assertAccepting / authorizeExecution / bindCommandTarget / emitStreamError / hasCommandTarget / trackSessionExecution / withAgentModelBinding`,两只测试子类只调 `authorizeExecution / registerController / removeController / trackSessionExecution` —— **三组都不在子类合同里**,拆成协作件不改合同。做法:标题生成**并进已有的 `agent-loop-title.ts`**(65 行,今天就是标题的纯函数 `generateTitleFromMessage / normalizeSessionTitle / canApplyGeneratedSessionTitle`,引擎已经引它 —— 不开第二只标题文件);压缩闸叫 `agent-loop-compaction-gate.ts`(与已有的 `agent-loop-context-compact.ts` 是两件事:那只 995 行是压缩**算法**,闸是「同一会话不并发压缩、发送前等闸」的调度状态;批 1 的 `agent-loop-runtime-compaction.ts` 是第三个面:带适配器的压缩**驱动**。三只文件头各写一句说明彼此关系);服务商解析叫 `agent-loop-provider-resolution.ts`。各一只类或工厂,基类持有实例;46–427 行那 250 行接口可先机械搬到 `agent-loop-stream-engine-types.ts`(批 1 可顺手做)。五个命令不拆:它们是一台状态机。预计 1771 → ~1200。

**`acp/acp-client.ts`(2007 行)**。`ACPClient` 1548 行、79 个方法、28 个字段,77 个方法连成一组(连接 ↔ 会话记录 ↔ 提示流互相调)。12 只测试直接 `new ACPClient`,**没有一处**用 `as any` 碰私有成员。唯一独立的面是给 SDK 的 **Client 回调**(1627–1930:`createClientApp`、`requestPermission` 36、`buildPermissionContext` 31、`createElicitation`、`readTextFile / writeTextFile`、六只 terminal 桥接,约 300 行),它们经接口被 SDK 调用,拆成 `acp-client-app.ts`(拿一个窄端口:查会话、promptContexts、terminalBridge)行为不变。连接 / 会话 / 提示那台状态机不拆。另可机械搬:`BoundedAsyncQueue`(60 行)与 140–232 的错误分类函数 → `acp-client-errors.ts`。真机门 `gate:acp` ①–④ 是它的证据。

**`music/music-radio.ts`(1940 行)**。`createRadioScope` 1803 行闭包;7 个 `let` 把嵌套函数分成:`radioStore / conductor`(人人用)、`gestureStart`(计时)、`currentLyrics`(歌词段 1620–1717,连 `lyricCache / lyricInflight`)、`lastObservedTitle / identifiedCurrent / lastWatchedSample`(反向识别段 1717–1810,`likeCurrentSong` 也读 `identifiedCurrent`)。文件自己的分节注释已经把它分成七段。先拆两段 `let` 自成一组的:`music-radio-lyrics.ts`(`createRadioLyrics(ports)`)、`music-radio-identify-watch.ts`;DJ 会话段(239–770 约 550 行)与播放段(`playProgrammeEntry` 216 行)留到有真机门再说。`vi.mock('@onething/backend/music/music-radio')` 两处整模块替身 + 深键 → **文件名与 24 个导出一个不动**,只动内部。没有真机门是它排在批 3 的原因。

### 2.4 不拆(与原因)

- `collab/actors/collab-actors-room-rules.ts`:房账 reducer。`grantFloor` 238 行里 9 个局部 `let` 全在同一次裁决里;文件头就是规则正本。拆开 = 两只文件各半张账。
- `backend.ts`:`assembleSteps` 745 行、80 条 `own()`,顺序是产品规格;前面已经拆过 `backend-assemble-engine.ts` / `-host-ports.ts` / `-shutdown.ts`,剩下的就是顺序本身。
- `session-repository`、`search-index-sqlite`、`session-event-log`、`plugin-manager-base`、`provider-openai-responses-wire`、`music-resource-spec`、`engine-agent-loop-executor`、`engine-stream-session-event-recorder`:一只类 / 一本账 / 一张表 / 一只编排函数(1.2)。
- 可拆但不进这三批:`agent-loop-tool-orchestration`(MCP 权限计划 62 行是独立块,可出 `agent-loop-mcp-permission-plan.ts`)、`skill-review-core`(45 行的转录块)、`provider-model-registry`(models.dev 抓取 vs 能力查询)、`settings-factory-defaults`(默认表 vs 归一化函数)、`credentials-pool`(2 个模块 `let`,61 个导出)—— 收益小于一次全量 vitest 的成本,等形状 A 的门红了再动。

## 3. 顺序、批次、验收

| 批 | 内容 | 为什么先 | 交卷条件 |
| --- | --- | --- | --- |
| **1** | executor 六只、runtime 四只、store-helpers 五只、theme-resolver 六只、theme-color-math、engine 适配器半只、stream-engine 类型外移 | 可读性收益最大(三只最大文件),风险最小:纯函数,无闭包无模块态无 `vi.mock`,能过 `split:prove` | `split:prove` 每只通过;`typecheck`;全量 `vitest`;`boundary:gate` / `entry:gate` / `cycle:gate`(**并读它打出的深层环**,兄弟互引可能造出不经入口的环,门只打不判)/ `layer:gate` / `name:gate` / `assembly:gate` / `import-side-effect-free.test`;agent-loop 两家额外跑 `sessions:shadow-battery`(真 server 跑场景矩阵、每次 run 末重折账本,mismatch = 0)+ `sessions:hydration-contract`;theme 以 `theme-gallery-regression` 与 `builtin-theme-contrast` 两只金样为准(theme 没有真机门,如实写) |
| **2** | plugin-api 按面拆、session-store 消息块 | 闭包变参数、模块替身要核对,行为由构造保证、靠测试证明 | 批 1 全部 + plugin 19 只套件与 CI teardown 测试;session-store 先出 `vi.mock` 清单(2.2),再 `session:gate`(硬闸)/ `sessions:verify` / `sessions:events-selfcheck` |
| **3** | stream-engine 三协作件、acp 回调面、collab host 适配器、music 两段 | 要先定端口;有真机门的先做(acp 有 `gate:acp`,engine 有 shadow-battery),collab 与 music 没有 | 批 1 全部 + `gate:acp` ①–④;engine 走 `sessions:shadow-battery` + `context-compact-gate.test` / `context-compact-progress.test`;collab 四只生命周期测试(`collab-actor-open-lifecycle`、`collab-mailbox-failure-lifecycle`、`runtime-wiring`、`room-config`);music 只有四只单测(`radio-host / radio-talk / radio-authorization / music-radio`),所以放最后、可不做 |

通则:每批一个提交,**搬家不改名**(标识符不动,文件名按 N2 起),测试随函数走(N6),入口交出的名字集合逐批对比相同。决策行可补 D224(判据与门)、D225(批 1 名单)、D226(批 2 / 3 条件)。

## 4. 给用户的决策与理由

先说哪些**不拆**。`backend.ts` 的装配函数 745 行、协作房间的规则文件 1431 行、会话仓那只类 1043 行,这几只再长也是一件事:一个是启动顺序本身(顺序就是产品规格,拆到几只文件里顺序就看不见了),一个是一本账的全部规则(每条规则都读同一份账,拆开要翻两只文件才看得懂一次状态变化),一个是一份缓存加一条写队列。所以我不用「超过多少行就拆」做门 —— 它会把这些误伤。

拆的判据是**一只文件里有没有住着几件互不相干的事**:把文件里的函数和类型当点、谁用谁当线,连不到一起的就是不同的事;第二件事超过 150 行就该分家。这一条做成门(`split:gate`),今天按它红两只。另外两种形状 —— 一只很长的函数里几组嵌套函数各管各的变量、一只类里几组方法各管各的字段 —— 脚本能探出来,但拆出来叫什么、向外要什么,要人定,所以只做评审规则不做门。

要拆的分三批。**第一批**是纯搬家:`agent-loop-executor`(2738 行,74 个接口和 52 个函数,其实是六件事:工具步骤、流块、收尾、回复后钩子、内容部件、回合状态)、`agent-loop-runtime`(四件事)、`session-store-helpers`(12 块互不相干,名字还叫 helpers)、`theme-resolver`(词表、解析核、色彩语义、UI 样式、高亮、预览六层)。这些都是纯函数:没有闭包(闭包 = 一只函数把自己里面的变量借给里面的小函数共用,拆开就得把那些变量显式递过去)、没有模块级状态(文件顶层的 `let`,整个进程共一份)、没有被测试整模块替身(`vi.mock` 按文件路径把整只文件换成假的,函数搬了家替身就打不到了),所以能用一只脚本证明「每个函数一字未改、只是搬了家」,再跑全量测试与现有结构门。**第二批**要把闭包里的共享变量变成一个上下文对象(插件 API 建造器按面拆成六只),或者先核对 35 处整模块替身(会话仓门面只拆出消息更新那块);行为由构造保证,靠测试证明。**第三批**要先设计端口(端口 = 拆出去的那块向外要的那几个函数,写成一个接口):引擎那只 1771 行的类里标题生成、压缩闸、服务商解析三组方法各管各的字段,可以拆成三个协作件(协作件 = 从类里拆出去、由类持有并调用的小对象)而五个命令留在类里;ACP 客户端只拆给 SDK 的回调面,状态机不动;协作运行时的四个 host 适配器看起来按参数拿运行时,查下去它们调的七八只函数都读模块单例,直接搬会造出一只兄弟环,所以也要先改参数再搬;电台只拆歌词和反向识别两段。第三批里有真机门的(ACP、引擎)先做,没有的(协作、电台)最后、可不做。

每一批都遵守已经立下的规矩:搬家不改名、测试随函数走、入口交出的名字集合逐批对比相同、`cycle:gate` 打出的深层环要读一遍。

## 附:脚本

- `s37-fable/analyze.mjs <文件…>`:顶层声明表、连通块(叶子常量不连边)、类成员按共享字段分组。
- `s37-fable/inner.mjs <文件> <函数|类>`:类方法表(含 `this.x()` 调用)、函数体一级语句与嵌套函数。
- `s37-fable/uses.mjs importers <文件>` / `nested <文件> <函数>` / `objkeys …`:谁引、引了什么名字、`vi.mock` 在哪;闭包内嵌套函数读写了哪些 `let`。

## 实施结果(s38,2026-10-04,未提交)

决策 D229–D236(`backend-structure-decisions-2026-10.md`),落地记录同见 `server-client-split-2026-10.md` §6。

1. **工具**:`split:prove`(`scripts/split-prove.mjs`,拆前从 git 取、拆后从工作树取,逐条顶层声明的源文本多重集相等)与形状 A 门 `cohesion:gate`
   (`scripts/file-cohesion-gate.mjs`,判据与 s37 `analyze.mjs` 逐条一致;`cohesion:check` 块表、`cohesion:report` 形状 B / C 报表只报不判),进 CI。
   立门读数 6 不是 2:另 4 只 1000 行以下的文件同样命中,记进只减名单 `docs/audit/cohesion-baseline-2026-10.txt`,待裁(D229)。
2. **批 1 五只纯搬家**(每只 `split:prove` 逐字相同,入口交出的名字 agent-loop 311 / theme 32 / engine 26 与改前逐个相同,标识符一个没改):
   `agent-loop-executor` → 六只(135 条,D230);`agent-loop-runtime` → 四只(84 条,D231);`session-store-helpers` → `session-meta` / `-load` / `-details` /
   `-usage-fold` / `-create-delete`(96 条,D232);`theme-resolver` → 六只(77 条)与 `theme-role-mapping` → 拆出 `theme-color-math`(80 条,D233);
   `engine-agent-loop-stream-runtime` → 拆出 `engine-agent-loop-runtime-adapters`(24 条,D234)。两只测试按 N6 随函数拆(executor 六只 26 条、runtime 四只 24 条,
   用例原文与 `describe` 标题不动)。`agent-loop-stream-engine` 的类型外移(文档写「批 1 可顺手做」)不在 D226 名单里,没做。
3. **两道缺门**(D228):`entry:gate` 加「主入口 `export *`」与「功能内非测试文件引自家主入口」两条。`export *`:session 20 / search 5 / markdown 2 条改具名、只交外面真用的
   (session 583 → 451、search 112 → 18、markdown 19 → 0),media 一条停下(与 `provider:gate` 冲突,要先改名),基线 `1 star:media` 只许减(D235)。
   自引入口:70 处里 45 处改引兄弟,25 处停下(eval 23 / session 1 / theme 1,会绕开测试替身或要改代码形状),基线 `self:` 三行只许减(D236)。自检 29 → 43 条。
4. CLAUDE.md §4 / §5 改掉「没有门」的两处、门表加 `cohesion:gate`;`feature-map` 重生成;代码注释里指向旧文件名的 29 处改成新住处。

**读数**:`cohesion:gate` 红 6 → 绿(0 只新命中,4 只在已知名单);`entry:gate` 非测试 0、测试 838 不变、`star:` 1、`self:` 25;`cycle:gate` 0 环,深层环仍是那 2 个;
layer / name / client-api / boundary / assembly / transport / provider / log / session 全绿。

**与本文不一致、要你看的地方**:① 1.3 节「今天只红两只」是只量了 1000 行以上文件的读数,扫全包是 6 只(D229);② `-tool-steps` 收下了工具执行的两只端口、
`session-meta` 收下了 `findLastPreviewableMessage` / `getDisplayContent`、theme 的真实依赖方向与 2.1 节的 DAG 相反的那一段(D230 / D232 / D233);
③ 形状 B / C 报表按「共用 `let` / 字段」机械分组,报不出 2.3 节点名的 `music-radio` 与 `CoreStreamEngine`(D229)。

**验收**(改前 `$S/s38-before/`、改后 `$S/s38-after/`,同一份脚本 `$S/s38-checks.sh`,沿用 s35 那套另加 theme 两只金样逐条与新门):三套 tsc 零错;
四个 bundle 全成,三份检索 Worker 与 ACP 桥字节数逐字节不变(server / CLI `search-worker.cjs` 1,276,540、桌面 1,275,004、`acp-mcp-bridge.cjs` 748,877),
主包变小(server 5,778,249 → 5,766,771、CLI 11,472,453 → 11,461,336,入口不再转交的名字);全量 vitest 根 11,431 条、壳 7,344 条:壳失败集合相同;根第一轮比改前多
6 条(`plugin/event-routing` 5 条 + `http-server-workspace-watch-ownership`「A shutdown」),单跑两遍 5 条全绿、只剩改前就红的「allowlist」一条,第二轮全量
失败集合 = 改前少一条(「A stop」那条负载抖动这次没红)—— 判为负载抖动;拆出来的十只测试零失败;`http-server/__tests__` + `apps/backend-server` 231 条逐条相同;
快照与 golden 的 sha 不变;`theme-gallery-regression` / `builtin-theme-contrast` 17 条逐条相同;persistence / import-side-effect-free + assembly-lifecycle 绿;
shadow-battery 与改前同一组红(appendFailures 8,refold mismatch 0);hydration(夹具与 battery 自留 store)0 失败;`gate:search-index` 与改前同三条红(⑤d ×2、⑤c);
`gate:acp` / `gate:web-shell` / `gate:client` / `gate:native` / `log:smoke` / `provider:drill` 绿;全部结构门绿(含新门 `cohesion:gate`,改前它是红的;
`session:check` 与改前同 4 条);CLI 与 server 能起;`gateway:start` 与改前一样因缺 `ONETHING_GATEWAY_RUNTIME_MODULE` exit 1、零写入。
别的会话的五只 `chat-*.ts` 零改动(改前、改后、跑期间 sha 都相同)。

## 实施结果(s39,2026-10-04,未提交):批 2 + 批 1 留下的几处

决策 D237–D241(`backend-structure-decisions-2026-10.md`),落地记录同见 `server-client-split-2026-10.md` §6。

1. **`session-store`**(D237):拆成门面 969 行 + `session-store-messages.ts` 295 行(十五个消息热写端口)+ `session-store-table.ts` 137 行(会话表持有器)。
   多出持有器一只是本文 2.2 节没算到的:端口读的 `sessionRepository()` 是门面私有的,留在门面里就是一对兄弟环。三只合起来 `split:prove` 93 条逐字相同
   (`split:prove` 看不见 `log` / `sessionRepository` 加了 `export`,如实记在 D237)。`vi.mock` 清单 35 处:搬走的名字 ∩ 工厂给的名字 = 0;
   2.2 节说的「三处 `import * as` 要改路径」实际 0 处(五只命名空间引用方都不用搬走的名字)。
2. **`plugin-api-builder`**(D238):1982 → 160 行,另出上下文一只(595 行,两个大形状原样搬来 + 上下文)与五只建造件(capabilities 292 / sessions 321 /
   ui 445 / storage 160 / registries 305)。两处偏离 2.2 节:两个大形状住上下文那只而不并进 `plugin-api-types.ts`(那只本来就在 cohesion 名单上,并进去是第三块);
   拼装按拆分前的键序逐格写出,不用 `{ id, ...a, ...b }`(键在原字面量里是交错排的,展开会改 `Object.keys(api)`)。证明:`split:prove` 只报 `createCorePluginAPI`
   一条变了;另一只脚本证 33 格方法正文、两只内嵌函数、上下文那一段各逐字出现一次;实跑比 34 格键序与嵌套对象的键序相同。
3. **cohesion 名单 4 只**(D239):`mcp-kernel-router`(→ 拆出 `mcp-kernel-tool-exposure.ts`,40 条逐字相同)与 `plugin-api-types`(→ 拆出 `plugin-manifest-types.ts`,
   28 条逐字相同)是两件事,拆开删行;`agent-loop-context-compact`(同一次压缩的几步,线在驱动 `engine-compact-session.ts` 里)与 `plugin-contract-panel`
   (节点形状与校验器是同一份协议,线是 `type` 字面量)暂留,理由写进名单文件头;判据不改。名单 4 → 2。
4. **media 的 `export *`**(D240):四个带服务商名的值(连同四个伴生形状)按内容改名(`generateImageViaImagesApi` 等),入口改具名、只交外面真用的 18 个名字;
   `provider:gate` 105 → 104 对(引擎那只文件不再点名);生图实现那只因用户可见的错误文本 `OpenAI image API error:` 仍在名单上(改它是改行为)。
5. **自引入口 25 处**(D241):theme 1(入口的定义原样搬进 `theme-catalog.ts`)、session 1、eval 23 —— 先把测试替身改打声明那个名字的兄弟文件(同一批 vi.fn,
   断言不动),再改引兄弟;eval 工作台不再递整个入口命名空间,改递一只只含它用到的 14 个函数的对象。`entry:gate` 规则①②改零基线硬闸,基线删 `self:` 三行与 `star:media`。

**读数**:`cohesion:gate` 已知名单 4 → 2;`entry:gate` 非测试 0、`export *` 0、自引入口 0(三条硬闸)、测试深层引用 838 不变;`provider:gate` 104;
`cycle:gate` 0 环、深层环 3 / 2 不变;其余结构门全绿。三份检索 Worker 与 ACP 桥每一步都逐字节不变。

验收与读数见 `server-client-split-2026-10.md` §6「大文件拆分批 2 + 批 1 留下的几处」。
