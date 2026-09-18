# 代码库目录结构说明

> 生成时间：2026-07-23。基于对仓库实际代码的抽样阅读（而非仅凭目录名猜测）整理，覆盖 monorepo 全部主要目录。若目录内容发生较大变化，本文档需要重新核对。

## 0. 总览：分层与依赖规则

这是一个 monorepo，核心分层从下到上是：

```
packages/core            → 最底层：引擎/会话/权限/工具/存储的原语，零运行时依赖，不允许 import electron / runtime / gateway
packages/onething-runtime → 应用运行时：在 core 之上组装 prompts/themes/memory/media/scheduler/agents/agent-loop 等，Electron-free
packages/gateway          → 微信/Telegram 等 IM 渠道网关，只依赖 core
apps/electron             → Electron 宿主专属的 IPC/窗口/preload 代码（从 src/main 逐步搬迁中）
apps/server                → 无 Electron 的 headless HTTP 服务（端口 8787），给 web 端/网关等场景用
apps/web                   → 浏览器构建，复用 src/renderer 同一套 Vue 代码
src/main, src/renderer, src/preload, src/shared → Electron 应用本体（正在被逐步"瘦身"迁移进上面的 packages/apps）
```

`packages/core/__tests__/architecture-boundaries.test.ts` 用正则扫描强制执行这条边界规则：`core` 不能出现 `electron`、`ipcMain/ipcRenderer`、`src/(main|renderer|preload)/`、`@onething/runtime`、`@onething/gateway` 等字样；`onething-runtime` 不能依赖 `gateway` 或宿主代码；`gateway` 不能依赖 `runtime` 或宿主代码；renderer 只能通过 `platformApi` 触达原生能力。也就是说 **core 是唯一的地基，其余包都只能单向依赖它**。

技术栈：Electron 桌面壳 + Vue3/TS/Pinia 前端；AI 调用是手写的 fetch/SSE（`packages/onething-runtime/src/agent-loop/providers/`，已移除 Vercel AI SDK）；存储是文件系统（JSON/JSONL）；构建用 electron-vite；测试用 Vitest。

---

## 1. `packages/core/` — 最底层原语（`@onething/core`）

零依赖的纯 TypeScript 包，通过 19 个 subpath exports 对外暴露。没有 README，边界规则见上文。各子目录：

| 目录 | 作用 |
| --- | --- |
| `agent/` | 较早期/简化版的编排层：`AgentEngine` 把 `ContextManager` + `EventBus` + `StreamChannel` + `ToolExecutor/Registry` + `PermissionPolicy` 串起来驱动一个可插拔的 `Provider`。 |
| `agent-loop/` | 驱动"一轮 LLM 对话"的核心机制：`runAgentLoop`（runner.ts）、重试（retry.ts）、流式转换（stream.ts/chunks.ts）、工具调用排序调度（tool-execution-order/scheduler.ts）、能力协商（capabilities.ts）、消息/历史转换、prompt 注入钩子。与 provider 无关，是纯粹的"回合执行"机制。 |
| `context/` | 极简的内存对话历史：`ContextManager` 用 `Map<sessionId, AgentMessage[]>`，无持久化。 |
| `engine/` | **最大最核心的目录**（30+ 文件）：`core-stream-engine.ts`、`agent-loop-executor.ts`/`agent-loop-runtime.ts` 端到端驱动一轮对话；`history.ts`、`tool-orchestration.ts` 管理历史和工具调用编排；`stream-processor/executor/runtime.ts` 处理 SSE 流；`context-compact.ts` 等实现上下文压缩。相当于整个流式对话引擎的"大脑"，agent-loop 和 session 都被组装进这里。 |
| `events/` | 会话事件总线基础设施：`EventBus`（三阶段模型：拦截→提交（打序号/时间戳）→分发）、`RingBuffer`（有界事件回放）、`StreamChannel`（流式分片）。是所有其他层（engine/session/permission/mcp）的发布订阅骨架。 |
| `http/` | 通用 HTTP/SSE 小工具：`assertOkResponse`、`readSseEvents`/`readJsonSseData`，不含任何 provider 特定逻辑。 |
| `ipc/` | 传输无关的类型化路由抽象：`defineRouter()` 生成 `domain:method-name` 风格的 channel 名字。只定义"形状"，不涉及 Electron ipcMain/ipcRenderer 本身。是 gateway/runtime 定义 IPC channel 时共用的契约。 |
| `mcp/` | Model Context Protocol 客户端/桥接：`HeadlessMCPManager` 管理多个 MCP server 连接；`router.ts` 把 MCP 工具目录组装成可供 AI 调用的工具；负责把 MCP schema 转成 core 的 `ToolDefinition`。 |
| `permission/` | 工具执行前的用户授权流程：`Permission` 命名空间（Info/Response=`once|session|workdir|reject`/Mode）、请求合并（同一时刻多个相同请求共享结果）、授权策略匹配与持久化授权存储。 |
| `plugins/` | 完整插件系统：发现/加载（loader.ts）、生命周期钩子（before-compact/after-response）、插件可调用的 API（api-builder.ts）、管理器（CorePluginBootstrapper/Manager）、内置日志监控插件（log-monitor.ts，21k）。 |
| `providers/` | 只有类型定义（`types.ts`）：`Provider` 接口（`stream()` 返回异步流）、`ProviderStreamEvent` 联合类型。真正的 provider 实现不在这里。 |
| `session/` | 会话生命周期：`Session` 类挂在 EventBus+StreamChannel 上归约出 `SessionState`；`SessionManager`、`timeline.ts`（消息/步骤/用量重建）、`store-helpers.ts`（50k，会话增删改的一整套纯函数）。子目录 `session/storage/` 负责分页、JSONL 编解码、JSON 分页读取。 |
| `storage/` | 底层文件存储原语（不感知业务）：`json-file.ts`（原子读写）、`file-mutex.ts`（跨进程文件锁）、`async-save-queue.ts`（防抖异步写）、`lru-cache.ts`、`paths.ts`（全部数据目录路径的中心登记表）。 |
| `tools/` | 与具体工具实现无关的工具执行引擎：`ToolExecutor`/`ToolRegistry`（注册、enable 过滤、自动执行规划）、`PermissionPolicy`（AllowAll/DenyAll）、`permission-guards.ts`（区分免审批 vs 需审批）、`diff-hunks.ts`。具体工具（read/write/bash…）不在这里定义。 |
| `__tests__/` | 跨切面测试：架构边界测试 + `gateway-runtime`/`runtime-facade`/`slash-commands`/`turn-context` 等顶层文件的测试。 |

依赖层次大致是：`storage`/`events` 最底层 → `context`/`providers`/`tools` 依赖它们 → `agent` 组合 context+events+tools+providers → `agent-loop` 是并行的更完整回合执行层 → `engine` 位于 agent-loop/events/session 之上 → `permission`/`mcp`/`plugins` 是被 engine/tools 消费的横切服务。

---

## 2. `packages/onething-runtime/src/` — 应用运行时（`@onething/runtime`）

在 core 之上组装出真正的产品能力，Electron-free，可被 Electron/CLI/网关/web 复用。顶层 `runtime.ts`/`gateway-runtime.ts`/`stream-engine.ts`/`stream-processor.ts` 是"引擎→处理器→runtime→对话/产品 runtime"的分层链条。

| 目录 | 作用 |
| --- | --- |
| `acp/` | Agent Client Protocol 客户端/管理器，用于对接外部 ACP 智能体。 |
| `agent-loop/` | 核心回合执行引擎；`stream-runtime.ts`（36k）是主流式循环。**`agent-loop/providers/`** 是移除 Vercel AI SDK 后手写的 fetch/SSE provider 实现：`claude.ts`/`codex.ts`/`deepseek.ts`/`gemini.ts`/`openai-compatible.ts`/`acp.ts`，`sse.ts` 是底层 SSE 解析，`factory.ts` 是 provider 工厂。 |
| `agents/` | "Agent 预设"（id/系统提示词/工具白名单）的磁盘持久化。 |
| `auth/` | OAuth/设备码认证：PKCE、JWT 解析、token 存储、回调 HTTP server。 |
| `evals/` | 离线评测/事故复盘/回放/裁判打分系统：fixture 采集、trace/snapshot 存储、LLM-judge 评分、敏感度/校准审计——独立的 prompt/agent 质量评测系统，不随产品下发。 |
| `external-agents/` | 让 Onething 把一轮对话委托给外部 agent runtime（ACP、Claude Code SDK connector）的连接器抽象。 |
| `files/` | 文件系统工具原语：搜索、目录列表、ripgrep 封装、原子文件操作、回滚、watch。 |
| `goals/` | "目标"续推跟踪：续推次数上限、预算、错误重试、目标状态的 XML prompt 渲染。 |
| `headless/` | `cli-projections.ts`：为 headless/CLI 消费者投影 runtime 状态。 |
| `markdown/` | Obsidian 风格的 markdown 附件资源服务（解析/保存附件、vault 检测）。 |
| `mcp/` | MCP server 编排、能力列举、IPC 胶水层。 |
| `media/` | 图片生成、媒体库服务/展示、图片预览注册表、data-URL 工具。 |
| `memory/` | "Hermes"文件式长期记忆：追加/捕获/回顾流水线、诊断日志、按 workspace 隔离的管理文件、prompt 上下文注入。 |
| `music/` | 完整的电台/音乐子系统：`radio-conductor.ts`（队列/播放调度）、`radio-store.ts`、`now-playing.ts`、`ncm-cli-driver.ts`（驱动 ncm-cli 播放器）、歌词识别；`providers/ncm/` 是网易云音乐 provider。 |
| `perf/` | 极小的启动耗时打点 `startup-trace.ts`。 |
| `permissions/` | 对 `@onething/core/permission` 的 runtime 封装：授权存储、会话/工作目录级授权展示、面向 IPC 的批准/拒绝/列表 API。 |
| `plugins/` | 插件系统：日志监控插件、插件命令执行/列举。（`soul-memory.ts` 已于 2026-08-06 整树退役，见 `docs/audit/soul-memory-retirement-2026-08-06.md`；`note-skills.ts` 于 2026-09-18 随笔记领域 P3 退役 —— 笔记库的技能根今天走 `listCustomSkillRoots` 那条 `custom:` 链路，见 `docs/design/notes-obsidian-cli-2026-09.md` §4.4。） |
| `practice/` | 间隔重复练习/打卡引擎（engine/ledger/summary.ts）。 |
| `project-dirs/` | "已知项目"目录注册表：id/持久化/prompt 注入/存储。 |
| `prompts/` | **`builder.ts`（16k）就是 CLAUDE.md 中提到的"目录在上、正文在下"系统提示词构建器**：拼装基础系统提示词+工具指南+操作系统特定内容+记忆/待办规则片段（从 `content/` 下的原始 `.md` 文件导入）。`resolver.ts`/`store.ts` 管理用户自定义提示词模板；`tasks/` 导出记忆捕获/回顾任务专用的系统提示词。 |
| `providers/` | 服务"非 agent-loop"路径（标题生成、裁判等 utility 调用）的 LLM provider 层：`anthropic.ts`/`deepseek.ts`/`zhipu.ts`/`codex.ts`，模型注册表/能力表，`provider-routing/runtime/facade.ts`。与 `agent-loop/providers/` 并行但服务对象不同。 |
| `scheduler/` | 基于 cron 的任务调度：`cron.ts`/`scheduler.ts`/`agent-task-runner.ts`、运行历史。 |
| `search/` | 网络/本地搜索 provider 抽象与 runtime。 |
| `sessions/` | 会话持久化核心：`session-repository.ts`（30k）+ `storage-driver.ts`（21k）——分支、脱水、消息 runtime、流中止、工具确认、工作目录跟踪。 |
| `settings/` | App 设置的仓库/保存/IPC。 |
| `skills/` | 类 Claude-Code 的技能加载/管理系统（loader.ts 32k，manage.ts 26k）：技能发现、按会话启用、按优先级合并。 |
| `storage/` | 底层 JSON 存储：app-state、路径解析（paths.ts）、文件锁。 |
| `themes/` | 主题引擎：Base46 Lua 解析器、CSS 变量映射、角色映射、主题解析器（87k）、窗口主题化；`builtin/` 内置 16 套主题 JSON。 |
| `toc/`（session TOC） | 每轮判断是否延展/开启/跳过一个对话"分段"用于摘要，代价受控的启发式+LLM 分类器。 |
| `todo-plan/` | 待办/计划文件存储+文件系统监听。 |
| `tools/` | 工具执行框架：注册表、沙箱化 bash 执行器、编辑引擎、diff/替换器、文件变更审计队列、后台任务；`builtin/` 是具体工具实现（bash/read/write/edit/grep/glob/find/skill/goal/radio/practice/time/variable/fart），`web-search/` 含 Brave Search provider。 |
| `triggers/` | 技能回顾触发系统（`skill-review-core.ts` 39k）。 |
| `usage/` | Token 用量账本、计价表、汇总报表。 |
| `variables/` | 模板变量系统：schema/校验/注册表/存储；`providers/` 提供具体取值来源（日期时间、git 分支、goal、music-radio、笔记、session-store、后台任务）。 |
| `voice/` | TTS/ASR 服务 runtime 与 provider；`kws/`（关键词唤醒）、`volcano/`（火山引擎 ASR/TTS 会话与协议实现）。 |

---

## 3. `packages/gateway/src/` — IM 渠道网关（`@onething/gateway`）

只依赖 core，不依赖 runtime/宿主。

- `index.ts`：包入口，`startGateway`/`startGatewayFromEnv` 把 Allowlist、RateLimiter、GatewaySessionRegistry、GatewayBridge、Gateway 组装起来，按环境变量 `GATEWAY_CHANNELS` 实例化各渠道，并动态 import 外部的 `CoreConversationRuntime`（与 onething-runtime 类型层解耦）。
- `config.ts`：allowlist/渠道 id/权限配置/bot token 的环境变量解析。
- `core/`：渠道无关的网关引擎：
  - `channel.ts` — `Channel`/`InboundMessage`/`OutboundMessage` 接口。
  - `bridge.ts`（15k） — `GatewayBridge`，中心消息路由：应用白名单/限流、解析共享斜杠命令（切目录/压缩上下文/新会话）、按会话排队处理、通过 `MarkdownSafeOutboundBuffer` 把模型输出流式发回。
  - `markdown-safe-outbound-buffer.ts` — 只在句子/代码块/列表边界才输出"就绪"片段，避免截断 markdown 结构，同时遵守微信 2000 字上限——这就是 CLAUDE.md 提到的"markdown-safe streaming"。
  - `permission-coordinator.ts` — 实现"回复 1/2/3"的远程权限审批：按 session/channel/user 跟踪待处理权限请求，发文本提示，匹配数字回复，超时处理。
  - `gateway.ts`：轻量 `Gateway` 类，注册渠道并通过 bridge 启停。
  - `session-registry.ts`：channel/user → `GatewaySession`（对话 runtime 会话）映射。
  - `storage.ts`：网关本地 JSON 文件存储（微信鉴权状态等用）。
  - `middleware/`：`allowlist.ts`（谁能跟机器人说话）+ `rate-limiter.ts`（每分钟限流）。
- `channels/telegram/`：`TelegramChannel` 通过长轮询（`getUpdates`）实现 `Channel`，4096 字上限，轮询失败重试退避。
- `channels/wechat/`：`WechatChannel` 基于 `ilink/`（`auth.ts` 扫码登录/轮询/token 持久化对接 "ilinkai" 微信机器人桥接 API；`poller.ts` 收消息轮询；`sender.ts` 发文本/打字状态），并发出配对 UI 所需的鉴权生命周期事件。

---

## 4. `apps/` — 三个可独立构建的宿主

### `apps/electron/` — Electron 宿主专属代码（`@onething/electron-host`）

纯 TS 源码，没有自己的构建步骤，通过约 70 个 subpath exports 直接被引用。结构：`app/`（启动/ready/激活/退出生命周期）、`ipc/`（约 25 个文件，按领域拆分：chat/sessions/mcp/oauth/permission/plugins/scheduler/shell/skills/themes/todo-plan/tools/variables/window…）、`window/`（主窗口/搜索/设置/待办/图片预览窗口创建，macOS 面板，激活恢复）、`preload/`（`bridge.ts` + `create-api.ts` 构建 `contextBridge` 的 `electronAPI`），以及 `auth/`、`gateway/`、`music/`、`voice/`、`menu/`、`shortcuts/`、`network/proxy`、`accessibility/`、`logging/`。依赖 core、gateway、runtime。

它不是独立可跑的 app——`apps/electron/src/main.ts` 只是薄封装，真正打包用的入口仍是 `src/main/index.ts`（见根目录 `electron.vite.config.ts`），大量 import `@onething/electron-host/*`（别名到 `apps/electron/src`）以及仍在 `src/main/` 下的 `@main/*` 模块。`apps/electron/src/app/main-process.ts` 是把 `@main` 的 stores/engine/events/IPC bridge 与抽取出来的 window/gateway/voice/shortcuts/bootstrap 拼在一起的编排器——印证了 CLAUDE.md 描述的"src/main 正在逐步瘦身迁入 packages/apps"。

### `apps/server/` — Headless 核心服务（`@onething/server-host`）

只有 4 个文件：`index.ts`（桶导出）、`http.ts`（原生 Node `http`，无框架，CORS + Bearer token 鉴权（`timingSafeEqual`），基于 `OnethingRuntimeFacade` 的 REST 式路由，暴露 `/api/memory/*`、channel-identity、session 等端点）、`runtime.ts`（`createDevelopmentOnethingServerRuntime` 用文件存储组装出 AgentEngine/EventBus/StreamChannel 支撑的 facade）、`main.ts`（进程入口：读 `ONETHING_SERVER_PORT`（默认 8787）、`ONETHING_SERVER_HOST`（默认 127.0.0.1）、`ONETHING_CORS_ORIGIN`（默认 `http://127.0.0.1:5174`）、`ONETHING_SERVER_TOKEN`，非回环地址且无 token 时会警告）。只依赖 core 和 runtime，无 Electron。这是让会话/记忆等能力脱离 Electron 独立运行的 headless 对应体，供 `apps/web` 的 dev 代理目标使用。

### `apps/web/` — 浏览器构建（`@onething/web`）

只有 `dev`/`build` 脚本（裸 Vite + Vue 插件）。`vite.config.ts` 把 `root` 设为仓库根目录，`@`/`@renderer` 别名指向 `src/renderer/`，`@shared` 指向 `src/shared/`，并代理 `/api` 到 `apps/server`（默认 8787，可用 `ONETHING_API_URL` 覆盖）。也就是说它构建的是**跟 Electron 完全同一套** `src/renderer` Vue 代码，只是没有 Electron 的 preload 桥。dev 端口 5174 与 server 的默认 CORS origin 对应。没有自己的 `src/` 目录，纯粹是构建配置。

---

## 5. `src/main/` — Electron 主进程（约 40 个子系统）

主进程是事件驱动架构：EventBus 是中枢，命令（`command:*`）从渲染进程发来，StreamEngine 处理后发出事件（`content:part`/`step:updated` 等），IPCBridge 转发给渲染进程。以下按子目录列出：

| 目录 | 作用 |
| --- | --- |
| `acp/` | 对 `@onething/runtime/acp` 的主进程再导出壳，加一层 `permission-bridge.ts` 把 ACP 权限请求接入本应用的 Permission 系统。 |
| `agent-loop/` | 组装每轮 agent-loop runtime：`buildAgentLoopRuntime()` 把工具注册表（经 `tools.ts` 桥接为 core 的 `AgentTool`）和各 provider 适配器（`providers/{claude,codex,deepseek,gemini,openai-compatible,acp}`，经 `factory.ts` 选择）组合起来。 |
| `agents/` | 用户自定义 Agent 定义（系统提示词/工具集）的持久化存储，封装 runtime 的 `createOnethingAgentStore`。 |
| `auth/` | OAuth/token 生命周期：`AuthService` 继承 runtime 的 `OnethingAuthService`，注入 Electron 专属 fetch；`callback-server.ts` 起本地 HTTP server 接收 OAuth 回调。 |
| `bridges/` | 把内部 EventBus/StreamChannel 事件翻译成渲染进程可见的 IPC channel（`session:event`/`session:stream`）。`safeSend()` 防止向已销毁窗口发送；文本/推理/工具输入的流式增量会在每会话 16ms 缓冲区里合并再发，`stream:complete` 前保证清空缓冲，避免丢 token。 |
| `channel/` | 多渠道（IM/API/桌面/语音）身份与会话路由：`ChannelSessionRouter.route()` 把消息来源解析为身份域下的规范 sessionId，为新 IM/API 发送者建会话；`connector-registry.ts` 注册 IM 连接器；`outbound-reply-dispatcher.ts` 按正确渠道回发。 |
| `cli/` | 独立 CLI/daemon 入口：`daemon start/status` 起/连后台 daemon 进程（`daemon-server.ts`），经 NDJSON（`ndjson.ts`）与 `daemon-client.ts` 通信。 |
| `engine/` | **核心对话执行引擎**。`StreamEngine` 继承 runtime 的 `OnethingStreamEngine`，重写 `handleSendMessage`/`handleEditAndResend` 经 `ChannelSessionRouter` 路由（除非是系统内部来源如 goal 续推）。子目录 `stream/` 是实际回合机制（`stream-processor/executor`、`tool-orchestrator`、`tool-execution*`、`agent-loop-executor`、`message-helpers`、`provider-helpers`、`image-generation/stream`、`chat-logger`）；`prompt/system-prompt.ts` 通过 runtime 的 prompts 系统构建系统提示词（拉入 skills、agent 定义、todo-plan 目录、AGENTS.md）；`triggers/` 是对话后触发器（goal 续推、技能回顾、session-toc、轮次评估）。 |
| `events/` | App 级类型化发布订阅骨架：`EventBus` 是对 core `EventBus` 的薄子类化（带上应用专属的 SessionEvent/GlobalEvent 类型）；`stream-channel.ts`/`ring-buffer.ts` 负责流式分片投递和缓冲回放。 |
| `external-agents/` | 把外部 CLI 编码智能体（目前是 Claude Code）接成连接器：跨常见安装路径定位本机 `claude` 可执行文件，用 JSON 文件持久化本地会话↔外部会话的映射，经 Permission 系统把关。 |
| `goals/` | 驱动自主"目标"运行：`kick.ts` 的 `emitGoalDrive()` 是续推目标的唯一入口，会保留会话真实传输渠道（`lastConnector`）以确保权限提示路由正确；`kickGoalRunIfIdle()` 仅在目标激活且无进行中流时触发。 |
| `headless/` | `HeadlessBackend`：不建 Electron 窗口即可启动整套 runtime（stores/settings/沙箱/工具注册表/事件系统/会话层/流引擎/触发器/权限/变量/目标/项目目录/技能/MCP/ACP），供 CLI daemon 和后台运行复用。 |
| `ipc/` | 约 30 个按领域拆分的 IPC handler 注册文件（chat/sessions/settings/agents/models/providers/tools/mcp/skills/shell/media/permission/oauth/themes/memory/scheduler/files/markdown/acp/channel-identity/goal/evals/usage/practice/app-state/plugins）。`handlers.ts` 的 `initializeIPC()` 是中枢启动函数，同时注册统一的 `session:command` handler 把渲染进程命令经 EventBus 路由给流引擎/权限系统。 |
| `logging/` | 全应用文件日志：`RollingFileLogger`（可配置滚动/归档/保留策略，gzip 压缩），patch `console.*` 和 `process.stdout/stderr.write` 使其同时写日志，并捕获渲染进程 console 输出和未捕获异常。 |
| `markdown/` | 解析/保存 markdown 内嵌资源（笔记系统用），封装 runtime 的 markdown 包，注入应用专属的编辑器设置和笔记根目录适配器。 |
| `mcp/` | MCP server 集成：`MCPManager` 继承 core 的 `HeadlessMCPManager`；`bridge.ts` 把 MCP 暴露的工具桥接进本应用工具注册表（schema 校验、路由），并把工具目录缓存到磁盘。 |
| `media/` | 对 runtime `MediaLibraryService` 的 Electron 适配，接上应用专属路径，用于索引/持久化聊天附带的图片和媒体文件。 |
| `memory/` | "灵魂记忆"workspace 层：解析按 agent/渠道用户区分的记忆根路径，对 agent/session id 做安全化处理；`diagnostics-logger.ts` 记录记忆捕获/回顾诊断日志。 |
| `music/` | 音乐 CLI 子进程生命周期管理（NCM 等 provider）、正在播放轮询、设置持久化；`radio.ts` 在此之上构建自主"电台"功能（DJ 语音/保活循环）。 |
| `network/` | 只有 `proxy.ts`：应用/校验 Electron 网络栈的代理设置，并提供 `testProxy()` 真实请求测连通性。 |
| `permission/` | 目录级权限系统：把授权存储配置到 `~/.onething` 权限目录，注册内置能力；`unattended.ts` 处理无人值守/后台运行的自动批准策略。 |
| `plugins/` | `PluginManager` 继承 core 的 `CorePluginManager`，注入宿主回调（扫描/加载/销毁/启用）；`builtin/` 内置一批首方插件（日志监控、笔记技能、灵魂记忆）。 |
| `practice/` | 单例"练习"节奏引擎（如番茄钟/凯格尔计时）：驱动 runtime 里的纯状态机 + 真实 1Hz 定时器，JSON 账本持久化，经 IPCBridge 推 `PRACTICE_EVENT` 给渲染进程。 |
| `project-dirs/` | 独立于变量系统的项目注册表（`~/.onething/project-dirs/`），提供当前/已知项目的 prompt 上下文渲染。 |
| `prompts/` | `resolver.ts` 把聊天消息里的 `@prompt`/`@skill` 引用解析成模型/展示两种文本；`store.ts` 是提示词 CRUD 存储。 |
| `providers/` | Electron 侧的 provider 门面：在 runtime 的 provider 编排之上加 OAuth、ACP prompt 流式、应用绑定 fetch、请求 dump；`agent-runtime.ts` 解析各 provider 的运行时路由（含 ACP 检测）。 |
| `scheduler/` | 配置 runtime scheduler 的状态文件路径；`user-tasks.ts`/`run-history.ts` 在核心 scheduler 上叠加用户自定义任务和运行日志。 |
| `search/` | "Search Everywhere"功能：`executeSearch` 和每日笔记创建逻辑。 |
| `session/` | 对 core `Session`/`SessionManager` 的单例访问层：`initializeSessionLayer()` 把核心会话管理器接到本地 EventBus/流通道；`usage.ts` 做会话级用量聚合。 |
| `skills/` | Hermes SKILL.md 加载器：Electron 专属适配器（打包路径、插件技能根目录、自定义目录、按音乐 provider 门控技能目录）；`manage.ts` 提供技能文件的增删改。 |
| `storage/` | 通用 key-value/文件存储抽象，封装 core 的 `HeadlessStorageManager`，目前只支持 `'file'` 后端。 |
| `stores/` | 中心持久化层：`sessions.ts`（会话增删改，300ms 节流异步写盘避免阻塞流式输出）；`settings.ts`/`app-state.ts`；`paths.ts`（几乎所有其他子系统都用到的路径解析中心）；`session-repository/` 处理分页。 |
| `themes/` | `builtin/` 内置 15 套主题 JSON（catppuccin/dracula/nord/gruvbox/solarized/tokyo-night/one-dark-light/github-dark-light/rose-pine/flexoki）供主题管理器使用。 |
| `toc/` | "Session TOC"：每个实质性回合跑一次小模型调用维护意图分段描述，原地修订当前分段而非累积笔记，失败只丢一次修订不影响正常对话。 |
| `todo-plan/` | 封装 runtime 的 `OnethingTodoPlanStore`/`Watcher`：待办/计划文档持久化并监听外部编辑（因为 AI 是用普通 read/write 工具写待办的），广播 `TODO_PLAN_CHANGED`。 |
| `tools/` | `core/`（Tool 基类、沙箱、bash 执行器、权限策略、后台任务）+ `registry.ts`（工具注册表）+ `builtin/`（bash/read/write/edit/find/goal/radio/practice/skill/variable/headless 等具体工具实现）。 |
| `usage/` | Token 计费账本：`recordUsage()` 是唯一入口，每次 LLM 调用都按 source（chat/title/memory/goal/evals）和 platform 打标写入 JSONL 账本；区分订阅制 provider（codex/claude-code/github-copilot）和按量计费的。 |
| `utils/` | 杂项底层工具：`ripgrep.ts`（文件搜索）、`fuzzy.ts`（模糊匹配打分）、`accessibility.ts`（macOS 辅助功能/屏幕录制权限检查）、`login-shell-env.ts`、`wildcard.ts`。 |
| `variables/` | 标量变量子系统：`bootstrapVariableSystem()` 初始化变量存储，注册标准 provider（工作目录、笔记、全局/会话存储、goal、音乐电台网关），把注册表变化桥接为 `session:variables-updated` 事件。 |
| `voice/` | 语音运行时编排：管理独立语音进程/窗口、`VoiceAudioRouter` 音频路由、`kws.ts` 唤醒词检测、`providers.ts`（OpenAI/OpenRouter STT/TTS）；经事件总线把语音事件/延迟里程碑发给渲染进程。 |

---

## 6. `src/renderer/`、`src/preload/`、`src/shared/` — 渲染进程与共享层

### `src/renderer/`

| 目录 | 作用 |
| --- | --- |
| `components/` | 按功能分组的 Vue 组件：`chat/`（消息列表、输入框、工具调用渲染，含 `composer/`、`message/` 子目录）、`sidebar/`（会话列表/组织器）、`settings/`（各设置 tab，含 `provider/`、`mcp/`、`skills/`、`evals/`）、`common/`（自研 UI kit：Button/Table/Menu/Splitter/VirtualTable 等）、以及 `evals/`、`memory/`、`search/`、`voice/`、`workbench/`、`editor/` 等功能目录。多数功能目录自带 `__tests__/`。 |
| `composables/` | 跨切面 UI 逻辑的 Vue 组合式函数：流式/markdown 渲染（`smoothStreamingText`/`parseStreamingMarkdown`/`streamingReveal`）、会话视图逻辑（`useChatSession`/`useSessionEvents`）、编辑器/文件处理（`useFileBuffers`/`useFileDrop`/`useAttachments`）、UI 工具（`useShortcuts`/`useInputHistory`/`useFollowScroll`）。还有一个装饰性桌宠功能 `pixelPet/`。 |
| `data/` | 单个静态数据文件 `mcpPresets.ts`（设置页用的 MCP 预设配置）。 |
| `editor/` | 编辑栈：`MonacoEditor.vue`（代码编辑）、`TextEditor.vue`（CodeMirror，composer 在用）、`tiptap/TiptapNoteEditor.vue`（所见即所得的 markdown 笔记/草稿纸，唯一的 markdown 撰写面）、`slash/`（块菜单）、`triggers.ts`（`/`、`@` 触发器）。 |
| `platform/`（**架构关键**） | 实现 CLAUDE.md 要求的唯一宿主访问面 `platformApi`：`index.ts` 导出一个 `Proxy`，按属性访问动态解析到 `createElectronPlatformApi(window.electronAPI)` 或 `createWebPlatformApi()`（取决于 `window.electronAPI` 是否存在）。`web.ts`（1338 行）是浏览器构建下同一套 API 的完整并行实现（用 SSE `EventSource`、REST 调用、能力降级提示）。这是"渲染进程永不直接用 `window.electronAPI`"规则的落地点。 |
| `services/` | `ipc-hub.ts`（**架构关键**）：`initializeIPCHub()` 是启动时唯一的 `platformApi.onSessionEvent()` 监听者，把统一的 `SessionEventEnvelope` 事件扇出为 `chatStore` 的状态变更，避免每个组件各自注册监听造成竞态。`commands/index.ts` 是斜杠命令注册表；`palette.ts` 是命令面板逻辑；`practice-sound.ts` 是练习功能的音效。 |
| `stores/` | Pinia 状态：`chat.ts`（按 sessionId 的消息/流状态）、`sessions.ts`、`settings.ts`、`themes.ts`、`media.ts`，以及 `workspace*.ts`、`voice.ts`、`music.ts`、`agents.ts`、`prompts.ts`、`practice.ts`、`evals*.ts`。`helpers/` 存放聊天渲染用的共享 reducer/视图模型构建函数。 |
| `styles/` | 全局 CSS：`main.css`、`variables.css`、`components.css`、`markdown.css`、`hljs-theme.css`、`flexoki-colors.css`，及 `themes/` 子目录。 |
| `types/` | 渲染层本地类型：`index.ts`（桶导出，扩展共享 IPC 类型为 `ElectronAPI`）、`commands.ts`、`palette.ts`、`tabs.ts`。 |
| `utils/` | 通用工具：`format.ts`、`clipboard.ts`、`diff-hunks.ts`、`scroll-chain.ts`/`stream-scroll-trace.ts`（流式滚动调试）、`perf.ts`。 |

### `src/preload/`

顶层 `src/preload/` 目前**已清空**（只剩缓存产物），真正的 preload 代码已迁移到 `apps/electron/src/preload/`：

- `bridge.ts`（1475 行）：真正的 preload 脚本，从 `../../../../src/shared/ipc.js` 引入 channel 常量和类型，构建一个巨大的 `electronAPI` 对象（`ipcRenderer.invoke`/`.on` 的薄封装），最后 `contextBridge.exposeInMainWorld("electronAPI", electronAPI)`——渲染进程里的 `window.electronAPI` 就是这个对象，只应经 `platformApi` 消费。
- `create-api.ts`：更新的通用封装，`createRouterAPI<T>(router)` 为 `@onething/core/ipc` 的 `Router` 自动生成类型化 `ipcRenderer.invoke()` 包装，取代手写每个 bridge 方法。
- `package.json`：`{"type": "commonjs"}`（preload 的 CJS 限制）。

### `src/shared/`

| 目录 | 作用 |
| --- | --- |
| `ipc/` | IPC 契约层：`channels.ts`（429 行，`IPC_CHANNELS` 常量表，是 preload 和主进程共用的唯一真源）、`index.ts`（763 行桶文件，聚合各领域类型模块：chat/settings/providers/voice/music/agents/evals/mcp/memory/permissions/scheduler/search/themes/tools/todo-plan/plugins/gateway/acp/oauth/usage/variables/channel-identity 等，一域一文件）。 |
| `events/` | 统一会话事件系统：`envelope.ts`（`SessionEventEnvelope`，带 sessionId/单调序号/时间戳用于环形缓冲回放）、`session-commands.ts`（意图：SendMessageCommand/EditAndResendCommand）、`session-events.ts`（397 行，实际发生的事实：StreamStartEvent/StreamCompleteData/工具调用结果事件等，归约成 SessionState）、`stream-chunks.ts`（对 core 事件类型的薄再导出）、`global-events.ts`（非会话级的全局事件）。 |
| `types/` | 极简的环境声明：`md-raw.d.ts`、`culori.d.ts`。 |
| `backend/` | `store-lock.ts`：跨进程存储文件锁的再导出壳（来自 runtime）。 |
| `cli/` | `protocol.ts`：daemon/CLI 的 IPC 协议定义（DaemonRequest/Response、错误码）。 |
| `defaults/` | `settings.ts`：`AppSettings` 默认值的唯一真源。 |
| `voice/` | `tts-stream.ts`/`segmenter.ts`/`speak-markup.ts`：对 runtime 语音文本处理模块的再导出壳。 |

**架构小结**：`platformApi` 用 `Proxy` 把渲染进程代码统一指向 Electron 真实 API 或 Web 平替实现，是"永不直接碰 `window.electronAPI`"规则的落地点；`services/ipc-hub.ts` 是消费 `platformApi.onSessionEvent` 的唯一入口，把事件转成 store 变更，避免各组件各自监听造成竞态。

---

## 7. 顶层其他目录

| 目录 | 作用 |
| --- | --- |
| `docs/` | 设计/调研笔记（多为中文），子目录 `design/`（各功能改版方案）、`audit/`（系统审计报告）、`deploy/`、`superpowers/`、`wechat-ilink-official/`。纯文档，不含代码。 |
| `scripts/` | 约 25 个开发运维脚本：`dev-unified.mjs`/`dev-with-logging.mjs`（多进程 dev 编排）、`build-macos-panel.mjs`（构建原生面板插件）、`convert-sessions.mjs`/`migrate-*.mjs`（数据迁移）、`release.sh`/`sign-dev-binaries.mjs`（发布/签名）、`headless-boundary-check.ts`（架构边界检查产物）等，`lib/` 是辅助函数子目录。 |
| `resources/` | 随包分发的资源：`skills/`（内置技能：netease-music-cli、onething-model-config、onething-music-radio、onething-verification）、`native/`（预编译的 `macos_panel.node`）、`models/`、`templates/security/`、`onething.png` 图标源文件。 |
| `evals/` | Prompt 质量评测系统（README 已确认）：在线信号采集 + 离线用例打分。`run.mjs`（CLI 入口，`bun run evals`）、`cases/`/`fixtures/`/`runs/`/`results.jsonl`、`runner/`（评测框架）、`DESIGN.md`/`triage.md`/`experiments.md` 设计文档。与单元测试无关，评的是 LLM 行为质量。 |
| `native/macos-panel/` | 原生 Node 插件（node-gyp，`macos_panel.mm` Objective-C++），实现 macOS 浮动面板窗口行为（类似 NSPanel 的置顶/非激活窗口），构建产物在 `resources/native/macos_panel.node`，被 `apps/electron/src/window/macos-panel.ts` 消费。 |
| `site/` | 单页营销落地页（`index.html`，中文，"onething — 会动手的桌面 AI"），经 `scripts/deploy-site.sh` 部署，不参与 app 构建。 |
| `sample-plugins/` | 两个示例插件（hello-world、log-monitor），演示插件 API 给第三方/示例作者参考，不作为实际启用的插件。 |
| `bin/` | 单文件 `onething.mjs`：`import '../out/main/cli.js'` 的薄封装，作为 npm-bin/全局 CLI 入口。 |
| `build/` | 仅 app 图标资源（`.icns`/`.ico`/`.png`），供 electron-builder 打包用，无代码。 |
| `public/` | Vite 静态资源，原样拷贝进 Electron 渲染进程和 `apps/web` 构建：`favicon.svg`、`voice/`（语音功能的音频/worklet 资源）。 |

---

## 附：如何验证本文档仍然准确

- 目录边界规则的强制执行点：`packages/core/__tests__/architecture-boundaries.test.ts`
- 系统提示词组装的单一入口：`packages/onething-runtime/src/prompts/builder.ts`
- IPC channel 常量单一真源：`src/shared/ipc/channels.ts`
- 所有磁盘路径解析的中心：`src/main/stores/paths.ts`（Electron 侧）与 `packages/onething-runtime/src/storage/paths.ts`（runtime 侧）
