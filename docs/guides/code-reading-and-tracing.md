# 怎么读这个仓的代码 —— 概念与追踪

> 写给仓库所有者。分两篇:**概念篇**把进程模型和事件系统一次讲透(是什么、为什么、原理),
> **追踪篇**给出在代码里行走的方法。先读概念篇,追踪篇的每一步就都有"为什么"。
> (2026-08-24;行号以当日 main 为准,漂移后按符号搜。)

---

# 概念篇

## 一、进程模型:你的代码其实活在两个世界里

### 1.1 Electron 是什么

一个 Electron 应用 = **一个主进程 + N 个渲染进程**,这是两种完全不同的东西:

- **主进程(main)**:一个 Node.js 程序。有文件系统、能开子进程、能建窗口。全应用只有一个。
  你的**引擎、会话存储、工具执行、provider 请求,全部在这里跑**。
- **渲染进程(renderer)**:每个窗口一个,本质是一个 Chromium 网页。它是**沙箱**:
  没有 `fs`、没有 Node、不能直接碰主进程的任何对象。你的 Vue 界面在这里跑。

关键认知:**这两个世界之间没有函数调用**。渲染进程里拿不到引擎对象,主进程里拿不到 DOM。
它们唯一的沟通方式是**互发消息**(Electron 的 IPC:`ipcRenderer.invoke` ↔ `ipcMain.handle`),
消息必须可序列化(结构化克隆)——所以跨界的永远是**数据**,不是对象、不是函数。

两个世界中间有一道海关:**preload 脚本**(`apps/electron/src/preload/bridge.ts`)。
它在窗口加载前运行,用 `contextBridge` 把一小组白名单函数挂到网页的 `window.electronAPI` 上。
渲染层能做的所有跨界动作,就是这份白名单——这是 Electron 的安全模型:
网页(哪怕被注入了恶意脚本)只能做海关放行过的事。

> 🪧 **平台分界牌**:本文档凡写到 `ipcRenderer.invoke/on`、`ipcMain.handle`、
> `webContents.send`、`contextBridge`,都是 Electron 平台语义(进程间管道 + 事件发射器);
> 写到 `EventSource`/SSE 是浏览器语义。它们是仓库代码的"地基",仓里没有它们的实现——
> 追到这些名字 = 触底,往下查平台文档。

### 1.2 这个仓里,每段代码住在哪个进程

```
主进程(Node)                                渲染进程(Chromium 网页)
┌─────────────────────────────────┐          ┌──────────────────────────┐
│ apps/electron/src/main + app 等 │          │ packages/renderer        │
│ packages/backend(装配)         │  ← IPC → │  (Vue 组件、pinia store、 │
│ packages/onething-runtime(产品)│  只传数据 │   platform/ 适配层)      │
│ packages/core(骨架)            │          │ packages/shared(两边都有,│
│ packages/shared                 │          │  但只当类型和常量用)     │
└─────────────────────────────────┘          └──────────────────────────┘
              ▲ 中间:preload/bridge.ts(海关,contextBridge 白名单)
```

所以当你在 `packages/renderer` 里追代码追到"发出去了",不是代码写得绕——是**这个进程里
真的没有下一步的代码**。下一步的代码在另一个程序里。这就是追踪必然"断"的第一处,
而且它不是这个仓发明的,是 Electron(乃至一切多进程程序)的物理现实。

### 1.3 为什么跨界消息长成"信封",而不是一条条专用通道

历史上这个仓有 342 条手写通道(每个功能一条 `ipcMain.handle`),每条都要写:
通道名常量、preload 包装、类型、处理者——追踪时每条都是一次断路。2026-08 的传输面统一
把它们收敛成**一个通用信封**:

```ts
{ domain: 'session-command', method: 'emit', payload: {...} }
```

- 桌面:唯一一条 `rpc:invoke` 通道(`apps/electron/src/main/ipc/rpc.ts` 里唯一一个 handle)
- web:同一个信封改走 `POST /api/rpc`
- 窗口/原生对话框类(处理者必须在 Electron 壳里的):对称的第二条 `shell:invoke`

**原理**:既然跨界只能传数据,那就让数据自己携带地址(`domain.method`),
两端用同一份契约(`packages/shared/ipc/<domain>.ts` 里的 `defineRouter`)派生类型。
收信人的位置从此变成一条命名规律:**domain 名 = `backend/rpc/domains/<domain>.ts` 文件名**
(壳面 = `apps/electron/src/ipc/shell/<domain>.ts`)。
中间的搬运工(client、preload 包装、dispatch)对所有域是**同一份代码**,永远不用读。

契约和处理者的**配对现场**(启动时完成,见 3.2 第 3 步):`packages/backend/backend.ts:221`
调 `registerAppRpcDomains()`,它按 `packages/backend/rpc/index.ts` 里的**域表**逐条
`registerRpcDomain(router, handlers)` ——"这份契约由谁应答"就定在那一行,每个域一行,可 grep。
壳域同构:各 `@main/ipc/<d>.ts` 把处理者注册进 `shell-registry`。
web 侧的收信口:`POST /api/rpc` 由 `packages/backend/server/http.ts` 的路由接住,
调的是**同一个** `dispatchRpc`、同一张域表——所以两条传输的答案永远一致。

### 1.4 web / server / CLI 是同一形状的变体

- 桌面主进程里装配的那套 backend,同时挂一个 HTTP/SSE 面(A 期"一个 core"):
  浏览器访问 :5174 时,`/api/rpc` 打到的是**桌面同一个引擎**。
- 独立 `server:start` = 没有窗口的"主进程",同一份 backend 装配。
- 所以"渲染 ↔ 主进程"这个概念在 web 上变成"浏览器 ↔ server 进程",
  信封、契约、处理者**全部同一份**,只是传输从 IPC 换成 HTTP。
  这就是为什么概念篇只需要讲一次。

## 二、事件系统:一份完整说明书

### 2.1 它解决什么问题(为什么存在)

引擎处理一条消息的过程中,会连续发生几十件事:用户消息落盘了、流开始了、
第一段文本到了、工具要执行了、要用户审批了、流结束了……这些事的**消费者不止一个**:

- 桌面窗口要实时刷新 UI
- web 的 SSE 连接要推同样的东西
- 事件溯源要把它写进 `events.jsonl`
- 目标系统/协作房/插件想在某些事发生时做点什么

如果用函数调用表达,引擎就得 import 所有这些消费者——引擎从此和每个功能耦死,
而且加一个消费者就要改引擎。**发布/订阅(EventBus)是"一处发生、多处消费"的唯一干净表达**:
引擎只管喊一嗓子,谁关心谁订阅,引擎不知道也不需要知道听众名单。

### 2.2 两套词汇:进来的叫命令,出去的叫事件

| | 命令(command) | 事件(event) |
|---|---|---|
| 方向 | 外界 → 引擎("请做某事") | 引擎 → 外界("某事发生了") |
| 数量 | 11 条 | 50 条 |
| 声明处(单一源) | `packages/core/events/session-command-types.ts` | `packages/core/events/session-event-types.ts` |
| 消费者 | 每条**恰好一个**(见 2.5) | 每条**任意多个** |
| 例子 | `command:send-message`、`command:abort` | `stream:start`、`tool:call`、`message:created` |

这两张表是全仓的**词汇宪法**:checker(`checkSessionVocabularyUsesTheRegistry`)禁止在代码里
散写这些字符串,必须引用常量。这不是洁癖——它让"值"变成"符号",于是发射点和消费点
在语法上共享同一个标识符,全局搜索从"碰运气"变成"完备"(详见追踪篇)。

50 条事件按前缀分族,一眼可读:

```
stream:*    流生命周期(start/complete/error/aborted/usage/params-resolving)
content:*   文本内容(part/continuation)
tool:*      工具(call/result/input-start|end/execution-start|update|end/executing/metadata)
step:*      步骤面板(added/updated)
message:*   消息落盘(created/user-created/assistant-created/updated/deleted/replaced)
context:*   上下文(size-updated/compact-started|progress|completed)
permission:* 审批(request/timeout/queued/settled)
interaction:* agent 提问(requested/settled)
steering:*  追打(queued/consumed/retracted)
collab:*    协作房(board-changed/typing/turn-active/coordinator-changed/agent-changed)
session:*   会话元信息(renamed/variables-updated/goal-updated/collab-updated)
其余        request:snapshot、skill:activated、scratchpad:consumed …
```

### 2.3 总线本体:一个对象、一套信封、三段流水线

**它是谁**:`packages/core/events/event-bus.ts` 的 `EventBus` 类(纯逻辑、零依赖),
`packages/backend/events/event-bus.ts` 把它特化并持有**进程级单例**(`getEventBus()`)。
每个 backend(桌面主进程 / server 进程)恰好一只。它在 `createOnethingBackend` 的
"事件系统"一步诞生(3.2 第 3 步)——所以任何比它早执行的代码拿不到总线,这是装配次序的意义。

**信封**:`emit(sessionId, event)` 时,总线在 commit 阶段给事件盖章,包成:

```ts
SessionEventEnvelope = {
  sessionId,
  sequence,   // 每会话单调递增(event-bus.ts:112)——排序与断线续传的依据
  timestamp,
  event,      // 你 emit 的原始对象,type 就是词汇表里的值
}
```

**三段流水线**(`emit` 的全部工作,event-bus.ts:93 起):

1. **Intercept**:注册过的拦截器可以改写或吞掉事件(`intercept()`;插件系统用它);
2. **Commit**:盖 sequence + timestamp,写入该会话的**环形缓冲**(每会话默认 1000 条);
3. **Fan-out**:按(会话,类型)四个粒度把信封递给所有订阅者,逐个 try/catch——
   一个订阅者抛错不影响其他订阅者,也不影响发射方。


**没有事件池,没有轮询循环(纠正一个常见的心智模型)**:如果你想象的是
"事件进来先插进一个池子,有个循环不停遍历池子、推给订阅者"——那是消息队列系统
(Kafka 那类)的模型,**这个总线不是**。真相:

- 订阅者列表是真的:四张 `Map<…, Set<handler>>`(:48-56),`on()` 的本体就是
  `handlers.add(handler)`(:160)。
- 事件池不存在:事件从不排队等待处理。环形缓冲(:127 `buffer.push`)是**历史存档**,
  只有 `replay()`(:265)读它,没人轮询它。
- 轮询循环不存在:`emit()` 是**普通函数调用**——`fanOut`(:351)当场 `for..of`
  遍历四张表逐个直呼 handler(每个都包 try/catch,:365),遍历完 emit 返回。
  "推"就是函数调用本身。

一次 emit 的时序:引擎所在的 JS 任务里调 `emit` → 拦截器(有 await)→ 盖 seq 章
→ 存档 → fanOut 同步直呼全部订阅者(含 IPCBridge 的 handler,它体内就把
`webContents.send` 发了)→ emit 返回,主进程侧全部跑完。

你直觉里的"池 + 循环"**在平台层是真的**:JS 运行时本身就是一个大
`while(true){ 取任务,跑到完 }`,`webContents.send` 的消息进的是**渲染进程事件循环
的任务队列**(真队列),循环取出后才触发 ipcRenderer 发射器;async handler 的后半截
也排进这个循环。🪧 平台分界牌:队列和循环在 V8/libuv/Electron 里,仓库里搜不到是正常的。

三个推论:① 无积压——没池子就没"池子满",代价是慢订阅者拖慢 emit 调用方,
这正是高频增量不走总线、另走 16ms coalescer 的原因(见 2.7);② 顺序——同会话事件
按 emit 顺序到达每个订阅者(seq 单调 + 同步扇出);③ 隔离——handler 抛错互不传染。

**环形缓冲为什么存在**:web 的 SSE 断线重连时带 `?after=<sequence>`,
server 用 `replay(sessionId, fromSequence)`(:265)把漏掉的事件补发——
这就是浏览器刷新后流不丢的原理。

### 2.4 怎么监听(全部四种粒度)

```ts
const bus = getEventBus()   // backend 侧;core 内部则由装配注入

// ① 指定会话 + 指定类型
bus.on(sessionId, SESSION_EVENT_TYPES.STREAM_COMPLETE, envelope => {...})
// ② 指定会话 + 全部类型
bus.onAny(sessionId, envelope => {...})
// ③ 全部会话 + 指定类型     ← 系统级订阅者最常用
bus.onAnySession(SESSION_EVENT_TYPES.TOOL_CALL, envelope => {...}, '标签')
// ④ 全部会话 + 全部类型     ← 只有"转发器"该用(IPC 桥、SSE、事件溯源)
bus.onAnySessionAny(envelope => {...}, '标签')
```

每个方法返回 `Unsubscribe` 函数;第三参 `label` 会出现在日志里,排障时能看见是谁在订阅。
**渲染层永远不直接碰总线**(它在另一个进程)——渲染层收到的是桥转发的复制品(见 2.6)。

### 2.5 集中处理点:订阅者的完整名册

**命令侧**(11 条,收件人只有三个,全部在启动时用 `onAnySession(常量, …)` 注册):

| 命令 | 集中处理点 |
|---|---|
| 其余 9 条(send-message / abort / retry / edit-resend / compact / steering …) | `CoreStreamEngine.buildCommandHandlers()` —— **一张以常量为键的表**,`packages/core/engine/core-stream-engine.ts:527` 起,`subscribeToCommands`(:588)逐条挂上总线 |
| `command:permission-respond` | `packages/core/permission/index.ts:302` |
| `command:interaction-respond` | `packages/core/interaction/registry.ts:237` |

**事件侧**(50 条,订阅者按角色分三类):

| 角色 | 订阅者 | 粒度 | 干什么 |
|---|---|---|---|
| **转发器**(全量) | `apps/electron/src/main/bridges/ipc-bridge.ts:77` | ④ `onAnySessionAny` | 每个信封原样转成 IPC `session:event` 发给窗口 |
| | `packages/backend/server/http.ts`(每条 SSE 连接) | ④ | 同样的信封写进 SSE;断线用 `replay` 补 |
| | 事件溯源 recorder(S1 影子) | ④ | 写 `sessions/<id>/events.jsonl` |
| **系统器官**(指定类型) | `core/session/session-manager.ts:32` | ③ `STREAM_START` | 流开始时登记会话活跃态 |
| | `backend/session/validation.ts:41` | ③ `STREAM_COMPLETE` | run 结束触发影子校验 |
| | `backend/wiring/goals/runtime-hooks.ts:116…` | ③ 多条 | 目标续推的触发器 |
| | `backend/wiring/collab/external-observability.ts:151` | ③ `INTERACTION_REQUESTED` | 协作房把 agent 提问外投 |
| **插件** | 经插件 API 的事件订阅面 | ③ | manifest 声明的事件钩子 |

想知道"事件 X 都有谁在听":搜 `onAnySession(SESSION_EVENT_TYPES.X` +
`[SESSION_EVENT_TYPES.X]`,两个句型并起来就是全部(词汇宪法保证没有第三种写法)。

### 2.6 事件怎么走到屏幕(最后一公里)

先解开一个常见困惑:"前端什么时候订阅?后端怎么通知?"——这里其实是
**两级订阅 + 一根管子**,三样东西名字都像"订阅",职责完全不同:

- **第 1 级订阅(主进程内)**:IPCBridge 对总线的 `onAnySessionAny`。发生在**开窗接桥时**
  (装配链 3.2 第 5 步)。这是真正的发布/订阅。
- **管子(不是订阅)**:`webContents.send('session:event', 信封)`。这是 Electron 提供的
  "往这扇窗的网页扔一条消息"的**单向物理能力**,相当于往一条已建立的连接里写数据。
- **第 2 级"订阅"(渲染进程内)**:`ipcRenderer.on('session:event', cb)` = 装监听器。
  发生在**页面启动时**——`renderer/main.ts:105` 的 `initializeIPCHub()` 调
  `platformApi.onSessionEvent(cb)`,preload 里才真正执行 `ipcRenderer.on`。

一扇窗从生到收到第一条事件的时间线:

| 时刻 | 发生什么 | 订阅状态 |
|---|---|---|
| t0 主进程启动 | 总线诞生(3.2 第 3 步),引擎命令订阅表挂上 | 主进程内部订阅就位 |
| t1 开窗+接桥 | `initializeIPCBridge(webContents)`(3.2 第 5 步) | **第 1 级订阅完成(在主进程里!)** |
| t2 页面加载 | preload 跑,把 `onSessionEvent` **暴露**出来(还没监听) | — |
| t3 网页 JS 启动 | `initializeIPCHub()` → `ipcRenderer.on(...)` | **第 2 级监听器就位** |
| t4 你发消息 | emit → 总线 → t1 订阅 → `webContents.send` → t3 监听器 → store | 没有新订阅,只是水流过管道 |

三个反直觉但重要的点:

1. **前端的订阅只发生一次、无条件、订全量**(t3)。组件和 store **不订阅任何东西**——
   它们只读响应式 state;全量事件在 ipc-hub 按 `event.type` 分发。所以永远不用问
   "这个组件订了没",答案永远是"hub 订了,组件只是在读 store"。
2. **后端不知道前端存在**:引擎只认识总线;总线只认识主进程内的订阅者;IPCBridge
   只认识一个 webContents。每层只往前看一步——这就是加一个消费者(如 SSE)不用改引擎的原因。
3. **web 上"订阅"变成真连接**:`onSessionEvent` 的 web 实现是建一条 SSE
   (`EventSource GET /api/events`,`platform/web.ts`);server 端每条 SSE 连接对应
   一个 `onAnySessionAny` 订阅,断线重连带 `?after=序号` 用环形缓冲补发。
   桌面的管子是 Electron 送的,web 的管子要自己建——两形态唯一的差别。


**"on"的真身(触底一次,以后不用再怀疑)**:`platformApi.onSessionEvent(cb)` 三层——
① `platformApi` 是 Proxy(`platform/index.ts:34`),每次属性访问按 `window.electronAPI`
在不在选桌面/web 实现;② 桌面实现(`preload/bridge.ts:131`)整个函数体就是
`ipcRenderer.on('session:event', listener)` + 返回 removeListener 闭包——`ipcRenderer`
是 preload 里的 EventEmitter,`.on` 做的事是**在本进程一张"通道名→函数数组"表上把你的
函数 push 进去**,不通知任何人;主进程 `webContents.send` 时 Electron 把信封送进渲染进程,
发射器查表逐个调用(callback 能被调是 contextBridge 代理函数穿过隔离边界);
③ web 实现(`web.ts:707 → createEventSourceSubscription :201`)= 对 `/api/events`
建/复用一条引用计数的 `EventSource`(永不关闭的 HTTP 响应)+ `addEventListener`。

**通用形状:全仓一切 `on`(总线 `onAnySession`、`ipcRenderer.on`、`addEventListener`)
都是"注册 = 把函数放进列表;通知 = 水来时遍历列表调用"。没有一处是魔法。**

> 🪧 **平台分界牌**:`ipcRenderer` 是 EventEmitter、contextBridge 能代理函数、
> `EventSource` 是 SSE 长连接——这些是 Electron / 浏览器的语义,不是本仓代码。
> 追到这里就是仓库侧的底,再往下查平台文档,不用再在仓里找。

完整路径:

```
引擎 emit → 总线 fan-out → IPCBridge(主进程)
   → webContents.send('session:event', envelope)     ← 跨进程,信封被结构化克隆
   → preload 白名单:electronAPI.onSessionEvent(cb)   (preload/bridge.ts:131)
   → 渲染层唯一入口:services/ipc-hub.ts:68 platformApi.onSessionEvent(...)
   → ipc-hub 按 envelope.event.type 分发给各 pinia store → UI 响应式更新
```

web 形态同构:SSE `GET /api/events` 替代 `webContents.send`,`platform/web.ts` 里的
EventSource 替代 preload,之后同一个 ipc-hub。**渲染层看到的"事件系统"就是 ipc-hub 一个文件**。

ipc-hub 内部没有魔法:`initializeIPCHub()`(`renderer/main.ts:105` 调用)注册一个回调,
里面按 `envelope.event.type` 一张分发表把事件递给对应的 store 处理函数——想知道
"事件 X 在渲染层被谁处理",就在 ipc-hub 里搜那个事件常量。

**渲染层的数据 = 拉 + 推两面**,别只盯推面:store 首次加载用 router client **拉**
(`sessions.list()` 之类的信封请求),之后靠事件**推**增量;两面在同一个 pinia store 汇合。
追"这个数据哪来的"时先分清是拉面(找 `<d>-client.ts` 调用)还是推面(找事件常量)。

### 2.7 高频流为什么不走事件总线

文本/思考增量每秒可能几十条,如果每条都走"信封+扇出+IPC",UI 会被消息风暴打爆。
所以**流增量是另一条专用通道**:`session:stream`,由 `SessionStreamCoalescer`
(`backend/events/stream-coalescer.ts`)在 16ms 窗口内合帧、按序号排好、
并保证"任何事件发出前,先冲掉它前面的增量"(顺序不倒挂)。
判断口径:**低频、要持久、要重放的走事件;高频、易失、纯 UI 的走流通道**。
两者在渲染层于 ipc-hub 汇合。

### 2.8 UI 侧:从 chunk 到像素(收文本 → 展示)

上面讲到"两者在 ipc-hub 汇合"为止,这里把最后一百米走完。一条文本增量在渲染层的全程:

1. **进门**:`platformApi.onSessionStream` 收到 `{ sessionId, chunk }`
   (桌面 = preload 的 `session:stream` 订阅;web = SSE)。注册点是
   `services/ipc-hub.ts:323`。
2. **翻译**:ipc-hub 按 `chunk.type` 分发(`text-delta` / `reasoning-delta` /
   `tool-input-delta` / `content_part` …)→ 统一进 `chatStore.handleStreamChunk`
   (`stores/chat.ts:1432`)。
3. **找目标消息**:chunk 上带 `messageId`(主进程的 coalescer 在合帧时盖的章,
   见 §2.7)→ `resolveMessageId` 在该会话的消息数组里定位那条流中的 assistant 消息。
   **找不到就排队**(`queuePendingStreamChunk`),等 `stream:start` 建好消息再 flush——
   这是"审批卡片死锁"事故(08-11)修出来的护栏:chunk 永远不丢,也永远不写错消息。
4. **写状态**:文本增量就是一句 `message.content += chunk.content`(chat.ts ~:1500),
   同时维护 `contentParts`(文本/思考/工具卡片的分段结构)。消息数组是 Vue 的
   响应式对象,**这一步赋值就是"通知 UI"本身**——没有第二套通知机制。
5. **变成像素**:Vue 依赖追踪触发重渲。组件链:
   `MessageList.vue:49` 的 `v-for`(**平铺列表,刻意不虚拟化**)→
   `MessageItem`(:66)→ `MessageBubble` / `ContentPartView` 按 part 类型分发 →
   文本 part 在**流中**用 `StreamingMarkdown.vue`(增量安全的 markdown 渲染,
   配 `StreamingCodeBlock` / `StreamingTableBlock` / `StreamingHtmlSegment` 处理
   未闭合的代码块/表格/HTML),**定稿后**换 `StaticMarkdown.vue`
   (走 `markdownRenderCache` 缓存 + `deferredMarkdownHydration` 延迟水合)。
6. **跟底滚动**:store 每次 `handleStreamChunk` 递增该会话的 scroll trigger
   (chat.ts:665),MessageList 用一个 O(1) watcher 决定是否贴底——所以滚动不是
   组件轮询消息数组,是 store 主动打点。

节奏由 §2.7 的 16ms 合帧决定:UI 每帧最多应用一批增量,打字机效果的"顺滑"来自
主进程的合帧,不是渲染层的动画。流结束时 `stream:complete` **事件**(不是 chunk)
从事件面到达,store 把消息标记为定稿,渲染从 Streaming* 切到 Static*。

追这条路的口径:进门搜 `onSessionStream`(全仓一个注册点);写状态搜
`handleStreamChunk`;展示从 `MessageList.vue` 的 `v-for` 往下点,全是普通组件树,
Vue DevTools 可视。

### 2.9 一段话把原理串起来

跨进程只能传数据(§1),所以引擎的动静必须变成"带类型的数据"才能出门;
消费者不止一个,所以出门前先过一次进程内的发布/订阅(总线);
类型的值收进两张宪法表,于是发射和消费共享同一个符号;
总线给每条事件盖序号并留 1000 条缓冲,于是 web 断线可续、事件日志可重放;
高频增量单独合帧,于是事件面保持低频有序。——事件系统的全部设计,就这五句话。

## 三、启动装配链:谁在什么时候把零件装上去

前两章讲的都是"静态零件"(海关、信封、总线、订阅表)。它们能工作,是因为**启动时有一条
装配链逐个把它们接上**。凡是"X 是在哪里被指定的 / 谁注册的 / 谁订阅的"这类问题,
答案一律在这条链上——主进程侧从 `startOnethingElectronMain` 往下读,渲染侧从
`renderer/main.ts` 往下读,不用猜。

### 3.1 构建期(还没运行,先说清产物从哪来)

`electron.vite.config.ts` 一份配置里有**三段独立构建**:

| 段 | 入口 | 产物 |
|---|---|---|
| main | `apps/electron/src/main.ts` | `out/main/index.js`(主进程程序) |
| preload | `apps/electron/src/preload.ts`(:46 指定) | `out/preload/index.js`(海关脚本) |
| renderer | `packages/renderer`(Vite SPA) | `out/renderer/`(网页) |

所以 `preload/bridge.ts` 不是"被某个配置置顶",它经 `preload.ts` 这个两行入口被打进
`out/preload/index.js`,然后在**开窗时**被逐窗指定(见 3.2 第 4 步)。

### 3.2 主进程启动期(`main.ts` → `startOnethingElectronMain`,`app/main-process.ts`)

`apps/electron/src/main.ts` 只有两行:import 并调用 `startOnethingElectronMain()`。
这个函数就是装配链本体,顺序:

1. **插宿主能力**:一大批 `configure*Host(...)` 调用(文件顶部 :23-:127 那批 import 的用途)——
   把 Electron 才有的东西(原生对话框、语音托盘、深链、窗口 provider…)插进各层声明的端口。
   这就是"端口边界"的另一半:接口在下层声明,**在这里被填上实现**。
2. **拿锁**:`StoreLock.acquire("desktop")`(:245)——同一个 store 只许一个桌面进程。
3. **造后端**:`await createOnethingBackend({...})`(:215)。引擎、总线、存储、工具注册表
   **全部在这一步诞生**;引擎构造时 `subscribeToCommands` 把命令订阅表挂上总线(§2.5 的表
   就是此刻生效的)。`createOnethingBackend` 内部的固定次序(设置→事件系统→会话层→引擎→
   Permission→变量→工具)写在 `packages/backend/backend.ts`,那是唯一的装配配方。
   其中钩子 `afterEngine → initializeIPC()`(:231)注册**全部** `ipcMain.handle`
   (`rpc:invoke` / `shell:invoke` / 推送通道)——"处理者是谁注册的"的答案。
4. **开窗**:`app/bootstrap.ts:84 → window/index.ts:325`(此处填
   `preloadPath: path.join(__dirname, '../preload/index.js')`)→
   `window/main-window.ts:47` 的 `new BrowserWindow({ webPreferences: { preload } })`。
   **preload 是 BrowserWindow 的构造参数,每扇窗各自指定**,不是全局配置;
   这个仓所有窗口都指向同一个产物,所以每扇窗的 `electronAPI` 是同一份白名单。
5. **接桥**:`app/activate.ts:51 initializeIPCBridge(mainWindow.webContents)` ——
   IPCBridge 在此 `onAnySessionAny` 订阅总线、对准主窗口;引擎经 `bind(webContents)`
   拿到命令目标。"事件为什么会到窗口"的答案。
6. **挂 HTTP 面**:`startEmbeddedOnethingHttpServer(backend)`(:269,非阻塞)——
   桌面同时成为这个 store 的 HTTP/SSE 服务方(§1.4 的由来)。
   之后是插件、调度器、MCP、网关等 post-window 服务。

### 3.3 渲染进程加载期(每扇窗都走一遍)

1. 窗口加载 URL → **preload 先于网页运行**:`installOnethingPreloadBridge()` 把白名单
   挂上 `window.electronAPI`(海关开门)。
2. 网页启动:`packages/renderer/main.ts:105` **`initializeIPCHub()`** ——
   渲染层在此订阅 `session:event` / `session:stream`(§2.6 最后一公里的起点),然后 Vue 挂载。
3. `platformApi` 每次访问按 `window.electronAPI` 在不在选 electron / web 实现——
   选择代码就是 `packages/renderer/platform/index.ts`(每次访问现选,不缓存判断;
   web 实现里的 SSE `EventSource` 也在 `platform/web.ts` 建立)。
   同一份渲染层代码因此能跑在桌面和浏览器。

### 3.4 用法

- "**谁指定了 preload?**" → 3.2 第 4 步(逐窗构造参数)。
- "**rpc:invoke 的 handle 谁注册的?**" → 3.2 第 3 步的 `initializeIPC()`。
- "**订阅表什么时候挂上总线的?**" → 3.2 第 3 步引擎构造时。
- "**ipc-hub 谁初始化的?**" → 3.3 第 2 步 `renderer/main.ts:105`。
- "**契约和处理者是在哪配对的?**" → `backend.ts:221 registerAppRpcDomains()` 按 `rpc/index.ts` 域表逐条挂载。
- "**web 的 /api/rpc 谁收?**" → `backend/server/http.ts` 路由 → 同一个 `dispatchRpc`。
- 换 server 形态:同一条链的无窗版本——`apps/server/src/main.ts` → `createRealServerBackend`,
  没有 3.2 第 4、5 步,SSE 直接订总线。


---

# 追踪篇

## 四、总纲:先判断"调用还是接力"

**凡是代码断掉的地方,都对应概念篇里的一个物理边界;每个边界有固定接头;接头都是可搜索的 TS 符号。**

| 边界 | 出处 | 接头 | 过桥动作 |
|---|---|---|---|
| ① 信封(跨进程,§1.3) | client → 处理者 | 契约路由键 | F12 方法名落契约键 → Shift+F12 到 `domains/<d>.ts`;或 ⌘P 直跳(domain=文件名) |
| ② 总线(一对多,§2) | `emit` → 订阅者 | 词汇常量 | ⇧⌘F 搜:消费点 `[SESSION_*_TYPES.X]`,发射点 `type: SESSION_*_TYPES.X` |
| ③ 端口(依赖倒置) | 接口 → 实现 | 类型声明边 | ⌘F12 跳实现(S2 批已给全部"留"的口补边,探针 `scripts/probe-go-to-implementation.mjs` 可验) |

其余一切都是普通函数调用,F12 直走。
为什么只有三种:跨进程只能传数据;一对多只能订阅;下层看不见上层——三条物理事实,三个边界,没了。

## 五、全程走读:SEND_MESSAGE 的一生

去程(每跳标注:调用 or 哪种边界):

```
 1. renderer stores/chat.ts:2366        sessionCommands.emit({type: SEND_MESSAGE,…})   调用
 2. platform/session-command-client.ts:51   client.emit —— 【①信封】渲染进程代码到此为止
      F12 方法名 → shared/ipc/session-command.ts:47(契约键)→ Shift+F12 → 处理者
      (被跳过的通用搬运:preload rpcInvoke → @main/ipc/rpc.ts 唯一 handle → dispatchRpc)
 3. backend/rpc/domains/session-command.ts:59   emit 处理者(ipc 盖 origin 章)      调用
 4. core/events/ipc-operations.ts:69    options.eventBus.emit —— 【③端口】⌘F12
 5. core/events/event-bus.ts:93         EventBus.emit —— 【②总线】搜 [SESSION_COMMAND_TYPES.SEND_MESSAGE]
 6. core/engine/core-stream-engine.ts:539   订阅表 [SEND_MESSAGE]: → handleSendMessage
 7. handleSendMessage
      override: runtime/src/engine/stream-engine.ts:144(路由/房间闸/插件旁路)
      core 本体 :780,体内全是普通调用:
        忙→steerMessage | waitForCompactionIdle | resolveUserReferences
        持久化用户消息+emit(MESSAGE_CREATED) | resolveProvider | maybeCompactBeforeSend
        建 assistant 占位 | this.runtime.streams.executeMessageStream(:925)【③端口】
      (this.runtime 这个 12 槽运行时是谁给的:`backend/wiring/engine/stream-engine-runtime.ts`
       装配、`stream-engine-bound.ts` 连五端口一起塞进构造,`wiring/engine/index.ts` 持
       `getStreamEngine()` 单例——都发生在 3.2 第 3 步)
 8. backend/wiring/engine/stream/stream-executor.ts:175 → agent-loop → provider 请求
```

回程 = §2.6 + §2.7:事件走总线→桥/SSE→ipc-hub;文本增量走 coalescer 的 `session:stream`。

## 六、发射点名册(搜出来的不是噪音)

`type: SESSION_COMMAND_TYPES.SEND_MESSAGE` 的 13 处命中 = "谁有权往会话里发消息"的完整名单:

```
renderer:  stores/chat.ts(用户)、TodoPlanPanel.vue(计划面板)
backend:   wiring/voice(语音)、wiring/music/radio(电台 DJ)、wiring/plugins/sessions(插件)、
           wiring/goals/kick(目标续推)、wiring/tasks/dispatch(派工)、
           wiring/collab/turn-primitives(协作房)、wiring/headless ×2
runtime:   gateway-runtime(微信/TG)、scheduler/agent-task-runner(定时任务)
```

运行时想确认某条消息的来源:看 `command.origin` / `source` 字段。

## 七、找代码在哪:三条命名等式

1. **包 = 环境**:零依赖 → `core`;产品(无 Electron)→ `onething-runtime/src`;装配 → `backend`;壳 → `apps/*`。
2. **目录 = 领域**;同名领域跨包时:core=骨架,runtime=本体,`backend/wiring/<领域>`=接线。
3. **文件名 = 角色**:`*.wiring.ts` / `*-bound.ts` / `domains/<d>.ts` / `<d>-client.ts` / `configure*Host`。

## 八、迷路急救

| 症状 | 原因 | 动作 |
|---|---|---|
| F12 进 `createRouterClient` 泛型 | 点到了造信封的机器 | 掉头:F12 点方法名落契约键;或 ⌘P `domains/<域>` |
| F12 落在接口 | 定义确实在下层(§三·③) | ⌘F12 |
| ⌘F12 落空 | 漏网鸭子口 | 跑探针,当 bug 修 |
| find usages 为空 | 双 TS 项目,文件被划进不含消费者的项目 | ⇧⌘F 文本搜索(对词汇常量是完备的) |
| 搜常量一大串 | 混了方向 | `[常量]`=消费点;`type: 常量`=发射点 |
| 追进 `eventBus.emit` 函数体 | 总线内部只有泛型流水线(§2.3) | 出来,搜方括号句型 |
| 想看运行时实际顺序 | 静态追踪答不了 | `bun run log:tail --session <id>`;`onething trace <sessionId> --last` |

## 九、诚实清单:仍靠"知道"而非"看见"的两处

1. **总线接头靠约定**(§四·②的句型要先被告知)。根治选项已挂号:
   A. 词汇表每条常量带 `@link` 直指消费者(悬停即见,checker 防漂移);
   B. 命令(每条恰一个消费者)不走总线改直调引擎——SEND_MESSAGE 全程 F12 直通。
2. **双 TS 项目让 find usages 不可靠**。根治选项:根 tsconfig 改 solution 风格挂 references。

背景判断:这套复杂度是"五宿主"买来的;实际在用的宿主越少,可砍的边界越多——这是产品决策。
