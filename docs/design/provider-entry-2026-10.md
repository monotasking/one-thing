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
