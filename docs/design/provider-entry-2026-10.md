# providers 功能入口调查(2026-10-03)

> 只调查,不改代码。量法与原始数据在会话 scratchpad 的 `s8/` 下(`sites.txt` 是 `entry:check` 的逐处清单,`analyze.mjs` / `names.mjs` /
> `mocks.mjs` / `featgraph.mjs` / `valueimp.mjs` 是这份文档里每张表的出处)。规矩本身见 `docs/design/server-client-split-2026-10.md` §4「功能入口」。

## 0. 读法与几个词

- **功能入口**:`packages/backend/runtime/providers/index.ts`,包说明符 `@onething/backend/runtime/providers`。规矩是功能目录之外只许从这里拿名字。
- **深层引用**:功能目录之外的文件直接 import 了 `runtime/providers/` 里入口以外的某个文件。`bun run entry:gate` 数的就是它,今天 providers 这一行是
  **236 处、62 个目标**(`node scripts/feature-entry-gate.mjs --list providers`)。
- **闭包**:从一个文件出发,顺着**值 import**(`import type` 不算,它编译后会被擦掉)能走到的全部仓内文件。闭包越大,import 它的那一方在
  测试、Worker、单文件 bundle 里背的东西越多。
- **装配半边**:providers 目录里有一批文件只做「宿主才知道的事」—— 会话属于哪个空间、设置怎么落盘、用哪只带代理的 fetch。它们在文件头里大多自称
  「装配层」「宿主接线」。与之相对的是「纯事实」那一半:manifest、能力账本、模型认亲、各家方言配方。这两半在今天的目录里混在一起,是下文
  大部分问题的根。
- **入口今天交出什么**:`index.ts` 44 行,`export *` 了 32 只模块,共 429 个名字;闭包 245 个文件(其中 79 个在 `agent-loop/`,
  因为入口经 `vendors/runtimes.ts` 把各家方言和运行时工厂都带上了)。

## 1. 被外面引用的内部目标全表

62 个目标、236 处。「谁在用」里「(测)」表示测试文件,数字是处数。「建议」一栏的口径:

- **改调用方**:外面要的名字入口**今天已经交出**,只是调用方走了深路径,把说明符换成入口即可(48 处)。
- **进入口**:外面真要、入口还没有,建议加进入口(约 130 处,其中装配半边那一批要先看第 6 节问题 1)。
- **测试搬家**:测的就是 providers 自己的某个文件,测试本身该搬进 providers 目录(多数是某一家的方言,搬进 `vendors/<id>/__tests__/`)。
- **别的**:见各行理由。

| 目标(`runtime/providers/` 下) | 它是什么 | 处数 | 谁在用 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `chat-facade.ts` | 对话门面:列可用服务商、发一轮对话 / 起标题、把工具定义换成某条线的形状,装配时登记注册表 | 25 | 包根(测)×7 包根×3 collab(测)×2 collab×2 engine(测)×4 engine×5 plugins(测)×1 plugins×1 | 进入口 | 包根、engine、collab、plugins 都要用;它是服务商功能对外的主门面。闭包 666,见第 5 节 |
| `model-registry-service.ts` | 模型目录服务:拉取 / 缓存 / 查询各家模型清单,带设置落盘与代理 fetch | 22 | 桌面×1 包根(测)×1 包根×1 engine(测)×9 engine×6 plugins(测)×1 plugins×1 usage(测)×1 usage×1 | 进入口 | engine 的上下文长度、能力判断与 RPC models 域都靠它;有 `import * as modelRegistry` 的整模块引用,进入口后要改成具名 |
| `provider-config.ts` | 生效配置与凭证解析(按会话选哪家、哪把 key、哪个 base URL) | 15 | 包根×1 agent-loop×1 agents(测)×1 engine(测)×1 engine×5 logging×1 prompts×1 spaces(测)×2 spaces×1 usage×1 | 进入口(补值导出) | 入口今天只交出它的两个类型,外面取的 15 个值都没有;闭包只有 87 |
| `space-credentials.ts` | 每个空间的凭证接线:会话属于哪个空间、凭证从哪读、加密 | 13 | 包根(测)×3 包根×2 engine×2 evals(测)×1 evals×1 quota(测)×1 quota×1 usage(测)×1 usage×1 | 进入口 | 包根装配、engine、quota、usage、evals 都要;属于「装配半边」,见第 6 节问题 1 |
| `__tests__/custom-manifest-fixture.ts` | 测试夹具:把自定义服务商按 id 临时登记进 manifest 注册表 | 11 | 包根(测)×1 agent-loop(测)×10 | 别的:测试基建 | 11 处里 10 处是 agent-loop 的 provider 线测试;随第 6 节问题 2 的结论走(测试搬进 providers,或棘轮对测试基建豁免) |
| `manifest.ts` | 服务商自述表(manifest)的类型与注册表:每家自己说用哪份方言、怎么登录、模型从哪来 | 10 | agent-loop(测)×1 agent-loop×3 engine(测)×1 engine×2 prompts×1 spaces×1 usage×1 | 改调用方 | 名字全在入口里,只是走了深路径 |
| `model-capability.ts` | 模型能力账本:某个型号能做什么、思考怎么配 | 10 | agent-loop(测)×4 agent-loop×5 settings×1 | 改调用方 | 名字全在入口里;但 9 处使用者是 agent-loop 的线协议层,见第 6 节问题 3 |
| `vendors/codex/agent-provider.ts` | codex(OpenAI Responses)线的构造门面 | 9 | agent-loop(测)×8 agent-loop×1 | 别的:见第 2 节 | 8 处是测试,1 处是 agent-loop/providers/codex.ts(生产上没有调用者) |
| `ipc-env.ts` | 按环境变量解析 API key、报告环境变量状态 | 8 | 包根×1 engine×2 evals(测)×1 evals×1 plugins(测)×1 plugins×1 quota×1 | 进入口 | 小模块(闭包 246 里绝大多数是入口已有的),包根、engine、evals、plugins、quota 都要 |
| `vendors/claude/agent-provider.ts` | anthropic-messages 线的构造门面 | 8 | agent-loop(测)×8 | 别的:见第 2 节 | 8 处全是 agent-loop 的测试 |
| `credential-strategy.ts` | 插件凭证策略注册表与调用口(超时、熔断) | 6 | 包根(测)×2 包根×2 plugins(测)×1 plugins×1 | 进入口 | 包根装配与 plugins 的 api 要用;属于装配半边 |
| `vendors/deepseek/agent-provider.ts` | DeepSeek 的构造门面 | 6 | agent-loop(测)×6 | 别的:见第 2 节 | 6 处全是 agent-loop 的测试 |
| `agent-runtime.ts` | 按运行时配置造 AgentProvider(含 ACP 判断) | 6 | engine(测)×3 engine×3 | 进入口 | engine 的 agent-loop 运行时与系统提示快照要用 |
| `vendors/runtimes.ts` | 内置服务商的行为名册(每家一行:方言、运行时工厂、OAuth、配额源) | 5 | 包根×1 agent-loop×3 auth×1 | 进入口(名册本身) | 这是「通用代码只读名册」的那张表,交出名册不点名任何一家;注意它的副作用 import(登记方言) |
| `model-registry.ts` | 模型目录的纯逻辑(条目形状、出处、查询) | 5 | 包根×3 agent-loop(测)×1 logging×1 | 改调用方 | 名字全在入口里 |
| `utility-provider.ts` | 后台杂活(技能回顾、会话目录、宠物)用的 provider | 5 | engine×1 pets×1 toc(测)×2 toc×1 | 进入口 | engine、pets、toc 要用 |
| `provider-table.ts` | 服务商注册表(登记、查找、实例化) | 4 | 包根(测)×2 包根×1 evals(测)×1 | 进入口 | 包根 settings 域要 `invalidateProviderCache`;`initializeRegistry` 由 chat-facade 在内部调,测试替换它要改法,见第 3 节 |
| `vendors/gemini/agent-provider.ts` | gemini(generateContent)线的构造门面 | 4 | agent-loop(测)×4 | 别的:见第 2 节 | 4 处全是 agent-loop 的测试 |
| `provider-options.ts` | 服务商私有的运行时旋钮(智谱编程套餐地址、千问 / Kimi 的模式与地区) | 3 | 包根×1 agent-loop×2 | 改调用方 | 名字全在入口里 |
| `model-query-presentation.ts` | 「这条线上这个模型界面该开哪几个口」的投影 | 3 | 包根×2 logging×1 | 改调用方 | 名字全在入口里 |
| `provider-presentation.ts` | 服务商列表与环境变量状态的 IPC 形状投影 | 3 | 包根×2 logging×1 | 改调用方 | 名字全在入口里 |
| `model-families/claude.ts` | Claude 型号家族知识(哪一代、思考档位) | 3 | agent-loop×3 | 进入口,或随第 6 节问题 3 变成内部 | 3 处都在 agent-loop 的 thinking 线型里 |
| `credential-strategy-lifetime.ts` | 凭证策略的作用域与生命期(含超时的那次选择) | 2 | 包根×1 plugins×1 | 进入口 | 包根装配与 plugins 的 api 要用 |
| `request-dump.ts` | provider 请求转储(诊断用) | 2 | 包根×1 logging×1 | 改调用方 | 名字全在入口里 |
| `vendors/codex/models.ts` | codex 模型列表取数与原生工具元数据 | 2 | 包根(测)×2 | 别的:见第 2、3 节 | 只有 models 域测试在 vi.mock 它 |
| `vendors/github-copilot/models.ts` | Copilot 模型目录取数 | 2 | 包根(测)×2 | 别的:见第 2、3 节 | 只有 models 域测试在 vi.mock 它 |
| `manual-model-store.ts` | 手填模型的装配半边(目录落全局、勾选落空间) | 2 | 包根×2 | 进入口 | 包根 models / spaces 两个 RPC 域要用 |
| `builtin/index.ts` | 内置 provider 定义(manifest 的投影) | 2 | agent-loop(测)×1 engine(测)×1 | 改调用方或进入口 | 只有 2 份测试用;入口已有 `BUILTIN_PROVIDER_MANIFESTS` / `getAvailableProviders`,能换就换,换不了再加一个名字 |
| `manual-models.ts` | 手填模型 = 目录条目(纯函数) | 2 | agent-loop×2 | 改调用方 | 名字全在入口里 |
| `types.ts` | 旧的 Provider 接口类型(请求、流事件、用量) | 2 | agents×1 scripts×1 | 进入口(只交类型)或删 | agents/agent-engine.ts 与 scripts/smoke-test-real.ts 在用;若 agent-engine 那条老路已退役,可以连类型一起删 |
| `vendors/codex/native-tools.ts` | codex 原生工具(图片生成)的判定与解析 | 2 | engine(测)×1 engine×1 | 别的:见第 2 节 | engine 的 stream-executor / 系统提示快照经 engine/stream/codex-native-tools.ts 用它 |
| `space-defaults.ts` | 按会话所在空间解析默认服务商 / 模型 | 2 | engine×2 | 进入口 | engine 要用;装配半边 |
| `space-ai-settings.ts` | 按会话所在空间取那一份 provider 设置 | 2 | engine×2 | 进入口 | engine 要用;装配半边 |
| `quota/index.ts` | 配额与余额的取数入口 | 2 | quota×2 | 改调用方 | 名字全在入口里;使用者是 quota 功能 |
| `effective-model.ts` | 「这一型此刻按多少算」的唯一判据(覆盖 > 接口报的 > 未知) | 1 | 桌面×1 | 改调用方 | 名字全在入口里;使用者是壳的测试夹具,见第 4 节 |
| `builtin-manifests.ts` | 内置 manifest 的装配处 | 1 | 桌面×1 | 改调用方 | 名字全在入口里;使用者是壳的测试夹具,见第 4 节 |
| `builtin-providers.ts` | 从 manifest 派生的内置服务商信息 | 1 | 桌面×1 | 改调用方 | 名字全在入口里;使用者是壳的测试夹具,见第 4 节 |
| `custom-manifests.ts` | 把设置里的自定义服务商同步进 manifest 注册表 | 1 | 包根×1 | 进入口 | 只有 backend.ts 装配时用;装配半边 |
| `space-config-migration.ts` | 一次性迁移:旧 settings.ai 凭证 → default 空间 | 1 | 包根×1 | 进入口 | 只有 backend.ts 装配时用;装配半边 |
| `provider-runtime.ts` | per-space 凭证覆盖的注入口 | 1 | 包根×1 | 改调用方 | 名字全在入口里 |
| `model-identity.ts` | 模型认亲:转发站报出的别家模型对回目录 | 1 | 包根×1 | 改调用方 | 名字全在入口里 |
| `custom-probe-analyst.ts` | 自定义服务商「自动识别」的装配半边 | 1 | 包根×1 | 进入口 | 只有 providers RPC 域用;闭包 678(要请模型来分析) |
| `models-dev-catalog.ts` | models.dev 目录键(纯查表) | 1 | agent-loop(测)×1 | 改调用方 | 名字已经由入口交出(经别的模块再导出) |
| `vendors/openrouter/dialect.ts` | openrouter 的方言配方 | 1 | agent-loop(测)×1 | 测试搬家 | 1 处测试,测的就是这家方言 |
| `vendors/github-copilot/dialect.ts` | Copilot 的方言配方 | 1 | agent-loop(测)×1 | 测试搬家 | 1 处测试 |
| `vendors/deepseek/dialect.ts` | DeepSeek 的方言配方 | 1 | agent-loop(测)×1 | 测试搬家 | 1 处测试 |
| `vendors/kimi/attachments.ts` | Kimi 的先上传再抽取文件通道 | 1 | agent-loop(测)×1 | 测试搬家 | 1 处测试 |
| `vendors/kimi/dialect.ts` | Kimi 的方言配方(采样策略) | 1 | agent-loop(测)×1 | 测试搬家 | 1 处测试 |
| `vendors/gemini/dialect.ts` | gemini 官方端点的方言配方 | 1 | agent-loop×1 | 别的:见第 2 节 | 生产代码 custom-from-spec.ts 拿它当自定义 gemini 线的底 |
| `vendors/openai/dialect.ts` | OpenAI 官方 Responses 线的方言配方 | 1 | agent-loop×1 | 别的:见第 2 节 | 生产代码 custom-from-spec.ts 拿它当自定义 Responses 线的底 |
| `model-families/gemini.ts` | Gemini 型号家族知识 | 1 | agent-loop×1 | 进入口,或随第 6 节问题 3 变成内部 | 1 处在 agent-loop 的 thinking 线型里 |
| `vendors/grok/dialect.ts` | grok 的 Responses 方言(含引用解码) | 1 | agent-loop(测)×1 | 测试搬家 | 1 处测试 |
| `vendors/kimi-code/oauth.ts` | Kimi Code 的 OAuth 定义 | 1 | auth(测)×1 | 测试搬家 | 1 处 auth 的测试 |
| `stream-provider-adapter.ts` | 流式 provider 适配(凭证覆盖注入口) | 1 | engine×1 | 改调用方 | 名字全在入口里 |
| `credential-rotation.ts` | 凭证轮换接线:失败了要不要换一把 key 重试 | 1 | engine×1 | 进入口 | engine 的 agent-loop 执行器要用;装配半边 |
| `auth/oauth-manager.ts` | 旧 OAuth 兼容门面(头注写明新代码直接用 auth 服务) | 1 | engine×1 | 改调用方(换成 auth 功能的入口),然后删门面 | 只剩 engine 的 provider-helpers 一处在用 |
| `utility-model.ts` | 后台杂活该用哪家哪个模型(纯路由问题) | 1 | plugins×1 | 进入口 | plugins 的 llm-service 要用;闭包只有 1 |
| `bound-fetch.ts` | 绑了超时与中止转发的 fetch | 1 | search×1 | 别的:搬出 providers | 使用者是索引 Worker(search/index/worker-network.ts);走 providers 入口会把 245 → 684 个文件拉进 Worker,见第 6 节问题 4 |
| `network.ts` | 代理设置的校验与规整、绕行规则匹配 | 1 | search×1 | 别的:搬出 providers | 同上,索引 Worker 在用;桌面 electron/network-proxy.ts 已经走入口 |
| `vendors/zhipu/endpoint.ts` | 智谱的地址与档位 | 1 | spaces(测)×1 | 测试搬家或改读 manifest | 1 处 spaces 的测试拿地址常量做断言 |
| `vendors/kimi/endpoint.ts` | Kimi 的地址矩阵 | 1 | spaces(测)×1 | 测试搬家或改读 manifest | 1 处 spaces 的测试拿地址常量做断言 |
| `vendors/manifests.ts` | 内置服务商的数据名册(每家一行,纯,壳也 import) | 1 | 包根×1 | 进入口(名册本身) | 包根 settings-defaults 读 `VENDOR_SEED_ORDER`,是只读名册的正当用法 |

几点说明:

- `provider-config.ts` 一行标「进入口(补值导出)」,是因为入口今天只 `export type` 了它的两个类型,外面要的 `getEffectiveProviderConfig` 等 15 个值都拿不到。
- `model-registry-service.ts` 有两处是 `import * as modelRegistry from …`(整模块当命名空间用),进入口以后要改成具名 import,否则会把入口的 429 个名字都挂在那个对象上。
- `vendors/runtimes.ts` 有一处是副作用 import(只为了让各家方言登记进方言表),进入口以后这层副作用随入口发生,今天入口的闭包里已经有它,行为不变。

## 2. 外面直接引用某一家服务商内部文件的地方

`vendors/<id>/…` 一共 50 处深层引用:**生产代码 10 处**(真正点名某一家的 4 处,读名册的 6 处),其余 40 处都是测试。按「一家一目录、通用代码只读名册」:通用代码应该读
`vendors/manifests.ts`(数据名册)与 `vendors/runtimes.ts`(行为名册)上的字段,而不是点名某一家的文件。

### 2.1 生产代码(10 处)

| 使用者 | 引的是 | 为什么要用这一家的具体文件 | 建议改法 | provider:gate / provider:drill |
| --- | --- | --- | --- | --- |
| `runtime/agent-loop/providers/codex.ts` | `vendors/codex/agent-provider.ts` 的 `createCodexAgentProvider` | 给 codex 构造门面包一层宿主能力(OAuth 刷新走 `authService`、带代理的 fetch、请求转储) | **先删**:这个包装经 `agent-loop/process-providers.ts` 再导出,但生产代码里没有任何调用者,只有 `agent-loop/__tests__/codex-provider.test.ts` 在用;生产路径早就走 `agent-loop/providers/factory.ts` 的 `codexAuth`。删掉后测试改用 `vendors/codex/agent-provider.ts` 并搬进 `vendors/codex/__tests__/` | `codex agent-loop/providers/codex.ts` 这一对在 provider:gate 基线里,删文件后它消失,基线可收紧一行;drill 不受影响 |
| `runtime/engine/stream/codex-native-tools.ts`(被 `stream-executor.ts` 与 `prompt/system-prompt-snapshot.ts` 调) | `vendors/codex/native-tools.ts` | 引擎每一轮都要问「这一家有没有原生工具(codex 的图片生成)」,今天只有 codex 有,于是直接点名 codex | **行为名册加一个钩子**:`VendorRuntimeKit` 增加可选的 `nativeTools?(ctx)`,codex 在自己的 `runtime.ts` 里填它;引擎改成「找到当前服务商那一行,有钩子就调」,不再认识 codex。`engine/stream/codex-native-tools.ts` 随之删除 | 基线里 `codex engine/stream/codex-native-tools.ts` 一对消失;drill 加的虚构服务商不填这个钩子,照旧只动两份名册 + 两个文案文件 |
| `runtime/agent-loop/providers/dialects/custom-from-spec.ts` | `vendors/gemini/dialect.ts` 的 `GEMINI_DIALECT`、`vendors/openai/dialect.ts` 的 `OPENAI_DIALECT` | 用户自定义服务商选「gemini 线」或「Responses 线」时,没有协议层的通用配方,就拿官方那一家的配方当底 | **名册加一个字段**:让行为名册的一行声明「我的方言是某条线的参考配方」(例如 `referenceDialectFor: ['gemini-generateContent']`),`custom-from-spec` 改成按线查名册;或者把这两份底配方提成协议层的通用配方(住在线协议那边,不属于任何一家),官方那一家再在它上面加自己的特殊处 | 基线里 `gemini` / `openai` × `custom-from-spec.ts` 两对消失;drill 不受影响(虚构服务商不声明参考配方) |
| `stores/settings-defaults.ts` | `vendors/manifests.ts` 的 `VENDOR_SEED_ORDER` | 读名册的行序给新空间排默认顺序 | **名册进入口**:这正是「通用代码只读名册」的正当用法,只是走了深路径。入口交出名册不点名任何一家 | 不受影响 |
| `rpc/domains/models.ts`、`agent-loop/providers/{dialects/index,factory,openai-compatible}.ts`、`auth/registry.ts` | `vendors/runtimes.ts`(行为名册) | 同上,读行为名册 | **名册进入口**。注意 `auth/registry.ts` 文件头写着它**故意惰性读**名册:名册会拉起整个 agent-loop,模块加载期就读会在环上读到没初始化完的表 —— 改走入口时这份惰性必须保留 | 不受影响 |

(前三行共 4 处是真正点名某一家;后两行共 6 处是读名册,只是走了深路径。)

### 2.2 测试(40 处)

全部是「测某一家的方言 / 构造门面 / 地址常量 / OAuth 定义」的测试,住在别的功能目录里:

- `agent-loop/__tests__/` 与 `agent-loop/providers/**/__tests__/` 里 32 处:claude 8、codex 8、deepseek 6 + 方言 1、gemini 4、
  github-copilot 方言 1、grok 方言 1、kimi 方言 1 + 附件通道 1、openrouter 方言 1,以及 `provider-retry-after` / `forced-tool-choice` /
  `adjacent-message-merge` / `tool-call-loss` 这几份「同一条断言对好几家都跑一遍」的测试。
- `rpc/__tests__/models-domain.test.ts` 4 处:`vi.mock` 换掉 codex 与 Copilot 的模型取数(见第 3 节 B 类)。
- `spaces/__tests__/provider-dials.test.ts` 2 处:拿智谱、Kimi 的地址常量做断言。
- `auth/__tests__/kimi-code-oauth.test.ts` 1 处。
- `engine/__tests__/core-codex-native-tools.test.ts` 1 处(codex 原生工具)。

建议:**只测一家的**,搬进 `vendors/<id>/__tests__/`(搬家后是内部引用,不计数,也不进 provider:gate —— 那把尺子本来就跳过 `__tests__`)。
**对好几家都跑一遍的**(`provider-retry-after` 这类),如果第 6 节问题 3 选「把 agent-loop 的线协议层并进 providers」,它们自然成了内部测试;
不并的话,改成读行为名册遍历每一家,而不是逐家 import。`provider-dials.test.ts` 的地址断言可以改读 manifest 上的地址字段。
这一节的改动都不会让 provider:drill 多碰文件:drill 只看「加一家时动了哪些文件」,测试搬家不在那条路径上。

## 3. 35 处 `vi.mock` 打在 providers 内部文件上的测试

`vi.mock(路径, 工厂)` 是「这次测试里,谁 import 这个路径都拿到替身」。它按**模块**替换:替身只对「经这个路径 import 它的人」生效。
所以把被替换的路径从内部文件换成入口,只有在**被测代码也经入口拿这个名字**时才有效 —— search 收口时实测过一次反例:被替换的函数由功能内部
另一只文件按相对路径调用,入口上的替身够不着。

分三类(另有 8 处 `vi.mock` 住在 providers 自己的 `__tests__/` 里,是内部引用,不在 35 之列):

- **A 类,改成替换入口即可(31 处)**:被测代码在 providers 之外(engine、collab、plugins、toc、usage、quota、各 RPC 域),收口后经入口拿那个名字。
  注意其中 **30 处是「整块工厂」写法**(不保留原件,只给出几个名字):替换的若是入口,入口其余 429 个名字在这次测试里就都没了,被测代码一碰就是
  `undefined`。所以这 30 处要同时改成「保留原件、只换几个名字」(`async importOriginal => ({ ...(await importOriginal()), x: stub })`)。
  这是测试写法的改动,不改断言。
- **B 类,需要改成参数注入(3 处)**:被替换的函数是 providers **内部**调用的,入口上的替身够不着。
  - `__tests__/import-side-effect-free.test.ts:52` 换 `provider-table.ts` 的 `initializeRegistry` —— 调它的是 `chat-facade.ts` 的
    `configureAppProviderRegistry`(内部相对 import)。改法同 search 那次:`configureAppProviderRegistry(initialize = initializeRegistry)`,
    测试在入口上换掉 `configureAppProviderRegistry`、只把 `initialize` 换成计数。
  - `rpc/__tests__/models-domain.test.ts:69 / :75` 换 `vendors/codex/models.ts`、`vendors/github-copilot/models.ts` 的取数函数 —— 调它们的是
    `model-registry-service.ts` 经行为名册拿到的 `createModelsFetcher`。改法:让 `model-registry-service` 的取数器能从参数注入(或在测试里换掉
    名册给出的那一格),而不是替换某一家的文件;这样测试也不再点名任何一家。
- **C 类,测试本身该搬进 providers 目录(1 处)**:`engine/stream/__tests__/codex-native-tools.test.ts:12` —— 它测的是 codex 原生工具的判定,
  第 2 节建议把这件事收进 `vendors/codex/` 的运行时钩子,测试跟着搬进 `vendors/codex/__tests__/`,对 `model-registry-service` 的替换随之变成内部引用。

| 类 | 测试文件:行 | 被替换的内部文件 | 写法 | 替换的名字 |
| --- | --- | --- | --- | --- |
| A | `packages/backend/__tests__/collab-digest-lifecycle.test.ts:28` | `chat-facade.ts` | 保留原件、只换几个名字 | `generateChatResponse` |
| A | `packages/backend/__tests__/plugin-model-lifecycle.test.ts:10` | `chat-facade.ts` | 整块工厂(不保留原件) | `generateChatResponse` |
| A | `packages/backend/rpc/__tests__/chat-domain.test.ts:63` | `chat-facade.ts` | 整块工厂(不保留原件) | (整块替换) |
| A | `packages/backend/rpc/__tests__/models-domain.test.ts:54` | `model-registry-service.ts` | 整块工厂(不保留原件) | `forceRefresh`、`refreshProviderModels`、`getAllModels`、`getModelDisplayName`、`getModelNameAliases`、`getModelsForProvider`、`saveProviderModels`、`searchModels` |
| A | `packages/backend/rpc/__tests__/providers-domain.test.ts:22` | `chat-facade.ts` | 整块工厂(不保留原件) | `getAvailableProviders` |
| A | `packages/backend/rpc/__tests__/settings-domain.test.ts:46` | `provider-table.ts` | 整块工厂(不保留原件) | `invalidateProviderCache` |
| A | `packages/backend/rpc/__tests__/spaces-domain.test.ts:49` | `space-credentials.ts` | 整块工厂(不保留原件) | (整块替换) |
| A | `packages/backend/runtime/collab/actors/__tests__/room-config.test.ts:103` | `chat-facade.ts` | 整块工厂(不保留原件) | `generateChatResponse` |
| A | `packages/backend/runtime/collab/actors/__tests__/runtime-wiring.test.ts:96` | `chat-facade.ts` | 整块工厂(不保留原件) | `generateChatResponse` |
| A | `packages/backend/runtime/engine/__tests__/context-compact-append.test.ts:44` | `chat-facade.ts` | 整块工厂(不保留原件) | `generateChatResponse` |
| A | `packages/backend/runtime/engine/__tests__/context-compact-append.test.ts:53` | `model-registry-service.ts` | 整块工厂(不保留原件) | `getModelContextLength`、`getKnownModelMaxOutputTokens` |
| A | `packages/backend/runtime/engine/__tests__/context-compact-plugin.test.ts:36` | `chat-facade.ts` | 整块工厂(不保留原件) | `generateChatResponse` |
| A | `packages/backend/runtime/engine/__tests__/context-compact-plugin.test.ts:39` | `model-registry-service.ts` | 整块工厂(不保留原件) | `getModelContextLength`、`getKnownModelMaxOutputTokens` |
| A | `packages/backend/runtime/engine/__tests__/stream-engine-resume-agent-loop.test.ts:141` | `model-registry-service.ts` | 整块工厂(不保留原件) | `modelSupportsTools` |
| A | `packages/backend/runtime/engine/__tests__/stream-engine-resume-agent-loop.test.ts:85` | `chat-facade.ts` | 整块工厂(不保留原件) | `isProviderSupported`、`requiresOAuth`、`convertToolDefinitionsForProvider`、`generateChatTitle` |
| A | `packages/backend/runtime/engine/prompt/__tests__/system-prompt-snapshot.test.ts:115` | `chat-facade.ts` | 整块工厂(不保留原件) | `isProviderSupported` |
| A | `packages/backend/runtime/engine/prompt/__tests__/system-prompt-snapshot.test.ts:119` | `model-registry-service.ts` | 整块工厂(不保留原件) | `modelSupportsTools` |
| A | `packages/backend/runtime/engine/prompt/__tests__/system-prompt-snapshot.test.ts:132` | `agent-runtime.ts` | 整块工厂(不保留原件) | `createAgentProviderFromRuntime` |
| A | `packages/backend/runtime/engine/stream/__tests__/agent-loop-runtime-multimodal.test.ts:182` | `model-registry-service.ts` | 整块工厂(不保留原件) | `getModelContextLength`、`getKnownModelMaxOutputTokens`、`getModelCapabilityEntry` |
| A | `packages/backend/runtime/engine/stream/__tests__/agent-loop-runtime-multimodal.test.ts:208` | `agent-runtime.ts` | 整块工厂(不保留原件) | `createAgentProviderFromRuntime`、`isACPProviderRuntime`、`resolveProviderRuntimeRoute` |
| A | `packages/backend/runtime/engine/stream/__tests__/agent-loop-stream-integration.test.ts:254` | `model-registry-service.ts` | 整块工厂(不保留原件) | (整块替换) |
| A | `packages/backend/runtime/engine/stream/__tests__/openai-image-output-gate.test.ts:67` | `model-registry-service.ts` | 整块工厂(不保留原件) | `modelSupportsImageGeneration`、`modelServesImageOutputInLoop`、`onethingModelServesImageOutputInLoop`、`modelSupportsTools`、`getModelById` |
| A | `packages/backend/runtime/engine/stream/__tests__/stream-executor.test.ts:54` | `model-registry-service.ts` | 整块工厂(不保留原件) | `modelSupportsImageGeneration`、`modelServesImageOutputInLoop`、`modelSupportsTools`、`getModelById` |
| A | `packages/backend/runtime/plugins/__tests__/llm.test.ts:18` | `ipc-env.ts` | 整块工厂(不保留原件) | `resolveProviderApiKey` |
| A | `packages/backend/runtime/plugins/__tests__/llm.test.ts:21` | `chat-facade.ts` | 整块工厂(不保留原件) | `generateChatResponse` |
| A | `packages/backend/runtime/plugins/__tests__/session-messenger.test.ts:66` | `model-registry-service.ts` | 整块工厂(不保留原件) | `getModelContextLength` |
| A | `packages/backend/runtime/quota/__tests__/quota-credential.test.ts:24` | `space-credentials.ts` | 整块工厂(不保留原件) | `credentialTargetFromMarker`、`decideSpaceProviderCredential` |
| A | `packages/backend/runtime/toc/__tests__/lifecycle.test.ts:15` | `utility-provider.ts` | 整块工厂(不保留原件) | `createUtilityProvider`、`providerId`、`id`、`capabilities` |
| A | `packages/backend/runtime/toc/__tests__/record-turn.test.ts:43` | `utility-provider.ts` | 整块工厂(不保留原件) | `createUtilityProvider` |
| A | `packages/backend/runtime/usage/__tests__/record-usage.test.ts:17` | `model-registry-service.ts` | 整块工厂(不保留原件) | `getModelCapabilityEntry`、`pricing` |
| A | `packages/backend/runtime/usage/__tests__/record-usage.test.ts:23` | `space-credentials.ts` | 整块工厂(不保留原件) | `resolveSessionCredentialId` |
| B | `packages/backend/__tests__/import-side-effect-free.test.ts:52` | `provider-table.ts` | 保留原件、只换几个名字 | `initializeRegistry` |
| B | `packages/backend/rpc/__tests__/models-domain.test.ts:69` | `vendors/codex/models.ts` | 保留原件、只换几个名字 | `fetchOnethingCodexModels`、`getOnethingCodexFallbackModels` |
| B | `packages/backend/rpc/__tests__/models-domain.test.ts:75` | `vendors/github-copilot/models.ts` | 保留原件、只换几个名字 | `fetchCopilotModels` |
| C | `packages/backend/runtime/engine/stream/__tests__/codex-native-tools.test.ts:12` | `model-registry-service.ts` | 整块工厂(不保留原件) | `getModelById` |

## 4. 桌面界面那 13 个提到 `runtime/providers` 的文件

按边界规则,界面(`apps/desktop-react/src`)只许 import `@shared/*` 与 `@onething/client`;主进程(`apps/desktop-react/electron`)是宿主,
可以 import 后端。13 个文件逐个看:

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `electron/main.ts:463` | **真引用(宿主,合规)** | 动态 import `model-registry-service` 的 `refreshAllProviders`。主进程可以引后端,但按功能入口规矩要走入口(计入棘轮的 1 处 `apps/desktop-react`) |
| `electron/network-proxy.ts:45` | 真引用(宿主,合规,已走入口) | `validateOnethingAppProxyUrl` 从入口拿,不计数 |
| `src/data/__fixtures__/models.ts:5` | **真引用(测试夹具)** | 引 `effective-model`。边界检查对 `__fixtures__` 目录豁免(`excludeDirs: ['__fixtures__']`),所以不报红;功能入口棘轮不豁免,计 1 处 |
| `src/data/__fixtures__/providers.ts:2-3` | **真引用(测试夹具)** | 引 `builtin-manifests`、`builtin-providers`,同上计 2 处。这三只被引的文件闭包都很小(2 / 24 / 30),改走入口就要背入口的 245 个文件(含 `node:fs` 等);见第 6 节问题 6 |
| `src/__tests__/override-tables-read-only-in-backend.test.ts:13` | 只是注释 | 说明「覆盖表只在后端判」,指向 `effective-model.ts` |
| `src/data/provider-settings-port.ts:172` | 只是注释,**路径已过时** | 指向 `backend/runtime/providers/provider-usage.ts:69-73`,这个文件已经不存在 |
| `src/i18n/zh.ts:2022` | 只是注释 | 指向 `model-capability.ts` 的规则表 |
| `src/providers/__tests__/dials.test.ts:17` | 只是注释,**路径已过时** | 指向 `qwen.ts` / `kimi.ts`,这两只早已搬进 `vendors/<id>/` |
| `src/providers/__tests__/projection.test.ts:253` | 只是注释 | 带行号引 `model-registry.ts:719`(行号可能已漂移) |
| `src/providers/components/ModelOverridePopover.tsx:33` | 只是注释 | 指向 `model-capability.ts` |
| `src/providers/projection.ts:421, 462` | 只是注释 | 同上;462 行带行号 |
| `src/providers/store.ts:323, 1880` | 只是注释 | 指向 `model-capability.ts` 与 `registry.ts` |
| `src/providers/types.ts:115, 271` | 只是注释 | 271 行带行号引 `model-registry.ts:914` |

结论:界面渲染代码里**没有**一处真 import 后端;真引用只有两只测试夹具(边界规则豁免)与主进程两处(宿主,合规)。注释里有 2 处路径已经不存在、
3 处带了会漂移的行号,可以顺手改,不影响任何门。

## 5. 入口闭包预估

### 5.1 入口会变多大

按第 1 节「进入口」的那一批(`chat-facade`、`model-registry-service`、`space-credentials`、`ipc-env`、`credential-strategy` 一族、`agent-runtime`、
`utility-provider` / `utility-model`、`provider-table`、`provider-config` 的值、`manual-model-store`、`custom-manifests`、`space-config-migration`、
`custom-probe-analyst`、`space-defaults`、`space-ai-settings`、`credential-rotation`、两份名册、两份型号家族)全部加进入口,入口的闭包从
**245 个文件涨到约 684 个**(各模块闭包的并集)。涨出来的主要是:toolkit 50、sessions 43、collab 39、plugins 37、engine 32、tools 26、
logging 18、storage 16、permissions 13、auth 13、agents 13、external-agents 12、acp 11。原因是 `chat-facade`(闭包 666)、
`utility-provider`(674)、`custom-probe-analyst`(678)、`agent-runtime`(603)这几只装配半边连着引擎、插件与协作。
「纯事实」那一半(`manifest` 28、`model-capability` 31、`builtin-manifests` 24、`effective-model` 2、`network` 1、`bound-fetch` 2)都很小。

### 5.2 会被拖大的使用者(前 10)

只算**值 import**:只用到类型的 9 只文件(例如 `provider-binding/request-dump.ts`、`engine/stream/message-helpers.ts`)编译后不留 import,不受影响。

| 使用者 | 今天的闭包 | 改走(变大后的)入口 | 说明 |
| --- | --- | --- | --- |
| `agent-loop/providers/thinking/gemini-thinking.ts` | 2 | ≈684 | 只要 `model-families/gemini` 的两个常量 |
| `agent-loop/providers/thinking/anthropic-effort.ts` | 2 | ≈684 | 只要 `model-families/claude` |
| `agent-loop/providers/dialects/runtime-transport.ts` | 2 | ≈684 | 只要 `manual-models` 的一个函数 |
| `agent-loop/providers/thinking/anthropic-budget.ts` | 3 | ≈684 | 只要 `model-families/claude` |
| **`search/index/worker-network.ts`(索引 Worker)** | 13 | ≈685 | 只要 `bound-fetch` + `network`;这一只在 Worker 里跑,今天的入口(245)就已经会把它拖大,见第 6 节问题 4 |
| `stores/settings-defaults.ts` | 29 | ≈684 | 只要名册的行序 |
| `settings/settings-save.ts` | 32 | ≈684 | 只要 `model-capability` |
| `agent-loop/providers/thinking/custom-reasoning.ts` | 32 | ≈684 | 只要 `model-capability` |
| `agent-loop/providers/base/model-profile.ts` | 33 | ≈684 | 只要 `model-capability` / `manual-models` |
| `spaces/provider-credentials.ts` | 53 | ≈684 | 只要 `manifest` |

(第 11、12 名是 `agent-loop/providers/base/http-agent-provider.ts` 64 → 684、`agent-loop/providers/wires/anthropic-messages-wire.ts` 104 → 684。)
前 10 名里有 7 只住在 `agent-loop/providers/`,也就是线协议层本身 —— 见 5.3。

### 5.3 会不会成环

成环 = 两个功能互相 import。下表是与 providers **双向**相连的功能(只数非测试文件,「值」= 值 import 条数,「型」= 只引类型的条数):

| 另一方 | providers → 它 | 它 → providers | 例子(→ / ←) |
| --- | --- | --- | --- |
| agent-loop | 值 83 / 型 41 | 值 20 / 型 3 | `providers/agent-runtime.ts` → `agent-loop/providers/process-factory.ts`;`agent-loop/providers/base/http-agent-provider.ts` → `providers/model-capability.ts` |
| 包根 | 值 17 / 型 0 | 值 25 / 型 11 | `providers/chat-facade.ts` → `provider-binding/bound-fetch.ts`;`backend.ts` → `providers/credential-strategy-lifetime.ts` |
| engine | 值 3 / 型 1 | 值 32 / 型 6 | `providers/manifest.ts` → `engine/error-details.ts`;`engine/compact-session.ts` → `providers/provider-config.ts` |
| spaces | 值 22 / 型 1 | 值 1 / 型 1 | `providers/credential-rotation.ts` → `spaces/credentials.ts`;`spaces/provider-credentials.ts` → `providers/manifest.ts` |
| auth | 值 14 / 型 12 | 值 1 / 型 0 | `providers/auth/oauth-manager.ts` → `auth/process-auth-service.ts`;`auth/registry.ts` → `providers/vendors/runtimes.ts` |
| logging | 值 8 / 型 1 | 值 1 / 型 5 | `providers/chat-facade.ts` → `logging/configure-logging.ts`;`logging/diagnostics.ts` → `providers/index.ts` |
| plugins | 值 2 | 值 6 | `providers/credential-strategy.ts` → `plugins/plugin-contract.ts`;`plugins/api.ts` → `providers/credential-strategy.ts` |
| usage | 值 2 | 值 4 | `providers/credential-strategy-lifetime.ts` → `usage/usage-recorder.ts`;`usage/usage-recorder.ts` → `providers/provider-config.ts` |
| settings | 值 1 | 值 1 | `providers/custom-manifests.ts` → `settings/events.ts`;`settings/settings-save.ts` → `providers/model-capability.ts` |
| agents | 值 2 | 型 1 | `providers/provider-config.ts` → `agents/executor/registry.ts`(反向只引类型,不成值环) |

**环今天就有**,而且代码里已经在绕:`auth/registry.ts` 与 `providers/quota/registry.ts` 的文件头都写着「名册惰性读,因为模块加载期读会在环上读到
还没初始化完的表」。收口不会新造出功能级的环(这些边今天就在),但会**把环收紧到入口这一个文件上**:今天 agent-loop 的线协议文件只引
`model-capability.ts` 这类叶子,收口后它们 import 的是入口,而入口又经名册 import 回 agent-loop 的线协议层(`vendors/*` → `agent-loop/providers/base`)。
ESM 在环上按依赖深度决定谁先求值,`class X extends 基类` 这种**在模块顶层就要用到对方**的写法最容易读到还没初始化的绑定(TDZ)。
最危险的是 agent-loop 这一对(双向都有几十条值边);包根、engine 那两对是「装配层调产品层、产品层反过来要装配层的 fetch / 设置」,
今天靠函数体里调用(而不是模块顶层)才没出事。这份预估是静态的,真机证据(server 单文件包启动、CLI 启动、`import-side-effect-free` /
`assembly-lifecycle` 两个测试、三份 bundle)要等动手时跑。


## 6. 需要用户拍板的问题

**问题 1:providers 要不要拆成两个功能?**
今天一个目录里住着两种东西:「纯事实」那一半(manifest、能力账本、模型认亲、名册、各家目录 `vendors/`,闭包几十个文件)和「装配半边」
(对话门面 `chat-facade`、模型目录服务 `model-registry-service`、各空间的凭证 / 默认值 / 设置、凭证策略与轮换、后台杂活 provider、自定义服务商
自动识别,闭包 500–680)。一个入口全交出去,入口闭包 245 → 约 684,只想要一个常量的使用者(第 5.2 节前 10 名)全被拖到 684。
- 选项 A(**推荐**):拆成两个功能目录、各自一个入口。服务商事实与名册留在 `runtime/providers/`;装配半边按内容起名另立目录(候选
  `runtime/llm/`:「对话与模型目录这门服务」),它 import providers 的入口,反过来不许。
- 选项 B:不拆,一个入口全交,接受入口闭包约 684 与第 5.3 节收紧的环。

**问题 2:agent-loop 里那些「测某一家服务商」的测试,搬不搬进 providers?**
`agent-loop/__tests__/` 与 `agent-loop/providers/**/__tests__/` 里有 32 处深层引用直接测某一家的构造门面或方言,另有 11 处用
`providers/__tests__/custom-manifest-fixture.ts` 这只测试夹具。
- 选项 A(**推荐**):只测一家的搬进 `vendors/<id>/__tests__/`,夹具随之变成内部引用;对好几家都跑一遍的那几份,改成遍历行为名册。
  棘轮不给测试开豁免。
- 选项 B:棘轮对测试文件和测试基建(`__tests__/`、`__fixtures__/`)豁免,测试原地不动。

**问题 3:`agent-loop/providers/`(线协议、方言基类、思考线型)要不要并进 `runtime/providers/`?**
这一层与 providers 是双向强耦合(providers → 它 83 条值边,它 → providers 20 条),各家的方言配方住在 `providers/vendors/<id>/dialect.ts`,
却要继承 `agent-loop/providers/base/` 的基类。第 5.2 节前 10 名里有 7 只就是这一层的文件。
- 选项 A(**推荐**):并进 providers(「各条线协议怎么拼」和「各家怎么说」是同一件事),agent-loop 只留与服务商无关的循环。agent-loop → providers 的
  20 处深层引用和最危险的那一对环一起消失。这是一次搬家,按 search / sessions 的做法单独一笔。
- 选项 B:不并,线协议层改走 providers 入口,接受第 5.3 节说的环收紧到入口上,并在动手时用真机门逐项证明没有初始化顺序问题。

**问题 4:`bound-fetch` / `network` 被索引 Worker 用,怎么办?**
`search/index/worker-network.ts` 跑在索引 Worker 里,只要这两只小文件(闭包 13);走 providers 入口,今天就会把 245 个文件拖进 Worker,
按问题 1 选 B 则是约 685 个。
- 选项 A(**推荐**):把这两只(代理设置的校验与规整、绑超时与中止的 fetch)搬成独立功能 `runtime/network/`,自己一个入口;
  providers 与 search Worker 都从它的入口拿。它们本来就不属于「服务商」。
- 选项 B:像 sessions 那次一样,Worker 那一处保留深层引用,棘轮里 providers 一行留 1~2。

**问题 5:三处点名某一家的生产代码,按名册字段 / 运行时钩子改?**
- 选项 A(**推荐**):① `agent-loop/providers/codex.ts` 与 `process-providers.ts` 里的 `createCodexAgentProvider` 生产上无人调用,删掉(测试改用
  `vendors/codex/` 的门面并搬家);② codex 原生工具改成行为名册的可选钩子 `nativeTools`,引擎不再认识 codex;③ 自定义线的底配方改成名册上
  「我是某条线的参考配方」的声明(或提成协议层通用配方)。provider:gate 基线随之收紧 4 对,provider:drill 不受影响。
- 选项 B:这三处本批不动,作为 providers 一行的剩余深层引用留着,另开一笔。

**问题 6:壳的测试夹具与主进程那一处怎么走?**
`src/data/__fixtures__/{models,providers}.ts` 引的三只文件闭包都很小(2 / 24 / 30);主进程 `electron/main.ts` 动态 import
`model-registry-service` 的 `refreshAllProviders`。
- 选项 A(**推荐**):跟着问题 1 走 —— 拆分后夹具改走 `runtime/providers` 的入口(那时它是轻的那一个),主进程改走装配半边那个新目录的入口。
  注释里 2 处已不存在的路径、3 处会漂移的行号一并改掉。
- 选项 B:不拆的话,夹具仍走入口,接受壳的测试多装 245 个后端文件;或对 `__fixtures__` 在棘轮上豁免(与边界检查的豁免口径一致)。

**问题 7:A 类 30 处「整块工厂」的 `vi.mock`,允许改成「保留原件、只换几个名字」吗?**
替换目标从内部文件换成入口以后,整块工厂会把入口其余 429 个名字在那次测试里全抹掉。
- 选项 A(**推荐**):允许,逐条改成 `importOriginal` 展开再覆盖,断言不动;B 类 3 处按第 3 节改参数注入,C 类 1 处随测试搬家。
- 选项 B:这 30 处保留对内部文件的替换(棘轮里留这些处数),等对应文件搬进 providers 后再说。

## 7. 去处与入口图(2026-10-04,只分析、未改代码)

> 背景:第一次收口尝试(全部引用改走 providers 入口、不搬文件)在加载期崩了 —— 入口闭包 268 → 704 只文件,
> 与 auth / settings / sessions / spaces 连成一个 60 只模块的值引用环,`class … extends` 读到未初始化的基类,
> 根全量 vitest 367 个文件红。补丁留在会话 scratchpad 的 `s13/attempt1.diff`,工作区已退回 793651d4a。
> 用户随后拍板:**不新建功能**,把 providers 里「用服务商干活」的那类文件按内容分进已有功能;先算图,不动代码。
> 本节的全部数字出自 scratchpad 的 `s14/`(`sim.mjs` 是模拟器,`scen-*.json` 是各方案的搬家表,`out-*.json` 是结果)。

### 7.1 量法

**图**:`packages/backend` 与 `packages/shared` 的全部非测试文件,边是**值引用**。用 TypeScript checker 把每个被 import 的名字解析到声明它的文件:
只引类型的名字(接口、类型别名、`import type`、没写 `type` 但实际只是类型的名字)不成边,因为编译后会被擦掉,esbuild 也会删;
动态 `import()` 不成边,因为它不在加载期执行。环 = 这张图的强连通分量(下文写「SCC」,两只以上文件互相能走到)。

**模拟搬家**:没有在 worktree 里真搬文件,而是在 HEAD 的代码上按「文件 → 所属功能」表重写边。理由是 SCC 只取决于「谁连到谁」,
文件挪到哪个目录、说明符怎么写都不改变这张图;在图上改比真搬 19 只文件、重写几百处说明符快两个数量级,而且每个方案都从同一份 HEAD 出发,
不会互相污染。重写规则:

- 引用方 A 要一个住在 D 的名字:A 与 D 同功能 → 直连 D(目录里的相对引用);不同功能 → 连到 D 所属功能的入口 `runtime/<F>/index.ts`,
  并记一条「入口 → D」(入口为外面再导出它)。`export *`、命名空间 import、副作用 import 按整只模块同样处理。
- 本批只收口 providers:只有**目标文件今天住在 providers 里**的那些引用改走入口(`--route-orig providers`),其余功能之间的深层引用保持今天的样子。
  这正是「providers 收口这一笔做完」的那一刻的图。
- 入口自己今天的再导出行保留,只去掉指向「已搬去别的功能」的文件的那几行(那几行跟着文件去新家的入口,由外面是否真要决定)。
- 包根(`backend.ts`、`rpc/`、`server/` …)与 `packages/shared` 没有入口,指向它们的边直连。

**加载期跨环取值**(下文写「隐患」):模块 M 在求值时 —— 顶层语句,以及顶层调用到的函数体、`new` 到的构造器与实例字段 —— 读到一个
模块级绑定(`const` / `let` / `class` / 命名空间),而那只绑定要经过与 M 在同一个 SCC 里的模块才拿得到。这种读法读到的是不是已初始化的值,
取决于谁先被 import。函数声明会被提升,读它不算;调用它就顺着进函数体看。括号里单列其中 `class … extends` 的条数,因为它一旦读到未初始化
就是加载时直接抛,没有任何惰性化的余地。

**校验**:用同一个模拟器算「不搬家、只把 providers 的引用改走入口」,得到的 7 条隐患与第一次尝试在真代码上量到、并在探针里真崩的 7 处**逐条相同**
(`process-auth-service` 的 `extends OnethingAuthService` 与两处取值、`external-agents/provider` 的 `extends BaseAgentProvider`、`settings-defaults`
的名册行序、`permission-policy` 的两处);环是 57 只(真代码上量到 60,差的 3 只是真代码里那几处只引类型、没写 `type` 的引用,模拟器按「编译后擦掉」不算)。

### 7.2 providers 里哪些文件是「重」的

在 HEAD 的真实图上,providers 里有 19 只文件的值闭包会拉进 sessions / settings / spaces / toolkit 之一(闭包大小在括号里):

- 对话与后台杂活:`chat-facade`(685)、`utility-provider`(693)、`custom-probe-analyst`(697,要请模型来分析)。
- 按本进程宿主能力造 provider:`process-factory`(621)、`process-providers`(625)、`agent-runtime`(622)、`codex.ts`(305,无人调用的包装,第 4 项要删)、
  `openai-compatible-fetch`(301,带代理的 fetch 走设置入口)。另有 `media-reader`(读媒体库)按这个口径不算重,但它只被 `process-factory` 用,随它一起走。
- 凭证:`space-credentials`(544)、`credential-strategy`(544)、`credential-strategy-lifetime`(544)、`credential-rotation`(545)。
- 按空间取默认值 / 设置 / 一次性迁移:`space-defaults`(462)、`space-ai-settings`(462)、`space-config-migration`(312)。
- 模型目录:`model-registry-service`(544)、`manual-model-store`(297);把设置里的自定义服务商同步进 manifest 注册表的 `custom-manifests`(301)。
- 旧 OAuth 兼容门面 `auth/oauth-manager`(304)。

它们「重」的直接原因都是几条边:要带代理的 fetch 就 import 设置入口(`createRequiredAppFetch`),要 OAuth 就 import `auth/process-auth-service`,
要按会话找空间就 import 会话入口,要空间的凭证 / 设置就 import `spaces/*`。`vendors/` 下各家一只都不重(各家 `oauth.ts` 只引 `auth/oauth-token`、`auth/jwt` 两只叶子)。

### 7.3 方案比较

每行一个方案。「新环」只列 HEAD 上没有的 SCC(HEAD 自己的 17 / 5 / 3 / 2 不算新)。九个使用者是第一次尝试里成环的那 9 只外面的文件,数字是它所在 SCC 的大小,
1 = 不成环。

| 方案 | 搬家表 | 最大 SCC | 新环 | 环里的入口 | 隐患(其中 extends) | 九个使用者里仍成环的 |
| --- | --- | --- | --- | --- | --- | --- |
| HEAD | 不搬、不收口 | 17 | 无 | 无 | 0(0) | usage-recorder 5(HEAD 已有的环,见 7.4) |
| 0 | 不搬,只收口 | 57 | 57 | auth、providers、sessions、settings | 7(2) | 9 个全在 57 里 |
| a1 | 对话 + 杂活 → engine;凭证四件 → auth;空间三件 → spaces;模型目录三件留 providers | 59 | 59 | auth、engine、providers、sessions、settings、spaces | 7(2) | 9 个全在 59 里 |
| a2 | 同 a1,空间三件 → settings | 58 | 58 | auth、engine、providers、sessions、settings | 7(2) | 9 个全在 |
| b | 同 a1,凭证四件 → spaces | 59 | 59 | 同 a1 | 7(2) | 9 个全在 |
| c1 / c2 / c3 | a1 / a1 / b 之上,模型目录三件 → settings / engine / settings | 59 | 59 | 同 a1 | 7(2) | 9 个全在 |
| d1 | 19 只重文件全部搬走(外加随 `process-factory` 走的 `media-reader`):对话、杂活、造 provider 那一族、`credential-rotation`、`custom-probe-analyst` → engine;凭证其余三件、空间三件、`manual-model-store`、`custom-manifests` → spaces;`oauth-manager` → auth;**模型目录服务 → engine** | 17 | 11 / 4 | engine、providers、spaces | 1(1) | provider-helpers 11、external-agents/provider 4、usage-recorder 11 |
| d2 | 同 d1,模型目录服务 → settings | 22 | 22 / 4 | auth、providers、sessions、settings、spaces | 2(2) | external-agents/provider 4、usage-recorder 22 |
| d3 | 同 d1,模型目录服务 → spaces | 17 | 6 / 4 | providers、spaces | 1(1) | external-agents/provider 4、usage-recorder 6 |
| d3x | d3 之上,`external-agents/provider.ts` → providers | 17 | 6 | spaces | 0(0) | usage-recorder 6 |
| d3x + 断边 | d3x 之上,`credential-strategy-lifetime` 不再静态 import `usage-recorder`(见 7.4) | 17 | 无 | 无 | 0(0) | 全不成环 |
| d1x + 断边 | d1 + 同样两处(模型目录服务 → engine) | 17 | 无 | 无 | 0(0) | 全不成环 |
| d2 + 同样两处 | 模型目录服务 → settings | 18 | 18 | auth、sessions、settings、spaces | 1(1) | 全不成环,但 settings 入口与 spaces、sessions、auth 成环 |
| d3n2 | d3 + 断边,外部 agent 那条改成「factory 不再 import 外部 agent 的 provider」而不是搬文件 | 17 | 无 | 无 | 0(0) | 全不成环 |

读法:

- **候选表(a / b / c)一行都不行**,而且只比「不搬」多两只。原因不是那几只该去哪,而是**留在 providers 里的那几只重文件**:`process-factory`
  (import 设置入口、`auth/process-auth-service`、外部 agent 的连接器注册表)、`agent-runtime` / `process-providers`(经它)、`auth/oauth-manager`(import auth 入口)、
  `codex.ts`、`openai-compatible-fetch`、`custom-manifests`(import 设置入口)、`media-reader`(import 媒体库)。只要其中任何一只留着,providers 入口就还连着设置入口,
  而设置入口里的 `settings-save` / `settings-defaults` 又要 providers 入口的轻名字,于是环原样还在。凭证放 auth 还是 spaces、空间三件放 spaces 还是 settings,
  在这个前提下都不影响结果。
- **19 只全搬走以后,只剩两个结**,而且两个都与「放哪」无关,是两条具体的边(7.4)。
- **模型目录服务不能放 settings**:它要按空间凭证去拉(`space-credentials` 已在 spaces),放进 settings 就让设置入口 → 模型目录 → spaces 入口 → 会话 → 设置入口成环(d2 那 18 只)。
  放 engine 或 spaces 都零环。
- d3n2 说明外部 agent 那个结也可以不搬文件解开,代价是改登记方式(见 7.4)。

### 7.4 放哪都成环的两处,卡在哪条边上

1. **`providers/factory.ts` → `external-agents/provider.ts`,反方向 `external-agents/provider.ts` 的 `class … extends BaseAgentProvider`**。
   `factory.ts` 在加载时调 `registerExternalAgentProviderRuntime("acp")`,登记的工厂用的是外部 agent 那只 provider 类;那只类又继承 providers 的基类。
   providers 入口必须交出 `factory.ts` 的名字(agent-loop 要),所以只要外部 agent 的 provider 住在 providers 之外、又经入口拿基类,
   就是「providers 入口 → factory → external-agents/provider → providers 入口」三只的环,而且是 `extends`(d3 那条 4 只的新环、1 条隐患)。
   两种解法:**(i)** 把 `external-agents/provider.ts` 搬进 providers —— 它本来就是「外部 agent 这一种 AgentProvider 的实现」,与各家的 provider 是同一类东西,
   它对外部 agent 功能只要类型与 `agents/executor/capabilities` 一只叶子(d3x);**(ii)** `factory.ts` 不再 import 它,改由外部 agent 功能在装配时自己
   登记这一行工厂(d3n2)。(ii) 把一次加载期登记改成装配期登记,要动装配顺序,需要用户拍板;(i) 只是搬一只文件。
2. **`credential-strategy-lifetime` → `usage/usage-recorder`(`getUsageLedger`),反方向 `usage-recorder` → `space-credentials`(`resolveSessionCredentialId`)与
   模型目录服务(`getModelCapabilityEntry`)**。这是 HEAD 上就有的那个 5 只的环(`credential-strategy-lifetime` / `credential-strategy` / `model-registry-service` /
   `space-credentials` / `usage-recorder`),今天它全是深层引用、不经过任何入口,所以无害;一旦 providers 收口,凭证那几只住在哪个功能,那个功能的入口就落进环里
   (d3x 里是 spaces 入口那 6 只;把插件凭证策略两件改放 plugins 也只是换成 plugins 入口,环还在,测过)。这个环跨着 usage 与凭证两个功能,**没有一种放法能让它
   在同一个功能里**,只能断一条边。最便宜的一条是 `credential-strategy-lifetime` 那一处:它只在 `captureLedger()` 的函数体里懒取账本,改成由装配处
   (`backend.ts` 本来就在 `new CredentialStrategyService(...)`)把「取账本」的函数传进去,静态 import 就没了。反方向那两条是用量记账真要的事实,不宜断。
   这一处要改 `CredentialStrategyService` 的构造参数与 `backend.ts` 的一行装配,需要用户拍板。

### 7.5 今天的基线与「入口之间不许成环」这道门

**HEAD 的读数**(同一算法,不搬、不改写):值引用 SCC 四个,大小 17 / 5 / 3 / 2;
17 是 engine / collab / goals / toolkit 那一组(`engine-layer`、`stream-engine-runtime`、`agent-loop-executor`、`tool-execution`、`triggers/index`、`goals/kick`、`toolkit/wiring` 等 17 只),
5 是上面 7.4 第 2 条那组,3 是 `plugins/{api,background-table,plugin-manager}`,2 是 `permissions/{permission-asks,permission-policy}`。
**四个 SCC 里没有任何一只 `runtime/<功能>/index.ts`,也没有总桶 `runtime/index.ts`**;按上面的口径,加载期跨环取值 0 处。

功能级的图(功能 A 有任一值边指向功能 B 就连一条)今天是**一个 50 个功能的大环**(378 条功能间的边),所以按功能级算的判据在今天就是满屏红,没法当门用;
文件级的判据才分得出好坏。

**建议的判据**(新门,例如 `entry:cycle-gate`):在上面这张值引用图上算 SCC,**任何一个 SCC 只要含有 `runtime/<功能>/index.ts` 或 `runtime/index.ts`,就红**,
并打出那个 SCC 经入口的最短环(和本节表格里「卡在哪条边上」同一种输出)。今天读数 0,所以它是**零基线硬闸**,不需要基线文件。

- 它管的正是这次出事的那件事:入口一旦在环里,外面谁先 import 谁就决定了入口背后的东西是否已初始化;第一次尝试里 `assembly-lifecycle` 单跑时还出现过 100 秒以上无输出、CPU 为 0 的情况,原因没有查清,只记作现象。
- **不会误报的地方**:只引类型的名字(含没写 `type` 的)不成边,动态 `import()` 不成边,测试文件不扫 —— 这三类正是最容易让「图上有环、运行时没有」的来源。
- **刻意不管的地方**:不经过任何入口的深层环(今天那四个)不红;它们是否该拆,是各功能自己收口时的事。
- **有意的「误报」**:一个入口在环里、但环上恰好没有加载期取值,门照样红。这是故意的 —— 那种环今天不崩,只是因为 import 顺序碰巧对,下一次加一行顶层常量就会崩。
- 加载期跨环取值(本节的「隐患」)今天也是 0,可以作为第二条判据,但它的函数体追踪是近似的(方法调用按 checker 能解析到的声明走,最深 8 层),
  建议先只在门的输出里打出来,不作红绿判据。

**一个提醒**:本节的推荐方案只保证「providers 这一笔收口做完的那一刻」入口不在环里。如果把**所有**功能之间的引用都同时改走入口,今天的图会变成一个
653 只模块、45 个入口的环(只把 engine 一个功能收口就有 247 只的环,只收口 usage 有 71 只)—— 其他功能也有自己的「轻名字被下层要、重的那半在上层」的问题。
这道门的作用正是让后面每个功能收口时当场看见自己造成的环,而不是在加载期崩了再查。推荐方案落地以后,留在 providers 里的文件对外只剩这些边:
`agent-loop/loop-primitives`(9 处)、`auth/oauth-token`(5)与 `auth/jwt`(1)、`engine/error-details`(2)与 `engine/engine-primitives`(1)、`usage/pricing`、
`spaces/credentials`(`route.ts` 用)、`agents/executor/{registry,capabilities}`、`agent-loop/provider-error-classification`。它们全是对方的叶子文件;
等 auth / engine / usage / spaces / agents 自己收口时,这些叶子必须不和那些功能的重文件共用一个入口闭包,否则会在那时重新成环(例如只把 spaces 也收口,
`route.ts` → spaces 入口 → 模型目录服务 → providers 入口就是 39 只的环)。

### 7.6 `tools/access-control/permission-policy.ts:22` 的惰性化(不改代码,写法与理由)

今天第 22 行在加载时执行 `const permissionRuntime = createOnethingPermissionRuntime({ grantMatcher: PermissionGrants.matchGrant, permissionBridge: Permission })`,
把 `grant-storage` 的命名空间属性与 `permission-asks` 的 `Permission` 命名空间读进一个选项对象。在环上先求值它时,两者读到的会是 `undefined`,而且**不抛**:
`decide` 有 `?? matchGrant` 兜底,`enforce` 不带桥的那一处(第 236 行)则会静默地拿到一个没有桥的运行时。

改法:换成首次用到时才建的持有器 ——

```ts
const permissionRuntimeHolder: { current?: OnethingPermissionRuntime } = {}
function permissionRuntime(): OnethingPermissionRuntime {
  return (permissionRuntimeHolder.current ??= createOnethingPermissionRuntime({
    grantMatcher: PermissionGrants.matchGrant,
    permissionBridge: Permission,
  }))
}
```

文件里 9 处 `permissionRuntime.decide(…)` / `permissionRuntime.enforce(…)` 改成 `permissionRuntime().…`。持有器是 `const`(`assembly:gate` 只禁模块级 `let`)。

等价理由:`createOnethingPermissionRuntime` 只是 `new OnethingPermissionRuntime(options)`,构造函数只把选项存进私有字段,不读设置、不碰磁盘、不起计时器;
`matchGrant` 是函数声明的导出,`Permission` 是模块级命名空间对象,两者在各自模块里都从不被重新赋值,所以首次调用时读到的与加载时(在不成环的情况下)读到的是同一个函数、
同一个对象;建一次以后同一只运行时一直用,和今天在加载时建的那一只行为相同。装配顺序不动 —— 第一次用到发生在权限判定的调用里,那时装配早已完成。

### 7.7 推荐方案

**推荐 d3x + 断边**,即:

| 去处 | 文件(`runtime/providers/` 下) | 按内容的理由 |
| --- | --- | --- |
| `engine/` | `chat-facade`、`utility-provider`、`custom-probe-analyst`、`process-factory`、`process-providers`、`agent-runtime`、`media-reader`、`openai-compatible-fetch`、`credential-rotation`、`codex.ts`(第 4 项删) | 都是「拿本进程的宿主能力(带代理的 fetch、OAuth 刷新、媒体库、外部 agent 连接器)去用服务商干活」:发一轮对话、起标题、后台杂活、请模型分析自定义服务商、造这一轮要用的 AgentProvider、失败了换一把 key 重试。使用者也几乎全在引擎 |
| `spaces/` | `space-credentials`、`credential-strategy`、`credential-strategy-lifetime`、`space-defaults`、`space-ai-settings`、`space-config-migration`、`manual-model-store`、`custom-manifests`、`model-registry-service` | 都是「某个空间的服务商配置」:凭证池与插件凭证策略、按会话所在空间取默认值和那份设置、旧凭证迁进默认空间、手填模型(勾选落空间)、把空间设置里的自定义服务商同步进 manifest 注册表、用这个空间的凭证去拉各家模型清单 |
| `auth/` | `auth/oauth-manager` | 它是 auth 服务的旧兼容门面,头注就写着新代码直接用 auth 服务 |
| `providers/`(搬进来) | `external-agents/provider.ts` | 它是「外部 agent」这一种 AgentProvider 的实现,与各家 provider 同类;留在外面就与 `factory.ts` 成 `extends` 环 |
| 断一条边 | `credential-strategy-lifetime` 不再静态 import `usage-recorder`,账本由 `backend.ts` 构造 `CredentialStrategyService` 时传入 | HEAD 上那个 5 只的环跨 usage 与凭证两个功能,放哪都会把一个入口拉进环 |

结果:providers 收口做完时,值引用 SCC 与 HEAD 完全相同(17 / 5→没了 / 3 / 2,HEAD 那个 5 只的环随断边一起消失),环里没有任何入口,加载期跨环取值 0 处,
九个曾成环的使用者全部不成环;providers 剩下的文件对外只连别家的叶子文件(7.5 末尾那张清单)。这个方案同时满足「不新建功能」与「providers 不拆」——
providers 留下的是服务商的事实、名册、各家目录、线协议与方言,以及不带宿主能力的 provider 工厂。

**需要用户拍板的点**:

1. **断边**(7.4 第 2 条):给 `CredentialStrategyService` 加一个「取用量账本」的构造参数,`backend.ts` 那一行装配传进去。装配顺序不变,但改了一个类的构造签名。
2. **外部 agent 的 provider 进 providers**(7.4 第 1 条的 (i))。若更愿意不搬它,可选 (ii):`factory.ts` 不再在加载时登记外部 agent 那一行工厂,改由外部 agent 功能在装配时登记 —— 这是登记时机的改变,零环效果相同(d3n2)。
3. **模型目录服务放 spaces 还是 engine**:两处都零环(d3x + 断边 / d1x + 断边)。推荐 spaces,理由是它按空间凭证拉、结果落设置,与手填模型同住;
   放 engine 的好处是使用者(引擎、RPC models 域、插件、用量)多在引擎一侧,坏处是 engine 本身是 HEAD 上 17 只那个环的一员,往里加重文件会让它以后的收口更难。
4. **「入口之间不许成环」这道门**(7.5)是否作为零基线硬闸、与这一笔一起落。
5. 这一笔要搬 21 只文件(providers 里 20 只,外加搬进来的 `external-agents/provider.ts`),外加 `permission-policy` 的惰性化(7.6)与第一次尝试里已证明需要的两处惰性化(`settings-defaults` 的种子表、`process-auth-service` 的兜底 fetch;
   在推荐方案下它们已不在环上,但仍是加载期调用外部工厂,建议照做以免后面别的功能收口时再踩)。

## 8. 实施结果(收口第一部分,s18,2026-10-04,未提交)

在 providers 归位(第 7 节推荐方案的 Fable 修订版,`feature-layers-and-provider-placement-2026-10.md` 第 9 节)之后收口。决策 D39–D45 记在
`backend-structure-decisions-2026-10.md`;施工账在 `server-client-split-2026-10.md` §6「providers 收口第一部分」。

**入口交出什么**:`index.ts` 只剩具名导出,`export *` 一行不剩;文件头是 R3 说明书(做什么、交出哪几类、依赖哪些功能、有意留着的那一处深层引用)。
197 个名字(值 116、类型 81),每个都从声明它的那只文件导出,按九类分组:

| 类 | 值 | 类型 | 合 |
| --- | --- | --- | --- |
| 服务商自述与名册(manifest、内置 manifest / 服务商信息、两份名册) | 12 | 4 | 16 |
| 服务商定义与注册表(十个契约类型、`ipc-types` 三个形状、注册表七个函数) | 7 | 13 | 20 |
| 模型目录与能力(目录纯逻辑、能力账本、认亲、手填模型、models.dev 缓存、模型列表接口) | 40 | 15 | 55 |
| 生效配置与凭证解析(`provider-config`、`provider-runtime`、环境变量 key、私有旋钮、杂活模型) | 18 | 10 | 28 |
| 造 AgentProvider 与线协议(纯工厂、OpenAI 兼容线、方言登记与自定义方言、自动识别纯函数、运行时路由、思考档位、provider data) | 23 | 12 | 35 |
| 对话门面与请求拼装(`createOnethingProviderFacade`、流式适配、起标题请求、消息与工具定义的线形状) | 3 | 15 | 18 |
| 界面形状的投影(服务商列表、环境变量状态、模型查询、方言选项) | 9 | 6 | 15 |
| 配额、计价与诊断 | 4 | 2 | 6 |
| 旧接口类型(`Provider` 等,agents 的老引擎在用) | 0 | 4 | 4 |

名单怎么定的:用 TypeScript checker 把 providers 目录之外每一处 import / re-export 的名字解析到声明文件(scratchpad `s18/needs.mjs`),取非测试引用、
今天已经走入口的测试、壳的两只测试夹具要的名字;只被测试深层引用的 30 个名字(各家构造门面、方言、错误映射、地址常量……)不进入口。
经总桶 `runtime/index.ts` 拿 providers 名字的地方是 0 处,所以总桶对旧桶 `agent-providers.ts` 的 `export *` 与旧桶本身一起删掉(D41)。

**引用改走入口**(脚本 `s18/rewrite.mjs`,带 dry 模式):86 只文件。非测试 56 处改走入口(同一文件里指向 providers 的几条 import 合成一条);
测试里名字全在入口的 14 处改走入口,其余 48 处留深层 —— 原来写包名深层说明符的 23 处(含 `vi.mock`、`typeof import()`)改成相对路径(D44),原来就是相对路径的 25 处不动。
providers 目录里两处包名自引用改成相对路径(`builtin/index.ts`、`builtin/__tests__/codex.test.ts`),`provider-table.ts` 经入口取类型(D42),
`__tests__/provider-facade.test.ts` 从 `../index.js` 改引兄弟文件。壳的两只测试夹具改走入口(问题 6 选 A,D43)。

**留下的深层引用**:`entry:gate` providers 一行 123 → **49**,非测试只剩 1 处 —— `engine/stream/codex-native-tools.ts` → `vendors/codex/native-tools.ts`(D40,第二部分的 `nativeTools` 钩子收掉);
其余 48 处全是测试:只测一家的构造门面 / 方言 / 地址常量 / OAuth(第二部分搬进 `vendors/<id>/__tests__/`)、`vi.mock` 打在 providers 内部文件上的 11 处(`provider-table` 6、`ipc-env` 3、codex / Copilot 模型取数各 1)、
`custom-manifest-fixture` 3 处、`builtin/index` 3 处、`provider-config` 里入口不交出的测试用函数 3 处等。

**exports**:删掉 47 个 `./runtime/providers/*` 深层键(含 `./runtime/providers/index`),只留 `./runtime/providers`。没有删不掉的键。

**闭包与环**:入口闭包 287 → 286(少了纯转发的 `agent-providers.ts` 与只剩类型的 `provider-definition.ts`,多了 `dialect-options.ts`,它顶层只有一句已在闭包里的副作用 import,
不取值)。新进闭包的模块没有加载期取值,所以本笔没有新的 const 持有器。`cycle:gate` 0(59 个入口);不经入口的深层环 17 / 3 / 2 与改前相同 —— 没有断边。
`import-side-effect-free.test.ts` 加了一条「import providers 入口不建仓库、不读设置」;在 `ipc-env.ts` 顶层临时加一句 `getSettings()` 时它红在
`['settings-repository', 'settings-path']`,恢复后绿。

**门**:entry 2806 → 2732(只有 providers 一行变,基线已收紧);layer 97 / 53 不变;cycle 0;name 131;provider 109;boundary / transport / log / session 绿;
feature-map 重新生成(边数变了)。四份 bundle 的 Worker 逐字节同大,三份主包各小约 9–14KB。
