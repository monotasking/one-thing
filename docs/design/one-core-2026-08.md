# 一个 core,任何 UI(2026-08-19)

> 起因:S0 落地后的 G12(跨进程 seq)让"server 要不要锁"第三次出现;用户点破:想要的一直是**一个 core,Electron / Web 都只是它的 UI**,而且"一直没成功"。本文回答三件事:为什么一直没成功、目标形态到底是什么、怎么分期走到。
> 与其它线的关系:`structural-debt-plan-2026-08.md` P4(传输面 router 迁移)解决"每个 UI **说同一种语言**";本文解决"每个 UI **连同一个实例**"。两半合起来才是"一个 core"。`session-event-sourcing-2026-08.md` S1 的硬前置 G12 由本文的 A 期消解。

---

## 0. 为什么一直没成功(诊断)

代码库里"一个 core"在**代码层**早就成立:`createOnethingBackend` 是唯一装配配方,`packages/core` + `runtime` + `app` 三层干净。没成立的是**运行时层**:

| 事实 | 位置 |
|---|---|
| Electron 主进程起一个引擎 | `apps/electron/src/app/main-process.ts:176 createOnethingBackend` |
| apps/server **再起一个**引擎 | `apps/server/src/runtime.ts:1119 createOnethingBackend` |
| CLI daemon **第三个** | `app/headless/backend.ts:98 createOnethingBackend`(`HeadlessBackend`) |
| Web 连的是 server 那个,不是 Electron 那个 | `apps/web/vite.config.ts:7 /api → :8787`;Electron 主进程**没有** HTTP/SSE 出口 |
| 三个引擎三种传输 | renderer↔main IPC(bridge.ts 1905 行)/ web↔server HTTP+SSE(web.ts 1801 行 + http.ts)/ CLI↔daemon unix socket NDJSON |

所以"在 Electron 发一条消息,Web 端能订阅到"在今天**不成立**——Web 订阅的是另一个进程的事件总线,只是恰好读同一个目录的文件。两个引擎各有一份内存真相、各自写同一批文件,这就是锁的问题反复出现的根。

**没成功的原因不是技术**,是每次加一个宿主就"再装配一个引擎 + 再写一套传输面",因为 Electron 给了 renderer 一条太方便的特权通道(IPC 直连主进程),引擎就被顺手留在了主进程里;而 web 要用就只能再起一个。三次都这么做,就成了三套。

---

## 1. 目标形态

```
                 ┌─────────────────────────────────────────┐
                 │  onething core service(每个 store 恰好一个进程)│
                 │  createOnethingBackend(...)               │
                 │  + 传输面:HTTP + SSE(回环 + token)        │
                 │    (= 今天 apps/server 的 http.ts,升格为核心)│
                 └───────────────┬─────────────────────────┘
        同一条事件流 / 同一份内存真相 / 同一个 seq 分配器
     ┌──────────────┬────────────┴────────────┬──────────────┐
     ▼              ▼                         ▼              ▼
 Electron renderer  Web 浏览器               CLI            未来任何 UI
 (platformApi →     (platformApi →           (同一 HTTP,    (同上)
  HTTP/SSE)          HTTP/SSE)                 不再 NDJSON)
```

三条规则:
1. **一个 store 只有一个引擎进程**。Electron 桌面开着时,它就是那个进程(引擎嵌在主进程里,**但必须同时暴露 HTTP/SSE 面**);没有桌面时 `server:start` 是那个进程。两者是同一份代码的两种启动方式,不是两套。
2. **UI 没有特权通道**。Electron renderer 对会话/聊天/设置/…的访问与 Web 完全同构(都是 `platformApi` 的 HTTP/SSE 实现);IPC 只留给**宿主原生能力**(窗口、原生面板、文件对话框、`media://`、快捷键)——这些本来就不是 core 的事。
3. **订阅即同步**。跨 UI 的一致性不靠锁、不靠文件,靠订阅同一条事件流。Web 开着、Electron 发消息,Web 的 SSE 收到同一个 `session:event`。

与 dsh 对照:dsh 就是这个形态(一个 harness 进程 + 任意前端经 remotes 连接),它的"壳税"为零正是因为没有第二条路。

---

## 2. 分期

| 期 | 名 | 做什么 | 消解什么 | 门 |
|---|---|---|---|---|
| **A** | 桌面内嵌 core 服务 | Electron 主进程在装配完 backend 后,**挂载** `apps/server` 的 HTTP/SSE 路由(把 `apps/server/src/http.ts` 抽成 `createOnethingHttpSurface(backend, opts)`,两个宿主都能挂),监听回环 :8787(端口/token 走 settings);`bun run dev` 不再起第二个 server 进程,web 直接连桌面;`server:start` 仍可独立跑(无桌面场景) | G12(单引擎 → seq 天然唯一,无锁);headless 缺口记忆里"三套引擎"去掉一套;dev 时 desktop/web 数据不互通 | 脚本:起桌面 → 浏览器开 :5174 → 两端各发一条 → 两端 SSE/IPC 都收到对方的 `session:event`;`sessions/*/messages.jsonl` 只有一个写进程(lsof) |
| **B** | renderer 去特权 | `platformApi` 的 Electron 实现按域切到与 web 相同的 HTTP/SSE 客户端(`router-client.ts` 同构),IPC 只剩宿主原生域;与结构债 P4 同步推进(P4 统一"说法",B 统一"对象") | bridge.ts/web.ts 双份镜像的**存在理由**消失(不是单纯合并,是 renderer 只剩一条路);`transport:gate` 归零 | 每域:桌面+web 同一段客户端代码;`transport:gate` 下降;双端冒烟 |
| **C** | core 可脱壳 | core 服务可作为独立进程常驻(= 今天的 CLI daemon 升格:HTTP/SSE 取代 NDJSON socket),Electron 启动时**领养已在跑的**或自己拉起;CLI 是普通 HTTP 客户端;`HeadlessBackend` 退役 | 第三套引擎;"桌面关了 agent 就停"的限制 | 桌面退出 → core 进程可选保活 → CLI/Web 继续用;再开桌面 → 领养不重启 |

A 是小的(一两天),且是 S1 的硬前置,建议**立即做**;B 跟结构债 P4 合并排期(逐域、可暂停);C 视需要。

---

## 3. 关键设计点(A 期)

- **嵌入 ≠ 第二份代码**:`apps/server/src/{http.ts(1988 行), runtime.ts(7629 行)}` 整体迁入 `packages/onething-runtime/src/app/server/`(装配层,Electron-free,可 import `@shared`),`apps/server/src/main.ts` 只剩进程壳。`runtime.ts` 增加 `createOnethingServerRuntimeOverBackend(backend, opts)`(不再自己 `createOnethingBackend`;现有 `createDevelopmentOnethingServerRuntime` 改为"先装配 backend 再调它");Electron 主进程在 backend 就绪后 `createOnethingHttpServer({runtime})` 并 `listen`。
- **端口(用户 2026-08-19 指出 8787 固定易冲突)**:默认 `listen(0)` 动态分配;显式 `ONETHING_SERVER_PORT`/设置项才固定,固定端口被占**明确报错不静默换**。起来后写 **发现文件** `<store>/run/http.json = {port, host, token, pid, startedAt, owner:'desktop'|'server'}`(与 `run/daemon.sock`、`run/backend.lock` 同目录),退出时删;客户端一律靠它找:web dev 代理(vite `proxy.router` 每请求读文件,桌面重启换端口不必重启 vite)、CLI、B 期 renderer 客户端。人找:日志一行 + 后续菜单"在浏览器中打开"(B 期)。
- **鉴权**:回环 + token(沿用 `ONETHING_SERVER_TOKEN` 语义;桌面每次启动生成随机 token 写进 http.json,env 设了则用 env);不绑非回环。
- **`server:start` 与桌面共存**:不是锁——启动时读 `run/http.json`,若 pid 存活且端口可达,拒绝启动并提示"这个 store 已由桌面 core 服务,直接连它"(`--force` 可绕过,自负后果)。这是"一个 store 一个 core"的直接体现。
- **权限通道亲和**:permission ask 记 `targetChannel`,web 的 respond 采用 ask 的 channel(server 今天已这么做),嵌入后同一进程内无需改。
- **dev 泳道**:`dev-unified`(electron+web)不再拉 server 进程,web 代理走发现文件;`dev:web` 单独跑时先读发现文件,活着就连桌面,否则自己拉 `server:start`(也写发现文件)。dev-self 泳道读它自己 store 的发现文件。
- **不动 renderer**(那是 B 期);A 期 web 端就是今天的 web 端,只是连的对象变了。

---

## 4. 不做 / 边界
- 不在 A 期把 IPC 域迁 HTTP(B 期 + P4)。
- 不做多 store / 多用户(server 仍单用户)。
- 不碰 gateway(它本来就是 core 进程内的一个通道)。
- 锁:A 之后 StoreLock 回到它本来的职责——同一 store 不起第二个 **core 进程**(desktop vs `server:start` vs daemon),这与"UI 不需要锁"不矛盾:UI 不是写者。

---

## 5. A 期落地记录(2026-08-19)

### 5.1 迁了什么

| 从 | 到 |
|---|---|
| `apps/server/src/http.ts`(1988 行) | `packages/onething-runtime/src/app/server/http.ts` |
| `apps/server/src/runtime.ts`(7629 行) | `packages/onething-runtime/src/app/server/runtime.ts` |
| `apps/server/src/mcp-client.ts` | `packages/onething-runtime/src/app/server/mcp-client.ts` |
| `apps/server/src/{http,mcp-wiring,session-create-id,session-scan}.test.ts` + `test-helpers.ts` | `packages/onething-runtime/src/app/server/__tests__/` |

`apps/server/src/` 只剩 `main.ts`(进程壳)与 `index.ts`(转出 `@onething/app/server/*`)。**没有任何东西被"切出来留在 apps/server"**:整棵树本来就满足装配层规矩(不 import electron / `@main` / `@preload`,`@shared` 允许,`node:http` 允许),迁移是纯搬家 + 改相对路径。

新增三个文件:
- `app/server/discovery.ts` —— 发现文件的读/写/删/探活。
- `app/server/embed.ts` —— `startEmbeddedOnethingHttpServer(backend, opts)` / `stopEmbeddedOnethingHttpServer()`,宿主内嵌用。
- `app/server/index.ts` —— 桶。

别名不用加:`@onething/app` 是**前缀**条目(`onething.aliases.ts:25`),`@onething/app/server/http.js` 自动落到 `packages/onething-runtime/src/app/server/http.ts`,四份配置(electron-vite / vitest / apps/web / apps/server)全都共用那张表。`tsconfig.json` 的 `@onething/app/*` 通配同理。

### 5.2 新接缝:`createOnethingServerRuntimeOverBackend(backend, opts)`

`runtime.ts` 里原来那个巨型函数体拆成三层:

```
createDevelopmentOnethingServerRuntime(options)      ← 老入口,签名不变
  ├─ options.createBackend(echo/local 测试后端)  → createServerRuntimeOverServerBackend(...)
  └─ createRealServerBackend(storePath)          → createOnethingServerRuntimeOverBackend(...)

createOnethingServerRuntimeOverBackend(backend: OnethingBackend, opts)   ← 新公开口
  └─ toOnethingServerBackend(backend, {ownsBackend}) → createServerRuntimeOverServerBackend(...)

createServerRuntimeOverServerBackend(backend: OnethingServerBackend, options)  ← 原函数体
```

`createRealServerBackend` 现在返回**产品后端**(`OnethingBackend`)而不是适配壳;适配那一小段提到 `toOnethingServerBackend`,两个调用方共用。echo / local-store 测试后端一行没动。

两个新选项:
- `ownsBackend`(默认 true):`runtime.shutdown()` 要不要连带关掉 backend。桌面借出来的传 `false` —— 关 HTTP 面绝不能把宿主的引擎一起关了。
- `processPorts: 'own' | 'host'`(默认 `'own'`):**进程级单槽端口**归谁。这是内嵌时最容易翻车的一处:server runtime 原本无条件 `configureMCPClientHost(mcpClientFactory)`(默认是 `DisabledServerMCPClient`)、`configureMCPClientIdentity`、`configureMCPCapabilitiesChangedHandler`、`configureOnethingPermissionGrantStorage`、`configureTodoPlanHost`、`configureScratchpadHost` —— 在桌面进程里跑一遍,等于把桌面的 MCP 静悄悄换成"禁用",把授权账页搬到另一个目录。`'host'` 下:
  - MCP 三件 + 授权账页存储:**一律不碰**(宿主已配);MCP 初始化也由宿主的 `initializeMCP()` 负责。
  - todo/scratchpad 广播:**串联**而不是覆盖 —— 先调宿主原本那只(IPC 给 renderer),再喂 SSE(给浏览器)。`shutdown()` 里还原。为此给 `app/todo-plan/store.ts` 和 `app/scratchpad/index.ts` 各加了一个 `get*HostPorts()`(单槽端口要能串联,后来者必须读得到前一位)。
  - scratchpad watcher 不重复起(它是单例,宿主已经起过)。

### 5.3 桌面内嵌

`apps/electron/src/app/main-process.ts`:
- `createOnethingBackend(...)` 的返回值不再丢弃,存进模块级 `desktopBackend`。
- `startPostWindowServices()` 第一件事是 `startEmbeddedCoreHttpSurface()` —— 非阻塞,失败只记一条 `[core-http] failed to mount …`,桌面照常用。
- 退出:`before-quit` 表新增**同步**项 `stopEmbeddedHttpServer`(排在同步段,和 `shutdownPlugins` 一起)——`before-quit` 不被 await,发现文件必须先于一切 await 消失;关端口 fire-and-forget。`SIGTERM`/`SIGINT`(dev 重启走的正是这条)也先删发现文件。

端口/鉴权口径(§3):`ONETHING_SERVER_PORT` 给了就固定(被占 = 明确报错,不静默换),没给就 `listen(0)`;token 取 `ONETHING_SERVER_TOKEN`,没有就 `crypto.randomBytes(24).toString('base64url')` 每次启动生成一把;只绑 `127.0.0.1`;CORS 单值,默认 `http://127.0.0.1:5174`,泳道脚本用 `ONETHING_CORS_ORIGIN` 覆盖(dev-self 是 5274)。

### 5.4 发现文件

`<store>/run/http.json`(与 `run/daemon.sock`、`run/backend.lock` 同目录;run 目录的定义提到 `@onething/runtime/storage` 的 `getOnethingRunDir()`,CLI 那份 `getCliRuntimePaths` 改为调它):

```json
{ "port": 59743, "host": "127.0.0.1", "token": "…", "pid": 7049, "startedAt": 1787149823862, "owner": "desktop" }
```

- 目录 0700,文件 0600(token 躺在盘上);文件已存在时补一次 `chmod`,因为 `writeFileSync` 的 `mode` 只在创建时生效。
- 读**永不抛**:不在 / 坏了 / 形状不对一律 `undefined`,调用方走回退。
- **存在 ≠ 活着**:`isHttpDiscoveryAlive` 是两段判定 —— pid 存活(`kill(pid,0)`,EPERM 也算活)**且**端口能连上。只看 pid 会被 pid 复用骗,只看端口会被别的程序占用同一端口骗。

### 5.5 `server:start` 让位

`apps/server/src/main.ts` 装配**之前**读发现文件:活着且 `owner !== 'server'` → 打一行人话并 `exit 1`,`--force` 绕过。它自己起来后也写发现文件(`owner: 'server'`,默认动态端口),退出时删(排在 `server.close()` 之前 —— 关端口那一刻"我在服务"就已经不成立)。配对 JSON 那一行照旧,只是端口取的是 `listen` 之后的实际值。

> 口径边界:**两个 `server:start` 之间不互相拒绝**(那本是 StoreLock 的活,P0.4 已撤)。发现文件只解决"桌面在服务时别再起一个引擎"。

### 5.6 dev 泳道

- `scripts/dev-unified.mjs`:electron 泳道在这次 run 里 → **不拉 server 进程**(桌面就是 core);web 单独跑 → 先读发现文件,活着就直接连,否则照旧 `server:build` + 起进程。就绪行里的 API 地址改成从发现文件读到的那个(不再是常量),读不到就打一句 warning。`cleanupPort(ports.server)` 只在真的要自己拉 server 时才做 —— 动态端口时代那个端口号上蹲着的很可能是别人。electron 泳道多传一个 `ONETHING_CORS_ORIGIN`。
- `apps/web/vite.config.ts`:内置 `server.proxy` 换成自写插件 `apps/web/dev-api-proxy.ts`。**为什么不能用内置的**:vite 在 `createProxyServer(opts)` 时就把 target 定死了,`proxies[context] = [proxy, {...opts}]` 存的是浅拷贝,`bypass(req,res,opts)` 拿到的是那份拷贝,改不动真正生效的 target。自写插件每请求读一次发现文件,并且**注入 `Authorization: Bearer <token>`** —— 浏览器不知道 token,它止步于 dev 代理。发现文件没有就回退 `ONETHING_API_URL || http://127.0.0.1:8787`(手动起的 `server:start` 仍连得上)。SSE 靠原样 pipe 保活,客户端断开就 destroy 上游。

### 5.7 验收(全部脚本级,无人肉走查)

| 项 | 结果 |
|---|---|
| 迁移后 `apps/server` 原有 4 份测试 | 58 passed |
| 新增 `discovery.test.ts` / `runtime-over-backend.test.ts` | 15 passed |
| `bun run server:build` → `node dist/server/main.js` | 单文件包正常启动(无 TDZ 死锁),动态端口 59219 |
| 发现文件 | 权限 0600,`owner:'server'`,内容如上 |
| 无 token 请求 `/api/capabilities` | 401 |
| 带 token | 200 + capabilities JSON |
| 陈旧(pid 已死)`owner:'desktop'` 记录 | 不拒绝,照常启动 |
| 活的 `owner:'desktop'` 记录 | `exit=1` + 让位提示 |
| 同上 + `--force` | 照常启动 |
| SIGTERM | 发现文件被删,刷盘走完 |
| **真机 Electron**(`out/main/index.js` + 临时 store) | `[core-http] embedded HTTP/SSE surface listening on http://127.0.0.1:59743`;`owner:'desktop'`;无 token 401 / 带 token 200;`MCPManager` 只初始化一次(没被 server runtime 覆盖);退出后发现文件消失 |
| 桌面在跑时 `server:start` | `exit=1` + 让位提示 |

门:`typecheck`(仅 3 条既有 red)、全量 `test`(仅既有 3 条 red)、`boundary:gate`(13 known,0 new)、`session:gate`(0)、`lint:ci`(334 基线)、`server:build`、`build`(electron)全过。`transport:gate` 有 4 条**既有**指标回升(bridge.ts / web.ts / channels.ts / IPC_CHANNELS,在 HEAD 上逐字相同),本次只把基线里 `lines:apps/server/src/http.ts` 改名成新路径、数值不变。

### 5.8 A 期没做的

- renderer 仍走 IPC(那是 B 期)。web 端连的对象变了,代码没变。
- CLI daemon 仍是 NDJSON + 第三只引擎(C 期)。
- 发现文件目前没有"人找"的入口(菜单"在浏览器中打开"留给 B 期),只有日志一行。
