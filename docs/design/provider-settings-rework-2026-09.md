# Provider 与模型配置整改方案 v2(2026-09-26)

用户 09-26 提五条:①文案废话太多;②订阅登录点「登录」没开浏览器、grok 只给一串网址,要统一成「网址可点开、码一键复制」;③手填模型取消勾选就消失;④自定义服务商要能设模型列表接口、自定义 Header,响应格式按真实响应生成;⑤订阅用量与 API 余额要查得到,并显示在 composer 的上下文圆环里。追问两条:⑥接口不报参数时,像 `gpt-5.5` 这种一眼就是某家的模型,拿存着的能力和上下文弹建议、点了才填,**不用 AI**;⑦API 与订阅的轮转策略要更实用。

v1 → v2 的变化(用户 09-26「好的」全收):加 manifest 自述表前置批,三格上 `ProviderConfig`;spec 编译成策略对象而不是线读路径;登录流搬进后端;参数折叠只在后端算一次;手填模型做成目录条目;models.dev 单份缓存;配额喂回密钥池、被动源提前;新增批 6 轮转 v2。五个 v1 拍点与两个 v2 拍点全按推荐拍定,记在 §9。

每批末尾是「陌生能力演练」(CLAUDE.md 09-02 立法):拿一个设计时没想的能力,列出要改的文件,答案必须是「能力自己的模块 + 一行注册」。

## 0. 现状事实(三路代码探查,09-26)

**登录为什么没开浏览器。** React 壳的宿主口表把 `shell` 填成 `null`(`apps/desktop-react/electron/host-ports.ts:155`),所以后端 `oauth.start` 里 `openExternal` 是 `undefined`,`startOnethingOAuthForIpc` 直接跳过打开(`runtime/src/auth/ipc-operations.ts:27-31`);返回体里带着 `authUrl`,但壳从不读它(`apps/desktop-react/src` 里零命中)。于是 Codex 卡片上「已在浏览器里打开授权页」是一句假话,五分钟后变成「等太久了」。Claude 的贴码流同样从不把授权页网址给用户看。grok 的设备码流把网址画成一个纯 `<span>`(`OAuthCard.tsx:142-153`),没有链接、没有复制。三个流三种屏,没有一个能自己走通。

**手填模型为什么消失。** 手填 ID 只存在 `ProviderConfig.selectedModels` 里(没有别的数组);目录行 = 目录 ∪「勾了但目录不认识的 ID」(`projection.ts:567`,后端 `rpc/domains/models.ts:105-117` 同一逻辑)。取消勾选 = 从 `selectedModels` 删掉 = 这个 ID 在世上唯一的记录没了。

**自定义服务商今天有什么。** `CustomProviderConfig { id, name, description?, apiType: 'openai'|'anthropic' }`(`shared/ipc/providers.ts:221`),id 是 `custom-<时间戳>`。没有 headers 字段、没有模型列表地址、没有探测。目录只认 models.dev,`custom-*` 在那里没有条目,刷新只打一行 warning。工厂层 `AgentProviderRuntimeConfig.dialect?` 早就允许自定义服务商指名任何已注册方言(`factory.ts:87-94`),但 core 的字段复制表(`core/engine/agent-loop-runtime.ts:651-662`)与 `agent-runtime-route.ts:53` 都没抄这一格,所以它从来没生效过。Header 的钩子也早在:`AuthStrategyOptions.headers`(`base/auth-strategy.ts:27-31`),自定义工厂没填。

**用量与余额今天有什么。** 唯一的活口是 Codex:`fetchOnethingCodexUsage`(`providers/codex.ts:699`)打 `chatgpt.com/backend-api/wham/usage`,经 `providersRouter.usage` 给设置页的 `UsageCard`;别家一律 `{ unsupported: true }`(`provider-usage.ts:60`)。成功响应的限额头(`x-codex-*`、`anthropic-ratelimit-*`)没人读;DeepSeek `/user/balance` 没人调。composer 圆环(`composer/components/MeterCard.tsx`)只画上下文占比,悬停卡片有上下文/tokens/本地估价/服务商报价/缓存命中五行,数据经 `data/meter-source.ts` 的 `usage.getSession` + `sessions.getTokenUsage`。

**各家配额接口(09-26 外网核实)。**

| 家 | 接口 | 形状 | 备注 |
| --- | --- | --- | --- |
| Codex(ChatGPT 订阅) | `GET chatgpt.com/backend-api/wham/usage` | `rate_limit.primary_window / secondary_window { used_percent, limit_window_seconds, reset_at }`,不同套餐两窗顺序不同,**按时长归类**(≤6h 当 5 小时窗,其余当周窗) | 已接 |
| Claude(Pro/Max 订阅) | `GET api.anthropic.com/api/oauth/usage` | `{ five_hour, seven_day, seven_day_sonnet…: { utilization(0–100), resets_at } }` | 要 `anthropic-beta: oauth-2025-04-20` + `User-Agent: claude-code/<v>`,少了 UA 落进严限桶持续 429;非公开接口 |
| DeepSeek | `GET api.deepseek.com/user/balance` | `balance_infos[{ currency, total_balance }]` | 公开文档 |
| Moonshot/Kimi | `GET api.moonshot.ai/v1/users/me/balance` | `{ available_balance, voucher_balance, cash_balance }` | 文档写只支持国际站,.cn 待真机核 |
| OpenRouter | `GET openrouter.ai/api/v1/credits`(或 `/auth/key` 的 `limit/usage`) | `total_credits − total_usage` | `/credits` 疑要管理密钥,待核;`/auth/key` 普通密钥可用 |
| xAI | `GET api.x.ai/v1/billing/credits` | 未核到官方文档 | 待核 |
| OpenAI API / Zhipu / Qwen / Gemini / grok 订阅 / Copilot / Kimi Code | 无公开余额或配额接口 | — | 用本地账本兜底 |

**轮转今天怎么做(09-26 追查)。** 密钥池在 `workspaces/<spaceId>/credentials.json`,API 密钥与 OAuth 账号同池(`authType` 区分),策略 `single | priority-failover | round-robin | plugin:*`,**默认 `single`**(加第二把密钥什么都不发生)。发送前 `selectSpaceCredentialEntryDetailed` 同步选一条;失败后 `createSessionCredentialRotator` 标冷却、重选、重建 provider 再试,每轮最多 3 次,跑过工具后不再换。三个硬伤:①**默认空间不轮转**(`credential-rotation.ts:87-90` 一行早退,注释说默认空间还从 settings.ai 读密钥,迁移后已不成立);②**订阅与同家 API 之间零接力**(`shared/provider-families.ts` 明说家族只管呈现);③**冷却只认报错不认配额**(配额满固定 5 分钟、限流 60 秒、鉴权 24 小时,`retry-after` 有则用,封顶 1 小时),服务商 `enabled` 开关发送路不查。

## 1. 全期总览

| 批 | 做什么 | 量 | 依赖 |
| --- | --- | --- | --- |
| 批 0 止血 | 设置页每句说明按 §2.1 重写、内置服务商描述换中文;**默认空间不轮转那一行删掉**;发送路查 `enabled` | 半天 | 无 |
| 批 1 登录 | 登录流搬进后端 `AuthService`(计时/超时/取消/推送 `oauth:flow`);壳注入 `shell` 口 + 一个外链帮手;三流合一屏(网址可点、码可复制、桌面自动打开) | 1.5 天 | 无 |
| 批 2 手填模型 | 手填 = 目录条目 `source:'manual'`,刷新只换非手填;取消勾选留行、✕ 才删;`configuredOnly`/孤儿逻辑删 | 半天 | 无 |
| 批 M 自述表 | `ProviderManifest`(方言/认证/模型来源/计费/配额源/同家);内置 16 家 = 代码里的 manifest,自定义 = settings 里的 manifest;19 处枚举改读字段;`headers`/`modelsUrl`/`dialect` 上 `ProviderConfig`;models.dev 单份缓存;`effective` 折叠只在后端算 | 2 天 | 批 2 |
| 批 3 自定义 + 建议 | 自定义对话框 = manifest 编辑器(方言下拉读注册表、Header 键值表带 `{{apiKey}}`、模型列表地址);直连拉目录;§5.4 参数建议芯片 | 1.5 天 | 批 M |
| 批 4 自动识别 | `CustomAdapterSpec` 数据表,`dialectFromSpec` 编译成三个策略对象(线不动);「自动识别」= 探两发 + 规则先判 + AI 只填偏差 + 真响应回验 | 2 天 | 批 3 |
| 批 5 配额 | 配额源注册表(五家先行 + 被动源:响应头);后端 `QuotaService` 缓存 + `provider:quota` 事件;composer 卡片行;设置页复用;密钥策略暴露只读 `decide()` | 2 天 | 批 M |
| 批 6 轮转 v2 | 一个 `pickRoute`:同家订阅账号(按窗口余量)→ 同家 API 密钥(按策略);冷却 = 报错 ∪ 配额(到期 = `resets_at`);默认策略改「按顺序接力」;家族开关「订阅用完切 API」 | 1.5–2 天 | 批 5 |

合计 11–13 天。批 0/1/2 先走;M → 3 → 4 一条线;M → 5 → 6 一条线,两条线可并行。

## 2. 批 0 · 止血

原则四条:一格说明最多一句;说它替你做什么,不说怎么做;实现名词(worker、方言、字段名)不上屏,原话进 Tooltip;施工笔记(「下一批」「始终置顶」)不上屏。「这一坑」这个说法全删。

### 2.1 替换表(zh;en 同步意译)

| 键 | 现在 | 改成 |
| --- | --- | --- |
| `providers.subIntro` | 用你已有的订阅跑模型,不产生额外 API 费用。这一坑的模型不按 token 计价。密码只在浏览器里输入,应用不经手。(登录前后各出一次) | 用你的订阅额度跑模型,不另收 API 费。(**只在未登录时出现**;登录后这一格换成账号行) |
| `providers.subCatalogLocked` | 登录后才有模型目录 —— 没登录时这一坑有哪些模型,应用并不知道。 | 登录后显示模型列表。(作为目录空态,不另占一行) |
| `providers.subDeviceCode` | 在网页里输入这串码 | 在授权页输入这串码 |
| `providers.subDeviceUrl` | 验证网址 | 授权页 |
| `providers.subWaiting` | 等待确认…确认后本页自动接续,不用手动回来。 | 等你在授权页确认,完成后这里自动更新。 |
| `providers.subPasteHint` | 浏览器里完成授权;若没有自动跳回,把授权码粘回来。 | 授权完成后,把页面给的授权码贴到这里。 |
| `providers.subBrowserWaiting` | 已在浏览器里打开授权页,完成后这边自动接续。 | 已打开授权页,完成后这里自动更新。(**只有真打开了才显示**,见批 1) |
| `providers.subTimedOut` | 等太久了 —— 这一次登录已经作废,重新来一次。 | 登录已超时,请重新登录。 |
| `providers.subTokenExpired` | 令牌已过期,需要重新授权 | 登录已过期 |
| `providers.subAccounts` | 这一坑支持多账号 · 现有 {count} 个 | {count} 个账号 |
| `providers.localIntro` | 本机进程,零凭证。探测、连接与启动配置在下一批。 | 使用本机安装的命令行工具,不需要密钥。 |
| `providers.customIntro` | 自定义端点。改这一家的名称、地址与默认模型走下面那颗「编辑」。 | **删**(「编辑」钮自己会说话) |
| `providers.keyNeverRead` | 密钥原文永不回读,只看得到尾号。 | 只显示密钥尾号。 |
| `providers.keyDeleteAsk` | 删掉这一条?已经记在它名下的用量仍留在账本里。 | 删除这个密钥?用量记录会保留。 |
| `providers.rotationSingleHint` | 始终用最上面那条,不自动换 —— 它冷却时这个 provider 就停用。 | 只用第一个密钥。 |
| `providers.rotationFailoverHint` | 从上往下取第一条可用的;配额耗尽或被限流会自动换下一条。顺序即优先级。 | 按顺序使用,失效时自动换下一个。 |
| `providers.rotationRoundRobinHint` | 每次请求轮换到下一条,把用量摊开;冷却中的条目自动跳过。 | 每次请求轮流使用。 |
| `providers.rotationUnavailable` | 这条策略此刻不可用,正在用内置的「按序接力」。你的选择保留着,插件回来它自动生效。 | 这个策略暂不可用,先按顺序使用。 |
| `providers.baseUrlDefaultIs` | 默认地址 {url} —— 清空这一格就回到它。 | 留空使用默认地址。(默认地址进输入框占位符) |
| `providers.baseUrlDialOwned` | 这一家的地址由上面的计费档位算出来:手改之后再拨一次档位会把它覆盖掉。 | 切换计费档位会重置这个地址。 |
| `providers.catalogHint` | 勾选后出现在聊天的模型选择器里 | 勾选的模型会出现在聊天里。 |
| `providers.catalogEmpty` | 这一坑还没有模型 | 还没有模型 |
| `providers.catalogTruncated` | 还有 {count} 型没画出来 —— 把检索词收窄一点。 | 还有 {count} 个,输入关键词筛选。 |
| `providers.groupPicked` | 已选 · {count}(始终置顶) | 已选 · {count} |
| `providers.addModel` | ＋ 手填 ID | ＋ 添加模型 |
| `providers.addModelDuplicate` | {model} 已经在这一坑的列表里了 | {model} 已在列表里 |
| `providers.manualModel` | 手填 | 手动添加 |
| `providers.customAddIntro` | OpenAI 兼容或 Anthropic 兼容端点:本地 Ollama / vLLM / 第三方聚合。 | 支持 OpenAI 兼容和 Anthropic 兼容的接口。 |
| `providers.customModelHint` | 端点常常不报目录,也不报能力。拉不到就手填 ID,能力项留空 —— 不猜、不预填。 | 拉不到模型列表时可以手动添加。 |
| `providers.customDeleteConfirm` | 真删 —— 模型勾选与这个空间里它的密钥一起没 | 删除后,它的模型选择和密钥一起清除。 |
| `providers.builtinNoDelete` | 内置的这一家删不掉 —— 用上面的开关停用它 | 内置服务商不能删除,可以停用。 |
| `providers.overrideContextHintDefault` | 目录没填这一型;不填按 {n} 算,压缩阈值也按它算。 | 留空按 {n} 计算。 |
| `providers.overrideOutputHintNoCatalog` | 目录没填这一型;不填就不带上限,由服务商用它自己的默认值。 | 留空则不限制。 |
| `providers.overrideCapsHint` | 关 = 这一型的请求不再带这项能力;开 = 目录说不支持也照发。 | 覆盖模型列表里的能力标记。 |
| `providers.reasoningHint` | 选择模型支持的等级和默认档位,留空名称则沿用通用名称。保存后用于下一次请求。 | 设置这个模型的思考档位。 |
| `providers.reasoningMappingHint` | 继承服务商配置,或改用内置适配、自定义 API 映射。自定义支持 effortPath、effortValues、disabledValue、enabledBody、disabledBody。 | 按服务商默认,或自定义请求参数。(五个字段名各自进输入框占位符) |
| `providers.usageCache` | 60s 缓存 | **删** |
| `providers.usageLoading` | 正在问用量… | 正在获取… |
| `providers.usageFailed` | 用量拿不到 | 获取失败 |
| `providers.usageUnavailable` | 服务商未给数 | 服务商未提供 |
| `providers.usagePrimary` / `usageSecondary` | Primary / Secondary | 由批 5 按时长改成「5 小时」「本周」 |
| `dials.ts:110` Qwen 风险注 | 订阅用户必须选对档位。用通用 Key 和地址调用会走按量计费,在订阅之外额外扣钱。 | 订阅用户请选对档位,否则会按量计费。 |
| `dials.ts:140` Kimi 风险注 | 编程套餐的 Key 与地址(api.kimi.com)和开放平台不通用:留着按量的那一套调用,会在订阅之外再按量扣一次钱。 | 编程套餐的密钥和地址与开放平台不通用,用错会额外扣费。 |

### 2.2 内置服务商描述

`builtin-providers.ts` 里的 `description` 是过期英文(「GPT-4, GPT-3.5 and other OpenAI models」「Claude 3.5, Claude 3」),显示在详情头。改成一句中文,不点模型名(模型名会过时):OpenAI「OpenAI 官方接口」;Claude「Anthropic 官方接口」;Claude Code「用 Claude 订阅」;Codex「用 ChatGPT 订阅」;Kimi Code「用 Kimi 会员」;Copilot「用 GitHub Copilot 订阅」;DeepSeek「DeepSeek 官方接口」;Kimi「Moonshot 官方接口」;Zhipu「智谱官方接口」;Qwen「阿里云百炼」;Gemini「Google AI 接口」;OpenRouter「聚合多家模型」;grok「xAI 官方接口」;grok 订阅「用 X Premium 订阅」;ACP「本机 Agent」。`description` 改成 i18n 键走字典。

### 2.3 两处一行修

- `packages/backend/wiring/providers/credential-rotation.ts:87-90`:删掉 `spaceId === DEFAULT_SPACE_ID` 早退(默认空间早已并入同一份密钥池)。补一条单测:默认空间两把密钥,第一把 402 后第二把被选中。
- 发送路查 `enabled`:`provider-helpers.ts getEffectiveProviderConfig` 里,provider 被停用时按「未配置」同路失败,错误句「{name} 已停用」。

### 2.4 验收

交卷前把设置页每种状态(未登录 / 登录中 / 已登录 / 过期;API 模式无密钥 / 有密钥 / 冷却)截一遍,每句话按 2.1 逐字核。可选棘轮 `copy:gate`(i18n 禁词表 + 说明句 ≤ 40 字)先不排。

## 3. 批 1 · 登录

### 3.1 裁定

**登录流的生命周期在后端。** 今天设备码轮询(60 次 × 5 秒)和浏览器回调轮询都写在壳的 store(`providers/store.ts:813-874`),后端没有取消动作,关掉设置页流程就成孤儿,CLI 与网页壳要登录得各写一遍。改成 `AuthService` 持有流:`start` 之后它自己起计时器轮询设备码 / 等回调、到点超时、`cancel` 收尾;状态变化推一条全局事件 `oauth:flow { providerId, flowId, phase: 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled', error? }`(`GLOBAL_EVENT_LEAVES_PROCESS` 加一行);`oauthRouter` 加 `cancel`。壳只订阅,`pollDevice` / `pollBrowser` / `authEpoch` 三样删。流对象 `own()` 在 backend 上,dispose 时取消。

**打开外链是桌面的真实能力,不是壳的能力缺口。** `shell` 宿主口在 React 壳填 `null` 是 09-03 迁壳时没接。批 1 在 `createShellHostPorts()` 注入 `shell: { openExternal, openPath, showItemInFolder }`(Electron `shell` 三个调用),`capabilities.shellTools` 随之为真 —— **AI 的工具从此能在桌面打开文件和网址,用户已拍(§10)**。顺带堵上 `references/kinds/link.ts:117-128` 那个「有 onethingHost 就什么都不做」的洞。

**渲染层只认一个帮手。** 新建 `apps/desktop-react/src/platform/open-external.ts`:桌面走 `shellRouter.openExternal`;网页壳走 `window.open(url, '_blank', 'noopener')`。所有「点了要出去」的地方都用它。

**后端不开浏览器,壳开。** `oauth.start` 只返回 `authUrl` / `verificationUri`;壳拿到后自己调 `openExternal`(桌面自动开,网页壳不自动开、链接始终在屏上兜底)。

### 3.2 一屏三流:`AuthFlowScreen`

三种流(浏览器回调 / 贴码 / 设备码)合成一个组件,行按事实显隐:

```
┌ 授权页  https://auth.openai.com/…/authorize?…   [打开] [复制] ┐   ← 三流都有;网址是链接
│ 在授权页输入这串码                                            │   ← 仅设备码
│    ABCD-1234                                        [复制]    │   ← 点码本身也复制;复制后钮变「已复制」1.5s
│ 授权码  [________________]  [提交]                            │   ← 仅贴码
│ 等你在授权页确认,完成后这里自动更新。            [取消登录]   │   ← 三流都有;取消 = oauth.cancel
└──────────────────────────────────────────────────────────────┘
```

| 行 | 浏览器回调(codex) | 贴码(claude-code) | 设备码(grok / kimi-code / copilot) |
| --- | --- | --- | --- |
| 授权页链接 + 打开 + 复制 | 显示 | 显示 | 显示(`verification_uri_complete`) |
| 用户码 + 复制 | — | — | 显示 |
| 授权码输入 + 提交 | — | 显示 | — |
| 状态句 | 已打开授权页,完成后这里自动更新。/ 点「打开」去授权,完成后这里自动更新。(网页壳或打开失败) | 授权完成后,把页面给的授权码贴到这里。 | 等你在授权页确认,完成后这里自动更新。 |
| 失败(`phase: failed`) | 登录失败 + 原话 Tooltip + 重试 | 同 | 同;`access_denied` 写「你在授权页拒绝了」 |
| 超时(`phase: expired`) | 登录已超时,请重新登录。 | 同 | 同 |

### 3.3 文件

`runtime/src/auth/auth-service.ts`(流生命周期 + 事件)、`backend/wiring/auth/oauth-events.ts`(`oauth:flow`)、`shared/ipc/oauth.ts`(`cancel`)、`shared/events`(全局事件行)、`apps/desktop-react/electron/host-ports.ts`(`shell`)、`src/platform/open-external.ts`(新)、`providers/components/AuthFlowScreen.tsx`(新,替 `OAuthCard.tsx:130-194`)、`providers/store.ts`(订阅事件,删轮询)、`providers/auth.ts`(`opened`、`authUrl`)。门 `gate:providers-auth`(dist/server + 假 OAuth 服务):三流各起一次,断言链接可点、设备码有复制钮、`openExternal` 被调一次且参数是返回网址、取消后 `phase: cancelled` 出网、后端 `dispose` 时无残留计时器。

### 3.4 陌生能力演练

「加一家用短信验证码登录的服务商」:`auth/registry.ts` 一条 flowKind + `auth-service.ts` 一个 `start` 分支,`AuthFlowScreen` 按返回体有没有 `authUrl` / `userCode` / `requiresCodeEntry` 显隐,不改。通过。

## 4. 批 2 · 手填模型 = 目录条目

`ProviderConfig.models: Record<string, ModelCapabilityEntry>` 就是这家的目录。`ModelCapabilityEntry` 加 `source: 'models.dev' | 'endpoint' | 'manual'`。手填 = 写一条 `source:'manual'` 的条目(参数全空)并勾上;取消勾选只动 `selectedModels`,行留着;✕(手填行悬停才有)删条目并从勾选里去掉,它是当前模型时换到第一个勾选的。刷新目录只替换非 `manual` 条目。壳 `projection.ts:516-580` 与后端 `rpc/domains/models.ts:105-117` 的「孤儿」拼接与 `configuredOnly` 删掉;老数据(勾了但目录没有)在后端读时折成 `manual` 条目,下一次任何写操作随手落盘,不做一次性迁移。`gate:providers` 加两步:取消勾选后行还在;✕ 后行没了且 `model` 换人。

## 5. 批 M · Provider 自述表

### 5.1 为什么

仓里有 19 处「这是不是 codex / copilot / custom-*」的判断,散在 13 个文件(`factory.ts`、`provider-data.ts`、`dialects/codex.ts`、`model-capability.ts`、`model-registry.ts`×2、`provider-config.ts`、`codex.ts`、`registry.ts`、`prompts/builder.ts`、`usage/index.ts` 的 `SUBSCRIPTION_PROVIDER_IDS`、`stream-executor.ts`、壳 `UsageCard.tsx`)。批 3/4/5/6 每一批都会再加一处。先抽表。

### 5.2 形状

```ts
// runtime/src/providers/manifest.ts
export interface ProviderManifest {
  id: string
  name: string                       // i18n 键
  description: string                // i18n 键
  icon: string
  dialect: string                    // 已注册方言 id
  auth: { kind: 'apiKey' } | { kind: 'oauth'; flow: 'pkce-callback' | 'manual-pkce' | 'device-code' } | { kind: 'none' }
  models: { kind: 'models.dev'; key: string } | { kind: 'endpoint'; path?: string } | { kind: 'roster' } | { kind: 'none' }
  billing: 'api' | 'subscription'
  quotaSource?: string               // 批 5 注册表里的 id
  sibling?: string                   // 同家的另一半:codex↔openai、claude-code↔claude、kimi-code↔kimi、grok-oauth↔grok
  dials?: DialSpec                   // 计费档位(千问/Kimi/智谱),从壳的 dials.ts 搬进来
  defaultBaseUrl: string
  supportsCustomBaseUrl: boolean
}
```

内置 16 家 = `builtin-manifests.ts` 里 16 个字面量(替掉 `builtin-providers.ts` + `factory.ts:423-705` 的逐家注册 + 壳 `dials.ts` + `shared/provider-families.ts`);自定义服务商 = `SpaceProviderSettings.customProviders[]` 里存的 manifest(`CustomProviderConfig` 改成 `{ manifest: ProviderManifest; config: ProviderConfig }`,读时兼容旧 `apiType` 映射到 `dialect`)。注册表 `ProviderManifestRegistry`(`register` 返回卸载函数,自定义的在装配时注册并 `own()`),19 处枚举改成读字段:`billing === 'subscription'`、`models.kind`、`auth.kind`、`quotaSource`、`sibling`。

### 5.3 三格上 `ProviderConfig`

```ts
headers?: Record<string, string>   // 每个请求都带;值里 {{apiKey}} 发送时换成当前凭证;有 Authorization 头时不再加默认 Bearer
modelsUrl?: string                  // 覆盖 manifest.models 的端点;空 = baseUrl + '/models'
dialect?: string                    // 覆盖 manifest.dialect(内置家指向中转站时也可能要换)
```

贯通:`core/engine/agent-loop-runtime.ts:651-662` 与 `agent-runtime-route.ts:53` 的字段复制表加三格(这是今天 `dialect` 从未生效的唯一原因);`factory.ts` 的通用工厂按 manifest.dialect 与 config 三格建 provider,逐家工厂函数合并成一个。**Header 存明文**(和 `baseUrl` 一样),密钥仍只在密钥池。

### 5.4 models.dev 单份缓存

`<store>/cache/models-dev.json`,带 `etag` / `fetchedAt`;`fetchOnethingModelsDevData` 改成读它、按 ETag 条件请求、24 小时内不重拉;所有 provider 的刷新与批 3 的建议索引都读这一份,离线可用。

### 5.5 `effective` 折叠只在后端

「用户覆盖 > 接口报的 > 未知」今天壳(`contextWindowOf` / `readingsOf`)与后端(`model-registry.ts:895/949`)各算一遍,09-10 圆环 unknown 事故就是它。`models.getWithCapabilities` 返回每型 `effective: { contextLength, maxOutput, capabilities, reasoningProfile, source: 'override' | 'endpoint' | 'catalog' | 'unknown' }`,壳的两个折叠函数删,`ProviderModelPrefs` 不再带两张覆盖表。

### 5.6 陌生能力演练

「加一家 Mistral」:`builtin-manifests.ts` 一个字面量(方言选 openai-chat,models.dev 键 mistral)+ 图标,别处零改。「加一家要 query string 带密钥的」:新方言一文件 + `registerDialect` 一行,manifest 指它。通过。

## 6. 批 3 · 自定义服务商 + 参数建议

### 6.1 对话框 = manifest 编辑器

名称、接口类型(下拉,读方言注册表的人话名:OpenAI 兼容 / OpenAI Responses / Anthropic / Gemini / OpenRouter / 智谱 / 通义 / DeepSeek…,默认 OpenAI 兼容)、接口地址、密钥(可空)、高级 ▸(模型列表地址、Header 键值表每行「名 / 值 / ✕」+「插入 {{apiKey}}」小钮)、默认模型。没有测试连接钮;保存后目录区自动拉一次,结果就是反馈。批 4 在这里加「自动识别」。

### 6.2 直连拉目录

`refreshOnethingProviderModels` 按 `manifest.models.kind` 分派(`models.dev` / `endpoint` / `roster` / `none`),`endpoint` 一个实现 `fetchProviderDirectModels(baseUrl, modelsUrl, headers, apiKey)`:宽容解析 `{data:[{id}]}`、`{data:[{id,display_name}]}`、`{models:[{name}]}`、纯字符串数组;能拿的参数字段拿全(OpenRouter `context_length` / `top_provider.max_completion_tokens`、vLLM `max_model_len`、Ollama `/api/show` 的 `num_ctx`),写成 `source:'endpoint'` 条目;都不中 → 交批 4 的 `modelsList` 映射;再不中 → 「获取失败」+ 原话 Tooltip,手动添加照常。codex 与 copilot 的现有 `/models` 拉取归到 `endpoint` 这一种下,各自的形状差异进解析器的形状表,不再是分支。

### 6.3 模型参数建议:接口不报参数时,从目录里认亲,弹建议、点了才填(用户 09-26 追问 + 裁定)

转发站、聚合站、本地推理框架报出来的模型十有八九是别家的现成模型:`openai/gpt-5.5`、`anthropic/claude-fable-5-1`、`deepseek-chat`、`DeepSeek-V3.2-Exp`、`qwen3-max:free`。它们的上下文长度、最大输出、能力位、思考档位,models.dev 全都有,只是挂在别家名下。今天这条路是断的:自定义目录条目没参数,行上留空,上下文按 128k 猜、tool 按名字猜(`model-registry.ts:895/949`)。

**用户裁定(09-26):不用 AI。** 目录里就有 `gpt-5.5`,拿存着的能力和上下文弹一个建议,用户点了才应用。所以这一节是「算一个建议 + 一颗应用钮」,不是自动继承,也没有 AI 参与。

**两个判断。** ①错的上下文比不知道更糟(认错亲会让 32k 的模型按 200k 跑,第一次长对话就 400),所以只做确定性匹配,不做编辑距离那类模糊匹配,认不出就不弹。②建议是建议,不自动写:应用之前它不影响任何一次请求;应用之后它就是用户覆盖,和手填的一样。

**匹配:`runtime/src/providers/model-identity.ts`**(纯函数,Electron-free,单测直接喂 models.dev 快照)。输入 `(modelId, 目录索引)`,输出 `{ twin: { provider, id }, level } | null`。三级逐级降,任一级唯一命中即停:

| 级 | 规则 | 例 |
| --- | --- | --- |
| ① 带厂牌前缀 | `厂牌/型号` 按第一个 `/` 切开;厂牌经别名表映射到 models.dev 的 provider 键(`openai`、`anthropic`、`google`、`deepseek`、`moonshotai`→`moonshot`/`kimi`、`x-ai`→`xai`、`z-ai`/`zhipu`、`qwen`/`alibaba`…),型号在该 provider 下**精确**匹配;不中则在 models.dev 的 `openrouter` 目录里精确匹配整串(那份目录本身就是一张「厂牌/型号」总表) | `openai/gpt-5.5` → openai · gpt-5.5;`deepseek-ai/DeepSeek-V3.2` → 走 openrouter 表 |
| ② 裸 ID 精确 | 全目录找同名 ID;**唯一**命中才算;多家同名(`deepseek-chat` 在 deepseek 与某聚合站都有)时取**第一方**(models.dev 里 provider 键 = 厂牌本身的那家) | `claude-fable-5-1` → anthropic;`deepseek-chat` → deepseek |
| ③ 规范化精确 | 两边都做同一套规范化后精确匹配:小写;去厂牌路径;去尾缀 `:free` / `:latest` / `-latest` / `-preview`;去日期尾 `-20260118` 这类;`_` 与 `-` 同视。仍要求唯一 | `DeepSeek-V3.2-Exp` → deepseek-v3.2-exp;`qwen3-max:free` → qwen3-max |

三级都不中 → `null`,不弹。

**建议什么时候算、算什么。** 读目录行时算(后端 `models.getWithCapabilities` 投影一格 `suggestion?`,索引按 models.dev 缓存建一次,内存里 memo),只在「这一型的这一项既没有用户覆盖、接口也没报」时给:上下文长度、最大输出、五个能力位(tools / vision / reasoning / imageOutput / fileInput)、思考档位。**参考价不进建议**:转发站的价不等于官方价,点一下把官方价写进账本会把估算带偏;价格留给账本按「无单价」处理。

**参数优先级三层不变**:用户覆盖 > 接口自己报的(批 3 的直连拉取要把能拿的字段拿全:OpenRouter `/models` 的 `context_length` / `top_provider.max_completion_tokens`,vLLM 的 `max_model_len`,Ollama `/api/show` 的 `num_ctx`;各家形状差异进批 4 的 `modelsList` 映射)> 未知(留空;引擎的 128k 兜底只在这一层才用)。建议不是一层,它只是「未知」态旁边的一颗钮。

**屏上。** 目录行参数列为空且有建议时,那一格画一枚小字建议芯片:「≈ 200K」「≈ 工具·视觉·思考」,悬停「按 OpenAI gpt-5.5 填」,点芯片 = 把这一项写进对应覆盖表;覆盖浮层里同样的位置多一行「按 OpenAI gpt-5.5 填:200K / 输出 128K / 工具·视觉·思考 [应用]」,一次写全部四张表(`contextLengthByModel` / `maxOutputByModel` / `modelCapabilitiesByModel` / 思考档位)。目录头部,当这家有 ≥2 个模型带建议时,多一句「{n} 个模型可按目录填参数 [全部应用]」。应用后芯片消失,值和手填的一模一样,浮层里「恢复目录值」照旧能清。手动添加 ID 那一刻(`addManualModel`)行一出来就带芯片。

文件:`model-identity.ts`(新,含别名表)、`backend/rpc/domains/models.ts`(投影 `suggestion`)、`shared/ipc/providers.ts`(`OpenRouterModel.suggestion?: { from: {provider,id}; contextLength?; maxOutput?; capabilities?; reasoningProfile? }`)、`ModelCatalogRow.tsx` / `ModelOverridePopover.tsx` / `ModelCatalog.tsx` 头部(芯片、应用行、全部应用)、`providers/store.ts`(`applySuggestion(providerId, modelId, fields)` 复用今天写覆盖表的那条路)。测试:一份 models.dev 快照 + 30 个真实转发站 ID 的黄金表(含五个必须答 `null` 的:`my-finetune-v2`、`gpt`、`chat`、同名多家非第一方、日期尾不同版本);`gate:providers` 加两步:手填 `gpt-5.5` 后行上有芯片、点后覆盖表有值且芯片消失。

### 6.4 陌生能力演练

「转发站要在 `/models` 上带分页」:`fetchProviderDirectModels` 的形状表加一行 `next` 字段名,别处不动。通过。

## 7. 批 4 · 自动识别适配

### 7.1 边界

第三方转发站的偏差集中在 openai-chat 一条线上的几个点:思考内容的字段名(`reasoning_content` / `reasoning` / `thinking`)、usage 字段名、工具调用参数累积方式、`finish_reason` 取值、`[DONE]` 有无、模型列表形状。**不做**「任意响应格式」。AI 生成的是一张数据表 `CustomAdapterSpec`,不是代码。

```ts
export interface CustomAdapterSpec {
  version: 1
  wire: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generateContent'
  request?: {
    maxTokensField?: 'max_tokens' | 'max_completion_tokens'
    streamUsage?: 'include_usage' | 'always' | 'none'
    reasoning?: ReasoningProfileOverride['custom']      // 复用今天就有的声明式思考映射
    extraBody?: JsonObject
  }
  response?: {                                             // 只对 openai-chat 生效(批 4 范围)
    textDeltaPath?: string          // 默认 choices[0].delta.content
    reasoningDeltaPath?: string     // 默认 choices[0].delta.reasoning_content
    toolCallsPath?: string          // 默认 choices[0].delta.tool_calls
    finishReasonPath?: string       // 默认 choices[0].finish_reason
    finishReasonMap?: Record<string, 'stop' | 'length' | 'tool-calls' | 'content-filter'>
    usage?: { input?: string; output?: string; cacheRead?: string; reasoning?: string }   // 相对 usage 对象的路径
    doneMarker?: string | null      // 默认 '[DONE]'
  }
  modelsList?: { itemsPath: string; idField: string; nameField?: string; contextField?: string }
  probe?: { at: number; model: string; confidence: 'high' | 'medium' | 'low'; notes: string }
}
```

路径是点号 + 下标的简单表达式(`choices[0].delta.reasoning_content`),一个 30 行的 `getPath` 就够,不引 JSONPath 库。

### 7.2 spec 编译成策略对象,线不动(v2 改法)

openai-chat 线今天已经是「读策略」的:usage 走路径表 `openAIChatUsageTable`(`openai-chat-wire.ts:105-138`),思考增量走 `thinking.decode`(`:291`),额外块走 `decodeExtras`(`:323`)。所以 `dialectFromSpec(spec)` 只做编译:`spec.response.usage` → 一个 `UsageNormalizer`;`reasoningDeltaPath` → 一个 `ThinkingWire`(`encode` 复用 `ReasoningProfileOverride.custom` 的声明式映射,`decode` 读路径);`toolCallsPath` / `finishReasonMap` / `doneMarker` → `decodeExtras` 与配方的 `request` 表。产出一个方言,`registerDialect('custom:<providerId>')` 在装配时注册、`own()` 卸载。**线的源码一行不改**,没有 spec 的自定义服务商与今天逐字一致(golden 夹具钉死)。

### 7.3 「自动识别」

对话框一颗钮,后端 `providers.probeCustom({ baseUrl, apiKey, headers, modelsUrl?, hintModel? })`:

1. **探两发。** `GET modelsUrl`;用启发式猜的线(`/v1/messages` 200 → anthropic;`event: response.created` → responses;`choices[].delta` → chat;`candidates[]` → gemini)`POST` 一条最小流式请求(`"hi"`,`max_tokens: 16`,`stream: true`)。截前 8KB、脱敏。
2. **规则先判。** 线的归属靠启发式;字段名命中默认值的,spec 只写 `wire`,不请 AI。
3. **AI 只填偏差。** 规则判不满时,两份样本 + spec 的 JSON Schema + 固定提示词交给一家**已配好且不是正在配置的这一家**的模型(utility 路);一家都没有就只走规则。
4. **回验。** 用生成的 spec 本地重放样本:≥1 个文本增量;有 usage 段就解出 input/output;模型列表 ≥1 项。不过 → 「识别失败」+ 原话 Tooltip,不写盘。
5. **一句话上屏。** 「识别为 OpenAI 兼容;思考内容在 reasoning_content;模型列表 12 个。」+ [应用]。

钮的 Tooltip:「会向这个地址发一条测试请求,并用已配置的模型分析响应。」

### 7.4 文件与测试

`shared/ipc/providers.ts`(spec 类型)、`dialects/custom-from-spec.ts`(新,编译器)、`runtime/src/providers/custom-probe.ts`(新:探测 + 规则 + 回验,纯函数)、`backend/rpc/domains/providers.ts`(`probeCustom`)、`CustomProviderDialog.tsx`。五份真实转发站 SSE 夹具(DeepSeek 直连、某聚合站 `reasoning`、Ollama、vLLM、LM Studio)各生成一次 spec 回验通过;golden 无 spec 逐字不变。

### 7.5 陌生能力演练

「转发站把工具调用塞在 `delta.function_call`(老格式)」:spec 加一格 `toolCallsStyle`,编译器多一个分支产出对应的 `decodeExtras`;线不动。通过。

## 8. 批 5 · 配额与余额

### 8.1 数据模型

```ts
export type ProviderQuota =
  | { kind: 'balance'; currency: 'USD' | 'CNY'; available: number; granted?: number; fetchedAt: number }
  | { kind: 'windows'; windows: Array<{ id: string; seconds: number; usedPercent: number; resetsAt?: number }>; plan?: string; fetchedAt: number }
  | { kind: 'unsupported' }
  | { kind: 'error'; reason: 'auth' | 'network' | 'rate-limited' | 'unknown'; message: string; fetchedAt: number }
```

窗口**按时长归类**,不按接口里的 primary/secondary 位置(Codex 各套餐顺序不同,CodexBar 等工具都踩过):≤6 小时 → 「5 小时」,≤8 天 → 「本周」,其余用「{n} 天」。

### 8.2 源注册表(能力自述)

`runtime/src/providers/quota/registry.ts`:`registerQuotaSource(id, source)`,`source = { fetch(ctx: { credential | oauthToken, baseUrl, fetchImpl }) => Promise<ProviderQuota> }`;manifest 的 `quotaSource` 指向它,core 与 RPC 只读表。首批五源:

| 文件 | 家 | 接口 | 产出 |
| --- | --- | --- | --- |
| `codex.ts` | codex | 现有 `fetchOnethingCodexUsage` 搬进来 | windows + credits(有余额时另出一条 balance 行) |
| `claude-code.ts` | claude-code | `api/oauth/usage`,三个头 | windows(five_hour / seven_day / 各模型周窗) |
| `deepseek.ts` | deepseek | `/user/balance` | balance(`total_balance`,币种照给) |
| `kimi.ts` | kimi(仅国际站;.cn 真机核后再开) | `/v1/users/me/balance` | balance |
| `openrouter.ts` | openrouter | `/auth/key`(`limit − usage`;`/credits` 若普通密钥可用则换它) | balance |

未注册的家一律 `unsupported`;xAI 与 Copilot 待核后各加一文件一行。**被动源同批做。** `http-agent-provider.ts:162` 拿到 `response.headers` 后,方言可选实现 `quotaFromHeaders(headers)`(Codex 的 `x-codex-primary-used-percent` / `x-codex-primary-reset-after-seconds` 一族;Claude 订阅的统一限额头字段名待真机核),产出走现成的 `provider-data` 事件上抛,`QuotaService` 收到即更新缓存,零额外请求,减少对 Claude 那条 429 高发接口的依赖。

### 8.3 后端服务与推送

`backend/wiring/quota/index.ts`:`QuotaService` 挂 `backend.quota`,`own()`;缓存键 `(providerId, credentialId | accountId)`。取数时机:composer 卡片打开且缓存超 60 秒;每次 `run/end` 后针对本轮用的 provider 与凭证,30 秒去抖;设置页刷新钮强制;**空闲不轮询**;`rate-limited` 后 10 分钟不问。出网全局事件 `provider:quota`。RPC:`providersRouter.usage` 改名 `quota`,返回 `ProviderQuota`。**密钥策略暴露只读 `decide(providerId, spaceId)`**(批 6 的 `pickRoute` 也用它),composer 卡片显示的余额是「这一发会用哪条」的余额。

### 8.4 composer 卡片

**圆环仍只画上下文占比**(18px 画不下第二道弧;余额也没有天然的百分比)。配额进悬停卡片,插在「上下文」行之后,按当前模型的服务商与将要用的凭证取数:

| 情况 | 行 |
| --- | --- |
| 订阅,有窗口 | 「5 小时 已用 62% · 14:30 重置」「本周 已用 31% · 周一 08:00 重置」(一窗一行,只画有数的) |
| API,有余额 | 「余额 ¥123.45」(币种符号按 currency) |
| 有余额也有窗口(Codex credits) | 两种都出 |
| 服务商不支持 | 「本月已用 $4.12(本地估算)」(读现有 `usage.getSummary` 月桶,按 provider 过滤) |
| 取数失败 | 不出行;卡片底一行灰字「余额获取失败」+ 原话 Tooltip |
| 正在取 | 上次的值照显示,不闪「加载中」 |

圆环本身只加一件事:最紧的窗口 ≥ 80%,或余额低于 ¥10 / $2 时,圆环底色换警示色(`--ring-warn`),悬停即见原因。备选是外圈第二道弧,不推荐。

### 8.5 设置页

API 模式:密钥池每条密钥行备注位右侧出「¥123.45」(有源的家才有,取数时机同上,不加钮)。订阅模式:`UsageCard` 改读 `ProviderQuota`,「5 小时」「本周」替掉「Primary / Secondary」;多账号时每个账号一组窗口条。

### 8.6 门与演练

`gate:quota`(dist/server + 假接口):五源各喂真实响应夹具断言归一;Codex 两种套餐顺序都归到「5 小时 / 本周」;`run/end` 后 30 秒内只发一次;429 后 10 分钟零请求;被动源一条响应头更新缓存;卡片行按 8.4 表逐格。演练「加 SiliconFlow `/v1/user/info`」:`quota/siliconflow.ts` 一文件 + manifest 一格。通过。

## 9. 批 6 · 轮转 v2

### 9.1 一个决策函数,一条候选序列

`runtime/src/providers/route.ts` `pickRoute(modelId, spaceId, now) => RouteCandidate[]`,`RouteCandidate = { providerId, entryId, reason }`。顺序:

1. 目标 provider 若 `billing === 'subscription'`:它的 OAuth 账号,**按窗口剩余量从多到少**(最紧的那个窗口的 `100 − usedPercent`;没有配额数据的排在有数据的后面,按池内顺序);
2. `manifest.sibling` 指向的同家 API 密钥(仅当家族开关「订阅用完切 API」为开),按池策略排;
3. 目标 provider 若 `billing === 'api'`:它的密钥按池策略排(`single` = 只取第一条可用;`priority-failover` = 按序;`round-robin` = 游标起)。

冷却集合 = 报错冷却(今天的)∪ **配额冷却**:窗口 `usedPercent ≥ 100` → `cooldownUntil = resetsAt`;余额 ≤ 0 → 冷却到下次配额刷新;由 `QuotaService` 写进同一格 `cooldownUntil`(只延长不缩短,同今天)。窗口重置后候选序列自然回到订阅。发送前取候选 `[0]`;失败后 `createSessionCredentialRotator` 改成沿序列取下一条(跨 provider 时 `reprovision` 换 manifest),不再只在一家的池内转。

**跨家兜底不做自动**:Claude 全用完不改走 DeepSeek,换模型是用户在选择器里手选的事。

### 9.2 用户面两格,其余默认

- 密钥池策略**默认改「按顺序接力」**(`priority-failover`);旧值 `single` 照读。
- 家族卡一颗开关「订阅额度用完时切到 API 密钥」,默认开(用户已拍,§10);切换发生的那一轮,composer 现有的自动重试提示行写「订阅额度已用完,这一轮按 API 计费」。
- 服务商开关 `enabled` 在 `pickRoute` 里是硬过滤(批 0 已在发送路查,这里归位)。

### 9.3 文件、门、留账

`runtime/src/providers/route.ts`(新,纯函数,喂 manifest 表 + 池 + 配额缓存)、`backend/wiring/providers/credential-rotation.ts`(沿序列取)、`space-credentials.ts`(`decide` 读 `pickRoute`)、`shared/ipc/spaces.ts`(家族开关)、壳 `ModeCard.tsx`(开关)。`gate:route`:订阅账号 A 窗口 100%、B 40% → 选 B;A/B 都满、开关开 → 选同家 API 第一把;开关关 → 失败句;窗口 `resets_at` 过后 → 回 A;默认空间两把密钥 402 后换第二把。留账两条:①「跑过工具后不再换凭证」在配额类失败时能否放开,要先读 runner 的重试会不会重跑工具;②流到一半失败换凭证重试,前半段已上屏文字会不会重复,进 `gate:route` 一步。

### 9.4 陌生能力演练

「一家新的订阅服务商 + 它的 API 半边」:两个 manifest 字面量互指 `sibling`,一个配额源文件,`pickRoute` 不改。通过。

## 10. 拍点(全部已拍,09-26)

1. 点「登录」桌面自动打开浏览器,屏上仍留链接与复制;网页壳只留链接。**已拍:是。**
2. 圆环仍只画上下文,配额进卡片两行,快用尽时圆环变警示色。**已拍:是。**
3. 「自动识别」向该地址发一条 16 token 测试请求,并用已配置的模型分析一次。**已拍:是。**
4. 自定义 Header 明文落 settings.json,`{{apiKey}}` 引密钥池。**已拍:是。**
5. Claude 订阅用量走非公开接口,429 时静默不显示。**已拍:是。**
6. 注入 `shell` 宿主口后 AI 工具能在桌面打开文件与网址。**已拍:开。**
7. 「订阅额度用完时切到 API 密钥」默认开,切换那一轮提示一句。**已拍:默认开。**
8. 模型参数建议不用 AI,弹芯片点了才填。**已拍(用户裁定)。**

## 11. 留账

**入库记录(09-26):** 批 0 4f2c3c478 · 批 1 e38e5660c · 批 2 3509eb188 · 批 M-b 5361cef8c · 批 M-a bcf4eb916 · 批 3 a5dde18c1 · 批 5 8d8d070cc · 批 4 fcd20cbc9;批 6 施工中。

**施工中挖出的新账:**

- 目录刷新拿旧 settings 快照整份写回,把中间别人写的字段盖掉(批 2 真机门上 1.5 秒内复现,与本方案无关,已开独立任务查根因,修法按 settings-single-authority「写入 API 换形」)。
- 批 4:适配表里 `toolCallsPath` / `finishReasonPath` / `finishReasonMap` / `doneMarker` 四格编译照常但**运行期不生效**(线把这几处读死了),由 `unsupportedAdapterSpecFields` 如实列出;§7.5 演练「转发站把工具调用塞在 `delta.function_call`」按「线一行不改」的红线答不出 —— 要给 openai-chat 线开一格可替换的工具调用策略,**待拍**。
- 批 5:Claude 订阅的响应头被动源字段名待真机核;默认空间同一家多个 OAuth 账号问到的是同一份令牌(默认空间的令牌仍住 settings 层 `oauth-tokens.json`,池里的 oauth 条目只是「登没登」标记,既有结构);composer 卡片底部「余额获取失败」的原话 Tooltip 因卡片是圆环悬停出现、指针一离开就关而碰不到;`resolveSessionCredentialId` 等发送路之外的解析仍会拨 round-robin 游标。
- 批 3:`ensureCatalog` 不重取「过期但没标脏」的目录;`gate-providers-squeeze` 不离线(models.dev 缓存启动时仍会走网刷新);新对话框未进 `gate:a11y`。
- 批 M-a:`sibling` 仍产自 `@shared/provider-families`(边界门不许 `@shared` 反向依赖 runtime,manifest 读它);三家有计费档位的 provider(`zhipu.ts` `resolveOnethingProviderBaseUrl`、`provider-options.ts`、`spaces/provider-credentials.ts` 的字段表)仍按 id 分支,要让 `DialSpec` 长出地址解析器才能收;`agent-runtime-route.ts` 的 `isOnethingACPProviderRuntime` 仍比较常量 `'acp'`。
- 批 M-b:引擎自己的上下文 / 最大输出读法仍只读默认空间(覆盖表是 per-space 的);目录条目已改「0 = 未知」,盘上老条目的 128000 到下次刷新才换。
- 批 1:壳的 `oauthStart` 仍不带 `spaceId`(照旧)。
- 测试基线红(与本方案无关,三个 worktree 都在干净 HEAD 上核过):`sessions-domain` 25 条(mock 缺 `getTodoPlanStore`)、music 域 2 条、`thinking-wire` grok-effort 1 条、`owned-labels-snapshot`(别的会话的 `memory` / `acpSpawnEnv` 标签没进快照);`credential-strategy.test.ts` 冷缓存首次转译 8.8s 撞 5s 超时是假红,批 5 加了 `beforeAll` 热身。


- Kimi `.cn` 站余额接口、xAI `/v1/billing/credits`、OpenRouter `/credits` 对普通密钥是否可用、Copilot 高级请求配额、Claude 订阅响应头字段名:五条待真机核。
- 批 4 只让 openai-chat 一条线接受 spec 编译;另外三条线的偏差没见过真实案例。
- `copy:gate` 棘轮、密钥保存后静默探测当状态点:可选,未排。
- 轮转 v2 两条留账见 §9.3。
- CLAUDE.md 里「eleven explicit nulls」已过期(今天 10 个,批 1 后 9 个),随批 1 一起改;`SUBSCRIPTION_PROVIDER_IDS` 等 19 处枚举随批 M 消失后,CLAUDE.md 的 Providers 段要补 manifest 一句。
