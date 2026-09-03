# RPC 域的 transport 分叉改端口(方案 B,2026-09-03)

来源:`docs/audit/backend-design-patterns-review-2026-09-02.md` §6 路线 B,用户 09-03 拍板"开 B"。
前置:方案 A 已落地(`backend-composition-root-2026-09.md`,提交 6b7ca50e / aef66b49 / bebc3d4a)——
`OnethingHostPorts` 那张表就是本方案要让 RPC 域去读的东西。

## 0. 一句话

`context.transport` 从今往后只准回答一个问题:**这条命令的回应该走哪条总线通道**(通道亲和)。
其余每一处"http 就拒 / http 就假态 / http 就绕去 server 闭包"的分叉,改成问两件与传输无关的事:
**这台宿主有没有这个外设**(读 `OnethingHostPorts` 那一格有没有注入)与
**调用方是不是本机可信**(读已有的 `isHostLocallyTrusted()`)。
出界脱敏(payload 经网络离开进程时摘掉密钥)是传输属性,保留,但改名把它说清楚。
一道棘轮把"哪些文件还能读 `transport`"钉死并只许降。

## 1. 现状(已核对,HEAD 6182962e)

42 域 318 方法,13 域读 `context.transport`。逐处归类如下(行号是今天的):

| 域 | 处 | 今天的判据 | 实际在问什么 | 归类 |
| --- | --- | --- | --- | --- |
| `voice.ts` | 11/11 | `transport==='http'` → 恒返回 `createServerVoiceState()` 假态 | 这台宿主有没有语音窗口与托盘 | **外设** → `host.voice` |
| `terminal.ts` | 7/7 | `transport==='http'` → 7 条全拒 "desktop host only" | 这台宿主有没有 PTY 的输出广播器(`configureTerminalBroadcaster`,今天由 Vue 的 `@main/ipc/terminal.ts` 注入,不在 `OnethingHostPorts` 里) | **外设** → 新增 `host.terminal` |
| `plugins.ts` | 7 读面 | `serverCatalog()`:`transport==='http'` → 走 `server/plugin-catalog.ts` 镜像目录 | 这个进程装没装 PluginManager;没装才该问 server 镜像 | **外设**(管理器在位优先) |
| `plugins.ts` | 11 写面 | `pluginsUnmanaged()`:`http && getPluginManager()===null` | 同上 | **外设**(去掉 `http &&`,只看管理器) |
| `oauth.ts:87` | 1 | `http` → 不开浏览器,把 `authUrl` 交回调用方 | 这台宿主有没有 `shell.openExternal` | **外设** → `host.shell` |
| `tools.ts:173` | 1 | `http` → 工具白名单 + 会话存在 + 访问判定三道闸 | 调用方是不是本机可信 | **信任** |
| `tools.ts:218/226/231` | 3 | `http` → 后台任务表恒空 / 停止不可用 / 工具调用更新不可用 | 同上(后台任务是本进程的表,远端多租户才该藏) | **信任** |
| `search.ts:59` | 1 | `http` → `getServerSearchPort()`(per-owner 沙箱)否则整机 `executeSearch` | 同上 | **信任**(可信 → 整机;否则 → server 端口) |
| `evals.ts:108` | 1 | `http` → 路径夹进 evals 两棵树 | 同上 | **信任** |
| `mcp.ts:199` | 1 | `http && stdio && !env` → 拒 probe | 能不能替调用方起本机进程 | **信任**(可信 ∨ env) |
| `mcp.ts:265` | 1 | `http` → 读配置文件恒"不存在" | 同上 | **信任** |
| `sessions.ts:241` | 1 | `http && kind && !collabRunning` → 拒建 | 进程里跑没跑 collab;ipc 那一列不检查是 Vue 遗留 | **面**(去掉 `http &&`,无条件) |
| `sessions.ts:304` | 1 | `http` → `releaseServedSession` + `Permission.clearSession` | HTTP 面自己的 served 表要收干净;IPC 没有这张表 | **面**(改成无条件;没 served 项就是 no-op,须核实) |
| `sessions.ts:385` | 1 | `http && !isHostLocallyTrusted()` → 夹 workingDirectory | 已经是信任判据 | **信任**(去掉 `http &&`,只看信任) |
| `files.ts:147` | 8 处经 `resolveFilesSandbox` | `http && isFilesHostLocallyTrusted()` → unconfined | 已经是信任判据 | **信任**(去掉 `http &&`) |
| `mcp.ts:119/126/152` | 3 | `http` → 状态 / 变更结果 / 配置脱敏 | payload 经网络离开进程 | **出界脱敏**(保留,改名) |
| `settings.ts:108/151/162` | 3 | `http` → 出门脱敏、回来合并真值 | 同上 | **出界脱敏**(保留,改名) |
| `session-command.ts:193` | 1 | `http` → abort 本地处理;权限应答认领 ask 的 targetChannel | 通道亲和 | **保留** |
| `interaction.ts:64` | 1 | `ipc` → 盖章 `'ipc'`,否则从 pending 读 | 通道亲和 | **保留** |
| `logs.ts:66` | 1 | 只把 transport 写进日志字段 | 记账 | **保留** |

`/api/capabilities`(`server/runtime.ts:570-590`):除 `collabRooms` 外全是静态常量 `webServerCapabilities`,
与后端实际护栏的判据是两套——这是审计 §2.6 说的"前端能力位与后端判据对不齐"的根。

**本机信任**今天已经是一个宿主端口:`server/local-trust.ts` 的 `configureFilesLocalTrust({origin:'desktop-embedded'|'loopback-server'})`,
桌面内嵌面在 `embed.ts:110` 声明、回环 `server:start` 在 `apps/server/src/main.ts:137` 声明,`ONETHING_SERVER_FILES_SANDBOX=1` 强制关。
名字里的 "files" 是历史(它先为 files 域而生),`isHostLocallyTrusted()` 这个别名已经存在。

## 2. 目标形状

### 2.1 三个问题,三个口

```ts
// 外设:读 OnethingHostPorts 那一格有没有注入(各自的 host-ports 模块加一个布尔访问器)
hasVoiceHost()      // runtime/src/voice/host-ports.wiring.ts
hasTerminalHost()   // runtime/src/terminal/service.wiring.ts(broadcaster 是否注入)
hasShellHost()      // runtime/src/shell/host-ports.ts
getPluginManager()  // 已有

// 信任:已有
isHostLocallyTrusted()   // server/local-trust.ts;文件改名 host-trust.ts,configureFilesLocalTrust 保留为别名

// 出界:把"remote caller"这个误导的名字换掉——它问的不是远不远,是 payload 走不走网络
payloadLeavesProcess(context)   // = context.transport === 'http';只有 mcp / settings 的脱敏可以调它
```

`OnethingHostPorts` 加一格:

```ts
terminal: TerminalHostPorts | null   // { broadcaster: TerminalBroadcaster };null = 这个宿主没有终端输出通道
```

React 壳写 `terminal: null`(它今天没有终端 UI,HTTP 面也没有终端数据的 SSE 路由——接的时候再补,不在 B);
Vue 桌面把 `@main/ipc/terminal.ts` 里的 `configureTerminalBroadcaster(...)` 搬进 `createElectronDesktopHostPorts()`;
server / daemon / 冒烟探针 `null`。`applyHostPorts` 对 `terminal` 非 null 时调 `configureTerminalBroadcaster`。

### 2.2 域处理器改法(逐域)

- **voice**:`isRemoteCaller` 删,11 处改 `if (!hasVoiceHost()) return <今天的假态/拒绝>`。返回值逐字不变。
- **terminal**:同上,`hasTerminalHost()`。
- **plugins**:`serverCatalog(context)` 改成 `pluginCatalogFor()`:`getPluginManager()` 在位 → `null`(走管理器那条路,与 IPC 同);不在位 → `getServerPluginCatalogPort()`(可能为 null → 今天的结构化拒绝)。`pluginsUnmanaged()` 改成 `getPluginManager() === null`。**效果**:桌面内嵌面上 7 条读面改读桌面真树(审计 §2.5 的脑裂消失);React 壳与独立 server 逐字不变。
- **oauth**:`openExternal: hasShellHost() ? url => getShellHost().openExternal(url) : undefined`。
- **tools**:4 处 `transport==='http'` 改 `!isHostLocallyTrusted()`。
- **search**:`isHostLocallyTrusted() ? executeSearch : serverPort(缺 → 今天的错误)`。
- **evals**:`clampEvalsWirePath` 的 `transport!=='http'` 改 `isHostLocallyTrusted()`。
- **mcp**:`probeServer` 的判据改 `!isHostLocallyTrusted() && stdio && !env`;`readConfigFile` 的 `remote` 改 `!isHostLocallyTrusted()`;三处脱敏改调 `payloadLeavesProcess(context)`。
- **sessions**:`:241` 去掉 `transport==='http' &&`(带 kind 而 collab 没跑一律拒);`:304` 去掉条件(先读 `releaseServedSession` 确认无 served 项时是 no-op,不是就保留原判据并报告);`:385` 去掉 `transport==='http' &&`。
- **files**:`resolveFilesSandbox` 去掉 `transport==='http' &&`(只看 `isFilesHostLocallyTrusted()`)。
- **settings / session-command / interaction / logs**:不动(settings 只改名)。

### 2.3 能力位从后端事实推导

`currentServerCapabilities()` 不再摊一份静态常量,而是:

```ts
{
  ...webServerCapabilities,            // 纯客户端形态的那几位(clipboardWrite / desktopWindows / globalMenuEvents …)照旧
  collabRooms: isCollabV3RuntimeRunning(),
  voice: hasVoiceHost(),               // 新:与 voice 域同一判据
  terminal: hasTerminalHost(),         // 新:与 terminal 域同一判据
  pluginsManage: getPluginManager() !== null,
  shellTools: hasShellHost(),
  localFileSystem: isHostLocallyTrusted(),
  workspaceFileSystem: true,
}
```

`RuntimeHostCapabilities` 里今天没有的键(`voice`)按 `packages/renderer/platform/types.ts` 的 14 位对齐加上。
渲染侧(Vue,退役)与 mobile 读到的就是后端护栏的真值,两套判据合成一套。`music` 那一位**不动**:
`web.ts:51` 已经写明"谁在服务这个 store 谁的机器就是放音机",这是裁定不是缺口;要改是另一票。

### 2.4 棘轮

`scripts/transport-gate.mjs` 加第二个指标:`packages/backend/rpc/domains/*.ts` 里每个文件的 `context.transport` /
`.transport ===` / `.transport !==` 读法计数(注释行不算)。基线文件同一份 `docs/audit/transport-baseline-2026-08-14.txt`
追加一段(或新开 `transport-forks-baseline-2026-09-03.txt`,由施工者按现有脚本的结构决定,报告写明)。
**只许降**,B3 结束时的目标基线:`session-command 1 / interaction 1 / logs 1 / mcp 3 / settings 3`,其余全部 0。
同一脚本再加第三个指标:`apps/desktop-react/electron/*.ts` 里 `ipcMain.handle|on(` 的个数 ≤ 1(`host:connection`)——
新壳的手写通道从此在量程内。

## 3. 分期与门

每期结束:`bun run typecheck` 零错、改动文件 eslint 零新增、定向 vitest 全绿、七道闸
(`boundary` / `session` / `transport` / `log` / `ui` / `assembly` + 本期新指标)全绿,两条真机探针
(`apps/desktop-react npm run smoke:core`、`bun run server:build && bun run log:smoke`)绿。

| 期 | 做什么 | 门(自证) |
| --- | --- | --- |
| **B0** | 棘轮:`transport-gate.mjs` 加两个指标(域文件 transport 读法逐文件计数只许降;desktop-react `ipcMain` ≤ 1),基线 = 今天的数。 | `bun run transport:gate` 绿;`--self-test`(照 assembly-gate 的写法)红绿各一 |
| **B1** | 外设四域:`host.terminal` 一格 + 五处宿主表;`hasVoiceHost / hasTerminalHost / hasShellHost`;voice / terminal / plugins / oauth 改判据。 | 每域一份处理器级单测:`{transport:'http'}` 下,端口注入 → 真路;未注入 → 今天的假态/拒绝逐字同;plugins 加一条"管理器在位 + http → 读管理器不读镜像"。棘轮四文件降到 0 |
| **B2** | 信任与面:tools / search / evals / mcp(两处)/ sessions(三处)/ files;`local-trust.ts` → `host-trust.ts`(旧名保留别名);`isRemoteCaller` 全部删除,脱敏两域改 `payloadLeavesProcess`。 | 每域单测:`{transport:'http'}` + 已声明本机信任 → 与 `{transport:'ipc'}` 结果相同;未声明 → 与今天 http 相同。棘轮降到目标基线 |
| **B3** | 能力位推导(§2.3)。 | 单测:注入 voice 端口 → `/api/capabilities.voice === true`;移除 → false;与 voice 域同一判据(同一个 `hasVoiceHost`) |
| **B4** | 文档:CLAUDE.md「IPC Communication Pattern」与「Process model」两段改成"transport 只答通道亲和;外设问端口,信任问 host-trust";本方案 §1 表改成"施工后"。 | `grep -c isRemoteCaller packages/backend` = 0 |

顺序 B0 → B1 → B2 → B3 → B4,每期一个提交。B1 与 B2 不并行(都动 `rpc/domains`)。

## 4. 可感知变化(列给用户,不是拍板)

在**现役宿主**上会变的:

| 宿主 | 变化 | 性质 |
| --- | --- | --- |
| React 壳(HTTP 面,`desktop-embedded` 可信) | tools:后台任务列表 / 停止 / 工具调用更新 / `executeTool` 三道闸 **放开**(今天恒空 / 恒拒);search:从 per-owner 沙箱端口改走**整机**搜索;evals 路径不再夹;mcp:stdio probe 与读配置文件放开 | 全部是"与 Vue 桌面 IPC 同权",即 B 的目的;每一条都是从"假态"变"真" |
| 回环 `server:start`(声明了 `loopback-server` 可信) | 同上一行 | 与 files 域 08-31 的既有裁定同口径("回环 server 走 ipc 那一列");**其中 mcp stdio = 替调用方起本机进程**,若不想让回环 server 也开,加一行 `origin === 'desktop-embedded'` 的判据即可——**请拍板** |
| 独立部署 server(未声明可信) | 逐字不变 | — |
| React 壳 / server / daemon 的 voice / terminal / plugins | 逐字不变(端口本来就是 null / 管理器本来就没装) | — |
| Vue 桌面内嵌面(退役) | plugins 7 条读面改读桌面真树 | 修脑裂 |

不在 B 里、需要单独拍板的:`ONETHING_SERVER_TOOLS` 缺省 `full`(审计 §2.6);`music` 能力位的裁定;
React 壳要不要接终端(需要给 HTTP 面加终端数据的 SSE 路由,那是 C 之外的一票)。

## 5. 明确不做

- 不动 `session-command` / `interaction` 的通道亲和分叉——那正是 `transport` 该答的问题。
- 不动 mcp / settings 的脱敏语义,只改名。
- 不动 `server/runtime.ts` 的内嵌面链上/覆盖逻辑(它要等 server runtime 能拿到"自己的实例",排在 B 后)。
- 不给 React 壳接语音 / 终端 / 插件——B 让判据正确,接不接是产品决定。

## 6. 风险

- **`releaseServedSession` 无条件调**:若它在没有 served 项时不是 no-op(比如抛错),保留原判据并报告——施工前先读。
- **terminal 广播器搬进宿主表**:`configureTerminalBroadcaster` 今天在 `initializeIPC()`(afterTools 钩子)里注册,搬进 `applyHostPorts` 意味着提前到装配第一步;广播器闭包里若读了装配产物(`getIPCBridge()` 是懒取,应无问题),逐字核对。
- **local trust 改名**:`configureFilesLocalTrust` 有 boundary checker 断言(A1 那次放宽的先例),改名时同步。
