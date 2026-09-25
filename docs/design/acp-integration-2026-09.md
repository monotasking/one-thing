# ACP 统一接入方案(2026-09):任何会说 ACP 的 agent CLI 都是一等同事

> 状态:方案,待拍板。起因:用户 2026-09-25「我想要完整的对接 ACP 方案,对接各种各样的 agent cli;例如 claude code」。
> 前作:`external-agents-integration.md`(2026-07,ACP 通道 + Claude SDK 连接器)、`claude-code-integration-v2.md`(2026-08,外部 agent 变一等同事:执行器 / 宿主工具面 / 交互协议)、`coding-agents-ledger-2026-08.md`(2026-08-29,「Codex / pi 走 ACP,SDK 要升 1.x」的定案)。本文把三篇的结论收成**一条路**,并把 2026-09-24 那笔「ACP 会话恢复」(`431b38dfd`)之后仍然缺的东西全部列出来。
> 协议与生态的逐条出处(spec 页、SDK d.ts、注册表 JSON、各适配器 dist 代码)在同日的参考稿 `acp-integration-reference-2026-09.md`,本文只引结论。

## 0. 一句话

**ACP(Agent Client Protocol,Zed 牵头的「编辑器 ↔ agent」标准协议,JSON-RPC over stdio)成为外部 agent 进 onething 的唯一通路。** agent 名册是数据不是代码;协议 1.x 的十六种会话更新每一种都有一等落点;agent 向我们要的三样东西(审批、文件、终端)全部走 onething 自己的许可系统、沙箱和终端服务;宿主工具面用一条 stdio 桥注入给所有 agent;Claude Code 换成官方适配器 `@agentclientprotocol/claude-agent-acp`,两千行的 SDK 专用连接器在对等门绿了之后退役。

## 1. 现状(2026-09-25 逐行核过)

### 1.1 两条路,几乎不共享

| | 路 A:ACP 通用 | 路 B:Claude Code 专用 |
| --- | --- | --- |
| 入口 | provider id `'acp'`,每个 agent 是它下面的一个「模型」 | provider id `'claude-code-agent'` |
| 进程 | `runtime/src/acp/client.ts`(1046 行)spawn CLI,`@agentclientprotocol/sdk` `ClientSideConnection` | `@anthropic-ai/claude-agent-sdk` 进程内驱动本机 `claude` |
| 翻译 | `runtime/src/agent-loop/providers/acp.ts`(340 行) | `runtime/src/external-agents/claude-code-connector.ts`(2103 行) |
| 装配 | `backend/wiring/acp/{subsystem,permission-bridge}.ts` | `backend/wiring/external-agents/{index,host-tools,spawn-env,background-status}.ts` |
| 有的东西 | 会话恢复(resume → load → new)、config options 上屏、代理环境 | 宿主工具面(MCP 注入协作工具)、插话、图片、persona、逐命令 / 逐路径权限效果、AskUserQuestion → 交互卡、resume |

`external-agents/acp-connector.ts`(66 行)是按 `ExternalAgentConnector` 契约写的 ACP 连接器,**只有测试在用**;生产的 ACP 路不经过它,也不经过 `ExternalAgentProvider`,所以 `ExternalAgentProvider` 里那几道检查(cwd 未绑定拒发、图片丢弃提示、system prompt 注入、会话链接持久化)在 ACP 路上一条都不跑。两套会话链接存储并存:`<store>/acp/session-links.json` 与 `<store>/external-agents/session-links.json`。`ACPAgentConfig` 有两份同形的拷贝(`shared/ipc/acp.ts` 与 `runtime/src/acp/types.ts`)。

### 1.2 协议版本落后一个大版本

仓里 `@agentclientprotocol/sdk` 钉在 `^0.17.1`,那是 1.0 收口前的草案;npm 最新 **1.5.0**(`PROTOCOL_VERSION` 仍是 1,线上协议号没变,变的是方法表与类型面)。1.5.0 比 0.17.1 多出来的、本方案要用的东西:

- agent 侧方法:`session/list` / `session/fork` / `session/resume` / `session/close` / `session/delete` / `session/set_config_option` / `session/set_mode` / `logout` / `providers/*`;
- 客户端侧方法:`elicitation/create`(agent 向用户提结构化问题)、`mcp/connect` 系列(agent 让客户端代连 MCP)、auth 的 `terminal` 方法(agent 让客户端开一个交互终端跑登录);
- 会话更新从 11 种变 **16 种**:新增 `plan_update`(items / markdown / file 三形)、`plan_removed`、`notice`、`compaction_update` / `compaction_summary_chunk`,`usage_update` 带 `cost`;
- `ToolCall` 多了 `name`(原始工具名,与粗分类 `kind` 分开);`McpServer` 多了 `acp` 形(经客户端代理)。

### 1.3 翻译层丢了多少

`agent-loop/providers/acp.ts` 对十六种更新的处置:文本 / 思考 / 工具调用 / 工具更新四种有落点;`plan` 被压成一句固定字符串「ACP plan updated.」;其余 **十一种直接 `default: break`**。工具内容里 `diff` 只剩路径(`oldText` / `newText` 丢掉,所以没有 diff 卡)、`terminal` 丢掉、`locations` 丢掉、`pending` / `in_progress` 不上屏、工具名只有粗分类 `kind`。出站只发最后一条用户文本:没有 system prompt、没有 persona、图片静默丢弃。

### 1.4 权限:四个选项没上屏,而且无桥宿主缺省自动放行

agent 发 `session/request_permission` 时带自己的选项表(`allow_once` / `allow_always` / `reject_once` / `reject_always`)。`backend/wiring/acp/permission-bridge.ts` 只答 allow / reject,于是「始终允许」永远到不了 agent;授权粒度是 `agentId:kind`(「始终允许 claude-code:execute」= 放行所有命令);ACP 路不跑 `describeExternalToolPermission` 那套按命令 / 按路径的效果分析(Claude 路有)。**只有 React 壳注册了桥**;CLI daemon 与 server 没有桥,回落到每个 agent 的 `permissionMode`,而四个内置 agent 的缺省是 `'allow'`——也就是在 daemon 与 server 上,agent 要什么给什么。

### 1.5 文件与终端:默认关,开了也不进沙箱

`allowFileSystemAccess` / `allowTerminalAccess` 四个内置 agent 全关。开了之后:读文件只查绝对路径与 1MB 上限,写文件直接 `mkdir -p` 落盘,终端直接 `spawn` —— 三者都不问沙箱、不问许可、不进 UI,终端子进程还拿不到登录 shell 环境与代理。

### 1.6 名字散落

「core 里不出现任何能力的名字」这条法,今天在这个域上是破的:`core/engine/external-agent-providers.ts:41-44` 硬编码 `acp` 与 `claude-code-agent` 两条执行事实(而 `registerCoreProviderExecution` 这个登记口零调用);`agents/executor/capabilities.ts`、`agent-loop/providers/factory.ts`、`providers/model-capability.ts`、`model-registry.ts`、`space-credentials.ts` 各自再认一遍字面量;`shared/defaults/settings.ts` 把四个 agent 的命令写死在 TS 里并附带按 id 的迁移函数。

### 1.7 壳

设置页没有 agent 名册(模型页的「本地」组只有一句「探测与启动设置下一批」);模型选择器把 agent 当模型列(无徽标、无状态);权限卡是内置的五个钮;工具卡按 `kind` 撞名内置 presenter,撞不上的走 JSON 抽屉;没有 plan / 模式 / 斜杠命令 / 用量 / 通知的任何渲染。`gate:*` 没有一条碰 ACP。

### 1.8 本机实测(2026-09-25)

| CLI | 版本 / 位置 | 说 ACP 的方式 |
| --- | --- | --- |
| claude | 2.1.281,`~/.local/bin/claude` | 本体不说;官方适配器 `@agentclientprotocol/claude-agent-acp`(npm 0.81.2,本机装了 0.81.1,`claude-agent-acp` 在 nvm 全局 bin) |
| gemini | homebrew | 本机版本帮助里是 `gemini --experimental-acp`;注册表 0.61.0 用 `gemini --acp`(§9) |
| codex | homebrew | 本体不说;官方适配器 `@agentclientprotocol/codex-acp`(npm 1.13.1,自带兼容的 `@openai/codex`,`CODEX_PATH` 可指本机二进制) |
| copilot | homebrew | `copilot --acp` |
| opencode | homebrew | 帮助里没有 acp 旗(待研究代理确认) |
| pi | homebrew | 本体只有 `--mode rpc`;社区适配器 `pi-acp`(npm 0.0.34,本机已装) |
| kimi | 未装 | `kimi acp`(defaults 里已经写着) |

## 2. 目标与不做

**目标**(每条后面写它在哪一期兑现):

1. 任何 ACP agent 零代码接入:名册 = 内置种子(数据文件)+ 官方注册表(联网拉,缓存)+ 用户手加;加一家 = 加一行数据(A1)。
2. 协议 1.x 全覆盖:十六种会话更新每一种有一等落点,工具卡带 diff / 终端 / 位置(A2)。
3. agent 向我们要的三样东西走 onething 自己的东西:审批走许可系统且四选项上屏、文件走沙箱、终端走 `TerminalService` 并能在壳里看到(A3)。
4. 宿主工具面注入所有 agent:一条 stdio 桥 + 有 http 能力的 agent 走 HTTP,按会话签发凭据做归因(A4)。
5. 会话有生命:进程崩了有状态、有重启;续接(load / resume)、认领 agent 自己的历史会话(`session/list`)、分叉、标题、用量入账(A5)。
6. Claude Code 迁到 ACP,SDK 连接器退役,打包排除 `@anthropic-ai/claude-agent-sdk`(A6)。
7. 每一期有代理可自证的门:`gate:acp`(后端,假 agent 进程)+ `gate:acp-shell`(壳,真机)。

**不做**(写下来免得再议):NES(编辑器内联补全,`nes/*`)与 `document/*` 文档同步——onething 不是代码编辑器;`mcp/connect` 系列(agent 让客户端代它连 MCP)——今天没有一家 agent 需要;Windows 专项(与终端 / 浏览器同口径,mac 先验收);agent 互调 `run_agent` 与 `agent:` 资源只留口不施工(A7)。

## 3. 架构:骨架不改,能力自述

### 3.1 分层与落位

```
┌─ 壳 apps/desktop-react ────────────────────────────────────────────┐
│ 设置「Agent」页(名册 / 探测 / 登录 / 装上)  模型选择器(agent 带徽标) │
│ 工具卡(diff / 终端 / 位置)  会话状态面(模式·命令·选项·计划·用量·通知)  │
│ 权限卡(agent 自己的四选项)  交互卡(elicitation)  终端瓦(agent 开的终端)│
└──────────────────────────┬─────────────────────────────────────────┘
                           │ POST /api/rpc(acp 域)+ GET /api/events(acp:* 全局事件)
┌─ 装配 packages/backend ──┴─────────────────────────────────────────┐
│ wiring/acp/  subsystem(AcpSubsystem)· permission-bridge · fs-bridge │
│              · terminal-bridge · elicitation-bridge · auth-bridge   │
│              · host-mcp-bridge(stdio/http)· registry(名册合并+探测)   │
│              · plan-projection(→ todo-plan)· usage-projection(→ 账本)  │
│ rpc/domains/acp.ts(名册 / 会话状态 / 认领 / 模式 / 选项 / 取消)        │
└──────────────────────────┬─────────────────────────────────────────┘
┌─ 产品 packages/onething-runtime/src ┴──────────────────────────────┐
│ acp/  client(进程 + 连接 + 会话表)· translate(16 种更新 → 事件)      │
│       · manifest(名册数据形状)· session-links · types              │
│ external-agents/  ExternalAgentConnector 契约 + AcpConnector(唯一实现)│
│                   · provider(createExternalAgentProvider)· host-mcp │
└──────────────────────────┬─────────────────────────────────────────┘
┌─ 内核 packages/core ─────┴──────────────────────────────────────────┐
│ agent-loop(externallyExecuted 直通,已有)· permission · interaction │
│ · engine/external-agent-providers(登记表,零字面量)                    │
└────────────────────────────────────────────────────────────────────┘
```

每一层只加自己那一格的东西,core 不改字面量、不加新事件类型(下面 §3.3 说为什么会话级状态不进回合事件流)。

### 3.2 名册是数据(A1 的核心)

**一个 agent 的自述**(`runtime/src/acp/manifest.ts`,纯类型 + 校验;数据文件在 `resources/acp-agents/<id>.json`):

```ts
export interface AcpAgentManifest {
  id: string                       // 'claude-code' | 'codex' | 'gemini' | …,仅 [a-z0-9-]
  name: string                     // 给人看
  description?: string
  vendor?: string                  // 'Anthropic' / 'OpenAI' / …,只用于分组显示
  icon?: string                    // 壳侧图标 key;没有就用首字母
  homepage?: string
  /** 怎么起进程。三种来源按序试:PATH 上的可执行 → npm 包 → 用户覆盖。 */
  launch: {
    command: string                // 'claude-agent-acp' / 'gemini' / 'kimi'
    args?: string[]                // ['--experimental-acp'] / ['acp']
    env?: Record<string, string>
  }
  /** 装了没有?怎么装?探测器只读这一格,不猜。 */
  detect?: {
    bins?: string[]                // which 这些名字里任一个
    versionArgs?: string[]         // ['--version'],拿一行版本号
    minVersion?: string
  }
  install?: {
    npm?: string                   // '@agentclientprotocol/claude-agent-acp' → 装法 `npm i -g <pkg>`
    hint?: string                  // 一句人话(装 CLI 本体去哪)
  }
  /** 登录提示。真正的登录动作按协议走(§3.5 auth),这里只是「还没登怎么办」的一句话。 */
  auth?: { hint?: string; loginCommand?: string[] }   // ['claude', '/login'] → 在 onething 终端里跑
  /** 它自己的配置文件在哪(§3.9 ⑥)。只用来画「打开配置目录」,onething 不读不写。 */
  configPaths?: string[]           // ['~/.claude', '~/.claude/settings.json']
  /** 我们知道它有的怪癖,不是能力声明(能力由 initialize 握手时 agent 自报)。 */
  quirks?: {
    promptTimeoutMs?: number
    systemPromptMeta?: 'claude-agent-acp'   // 已验:它认 session/new 的 _meta.systemPrompt(§3.4)
  }
}
```

**三个来源,一次合并**(`backend/wiring/acp/registry.ts`):

1. 内置种子 `resources/acp-agents/*.json`(打包进 asar,与 `resources/skills` 同一条搬运规则);
2. 官方注册表(ACP 组织维护的 agent 清单 JSON,Zed 就是从这里分发 external agents;URL 与字段以研究代理核实为准,§9 附表),用 **托管 fetch**(与 provider 请求、模型下载同一实现,走 `network.proxy`)拉取,落 `<store>/acp/registry-cache.json`,TTL 24h,离线用缓存,没缓存用种子;
3. 用户手加 / 覆盖:`settings.acp.agents[]`(形状不变,仍是 `ACPAgentConfig`,只是**不再内置四条**——内置条目从 defaults 里删掉,由种子文件提供)。

合并规则:同 id 用户 > 种子 > 注册表;`enabled` 缺省 = 探测到已安装。`DEFAULT_ACP_SETTINGS.agents` 变成空数组,`migrateLegacyDefaultACPAgent` 与那四条 TS 字面量删除(老盘上的四条会因为「与种子同 id 且字段全等」被识别为种子拷贝而不再落盘)。

**探测**(`backend/wiring/acp/detect.ts`):对每个 manifest 在**登录 shell 的 PATH**(`hydrateProcessEnvFromLoginShell` 已把它灌进 `process.env`)上 `which` `detect.bins`,拿到路径再跑 `versionArgs` 取版本;结果 `{ installed, path?, version?, checkedAt }` 进 `ACPAgentState`。探测是 RPC `acp.detect` 主动触发 + 设置页打开时触发,不做后台轮询。

**陌生能力演练**:接 Gemini CLI = 新建 `resources/acp-agents/gemini.json` 一个文件,内容是 `{ id, name, launch: { command: 'gemini', args: ['--experimental-acp'] }, detect: { bins: ['gemini'] }, install: { hint: 'brew install gemini-cli' } }`;core / runtime / backend / 壳零改动。用户不想等我们发版:设置页「添加 agent」填同样三格。

### 3.3 会话级状态与回合事件分家

ACP 的十六种更新里,只有文本 / 思考 / 工具三类是「这一轮说了什么」,其余(模式、可用命令、config options、计划、用量、标题、通知、压缩)是**会话的状态**,与哪条消息无关,而且 agent 可以在没有 prompt 在飞的时候推它们(`session/new` 一返回就推 `available_commands_update` 是常态)。今天 `ACPClient` 只在 prompt 期间收更新,其他时候的通知被扔掉——这是 §1.3 那些「丢」的结构性原因,不是漏写了几个 case。

所以分家:

- **回合事件流**(`AgentTurnStreamEvent`,core 词汇,不加新种):`agent_message_chunk` → `text-delta`;`agent_thought_chunk` → `reasoning-delta`;`tool_call` / `tool_call_update` → `tool-call-start` / `tool-metadata` / `tool-partial-result` / `tool-result`(`externallyExecuted: true`,已有);`compaction_summary_chunk` → 一条 `provider-data`(壳侧折成「上下文更新」折痕行,与本地 compact 同一个组件)。
- **会话状态**(新,`runtime/src/acp/session-state.ts`):

```ts
export interface AcpSessionState {
  localSessionId: string
  agentId: string
  acpSessionId?: string
  modes?: { current: string; available: Array<{ id: string; name: string; description?: string }> }
  configOptions: AcpSessionOption[]      // 已有形状(431b38dfd),补 boolean 型
  commands: Array<{ name: string; description: string; inputHint?: string }>
  plan?: { kind: 'items'; entries: Array<{ content: string; priority: 'high'|'medium'|'low'; status: 'pending'|'in_progress'|'completed' }> }
       | { kind: 'markdown'; markdown: string }
       | { kind: 'file'; path: string }
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  info?: { title?: string; updatedAt?: string }
  notices: Array<{ severity: 'info'|'warning'|'error'; title: string; description?: string; at: number }>   // 最近 20 条
  compaction?: { status: 'in_progress' | 'done'; startedAt: number }
  process: { status: 'disconnected'|'connecting'|'connected'|'error'; error?: string; pid?: number }
}
```

  由 `ACPClient` 在**任何时候**收到通知就折进这张表(一个 reducer,`applySessionUpdate(state, update)`,纯函数、有测试),折完广播一条全局事件 `acp:session-state`(载荷 = 整张表的快照,`GLOBAL_EVENT_LEAVES_PROCESS` 登记为可出进程,于是 SSE 自动带出去,壳零通道代码)。读法是 RPC `acp.sessionState(sessionId)`。

- **两处投影,不是两处 UI**:`plan` 投进 todo-plan 域的 `session-ai-todo` 作用域(`wiring/acp/plan-projection.ts` 调 `getTodoPlanStore()`;`items` 形逐条映射,`markdown` 形整段落,`file` 形读那个文件)——待办面板照旧显示,壳不新建计划面板;`usage_update` 投进 composer 已有的 `MeterCard`(它今天读本地估算的上下文用量,加一格来源「agent 自报」优先)。`PromptResponse.usage`(input / output / thought / cached)与 `usage_update.cost` 一起进 usage 账本(`source: 'acp'`,`billingMode` 未知则 `costUSD: null`、`reportedCost` 实报优先——账本已有这两格并存的约定)。

### 3.4 一条路:`ExternalAgentProvider` over `AcpConnector`

删 `agent-loop/providers/acp.ts`(340 行)与 `ACPAgentProvider`;`factory.ts` 对 `'acp'` 改成 `createExternalAgentProvider({ connector: acpConnector, … })`——与 Claude 路今天用的**同一个包装器**。于是 ACP 路白拿:cwd 未绑定的结构化拒发(壳里已有 `errorDetails` 卡)、图片能力按 `promptCapabilities.image` 判并在不支持时给提示、system prompt / persona 的装配位、会话链接回调。`AcpConnector` 从 66 行的测试替身变成生产实现,内容是 `ACPClient` + 翻译器;`ExternalAgentConnector` 契约里 `capabilities` 改成**握手后填**(`initialize` 返回什么就是什么,不再有 `ACP_CAPABILITIES` 常量表)。

`ExternalAgentSessionLink` 与 `ACPSessionLink` 合并成一份(`<store>/acp/session-links.json` 留,`external-agents/session-links.json` 在 A6 随 SDK 连接器退役时迁走)。`ACPAgentConfig` 的两份拷贝合一(runtime 那份是权威,shared 那份 `import type` 它——契约层允许 import type core / runtime 的纯类型文件,`core/interaction/types.ts` 就是先例)。

**persona 与 system prompt 怎么进**:ACP 协议正文没有 system prompt 这一格。执行器表里 `persona: 'prepend'` 今天没人读;这里给它实现,分两档:通用档 = 系统通道的片段(byte-identical 的静态前缀)折成会话第一条 prompt 的第一个 `text` 块(`<persona>…</persona>`),回合通道的片段走已有的 `<context-update>` 尾块——就是 `prompt-channels-2026-08.md` 那两条通道,只是「system 前缀」在这个执行器上落到「第一条 prompt 的头」;例外档 = manifest `quirks.systemPromptMeta: 'claude-agent-acp'` 的 agent,`session/new` 的 `_meta.systemPrompt = { append: <前缀> }`(实测 `claude-agent-acp` 0.81 `dist/acp-agent.js:6240-6252`:字符串会**整个替换** Claude Code 自己的操作指令,对象形只追加——与 `claude-code-integration-v2.md` §10.2 记的 SDK 判例同一条)。恢复会话(load / resume)时不重发 persona(agent 自己有历史)。

**插话(steer)怎么进**:协议正文没有插话;但 `claude-agent-acp` 与 `codex-acp` 都实现了同一条扩展通知 `_session/steering`(把一段文本塞进正在跑的这一轮),并在握手时用 `InitializeResponse._meta.steering.supported` 自报。执行器表的 `steer` 位从这一格读:真 → steering 链路把插话发成 `_session/steering` 通知;假 → 退回今天对 `steer: false` 执行器的做法(进宿主队列,等这一轮结束再发)。这是 `_meta` 扩展里唯一一条我们主动读的(另一条是被动收的 `_auth/status_update`),理由是两家官方适配器都用同一个名字,已经是事实标准。

### 3.5 agent 向我们要的三样东西 + 两种问法

| agent 发 | 我们的落点 | 判据 |
| --- | --- | --- |
| `session/request_permission` | `Permission.ask`,效果由 `describeExternalToolPermission(kind, name, rawInput, locations)` 算(Claude 路那套按命令 / 按路径的分析原样复用,输入从 SDK 工具入参换成 ACP 的 `rawInput` + `locations`);**agent 的选项表原样带到卡上**:`allow_once` ↔ `once`,`allow_always` ↔ `always`(我们这边同时记 grant,再答 agent 那个 `allow_always` 的 optionId),`reject_once` ↔ `reject`,`reject_always` ↔ `reject` + 我们这边记会话级拒绝;`session` / `workdir` 两钮是 onething 自己的记忆,答 agent `allow_once`,下次同效果直接放行不再上卡。agent 没给的选项不画。 | 无桥宿主(server / daemon)**拒绝**,不再按 `permissionMode: 'allow'` 自动放行;`permissionMode` 改名 `unattended: 'reject' \| 'allow'`,缺省 reject,`'allow'` 只能由用户在设置页显式打开(见 §8 拍点 2) |
| `fs/read_text_file` | `checkFileAccess` 读根(会话 cwd + 沙箱读根)之内直接读;之外走 `file_read` 效果问一次 | 读回 `line` / `limit` 切片,1MB 上限不变 |
| `fs/write_text_file` | 先算 diff(`createTwoFilesPatch`,Claude 路已有),走 `file_write` 效果(卡上带 diff),准了再写;写完发一条 `tool/audit` 到账本 | 写根之外一律问,`always` 按目录 scheme 记 |
| `terminal/create` | `TerminalService.create({ command, args, cwd, env: 登录 shell 环境 + 代理环境 + 请求 env, owner: { kind: 'acp', agentId, sessionId } })`;`terminal/output` 读它的回放环(`attach` 那套 seq + ring),`wait_for_exit` / `kill` / `release` 对应 `onExit` / `kill` / 摘表 | 命令走 bash 分类器算 `execute` 效果,问过再起;终端在壳的终端瓦里**能看能进**(工具卡上 `terminal` 内容块 → 一枚「打开终端」钮 → 现有 `terminal` 内容种类按 terminalId attach) |
| `authenticate` / `authMethods` | 握手拿到 `authMethods`;`type: 'terminal'` 的方法 = 我们开一个 onething 终端瓦跑它给的程序(退出码 0 = 成功),`agent` 型方法 = 调 `authenticate({ methodId })`;`-32000 auth_required` 错误 → 壳上一张「去登录」卡,按钮就是上面两条之一 | 客户端能力声明 `auth: { terminal: true }` |
| `elicitation/create`(form / url) | `Interaction.ask`(E1 的交互内核):form 的 JSON Schema(string / enum / boolean / number / multiselect)映射成 `InteractionQuestion[]`,url 型 = 打开外链 + 一张「完成了 / 取消」卡;答案按 `elicitation/complete` 回;deadline 用交互内核自己的表 | 客户端能力声明 `elicitation: { form: {}, url: {} }`。**claude-agent-acp 0.81 实测:客户端声明了 `elicitation.form`,AskUserQuestion 才走 elicitation;不声明就退化成一次普通审批**(`dist/acp-agent.js:5591-5599`)——这就是为什么这条不可选 |

`request_permission` 与 `elicitation` 的 `messageId` 锚点:`AcpConnector.streamTurn` 拿到的 `messageId` 经 `promptContexts` 透传给桥(今天 `CoreACPPromptStreamOptions` 没这一格,永远走兜底锚,卡贴在会话末尾——补上)。

### 3.6 宿主工具面:一条 stdio 桥,所有 agent 通吃

今天的宿主 MCP 服务器是 `createSdkMcpServer` 进程内对象,只有 Claude SDK 能吃。ACP 的 `NewSessionRequest.mcpServers` 只认 stdio / http / sse / acp 四形。做法:

- **stdio 桥**(通吃):一个新的构建入口 `acp-mcp-bridge.cjs`,与 `search-worker.cjs` 同一条规矩——三份构建配方各出一份、永远落在宿主入口旁边、asarUnpack。它是个薄进程:读 `ONETHING_MCP_URL` + `ONETHING_MCP_TOKEN`,在 stdio 上说 MCP,把每个 `tools/list` / `tools/call` 转成对活核 `POST /api/rpc` 的调用(新 RPC 域 `host-mcp`:`listTools` / `callTool`,只认桥凭据)。桌面上 command = `process.execPath`,env 加 `ELECTRON_RUN_AS_NODE=1`;server / CLI 上 command = `process.execPath`(就是 node)。
- **HTTP 直连**(能省一个子进程就省):`mcpCapabilities.http` 为真的 agent 直接给 `{ type: 'http', url: <face>/api/mcp, headers: [Bearer <桥凭据>] }`,`/api/mcp` 是 `@modelcontextprotocol/server`(根 package.json 已有 `^2.0.0`)的 Streamable HTTP 挂在内嵌面上。
- **凭据即归因**:每个 (agentId, localSessionId) 在 `session/new` 前签一枚桥凭据(`randomBytes(24).base64url`,内存表,会话 close / dispose 时作废);`host-mcp.callTool` 用它查到 `HostToolTurnContext`(`bindHostToolContext` 已有),于是 `send_message` 说话经的还是那张牌、那把租约、那个幂等窗——E3 那条链一个字不改。
- **工具集**:与 Claude 路同一张表(`filterHostToolSurface` 按场子过滤的协作四件),外加 `send_notification`;`run_agent` 留 A7。
- **用户自己的 MCP 名册**(`settings.mcp.servers`)透传:stdio 形逐条转成 `McpServerStdio { name, command, args, env: [{name,value}] }`,http / sse 形按 `mcpCapabilities` 门控,没能力的 agent 不给。

### 3.7 进程与会话生命

- 一个 agent 一个进程、多会话复用(维持);新增:订 `connection.closed`(SDK 1.x 有)而不只靠子进程 `exit`;崩了 → `process.status = 'error'` 进会话状态并广播;下一次 prompt 自动重连,**退避 3 次 / 30s 窗口**,超过就把错误留在 `errorDetails` 卡上;重连后按 resume → load → new 恢复(已有)。
- 空闲回收 10 分钟(维持);`dispose` 3s 上限(维持);终端归 `TerminalService`,所以 agent 进程死了终端不跟着死——这是有意的(用户可能正看着输出)。
- 认领:`session/list`(能力位 `sessionCapabilities.list`)→ RPC `acp.listRemoteSessions(agentId, cwd?)` → 设置页 / 会话侧栏「从 <agent> 导入」→ `acp.adoptSession` 建本地会话 + 链接 + `session/load`,**这一次的回放不丢**:`user_message_chunk` / `agent_message_chunk` / 工具更新按顺序折成 `message/imported` 事件进账本(`origin.source: 'acp-import'`),幂等靠链接表查重。这就是 `coding-agents-ledger-2026-08.md` §4 缺口 A 的 ACP 版,那篇要的「扫 `~/.claude/projects` 解析 JSONL」在这条路上不需要——agent 自己给列表。
- 分叉:`session/fork` 能力位在场时,会话菜单多一项「分叉」= 新本地会话 + fork 出来的远端 id。
- 标题:`session_info_update.title` 在用户没手改过标题时写进会话标题。

### 3.8 壳

设置页新增「Agent」页(不塞进模型页;它是名册,不是凭证):每行一个 agent——图标 / 名字 / 来源(内置·注册表·自定义)/ 探测结果(未安装 · x.y.z · 版本过低)/ 登录态(握手 `authMethods` 非空且上次 `auth_required` → 「未登录」+ 「去登录」钮)/ 启用开关 / 「装上」钮(在终端瓦里跑 `npm i -g <pkg>` 或显示 `install.hint`)/ 「无人值守时自动放行」开关(缺省关,一句人话警告)。「添加自定义 agent」= 名字 / 命令 / 参数三格,与 MCP 设置页同一个表单基础件。

模型选择器:agent 行带来源徽标与探测状态(未安装的置灰,悬停给装法);右卡 `AgentOptionsCard` 维持,**模式作为第一行 select 并进去**(`modes` 折成一个 `mode` 选项,`setSessionOption('mode')` 走 `session/set_mode`),boolean 型 config option 画成 `Switch`。

**composer 上本来就有的三个控件,按协议的 `category` 认领 agent 的选项,不按 agent 名字**(`SessionConfigOptionCategory = 'mode' | 'model' | 'model_config' | 'thought_level' | string`,协议正文里的四个值;claude-agent-acp 的 `model` / `effort` / `mode` / `fast` 四个选项分别标着 `model` / `thought_level` / `mode` / `model_config`,核过 `dist/session-{model,effort,mode}.js`):

| composer 控件 | 认领 category | 行为 |
| --- | --- | --- |
| 模型药丸(今天显示 agent id) | `model` | 药丸显示当前模型值,点开列 agent 自报的模型;选中 = `session/set_config_option`,会话内即时生效 |
| 思考档位(六档 `ThinkToggle`) | `thought_level` | 档位表换成 agent 自报的 choices(Claude 是 low / medium / high / max 按模型不同),同一只控件,只是表是活的 |
| 模式(新,与药丸并排的一粒) | `mode` | Claude 的 default / acceptEdits / plan / auto,Codex 的 approval |
| 其余(`model_config` 与未知 category) | — | 留在右卡 `AgentOptionsCard` |

用户不用进终端:切模型、切思考、切模式都是一次 RPC。会话没开(草稿态)时改的是这家 agent 的缺省(`profiles[agentId].preferred`),第一条消息发出时套上。

composer:斜杠命令抽屉的候选里并入 `commands`(带 `inputHint` 做占位),选中 = 原样把 `/name args` 发出去(ACP 里命令就是文本);MeterCard 多一格来源。

工具卡:`diff` 内容块 → 复用 `edit` 工具的 diff 视图(`toolCall.changes`,Claude 路已有的 `changesFromMetadata` 通道);`terminal` 内容块 → 「打开终端」钮;`locations` → 卡脚一行可点路径:行号(走消息引用的 `file:` scheme);`kind` 映射 presenter(read → read,edit / delete / move → edit 族,execute → bash,search → search,fetch → web,think / switch_mode / other → 默认),`name` 显示为工具名。

权限卡:选项集合由后端在 ask 那一刻算好带上(`PermissionAsk.choices`),卡只画后端给的钮——今天的五钮变成「后端说有几个画几个」,本地工具的 ask 给的还是原来那五个,零回归。

会话状态:一条会话级横条(与今天 `DrawerStatus` 同位)——模式 · 用量 · 最近一条 notice;`compaction` 进行中 = 折痕行「agent 正在整理上下文」。

### 3.9 每家 agent 的配置面:六种东西,六个主人

用户 09-25 问「各 agent cli 的配置怎么做」。先把「配置」拆开——它不是一张表,是六种东西,每种有自己的主人,onething 只管其中三种半:

| 配置的是什么 | 主人 | 落在哪 | 设置页上长什么样 |
| --- | --- | --- | --- |
| ① 怎么起它:命令 / 参数 / 环境变量 / 进程 cwd | manifest 给缺省,用户可覆盖 | 种子 / 注册表 → `settings.acp.agents[id]` 里**只存改过的字段**(稀疏覆盖,`effective = manifest ⊕ override`) | 「高级」折叠区:命令一格、参数一格、环境变量键值行。缺省不展开——绝大多数人一辈子不用碰 |
| ② 登录 / 凭据 | **CLI 自己**(`~/.claude`、`codex login`、`gemini` 的 OAuth、`kimi /login`)。onething 不存、不代管 | 不落我们的盘 | 状态行「已登录 / 未登录」+「去登录」钮:agent 自报 `authMethods` 里 terminal 型 → 在 onething 终端瓦里跑它给的程序;agent 型 → 调 `authenticate(methodId)`。`_auth/status_update` 推来就更新。**登录全程不离开 onething 窗口**,但流程本身是那家 CLI 的:例如 claude-agent-acp 自报三种方法(核过 `dist/acp-agent.js:1029-1074`)——`claude-ai-login` = 终端型,我们在终端瓦里起 `claude-agent-acp --cli auth login --claudeai`,它开系统浏览器走订阅 OAuth、回终端贴码、退出码 0 即成;`console-login` 同形走 API 控制台;`claude-login` = agent 型,调 `authenticate` 由它自己处理。我们不替任何一家做 OAuth(合规,也没必要)。例外:极少数要 API key 走环境变量的 agent(自定义条目),环境变量行可以标「密钥」,标了就进凭证池(safeStorage),spawn 时注入,settings.json 里不留明文 |
| ③ 会话行为:模式(permission mode)/ 模型 / effort / fast / sandbox / approval | **agent 自报**(`session/new` 返回的 `modes` + `configOptions`),onething 一个都不硬编码 | 用户的偏好 → `<store>/acp/session-links.json` 的 `profiles[agentId].preferred`(431b38dfd 已有);会话内的实时值 → `acp:session-state` | 「缺省选项」区 = 模型选择器右卡那只 `AgentOptionsCard` 同一个组件,画 agent 自报的选项;没连过 → 一句「首次连接后出现」+「现在连接」钮。会话内改 = 只改这一会话;设置页改 = 改缺省 |
| ④ 权限策略 | onething 的许可系统 | grants(已有)+ `settings.acp.agents[id].unattended` | 「无人值守时自动放行」开关(缺省关,一句人话警告)+ 「查看已授权」链接到权限页按 agent 过滤 |
| ⑤ 工具:宿主工具面开不开、onething 的 MCP 名册转不转给它 | onething | `settings.acp.agents[id].hostTools`(缺省 true)/ `.forwardMcpServers`(缺省 false——用户的 MCP 表可能很长,而 agent 多半自己配过) | 两个开关 |
| ⑥ agent 自己的配置文件:`~/.claude/settings.json`、`CLAUDE.md`、`~/.codex/config.toml`、`~/.gemini/settings.json`、`.cursor/rules` | **CLI 自己**。onething 不读不写不合并——那是用户与那家 CLI 之间的事 | 不落我们的盘 | 「打开它的配置目录」一条链接(`shell` 宿主端口 `revealInFolder`,路径来自 manifest `configPaths`) |

会话 cwd 不在这张表里:它是**每个会话**绑定的工作目录(composer 的目录钮),进 `session/new.cwd`;①里的进程 cwd 只是 spawn 时的目录,与会话无关,留在高级区。

**数据形状**(对 §6 的 `ACPAgentConfig` 的最终定稿):

```ts
interface ACPAgentConfig {
  id: string
  basedOn?: string                 // 自定义条目可以「复制自」一个种子 / 注册表 id,继承它的 manifest
  enabled?: boolean                // 缺省 = 探测到已安装
  name?: string                    // 覆盖显示名(复制出来的第二个 Claude 叫「Claude·工作」)
  command?: string; args?: string[]; cwd?: string
  env?: Record<string, string>     // 明文行
  secretEnv?: string[]             // 只存键名;值在凭证池 `acp:<id>:<KEY>`
  unattended?: 'reject' | 'allow'  // 缺省 reject
  hostTools?: boolean              // 缺省 true
  forwardMcpServers?: boolean      // 缺省 false
  promptTimeoutMs?: number; idleTimeoutMs?: number; connectTimeoutMs?: number
}
```

**设置「Agent」页的形状**(与 Provider 页同一套 rail + 详情):左栏一行一个 agent(图标 / 名 / 探测与登录两粒状态点),右栏从上到下:状态行(已安装 x.y.z · 已登录 · 空闲)→ 启用开关 → 缺省选项 → 权限(一个开关 + 一条链接)→ 工具(两个开关)→ 高级(折叠:命令 / 参数 / 环境变量 / 超时 / 打开配置目录)。底部「添加自定义 agent」= 名字 / 命令 / 参数三格,或「复制为自定义」从现有条目起。

**加一家不写代码**:种子 / 注册表来的 agent,用户在这页看到的是探测结果与它自报的选项;要改的只有开关。**加一家我们没见过的**:填三格。两条路都不动骨架。

## 4. 分期总览

| 期 | 名 | 交付 | 依赖 |
| --- | --- | --- | --- |
| A0 | 协议升级 + 单路合流 | SDK ^1.5.0;删 `ACPAgentProvider`,ACP 走 `ExternalAgentProvider` over `AcpConnector`;链接表与配置类型各合一;core 字面量改登记;会话状态 reducer + `acp:session-state` 事件(只做骨架与文本 / 思考 / 工具三类) | 无 |
| A1 | 名册数据化 | manifest + 种子文件 + 注册表拉取 + 探测 + 设置「Agent」页 + 模型选择器徽标 | A0 |
| A2 | 更新全覆盖 + 工具保真 | 十六种更新全部有落点;diff / terminal / locations;plan → todo-plan;usage → meter + 账本;命令 → 抽屉;模式 → 选项卡;notice / info / compaction 上屏 | A0 |
| A3 | 三样东西 + 两种问法 | 权限四选项 + 效果分析;fs 走沙箱与许可;terminal 走 `TerminalService` 且壳能看;auth terminal;elicitation → 交互卡;无桥宿主 fail-closed | A0 |
| A4 | 宿主工具面 | stdio 桥 + `/api/mcp` + 桥凭据归因 + `host-mcp` RPC 域 + 用户 MCP 名册透传 | A0 |
| A5 | 会话生命 | `closed` 监听 + 重启退避 + 状态广播;认领(list + load 回放导入);fork;标题 | A0、A2 |
| A6 | Claude Code 迁 ACP | 对等清单逐条绿 → `claude-code-agent` provider 退役、SDK 依赖与 2103 行连接器删除、打包排除 | A2–A5 |
| A7 | 留口 | `run_agent` / `agent:` 资源 / Windows | A4 |

A1–A4 相互独立,可并行派工;A5 要 A2 的导入落点;A6 是收口。每期一个门步,门在 §7。

## 5. 分期细则

### A0 协议升级 + 单路合流

改动面:

- `package.json`:`@agentclientprotocol/sdk` `^0.17.1 → ^1.5.0`。1.5.0 的 `ClientSideConnection` 方法表(核过 d.ts):`initialize` / `newSession` / `loadSession` / `resumeSession`(转正)/ `listSessions` / `deleteSession` / `closeSession` / `setSessionMode` / `setSessionConfigOption` / `authenticate` / `logout` / `prompt` / `cancel` / `extMethod` / `extNotification` 是稳定面;`unstable_forkSession` 与 `unstable_*Provider` / `unstable_*Nes` / `unstable_did*Document` 仍带前缀;`unstable_setSessionModel` **已删**(模型选择统一走 config options)。客户端接口 `Client` 多了可选的 `createElicitation` / `completeElicitation` / `extMethod`。编译面问题,不是行为问题。**连接对象换成 1.x 的应用 API**:`ClientSideConnection` 构造器自 0.27 起标 `@deprecated`(还能用),`acp.client({ name: 'onething' }).onRequest(...).onNotification(...).connect(stream)` 返回 `ClientConnection { agent, signal, closed, close(err?) }`——`closed` 正是 §3.7 要订的那个信号,所以直接换,不留旧构造器。取消语义按 spec:`session/cancel` 后 prompt 以 `stopReason: 'cancelled'` 收场,飞着的请求答 `-32800`,我们这边同样用 `-32800` 答 agent 被我们取消的 `request_permission`(`RequestPermissionOutcome.cancelled`)。
- `runtime/src/acp/client.ts`:拆三块——`process.ts`(spawn / stderr 尾 / `closed` / 退避)、`session.ts`(会话表 + resume → load → new + options)、`translate.ts`(十六种更新 → 回合事件 或 会话状态);`sessionUpdate` 回调**永远**先折会话状态,再按「有没有在飞的 prompt」决定要不要推回合队列。
- `runtime/src/acp/session-state.ts`:`AcpSessionState` + `applySessionUpdate`(纯 reducer)。
- `runtime/src/external-agents/acp-connector.ts`:变生产实现;`capabilities` 在 `ensureSession` 后由握手结果填。
- `runtime/src/agent-loop/providers/factory.ts`:`'acp'` → `createExternalAgentProvider`;删 `agent-loop/providers/acp.ts`。
- `core/engine/external-agent-providers.ts`:`PROVIDER_EXECUTION_FACTS` 清空,`registerCoreProviderExecution` 由 `agents/executor/registry.ts` 的 `syncAgentExecutorsToCore()` 真正喂(它今天就存在且模块加载时执行,只是 core 那边硬编码盖住了它);执行器表 `capabilities.ts` 的 `acp` 条目改成「握手后填」的动态描述(`hostTools` / `steer` / `interrupt` 三位从连接器能力读)。
- `shared/ipc/acp.ts`:`ACPAgentConfig` 改 `import type` runtime 那份;新增 `acpSessionStateRouter` 读法;`shared/events` 登记 `acp:session-state` 可出进程。
- 链接表合一:`external-agents/types.ts` 的 `ExternalAgentSessionLink` 保留为契约,存储实现改指 `FileACPSessionLinkStore`。

判据:现有 ACP 与外部 agent 测试全绿(含 `fixtures/fake-agent.mjs` 升到 `AgentSideConnection` 1.x);`gate:acp` ①–④(§7)绿;反证:把 `syncAgentExecutorsToCore` 挖掉 → 压缩门对 acp 会话开始压缩 → 至少 1 红。

### A1 名册数据化

改动面:`runtime/src/acp/manifest.ts`(类型 + `parseAcpAgentManifest` 校验);`resources/acp-agents/{claude-code,codex,gemini,copilot,pi,kimi,…}.json`(清单以 §9 生态表为准);`backend/wiring/acp/registry.ts`(三源合并、`<store>/acp/registry-cache.json`、托管 fetch);`backend/wiring/acp/detect.ts`;`AcpSubsystem` 加 `registry` 字段与 `refreshRegistry()`;RPC `acp.getAgents` 返回值加 `source` / `detect`;`shared/defaults/settings.ts` 删四条字面量与迁移函数;`electron-builder.yml` 把 `resources/acp-agents` 列进 `extraResources`(与 skills 同一行);壳 `content/settings/AgentsSettings.tsx` + `pages.tsx` 一行 + `providers/families.ts` 的 `LOCAL_MODE_KINDS` 删 `'claude-code-agent'`(A6 前先留)。

判据:`gate:acp` ⑤(种子目录里放一个临时 manifest,`acp.getAgents` 里出现它,`detect` 对不存在的 bin 答 `installed: false`);壳门 `gate:acp-shell` ①(设置页列出种子 agent 与探测结果)。陌生能力演练写在 §3.2。

### A2 更新全覆盖 + 工具保真

改动面:`translate.ts` 十六个 case 各一条(表在 §3.3);`wiring/acp/plan-projection.ts`;`wiring/acp/usage-projection.ts`(账本 `recordUsage({ source: 'acp', providerId: 'acp', model: agentId, … })`);壳 `content/tools/presenters/` 加 kind → presenter 映射表(一张表,不是 if 链)、`ToolCard` 认 `changes` 与 `terminalId`、卡脚 `locations`;composer 命令抽屉并入 `commands`;`DrawerModelPicker` 的 `AgentOptionsCard` 加 mode 行与 boolean 行;`MeterCard` 加来源;`ChatStream` 折痕行认 compaction;`DrawerStatus` 加 notice。

判据:`gate:acp` ⑥–⑩;反证:把 reducer 里 `plan_update` 的 case 挖掉 → 门 ⑧ 红。

### A3 三样东西 + 两种问法

改动面:`wiring/acp/permission-bridge.ts` 重写(效果分析 + 选项映射 + `choices` 上卡 + `messageId` 透传);`core/permission` 的 `Info` 加可选 `choices: Array<{ id, kind, label }>`(不加就是今天五钮);`wiring/acp/fs-bridge.ts`;`wiring/acp/terminal-bridge.ts`(`TerminalCreateRequest` 加 `owner` 一格,壳终端列表里能按 owner 分组);`wiring/acp/auth-bridge.ts`;`wiring/acp/elicitation-bridge.ts`(JSON Schema 子集 → `InteractionQuestion[]`;不认识的 schema 类型 → 一题自由文本);`ACPClient` 的 `clientCapabilities` 固定为 `{ fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true }, elicitation: { form: {}, url: {} }, session: { configOptions: {}, notices: {} , compaction: {} }, plan: {} }`——**能力是我们有什么,不是每个 agent 一个开关**;删 `allowFileSystemAccess` / `allowTerminalAccess` 两格(它们本来就是「不进沙箱所以先关着」的替身);`permissionMode` → `unattended`,缺省 `'reject'`。壳:`PermissionCard` 按 `choices` 画钮;交互卡零改(E2 已有);终端瓦按 owner 显示「<agent> 开的」。

判据:`gate:acp` ⑪–⑯;反证:把无桥兜底改回 allow → ⑯ 红;把 fs 沙箱检查挖掉 → ⑬ 红。

### A4 宿主工具面

改动面:新构建入口 `runtime/src/acp/mcp-bridge/entry.ts` → 三份配方(`apps/desktop-react/scripts/build-electron.mjs` 第四个 esbuild 调用、`scripts/build-cli.mjs`、`scripts/build-server.mjs`)各出 `acp-mcp-bridge.cjs`;`electron-builder.yml` asarUnpack 加一行;`backend/rpc/domains/host-mcp.ts`(`listTools` / `callTool`,只认桥凭据);`backend/server/http.ts` 加 `/api/mcp`(`@modelcontextprotocol/server` Streamable HTTP,同一把桥凭据);`wiring/acp/host-mcp-bridge.ts`(签发 / 作废凭据、组 `mcpServers` 数组、按 `mcpCapabilities` 选形);`wiring/external-agents/host-tools.ts` 的 `resolveClaudeCodeHostToolSurface` 改名 `resolveHostToolSurface`(它本来就不认 Claude,只是名字);用户 MCP 名册透传在同一处组数组。

判据:`gate:acp` ⑰–⑱(假 agent 收到 `mcpServers` 里有一条 stdio,起桥,`tools/list` 看到 `send_notification`,`tools/call` 落到发起会话;凭据作废后再调 → 拒);反证:凭据换成常量 → ⑱ 红。

### A5 会话生命

改动面:`process.ts` 的 `closed` 监听 + 退避;`acp:session-state` 里 `process` 一格;RPC `acp.listRemoteSessions` / `acp.adoptSession` / `acp.forkSession`;`session.ts` 的 `load` 回放在认领模式下进 `message/imported`(走 `sessionCommands`,不直接写账本);标题写入走 `patchSession`;壳:会话侧栏「从 agent 导入…」入口(与「打开目录…」同一个 hub)、会话菜单「分叉」。

判据:`gate:acp` ⑲–㉑;反证:退避挖掉 → ⑲ 里「kill 后第 4 次 prompt 仍在重连」红。

### A6 Claude Code 迁 ACP

对等清单(每条一个门步,全绿才删):

| Claude SDK 路今天有的 | ACP 路上的对应 | 来源 |
| --- | --- | --- |
| 流式文本 / 思考 / 工具三段 | A0 | `translate.ts` |
| 逐命令 / 逐路径权限效果 | A3 | `rawInput` + `locations` 喂同一个分析器 |
| AskUserQuestion → 交互卡 | A3 | elicitation form(客户端必须声明) |
| 宿主协作工具(send_message 等) | A4 | stdio 桥 |
| 图片输入 | A2 | `promptCapabilities.image` |
| resume | 已有 | `loadSession`(claude-agent-acp 声明) |
| 插话(steer) | A0 | `_session/steering` 扩展通知,握手 `_meta.steering.supported` 自报(claude-agent-acp 与 codex-acp 同名;§3.4);不自报的 agent 退化成排队到下一轮 |
| persona | A0 | `_meta.systemPrompt = { append }`(实测 0.81 支持;§3.4) |
| 六档 effort / 模型选择 | A2 | claude-agent-acp 把它们暴露成 config options(`session-model.js` / `session-effort.js`) |
| resume / fork / list / 图片 / 嵌入上下文 / http+sse MCP | 已有或 A2 | 0.81 握手自报:`loadSession: true`,`sessionCapabilities.{fork,list,resume}`,`promptCapabilities.{image,embeddedContext}`,`mcpCapabilities.{http,sse}`(`dist/acp-agent.js:1090-1123`) |
| 用量与花费 | A2 | `usage_update` + `PromptResponse.usage` |
| 子代理嵌套过滤 | claude-agent-acp 自己折(`acp-subagents.js`);我们只看到顶层 | — |

删除:`external-agents/claude-code-connector.ts`(2103 行)、`wiring/external-agents/{index,background-status}.ts` 里 Claude 专用的探测与标题、`host-mcp/server.ts` 的 `createSdkMcpServer` 路(桥取代)、`AIProvider.ClaudeCodeAgent` 与 defaults、`LOCAL_MODE_KINDS['claude-code-agent']`、`@anthropic-ai/claude-agent-sdk` 依赖与 `electron-builder.yml` 里对它平台二进制的排除行、`*.real-cli.test.ts` 改成对 `claude-agent-acp` 的 opt-in 真机门。存量会话:provider `claude-code-agent` 的会话在打开时改写成 `acp` + model `claude-code`,链接表按 `externalSessionId` 迁(claude-agent-acp 的会话 id 就是 `~/.claude/projects` 的原生 id,与 SDK 路同一个)。

### A7 留口(不施工)

`run_agent` 与 `agent:` 资源(让 app 自己的 AI 或另一个 agent 委派一个 ACP agent,走原子那套 读 / 做 / 看 + 效果声明);Windows(stdio 编码 / 路径 / `process.execPath` 的 `ELECTRON_RUN_AS_NODE`);`mcp/connect` 系列。

## 6. 数据形状汇总(新增或改动的)

```ts
// settings.acp(改)
interface ACPSettings {
  enabled: boolean
  agents: ACPAgentConfig[]            // 只放用户手加 / 覆盖;内置来自种子文件
  registry?: { enabled: boolean; url?: string; refreshedAt?: number }   // 缺省 enabled: true
}
interface ACPAgentConfig { … }        // 定稿在 §3.9:稀疏覆盖,只存用户改过的字段;
                                      // basedOn / secretEnv / unattended / hostTools / forwardMcpServers 是新格
// 删:model / permissionMode / allowFileSystemAccess / allowTerminalAccess / mcpServers(转发改成一个开关)
//     / maxBufferedUpdates / maxSessionRecords / maxTerminals / maxTerminalOutputBytes(后四个变常量)

// acp.getAgents 返回(改)
interface ACPAgentState {
  config: ACPAgentConfig
  manifest: AcpAgentManifest
  source: 'builtin' | 'registry' | 'user'
  detect?: { installed: boolean; path?: string; version?: string; belowMin?: boolean; checkedAt: number }
  auth?: { methods: AuthMethod[]; required: boolean; label?: string }
  process: { status: 'disconnected' | 'connecting' | 'connected' | 'error'; error?: string; pid?: number; agentInfo?: { name?: string; version?: string } }
  capabilities?: AgentCapabilities    // 握手原样
  sessionCount: number; activePromptCount: number
}

// 全局事件(新):'acp:session-state' → AcpSessionState(§3.3);'acp:agent-state' → ACPAgentState
// RPC acp 域(改 / 新):getAgents · detect · addAgent · updateAgent · removeAgent · connectAgent · disconnectAgent
//   · refreshRegistry · sessionState · setSessionMode · setSessionOption · cancelSession
//   · listRemoteSessions · adoptSession · forkSession · authenticate
// RPC host-mcp 域(新):listTools · callTool(只认桥凭据)
// Permission.Info(改):choices?: Array<{ id: string; kind: 'once'|'always'|'reject'|'reject-always'; label: string }>
// TerminalCreateRequest(改):owner?: { kind: 'user' | 'acp'; agentId?: string; sessionId?: string }
```

## 7. 门(代理可自证)

**`bun run gate:acp`**(根,node,`scripts/gate-acp.mjs`):起 `dist/server` 于临时 store,假 agent = `runtime/src/acp/__tests__/fixtures/fake-agent.mjs` 升级版(SDK 1.5 `AgentSideConnection`,按环境变量剧本行事),全程走 `POST /api/rpc` + `GET /api/events`,不 spawn 真 CLI:

| 步 | 证明 | 期 |
| --- | --- | --- |
| ① | 握手:`acp.getAgents` 里假 agent `process.status = 'connected'`,`capabilities` 与假 agent 自报逐字相同 | A0 |
| ② | 会话:发一条消息 → 假 agent 收到 `session/new` 且 `cwd` = 会话绑定目录;未绑定目录 → 结构化拒发,`errorDetails` 到账本 | A0 |
| ③ | 流:文本 + 思考分别成 `text-delta` / `reasoning-delta`;`tool_call` → 工具卡到终态;假 agent 中途发一条协议外请求 `cursor/whatever` → 收到 `-32601`,连接不断、流照常收场 | A0 |
| ④ | 状态:`session/new` 返回后立即推的 `available_commands_update` 出现在 `acp.sessionState`(不在 prompt 期间也收得到) | A0 |
| ⑤ | 名册:临时种子 manifest 上榜;`detect` 对不存在的 bin 答未安装 | A1 |
| ⑥ | diff:`tool_call_update` 带 `diff` → 工具卡 `changes` 有 old / new hunk | A2 |
| ⑦ | terminal 内容块 → 卡带 `terminalId` | A2 |
| ⑧ | plan items → todo-plan `session-ai-todo` 三条,状态跟着 `plan_update` 变 | A2 |
| ⑨ | usage_update → `acp.sessionState.usage`;prompt 结束 → 账本一条 `source: 'acp'` | A2 |
| ⑩ | mode:`setSessionMode` → 假 agent 收到 `session/set_mode`;`current_mode_update` 回流进状态 | A2 |
| ⑪ | 权限四选项:`request_permission` 带四选项 → `permission:request` 事件的 `choices` 四条;答 `once` → 假 agent 收到 `allow_once` 的 optionId | A3 |
| ⑫ | 始终允许:答 `always` → grant 落盘;同效果第二次 ask 不上卡直接放行 | A3 |
| ⑬ | fs:`fs/read_text_file` 读 cwd 内文件成功;读 `~/.ssh/id_rsa` → 上卡,超时拒 | A3 |
| ⑭ | terminal:`terminal/create` → `terminal.list` 里出现 owner 为 acp 的一条;`terminal/output` 与 `terminal:data` 全局事件字节一致;`kill` 后 `exit` 事件 | A3 |
| ⑮ | elicitation form → `interaction:request` 事件一题两选;答完假 agent 收到 `elicitation/complete` 的 accept | A3 |
| ⑯ | 无桥:server 不注册桥 → `request_permission` 被拒(`reject_once`),**不是**自动放行;`unattended: 'allow'` 显式打开才放 | A3 |
| ⑰ | 桥:假 agent 收到的 `mcpServers` 有一条 stdio;起它,`tools/list` 有 `send_notification` | A4 |
| ⑱ | 归因:`tools/call send_notification` → 通知落在发起会话;会话关闭后凭据作废,再调 → 401 | A4 |
| ⑲ | 崩溃:`kill -9` 假 agent → `acp:agent-state` 推 `error`;下一条消息自动重连并 `session/load`;连崩 3 次后第 4 次不再重连 | A5 |
| ⑳ | 认领:`acp.listRemoteSessions` 列出假 agent 的两条;`adoptSession` 后本地会话有 `message/imported` 四条,再认领一次返回同一个会话 id | A5 |
| ㉑ | 标题:`session_info_update.title` → 会话标题;用户改过标题后不再覆盖 | A5 |
| ㉒ | (opt-in `ONETHING_GATE_REAL_ACP=1`)真 `claude-agent-acp`:发「只回复单词 pong」→ 文本含 pong;发一条要改文件的 → 权限卡 → 答 once → diff 卡 | A6 |

**`npm run gate:acp-shell`**(`apps/desktop-react/scripts/gate-acp-shell.mjs`,真机 CDP,与 `gate:terminal` 同口径:不连 5175、临时 user-data-dir、窗口不到前台):① 设置「Agent」页列出种子 agent 与探测结果;② 模型选择器 agent 行带徽标、未安装置灰;③ 权限卡按 `choices` 画四钮;④ 工具卡 diff 视图与「打开终端」钮 → 终端瓦 attach 到 agent 的终端;⑤ 待办面板显示 agent 的 plan;⑥ 命令抽屉出现 agent 命令,选中后发出的正文是 `/name`;⑦ 会话横条显示模式与用量。两条门都进各自的 `verify`。

## 8. 拍点(只列用户可感知的行为变化;设计细节已定,不上会)

> **2026-09-25 用户:「按照推荐的来即可。」** 三条全按推荐拍定:① Claude 走 ACP、对等门绿后退役 SDK 连接器;② 无桥宿主缺省拒绝,`unattended` 显式打开才放;③ 官方注册表联网拉、24h 缓存。

1. **Claude Code 走 ACP、SDK 连接器退役**(A6)。推荐:是。理由:两条路 6253 行只有一条能给所有 agent 用;claude-agent-acp 是 ACP 组织维护的官方适配器,把 SDK 路今天独有的东西(AskUserQuestion、宿主 MCP、effort / 模型、resume、用量、子代理、插话)全按协议或它自己的 `_session/steering` 扩展暴露出来了;对等清单(A6 表)逐条有落点,没有已知损失。做法是先并行,对等清单门绿了再删——不是一刀切。
2. **无桥宿主(server / daemon)对 agent 的审批缺省拒绝**(A3)。推荐:是。今天四个内置 agent `permissionMode: 'allow'`,在 daemon 与 server 上等于 agent 要什么给什么;改成缺省拒、用户在设置页对某个 agent 显式打开「无人值守时自动放行」。这是可感知变化:在 `server:start` 下跑 ACP 的人会发现工具开始被拒,直到打开那格。
3. **官方注册表联网拉取**(A1)。推荐:拉(走托管 fetch,24h 缓存,离线用种子)。不拉的代价是每接一家都要我们发版;拉的代价是设置页第一次打开多一次网络请求(可在设置里关)。

## 9. 生态附表(2026-09-25 核实;全文在 `acp-integration-reference-2026-09.md`)

**官方注册表**:索引 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`(形状 `{ version, agents: AgentEntry[], extensions: [] }`,实测 41 家,每小时 cron 对 npm / PyPI / GitHub Releases 校版本);条目 `AgentEntry = { id, name, version, description, distribution, repository?, website?, authors?, license?, icon? }`,`distribution` 三形:`npx: { package: '@scope/pkg@x.y.z', args?, env? }`、`uvx: { package, args?, env? }`、`binary: { '<darwin-aarch64|darwin-x86_64|linux-*|windows-*>': { archive, sha256?, cmd, args?, env? } }`;图标 `https://cdn.agentclientprotocol.com/registry/v1/latest/<id>.svg`;上榜条件是支持 agent 型或 terminal 型登录(纯环境变量 API key 的不收)。同仓每日跑一份能力探针 `.protocol-matrix/latest.json`(35 家:`session/list` 22 家、`resume` 12、`fork` 9)。

注册表条目 → 我们的 manifest 的折法(`registry.ts`):`npx` 形 → `launch = { command: 'npx', args: ['-y', package, ...args] }` + `install = { npm: package 去版本号 }`;`binary` 形 → A1 **不自动下载二进制**(签名 / 校验 / 更新是另一件事),只给 `install.hint = repository`,用户装到 PATH 上后 `detect.bins` 认得出来;`uvx` 形同 binary 处理。种子文件里 `launch.command` 优先写 PATH 上的可执行名(`claude-agent-acp` / `gemini` / `codex-acp` / `copilot` / `kimi` / `opencode` / `pi-acp`),`npx` 只作没装时的兜底——`npx` 每次冷起要解析包,慢且要网。

| id(注册表) | 起法 | 登录 | load / list / fork / resume | 备注 |
| --- | --- | --- | --- | --- |
| `claude-acp` | `claude-agent-acp`(npm `@agentclientprotocol/claude-agent-acp` 0.81.2) | terminal(`--cli auth login --claudeai` / `--console`) | ✓ ✓ ✓ ✓(+delete / close / additionalDirectories) | 模式 = Claude 权限模式(default / acceptEdits / plan / auto / bypassPermissions);config options `mode` / `model` / `effort` / `fast`;TodoWrite → `plan`;AskUserQuestion → form elicitation;扩展 `_session/steering`(`InitializeResponse._meta.steering.supported`)/ `_session/goal` / `_auth/status_update` / `_claude/sdkMessage`;`_meta.systemPrompt`;**Claude Code 本体没有 `--acp`**,Anthropic 不发官方适配器 |
| `codex-acp` | `codex-acp`(npm `@agentclientprotocol/codex-acp` 1.13.1,自带 `@openai/codex`,`CODEX_PATH` 可换) | agent(ChatGPT / API key) | ✓ ✓ ✓ ✓ | 模型 / effort / fast / approval / sandbox 全是 config options;也有 `_session/steering`;子代理会话按草案 RFD |
| `gemini` | `gemini --acp`(0.61.0;本机装的版本帮助里写 `--experimental-acp`,两个旗共存期,种子用 `--acp`,老版本用户改 args) | agent | ✓ ✗ ✗ ✗ | 免费档 2026-06-18 起被 Antigravity CLI 接替(注册表 `antigravity-acp`,binary 形) |
| `goose` | `goose acp`(binary) | agent | ✓ ✓ ✗ ✗ | |
| `qwen-code` | `qwen --acp --experimental-skills`(npm `@qwen-code/qwen-code`) | agent | ✓ ✓ ✗ ✓ | |
| `opencode` | `opencode acp`(binary;本机 homebrew 装的帮助里没列,待真机验) | terminal | ✓ ✓ ✓ ✓ | Kilo(`kilo acp`)是它的 fork,能力同 |
| `github-copilot-cli` | `copilot --acp`(npm `@github/copilot`) | terminal | ✓ ✓ ✗ ✗ | 也能 `--port` 开 TCP |
| `kimi` | `kimi acp`(binary,MoonshotAI/kimi-cli;Python 版 kimi-cli 已归档) | terminal | ✓ ✓ ✗ ✓ | defaults 里那条注释写的「订阅登录只对官方 CLI 开放」仍成立 |
| `auggie` | `auggie --acp`,env `AUGMENT_DISABLE_AUTO_UPDATE=1` | terminal | ✓ ✓ ✗ ✗ | |
| `cursor` | `cursor-agent acp`(binary) | agent(`cursor_login`) | ✓ ✓ ✗ ✗ | 扩展方法 `cursor/ask_question` / `cursor/create_plan` 等**不带下划线前缀**,在协议保留命名空间之外——翻译器对不认识的方法要答 method-not-found 而不是崩 |
| `junie` | `junie --acp=true`(binary,JetBrains) | agent | ✓ ✓ ✓ ✓ | |
| `cline` | `cline --acp`(npm) | agent | ✓ ✗ ✗ ✗ | |
| `factory-droid` | `droid exec --output-format acp-daemon` | agent | ✓ ✓ ✗ ✓ | |
| `grok-build` | `grok agent stdio`(npm `@xai-official/grok`) | agent | ✓ ✓ ✗ ✓ | |
| `minimax-code` / `mistral-vibe` / `devin` / `amp-acp` | 见参考稿 B.2 | | | `amp-acp` 是社区包装,探针四项全 ✗ |
| (不在注册表)`pi` | `pi-acp`(npm 0.0.34,社区 MVP,包 `pi --mode rpc`) | — | 见 README | 我们 defaults 里已有;留在种子里但标 `experimental` |

种子文件第一批(A1):`claude-code` / `codex` / `gemini` / `copilot` / `kimi` / `opencode` / `qwen-code` / `goose` / `pi`——前六家是本机装了或用户提过的,后三家是注册表里能力最全的。其余家靠注册表拉取上榜,不进种子。

**客户端实现参照**(进程管理部分,我们没有的都在这里抄):`acpx`(npm 0.19.3,`acpx/runtime`:超时、许可策略引擎、会话日志、注册表解析器)、Zed `crates/agent_servers/src/acp.rs`(stderr 灌进 debug 日志、早退 = 带 stderr 尾的错误、退出后 250ms 排空)、Obsidian「Agent Client」插件(最接近的 Electron 同类)。SDK 自己不 spawn、不重启、不读 stderr。

## 10. 风险与留账

| 风险 | 应对 |
| --- | --- |
| claude-agent-acp 版本节奏快(0.81 → ?),`_meta` 扩展面会变 | 只用协议正文里的东西;扩展只认 `_auth/status_update` 一条;manifest `quirks` 是写下来的例外表,不是能力 |
| 官方注册表格式变 | `parseAcpAgentManifest` 是校验器,不认识的字段丢弃、缺必填的条目丢弃并记一条 warn;种子文件永远够用 |
| agent 发协议外的方法(Cursor 的 `cursor/ask_question` 等不带 `_` 前缀) | 客户端对任何不认识的请求答 JSON-RPC method-not-found(`-32601`),对不认识的通知记一条 debug;绝不因未知方法断连——这是 `gate:acp` ③ 里假 agent 故意发一条乱方法要证的事 |
| `npx` 起法冷启动慢且要网 | 种子 `launch.command` 优先 PATH 上的可执行名,`npx` 只作没装时的兜底;「装上」钮走 `npm i -g` |
| 一个 agent 进程多会话,某会话卡死拖住全体 | prompt 超时(30 分钟维持)+ 取消按会话;进程级只有崩溃才重启 |
| stdio 桥在打包桌面上要用 `process.execPath` + `ELECTRON_RUN_AS_NODE` | `gate:packaged` 加一步:桥进程能起、`tools/list` 有回 |
| 权限卡「后端给几个画几个」改了卡的合同 | `choices` 缺省 = 今天五钮,本地工具零回归;壳门 ③ 钉 |
| 认领导入的转写与 agent 真实上下文漂移 | 导入只为看历史,`origin.source: 'acp-import'` 标明;真源在 agent,续聊靠 load |
| todo-plan 域在重做(`todo-rebuild-2026-09`) | 投影只写 `session-ai-todo` 作用域的 store 接口,面板换了投影不动 |

留账:`mcp/connect` 系列;Windows;`run_agent`;`session/close` 与 `session/delete`(我们不替 agent 删它的会话);NES / document 同步永不。

## 11. 施工单

### 11.1 A0 拆四单(2026-09-25 起单;用户「ok」)

顺序 A0-1 → A0-3 → A0-2 → A0-4,都碰 `runtime/src/acp/client.ts`,不并行。每单交卷:改动文件清单、`bun run typecheck` 读数、相关 vitest 读数(`vitest run packages/onething-runtime/src/acp packages/onething-runtime/src/external-agents packages/backend/wiring/acp packages/backend/rpc/__tests__/acp-domain.test.ts` 为最小集)、五门(`boundary:gate` / `log:gate` / `assembly:gate` / `session:gate` / `transport:gate`)、反证一条。不提交,Fable 审完派提交。

**A0-1 SDK 升级 + 连接对象换 1.x 应用 API。**

- `package.json` `@agentclientprotocol/sdk` `^0.17.1 → ^1.5.0`;`npm install` 与 `bun install`(hoisted,`bunfig.toml` 已钉)两份锁文件都要动。
- `runtime/src/acp/client.ts` `openConnection`(今 `:387-488`):`new ClientSideConnection(() => handlers, stream)` 换成 `acp.client({ name: 'onething', version }).onRequest(acp.methods.client.session.requestPermission, …).onNotification(acp.methods.client.session.update, …)[.onRequest(fs / terminal 各法,仍按今天的 allow* 条件挂)].connect(stream)`,得到 `ClientConnection { agent: ClientContext, signal, closed, close }`;agent 侧调用全部改成 `agent.request(acp.methods.agent.<…>, params)`(`initialize` / `session.new` / `session.load` / `session.resume`(替 `unstable_resumeSession`)/ `session.setConfigOption` / `session.prompt` / `session.cancel` 是通知走 `agent.notify`);`closed` 与子进程 `exit` 接到同一条收尾(status = error、飞着的队列 fail、终端 kill),两边谁先到谁收,第二次是幂等。1.x 的 `ClientContext.request` 是泛型,没有 `newSession()` 这类便捷法——读 `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` 的 `methods` 常量表与 `ClientContext`。
- `runtime/src/acp/__tests__/fixtures/fake-agent.mjs`:`AgentSideConnection` 在 1.5 仍导出(标 deprecated),本单不换,只把它用到的类型名对上(`unstable_resumeSession` → `resumeSession` 的 handler 名等)。
- 全仓 `bun run typecheck` 归零;最小测试集全绿;`gate:native` 不涉及(纯 JS 依赖)。
- 反证:把 `closed` 那条监听挖掉,新增一例「假 agent 主动 `close()` 连接但进程不退」→ 状态不变红。

**A0-3 单路合流。**

- `runtime/src/external-agents/acp-connector.ts` 变生产实现:`ensureSession` = `ACPManager` 的 open/restore;`streamTurn` = 今 `agent-loop/providers/acp.ts:278-334` 那段翻译(文本 / 思考 / 工具三类 + finish 映射)搬进来,`tracker`(`:140-238`)一起搬;`capabilities` 在 `ensureSession` 后由握手结果填(`hostTools: false` 先留,A4 改;`steer` 读 `initialize` 返回的 `_meta.steering.supported`;`interrupt: true` = `session/cancel`;`imagesIn` 读 `promptCapabilities.image`;`resume` 读 `loadSession || sessionCapabilities.resume`)。
- `runtime/src/agent-loop/providers/factory.ts:451-464`:`'acp'` → `createExternalAgentProvider({ providerId: 'acp', connector: acpConnector, resolveSessionLink, onSessionLink, … })`,与 `:466-487` 的 Claude 分支同一个包装器;删 `agent-loop/providers/acp.ts` 与 `backend/wiring/agent-loop/providers/factory.ts:89-90` 的 `acpStreamPrompt` / `acpCwd`。
- 链接表:`ExternalAgentSessionLink` 契约留,存储改指 `FileACPSessionLinkStore`(`<store>/acp/session-links.json`);`backend/wiring/external-agents/index.ts:80-115` 那份文件存储改成读写同一个文件(Claude 路暂时同吃,A6 再删)。
- `shared/ipc/acp.ts:12-54` 的 `ACPAgentConfig` 改 `import type` runtime 那份(`runtime/src/acp/types.ts`),删注释 `:130-134`。
- `core/engine/external-agent-providers.ts:41-44` `PROVIDER_EXECUTION_FACTS` 清空;确认 `agents/executor/registry.ts` 的 `syncAgentExecutorsToCore()` 在装配前已执行(它是模块加载时跑的,查 import 链确保 `backend.ts` 装配前已 import 过执行器注册表;没有就在 `backend.ts` 加一条静态 import,与工具 barrel 那三条同理由)。
- 反证:清空 `PROVIDER_EXECUTION_FACTS` 后不接登记 → 压缩门对 acp 会话开始压缩 → `core-stream-engine` 现有测试至少 1 红。

A0-3 施工记(2026-09-25):翻译搬进 `runtime/src/acp/translate.ts`(`translateACPPromptStream(events, turn)`,产出逐字未变);`ACPAgentConfig` 两份合一的落点是**第三个家 `packages/shared/contracts/acp.ts`**——契约层不许依赖产品层,产品层非 wiring 文件不许 import `@shared/ipc`,两边都够得着又不反向的只有 `@shared/contracts`(`usage.ts` 是先例);链接表一只对象由 `ACPManager.getSessionLinkStore()` 持有,`ExternalAgentSessionLink` 加可选 `agentId`,旧 `<store>/external-agents/session-links.json` 首次读时并入不删;连接器契约加可选 `capabilitiesFor(model)`(一台连接器多台 agent);执行器表 acp `interrupt` 翻真(直连 `session/cancel`),`steer` 仍 false 等投递接上。`backend.ts` 的静态 import 只是护栏——`wiring/external-agents` 已间接 import 到注册表,反证靠新测试 `backend/__tests__/provider-execution-facts.test.ts`(挖掉 `syncAgentExecutorsToCore()` 即红)。**可感知变化**:ACP 会话未绑目录改为结构化拒发(从前静默用 `process.cwd()`)。顺手做了图片:握手说收图就以 `image` / `resource_link` 块跟在文本后面发。留账:persona / system prompt 仍不送(要先让 composer 按执行器只给 persona 片段,不给本地工具说明——挪到 A2);首轮握手前能力是保守缺省,第一条带图的消息会被提示「送不出」,下一条起正常(A2 里让 `capabilitiesFor` 在 `ensureSession` 之后再问一次)。

**A0-2 会话状态与回合事件分家。**

- 新 `runtime/src/acp/session-state.ts`:`AcpSessionState`(§3.3 形状)+ `applySessionUpdate(state, update): AcpSessionState`(纯 reducer,十六个 case 本单只落 `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` / `notice` / `plan` / `plan_update` / `plan_removed` / `compaction_update` 的**状态半边**,渲染与投影归 A2)+ 测试。
- `client.ts` 的 `sessionUpdate` 回调:先 `applySessionUpdate`,再看有没有在飞的 prompt 队列,有才推——**不在 prompt 期间的通知不再丢**。
- `shared/events/global-events.ts`:登记 `acp:session-state`(载荷 = 状态快照)与 `acp:agent-state`(载荷 = `ACPAgentState`),`GLOBAL_EVENT_LEAVES_PROCESS` 两条 true;`ACPManager` 在状态变化时 `emitGlobal`(沿用 `createEventBusTerminalBroadcaster` 那种「发送时取总线、总线未建则 warn-and-drop」的写法,别在构造时抓总线)。
- RPC `acp.sessionState(sessionId)`(`shared/ipc/acp.ts` + `backend/rpc/domains/acp.ts`),测试文件 `acp-domain.test.ts` 的「exactly N methods」断言随之更新(今天它还停在 8,实际 10,一并修)。
- 反证:reducer 里 `available_commands_update` 的 case 挖掉 → 新测试 1 红。

### 11.2 A1 拆两单(名册数据化)

A1-a 是后端,A1-b 是壳;A1-b 依赖 A1-a 的 RPC 形状。与 A2 / A3 / A4 不冲突文件(它们碰 `client.ts` / `translate.ts` / 桥,A1 碰名册与设置),可与其中一单并行派。

**A1-a manifest + 种子 + 注册表 + 探测 + 设置。**

- `runtime/src/acp/manifest.ts`:`AcpAgentManifest`(§3.2 形状,含 `configPaths`)+ `parseAcpAgentManifest(raw: unknown): { ok: true; manifest } | { ok: false; reason }`(id 只收 `[a-z0-9-]`,`launch.command` 必填,不认识的字段丢)+ `manifestFromRegistryEntry(entry)`:注册表 `distribution.npx` → `launch = { command: 'npx', args: ['-y', package, ...args], env }` + `install.npm = package 去 @version`;`binary` / `uvx` → 不给 `launch`(A1 不自动下载二进制),只给 `install.hint = repository ?? website` 与 `detect.bins = [id 推的可执行名]`,这种条目只能靠用户装到 PATH 上后被探测认领。类型住 `packages/shared/contracts/acp.ts`(壳要画它,与 A0-2/A0-3 同理)。
- 种子 `resources/acp-agents/<id>.json` 九个:`claude-code`(`claude-agent-acp`,detect bins `claude-agent-acp`,install npm `@agentclientprotocol/claude-agent-acp`,auth hint「用 Claude 订阅或 API 控制台登录」,configPaths `~/.claude`,quirks `systemPromptMeta: 'claude-agent-acp'`)、`codex`(`codex-acp`,npm `@agentclientprotocol/codex-acp`,configPaths `~/.codex`)、`gemini`(`gemini --acp`,bins `gemini`,hint `npm i -g @google/gemini-cli`,configPaths `~/.gemini`)、`copilot`(`copilot --acp`,npm `@github/copilot`)、`kimi`(`kimi acp`,hint = kimi-cli release 页)、`opencode`(`opencode acp`)、`qwen-code`(`qwen --acp --experimental-skills`,npm `@qwen-code/qwen-code`)、`goose`(`goose acp`)、`pi`(`pi-acp`,npm `pi-acp`,`experimental: true`)。种子目录解析照技能:`packages/onething-runtime/src/skills/loader.ts` `getBuiltinSkillsPath()` 那套 dev = 仓根 / 打包 = `process.resourcesPath`,抽一个共用的 `getBuiltinResourcePath(name)` 两处同用;`electron-builder.yml` `extraResources` 加 `resources/acp-agents` 一行(与 skills 同形)。
- `backend/wiring/acp/registry.ts`:`AcpAgentRegistry { roster(): AcpAgentRosterEntry[]; refresh(opts?: { network?: boolean }): Promise<void>; onChanged(listener): () => void }`,`AcpAgentRosterEntry = { manifest, source: 'builtin' | 'registry' | 'user', override?: ACPAgentConfig, effective: ACPAgentConfig }`。三源合并同 id 用户 > 种子 > 注册表;`effective` = manifest.launch ⊕ override(只覆盖 override 里写了的字段);`enabled` 缺省 = 探测到已安装。注册表:`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,用 `backend/provider-binding/bound-fetch.ts` 的 `createAppFetch()`(走 `network.proxy`,与 provider 请求同一实现),落 `<store>/acp/registry-cache.json` `{ fetchedAt, entries }`,TTL 24h,失败用缓存、无缓存只用种子,一行 warn;`settings.acp.registry.enabled` 缺省 true,false 就不联网。**`ACPManager.updateSettings` 吃的是 `effective` 数组**,不再直接吃 `settings.acp.agents`——`AcpSubsystem` 持有 registry,`applySettings` = 重算 roster 再喂 manager;`settings:changed` 与 `registry.onChanged` 都触发。
- `backend/wiring/acp/detect.ts`:`detectAgent(manifest): Promise<AcpAgentDetect>`(`{ installed, path?, version?, belowMin?, checkedAt }`):在 `process.env.PATH`(登录 shell 已灌)上找 `detect.bins` 任一个可执行(`access X_OK`),找到再 `execFile(path, versionArgs, { timeout: 3000 })` 取首行里第一个 `\d+\.\d+(\.\d+)?`;`launch.command === 'npx'` 的条目 installed = 找得到 `npx`。结果缓存在 registry 里,`acp.detect` 与设置页打开时刷新,不轮询。
- 设置:`DEFAULT_ACP_SETTINGS.agents = []`,删四条字面量与 `migrateLegacyDefaultACPAgent`;`normalizeACPSettings` 加一步「与种子逐字相等的条目(id 同、command 同、args 同)丢掉」——老盘上那四条是当年 defaults 写回去的拷贝,不是用户的意思;加 `registry?: { enabled?: boolean }`。`ACPAgentConfig` 加 `basedOn?` / `secretEnv?`(本单只加字段与校验,凭证池接入归 A3)。
- RPC:`acp.getAgents` 返回值加 `manifest` / `source` / `detect`(`ACPAgentState` 在 contracts 里扩);新 `acp.detect({ agentId? })`、`acp.refreshRegistry()`;`addAgent` 收 `basedOn`。`acp-domain.test.ts` 方法表随之 13。
- 反证:种子目录里放一个 `launch.command` 缺失的坏文件 → `parseAcpAgentManifest` 拒、一行 warn、其余照常上榜(测试);把「与种子相等的条目丢掉」挖掉 → 老盘夹具里 `claude-code` 出现两次红。

A1-a 施工记(2026-09-26):落地如单,三处值得记。①旧 id `codex-cli` / `kimi-code` 的认回**写在种子的 `aliases` 字段**,代码里不出现旧名;`selectedModels` 里的旧 id 不改写(通用存储层不该认识某个 provider 的内容),靠 `ACPManager.setAgentAliases` 认回,选择器不会自动勾上新行。②注册表 `binary` 形条目在本平台有目标时也给 `launch`(只写 PATH 上的可执行名,不下载),装好即能认领——比施工单「不给 launch」更好,采纳。③**种子 agent 的覆盖只存改过的字段**(`sparseOnethingACPRosterOverride`:`id` 必留,`enabled` 只在显式传了才存,`name` / `description` / `command` / `args` / `env` / `permissionMode` 与种子推出的值相等就丢,其余带着的原样留),否则设置页的启用开关会被「种子拷贝丢弃」规则吞掉——审查打回补的;用户手加的条目仍整份存。`gate:acp` 写 `registry.enabled: false` 且收尾断言日志里没有 `acp registry fetching`。顺带核实:**独立 server 从不调 `backend.acp.start()`**,那里的名册靠懒加载的种子与缓存,版本号与联网只由 `acp.detect` / `acp.refreshRegistry` 触发——A5 处理(server 装配后 `start()`,与桌面 / daemon 同口径)。留账:`gate:acp` ⑤ 未加;用户显式启用一台未安装的种子 agent 现已可行。

**A1-b 设置「Agent」页 + 选择器徽标。**

- `apps/desktop-react/src/content/settings/AgentsSettings.tsx`(+ `.module.css`),`pages.tsx` 加一行 `{ id: 'agents', titleKey: 'settings.pageAgents', layout: 'fill' }`,排在 `models` 之后。形状照 §3.9:左栏 rail(复用 `providers/components/ProviderRail` 的基础件,不复制)一行一 agent(图标 / 名 / 探测·登录两粒状态点),右栏本单只做四段——状态行(已安装 x.y.z / 未安装 + 「装上」钮 = 在终端瓦里跑 `npm i -g <install.npm>` 或显示 `install.hint`;进程 空闲 / 运行中 pid / 出错一句)、启用开关、高级折叠(命令 / 参数 / 环境变量键值行 / 超时;「打开配置目录」走 `shell` 域 `revealInFolder`)、底部「添加自定义 agent」(名字 / 命令 / 参数三格)与「复制为自定义」。登录 / 缺省选项 / 权限 / 工具四段归 A3 / A2。数据层 `data/acp-agents-source.ts`:`acpAgentsQuery`(`acp.getAgents`)+ `acp:agent-state` 全局事件就地更新 + `detect` / `refreshRegistry` / `addAgent` / `updateAgent` / `removeAgent` 五只 mutation;三张状态表(initial / ready / error;empty = 「一个都没探测到」+ 一句怎么装)。
- 选择器:`DrawerModelPicker` 的 acp 行带来源徽标(内置 / 注册表 / 自定义)与探测状态,未安装置灰、悬停给装法;`providers/families.ts` 不动。
- i18n zh + en 成对;`gate:acp-shell` ①②(真机 CDP,同 `gate:terminal` 口径);壳 `npm run ui:consume` / `squeeze-gate` / `motion-gate` 无新增。
- 反证:把「未安装置灰」挖掉 → 壳门 ② 红。

### 11.3 A3 拆四单(三样东西 + 两种问法)

顺序 A3-a → A3-b → A3-c(三单都改 `client.ts` 的客户端方法表,不并行);A3-d 是壳,依赖前三单的契约,可与 A1-b 同批派。核过的现状:`backend/wiring/acp/permission-bridge.ts` 只造一条 `external-agent` 效果(资源 `agentId:kind`)、只答 allow / reject;`Permission.Response = 'once' | 'session' | 'workdir' | 'always' | 'reject'`,`Info.alwaysScope` 决定 `always` 钮;壳 `PermissionAsk { toolCallId, permissionId, title, type, pattern?, alwaysScope?, … }`;`describeExternalToolPermission({ toolName, input, cwd })` 认的是 SDK 工具名(`Bash` / `Read` / `Edit` / `Write` …);`TerminalCreateRequest` 今天只有 `cwd / shell / cols / rows / sessionId`——它起的是 shell,不是命令;效果表已有 `read`(silent)/ `file_edit` / `file_write` / `file_destructive_edit` / `bash` / `external_directory` / `sensitive_file_read` / `external-agent` 各行。

**A3-a 权限:四选项上卡 + 效果分析 + 无人值守缺省拒。**

- `runtime/src/external-agents/permission-effects.ts` 加一层 `describeAcpToolPermission({ kind, name, rawInput, locations, cwd })`:先按 `kind` 归一——`execute` → 取 `rawInput.command`(字符串或 `[cmd, ...args]`)走 `Bash` 那条分析;`read` → 路径取 `locations[0].path` ?? `rawInput.path` ?? `rawInput.file_path` 走 `Read`;`edit` / `delete` / `move` → 同上走 `Edit` / `Write`(`delete` 用 `file_destructive_edit`,`move` 两个路径各一条);`search` / `fetch` / `think` / `switch_mode` / `other` 与取不到字段的 → 退回今天那条 `external-agent` 效果(资源 `agentId:kind`)。产出是 `Effect[]`,一条不多编。
- `core/permission/index.ts` `Info` 加可选 `choices?: Array<{ id: string; kind: 'once' | 'always' | 'reject' | 'reject-always'; label: string }>`;`Permission.ask` 原样带到 `permission:request` 事件;不给 = 今天五钮(本地工具零回归)。
- `permission-bridge.ts` 重写:效果 = 上面那层;`choices` = agent 的 `options` 按 `kind` 映射(`allow_once` → once,`allow_always` → always,`reject_once` → reject,`reject_always` → reject-always,`label` 用 agent 给的 `name`);`messageId` 从 `promptContexts` 透传(`CoreACPPromptStreamOptions` 已有 `messageId`,连接器 A0-3 已递,桥今天没读);应答映射:`once` → 答 `allow_once` 的 optionId;`always` → 我们这边 grant 落盘(走 `Authorizer` 现有路径)**并**答 `allow_always` 的 optionId;`session` / `workdir` → 我们记忆、答 `allow_once`;`reject` → `reject_once`;`reject-always` → 答 `reject_always` 并在我们这边记会话级拒绝;取消(用户关卡 / 会话 abort)→ `RequestPermissionOutcome.cancelled`。agent 没给某 kind 的选项就不画那个钮;`session` / `workdir` 永远画(它们是 onething 的记忆)。
- `unattended`:`ACPAgentConfig.permissionMode` → `unattended?: 'reject' | 'allow'`(contracts + normalize 一次性改名迁移,老值 `'allow'` 照搬、`'reject'` 照搬、缺省 reject);`client.ts` `resolvePermissionFromMode` 改读它,**无桥时缺省拒**(答 `reject_once`);`unattended: 'allow'` 才选 `allow_once`(永不自动选 `allow_always`)。
- 反证:效果分析挖掉 → 新测试「execute 带 `rm -rf` 的 rawInput 产出 bash 效果」红;无桥兜底改回 allow → `gate:acp` ⑯ 红(门步在 A3-b 一起补)。

**A3-b 文件 + 终端走 onething 自己的。**

- 客户端能力固定:`clientCapabilities = { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true }, elicitation: { form: {}, url: {} }, session: { configOptions: {}, notices: {}, compaction: {} }, plan: {} }`,方法表无条件全挂;删 `allowFileSystemAccess` / `allowTerminalAccess`(contracts、normalize、defaults、`gate:acp` 的 settings 一并)。`auth` / `elicitation` 两组的处理器 A3-c 接,本单先挂成「答 method-not-found」占位?——不:能力声明与处理器必须同批,本单只声明 fs / terminal / session / plan,auth 与 elicitation 的声明留到 A3-c。
- `backend/wiring/acp/fs-bridge.ts`:`ACPClient` 的 `readTextFile` / `writeTextFile` 改成调注入的 `AcpFsBridge`(`ACPClientRuntimeOptions` 加一格,与 `getSessionLinks` 同列;缺席 = 今天的裸实现,测试用)。读:`checkFileAccess` 以会话 cwd + 读根判,根内直接读,根外 / 敏感文件走 `Permission.ask`(效果 `external_directory` / `sensitive_file_read`,`choices` 无、五钮),拒了答 JSON-RPC 错误(`-32000` 类,message 一句人话);写:读旧文 → `createTwoFilesPatch` → 效果 `file_write`(新建)/ `file_edit`(改)/ 根外加 `external_directory`,卡上带 diff(`metadata.diff`,壳 A3-d 画),准了 `mkdir -p` + 写,写完 `tool/audit` 一条进账本(照 `AuditProjector`)。
- `runtime/src/terminal/service.wiring.ts` `TerminalCreateRequest` 加 `command?: string; args?: string[]; env?: Record<string,string>; owner?: { kind: 'user' | 'acp'; agentId?: string; sessionId?: string }`:给了 `command` 就直接 spawn 那个程序(node-pty 本就能起任意可执行),不给照旧起 shell;`TerminalInfo` 带 `owner`。`backend/wiring/acp/terminal-bridge.ts`:`terminal/create` → 先按 `execute` 效果问许可(命令走 bash 分类器,`unattended` 同上),准了 `TerminalService.create({ command, args, cwd: params.cwd ?? 会话 cwd, env: 登录 shell 环境 ⊕ 代理环境 ⊕ params.env, owner })`;`terminal/output` 读它的回放环(`attach` 那套,截到 `outputByteLimit`),`wait_for_exit` 订 `onExit`,`kill` → `kill`,`release` → 摘表(进程若还在也杀——release 语义是「我不要了」)。`ACPClient` 里今天那套自己 spawn 的终端实现删,`TerminalRecord` 表删。
- **桥在三个宿主上都注册**(裁定):今天只有 React 壳调 `registerACPPermissionBridge()`;server 与 daemon 没有桥,于是 agent 的审批根本到不了许可系统。A3-b 起 `createRealServerBackend` 与 `HeadlessBackend` 也 `own(registerACPPermissionBridge())`——桥本身不认宿主,它只是把 agent 的请求交给 `Permission.ask`;无人应答时许可系统自己的无人值守兜底(`wiring/tools/core/permission-policy.ts` `UNATTENDED_ASK_TIMEOUT_MS = 120_000` 后拒)就是「无桥缺省拒」的同一语义,`unattended: 'allow'` 的 agent 在桥里前置放行不进 ask。于是 §3.5 那条「无桥宿主」改口为「无人应答」,结论不变。
- 门步 ⑪–⑭ + ⑯ 本单补进 `gate-acp.mjs`,门自己当应答者(订 `permission:request` 事件、按步发 `permission-respond` 命令);假 agent 加剧本 `FAKE_AGENT_PERMISSION=1`(工具前发四选项审批)、`FAKE_AGENT_FS=1`(读 cwd 内一文件,再读 `~/.ssh/id_rsa`)、`FAKE_AGENT_TERMINAL=1`(起 `echo hi` 并读输出)。⑯ 验「无人应答 → 拒」:门不应答那一次,超时常量经 `ONETHING_UNATTENDED_ASK_TIMEOUT_MS` 环境变量压到 2s(新加,只有这一处读,缺省不变)。
- 反证:fs 沙箱检查挖掉 → ⑬ 红;终端不经 `TerminalService` → ⑭ 红;无人应答兜底改成放行 → ⑯ 红。

**A3-c 登录 + 提问。**

- `backend/wiring/acp/auth-bridge.ts`:握手后 `authMethods` 进 `ACPAgentState.auth = { methods, required, label? }`(`required` 由 `-32000 auth_required` 错误或 `_auth/status_update` 置);RPC `acp.authenticate({ agentId, methodId })`:`type: 'terminal'` 方法 → `TerminalService.create({ command: agent.command, args: method.args, env: agent env ⊕ method.env, owner: { kind: 'acp', agentId } })` 并把 terminalId 答给壳(壳开终端瓦);退出码 0 → 重连 agent(`disconnect` + 下次 prompt 自然连)并清 `required`;agent 型 → `agent.request(authenticate, { methodId })`。客户端能力加 `auth: { terminal: true }`。
- `backend/wiring/acp/elicitation-bridge.ts`:`elicitation/create` → `Interaction.ask({ sessionId, origin: 'external-agent', questions, toolCallId?, messageId })`:form 模式的 JSON Schema 子集映射——`enum` → 单选 options、`multiselect` → `multiSelect`、`boolean` → 两选、`string` / `number` → `allowFreeText` 且无 options、不认识的类型 → 一题自由文本;url 模式 → 一题两选「已完成 / 取消」+ 用 `shell` 域开外链;答案按 `elicitation/complete`(accept + content / decline / cancel)回;deadline 用交互内核缺省。客户端能力加 `elicitation: { form: {}, url: {} }`——**声明了 claude-agent-acp 才把 AskUserQuestion 发成表单**。
- 反证:能力里 `elicitation.form` 摘掉 → 新测试「假 agent 发 elicitation/create」得 method-not-found 红;`gate:acp` ⑮ 补(假 agent `FAKE_AGENT_ELICIT=1`)。

**A3-d 壳:权限卡按 `choices` 画、diff 上卡、终端瓦 owner、登录钮。**

- `content/permission/PermissionCard.tsx`:有 `choices` 就按它画钮(label 用 agent 给的,kind 决定颜色与位置),`session` / `workdir` 照旧;`metadata.diff` 在场画 `DiffView`(复用 edit 工具那只)。`data/permission-ask.ts` 加 `choices?` / `diff?`。
- 终端列表 / 瓦:`owner.kind === 'acp'` 的显示「<agent 名> 开的」并按 owner 分组;工具卡 `terminal` 内容块 → 「打开终端」钮(A2 已把 terminalId 带到卡上)。
- 设置「Agent」页(A1-b 的页)补三段:登录(状态 + 「去登录」→ `acp.authenticate` → 终端型开瓦)、权限(`unattended` 开关 + 「查看已授权」链接)、工具(`hostTools` / `forwardMcpServers` 两开关,A4 接后端)。
- `gate:acp-shell` ③④;反证:`choices` 分支挖掉 → ③ 红。

### 11.4 A2 拆三单(更新全覆盖 + 工具保真 + 投影 + 壳)

A0-2 已把十种状态更新折进 `AcpSessionState`;A2 剩下的是**回合流的保真**与**投影 / 渲染**。A2-a 与 A3 都改 `translate.ts` 以外的东西可并行;A2-b 只装配层;A2-c 是壳。

**A2-a 工具保真 + persona。** `translate.ts`:`diff` 内容块 → `tool-metadata` 带 `changes`(`createTwoFilesPatch(path, path, oldText ?? '', newText)` → `trimDiff` → `truncateDiffForDisplay`,与 Claude 连接器 `claude-code-connector.ts:760` 同一条链,抽成 `external-agents/diff-changes.ts` 两边共用);`terminal` 内容块 → `tool-metadata` 带 `terminalId`;`locations` → `tool-metadata` 带 `locations`;`pending` / `in_progress` 状态 → `tool-partial-result` 带 `status`(卡上显示「等待 / 进行中」);`name` 在场用它当工具名,`kind` 进 metadata(壳按 kind 选 presenter);`compaction_summary_chunk` → `provider-data { kind: 'compaction-summary', text }`。persona:`ExternalAgentProvider` 对 `persona: 'prepend'` 的执行器,把 composer 系统通道里 `source === 'builtin'` 且 `slot === 'section'` 以外的片段(即 persona / agent 描述那几段,不含工具说明)折成会话第一条 prompt 的头块 `<persona>…</persona>`;manifest `quirks.systemPromptMeta === 'claude-agent-acp'` 的 agent 改走 `session/new` 的 `_meta.systemPrompt = { append }`(`client.ts` `newSession` 加可选 `_meta`,连接器按 manifest 决定)。`capabilitiesFor` 在 `ensureSession` 之后再问一次(A0-3 留账:首轮图片)。反证:`diff` 折叠挖掉 → 夹具回放测试 `changes` 为空红。
**A2-b 投影。** `wiring/acp/plan-projection.ts`:订 `ACPManager.onSessionStateChanged`,`plan` 变了就写 todo-plan 域 `session-ai-todo` 作用域(`getTodoPlanStore()`;`items` 逐条、`markdown` 整段、`file` 读文件),`plan_removed` 清空;`wiring/acp/usage-projection.ts`:`PromptResponse.usage` + `usage.cost` → `recordUsage({ source: 'acp', providerId: 'acp', model: agentId, inputTokens, outputTokens, thoughtTokens?, cachedRead?, cachedWrite?, reportedCost? })`,`billingMode` 未知 `costUSD: null`;标题:`session_info_update.title` 且用户没手改过 → `patchSession({ title })`。三个都在 `AcpSubsystem` 里 `own`。`gate:acp` ⑥–⑨ 补(假 agent `FAKE_AGENT_RICH_TOOLS=1` / `FAKE_AGENT_PLAN=1` / `FAKE_AGENT_USAGE=1`)。反证:plan 投影挖掉 → ⑧ 红。
**A2-c 壳。** 工具卡:`presenters/` 加一张 `kind → presenter` 表(read → read;edit / delete / move → edit 族;execute → bash;search → search;fetch → web;其余默认),`changes` 走 `DiffView`,`terminalId` 出「打开终端」钮,`locations` 卡脚可点(`file:` 引用);composer:命令抽屉并入 `commands`(选中 = 原样发 `/name`),`MeterCard` 多一格「agent 自报」优先,模型药丸 / 思考档 / 模式粒按 `category` 认领(§3.8 表),`AgentOptionsCard` 加 boolean 行;`ChatStream` 折痕行认 `compaction-summary`;`DrawerStatus` 显示最近 notice。数据层 `data/acp-session-state-source.ts`(`acp.sessionState` 冷读 + `acp:session-state` 事件替换)。`gate:acp-shell` ④–⑦。

### 11.5 A4 拆两单(宿主工具面)

**A4-a 桥与凭据。** 新构建入口 `runtime/src/acp/mcp-bridge/entry.ts`(薄进程:读 `ONETHING_MCP_URL` / `ONETHING_MCP_TOKEN`,用 `@modelcontextprotocol/server` 在 stdio 上开 MCP server,`tools/list` / `tools/call` 转成对 `POST /api/rpc` `host-mcp.listTools` / `host-mcp.callTool` 的调用)→ 三份配方各出 `acp-mcp-bridge.cjs`(`apps/desktop-react/scripts/build-electron.mjs` 第四个 esbuild、`scripts/build-cli.mjs`、`scripts/build-server.mjs`),`electron-builder.yml` asarUnpack 加一行;`backend/rpc/domains/host-mcp.ts`(只认桥凭据:`Authorization: Bearer <bridge token>`,与用户 token 不同表);`wiring/acp/host-mcp-bridge.ts`:每 (agentId, localSessionId) 签一枚凭据(内存表,会话 close / dispose 作废),组 `mcpServers`:`mcpCapabilities.http` 真 → `{ type: 'http', name: 'onething', url: <face>/api/mcp, headers: [Bearer] }`,否则 stdio `{ name: 'onething', command: process.execPath, args: [bridge.cjs], env: [ONETHING_MCP_URL, ONETHING_MCP_TOKEN, ELECTRON_RUN_AS_NODE=1] }`;`/api/mcp` 挂在 `backend/server/http.ts`(Streamable HTTP,同一把桥凭据);工具集 = `resolveHostToolSurface`(改名自 `resolveClaudeCodeHostToolSurface`)+ `send_notification`;用户 MCP 名册透传按 `forwardMcpServers` 开关与 `mcpCapabilities` 门控;执行器表 acp `hostTools` 翻真。`gate:acp` ⑰⑱。反证:凭据换常量 → ⑱ 红。
**A4-b 运行时接线。** `AcpConnector.streamTurn` 在 `openSession` 前算好 `mcpServers` 递给 `ACPManager.openSession`(签名加一格),`client.ts` `newSession` / `load` / `resume` 用它替 `config.mcpServers` 透传;`bindHostToolContext` 按桥凭据而非按回合绑定(一条会话多轮共用一枚凭据,回合切换时更新 context 里的 `messageId`);Claude SDK 路的 `createSdkMcpServer` 保留到 A6。

**A0-4 `gate:acp` 骨架 ①–④。**

- `scripts/gate-acp.mjs`(node,bun 无 `node:sqlite` 的口径同 `gate:search-index`):`server:build` 产物起 `dist/server` 于临时 store(`ONETHING_STORE_PATH`),`settings.json` 里写一条 agent 指向 `fake-agent.mjs`(`command: process.execPath, args: [fixture]`,env `FAKE_AGENT_CAPS=load`),全程 `POST /api/rpc` + `GET /api/events`;步骤 ①–④ 按 §7 表,③ 含协议外请求 `cursor/whatever` 得 `-32601` 且流照常收场(假 agent 加剧本 `FAKE_AGENT_ROGUE_METHOD=1`)。
- 根 `package.json` `"gate:acp": "node scripts/gate-acp.mjs"`;不进 `verify`(与 `gate:search-index` 同口径,单独跑)。
- 反证:注释掉 A0-2 的「prompt 外通知也折状态」→ ④ 红。
