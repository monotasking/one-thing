# 消息发送链路

> 现状快照：`redesign/prompt-assembly` 分支，2026-07-23。核心生成循环已迁移到
> `packages/core/agent-loop`，`src/main/engine/stream/tool-loop.ts` 已不存在——
> 若看到引用该文件的旧文档，以本文件为准。

## 整体链路

```
InputBox.vue (渲染进程)
  → chatStore.sendMessage()
  → platformApi.emitCommand() → IPC invoke
  → preload bridge → main 进程 IPC_CHANNELS.SESSION_COMMAND
  → StreamEngine.handleSendMessage()（main/onething-runtime/core 三层继承）
  → runtime.streams.executeMessageStream()
  → executeAgentLoopStreamGeneration（host 适配层）
  → buildAgentLoopRuntimeFromStreamContext（组装 prompt + provider + 工具）
  → runAgentLoop（packages/core/agent-loop/runner.ts，纯逻辑主循环）
  → provider 执行 + chunk 流回
  → 工具调用 → 权限检查 → 执行
  → EventBus.emit → IPCBridge → 渲染进程 chatStore 更新
```

## 1. 渲染进程发起

- `src/renderer/components/chat/InputBox.vue:1448` `sendMessage()` 组装文本/附件，
  `emit('sendMessage', ...)` 交给 `ChatPanel.vue`。
- `src/renderer/stores/chat.ts:2073` `sendMessage(sessionId, content, attachments?, options?)`：
  解析 provider 覆写、处理新会话草稿，调用
  `platformApi.emitCommand(sessionId, { type: "command:send-message", ... })`（chat.ts:2112）。

## 2. IPC 通道

### 2.1 渲染进程 → Preload 桥

- `platformApi`（`src/renderer/platform/electron.ts`）→ `window.electronAPI`。
- preload 桥：`apps/electron/src/preload/bridge.ts:118-120`：
  ```ts
  emitCommand: (sessionId, command) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMMAND, { sessionId, command })
  ```
- 命令类型定义在 `packages/shared/events/session-commands.ts`（`SendMessageCommand`）。

### 2.2 Main 进程 IPC handler 注册

Preload 的 `ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMMAND, ...)` 到达 main 进程后，由
`apps/electron/src/ipc/session-command.ts` 注册的 `ipcMain.handle` 接收：

```ts
// apps/electron/src/ipc/session-command.ts
export function registerElectronSessionCommandIpcHandler(options) {
  const host = options.ipcMain ?? ipcMain
  host.handle(options.channel, (_event, request) => {
    return options.handleCommand(request)  // → 转交给回调
  })
}
```

调用方在 `apps/electron/src/main/ipc/handlers.ts:100-112`：

```ts
registerElectronSessionCommandIpcHandler({
  channel: IPC_CHANNELS.SESSION_COMMAND,
  handleCommand: async ({ sessionId, command }) => {
    return emitCoreSessionCommandForIpc({
      sessionId,
      command,
      eventBus: getEventBus(),    // ← 拿到全局单例 EventBus
      logger: console,
    })
  },
})
```

### 2.3 IPC → EventBus（解耦桥）

`emitCoreSessionCommandForIpc`（`packages/core/events/ipc-operations.ts`）是一个带 try/catch
的安全包装，核心就一行：

```ts
const result = await options.eventBus.emit(options.sessionId, options.command)
```

这条命令注入 EventBus 后，经过 **Intercept → Commit → Fan-out** 三阶段管道，被所有
对该命令感兴趣的订阅者接收。IPC handler 到这里就完成返回——渲染进程只收到 `{ success: true }`，
不等待命令执行的最终结果。后续的流式事件（`message:created`、`content:part`、
`tool:execution-*` 等）通过**事件回传**（见第 7 节）走独立通道异步推给渲染进程。

### 2.4 StreamEngine 订阅命令

`CoreStreamEngine`（`packages/core/engine/core-stream-engine.ts`,2026-08-21 前是它的基类 `HeadlessStreamEngine`）通过
`onAnySession()` 跨 session 订阅所有命令：

```ts
protected subscribeToCommands(eventBus: TEventBus): void {
  eventBus.onAnySession('command:send-message', (envelope) => {
    const target = this.commandTarget
    if (!target) return
    this.handleSendMessageCommand(envelope.sessionId, envelope.event, target)
  }, 'StreamEngine')
  // 同时订阅 command:edit-and-resend、command:retry-message、
  // command:abort、command:resume-after-confirm 等
}
```

关键设计意图：
- `onAnySession` 意味着 StreamEngine 不需要为每个 session 单独注册——任何 session 的命令都会路由过来。
- 命令是"意图"（如 `command:send-message`），订阅者被动接收，发命令的代码不知道谁在听。
- 多个系统可以同时关心同一条命令（如 SessionManager 还订阅 `stream:start` 做自动创建 session），
  Fan-out 阶段依次投递给每个订阅者，互不干扰。

## 3. Main 进程处理（三层继承）

- `src/main/engine/stream-engine.ts:22` `StreamEngine extends OnethingStreamEngine`，
  `handleSendMessage`（line 37）只做频道会话路由改写，然后 `super.handleSendMessage(...)`。
- 真正逻辑在 `packages/core/engine/core-stream-engine.ts:459`：
  1. 解析 prompt refs/skills
  2. `this.store.addMessage` 落盘用户消息（line 498）
  3. 发 `message:user-created`（line 500）
  4. 首条消息异步触发标题生成（line 505）
  5. 解析 provider 配置（line 513）
  6. 创建并落盘占位的流式 assistant 消息（530-543），发 `message:assistant-created`
  7. `this.runtime.history.buildMessages` 构建历史（line 553）
  8. `this.runtime.streams.executeMessageStream({...})`（line 556）—— 交给下一层

## 4. 核心生成循环（本分支重点变更处）

三层结构：

- **Host 适配层**：`src/main/engine/stream/agent-loop-executor.ts:424`
  `executeAgentLoopStreamGeneration`：
  - 构建 turn 状态
  - `buildAgentLoopRuntimeFromStreamContext`（`agent-loop-runtime.ts:116`）组装 provider/工具/prompt
  - 驱动 `executeAgentLoopStreamLifecycleWithAdapters`（来自 `@onething/core/engine` =
    `packages/core/engine/agent-loop-executor.ts`，本次改动重点），提供通用的
    "准备 → 流式 → 应用 chunk → 收尾 → 后置钩子" 骨架。
- **纯逻辑主循环**：`packages/core/agent-loop/runner.ts:359` `runAgentLoop`，通过
  `bridge.ts:10` 的 `streamAgentLoopProviderChunks` 暴露为 async generator，在
  `agent-loop-executor.ts:470` 被调用：
  `streamChunks: (prepared) => streamAgentLoopProviderChunks(prepared.runtime)`。

层次关系：

```
packages/core/agent-loop/runner.ts          模型无关的轮次/工具调度纯逻辑
        ↓
packages/core/engine/agent-loop-executor.ts 通用生命周期/事件形态适配
        ↓
src/main/engine/stream/agent-loop-executor.ts  Electron host 专属：落盘、发事件、计费、triggers
```

这是一条连贯管线，不是新旧两套并存（`packages/core/tools/tool-loop.ts` 只是个无关的
17 行 `executeToolCalls` 小工具，跟发消息主链路无关）。

## 5. Provider 执行与 chunk 结构

- provider 通过 `createAgentProviderFromRuntime`（`src/main/providers/agent-runtime.ts:2`，
  实为 `packages/onething-runtime/src/agent-loop/providers/factory.ts`）解析到具体实现
  （`codex.ts` / `deepseek.ts` / `gemini.ts` / `openai-compatible.ts` / `claude.ts` / `acp.ts`）。
  Vercel AI SDK 已移除，各 provider 手写 fetch/SSE。
- `runner.ts:245` `executeProviderTurn` 驱动 `streamAgentProviderTurnEvents`
  （`packages/core/agent-loop/stream.ts`），收集 `AgentStreamEvent`。
- 转换为对外 chunk：`packages/core/agent-loop/provider-stream.ts:119`
  `agentEventsToProviderStreamChunks`，chunk 判别联合类型定义在 `chunks.ts:13-25`：
  `turn-start / reasoning / text / tool-input-start|delta / tool-call / tool-metadata /
  tool-partial-result / provider-data / tool-result / turn-end / finish / auto-retry`。
- `agent-loop-executor.ts:471` 逐个消费 chunk：`applyAgentLoopStreamChunk` →
  `coreApplyAgentLoopStreamChunkWithAdapters`。

## 6. 工具调用与权限

- `runner.ts:264-317` `collectEvent` 中检测到 `'tool-call-done'`（非 `externallyExecuted`）
  时，走 `ToolExecutionScheduler`（`tool-execution-scheduler.ts`）的
  `scheduler.enqueue(..., { barrier })` 做串行化调度。
- `onToolCallDone`（runner.ts:454-485）做 doom-loop 防护，调用
  `executeAgentToolCall`（runner.ts:203），委托给 host 的 `options.executeTool` →
  `src/main/engine/stream/agent-loop-runtime.ts:174-179` →
  `tool-execution.ts:39` `executeToolDirectly` →
  `packages/onething-runtime/src/tools/direct-tool-execution.ts` 的
  `executeOnethingDirectTool`，权限强制走
  `src/main/tools/core/permission-policy.ts` →
  `src/main/permission/index.ts` 的 `Permission.getMode` / `Permission.ask`。
- 需要确认时结果带 `requiresConfirmation`，`runner.ts:482-484` 抛出
  `AgentLoopPauseForConfirmationError`，循环暂停等待 `command:resume-after-confirm` 命令（`command:confirm-tool` 于 2026-08-22 随拍板 #26 删除：全仓零订阅者）。

## 7. 事件回传渲染进程

- `src/main/events/event-bus.ts:4` `EventBus.emit(sessionId, event)` 全程发事件
  （消息创建/流式 chunk/工具事件）。
- `ipc-bridge.ts:154` `eventBus.onAnySessionAny(...)` → `handleSessionEvent`（line 206）→
  `safeSend(IPC_CHANNELS.SESSION_EVENT, ...)`（line 228）/ `SESSION_STREAM`（288/302）
  发给渲染进程 webContents。
- 渲染进程 `ipc-hub.ts:52`（`onSessionEvent`）、`:249`（`onSessionStream`）接收后更新
  `chatStore`（消息、流式内容、工具调用状态）。

## 8. 系统提示词组装时机

- `src/main/engine/prompt/system-prompt.ts:73` `buildPrompt` 调用
  `packages/onething-runtime/src/prompts/builder.ts:66` 的 `buildOnethingPrompt`
  （本分支重点改动对象之一，含 golden 测试快照）。
- 调用点在 `agent-loop-runtime.ts:158-161` 的 `createAgentLoopRuntimeAdapters`，
  经 `buildAgentLoopRuntimeFromStreamContext` → `buildOnethingAgentLoopStreamRuntime`，
  在 `agent-loop-executor.ts:448-449` 的 `prepareRuntime()` 阶段执行——**在**
  `streamChunks(prepared)`（line 470）调用 provider **之前**。也就是说每一轮都会先
  完整组装系统提示词+工具定义，再发起 provider 调用。

## 迁移状态小结

没有发现新旧架构并存的死代码——`src/main/engine/stream/agent-loop-executor.ts`
是对 `packages/core/engine/agent-loop-executor.ts` 的薄 host 适配层，不是并行实现。
本分支改动的文件（`packages/core/agent-loop/*`、`packages/core/engine/agent-loop-executor.ts`、
各 provider 文件、`prompts/builder.ts` 及其 golden 快照）都精确落在这一条主链路上，
属于对 agent-loop / prompt-assembly 内部逻辑的持续打磨，而非架构分叉。
