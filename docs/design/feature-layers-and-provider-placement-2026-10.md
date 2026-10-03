# providers 去处决策(s15,Fable,2026-10-04)— 只分析,未改代码

模拟器:`s15-fable/sim.mjs`(= `s14/sim.mjs` + `--dump`),场景 `scen-p.json`(providers 这一笔)、`scen-f.json`…`scen-f5.json`(后续),
断边清单 `drops-*.txt`,结果 `*-*.json`,层次表 `layers.json` + `viol.mjs`(算「低层引高层」的边数),`viol-{head,p,f4,f5}.txt`。

## 0. 一句话

providers 里「用服务商干活」的文件不是该去 spaces(d3x),而是该**按各自依赖的层次**去:发对话/造实例的去 engine,按会话找空间设置的去 sessions,
模型目录三件去 settings,凭证一族(连同 spaces 里的凭证池、auth 里的 token 写回)合成一个新功能 `credentials/`;再断四条边。
这一笔(29 只文件 + 4 条断边)做完后,providers、spaces、auth、settings、sessions、credentials、usage 依次收口都不再成环;
**engine 收口成不成环与 providers 无关**——它自己就是 247 只的环,要另做一批(内核归 agent-loop、组合根出引擎、触发器归各功能),也模拟通了。

## 1. 问题问对了一半

- 「providers 收口不成环」的硬条件,d3x 也能满足。但「之后 spaces/auth/engine/settings/sessions 依次收口不重新成环」这一条,先得看 HEAD 自己:
  只把 **engine** 一个功能改走入口 = 247 只的环(13 个入口在里面);只收口 **auth** = 24 只(auth/providers/settings 三个入口);只收口 **usage** = 71。
  spaces / settings / sessions 单独收口都是 0。所以 engine、auth、usage 的环不是 providers 的放法造成的,它们和 providers 得的是同一种病:
  **一个目录里既有「下层人人要的叶子」又有「要用到全世界的重半边」**。engine 的叶子是 `engine-primitives` / `error-details` / `history` 那一组
  (前 core/engine 内核,providers、sessions、prompts、agents、acp、mcp、toolkit、search、events 都 import),重半边是 `stream/*`、`triggers/*`、`engine-layer`;
  auth 的叶子是 `oauth-token` / `jwt`(各家 vendors 的 oauth.ts 要),重半边是 `process-auth-service`(import 设置入口);usage 的叶子是 `pricing` / `summary`,重半边是 `usage-recorder`。
- d3x 的真问题:它把重文件搬进 **spaces**,而 spaces 是个叶子功能(`types` 被 13 个功能 import,`provider-settings` / `credentials` 被 settings、auth、quota 直引)。
  等于把 providers 的病原样挪到 spaces 身上,所以 spaces 一收口就是 37 只的环(`d3x-ps2.json`,断边生效;文档 7.5 自己估的是 39)。
- 结论性的放法原则(Nx / FSD 那一套,下面第 6 节是层次表):**一个功能的入口只能站在一个层次上**。重文件只能去「本来就在上层」的功能,
  叶子功能里不许塞重文件;一个功能若两头都有,就拆成两个功能(engine → agent-loop + engine;spaces 的凭证半边 → credentials)。

## 2. providers 这一笔:放法表(29 只)

| 文件(`runtime/providers/` 下,除非注明) | 去处 | 一句理由 |
| --- | --- | --- |
| `chat-facade.ts` | `engine/` | 「对话请求从哪发出」= 引擎;它是 engine 的 `provider-helpers` / `compact-session` / `stream-engine-runtime` 和 collab、plugins、RPC chat 共用的「发一轮」门面 |
| `utility-provider.ts` | `engine/` | 后台杂活(起标题、TOC、技能复盘)用哪个模型跑一轮,是引擎的「杂活回合」 |
| `custom-probe-analyst.ts` | `providers/client-api.ts`(D21 规矩下,见第 8 节);**模拟里按 engine 算** | 它只被 `rpc/domains/providers.ts` 用(设置页「自动识别」的一步),不是引擎跑的任何回合——放 engine 等于让 L3 多一只只被 L4 用的文件,R2 过不去。它是第 8 节 client-api 规矩的第一个用例;在 engine 还是在包根直连,对零环结果没有影响。探测/规则/回验的纯函数 `custom-probe.ts` 留 providers |
| `process-factory.ts` `process-providers.ts` `agent-runtime.ts` | `engine/` | 「按本进程宿主能力(OAuth 刷新、带代理 fetch、媒体库、外部 agent 连接器)造这一轮要用的 AgentProvider」;纯工厂 `factory.ts` 留 providers,索引头写明「实例在 engine 造」 |
| `media-reader.ts` `openai-compatible-fetch.ts` | `engine/` | 只被 `process-factory` 用,随它走 |
| `codex.ts` | 删(文档第 4 项);模拟按去 engine 算 | 无人调用的包装 |
| `space-defaults.ts` `space-ai-settings.ts` | `sessions/` | 内容是「这条会话属于哪个空间 → 用那个空间的默认模型 / provider 设置」,问的是会话;它俩的闭包(462)就是 sessions 的闭包(461),搬过去不增重;只被 engine 用 |
| `space-credentials.ts` `credential-rotation.ts` `credential-strategy.ts` `credential-strategy-lifetime.ts` `space-config-migration.ts` `route.ts` | `credentials/`(新) | 「这条会话该用哪把钥匙、失败了换哪把、插件策略怎么选、订阅额度用完走哪条路、老凭证怎么迁进默认空间」—— 全是凭证;`route.ts` 只被 `space-credentials` / `credential-rotation` 用,且只吃凭证池的谓词 |
| `spaces/credentials.ts`(池)`spaces/provider-credentials.ts`(解析规则) | `credentials/` | 凭证池与规则跟解析住一起,R1 一个目录答完「凭证在哪」;spaces 只剩空间身份/名册/每空间 provider 设置/overlay |
| `auth/space-token-store.ts` | `credentials/` | 它是「OAuth 的 token 写回凭证池」,认识池的形状;auth 不再认识池(改为装配时把它注入 auth 服务,见第 3 节) |
| `model-registry-service.ts` `manual-model-store.ts` `custom-manifests.ts` | `settings/` | 三件的数据都住在设置里(`ai.modelCatalog` 缓存、每空间 `providers.json` 的勾选与自定义服务商);它们读写设置入口,而 settings 本来就 import providers 的事实(种子行序、能力账本校验)—— **settings 在 providers 之上**是今天就成立的方向。纯的目录逻辑(`model-registry.ts` 1166 行、`model-capability.ts` 875 行、`manual-models.ts`、`models-dev-*`、`models-endpoint.ts`)留 providers |
| `auth/oauth-manager.ts` | `auth/` | 旧兼容门面,头注就说新代码直接用 auth 服务 |
| `external-agents/provider.ts` | → `providers/` | 「外部 agent 这一种 AgentProvider 的实现」,与各家同类;留在外面就与 `factory.ts` 成 `extends` 环(文档 7.4-1 (i)) |
| `usage/summary.ts` 里的 `computeOnethingCredentialUsage`(只搬函数) | → `credentials/` | 纯函数(类型-only import),算「每把钥匙用了多少」,说的是凭证;搬走后 `credential-strategy` 对 usage 零依赖 |
| `usage/pricing.ts` | → `providers/` | 「这个模型一个 token 多少钱」是模型目录的事实;只被 `providers/base/usage.ts` 用;搬走后 usage 只剩账本 + 汇总 + 记账 |
| `auth/oauth-token.ts` `auth/jwt.ts` | → `network/` | PKCE 一对、token 应答归一、JWT 解码:协议小件,不认识任何服务商、不存任何 token;auth 和 providers 都要,放最底层两边都能引,providers 从此零 auth 依赖 |
| `request-dump.ts` | → `logging/` | 转储落 `log/dumps/`、归日志管家管、开关由诊断模式拨 —— 它是日志设施;搬过去后 `logging/diagnostics.ts` 不再 import providers 桶(今天 logging → providers 这一条让 settings-store 的闭包背上整个 providers)。写盘那层 `request-dump-writer.ts` 留 providers |

providers 留下的:manifest / 名册 / `vendors/<id>/` / dialects / wires / base / thinking / quota 注册表 / 纯目录逻辑 / 纯工厂 / `provider-config` / `provider-data` / `agent-providers` / `ipc-env` / `provider-table` …。
它对外只连:network、logging、storage、agent-loop 的叶子(`loop-primitives`、`provider-error-classification`)、engine 的叶子(`error-details`、`engine-primitives`,engine 批里归 agent-loop)、`agents/executor/{registry,capabilities}`(两处,见第 5 节)。

## 3. 要断的三条边(「值 import 改成装配时给」)+ 两处时机变化

模拟里 `drops-p.txt` 写了四条,其中 `credential-strategy → usage/index` 那条在图上等价于第 2 节「搬函数」那一行,真做时是搬,不是断。

| 边 | 改法 | 可感知行为 |
| --- | --- | --- |
| `credential-strategy-lifetime` → `usage/usage-recorder`(`getUsageLedger`) | `CredentialStrategyService` 构造参数加「取账本」函数,`backend.ts` 装配那一行传入(文档 7.4-2) | 无:只在 `captureLedger()` 函数体里用,首次用到时装配早已完成 |
| `model-registry-service` → `space-credentials`(`resolveSpaceProviderCredentialForSpace`,拉模型清单时取这个空间的 key) | `refreshProviderModels` / `refreshAllProviders` 的「取凭证」改成构造/配置时注入的函数(`backend.ts` 装配 settings 的模型目录时传 credentials 的解析函数);读目录的 15 个函数不受影响 | 无:刷新只在 RPC `models.refresh` 与启动后调用,那时装配已完成 |
| `auth/service-factory` → `space-token-store`(`createOnethingSpaceTokenStore`) | token store 由 `backend.ts` 建好传进 `createOnethingAuthServiceOptions` | **有一处时机变化要单列**:`process-auth-service.ts:36` 今天在模块加载时 `export const authService = new AuthService()`(构造函数只存字段,不做 I/O),注入后 `authService` 要改成首次用到时才建的持有器(D12 口径)。全仓没有在 import 期就读 `authService.` 的顶层语句,所以首次用到仍是装配完成之后 |

spaces 收口时还要一条(不属于 providers 这一笔):`spaces/store.ts:116` 删空间时同步调 `forgetProjectsStore(spaceId)`(丢掉该空间 project-dirs 的内存实例)。
改成 project-dirs 订阅 spaces 的 `notify()`(空间列表变了就忘掉不在列表里的空间)。顺序仍由 `removeSpace` 保证:`persist()` → `removeSpaceDir()` → `notify()`,
notify 是同步派发,所以 forget 仍发生在 `return` 之前,只是从「removeSpaceDir 之后、notify 之前」挪到「notify 之内」,中间没有别的调用。

engine 批里还有一处时机变化要记在这张表上:`turn-principal → collab/drive-guard`(第 5 节 F2)—— prover 今天是加载期从 collab 直接 import,改为装配时经端口给;它头注就写着「today the single prover is the collab drive token」。首次用到在回合里,装配早已完成。

另外两处文档 7.6 已写的惰性化(`permission-policy:22`、`settings-defaults` 种子表)照做。

## 4. 模拟结果

口径同文档 7.1:值引用图上的 SCC;「入口」指 `runtime/<F>/index.ts`;新功能 `credentials/` 的入口按同规则生成。`--route-orig` 按文件原籍决定哪些引用改走入口。

| 场景 | 收口的功能 | SCC 大小 | 环里的入口 | 加载期隐患 | 九个使用者 |
| --- | --- | --- | --- | --- | --- |
| HEAD | 无 | 17 / 5 / 3 / 2 | 无 | 0 | usage-recorder 5 |
| HEAD | 只 engine | **247** | 13 个 | 117(29 extends) | 7 个在 247 里 |
| HEAD | 只 auth | 24 | auth providers settings | 13(1) | registry 24 |
| HEAD | 只 usage | 71 | 5 个 | 95(21) | 5 个在 71 里 |
| d3x+断边(文档推荐) | providers | 17 / 3 / 2 | 无 | 0 | 全 1 |
| d3x+断边 | providers + spaces | **37** | auth providers sessions settings spaces | 5(1) | 6 个在 37 里 |
| d3x+断边 | providers spaces auth settings sessions | 59 | 同上五个 | 16(1) | 6 个在 59 里 |
| d3x+断边 | 六个 | **280** | 15 个 | 130(34) | 8 个在 280 里 |
| **P(本方案这一笔)** | providers | 17 / 3 / 2 / 2 | 无* | 0 | 全 1 |
| P | providers + spaces + auth | 17 / 4 / 3 / 2 | spaces(4 只:spaces/store ↔ project-dirs/store) | 0 | 全 1 |
| P | providers spaces auth settings sessions | 17 / 4 / 3 / 2 | 同上 | 0 | 全 1 |
| P | 上面五个 + credentials + usage | 17 / 4 / 3 / 2 | 同上 | 0 | 全 1 |
| P | 六个(含 engine) | **265** / 4 / 3 / 2 —— 这是 engine 自己的病(HEAD 只收口 engine 就是 247),providers 这一笔治不了也没加重 | 14 个(engine 把 acp/agents/auth/evals/files/mcp/prompts/providers/search/sessions/settings… 全拖进来) | 124(34) | 7 个在 265 里 |
| F(= P + 内核进 agent-loop) | 六个 | 38 / 4 / 3 / 2 | engine、search | 0 | provider-helpers 38 |
| F4(P + engine 批,见第 5 节) | 六个 | **3 / 2** | 无 | 0 | 全 1 |
| F4 | 六个 + agent-loop usage credentials network | 3 / 2 | 无 | 0 | 全 1 |
| F5(F4,但「调用服务商」十只独立成 `provider-calls/`) | 同上两组 | 3 / 2 | 无 | 0 | 全 1 |

\* P-providers 里那个新的 2 环是 `auth/index.ts ↔ providers/auth/oauth-manager.ts`:oauth-manager 搬进 auth 后仍 import 自家的 `index.ts` 桶,
模拟器按原样保留了这条自引用。真搬时改成引兄弟文件就没了,不是方案的环。3 和 2 是 HEAD 自己的 `plugins/{api,background-table,plugin-manager}` 与 `permissions/{asks,policy}` 深层环,不经入口。
HEAD 那个 5 只的环随第 3 节的改法消失。

**P 在五个 / 七个功能收口下与 HEAD 的 17 一模一样**,也就是说 providers 这一笔做完,spaces(加上面那一条断边)、auth、settings、sessions、credentials、usage 各自收口都不会重新成环。

## 5. 后续批次(不属于 providers 这一笔,但硬条件里点了 engine)

**engine 批(F2 → F4,逐步加,数字是「六个功能都收口」时的最大 SCC)**:

1. **内核归 agent-loop**(F):`engine/` 顶层闭包 ≤ 63 的那 40 只 —— `engine-primitives`、`error-details`、`core-stream-engine`、`agent-loop-{runtime,executor,selection,turn}`、
   `direct-tool-execution`、`tool-orchestration`、`context-compact`、`stream-processor`、`stream-executor`(顶层那只)、`history`、`turn-context`、`ids`、`message-sources`、`stream-sender`、
   `prompt-fragments`、`triggers.ts`(注册表类)… 这是前 `core/engine`,「一轮怎么跑」,与 agent-loop 是一回事;同时 agent-loop 里「挑哪家 provider 运行时」的两只
   `stream-runtime.ts` / `selection.ts`(import providers 的 `agent-providers` / `provider-config`)反向搬进 engine —— 它们是上层的事。做完 agent-loop 对外只剩 shared / logging / tools 的三个叶子,providers → agent-loop 单向。六个收口:38(engine ↔ search、toc)。
2. **组合根出引擎**(F2):`engine-layer.ts`(`createStreamEngineLayer` + 读槽的两个 getter)、`stream-engine-bound.ts`(从 collab / plugins / agents / external-agents 填五个端口)、`triggers/index.ts`(内置触发器登记清单)三只是 `backend.ts` 里「装引擎」那一步的拆件,**合成包根一只 `assemble-engine.ts`**,与 `backend.ts` 同级(D21「包根 = 几只组装文件」);`runtime.ts` 是连 gateway 的门面,归 gateway。模拟里这四只标成 `root:assembly`(直连、无入口),就是这个意思;
   触发器各归其主:`goal-continuation` → goals、`session-toc` → toc、`skill-review` → skills(能力自述、装配处读表);`execution-context.ts`(「这次执行属于谁、哪个会话」,只吃 `sessions/access` 两个名字)→ sessions。
   断两条小边:`agent-loop-executor` → 总桶 `runtime/index.ts`(只为 `hashSections`,改引 `evals/section-hash` 或它搬去的叶子;总桶本来要删)、`turn-principal` → `collab/drive-guard`(prover 由端口注入,它头注就说「today the single prover is the collab drive token」)。六个收口:20(engine ↔ goals)。
3. **引擎自己不许摸组合根**(F3):`stream/stream-executor.ts` 用 `getStreamEngine()`、`stream/agent-loop-executor.ts` 用 `triggerManager` 都是从 `engine-layer` / `triggers/index` 拿 ——
   前者改经它已持有的 runtime,后者把 `export const triggerManager = new TriggerManager()`(今天就在 `triggers/index.ts:27`,与登记函数 `registerBuiltinTriggers` 同文件)拆成内核里的一只实例文件,登记留装配。零时机变化。六个收口:19。
4. **引擎单例经 `packages/backend/current.ts` 取**(F4):goals/kick、collab(5 处)、voice、scheduler、headless 今天 import `engine-layer.ts` 的 `getStreamEngine(Safe)`,而它只是 `getCurrentBackend('engine').engine`(读槽,不构造,`engine-layer.ts:56-70`);
   改成直接读 `current.ts`(零出边)。六个收口:**3 / 2,零入口,零隐患**;再加 agent-loop / usage / credentials / network 也是 3 / 2。

**auth 批**:`authService` 懒建(第 3 节第四行);`auth/index` 不再再导出 token store。
**spaces 批**:`spaces/store → project-dirs/store` 那一条(第 3 节末)。
**下一批的结(不在六个里,层次表里标了,未解)**:collab ↔ engine(engine 要 collab 的 `members` / `user-identity` / `drive-guard`,collab 的 `referee-judge` / `digest-runner` 要 engine 的 `chat-facade` / `provider-helpers`);
tools 的 `access-control/` 半边(import settings / sessions / permissions / files / notes,是权限不是工具);`providers/provider-config → agents/executor/registry` 的谓词 `isExternalAgentExecutorProvider`(该由 manifest 自述);
credentials ↔ plugins(`credential-strategy` 吃 `plugins/plugin-contract` / `health` 两只叶子,`plugins/api` 登记策略);logging ↔ storage(`storage/json-file` 用 logger 原语、`configure-logging` 要 storage 的路径)。

## 6. 层次表(按协调者补充的输入:Nx 标签 / FSD 层次;目录仍平铺,层次是标签)

规则:**只许高层引低层;同层之间经入口且不成环;L0 不引任何功能**。标签表放仓库里由门读(例如 `layers.json`),`entry:cycle-gate` 之外再加一条「低层引高层 = 红」。

| 层 | 含义 | 功能(F4 落地后的分配初稿) |
| --- | --- | --- |
| L0 基础件 | 不认识任何产品概念:存储、日志、网络、生命周期、事件原语 | storage、logging、network、lifecycle、events(其中 `event-only-emitter` → sessions / engine-primitives 两条上行边是违例,它是引擎件放错了地方)、references、shell、dialog、context、memory、triggers(注册表)、http、perf、`packages/shared`、包根的槽位与小件(`current.ts`、`utils/`、`rpc/sandbox.ts`、`server/host-trust.ts`、`channel/origin.ts`;`store.ts` 兼容桶待删) |
| L1 领域事实 | 纯事实与纯逻辑,不读用户的存储、不起服务 | **providers**(各家是谁、怎么说、模型目录的事实与纯逻辑、纯工厂)、**spaces**(空间身份、名册、每空间 provider 设置、overlay)、**agent-loop**(一轮怎么跑的内核)、tools(纯模块;access-control 半边 9 条上行边是违例)、prompts(→ plugins 契约 3 条是违例)、themes、practice |
| L2 能力 | 有自己的存储或服务,靠事实与基础件干活 | **settings**(含模型目录服务三件)、**auth**、**credentials**(新)、**sessions**(含执行上下文、按会话取空间设置)、usage、quota、files、notes、skills、media、music、voice、terminal、todo-plan、scratchpad、project-dirs、mcp、acp、external-agents、toolkit、search、resource、plugins、evals、pets、ambient、goals、toc、tasks、scheduler、deeplink、permissions、interaction、agents、markdown、variables、(F5 时的 provider-calls) |
| L3 编排 | 把多个能力接成一台机器跑 | **engine**、collab、gateway、headless |
| L4 对外接口 | 界面连进来的那台 HTTP 服务器、装配配方、各功能的 client-api | 包根 `backend.ts` / `assemble-engine.ts` / `rpc/` / `server/`(D21 的 http-server)、总桶(待删) |

L2 内部有先后(settings < auth < sessions < credentials < usage < …),但按 Nx/FSD 的做法同层只要求「经入口、不成环」,不再细分 —— 细分到六层以上,标签就没人记得住了。

**违例计数**(`viol.mjs`,低层 → 高层的值边;入口再导出搬走文件的那几行不算):

| 状态 | 跨功能边 | 低层引高层 | 违例对 | 最多的几家 |
| --- | --- | --- | --- | --- |
| HEAD | 2020 | **139** | 61 | providers 49(settings/sessions/auth/usage/media/plugins/engine…)、toolkit 18、tools 9、prompts 7、agent-loop 5、plugins 5 |
| P(providers 这一笔) | 2029 | **98** | 54 | providers 剩 5(→ engine 叶子 3、→ agents 2)、toolkit 18、tools 9、prompts 7 |
| F4(+ engine 批) | 2027 | **61** | 33 | toolkit 15(全是 → collab)、tools 9(access-control)、root:slot 6(`store.ts` 兼容桶,路线第 3 项删)、plugins 4、prompts 3、external-agents 3、variables 3 |
| F5(+ provider-calls) | 2033 | **57** | 30 | 比 F4 少的 4 条 = toc 2、skills 1、pets 1 → engine 里的 `utility-provider` / `chat-facade` |

F4 里剩的 61 条按性质分三类:(a) 工具误差 1 条(`logging/diagnostics → providers/index` 桶,request-dump 搬去 logging 后实际消失)+ 兼容桶 `store.ts` 6 条;
(b) 真正的下一批结(collab 被 toolkit / agents / external-agents / variables / music / search / sessions / interaction 引 24 条 —— collab 的 `tool-surface` / `user-identity` / `venue` 是叶子,该拆出来或下沉;tools 的 access-control 9 条;prompts → plugins 契约 3 条;providers → agents 2 条;events 里 `event-only-emitter` 1 条;triggers → agent-loop 1 条);
(c) 用了引擎杂活回合的 L2 功能 5 条(toc、skills、pets、plugins)。

**层次能不能自然解开 providers / spaces / settings / sessions / engine 的环?** 能,而且这就是第 2 节的推导过程:把 providers 的「事实」判 L1、「干活」判 L2/L3 之后,每只重文件的去处由它的依赖层次决定(要 sessions 的不能进 L1 的 spaces,要 settings 的进 settings,要宿主能力的进 engine),P 的零环结果是这个判法的直接产物。engine 的环同理:内核是 L1、hub 是 L3、组合根是 L4,三者今天挤在一个目录。

## 7. 决策与理由(给用户)

**决定:不采用 d3x,采用上面第 2 节的放法(P)+ 第 3 节的四条断边。** 理由是三句话:

1. d3x 把凭证、空间设置、模型目录服务一共九只重文件搬进 spaces,而 spaces 是被十三个功能当叶子引的小功能(types、每空间的 provider 设置、凭证池)。
   这等于把 providers「既是叶子又是枢纽」的病挪到 spaces 身上——模拟里 spaces 一收口就是 37 只的环(断边已生效的那次),六个功能一起收口是 280 只。文档 7.5 末尾自己也写了这条限制。
2. 正确的判法是看每只文件要谁:要「会话属于哪个空间」的去 sessions(它们的闭包就是 sessions 的闭包),读写设置的去 settings(settings 今天就引 providers 的事实,方向本来就是 settings 在 providers 之上),
   要宿主能力发请求的去 engine(「对话请求从哪发出」答 engine),而「这条会话用哪把钥匙、失败换哪把、插件怎么选、老凭证怎么迁」这一族——凭证——在今天散在 providers、spaces、auth 三个目录里,
   没有一个现成功能能装下它而不变成枢纽,所以合成 `credentials/`。这是用户自己举过的例子,名字过得了 R2:问「凭证在哪」一个目录答完。
3. 按这个放法模拟,providers 收口零环;再把 spaces、auth、settings、sessions、credentials、usage 依次收口,图与 HEAD 完全一样(17/4/3/2,那个 4 是 spaces ↔ project-dirs 的一条同步调用,spaces 批里改订阅)。
   engine 收口要另一批(内核归 agent-loop、组合根出引擎、触发器归各功能、单例经 current.ts 取),做完六个功能加 agent-loop / usage / credentials / network 全收口是 3/2,零入口零隐患。

**否掉的备选**:

- **d3x / d1x**(模型目录服务去 spaces / engine):上面第 1 条;d1x 把重文件塞进已经是 1145 闭包的 engine,engine 批时要再搬一次。
- **新建 `llm/`**:用户已否,名字有歧义。但要说明代价:不新建的话,toc / skills / pets / plugins 四个 L2 功能要引 engine(L3)里的 `utility-provider` / `chat-facade`,是 5 条层次违例(F4 61 → F5 57 之差)。
  若用户能接受一个说得清的名字(我推荐 `provider-calls/`:「我们去调用服务商」,与 `providers/`「服务商是谁、怎么说」正好一对;不叫 llm、不叫 inference),就是 F5;否则 F4,把这 5 条记成已知例外。**我按用户的偏好推荐 F4**,F5 作为备选,区别只有这 5 条边。
- **新建 `model-catalog/`**:纯目录逻辑被 settings-save(校验)和 providers 自己的 `base/model-profile` 引,服务半边又要 settings —— 新目录会同时装叶子和枢纽,与 settings 成环;所以纯逻辑留 providers、服务进 settings。
- **凭证四件留 providers**(a/b/c 系列):只要 providers 里有一只 import 设置入口,providers 入口就背上设置入口,设置入口的 `settings-defaults` / `settings-save` 又要 providers 的轻名字,环原样还在(文档 7.3 已证)。
- **凭证进 auth**:auth 要写回凭证池,凭证解析要 auth 刷新 token,两边都是真需要;合在一个目录就是 auth 入口既叶子又枢纽(HEAD 只收口 auth 就是 24 的环)。拆成「auth 跑登录流程」与「credentials 管钥匙」,方向是 credentials → auth 单向,auth 经注入拿 token store。
- **模型目录服务注入凭证 vs 留边**:留边 = settings → credentials → auth → providers ← settings 成环(模拟 f-ten 的 23 环就是它)。注入是唯一解,且不改时机。

## 8. 两件模拟没算、但「依次收口」会撞上的事

1. **D21 的 `<d>/client-api.ts`**。今天 `rpc/domains/*` 在模拟里是包根文件(直连,不成环)。一旦搬进各功能并经 `index.ts` 交出去,`settings/client-api.ts`(它 import `provider-table` 等 270 闭包的重件)、`models` / `providers` / `spaces` 的 client-api 会把每个有界面操作的功能重新变成枢纽,本文的零环会在路线第 2 项翻掉。
   建议的规矩:**client-api.ts 是功能的第二个入口,只许 http-server import,它可以引任何功能的 index.ts,但任何 index.ts 不许引 client-api.ts;DAG 门只算 index.ts**。一句话:`index.ts` 给别的功能用,`client-api.ts` 给界面用。
2. **入口再导出的口径**。`--route-orig` 让各入口保留今天的再导出行,只删指向搬走文件的几行。真收口时各入口会增加新的再导出(外面要什么就出什么),闭包只会更接近「全部走入口」的那一档;本文每个场景都跑了「六个 / 十个功能全走入口」那一档,所以结论不依赖这个口径差。

另外:`agent-loop` 批前,providers → engine 剩 3 条叶子边(`error-details` ×2、`engine-primitives` ×1),providers → agents 2 条(`executor/registry` 的谓词、`executor/capabilities`)。前者随内核归 agent-loop 消失;后者要 manifest 自述「这是外部 agent 执行器」,是 agents 批的事。
