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
| `renderer.perf` | 渲染/切换/首屏计时(debug)。**横切面**:chat store / sessions store / App / MessageList / ChatPanel / 两个 Streaming 组件都往里写 —— 按 store 或 component 拆开就没法一句 `renderer.perf=debug` 全开(L4 区 ③b 提出,§9.2 采纳) |
| `app.backend` `app.events` | 装配层自身的生命周期(`createOnethingBackend`、事件系统起停) |
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

单一开关 `ONETHING_LOG='<default>[,<ns-glob>=<level>]*'`,例:`ONETHING_LOG=info,engine.*=debug,providers.deepseek=trace`。它**替代**现有 8 个 debug 开关(`ONETHING_DEBUG_STREAM` 等映射为别名一个版本后删除)。renderer 侧同一 spec 由主进程下发(落地是 RPC 域 `logs.config`,不是手写通道 `log:config`;见 §10.1)+ localStorage 覆写(`onething:log`,优先级更高)。是否在设置页暴露 → 拍板点 E。

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
| **L4** | 调用点迁移 | 按区迁:engine/toolkit/agent-loop(绑 sessionId/messageId/toolCallId 子 logger,`tool-orchestrator` 透传删)→ ipc/ 各域 → stores/components → core 其余;每区迁完开 `no-console: error`;~~删 app `chat-logger.ts` 8 个死导出与 `last-system-prompt` 写者~~(顺延到 L5-lite,见 §10.2);`themes/index.ts:400/410`、`EvalsRunsView.vue:494`、`server/main.ts:53 pairing` 三处 dump 处置;collab 中文消息英文化(fields 承载细节);189 处静默 catch 中"值得留痕的"补 `debug` | L3 | `log:gate` 基线 831→≤50(剩余全在白名单);ESLint 绿;抽样:`sessions/*/events.jsonl` 之外的 engine 日志 100% 带 sessionId(脚本统计) |
| **T0** | 追踪键 | `runId` 生成于引擎执行入口并贯穿 agent-loop ctx;`ChatMessage.runId`;`SESSION_EVENT_TYPES` 增 `run/start|end`、`request/response|error`,既有事件加 `runId`;recorder 采集点补齐(响应收齐、错误/重试、run 结束) | L0(logger child 绑键)可并行 | 单测:一次含 2 轮工具循环 + 1 次重试的 run,events.jsonl 出现 1 run/start、3 request/start、1 request/error(willRetry)、3 request/response、1 run/end,全部同 runId;decode 老文件不报错 |
| **T1** | 正文账本 | `sessions/<id>/io/`:`responses.jsonl` 始终、`requests.jsonl`(配方)始终、`blobs/`(system 去重)始终、`dumps/*.req.json.gz` 诊断模式;`providers/request-dump.ts` 改写到此(删 `log/provider-requests` 路径与 `last-system-prompt`);每会话 20MiB 软上限(只删 dumps);会话删除级联;`trace:stats` | T0 | 单测:上限淘汰只删 dumps;删会话后 io/ 不残留;配方复原+hash 校验对被编辑消息如实标不匹配;真机脚本:发一条消息,`responses.jsonl` 多一行且 `textHash` 与 events `request/response` 一致、`requests.jsonl` 那行的 messageIds 与 messages.jsonl 对得上 |
| **T2** | 查询面 | `sessions/trace.ts` 装配树;CLI `onething trace`;`GET /api/sessions/:id/trace`;轨迹面板按 run 分组 + 展开 response;`log:tail --session --run` | T1、L1 | 单测:装配树对 T0 的样本会话输出固定快照;HTTP 200 + JSON schema;playwright:面板显示 run 节点数 = events 中 run/start 数 |
| **L5** | 目录治理收尾(**渲染侧 spec 下发 + 死码清除已先行落地,见 §10**) | provider-requests 默认关、搬 `log/dumps/`、janitor 接管;`dev-with-logging.mjs` 只记 runner/stderr,不再复刻主进程 stdout(主进程自己写 app.jsonl);删 `log/memory/`;旧 8 个 `ONETHING_DEBUG_*` 别名一个版本后删;文档:`docs/design/logging-system-2026-08.md` §7 落地记录 + CLAUDE.md 一段 | L1 | 脚本:构造超 512MiB 的假 `log/`,跑 janitor 一轮后 ≤ 上限且账本目录未被碰;`dev.log` 与 `app.jsonl` 零重叠(同一 msg 计数) |

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

---

## 7. L0/L1 落地记录(2026-08-20)

> 状态:**L0 + L1 已实施**(未提交)。L2 的 server 那半(`configureLogging` + 请求日志
> 中间件 + crash hooks)顺手一起落了 —— 它是"日志系统有没有第二个宿主"的最小证明;
> daemon / gateway / renderer(L3)/ 调用点迁移(L4)未动。

### 7.1 落了什么

| 层 | 件 | 位置 |
|---|---|---|
| L0 内核(零依赖、零 node import) | `Logger` / `LogRecord` / `LogSource`、`LevelFilter` + `parseLogLevelSpec`、`LoggerRoot` + `createLogger`、`normalizeError` / `safeStringify`、`ConsoleSink(pretty\|json)` / `MemoryRingSink` / `JsonlFileSink`(接口)/ `formatJsonLine` / `formatPretty` | `packages/core/logging/{types,level,error,logger,sinks,index}.ts` |
| L1 装配 | `configureLogging()`(唯一接线点,幂等)、`getLogger(ns)`、`setLogLevelSpec()`、`writeAppLog`(兼容别名)、`initializeAppLogging`(旧名别名)、`dumpRecentLogRecords()` | `packages/onething-runtime/src/app/logging/index.ts` |
| | `JsonlFileSink`(轮转/gzip/保留期复用 `RollingFileLogger`,写 `app.jsonl`) | `.../logging/jsonl-file-sink.ts` |
| | `LegacyConsoleSink`(console + stdout/stderr 劫持 → `ns='console'`) | `.../logging/legacy-console-sink.ts` |
| | `installProcessCrashHooks` | `.../logging/crash-hooks.ts` |
| | `LogDirJanitor` + `LOG_DIR_POLICY` | `.../logging/janitor.ts` |
| | 诊断模式 `applyDiagnosticsMode` | `.../logging/diagnostics.ts` |
| 宿主 | Electron:`configureLogging({src:'main'})`;renderer 兜底降级为 warn+ 且结构化 | `apps/electron/src/app/main-process.ts`、`apps/electron/src/logging/console-capture.ts` |
| | server:`configureLogging({fileBaseName:'server',src:'server'})` + `server.http` 访问日志 | `apps/server/src/main.ts`、`packages/onething-runtime/src/app/server/http.ts` |
| 工具 | `log:check` / `log:gate`(棘轮,基线 854)/ `log:tail`(pretty 跟随)/ `log:smoke`(真机门) | `scripts/log-{check,gate,tail,smoke}.mjs` |
| 设置 | `AppSettings.diagnostics.enabled`(默认 false)+ 设置页 General → Diagnostics 一行开关 | `packages/shared/ipc/settings.ts`、`packages/shared/defaults/settings.ts`、`GeneralSettingsTab.vue` |

`RollingFileLogger` 只加了两处:`extension` 选项(`log` / `jsonl`,归档识别与压缩跟着走)与
`writeLine(line)`(落一行已经成形的文本)。旧的文本 `log()` 路径原样保留 —— `dev.log`
与迁移期的调用点还在用。

### 7.2 拍板项的落法

- **A(JSONL)**:`app.jsonl` / `server.jsonl`,一行一条 `LogRecord`;归档
  `app-<ts>-nnn-<reason>.jsonl.gz`。`bun run log:tail` 是人眼那一侧的补偿。
- **B(dump 默认关)**:`shouldDumpOnethingProviderRequests` 改为 opt-in ——
  `ONETHING_DUMP_PROVIDER_REQUESTS=1` 或诊断模式;目录搬到 `log/dumps/provider-requests/`,
  由 janitor 按 7 天 / 100MiB 治理(它自己那套"只压不删"的 100MiB 预算留着,作为
  进程内的第一道刹车)。
- **C(console-message 降级)**:只抓 warn+;元数据进 `fields`;多行 Vue warn 折成
  **一条**记录,首行是 `msg`,其余进 `fields.stack`。
- **D(dev.log)**:`scripts/dev-with-logging.mjs` 不再复刻主进程 stdout,只留
  runner 与 stderr —— 主进程自己写 `app.jsonl`。
- **E(诊断模式)**:设置页一个开关 = 全域 `debug` + dump 开;关掉回到 env
  `ONETHING_LOG` 给的 spec(不是硬编码 `info` —— 开着 `ONETHING_LOG=engine.*=debug`
  跑的人不该因为关掉诊断模式就丢掉它)。生效点两个:`createOnethingBackend` 读完
  settings 的第一时间、以及 `app/stores/settings.ts` 的两条保存路。
- **F(no-console 棘轮)**:`bun run log:gate`,基线
  `docs/audit/log-gate-baseline-2026-08-20.txt` = **854** 条(口径见 `log-check.mjs`
  头注;与盘点的 831 差在扫描范围)。CLI 产品输出口 `apps/electron/src/main/cli/stdout.ts`
  与 `scripts/` 在白名单外/内,不计数。

### 7.3 与设计文本的两处偏差(有意)

1. **未捕获异常默认走 `uncaughtExceptionMonitor`,不是 `uncaughtException`**。
   装 `uncaughtException` 监听等于**接管** Node 的默认行为(打栈 + 退出码 1),
   那是用户可感知的变化,不该由日志改造顺手做掉。monitor 一样能在进程死之前
   fatal 一条 + `flushSync`,而崩溃语义逐字不变。需要接管的宿主显式传
   `uncaughtException: 'handle'`(那条路测过:fatal → flush → 打栈 → `exit(1)`)。
2. **server 的 `configureLogging` 在 runtime 装配之后调用**。store 根
   (`ONETHING_STORE_PATH`)是在 `createRealServerBackend` 里钉死的,提前接线会把
   `server.jsonl` 写进另一个 store 的 `log/`。代价:装配期那几行 console 只进内存环,
   不落盘(真机门实测 `server.jsonl` 12 行,全是 listen 之后的)。

### 7.4 门(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | 3 red,全部是既有的 `spaces/__tests__/provider-dials.test.ts`(中途另有 2 条来自并行的会话批,已由那一批自己修掉) |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 1128 文件通过 / 1 失败:`ui-token-vars.test.ts` ×2 + `AIProviderTab.interaction.test.ts` 的 unhandled rejection —— 与本批前的既有红逐条相同 |
| `bun run boundary:gate` | ok — 13 known, none new |
| `bun run session:gate` | ok — 0 |
| `bun run lint:ci` | 334 problems(128 errors / 206 warnings),与基线一致 |
| `bun run log:gate` | ok — 854 known, none new |
| `bun run server:build` + 真机 `bun run log:smoke` | 9/9 通过:3 条 `server.http`(200/404/500 逐条对上)、每行 JSON.parse 成功且带 time/level/ns、`[object Object]` = 0、默认无 dump 目录 |
| `bun run build`(electron) | ok |

真机脚本全程 `ONETHING_STORE_PATH` 指向 `mkdtemp` 出来的临时目录,**没有碰过
`~/.onething`**。

### 7.5 留给后续期的尾巴

- `writeAppLog` 的 8 个调用点仍是"source 当 ns"的形状(L4 顺手改成 `getLogger`)。
- `RollingFileLogger` 的文本 `log()` 路径要等 `dev.log` 也结构化之后才能删。
- janitor 的"已知前缀"名单里 `agent-*` 只被认得、不被治理(插件自管,§2.4)。
- renderer 仍然只有 `console-message` 兜底,没有自己的 hub —— 那是 L3。
- `log/memory/` 空目录残留、8 个 `ONETHING_DEBUG_*` 别名未删 —— L5。

---

## 7.4 L2/L3 落地记录(2026-08-20)

> 状态:**L2 剩余(gateway + daemon)与 L3(renderer)已实施**(未提交)。
> L2 的 server 半边在 L0/L1 那批已落(§7.1);L4(调用点迁移)与 L5(目录收尾)未动。

### 7.4.1 落了什么

| 期 | 件 | 位置 |
|---|---|---|
| L3 renderer | `RendererLogHub`:内存环 200 / dev pretty 回显 / 16ms·50 条批量上行 / `beforeunload` + `fatal` 立即冲刷 / 背压丢最旧并计数;`getLogger(ns)`、`installRendererLogging()`、`window.__onethingLog` | `packages/renderer/services/log.ts` |
| | 上行契约(域 + 记录形状 + 批量上限 + 回声标记) | `packages/shared/ipc/logs.ts` |
| | 收方 handler(ns 前缀 / `src` / 调用者盖章 / 校验 / 背压留痕) | `packages/onething-runtime/src/app/rpc/domains/logs.ts`(名册第一格 `rpc:logs`) |
| | 渲染侧客户端(壳外一个模块,四壳零改动) | `packages/renderer/platform/logs-client.ts` |
| | crash-log 改 producer:四路捕获照旧,出口换成 hub;Vue warn 去重后**一条** `warn`,栈进 `fields.stack`;零 console | `packages/renderer/services/crash-log.ts` |
| | hub 先于崩溃捕获装 | `packages/renderer/main.ts` |
| | `console-message` 兜底认自己的回声并丢弃 | `apps/electron/src/logging/console-capture.ts` |
| L2 gateway | 构造时注入 + 进程级工厂 + 内核 `ConsoleSink` 兜底;`startGateway({ getLogger })` | `packages/gateway/src/core/logging.ts`、`index.ts` |
| | 28 处裸 console → `gateway.{bridge,permission,storage,wechat,wechat.auth,wechat.poller,wechat.sender,telegram}` | gateway 全树 |
| | Electron 宿主把自己的 `getLogger` 传进去 | `apps/electron/src/{gateway/lifecycle-controller.ts,app/main-process.ts}` |
| L2 daemon | `configureDaemonLogging()` → `daemon.jsonl` + janitor + crash hooks;spawn 只重定向 stderr;`daemon logs` 优先读 jsonl | `apps/electron/src/main/cli/{daemon-server,daemon-client,paths,index}.ts` |
| 顺手修 | `LoggerRoot.src` 改为**可变**并在写入时读取 —— `configureLogging({src})` 从前只喂了 `LegacyConsoleSink`,根 logger 一直是 `main`,`server.jsonl` / `daemon.jsonl` 里的 `src` 是假的 | `packages/core/logging/logger.ts`、`app/logging/index.ts` |

### 7.4.2 与设计文本的偏差(有意,各有理由)

1. **传输不是 `ipc 'log:append'` + `POST /api/logs`,是 RPC 域 `logs`。**
   §2.5 写的是通道级说法。手写通道要同时改 `channels.ts` / preload / `@main` handler /
   `web.ts` —— 而那四枚正是 `transport:gate` 的计量面(本仓已经因为别处的手写通道
   预红)。RPC 域是「一个 router 文件 + 一个 handler 文件 + 名册一行,四壳零改动」,
   还白拿 web 平价:server 的 `/api/rpc` 与其它路由共用同一道 Bearer 闸(真机脚本
   实测无 token = 401)。代价:方法不挂在 `platformApi` 上,调用点引
   `platform/logs-client`;这与 E1 判例(`session-events-client` 等六个域)同形。
2. **`fields.webContentsId` 换成 `fields.transport`(+ http 面的 `ownerUid`/`workspaceId`)。**
   `RpcDispatchContext` 不带 webContents id,而给它加字段是「待拍板:RpcRequest 加
   context 字段」那条线上的事,不该由日志改造顺手拍。现在盖的章仍然全部来自**宿主
   适配器**、不读信封 —— 这一条比 id 本身更重要。
3. **`fatal` / `beforeunload` 是「立即发起」,不是「保证送达」。** §5 的缓解写的是
   `sendSync`,但渲染侧没有同步出口(`rpcInvoke` 是 Promise)。实现做到的是:队列
   不等窗口、`send()` **同步调用**(不裹微任务)。如实写在文件头,不假装有同步通道。
4. **Vue warn 的去重是彻底的**:重复的 warn 既不进环、也不再发第二条记录。原文本只
   说「去重后 warn 一条」;第 2..n 条一个字节的新信息都没有,而它正是 app.log 38%
   体积的来源。
5. **`shouldDebugStream` 四份合一未做**(L3 交付栏里的第四项)。它是四个
   `ONETHING_DEBUG_*` 开关的合并,与 §7.5 里「旧别名一个版本后删」同属 L5 的收尾,
   放在那一批一起做更省事。本批只保证新代码不再新增开关。

### 7.4.3 门(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | 3 red,全部是既有的 `spaces/__tests__/provider-dials.test.ts`(node 面);web 面全绿 |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 1135 文件通过 / 1 失败:`ui-token-vars.test.ts` ×2 —— 与本批前的既有红逐条相同 |
| `bun run boundary:gate` | ok — 13 known, none new |
| `bun run session:gate` | ok — 0 |
| `bun run log:gate` | ok — **822**(L1 基线 854;gateway 28 + crash-log 4 已消,hub 的 3 处 dev 回显是新增)。基线文件仍是 854 —— 落库那一批再重录(棘轮脚本要求基线与状态同批) |
| `bun run ui:gate` | ok — 81 known, none new |
| `bun run lint:ci` | 404(128 errors / 276 warnings);**本批新增 0**,+70 全在并行会话批的 `TrajectoryPanelContent.vue` |
| `bun run transport:gate` | 5 个指标预红 —— 本批贡献 **0**(四枚计量壳一行未动;stash 到 HEAD 复测同样 5 红) |
| `bun run server:build` + `node scripts/log-smoke.mjs` | 16/16:原有 9 条 + L3 新增 7 条(append 200、3 条 accepted、无 token 401、3 条 `renderer.*`、逐条 `src='renderer'`、ns 前缀正确、err 归一化保住) |
| `bun run build`(electron) | ok |

真机脚本全程 `ONETHING_STORE_PATH` 指向 `mkdtemp` 出来的临时目录,**没有碰过 `~/.onething`**。

### 7.4.4 留给后续期的尾巴

- `log:gate` 基线未重录(见上)。
- renderer 的 `console.*` 存量(hub 之外)仍在,`stores/chat.ts` 热路径未清 —— L4。
- `shouldDebugStream` 四份合一、8 个 `ONETHING_DEBUG_*` 别名 —— L5。
- `daemon.log` 仍在(只接配置前的 stderr);等 daemon 稳定跑一版后可以整只删。
- gateway 的等级映射按 §2.3 直译(`console.log`→`info` 的两处是生命周期节点,
  `console.warn/error` 原样),唯一改级的是微信入站身份转储 `info`→`debug` ——
  它是每条消息都打的形状转储,按 §2.3 就该是 debug。

---

## 8. L4 迁移规则(2026-08-20,派工前定死)

目标:非测试源码 `console.*` 调用点 822 → ≤ 50(白名单:`scripts/`、`apps/electron/src/main/cli/stdout.ts`、`LegacyConsoleSink` 自身、少数必须直写 stderr 的启动期 FATAL)。迁完的目录开 ESLint `no-console: error`。

### 8.1 等级映射(机械规则,偏差必须在 PR 里逐条列)
| 今天 | 迁到 | 说明 |
|---|---|---|
| `console.error(msg, err)` | `log.error(msg, fields?, err)` | err 走 `err` 字段,不拼进 msg |
| `console.warn` | `log.warn` | |
| `console.info` | `log.info` | |
| `console.log` — 生命周期节点(启动/监听/加载完成/会话开始结束/插件装载) | `log.info` | |
| `console.log` — 每请求/每 tool call 的形状与决策 | `log.debug` | |
| `console.log` — 每 chunk / 每 delta / EventBus 扇出 / Perf 逐帧 | `log.trace` | |
| `console.debug` | `log.debug` | |
| 门控在 `ONETHING_DEBUG_*` / `shouldDebugStream()` / `VITE_DEBUG_*` / localStorage debug 之后的 | 去掉门控,直接 `log.trace`/`debug`(等级过滤取代开关);开关常量保留一个版本作别名(L5 删) | `shouldDebugStream` 四份在此合一为 `ONETHING_LOG` 的 `engine.stream=trace` 别名 |
| 静默 `catch {}` 中值得留痕的 | 补一行 `log.debug('…swallowed', {reason}, err)` | 不改控制流;明显无意义的(如 JSON.parse 探测)不补 |

### 8.2 命名空间与字段
- `ns` 按 §2.2 表:文件所在模块 → 前缀;模块级 `const log = getLogger('engine.stream')`;会话/run/请求/工具上下文用 `log.child({sessionId, runId, requestIndex, toolCallId})` 绑一次。
- `msg` 固定短句英文、不拼变量;变量进 `fields`;老的 `[Tag]` 前缀**删除**(ns 取代)。
- 中文消息(collab 28 条)改英文短句,细节进 fields。
- 不允许 `log.info(JSON.stringify(x))`;传对象。

### 8.3 分区与所有权(三区并行,文件不相交)
| 区 | 范围 | `getLogger` 来源 |
|---|---|---|
| ① core + runtime 产品层 | `packages/core/**`、`packages/onething-runtime/src/**`(不含 `src/app`) | core:`@onething/core/logging` 的 `createLogger` 需要 root——core 不持有全局 root,**core 模块通过注入的 `logger?: Logger` 参数/选项拿**(已有 8 个 `Core*Logger` 鸭子接口统一为 `Logger`),缺省 `noopLogger`;runtime 产品层同样注入或从 `@onething/runtime/logging`(新增薄模块,持有可被 app 层 `configureLogging` 设置的 root)取 `getLogger(ns)` |
| ② app 装配层 + server 壳 | `packages/onething-runtime/src/app/**`、`apps/server/src/**` | `@onething/app/logging` `getLogger` |
| ③ Electron 宿主 + renderer | `apps/electron/src/**`(除 cli/stdout.ts)、`packages/renderer/**` | 主进程 `@onething/app/logging`;renderer `@/services/log` |

### 8.4 门
每区:`log:check` 该区归零(白名单外);该区目录 ESLint `no-console: error` 开启且 `lint:ci` 错误数不增;`bun run test` 全量;真机 smoke(`log:smoke`)仍绿;每区附映射表(文件 → 迁入 ns、等级偏差清单)。

---

## 9. L4 落地记录(2026-08-20)

> 四区并行,文件不相交(§8.3)。每区一节 §9.x,只写自己那一格。

### 9.1 区 ① — core + runtime 产品层(`packages/core/**`、`packages/shared/**`、`packages/onething-runtime/src/**` 不含 `src/app`)

迁前 `log:check` 该区 **192** 处,迁后 **0**(白名单为空 —— 本区没有一条必须直写 stderr
的启动期 FATAL)。`packages/shared/**` 本来就是纯契约,一条 console 都没有。
ESLint `no-console: 'error'` 已对该区三棵目录开启(`eslint.config.js` 的「区 ①」块;
`src/app/**` 与测试目录 ignore —— 前者是区 ② 自己的格子)。

#### 9.1.1 新增的两个件

| 件 | 位置 | 作用 |
|---|---|---|
| `CompatLogger` / `toLogger()` / `noopLogger` / `isLogger()` | `packages/core/logging/compat.ts` | core 里 14 个 `Core*Logger` 鸭子接口的**统一收口**:`CompatLogger = Logger \| LegacyDuckLogger`,`toLogger()` 把两者都收敛成 `Logger`,不给则 `noopLogger`(**不再默认 `console`**) |
| `configureCoreLogging()` / `getCoreLogger(ns)` | `packages/core/logging/port.ts` | core 的注入端口。core 仍然**不持有 root**(没有 sink、没有等级表),只有一个由装配层填进来的工厂;`getCoreLogger` 返回延迟绑定的 logger(core 模块几乎都在装配之前求值) |
| `getLogger(ns)` / `setRuntimeLoggerRoot(root)` / `captureRuntimeLogs()` | `packages/onething-runtime/src/logging/index.ts`(新;alias `@onething/runtime/logging` 已登记) | 产品层的门面。产品层不能 import `@onething/app`,所以持有一个**可被装配层替换**的 root;未接线时只挂一个 200 条内存环(不打 console、不污染测试输出) |

接线只有一句:`app/logging/index.ts` 的 `configureLogging()` 开头调
`setRuntimeLoggerRoot(root)`(放在幂等闸**之前** —— 嵌入式 server 第二次调用同样该指向
这一个 root)。`setRuntimeLoggerRoot` 自己再顺手 `configureCoreLogging({ getLogger })`,
所以 core 与产品层是**同一句话**接线的,宿主不必记住第二句。

#### 9.1.2 映射表(文件 → ns → 等级)

`packages/core`(全部走注入 / `getCoreLogger`):

| 文件 | ns | 迁入等级 |
|---|---|---|
| `events/event-bus.ts`(20) | `core.events` | emit / 扇出 → `trace`;subscribe / unsubscribe → `debug`;interceptor / handler 失败 → `error` |
| `permission/index.ts`(14) | `core.permission` | initialize / shutdown → `info`;ask / coalesce / respond → `debug`;其余 warn/error 原级 |
| `interaction/registry.ts`(11) | `core.interaction` | initialize / shutdown → `info`;ask → `debug`;deadline / 无 pending / 跨通道 → `warn` |
| `plugins/storage.ts`(14) | `core.plugins` | 原级(warn/error) |
| `plugins/loader.ts`(11) | `core.plugins` | 原级 |
| `plugins/store.ts`(3)、`plugins/storage-files.ts`(2)、`plugins/scheduler.ts`(1) | `core.plugins` | 原级 |
| `mcp/manager.ts`(8) | `core.mcp` | 生命周期 `console.log` → `info`;连接失败 → `error` |
| `storage/json-file.ts`(3) | `core.storage` | 原级 |
| `session/timeline.ts`(2) | `core.session` | 摘要元数据清空 → `warn`;contextSize 修复转储 → `debug` |
| `session/session-manager.ts`(1) | `core.session` | 自动建会话 → `debug` |
| `session/storage/json-message-page.ts`(1) | `core.session` | 原级 |
| `events/stream-channel.ts`(2) | `core.events` | 原级 |
| `engine/headless-stream-engine.ts`(2) | `core.engine` | `log()` → `debug`、`logError()` → `error`(两个 protected 助手的**函数体**换了出口,~40 个调用点一字未动) |
| `engine/context-compact.ts`(1) | `core.engine` | 原级 |

`packages/onething-runtime/src`(产品层,全部 `getLogger(ns)`):

| 文件 | ns | 迁入等级 |
|---|---|---|
| `skills/loader.ts`(21) | `skills` | 加载完成 / 目录创建 / 删除 → `info`;逐根、逐工程路径的转储 → `debug`;其余原级 |
| `themes/index.ts`(9) | `themes` | 初始化 / 自定义主题加载 → `info`;两条 neutral / primary 语义大转储 → `debug`(原来是**无条件** `console.log(JSON.stringify(…, null, 2))`,每次解析主题都打) |
| `themes/resolver.ts`(8)、`base46-parser.ts`(2)、`css-mapper.ts`(1) | `themes` | 原级 |
| `spaces/{credentials,persistence,provider-settings,overlay,store,notifications}.ts`(14) | `spaces` | 原级 |
| `project-dirs/{persistence,store}.ts`(6) | `projects` | 原级 |
| `agent-loop/providers/codex.ts`(6) | `providers.codex` | 每 delta / 每 SSE 事件 → `trace`;`streamTurn request` → `debug`;401 刷新 / OAuth 降级 → `warn` |
| `agent-loop/providers/deepseek.ts`(3) | `providers.deepseek` | 同上 |
| `acp/{client,manager}.ts`(7) | `acp` | 连上 → `info`;其余 `warn` |
| `evals/{snapshot,case-file}.ts`(5) | `evals` | 原级 |
| `toolkit/contract.ts`(2) | `toolkit.contract` | 原级 |
| `toolkit/families/process.ts`(1) | `toolkit.process` | 原级 |
| `media/media-library-service.ts`(2) | `media` | 原级 |
| `variables/{store,schema,registry}.ts`(3) | `variables` | 原级 |
| `stream-engine.ts`(1) | `engine.stream` | 关停 → `info` |
| `prompts/builder.ts`(1) | `engine.prompt` | 原级 |
| `music/reliable-runner.ts`(1) | `music` | `console.info` → **`debug`**(偏差,见下) |
| `auth/callback-server.ts`(1) | `auth` | 原级 |
| `agents/{store,profile}.ts`(2) | `agents` | 原级 |

#### 9.1.3 门控开关:去掉的三个,需要的三条别名

按 §8.1「去掉门控,等级过滤取代开关」,本区删掉三个 env 门(常量本身不再有读者):

| 旧开关 | 需要的 `ONETHING_LOG` 别名 | 状态 |
|---|---|---|
| `ONETHING_DEBUG_SKILLS=1` | `skills=debug` | ✅ 区 ② 的 `app/logging/legacy-debug-env.ts` 已落 |
| `ONETHING_DEBUG_STREAM=1` / `ONETHING_DEBUG_CODEX_STREAM=1` | `providers.codex=trace` | ✅ 同上(区 ② 落成 `providers.*=trace`,覆盖) |
| `ONETHING_DEBUG_STREAM=1` / `ONETHING_DEBUG_DEEPSEEK_STREAM=1` | `providers.deepseek=trace` | ✅ 同上 |
| `DEBUG=*skills*`(旧 skills 门的第二个入口) | `skills=debug` | ❌ 未覆盖 —— 它本来就是个野生约定,L5 直接删掉即可 |

两个 provider 里 `const debugStream = shouldDebugXxxStream()` 换成
`log.isLevelEnabled("trace")` —— **不是**把门控原样留着:它是等级检查,而且
deepseek 的 `lastDeltaAt`(算 delta 间隔用)本来就只在这条路上更新,换成等级检查
才能保住「gapMs 只在真的打的时候才有意义」这个语义,同时不给每条 delta 白算一次
`previewText`。`core/engine/event-only-emitter.ts` 里的 `options.debugStream` 同理换成
`log.isLevelEnabled('trace')`,选项字段标 `@deprecated` 留一个版本。

#### 9.1.4 与 §8 的偏差(逐条)

1. **core 的注入不是「每个模块一个 `logger?` 参数」,是一个进程级端口 `configureCoreLogging`。**
   §8.3 写的是「core 模块通过注入的 `logger?: Logger` 参数/选项拿」。有天然注入缝的
   地方照做了(`EventBus` 构造第二参 + `setLogger`、`Permission.setLogger`、
   `InteractionRegistry.setLogger`);但 core 里写日志的地方**绝大多数是自由函数**
   (`readPluginSettingsFile`、`repairSessionTimelineMetadata`、`writeJsonFile`…),
   没有构造函数也没有 options —— 给每个文件发明一个 `setXxxLogger()` 只是把同一个
   全局换了十几个名字。端口的边界仍然守住了 §8.3 的**实质**:core 不持有 root
   (没有 sink、没有等级表、没有 node import),只有一个装配层填进来的工厂;
   不填 = `noopLogger`。
2. **`music/reliable-runner.ts` 的 `console.info` 迁到 `debug` 而不是 `info`。**
   §8.1 的机械规则是 `console.info → log.info`。这一行是**每条 ncm 命令**都打的
   耗时探针(`[music:timing] … 312ms`),按 §2.3 的语义("每请求/每 tool call 的
   形状与决策")它就是 debug。
3. **`themes/index.ts` 的两条语义转储从「无条件 info」降到 `debug`。**
   同 2:它们是每次解析主题都打的整块 JSON,不是生命周期节点。
4. **14 个 `Core*Logger` 鸭子接口:类型统一了,消息文本没动。**
   14 个接口全部变成 `CompatLogger` 的 `@deprecated` 别名,注入点统一走
   `toLogger(...)`(默认 `noopLogger`,不再 `?? console`),方法名按 §8.1 映射
   (`log→debug` / `log?.()→debug()` / `warn?.()→warn()` / `error?.()→error()`)。
   **但这些调用点的 `msg` 仍然带着 `[Tag]` 前缀与内插变量** —— 它们本来就不是
   `console.*` 调用点(不在本区的 192 里),而 §8.2 的 msg 纪律在这里要连着改
   ~150 条断言字符串的测试(`api-builder.ts` 一个文件就 79 处)。为此
   `DuckLoggerAdapter` 特意做成**逐字兼容**:不加 ns 前缀、`err` 原样透传不归一化,
   所以过渡期注入 `console` / 测试替身 / 区 ② 的 `consolePort()` 收到的参数与迁移前
   一模一样。留给 L5:区 ② 把 `consolePort()` 换成直接传 `getLogger(ns)` 之后,
   这些 msg 连同 `[Tag]` 前缀一起结构化,`console-port.ts` 与 `compat.ts` 的鸭子那一半同时删。
5. **默认值从 `console` 变成 `noopLogger` 是可感知的:没人注入的调用点会静音。**
   这正是 §8.3「缺省 `noopLogger`」要的,而且区 ② 已经在所有装配层注入点喂了
   `consolePort(getLogger(ns))`,所以生产路径一条都没丢。代价记在这里,不藏。
6. **静默 catch 一条都没补。** §8.1 允许"值得留痕的补一行"。本区扫下来,静默
   catch 全是探测型(`JSON.parse` 试解析、`statSync` 探文件、`closeClient` 尽力而为),
   补了只会造噪音。

#### 9.1.5 测试侧的连带改动(本区文件)

`console.warn` 不再是这些告警的出口,所以 7 个测试文件的 `vi.spyOn(console, 'warn')`
换成断言**记录**:`captureRuntimeLogs()`(新,`runtime/logging`)把 root 换成一个只挂
内存环的临时 root,`ofLevel('warn')` 拿到结构化记录,断言从"消息里含某个子串"改成
"`fields.agentId === 'ghost'`"这种。涉及:`agents/__tests__/{profile,store}.test.ts`、
`spaces/__tests__/{credentials,credentials-encryption,notifications,overlay}.test.ts`、
`themes/__tests__/highlight-groups.test.ts`。

另有两个**区 ② 的**测试因为 `CompatLogger` 的 `(...args)` 推断(联合类型上的上下文
推断给不出参数类型)需要一处 `: unknown[]` 注解:
`app/mcp/__tests__/core-client-state.test.ts`、`app/plugins/__tests__/core-manager.test.ts`。

#### 9.1.6 门(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run log:check`(本区路径) | **0**(迁前 192) |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run typecheck` | 3 red,全部是既有的 `spaces/__tests__/provider-dials.test.ts` |
| `bun run lint:ci` | 334 problems(128 errors / 206 warnings)—— 与基线逐字相同,本区新增 0 |
| `bun run boundary:gate` | ok — 13 known, none new |
| `bun run session:gate` | ok — 0 |
| `bun run ui:gate` | ok — 81 known, none new |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 1136 文件通过 / 1 失败:`ui-token-vars.test.ts` ×2 + `AIProviderTab.interaction.test.ts` 的 unhandled rejection —— 与本批前的既有红逐条相同。(并行三区同树,整跑中途出现过 7 个文件红,逐个**单跑全绿** —— 并发抖动 + 别区在途,见 §9.1.7) |

#### 9.1.7 留给后续期 / 交给区 ② 的两条

- **`DEBUG=*skills*` 这个野生入口没有别名**(§9.1.3 表末行)—— L5 连同 `ONETHING_DEBUG_*` 一起删。
- **`app/{deeplink,providers}/__tests__` 有一个已知的脆弱点**(收尾时已绿,记在这里
  免得下次再查一遍):它们用 `collectLogRecordsForTests()`(区 ② 新加)去抓
  `createPluginAPI` 的拒绝理由,而 `load()` 里先 `vi.resetModules()` 再
  `await import('../../plugins/api.js')` —— 采集器是**静态** import 的
  `app/logging/index.js`,与 API 拿到的可能不是同一份模块实例(于是不是同一个 root)。
  稳妥的写法是把 `logging/index.js` 也放进 `load()` 的那批动态 import 里。
- **区 ② 的 `consolePort()` 是过渡件**:它换成直接传 `getLogger(ns)` 之后,
  `core/logging/compat.ts` 的鸭子那一半(`LegacyDuckLogger` / `DuckLoggerAdapter`)
  与 14 个 `@deprecated` 别名一起删,那批 `[Tag] msg` 也在同一批结构化。

### 9.2 区 ② — 装配层 + server 壳(`packages/onething-runtime/src/app/**`、`apps/server/src/**`)

迁前 `log:check` 该区 **245** 处,迁后 **4** —— 全部是 `apps/server/src/main.ts` 里
**接线之前**的启动期直写(白名单,逐条列在下面)。ESLint `no-console: 'error'` 已对
该区两棵目录开启(`eslint.config.js` 的「区 ②」块,测试目录 ignore)。

#### 9.2.1 命名空间映射(文件 → ns)

一条规则:**ns 从模块路径推**,`[Tag]` 前缀一律删除。117 个文件拿到模块级 logger,
落在 40 个命名空间上:

| ns | 文件(同 ns 多文件时列目录) |
|---|---|
| `app.backend` | `app/backend.ts` |
| `app.events` | `app/events/index.ts` |
| `engine.stream` | `app/engine/index.ts`、`stream-engine.ts`、`stream/{agent-loop-executor,agent-loop-runtime,provider-helpers,stream-executor}.ts` |
| `engine.stream.chat` | `app/engine/stream/chat-logger.ts`(请求起止 / 每轮计时) |
| `engine.stream.coalescer` | `app/events/stream-coalescer.ts` |
| `engine.stream.emitter` | `app/events/event-only-emitter.ts` |
| `engine.stream.image` | `app/engine/stream/{image-generation,image-stream}.ts` |
| `engine.history` | `app/engine/stream/{chat-logger,history-shadow,message-helpers}.ts` |
| `engine.compact` | `app/engine/context-compact.ts` |
| `engine.prompt` | `app/engine/prompt/plugin-context.ts` |
| `engine.triggers` | `app/engine/triggers/{session-toc,skill-review,turn-evaluation}.ts` |
| `toolkit` / `toolkit.runner` | `app/toolkit/{wiring,plugin-tools}.ts` / `app/engine/stream/{tool-orchestrator,tool-execution}.ts` |
| `sessions` | `app/stores/sessions.ts`、`app/session/{index,reads}.ts` |
| `sessions.events` | `app/session/{assistant-parts,event-log,event-stats,event-translator,prepare}.ts`、`app/engine/stream/session-event-recorder.ts` |
| `sessions.shadow` / `sessions.validation` / `sessions.toc` | `app/session/shadow.ts` / `app/session/validation.ts` / `app/toc/index.ts` |
| `collab.*` | 23 个文件 → `collab.{board,budget,digest,observability,identity,room,wake,runtime,scheduler,referee,actors.{agent,room,mind,turn}}` |
| `plugins.*` | 15 个文件 → `plugins`、`plugins.{health,loader,manager,market,sessions,log-monitor}` |
| `providers.*` | `providers`、`providers.{codex,copilot,registry,dump}` |
| `mcp` / `mcp.oauth` / `server.mcp` | `app/mcp/{bridge,client}.ts` / `app/mcp/oauth/provider.ts` / `app/server/mcp-client.ts` |
| `ipc.<domain>` | `app/rpc/domains/{agents,models,permission-grants,prompts,providers}.ts` |
| `server.runtime` / `server` | `app/server/runtime.ts` / `apps/server/src/main.ts` |
| `music` / `music.radio` | `app/music/service.ts` / `app/music/{radio,dj-voice}.ts` |
| 其余一对一 | `goals` `variables` `skills` `tasks` `usage` `settings` `storage` `scratchpad` `todo-plan` `prompts` `project-dirs` `interaction` `external-agents` `scheduler` `permission` `channel.outbound` `daemon` `logging` |

#### 9.2.2 等级偏差(§8.1 的机械规则之外,逐条)

| 位置 | 原级 | 迁到 | 理由 |
|---|---|---|---|
| `music/radio.ts` 的 `[radio:timing]` ×3、`[music:watch]` ×1、`music/dj-voice.ts` ×2 | `console.info` | `debug` | 每次开台/每次换歌的计时与状态转移,是「每请求的形状」不是生命周期节点 |
| `providers/model-registry.ts` "Fetching from models.dev" | `console.log` | `debug` | 同上;紧随其后的 "fetched N models" 留 `info`(它是一次真的加载完成) |
| `mcp/bridge.ts` ×3 | `console.log` | `debug` | 每次构面时的目录/路由决策 |
| `stores/sessions.ts` 的 `[SessionUsage]` ×2 | `console.log` | `debug` | 每轮用量写入的形状转储(§8.1「每请求/每 tool call」那一行) |
| `session/validation.ts` 的 consistent 分支 | `console.log` | `debug` | 一致时不该占 info;不一致仍是 `warn` |
| `engine/stream/chat-logger.ts` 的 `logMessageBodyShape` | `console.log`(带 `ONETHING_DEBUG_HISTORY_SHAPE` 门控) | 摘要 `debug` / 逐行铺开 `trace` | 见 9.2.3 |
| `server/runtime.ts` "index ownership backfilled" | `console.log` | `info` | 一次性迁移完成 = 生命周期节点 |
| `plugins/loader.ts` "loaded local dev script(s)" | `console.log` | `info` | 启动可见性(原注释就是这么写的) |
| `collab/actors/runtime.ts` "migration complete" | `console.info` | `info` | 原级 |

#### 9.2.3 门控开关 → 等级过滤(特殊职责 a)

`ONETHING_DEBUG_*` 的门控**全部拆掉**,判据换成 `log.isLevelEnabled(...)`:

- `app/events/stream-coalescer.ts` 与 `app/events/event-only-emitter.ts` 里两份
  `shouldDebugStream()` 副本删除(第三份在 `app/providers/builtin/codex.ts` 的
  `shouldDebugCodexStream()`,同样删)。coalescer 直接 `log.trace`;emitter 与 codex
  仍要一个布尔(core 的 emitter / SSE 回调吃的是谓词),改成
  `getLogger('engine.stream.emitter').isLevelEnabled('trace')` 与
  `getLogger('providers.codex').isLevelEnabled('trace')`。
- `app/engine/stream/chat-logger.ts` 的 `VERBOSE_HISTORY_SHAPE` 常量删除。

别名层落在**一个**地方:`app/logging/legacy-debug-env.ts`
(`resolveLegacyDebugAliases` + `composeLevelSpecWithLegacyAliases`),由
`app/logging/index.ts` 的 `resolveLevelSpec()` 拼进 spec。**它们是废弃的,L5 整表删除**;
`configureLogging()` 命中时打一条 `warn`(`deprecated debug env aliases applied`,
带 `switches` / `mappedTo`)。

| 旧开关 | 等价 spec |
|---|---|
| `ONETHING_DEBUG_STREAM=1` | `engine.stream=trace,providers.*=trace,renderer.chat-store=trace,renderer.ipc-hub=trace` |
| `ONETHING_DEBUG_CODEX_STREAM=1` / `ONETHING_DEBUG_DEEPSEEK_STREAM=1` | 同上 |
| `ONETHING_DEBUG_HISTORY_SHAPE=1` | `engine.history=trace` |
| `ONETHING_DEBUG_SKILLS=1` | `skills=debug` |
| `DEBUG=<任意非空>` | `debug`(默认级) |

强弱:显式 `ONETHING_LOG` 永远赢 —— 别名的**默认级**排在 base 之前(后写后赢),
别名的 **ns 规则**排在 base 之后(同特异性时解析器保持插入序,base 先命中)。
`applyDiagnosticsMode(false)` 也走同一个 `resolveLevelSpec()`,所以关掉诊断模式不会
顺手丢掉别名。用例:`app/logging/__tests__/legacy-debug-env.test.ts`(8 条)。

**两处与派工文本的偏差:**

1. `ONETHING_DEBUG_HISTORY_SHAPE` 映射到 `engine.history=**trace**` 而不是 `=debug`。
   `chat-logger` 现在分两档:摘要 `debug`、逐行铺开(400 条会话 ~2400 行 util.inspect,
   2026-08-18 实测每次发送 ~300ms 主线程)`trace`。旧开关开的是**逐行铺开**那一档,所以
   必须映射到 trace;顺带保证「诊断模式 = 全域 debug」不会把那 300ms 请回来。
   trace 是 debug 的严格超集,派工要的那一档一条不少。
2. `[EventBus] emit … → Session (onAny)` 那 4820 行**不在本区** —— 它们在
   `packages/core/events/event-bus.ts`(区 ①)。同理 `[ProviderRequestDump]`
   (`runtime/src/agent-loop/providers/*`)、`[TriggerManager]`
   (`core/engine/triggers.ts`)、`[ContextUsage]`(`core/engine/context-usage.ts`)、
   `[buildHistoryMessages]` 的 core 半边。本区只迁了 `app/events/index.ts`
   (`app.events`,3 条)与 `buildHistoryMessages` 在装配层的那一半(`engine.history`)。

#### 9.2.4 注入式鸭子 logger 端口(特殊职责 c)

装配层有 **135 处** `logger: console`(它们不是 `console.<method>(` 调用形状,所以
`log:check` 一条都不数,但同样把命名空间丢给了 `ns='console'`)。core 的 8 个
`Core*Logger` 鸭子接口还在被区 ① 统一,**现在传真 `Logger` 会因签名不兼容炸掉**
(`(...args: unknown[]) => void` vs `(msg: string, fields?, err?) => void`)。

落法:新增 `app/logging/console-port.ts` 的 `consolePort(log, plainLevel = 'debug')` ——
**同形状**替身(调用签名逐字不变,任何吃 `console` 的端口直接换),内部把第一个字符串
参数当 `msg`(顺手剥 `[Tag] `)、第一个 `Error` 进 `err`、其余进 `fields`。36 个文件的
`logger: console` 全部换成 `logger: consoleLog`(= `consolePort(getLogger(ns))`)。
`app/storage/index.ts` 的 `onInitializeError: console.error` 同理。
**这是过渡件**:区 ① 把 `Core*Logger` 统一到 `Logger` 之后,调用点改传 `getLogger(ns)`,
本文件删。

`setRuntimeLoggerRoot(getRootLogger())` 由 `configureLogging()` 调用(区 ① 落的那一句
已在树里,本区只补了 `shutdownAppLogging()` / `resetLoggingForTests()` 里的
`setRuntimeLoggerRoot(null)` —— 拆线也要拆干净)。

#### 9.2.5 `apps/server/src/main.ts` 的白名单(特殊职责 d)

4 条,全部在 `configureLogging()` **之前**(它必须排在 runtime 装配之后,否则
`server.jsonl` 会写进另一个 store 的 `log/`,§7.3),逐条带
`// eslint-disable-next-line no-console` + 一行理由:

| 行 | 内容 |
|---|---|
| `main.ts:45` | FATAL:非回环且无 `ONETHING_SERVER_TOKEN`,拒绝启动 |
| `main.ts:55` | WARNING:`ONETHING_SERVER_ALLOW_INSECURE=1` 时的不安全监听告警 |
| `main.ts:74` | FATAL:同一 store 已由桌面 core 服务,让位 |
| `main.ts:92` | FATAL:runtime 装配失败(日志接线在它之后) |

接线**之后**的行全部迁走,包括两条 `EADDRINUSE` / listen 失败 → `log.fatal`
(`process.on('exit')` 的 `flushSync` 保证落盘)。

**顺手补的一处(必要,不是顺带优化)**:`configureLogging({ consoleEcho: 'pretty' })`。
server 是独立进程,终端那一侧原本靠 `LegacyConsoleSink` 的**原样透传**;所有 console
迁走之后没有回显 sink,终端会整只哑掉。同时给回显 sink 加了一道
`record.ns === LEGACY_CONSOLE_NS` 的跳过 —— 未迁移的行已经透传过一次,再回显就是打两遍。

#### 9.2.6 等级 spec 的单向下发(区 ③b 提出)

渲染侧 hub 的等级只认 localStorage `onething:log`,主进程的 `ONETHING_LOG`(以及别名
展开出来的 `renderer.*=trace`)到不了那边。本批落了**收方那一半**:`logs` RPC 域新增
`config` 路由(`packages/shared/ipc/logs.ts` 的 `LogConfigResponse` +
`app/rpc/domains/logs.ts` 的 handler,返回 `getLogLevelSpec()`)。做成**拉**而不是推:
渲染进程可能比 `configureLogging()` 晚起、也可能重载,推要处理「推的时候没人听」的窗口。

**尾巴(L5 / 区 ③b)**:渲染侧还没有人调它 —— `installRendererLogging()` 里装完 hub
之后拉一次 `logsRouter.config()`,把返回的 spec 当默认(localStorage 仍是本地覆写)。
契约与 handler 已就位,不需要再改一次协议。

#### 9.2.7 顺手改的测试(本区目录内)

10 个测试文件断言的是 `vi.spyOn(console, …)`,而日志已经不走 console。改成断言**记录**:

- 新增 `collectLogRecordsForTests(spec = 'trace')`(`app/logging/index.ts`):把根 logger
  上发生的记录收进数组,`stop()` 解除订阅并恢复等级。用于装配层自己的输出。
- 断言来自产品层的输出时用区 ① 的 `captureRuntimeLogs()`(`@onething/runtime/logging`)。

| 文件 | 换成 |
|---|---|
| `agents/__tests__/store.test.ts`、`collab/__tests__/agent-session-deleted-agent.test.ts` | `captureRuntimeLogs()`(warn 来自 `runtime/src/agents/store.ts`,区 ①) |
| `engine/prompt/__tests__/prompt-context.test.ts` | `captureRuntimeLogs()`(warn 来自 `runtime/src/prompts/builder.ts`) |
| `external-agents/__tests__/{host-tools,permission-and-interaction,steering-delivery}.test.ts` | `collectLogRecordsForTests()` / 给 `vi.mock('../../logging/index.js')` 补 `getLogger` + `consolePort` |
| `plugins/__tests__/{config,event-routing,local-plugins}.test.ts`、`session/__tests__/{event-log,event-log-s1}.test.ts`、`toc/__tests__/record-turn.test.ts` | `collectLogRecordsForTests()` |

#### 9.2.8 门(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run log:check \| grep '<区 ② 路径>'` | 迁前 **245** → 迁后 **4**(全是 §9.2.5 的白名单) |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run typecheck` | 3 red,全部是既有的 `spaces/__tests__/provider-dials.test.ts`;本区 0(过程中另见区 ① 在途的 `core/engine/stream-processor.ts` / `core/plugins/lifecycle.ts` 中间态,收尾时已消) |
| `bunx vitest run packages/onething-runtime/src/app apps/server` | 291 文件通过 / 1 skipped,**0 失败** |
| `ONETHING_SESSION_FREEZE=1 bun run test`(全量) | 1136 文件通过 / 1 失败:`ui-token-vars.test.ts` ×2 + `AIProviderTab.interaction.test.ts` 的 unhandled rejection —— 与本批前的既有红逐条相同 |
| `bun run lint:ci` | 334 problems(**128 errors / 206 warnings**)= 基线,本区新增 **0** |
| `bun run boundary:gate` | ok — 13 known, none new |
| `bun run session:gate` | ok — 0 |
| `bun run server:build` + `node scripts/log-smoke.mjs` | 16/16 通过(`consoleEcho: 'pretty'` 生效后终端可读,`server.jsonl` 逐条对上) |

#### 9.2.9 与区 ① 的两处交界(已协调,记一笔)

1. **core 的 `CorePluginAPILogger` 默认从 console 改成 noop**(区 ① 的
   `toLogger(undefined) → noopLogger`)之后,`app/plugins/api.ts` 不注入 logger 就等于
   把 core 的声明门拒绝、storage 拒绝、超时告警**全部静音**。本区补上注入:
   `logger: options?.logger ?? getLogger('plugins').child({ pluginId })`,并给
   `CreatePluginAPIOptions` 加了 `logger?: CompatLogger`(测试注入口)。
2. 因此 `app/deeplink/__tests__/registry.test.ts` 与
   `app/providers/__tests__/credential-strategy.test.ts` 的 console spy 断言改成
   **从 `load()` 里那一份 logging 单例**取记录(`vi.resetModules()` 之后模块是新的,
   静态 import 的捕获器收的是另一个 root —— 这是本批踩过的坑,写在注释里了)。

#### 9.2.10 留给 L5 的尾巴(本区)

- `app/logging/legacy-debug-env.ts` 整表删除(5 个旧开关 + `DEBUG`),连同
  `configureLogging()` 里那条弃用 warn。
- `app/logging/console-port.ts` 删除 —— 等区 ① 把 `Core*Logger` 统一到 `Logger`,
  135 处 `logger: consoleLog` 改传 `getLogger(ns)`。
- 渲染侧调用 `logs.config`(§9.2.6)。
- `writeAppLog` 的 `channel/*` 调用点仍是「source 当 ns」的形状(§7.5 的老尾巴,本批
  未动 —— 它已经是结构化入口,不在 `log:check` 的计数面上)。

### 9.3a 区 ③a — Electron 宿主(`apps/electron/src/**`)

迁前 `log:check` 该区 **155** 处,迁后 **0**(白名单 `apps/electron/src/main/cli/stdout.ts` 除外)。
主进程一律 `@onething/app/logging` 的 `getLogger(ns)`;preload **零日志**(见下);
CLI 的用户输出走 `stdout.ts`,不是日志。

#### 映射表(文件 → ns / 去向)

| 文件 | 处 | 去向 |
|---|---|---|
| `main/cli/index.ts` | 44 | **全部 → `stdout()` / `stderr()`**(产品输出,非日志) |
| `main/cli/plugin-command.ts` | 20 | 同上 |
| `main/ipc/evals.ts` | 24 | `ipc.evals` |
| `app/main-process.ts` | 16 | `app.boot` |
| `window/macos-panel.ts` | 6 | `window.macos-panel` |
| `main/ipc/sessions.ts` | 4 | `ipc.sessions` |
| `main/bridges/ipc-bridge.ts` | 4 | `ipc.bridge` |
| `window/index.ts` | 3 | `window` |
| `main/ipc/themes.ts` | 3 | `ipc.themes` |
| `main/ipc/skills.ts` | 3 | `ipc.skills` |
| `main/ipc/plugins.ts` | 3 | `ipc.plugins` |
| `preload/bridge.ts` | 2 | **删除**(见偏差 3) |
| `main/ipc/tools.ts` | 2 | `ipc.tools` |
| `main/ipc/settings.ts` | 2 | `ipc.settings` |
| `main/ipc/network-proxy.ts` | 2 | `ipc.network-proxy` |
| `main/ipc/evals-workbench.ts` | 2 | `ipc.evals-workbench` |
| `main/ipc/evals-provider-adapter.ts` | 2 | `ipc.evals` |
| `main/bridges/ipc-bridge-lifecycle.ts` | 2 | `ipc.bridge` |
| `window/todo-plan-window.ts` | 1 | `window.todo-plan` |
| `window/renderer-targets.ts` | 1 | `window` |
| `web-preview/web-preview.ts` | 1 | `web-preview` |
| `search/ipc.ts` | 1 | `search` |
| `main/ipc/permission.ts` | 1 | `ipc.permission` |
| `main/ipc/mcp.ts` | 1 | `ipc.mcp` |
| `main/ipc/interaction.ts` | 1 | `ipc.interaction` |
| `main/ipc/handlers.ts` | 1 | `ipc` |
| `browser/widevine.ts` `browser/search-engine.ts` `browser/profiles.ts` | 3 | `browser` |

`[Tag]` 前缀全删,消息改成固定英文短句,变量进 `fields`,`error` 一律走第三参 `err`。

#### 与 §8.1 机械映射的偏差(逐条)

1. **`main/ipc/sessions.ts` 的两处 `console.info('[Perf][SessionPage][ipc]', …)` → `log.debug`。**
   §8.1 说 `console.info → log.info`,但这两条是**每请求**的形状/耗时读数,按 §2.3
   的语义就是 debug。级别语义优先于逐字映射。
2. **`main/ipc/evals.ts` 里 `[Evals] Send-view rebuild failed…` 由 `console.error` 降为 `log.warn`。**
   它就地降级到 storage view 并继续(`synthesizedContextOrigin = 'synthesized'`),
   是"可恢复降级",按 §2.3 属 warn 而不是 error。
3. **`preload/bridge.ts` 的 2 处不是迁移,是删除。**
   preload 是独立 bundle(esbuild/CJS,contextIsolated),`@onething/app/logging`
   带 node fs 与整棵装配层,不能进;为两行调试 trace 造一个 preload 本地 shim
   或走 `logs` RPC 都不成比例。而这两行说的事(`openImagePreview` /
   `openImageGallery` 被调了)在主进程侧已经有等价且更靠谱的一条 ——
   `window/index.ts` 的 `log.debug('image preview window requested', …)`,
   gallery 模式同样经它。删掉后 **preload 的 console 计数 = 0**,不需要白名单。
4. **`app/main-process.ts` 的六处 `(non-blocking)` 子系统失败统一成一条消息 + `fields.subsystem`。**
   `log.error('subsystem startup failed', { subsystem: 'plugins' | 'scheduler' | 'mcp' |
   'acp' | 'model-registry' | 'gateway' | 'skills', blocking: false }, err)` ——
   msg 稳定、可聚合;`core-http` 的两条挂载/关闭失败另有各自的 msg,同样带
   `fields.subsystem: 'core-http'`。
5. **`console.log(formatStartupSummary())` → `log.info('startup summary', { summary })`。**
   `formatStartupSummary()` 返回的是一行已经拼好的 `[Perf][Startup] …` 文本(它住在
   区 ① 的 `runtime/src/perf/startup-trace.ts`,本批不动),所以整串进 `fields.summary`
   而不是 msg。彻底结构化要等区 ① 把那个函数改成返回段落数组。

#### 白名单(该区保留 console 的地方)

**空。** 该区没有一处需要在 logging 配置好之前直写 stderr 的启动期 FATAL ——
`main.ts` 的启动路径先 `configureLogging()` 再做别的;CLI 的 `stderr()` 是产品
输出口,不是日志白名单。ESLint 的 `ignores` 只有 `main/cli/stdout.ts`(它就是那个口)
与测试目录。

#### ESLint

`eslint.config.js` 末尾新增一块,`files: ['apps/electron/src/**/*.ts']`、
`ignores: ['apps/electron/src/main/cli/stdout.ts', 'apps/electron/src/**/__tests__/**',
'apps/electron/src/**/*.test.ts']`、`rules: { 'no-console': 'error' }`。

#### 门(全部实跑)

| 门 | 结果 |
|---|---|
| `log:check`(本区) | 迁前 155 → 迁后 **0** |
| `bun run log:gate` | ok — none new(全仓四区并行下降中) |
| `bunx eslint apps/electron/src` | `no-console` 错误 **0**;该区仅剩 2 个既有 `no-this-alias`(两个 auth 测试文件) |
| `bun run lint:ci` | 335(129 errors);**本区贡献 0** —— 逐文件核过,报错文件无一是本批改动的 |
| `bun run typecheck` | 3 red,全部是既有的 `spaces/__tests__/provider-dials.test.ts` |
| `bunx vitest run apps/electron` | 78 文件 / 406 测试全过 |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 本区 0 红;全仓 3 文件红,全在并行区(`app/external-agents/*` ×2、`app/plugins/config`、`renderer/ui-token-vars` ×2 既有) |
| `bun run boundary:gate` | ok — 13 known, none new |
| `bun run session:gate` | ok — 0 |
| `bun run ui:gate` | ok — 81 known, none new |
| `bun run build`(electron) | ok;`out/main/cli.js` 仍 29KB、**不含 electron**,`node out/main/cli.js --help` 正常出表(证明 `stdout.ts` 换法没把装配层拖进 CLI 图) |
| `bun run server:build` + `node scripts/log-smoke.mjs` | 16/16 绿 |
| 结构化自证 | 临时单测(跑完即删):对 `ipc.evals` / `ipc.sessions` / `ipc.bridge` / `app.boot` / `window` / `browser` / `search` 各打一条,root sink 收到的 7 条记录 `ns` 逐一对上、`msg` 不拼变量、`fields` 与归一化后的 `err` 都在 |

#### 留下的尾巴

- **`logger: console` 还有 ~110 处**(`main/ipc/*.ts`、`ipc/*.ts` 把 `console` 当鸭子
  logger 注入区 ① 的 IPC 投影)。它不是 `console.<method>(` 调用点,`log:check` 与
  `no-console` 都数不到,但那些投影内部的 `logger.error(...)` 最终仍打到 console
  (迁移期由 `LegacyConsoleSink` 兜住,记为 `ns='console'`)。换掉它要动区 ① 的
  投影签名(把鸭子接口统一成 `Logger`),按 §8.3 属区 ① / L5,本批不越界。
- `app/main-process.ts:436` 的 `hydrateProcessEnvFromLoginShell({ logger: console })` 同上。

---

### 9.3b 区 ③b — renderer(`packages/renderer/**`)

迁前 `log:check` 该区 **230** 处,迁后 **0**(该区无白名单)。全部走
`@/services/log` 的 `getLogger(ns)`(L3 落的 `RendererLogHub`);`services/crash-log.ts`
早在 L3 就是 hub 的 producer,本批一行未动。

#### 映射表(文件 → ns / 等级)

| 文件 | ns | 站点 | 等级说明 |
|---|---|---|---|
| `stores/chat.ts` | `renderer.chat-store` + `renderer.perf` | 27 | 逐 chunk → `trace`;权限缓存/流完成 → `debug`;`[Perf][SessionPage]` → `renderer.perf` 的 `debug`;其余 warn/error 原级 |
| `stores/themes.ts` | `renderer.themes` | 20 | 原 `isThemeDebugEnabled()` 门下的 `console.log` → `debug`;error 原级 |
| `stores/sessions.ts` | `renderer.sessions-store` + `renderer.perf` | 19 | `[Perf][SessionSwitch]` ×2 → `renderer.perf` 的 `debug`;其余 error 原级 |
| `stores/settings.ts` | `renderer.settings` | 12 | 主题门下的 `console.log` → `debug`;error/warn 原级 |
| `stores/evals.ts` | `renderer.evals` | 11 | 运行开始/结束 = 生命周期 → `info`;逐事件 → `debug`;**`evalsRunStart failed` 由 `console.log`→`error`(§8.1 的「错误当 log 打」三修之一)** |
| `services/ipc-hub.ts` | `renderer.ipc-hub` | 11 | 逐 chunk / 逐 stream 事件 → `trace`;监听器注册完成 → `info`;`request:snapshot` → `debug` |
| `components/settings/skills/useSkills.ts` | `renderer.skills` | 10 | 全 `error`,`err` 走第三参 |
| `components/ImagePreviewWindow.vue` | `renderer.image-preview` | 10 | `console.log` 全是形状转储 → `debug` |
| `components/chat/message/markdownRenderCache.ts` | `renderer.markdown-cache` | 10 | IDB 降级 → `warn`;`restored N entries` `info`→`debug`(每次启动都打的形状行) |
| `App.vue` | `renderer.app` + `renderer.perf` | 8 | `[Perf][Startup]` ×2 → `renderer.perf` 的 `debug`;其余 warn 原级 |
| `stores/media.ts` | `renderer.media` | 7 | 全 `error` |
| `utils/stream-scroll-trace.ts` | `renderer.stream-scroll` | 5 | 见下「门控移除」 |
| `stores/scratchpad.ts` | `renderer.scratchpad` | 5 | 全 `error` |
| `composables/usePermissionResponder.ts` | `renderer.permission` | 5 | 应答/拒绝的形状行 → `debug`;`canRespond=false` → `warn`;失败 → `error` |
| `components/SettingsPage.vue` | `renderer.settings-page` | 5 | 原级 |
| `components/settings/PluginsSettingsTab.vue` | `renderer.plugins` | 5 | 原级 |
| `components/settings/mcp/useMCPServers.ts` | `renderer.mcp` | 5 | 原级 |
| `stores/projects.ts` | `renderer.projects` | 4 | 原级 |
| `stores/collabBoard.ts` | `renderer.collab-board` | 4 | 原级 |
| `components/settings/provider/useProviderAuth.ts` | `renderer.provider-auth` | 4 | 原级 |
| `components/chat/message/MessageActions.vue` | `renderer.message-actions` | 4 | 原级 |
| `components/settings/provider/useProviderSettings.ts` | `renderer.provider-settings` | 3 | 原级 |
| `components/chat/MessageList.vue` | `renderer.message-list` + `renderer.perf` | 3 | `[Perf][SessionRender]` → `renderer.perf` 的 `debug` |
| `components/chat/message/DiffView.vue` | `renderer.diff-view` | 3 | 原级 |
| `stores/interactions.ts` | `renderer.interactions` | 2 | 原级 |
| `composables/usePickerOrchestration.ts` | `renderer.picker` | 2 | 原级 |
| `composables/useMarkdownRenderer.ts` | `renderer.markdown` | 2 | 原级 |
| `components/chat/message/MessageSystem.vue` | `renderer.message-system` | 2 | 原级 |
| `stores/workspace.ts` | `renderer.workspace-store` | 1 | 原级 |
| `stores/music.ts` | `renderer.music` | 1 | `[radio:timing]` `info`→`debug`,中文消息改英文短句,毫秒进 `fields` |
| `platform/web.ts` | `renderer.platform-web` | 1 | 原级 |
| `main.ts` | `renderer.boot` | 1 | `log`→`debug`(HMR 主题纠偏,不是生命周期节点) |
| `editor` / 其余单点组件 | `renderer.<component>` | 各 1 | `ChatPanel`/`StreamingMarkdown`/`StreamingHtmlSegment` 的 `[Perf][Markdown]` → `renderer.perf`;`StreamingCodeBlock`、`SelectionToolbar`、`TodoPlanPanel`、`ModelSelector`、`ChannelsSettingsTab`、`BashSettingsPanel`、`PluginAmbientLayer`、`PluginWebviewFrame`、`VirtualTable.example`、`VoiceRuntimeWindow`、`RightWorkbenchPanel`、`CoordinatorStatusBar`、`useCollabReactions`、`useModelLedger`、`EvalsRunsView`、`EvalsFixturesView` 原级 |

#### 门控移除(§8.1 最后两行)

| 原门 | 处置 |
|---|---|
| `shouldDebugStream()`(`services/ipc-hub.ts:38`、`stores/chat.ts:1011` 两份拷贝) | **删除**。两处调用点改 `log.trace`;字段计算贵的那两处(`previewText`/`debugGapMs`)前面留 `log.isLevelEnabled('trace')` —— 那是**性能护栏**不是开关(关着时等价于旧代码不进 if)。等价开法:`renderer.chat-store=trace` / `renderer.ipc-hub=trace`。区 ② 若实现 `ONETHING_DEBUG_STREAM` 别名,**renderer 侧需要的是 `renderer.chat-store` + `renderer.ipc-hub` 两个 ns 一起降到 trace**(与主进程的 `engine.stream=trace` 同一次映射里加即可)。 |
| localStorage `onething:debug-stream` | 同上,已无读者。 |
| localStorage `onething:debug-theme`(`stores/themes.ts:14`、`stores/settings.ts:34` 两份 `import.meta.env.DEV &&` 拷贝) | **删除**两个 `isThemeDebugEnabled()`。等价开法:`renderer.themes=debug` / `renderer.settings=debug`。 |
| localStorage `debug:stream-scroll`(`utils/stream-scroll-trace.ts`) | **删除**。`isTraceEnabled()` 保留为导出(唯一消费者 `composables/useFollowScroll.ts` 一行未动),实现改成 `log.isLevelEnabled('trace')`。环形缓冲与 `window.__streamScrollTrace` 取样口原样保留;`printTrace`/`printSummary` 的 `console.table` 改成 `log.debug` + **返回值不变**(devtools 里返回的数组本来就渲染成表)。顺手删掉只为这个门存在的 `refreshEnabled()`。`docs/design/streaming-markdown-rendering.md` §8.3 的开法同步改写。 |
| `import.meta.env.VITE_DEBUG_TOOL_INPUT`(`stores/chat.ts`)+ 它的 `ImportMetaWithDebugEnv` 类型 | **删除**。`tool_input_*` 那两类 chunk 照旧只在自己的分支里记一条 `trace`(chunk 类型是**内容范围**不是门)。 |
| `import.meta.env?.DEV`(`stores/chat.ts` 的 plugin-status 丢弃行) | **删除**,改 `log.debug`。 |

#### 与 §8.1 的等级偏差(逐条)

1. **`stores/evals.ts:313` `run-done`/`error` → `info`**(机械规则会给 `debug`)。它是一次 evals 运行的**结束节点**,与同文件的 `startRun` 成对;按 §2.3「生命周期节点 = info」。
2. **`markdownRenderCache.ts:148` `info` → `debug`**(降级)。`restored N entries from disk` 每次冷启动都打,是缓存的形状转储而不是生命周期节点。
3. **`stores/music.ts:273` `info` → `debug`**(降级)。`口播收到→出声 Xms` 是每条口播都打的时延转储。
4. **`main.ts:37` `log` → `debug`**(而非 `info`)。它只在 HMR / 旧值残留时触发,是纠偏而非启动节点。
5. **所有 `[Perf][*]` 的 `console.info` → `renderer.perf` 的 `debug`**。按 §8.1「Perf 逐帧 → trace」的精神,但这几条是**每会话切换 / 每次慢渲染一条**(不是逐帧),`debug` 更贴 §2.3;逐帧的那一类(`stream-scroll`)确实落在 `trace`。
6. **三处「错误当 log 打」已修**:`stores/chat.ts` 的 `Stream error:` → `log.error('stream failed', …)`;`stores/evals.ts` 的 `evalsRunStart failed:` → `log.error`;`services/ipc-hub.ts` 的 `session:event stream:error` → 它本身只是**事件到达**的形状转储(真正的错误由 chat store 那条 `error` 记),故留在 `trace`,不当第三处 —— 第三处是 `SettingsPage.vue:785` 的 `openPath` 返回错误串,原本 `warn` 拼字符串,现在 `log.warn('open settings.json reported an error', { result })`。

#### 静默 catch

未新增 `log.debug('…swallowed')`。本区的 `catch {}` 全是 localStorage / JSON 探测(§8.1 明说不补),唯一有诊断价值的两处(`themes.ts` 的 CSS 变量缓存写入、`markdownRenderCache` 的 IDB 事务)本来就已经有 `warn`。

#### 白名单

**空**。该区没有必须直写 console 的启动期 FATAL:hub 在 `main.ts` 的第一行装(早于 `installGlobalCrashCapture`),之前的一切只是模块求值。`services/log.ts` 里 `EchoSink` 的 dev 回显走**动态成员访问**(`this.target[ECHO_METHOD[level]]`),`log:check` 的 `console.<method>(` 形状与 ESLint `no-console` 都不认它 —— 不是绕过,是它本来就是 sink 而不是调用点。

#### ESLint

`eslint.config.js` 新增一格:`files: ['packages/renderer/**/*.ts', 'packages/renderer/**/*.vue']`,
`ignores` 为 `__tests__` / `*.test.ts` / `*.spec.ts`,`rules: { 'no-console': 'error' }`。

#### 门(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run log:check \| grep packages/renderer` | 迁前 **230** → 迁后 **0** |
| `bun run log:gate` | ok — 4 known, none new(全仓 822 → 4,四区合并后的数;基线文件待落库那批重录) |
| `bun run typecheck` | node 面 5 red:3 条既有 `spaces/__tests__/provider-dials.test.ts` + 2 条来自并行区的 `app/plugins/api.ts` / `app/tools/core/permission-policy.ts`(**不在本区**);`typecheck:web` 全绿 |
| `ONETHING_SESSION_FREEZE=1 bunx vitest run packages/renderer` | 338 文件通过 / 1 失败:`ui-token-vars.test.ts` ×2 + `AIProviderTab.interaction.test.ts` 的 unhandled rejection —— 与本批前的既有红逐条相同 |
| `bun run lint:ci` | 335(129 errors / 206 warnings)。**本区新增 0**:stash 掉本区改动后单跑 `eslint packages/renderer` 同样是 21 errors / 36 warnings,一条不差;+1 error 来自并行区 |
| `bun run ui:gate` | ok — 81 known, none new |
| `bun run boundary:gate` | ok — 13 known, none new |
| `bun run session:gate` | ok — 0 |

#### 留给 L5 的尾巴(本区)

- `ONETHING_DEBUG_STREAM` 的 renderer 侧别名要覆盖 `renderer.chat-store` + `renderer.ipc-hub` 两个 ns(见上表);区 ② 的 spec 解析器实现,本区只提需求。
- `renderer.perf` 这个 ns 不在 §2.2 的表里(表里只有 `renderer.<store|component|service>`)。它是**跨组件的横切面**(chat store / sessions store / App / MessageList / ChatPanel / 两个 Streaming 组件都往里写),按 store 或 component 拆开就没法一句 `renderer.perf=debug` 全开。要么落一行进 §2.2,要么下一批改成 `renderer.<x>` + `fields.perf`。

---

## 10. L5-lite 落地记录(2026-08-20)

> 状态:**已实施(未提交)**。这一批只做 L5 里两件不牵动目录治理的尾巴 ——
> 渲染侧的等级 spec 下发,与 L4 欠下的死码清除。janitor / dumps 搬家 / `log/memory/`
> 那半边仍未动,尾巴逐条列在 §10.3。

### 10.1 渲染侧拉主进程的等级 spec(§2.3 的「主进程下发 + localStorage 覆写」)

`logs.config` 这格路由在 L3 就已经落好了(`packages/shared/ipc/logs.ts` 的
`LogsRoutes.config` + `app/rpc/domains/logs.ts` 的 handler,返回
`{ levelSpec: getLogLevelSpec() }`),但**没有调用者** —— 于是主进程的
`ONETHING_LOG`(以及废弃的 `ONETHING_DEBUG_*` 别名展开出来的 `renderer.*=trace`)
到不了渲染侧,`renderer.chat-store=trace` 这类开法只能靠手改 localStorage。本批把
调用点接上:

| 件 | 位置 |
|---|---|
| `RendererLogHub.setDefaultLevelSpec(spec)` —— 采纳主进程的默认;**有 localStorage(`onething:log`)覆写时一个字不改**,并返回 `false` 如实说明没采纳 | `packages/renderer/services/log.ts` |
| `pullLevelSpec(hub, fetchConfig?)` —— 装好之后拉一次;失败**静悄悄**保持默认(`info`),只在 `renderer.log` 的 **debug** 留一行 | 同上 |
| `installRendererLogging()` 里的首拉 + 借 `onSettingsChanged` 的重拉 | 同上 |
| 用例 3 条(采纳 / 覆写赢 / 拉失败保持默认)+ 空串与空白不采纳 | `packages/renderer/services/__tests__/log-hub.test.ts` |

三条判据,逐条对应上面三格:

1. **优先级**:localStorage > 主进程下发 > `info`。判定放在 `setDefaultLevelSpec`
   **调用时**读 localStorage,而不是构造时快照 —— 用户在 devtools 里
   `__onethingLog.level('trace')` 之后(它会写 localStorage),后到的重拉不会把它顶掉。
2. **失败即沉默**:日志系统自己的失败记成 warn/error 是自喂循环的开端;`debug` 一行
   足够排障,而默认级本来就看不见它。空串 / 全空白同样不采纳 —— 收方给不出 spec 时
   不该把过滤器清成空。
3. **是拉不是推**:与 handler 注释同一条理由 —— 渲染进程可能比 `configureLogging()`
   晚起、也可能重载,推一次要处理「推的时候没人听」的窗口,拉一次没有这个窗口。

**重拉用的是现成信号,没有新通道。** 主进程运行期唯一会改 spec 的入口是诊断模式
(设置存盘 → `applyDiagnosticsMode` → 根 logger 换 spec);`ONETHING_LOG` 环境变量只在
启动时生效,首拉已经覆盖。所以本批借已有的 `platformApi.onSettingsChanged` 广播,
且**只在 `diagnostics.enabled` 真的翻转时**才多发一次 RPC(第一条广播时上一次的值
未知,按「变了」处理:至多多一次 RPC,好过漏掉装机后的第一次翻转)。
**web 面上 `onSettingsChanged` 是 noop**(`platform/web.ts:610`)—— 那边只有首拉,
诊断模式开关不会即时传到浏览器端的 hub;要即时就得给 SSE 加一个事件,那是新通道,
不在本批。

### 10.2 死码清除:`chat-logger` 的 8 个死导出 + `last-system-prompt`

2026-08-19 的清点(`docs/audit/logging-inventory-2026-08-19.md` §49)说 app 版
`chat-logger.ts` 9 个导出里 8 个零外部引用;本批用 rg 复核(L4 之后仍然成立)后删除。
净 **−520 / +144** 行。

| 删了什么 | 位置 |
|---|---|
| `dumpAssembledPrompt` `logRequestStart` `logTurnStart` `logTurnEnd` `logRequestEnd` `logContinuationMessages` `logToolsDetail` `logSkillsDetail`(8 个,全仓零调用点) | `app/engine/stream/chat-logger.ts`(187 → 61 行) |
| 随之失去全部生产调用者的 core 纯函数:`buildAssembledPromptDump` `buildRequestStartLogLines` `buildRequestEndLogLines` `buildContinuationMessageLogLines` `buildToolsDetailLogLines` `buildSkillsDetailLogLines` `buildTurnEndLogLine` `CoreChatTurnTimer` `formatToolNames` `formatSkillNames` `CHAT_LOG_DOUBLE_LINE` `CHAT_LOG_SINGLE_LINE` + 类型 `CoreToolDefinitionForLog` `CoreSkillDefinitionForLog` | `packages/core/engine/chat-logger.ts`(378 → 139 行)+ `core/engine/index.ts` 的 re-export |
| 只为上面那批存在的用例 | `app/engine/__tests__/core-chat-logger.test.ts`(6 例 → 2 例) |
| `getLastSystemPromptDebugPath` 三份(core / app 包装 / runtime `getOnethingLastSystemPromptDebugPath`)+ core 桶的 re-export + 唯一的断言 | `core/storage/{paths,index}.ts`、`app/stores/paths.ts`、`runtime/src/storage/paths.ts`、`app/storage/__tests__/core-storage-manager.test.ts` |

**留下的**:`logMessageBodyShape`(唯一活着的导出,调用点 `app/engine/stream/message-helpers.ts:132`)
与它依赖的 core 三件 `buildMessageBodyShapePayload` / `chatLogContentTextLength` /
`chatLogJsonLength` + 六个类型。分层照旧:core 出纯函数,app 出副作用(等级判定 + 落记录)。

判据是「**这些东西观测到的事实已经有更好的账本**」而不是「没人调所以删」:请求起止 /
逐轮计时 / 续轮消息 / 工具技能清单,S 线的 `sessions/<id>/events.jsonl` 逐条都记;
`<store>/debug/last-system-prompt.txt` 更是从 L4 之前就没有写者(§2.4 的表里已经标了
「死写者,直接删」)。

**两处副作用,记在这里免得下次被当 bug**:

- ns `engine.stream.chat` 随文件里的 `log` 一起消失(§9.2.1 的映射表那一行作废);
  本文件现在只写 `engine.history`。
- `<store>/debug/` 目录本身还在(`getDebugDir` / `getOnethingDebugDir` 保留,它是通用
  目录取值口),只是不再有任何代码指向 `last-system-prompt.txt`。真实 store 里的存量
  文件属于用户数据,清理是 user-land 的事,本批不碰。

### 10.3 L5 还欠什么

- **`ONETHING_DEBUG_*` 8 个别名整表删**(`app/logging/legacy-debug-env.ts` +
  `composeLevelSpecWithLegacyAliases` + 8 条用例):按 §7.5 的口径「一个版本后删」,
  这一批不动。删的时候连带 §9.2.3 的映射表与 `chat-logger.ts` 文件头那句注释。
- **`consolePort()` 过渡件**(§9.1 尾):换成直接传 `getLogger(ns)` 之后,
  `core/logging/compat.ts` 的鸭子那一半(`LegacyDuckLogger` / `DuckLoggerAdapter`)与
  14 个 `@deprecated` 别名一起删。
- **`app/plugins/api-builder.ts` 的鸭子 logger `[Tag]` 字符串**:插件拿到的 `api.log`
  仍是拼字符串的形状,随上一条一起结构化。
- **目录治理那半边**(本批一行未动):provider-requests 默认关 + 搬 `log/dumps/`、
  `LogDirJanitor` 接管、`dev-with-logging.mjs` 不再复刻主进程 stdout、`log/memory/` 删。
  其中真实 store 里的 `log/memory/` 存量目录是 **user-land 清理**,代码侧只需保证不再
  写它。
- **web 面的诊断模式即时性**(§10.1 末):要即时就得给 SSE 加事件,是新通道,待拍板。
- `renderer.perf` 落进 §2.2 的表(L4 区 ③b 提的,仍未落笔)。

### 10.4 门(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | 3 red,全部是既有的 `spaces/__tests__/provider-dials.test.ts`;`typecheck:web` 全绿 |
| `bunx vitest run packages/renderer/services packages/onething-runtime/src/app/engine packages/core/engine` | 83 文件 / 624 例全绿 |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 1136 文件通过 / 1 失败:`ui-token-vars.test.ts` ×2 + `AIProviderTab.interaction.test.ts` 的 unhandled rejection —— 与本批前的既有红逐条相同 |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run session:gate` | ok — 0 |
| `bun run boundary:gate` | ok — 13 known, none new |
| `bun run ui:gate` | ok — 81 known, none new |
| `bun run lint:ci` | 334(128 errors / 206 warnings);本批新增 0 |
| `bun run web:build` | ok |
| `bun run build`(electron) | ok |

全程没有碰过 `~/.onething`。
