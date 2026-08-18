# 多空间 provider 配置与模型选择 —— 整体审查与调整方案

日期：2026-08-18。审查对象：B3/B7/B9/B10 落地的 per-space provider 配置与模型选择。
主设计：`workspace-spaces-2026-08.md`。本文是对其中 provider 配置这一支的结构性复盘。

## 1. 诊断

反复出现的问题（独立面板 → 开关不独立 → 默认模型不独立 → 旋钮设不了 → 跨窗口不同步
→ 切空间外观变）**都是同一个决定的显形**：B3「default 空间 = settings.ai 原地不动，
非 default = 另立 credentials.json + space.json」。零迁移换来了**两套数据形状**，每个消费
者都必须 `isDefaultSpace ? A : B`，每片都会漏一个消费者。且非 default 侧语义不统一：
凭证严格隔离 / 偏好缺席回落全局 / 接入目录全局∪空间——三种规则。

结论：只要两套形状还在，新增任何 provider 设置项都会在同一处再摔。B10 补眼下缺口，
但不改结构；本方案改结构。

## 2. 目标形状：default 也是普通空间

- 每个空间（含 default）：`workspaces/<id>/credentials.json`（凭证池）+ `space.json`
  （provider 偏好：`providerEnabled` / `selectedModels` / `defaultSelection` /
  `providerOptions{apiMode,region,baseUrl}`）。
- `settings.ai` 只留全局共享：models.dev 目录缓存（models/modelsLastFetched）、自定义
  provider **定义**（无凭证）、per-model 能力与上下文覆盖、provider 家族表。
- 统一语义：
  - 凭证：per-space 严格隔离，不回落。
  - 偏好：per-space，**不回落**（无全局偏好可回落）；新空间初值来自向导「从空间 X 导入」
    或空白；空白空间加第一把 key 时该 provider 的 selectedModels 预填首装默认表。
  - 模型选择器闸：`enabled(space) ∧ configured(space) ∧ selectedModels(space)`，default
    不再豁免 configured。
  - 引擎：会话 → 归属空间 → 偏好+凭证；无 workspaceId = default。
  - 设置页：单数据路、无 isDefaultSpace 分支、外观恒同构、标题栏「当前空间」。
  - 跨窗口：全部 `spaces:changed`；`settings:changed` 只剩全局共享部分。
  - OAuth：default 的 `oauth-tokens.json` 迁进 default 池（B6 space target 已支持）。
- 接入目录保持「全局∪空间」追加语义（它是权限边界，宽松合并有意；不在本方案内）。

## 3. 拍板（2026-08-18 用户）

1 → 机器级、所有空间可见。2 → **迁移后直接清掉旧字段**（不留回滚版；迁移前先备份 settings.json 一份到 `<store>/backups/`）。3 → 立即开（B10 收尾后即派 C1）。

原始选项：

1. **环境变量 API key**：建议机器级、所有空间可见（未存储故非泄漏；每空间显示 Env 徽章）。
   备选：仅 default 可见（再添一条特殊路，不推荐）。
2. **迁移后 settings.ai 旧字段**：建议保留一版（迁移标记 + 读侧忽略）可回滚；下一版清理。
3. **时机**：建议先提交工作区九批 + 真机走查，再开 C1（结构性重构不叠在未提交改动上）。

## 4. 分片

- **C1 数据统一 + 迁移（后端）**：space.json 加 providerOptions；`createOnethingBackend`
  装配序列加一次性惰性迁移（settings.ai.providers[*] 凭证→default 池、偏好→default
  space.json、oauth-tokens.json→default 池 oauth entries；写 `settings.storage.providerConfigMigratedAt`
  标记；**旧字段迁移后清除**，迁移前把 settings.json 原样备份到 `<store>/backups/settings-pre-space-migration-<ts>.json`）；三宿主同一份代码，server/CLI 用 default 空间文件。三态解析去掉
  `kind:'settings'` 分支。测试：迁移幂等、标记后读侧忽略旧字段、回滚可读、server 同路。
- **C2 视图与 UI 单路**：`useSpaceProviderView` 去掉 isDefaultSpace 分支；ConnectionsSection
  用 B10 抽出的共享行组件唯一渲染；env 徽章按拍板 1；新空间向导默认勾「从当前空间导入偏好」。
- **C3 选择器与引擎闸统一**：default 加 configured 闸；引擎回落链去掉「全局默认」一格
  （agent 覆盖 > 会话 > 空间默认）；旧会话缺省 default 不变。
- **C4 清理与文档**：settings.ai 旧字段从类型与 defaults 中删除（读侧仅迁移代码认识它们）；主设计 §2 决策表「default
  空间凭证源=settings.ai」条目改写；CLAUDE.md 一段。

## 5. 风险与回滚

- 迁移前备份 settings.json；回滚 = 用备份覆盖 + 删 default 空间新文件（文档化步骤）。
- default 用户可见变化只有一条：配了模型没配 key 的 provider 从选择器消失（本就发不出）。
- server 默认 owner 首次启动会执行同一迁移；`owners/<uid>/<wid>` 多租户树不动。

---

## 6. C1 已实施(2026-08-18)

「default 也是普通空间」已落地:一次性迁移 + 两态解析 + 渲染层跟随。以下是与
§2/§4 的**逐条对账**,以及实施中偏离方案的地方(勘误)。

### 6.1 迁移映射表

`createOnethingBackend` 装配序列第 2 步(`initializeSettings()` 之后、任何子系统
问「这个 provider 配了没有」之前)跑一次
`migrateProviderConfigToDefaultSpace()`(`packages/onething-runtime/src/app/providers/space-config-migration.ts`)。
触发条件:`settings.storage.providerConfigMigratedAt` 缺席。

| 旧位置 | 新位置 | 备注 |
| --- | --- | --- |
| `settings.ai.providers[pid].apiKey` | `workspaces/default/credentials.json` → `providers[pid].entries[0].apiKey` | 空 key **且**无 baseUrl 的不建 entry(否则池里堆十几条空壳) |
| `…[pid].baseUrl` | 同一条 entry 的 `baseUrl` | |
| `…[pid].{zhipu,qwen,kimi}ApiMode` / `{qwen,kimi}Region` | 同一条 entry 的 `apiMode` / `region` | 批 B10 的 entry 级裁决,C1 尊重不变 |
| `settings.ai.customProviders[*].apiKey` / `.oauthToken` | 同一份池(键就是 `custom-xxx`) | **定义**留全局,钥匙进空间 |
| `<store>/oauth-tokens.json` 的每个 provider | 同一份池的 `authType:'oauth'` entry | 迁完把原文件写成 `{}`(清空不是删除) |
| `…[pid].enabled` | `workspaces/default/space.json` → `overlay.providerEnabled[pid]` | |
| `…[pid].selectedModels` | `overlay.selectedModels[pid]` | 空数组保留(「表达成空」≠「没表达过」) |
| `settings.ai.provider` + `providers[该 pid].model` | `overlay.defaultSelection = { provider, model }` | 合成一对,不拆两格 |

留在 `settings.ai` 的(全局共享,所有空间同一份):`temperature`、
`providers[*]` 的 `models` / `modelsLastFetched`(models.dev 目录缓存)、
`temperatureByModel` / `maxOutputByModel` / `contextLengthByModel` /
`thinkingByModel` / `thinkingEffortByModel` / `serviceTierByModel` /
`modelCapabilitiesByModel`、`customProviders[*]` 的定义部分。

**幂等与失败语义**:标记在 = 同步返回,不备份不改动;搬运只补不覆盖(已有 entry
的 provider 不动、overlay 已表达过的键不动),所以重跑安全;任何一步抛错都
**走不到**写标记/清字段那一步,下次启动重跑。装配序列里包了 try/catch —— 迁移
失败不该把整次启动拖垮,只记一条 error。

### 6.2 备份与回滚步骤

迁移前备份到 `<store>/backups/`:

- `settings-pre-space-migration-<ISO>.json`
- `oauth-tokens-pre-space-migration-<ISO>.json`(只在原文件存在且非空时)

回滚(退回 C1 之前的形状):

1. 退出 onething(桌面端 / server / CLI daemon 全部,`StoreLock` 是单实例的)。
2. `cp <store>/backups/settings-pre-space-migration-<ISO>.json <store>/settings.json`
3. `cp <store>/backups/oauth-tokens-pre-space-migration-<ISO>.json <store>/oauth-tokens.json`
4. `rm <store>/workspaces/default/credentials.json`
5. 编辑 `<store>/workspaces/default/space.json`,删掉 `overlay` 里的
   `providerEnabled` / `selectedModels` / `defaultSelection` 三个键
   (`connectedDirectories` 是 B2 的,**不要删**)。
6. 代码回到 C1 之前的提交。备份里 `storage.providerConfigMigratedAt` 本来就不存在,
   所以第 2 步一并把标记清掉了。

只想**重跑**迁移(不回退代码):删掉 `settings.json` 里的
`storage.providerConfigMigratedAt` 即可,搬运是幂等的。

### 6.3 勘误(与 §2/§4 的偏离)

1. **`providerOptions` 不加**。§2 给 overlay 留了
   `providerOptions{apiMode,region,baseUrl}`。核实结果:这三格没有一个是「没有
   entry 也需要」的 —— `apiMode`/`region` 是「这把钥匙属于哪个账号档位」(cn 与
   intl 是两个互不可达的账号),`baseUrl` 要么由档位派生、要么是「我这台机器走哪个
   代理」(那是机器级,不该按空间存)。批 B10 已裁决它们是 entry 级,C1 尊重该裁决,
   **不另设 overlay 字段**,免得同一件事有两个落点。
2. **两态之外多了两格,但它们不是「状态」,是「不阻断」**:
   `kind:'env'`(机器环境提供 apiKey,拍板 1)与 `kind:'credential-free'`
   (ACP / 本地 CLI agent / 外部 agent executor,从不问凭证)。两者都**不盖**
   `spaceCredential` 标记,因此不经过起流前置拦截。`credential-free` 是补一个
   **被三态形状盖住的既有 bug**:C1 之前非 default 空间的 ACP 会被报成「本空间
   未配置」而起不了流(default 空间恰好靠 `kind:'settings'` 绕开了)。
3. **env 的边界**:env 只补 `apiKey` 这一格;**池里有可用 entry 时 env 不参与**
   (空间里配了钥匙却被环境变量顶掉是解释不清的一天);**OAuth 型 provider 不受
   env 影响**(一串环境变量不会让你登录)。设置页每个空间都会把 env 兜底画成
   `Env` 摘要(`buildSpacePoolCredentialView` 的 `envApiKey` 入参)。
4. **`mergeWithDefaults` 白名单补了 `storage` 与 `evals`**。迁移标记住在
   `settings.storage` 里,而那两个键是 C0 审计记下的既有漏项 —— 不补的话标记
   每次读盘都被吞掉,迁移**每次启动重跑一遍**。副作用如实记下:
   `storage.sessionFormat` 这个一直是死的开关随之生效(缺省仍是 `jsonl`,
   见 `app/stores/sessions.ts:79`),`evals.repoDir` 同理。
   `settings.test.ts` 的 `KNOWN_DROPPED_KEYS` 随之清空。
5. **`settings.ai` 的旧字段:数据清了,类型没删**(与任务书的「从类型中删除」有
   偏离,记在这里)。原因是 `ProviderConfig` 同时是**落盘形状**和**运行期生效
   形状** —— `applySpaceProviderCredential` 正是把 entry 的 apiKey/baseUrl/档位
   **盖回**这个类型上,`getEffectiveProviderConfig` 也从它上面读 `model`。把这些
   格从类型里删掉,等于要先把「持久化 config」与「生效 config」拆成两个类型,
   那是一次独立的、比 C1 更大的重构(核心 `CoreProviderConfigLike` 与两条解析链
   全在其上)。C1 做到的是:**没有任何写路再产出它们**(设置页全部改写空间层)、
   **迁移把盘上的清掉**、**读路全部走空间层**。留待 C4 的是类型层的拆分。
   同理 `settings.ai.provider` 仍在类型与 defaults 里,作为**全新安装的种子**和
   引擎回落链的最后一格 —— 去掉那一格是 §4 里 C3 的活。
6. **`DEFAULT_PROVIDER_CONFIGS` 变成「首装种子表」的第一个真实消费者**:
   空白空间加**第一把** key 时,`seedSpaceSelectedModels` 用它给该 provider 预填
   `selectedModels`(qwen / acp / claude-code-agent 那几家的可用模型 models.dev
   目录里没有或滞后,种子表是唯一来源)。只在该 provider **一格都没表达过**时预填 ——
   表达成空数组是用户自己清的。
7. **用量卡(批 B10 移交项 2)按空间查**:`ProviderUsageRequest` 加了
   `spaceId`,RPC handler 用
   `resolveSpaceProviderCredentialForSpace(spaceId, providerId)` 换出 auth 目标。
   不加这一格的话,迁移之后 `oauth-tokens.json` 已空,用量卡对**所有**空间都失效。
   渲染层的缓存键也从 `providerId` 改成 `providerId@spaceId`(两个空间是两个 codex
   账号,共用一格会把 A 的额度画在 B 的卡上)。
8. **新建空间向导的「导入凭证」源头改了**:从 `settings.ai.providers[*]` 改成
   **另一个空间的凭证池**(缺省 default)。迁移之后 settings 里已经没有 apiKey
   这一格,继续读它只会导出一片空。同时 `buildImportedSpaceCredentials` 由
   「每个 provider 一条」改成**按 entry 逐条追加**(源空间的池本来就是多条,
   覆盖会让「三把轮换的 key」悄悄变成一把)。
9. **IPC 层的 `DEFAULT_SPACE` 闸拆了三处**(`setSpaceCredential` /
   `setSpaceCredentialPool` / `clearSpaceCredential`)。唯一保留的是
   `importSpaceCredentials` —— 导入给自己是句废话。
10. **默认空间唯一的可见变化**如 §5 所述:配了模型没配 key 的 provider 从选择器
    消失(`configured` 闸不再豁免 default)。凭证区的**外观**也变了:default 空间
    现在和别的空间一样是那一个池编辑器(单路化的直接后果;更彻底的 UI 收敛在 C2)。

### 6.4 tsc / 测试驱动改到的消费点

产品与装配层:`spaces/provider-credentials.ts`(两态 + env + credential-free)、
`spaces/credentials.ts`(导入按 entry 追加)、`spaces/ipc-operations.ts`(拆三处闸)、
`app/providers/space-credentials.ts`(解析入口 + 导入源 + 种子预填)、
`app/providers/space-defaults.ts`(去 default 特判)、
`app/rpc/domains/providers.ts`(用量按空间)、`app/backend.ts`(装配序列)。

宿主:`apps/electron/src/ipc/spaces.ts`(去三处 `isDefaultSpace`)。

契约:`shared/ipc/settings.ts`(`StorageSettings.providerConfigMigratedAt`)、
`shared/ipc/providers.ts`(`ProviderUsageRequest.spaceId`)、
`shared/defaults/settings.ts`(merge 白名单补 storage/evals)。

渲染层:`stores/spaceProviders.ts`(去 default 短路与三处写闸)、
`composables/useSpaceProviderView.ts`(单数据路 + env 徽章)、
`components/settings/provider/useProviderSettings.ts`(setActiveModel /
setProvidersEnabled / toggleModelSelection / addCustomModel / setDefault* 全部改写空间层)、
`useModelLedger.ts`(setDefault / removeModel / renameModel)、
`ConnectionsSection.vue`(`usesSpacePool` 去 default 分支 + 用量卡移出 OAuth 分支 +
「全局共享」说明)、`ModelLedgerSection.vue`(调参卡「全局共享(所有空间)」)、
`platform/providers-client.ts`、`useProviderUsage.ts`。

### 6.5 计划外发现 / 事故

- **实施过程中一次单测清空了开发机上真实的 `~/.onething/oauth-tokens.json`**
  (写成了 `{}`)。根因:迁移里取 token 文件路径用的是
  `getDefaultOnethingTokenFilePath()` —— 它走的是模块级 `getOnethingStorePath()`,
  隔离测试把 store 根挪走时它照旧指着 `~/.onething`,而那一步是**写**。
  已双向加固:①迁移改走宿主端口 `getStorePath()`(生产里同一个文件,测试可隔离);
  ②该测试 `beforeEach` 把 `ONETHING_STORE_PATH` 也钉在临时目录。
  凡是**会写用户 store** 的新代码,路径必须走 `app/stores/paths.ts` 的端口。
- `mergeWithDefaults` 吞 `storage` 这件事(memory 里记了很久的「sessionFormat 开关
  是死的」)在本片被迫修掉 —— 迁移标记就住在那儿。

### 6.6 给 C2(UI 单路化)留下的接口

- `useSpaceProviderView` 已经是**单数据路**:`credentialOf` / `selectedModelsOf` /
  `spaceDefault` / `providerEnabledOverride` / `setDefaultSelection` /
  `setProvidersEnabled` / `setSelectedModels` 对所有空间同一条。`isDefaultSpace`
  仍导出,但**只回答产品问题**(能不能删这个空间、要不要画「从别的空间导入」)——
  C2 若发现它又出现在读写分支里,那是回归。
- `buildSpacePoolCredentialView({ providerId, pool, oauth, envApiKey })` 是纯函数,
  Env 徽章由 `envApiKey` 入参决定(拍板 1)。B10 的 `ProviderCredentialRows`
  已带徽章位,C2 只需把 `usesEnvApiKey` 一路接到它。
- `ConnectionsSection.usesSpacePool` 现在只判 `spaceView.spaceAvailable`(后端答不
  答得上话)。C2 要做的是把 OAuth 分支(`AuthCard`)与池编辑器收成 B10 的共享行
  组件唯一渲染 —— 目前 OAuth 登录已经走 `SpaceCredentialPool` 的 `oauth` 形态,
  `AuthCard` 只在 `spaceAvailable === false`(web 降级)时才画得到。
- 新建空间向导的「从空间 X 导入」入口:`importDefaultSpaceCredentials(targetId,
  sourceSpaceId?)` 已支持指定源空间(缺省 default),渲染层还没有源空间选择器。
- 还留在 `settings.ai` 的写路:`setDefaultProvider` / `setDefaultModel` 已改写
  overlay,`settingsStore.saveAIProviderDefault` 现在**没有生产调用方**(只剩 store
  定义),C3 去掉引擎回落链时可以一并删。

## 7. 2026-08-18 用户对齐：每个空间一整套完整的 provider 设置

用户原话：「不同的空间，provider 设置应该是完整的、独立的两套。对齐。」

推翻本方案 §2「settings.ai 保留自定义 provider 定义 / per-model 覆盖」的划分，也推翻
B7/B9 的「散装 overlay 字段 + 缺席回落全局」。目标：

- `workspaces/<id>/providers.json` = 该空间**完整**的 AI 配置，形状 = 今天的 `AISettings`
  减去两样：凭证（留在池 `credentials.json`，多 key 需要池）与 models.dev 目录缓存
  （缓存非设置，全局一份）。含：默认 provider/model、每 provider 的 enabled /
  selectedModels / apiMode·region·baseUrl（entry 级旋钮仍在 entry；provider 级 baseUrl
  与自定义 provider 定义在此）/ 逐模型 contextWindow·maxTokens 覆盖 / 思考档位、
  customProviders 定义。
- **无回落**：空间即空间。新空间初值来自向导「从空间 X 复制」或空白。
- overlay 里 B7/B9 的 `providerEnabled` / `selectedModels` / `defaultSelection` 并入
  providers.json（overlay 只剩接入目录等非 provider 项）。
- 设置页 = 编辑当前空间的 providers.json，与旧的 settings.ai 编辑同一条代码路（换源）。
- `settings.ai` 最终只剩：models 目录缓存 + modelsLastFetched（+ 家族表若在此）。
- C1 迁移改为：`settings.ai`（去凭证、去缓存）**整体**搬进 default 空间 providers.json，
  凭证进池（已做），缓存留 settings.ai；旧字段清除范围随之扩大到整个 providers[*] 与
  provider/customProviders。

分片调整：C2 = 「providers.json 全量 per-space + 迁移改整体搬 + 设置页/选择器/引擎换源
单路」；C3 = 闸与回落链清理；C4 = 类型拆分（持久化 config 与生效 config）。

---

## 8. C2 已实施(2026-08-18)

§7 的「每个空间一整套完整的 provider 设置」已落地:**新增一份落盘文件 +
一处换源缝 + 一次整体搬迁**。以下是与 §7 的逐条对账,以及实施中偏离方案的地方
(勘误)。

### 8.1 providers.json 的形状

`workspaces/<id>/providers.json`(`packages/onething-runtime/src/spaces/provider-settings.ts`):

```jsonc
{
  "ai": {                       // 一级键留位,与 space.json 的 { overlay: … } 同一手法
    "provider": "deepseek",     // 这个空间的默认 provider;"" = 还没选过
    "temperature": 0.7,         // 缺席 = 用全局缺省
    "providers": {              // 每 provider 的整份配置
      "deepseek": {
        "model": "deepseek-chat",          // 该 provider 的默认模型
        "selectedModels": ["deepseek-chat"],
        "enabled": true,
        "baseUrl": "…",                    // provider 级(无 entry 时的缺省 / 自定义 provider)
        "zhipuApiMode": "…", "qwenApiMode": "…", "qwenRegion": "…",
        "kimiApiMode": "…", "kimiRegion": "…",
        "contextLengthByModel": {}, "maxOutputByModel": {},
        "temperatureByModel": {}, "thinkingByModel": {}, "thinkingEffortByModel": {},
        "serviceTierByModel": {}, "modelCapabilitiesByModel": {}
      }
    },
    "customProviders": [ { "id": "custom-x", "name": "X", "apiType": "openai" } ]
  }
}
```

**永不落进这份文件的键**(`SPACE_PROVIDER_STRIPPED_FIELDS`,剥在唯一的写入口):
`apiKey` / `oauthToken` / `authType`(→ 同空间 `credentials.json` 凭证池)、
`models` / `modelsLastFetched`(→ 全局 `settings.ai.modelCatalog`)、`localAddress`
(历史脏键)。剥在写路而不是靠调用方自觉 —— 落盘入口只有一个,过滤器就只该有一份。

坏文件的收法与 overlay **不同**,这是有意的:结构不认时 overlay 退成「空 overlay」
(等价于「这个空间没加料」),而 providers.json 退成**空设置但文件视为存在** ——
文件在就说明这个空间已经在新形状里,退回「缺席」会让一个坏字节把整台机器拖回
迁移前的语义。

**entry 级旋钮仍在 entry 上**(批 B10 裁决,C1 尊重,C2 继续尊重):provider 级的
`apiMode` / `region` / `baseUrl` 只是「无 entry 时的缺省」与自定义 provider 的住址。

### 8.2 类型拆分做到哪一步

| 类型 | 含义 | 住址 |
| --- | --- | --- |
| `AISettings` | **全局**:`temperature` 缺省 + `modelCatalog` | `settings.json` 的 `ai` 段 |
| `SpaceProviderSettings` | **per-space**:`provider` / `temperature` / `providers` / `customProviders` | `workspaces/<id>/providers.json` |
| `EffectiveAISettings` | 生效形状 = 上面两者合成 | 内存;`AppSettings.ai` 就是它 |
| `ProviderModelCatalog` | 目录缓存一格(`models` / `modelsLastFetched`) | `AISettings.modelCatalog[pid]` |
| `PersistedAppSettings` | `Omit<AppSettings,'ai'> & { ai: AISettings }` | 设置仓库与迁移专用 |

任务书要求的「把 `AISettings.providers / provider / customProviders` 从全局类型移走」
**已达成**:`AISettings` 上这三格不复存在。**勘误**:`AppSettings.ai` 的类型改成了
`EffectiveAISettings`(生效形状)而**不是**改名为别的东西 —— 这样整棵消费者树
(约 28 个文件)一个字不改就变成 per-space,而「持久化 vs 生效」的分家由
`PersistedAppSettings` 这一个别名承担。`ProviderConfig` 仍然兼落盘与生效两职
(它上面还留着 `apiKey` / `models`),拆成两个类型是 C4 的活 —— C1 记下的理由未变:
`applySpaceProviderCredential` 正是把 entry 的 apiKey 盖回这个类型上。

### 8.3 换源:一处缝,不是 N 个消费者

合成与拆分的两个纯函数住在 `packages/shared/defaults/ai-settings.ts`
(`composeEffectiveAISettings` / `splitEffectiveAISettings`)—— 后端与渲染层**共用同
一份**。两处各写一份的第一天不会有人发现,第一百天没人解释得清为什么设置页存下去
的东西引擎读不到。

| 层 | 换源点 |
| --- | --- |
| 装配层读 | `app/stores/settings.ts`:`getSettings()` = **default 空间**的生效 settings;`getSpaceSettings(spaceId)` 任意空间;`getPersistedSettings()` 原样(只给迁移) |
| 装配层写 | 同文件的 `prepareSave`:`ai` 拆成两半,per-space 写 `providers.json`(`options.spaceId ?? default`),其余落 `settings.json` |
| 引擎 | `app/providers/space-ai-settings.ts` 的 `getSessionSettings(sessionId)`,接进 `provider-helpers.ts` 的两条解析链(`getEffectiveProviderConfig` / `getProviderConfigForChat`) |
| 引擎(标题模型) | core 的 `StreamEngineStoreAdapter.getSettingsForSession?`(新增可选口),宿主在 `stream-engine-runtime.ts` 注入 —— 标题解析不经过 `getEffectiveConfig`,少了这一格它会用别的空间的模型 |
| 渲染层读 | `stores/settings.ts` 的 `applySpaceProviderSettings()`:拿到后端那份之后用**这个窗口的**空间重新合成 |
| 渲染层写 | 同文件 `saveSettings`:先 `spaceProviders.writeProviderSettings(space)`,再把**只剩全局那一半**的 payload 发给 `platformApi.saveSettings` |
| 立即落盘的三个写(模型选择 / 默认 / 开关) | `stores/spaceProviders.ts` 的 `writeSelectedModels` / `writeDefaultSelection` / `writeProvidersEnabled`,先读后并 + 乐观更新 + 失败回滚 |

**守卫一条**:`prepareSave` 只在 `settings.ai.providers` **存在**时才拆。渲染层发过来
的是「只剩全局那一半」,少了这一格判断,一次「只保存全局」的写会把 default 空间的
整份 provider 设置清成空的。

`isDefaultSpace` 在数据读写路径上**已清零**:`useSpaceProviderView` 与
`spaceProviders` store 仍导出它,但只回答产品问题(能不能删这个空间)。

### 8.4 迁移映射(改成整体搬 + 二段迁移)

标记两格,各管一段:

| 段 | 标记 | 做什么 |
| --- | --- | --- |
| 一(C1) | `storage.providerConfigMigratedAt` | 凭证 + oauth token → default 凭证池 |
| 二(C2) | `storage.spaceProviderSettingsMigratedAt` | 见下 |

第二段做四件事:

1. `settings.ai` 的 `providers[*]`(去钥匙、去目录缓存)+ `provider` +
   `customProviders` → **每个已登记空间**的 `providers.json`;
2. 该空间 overlay 里 B7/B9 的三格**盖在上面**(`providerEnabled` → `providers[*].enabled`、
   `selectedModels` → `providers[*].selectedModels`、`defaultSelection` → `provider` +
   `providers[provider].model`),然后把这三格从 overlay 上清掉;
3. `providers[*].models` / `.modelsLastFetched` 抬进 `ai.modelCatalog`;
4. `ai` 上的 `provider` / `providers` / `customProviders` **整键删除**(C1 是逐格清理 ——
   那意味着每加一件 provider 设置就要记得往那张表里补一行,正是要拆掉的东西)。

**C1 版本已经跑过的机器**(第一格在、第二格不在)= 只跑第二段;凭证那一段整个跳过
(再搬一次只会在池里堆重复 entry),第一格的时间戳原样保留。

纪律不变:先备份(`<store>/backups/settings-pre-space-migration-<ISO>.json`)、
搬运只补不覆盖(`providers.json` 已在 = 跳过)、任何一步抛错都走不到写标记那一步。

### 8.5 有意留全局的清单(应只剩这些)

| 项 | 落址 | 理由 |
| --- | --- | --- |
| models.dev 目录缓存 | `settings.ai.modelCatalog[pid].{models,modelsLastFetched}` | 缓存不是设置:~500KB,刷新一次该所有空间同时看见,复制 N 份纯属浪费 |
| 采样温度缺省 | `settings.ai.temperature` | 空间没表达 `temperature` 时的机器级兜底(空间表达了就以空间为准) |
| provider 家族表 | `packages/shared/provider-families.ts`(代码常量,不落盘) | 「Kimi 与 Kimi Code 是一家」是产品事实,不是用户设置 |
| 环境变量 API key | 不落盘 | C1 拍板 1:机器级,全空间可见,并画 Env 徽章 |
| 接入目录 | `settings.tools.connectedDirectories` ∪ 空间 overlay | 权限边界,宽松合并有意(不在本方案内) |
| ACP agent 配置 | `settings.acp` | **勘误**:它不在 `settings.ai` 下,本片未动;要不要 per-space 是独立问题 |

### 8.6 tsc / 测试驱动改到的消费点

**契约**:`shared/ipc/providers.ts`(`AISettings` 重定义 + `SpaceProviderSettings` /
`EffectiveAISettings` / `ProviderModelCatalog` 新增)、`shared/ipc/settings.ts`
(`AppSettings.ai` 改指生效形状 + `PersistedAppSettings` + C2 迁移标记)、
`shared/ipc/spaces.ts`(两条新请求/响应 + `SpacesChangedEvent.kind` 加 `'providers'`)、
`shared/ipc/channels.ts`(`SPACES_{GET,SET}_PROVIDER_SETTINGS`)、`shared/ipc/index.ts`。

**共享逻辑**:`shared/defaults/ai-settings.ts`(**新增**:合成/拆分/空白初值/全灭壳判定)、
`shared/defaults/settings.ts`(`DEFAULT_AI_SETTINGS` 改生效形状 + `normalizeAISection`
按迁移标记分两种形状)。

**产品层**:`spaces/provider-settings.ts`(**新增**:落盘层)、`spaces/overlay.ts`
(三格读得进写不出)、`spaces/notifications.ts`(kind 加 `'providers'`)、
`spaces/ipc-operations.ts`(两条 IPC 操作)、`spaces/index.ts`、`onething.aliases.ts`。

**装配层**:`app/providers/ai-settings-compose.ts`(**新增**:迁移标记 + 无回落语义)、
`app/providers/space-ai-settings.ts`(**新增**:按会话取空间)、`app/stores/settings.ts`
(合成/拆分/持久化三对函数)、`app/providers/space-config-migration.ts`(整体搬 + 二段)、
`app/providers/space-defaults.ts`(源头换成 providers.json)、
`app/providers/space-credentials.ts`(种子预填改写 providers.json;「从空间 X 复制」
连 providers.json 一起复制)、`app/engine/stream/provider-helpers.ts`、
`app/engine/stream-engine-runtime.ts`。

**内核**:`core/engine/stream-runtime.ts`(`getSettingsForSession?` 可选口)、
`core/engine/core-stream-engine.ts`(标题解析用它)。

**宿主**:`apps/electron/src/ipc/spaces{,-controller}.ts`、`apps/electron/src/preload/bridge.ts`。

**渲染层**:`stores/spaces.ts`(两条通道)、`stores/spaceProviders.ts`(持有整套设置,
三个立即写改成 patch 整层)、`stores/settings.ts`(合成 + 拆分落盘)、
`composables/useSpaceProviderView.ts`(读写全部改 providers.json,`providerEnabledOverride`
撤掉 —— `isProviderEnabledIn` 的第一个入参**就是**空间的 providers 表)、
`stores/chat.ts`、`components/settings/{MusicSettingsTab,ToolsSettingsTab}.vue`、
`components/agents/AgentConfigForm.vue`(三处去掉第三个「空间覆盖」入参)、
`components/settings/provider/{ConnectionsSection,ModelLedgerSection}.vue`(范围说明改口径)、
`platform/web.ts`、`types/index.ts`。

### 8.7 勘误(与 §7 的偏离)

1. **`AppSettings.ai` 没有改名**,见 §8.2。`AISettings` 这个名字给了全局那一半,
   生效那一半叫 `EffectiveAISettings`。
2. **`mergeWithDefaults` 的 `ai` 段有两种形状**,由 C2 迁移标记分家:迁过且盘上没有
   `providers` 这一格 → 只留 `temperature` + `modelCatalog`;否则仍并进
   `DEFAULT_PROVIDER_CONFIGS`。后者不能删:① 迁移之前盘上还躺着旧字段,迁移正要读;
   ② **apps/server 的多租户树(`owners/<uid>/<wid>`)不在本次改造内**,它直接拿
   `mergeWithDefaults` 的结果当生效设置用。
   实施中在这里踩到一个**真实的跨用户泄漏**:第一版把模块常量 `DEFAULT_AI_SETTINGS`
   直接展开进结果,浅拷贝让所有 owner 共享同一批 `ProviderConfig` 对象 —— Alice 存的
   key 出现在 Bob 的设置里。已改成传 `createDefaultSettings()` 深拷出来的那一份,
   `http.test.ts` 的 owner 隔离用例抓住了它。
3. **非 default 空间的初值 = `settings.ai` 作底 + 自己的 overlay 盖上**。§7 说
   「新空间初值来自向导或空白」,但**迁移当下已存在**的非 default 空间没有第三种选择:
   C2 之前它们除了 overlay 三格以外全部回落全局,搬完之后用户在每个空间看见的必须与
   搬之前一样。这是本次迁移**唯一一次跨空间取值**,之后「无回落」生效。
4. **「从空间 X 复制」现在连 providers.json 一起复制**(`importDefaultSpaceCredentials`)。
   只复制钥匙不复制设置的话,新空间开出来是「有 key、没有一个模型被选中、没有默认」。
   渲染层的向导仍然只有一个勾选框(它现在的含义是「复制设置与凭证」),**源空间选择器
   仍未做**(C1 就欠着,C2 未补)。
5. **空白空间加第一把 key 时,除了预填 `selectedModels`,还会把该 provider 钉成默认并
   置 `enabled: true`**。§7 只说了预填模型表;不补这两格的话,配好第一把 key 的空白空间
   仍然发不出消息(没有默认)、或者在选择器里看不见(enabled 缺省被合成成 false)。
   「表达成空数组」仍然不被覆盖 —— 那是用户自己清的。
6. **合成时给「目录里认识、空间没配过」的 provider 补一条全灭壳**(`enabled: false`),
   拆分时再把它摘掉。补是为了让设置页拿得到目录缓存(否则新配一个 provider 时模型列表
   是空的),摘是为了让空白空间的 providers.json 真的是空的 —— 「没表达过」与
   「表达成关」在种子预填那里是两回事。
7. **overlay 的三格「读得进、写不出」**:类型、归一、解析全部保留(迁移要从盘上的旧
   overlay 取值),但 `writeSpaceOverlay` 不再产出它们。于是没迁过的机器读得到旧数据,
   迁过的机器第一次写回就把它们清掉 —— 不需要第二个开关。
8. **逐模型调参的范围说明反了口径**:C1 时 `ModelLedgerSection` 上写着「全局共享
   (所有空间)」,C2 改成「仅当前空间」。这是用户可见的语义变化,记在这里。
9. **apps/server 没有 `/api/spaces/<id>/provider-settings` 路由**:web 端两条通道走
   `softJson` 降级 —— 读回 `{success:false}`,渲染层据此保持后端那份(单空间宿主上
   `/api/settings` 就是它的生效设置)。与 B1 起 spaces 的其余路由同一条降级口径。

10. **C1→C2 两段路上丢了一格:非默认 provider 的「上次用的模型」**。C1 把
    `settings.ai.provider` + 那个 provider 的 `model` 合成进 overlay 的
    `defaultSelection`,同时**从每个 provider 配置里删掉了 `model`**。于是 C2 搬的时候,
    只有「空间默认 provider」那一格有 model,其余 provider 的 `model` 是空的。
    影响很轻(模型选择器列的是 `selectedModels`,`model` 只是「切到这个 provider 时
    的缺省那一个」),用户在选择器里点一次即恢复;但它是**已经发生**的数据变化,
    记在这里。全新安装与只跑一次 C2(没跑过 C1)的机器不受影响。
11. **实测:开发机上的 dev 栈在本片实施期间自己跑了一次真迁移**。`electron-vite dev`
    热重载拿到新代码 → `createOnethingBackend` 装配序列第 2 步 → C2 迁移在真实
    `~/.onething` 上执行(备份 `settings-pre-space-migration-2026-08-18T09-00-26-059Z.json`)。
    结果是对的(两个空间各拿到自己那一整套、`settings.ai` 收敛到
    `{temperature, modelCatalog}`、钥匙没有泄进 providers.json),但这说明
    **迁移一旦入库就会在下一次启动生效** —— 想先看不想迁的人,回滚步骤见 §8.8。

### 8.8 回滚步骤(在 §6.2 之上更新)

1. 退出 onething(桌面端 / server / CLI daemon 全部,`StoreLock` 是单实例的)。
2. `cp <store>/backups/settings-pre-space-migration-<ISO>.json <store>/settings.json`
   (C2 的备份文件名与 C1 同款;取**时间戳最新**的那一份)。
3. `cp <store>/backups/oauth-tokens-pre-space-migration-<ISO>.json <store>/oauth-tokens.json`
   (只有 C1 那次会生成)。
4. `rm <store>/workspaces/*/providers.json`
5. `rm <store>/workspaces/default/credentials.json`(只在退回 C1 之前时)。
6. `space.json` 里 C1 写的三格(`providerEnabled` / `selectedModels` / `defaultSelection`)
   在 C2 里被清掉了 —— 它们的值在第 2 步恢复的 `settings.ai` 里有一份等价的,**不需要
   手工补回**;`connectedDirectories` 是 B2 的,**不要删**。
7. 代码回到 C2 之前的提交。备份里两个迁移标记本来就不存在,所以第 2 步一并清掉了它们。

只想**重跑第二段**(不回退代码):删掉 `settings.json` 里的
`storage.spaceProviderSettingsMigratedAt`,并删掉要重建的那些 `providers.json`
(搬运是「只补不覆盖」的,文件在就跳过)。

### 8.9 给 C3 / C4 的接口

- **C3(闸与回落链清理)**:解析链上「全局默认」那一格已经**事实上空了** ——
  `settings.ai.provider` 迁移之后不再落盘,`getEffectiveProviderConfig` 最后那一支
  只会拿到空串。C3 可以把那一格从 `packages/onething-runtime/src/providers/provider-config.ts`
  的 `getEffectiveProviderConfig` 里删掉,并顺手删 `settingsStore.saveAIProviderDefault`
  (C1 起就没有生产调用方了)。
- **C4(类型拆分)**:`ProviderConfig` 仍兼落盘与生效两职。拆分点已经画好 ——
  `SPACE_PROVIDER_STRIPPED_FIELDS`(`shared/defaults/ai-settings.ts` 与
  `spaces/provider-settings.ts` 各一份,内容相同、住址不同,因为产品层进不了 `@shared`)
  就是那条线:线上面是 `SpaceProviderConfig`(可落盘),线下面是运行期盖上去的
  `apiKey` / `oauthToken` / `models`。
- **合成/拆分是唯一入口**:任何新的 provider 设置项,只要写进 `providers[*]`,
  就自动 per-space、自动落进 providers.json、自动被两条解析链读到。**不需要**在
  overlay、IPC 契约、迁移表里各加一行 —— 那正是 B7→B9→B10 每片都漏一件的病根。
