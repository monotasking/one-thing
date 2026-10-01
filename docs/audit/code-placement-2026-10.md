# 代码放置盘点:哪些代码在哪儿、跑在哪一边(2026-10-01)

> 起因:用户决定合并包,并希望**把 server 和 client 拆开**,但还没想好要不要保留 shared。
> 本文只是调查,一行代码都没动。数字都是 2026-10-01 在 `d5fb0ae0f` 上实测的
> (非测试源码;import 图用脚本按 `import … from` 解析,区分**值导入**与 **`import type`**)。
>
> 两个词先说清:
> - **值导入**:运行时真的会把那个文件的代码加载进来(函数、常量、类)。
> - **类型导入**(`import type`):只在编译期用,打包后不存在。类型是可以复制或生成的,值不行。

## 1. 全仓地图

| 位置 | 源文件 | 行数 | 跑在哪 | 归哪一边 |
| --- | ---: | ---: | --- | --- |
| `apps/desktop-react/src` | 791 | 160.7k | 浏览器 / Electron 渲染进程 | **client** |
| `apps/mobile` | 13 | 1.5k | React Native(Metro 打包) | **client** |
| `packages/client` | 11 | 1.5k | 浏览器与 node 都能跑的客户端 SDK(连接、RPC、事件订阅) | **client** |
| `apps/desktop-react/electron` | 33 | 7.5k | Electron 主进程 | **两边都有**,见 §3.2 |
| `packages/core` | 287 | 71.5k | node(其中一小部分也进浏览器,见 §3.1) | 大部分 **server** |
| `packages/onething-runtime/src` | 779 | 158.1k | node(3 个文件也进浏览器) | **server** |
| `packages/backend` | 422 | 89.8k | node | **server** |
| `packages/gateway/src` | 20 | 3.4k | node(微信 / Telegram 通道) | **server**(今天没有宿主在跑它) |
| `apps/server/src` | 2 | 0.3k | node(独立后端进程外壳) | **server** |
| `apps/cli/src` | 12 | 2.9k | node | **两半**,见 §3.3 |
| `packages/shared` | 84 | 19.4k | 两边都 import | **契约**,见 §4 |
| `scripts/` | 75 | 26.9k | 开发机 | 工具(门、构建、迁移) |
| `apps/desktop-react/scripts` | 87 | 68.1k | 开发机 | 工具(壳的真机门、构建) |
| `apps/desktop-react/vite/dev-api-proxy.ts` | 1 | 0.1k | 开发服务器 | 工具(读发现文件,把 `/api` 转给活着的后端) |

一句话:**server 侧约 32 万行,client 侧约 16.4 万行,中间的契约约 1.9 万行。**

## 2. 谁依赖谁(按「有多少个文件 import 了对方」计)

| 方向 | 值导入的文件数 | 只有类型导入的文件数 |
| --- | ---: | ---: |
| 壳 → shared | 48 | 114 |
| 壳 → core | 17 | 10 |
| 壳 → runtime | 5 | 1 |
| 壳 → client | 5 | 4 |
| 壳 → Electron 主进程 | 1 | 1 |
| 手机 → shared / core | 0 | 5 / 2 |
| client SDK → shared / core | 4 / 0 | 6 / 4 |
| Electron 主进程 → backend / runtime / core / shared | 5 / 5 / 2 / 3 | 3 / 2 / 4 / 3 |
| CLI → backend / runtime / core / shared | 4 / 4 / 3 / 1 | 0 / 0 / 2 / 5 |
| backend → runtime / core / shared | 250 / 126 / 98 | 138 / 128 / 180 |
| runtime → core / shared | 135 / 22 | 169 / 49 |
| gateway → core | 3 | 3 |
| **shared → core** | **8** | 16 |
| **core → shared** | **2** | 0 |

最后两行是一个**环**:core 和 shared 互相依赖。原因是会话的事件 / 命令词汇被拆在两边 ——
`core/events/session-{command,event}-types.ts` 从 `shared/events` 取常量,而 `shared/events/session-{commands,events}.ts`
又从 `core/events` 取。另外 `shared/ipc/router.ts`(RPC 契约的写法 `defineRouter`)、`shared/ipc/interaction.ts`、
`shared/ipc/plugins.ts`、`shared/json.ts` 也各自借了 core 的一块。

## 3. 跨边界的那几处

### 3.1 浏览器里实际跑着的 server 侧代码

客户端(壳 + 手机 + client SDK)顺着值导入一路追下去,实际会加载 **core 112 个文件、runtime 3 个文件**。
入口不到 20 个,其余是桶文件(把一个目录的导出汇总起来的 `index.ts`)顺带拖进来的。按功能:

| 功能 | 入口 | 壳里谁在用 |
| --- | --- | --- |
| 会话投影:事件流 → 消息列表(与后端同一个折叠函数) | `core/session/projection/reducer`、`core/session`(materialize)、`render-anchors`、`session/events` | `data/chat-source.ts`、`chat-materialize.ts`、`content/assemble/anchor.ts` |
| 引用标记 `<ref …>` 的解析 / 格式化 / 扫描 | `core/references` | markdown 渲染、输入框 |
| 资源地址(`dir:` / `git:` …)解析与比较 | `core/resource`(桶还拖进工具系统 15 个文件) | `workbench/kinds.ts` |
| 权限效果表 | `core/toolkit` 的 `effectPolicyFor` | `data/permission-ask.ts` |
| 文本行编辑 | `core/text` | 编辑器 |
| 斜杠命令表 | `core/slash-commands` | `data/commands-source.ts` |
| 输入框里的文件 / 页面标记 | `runtime/prompts/prompt-references` | `references/kinds/{dir,file}.ts`、`data/page-references.ts` |
| 宠物骨架的形状与颜色校验 | `runtime/pets/rig-spec`(另有 `alu.rig` 只给开发页) | `pets/rigs/DeclarativeRig.tsx` |

规律:**全是词汇、形状和纯算法,没有一样是「做事」的代码**(发请求、读写磁盘、跑工具)。
另:`core/logging` 也在闭包里,但不是壳自己的日志 —— 壳的 `services/log.ts` 是一个本地环形缓冲,**不往后端送**;
CLAUDE.md 里「渲染层日志经 `logs` RPC 域送到后端」那段描述的是已退役的 Vue 壳,与现状不符。

### 3.2 Electron 主进程:四种角色挤在一起

| 角色 | 代码 | 拆开以后归哪 |
| --- | --- | --- |
| 启动器 + 连接:读发现文件、把 `{baseUrl, token}` 交给页面 | `main.ts`、`host-connection.ts` | client |
| 自己当后端:装配 backend、开内嵌 HTTP 口、调度器、MCP / ACP | `main.ts` 的 `assembleOwnCore`、`host-ports.ts`(import backend 7 处、runtime 7 处) | **server**(两个进程以后由后台后端做) |
| 窗口系统与内置浏览器:原生视图、菜单、下载、网页权限 | `browser/*`、`native-view-*`、`app-menu*` | client;其中给 AI 用的 `browser:` 资源(import `core/resource` / `core/toolkit`)用户已决定不做 |
| 日志、内存探针、登录 shell 环境 | `memory-probe.ts`、`login-shell-env.ts`、经 `backend/wiring/logging` 写日志 | 拆开后 client 需要自己的日志落点 |

壳还有一处值导入 Electron 主进程的文件:`data/browser-port.ts` → `electron/native-view-protocol.ts`
(原生视图的协议形状)。它是 client 内部(页面 ↔ 主进程)的契约,与 server 无关。

### 3.3 CLI:两半

- **命令那一半**(`index.ts`、`daemon-client.ts`):用户敲的命令。按已定的方向改成本机后端的 HTTP 客户端 → **client**。
- **daemon 那一半**(`daemon-server.ts`):今天自己装配一个后端(`HeadlessBackend`),走 unix socket 和自有的 38 个方法 → 两个进程以后**退役**。
- **`trace-command.ts`**:直接读磁盘上的 `events.jsonl`,不经后端 → 是**后端那台机器上的工具**,归 server 侧(或改成经 RPC 读)。
- 另有 `store-lock-command.ts` 等直接动数据目录的维护命令,同理归 server 侧。

## 4. `@shared` 里到底是什么

按客户端实际怎么用(值导入沿值导入追,类型导入单列;桶 `ipc.ts` / `ipc/index.ts` 不当作「用到了全部」):

| 客户端的用法 | 文件 | 行数 | 是什么 |
| --- | ---: | ---: | --- |
| **值导入**(真的要在客户端跑) | 41 | 10.4k | 各域 RPC 契约(`defineRouter` 产出的「方法名表」是值,client 拿它发请求)、事件与命令词汇常量、发现文件的读法(`backend/http-discovery.ts`,client SDK 的 node 入口读 `run/http.json`)、几个纯函数(`provider-dials` / `provider-families` / `quota-windows` / `reasoning-effort`,P4 搬来的)、`defaults/settings.ts`(壳只用其中 `DEFAULT_NETWORK_SETTINGS` 一个常量) |
| **只用类型** | 16 | 4.8k | 消息、工具、协作等的数据形状 |
| **客户端完全不用** | 25 | 4.2k | 今天没有客户端调用的域的契约(evals、gateway、scheduler、practice、scratchpad、deeplink、window、notify、logs、app-state …);`defaults/ai-settings.ts`、`cli/protocol.ts`(只有后端 / CLI 用);`fonts.ts`、`tool-errors.ts`、`tool-failure-params.ts`(零使用) |

结论:**`@shared` 几乎就是「server 和 client 之间的 API」本身**(RPC 方法表 + 请求 / 响应形状 + 事件词汇),
外加少量放错位置的东西(只有一边用的默认值、CLI 协议、零使用的文件)。

## 5. 要不要 share:三条路

决定这件事的不是包的数量,而是一个问题:**两边是不是必须从同一份数据算出同一个答案?**
今天的答案是「是」:会话投影(后端写下来的与前端显示的必须一致)、引用标记解析、资源地址、权限效果表、文本编辑、
事件词汇、RPC 方法表 —— 这些在两边都要**运行**,不只是类型。

| | A. 保留一个瘦 shared | B. 契约由 server 拥有 | C. 不共享代码 |
| --- | --- | --- | --- |
| 做法 | shared = 契约(RPC 方法表、请求 / 响应类型、事件词汇、发现文件记录)+ 两边必须一致的纯逻辑(上面那些)。只有一边用的东西搬回那一边;core 里浏览器在用的入口与 runtime 那 3 个文件搬进来 | client 直接 import server 包里一个「契约 + 纯逻辑」子路径 | client 的类型由 schema 生成;纯逻辑各写各的,或者后端直接下发算好的消息 |
| 单一真相 | 有 | 有 | 类型有(生成),逻辑没有 |
| 边界由谁守 | 包边界(client 只能看见 shared) | 只能靠检查器(client 包依赖了 server 包,`import` 别的子路径不会报错) | 网络本身 —— 最硬 |
| 代价 | 要定规矩「shared 里只放两边都用的、不碰 node」,并由门守住 | 方向反了(客户端依赖后端包);手机的 Metro 也要能解析 server 包 | 要建代码生成;投影要么复制两份(必然漂移),要么**推翻 U 线的决定** —— 当时定的是「界面用事件词汇 + 同一个折叠函数自己算,不收快照」,改成后端下发成品消息是一次架构回退 |

不管走哪条,都要顺手做两件事:**把事件词汇收归一处**(拆掉 core ↔ shared 的环),以及**保证契约不碰 node**
(手机经 Metro 只吃类型,浏览器包里出现 `node:` 依赖就会坏)。

**推荐 A**:两边今天确实要运行同一批代码,而这批代码恰好全是「词汇、形状、纯算法」;把它们放进一个
client 和 server 都能看见、却看不见对方的包里,边界由包本身守,不用靠检查器,也不用推翻 U 线。

## 6. 按 A 走,拆开以后的样子(示意)

```
packages/shared      契约 + 两边共用的纯逻辑(会话投影、引用标记、资源地址、效果表、文本编辑、事件词汇……)
                     零 node 依赖;只 import 自己
packages/backend     server:今天的 core(除去搬进 shared 的那部分)+ runtime + backend,合成一个包;gateway 视情况并入
packages/client      client SDK(连接、RPC、事件订阅)
apps/server          后台后端进程外壳(两个进程以后的「后端」)
apps/desktop-react   src/ = 界面;electron/ = 启动器 + 窗口系统 + 内置浏览器(不再装配后端)
apps/cli             命令 = HTTP 客户端;daemon 退役;直接读盘的维护命令归 server 侧
apps/mobile          只吃 shared 的类型
```

依赖方向:`client 侧 → shared ← server 侧`,client 与 server 互不 import。

## 7. 顺带发现

- CLAUDE.md 的日志一节仍在描述 Vue 壳的渲染层日志中枢(经 `logs` RPC 送后端);React 壳的 `services/log.ts`
  是本地环形缓冲,不送后端。
- `shared` 里有 3 个零使用文件(`fonts.ts`、`tool-errors.ts`、`tool-failure-params.ts`)。
- `packages/gateway` 没有任何宿主在 import(与 09-30 调查一致)。
