# 架构方向与 provider 试点(2026-10-01)

> 起因(09-30):用户想"扔掉 core / runtime",因为一个功能(例如 provider)散在很多地方,读代码很难。
> 这份文档记录的是 09-30 至 10-01 两天里**和用户一起定下的方向**,以及第一步(provider 试点)的施工计划。
> §1 里除了标「待定」或「推论」的条目,都是用户拍过的;施工计划在用户确认后才开工。

## 0. 一句话

**一个后端,其余都是客户端;一个能力,一个家。** 先拿 provider 做试点,证明"一个服务商只住一个文件夹"做得到,再决定包结构要不要动。

## 1. 已定的方向

### 1.1 进程与客户端

- 只有一个后端。Electron 窗口、浏览器、CLI、手机都是它的客户端,都走 `POST /api/rpc` + `GET /api/events`。
- onething 主要跑在本机。远程接入只有两种:手机 app(能力与电脑一致)与 gateway(按人分权限,**以后再做**)。
- **两个进程**:后台后端 + Electron 界面客户端。
  - 后端由 Electron 拉起和停止,**不开机自启**。
  - 缺省:后端随 Electron 同起同停;可在设置里改成"Electron 退出后后端继续运行"。
  - 关窗口不是退出 Electron,只有 Quit 才退出(macOS 惯例)。**现状不符**:`apps/desktop-react/electron/main.ts:789` 是 `window-all-closed → app.quit()`,要改。
  - CLI 缺省同样依附于 Electron 拉起的后端;可配置为由 CLI 自己拉起后端。CLI 改走 HTTP,现在那套 unix socket + 38 个自有方法(`apps/cli/src/daemon-server.ts`)退役。
- **待定**:独立的 `apps/server` 是否保留为"开发与门测试用的无界面后端"(我提的建议,用户未答)。

### 1.2 什么归后端,什么归客户端

划分依据:**这件事发生在哪台机器上、谁的屏幕上**。

- 归后端:provider、会话、工具、终端、插件、gateway、凭证。
- 归客户端:界面、内置浏览器、原生对话框、深浅色、用户自己点的"打开链接 / 在访达中显示"。
- **不需要经过后端的,不再经过后端。** 现在 `dialog`、`settings.shouldUseDarkColors`、`shell` 三格宿主端口把客户端的事注入进了后端,拆进程时移出。
- agent 请求打开链接(`backend/wiring/acp/elicitation-bridge.ts`):后端不再代开,卡片上给按钮,由用户面前的客户端打开。
- AI 的"在访达中显示"(`dir:` 资源的 `reveal`):**先保留**。拆进程时把它的 `home` 从 `'core'` 改为 `'shell'`,走现成的"后端请客户端执行"机制(`backend/wiring/resource/shell-dispatch.ts`,`workbench` 资源已在用)。
- 内置浏览器留在 Electron,**给 AI 用的那一半不做**:`browser:` 资源、`browser_navigate` 权限效果、`gate:browser` ① 以后删;`wrapUntrustedText` 保留(`web_open` / `web_search` 在用)。CDP 断掉。
- **推论**(由"不需要经过后端的不再经过后端"推出,未单独拍):浏览器的标签表与登录状态归 Electron 自己的数据目录,不再写 `<store>/browser/`。

### 1.3 凭证

- **凭证由后端管理。**
- 迁移:Electron 加「导出凭证」,导出文件用**口令派生的密钥**加密;迁移程序用同一口令解密,交给后端重新加密保存。顺序固定为:停旧后端 → 导出 → 迁移并逐条校验 → 删旧密文(OAuth token 会自动刷新,半路刷新会让导出过期)。导出 / 导入同时作为长期功能保留(备份、换电脑)。
- 后端的主密钥放**系统钥匙串**。访问必须带超时、不挡启动;解不开时向客户端推"凭证已锁定"。门测试在临时 store 上跑,需要明确的"不用钥匙串"模式。(CLAUDE.md 记载:钥匙串授权框无人点会让装配无声挂死。)
- 任何接口不得把凭证原文返回客户端。拆进程后所有客户端都在进程外,`payloadLeavesProcess` 恒真,脱敏不能再按它判。

### 1.4 插件与 gateway

两者都要用,都挂在后端。今天都没有宿主在跑:`bootstrapPluginSystem` 零生产调用者,`@onething/gateway` 零宿主 import。

## 2. 为什么 provider 难读:两个问题

量测见 09-30 会话;以下数字都是 10-01 实测。

### 2.1 一个功能被切在七个目录里

`core/providers`、`runtime/src/providers`、`runtime/src/agent-loop/providers`、`backend/provider-binding`、`backend/wiring/providers`、`backend/wiring/agent-loop/providers`、`backend/rpc/domains/{providers,models}.ts`,外加契约 `shared/ipc/providers.ts` 与壳 `apps/desktop-react/src/providers`。

同名文件 `registry` / `model-registry` / `manual-models` / `custom-probe` 各在 runtime 与 backend/wiring 有一份,是**同一个功能的逻辑半边与接线半边**,来自拍板 #25(当时状态"已按默认开工,待知会")。provider 对外依赖只有 `spaces`、`stores/settings`、`auth`、`logging`、`current.ts` 五样,#25 那一刀落在很少几条边上。

死代码不是原因:完全无人使用的只有 `runtime/src/providers/deepseek.ts` 与 `tool-result-content.ts`(约 470 行)。

### 2.2 一个服务商散在二十来个文件里(主要问题)

以智谱为例。用 P0 定义的尺子量(§4 P0),智谱出现在 **22 个文件**里,其中只有 3 个是它自己的(`zhipu.ts`、`dialects/zhipu.ts`、`thinking/zhipu-thinking.ts`),另外 19 个是别处。同一把尺子量其余各家:deepseek 35、qwen 26、kimi 26、gemini 29、codex 43、openai 64(openai 含部分协议名残留,P0 会细化)。

| 性质 | 位置 |
| --- | --- |
| 自己的数据写在公共大表里 | `runtime/providers/zhipu.ts`(接口地址)、`dials.ts:72`、`env.ts:25`、`model-capability.ts:802`、`model-identity.ts:38`、`models-dev-catalog.ts:24`、`provider-config.ts:33`(错误码说明)、`builtin-manifests.ts:121` |
| 通用代码里的特例分支 | `provider-options.ts:130`、`agent-loop/providers/factory.ts:679`、`spaces/provider-credentials.ts:37`/`:71`、`zhipu.ts:54` |
| 写死名单的契约 | `shared/ipc/providers.ts`:`AIProviderId` 联合、`AIProvider` 枚举、`ZhipuApiMode` 与 `zhipuApiMode` 字段;`shared/defaults/settings.ts:97` 的缺省值 `zhipuApiMode: 'standard'` |
| 违反骨架法 | `core/engine/error-details.ts:29` 的 `ZHIPU_ERROR_DESCRIPTIONS`,与 `provider-config.ts:33` 重复 |
| 自己的家 | `dialects/zhipu.ts`、`thinking/zhipu-thinking.ts` |
| 壳渲染(骨架法允许) | `provider-icons.ts`、`i18n/{zh,en}.ts` |

批 M(`docs/design/provider-settings-rework-2026-09.md` §5)已经立了 manifest 注册表(`runtime/src/providers/manifest.ts`)和"不许点名"的活口(`providers/__tests__/manifest-no-enumeration.test.ts`),但那把尺子只管五个订阅 / 登录型 id,其余各家的数据仍在公共大表里。**这次试点就是把批 M 做完。**

## 3. 目标形状

```
providers/
  catalog/       模型目录、能力、认亲、手填模型
  credentials/   凭证池、轮换、策略、OAuth、自动识别
  request/       wire、dialect 与 thinking 的基类、请求转储
  quota/         配额形状与注册表
  routing/       这次对话用哪家哪个模型
  vendors/
    <id>/        这一家的一切:manifest 数据(接口地址与模式、档位、环境变量名、
                 目录键、认亲品牌、能力规则、错误码说明)、dialect、thinking、
                 运行时工厂、配额源
    index.ts     每家一行注册
```

- 通用部分只读注册表,**不出现任何一家的名字**。
- 每家的特殊之处以数据或钩子的形式写在自己的文件夹里。
- 界面通过 RPC 读 manifest;只有纯数据、浏览器安全的表放进契约层。界面不再 import `runtime/src/providers/*`(今天 import 了 `model-registry`、`effective-model`、`dials`、`builtin-manifests`、`quota/classify-windows`、`model-capability`)。
- 试点期间 `vendors/` 放在 `packages/onething-runtime/src/providers/vendors/`,**不动包结构**。包要不要合、#25 要不要撤,等试点做完再定(§5)。

**验收(陌生能力演练)**:加一家新服务商只动三处——`vendors/<id>/`、壳的图标与文案、注册表一行。今天以智谱计,要动 19 个别处的文件。

## 4. 试点施工计划

每一批独立提交、门全绿,不改用户可感知的行为。

### P0 · 尺子

- 现有的 `manifest-no-enumeration.test.ts` 只抓"与名字做等值比较 / `case`",量不到表键、标识符、注册时的字面量,也不扫 `packages/shared`。新尺子对**全部 14 个内置 id** 逐文件判"命中",剥掉注释后满足任一即算:
  - id 作为字符串字面量出现(`'zhipu'`);
  - id 作为对象键出现(`zhipu: …`);
  - 标识符里含这个 id,大小写不敏感(`ZHIPU_DIALS`、`readOnethingZhipuOptions`)。
- 扫描范围:`packages/{core,onething-runtime/src,backend,shared}` 与 `apps/desktop-react/{src,electron}`。`packages/shared` 在 P3 前整体列入允许名单(只计数不判红)。
- 允许名单:`vendors/<id>/` 目录、壳的图标与 i18n 文件。协议名不算命中:`openai-chat`、`openai-responses`、`openai-effort`、`anthropic-*`、`gemini-wire` 这类是线协议的名字,不是服务商。
- 以棘轮落地:记录今天每家的命中文件数作基线,只许减不许增;P3 结束时归零变硬闸。原型在 10-01 跑过一遍,即 §2.2 的数字。
- 产出:基线文件 `docs/audit/provider-vendor-enumeration-baseline-2026-10.txt`。

### P1 · 骨架 + 智谱一家走通(模板)

- 建 `vendors/zhipu/`,把 §2.2 表里智谱的数据与分支全部收进来。
- manifest 增加必要的字段(接口模式、环境变量名、目录键、认亲品牌、错误码说明、能力规则),公共表改为从注册表读。
- `factory.ts` 里的 `registerAgentProviderRuntime("zhipu", …)` 移入 `vendors/zhipu/`。
- core 里的错误码说明改为一个不认识服务商的注册口,智谱的说明由它自己登记;删掉两份重复。
- **兼容**:用户设置里已存的 `zhipuApiMode` 字段要照常读出;契约字段的改名放 P3 一起做,读侧兼容旧键。
- 验收:智谱在 `vendors/zhipu/` 以外的命中数归零(`shared` 除外,留给 P3);所有现有门与测试全绿;`headless-boundary-check.ts` 里涉及的 provider 位置断言同批改写。

**P0 落地记录(`872eec88f`)**:尺子、事实快照(`providers/__tests__/vendor-facts.snapshot.test.ts`)、CI 接入。
线协议快照早已覆盖全部 14 家(Provider OO 重建时立的四套),P0 只补了「公共表推导出的答案」那一半。

**P1 落地记录(10-01)**:
- 机制:`ProviderManifest` 加六格各家数据 —— `envVars` / `modelIdentity` / `catalogAliases` /
  `errorDescriptions` / `endpoint`(`pickOptions` / `resolveBaseUrl` / `entryFields` / `ownsBaseUrl`)/
  `modelRuleTable`;行为那一半是 `vendors/runtimes.ts` 的 `VendorRuntime`(`thinkingWires` +
  `createProvider(config, options, kit)`),工厂按名册登记。数据名册 `vendors/manifests.ts`(纯,壳也
  import),行为名册 `vendors/runtimes.ts`(后端)—— 所以「注册一行」实际是**每半边一行**。
- 14 家的 manifest 字面量全部搬回 `vendors/<id>/manifest.ts`;`builtin-manifests.ts` 只剩家族补格与 `acp`。
- 「档位 → 地址」一组(智谱 / 千问 / Kimi / Kimi Code)整组走 `endpoint`:`provider-options.ts` 的三段
  按 id 分支、`zhipu.ts` 的分发函数、`spaces/provider-credentials.ts` 的三张表都换成读字段。通用的
  `resolveOnethingProviderBaseUrl` 住进 `providers/endpoint.ts`,归一函数是叶子模块 `base-url.ts`。
- 智谱整家搬完:地址 / 档位(`vendors/zhipu/endpoint.ts`)、自述与数据(`manifest.ts`)、方言、思考参数、
  运行时工厂(`runtime.ts`)。`providers/zhipu.ts` 删除。
- core 的智谱错误码表换成查询口 `configureProviderErrorCodeDescriber`;manifest 注册表加载时接上
  「问遍各家的 `errorDescriptions`」。runtime 里逐字抄的那份 `extractErrorDetails` 删除,改用 core 的。
  **既有行为照旧**:说明不分是哪家返回的错误码(任何家返回 1113 都会配智谱的说明),快照钉着。
- `builtin-providers.ts` 里十个零引用的 `xxxBuiltinProvider` 导出删除。
- 尺子改用 TypeScript 解析器取标识符与字面量(手写的注释剥离器会被正则字面量里的引号带偏);
  同家的订阅半边目录(`kimi-code/` 认识 `kimi`)与模型路径的厂牌前缀(`'openai/gpt-4o'`)不算点名。
  用同一把尺重量:P0 时 358 对,P1 后 320 对;智谱 21 → 6。
- 智谱剩下的 6 处全是**写死名单的类型**:`OnethingReasoningWire` / `OnethingProviderKind` 与
  `REASONING_WIRES`(`model-capability.ts`)、`openai-compatible.ts` 的 `reasoningStyle` 联合、
  `zhipuApiMode` 字段(`provider-config.ts` / `provider-definition.ts`)、`shared` 契约与缺省值 —— 归 P3。
- 门:typecheck(node / desktop)、`boundary:gate`、`transport:gate`、`provider:gate` 绿;两份快照逐字不变。
  全量 vitest 有 19 条红在 P0 提交上**原样存在**(音乐 / 提示词金样 / 插件事件 / http 文件面等别的会话的
  在途改动),`assembly:gate` 在 HEAD 也红(`wiring/music/radio.ts` 9 → 10),都与本试点无关。

### P2 · 其余各家

按线协议分批,每批一笔提交:

1. openai-chat 一族:deepseek、kimi、kimi-code、qwen、openrouter、grok、openai
2. anthropic 一族:claude、claude-code
3. gemini
4. 订阅 / 登录型:codex、github-copilot、grok-oauth

顺带删除 `runtime/src/providers/deepseek.ts` 与 `tool-result-content.ts` 两个无人使用的文件。

**P2 第 1 批落地记录(openai-chat 一族:deepseek / kimi / kimi-code / qwen / openrouter)**:
- 五家的地址与档位(`kimi.ts` / `qwen.ts` → `vendors/<id>/endpoint.ts`)、档位旋钮、环境变量、认亲行、目录别名、
  型号规则表(连同只服务它们的档位常量)、方言(含 `kimi-attachments`)、只服务一家的思考线型、运行时工厂、
  配额源全部回家;`provider-options.ts` 的 `readOnething<Id>Options` 搬进各家。
- 新机制:配额源进 `VendorRuntime.quotaSources`,`quota/registry.ts` 改为**惰性**播种(registry 要 import
  行为名册,而名册拉起 agent-loop —— 加载期播种会成环);`VendorRuntimeKit` 加 `accessToken(config)`(订阅家要)。
- 死代码清掉:旧 deepseek 路(`providers/deepseek.ts`、`tool-result-content.ts`、`provider-routing` 的
  `{kind:'deepseek'}` 与三个推断函数、`message-conversion` 的 DeepSeek 源消息转换、`provider-facade` 的
  `withDeepSeekFetch`、`agent-runtime-route` 的常量、`thinking-options` 的 `normalizeDeepSeekReasoningEffort`、
  backend `wiring/agent-loop/providers/deepseek.ts` 包装与它的测试)—— 逐个核过零生产调用者,测试里只测它们
  自己的那几条一并删。`createDeepSeekAgentProvider` 留在 `vendors/deepseek/agent-provider.ts`(8 个测试拿它
  当构造捷径),桶里的再导出删掉。
- 千问的型号规则不再 import DeepSeek 家的常量:它转售 DeepSeek 型号接受的两档由千问自己声明。
- 尺子:正则字面量不收(代码里的正则几乎都在认模型 id,如千问规则表里的 `/^deepseek-v[34]/`,那是模型家族
  知识)、`openai-file`(PDF 投递格式)算协议名。320 → 257 对。
- 本批各家剩下的对属于:P3(写死名单的类型、`shared`)、P4(壳)、领域外(语音 / 日志 / 触发器 / 会话 / 评估);
  另有三处需要新机制而不是搬家 —— `auth/registry.ts` 的 OAuth 配置(随第 4 批订阅家一起)、`model-registry.ts`
  里千问的目录补全钩子、`models-dev-catalog` 与 `model-registry` 签名里的千问 / Kimi 档位配置类型(随 P3)。
  `wires/openai-chat-messages.ts` 认 OpenRouter 的 `reasoning_details` 回放,留在线协议层(改成方言字段会改测试构造)。

**P2 第 2 批落地记录(claude / claude-code / gemini)**:
- 新概念:**模型家族 ≠ 服务商**。`claude` / `gemini` 既是一家服务商,也是一族型号(Copilot、OpenRouter 也卖),
  还是线协议的名字。只属于这一家的进 `vendors/<id>/`;说型号的(`onethingClaudeModelFamily`、按型号名判思考编码、
  型号展示名别称)进新目录 `providers/model-families/<family>.ts`,尺子豁免它;线协议层留原处。
  `model-families/index.ts` 汇总跨家族的表(今天是展示名别称),通用代码读汇总不点家族名。
- 三家的方言、运行时工厂、claude-code 配额源(`LEGACY_QUOTA_SOURCES` 只剩 codex)、环境变量、认亲、目录别名、
  型号规则表回家;`claude` / `gemini` 的 agent-provider 构造捷径照 deepseek 先例留在各家目录,backend 的
  零调用者包装删除。
- 剩下的对:线协议层(anthropic / gemini 线型与配方;`wires/anthropic-messages.ts` 的 `providerData.provider:
  "claude"` 会写进历史消息,改了就改存档)、`custom-from-spec` 以官方 gemini 方言为底(改了会变表单可见的接口类型)、
  OAuth 配置(第 4 批)、`model-capability` 里 `resolveImageOutputServedBy` 的 `kind === 'gemini'` / openrouter 一行、
  P3 类型、P4 壳、领域外(ACP 的 agent id、`CLAUDE.md` 文件名等)。257 → 230 对。
- 补记:第 1 批提交漏了 `wires/openai-chat-provider-options.ts`(`DEEPSEEK_IMAGE_DETAIL_VALUES` 移进 deepseek 方言后
  这里的删除)—— 当时排除别的会话文件的过滤条件 `chat-` 太宽,本批一并提交。

**P2 第 4 批落地记录(openai / codex / grok / grok-oauth / github-copilot;内置服务商至此全部住进自己的目录)**:
- 五家的方言、运行时工厂(`factory.ts` 里一家都不再点名;Copilot 的补全 token 缓存随工厂进
  `vendors/github-copilot/runtime.ts`)、环境变量、认亲、目录别名、型号规则表回家。codex 的非请求半边
  (`providers/codex.ts` → `vendors/codex/models.ts`)、原生工具判据(`native-tools.ts`)、配额源、构造门面
  (`agent-provider.ts`)、只服务它的配方主体与三态端点(`CODEX_DIALECT_SPEC` / `responsesEndpoint`)回家;
  xAI 的两条思考线型合进 `vendors/grok/thinking.ts`,Live Search 白名单(`wires/xai-search-parameters.ts` →
  `vendors/grok/search-parameters.ts`)改由配方以函数交给线协议层的袋(`searchParameters` 从布尔改为函数)。
- 新机制(都在 `VendorRuntime` 上,都由读的人**惰性**读名册):
  - `oauth`:`auth/registry.ts` 不再手列五份配置,按名册建表;五份(含第 1 / 2 批留下的 claude-code、kimi-code)
    各回各家 `vendors/<id>/oauth.ts`。PKCE 与 token 归一搬进叶子模块 `auth/oauth-token.ts`(registry 原样再导出)。
  - `createModelsFetcher(deps)`:`rpc/domains/models.ts` 不再按两个枚举值手列,按名册建列表口表;宿主只交一份
    不点名的 `VendorModelsFetcherDeps`(缓存目录、落盘、设置选型、`getToken` / `refreshTokenIfNeeded`、
    app fetch、日志)。Copilot 的取数与模型缓存从 backend `builtin/github-copilot.ts` 搬进 vendor(该文件删除)。
  - `fallbackModels`(照配额源同形加的第三格,可拒):backend `model-registry.ts` 的兜底表改为读名册;
    grok 两半共用 `vendors/grok/fallback-models.ts`。
- 过渡表收尾:`LEGACY_QUOTA_SOURCES` 与 `DEFAULT_PROVIDER_API_KEY_ENV_VARS` 清空后连同回落分支删除;
  `PROVIDER_MODEL_RULES` 只剩 `acp` / `unknown`,改名 `NON_VENDOR_MODEL_RULES`;`LEGACY_MODEL_VENDOR_ALIASES` /
  `LEGACY_PROVIDER_MAPPING` 只剩 Mistral / Meta / Cohere 这几个**非服务商**厂牌,改名并注明。Copilot 的
  `kind === 'copilot'` 专门分支换成它 manifest 里的一行函数型规则(同位置同答案,vendor-facts 快照为证)。
- 型号家族:`model-families/openai.ts`(gpt-5.x 按代分档、`none` / `original` 判据);Copilot 列表口用的
  型号说明与上下文长度按族拆进 `model-families/{openai,claude,gemini}.ts`,`index.ts` 按原 `if / else if` 次序汇总。
- 死代码(逐个 grep 核过零生产调用者):`prepareOnethingCodexCallOptions` 及只服务它的三件(唯一去处是
  backend codex 定义的 `prepareCallOptions` 一格,全仓无人读那一格)、backend `builtin/codex.ts` 与
  `builtin/index.ts` 里的「滤掉 codex 再追加」(codex 本就在可移植表末位,同序同值)、
  `githubCopilotBuiltinProvider`、backend `builtin/github-copilot.ts` 的 `clearCopilotModelsCache`。
- 尺子:`OpenRouterModel`(全仓目录行的格式名)算协议名;整串是 HTTP 头名形状的字符串(`OpenAI-Intent`)不计。
  `Codex*` 这一族 Responses 线协议旧名加了中性别名(`ResponsesNativeTool` / `ResponsesUsageNormalizer` /
  `toResponsesToolChoice`),搬回家的别家配方读中性名;整体改名另起一单。230 → 163 对。
- 剩下的对:Responses 线协议层的 `Codex*` 旧名与配方缺省(占位认证、传输声明、兜底 instructions、`'codex'`
  思考线型 —— 自定义服务商的 Responses 适配表也吃这些缺省;`factory.ts` 给自定义 Responses 家用 `codexAuth`)、
  dump 的 `'codex-http'` 模式(落盘可见)、`model-capability` 的 `kind === 'openai'` 原生出图判据与
  `providerMetadata.codex` 证据键、backend `refreshAllProviders` 里给 grok 两半补设置条目的循环、
  backend `wiring/agent-loop/providers/codex.ts`(零生产调用者,测试钉着 authService 回落与宿主 token 形状,留)、
  自定义服务商的 `apiType: 'openai'`、P3 类型、P4 壳、领域外(引擎的 codex 原生工具接线、语音、媒体、日志)。

### P3 · 打开契约

- `AIProviderId` 从写死的联合改为字符串 + 注册表;`AIProvider` 枚举退役;`OnethingProviderKind` 同理。
- 各家专属字段(`zhipuApiMode` / `qwenApiMode` / `kimiApiMode` …)与它们在 `shared/defaults/settings.ts` 的缺省值,改为通用的"接口模式"字段,缺省值由各家 manifest 提供;读侧兼容旧键,写侧按新键,下次保存自动升级。
- 尺子归零,改为零基线硬闸。

**P3 落地记录**:
- 契约:`AIProviderId` 改为 `string`,`AIProvider` 枚举删除;`ReasoningProfileOverride.wire` 改为 `string`;
  `ZhipuApiMode` 等五个类型与 `ProviderConfig` 上的五个具名档位字段删除。**存档字段名不变** —— 它们由各家
  `dials.apiModeKey` / `regionKey` 声明,壳与 runtime 一律按键读写;没有新增索引签名。
- 出厂默认:`shared` 的 `DEFAULT_PROVIDER_CONFIGS` 拆了 —— 12 家各自的条目逐字搬进 manifest 的 `seed`
  (值不与 `defaultModel` 统一,两边今天本来就不同);shared 只留非服务商的 `acp` / `custom`
  (`NON_VENDOR_PROVIDER_SEEDS`)。`createDefaultSettings` / `mergeWithDefaults` 接受种子表;backend 的
  `stores/settings-defaults.ts` 导出**预先绑好种子**的两个函数,backend 全部调用点改用它。键序有代码依赖
  (`core/engine/title.ts` 取第一家兜底、CLI 列表顺序、server 多租户树直接下发),所以名册旁的 `VENDOR_SEED_ORDER`
  保持旧键序,测试钉住;改动前先录的冻结快照(`stores/__tests__/settings-defaults.freeze.test.ts`)逐字相等。
- runtime:`OnethingProviderKind` / `OnethingReasoningWire` / `openai-compatible` 的 `reasoningStyle` 改为 `string`;
  校验用户覆盖的合法线型 = 协议层叶子模块 `thinking/protocol-wire-ids.ts` + 各家 manifest 的 `reasoningWires`
  + `custom`,不再手写名单(`reasoning-wire-ids.test.ts` 钉住:旧的 14 个仍合法、`deepseek-inferred` 等仍非法)。
  千问的目录补缺成为 manifest 的 `catalogBackfill`;自定义服务商借用的协议缺省规则表来自
  `model-families/index.ts`;认亲读「聚合站目录」改为 openrouter manifest 声明 `aggregator: true`;三个只剩测试在用的
  `*BuiltinProvider` 导出删除。
- 尺子 163 → 119 对。provider 领域内剩 26 对,全是下列几类之一:自定义服务商的 `apiType: 'openai'|'anthropic'`
  与 `custom-openai`(存档形状与协议名)、出图路由按 `kind` 判的一行(P2 已记)、grok 两半补设置条目的循环、
  用户可见报错文案里的环境变量示例、落盘的 `'codex-http'` 转储模式名、`custom-probe` 以 gemini 方言为底、
  ACP 的 agent id(`'claude-code'`、`'codex'`、`'gemini'` 作为 agent 名,尺子按字面量会误认)、领域外的语音默认值。

### P4 · 界面改读 RPC

- providers 域补上"列出 manifest"等读接口;壳不再 import `runtime/src/providers/*`。
- 浏览器安全的纯表(如 `classify-windows`)移进契约层。

### P5 · 演练

写一个"假服务商"测试夹具,按验收标准实际加一家,确认只动三处。

## 5. 试点之后再定的事

- 包结构:合并 core / runtime / backend,还是保留;#25 的"逻辑与接线按文件拆"是否撤销,让一个功能的逻辑与接线住同一个目录。
- 其他领域是否照 provider 的样子改(search、mcp、acp、plugins、collab、music 都有同样的七处散落)。
- 两个进程的拆分顺序:生命周期 → 凭证导出与迁移 → 客户端能力移出后端 → CLI 改走 HTTP → 插件与 gateway 挂上后端 → 手机配对。

## 6. 要知道的牵连

- `scripts/headless-boundary-check.ts` 有 17 条 provider / model 相关的位置断言(如 `checkRuntimeOwnsProviderRegistry`),文件挪动时要同步改写或退役。
- `docs/design/provider-oop-2026-08.md`、`provider-settings-rework-2026-09.md` 与 CLAUDE.md 里的 provider 路径要随批更新。
- 用户设置与凭证文件里存着各家专属字段,所有改名都必须读侧兼容。
