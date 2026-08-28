# web 泳道 SSE 诊断:具名事件到底有没有到浏览器(2026-08-28,opus 勘察,零代码改动)

起因:U1-b 施工的真机支架里撞见「SSE 连上(readyState 1)但 `session:event` 零到达
renderer」——服务端账本三轮跑完,浏览器里 chatStore 始终 0 条消息。这条直接压在
冻结中的 **B 批**(换管走同一条推送面)与用户对 web 端的信任上,所以单独查一棒。

> **2026-08-28 补充勘察:结论改判。** 复跑 listRaw 修复时"账本三轮跑完、renderer 零消息"
> **当场复现了**,并且定位到了真因 —— 不是支架,是**服务端的会话归属判据**把这条会话的
> 事件从 SSE 广播里整只滤掉了。第五节是完整证据链;下面第一、二节的读数与判定保留原样
> (它们本身没错:那些**用 `sessions.create` 建出来的**会话确实全程正常),但"(c) 支架
> 自身接错"这句**只解释一半**,另一半是第五节这条真缺陷。
>
> 施工时那两条支架接错(store 环境变量、探针签名)是真的,但它们**不是**产品静默的原因。

**结论先写**:判定 **(c) 支架自身接错**。生产两条泳道没有被证伪 —— 在一次逐层核对过
配置的复跑里,同一条 standalone server 泳道**三段全通**,连产品全流程(输入框发消息 →
消息实时上屏)都正常。查的路上另外**抓到一个真缺口**(与 SSE 无关):
`sessionEvents.list` 只交付**老七类**,ui-refold 的账本侧因此在真机上恒折出 0 条消息。

---

## 一、三段观察的读数

复跑支架:临时 store + 假 provider(OpenAI 兼容 SSE)+ 真 `dist/server/main.js`
(:8932,token 固定)+ apps/web 的 vite dev(:5199)+ 真 Chromium。真机 `~/.onething`
全程只读。

### 段一:服务端 SSE 出口(不经浏览器、不经代理)

裸 node `fetch` 流读 `GET /api/events`,一发一收:

| 连接 | 身份头 | 结果 |
|---|---|---|
| A | 不带 `x-onething-*`(与浏览器 EventSource 同款,它根本发不了头) | `status=200 ct=text/event-stream`,**11 条 `session:event`** + 1 条 `: connected` |
| B | 带 `x-onething-user-id: local-user` / `workspace-id: default` | 同上,11 条 |
| C | 会话建好后新开、带 `?sessionId=` | 6 条 |

出口本身是好的:`packages/backend/server/http.ts:459` `handleEvents` →
`writeSse(response, 'session:event', envelope, envelope.sequence)`(:495),
`SessionStreamCoalescer` 实例在 :485 每连接一只,`session:stream` 走 :487。
**归属过滤没有误杀**:`runtime.events.subscribe('*')` 那条
(`packages/backend/server/runtime.ts:1924-1951`)按 `canReadSession` 逐条放行,
而 `ownsSession`(:2655)对"没有 owner 字段的会话"直接放行 —— A/B 两条读数一样,
证明身份头在这条泳道上不影响投递。

### 段二:网络层(vite dev 代理 → 浏览器原始帧)

在页面里用 `fetch('/api/events')` 流读(绕开 EventSource),同时开一条 EventSource
具名监听,再用同一页的 `POST /api/rpc` 建会话并发消息:

```
l1 (裸 fetch 流读) : { '(unnamed)': 1, 'session:event': 25, 'session:stream': 3 }  共 29 帧
l2 (EventSource)   : { 'session:event': 25, 'session:stream': 3 }                  共 28 帧
```

代理这一跳没有缓冲问题:`apps/web/dev-api-proxy.ts:100-104` 是
`upstreamResponse.pipe(res)` 原样转发,`res.on('close')` 收上游。

### 段三:renderer 订阅口 → store → 屏幕

`packages/renderer/platform/web.ts:201-235` `createEventSourceSubscription`:
按 **path** 复用一条 EventSource(`sharedEventSources`),用
`addEventListener(eventName, …)` 收具名帧 —— `session:event` 的订阅在 :246 / :301 /
:328 / :352 / :374,`ipc-hub` 的分发口在 `packages/renderer/services/ipc-hub.ts:80`。

读数:走**产品全流程**(点输入框 → 打字 → Enter)之后

- `chatStore.sessionMessages` 从 0 → 4 → 6 条,消息实时上屏(DOM 里读得到正文与工具行);
- `window.__onethingUiRefold.stats()` = `{checks: 1, mismatches: 1, …}` —— 收尾采样也真的跑了。

三段全通。

---

## 二、(a)/(b)/(c) 判定

**(c) 支架自身接错**。两条具体的接错模式,各有对照实验:

1. **vite 没拿到 `ONETHING_STORE_PATH`**(施工时的真实原因之一):支架脚本用
   `grep -o '/var/folders/…' <server.log>` 取临时 store 路径,而那份日志被 `grep`
   判成 **binary**(`file` 报 `data`),**静默返回空**,于是 vite 起在了空环境里。
   `dev-api-proxy.ts:34-37` 的 `laneStorePath()` 因此回落到 `~/.onething`,那里没有
   发现文件,再回落到 `ONETHING_API_URL || http://127.0.0.1:8787`(:69-76)——
   而 8787 上没有任何进程。
   **对照实验**:故意不带该环境变量复跑,`GET /api/events` 与 `POST /api/rpc`
   **同时** 502(`[dev-proxy] no onething core at 127.0.0.1:8787: ECONNREFUSED`)。
2. **探针调用签名用错**:两次"SSE 收不到"的现场探针里,我用
   `chatStore.sendMessage('文本')` 触发回合,而那个入参是 **sessionId**。服务端当场
   `channel.session-router Resolved message session route {"requestedSessionId":"probe from browser"}`
   + `core.engine handleSendMessage error` —— **压根没有事件被发出**,收不到是对的。

**(b) 仅 standalone server 泳道坏**:证伪 —— 上面三段全部就是 standalone 泳道。

**(a) 生产 web 泳道真坏**:没有证据支持。桌面内嵌 HTTP 面与 standalone 跑的是**同一份**
`packages/backend/server/http.ts`(§一里那条 `handleEvents`),而这份代码在真浏览器上
被证明会发具名帧;renderer 那一侧也被证明会收。桌面内嵌面本批没有单独驱动(要驱动
Electron UI,本机没有那条自动化缝),所以措辞停在"未证伪",不写成"已验证"。

排除掉的两条中途假设,各有读数:

- **vite 首次依赖优化打断**(仓内既有判例):用 `ONETHING_WEB_CACHE_DIR` 指到一个空目录
  强制冷优化后复跑 —— 照样全通(6 条消息上屏)。不成立。
- **5 秒一次的 `POST /api/rpc` 是降级轮询**:健康复跑里同样存在(200 次请求里绝大多数
  是它),是常态背景流量,不是"SSE 挂了才轮询"的信号。不成立。

**留一句诚实的话**:施工当时那台支架的 store 与日志已经被我清掉(临时目录 + 日志覆盖),
所以"当时到底是这两条里的哪一条"无法回溯钉死;能钉死的是**这两条各自都能造出那个现象**,
而**逐层核对过配置之后现象不复现**。

---

## 三、路上抓到的真缺口(与 SSE 无关,但直接压着 ui-refold)

`sessionEvents.list` **只交付老七类**,不是全集:

`packages/backend/rpc/domains/session-events.ts:20-23` → `readSessionEvents`
(`packages/backend/session/event-log.ts:717`)→ `parseSessionEventLog`
(`packages/onething-runtime/src/sessions/session-events.ts:178`)→
`decodeSessionEventLine`(同文件 :166)**在出口按七类再筛一道**,v2 新增类型按
"未来版本的新类型"跳过。全集读法是隔壁那条 `readSessionLogEvents`
(`event-log.ts:729`,投影 / surface 索引走它)。

真机读数(本批那条会话):

| | 条数 | 类型 |
|---|---|---|
| 盘上 `events.jsonl` | **47** | 18 类,含 `session/created` `user/message` `run/start` `assistant/chunks` `assistant/part-end` `message/patched` `run/end` |
| `sessionEvents.list` 返回 | **16** | 只有 `request/tools·header·start·end` / `tool/call·audit·result` / `assistant/first-token` |

后果:**ui-refold 的账本侧在真机上恒折出 0 条消息** —— 折叠器要的开张事件
(`run/start`、`user/message`、`session/created`)全被筛掉了。现场那条失配就是它:

```
warn ui-refold mismatch { sessionId: ff59d59a…, hand: 6, ledger: 0,
                          diff: [{ path: '.length', a: '0', b: '6' }] }
```

U1-b 的单元测试喂的是手写的 v2 夹具、直接进 `compareUiRefold`,绕过了这条 RPC,
所以测试全绿而真机必红 —— 这正是"真机是另一半门"的又一个例子。

**修复方向(一句话,不施工)**:给 `sessionEvents` 域加一条全集读法(或给 `list` 一个
"全集"参数),让 ui-refold 走 `readSessionLogEvents` 那条;老七类那条是轨迹面板的
词汇,不该被投影消费者共用。**动它=改一个已发布 RPC 面的语义,属拍板范围。**

---

## 四、这一棒的边界

零代码改动;真机 `~/.onething` 只读(只 `stat`/读文件与 RPC 读面,零写入);
支架全程临时 store,跑完删除。工作树只多这一份文档与 §17.8 的一句指针。

---

## 五、改判:真因是 `ownsSession` 的"半盖章会话"(2026-08-28 补充,证据链完整)

### 5.1 现象:同一进程、同一时刻,两类会话的命运不同

复跑时用**裸 node**(不经浏览器、不经 vite 代理)开一条 `GET /api/events`,再用两条路各建一条会话、各跑一轮:

| 建会话的路 | 会话 | 事件真的产生了吗 | SSE 收到 |
|---|---|---|---|
| `sessions.create` RPC(我的探针 / 之前那几次"健康"复跑走的都是它) | `bb197fe9` | 是 | **28 帧** |
| 直接对一个新 id 发消息(`ensureSession` 隐式建)| `f2e4f0e1` | 是 | **0 帧** |
| 浏览器点 "New Chat" 再发(**产品真实路径**) | `732f6ec3` | 是(账本 24 → 57 行) | **0 帧** |

浏览器侧同一时刻的对照:代理后的裸 `fetch` 流读与 `EventSource` 对 `bb197fe9` 类会话拿到
25+3 帧,对 `732f6ec3` 拿到 0 帧。**所以既不是代理、也不是 EventSource、更不是浏览器**——
是服务端按会话把事件滤掉了。

### 5.2 判据:`ownsSession` 的"无主"早出要求两格**都**空

`packages/backend/server/runtime.ts:2655-2664`:

```ts
function ownsSession(session, context = defaultRequestContext()): boolean {
  if (!session.userId && !session.workspaceId) return true;      // 无主 → 放行
  return session.userId === context.userId
      && session.workspaceId === context.workspaceId;            // 否则两格都要对上
}
```

SSE 的 `handleEvents`(`server/http.ts:491-496`)订阅的是通配 `'*'`,每条事件都过
`canReadSession` → `getSessionForContext` → `ownsSession`(`runtime.ts:1924-1951`)。

盘上读数(同一个 store,`meta.json` / `index.json` 一致):

| 会话 | userId | workspaceId | SSE |
|---|---|---|---|
| `bb197fe9`(create 路) | — | — | 通(**两格都空,走无主早出**) |
| `dab3d4c6`(create 路) | — | — | 通 |
| `215f14d4`(create 路) | — | — | 通 |
| **`732f6ec3`(UI 路)** | — | **`default`** | **断** |

`732f6ec3` 只被盖了半个章:`workspaceId='default'` 有、`userId` 没有。于是无主早出不成立,
接着比 `session.userId === context.userId` = `undefined === 'local-user'` → false ——
**这条会话的每一条事件都被过滤掉**,而它自己的账本照写不误。

### 5.3 半个章从哪来:两个 `workspaceId` 撞在同一格

`packages/backend/rpc/domains/sessions.ts:222 / 247 / 268`:`sessions.create` 收下**请求里的**
`workspaceId`(renderer 的**空间**模型 —— 侧栏那个"默认空间"),用
`store.createSession(id, name, { workspaceId })` 盖到会话上。而服务端的归属模型
(`ownsSession` / `getRuntimeRequestContext` 的 `x-onething-workspace-id`)读的是**同一格**
字段,把它当"这条会话属于哪个 HTTP 主体作用域"。

**一个字段两种语义**:产品的"空间"与服务端的"租户"。产品路径盖空间不盖 userId,
判据却要求"要么两格全空、要么两格全对" —— 于是产品自己建的会话在自己的推送面上隐身。

### 5.4 影响面与修复方向(不施工)

- **web 泳道**:用 UI 建的会话(即真实用户的每一条会话)在 standalone server 上**收不到任何
  推送** —— 消息不上屏、流不动;RPC 读面照常,所以刷新页面能看到历史,像"实时挂了"。
- **B 批**(换管走同一条推送面)会**原样继承**这条:换的是词汇,过滤发生在词汇之前。
- **桌面**:desktop 走 IPCBridge 不走这段过滤,不受影响;桌面内嵌 HTTP 面则与 standalone
  同代码,受影响。
- **修复方向一句话**:单用户服务端上"没有 userId"就该判无主 —— 早出改成只看 userId
  (或逐格只比"有值的那格");更干净的是把**空间**从**归属**字段上拆开,别让产品概念写进
  安全判据。**这是安全相关的语义变更,属拍板范围。**

### 5.5 与第二节判定的关系

第二节那两条支架接错(store 环境变量取空、探针 `sendMessage` 签名用错)**都是真的**,
它们解释了"探针为什么收不到";但产品静默的真因是本节这条。**改判为:(a) 生产 web 泳道
在 standalone server 上确有缺陷**(用 UI 建的会话收不到推送),(c) 只覆盖探针那一半。

---

## 六、修复:空间与归属拆成两个字段(2026-08-28,opus 施工,未提交)

用户拍板:**不走"没有 userId 就判无主"的窄修,把两个语义拆开**。

### 6.1 拆法与理由

| | 字段 | 语义 | 谁读 |
|---|---|---|---|
| 保留原名 | `session.workspaceId` | **产品空间**(侧栏那个"默认空间") | `resolveSessionSpaceId` / `countSessionsInWorkspace` / 每 space 的凭证·设置·项目目录·usage 归因 / renderer `sessionBelongsToSpace` 与侧栏过滤 —— 勘察到 **17 处读者**,全是这个语义 |
| **新增** | `session.ownerUserId` / `session.ownerWorkspaceId` | **服务端租户**(HTTP 主体作用域,来自 `x-onething-*` 头) | `ownsSession` / `ownsSessionMeta`(`server/runtime.ts`)、`permission-grants` 域的同款判据 —— 勘察到 **2 处判据 + 5 处盖章**,全在服务端 |

**为什么不是反过来**(把产品空间改名 `spaceId`、`workspaceId` 留给租户):

1. **改动面**:产品语义有 17 处读者 + 5 层契约(`ChatSession` / `SessionMeta` /
   `CreateSessionOptions` / `SessionsCreateRequest` / `CoreSessionMeta`)+ 盘上每条会话的
   `meta.json`/`index.json`;租户语义只有服务端那一小片。**动少的那一半**。
2. **语义诚实**:`workspaceId` 这个名字是 workspace-spaces 方案给**空间**起的
   (`docs/design/workspace-spaces-2026-08.md` §批 B:「归属的 space,缺席 = default」),
   契约注释里写的也一直是空间。后来居上、借用这一格的是**服务端租户**,所以该改名的是它。
3. **存量数据不用动**:盘上会话的 `workspaceId` 存的本来就是空间 —— 保持原样即正确。
   租户两格对所有存量会话**缺席**,而缺席 = 无主 = 谁都读得到,**bug 自动消失,零迁移**。

### 6.2 落点

- `packages/backend/server/runtime.ts`:`ServerChatSession` / `ServerSessionIndexMeta` /
  `SessionWorkspaceRef` 加 `ownerUserId` / `ownerWorkspaceId`;新增 `sessionOwner()`(读租户,
  **故意不回落** `workspaceId`)与 `ownerMatchesContext()`(两格全空 = 无主;**缺席的一格不参与
  比较** —— 老会话只盖过 `userId` 的那种不该因为"没有租户作用域"就对所有人隐身);
  `ownsSession` / `ownsSessionMeta` 改用它们;5 处盖章(`stampOwner`、两个 store 的
  `createSession`/`createBranchSession`、三处 index meta `Object.assign`)改写 owner 两格,
  **不再覆盖 `session.workspaceId`**(从前 `stampOwner` 会把用户选的空间抹成租户默认值);
  `backfillSessionIndexOwnership` 改填 owner 两格,`SESSION_INDEX_OWNER_VERSION` 1 → **2**
  (版本一升,存量 index 里那些"空间被当成租户"的旧值全部重填清掉);
  `toSessionMeta` / `toChatSession` / `stripSessionOwnerFields` 补摘新字段。
- `packages/backend/rpc/domains/permission-grants.ts`:同款判据的**第二份拷贝**同步改
  (`listOwnedSessions`),否则 index 换了字段名它会把所有会话当无主 —— 这一格由
  `http.test.ts` 的 alice/bob 用例当场抓住。

### 6.3 两处**故意不动**(各是一次单独拍板)

1. **会话沙箱路径**`workspaceSandboxRootForSession` 仍按 `owner ?? 盘上原值` 取第二段 ——
   非 default 空间里建的会话,它的文件今天就住在 `owners/<uid>/<space>/`;改读租户格会让那些
   文件当场"消失"。本批**一个字节都不挪**,「空间该不该决定沙箱路径」留账待拍。
2. **服务端列表面仍然摘掉 `workspaceId`**(`stripSessionOwnerFields` / `toSessionMeta`)——
   它今天就没出过这道门;留下来等于让 web 端左栏突然开始按空间过滤会话(可感知的行为变化)。
   留账待拍。

### 6.4 验证

- **单元**:`session-scan.test.ts` 三只 —— 回填写的是 owner 两格且 `ownerVersion=2`;
  空间不被抄进租户格;**只带空间的会话事件照常上通配订阅**(这一只是本条 bug 的钉子);
  真租户章(`userId: 'u1'`)仍然拦得住默认上下文。`http.test.ts` 的 alice/bob 用例
  (跨租户看不到彼此的授权/会话)保持绿 —— 多租户隔离没有被这次放宽削弱。
- **真机支架**:同一条产品路径(浏览器点 New Chat → 输入 → 回车),裸 node SSE 客户端
  对那条会话的读数从 **0 帧** 变成 **10 条 `session:event` + 2 条 `session:stream`**;
  浏览器里消息实时上屏,chatStore 拿到 2 条。盘上 `meta.json` 是
  `{ workspaceId: 'default', ownerUserId: —, ownerWorkspaceId: — }`:空间照旧、租户无主、
  **没有任何数据被迁移**。

