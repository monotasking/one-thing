# 发送一条消息

从输入框按下发送,到向模型发出 HTTP 请求,再到回复逐字上屏。

- 角色:**干活** / **壳**(只转交或换形状,第一遍可跳过)/ **查表**(按名字找下一步,跳转到定义过不去)
- 路径都相对仓库根;前端的 `src/` 指 `apps/desktop-react/src/`
- 状态对应分支 `claude/upbeat-mccarthy-qxsjiv`:发送走具名方法 `session-command.sendMessage`。
  通用入口 `emit` 仍然接受 `command:send-message`,走的是后端同一个本地函数

## 总图:一次发送是两条连接

```
渲染进程(React)                                  主进程(Electron,后端)
                                                    
 按钮 → … → fetch POST /api/rpc  ─────────────►  HTTP 入口 → 查 RPC 表 → handler
                                    ◄── {success}          │ 投进事件总线就返回
                                                            ▼
                                                   引擎 → agent 循环 → provider → fetch 模型 API
                                                            │ 生成过程中不断发事件
 chat-source ◄── GET /api/events(SSE 长连接)◄──  总线 / streamChannel 订阅者
```

`POST /api/rpc` 只负责把命令送到后端,命令进总线就返回。**回复全部走另一条 SSE 长连接。**

## 一、前端:按钮 → HTTP 请求

| # | 角色 | 位置 | 做什么 |
|---|---|---|---|
| 1 | 干活 | `src/composer/components/Composer.tsx` 发送键 `onClick` | 读出输入框文字与分段,调 `doSend` |
| 2 | 干活 | `src/composer/useComposerSend.ts` 返回的函数(Composer 里叫 `doSend`)→ `sendPlain` | 是 `/命令` 就执行命令;否则发消息。还没绑定会话时先建会话 |
| 3 | 干活 | `src/composer/store.ts` 的 `send` | 收集附件,交出去后清空附件与抽屉 |
| 4 | 壳 | `src/composer/sink.ts` 的 `realSink.send` | 转给 `sendChatMessage`(这一层只为测试时能替换) |
| 5 | 壳 | `src/data/chat-source.ts` 的 `sendChatMessage` | 按 `sessionId` 找到这条会话的 source,转给它 |
| 6 | 干活 | `src/data/chat-source.ts` 会话 source 的 `send` | 铸 `messageId`,先画「发送中」的乐观气泡,调 `dispatch`(不等结果) |
| 7 | 干活 | `src/data/chat-source.ts` 的 `dispatch` | 调端口;失败时把气泡标为失败 |
| 8 | 干活 | `src/data/chat-port.ts` `realPort()` 里的 `sendMessage` | 读附件成 base64、展开页面引用,调 `sessionCommands.sendMessage(...)` |
| 9 | 查表 | `packages/client/rpc/router-client.ts` 的 `createRouterClient` | `sessionCommands = client.api(sessionCommandRouter)`:按 router 的方法名清单**在运行时生成**方法,源码里没有 `sendMessage` 的函数体。它等于 `invoke({ domain: 'session-command', method: 'sendMessage', payload })` |
| 10 | 干活 | `packages/client/transport/http.ts` `HttpTransport.invoke` | **`fetch POST {baseUrl}/api/rpc`**,带 Bearer token |

`baseUrl` / token 从哪来:启动时渲染进程经 `host:connection` 问主进程
(`apps/desktop-react/electron/preload.ts` → `src/platform/connection.ts` 的 `connect`)。桌面版也是真的 HTTP,走本机回环。

## 二、后端:HTTP 请求 → 命令进总线

| # | 角色 | 位置 | 做什么 |
|---|---|---|---|
| 11 | 干活 | `packages/backend/server/http.ts` `createOnethingServerRequestHandler` | 校验 token(失败 401),生成 `rpcContext`(调用者身份,只由后端生成,不从请求体读) |
| 12 | 壳 | 同文件 `handleRequest` → `matchRoute` | `POST /api/rpc` → `handleRpc`。其余分支是 SSE 推送和给手机端留的旧 REST 路由,可跳过 |
| 13 | 壳 | 同文件 `handleRpc` | 解析请求体,调 `dispatchRpc` |
| 14 | 查表 | `packages/backend/rpc/registry.ts` `dispatchRpc` | 按 `domain` 找域、按 `method` 查白名单、按契约声明检查会话写权限,再调 handler |
| 15 | 干活 | `packages/backend/rpc/domains/session-command.ts` 处理者 `sendMessage` → 本地函数 `sendMessage` | 拼成 `{ type: 'command:send-message', … }`;带附件而会话正忙 → 直接返回失败;处理 `presented`;调 `emitToBus` |
| 16 | 壳 | 同文件 `emitToBus` → `packages/core/events/ipc-operations.ts` `emitCoreSessionCommandForIpc` | 调 `eventBus.emit`,把结果包成 `{ success }` |
| 17 | 查表 | `packages/core/events/event-bus.ts` `EventBus.emit` | 拦截器 → 编号存入环形缓冲 → `fanOut` 同步分发给订阅者。**HTTP 请求在这之后就返回了** |

**跨过第 14 步的查表**:表是启动时填的。在 `packages/backend/rpc/index.ts` 搜 router 名(这里是 `sessionCommandRouter`),
那一行 `registerRpcDomain(router, handlers)` 的第二个参数就是实现对象,去它所在的文件找同名方法。

**跨过第 17 步的查表**:引擎在 `packages/core/engine/core-stream-engine.ts` 的 `subscribeToCommands` 里订阅,
按 `buildCommandHandlers` 这张「命令类型 → 方法」的表分派。找命令类型对应的那一项即可。

## 三、引擎 → 调用模型

| # | 角色 | 位置 | 做什么 |
|---|---|---|---|
| 18 | 查表 | `core-stream-engine.ts` `buildCommandHandlers` 里 `SEND_MESSAGE` 那一项 | 调 `this.handleSendMessage`,**不 await**(所以第 17 步很快返回) |
| 19 | 干活 | `packages/onething-runtime/src/engine/stream-engine.ts` `ProductStreamEngine.handleSendMessage` → `performProductSendMessage` | 权限检查、协作房间、路由到哪条会话、插件输入拦截,然后 `super.performSendMessage` |
| 20 | 干活 | `core-stream-engine.ts` `CoreStreamEngine.performSendMessage` | 会话正忙 → 改为插话;写入用户消息 → 发 `message:user-created`;建空的助手消息 → `openAssistantRun`(账本写 `run/start`)→ 发 `message:assistant-created`;组装历史;调 `this.runtime.streams.executeMessageStream` |
| 21 | 壳 | `packages/backend/wiring/engine/stream/stream-executor.ts` `executeMessageStream` | 准备上下文,调 `executeAgentLoopStreamGeneration`,结束时记账 |
| 22 | 壳 | `packages/backend/wiring/engine/stream/agent-loop-executor.ts` `executeAgentLoopStreamGeneration` | **组装一个装满回调的 `lifecycleOptions`**,交给第 23 步 |
| 23 | 干活(骨架) | `packages/core/engine/agent-loop-executor.ts` `executeAgentLoopStreamLifecycleWithAdapters` | 只定顺序:`prepareRuntime` → `emitStreamStart`(发 `stream:start`)→ `for await (chunk of streamChunks(...)) applyChunk(chunk)` → `completeStream` → 回复后钩子 → `stream:complete` / `stream:error` / `stream:aborted`。每一步去第 22 步的 `lifecycleOptions` 找同名回调 |
| 24 | 壳 | 回调 `streamChunks` → `packages/core/agent-loop/bridge.ts` `streamAgentLoopProviderChunks` | 挂上账本记录(`attachSessionEventRecorder`),启动 agent 循环,把它的事件转成片段流。是异步生成器,`for await` 第一次取值时才开始执行 |
| 25 | **干活** | `packages/core/agent-loop/runner.ts` `runAgentLoop` | **agent 主循环**:调模型 → 要调工具就执行工具(需要时询问权限)→ 把结果交回模型 → 直到不再调工具 |
| 26 | 干活 | 同文件 `executeProviderTurn` | 循环里的「一轮」:调一次模型,收集这一轮的结果 |
| 27 | 壳 | `packages/core/agent-loop/stream.ts` `streamAgentProviderTurnEvents` | 给 `provider.streamTurn` 加上「按停止就中断」 |
| 28 | **干活** | `packages/onething-runtime/src/agent-loop/providers/base/http-agent-provider.ts` `HttpAgentProvider.streamTurn` | 拼请求体(`buildBody`)、地址、鉴权 → `send` → `fetchOnce` → **`this.ctx.fetchImpl(url, { method: 'POST', … })` 向模型发请求** → `parseStream` 解析流式回复 |

**第 20 步的 `this.runtime.xxx.yyy`**:依赖注入,实现不在 core。去
`packages/backend/wiring/engine/stream-engine-runtime.ts` 的 `createMainStreamEngineRuntime` 搜 `yyy`;
分到哪个组看 `packages/onething-runtime/src/product-stream-runtime.ts`。

**第 28 步的 `provider` 是什么**:按 `providerId` 查表造出来的
(`packages/onething-runtime/src/agent-loop/providers/factory.ts` 的 `createAgentProviderFromRuntime`,
表由同文件底部的 `registerAgentProviderRuntime(...)` 填)。
类的层次:`BaseAgentProvider` → `HttpAgentProvider`(固定的发请求流程)→ 按协议分的 `wires/*`(比如 `OpenAIChatWire`),
再加按厂商分的配置 `dialects/*`(比如 DeepSeek)。ACP 不走 HTTP,有自己的 `streamTurn`(`providers/acp.ts`)。

## 四、回复:通过 SSE 回到屏幕

| # | 角色 | 位置 | 做什么 |
|---|---|---|---|
| 29 | 干活 | 第 22 步里的 `createEventOnlyEmitter` | 事件(工具开始 / 结束、用量、结束…)走**事件总线**;逐字文字、思考、工具参数片段走 **`streamChannel`** |
| 30 | 干活 | `packages/backend/server/http.ts` `subscribeLiveSessionEvents` | 前端那条 `GET /api/events` 连接订阅着总线和 `streamChannel`,用 `writeSse` 写成 `session:event` / `session:stream` |
| 31 | 壳 | `packages/client/transport/http.ts` 读 `/api/events` 的循环 | 解析 SSE,交给 `client.events` |
| 32 | 壳 | `src/data/chat-port.ts` 的 `onSessionEvent` / `onSessionStream` | 把两类推送接到 chat-source |
| 33 | 干活 | `src/data/chat-source.ts` `dispatchSessionEvent` / `dispatchSessionStream` → 会话 source 的 `handleEvent` / `handleStream` | 用户消息事件回来时按 `messageId` 认领第 6 步的乐观气泡(`reconcileOverlay`);文字片段不断追加,回复逐字上屏 |

## 账本(`events.jsonl`)怎么写

不经过总线订阅者,有两个直接入口:

- 消息的增删改:第 20 步的 `store.addMessage` 等调用 → `packages/backend/session/command-events.ts` 当场写入;
- 模型的流式输出:第 24 步挂上的 `attachSessionEventRecorder`(`packages/backend/wiring/engine/stream/session-event-recorder.ts`)。

每写一条,`packages/backend/session/event-broadcast.ts` 会把同一条记录作为 `session:ledger-event` 放上总线,再由 SSE 推给前端。

## 追主流程时可以跳过的旁支

| 看到的代码 | 为什么正常情况下不走 |
|---|---|
| 第 24 步里的 `rotateCredential` / `prepared.reprovision` | 凭证轮换:只在空间配置了多把 key、且请求失败时才触发;默认空间是 `undefined` |
| 第 25 步里的 `options.beforeTurn` | 每轮前的钩子:插话、上下文压缩。第一轮一般返回 `undefined`,消息原样发出 |
| 第 27 步里的 `provider.runTurn(...)` | 兜底分支:只给没有 `streamTurn` 的 provider 用。所有 provider 都有 `streamTurn`,在前面就 `return` 了 |
| `packages/onething-runtime/src/runtime.ts` 里的 `new CoreStreamEngine(...)` | 兜底分支:正式装配总会传入现成的引擎(`new ProductStreamEngine`,在 `packages/backend/wiring/engine/stream-engine-bound.ts`) |
| `packages/onething-runtime/src/gateway-runtime.ts` `createOnethingConversationRuntimeFromStreamEngine` | 给网关用的「会话门面」,包在已经建好的引擎外面,不是创建引擎的地方 |

## 引擎是在哪里装配起来的

```
packages/backend/backend.ts                  createStreamEngineLayer(...)
→ packages/backend/wiring/engine/index.ts    createStreamEngineLayer
    createMainStreamEngineRuntime()           造依赖表(之后的 this.runtime)
    createBoundStreamEngine(...)              new ProductStreamEngine(依赖表, ports)
    createOnethingRuntimeFromStreamRuntime({ createEngine: () => engine, … })
      → engine.setEventBus(eventBus)          引擎在这里订阅总线上的命令
```

## 基准

写这张地图时(2026-09-27),这条路径是:

- 前端:按钮到 `fetch` **10 步**,其中壳 2 步、查表 1 步;
- 后端:HTTP 入口到向模型 `fetch` **18 步**,其中壳 7 步、查表 3 步。

之后重构这条流程时,用这两个数字衡量有没有变简单。
