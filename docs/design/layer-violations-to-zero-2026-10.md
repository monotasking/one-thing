# 越层引用清零决策(s24,Fable,2026-10-04)— 只分析,未改代码

读数口径:`bun run layer:check` 今天 **48 条 / 26 对**(`scripts/lib/backend-structure.mjs` 的值引用图,1577 只非测试文件、4691 条值边、1986 条跨功能边);`cycle:gate` 今天 0 个入口环(深层环 3/2 不判)。
模拟器:`s24-fable/sim2.mjs`(读 `graph.json` = `buildValueGraph()` 落盘;场景 = 搬家 / 断边 / 加边 / 改层;搬出去的文件自动删掉老入口对它的再导出边;入口环按真门口径「原图 SCC 含入口」判)。HEAD 基线与真门逐数对上(48/26、入口环 0)。

**先撤一句话**:上次文档第 7 节「我按用户偏好推荐 F4(留 5 条已知例外)」作废。目标现在是 `layer:gate` 改成零基线硬闸,例外一条不留。

## 0. 一句话

26 对违例有三种病,不是一种:**(a)低层按能力枚举**(toolkit 列协作工具、agent 列协作地板、variable 写协作在场块、tool 列音乐 CLI)—— 改成「能力自己登记,低层读表」;**(b)叶子住错层**(会话种类的八个小判据住在 collab、辅助模型调用住在 engine、插件提示词源住在 prompt、执行器能力表住在 agent、access-control 住在 tool、事件发射器住在 event、技能复盘触发器住在 trigger)—— 把文件搬到它依赖的那一层;**(c)层次表判错**(headless 是装配配方、space 有自己的存储、trigger 根本不是基础件)—— 改表。全部做完:**违例 0 条 / 0 对,入口环 0,原图 SCC 仍是 3/2**;新建一个 L2 功能 `provider-call`,删一个 L0 行 `trigger`,改两行层次(`space` L1→L2、`headless` L3→L4)。

## 1. 逐对改法(26 对,按病因分组)

列的含义:**改法**(文件去哪 / 边怎么断);**性质**:机械 = 只搬文件改 import 路径,半机械 = 搬家 + 一处小接口(登记函数 / 钩子 / 构造参数),改接口 = 要动调用方签名;**行为**:可感知行为变化,要么写「无」加理由,要么写具体是什么;**装配顺序**:有变化才写。

### 1A. collab 簇(9 对 25 条:toolkit 12、external-agent 3、variable 3、agent 2、interaction / music / plugin / search / session 各 1)

collab 今天是三种东西挤在一个目录:协作的四只工具(住在 toolkit 里)、八个关于「这条会话是什么」的小判据(谁都要)、协调器本体(L3)。拆成三份,各去各层。

| # | 对 | 改法 | 性质 | 行为 | 装配顺序 |
| --- | --- | --- | --- | --- | --- |
| A1 | toolkit(L2) → collab(L3) 12 条 | **协作工具归 collab 自己,自注册进目录**(CLAUDE.md 09-02 立法:「能力自述、别人读表」;`toolkit-tier-catalogs.ts` 文件头写着同一条纪律,`registerFeatureTools` 就是现成样板)。搬:`toolkit/builtin/toolkit-builtin-{board,notebook,send-message,history}.ts` + `toolkit/families/toolkit-families-collab.ts` → `collab/tools/collab-tool-{board,notebook,send-message,history}.ts` + `collab/tools/collab-tool-family.ts`;`toolkit-adapters.ts` 里「协作」一段(`collabAdapters` / `sendMessageAdapters` / `boardAdapters` / `historyAdapters` / `notebookAdapters`)→ `collab/tools/collab-tool-adapters.ts`;新增 `collab/tools/collab-tool-registration.ts` 导出 `registerCollabTools(catalog, tier)`,`backend.ts` 在 `buildToolkitCatalog(tier)` 之后那一行调它。`toolkit.ts` 入口不再交出这四只工具与协作族;`CatalogAdapters` 去掉 `sendMessage` / `board` / `history` / `notebook` 四格;`toolkit-scene.ts` 的 `venue:` 改读 session(A2)。搬进 collab 的五只文件改经 `@onething/backend/toolkit` 入口拿契约与 `Catalog`,不走 `../toolkit-contract.js` 这种深层路(否则 entry:gate 对 toolkit 的只减不增会红) | 半机械 | **生产无变化,测试可见一处变化**。生产要钉两件事:① 三档的 id 集合逐字不变 —— 今天 full = 四只都有、headless = board / history / send_message(无 notebook)、readonly = 一只没有;`registerCollabTools` 收 `tier` 按这张表注册,表住在 collab 里(「我服务哪几档」是能力自述的一部分);`toolkit/__tests__/catalog-tiers.test.ts` 三个 id 集合不改,改成先 `registerCollabTools` 再比;② 注册**无条件**、不挂在 `collab: true` / 协调器启动上 —— server runtime 不开 collab,今天四只工具照样在目录里。测试可见的变化:`toolkit-wiring.ts` 的 `getOrBuildToolkitCatalog()` 在「宿主没走 `backend.ts`」时懒建 full 档,注释自己说真宿主不走这条路、**单测走**;登记挂在 `backend.ts`,懒建路上就没有四只协作工具。不把登记塞回 `buildToolkitCatalog`(那是 toolkit 重新认识 collab),而是让直接跑引擎、不经 `backend.ts` 的测试在 setup 里 `registerCollabTools(getOrBuildToolkitCatalog(), 'full')` —— 受影响的是 `collab/__tests__` 与 `engine/__tests__` 里断言协作工具在面上的集成用例,施工单跑一遍 vitest 点名 | 无:`buildToolkitCatalog` 与紧随其后的注册仍在缝 4,先于任何回合 |
| A2 | agent-profile-for-session / interaction / music / search / session-store / plugin-session-messenger / toolkit-scene → collab(各 1 条) | **会话种类的事实下沉到 session**。它们问的全是 `session.kind` / `session.room` / `session.collab` 这三个字段的含义,字段本身就在 session 的记录上,session-store 自己都在用(930 行 `stampTurnSource`)。搬:`collab/collab-venue.ts` → `session/session-venue.ts`(`resolveCollabVenue` / `collabVenueLinksRoom` / `collabVenueOf` / `collabVenueOfSession` / `collabLinkedRoomSessionId`,外加从 `collab-ingress.ts` 搬来的 `isCollabCoordinatorDrivenSession`);`collab/collab-dm.ts` → `session/session-dm-room.ts`(`isUserDmRoom` / `isAgentPairDmRoom`);`collab/collab-visibility.ts` → `session/session-room-visibility.ts`(`collabRoomVisibleUntil` / `isCollabMessageVisible`);`collab-classify.ts` 里七个 `COLLAB_*_SOURCE` 常量 → `session/session-message-source.ts`(谓词留 collab,改引 session)。**不下沉的**:`collab-tool-surface.ts` 的 `COLLAB_TOOL_VENUES` / `isCollabToolAllowedInVenue` / `COLLAB_*_TOOLS` 与 `collab-venue.ts` 的 `collabToolAllowedInSession` —— 「哪个协作工具在哪个场子成立」是工具的事,随 A1 进 `collab/tools/`。七个读者改引 `@onething/backend/session` 入口 | 半机械(`collab-venue.ts` 是**拆**不是搬:`collabToolAllowedInSession` 带着它依赖的场子门留在 collab,其余五个函数去 session;搬去的文件不许再引 `@onething/backend/session` 入口,改引兄弟文件) | **无**:每个函数逐字搬,「认不出的一律算 chat」「coordinator-driven 只认 room|agent」两个判据不合并(前者含 work,后者不含) | 无 |
| A3 | agent(L2) → collab(L3):`agent-profile.ts` 的 `AGENT_TOOL_GRANTS` 四行 `collab-room/dm/work/notebook` | **地板由 collab 登记**。`agent` 开 `registerAgentToolGrant(grant)`(表变成「内置行 + 登记行」,`AGENT_TOOL_GRANTS` 改成读表函数),新文件 `collab/tools/collab-agent-tool-grants.ts` 持这四行,`backend.ts` 在 A1 的注册旁边调一次 | 半机械 | **无**,条件是登记先于第一次 `resolveAgentProfileForSession` —— 装配期,先于窗口与回合;`agent/__tests__` 里直接读 `AGENT_TOOL_GRANTS` 的用例要在 setup 里登记 | 无(装配期多一行) |
| A4 | variable(L2) → collab(L3) 3 条:`agentSelfGateway` 的在场块(房 / 私聊 / 卡片,`variable-gateways.ts` 290–322 行) | **在场块由 collab 提供**。`variable` 开 `registerAgentPresenceSource(fn)`(没登记时在场块为空),那一段连同它要的 `getCollabSelfTaskFacts` / `resolveUserIdentity` / `isAgentPairDmRoom` 搬进 `collab/collab-variable-presence.ts`,`backend.ts` 登记。`resolveUserIdentity` 读 settings,反转后只剩 collab 与 engine 用它,不必搬 | 半机械 | **无**:同一段代码换了住处;变量板的输出逐字不变 | 无 |
| A5 | external-agent(L2) → collab(L3) 3 条 | 三条三治:① `collabVenueOf` → 随 A2 改引 session;② `external-agent-host-mcp-tools.ts` 的第二道门(`isCollabToolAllowedInVenue` / `COLLAB_TOOL_VENUES`)改问**工具对象自己的 `visibleIn(scene)`**(经 toolkit 的目录拿工具)—— 已核对:`toolkit-families-collab.ts:86` 的 `visibleIn` 就是 `isCollabToolAllowedInVenue(this.venueTool, sceneVenue(scene))`,与 `COLLAB_TOOL_VENUES` 逐格同一张表,不是平行实现;③ `findCollabV3Turn`(牌位查询,注释自己说「取不到牌不是拒绝的理由」)改成端口:`external-agent` 开 `configureExternalAgentTurnLookup(fn)`,`backend-assemble-engine.ts`(今天就在那里给 collab 填五个端口)填 `findCollabV3Turn` | 半机械 | **无**:②两道门的判定逐格相同;③端口未填时返回 undefined,与今天「非 v3 路径取不到牌」同一分支,且装配先于任何外部 agent 回合 | 无 |

### 1B. engine 的「杂活回合」(4 对 4 条:pet / plugin / skill / toc → engine)+ F5 的最终决定

**决定:新建 L2 功能 `provider-call/`(「去调用服务商」,与 `provider/`「服务商是谁、怎么说话」正好一对;目录单数,过 N 规;不叫 llm、不叫 inference)。** 上次写的 `provider-calls` 按单数改。

为什么是功能而不是读 `backend-current` 槽:槽读法是给唯一实例用的(`getStreamEngine` 那种);这里是一组函数加工厂(拿一只可用的服务商实例、跑一次非流式对话、生成标题、解析鉴权),塞进槽里等于把依赖藏起来,「我要用小模型跑一句话去哪」就答不出来了。为什么不能留在 engine:闭包里一只 engine 的东西都没有 —— `utility-provider → process-providers → provider-factory → external-agent / auth / provider / media`,`chat-facade → acp / auth / settings / credentials`,全是 L2 材料,engine 只是收留它们(D24 那一笔把它们从 providers 搬出来时,engine 是当时唯一不成环的落点)。

| # | 对 | 改法 | 性质 | 行为 | 装配顺序 |
| --- | --- | --- | --- | --- | --- |
| B1 | pet / plugin / skill / toc(L2) → engine(L3) | 搬九只:`engine/engine-{utility-provider,chat-facade,process-providers,provider-factory,openai-compatible-fetch,agent-runtime,media-reader}.ts` + `engine/stream/engine-stream-provider-helpers.ts` → `provider-call/provider-call-{utility,chat,process-providers,factory,openai-compatible-fetch,agent-runtime,media-reader,auth}.ts`,入口 `provider-call/provider-call.ts`(N3 形状,具名导出);`engine/engine-auxiliary-model-checkpoint.ts`(辅助模型的意图 / 结果账,只引 session 与 agent-loop)→ `session/session-auxiliary-model-checkpoint.ts`,由 session 入口交出,**它自己改引兄弟文件**,不许引 `@onething/backend/session` 入口(模拟里不改这一条就是一个 2 只的入口环)。四个读者与 engine 内部六个读者改引 `@onething/backend/provider-call`;`engine.ts` 入口不再交出这些名字。层次表登记 `provider-call: L2, why: 去调用服务商:把设置与凭证变成一只可用的服务商实例,跑一次对话 / 生成标题,以及辅助模型要的鉴权解析` | 机械 | **无**:九只文件逐字搬;`configureAppProviderRegistry()` 这类幂等 latch 照旧挂在 `configureAppRuntimeAdapters()` | 无 |

### 1C. 其余 11 对(每对一行)

| # | 对 | 改法 | 性质 | 行为 | 装配顺序 |
| --- | --- | --- | --- | --- | --- |
| C1 | prompt(L1) → plugin(L2) 3 条 | `prompt/prompt-plugin-context.ts` + `prompt-plugin-context-breaker.ts` → `plugin/plugin-prompt-context.ts` + `plugin-prompt-context-breaker.ts`(它们是插件的提示词源,引插件契约与健康表是本分);`prompt-builder.ts:352` 的 `defaultOnethingPromptComposer` 不再内置 `new PluginPromptContextSource()`;`engine/prompt/engine-system-prompt.ts` 与 `gateway-channel-prompt-context.ts` 改引 plugin 入口 | 机械 | **无**:`defaultOnethingPromptComposer` 的生产调用方是**零**(全仓只有 `prompt/__tests__/prompt-fragments.test.ts` 与 `__tests__/fixtures/tool-prompts.ts`);`desktopPromptComposer` 本来就另装了一份带断路器的 `pluginPromptSource`。那两处测试若依赖默认 composer 里的插件源,改成显式加源 | 无 |
| C2 | provider(L1) → agent(L2) 2 条 | **两张执行器表并成一张,住 agent-loop**。`agent/executor/agent-executor-capabilities.ts`(零依赖纯表:local / acp 两条 + 未知外部执行器缺省)并进 `agent-loop/agent-loop-external-agent-providers.ts`(那里已有 `registerCoreProviderExecution` 登记表,条目形状从 `{kind, contextWindow}` 扩成完整描述符,加 `hostTools / steer / interrupt / persona`);`provider-config.ts` 的 `isExternalAgentExecutorProvider` 改问 agent-loop 的 `isCoreExternalAgentProvider`;`provider-external-agent.ts` 的 `findAgentExecutorDescriptor` 改引 agent-loop;`agent-executor-registry.ts` 末尾那句**加载期副作用** `syncAgentExecutorsToCore()` 删掉(表就在登记表旁边,没有东西要同步了)。已核对:agent-loop 的登记表今天只有缺省一行(local / ours,与 A 表的 local 行一致),`acp: external / theirs` 那一行完全靠加载期同步才存在 —— 并表之后它第一次有了常驻的家 | 机械 | **无**:判定读同一张表;删掉的同步函数的唯一作用就是把 A 表抄进 B 表。要钉一条:并表后任何在 `agent-executor-registry` 加载之前就问 `isCoreExternalAgentProvider('acp')` 的路径今天答 false、之后答 true —— 查无此路径(三处消费都在回合里),但施工单要写进测试 | 无(少一处 import 时副作用,与 `import-side-effect-free.test.ts` 同向) |
| C3 | space(L1) → project-dir(L2) | `SpacesStore.remove()` 第 116 行 `forgetProjectsStore(spaceId)` 改成删房钩子:`onSpaceRemoved(cb)`(与已有 `subscribe` 同形),`project-dir/project-dir-bootstrap.ts` 在 `bootstrapProjectDirs` 里订阅并把退订交给它返回的 disposer;钩子在 `this.notify()` 之前跑,位置与今天那一行相同。**同时 space 改判 L2**:它读写用户 store(`space-persistence`),与 L1「不读用户的存储」矛盾;唯一的低层引用者是 `provider-client-api.ts → space-types.ts`(第二入口,L4 槽位),改层零代价 | 半机械 | **无**:钩子同步、同位置;唯一差别是 `bootstrapProjectDirs` 之前删空间不会清 project-dirs —— 删空间是装配后的 RPC,到不了那个窗口。`space/__tests__` 里断言「删空间 → project-dirs 被清」的用例要在 setup 里订阅 | 无 |
| C4 | event(L1) → session(L2) | `event/event-only-emitter.ts` → `engine/engine-event-only-emitter.ts`。它写会话事件、记用量、引擎的 `StreamContext`,唯一读者是 `engine/stream/` 三只 | 机械 | 无 | 无 |
| C5 | feature-registry(L2) → http-server(L4) | `FeatureContextImpl.registerRpcDomain` 用的 `registerRouterHandlers` 改成**装配时交进来的闩**,不是构造参数 —— 已核对:`FeatureContextImpl` 是 `feature-registry-table.ts:80` 在 `mount` 时 `new` 的,表本身是模块级 `const mounted = new Map()`,根是 `feature-registry-cordis-root.ts:20` 的 `let root`,没有一个「建表」的调用点可以传参。改法:`feature-registry` 开 `configureFeatureRegistryRpc({ registerRouterHandlers })`(与 `configure*Host` 同形,存在一个 `const` 持有对象或挂在已有的 `root` 上,**不新增模块级 `let`** —— `assembly:gate` 只减不增),`backend.ts` 在装 http-server 之前调一次;未配置时 `registerRpcDomain` 抛「feature registry 未接 RPC」而不是静默吞。「加进 L0 槽位名单」这条路是关的:`http-server-dispatch-table.ts` 引 session 与 backend-current,不是槽位 | 半机械(一个 configure 闩) | **无**:今天 `mount` 也只在装配之后发生(自进化 feature 由 `backend.ts` 装) | 无(多一行,在 http-server 之前) |
| C6 | headless(L3) → 包根(L4) | 改表:`headless` → L4。`headless-backend.ts` 就是 CLI 守护进程那份装配配方(CLAUDE.md 宿主表的一行),没有任何功能引它(IN = 0),它引 `backend.ts` 是装配方引装配配方 | 改表 | 无 | 无 |
| C7 | tool(L1) → permission / session / settings / file / note 8 条(`access-control/` 两只) | `tool/access-control/tool-access-control-permission-policy.ts` → `permission/permission-policy.ts`(它就是 `decidePermission`:授权记录 + 无人值守 + 会话读面);`tool/access-control/tool-access-control-sandbox.ts` → `permission/permission-sandbox-roots.ts`(「工具可读可写哪些根」:设置里的缺省工作目录、接入目录、笔记根、输出目录;`configureSandboxHost` 宿主端口随它走,CLAUDE.md 宿主端口表 `sandbox` 那行的路径改)。九个读者(toolkit-authorizer / toolkit-runner-factory / toolkit-file-adapters / acp-request-authorize / variable-system / variable-gateways / file-client-api / backend.ts / backend-host-ports.ts)改引 `@onething/backend/permission` 入口。环检查:file / note / settings 的出边今天都没有 permission,搬进去不成环;session ↔ permission 的深层互引今天就在,不会更坏 | 机械 | 无 | 无 |
| C8 | tool(L1) → music(L2) | `tool-bash-classifier.ts:59` 加载期用 `builtinMusicProviders` 建的 `MUSIC_BASH_POLICIES` 改成登记表:classifier 开 `registerBashPolicy(binary, policy)`;music 新增 `registerMusicBashPolicies()`(照注释「ALL builtin policies」全量登记、不看 active provider),`backend.ts` 装 music 那一步调它 | 半机械 | **无**,条件是登记先于第一次 `classifyBashCommand` —— 分类只在工具执行时发生,装配之后;直接调 classifier 并断言 ncm-cli 归类的测试要先登记 | 无(装配期多一行) |
| C9 | trigger(L0) → agent-loop(L1) | `trigger/` 六只全是**技能复盘触发器的实现**(`trigger-skill-review.ts` 470 行,跑 agent loop),不是登记表(登记表 `TriggerManager` 住在 agent-loop),唯一读者是 skill。整目录并进 skill:`trigger-*.ts` → `skill/skill-review-*.ts`(与已有 `skill/skill-review-trigger.ts` 同一族名),`trigger.ts` 入口删;层次表删 `trigger` 行,`bun run feature-map` 重生成 | 机械 | 无 | 无 |

### 1D. 不必动、但顺手记下的

- `collab-actors-turn-context.ts` 已经是 `configure*Port` 形状,A5③ 给 external-agent 开端口与它同一风格,不是新发明。
- `resolveUserIdentity`(读 settings 的用户名 / handle)反转后只剩 collab 与 engine 两个 L3 读者,留在 collab 不动。

## 2. 模拟结果

| 场景 | 跨功能值边 | 低层引高层 | 入口环(真门口径) | 原图 SCC | 深层值引用(非测试) |
| --- | --- | --- | --- | --- | --- |
| HEAD | 1986 | **48 / 26 对** | 0 | 3/2 | 846 |
| 1A collab 簇 | 1990 | 23 / 17 | 0 | 3/2 | 847 |
| 1B provider-call | 1996 | 44 / 22 | 0 | 3/2 | 854 |
| C1 prompt | 1982 | 45 / 25 | 0 | 3/2 | 842 |
| C2 执行器表 | 1988 | 46 / 25 | 0 | 3/2 | 849 |
| C3 space | 1986 | 47 / 25 | 0 | 3/2 | 845 |
| C4 event | 1985 | 47 / 25 | 0 | 3/2 | 844 |
| C5 feature-registry | 1987 | 47 / 25 | 0 | 3/2 | 846 |
| C6 headless | 1986 | 47 / 25 | 0 | 3/2 | 846 |
| C7+C8 tool(含 permission 内两只改引兄弟) | 1983 | 39 / 20 | 0 | 3/2 | 844 |
| C9 trigger | 1985 | 47 / 25 | 0 | 3/2 | 846 |
| **全部叠加(文件照搬、读者路径照旧)** | 1994 | **0 / 0** | **0** | **3/2** | 849 |
| **全部叠加(读者改引新家入口)** | 1985 | **0 / 0** | **0** | **3/2** | **820** |

(全部十二行都是模拟器最终规则下的重跑读数,2026-10-04 收口前重生成;单场景行各自独立叠在 HEAD 上。)

模拟器后来加了一条通用规则(advisor 复核指出):**搬进新家的文件由新家入口交出(加「新入口 → 文件」边);它若引新家入口,改引兄弟文件(删「文件 → 新入口」边)**。表里的数都是这条规则生效后的。它抓出了三件施工时必撞的事:

- 自动改引兄弟文件 5 处:`toolkit-builtin-board` / `-send-message`(搬进 collab 后不能再引 `@onething/backend/collab`)、`collab-venue`(搬进 session 后不能再 `import * as store from '@onething/backend/session'`)、`engine-auxiliary-model-checkpoint`(同 session)、`tool-access-control-permission-policy`(搬进 permission 后不能再引 `@onething/backend/permission`)。
- **一个真环**:C7 做完、`permission.ts` 入口交出 `permission-policy` 之后,出现 5 只的入口环 `permission.ts → policy → with-grant-storage → grant-storage → permission.ts` —— 因为 permission 里**今天就有**两只文件(`permission-capabilities.ts` / `permission-grant-storage.ts`)引自家入口。它们改引兄弟文件(`permission-runtime.ts` 等)环就没了(模拟已证:0)。这不是 C7 的病,是全仓的一个潜伏习惯:**127 只功能内文件引自家入口**(collab 30+、toolkit 10+、skill / session / permission / plugin 各几只),每次把新文件交给入口都可能踩响其中一只。施工规矩加一条:搬进去的文件及其同目录的兄弟,凡引自家入口的一律改引兄弟。
- 单跑 1B 时那个 2 只环(session 入口 ↔ 记账文件)就是同一条规则抓的第一个样本。
- 「改道后含入口的 SCC」(把所有跨功能边改成走入口之后的强连通分量)HEAD 是 531 只一团,全部叠加后最大 116 —— 这是 entry:gate 清零之后才会变成红绿的指标,这里只作佐证:越层清零顺便把「将来走入口」的死结拆小了四倍多。

## 3. 对 `entry:gate`(深层引用)的影响与第 4 题

`bun run entry:check -- --list` 的 2296 是**引用点**数(含类型引用、含测试、含 apps/ 与 scripts/),按真门的 `measure()` 过滤:

- 2296 里 **非测试 1126**,测试 1170。非测试里 `packages/backend` 之外 50(`apps/desktop-react` 23、`apps/cli` 10、`scripts/*` 17)。
- 非测试按**被引功能**:logging 219、agent-loop 102、toolkit 88、tool 80、storage 54、event 51、agent 50、collab 47、space 34、plugin 33、auth 31、resource 30、permission 25、prompt 23、mcp 21、note 17、skill 16、usage 14、acp 13、external-agent 13。
- 按**引用方**:engine 110、包根 103、toolkit 87、provider 82、resource 73、session 68、plugin 59、collab 49、acp 47、http-server 33。
- 最大的几对:provider → agent-loop 61、toolkit → tool 46、resource → toolkit 42、session → logging 31、plugin → logging 26、collab → agent 21、engine → agent-loop 19、engine → logging 16、acp → logging 15、session → event 15、toolkit → collab 14、acp → toolkit 11、provider → auth 10、settings → space 10。

本方案对它的影响(模拟器的值边口径,两种读法都跑了):「文件照搬、读者 import 路径照旧」是 846 → 849(+3);加一条施工规矩 —— **搬进新家的文件由新家入口交出,所有跨功能读者改引入口**(`--via-entry`,29 处读者改路)—— 是 846 → **820(−26)**,按目标功能:collab 32→20、tool 64→57、agent-loop 30→31、permission 22→19、agent 46→43、prompt 10→7、event 14→12、session 3→5、toolkit 43→48(+5 是搬进 collab 的四只工具与族基类对 `toolkit-contract` / `toolkit-tool-protocol` 的深层引用,它们原来是功能内引用;改经 toolkit 入口即归零,施工单 5 的规矩里已写)。基线文件 `docs/audit/feature-entry-baseline-*.txt` 要重盖(D50 的口径:真降之后 `--write-baseline`;新功能 `provider-call` 要有一行)。

**下一步按功能收口的优先顺序**(判据:对可读性的影响 = 非测试深层引用数 × 引它的功能数,再扣掉「本来就是基础件、深层引用无害」的):

1. **logging(219)** —— `logging-configure.ts` 173(`getLogger` / `consolePort`)+ `logging-logger-primitives.ts` 44 + `logging-diagnostics.ts` 2。不是坏味道,是入口没交出这些名字(或交出了没人改)。一条 codemod:`@onething/backend/logging/logging-configure` → `@onething/backend/logging`。零风险,一次把总数砍五分之一。
2. **agent-loop(102)** —— 61 条来自 provider 引 `agent-loop-primitives`(循环原语、错误分类)。agent-loop 入口今天不交出原语(D50 留账),收口 = 入口交出 + codemod。先做这一家,provider 才算真正干净。
3. **toolkit(88)+ tool(80)** —— toolkit → tool 46 条是工具系统引自己的纯模块,resource → toolkit 42 条是资源面引工具协议。两家一起收:`toolkit` 入口交出协议与族基类,`tool` 入口交出纯模块;A1 之后 toolkit → collab 的 14 条自然消失。
4. **event(51)/ agent(50)/ collab(47)** —— session → event 15、collab → agent 21 是真耦合,收口要先看入口形状;collab 的 47 在 A1 / A2 做完会掉一半。
5. **storage(54)** —— 基础件,深层引用是 `storage-primitives`,与 logging 同治(入口交出 + codemod),排后是因为无害。
6. 其余(space 34、plugin 33、auth 31、resource 30、permission 25、prompt 23)各自一批,随各功能的收口单走。

## 4. 决策与理由(给用户)

**决定:按第 1 节的 26 条改法全部做,做完把 `layer:gate` 的基线文件删掉、改成零基线硬闸;新建 `provider-call/`,删 `trigger/`,`space` 改 L2、`headless` 改 L4。** 理由是四句话:

1. 这 26 对不是 26 个独立的毛病,是三种病。第一种是**低层按能力枚举**:工具目录里写死「协作有四只工具」、agent 档案里写死「协作房的地板是这几只」、变量系统里写死「协作的在场面长什么样」、bash 分类器里写死「音乐 CLI 的策略」。这正是 CLAUDE.md 09-02 立的那条法(「加功能不许改骨架」)要抓的东西:把骨架改成「能力自己登记、骨架读表」,collab 与 music 自己登记,toolkit / agent / variable / tool 再也不用认识它们。第二种是**叶子住错层**:「这条会话是房还是私聊」这种小判据住在协调器(collab)里,于是七个只想问一句话的功能都被迫引一台 L3 的机器;「拿一只小模型跑一句话」住在 engine 里,于是目录 / 技能 / 宠物 / 插件都得引引擎。把叶子搬到它依赖的那一层(session、provider-call、plugin、agent-loop、permission、engine、skill),引用方向自然就朝下了。第三种是**表判错了**:headless 是装配配方不是编排,space 读写用户 store 不是纯事实,trigger 根本不是登记表而是技能复盘的实现。改表不改代码。
2. 新建 `provider-call/` 是这里唯一新增的功能。上次我因为「用户不想新建」推荐留 5 条例外,现在撤回:目标是零基线硬闸,例外留一条就不是硬闸。名字过 R2 —— 目录里 `provider`(服务商是谁、怎么说话)与 `provider-call`(去调用服务商)并排,一眼分得开;「我要用小模型跑一句话去哪」一个目录答完。否掉的三条路写在下面。
3. **29 只文件搬家、7 处小接口(4 个登记函数 + 1 个钩子 + 1 个 configure 闩 + 1 个端口)、3 行改表、生产行为 0 条变化**。每一条的「行为无变化」都有条件,第 1 节逐条写了条件是什么、谁来钉(三档工具 id 集合的测试、地板表的测试、删空间的测试、bash 分类的测试);测试可见的变化只有一处(A1:不经 `backend.ts` 直接跑引擎的用例要自己登记协作工具),写在 A1 那行。装配顺序一处不动:新加的登记全部挂在 `backend.ts` 已有的步骤旁边,先于窗口与任何回合。
4. 模拟器(与真门同一份值引用图)说:全部做完 **违例 0 条 / 0 对、入口环 0、原图 SCC 与 HEAD 相同(3/2)**;深层引用按「搬进去的文件由新家入口交出」做是净减,不是净增。

**否掉的备选**:

- **把会话种类的八个判据做成新的 L1 功能 `room/`**(而不是进 session):模拟跑了(`sA2-room.json`),剩一条违例 `room(L1) → session(L2)` —— 因为那八个里有三个要按 sessionId 读会话仓(`collabVenueOfSession` / `collabLinkedRoomSessionId` / `isCollabCoordinatorDrivenSession`),它们天生是 session 的事。再拆成「纯形状判据进 room、读仓的进 session」就是把一句 if 拆到两个目录,读起来更差。字段在 session 的记录上,判据就住 session。
- **四个 L2 功能用端口收引擎的「小模型调用」**(不新建功能):四个端口装同一件东西,是按能力枚举的另一种写法,而且「拿小模型去哪」答案变成「某个装配处填的端口」。否。
- **读 `backend-current` 槽拿辅助模型**:槽是给唯一实例用的(引擎本体);一组函数加工厂塞进槽里是把依赖藏起来。否。
- **access-control 两只进 toolkit 而不是 permission**:toolkit 确实也引 settings / file,但 `decidePermission` 的三个读者里两个不是 toolkit(acp 的授权、变量系统的守卫),它的名字就是 permission 的名字。沙箱根那只跟着它走,因为「可读可写哪些根」是同一个问题的另一半。
- **协作工具留在 toolkit、只把 venue 判据下沉**:违例从 12 降到 0 要靠把 collab 的 7 只实现文件都当叶子引 —— toolkit 还是认识 collab。那是把枚举藏得更深,不是去掉枚举。否。
- **执行器能力表留在 agent、provider 用 manifest 自述「我是外部执行体」**:manifest 能答 `isExternalAgentExecutorProvider`,答不了 `persona` / `hostTools` 这些执行器的事;两张表并一张比一张表加一个 manifest 字段少一处要同步的地方。否。

## 5. 施工清单(给派工用,每单可独立交卷,顺序无依赖,只有 A1 与 A2 建议同批)

| 单 | 内容 | 搬 | 接口 | 违例降 | exports 键 / 仓外读者 | 门 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | C6 + C9 + space 改 L2(C3 的改表半边) | 6(trigger→skill) | 0 | 3(48→45) | 删 `./trigger` + 3 把 `./trigger/*` 键,加 skill 侧对应键;仓外读者无 | `feature-map` 重生成;`layer:check` 45 |
| 2 | C4 + C1 + C2 | 4 | 0(删一处加载期副作用) | 6(45→39) | `./event/event-only-emitter`、`./prompt/prompt-plugin-context-breaker` 两把键改路径;仓外读者无 | `import-side-effect-free` 仍绿;`layer:check` 39 |
| 3 | C7 + C8 + C5 + C3 的钩子半边 | 2 | 闩 1(C5)、登记 1(C8)、钩子 1(C3) | 10(39→29) | `./tool/access-control/*` 两把键改成 `./permission/*`;`packages/backend/__tests__/import-side-effect-free.test.ts` 引 `tool-access-control-sandbox`,路径改;permission 里两只改引兄弟文件 | CLAUDE.md 宿主端口表 `sandbox` 路径改;`layer:check` 29 |
| 4 | 1B provider-call | 9 | 0 | 4(29→25) | 加 `./provider-call`(+ 每个被 import 的子路径各一把);仓外读者无 | 层次表加 `provider-call` 行;entry 基线加一行;`layer:check` 25 |
| 5 | 1A A1 + A2 | 8 | 登记 1 | 19(25→6) | `./collab/collab-venue` 改成 `./session/session-venue`;仓外读者无 | `catalog-tiers.test.ts` 三集合不变;`layer:check` 6 |
| 6 | 1A A3 + A4 + A5 | 0 | 登记 2、端口 1 | 6(6→0) | 无 | `layer:gate` 改零基线,删基线文件 |

(3 + 6 + 10 + 4 + 19 + 6 = 48。单 1 把 space 改成 L2 之后,space → project-dir 当场不再是违例,所以单 3 的钩子不计数、但仍要做 —— 它是同层互引,入口无环门今天没抓到只因为两边都是深层引用。)

每单交卷标准:`bun run layer:check` 的数字与上表一致、`cycle:gate` 0、`entry:gate` 不红(基线按 D50 收紧)、`typecheck` 绿(缺 exports 键在这里红)、`vitest` 绿、`boundary:gate` 绿、`assembly:gate` 绿(单 3 的闩不许新增模块级 `let`)。

模拟器看不见的两样东西,每单自己查:`apps/`、`scripts/` 与根 `__tests__` 对搬家文件的直接 import(本次 29 只里只有一处:根测试 `import-side-effect-free.test.ts` 引 `tool-access-control-sandbox`),以及 `packages/backend/package.json` 的 exports 键(精确键、无通配,缺键在 typecheck 就红;本次涉及 8 把旧键 + `./trigger` 总桶键)。

## 6. 实施结果(逐单记录)

### 单 0:`assembly:gate` 转绿(2026-10-04,未提交)

- 红在 `music/music-radio.ts` 9 → 10。多出的那一个是 `playStartSounding`,b353c9fdd(09-27「电台开台后什么都不发生 + 开播时界面空白」)加的,那一笔没跑这道门。更深一层:这个文件的十个顶格 `let` 全是 `createRadioScope` 这一代作用域的**局部状态**(09-07 把模块包进作用域工厂时函数体没缩进),门按「顶格 let」把它们算成了模块级。
- 改法:同一台起播状态机的三格(`playStarting` / `playStartingEntry` / `playStartSounding`)收进一只 `const playStart = { inFlight, entry, sounding }`,四处写、两处读逐个改;行为逐字不变。顶格 `let` 10 → 7,基线那一行手改 9 → 7(没跑 `--write-baseline`:它会把 `github-copilot.ts` 1 → 0 等别处的真降一起扫进来)。决策 D127。
- 读数:`assembly:gate` ok(169 / 113 文件);layer 48 / 26、cycle 0、entry 2296、name 0、boundary 0 失败、node tsc 零错,与改前相同。

### 单 1:C6 + C9 + space 改 L2(2026-10-04,未提交)

- C9:`trigger/` 五只并进 skill —— `trigger-skill-review.ts` → `skill/skill-review-runner.ts`、`-core` / `-state` / `-state-core` → `skill/skill-review-{core,state,state-core}.ts`、`trigger-ipc-skill-review-state.ts` → `skill/skill-review-ipc-state.ts`(D128);入口 `trigger.ts` 删、目录删;`skill-review-trigger.ts` 的四处 `@onething/backend/trigger*` 改引兄弟文件(D126)。测它们的两只测试跟进 `skill/__tests__/`(`skill-review-core.test.ts`、`skill-review-ipc-state.test.ts`),`skill-review-trigger.test.ts` 的一处改相对路径。exports 删 `./trigger` 与三把 `./trigger/*`,不加键(D129)。`provider-vendor-baseline` 里 deepseek 那一对的路径随文件改(数不变);`probe-go-to-implementation.mjs` 一行路径。
- C6 / space:层次表 `headless` L3 → L4、`space` L1 → L2、删 `trigger` 行,why 跟着改(D134);`feature-map` 重生成。
- 读数:**`layer:check` 45 条 / 23 对**(与施工清单一致;消失的三对正是 `trigger → agent-loop`、`headless → (包根)`、`space → project-dir`),基线收紧;cycle 0(58 个入口);entry 2296 → 2292(`trigger` 一行 4 → 0,基线收紧);name 0;boundary 0 失败;assembly ok;node tsc 零错。

### 单 2:C4 + C1 + C2(2026-10-04,未提交)

- C4:`event/event-only-emitter.ts` → `engine/engine-event-only-emitter.ts`;engine 三个读者改引兄弟文件;发射器自己对引擎入口的类型引用改引兄弟、对 event 的两处改走 event 入口与已有的 `event-delta-stamp` 键(D130);测试 `skill-activation-landing.test.ts` 跟进 `engine/__tests__/`;删 `./event/event-only-emitter` 键。
- C1:`prompt/prompt-plugin-context{,-breaker}.ts` → `plugin/plugin-prompt-context{,-breaker}.ts`;prompt 入口不再转交;缺省 composer 去掉插件源。**第 1C 节「生产调用方是零」不对**:`backend.ts` 的提示词版本戳用的就是缺省 composer,所以它显式补 `.with(new PluginPromptContextSource())`,版本戳逐字不变(D131)。插件入口具名交出带断路器的那一版与源类,泛型那一半只经新键 `./plugin/plugin-prompt-context`(D132);两只只测泛型那一半的测试跟进 `plugin/__tests__/`,依赖缺省 composer 插件源的三处测试显式补源,网关测试改 mock 插件入口。
- C2:执行器表(local / acp + 未知外部执行器的保守缺省)与三个类型并进 `agent-loop/agent-loop-external-agent-providers.ts`,作内置行;`registerCoreProviderExecution` 签名不变、写登记行;`syncAgentExecutorsToCore()` 这句加载期副作用连同函数删除;`provider-config` 改问 agent-loop 的 `isExternalAgentExecutorId`、`provider-external-agent` 与 `external-agent-acp-connector` 改引 agent-loop(D133);删 `agent/executor/agent-executor-capabilities.ts`。补测试 `agent-loop/__tests__/agent-loop-external-agent-providers.test.ts`(只引 agent-loop:不加载 agent 也认得 acp)。
- 读数:**`layer:check` 39 条 / 20 对**(消失的三对:`event → session`、`prompt → plugin` 3 条、`provider → agent` 2 条),基线收紧;cycle 0;entry 2292 → 2279(agent 96 → 93、event 79 → 77、prompt 31 → 23,plugin 不涨,基线收紧);name 0;boundary 0 失败;assembly ok;`import-side-effect-free` + `assembly-lifecycle` 24 条全绿;node tsc 零错。

### 三单合起来的验收(改前 `s26-before` = 19ccea32c + 别的会话的未提交改动 / 改后 `s26-after`)

三套 tsc 零错;`server:build` / `build:cli` / 桌面四份 bundle / `web:build`(`node:` 命中 0)成功;全量 vitest 失败集合**逐行相同**(仓根 21 条、壳侧 1 条,都是改前就有的;搬家的五只测试按路径映射后用例名与结果逐条相同,新增一只 3 条全绿);vitest 快照文件 sha 改前改后与跑前跑后都不变;golden 命中集 sha 不变;persistence 19 文件 176 条全绿;shadow-battery 场景表逐行相同(改前就红在 `compact-half-run-log` 与 appendFailures 8,未变),refold 217 次 0 不一致;hydration 夹具店与新店各 217 会话 0 失败;`gate:acp` 109 条 ok 不变;`gate:search-index` ok / FAIL 结构逐行相同(改前就红的两条 ⑤d 未变,只有毫秒数不同);`gate:web-shell` 全绿;`gate:client` 两个运行时都绿;name / client-api / boundary(132 ok)/ transport / provider(105 对)/ log / session / native 不变,feature-map 66 → 65 行;`provider:drill` 改前改后同一处假红(脚本的 worktree 链接表还写着 D120 之前的 `client`,`@onething/backend-client` 解析不到),本地重放(链接表改成 `backend-client`、铺上工作区改动)全绿;CLI 与 server 能起。

### 单 3:C7 + C8 + C5 + C3 的钩子半边(2026-10-04,未提交)

- C7:`tool/access-control/` 两只 → `permission/permission-enforcement.ts`(方案写的 `permission-policy.ts` 已被内核那只占了,按内容叫执行面)与 `permission/permission-sandbox-roots.ts`(D135);permission 入口具名交出它们;九个读者改引 permission 入口;三只测试跟进 `permission/__tests__/`;exports 两把键换址,assembly 基线 sandbox 那一行换址,边界检查器两处换址,CLAUDE.md 宿主端口表 `sandbox` 一行改路径。第 2 节模拟器点名的环:`permission-capabilities.ts` / `permission-grant-storage.ts` 改引兄弟文件(D136),入口环 0。
- C8:分类器开 `registerBashPolicy`,音乐开 `registerMusicBashPolicies()`,在 `configureAppRuntimeAdapters()` 里调(D137);ncm 分类测试跟进 `music/__tests__/music-bash-policies.test.ts`。
- C5:`configureFeatureRegistryRpc({ registerRouterHandlers })` 闩,const 持有器,同样在 `configureAppRuntimeAdapters()` 里交;未配置即抛(D138)。三只直接挂 feature 的测试自己交。
- C3 钩子:`onSpaceRemoved` 模块级登记表,`bootstrapProjectDirs()` 订、disposer 退订(D139)。单 1 把 space 改成 L2 之后 `space → project-dir` 已不计数,所以这一半不改读数(施工清单的脚注说过)。
- 读数:**`layer:check` 29 条 / 13 对**(消失:`tool → permission` 4、`tool → file / music / note / session / settings` 各 1、`feature-registry → http-server` 1,共 10),基线收紧;cycle 0;entry 2279 → 2260(tool 111 → 97、permission 65 → 62、project-dir 16 → 15、music 15 → 14);name 0;boundary 0 失败;assembly ok;node tsc 零错。

### 单 4:1B 新功能 `provider-call/`(2026-10-04,未提交)

- 九只照方案搬:`provider-call/provider-call-{utility,chat,process-providers,factory,openai-compatible-fetch,agent-runtime,media-reader,auth}.ts` + 入口 `provider-call.ts`(具名导出 14 个名字,R3 文件头);`engine-auxiliary-model-checkpoint.ts` → `session/session-auxiliary-model-checkpoint.ts`,改引兄弟文件,由 session 入口交出(D140)。engine 入口不再交出这些名字;engine 内部 6 个读者与外面 10 个读者改引 provider-call / session 入口;exports 加 `./provider-call`;层次表加 `provider-call` L2 行(D142);三只测试跟进 `provider-call/__tests__/`,其余 20 只测试只改桩 / import 的路径;边界检查器的门面判据、`provider-vendor` 基线里 openai 那一对、CLAUDE.md 的服务商段与 engine 目录行换址。
- 读数:**`layer:check` 25 条 / 9 对**(消失:`pet / plugin / skill / toc → engine` 各 1),基线收紧;cycle 0(59 个入口);entry 2260 → 2275 —— `provider-call` 新行 34(全是测试对它内部文件的桩与引用)、`engine` 26 → 7(D141);name 0;boundary 0 失败;assembly ok(chat 门面那一个 `let` 换址);node tsc 零错。

### 单 3–4 合起来的验收(改前 `s26b-before` = 8c4b9413b + 别的会话的未提交改动 / 改后 `s26b-after`)

三套 tsc 零错;`server:build` / `build:cli` / 桌面四份 bundle / `web:build`(`node:` 命中 0)成功;全量 vitest 仓根失败集合与改前相比**只多一条** `file-workspace-watch-driver` 的「watches a real read-only directory…」—— 那是真文件系统监听的时序用例(改前就有同文件的另一条在红),单跑三次 18/18 全绿,判为抖动;壳侧逐行相同;搬家的七只测试按路径映射后用例名与结果逐条相同;快照与 golden sha 不变;persistence 176 条、side-effect + lifecycle 24 条全绿;shadow-battery 场景表逐行相同(refold 217 / 0,appendFailures 8 与改前相同);hydration 两店各 217 / 0;`gate:acp` 109 条 ok;`gate:search-index` ok / FAIL 结构相同;`gate:web-shell` / `gate:client` 绿;name / client-api / boundary(132 ok)/ transport / log / session / native 不变。`provider:gate` 在验收那一轮红过一次(openai 那一对随 `provider-helpers` 换了文件路径),基线换址后 105 对绿;`provider:drill` 本地重放(铺上工作区改动)全绿;CLI 与 server 能起。
