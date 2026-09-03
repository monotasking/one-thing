# core 的客户端 SDK `@onething/client` —— 运行时统一第二步(2026-09)

> 起因(09-03 用户):运行时统一第一步(去 castlabs、清 better-sqlite3、gate:native)入库后,下一步是「React 壳
> 从 Vue 的 renderer 包里摘干净」。用户追问三句定了方向:①「以后换框架是不是还得再搬一次」→ 这次要搬到一个
> **不属于任何框架**的地方;②「这块是 HTTP 层吗」→ 一半是,它是 core 那个 HTTP/SSE 面的**客户端一端**,外加
> 传输无关的域客户端与纯判据;③「CLI 能用这层吗」→ 能,前提是**不依赖浏览器独有原语**,由 Node 环境的测试证明。
>
> 本文照根 CLAUDE.md 两条法写:**加功能不许改骨架**(§6 陌生能力演练)、**原生模块只许 N-API**(本包零原生依赖)。
> §0 结论 → §1 现状 → §2 目标边界 → §3 包与分层 → §4 接口 → §5 四个消费者怎么接 → §6 演练 → §7 分期与门 → §8 反证 → §9 留账。

---

## 0. 一页结论

**立一个 workspace 包 `packages/client`(`@onething/client`)**,与 core / runtime / backend 并列,是「壳和 core 之间的客户端底座」:
纯 TypeScript、浏览器与 Node 双环境、零 React 零 Vue 零 Electron、只依赖 `@shared` 契约与 `@onething/core` 的纯模块。

三段,自下而上:

| 段 | 是什么 | 可换点 |
| --- | --- | --- |
| **transport** | 一个 `Transport` 接口(`invoke` 一条 RPC 信封 / `events` 一条推送流 / `capabilities`);缺省实现 `http`:全局 `fetch` + **用 fetch 流自己解析的 SSE**(不是浏览器的 `EventSource`,Node 也能跑,token 进 Bearer 头不进 URL) | 换传输 = 再实现一个 `Transport`(IPC / WebSocket / 内存假传输) |
| **rpc** | `createRouterClient(router, invoke)` 原样搬;**不再有按域一个文件的 `*-client.ts`**——`client.api(sessionsRouter)` 泛型取用,按 router 记忆 | 加一个域 = 只在 `@shared/ipc` 加 `defineRouter`,本包零改动 |
| **model** | 从设置推导的纯判据(`provider-model`)、会话生命周期折叠(`session-lifecycle`) | 纯函数,加就加 |

一个入口:`createOnethingClient({ transport })` → `{ api(router), events.on(name, cb), capabilities(), close() }`。**没有模块级单例**:今天 `configureWebTransport` 那种「配置写进模块变量」的形不进本包;要缺省实例的壳自己 `const client = createOnethingClient(...)` 导出一份。

四个消费者:React 壳(本批)、Vue renderer(本批,改为薄适配)、CLI(下一批,读 `run/http.json` 当 core 的客户端)、apps/mobile(将来)。

**拍点**(粗体推荐):

| # | 问题 | 选项 |
| --- | --- | --- |
| 甲 | 包名 | **`@onething/client`** / `@onething/sdk` |
| 乙 | 按域文件 | **不留**,`client.api(router)` 泛型;Vue renderer 里现有 40 多个 `*-client.ts` 改成对 `client.api(...)` 的一行别名(退役时随 Vue 删) / 保留按域文件搬进本包 |
| 丙 | SSE token | **fetch 流 + Bearer 头**;server 的 `?token=` 只为 Vue 的 `EventSource` 留到 Vue 退役 / 两种都留 |

---

## 1. 现状(只列与本批相关的)

- `packages/renderer/platform/`(Vue 的渲染进程包)里住着这一层:`web.ts` 774 行(fetch + `EventSource` + 一张 `PlatformApi` 方法表的 web 实现)、`electron.ts`(同一张表的 IPC 桥实现)、`index.ts`(`platformApi` 代理:有 `window.electronAPI` 走 IPC,否则走 web)、`router-client.ts` 55 行、`transport-config.ts` 82 行(模块级单例)、`types.ts`(`PlatformApi = ElectronAPI & {…}`,一百来个方法)、`session-lifecycle.ts`、40 多个 `*-client.ts`(每个 4 行:`createRouterClient(xxxRouter, platformApi.rpcInvoke)`)。
- **React 壳向它伸了 18 种 import、10 余个文件**:6 条推送订阅 + `getSessionUsage` + `configureWebTransport` + 16 个域客户端 + `provider-model` + 两个类型。React 壳只走 HTTP,从不碰 `electron.ts`。
- `web.ts` 用了三样浏览器独有的东西:`EventSource`(Node 没有)、`window.matchMedia`(系统主题)、`navigator.clipboard`(剪贴板)。后两样是**宿主能力**不是传输,不该在传输层。
- `PlatformApi` 的形是 Electron 桥那张大表:web 实现里 `WEB_DESKTOP_ONLY_PLATFORM_METHODS` / `WEB_UNSUPPORTED_PLATFORM_METHODS` 两张名单在说「这些方法在 web 上没有」——这是「按能力枚举」的形,本包不继承它。
- server 侧(`backend/server/http.ts`):每条路由都认 Bearer 头;`GET /api/events` 是**唯一**额外认 `?token=` 的路由,注释写明是为浏览器 `EventSource` 带不了头才开的口。
- apps/mobile 只在注释里提到 renderer,零真引用。

---

## 2. 目标与边界

**目标**:①React 壳对 `packages/renderer` 零 import,`@renderer` 别名从 React 壳的 tsconfig / vite 删除;②这一层从此不属于任何框架,换壳不再搬;③在 Node 里跑得起来,由 Node 环境的测试证明(CLI 的路由此打通);④Vue renderer 改为消费本包,不留两份实现。

**边界**(本批不做):CLI 改成 core 的客户端(下一批 C3);退役 Vue 宿主(第四步);`PlatformApi` 那张大表的瘦身(随 Vue 退役自然消失);server 侧删 `?token=`(等 Vue 的 `EventSource` 消费者没了再删)。

---

## 3. 包与分层

```
packages/client/                      '@onething/client'(root workspaces 加一行;exports 家族式通配)
  package.json                        deps: 无;peer: 无;devDeps: vitest(environment: node)
  transport/
    types.ts                          Transport / EventStream / TransportEvents(事件名 → 载荷类型表,从 @shared/events 派生)
    http.ts                           createHttpTransport({ baseUrl, token, fetch?, headers? })
    sse.ts                            parseSseStream(ReadableStream<Uint8Array>): AsyncIterable<SseMessage>(纯函数,含 id/event/data/retry 与多行 data)
    memory.ts                         createMemoryTransport(handlers)(测试替身:路由表 + 手动 emit)
  rpc/
    router-client.ts                  createRouterClient / RpcError(原样搬)
  events/
    subscriptions.ts                  createEventHub(stream): on(name, cb) → off;按名分发、重连时 ?after= 续播
    session-lifecycle.ts              foldSessionLifecycleEvent / onSessionLifecycle(原样搬,改吃 hub)
  model/
    provider-model.ts                 原样搬(只依赖 @shared/provider-families 与 @shared/ipc/settings 的类型)
  client.ts                           createOnethingClient(options): OnethingClient
  discovery.ts                        readCoreDiscovery(storePath) —— Node 专用子路径 `@onething/client/node`,读 <store>/run/http.json(CLI 用;浏览器构建不引)
  index.ts
  __tests__/                          全部在 node 环境跑(vitest environment: 'node',不挂 jsdom)
```

边界规则(进 `scripts/headless-boundary-check.ts`):`packages/client` 禁 import `react` / `vue` / `electron` / `@main` / `@renderer` / `@onething/backend` / `@onething/runtime`;禁裸用 `window` / `document` / `navigator` / `EventSource` / `localStorage`(宿主能力经参数注入);另立一条 **壳不许 import 别的壳**:`apps/desktop-react` 禁 `@renderer` 与 `packages/renderer`,`packages/renderer` 禁 `apps/desktop-react`。

---

## 4. 接口

### 4.1 Transport:唯一的可换点

```ts
export interface Transport {
  invoke(request: RpcRequest): Promise<RpcResponse>          // 一条 RPC 信封(@shared/ipc/rpc)
  events(options?: { after?: number; signal?: AbortSignal }): AsyncIterable<TransportEvent>   // 推送流;after = 从这个序号续播
  capabilities(): Promise<PlatformCapabilities>              // GET /api/capabilities 的形(从 @shared 取类型)
  onConnectionChange?(cb: (state: 'open' | 'retrying') => void): () => void   // C1 补,可选:传输自己知道那条流通不通
  close(): void
}
export interface TransportEvent { name: string; data: unknown; id?: number }
```

- **http**:`invoke` = `POST /api/rpc`(Bearer 头);`events` = `GET /api/events`(Bearer 头,`?after=`),用 `fetch` 拿 `ReadableStream`,`parseSseStream` 解析;断线按 `retry` 指数退避重连,带上最后一个 `id` 当 `after`。**不用 `EventSource`**,所以 Node 22 / 24 与浏览器同一份代码;token 不再出现在 URL。
- **`onConnectionChange`(C1 补,可选)**:`events()` 在 HTTP 上是**自愈**的 —— 断了它自己退避重连,
  那个 `for await` 从头到尾不结束。于是枢纽光看迭代器**永远看不见断线**,`status()` 的 `reconnecting`
  那一格在真机上不可达(C1 的真机门 `gate:connect` 路径三当场证伪了本文原来那句「流断了,传输在退避」)。
  断没断只有传输知道,所以由它说;两格(`open` / `retrying`),**可选** —— 一个不会断的传输(内存替身)
  没有这件事可说,让它实现一个恒 `open` 的桩是造假事实,枢纽退回只看迭代器。
- **memory**:测试替身;也是「换传输不改上层」的活证据。
- IPC 传输(Vue 桌面)**不在本包**:它需要 `window.electronAPI`,由 Vue renderer 自己实现 `Transport` 接口(`electron-transport.ts`,把 `rpcInvoke` 与 `on*` 订阅适配成 `invoke` / `events`),注入给本包的 `createOnethingClient`。

### 4.2 Client:一个对象,三个口

```ts
export interface OnethingClient {
  api<T extends DomainRoutes>(router: Router<T>): RouteAPI<T>   // 泛型取域客户端;按 router 记忆
  events: {
    on<K extends keyof TransportEvents>(name: K, cb: (payload: TransportEvents[K]) => void): () => void
    onAny(cb: (event: TransportEvent) => void): () => void
    status(): 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed'
  }
  capabilities(): Promise<PlatformCapabilities>                // 记忆一次,失效由宿主 `refresh`
  close(): void
}
export function createOnethingClient(options: { transport: Transport; logger?: Logger }): OnethingClient
```

- `api(router)`:`createRouterClient(router, transport.invoke)`,按 router 对象做 WeakMap 记忆。**没有 `client.sessions`、`client.settings` 这种按域的属性**——那是枚举点。壳想要短名字,自己写一行 `const sessionsApi = client.api(sessionsRouter)`。
- `events.on`:事件名与载荷类型的表 `TransportEvents` 从 `@shared/events` 与 `@shared/ipc/channels` 派生(`session:event` → `SessionEventEnvelope`,`session:stream` → `SessionStreamPayload`,`settings:changed` → `AppSettings`,……)。**加一条推送 = 在 @shared 加一条**,本包零改动。
- `events.status()`:连接状态一格,壳画「重连中」用;第一批 React 壳的 `connection.ts` 已经在自己维护这一格,搬进来。

### 4.3 宿主能力不在本包

系统主题(`matchMedia`)、剪贴板、打开外链、文件对话框:这些是**宿主**的,不是 core 的客户端的。React 壳今天用的 `onSystemThemeChanged` 是浏览器 API 的包装,搬回壳自己的 `src/platform/host.ts`;Vue 的 `platformApi` 大表里这些方法照旧留在 renderer。判据:**凡是不经 core 就能答的,不进本包**。

### 4.4 Node 子路径

`@onething/client/node` 只导出 `readCoreDiscovery(storePath)`(读 `<store>/run/http.json` → `{ baseUrl, token, owner, pid }`,判活:pid 在且端口连得上——与 `apps/server/src/main.ts` 的拒启判据同一份,抽到 `@shared/backend` 复用)。浏览器构建永远不引这个子路径;`exports` 里单列。

---

## 5. 四个消费者怎么接

### 5.1 React 壳(本批 C1)

- `src/platform/connection.ts`:拿到 `host:connection` 的 `{ baseUrl, token }` 后 `createOnethingClient({ transport: createHttpTransport({ baseUrl, token }) })`,导出 `client`;连接状态改读 `client.events.status()`。
- 各 `data/*-port.ts`:`import('@renderer/platform/xxx-client')` 改为 `client.api(xxxRouter)`(router 从 `@shared/ipc/<d>.js` 引);6 条 `platformApi.onXxx` 改 `client.events.on('xxx', cb)`;`getSessionUsage` 改 `client.api(usageRouter).getSessionUsage`(核一下 usage 有没有 router;没有就是它该有 router 的时候,加在 @shared)。
- `provider-model` 与 `session-lifecycle` 改 import 路径;`chat-source.ts` / `chat-port.ts` 引的 `@renderer/platform/types` 里那两个类型改从 `@shared/events` 直接引(它们本来就是再导出)。
- 删 tsconfig `paths` 与 vite alias 里的 `@renderer`;边界检查加「壳不许 import 别的壳」。
- 系统主题订阅搬回 `src/platform/host.ts`。

### 5.2 Vue renderer(本批 C2,只求不留两份)

- `platform/router-client.ts` / `transport-config.ts` / `session-lifecycle.ts` / `stores/helpers/provider-model.ts`:删本体,改成从 `@onething/client` 再导出(一行)。
- `platform/web.ts`:传输部分(fetch / SSE / token)改为内部持一个 `createHttpTransport`;`PlatformApi` 大表的 web 实现照旧存在,只是底下不再自己拼 fetch。`EventSource` 随之消失,`?token=` 的消费者归零(server 侧那条口留到 Vue 退役再删,§9)。
- `platform/electron.ts`:不动。另加 `platform/electron-transport.ts` 把 IPC 桥适配成 `Transport`,让 renderer 里的 `client` 在桌面下也能 `api(router)`——40 多个 `*-client.ts` 改成 `export const sessionsApi = client.api(sessionsRouter)`(拍点乙)。
- 验收只求一条:`bun run build`(Vue 宿主)与 `web:build` 绿、既有 renderer 测试绿。

### 5.3 CLI(下一批 C3,本批只铺路)

`onething <cmd>` 先 `readCoreDiscovery()`,活着就 `createHttpTransport` 当 core 的客户端,`client.api(sessionsRouter).list({})`;不活再走今天的 HeadlessBackend 自装(或提示先起桌面)。SSE 在 Node 里靠 fetch 流,`onething tail` 这类跟随命令就是 `client.events.onAny`。本批的 Node 环境测试是它的通行证。

### 5.4 apps/mobile(将来)

React Native 有全局 `fetch` 与 `ReadableStream`(0.7x 起),`createHttpTransport` 直接用;`readCoreDiscovery` 不适用(手机不在 store 所在机器),地址与 token 由配对流程给——那是 mobile 自己的事,本包不认识配对。

---

## 6. 陌生能力演练(交卷前必做)

| 需求 | 要动的文件 |
| --- | --- |
| 换一个前端框架(Svelte 壳) | 新壳自己的目录 + `createOnethingClient` 一行;本包零改动 |
| 加一种传输(WebSocket / 内存 / IPC) | 一个实现 `Transport` 的文件;域客户端与事件层零改动 |
| 加一个 RPC 域 | `@shared/ipc/<d>.ts` 的 `defineRouter`;本包零改动;壳 `client.api(newRouter)` |
| 加一条推送事件 | `@shared/events` 加一条类型 + channels 加一个名;本包零改动(`TransportEvents` 派生) |
| 加一个宿主能力(读剪贴板) | 壳自己的 `host.ts`;本包零改动(§4.3 判据) |
| CLI 变成 core 的客户端 | CLI 目录 + `@onething/client/node` 已有的发现函数;本包零改动 |
| 多个 core(同时连本机与远端) | `createOnethingClient` 两次;本包零改动——这正是「无模块级单例」换来的 |

七条全过。第一稿曾想按域留 `client.sessions` 属性与 `*-client.ts` 文件,演练第三条就红(加域要改本包),所以改成 `api(router)`。

---

## 7. 分期与门

| 期 | 交什么 | 门 |
| --- | --- | --- |
| **C0 包骨架 + 传输** | `packages/client` 全部(§3);root workspaces + exports;边界规则两条;Node 环境测试:`parseSseStream` 黄金表(多行 data / id / retry / 分块边界切在 `\n` 中间)、http 传输对一个本地假 server 的 invoke / events / 重连 / after 续播、memory 传输、`api(router)` 记忆、事件表类型测试(`expectTypeOf`) | `bun run test`(node env)绿;`boundary:gate` 绿;`tsc -p packages/client` 零错;**Node 22 与 Electron 24 两处各跑一次 SSE 测试**(与 gate:native 同一条「不靠注释」的法) |
| **C1 React 壳迁移**(已落地 2026-09-03) | §5.1 全部;删 `@renderer` 别名;`host.ts`;`gate:connect` 加路径三(断了再回来)与「token 只在 Bearer 头里」的断言;`Transport.onConnectionChange` 补口 | React 壳 tsc / eslint / vitest 绿;`rg '@renderer' apps/desktop-react` = 0;真机门 `gate:chat` / `gate:data` / `gate:search-messages` / `gate:workspace` / `gate:theme` / `gate:connect`(三路径)绿(隔离 store,CDP);边界门「壳不 import 壳」**基线清零 → 零基线硬闸** |
| **C2 Vue renderer 改消费** | §5.2 全部 | `bun run build` / `web:build` 绿;renderer 既有测试绿;`rg 'new EventSource' packages/renderer` = 0 |
| C3(下一批)CLI 当客户端 | §5.3 | 另案 |

C0 → C1 → C2 串行;C1 与 C2 可并行(都只依赖 C0)但共享 `@shared` 的类型改动,先 C1 再 C2 稳妥。三张 opus 单。

---

## 8. 反证(拆掉即红)

- C0:`parseSseStream` 把分块边界切在 `data:` 中间 → 黄金表红;http 传输把 token 放回 URL → 「Bearer 头」测试红;`api(router)` 不记忆 → 「同 router 两次同一对象」红;测试环境改 jsdom → **必须仍绿**(反向证明:改成 jsdom 后再把 `EventSource` 引回来测试才红——这是「Node 能用」的证词)。
- C1:任何一处 `@renderer` 残留 → 边界门红;`host.ts` 的主题订阅删掉 → 主题门红。
- C2:renderer 保留一份自己的 `createRouterClient` → 「不留两份」grep 门红。

---

## 9. 留账

- server 侧 `GET /api/events` 的 `?token=` 口:Vue 退役后删,顺带把 http.ts 那段注释一起删。
- `PlatformApi` 大表与它的两张「web 上没有」名单:随 Vue 退役消失;React 壳不消费它。
- ~~`usage` 的 `getSessionUsage` / `getUsageSummary` 今天在 `PlatformApi` 上而不是 router 上——C1 时核,没有 router 就加~~ **C1 核账结清:它有 router。**
  `@shared/ipc/usage.ts` 的 `usageRouter`(`getSummary` / `getSession`)自 T0 试点起就在,后端
  `packages/backend/rpc/domains/usage.ts` 也注册着;Vue 那侧的 `platformApi.getSessionUsage` 本来就是
  `usageApi.getSession` 的一行别名(`platform/web.ts:597`、`platform/electron.ts:47`)。所以 C1
  **一个域都没加**,`data/meter-port.ts` 直接 `client.api(usageRouter).getSession({ sessionId })`。
- `readCoreDiscovery` 的判活判据与 `apps/server/src/main.ts` 的拒启判据要同一份(抽到 `@shared/backend`),否则 CLI 与 server 对「core 活没活」会各说各话。
- 运行时统一第三步(根脚本与打包配置换主到 React 壳)与第四步(退役 Vue 宿主)在本批之后;本批做完,第四步删的只剩 Vue 自己的东西。
