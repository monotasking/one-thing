# 日志系统梳理(2026-08-19)

> 性质:现状盘点 + 问题清单。**不含改造方案**——方案另拍板。
> 范围:packages/core、packages/onething-runtime(product + app)、packages/renderer、packages/gateway、packages/shared、apps/electron、apps/server、scripts。排除测试/node_modules/构建产物。
> 证据:代码 rg 统计 + 真机 `~/.onething/log` 采样(app.log 72,511 行、log/ 目录 1.1G)。

---

## 0. 一句话结论

**没有日志系统,只有一个 console 截获器。** 全仓 ~1,020 条日志调用里 ~97% 是裸 `console.*`;唯一的结构化 API `writeAppLog` 只有 8 个调用点;`RollingFileLogger` 基建靠 monkey-patch `console` + `process.stdout.write` 被动抓输出落到 `app.log`。其余七八条独立落盘线各管各的轮转/保留策略,`~/.onething/log/` 是它们的合租房。

---

## 1. 现有基础设施(它是什么、写到哪)

### 1.1 主线:`app/logging/`(仅 Electron 宿主接线)

| 件 | 位置 | 要点 |
|---|---|---|
| `RollingFileLogger` | `packages/onething-runtime/src/app/logging/rolling-file-logger.ts` | 纯文本行 `ISO [source] LEVEL msg {metadata}`;8MiB/跨天轮转、30 归档、14 天、gzip;只认 `app-` 前缀归档 |
| 门面 + 劫持 | `app/logging/index.ts` | `initializeAppLogging()`:patch `console.{debug,info,log,warn,error}`(**`console.log→INFO`**)、patch `process.stdout/stderr.write`(source `stdout`/`stderr`)、`process.on('warning'/'uncaughtExceptionMonitor'/'exit')`;`writeAppLog(level,source,msg,meta)` 是唯一结构化入口 |
| 宿主口 | `configureAppLoggingHost({setAppLogsPath, createRendererConsoleCapture})` | **只有** `apps/electron/src/app/main-process.ts:347-373` 接线;server / web / CLI daemon 进程内均不初始化 |
| renderer 捕获 | `apps/electron/src/logging/console-capture.ts` | `webContents.on('console-message')` → source `renderer:<wcId>`,meta `{sourceId,lineNumber,url}`;未知等级降为 info |
| renderer 侧 | `packages/renderer/services/crash-log.ts` | localStorage 环形缓冲(40 条)+ **必打一条 console 行**,靠上面的 console-message 顺带落盘;无 IPC 通道 |
| env | `ONETHING_LOG_MAX_SIZE_MB / MAX_ARCHIVES / RETENTION_DAYS / COMPRESS` | 同组 env 被 `scripts/dev-with-logging.mjs` 逐字复刻读取 |

`writeAppLog` 的 8 个调用点:`app/channel/{outbound-reply-dispatcher,identity-service,session-router}.ts` + `app/tools/core/permission-policy.ts:170`。

### 1.2 其余落盘线(互不知晓)

| 落盘物(`~/.onething/`) | 格式 | 写者 | 治理 |
|---|---|---|---|
| `log/app.log` + `app-<ts>-nnn-<reason>.log.gz` | 文本 | §1.1 | 8MiB/跨天/30/14d/gzip |
| `log/dev.log`、`log/start.log` + 归档 | 文本 `ISO [runner|stdout|stderr] msg` | `scripts/dev-with-logging.mjs` | 同上,**独立 JS 复刻**(:60-137) |
| `log/daemon.log` | 原始字节流 | `apps/electron/src/main/cli/daemon-client.ts:137-138` fd 重定向 | **无** |
| `log/agent-YYYY-MM-DD.log` | 行文本 | log-monitor 插件(`core/plugins/log-monitor.ts` → `runtime/src/plugins/log-monitor.ts` → `app/plugins/builtin/log-monitor.ts` 三层) | 按日/7 天(插件设置) |
| `log/provider-requests/<ts>__<provider>__<model>__<mode>.json.gz` | pretty JSON,**完整请求正文** | `runtime/src/providers/request-dump.ts` | **默认开**(`ONETHING_DUMP_PROVIDER_REQUESTS !== '0'`);100MiB 软预算只压不删/30d;真机 **12,999 个文件 1.1G** |
| `debug/last-system-prompt.txt` | 文本覆写 | `app/engine/stream/chat-logger.ts:46 dumpAssembledPrompt` | **写者 0 外部调用 → 死路**(真机 `debug/` 下无此文件) |
| `sessions/<id>/events.jsonl` | JSONL `{seq,time,type,data}` 七类事件(含 `tool/audit`) | `app/session/event-log.ts` + `app/toolkit/audit-sink.ts` | **无上限无保留**(真机合计 968K) |
| `collab/<room>/actors/scheduler-log-YYYY-MM-DD.jsonl` | JSONL | `app/collab/actors/scheduler-log.ts` | 按日/14d |
| `usage/usage-YYYY-MM.jsonl` | JSONL | `runtime/src/usage/ledger.ts` | 按月/**无保留** |
| `tool-outputs/bash-*.log`、`scheduler/runs/*.jsonl`、`agents-v3/*/inbox.jsonl`、`collab/*/activity.jsonl`、`practice/*.jsonl`、`evals/online/records.jsonl` | 各异 | 各功能 | 本轮未逐一核 |

真机 `log/` 目录构成:`provider-requests` 1.1G、`app.log` 5.5M(+16 个 gz 归档)、`dev.log` 2.6M(+17 个归档)、`daemon.log` 16K、`agent-*.log` 0B、`memory/` 空目录(soul-memory 退役残留)。

### 1.3 名字有误导的文件

- 两个 `chat-logger.ts`:core 版是纯函数(`build*LogLines`),app 版是 console 副作用层——**分层不是重复**,但 app 版 9 个导出里 8 个零外部引用(只剩 `logMessageBodyShape` 活着)。
- 三个 `log-monitor.ts`:原语 / 产品 / 装配壳,分层正确。
- `collab/turn-log.ts`:**不是日志**,是 `<elsewhere>` prompt 片段构造器 `buildCollabElsewhere`。

### 1.4 其他宿主

| 宿主 | 现状 |
|---|---|
| `apps/server` | `main.ts` 纯 console 7 条(含 `pairing ${JSON.stringify(pairing)}` 进 stdout);**`http.ts` 1,988 行 console 出现 0 次——无访问日志、无 4xx/5xx、无耗时**;无文件 sink;无进程级钩子 |
| `packages/gateway` | 全裸 console 27 条,前缀 `[GatewayBridge]/[Gateway]/[ILinkPoller]/[Wechat*]…`;仅 wechat/telegram channel 类接受可选 `logger`,默认回落 console |
| CLI daemon | 进程内 1 条 `[Daemon] listening`;其余靠 spawn 侧 fd 重定向到 `daemon.log` |
| `packages/shared` | **0 条日志调用**(66 文件),唯一干净的包 |

---

## 2. 调用点画像

### 2.1 数量(非测试源码,按行)

| | core | runtime-product | runtime-app | renderer | electron-main¹ | electron-other | server | gateway |
|---|---|---|---|---|---|---|---|---|
| console.log | 32 | 24 | 33 | 50 | 81 | 6 | 7 | 1 |
| console.warn | 26 | 54 | 64 | 47 | 10 | 7 | 4 | 8 |
| console.error | 34 | 17 | 103 | 122 | 42 | 5 | 10 | 18 |
| console.info/debug/other | 0 | 1 | 7 | 16 | 2 | 0 | 0 | 0 |
| **小计** | 92 | 96 | 207 | 235 | 135 | 18 | 21 | 27 |

¹ electron-main 的 log 里 64 条是 `cli/index.ts`+`plugin-command.ts` 的 CLI stdout,不算日志。

全仓 831 条 console 行:error 42% / log 28% / warn 26% / info 3% / **debug 1 条**(`renderer/stores/chat.ts:1470`)。第三方日志库(electron-log/pino/winston/debug)**零依赖**。

五套互不相通的抽象:`writeAppLog`(8 处)、core 插件 `CorePluginAPILogger {log,error}` 默认落 console(84 处,58 处挤在 `api-builder.ts`)、triggers 注入 `getLogger(adapters).log`(5 处)、gateway channel `logger?`(6 处)、renderer `crash-log`(5 处)。`api.log` / `api.status` 全仓 **0 调用点**。

### 2.2 前缀 tag

**172 个不同 tag、7 种命名风格**:PascalCase 120、lowercase 21(`[radio] [collab] [spaces] [goals]`)、带空格 12(`[Chat Store] [IPC Hub] [Evals Workbench IPC]`)、kebab 8(`[collab-v3] [project-dirs]`)、冒号 7(`[CodexProvider:SSE] [server:files]`)、点/斜杠 4(`[variables.store] [toolkit/contract]`)、camel 2。

同一概念多写法:IPC 8 种(`[ipc] [IPC] [Tools IPC] [Permission IPC] [PluginIPC] [Theme IPC] [Evals IPC] [SessionsIPC]`)、Theme 5 种、Codex 5 种、collab 4 种。单文件 7 个 tag(`apps/electron/src/app/main-process.ts`),单目录 19 个(`apps/electron/src/main/ipc/`)。

**156 条(15%)无任何 tag**,renderer 76 条最多(`components/settings/skills/useSkills.ts` 连续 10 条裸 `console.error('Failed to …')`)。

中文消息 28 条,几乎全在 `app/collab/**`(tag 仍英文):`'[collab-v3] 迁移失败,以空账继续:'`、`'[collab-referee] 裁决失败,回落举手 FIFO:'`。

### 2.3 真机 app.log 的实际内容(72,511 行样本)

| 份额 | 内容 | 来源 |
|---|---|---|
| **56%**(40,816) | `[main] INFO`,其中 `[EventBus] emit … → Session (onAny) → StreamEngine → IPCBridge` 扇出 trace 4,820 行、`[ProviderRequestDump]` 153、`[SessionUsage]` 136、`[DeepSeekAgentProvider]` 110 | `console.log` 被映射成 INFO |
| **38%**(27,458) | `[renderer:1] WARN`——Vue warn 的组件链栈(`at <Container>` 3,879、`at <SplitterPanel>` 2,586、`components: App > ErrorBoundary > AppShell > Splitter…` 1,293) | crash-log `vue-warn` 每条多行 → console-message 逐行落盘 |
| 3%(2,126) | `[renderer:1] ERROR`,同一个 `TypeError: Cannot read properties of undefined (reading 'length')` 重复 147 次,每次带 ~15 行栈 | crash-log |
| 0.5% | `[main] ERROR`,一半是 `[ILinkPoller] Poll failed: ENOTFOUND ilinkai.weixin.qq.com` 循环重试 | gateway 裸 console.error |
| 199 行 | `[Perf][SessionRender][MessageList] [object Object]` | renderer 传对象给 console,console-message 只给字符串 |
| 0 行 | `channel.*` 之外的结构化 source | `writeAppLog` 只有 8 处 |

同一时间窗 `dev.log` 与 `app.log` 各含 1,513 行 `[EventBus] emit`——**同一行落两处、格式不同**(dev 无 LEVEL 字段)。

### 2.4 热路径与门控

renderer 235 条中只有 4 处 `import.meta.env.DEV` 门控(其中 `stores/themes.ts:14` 与 `stores/settings.ts:34` 是复制粘贴的同一段);其余生产构建照打。无门控热路径:`stores/chat.ts:1454/1675/1679/1772/1776`(每次流结束/出错)、`:1120/1134`(每次权限缓存)、`:2145`(每次首屏 `[Perf]`)、`composables/usePermissionResponder.ts:55/91`(每次权限应答)、`markdownRenderCache.ts` 10 条。

debug 开关 8 个、3 套命名:env `ONETHING_DEBUG_{STREAM,CODEX_STREAM,DEEPSEEK_STREAM,HISTORY_SHAPE,SKILLS}` + `DEBUG`;vite `VITE_DEBUG_TOOL_INPUT`;localStorage `onething:debug-stream` / `onething:debug-theme` / `debug:stream-scroll`。`shouldDebugStream()` 独立实现 4 遍(`renderer/services/ipc-hub.ts:38`、`renderer/stores/chat.ts:1017`、`app/events/stream-coalescer.ts:100`、`app/events/event-only-emitter.ts:47`),读的 key 不完全一致。

正面例子:`app/engine/stream/chat-logger.ts:71-97` 记录了 400 条会话 → 2,400 行 console → ~300ms 主线程阻塞的事故,已改默认摘要 + `ONETHING_DEBUG_HISTORY_SHAPE=1` 展开。

### 2.5 结构化与关联 ID

传结构化对象的调用 63 条(~8%);**带 sessionId/messageId/toolCallId 的日志行整仓 28 条**:`app/engine/**` 1 条(`stream-engine.ts:405`)、`app/toolkit/**` 0、`core/agent-loop/**` 0。`tool-orchestrator.ts:75-76` 把 logger 写成 `info: (...args) => console.log(...args)` 透传,丢掉全部上下文。

### 2.6 错误路径

- 用 `console.log` 打错误 3 处:`renderer/stores/chat.ts:1776`(Stream error)、`stores/evals.ts:313`、`services/ipc-hub.ts:86`。
- 静默 catch 189 处(renderer 66 / runtime-product 57 / runtime-app 31 / core 18),绝大多数带"有意吞"注释,但**没有一处降级为 debug 日志**。
- 进程级:全仓无 `process.on('unhandledRejection')`、无 `uncaughtException`(只有 `uncaughtExceptionMonitor` 一处,且仅 Electron 接线);electron 启动期 7 个子系统失败 `console.error(… "(non-blocking)")` 就地丢弃(`main-process.ts:226-265`);server 无任何进程钩子。
- renderer:`installGlobalCrashCapture` 四路收口(errorHandler/warnHandler/window error/unhandledrejection)全部进 localStorage + console;组件级另有 3 个独立 `onErrorCaptured`。
- 无门控大对象/敏感 dump:`runtime/src/themes/index.ts:400/410` 两条 `JSON.stringify` 无门控;`apps/server/src/main.ts:53` pairing 进 stdout;`EvalsRunsView.vue:494 handleStartRun called with: JSON.stringify(params)` 调试残留。

---

## 3. 问题清单(按混乱程度排序,只陈述事实)

| # | 问题 | 证据 |
|---|---|---|
| 1 | **无统一门面**:97% 裸 console,5 套抽象各管一角,`writeAppLog` 8 处 | §2.1 |
| 2 | **`console.log→INFO` 的劫持让等级失真**:app.log 56% 是 INFO 且其中大半是 EventBus 扇出 trace / provider 逐 delta 这类 debug 语义;`console.debug` 全仓 1 条 | §1.1、§2.3 |
| 3 | **tag 失控**:172 个、7 种风格、同概念最多 8 写法、15% 无 tag、collab 中文 | §2.2 |
| 4 | **同目录 4 套轮转 + 1 个不治理**:app / dev(逐字复刻) / agent-*(7d) / provider-requests(100MiB 只压不删) / daemon.log(无);无目录总量上限;真机 provider-requests 1.1G | §1.2 |
| 5 | **dev.log 与 app.log 内容重叠**:同一主进程行落两处、格式两样 | §2.3 末 |
| 6 | **renderer 通路隐式有损**:靠 crash-log "必打一条 console" + `console-message` 顺带落盘;对象变 `[object Object]`(199 行);Vue warn 多行栈把 app.log 灌满 38%;非 Electron 宿主完全没有落盘 | §1.1、§2.3 |
| 7 | **关联 ID 缺失**:引擎/工具/agent-loop 路径基本无 sessionId/toolCallId | §2.5 |
| 8 | **server / gateway / daemon 无文件日志、无请求日志、无进程钩子** | §1.4 |
| 9 | **renderer 生产无门控**:4/235 有 DEV 门控;debug 开关 8 个 3 套命名,`shouldDebugStream` 四份 | §2.4 |
| 10 | **静默 catch 189 处零降级;`unhandledRejection` 全仓无人监听** | §2.6 |
| 11 | **provider 请求正文 dump 默认开**,含 system 全文 + 全部 messages;`last-system-prompt.txt` 写者已死 | §1.2 |
| 12 | **`events.jsonl` / `usage-*.jsonl` 无上限无保留** | §1.2 |
| 13 | 死代码/误名:app `chat-logger.ts` 8 个导出零引用;`turn-log.ts` 不是日志;`log/memory/` 空目录残留 | §1.3 |

---

## 4. 附:相关既有文档

- `docs/design/session-events-trace-*`(events.jsonl 七事件设计,E0-E2)
- `docs/design/tool-system-oop-2026-08.md`(AuditProjector → `tool/audit`)
- `docs/audit/soul-memory-retirement-2026-08-06.md`(`log/memory/` 来源)
- `docs/design/pi-benchmark-adoption-2026-08.md`、`reference_deepseek_harness_study`(事件日志唯一事实/一切皆投影——可作后续改造参照)
