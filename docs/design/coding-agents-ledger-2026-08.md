# 外部 Coding Agent 接管(pi / Claude Code / Codex)— 会话续聊、用量、花费

2026-08-29 立项。目标:在 onething 后端把本机 CLI coding agent(pi、Claude Code、
Codex,后续持续接入新家)的历史会话管起来 —— **不止看账,还要能在应用里挑一条
外部会话直接接着聊**。先做后端,UI 后续由 apps/desktop-react 经既有 RPC 通道对接。

## 0. 一句话架构

**两个半边、一条缝。**

- **账房半边(新域 `coding-agents`)**:三家(及以后每家)各一个格式适配器,把
  自家 JSONL 解析成同一套规范模型;增量索引器把 3.3GB 原始数据折叠成摘要缓存;
  聚合器出用量与花费;RPC 域出口。只读,原始数据永远留在各家目录。
- **续聊半边(既有域 `external-agents`)**:不新造对话栈。外部会话被**认领**成一条
  onething 会话,经 `ExternalAgentSessionLink` 绑定 `{connectorId, externalSessionId,
  cwd}`,之后每一轮走现成的引擎/流式/权限/持久化机器 —— Claude 连接器已存在且已支持
  resume;补 Codex 与 pi 两个连接器即可。**CLI 自己写回自家会话文件**(resume 的
  语义就是续写),所以外部账本始终是 agent 上下文的唯一事实,我们的会话只是渲染快照
  —— 这正是 `external-agents/types.ts` 里已经写下的契约。
- **缝**:账房发现会话 → 用户挑一条 → `adoptSession` 建链 → 引擎接管续聊 →
  turn 结束账房重扫那一个文件,账目自动跟上。

## 1. 数据源实测(2026-08-29,本机)

| Agent | 位置 | 布局 | 用量在哪 | 花费 |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<项目slug>/<uuid>.jsonl` | 每项目一目录,每会话一文件;1150 文件 / 1.1G | 每条 assistant 行 `message.usage`:`input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens` / `output_tokens_details.thinking_tokens`;model 在消息上 | 无,按价目表算 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | 按日期三层目录;289 文件 / 2.0G | `event_msg/token_count` 的 `total_token_usage`(**会话累计值,取最后一条**);model 在 `turn_context` 上(可中途换) | 无,按价目表算 |
| pi | `~/.pi/agent/sessions/--<cwd转义>--/<ts>_<uuid>.jsonl` | 按工作目录分组;151 文件 / 164M | 每条 assistant 消息 `usage`:`{input, output, cacheRead, cacheWrite, totalTokens}` | **自带** `usage.cost.*`(USD) |

### 已核实的格式陷阱(实现时必须处理)

1. **Codex `cached_input_tokens` 包含在 `input_tokens` 之内** —— 计价按
   `input - cached` 计,否则缓存按全价重复计费。Claude 的三个 input 字段互斥,直接加。
2. **Codex `token_count` 是累计快照**,会话总量 = 最后一条的 `total_token_usage`;
   老版本会话可能没有此事件 → 用量诚实缺席记 null,不编零。
3. **Claude Code 同一条 assistant 消息可能因流式/重试写多行**,按 `message.id`
   去重再累加(ccusage 同款口径)。sidechain(子代理)照常计 —— 那也是真花费。
4. **pi 的 cost 是写入时算好的** —— 直接采信(`costSource: 'native'`),不重算,
   账本尊重产地。
5. 空文件、首行元数据解析失败的文件跳过并计入 `skipped`,一个坏文件不毒死整次扫描。

## 2. 账房半边:落点与骨架

域名定为 **`coding-agents`**。与既有域职责互斥:`agents` 是内部 agent 档案,
`external-agents` 是驱动外部 agent 干活的连接器层,本域读外部 agent 落盘的账。
I1/I2 校验过:core / runtime 均无同名目录,无碰撞。

```
packages/onething-runtime/src/coding-agents/     # 产品层,Electron-free
├── types.ts            # 规范模型(§3)
├── source.ts           # CodingAgentSource 抽象接口
├── registry.ts         # 唯一的"有哪些家"名单
├── sources/
│   ├── claude-code.ts  # 一家一个适配器,互相不认识
│   ├── codex.ts
│   └── pi.ts
├── index-store.ts      # AgentSessionIndex:增量索引 + 磁盘缓存
├── summary.ts          # 聚合:day/week/month × agent × model × project
└── cost.ts             # 计价:复用 usage/pricing.ts 机制,补三家 model 价目

packages/backend/wiring/coding-agents/index.ts   # 薄接线:单例装配、缓存路径注入
packages/backend/rpc/domains/coding-agents.ts    # RPC handlers
packages/shared/ipc/coding-agents.ts             # defineRouter 契约
packages/renderer/platform/coding-agents-client.ts
```

依赖方向不变:product ← assembly ← hosts。三家根目录是**外部根**,不走
`getOnethingStorePath`;做成构造参数,默认 `os.homedir()` 拼接,测试注入临时目录。
索引缓存落 `<store>/coding-agents/index-<kind>.json` —— 是缓存不是账本,可删可重建。

### 面向对象的三个关键决定(新家接入是硬约束)

**① 格式知识全部封死在 Source 里。**

```ts
interface CodingAgentSource {
  readonly kind: CodingAgentKind        // 'claude-code' | 'codex' | 'pi' | …
  readonly rootDir: string
  /** 只 readdir+stat 不读内容 —— 增量判断的输入 */
  listSessionFiles(): Promise<SessionFileRef[]>   // { path, mtimeMs, sizeBytes }
  /** 流式逐行读一个 jsonl,折叠成摘要;坏文件返回 null 附原因 */
  parseSummary(ref: SessionFileRef): Promise<AgentSessionSummary | null>
  /** 按需读全文投影成规范转写(分页;认领时也用它导入显示快照) */
  parseTranscript(ref: SessionFileRef, opts: PageOpts): Promise<AgentTranscript>
  /** 续聊桥:这家会话由哪个 external-agents 连接器接管;不能接管的家返回 null */
  connectorBinding(s: AgentSessionSummary): { connectorId: string
                                              externalSessionId: string
                                              cwd: string } | null
}
```

**② 索引器/聚合器/RPC 只认接口不认三家。** `AgentSessionIndex` 持有
`CodingAgentSource[]`,刷新对谁都一样:`listSessionFiles()` → 与缓存比
`(mtime, size)` → 只对变化文件调 `parseSummary` → 写回。日常刷新只碰几个文件,秒级。

**③ 注册点是显式 Registry**(`registry.ts`),`CodingAgentKind` 用 `string`
品牌类型不做闭合联合 —— 索引缓存是落盘数据,闭合联合会让"删一家适配器"之后
旧缓存行变非法(与 `ONETHING_USAGE_SOURCES` 同理)。

### 新增一家 CLI 的完整清单(以后照抄)

1. `sources/<name>.ts` 实现 `CodingAgentSource`,格式知识只许写在这里;
2. `registry.ts` 加一行;
3. `cost.ts` 补该家 model 单价(查不到自动落 `unpricedModels`,不阻塞);
4. `__tests__/fixtures/<name>/` 放 2-3 个脱敏样本 + 解析用例;
5. (若要续聊)`external-agents` 下补该家连接器,`connectorBinding` 返回其 id。

索引器、聚合器、RPC 契约、client、React UI 零改动 —— 列表/聚合全按
`AgentOverview[]` 动态出数,前端不硬编码家数。

## 3. 规范模型

```ts
interface AgentSessionSummary {
  agent: CodingAgentKind
  id: string                    // 各家自己的会话 uuid
  filePath: string
  projectDir: string            // 还原后的真实 cwd(slug/转义都还原)
  title: string                 // 首条用户消息截断(≤120 字符)
  startedAt: number
  updatedAt: number             // 文件 mtime
  messageCount: number
  models: string[]              // 出现过的 model,按出现序
  tokens: OnethingUsageTokens | null    // 复用既有形状;null=确无用量记录
  cost: { totalUSD: number; source: 'native' | 'computed' } | null
  resumable: boolean            // connectorBinding 非 null 且 CLI 可用
  adoptedSessionId?: string     // 已认领 → 对应的 onething 会话 id
  sizeBytes: number
}
```

计价:model 查不到价 → `cost: null` + 记入 `unpricedModels` 随聚合返回,不静默按 0。
订阅计划(Claude Max / ChatGPT)场景,聚合结果带 `billingNote:
'equivalent-api-cost'`,UI 据此措辞为"等效 API 成本"。外部账**不写入** onething
自家 usage 账本 —— 自家账本是 append-only 事实,外部索引是缓存,两者只共享
`OnethingUsageTokens` 类型与价目表;要合并展示是 UI 的事。

## 4. 续聊半边:认领 + 三个连接器

`external-agents` 现状(实测):`ExternalAgentSessionLink` 已定义并持久化于
`<store>/external-agents/session-links.json`;能力表已有 `resume/fork/steer` 位;
Claude 连接器已把 `request.resume.externalSessionId` 递进 SDK;`types.ts` 注释里
连接器谱系明写 "ACP, Claude Agent SDK, Codex app-server, pi RPC"。缺口只有两类:

**缺口 A — 认领入口。** 今天的 link 只由 onething 里发起的会话产生。新增
`adoptExternalSession(summary)`(装配层,`wiring/coding-agents/adopt.ts`):

1. 建一条 onething 会话,绑定该家的 external-agent provider;
2. 经 `source.parseTranscript` 导入最近 N 轮(默认 50 条消息)作**显示快照**,
   消息标记 `origin.source: 'coding-agent-import'` —— agent 的真实上下文由
   resume 携带,快照只为 UI 有历史可看;
3. 写 `ExternalAgentSessionLink{ connectorId, externalSessionId, cwd }`;
4. 之后发消息走普通聊天链路,引擎 → 连接器 → CLI resume 续写自家文件;
   turn 结束触发账房对该文件的单文件重扫(挂在既有 turn 完成事件上,不加新机制)。

同一条外部会话重复认领返回已有的 onething 会话(幂等,靠 link 表查重)。
连接器层已有"两进程同时 resume 同一外部会话"的互斥防护,直接受益。

**缺口 B — ACP 升级 + pi 连接器**(2026-08-29 ACP 调查后的定案,调查记录见 §4.1):

- **Codex:走 ACP,不再手写 app-server 协议。** `@agentclientprotocol/codex-acp`
  (v1.7.0 实测)是官方维护的 stdio ACP agent,内部驱动新 Codex App Server,
  npm 包自带兼容的 `@openai/codex` 依赖(解了"本机 PATH 无 codex"的问题,
  `CODEX_PATH` 可覆盖)。它声明 `loadSession: true` + `sessionCapabilities.resume`,
  `session/load` 映射到 App Server 的 `thread/resume` —— 也就是**能按原生
  rollout id 恢复 `~/.codex/sessions` 里的历史会话**,还处理 `session/list`。
  我们要做的是把仓库既有的通用 ACP 连接器升级:能力表 `resume: false` 的判断
  已过时(当年协议没有 load/resume,现在 v1 两个都有),补 `session/load` /
  `session/resume` 两法 + 认领时接受外部发现的原生 session id,按 initialize
  返回的能力位门控。升级是通用的 —— **以后任何自带 ACP 适配器的新 CLI
  都白拿续聊能力**,与"持续接入新家"的硬约束正对齐。
- **Claude:留在既有 SDK 连接器,不换 ACP。** claude-code-acp 也完全可行
  (会话存储就是 `~/.claude/projects/`,id 即原生 id,`loadSession: true` +
  `resumeSession` + fork/rewind 都有),但仓库的 SDK 连接器已深度接好权限桥、
  settings 三层、usage 读数,换 ACP 是净损失;ACP 对 claude 保留为兜底路。
- **pi:也走 ACP**(2026-08-29 更正:用户指出 pi 支持 ACP,查证属实 —— Zed 官方
  External Agents 文档有 Pi 节、ACP Registry 有 Pi 条目)。形态是独立适配器
  `pi-acp`(社区 MVP,包装 `pi --mode rpc` 桥成 stdio ACP,支持把 session
  loading/history 映射到 pi 自家会话文件、可续聊;pi 本体不直接说 ACP,
  `--mode` 只认 text/json/rpc)。裁定:pi 优先走升级后的通用 ACP 连接器 +
  pi-acp;鉴于其成熟度是 MVP,`pi --mode rpc` 直连保留为后备路,实现期真机
  验一轮再定死。

Claude Code 这条线**零连接器新代码**,只吃缺口 A。

### 4.1 ACP 调查记录(2026-08-29)

- 协议(v1,agentclientprotocol.com):`session/load` 由 `agentCapabilities.
  loadSession` 门控,agent 把它自己存储里的整段历史经 `session/update` 重放给
  客户端后应答 —— 认领时的"显示快照"可以直接吃这份重放,连转写文件解析都省了
  (账房的 `parseTranscript` 仍保留,给未认领会话的预览用);`session/resume` 由
  `sessionCapabilities.resume` 门控,不重放、只恢复上下文,适合"接着说"。
- claude-code-acp(zed-industries):会话就落在 `~/.claude/projects/<slug>/*.jsonl`
  (`CLAUDE_CONFIG_DIR` 可改根),ACP session id 与原生 id 同一,`loadSession:
  true`、`resumeSession`、fork、rewind、list-sessions 均有实现与测试。
- codex-acp:开发已从 zed-industries 迁至 agentclientprotocol org,基于新
  Codex App Server;npm 包 dist 实测声明 `loadSession: true` + `resume: {}`,
  内部走 `thread/resume`,并注册了 `session/list` 处理器。
- 结论:**ACP 覆盖续聊(claude✓ codex✓ pi✗),不覆盖账房** —— 历史用量/花费
  聚合仍靠文件扫描(ACP 只在活跃回合里发 token usage 事件,不提供历史账),
  且 `session/list` 不带 token/cost,账房的发现+出账地位不变。
- 顺手修正:`acp-connector.ts:21` "resume across app restarts needs the
  connector-native protocols" 的注释与 `resume: false` 位是协议旧貌,升级时删。

### 4.2 ACP 版本现状与升级项(2026-08-29 核查)

**协议版本**:ACP 用整数版本在 `initialize` 里协商,当前稳定线是 **v1**
(`protocolVersion: 1`);`session/load` 与 `session/resume` 都在 v1 正式文档内。
v2 还是 `unstable-v2` 草案(changelog 可见:load/resume 要合并成一个方法、diff
格式要换、ID 命名要统一)——**我们接 v1,不追 v2 草案**;SDK 主线同时带
experimental v2 API,不碰即可。

**SDK 版本 —— 本仓库有一个升级项**:

| 件 | 本仓库现状 | 最新 | 判断 |
| --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | **^0.17.1**(pre-1.0) | **1.4.0**(2026-08-20;1.0.0 于 2026-06-24 转正) | **要升到 ^1.4.0**。两边 `PROTOCOL_VERSION` 都是 1,线上的协议没说错,但 0.17.1 的 schema/类型面是 1.0 收口前的草案(session/resume 当时在 unstable 区),稳定的 load/resume 类型、方法合同校验、malformed-input 上报都在 1.x。仓库对它的用面很薄(`ClientSideConnection` / `ndJsonStream` / schema 类型,见 `acp/client.ts`),迁移是编译面问题 |
| `@zed-industries/agent-client-protocol`(旧包) | 未使用 | 0.4.5,2025-10 起停更 | 已死,永不引入 |
| `@agentclientprotocol/codex-acp` | 未接 | 1.7.0(官方 org,活跃) | P3 接入对象 |
| `@zed-industries/claude-code-acp` | 未接(claude 走 SDK 连接器) | npm 停在 0.16.2(2026-03-26,dep 还是 sdk 0.14.1);**main 分支远新于 npm**,Zed 现经 ACP Registry 分发 | 只作兜底路;若真要接,以 Registry 渠道的版本为准,不以 npm latest 为准 |
| `pi-acp` | 未接 | 社区 MVP(多个 fork,Zed Registry 有 Pi 条目) | P4 接入对象,验后定 |

对分期的影响:**P3 前置一个 P3-0 = SDK 升级批**(^0.17.1 → ^1.4.0,连带删
`resume: false` 旧判断、按能力位补 load/resume 两法),先落这批再接 codex-acp。

### 4.3 参照:Zed 与 Claude Code 是怎么接的

我们的续聊半边与 Zed 的做法同构,可互相对照:

- **Zed(客户端侧)**:Agent Panel 从 **ACP Registry**(`zed: acp registry`,
  一份经 CI 验证 authMethods 的策展名单)安装 External Agent;每个 agent 是 Zed
  spawn 的子进程,stdio 上跑 ndjson JSON-RPC。Zed 只托管 thread UI(消息流、
  权限卡、diff 展示、terminal),agent 自管 runtime / auth / 模型 / 计费。
  Zed v0.225+ 支持会话历史(即 `session/load` 重放)。我们的对应物:
  连接器进程 = 同款 spawn+stdio;thread UI = onething 会话;Registry ≈ 我们的
  `CodingAgentRegistry`(只是我们的名单在代码里)。
- **Claude Code(agent 侧)**:Claude Code 本体不说 ACP。`claude-code-acp`
  适配器进程内嵌 `@anthropic-ai/claude-agent-sdk`(Claude Code 的无头引擎),
  把 SDK 消息流翻译成 ACP `session/update`,把 ACP 的 fs/permission 请求翻译回
  SDK 的 canUseTool;会话直接读写 `~/.claude/projects/`,settings 三层与
  CLAUDE.md 照读,`/login` 管认证 —— 所以 Zed 里的 Claude 与终端里的 claude
  共享同一份账号、会话存储与配置。这正是我们"认领 `~/.claude` 历史会话"
  可行性的又一重佐证:Zed 每天都在这么干。

## 5. RPC 契约(数据面域,web 端经 `POST /api/rpc` 自动可用)

```ts
// @shared/ipc/coding-agents.ts
{
  listAgents(): AgentOverview[]
  // { agent, installed, cliAvailable, rootDir, sessionCount, totalSizeBytes, lastActiveAt }
  listSessions(req: { agent?; projectDir?; query?; offset?; limit?
                      sort?: 'updatedAt'|'cost'|'tokens' }): { items; total }
  getSession(req: { agent; id }): AgentSessionSummary
  getTranscript(req: { agent; id; page? }): AgentTranscript
  getUsageSummary(req: { granularity: 'day'|'week'|'month'; count?; agent? })
  // 桶结构对齐既有 usage 域,外加 byAgent / byModel / byProject 切片 + unpricedModels
  refreshIndex(req: { agent? }): { scanned, changed, skipped, tookMs }
  adoptSession(req: { agent; id }): { sessionId: string }   // 幂等
}
```

`adoptSession` 之后的对话不走本域 —— 就是普通 onething 会话,React 壳用它已经要做的
聊天链路(session-command + session:event/SSE)收发,零新通道。索引刷新策略:
请求时 TTL(60s)+ 显式 `refreshIndex` + 认领会话 turn 结束的单文件重扫;
不上 fs-watch(不引新依赖,现有机制够用)。

## 6. 分期

| 期 | 内容 | 验收 |
| --- | --- | --- |
| **P0 解析与索引** | types + Source 接口 + Registry + 三家适配器(处理 §1 全部陷阱)+ 增量索引缓存 | 夹具测试(每家 2-3 个脱敏样本);真机首扫 1590 文件可完成,二次刷新只碰变化文件 |
| **P1 出账 + RPC 读面** | cost.ts 价目 + summary.ts 聚合 + shared 契约 + backend handlers + client(除 adoptSession 外全部) | 聚合数字夹具可手算对上;codex 缓存减扣专项用例;curl 打 `POST /api/rpc` 全法可用 |
| **P2 认领续聊(Claude 先行)** | adoptSession + 转写快照导入 + link 落表 + turn 后单文件重扫;Claude 连接器直接复用 | 真机:挑一条历史 claude 会话认领,应用里续聊一轮,`~/.claude` 对应文件确实长出新轮次,账房数字跟上 |
| **P3 ACP 升级 + Codex** | **P3-0**:`@agentclientprotocol/sdk` ^0.17.1 → ^1.4.0(编译面迁移,删 `resume: false` 旧判断);**P3-1**:通用 ACP 连接器补 `session/load`/`session/resume`(能力位门控)+ 认领接受外部原生 id;codex-acp@1.7 作为第一个受益者接入(npx 拉起,ChatGPT 登录/API key 经 ACP authenticate) | 同 P2 口径真机走查:认领一条历史 rollout,续聊后 `~/.codex/sessions` 长出新轮次;adapter 不可用时可见降级 |
| **P4 pi 接入** | 优先 pi-acp(ACP,零新连接器);真机验其 MVP 成熟度,不够则退 `pi --mode rpc` 直连连接器(词汇对照 pi-mono 源码) | 同上 |
| **P5 管理小件** | 归档/删除 = 移入各家目录旁 `trash/`(不硬删,可恢复);Finder 定位 | 删错可捞回;对外部目录的唯一写动作就这一个,且默认要确认 |

每期完过四门(tsc / vitest / build / eslint),P0-P4 对外部目录零写入
(续聊的写入者是 CLI 自己,不是我们)。

## 7. 就地拍掉的裁定(不再上会)

- 域名 `coding-agents`;续聊骑 `external-agents`,不开第三个域。
- pi 采信自带 cost;claude/codex 按价目表算并标"等效 API 成本"。
- 外部账与自家 usage 账本分开出口,不做后端合表。
- 认领导入 50 条显示快照,不全量导入(agent 上下文由 resume 携带,全量导入徒增体积)。
- 删除做成 trash 移动而非硬删,且排到 P5。
- 不上 fs-watch。
- ACP 定位:**通用续聊适配层**。codex 走 ACP(codex-acp),pi 优先走 ACP(pi-acp,
  验后定),以后自带 ACP 的新 CLI 白拿续聊;claude 留 SDK 连接器(已深度集成,
  换 ACP 是净损失)。协议钉 v1,SDK 升 ^1.4.0,不追 unstable-v2 草案。
- 认领 claude/codex 会话的显示快照优先吃 `session/load` 的历史重放
  (claude 走 SDK resume 时仍用账房 `parseTranscript`);账房的发现与出账不依赖 ACP。
