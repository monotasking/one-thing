# 统一历史搜索 `history` —— 实施方案

状态：**已实施**（S1–S4 全部合入，2026-08-02；实测数字见 §8）
日期：2026-08-02
执行者：任何 AI / 工程师。**这份文档是自足的**——不需要读上下文对话，但需要按 §0 读三个前置文件。

---

## 0. 开工前必读

按顺序读完这三个文件的**文件头注释**（不用读实现），它们定义了本方案必须遵守的既有纪律：

1. `packages/onething-runtime/src/collab/classify.ts` —— 一条房间消息「算不算数」的唯一判据
2. `packages/onething-runtime/src/app/collab/history-tool.ts` —— 本方案的成品（它吸收并退役了 `room-history-tool.ts`，后者已删）
3. `packages/onething-runtime/src/collab/turn-log.ts` —— 「事件不是状态」这条纪律的由来

三条贯穿全文的硬纪律，违反了应当被打回：

- **一条规则只能有一份实现。** 该仓库曾因「这条消息算不算数」写了三遍、三份答案不一致，导致卡片流转记录「在投影里是事实、在摘要里不存在、在工具里查不到」。
- **面向模型的文本只陈述事实，不指挥。** 不写「记得去查历史」这类督促句（历史教训：措辞层的督促换来的是废话行为）。
- **静默截断是最脏的失败形态。** 任何上限、丢弃、降级都必须在输出里留下可见标记。

---

## 1. 背景（最小必要）

### 1.1 房与会话

- **房间(room)** = 群聊或私聊。私聊也是房：`kind:'room'` + `room.dm:true`；单成员 = 用户↔agent，双成员 = agent↔agent。
- 每间房有一份**权威转录**：`<store>/sessions/<roomId>/messages.jsonl`（JSONL，一行一条，按 seq 有序）。UI 读它。
- 每个 **(agent × 房)** 另有一条「执行会话」`agent-exec-<agentId>-<roomSessionId>`，存该 agent 在那间房的工作记录。
- 真机量级参考：一间群聊 350–500 条 / 200–350 KB；一条执行会话可达 368 KB。用户当前有 22 间房 / 1231 条消息。

### 1.2 事故与需求

2026-08-01：agent A 在群里用 `dm` 给四人私发狼人杀身份牌。之后在群回合里，
收件人被问「收到 dm 了吗」全部回答「没收到」——牌就躺在他们各自的私聊房里，
但**群回合读不到别的房**。

产品决定（已拍板）：

1. **取消默认隔离**。agent 对**自己在场**的所有房（群聊 + 私聊，含用户↔它的私聊）有统一的可检索历史。
2. **看不到别人之间的对话**（它不在场的房）。
3. 搜索**放在 Electron 主进程**，不引入 apps/server。

### 1.3 为什么"折叠/截断"这件事不在本方案里

该系统近期完成了一次重构：房回合的模型输入不再是「每轮重新投影」，而是
「房间新消息跟着一条 `drive` 消息写进执行会话」。**drive 是真实落盘消息，写进去就撤不回来。**

因此"保留多少给模型看"是**上下文层**的问题，与本方案无关。
**转录永远是完整的**——本方案只做在完整转录上的检索。

---

## 2. 要建什么

**一个工具 `history`**，让 agent 检索它在场的所有房的历史。
**`room_history` 退役并入**，不并存（两个历史工具 = 两套分页/上限/空结果语义/引用习惯）。

### 明确不做

| 不做 | 理由 |
| --- | --- |
| 给 agent `bash` 去 grep 转录文件 | 授权整个失效（同一棵树下有 `oauth-tokens.json`、别人的私聊）；读到的是内部 JSONL 格式，会把协调器的机械行当成有人说的话；成本不可控且工具结果永久累积 |
| 中文分词 / 倒排索引 | 见 §5.1。本期只做子串 + 范围兜底 |
| 通过 `store.getSession()` 读转录 | 见 §5.2。**必须直接读盘** |
| 跨到别人不在场的房 | 产品决定 2 |

---

## 3. 授权模型（本方案的核心，先实现它）

### 规则

```
visibleUntil(room, agentId) =
    room.memberAgentIds 含 agentId          → +∞         （当前成员，全部可见）
    room.formerMembers 里有 agentId         → 最后一次 removedAt
    都不在                                   → undefined  （从不可见）

可检索消息 = 我在场的房中，timestamp ≤ visibleUntil 的消息
```

一句话：**看得到「我最后一次在场那一刻」之前的一切，看不到之后的。**

- 当前成员 → 全部可见（**包括它入房之前的历史**，与现有"首轮把整段房历史交给它"的行为一致）
- 被移出的 → 只到移出那一刻
- 移出后又被拉回 → 它是当前成员 → 全部可见

### 为什么需要新字段

被移出这件事**已经**记在房间转录里（`collab-membership` 系统行，
`buildCollabMemberRemovedLine`），但那行**只有名字没有 agentId**：

```ts
buildCollabMemberRemovedLine(member: { name: string }) → "Bram 已被移出群聊"
```

按名字反查是被明令禁止的（W14a 把 @ 全部 id 化，正因为名字会改）。所以需要结构化数据。

---

## 4. 分期

四步，**每步独立可验收、可单独提交**。

### S1 · 授权数据与判据

**S1.1 类型** —— `packages/shared/ipc/chat.ts`，`RoomConfig`（约 140 行）新增：

```ts
  /**
   * 曾经在场、后来被移出的成员。授权判据用它回答「我能看到这间房到什么时候」
   * （docs/design/collab-history-search.md §3）。
   *
   * 只追加不删除；同一个 agentId 可能有多条（移出→拉回→再移出），读时取
   * **最后一条**。为什么不解析转录里那条 `collab-membership` 系统行：那行只有
   * 名字没有 id，而按名字匹配是被禁止的（改名即失效）。
   */
  formerMembers?: Array<{ agentId: string; removedAt: number }>
```

**S1.2 纯判据** —— 新文件 `packages/onething-runtime/src/collab/visibility.ts`：

```ts
/** 我在这间房能看到什么时候为止。`undefined` = 这间房对我不可见。 */
export function collabRoomVisibleUntil(
  room: { memberAgentIds?: readonly string[]; formerMembers?: readonly { agentId: string; removedAt: number }[] } | undefined,
  agentId: string | undefined,
): number | undefined
```

- 当前成员 → `Number.POSITIVE_INFINITY`
- `formerMembers` 命中 → 其中**最大**的 `removedAt`
- 否则 → `undefined`
- `agentId` 缺席 → `undefined`

从 `packages/onething-runtime/src/collab/index.ts` 导出。

**S1.3 写入点** —— `packages/onething-runtime/src/app/collab/coordinator.ts`，
成员变更那一段（搜 `if (membersChanged || pmChanged)`，约 440 行）：
在写 membership 系统行的**同一处**，对 `previousMembers` 中不在 `nextMembers` 里的每个 id
追加一条 `{ agentId, removedAt: Date.now() }`。与系统行同一个 if 分支，
**不要另起一个判断**（同一件事两处判定 = 迟早分家）。

**S1.4 验收** —— 新增 `packages/onething-runtime/src/collab/__tests__/visibility.test.ts`：

- 当前成员 → `Infinity`
- 被移出 → 那次的 `removedAt`
- 移出两次 → 取较晚的
- 移出后又加回（同时在 `memberAgentIds` 与 `formerMembers` 里）→ `Infinity`
- 从不在场 → `undefined`

外加一条 app 层集成：移出一个成员后，`room.formerMembers` 出现对应记录且 `removedAt` 合理。

---

### S2 · `history` 工具契约（纯层，无 I/O）

**新文件** `packages/onething-runtime/src/tools/builtin/history.ts`，
形状照抄 `packages/onething-runtime/src/tools/builtin/room-history.ts`
（`Tool.define` + `adapters` 注入，纯层不碰 store/fs）。

**参数**

| 参数 | 类型 | 说明（写给模型的描述照此展开） |
| --- | --- | --- |
| `q` | string? | 关键词。**纯子串、大小写不敏感、无分词**。传一两个词，不要整句 |
| `who` | string? | 谁说的：`名字#句柄` / 裸名字 / `用户` |
| `where` | string? | 哪间房：房名 / `名字#句柄`（= 我和 TA 的私聊）/ 不填 = 我在场的所有房 |
| `since` `until` | string? | `YYYY-MM-DD`（本地时区，与信封时间同口径） |
| `limit` | number? | ≤ `HISTORY_MAX_LIMIT`(30)，默认 10 |
| `cursor` | string? | 续查。**方向永远是往更早走** |

**结果**

```ts
export interface HistoryToolResult {
  ok: boolean
  /** 每条一行，已渲染好的 <say> 信封（含 room 属性）。 */
  entries?: { line: string }[]
  /** 命中总数（可能远大于返回条数）。 */
  total?: number
  nextCursor?: string
  /** 实际扫了几间房；被上限截掉的房数（>0 必须渲染出来）。 */
  scannedRooms?: number
  skippedRooms?: number
  /** 关键词没命中、退回"这个范围里最近 N 条"时为 true。 */
  fellBackToRange?: boolean
  /** 这个 agent 一间房都进不去。 */
  noRooms?: boolean
  error?: string
}
```

**空结果分五态**（照 `room-history.ts` 的三态写法扩展，每态都要指出下一步）：

1. `noRooms` → 「你还没有加入任何房间。」
2. `where` 解析不到 → 「没有这样一间房。」+ 列出**我能查的房名**（≤10）。
   *（同一句话覆盖"不存在"与"不是你的"——不给探测面。）*
3. 范围内一条消息都没有 → 「〈范围〉里没有任何消息。」
4. 范围里有消息但关键词没命中 → **不返回空**，走范围兜底（`fellBackToRange`），
   文案说明「没有匹配到关键词，以下是这个范围里最近的 N 条」。
5. 带游标翻到了尽头（`endOfRange`）→ 「已经翻到最早的一条了」+ 总数。
   *（「翻完了」与「从来没有过」共用一句话，等于让模型把一次成功的翻页读成否定答案。）*

**有结果时**必须渲染进 `output`：`scannedRooms`、`skippedRooms>0`、`fellBackToRange`、`nextCursor`。
`metadata` 是给 UI 的，**模型看不见它** —— 只进 metadata 等于没渲染。

**验收** —— 新增 `packages/onething-runtime/src/tools/__tests__/history.test.ts`（用 stub adapters）：
四种空结果文案两两不同；`skippedRooms>0` 时输出里出现该数字；
参数描述里必须出现「一两个词」与「更早」（防止后来者改坏）。

---

### S3 · app 接线：**直接读盘**

**新文件** `packages/onething-runtime/src/app/collab/history-tool.ts`。

**S3.1 候选房**（只读元数据，不 load 会话）

**先过场子门**（与 `dm` 同构，`app/collab/dm-tool.ts:52`）：`session.agentId` 必须存在，
**且** `session.kind` ∈ {room, agent, work}。只问 agentId 不够 —— 每条新建会话都被盖上
`agentId: 'default'`，而默认 agent 没有工具白名单（= 所有工具可见），网关按远端身份建的
会话正是这个形状。少了这道门，网关对面的陌生联系人能让主助理倒出用户与它的私聊全文。

```ts
store.getSessionsList()                       // SessionMeta[]，不含 messages
  .filter(m => m.kind === 'room')
  .map(m => ({ meta: m, until: collabRoomVisibleUntil(m.room, agentId) }))
  .filter(x => x.until !== undefined)
```

`where` 给定时在此集合内选中一间；选不中 → 空结果第 2 态。
`where` 是 `名字#句柄` 时用 `resolveDmTarget`（`app/collab/dm-target.ts`）解析成 agent，
再找双方都是成员的 dm 房——**不要另写一套人名解析**。

**S3.2 读盘（本方案最关键的一条）**

**不要用 `store.getSession()`。** 直接读
`path.join(getSessionsDir(), roomId, 'messages.jsonl')`
（`getSessionsDir` 来自 `app/stores/paths.ts`），用
`scanJsonlLog`（`packages/core/session/storage/jsonl/codec.ts`）解码。

理由见 §5.2（会话缓存只有 10 个槽，扫房会顶掉正在流式写入的会话）。

**范围优先**：先用 `since/until` 与 `where` 收窄候选，再读文件。
硬上限：`HISTORY_MAX_ROOMS`(10) 间、`HISTORY_MAX_BYTES`(8 MB) 总读入；
超出即停并置 `skippedRooms`。**`skippedRooms` 必须在扫描之后算**
（`ranged.length - scannedRooms`）：上限有两种，这个数就要覆盖两种，否则撞上字节
上限丢掉的房一个标记都不留。不变式：扫过的 + 报出没扫的 = 我能进的全部房数。

**S3.3 过滤**

按顺序：

1. `timestamp <= visibleUntil`（授权）
2. `isCollabRoomFact(message)`（`collab/classify.ts`）——drive、thinking record、
   运营系统行都不是聊天记录
3. `message.content` 非空
4. `since`/`until` 按天（`YYYY-MM-DD`，本地时区）
5. `who` —— 复用 `room-history-tool.ts` 现有的 `matchesMember`（连同它的系统行分支一起搬过来）
6. `q` —— 归一化（`trim().toLowerCase()`，`trim()` 已含全角空格）后子串匹配

**S3.4 渲染**

复用 `wrapCollabMessageEnvelope`（`collab/projection.ts`，标签是 **`say`**，
不是 `msg`），额外带 `room="房名"`。系统行署名 `COLLAB_SYSTEM_SPEAKER_LABEL`（「系统」）——
照搬 `room-history-tool.ts` 现有的 `renderLine` 分支，那里已经处理过。

**S3.5 游标：keyset 三元组 + 查询指纹**

```
cursor = "<timestamp>:<roomId>:<messageId>|<fingerprint>"
fingerprint = q/who/where/since/until 的稳定哈希
```

- 跨房时，信封时间精度到分钟，**单一时间戳不构成全序**——必须三元组。
- 指纹不符 → **拒绝并说明**，不要退回时间比较
  （`room-history-tool.ts` 现在会退回，那等于把另一个查询的续页当成这一个的）。
- 游标读不懂 → **同样拒绝**，不要静默当成第一页。
- 定位方式是「**找第一条严格更早的命中**」，不是「找到锚点那条再往后一格」：
  锚点所在的房随时可能被挤出扫描集（房数上限 10、真机 22 间房），按下标定位会返回
  一个空页，而空页读起来就是一个带确定性的否定。游标存的是**值**，不是下标。
- 翻页方向恒定：**更早**。

**S3.6 注册**

- `packages/onething-runtime/src/app/tools/builtin/index.ts`：`RoomHistoryTool` → `HistoryTool`
- `packages/onething-runtime/src/app/tools/builtin/headless.ts`：同上
- `packages/onething-runtime/src/collab/tool-surface.ts`：`COLLAB_ROOM_TOOLS` 里
  `'room_history'` → `'history'`

**S3.7 验收** —— 新增 `packages/onething-runtime/src/app/collab/__tests__/history-tool.test.ts`：

- 只返回我在场的房；别人之间的私聊一条都不返回
- 被移出的房只返回 `removedAt` 之前的
- `where` 传一个我不在的房 → 空结果第 2 态 + 房名清单里没有那间
- `who` 认名字、`名字#句柄`、「用户」、「系统」
- 关键词没命中 → `fellBackToRange` 为真且**有结果**
- 游标：翻两页无重叠、第二页严格更早；**换了过滤条件的游标被拒绝**
- 超过 `HISTORY_MAX_ROOMS` → `skippedRooms>0` 且渲染出来
- **drive / thinking record / 运营系统行不出现在结果里**

---

### S4 · 退役与顺带修

**S4.1 `room_history` 退役**——删除这些，并清理所有引用：

```
packages/onething-runtime/src/tools/builtin/room-history.ts
packages/onething-runtime/src/tools/__tests__/room-history.test.ts
packages/onething-runtime/src/app/collab/room-history-tool.ts
packages/onething-runtime/src/app/collab/__tests__/room-history-tool.test.ts
```

引用点（全清单，逐个改）：

```
packages/onething-runtime/src/app/tools/builtin/index.ts
packages/onething-runtime/src/app/tools/builtin/headless.ts
packages/onething-runtime/src/collab/tool-surface.ts
packages/onething-runtime/src/agents/__tests__/profile.test.ts
packages/onething-runtime/src/app/agents/__tests__/profile.test.ts
packages/onething-runtime/src/collab/__tests__/{agent-pair-dm,say,dm}.test.ts
packages/onething-runtime/src/collab/{digest,projection,history-window}.ts   ← 仅注释提及，一并更新
```

保留并搬进新工具的两件内脏：`matchesMember`、`renderLine`（含系统行分支）。

**S4.2 `now` 每回合冻结一次**

`packages/onething-runtime/src/app/collab/turn.ts` 里
`buildDriveRoomContext` / `buildDriveElsewhere` 目前各自 `Date.now()`。
同一个回合会多次重建 history，跨午夜时保留边界会在**同一个回合内**跳一天
（前缀全 miss，且模型第一遍读到的正文第二遍消失）。

改：该函数里已有 `driveStartTs`，把它作为 `now` 传下去，三处共用一个值。

**S4.3 验收**

- 全量 `npx vitest run` 绿
- `npx eslint` 对改动文件干净
- 全仓 `grep -rn "room_history"` 只剩历史文档

---

## 5. 已知陷阱（不读这一节大概率会踩）

### 5.1 中文子串匹配几乎必空——但**不要**上分词

`contains` 是纯子串，中文无分词。真机实测：

| 查询 | 命中 |
| --- | --- |
| `狼人` | 16 |
| `预言家` | 18 |
| `身份牌已私发四人`（模型爱这么传） | **0** |

**解法是范围兜底，不是分词**：关键词 0 命中时，**只放宽 `q` 这一维**
（`who`/`where`/`since` 全部保留），返回该范围内最近 N 条并明说。
理由：模型填错的几乎总是关键词，它填对的范围已经足够窄；
让一个坏关键词把一个好范围清零是最贵的失败。

不上分词的另外两个理由：几百条小语料上 OR 匹配过召回严重（「身份」会把
「确认一下你的身份」排到「身份牌」前面）；且 CLAUDE.md 明写跨会话搜索/索引
归 apps/server，不进 Electron 主进程。

> **2026-09-05 更正（检索重建 S3 / S5，`docs/design/search-index-2026-09.md`）**：
> 上面这两条理由**都已被推翻**，留在这里是因为它们仍然解释着 `history` 工具今天的形状。
> ① 「不进主进程」那条 CLAUDE.md 裁定 09-05 撤销（§12「拆掉的旧裁定」）：索引是账本的
> **投影**，引擎是内建 `node:sqlite`、句柄只活在 `worker_threads` 里；当年那条裁定的真
> 理由是 better-sqlite3 的 ABI 风险，不是「主进程不该有库」。② 「不要上分词」也被推翻：
> 今天**跨会话消息检索走的是索引**，分词由 core 的 TS 分析器做（二元 + AND 优先 + 短语
> 核验），`身份牌` / `私发` 这些双字三字词都命中 —— FTS5 只吃预切好的 token 串。
> **`history` 这只协作工具本身一行没改**：它仍然是 `contains` 纯子串 + 范围兜底，服务的
> 是「这一间房里最近发生了什么」；把它换到索引上是另一批。「同一句话在哪些会话里出现过」
> 今天该问 `search` 工具（同一份索引，`surface: 'agent-tool'`，见那份设计的 §14）。

### 5.2 会话缓存只有 10 个槽 —— 这是"必须直接读盘"的原因

```
packages/onething-runtime/src/sessions/session-repository.ts:148
  new LRUCache(options.cacheSize ?? 10)
```

一次跨房检索要读 5–20 间房（每间 200–350 KB），走 `store.getSession()` 会把整个
热集顶出去——**包括正在流式追加的那条执行会话**。该仓库 07-11 审计已记过一次
LRU 丢写事故。直接读盘完全绕开它。

### 5.3 工具结果会**永久**留在上下文里

该系统重构后，执行会话是一条普通聊天记录，模型读整份。因此工具结果不是
"这一轮用完就丢"，而是**永久累积**。所以：

- 上限必须硬（30 条 / 单条 300 字 / 总 8 KB）
- 每处截断必须可见
- 已经因此踩过一次坑：一个滚动快照被写了 47 次、同一事件最多 23 份副本

### 5.4 信封标签是 `say` 不是 `msg`

`COLLAB_ENVELOPE_TAG = 'say'`（`collab/projection.ts`）。
不要为搜索结果发明第三种标签——模型会因此学出两套引用习惯。

### 5.5 「今天的消息」并不总在折叠段里

旧的 `room_history` 只查"折叠段"，新工具**查整份转录**。
不要把那条规则搬过来：它会让同一句查询在两间房里表现不同
（取决于各自的折叠配置），而那正是现在要用三段文案去解释的东西。

---

## 6. 完成的定义

- [x] S1–S4 全部合入，`npx vitest run` 全绿（806 文件 / 6324 例）、`eslint` 干净、
      `tsc --noEmit` 无新错、`boundary:gate` 无新红（26 known，另有 2 条基线自愈）
- [x] 全仓 `grep -rn "room_history"` 只剩历史文档中的提及（源码里剩 5 处，全部是
      「前身/取代/退役」的叙述性注释，无一处是活的接线）
- [x] 真机走查：见 §8
- [x] 本文档状态行改成「已实施」并追加一节实测数字

---

## 7. 术语表

| 词 | 意思 |
| --- | --- |
| **房 / room** | 群聊或私聊，都是 `kind:'room'` 的会话。私聊多一个 `room.dm:true` |
| **转录 / transcript** | 一间房的消息记录文件 `sessions/<roomId>/messages.jsonl`，完整、永不删 |
| **执行会话** | `agent-exec-<agentId>-<roomId>`，某个 agent 在某间房的工作记录 |
| **drive** | 协调器写进执行会话、用来触发一个回合的合成 user 消息 |
| **信封** | `<say from="名字#句柄" time="…">正文</say>`，房间消息给模型看的形状 |
| **句柄 / handle** | agent id 的短形式，`名字#句柄` 是模型可用来点名/私聊的 token |

---

## 8. 实测数字（2026-08-02，真实 `~/.onething`）

走查方式：对真实存储只读跑 `searchCollabHistory`（真实 `messages.jsonl`、真实
`agents.json`、真实房元数据；不启动 Electron，不写任何文件）。查询者是 Iris
（`agent-eba0c4b7…`），也就是 07-28 那次「发完身份牌就读不回来」的当事人。

| 指标 | 值 |
| --- | --- |
| 扫到的房 | 5（cumo、Iris⇄用户、Bram ⇄ Iris、Atlas ⇄ Iris、Nova ⇄ Iris） |
| 因上限跳过 | 0 |
| 命中总数 | 450 |
| 本页返回 | 30（`limit` 上限） |
| 结果字符数 | 4,070（≈ 一次 drive 的 1/5） |
| 耗时 | 8 ms |

三条性质逐条核对：

**① 查得到自己的私聊。** `where:"Bram"` 只回 `Bram ⇄ Iris` 一间，第一条就是
当初那张牌：

```
<say room="Bram ⇄ Iris" from="Iris#eba0c4b7" time="2026-08-02 01:39">🃏 你的身份：**狼人** …</say>
```

原始事故（Iris 在群里说「我不知道每个人的身份牌了」）在这条路径上不再成立：
牌面躺在它自己的私聊房里，现在查得回来。

**② 查不到别人之间的私聊。** 该存储里有三间 Iris 不在场的双人私聊
（`Bram ⇄ Nova`、`Bram ⇄ Atlas`、`Nova ⇄ Atlas`）。不带 `where` 的全房检索里
一条都没有；显式 `where:"Bram ⇄ Nova"` 走「没有这样一间房」那一态，且附带的
可查房名清单里也没有它——**「不存在」与「不是你的」共用同一句话，不构成探测面**。

**③ 结果里没有 drive / 思考记录。** 30 行全部是 `<say room=…>` 开头，
无 `<turn agent=…>`。

同一份走查已折算成不依赖个人数据的固定用例，留在
`packages/onething-runtime/src/app/collab/__tests__/history-tool.test.ts`（17 例）。
