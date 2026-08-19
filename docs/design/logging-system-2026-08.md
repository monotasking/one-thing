# 日志系统设计(2026-08-19)

> 前置:`docs/audit/logging-inventory-2026-08-19.md`(现状盘点,13 条问题)。
> 本文 = 成熟日志的通用原则 → onething 的目标结构 → 分期(L0–L5)→ 待拍板行为点。
> 拍板前本文是提案;§6 的选项未定之前不动代码。
> **2026-08-19 追加拍板:会话事件溯源(E3)现在做,见 `session-event-sourcing-2026-08.md`;本文 §2.7 的 T0–T2(runId 缝合 + `io/` 账本)被 S 线取代,只保留 §2.7.2 的四层键定义(诊断日志 fields 仍按此绑定)与 §2.7.4 的存储算账。L 线不变。**

---

## 1. 成熟日志长什么样(通用原则)

参照:pino / structlog 的结构化模型、OpenTelemetry Logs 数据模型、12-factor "logs as event streams"、以及 deepseek-harness 的"事件日志唯一事实,一切皆投影"。抽成七条,每条后面括号是 onething 现状对照。

| # | 原则 | 现状对照 |
|---|---|---|
| P1 | **一个门面**:产品代码只见 `Logger` 接口,不见 console、不见文件、不见传输 | 5 套抽象 + 97% 裸 console;core 内另有 8 个 `Core*Logger` 鸭子接口 |
| P2 | **记录是结构化数据,不是字符串**:`{time, level, ns, msg, ...fields}`;字符串只是渲染结果之一 | 92% 模板字符串;`[object Object]` 199 行 |
| P3 | **命名空间从模块推导,不手打**:`engine.stream` / `toolkit.runner`;子 logger 绑定上下文(`sessionId`,`toolCallId`)一次,后续行自动带 | 172 个手打 tag,关联 ID 28 行 |
| P4 | **等级有语义,且运行时可按命名空间调**:trace/debug 默认关,`ONETHING_LOG=info,engine.*=debug` 一行开 | `console.log→INFO`,debug 全仓 1 条,开关 8 个 3 套命名 |
| P5 | **生产者与 sink 解耦**:同一条记录可同时到终端(pretty)/文件(JSONL)/主进程(renderer 桥)/内存环(崩溃现场) | 只有 console 劫持一条路;renderer 靠"必打一条 console"被顺带抓 |
| P6 | **三类东西分开管**:①诊断日志(临时、轮转、可丢)②事件账本(产品数据、随所有者生命周期)③调试转储(默认关、有界、显式开) | 全塞 `log/` 合租,4 套轮转 + 1 个不治理;provider 正文 dump 默认开 1.1G |
| P7 | **错误不静默**:每个宿主装 `unhandledRejection`/`uncaughtException`;吞异常至少 debug 一行;lint 禁 console 让 P1 不回退 | 189 处静默 catch 零降级;`unhandledRejection` 无人听;server 无钩子 |

一句话:**日志是数据管道,不是 print。** 三个决定分别是"记什么(结构)""谁看(sink)""留多久(治理)",互不耦合。

---

## 2. onething 的目标结构

依旧遵守三层:core 定接口和纯 sink,app 装配,宿主注入。

```
┌ renderer ───────────────────────────────────────────────────────┐
│ log = getLogger('renderer.chat-store')          (P1/P3)         │
│  → RendererLogHub: 内存环 + console echo(dev) + 批量 transport   │
│    transport = platformApi.appendLogs(batch)   (P5)             │
│      electron: ipc 'log:append'   web: POST /api/logs           │
│  crash-log 改为 RendererLogHub 的一个 producer,不再自打 console  │
└─────────────────────────────────────────────────────────────────┘
┌ core/logging (零依赖) ──────────────────────────────────────────┐
│ Logger { trace debug info warn error fatal child(fields) }      │
│ LogRecord { time level ns msg fields? err? }                    │
│ LevelFilter(spec: 'info,engine.*=debug')       (P4)             │
│ sinks: ConsoleSink(pretty|json)  MemoryRingSink  (P5)           │
│ 8 个 Core*Logger 接口 → 统一为 Logger(结构兼容,渐进替换)         │
└─────────────────────────────────────────────────────────────────┘
┌ runtime/src (product) ──────────────────────────────────────────┐
│ 只 import Logger 类型 + getLogger(ns);不知道 sink                │
│ 已有的 CorePluginAPILogger / getLogger(adapters) / gateway       │
│ channel logger? 全部收敛为 Logger 子实例                          │
└─────────────────────────────────────────────────────────────────┘
┌ runtime/src/app/logging (assembly) ─────────────────────────────┐
│ RollingFileLogger → JsonlFileSink(保留轮转/压缩/保留期实现)       │
│ configureLogging({level, sinks, hostPorts})                     │
│ LogDirJanitor:log/ 目录唯一治理者,一张策略表   (P6)              │
│ installProcessCrashHooks(logger)               (P7)             │
│ console 劫持降级为 LegacyConsoleSink:ns='console',带 ratchet 计数 │
│ ipc/http 'log:append' handler → 同一根 logger,ns 前缀 renderer.  │
└─────────────────────────────────────────────────────────────────┘
┌ hosts ─────────────────────────────────────────────────────────┐
│ electron: 现有 configureAppLoggingHost 保留;console-message 捕获  │
│           降级为 warn+ 且只抓非我方来源(第三方/CSP/未捕获)          │
│ server:  configureLogging + 请求日志中间件(method path status ms │
│           sessionId)+ crash hooks;stdout=pretty|json 由 env 决定 │
│ daemon:  同上;daemon.log 由 janitor 治理(或改由 JsonlFileSink 写) │
│ gateway: 构造时注入 Logger,内部 child('gateway.wechat') 等        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 记录形状

```ts
interface LogRecord {
  time: number            // epoch ms
  level: 'trace'|'debug'|'info'|'warn'|'error'|'fatal'
  ns: string              // 'engine.stream' — 点分,层级前缀即命名空间过滤单位
  msg: string             // 固定短句,英文,不拼变量(变量进 fields)
  fields?: Record<string, unknown>   // sessionId messageId toolCallId requestId …
  err?: { name; message; stack?; cause? }   // 归一化,不靠 util.inspect
  src?: 'main'|'renderer'|'server'|'daemon'|'gateway'|'console'|'process'
}
```

- 文件落盘 **JSONL**(一行一条 `LogRecord`);终端走 pretty renderer。原 `ISO [source] LEVEL msg {meta}` 文本格式只在 pretty 渲染里存活。→ 拍板点 A。
- `msg` 稳定、`fields` 变化:`log.info('stream finished', { sessionId, messageId, ms })` 而不是 `` `Stream complete: ${sessionId}` ``。可 grep、可聚合、可做告警。
- `err` 单独字段;`console.error('x', error)` 的二元拼接消失。

### 2.2 命名空间表(唯一事实,替代 172 个手打 tag)

前缀 = 层 + 模块,与目录对应,新增模块必须落一行:

| 前缀 | 覆盖 |
|---|---|
| `core.agent-loop` `core.events` `core.permission` `core.toolkit` `core.plugins` | packages/core |
| `engine.stream` `engine.prompt` `engine.compact` `engine.triggers` | app/engine/** |
| `toolkit.runner` `toolkit.authorize` `toolkit.<tool>` | app/toolkit + runtime toolkit |
| `providers.<id>` `providers.dump` | agent-loop/providers + request-dump |
| `sessions` `settings` `usage` `skills` `themes` `variables` `goals` `collab` `mcp` `acp` `plugins` `media` `voice` `music` `spaces` | 各自子系统 |
| `ipc.<domain>` `server.http` `server.<domain>` `daemon` `gateway.<channel>` | 宿主 |
| `renderer.<store|component|service>` | renderer,由桥接层自动加 `renderer.` 前缀 |
| `console` | LegacyConsoleSink 抓到的未迁移输出(迁移期临时) |
| `process` | crash hooks / warning |

### 2.3 等级语义与开关

| 级 | 含义 | 默认 |
|---|---|---|
| trace | 每 chunk / 每 delta / 每 EventBus 扇出 | 关 |
| debug | 每请求 / 每 tool call 的形状、决策 | 关 |
| info | 生命周期节点:会话开始/结束、请求开始/结束、插件加载、宿主 listen | 开(文件) |
| warn | 可恢复异常、降级、重试 | 开 |
| error | 失败但进程继续 | 开 |
| fatal | 进程要退了 | 开 |

单一开关 `ONETHING_LOG='<default>[,<ns-glob>=<level>]*'`,例:`ONETHING_LOG=info,engine.*=debug,providers.deepseek=trace`。它**替代**现有 8 个 debug 开关(`ONETHING_DEBUG_STREAM` 等映射为别名一个版本后删除)。renderer 侧同一 spec 由主进程下发(`log:config`)+ localStorage 覆写(`onething:log`)。是否在设置页暴露 → 拍板点 E。

### 2.4 三类东西的归属(P6)

| 类 | 归属 | 生命周期 | 例 |
|---|---|---|---|
| **诊断日志** | `log/` 目录,`LogDirJanitor` 唯一治理者 | 轮转 + 保留天数 + **目录总量上限**(建议 512MiB) | app.jsonl、server.jsonl、daemon.jsonl、dev.log |
| **事件账本** | 所有者目录,随所有者删 | 会话删则删;`usage` 按月;不进 janitor | `sessions/<id>/events.jsonl`、`collab/<room>/actors/scheduler-log-*.jsonl`、`usage/*.jsonl` |
| **调试转储** | `log/dumps/<kind>/`,默认**关** | 显式开 + 有界(条数/字节) | provider-requests、last-system-prompt(死写者,直接删) |

Janitor 一张表:

```ts
const LOG_DIR_POLICY = {
  'app':      { maxFileMiB: 8, maxArchives: 30, retentionDays: 14, gzip: true },
  'server':   { … }, 'daemon': { … }, 'dev': { … },
  'dumps/provider-requests': { retentionDays: 7, maxTotalMiB: 100, mode: 'delete-oldest' },
  '*':        { totalCapMiB: 512 }  // 目录总量,超了从最旧归档开始删
}
```

`log/agent-*.log`(log-monitor 插件)保持插件自管,但注册进 janitor 的"已知前缀"名单,不再互不知晓。

### 2.5 renderer 通路(P5)

- `packages/renderer/services/log.ts`:`getLogger(ns)` → `RendererLogHub`。Hub 三件事:①内存环 200 条(取代 crash-log 的 localStorage 环,崩溃 dump 仍可 `window.__onethingLog.dump()`)②dev 下 console echo(pretty)③按 16ms/50 条批量 `platformApi.appendLogs(records)`。
- 传输:electron `ipc 'log:append'`(新增到 `packages/shared/ipc/channels.ts`,走 §IPC 五步);web `POST /api/logs`。主进程 handler 直接喂根 logger,`ns` 加 `renderer.` 前缀,`src='renderer'`,`fields.webContentsId`。
- crash-log 的四路捕获保留,但改为 `hub.error('vue error', {componentChain, info}, err)`——**不再靠 console 顺带**;Vue warn 去重后 `warn` 一条,栈进 `fields.stack`,不再多行。这一项直接消掉 app.log 38% 的体积。
- Electron `console-message` 捕获保留为**兜底**:只抓 warn+ 且消息不是我方 hub 发出的(hub echo 时加 zero-width 前缀或走 `console.debug` 绕开)。→ 拍板点 C。
- `[object Object]` 问题随结构化传输自然消失。

### 2.7 追踪能力(trace):一次会话的一轮,从谁发起到模型回了什么

> 需求(2026-08-19 用户补充):某 session 的某一轮,要能追到是哪个 agent 回的、哪个 provider、哪个 model、回复内容、provider 的 response。

**这不是诊断日志的职责,是事件账本 + 消息账本的职责**;诊断日志只负责"带着同一组键",让三本账能 join。

#### 2.7.1 现状:三本账各记一半,没有共同的键

| 账本 | 已有 | 缺 |
|---|---|---|
| `sessions/<id>/events.jsonl` | `request/header`(provider/model/systemPromptHash/toolsHash,去重追加)、`request/start|end`(requestIndex/messageId/usage/stopReason)、`assistant/first-token`、`tool/call|result|audit` | **run 级标识**(一次发送=多次请求;重试/edit-resend/steer/resume 无法归组)、**agentId**、请求出错/中止/重试事件、provider 响应元数据(response id、实际 model、finish reason) |
| `sessions/<id>/messages.jsonl` | 助手消息 `provider/model/agentId/content/reasoning/toolCalls/steps(turnIndex,toolCallId)/usage` | 与 events 的 `requestIndex` 无显式引用(只有 messageId 松耦合);一个 run 内多轮请求的**逐轮**回复合并在一条消息里,靠 `steps.turnIndex` 间接还原 |
| `log/provider-requests/*.json.gz` | 完整请求正文 | 按时间戳命名、**无 sessionId/requestIndex**,无法从会话反查;**不记响应**;默认开且 1.1G(拍板 B 已定默认关) |
| `log/app.log` | — | 引擎/工具路径几乎不带 sessionId(28 行/全仓) |

#### 2.7.2 追踪键(correlation keys)——四层,处处一样

```
sessionId  →  runId  →  requestIndex  →  toolCallId
 会话         一次引擎执行      会话内单调递增        工具调用
              (send / retry /   (已有,events.jsonl
               edit-resend /     的 request/* 都用它)
               resume / steer-
               continuation /
               follow-up)
```

- `runId`:引擎每次开始执行生成的 uuid;**新增**。落在 ①每条 `request/*`、`tool/*` 事件的 `data.runId` ②助手消息 `ChatMessage.runId`(retry 产生的新助手消息带新 runId,旧的保留自己的)③诊断日志 `fields.runId` ④dump 文件名/元数据。
- `agentId`:落在新增的 `run/start` 事件(见下),不进 `request/header`(header 是去重信封,agent 切换必然换 provider/model 触发新 header,但语义上 agent 属于 run)。
- `requestIndex`、`toolCallId`、`messageId`:沿用现有。
- 诊断日志:agent-loop 入口处 `log.child({sessionId, runId, agentId})`,每轮请求再 `child({requestIndex})`,工具执行 `child({toolCallId})`——这就是 §2 P3 的落地点,L4 迁引擎/工具区时按此绑定。

#### 2.7.3 事件账本增补(需扩大 `SESSION_EVENT_TYPES`,该文件头注明"扩大需单独拍板"——本次连同拍板)

| 事件 | data | 何时 |
|---|---|---|
| `run/start` | `runId, kind: 'send'\|'retry'\|'edit-resend'\|'resume'\|'steer'\|'follow-up', agentId, triggerMessageId(用户消息), assistantMessageId` | 引擎开始一次执行 |
| `run/end` | `runId, outcome: 'completed'\|'aborted'\|'error', error?{name,message}` | 执行结束(任何路径) |
| `request/response` | `runId, requestIndex, messageId, providerResponseId?, responseModel?(provider 实际返回的 model 名), finishReason?, textChars, reasoningChars, toolCallIds[], textHash, textPreview(≤500)` | 一次 provider 请求的响应收齐后 |
| `request/error` | `runId, requestIndex, error{name,message,status?}, willRetry: boolean, attempt` | provider 请求失败(含 turn 级重试的每次) |
| 既有 `request/start|end`、`tool/*` | 各加 `runId` | — |

仍守四条铁律:只记时刻不记时长;正文只记指纹+预览(≤500),正文在别的账本;追加不截断。`request/response` 记的是**响应信封**,不是响应正文。

#### 2.7.4 正文在哪 + 存储预算(用真机数据算过)

**先算账**(2026-08-19 真机 `~/.onething`,408 个会话,12,999 次 provider 请求):

| 量 | 实测 | 含义 |
|---|---|---|
| 一次请求正文(raw) | 中位 **127KB**,最大 1.7MB;gz 后平均 89KB | 其中 system ~5KB、tools ~28KB、**其余全是历史消息**(中位 43 条) |
| 一次响应(模型输出:content+reasoning) | 平均 **0.6KB**,p95 1.4KB,最大 10KB | 模型真正"回"的东西极小 |
| 一条助手消息含工具结果 | 平均 6.8KB,p95 22KB,最大 876KB | 工具结果是输入不是输出,已在 messages.jsonl 的 steps 里 |
| `log/provider-requests/` | **1.1G** | 请求正文 × 12,999,每轮把整段历史重存一遍 = O(n²) |
| `sessions/*/messages.jsonl` | 345MB | 会话状态(工具结果占大头) |
| `sessions/*/events.jsonl` | 0.95MB | 信封账本极便宜(~2KB/会话) |

结论:**响应始终记是零成本(13k 次 × ~1KB ≈ 13MB);贵的是请求正文,而请求正文 95% 是别处已有的东西**——消息在 messages.jsonl、工具目录在 `request/tools`(已按指纹去重)、system prompt 只有 5KB 且会话内很少变。所以请求不该存正文,该存**配方**。

**落点**(全部在 `sessions/<id>/io/`,随会话删除,不进 janitor):

| 文件 | 每请求一行/一件 | 内容 | 默认 | 每 100 请求约 |
|---|---|---|---|---|
| `responses.jsonl` | 一行 | `{runId, requestIndex, messageId, providerResponseId?, responseModel?, finishReason?, usage, text, reasoning?, toolCalls[{id,name,argumentsRaw}], providerRaw?(仅非标准字段)}` —— **完整响应正文** | **始终** | ~100KB |
| `requests.jsonl` | 一行 | **配方**:`{runId, requestIndex, provider, model, systemPromptHash, toolsHash, messages:[{messageId, contentHash, role}], params:{temperature,…}}` —— 不含正文;`contentHash` 让"后来被编辑/compact 过"可检出(hash 不匹配=不能逐字复原,如实标出) | **始终** | ~300KB |
| `blobs/<sha256-16>` | 按内容寻址 | system prompt 全文(去重:同一 hash 只存一次;`turnContext` 尾块已在消息上,不重复) | 始终 | ~20KB |
| `dumps/<runId>-<n>.req.json.gz` | 一件 | provider 收到的**逐字**请求正文(排 provider 层 bug 用) | **诊断模式** | 8.9MB |

复原一次请求 = `requests.jsonl` 那行 + `blobs/<systemPromptHash>` + `events.jsonl` 里对应 `request/tools` + `messages.jsonl` 按 messageId 取正文并校 hash。这就是 `trace` 查询面的装配逻辑;逐字级别只有诊断模式才有,且如实区分"配方复原"与"逐字原件"。

**与 messages.jsonl 的重叠**只剩响应文本一份(≈0.6KB/条),接受。**不做**内容寻址去重到消息级——那是把 messages.jsonl 事件溯源化的前奏,本轮不碰。

**为什么是 jsonl 不是每请求一个文件**:响应 ~1KB,单文件 gzip 头开销比正文还大,且 100 个小文件对 Finder/备份不友好;`responses.jsonl` append-only 与 events.jsonl 同纪律,会话归档时整文件 gzip。

**上限**:每会话 `io/` 软上限 20MiB(`dumps/` 先删、`blobs/` 不删、两个 jsonl 不删——它们本身就小);全库有 `bun run trace:stats` 打印各会话 io 体积 top 20。

**存储对比**(13k 请求量级):现状 provider-requests 1.1G → 新方案默认态约 **55MB**(responses 13MB + requests 40MB + blobs 若干);诊断模式打开时才回到 GB 量级,并且随会话删、有上限。

**顺带发现(不属本文,记下)**:messages.jsonl 345MB 的大头是 steps 里的工具结果,`steps/toolCalls` 双存的旧异味(见 compact 回滚记忆)仍在——那是会话存储自己的账,后续单独处理。

#### 2.7.5 查询面

三个出口,一个实现(`packages/onething-runtime/src/sessions/trace.ts`,纯函数:读 events + messages + io 目录,按 runId 装配成树):

```
Session
└─ Run(runId, kind, agentId, trigger user msg, outcome, t0..t1)
   ├─ Request #k(provider, model, header hash, t_start, first-token, t_end, usage, finish, error/retry)
   │   ├─ response envelope(+ .res.json 正文可展开)
   │   └─ ToolCall(toolCallId, name, args, result preview, audit: effects/decision/asked/outcome)
   └─ Assistant message(messageId → content/reasoning/steps)
```

- CLI:`onething trace <sessionId> [--run <runId>|--last] [--json]`(daemon RPC 或直接读文件);
- HTTP:`GET /api/sessions/:id/trace[?run=]`(web 端与轨迹面板共用);
- 轨迹面板 `TrajectoryPanelContent.vue` 升级为按 Run 分组、可展开 response 正文——**不新造组件**,在现有 `trajectory-projection.ts` 上加 run 分组投影。
- 诊断日志侧:`bun run log:tail --session <id> --run <runId>` 过滤 `app.jsonl`(fields 匹配),把同一 run 的 warn/error 与账本树并排。


### 2.6 迁移期的兼容与量化

- `LegacyConsoleSink`:保留现有 console 劫持,但记录 `ns='console'` + `fields.callsite`(从 stack 取一帧)。它给出的是**尚未迁移的日志流量**,可按 callsite 排序,指导 L4 迁移顺序。
- `bun run log:gate`(新增,`scripts/log-gate.mjs`,同 ui-gate/boundary-gate 棘轮):统计非测试源码中的 `console.*` 调用点,基线 = 当前 831;只允许下降。CLI stdout 用途改走 `stdout()` 助手(`apps/electron/src/main/cli/stdout.ts`),不计入。
- ESLint `no-console` 在迁移完成的目录逐个开 `error`(L4 每迁一区开一区);`scripts/` 与 `cli/stdout.ts` 白名单。

---

## 3. 分期总览

| 期 | 名 | 交付 | 依赖 | 门(代理可自证) |
|---|---|---|---|---|
| **L0** | 内核 | `packages/core/logging/`:Logger/LogRecord/LevelFilter/ConsoleSink(pretty+json)/MemoryRingSink/`getLogger`;8 个 `Core*Logger` 接口改为 `Logger` 的结构子集(不改调用方) | — | 单测:级别过滤 spec 解析、child 字段合并、err 归一化;architecture-boundaries 测试通过(core 零依赖) |
| **L1** | 装配 | `app/logging` 重写为 `configureLogging`;`RollingFileLogger`→`JsonlFileSink`;`LegacyConsoleSink`;`installProcessCrashHooks`;`LogDirJanitor` + 策略表;`ONETHING_LOG` 解析;`log:gate` 脚本 + 基线 | L0 | 单测(sink 轮转/janitor 表/总量上限);`bun run log:gate` 绿;boundary 绿;真机脚本:起 electron 30s 后 `app.jsonl` 每行 `JSON.parse` 成功且含 `ns/level/time` |
| **L2** | 宿主 | server:`configureLogging` + `server.http` 请求日志中间件 + crash hooks + `POST /api/logs`;daemon:同上,`daemon.log`→`daemon.jsonl` 走 sink;gateway:构造注入 Logger,27 处 console 迁移;electron:`ipc 'log:append'` handler + console-message 降级 | L1 | 脚本:起 server 打 3 个请求(200/404/500),`server.jsonl` 出现 3 条 `ns=server.http` 且 status 字段正确;`unhandledRejection` 注入测试落一条 `fatal/error`;gateway 目录 `console.*`=0 |
| **L3** | renderer | `services/log.ts` + `RendererLogHub` + `platformApi.appendLogs`(electron/web 两实现);crash-log 改 producer;Vue warn 去重单行;`shouldDebugStream` 四份合一(读 `ONETHING_LOG` 下发) | L2 | 单测:批量/背压/环;真机脚本(playwright):触发一次 Vue warn + 一次 vue error,主进程 `app.jsonl` 各恰 1 条结构化记录,`[object Object]` 计数 0;`stores/chat.ts` 热路径 console=0 |
| **L4** | 调用点迁移 | 按区迁:engine/toolkit/agent-loop(绑 sessionId/messageId/toolCallId 子 logger,`tool-orchestrator` 透传删)→ ipc/ 各域 → stores/components → core 其余;每区迁完开 `no-console: error`;删 app `chat-logger.ts` 8 个死导出与 `last-system-prompt` 写者;`themes/index.ts:400/410`、`EvalsRunsView.vue:494`、`server/main.ts:53 pairing` 三处 dump 处置;collab 中文消息英文化(fields 承载细节);189 处静默 catch 中"值得留痕的"补 `debug` | L3 | `log:gate` 基线 831→≤50(剩余全在白名单);ESLint 绿;抽样:`sessions/*/events.jsonl` 之外的 engine 日志 100% 带 sessionId(脚本统计) |
| **T0** | 追踪键 | `runId` 生成于引擎执行入口并贯穿 agent-loop ctx;`ChatMessage.runId`;`SESSION_EVENT_TYPES` 增 `run/start|end`、`request/response|error`,既有事件加 `runId`;recorder 采集点补齐(响应收齐、错误/重试、run 结束) | L0(logger child 绑键)可并行 | 单测:一次含 2 轮工具循环 + 1 次重试的 run,events.jsonl 出现 1 run/start、3 request/start、1 request/error(willRetry)、3 request/response、1 run/end,全部同 runId;decode 老文件不报错 |
| **T1** | 正文账本 | `sessions/<id>/io/`:`responses.jsonl` 始终、`requests.jsonl`(配方)始终、`blobs/`(system 去重)始终、`dumps/*.req.json.gz` 诊断模式;`providers/request-dump.ts` 改写到此(删 `log/provider-requests` 路径与 `last-system-prompt`);每会话 20MiB 软上限(只删 dumps);会话删除级联;`trace:stats` | T0 | 单测:上限淘汰只删 dumps;删会话后 io/ 不残留;配方复原+hash 校验对被编辑消息如实标不匹配;真机脚本:发一条消息,`responses.jsonl` 多一行且 `textHash` 与 events `request/response` 一致、`requests.jsonl` 那行的 messageIds 与 messages.jsonl 对得上 |
| **T2** | 查询面 | `sessions/trace.ts` 装配树;CLI `onething trace`;`GET /api/sessions/:id/trace`;轨迹面板按 run 分组 + 展开 response;`log:tail --session --run` | T1、L1 | 单测:装配树对 T0 的样本会话输出固定快照;HTTP 200 + JSON schema;playwright:面板显示 run 节点数 = events 中 run/start 数 |
| **L5** | 目录治理收尾 | provider-requests 默认关、搬 `log/dumps/`、janitor 接管;`dev-with-logging.mjs` 只记 runner/stderr,不再复刻主进程 stdout(主进程自己写 app.jsonl);删 `log/memory/`;旧 8 个 `ONETHING_DEBUG_*` 别名一个版本后删;文档:`docs/design/logging-system-2026-08.md` §7 落地记录 + CLAUDE.md 一段 | L1 | 脚本:构造超 512MiB 的假 `log/`,跑 janitor 一轮后 ≤ 上限且账本目录未被碰;`dev.log` 与 `app.jsonl` 零重叠(同一 msg 计数) |

L0–L1 可一天;L2/L3 各半天;L4 是量最大的一期(~800 处),按区派 opus 并行,Fable 只做 review;L5 半天。**T0–T2 独立于 L2–L4,可在 L0 后立刻并行开工**——追踪能力是用户明确要的,优先级排在 L4 前。

派工原则(见记忆 `feedback_delegate_repetitive_to_opus`):L0/L1/L2 骨架由 Fable 定形状、opus 实现;L4 的逐文件迁移全部 opus,每区一个 agent,门是 `log:gate` 数字 + ESLint。

---

## 4. 明确不做

- 不引第三方日志库(pino/electron-log):体量不值,且 core 零依赖红线;自建 ~400 行足够。
- 不做远程上报/采集后端:单用户桌面产品,文件 + 内存环 + `dump()` 够用。
- 不动事件账本(`events.jsonl`/scheduler-log/usage)的格式和写者——它们是产品数据,已有各自设计文档;本文只把它们**从"日志"里正名出去**,并明确不进 janitor。
- 不在本轮做"日志查看面板"UI:先把数据做对;面板是后续 workspace panel 的候选(现有 log-monitor 插件的 `logs` panel 可先接 `app.jsonl`)。

---

## 5. 风险

| 风险 | 缓解 |
|---|---|
| console 劫持一撤,漏掉某处仍在 console.log 的关键错误 | L1–L4 期间 LegacyConsoleSink 一直在,`ns=console` 流量看得见;直到 gate ≤50 再考虑撤 |
| renderer 批量传输在崩溃瞬间丢尾巴 | 内存环 + `beforeunload` flush + crash 路径同步 `sendSync`(仅 fatal) |
| JSONL 文件人眼不友好 | `bun run log:tail`(pretty 渲染 `app.jsonl`,支持 `--ns engine.*`);dev 终端本来就是 pretty |
| L4 量大、机械改动引入语义变化(把 warn 改成 info 之类) | 每区迁移规则写死:级别按 §2.3 表映射(`console.log`→大多 debug,少数生命周期→info),PR 附映射统计;review 只看映射表偏差 |
| server 单文件 bundle 的 TLA/动态 import 坑(见 toolkit 记忆) | `core/logging` 只静态导出,无顶层 await |

---

## 6. 待拍板的行为点

以下每项都是用户可感知的变化,列出选项,括号内是我的推荐。**2026-08-19 拍板结果**:A=②JSONL、B=②默认关、C=②warn+ 兜底、E=②设置页加"诊断模式"(一个开关 = debug 全开 + dump 开;env `ONETHING_LOG` 仍存在作为精细控制,不再是 E①的"只 env")。D/F/G 未单独拍板,按推荐执行(均为开发期/代码卫生项,不改用户可见行为);如有异议在 L5/L4 前提出。

| # | 问题 | 选项 |
|---|---|---|
| **A** | 文件格式 | ①`app.log` 保持文本格式不变 ②改 **JSONL**(`app.jsonl`),提供 `log:tail` pretty 查看(**推荐②**;文本行是 `[object Object]` 和多行栈的根源) |
| **B** | provider 请求正文 dump | ①保持默认开 ②**默认关**,`ONETHING_LOG=providers.dump=debug` 或设置里"诊断模式"打开,且有界(**推荐②**;真机 1.1G,含全部 prompt 正文) |
| **C** | Electron `console-message` 捕获 | ①保持全量抓 ②降级为 warn+ 兜底(**推荐②**)③全删,只信 hub |
| **D** | `dev.log` | ①保持(与 app 重复)②只记 runner/stderr,主进程输出只在 `app.jsonl`(**推荐②**)③删掉 dev-with-logging 的文件写入,dev 时全靠终端 |
| **E** | 等级开关的暴露面 | ①只有 env `ONETHING_LOG` + renderer localStorage(**推荐①**,符合"设置极简")②设置页加一个"诊断模式"开关(=`debug` 全开 + dump 开)③二者都有 |
| **F** | `no-console` 收口力度 | ①棘轮 gate 只降不升 + 迁完的目录开 ESLint error(**推荐①**)②全仓一次性 error,未迁的用 eslint-disable 标注 |
| **H** | 逐轮 provider 响应/请求正文 | **已按 §2.7.4 算账后定**:响应正文始终记(`io/responses.jsonl`,~1KB/次)、请求存配方不存正文(`io/requests.jsonl`+`blobs/`)、逐字请求正文只在诊断模式(`io/dumps/`)。用户 2026-08-19 关切=空间占用,§2.7.4 给出 1.1G→~55MB 的对比 |
| **G** | 静默 catch 189 处 | ①不动 ②逐处判定,值得留痕的补 `debug`(**推荐②**,L4 顺手,不改控制流)③全部补 |
