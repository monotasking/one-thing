# 事件订阅的三件事:受众、范围、派生字段(2026-09-03)

来源:09-03 用户报障「React 壳发消息之后流式渲染整个应用卡死」。真机复现报告在会话
scratchpad `perf-repro-report.md`(隔离实例 + 假 provider + CDP trace + core `--cpu-prof`),
关键数字抄在 §1。本文只谈设计,不改代码;用户问的第二个问题「切会话之后原会话能否
继续收到流」在 §4 单独回答。

## 0. 一句话

今天每一条流式分片推出去之前,core 都要回答「这条连接能不能看这条会话」,而回答的方法是
**把整条会话重新组装一遍**。改法不是把这个问题问得更便宜,而是**不在每条分片上问**:
权限是订阅建立那一刻就定下的事实,交给一个随生命周期自维护的 `SessionAudience` 对象;
客户端「此刻想看哪条」是订阅的范围,写在订阅自己身上;`getSession` 顺手算的两个标量归
索引元数据,谁都不再为它付组装的钱。

## 1. 现状(已核对,HEAD 6d41923b)

### 1.1 线路

```
客户端(React 壳 / apps/web / mobile)
  一条 EventSource  GET /api/events            ← 不带 sessionId,即 `*`:所有会话
     ├─ session:event   (会话事件 + session:ledger-event 账本行)
     └─ session:stream  (16ms 合批之后的 text/reasoning/tool-input delta)
core(packages/backend/server/http.ts handleEvents)
  runtime.events.subscribe('*', handler, options, requestContext)     ← runtime.ts:2100
  runtime.streams.subscribe('*', handler, _, requestContext)          ← runtime.ts:2130
     每一条 envelope / payload:canReadSession(sessionId)
       → getSessionForContext → resolveSession → sessionStore.getSession
       → normalizeAppSession(runtime.ts:3134)
       → appSessionReads.listMessages(session.id)                     ← 全量物化
```

`normalizeAppSession` 只为了填 `messageCount` 与 `previewText` 两个标量,代价是整条会话的
`materializeChatMessages`:每个工具调用的参数/结果重新 `JSON.parse`(`parseJsonSafely`),
超 64KB 的正文从 `blobs/` 读回、解码、再哈希。

### 1.2 数字(真机,隔离实例)

| 读数 | 报障会话(26 条消息 / 29 工具调用 / 5.5MB 账本 / 9MB blobs) | 空会话 |
| --- | --- | --- |
| `sessions.get` RPC 往返(**不含** normalize,见下方更正) | 69ms(30 次中位) | 0.7ms |
| 一次回答 2690 个 delta 的 core 纯 CPU | 87–110s | ≈0 |
| SSE 订阅者 1 个 / 2 个 时的滞后 | 87s / 188s(线性乘数) | 5ms |
| React 壳自装 core 时 Electron 主进程 CPU | 117% | 16% |
| 渲染进程 inputDelay 最长 | 36s | 无 |
| core 进程 profile 里 `(idle)` | 0.9% | — |

被排除的嫌疑(都有数):探针 `describeTarget` 整段 26–44ms;shiki 147–330ms;markdown ≈100ms;
dev/built 渲染层自耗 3.3s/1.6s 但滞后不变;钉 Sessions 面板 + 400 会话无差别;
数据层整份重折 12ms、逐事件 0.1ms。

**更正(批 A 施工时核对,09-03)**:上表第一行那 69ms **不经过 `normalizeAppSession`**。
`probe-cost.mjs` 打的是 `sessions.get` 这条 RPC,而它的处理者
(`packages/backend/rpc/domains/sessions.ts:292`)用的是 `import * as store from '../../store.js'`
—— **app 仓库**,不是 server runtime 的 `sessionStore`;那 69ms 是仓库的物化视图
(`materializeMessagesFromProjection`)加上**整条会话(含全部消息体)经 HTTP 序列化**。
批 A 动不了它:改完实测 71.4ms → 72.8ms(同机同探针,噪声内)。它要另立一批治
(读面瘦身 / 分页,见 §7)。

真正被 `normalizeAppSession` 吃掉的是**订阅侧那条路**:`canReadSession` → `getSessionForContext`
→ `resolveSession` → `sessionStore.getSession` → `normalizeAppSession` → `listMessages`,
每条分片一次。它的代价用 `probe-lag.mjs` 量得出来(同机实测,批 A 前后):

| 读数(node 侧 SSE 哨兵滞后,大会话) | 批 A 前 | 只把 `covers` 换回旧写法 | 批 A 后 |
| --- | --- | --- | --- |
| 1 个订阅者 | 49 349ms | 73ms | 75–80ms |
| 2 个订阅者 | 109 204ms(1→2 = 2.2×) | — | 75–80ms(不再翻倍) |

中间那一列是关键:**收益几乎全部来自 §3.4 去物化**;§3.1 的受众对象贡献的是结构
(订阅者数不再是乘数)与 CPU(gate:perf 场景④实测 27% → 7–20%)。

### 1.3 客户端今天怎么切会话(`apps/desktop-react/src/data/chat-source.ts` `open`)

切走:`fold` / `water` / `tail` 全丢,退订再重订同一条 `*` 订阅,新会话经 `listRaw` 整份重折。
原会话的事件**仍然从线上来**(订阅是 `*`),只是 `onEvent` 第一行按 `sessionId` 丢掉。
`sessions-source` 用 MESSAGE_EVENTS 抬 `updatedAt`,`STREAM_COMPLETE` 作废章节缓存;
`meter-source` 只看当前会话。会话列表今天**没有**「正在跑」的指示。

### 1.4 gate:perf 为什么绿

场景③只注入一条**用户**消息,没有 assistant 流,也不是大会话 —— 场景没对上,不是门坏了。

## 2. 把一个问题拆成三个

今天 `canReadSession` 一句话里揉着三件不相干的事:

| 事 | 变化频率 | 谁说了算 | 今天在哪 |
| --- | --- | --- | --- |
| **受众**:这条连接能看哪些会话 | 订阅建立时定;之后只在会话创建/删除/改归属时变 | 请求上下文 × 会话归属(`ownerUserId` / `ownerWorkspaceId`,已在索引元数据里,`ownsSessionMeta` 现成) | 每条分片重算 |
| **范围**:这条连接此刻想收什么 | 用户切会话时变 | 客户端 | 没有这个概念:永远 `*` 全收,客户端自己丢 |
| **派生字段**:`messageCount` / `previewText` | 每条消息落账时变 | 写侧(`list-projection-backfill` E 批已挂上写侧) | `getSession` 顺手全量重算 |

拆开之后每件事都有自己的节拍,没有一件需要落在「每条分片」上。

## 3. 设计:三个对象

### 3.1 `SessionAudience` —— 受众,订阅建立时算一次,自己保持新鲜

```ts
// packages/backend/server/audience.ts(新)
interface SessionAudience {
  /** O(1),零 I/O,零解析。 */
  covers(sessionId: string): boolean
  /** 订阅关闭时调用;把自己挂在生命周期总线上的监听退掉。 */
  dispose(): void
}
```

两个实现,**由装配层按宿主选**,过滤代码不知道自己跑在哪:

- `OpenAudience`:`covers` 恒真。单用户宿主(React 壳自装 core、CLI daemon)用它。今天
  `ownsSession` 在 `userId` / `workspaceId` 两格都缺席时本来就返回 true(runtime.ts:405),
  这个实现只是把那条隐含规则说出口。
- `TenantAudience`:`covers(id)` 先查自己的备忘 `Map<id, boolean>`;没记过就从**会话索引**
  (`sessionStore.getSessionsList()`,内存里的元数据数组,不载消息体)按 `ownsSessionMeta(meta,
  context)` 判一次并记下。备忘的失效口是**store 的索引写点**,不是事件总线:
  `packages/backend/stores/sessions.ts` 的 `updateSessionsIndexMeta`(:135)是索引唯一的写口,
  在那里加一个 `onSessionIndexChanged(sessionId)` 监听端口,Audience 收到就删那一格备忘。
  **审查修正(09-03)**:初稿写的是「订阅总线上的 `session:created` / 归属变更事件」——
  核对 `packages/core/events/session-event-types.ts`,55 条里只有 `session:removed`,
  **没有** created、没有归属变更;靠总线维护集合会陈旧。索引写点则天然覆盖创建 / 删除 /
  改归属三种情况(它们都要写索引),所以真相源改成索引。今天 `findSessionIndexMeta`
  是对数组线性 `find`,批 A 顺带给索引配一张按 id 的 Map。

  **施工更正(09-03,批 A)**:上一段说的「`updateSessionsIndexMeta`(:135)是索引唯一的
  写口」不成立 —— `packages/backend/stores/sessions.ts` 里那个**私有**包装函数全仓零引用
  (死代码,与 `saveSessionToFile` / `loadSessionsIndex` / `saveSessionsIndex` 同批)。
  活着的写门是三个 + 一个整表口:

  | 写门 | 什么时候写 | 通知 |
  | --- | --- | --- |
  | `updateSessionsIndexMetaForCommands`(:905) | 命令面每次落账、E2 列表投影回填、server 的 `saveSessionMeta` | 带那条 id |
  | `patchSessionFields`(:177) | 会话级补丁 —— **归属盖章(`stampOwner` → `save`)走的就是它** | 带那条 id |
  | `deleteSession`(:523) | 删会话(含级联) | 每个被删的 id 各一条 |
  | `saveSessionsIndex`(:292) | 整份索引换掉 | **`undefined`** |

  于是端口签名是 `(sessionId: string | undefined) => void`,**`undefined` = 整份索引换掉了,
  听者整本备忘作废**。不用空串当哨兵:空串是一个合法但不存在的 id,`memo.delete("")`
  等于没失效(审查抓到的空操作)。仓库内部还有一批元数据变更(改名 / 置顶 / 归档 /
  换模型 / 换 agent)不发通知 —— 它们不动归属两格,备忘不受影响;索引那张按 id 的 Map
  另有 `index.json` 的 `mtime:size` 指纹自校验,所以它们照样看得到最新的表。

订阅点的改法(runtime.ts `eventsPort.subscribe` / `streamsPort.subscribe`):

```ts
const audience = audienceFor(context)          // 装配层注入的工厂
if (sessionId !== '*') {
  if (!audience.covers(sessionId)) { audience.dispose(); return () => {} }
  const off = eventBus.onAny(sessionId, handler, 'ServerRuntimeEvents')
  return () => { off(); audience.dispose() }
}
const off = eventBus.onAnySessionAny(envelope => {
  if (audience.covers(envelope.sessionId)) handler(envelope)
}, 'ServerRuntimeEvents')
return () => { off(); audience.dispose() }
```

`canReadSession` 那个闭包连同 `getSessionForContext` 在这条路上的调用一起删除。

### 3.2 订阅的范围写在订阅自己身上,不设服务端可变表

「此刻想看哪条」有两种做法:(甲)服务端为每条连接维护一张可变的关注表,客户端用一条
控制 RPC 改它;(乙)范围是订阅的**不可变属性**,写在 URL 里,改范围 = 换一条订阅。

**取乙。** 理由:甲要给 SSE 连接发身份、要一张连接 id → 关注表的注册表、要处理控制 RPC
与连接生命周期的竞态;乙什么都不用,`GET /api/events?sessionId=X` 今天就是一条按会话的
订阅(`sessionId !== '*'` 分支,带 `Last-Event-ID` 续传)。一个对象的范围从建立到销毁
不变,也是最好解释的语义。

于是客户端持有**两条**订阅:

| 订阅 | URL | 收什么 | 生命周期 |
| --- | --- | --- | --- |
| 前台 | `/api/events?sessionId=<当前会话>` | 这条会话的全部:会话事件 + 账本行 + 流分片 | 随当前会话换 |
| 全局 | `/api/events?level=summary` | 所有可见会话的**概要级**事件,不含账本行、不含流分片 | 随应用 |

`level` 是新参数;缺省 `full`,即今天的行为 —— apps/web(Vue,退役但仍能跑)与 mobile
一个字不改仍然全收。只有 React 壳改成双订阅。

### 3.3 事件自述层级,路由读表

「概要级包含哪些事件」不许写成路由里的一张字面量清单(那是按能力枚举)。事件类型的
唯一权威是 `packages/core/events/session-event-types.ts`(55 条);在它旁边加一张
`SESSION_EVENT_TIER: Record<SessionEventType, 'summary' | 'full'>`,shared 那边已有的
双向穷尽断言顺带保证多一条类型就必须填一格。今天判为 `summary` 的大致是:
`session:created/renamed/removed`、`message:*created`、`stream:start/complete/error/aborted`、
`run` 起止;`session:ledger-event` 与整条 `session:stream` 是 `full`。`handleEvents` 里的
过滤只读这张表。

### 3.4 `getSession` 不再物化

`normalizeAppSession`(runtime.ts:3134)只保留 `agentId` 缺省那一行;`messageCount` /
`previewText` 不再现算。它有四个调用点(`save`、`getSessionForContext` 盖租户章那支、
`getSession`、`saveSessionMeta`),意思是**每次保存会话元数据也在物化整条会话**。

**开工前那条核对的答案(09-03,批 A 施工时逐条查的)**:

1. **`messageCount` 在 app 写侧本来就在维护** —— 产地是 `session/commands.ts` 的
   `applyListProjection` → core 的 `applySessionListProjectionToMeta`,挂在
   `updateSessionsIndexMeta` 上跟着每次追加 / 截断 / 删除 / 整换走(E 批 f569aaf7)。
   所以 `normalizeAppSession` 里那一行**无条件重算**是纯冗余,而它就是全部代价。
2. **`previewText` 在 app 写侧没有产地**。命令面对它只有一处 **delete**
   (`replaceAll` 清空时);唯一会算它的纯函数 `extractSessionMeta`(core/session/store-helpers.ts)
   **全仓零生产调用点**。它今天只在 server 自己那条路上被算:`refreshSessionMeta`
   (无条件)与 `normalizeStoredServerSession`(缺席才算),而 React 壳的写路根本不经过
   它们。
3. **读方读的是索引元数据,不是 session 对象**:会话列表走 `getSessionsList()` → `index.json`,
   从来没经过 `normalizeAppSession`。消费点是 React 壳 `expose/projection.ts:144`
   (`meta.previewText ?? ''`)、Vue `SessionItem.vue` / `useSessionOrganizer.ts:509`、
   `apps/mobile/app/sessions.tsx`、`search/providers.ts`、`headless/cli-projections.ts`。
4. **真机实测(只读用户 store)**:`~/.onething/sessions/index.json` 460 条里
   **`previewText` 只有 6 条**,而 `lastMessagePreview` 424 条、`messageCount` 424 条。
   也就是说这一格**今天就已经是空的** —— 删掉 `normalizeAppSession` 里那两行是**零可感知
   变化**,不需要「在写侧补上」也不需要「读方改读 `lastMessagePreview`」:两边本来就没有
   各算一份,是一边有、一边空。

**`toSessionMeta`(runtime.ts:2742)改一处**(初稿写「不变」,施工时审查改的):`previewText`
从直给改成**条件展开**,与紧邻的 `lastMessagePreview` 同款写法(并把它从 `...meta` 里摘出来,
否则「键在、值是 undefined」那一档照样会被铺进投影)。理由:`normalizeAppSession` 不再兜底
重算之后,一条「索引里有 `previewText`、`meta.json` 里没有」的存量会话再存一次会被
`Object.assign` 洗成 undefined —— 会话卡上的预览那一行会空掉,**那是可感知的**。真机上这类
条目 6/460,数目小但没有理由让它坏。这是防御,不是行为改动。

### 3.5 切会话的次序规则:先拉账本,再带 `after=` 订阅

今天一条常驻 `*` 连接,切会话只换客户端过滤条件,「先订再拉」的次序天然成立。改成按会话
订阅之后,新连接握手是异步的,握手期间落账的行会漏。规则改成反过来:

1. `listRaw` 整份拉回,拿到账本的 `lastSeq`;
2. 开前台订阅 `GET /api/events?sessionId=X&after=<lastSeq>`。

这是安全的,因为**序号按会话**(`packages/core/events/event-bus.ts:45` 每会话一个计数器),
每会话环缓冲 1000 条,`?after=` 走 `eventBus.replay(sessionId, afterSeq+1)` 把握手窗口里的
行补回来;`feedLedger` 对 `seq <= lastSeq` 幂等、对缺号触发重折,两头都兜住。反证:去掉
`after=`,在 listRaw 与握手之间注入一条账本行,屏幕漏一行 → 红。
顺带一条改善:今天的 `*` 连接断线重连**没有**续传(`options` 只在非 `*` 分支生效),
靠缺号重折;按会话订阅之后 `Last-Event-ID` 真的能续。

### 3.6 客户端的订阅口要带范围(批 B 的漏项)

`platformApi.onSessionEvent` / `onSessionStream`(`packages/renderer/platform/web.ts:725`)
把路径写死为 `/api/events`,`sharedEventSources` 按路径去重。批 B 要让这一层接受范围:
`onSessionEvent(callback, { sessionId } | { level: 'summary' })`,路径不同就是不同的
EventSource。`resolveEventSourceUrl` 已经正确处理带 `?` 的路径(transport-config.ts:80)。
消费方各归各:`chat-source` 与 `meter-source` 走前台(`meter-source` 的失效判据读的是
账本行里的 `run/end`,它**不能**走概要),`sessions-source` 走概要。这层是 Vue 时代留下的
`packages/renderer/platform`,React 壳仍在 import,改它要同时跑 Vue 侧的既有用例。

### 3.7 连接内的派发管线

一条 SSE 连接 = `Audience ∩ Scope ∩ Tier → Coalescer → socket`。Coalescer(16ms 合批)不动。
三道过滤全是内存判断,连接建立之后这条管线上**没有任何一步读盘或解析 JSON**。

## 4. 切会话之后,原会话能否继续收到流

分三层答,每层的「是」是不同的东西:

**引擎层:能,而且从来不受订阅影响。** 一次 run 归引擎,不归任何连接。客户端切走、
甚至关掉窗口,run 照跑,每条 delta 照写进 `events.jsonl`(账本是唯一真相),core 照
广播。今天就是这样,本设计不碰。

**这个客户端的线上:降级到概要,不断。** 切走 = 关掉原会话那条前台订阅、开新会话的。
原会话对这个客户端只剩全局那条概要订阅:它还能收到原会话的 `run` 起止、`message
创建`、`stream:complete/error`,足够让会话列表把它标成「在跑 / 跑完了 / 出错了」并抬
`updatedAt`。它收不到的是逐字的分片 —— 这些分片没有人在看,发过来只是让 core 多做一份
序列化、让浏览器多丢一次。

**切回来:从账本起底,再接活流,缺口 ≤ 一条打包行。** `open(原会话)` 走今天那条路:
`listRaw` 整份重折(报障会话实测 12ms 折叠 + 20ms 解析)得到账本此刻的全貌,同时前台
订阅开起来,从此刻起的分片进 R2 水位表。账本里 `assistant/chunks` 是打包行,最近还没
打包的那一小截(≤2s)屏幕上要等下一条打包行到才补上 —— 这正是 R2「中途入场」那条
既有规则(`mergeWater` 的「账本比 parts 长的那截」),不是新缺口。

**否决的一条**:让后台会话在屏幕外「保持折叠热着」以求切回零缺口。那等于把「有几条会话
在跑」变成客户端内存与 CPU 的乘数,而账本重折只要几十毫秒。真相在账本,不在客户端的
副本里。

**顺带出现的一条可感知变化(待用户拍板,不在本设计里默认做)**:概要订阅里的 `run`
起止正好给 `sessions-source` 一个 `running` 集合,会话卡可以画「正在跑」。今天没有这个
指示;加不加是产品决定。

## 5. 陌生能力演练

- **新增一种会话事件类型**:在 `session-event-types.ts` 加一条 + 在层级表填一格。路由、
  过滤器、客户端零改动。
- **新增一种宿主**(比如多租户的托管 server):装配层多一个 `SessionAudience` 实现并注入
  工厂。`http.ts` / `runtime.ts` 的订阅代码零改动。
- **新增一个客户端**(mobile 想省流量):在 URL 上选 `level=summary` + 按会话订阅。
  服务端零改动。
- **新增一种归属规则**(比如共享会话):只改 `TenantAudience` 的建集合函数与它监听的
  生命周期事件。

四条都落在「能力自己的模块 + 一行注册」,骨架不动。

## 6. 分期

| 批 | 内容 | 可感知变化 | 验收 |
| --- | --- | --- | --- |
| **A 止血** | 3.1 `SessionAudience`(两实现 + 装配注入;索引配按 id 的 Map + `onSessionIndexChanged` 端口)+ 3.4 `getSession` 去物化(四个调用点一起);删 `canReadSession` 闭包 | 零 | 见下方「批 A 实际验收」 |
| **B 范围** | 3.2 `level` 参数 + 3.3 层级表 + React 壳双订阅(`chat-source` 前台按会话订、`sessions-source` / `meter-source` 走概要) | 零(概要级已覆盖列表今天用到的所有事件类型,要逐条对 MESSAGE_EVENTS 核) | 单元:层级表穷尽;真机:两条会话并发跑,只看其一,`read_network_requests` 数另一条的分片 = 0;切回原会话 ≤ 一条打包行内追平;apps/web 不带 `level` 时事件序列与今天逐字相同(gate-chat 已有夹具) |
| **C 指示** | 会话卡「正在跑」 | 有,待拍板 | — |

A 与 B 互相独立,A 先落(它一个人就把 §1.2 的数字打回空会话档)。

### 批 A 实际验收(09-03 落地)

**探针**(`probe-lag.mjs`,大会话,同机改前 / 改后):core 侧滞后 **49 349ms → 75–80ms**;
订阅者 1→2 **109 204ms → 75–80ms**(不再翻倍)。
`probe-cost.mjs` 那条「`sessions.get` ≤ 2ms」**取消** —— 它量的路不经过 `normalizeAppSession`
(§1.2 更正),批 A 动不了它;实测 71.4ms → 72.8ms,另立批治。

**`gate:perf` 场景④**(门自己**种**一条与报障同量级的会话:38 回合 / 账本 1263 行 / 5.1MB /
52 次工具调用、参数各 30KB;假 provider 吐 ~50KB 带 ```html 围栏的回答 + 2 次工具调用,
按 25 字 / 1ms 的密节拍吐 1032 块):

- **判据 = core 侧滞后 ≤ 1000ms ∧ core 进程 CPU 中位 < 40%**,两条都是断言。
  「core 侧滞后」是门内自开的一条 **node SSE 订阅**上哨兵到达的时刻减 provider 收尾的时刻
  —— 与壳那条订阅走同一台 core、同一条过滤链。
- **为什么不用「屏幕滞后」当判据**(初稿的写法):实测它对批 A 改没改**毫无反应**,量的是
  渲染层。轻档会话上「改前 861ms / 改后 750ms」,重档会话上「改前 3050ms / 改后 4316ms」
  —— 同一趟里渲染主线程单段任务能到 2–4.7s(shiki 把整段回答一遍遍重高亮),差全是渲染
  噪声。屏幕滞后照旧打印,只是不作判据;它该由渲染侧的批来治。
- **种子判据**从「≥3000 事件」改成「账本 ≥5MB ∧ 工具调用 ≥20」:`assistant/chunks` 是**按
  时间**打包的,一条流不管吐 77KB 还是 230KB 都落约 35 行/回合 —— 账本行数只能拿墙钟买
  (3000 行 ≈ 86 回合 ≈ 十分钟),而它不是代价来源(代价是**字节 × 消息条数 × 工具调用的
  JSON**)。种出来的现场在每条代价轴上都不比报障那条轻。
- 读数:core 侧滞后 **15–19ms**、core CPU 中位 **7–20%**(三趟)。

**反证**:**整批 A 回滚** → 场景④两条断言都红 —— `core 侧滞后 2571ms ≤ 1000ms` ✗、
`core 进程 CPU 中位 96% < 40%` ✗。
**只把 `covers` 换回 `canReadSession` 不红**(13ms / 27%):收益主要来自 §3.4 去物化,
§3.1 贡献的是结构(订阅者数不再是乘数)与 CPU(27% → 7–20%)。

**场景③的隔离**:场景①②③ 的基线是「这台 core 上没有可用 provider」。假 provider 一路开着
的话,③注入的用户消息会真的跑一轮(哪怕回空),会话列表因此多刷一次 401 张卡,稳定多出
一段 >33ms 的帧。所以门把 provider 的在场时间掐到最小:起 core 时开着(种大会话要用)→
种完、拉起应用**之前**经 `settings.saveSettings` 摘掉 → ①②③ 在无 provider 下跑 → ③ 跑完
再装回来 → ④。实测 ③ 回到 **0 段 >33ms**(最长任务 24ms,基线 31ms),④ 照常绿(目录键
变了,`saveSettings` 之后 provider 缓存自己重拉)。

## 7. 留账

- `ownsSession` 两格皆缺席即无主(runtime.ts:405)的语义原样搬进 `OpenAudience`;
  多租户 server 上「无主会话人人可见」这条本身对不对,不在本设计裁。
- 批 B 与批 A 的关系(审查结论):A 落地后,`*` 全收剩下的代价只是每连接一份序列化与
  客户端一次丢弃,桌面上量不出来;B 的收益在弱网 / 多会话并发(mobile、agent 网络)。
  **B 看 A 之后的数字再决定**,不与 A 同批派。
- 批 B 要动 `packages/renderer/platform/web.ts`(Vue 时代的传输层,React 壳仍 import),
  见 3.6;那一层的既有用例要一起跑。
- 一个客户端多窗口(每窗口一条前台订阅)是乙的自然结果,不需要额外设计;但 core 为每条
  前台订阅各跑一遍 Coalescer,窗口数是分片序列化的乘数 —— 与今天相同,不恶化。
- Vue 壳的 IPCBridge 不走这条路(已退役),不动。
- `Response.json.then 584ms`(用户日志,web.ts 的 fetch 包装)是另一条大响应,与本设计
  无关,待单独定位是哪条 RPC。
- **`sessions.get` 那 70ms 另立一批**(批 A 施工时定位,§1.2 更正):它是 app 仓库的物化视图
  加上整条会话(含全部消息体)经 HTTP 序列化,与订阅侧无关。治法在读面 —— 会话详情不该
  连着整份消息一起交出去,或者交出去之前先分页。批 A 没碰它,数字原样(71.4 → 72.8ms)。
- **场景③与场景④共用一台 core 的隔离方式是「掐 provider 的在场时间」**(§6),不是给场景③
  重定基线。它成立的前提是 `saveSettings` 在运行期真的会重拉 provider 目录 —— 实测成立。
  若将来那条重拉链改了,场景④会起不来(而不是悄悄用旧目录),那时这道隔离要换成
  「场景④单开一台 core」,但壳只能连一台,所以那等于把④拆成另一道门。
- **`TenantAudience` 的失效口今天是防御性的**:归属只在会话**创建**那一刻盖一次章
  (`stampOwner`),之后没有改归属的写路;新会话对备忘恒是一次未命中,所以不通知也判得对。
  端口留在正确的位置上,是为了将来真出现「共享会话」这类新归属规则时(§5 第四条)不用
  再找一遍失效点。
- **`findMeta` 在索引查无此条时回落到会话对象**(`resolveSession`):批 A 之前那把尺子问的是
  `getSessionForContext`(会话对象上的归属),而索引条目理论上可以还没写(存量盘、echo
  后端的工作集)。回落只在「备忘未命中 ∧ 索引查无此条」时跑,热路一步不多 —— 换来的是与
  批 A 之前**逐字同判**,而不是「大概一样」。
