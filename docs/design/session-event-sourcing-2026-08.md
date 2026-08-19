# 会话事件溯源(E3 提前):事件日志唯一事实,消息是投影(2026-08-19)

> 起因:用户在日志梳理中问"能否更暴力一点,改为日志驱动"。
> 这就是 `dsh-architecture-adoption-2026-08.md` 里登记为"远期、单独拍板"的 **E3 消息即投影**。本文 = 评估 + 分期方案。
> **2026-08-19 已拍板:现在做,S 线取代 T 线;delta 不入账只记 part 收齐;老会话一次性批量迁移脚本**(拍板 4/5 按推荐:保留 `messages.jsonl` 名作快照;影子期 ≥3 天零 mismatch)。
> 与 `logging-system-2026-08.md` 的关系:那边的 L 线(诊断日志 Logger/sink/janitor)**不受影响、照做**;那边的 T0–T2(runId 缝合 + `io/` 正文账本)**被本文取代**——事件溯源之下追踪是构造出来的,不需要缝。

---

## 0. 一句话

**把 `sessions/<id>/events.jsonl` 从"信封账本"升格为"唯一事实":用户消息、模型每一轮的响应、工具调用/结果、编辑/删除/重发/压缩/换 agent……全部是 append-only 事件;`ChatMessage[]`(UI 看的)与"模型可见历史"(下一次请求发的)是同一份事件的两个纯函数投影;`messages.jsonl` 降为可删可重建的快照缓存。**

追踪能力因此不用"设计":某 session 某一轮 = 事件流的一个区间,agent/provider/model/请求配方/响应正文/工具/权限/错误/重试全在里面,按 seq 排好。

---

## 1. 现在的形状 vs 目标形状

```
现在                                          目标
┌ engine ─────────────┐                        ┌ engine ─────────────┐
│ 改 session.messages │──throttled save──▶     │ append(event)       │──▶ events.jsonl(唯一事实)
│ (steps/contentParts/│    messages.jsonl      │                     │        │
│  toolCalls/usage 双存)│                       └─────────────────────┘        │ project()
│ + recorder 旁路记账 │──▶ events.jsonl(信封)                        ┌───────┴────────┐
└─────────────────────┘                                            ▼                ▼
   history rebuild 从 messages 拼请求                       ChatMessage[](UI)   ModelHistory(下一次请求)
   compact 改写 messages,中间轮丢                          快照缓存 messages.jsonl   compact = 一条事件,
   trace 面板另读 events                                    (可删可重建)             投影时按区间折叠
```

三个"现在"的病在目标形状里**结构性消失**:
- `steps/toolCalls/contentParts` 双存(compact 回滚记忆里的老异味)——投影想输出什么形状就输出什么形状,存的只有事件;
- 历史重建 P0 "压缩吞本 run 中间轮工具上下文"(history-rebuild 记忆 5 问题)——`ModelHistory` 投影按 `session/compact` 事件的覆盖区间折叠,中间轮事件仍在;
- retry / edit-resend / steer 的"上一版"不可追——都是事件,旧的从不删。

---

## 2. 爆炸半径(实测)

| 面 | 数量 | 说明 |
|---|---|---|
| 消息写入 | 15 处调用 / 10 文件(`updateMessage/addMessage/deleteMessage/…`)+ 引擎流式路径(`message-helpers`、`stream-executor` 的 persist) | 全部改为 emit 事件 |
| `session.messages` 读 | 62 处 / 34 文件(collab/actors 7、engine/stream 3、triggers 2、usage/goals/tasks/plugins/permission 各 1…) | 读投影结果,签名不变(`session.messages` 变成 getter 返回缓存投影)→ **大多数零改动** |
| 会话元数据写 | ~20 个 `updateSession*`(agent/model/pin/archived/summary/tokenUsage/workdir…) | 分两类:属于会话事实的(agent/model/compact/workdir)进事件;纯 UI 偏好(pin/archived/summary)留 `meta.json` |
| 存储层 | `core/session/storage/jsonl/`(codec+pager,8 个导出)、`runtime/sessions/storage-driver.ts`(混合驱动)、`app/stores/sessions.ts`(LRU+300ms 节流) | pager 改读快照;驱动加"事件优先"模式;节流保存变成 append(同步、无节流) |
| renderer | `stores/chat.ts` 32 处 `.messages` | **不动**:主进程投影后照旧发 `ChatMessage`;renderer 直接消费事件是后话 |
| 历史 | 408 会话 / 345MB messages.jsonl(大头是 steps 里的工具结果) | 一次性批量脚本合成 `message/imported` 事件(拍板 3);原件留 `legacy-backup/` |
| collab / agents-v3 | 各有 `activity.jsonl` / `inbox.jsonl` / `scheduler-log-*.jsonl` | 不碰 |
| 测试 | session/engine/stores 相关 ~几百用例 | 主要靠"投影等价"金测兜底(见 §4) |

量级判断:与 toolkit 重建(R0–R4b)同级——核心 ~2–3k 行新代码,删的比加的多;**高风险点只有一个:每个会话都过它**。所以方案的骨架是"影子期 + 等价断言",不是"一刀切"。

---

## 3. 事件全集(草案)

在现有七类之上补齐为**完整**事实。仍守四铁律(只记时刻;执行前记账;记模型当时看到的世界;追加不截断)。

| 组 | 事件 | data(要点) |
|---|---|---|
| 会话 | `session/created` `session/agent-changed` `session/model-changed` `session/workdir-changed` `session/compacted` | compacted:`{summary, model}` + 顶层 `surfaceOp:{op:'replace',start,end}` + `sourceEventSeqs`(被遮蔽的全部 seq)——按 dsh surface 机制,见 §3.1 |
| 用户 | `user/message` `user/message-edited` `user/message-deleted` | 编辑/删除 = 新事件 + `surfaceOp: replace`(range 覆盖旧消息及其之后被截断的部分),旧的不动 |
| 执行 | `run/start` `run/end` | `{runId, kind: send/retry/edit-resend/resume/steer/follow-up, agentId, triggerSeq, outcome, error?}` |
| 请求 | `request/tools`(已有) `request/header`(已有) `request/start`(已有) `request/recipe` **新** `assistant/first-token`(已有) `request/response` **新** `request/error` **新** `request/end`(已有) | recipe:`{systemPromptHash→blob, toolsHash, messages:[{seq, contentHash}], params}`;response:**完整响应正文**(text/reasoning/toolCalls/usage/finish/providerResponseId/responseModel) |
| 助手 | `assistant/chunks` **新**(打包行)+ `assistant/part-end` **新** | **2026-08-19 拍板 2 改为③存 delta**:内存攒批,2s / 64 条 / part 边界 / 请求结束先到者触发落一条打包行 `{runId, requestIndex, partIndex, kind: text/reasoning/tool-input, time0, dt:[…相对毫秒], text:[…逐条 delta 原文]}`——每条 delta 的内容与到达时刻无损保留(dsh ChunkRow 同款,~50×);part 收齐记**不带正文**的 `assistant/part-end {partIndex, kind, len, hash}`;图片 part 走 blob 引用。正文唯一来源 = delta fold,`request/response` 只带 finish/usage/ids + 各 part hash,不再存第二份文本。估算 ~3KB/次响应(13k 次 ≈ 40MB)。崩溃丢 ≤ 最后一批(≤2s),checkpoint 需求被覆盖 |
| 工具 | `tool/call` `tool/result` `tool/audit`(已有,result 改存全文而非 500 字预览,大结果走 blob) | |
| 权限/交互 | `permission/asked` `permission/answered` `interaction/asked` `interaction/answered` | 时刻+决定;卡片状态是投影 |
| 附件/引用 | `attachment/added` `message/reaction` `message/reply-to` | collab 用 |
| 系统 | `context/turn-update`(`turnContext` 的 set/removed 从消息字段变事件) `plugin/status` | |
| 导入 | `message/imported` | 老会话惰性迁移用:一条老消息一个事件,原样带全部字段 |

正文去重:`blobs/<sha256-16>`(system prompt、超 64KB 的工具结果);事件里存 hash。响应正文直接在事件里(实测 ~0.6KB/次)。

### 3.1 与 deepseek-harness 的对照(2026-08-19 读原文后修订)

原文:`~/data/code/deepseek-harness/.agents/notes/implemented/architecture/{2026-06-11-event-sourced-sessions, 2026-06-14-session-persistence, 2026-06-18-session-surface, 2026-07-19-zstandard-jsonl-session-logs, 2026-07-21-semantic-session-checkpoints}.zh.md`。

| 维度 | dsh | 本文 | 处置 |
|---|---|---|---|
| 状态来源 | `Session` = append-only `SessionEvent[]`,`deriveMessages()` 每次派生;**没有持久快照** | **改拍:同样无快照**(拍板 6) | 分岔只剩分页:dsh 不按消息分页,我们在事件流上做倒读分页(§3.2) |
| 模型可见历史 | **surface**:事件顶层字段 `surfaceOp: 'append' \| {op:'replace',start,end}` + `sourceEventSeqs[]`;`SurfaceManager` 增量维护有序 seq 数组;compact/剪枝 = 追加带 replace 的新事件,被遮蔽事件留在日志不在 surface | 原稿:`session/compacted {coversSeqFrom,To}` 由投影折叠 | **采纳 dsh**:`surfaceOp`+`sourceEventSeqs` 是一个机制同时表达 compact / edit-resend / regenerate / delete / tool-result 剪枝,且回放可校验替换范围是否列全;`projectModelHistory` 走 surface。§3 表里的 `session/compacted`、`user/message-edited|deleted` 语义改为"新事件 + replace op" |
| 流式 delta | 全记(`assistant/chunk` 无损),因 `events[i].seq===i` 连续契约;存储打包 ChunkRow ~56× + zstd | **改拍:全记 + 打包**(`assistant/chunks` 一行一批) | 差别:dsh 打包行在逻辑层展开为 N 个事件(要 seq===index);我们一行就是一个事件,delta 身份 = (eventSeq, index),不需要展开 |
| 刷盘 | append 同步;持久化缓冲在**语义检查点**排空(调模型前 / 调工具前 / step 结束 / turn 结束);每批一帧,fsync+原子发布 | 未细化 | **采纳**语义检查点取代 300ms 节流(S1) |
| 崩溃 | 永不截断;冷加载合成 error `tool/result` + `step/end` + `turn/end{interrupted}`,修复只提交一次;末条撕裂丢弃,更早 seq 断裂=损坏拒载 | 只有"半行丢弃" | **采纳**合成收尾事件(S2 `prepare` 阶段) |
| 元数据 | 日志外 `SessionHeader`(version/cwd/lineage);"元数据不是可回放状态" | `meta.json` 留 UI 偏好;agent/model/workdir 进事件 | 一致;workdir 影响模型看到的世界(system 变量),进事件 |
| 后端 | JSONL(+zstd)与 SQLite 跑同一份 persistence contract 测试 | 只 jsonl | 不做双后端;但 S0 金测写成**对任意 store 可跑的合同**(形态照抄) |
| 大会话 | large-session restore pipeline(协作让出、增量扫描)+ `prepare` 阶段 | 快照 + pager | 分岔点,见第一行 |
| UI | chat 与 trajectory 是同一事件窗口两次装配 | renderer 仍收 ChatMessage | 不改(§6) |


### 3.2 读路径:没有快照,分页直接建在事件日志上(2026-08-19 拍板 6 = 无快照)

拍板:**不留任何内容快照**。`messages.jsonl` 在迁移后退役(原件进 `legacy-backup/`);唯一持久物 = `events.jsonl` + `blobs/`。理由:快照只买读性能,代价是双份内容 + 一致性工程(审查 B6/M2);而我们的读负载是"分页看尾部",可以直接在事件流上做。

两种读者,两条路:

| 读者 | 需要什么 | 怎么读 |
|---|---|---|
| **引擎激活会话**(下一次请求要 ModelHistory、`session.messages` 的 47 个文件读者) | surface 上全部可见消息 | 顺序读整份 events.jsonl 一次 → fold 成内存投影(与今天 `loadJsonl` 全量读 messages.jsonl 同一成本类;事件文件 ≈ 今天 messages + delta 打包 ~10–20%);被 `surfaceOp replace` 遮蔽的区间解析后丢弃。LRU 缓存同今天 |
| **UI 分页**(首屏尾部 N 条、向上翻页、跳到某条) | 一页消息 | **倒读**:从文件末尾按 chunk 向前读(今天 `collectTailMessages` 已是这个做法,只是读的是 messages.jsonl),逐行解析、按 surface 规则 fold,攒够 N 条消息边界即停。因为 replace 事件一定晚于它遮蔽的事件,倒读先遇到 replace、后遇到被遮蔽者,可以直接跳过,不需要先看全文件 |

**游标**:`{eventSeq, fileOffset}`——"再往上翻"从上次停下的偏移继续倒读,无需任何索引;`hasMoreBefore = offset > headerEnd`。**跳到某条**(搜索命中、TOC、trace 跳转)需要 seq→offset:首次跳转时正向扫一遍建**内存**索引(每会话一次,不落盘),之后 O(1)。不做持久索引文件——那就是快照的影子;若实测大会话跳转慢再议。

**`ChatMessage.seq` 退役**:UI 坐标改用 `eventSeq`(消息的 `user/message` / 首个 `assistant/chunks` 事件 seq),身份稳定、删一条不平移,审查 M6 的 cursor 漂移问题随之消失。`pagination.ts` 的 `totalCount/hasMoreAfter` 语义重写为基于 seq。

**活跃流**:正在生成的助手消息住在引擎内存投影的尾部(增量 reducer:每追加一个事件只 patch 最后一条);renderer 照旧收 stream chunk + `ChatMessage`,不变。

**旁路读者**(toc `segments.jsonl`、全文搜索、usage、启动 sanitize、collab 7 处):一律走 P0 的读门面 `sessionRead.messages(sessionId)` / `sessionRead.page(...)`,不再碰文件——这是 P0 必须包含"读门面"的原因。

**格式判定**:`storage-driver.ts:144 jsonlExists` 改为认 `events.jsonl`(审查 B4);会话创建 = 事件层建目录并写 `session/created`,鸡生蛋消失。

**退役**:`sessions:rebuild`(没有快照可重建)→ 改为 `sessions:verify <id>`(全量 fold + surface 校验 + seq 连续性 + blob 引用完整性)。

**门(S2)**:48MB 级真机会话,首屏(尾 40 条)≤ 今天的 ±10%;"向上翻一页" p95 ≤ 50ms;引擎激活全量 fold 耗时与今天 `loadJsonl` 同量级(记录数字);跳转冷建索引一次的耗时记录在案。


两个投影(core 纯函数,`packages/core/session/projection/`):
- `projectChatMessages(events, {upToSeq?}) → ChatMessage[]`(UI 形状,含 steps/contentParts 等**派生**字段);
- `projectModelHistory(events, {upToSeq}) → ProviderMessage[]`(下一次请求用;**走 surface**——由 `surfaceOp` 增量维护的有序 seq 数组,compact/edit/剪枝都是 replace;供 history-rebuild 用,取代今天从 messages 拼)。

每个事件两个可选顶层字段(与 seq/time 同级,dsh 原样):`surfaceOp?: 'append' | {op:'replace', start, end}`、`sourceEventSeqs?: number[]`。非 surface 事件(request/*、tool/audit、run/*、permission/*)不带。

~~快照~~ **拍板 6(2026-08-19):无快照**,见 §3.2。`messages.jsonl` 迁移后退役。

---

## 4. 分期与门(代理可自证)

| 期 | 名 | 交付 | 门 |
|---|---|---|---|
| **S0** | 事件全集 + 投影 | core:事件类型 + codec 扩展(老 7 类不变)+ `projectChatMessages` + `projectModelHistory` + `synthesizeEventsFromMessages`(老会话→事件) | **金测**:对真机抽样 50 个会话,`projectChatMessages(synthesize(messages))` 与原 messages **深相等**(忽略派生字段的顺序);history-rebuild 现有测试用 `projectModelHistory` 重跑全绿 |
| **S1** | 影子写 | 引擎每处消息变更同时 emit 事件(旧写路径不动);flush 改语义检查点(调模型前/调工具前/响应收齐/run 结束),不再 300ms 节流;每次 persist 后断言 `project(events) ≡ messages`,不等则写 `session/shadow-mismatch` 诊断日志(带 diff 摘要);`run/start|end`、`request/recipe|response|error`、`assistant/part` 采集点接上 | 影子期跑真机 ≥ N 天:`app.jsonl` 中 `shadow-mismatch` 计数 = 0;`bun run sessions:shadow-report` 输出各会话事件数/快照差 |
| **S2** | 读切换 | `session.messages` getter 改返回投影缓存;`prepare` 阶段对未闭合 run 合成收尾事件(aborted tool/result + run/end{interrupted}),只提交一次;pager 读快照+尾重放;`scripts/migrate-sessions-events.mjs` 批量迁移 + 启动 marker 守卫;`ModelHistory` 投影接入 agent-loop 的 history builder;compact 改为事件 | 现有 session/engine/compact 测试全绿(不改断言);真机脚本:打开 top-20 大会话,首屏耗时不劣于现状 ±10%(有分页 bug 记忆里的量法) |
| **S3** | 写切换 + 删旧 | 旧 `updateMessage/…` 写路径删除,只剩 append;`steps/toolCalls` 双存从存储消失(投影仍产出);`app/engine/stream/session-event-recorder.ts` 并入引擎主路径(不再是旁路);轨迹面板/`trace` CLI/`GET /api/sessions/:id/trace` 直接读事件 | `log:gate` 同款棘轮:仓内 `messages.push/splice/= ` 为 0;删快照后 `sessions:rebuild` 逐字节复原;真机 shadow 数据对比 |
| **S4** | 收尾 | 老 `provider-requests` dump 迁到 `request/recipe`+诊断模式 `dumps/`;`last-system-prompt` 删;文档;`legacy-backup/` 策略 | 存储对比脚本(§2.7.4 那套):默认态体积 |

S0 可立即开(纯函数,零风险);S1 影子期是**唯一的时间成本**(建议 3–5 天真机)。整体与 L 线并行:L 线管 warn/error/perf 怎么写、写到哪;S 线管会话事实。

---

## 5. 待拍板

| # | 问题 | 选项(推荐加粗) |
|---|---|---|
| **1** | 现在做 E3,还是先做 L0/L1 + T 线缝合 | ①**现在做,S 线取代 T 线**(缝合是过渡品,做了要拆)②先 T 线快速拿到追踪,E3 排后 |
| **2** | 流式 delta 入不入账 | ①只记 part 收齐(审查 M1:今天只丢 ≤300ms,part-only 是量级退化,且"今天也只是尽力而为"的论证错了)②part + 2s/4KB checkpoint ③**全 delta 打包(2026-08-19 用户改拍此项)**:一 delta 一行会炸,必须打包(见 §3 助手行);换来 token 级回放与 TTFT/tps 派生,响应正文只存一份 |
| **3** | 老会话 | ①惰性导入为 `message/imported` ②只读兼容模式 ③**一次性批量迁移脚本(已拍板)**:`scripts/migrate-sessions-events.mjs`,原 messages.jsonl 就地作首个快照、原件备份到 `legacy-backup/`;启动期加一道**一次性**守卫——发现未迁移会话就地用同一转换器补跑并记 warn(不做常驻惰性路径;注意 startup-perf 记忆:不要在启动时全量读 302MB,守卫只查 marker 文件) |
| **4** | 快照文件 | ~~①保留 `messages.jsonl` 作快照 ②改名~~ **被拍板 6 取代:无快照**(审查证明①的"pager 零改"不成立,B3) |
| **5** | 影子期长度 | ①**≥3 天真机零 mismatch**②一周③跑一次金测就切 |

## 6. 明确不做(审查后仍成立)

- renderer 不改成直接消费事件(仍收 `ChatMessage`);"chat 与 trajectory 是同一事件窗口的两次装配"留到 renderer 有需要时。
- collab / agents-v3 自己的账本不并入。
- 不引事件存储库/数据库;仍是 per-session jsonl + blobs。
- L 线诊断日志不承载会话事实——`Logger` 是给人排障的,事件是给系统当真相的,两者的 sessionId/runId 字段相同以便 join,但不合并。


---

## 7. 审查记录(2026-08-19,两路对抗审查 + 自审)—— **按现稿否决,需修订后再开工**

两路独立审查(A:对照真实代码反驳;B:运维/存储/迁移/流程风险)都给出 reject-as-written。合并去重后按严重度:

### 7.1 Blocker(任一不解决,S1 之后无路可走)

| # | 问题 | 证据 | 对方案的影响 |
|---|---|---|---|
| B1 | **"`session.messages` 改 getter、多数读零改动"前提不成立** | 6 处整体赋值(`core/session/store-helpers.ts:1149,1187`、`app/stores/sessions.ts:740`、`apps/server/src/runtime.ts:4937,5733,5989`)在 strict mode 下对 getter 赋值直接 `TypeError`;`store-helpers.ts:1493 Object.assign(message, patch)` 是 22 个 `updateMessage*` 的唯一落点,改的是缓存对象、事件无记录、**影子期比不出(比的是同一份内存)、快照重建时静默回滚**;实测 mutator **156 处/33 文件**(doc 写 15/10),`.messages` 引用 **155 处/47 文件**(doc 写 62/34) | §2 爆炸半径低估一个量级;必须先有"单一写路径"(见 §8 P0) |
| B2 | **`apps/server` 完全绕过事件账本** | server 6 处独立写消息 + `persistSession`(`runtime.ts:2723,2743,2759,4937,4967,5114,5127`);`appendSessionEvent` 在 `apps/server` 0 命中;`StoreLock` 保证的是"同一时刻一个宿主",用户 desktop/server 交替使用时"按事件投影"会**丢掉 server 期间全部消息** | 宿主这一行在 §2 表里根本没有;同样是 P0 的理由 |
| B3 | **pager "零改"是错的,失败模式是静默丢消息** | `core/session/storage/pagination.ts:76 hasMoreAfter = last.seq < totalCount`,而 `storage-driver.ts:359/376` 的 `totalCount` 只数快照 → 快照落后时 renderer 认为到底,事件尾永远加载不出;`getJsonlUserMessageMarkers` 同病 | 拍板 4 的支点失效;`JsonlLogPageSource` 的 totalCount/readRange/resolveAnchorSeq 必须改成"快照 ∪ 事件尾"合成源 |
| B4 | **鸡生蛋 + "快照可删"等于删会话** | `app/session/event-log.ts:74-76` 只对已存在目录 append,:54-64 明令禁止 event-log mkdir(理由:`storage-driver.ts:144 jsonlExists` 会把 legacy 会话误判 → "整份历史当场消失");`jsonlExists` 不看 `events.jsonl`,删掉快照后 `format()` 判成 legacy,`getMessagesPage`/`loadJsonl` 返回 undefined | 会话创建必须先写 `session/created` 并由事件层建目录;`jsonlExists`/格式判定要认 events.jsonl;"丢第一条用户消息"的 300ms 窗口在唯一事实下不可接受 |
| B5 | **旁路账本纪律与唯一事实互斥,doc 没翻** | `event-log.ts:10-12,116-120,144-152`:fire-and-forget、写失败 warnOnce 吞掉、无 fsync、`!enabled` 静默丢;dsh 是"检查点 fsync + 原子发布" | 事件成为事实后:写失败必须上抛 + UI 提示;检查点 fsync;seq 分配要跨进程安全(`event-log.ts:43 states` 是进程内 Map,`:139 lastSeq+1`,第二写者即重复 seq,而 `surfaceOp replace` 按 seq 区间遮蔽 → 静默错乱) |
| B6 | **快照/事件一致性无不变量、无唯一写者、无原子写** | 快照 header `{t:'h',v:2}` 无处放 `snapshotSeq`(`codec.ts:17`);引擎 persist / 后台 rebuild / `sessions:rebuild` 三个写者未互斥;`writeSuffix` 是就地 truncate+write 非原子;崩溃序"快照已更新但 events 尾撕裂"→ 快照超前于事实,无处置 | header v3 加 `snapshotSeq`;唯一写者 = per-session 串行队列;打开时断言 `snapshotSeq ≤ lastSeq` 否则弃快照全量重放 |
| B7 | **影子期门不可脚本化,S0 金测恒真** | "mismatch"未定义(isStreaming/thinkingTime/timestamp/usage 累计/steps 顺序必不等);每次 persist 深比较 400 消息 = 自造性能事故;"≥3 天真机"是人肉门;S0 的 `project(synthesize(messages))≡messages` 因 `message/imported` 原样带字段而恒成立,证不了细粒度事件→消息的投影 | 定义 `canonicalChatMessage()`;比较只在检查点、只比最后一个 run;门改按量(`runs ≥ 200 且 mismatch = 0`);S0 金测改为"新产生会话的细粒度事件投影 ≡ 引擎写出的消息"(只能在 S1 验) |
| B8 | **迁移输入集合与回滚未定义** | 未覆盖 `segments.jsonl`(66)、`messages.cleared-*.jsonl`(~90)、`agent-dm-*` 非 uuid 会话、1 个 `sessions/<id>.json`、`legacy-backup/` 276MB、`onething.sqlite` 同步副本、meta.json 字段合成事件的假时间戳;"就地作快照"与"备份到 legacy-backup"矛盾;无 `StoreLock` 检查;影子期 events 与迁移出的 `message/imported` 的 seq 对齐未写;无 `sessions:rollback` | 脚本需白名单 + 未知文件清单 + lock owner `migrate` + dry-run + 重编号 + 回滚命令 |

### 7.2 Major

| # | 问题 | 证据 |
|---|---|---|
| M1 | **"不记 delta"的退化被低估,拍板 2 的依据错了** | 今天 `core/engine/stream-processor.ts:410` 每 token 更新 → 300ms 节流 → `writeSuffix`,**崩溃只丢 ≤300ms**;part-only 丢整个未收齐 part(可以是几千 token);而选项② checkpoint 的"+10% 体积"在响应实测 0.6KB 下近似为零 → **建议重开拍板 2** |
| M2 | **存储账方向反了** | `tool/result` 改存全文(今天 500 字预览)→ events.jsonl ≥345MB;叠加保留的快照 345MB ≈ **700MB**(B 审查用 7f0ab096 推演 1.6×、08f1fe09 1.5×,全库 550–600MB);doc 只给了 io/ 的 55MB;三处重复:`assistant/part.content` ≡ `request/response.text`、`tool/result` 全文 ≡ 快照 `steps[].result`、`tool/call` args 三存;工具结果进 blobs 后 blobs 成为"唯一不可删却最大"的一类,20MiB 上限失效;events/blobs 无上限无 gzip |
| M3 | **事件全集覆盖不全** | 无来源:`isStreaming`(恢复路径 `sessions/stream-abort.ts:139`、`history.ts:706,751`、`context-compact.ts:400` 都靠它,老会话 `message/imported` 无 `run/*` → 恢复分支永不触发)、`summary/summaryUpToMessageId`(doc §2 说是 UI 偏好,实为 compact 切点 `history.ts:679`)、compact 三态(`context-compact.ts:100/158/189/214`)、启动期 sanitize 改写卡死 compact(`timeline.ts:315-330`)、collab `MESSAGES_REPLACED` 全清(`room-config.ts:221`)、图片生成状态机(`media/image-generation.ts` 6 处)、`tool-call-state.ts`、system marker 按内容查删(`sessions/system-messages.ts:31-55`)、`thinkingTime/skillUsed/errorDetails/steered/source/voice/collabChainReset/origin/mentions` 等 ~15 字段、瞬态 part(`chat.ts:97/115/126` 追加即撤,append-only 表达不了)、附件内联 base64(`chat.ts:178`,>1MB 进事件行不可) |
| M4 | **`turnContext` 的同步幂等闸** | `app/engine/prompt/session-turn-context.ts:16-21,82,98,103`:同步 `attach()`,幂等靠消息字段 + 进程内集合;改事件后判据要么仍读消息字段(没改成事件)要么扫事件尾(文件 IO 破坏同步契约) |
| M5 | **`projectModelHistory` 签名不足** | 今天 `buildHistoryMessages(messages, session)` 需要 `summary/summaryUpToMessageId/kind/agentId/name/room.*/collab.*`;投影是 `(events, sessionMeta) → history`;collab 5 类消息语义(`message-helpers.ts:198+`)在事件 role 里没有 |
| M6 | **seq 撞名且坐标系相反** | `ChatMessage.seq` 是位置(行号,删一条全平移,`pagination.ts:72`),事件 seq 是身份;`request/recipe.messages[].seq` 与 `surfaceOp.start/end` 同名异义;pager cursor 编码消息 seq(`pager.ts:49`),快照重建后 cursor 静默指错 |
| M7 | **性能未量化** | 同步 append 在 Electron 主线程(今天是 promise 链 + 300ms 节流;tool/result 最大 392KB,透明窗丢帧记忆);getter 全量投影 5k 事件/48MB 秒级,缓存失效/增量 reducer 未定义;`event-log.ts:85,176-187` 同步全文件读(今天 0.95MB 无所谓,唯一事实后几十 MB 卡事件循环);">200 事件触发 rebuild"按事件数计,一轮 30 工具 ≈ 200+ 事件,**单轮内触发** |
| M8 | **门与依赖缺口** | S3 棘轮正则 `messages.push/splice/=` 命中 `message-queue.ts`、`room-rules.ts effects.messages`、provider `body.messages` 等无关代码,且 `log:gate` 尚不存在(L 线计划中);runId 在 S1 才有但 `request/recipe|response` 依赖它;轨迹面板消费旧 7 类事件,S3 门没列 renderer;`sanitizeSessionOnStartup` 与 `prepare` 合成收尾是同一件事两套实现;toc `segments.jsonl` 读 messages 定位 turn;`sessions:rebuild` 换掉数组对象后旧引用(`context-compact.ts:247`)读到旧数据;`repairSessionTimelineMetadata` 在投影中途回写会话字段 |
| M9 | **遗漏清单** | events.jsonl 自身上限/gzip;会话删除级联 events+blobs;备份/导出格式;隐私(`request/response`、tool/result 全文含敏感文件,sensitive-files 过滤在工具层被事件层绕过);`onething.sqlite` 副本地位;多 store `owners/<uid>/<wid>` 下 server 路径;损坏分级(尾行撕裂 vs 中段断裂);老版本 app 打开新格式要 `formatVersion` 拒载;`ONETHING_DUMP_PROVIDER_REQUESTS` 退役与清理脚本;store 合同测试落点;事件写失败的监控/UI 提示 |

### 7.3 审查后的判断

1. **方向保留**(事件唯一事实、投影派生、surfaceOp、只记时刻、追加不截断)。
2. **缺一个前置期**:B1/B2 说明真正的病根是"会话消息没有单一写路径"——156 个 mutator 散在 33 文件 + server 自己一套。这件事不做,事件溯源在结构上不可能正确(影子期比不出、server 旁路)。它独立于事件溯源也有价值(今天 server/desktop 的双写就已经是隐患)。
3. **快照 + 全文事件 = 双份重内容**,这是存储账反转的根因。三条路:(a) 接受 ~2×;(b) dsh 路:不留持久快照,读侧做增量恢复流水线 + 事件内分页;(c) **薄快照**:快照只存 UI 骨架 + 轻字段,重内容(工具结果全文、大 part)只在事件/blobs 存一份,UI 展开时按需读。
4. **拍板 2 要重开**(M1):checkpoint 成本近零,而 part-only 是量级退化。
5. 门必须全部改成脚本可判:canonicalizer、按量影子门、类型级棘轮(不是正则)。

## 8. 修订后的分期(待拍板后替换 §4)

| 期 | 名 | 交付 | 门 |
|---|---|---|---|
| **P0** | 写路径收口(独立价值,无论 E3 做不做) | `app/session/commands.ts` 一组显式命令(`appendMessage / patchMessage / truncateFrom / replaceAll / markStreaming …`),全部 156 处 mutator + server 6 处改走它;`ChatMessage` 对象从 store 出来即**冻结**(深 freeze,开发期断言),copy-on-write;`session.messages` 整体赋值 6 处消失 | 类型级棘轮:`ChatSession['messages']` 的可变引用只允许出现在 `commands.ts`(ESLint 自定义规则 / ts-morph 脚本,不是正则);全仓 `Object.assign(message…)`=0;server 与 desktop 同一命令面 |
| **S0** | 事件全集 + 投影(纯函数)+ 合同测试 | 在 P0 命令面上,每个命令对应事件;`projectChatMessages`/`projectModelHistory(events, meta)`;`canonicalChatMessage`;store 合同测试套件;事件/消息 seq 改名区分(`eventSeq` vs `messageSeq`);附件 base64 / 大工具结果 → blobs 规格;瞬态 part 不入事件 | 合同测试对"命令序列 → 事件 → 投影"与"命令序列 → 直接改消息"逐条等价(这才是非恒真的金测) |
| **S1** | 影子写 + 纪律翻转 | 命令面双写;event-log 翻为:会话创建先建目录写 `session/created`、写失败上抛、检查点 fsync、跨进程 seq 保护;`run/*`、`request/recipe|response|error`、`assistant/part`(+checkpoint,视拍板 2)采集 | `sessions:shadow-report`:`runs ≥ 200 ∧ mismatch = 0`(按 canonicalizer);主线程最长阻塞 <16ms(CDP 量) |
| **S2** | 读切换 | 事件倒读 pager + `{eventSeq,fileOffset}` 游标 + 跳转内存索引;`jsonlExists` 认 events.jsonl;`ChatMessage.seq`→`eventSeq`;`prepare` 合成收尾取代 `sanitizeSessionOnStartup`;迁移脚本(白名单/lock/dry-run/重编号/rollback);`messages.jsonl` 退役进 legacy-backup | 现有测试全绿;48MB 会话首屏 ±10%、向上翻页 p95 ≤50ms、全量 fold 与今天 loadJsonl 同量级;rollback 往返逐字节 |
| **S3** | 删旧 | 命令面内部只剩 append+project;trace CLI/API/面板读事件;events/blobs 上限与 gzip | 棘轮归零;`sessions:verify` 全库通过;存储脚本给出**目标值**(≈ 今天 messages.jsonl × 1.1–1.2) |
| **S4** | 收尾 | provider dump 退役、隐私过滤进事件层、备份/导出格式、文档 | — |

### 待重拍
- ~~拍板 2 重开~~ **已改拍为③全 delta 打包**(见 §3 / §5)。
- ~~新拍板 6:快照形态~~ **已拍:(b) 无快照**——分页建在事件日志上(§3.2);B6 整条消失,M2 的双份存储消失(事件 ≈ 今天 messages + delta 打包 10–20%)。
- **新拍板 7:P0 是否先独立落地**(推荐是——它修的是今天就存在的 server/desktop 双写隐患,且是 S 线的硬前置)。

---

## 9. S0 规格(2026-08-19,建在 P0 命令面之上;纯函数,不碰持久化)

P0 已落地(commit 856bc3dc):所有消息变更都经 `sessionCommands` 的 12 命令 + `patchSession`,读经 `sessionReads`。S0 的任务 = 把"命令序列"翻译成"事件序列"的规格定死,并证明**从事件投影出的消息 ≡ 从命令 reducer 算出的消息**。S1 才接真实引擎与落盘。

### 9.1 事件记录形状

```ts
interface SessionEventRecord<T, D> {
  seq: number            // 会话内单调递增(eventSeq);身份,不是位置
  time: number           // Date.now(),只记时刻
  type: T
  data: D
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }   // 仅 surface 事件带
  sourceEventSeqs?: number[]   // 因果/遮蔽引用
}
```
- 既有 7 类(`request/tools|header|start`、`assistant/first-token`、`tool/call|result|audit`、`request/end`)**形状不变**,只是 `data` 里新增可选 `runId`;解码对未知 type 跳过(铁律 4)。
- **命名**:事件 seq 一律叫 `eventSeq`;`ChatMessage.seq`(位置)在 S2 退役,S0 投影输出的 `ChatMessage` 不再填 `seq`(或填 `eventSeq` 并标注),合同测试比较时忽略该字段。
- `BlobRef = { hash: string; bytes: number; mime?: string }`:S0 只定义类型与 `isBlobRef`,blob 存储在 S1。附件 `base64Data`、>64KB 的工具结果、图片 part 在事件里只能是 `BlobRef`。

### 9.2 事件全集(S0 定稿;与 §3 表一致,以本节为准)

| 组 | type | data 要点 | surface |
|---|---|---|---|
| 会话 | `session/created` | `{sessionId, kind?, agentId?, model?, provider?, workingDirectory?}` | — |
| | `session/agent-changed` `session/model-changed` `session/workdir-changed` | `{from?, to}` | — |
| | `session/compacted` | `{summary, model?, provider?}` + `surfaceOp:{replace,start,end}` + `sourceEventSeqs`=被遮蔽全部 | append(它自己是 surface 节点:summary 作为 system 历史) |
| 用户 | `user/message` | `{message: ChatMessage(user,附件为 BlobRef)}`(一整条用户消息,含 `origin/mentions/replyTo/voice/source/attachments`) | append |
| | `user/message-edited` | `{messageId, message}` + `surfaceOp:{replace,start:旧 user/message seq,end:当时 surface 末尾}` + `sourceEventSeqs` | append(新节点) |
| | `message/deleted` | `{messageId}` + `surfaceOp:{replace,start,end}`(只遮蔽该消息对应的节点) | — |
| | `message/patched` | `{messageId, patch}`(reactions/replyTo/mentions/thinkingTime/skillUsed/errorDetails/steered/collab* 等**非正文**字段) | — |
| 执行 | `run/start` | `{runId, kind:'send'\|'retry'\|'edit-resend'\|'resume'\|'steer'\|'follow-up', agentId?, triggerEventSeq, assistantMessageId, provider, model}` | append(助手消息节点从这里开始) |
| | `run/end` | `{runId, outcome:'completed'\|'aborted'\|'error'\|'interrupted', error?{name,message}}` | — |
| 请求 | 既有 `request/tools` `request/header` `request/start` `assistant/first-token` `request/end` | 各加 `runId?` | — |
| | `request/recipe` | `{runId, requestIndex, systemPromptHash, toolsHash, messages:[{eventSeq, contentHash}], params?}` | — |
| | `request/response` | `{runId, requestIndex, messageId, providerResponseId?, responseModel?, finishReason?, usage?, parts:[{partIndex, kind, len, hash}], toolCallIds:[]}`(**不带正文**) | — |
| | `request/error` | `{runId, requestIndex, error{name,message,status?}, willRetry, attempt}` | — |
| 助手 | `assistant/chunks` | `{runId, requestIndex, messageId, partIndex, kind:'text'\|'reasoning'\|'tool-input', toolCallId?, time0, dt:number[], text:string[]}`(一行一批 delta,无损) | — |
| | `assistant/part-end` | `{runId, requestIndex, messageId, partIndex, kind, len, hash, blob?: BlobRef(图片)}` | — |
| 工具 | 既有 `tool/call` `tool/result` `tool/audit` | `tool/result.result` 改为 `{text}\|{blob: BlobRef}`,保留 `resultPreview`;各加 `runId?` | `tool/result` append(作为 surface 节点:工具结果进模型历史) |
| 权限/交互 | `permission/asked` `permission/answered` `interaction/asked` `interaction/answered` | `{runId, toolCallId?, requestId, …决定}` | — |
| 上下文 | `context/turn-update` | `{messageId(最新用户消息), set?, removed?}`(取代 `ChatMessage.turnContext` 字段) | — |
| 导入 | `message/imported` | `{message: ChatMessage 原样}`;连续 imported 的 user/assistant 节点各 append | append |

**瞬态 part**(`isTransientPart` 三类)不入事件;**流式 `isStreaming`** 不是事件字段,是投影状态(`run/start` 之后、`run/end` 之前 = streaming)。

### 9.3 命令 ↔ 事件对应(S1 的翻译表,S0 先用它写合同测试)

| `sessionCommands` | 事件 |
|---|---|
| `appendMessage` user | `user/message` |
| `appendMessage` assistant(占位,isStreaming) | `run/start`(assistantMessageId = message.id) |
| `appendMessage` system/error | `user/message` 的 role 变体?—— **否**:system marker 与 error 走 `message/imported`-同形的 `system/message {message}`(新增 type,append 节点,role 原样) |
| `patchMessage` content/reasoning(hint stream) | **不由命令翻译**:来自 agent-loop 的 delta 流 → `assistant/chunks`;S0 合同测试里用 fixture 直接造 chunks |
| `patchMessage` 其余字段 | `message/patched` |
| `appendContentPart` | 图片 → `assistant/part-end{kind:'image',blob}`;文本/推理 part 由 chunks+part-end 表达 |
| `upsertStep` / `patchStep` / `patchStepsUsageByTurn` / `setToolCalls` | **不翻译**:steps/toolCalls 是投影派生物,来源是 `tool/call|result|audit` + `request/response.usage` |
| `truncateFrom` | `user/message-edited`(带新 content)或 `message/deleted`(regenerate 的 inclusive 截断) + replace |
| `deleteMessage` | `message/deleted` |
| `replaceAll{clear}` | `session/cleared` **新增**:`surfaceOp:{replace,start:1,end:当前末尾}`,`sourceEventSeqs` 全部 |
| `replaceAll{replaced}` (collab MESSAGES_REPLACED) | `session/cleared` + 逐条 `message/imported` |
| `repairOnLoad` | 不翻译:冷加载修复 = S2 `prepare` 合成 `run/end{interrupted}` + aborted `tool/result` |
| `patchSession` agent/model/workdir | `session/*-changed`;其余会话级字段(pin/archived/name/summary 非 compact)留 meta.json |
| compact(`context-compact.ts`) | `session/compacted` |

### 9.4 投影(core 纯函数,`packages/core/session/projection/`)

- `SurfaceIndex`:增量维护有序 `eventSeq[]`(append / replace splice),`fold(events)` 与 `push(event)` 两个入口,结果相同(测试断言)。
- `projectChatMessages(events, {upToSeq?}) → { messages: ChatMessage[], activeRun?: {runId, messageId} }`:
  - user/system/imported 节点 → 原样消息;
  - `run/start` → 助手消息骨架(`id/role/agentId/provider/model/timestamp=run/start.time`),随后 chunks fold 成 `content/reasoning/contentParts`(按 partIndex 顺序;`tool-input` kind 归到 toolCalls.arguments 流),`tool/call|result|audit` → `toolCalls[]` + `steps[]`(派生形状沿用今天的 `Step`/`ToolCall`,`steps[].result` 取 `tool/result` 全文或 blob 占位),`request/response.usage` 累计到 `message.usage`/`steps[].usage`,`run/end` 决定 `isStreaming=false` 与 `errorDetails`;
  - `message/patched` 叠加;`message/deleted`/replace 遮蔽的节点不出现;`session/compacted` 不产生 UI 消息(UI 看的是原消息;compact 摘要只进模型历史)——**注意**:今天 UI 会显示一条 compact 消息(`context-compact.ts:100` addMessage),投影要保留这条(作为 `role:'system'` 的派生消息,由 `session/compacted` 生成),合同测试以今天的 UI 形状为准。
- `projectModelHistory(events, meta, {upToSeq}) → ProviderMessage[]`:只走 surface;`session/compacted` 节点渲染为 summary 系统消息,被遮蔽的节点跳过;`context/turn-update` 以今天 `turnContext` 的落点规则注入;输出须与今天 `buildHistoryMessages(sessionReads.sliceForHistory(...), session)` 等价(合同测试)。
- `canonicalChatMessage(m)`:剔除瞬态/派生字段(`isThinking/thinkingStartTime/seq/isStreaming` 的中间态、瞬态 part),`contentParts/steps/toolCalls` 内部按稳定键排序后深比较;供合同测试与 S1 影子断言共用。

### 9.5 合同测试(非恒真)

`packages/core/session/__tests__/projection-contract.test.ts`,对每个场景同时跑两条线:
- A 线:命令序列 → `applySessionCommand` 逐条 → `ChatMessage[]`(今天的真相);
- B 线:同一场景的事件序列(按 §9.3 翻译,流式部分用 fixture 造 `assistant/chunks`+`part-end`+`request/response`) → `projectChatMessages` → `ChatMessage[]`;
- 断言 `canonical(A) ≡ canonical(B)`;`projectModelHistory(B)` ≡ `buildHistoryMessages(A)`。
场景至少:单轮文本;带 reasoning;两轮工具循环(含 denied 权限);中途 abort;regenerate;edit-resend;删除中间消息;compact 后继续;collab 清空;系统 marker 增删;老会话 imported;surface replace 链式(compact 后 edit)。
外加 `SurfaceIndex` fold≡push、解码容错(未知 type/半行)、`BlobRef` 判定。

### 9.6 S0 明确不做
不碰 `app/session/event-log.ts` 的落盘、不改 recorder、不改 `sessions/session-events.ts` 既有 7 类的编码(新类型加在同文件或 `session-events-v2.ts`,由实施者定但必须向后兼容读旧文件)、不动 renderer、不动 `messages.jsonl`。

### 9.7 S0 落地记录(2026-08-19)

**门**:`typecheck` 只剩 `spaces/__tests__/provider-dials.test.ts` 的 3 条既有错;
`ONETHING_SESSION_FREEZE=1 bun run test` 10718 passed / 2 failed(两条既有
`ui-token-vars.test.ts`)+ 1 条既有 unhandled rejection(`AIProviderTab.interaction.test.ts`);
`session:gate` **0**(none new);`boundary:gate` 绿(13 known,none new);
`lint:ci` **334**(与 P0.4 收口后的基线同数,零新增);
`packages/core/__tests__/architecture-boundaries.test.ts` 10 条全绿(core 仍零依赖:
新代码不引 node、不引 shared、不引 electron)。

#### 交付

| 文件 | 角色 |
|---|---|
| `packages/core/session/events/types.ts` | 事件词表 v2:记录外壳(`{seq,time,type,data,surfaceOp?,sourceEventSeqs?}`)、`BlobRef`+`isBlobRef`、七类原样上移(只加可选 `runId`)、§9.2/§9.3 的全部新类型、双向穷尽守卫 `SESSION_LOG_EVENT_TABLE_IS_EXHAUSTIVE`、正文门 `SESSION_SURFACE_EVENTS_CARRY_NO_MESSAGE_BODY`、surface 节点分类表 |
| `packages/core/session/events/codec.ts` | `encode/decode/parseSessionLogEventLog` + `isSessionLogEventType`。与 E0 逐字节兼容;半行/未知类型跳过;`surfaceOp`/`sourceEventSeqs` 形状不对**只丢那个字段**,不丢整条 |
| `packages/core/session/projection/surface.ts` | `SurfaceIndex`(`push` 增量 / `foldSurface` 一次性)+ replace 校验(start/end 在不在面上、`sourceEventSeqs` 有没有列全)→ `SurfaceViolation[]` |
| `packages/core/session/projection/reducer.ts` | `(state, event) → state` 归约器 + 节点定义 + 工具/步骤/内容 part 的物化算法 |
| `packages/core/session/projection/chat-messages.ts` | `projectChatMessages` / `foldSessionProjection` / `materializeChatMessages` |
| `packages/core/session/projection/model-history.ts` | `projectModelHistory(events, meta, opts)` + `defaultHistoryMessageContent` |
| `packages/core/session/projection/canonical.ts` | `canonicalChatMessage(s)` —— 合同测试与 S1 影子断言共用的比较判据 |
| `packages/core/session/projection/types.ts` | `ProjectedChatMessage/Step/ToolCall/ContentPart`(与 shared 契约结构兼容,不引用) |
| `packages/core/engine/history.ts` | 抽出 `compactedHistoryPreamble(summary)` —— 摘要那条 user 消息现在有两个产出口(消息重建 / surface 投影),必须逐字节同源 |
| `packages/onething-runtime/src/sessions/session-events.ts` | 降为**再导出 + 哈希/检视工具**:`SessionEventRecord` 仍只是七类(轨迹面板、`@shared` 契约面、rpc 域零改动),解码委托给 core 那一份再按七类筛一道 |
| `packages/core/session/__tests__/projection-contract.test.ts` | §9.5 的 12 场景 + SurfaceIndex fold≡push + 增量逐步等价 |
| `packages/core/session/__tests__/session-event-codec.test.ts` | 向后兼容(真机文件逐行 decode→encode 回到原文)、半行/未知类型容错、BlobRef、类型级门 |
| `packages/core/session/__tests__/fixtures/legacy-events.jsonl` | 真机会话 `fd899977…/events.jsonl` 的**逐字节子集**(第 2–33 行,24.9KB,含全部七类);第 1 行那条 39KB 的 `request/tools` 没收进来,子集里另有一条 19KB 的同类 |

#### 口径裁定(原文没写死的地方)

1. **词表放大不动既有联合**。core 里 `SessionLogEventRecord` 是 v2 全集,
   `SessionLegacyEventRecord` 是七类;runtime 的 `SessionEventRecord` 仍**等于**七类。
   理由:renderer 的 `trajectory-projection.ts` 与 `@shared` 的 rpc 域都在那个联合上做
   穷尽分支,悄悄放大它等于让一堆 switch 静默漏掉新类型。S1 接新事件时要显式换类型。

2. **"两种看不见"必须分开**(这是本期最容易写错的一处)。`node.hidden` = UI 上没了
   (删除 / 清空 / 编辑重发的截断);`SurfaceIndex` 的遮蔽 = 只是不进模型历史。
   `session/compacted` 走后者 —— 被压缩的消息在聊天记录里**照旧显示**(§9.4 的那条
   "注意"),混成一个标志位的话压缩一次屏幕上就少半屏。

3. **`surfaceOp: replace` 按位置匹配,不按 seq 大小**。`order` 是呈现序不是升序:
   compact 之后那个节点排在最前面,seq 却最大。第一版用 `findIndex(seq >= start)`,
   于是"压缩后再编辑"一条都没遮蔽掉(校验报了 range-missing,而模型历史里旧的一问
   一答原封不动留着)。合同测试第 12 场景就是钉这一条的。

4. **`steps[]` / `contentParts` 的次序从哪来**:
   - `contentParts` 按 `partIndex` 升序;`text`/`reasoning` part 各自成一格,
     `tool-input` part **不进** contentParts(它喂的是 `toolCalls[].arguments` 那一路);
   - `toolCalls[]` / `steps[]` 按 `tool/call` 的到达序(`toolOrder`),两者一一对应;
   - `turnIndex` = 该 `requestIndex` 在**这个 run 内**的 1 起序号(事件里的
     `requestIndex` 是会话级的,直接用会让第二个 run 的第一轮变成 turnIndex=5)。

5. **`tool-input` chunks → `toolCalls[].arguments` 的口径**:
   `tool/call.argumentsRaw` 是**唯一**的参数真相(它是真正执行的那一份);
   tool-input 的 delta fold 只喂 `streamingArgs`(参数还在生成时的显示),
   `tool/call` 一到就撤下。`argumentsRaw` 解不开 JSON 时给 `{}`,原文不丢
   (铁律 2:模型把 JSON 写坏了就原样记账,不替它修)。
   顺序坑:参数流**先**收齐(`assistant/part-end{kind:'tool-input'}`),`tool/call`
   才落账,所以 part-end 到达时那个 tool 还不存在 —— `receivedAt` 由 `tool/call`
   回头去 part 上取。

6. **`session/compacted` 的 UI 消息长什么样**:`{id: data.messageId, role:'system',
   content: buildContextCompactContent({status, summary, compactedMessageCount,
   compactedThroughMessageId}), timestamp: event.time}` —— 正文直接调 core 自己的
   `buildContextCompactContent`(引擎写出去的就是它),不在投影里手抄一份 JSON。
   因此事件 data 必须带 `messageId` / `compactedMessageCount` /
   `compactedThroughMessageId` / `status` / `error`,§9.2 原表只写了 `{summary, model?,
   provider?}`,**本节以实现为准**。失败的压缩记 `status:'failed'`:它在 UI 上是一张
   红卡,在模型历史里什么都不是(不发摘要)。

7. **`projectModelHistory` 不自己写一遍物化**。surface 上的节点按"连续的非压缩段"
   切开,每段交给 `core/engine/history.ts` 的 `buildHistoryMessages`(今天真机走的
   那一份);压缩节点渲染成 `compactedHistoryPreamble`。有压缩节点时 `meta.summary`
   **不再参与**(切点已由 surface 表达,再按锚点切一次就是切两刀);没有压缩节点的
   老会话(全是 `message/imported`)仍把 meta 交给 builder 自己切 —— 那不是兜底,
   是事实所在处不同。

8. **`tool/result` 是 surface 节点但不单独物化**。它折进所属 run 的那条 assistant
   消息(今天历史就是 assistant+tool 成对发的)。它在 surface 上占一格是为了
   "工具结果剪枝"能用同一个 replace 表达:被遮蔽的 `tool/result` 对应的那次调用
   从模型历史里摘掉,UI 上那张卡照旧在。

9. **归约器是线性持有的**。`reduceSessionProjection` 返回新的 state 对象,但内部的
   Map/数组/节点是**移动语义**:传进去的那份交出去之后就不该再用。每条事件复制一遍
   全部节点会让增量维护退化成 O(n²),而这个投影要跑在主线程上(§7.2 M7)。要历史
   某一刻的快照就 `projectChatMessages(events, {upToSeq})` 重跑一次 —— 那条是纯的,
   合同测试里"逐条推 ≡ 逐条 upToSeq fold"钉住两者一致。

10. **`canonicalChatMessage` 丢什么**:`seq`/`eventSeq`/`sessionId`/`isThinking`/
    `thinkingStartTime` 直接丢;`isStreaming` 只保留 `true`(`false` 与缺席同义);
    瞬态 part(`waiting`/`image-loading`/未结算的 `plugin-status`)丢;`undefined` 值
    的键与空数组丢;`steps`/`toolCalls` **按 id 排序**后深比较。
    **`contentParts` 的顺序不排序** —— §9.4 把它和另两个并列写了,但那个顺序**就是
    正文本身**,排掉等于放过"两段话装反了"这一类错。这是本节对 §9.4 的一处明确偏离。

11. **投影产出的对象一律一次性构造**(条件展开),不"先建后逐字段改"。不只是风格:
    `session:gate` 规则 B 盯的就是消息形状上的属性赋值,而它盯的理由(投影产物转手
    就被深冻结交给读门面)在这里同样成立。第一版是先建后补,`session:gate` 当场 +23。

#### S1 必须补的规格缺口

| # | 缺口 | 今天怎么处置的 | S1 要做什么 |
|---|---|---|---|
| G1 | **`Step.id` 事件里没有** | 派生 `step-${callId}`(确定性,与 toolCallId 一一对应) | `tool/call` 上补 `stepId`,否则影子期每条 step 的 id 都对不上,`canonical` 的 id 排序也换了键 |
| G2 | **`Step.title` 事件里没有** | 取 `tool/audit.previewTitle`,缺席退回工具名 | 今天是 `generateStepTitle(toolName, args, skillName)` 算的;要么把它算进 `tool/call`,要么接受"标题是纯派生"并把那个函数搬进 core 供投影调用 |
| G3 | **子步骤(`childSteps`)** | 不产出 | 事件里没有父子关系(今天靠 `sendStepAdded(subStep)` 的调用栈);需要在 `tool/call` 上补 `parentCallId` |
| G4 | **`data-steps` / `waiting` / `image-loading` 占位 part** | 不产出(canonical 里当瞬态丢) | 确认它们**永久**是渲染侧的事(推荐),还是要一条 `assistant/part-end{kind:'placeholder'}` |
| G5 | **`thinkingTime` / `skillUsed` / `steered` / `collab*` / `origin` / `mentions` / `reactions`** | 只能靠 `message/patched` 带过来(合同测试里 imported 场景验了透传) | S1 要逐个确认采集点:哪些是 `message/patched`,哪些该有自己的事件(`skill:activated` 今天是一条流事件) |
| G6 | **`rejectionReason`** | 两条线都不产出 | `permission/answered.reason` 已经有这一格,但没有"把它接到 toolCall 上"的规则;要定死是投影按 `toolCallId` 关联,还是 `tool/audit` 冗余一份 |
| G7 | **参数流开了头就被打断**(有 tool-input part,没有 `tool/call`) | 不产出任何 toolCall | 今天 UI 上是一张 `input-streaming` 的卡。要么投影按孤儿 tool-input part 合成占位 toolCall,要么接受它消失 |
| G8 | **多模态 / 附件** | `defaultHistoryMessageContent` 只处理字符串正文 + 尾块 | 附件的 `base64Data` 必须是 `BlobRef`(类型已就位,存储在 S1);`buildMessageContent` 由宿主注入,S1 要把桌面端那一份接进来并验"落点与回放同一函数" |
| G9 | **compact 的 `useCompactedToolResults`** | surface 路径统一走非压缩预算 | 今天压缩后的尾部用的是更紧的 per-result 预算(24k/80k vs 200k/600k)。小载荷下两者逐字节相同(合同测试没碰到),但真机大结果会分叉 —— S1 要么在 `session/compacted` 之后的段落切到压缩预算,要么明确改口径 |
| G10 | **`request/recipe.messages[].eventSeq` 没有生产者** | 类型定义了,投影不读 | 它是"这次请求究竟发了哪些节点"的自证账;S1 采集时要与 `projectModelHistory` 走同一个 surface 快照,否则两者对不上就没有校验价值 |
| G11 | **`session/cleared{reason:'replaced'}` 的第二半** | 只实现了"全清";§9.3 说 replaced = cleared + 逐条 `message/imported` | 合同测试只验了 `clear`;collab 的 `MESSAGES_REPLACED` 要在 S1 补一条端到端 |
| G12 | **seq 的跨进程安全** | S0 不落盘,不涉及 | §7.1 B5 + `session-commands-p0-2026-08.md` §10.7(server 的 StoreLock 已按用户裁定撤回):desktop 与 server 共享 `~/.onething` 时两个写者会分配重复 seq,而 `surfaceOp replace` 按 seq 区间遮蔽 → 静默错乱。**S1 开工前必须先解决**,这是 S 线唯一的硬前置 |


---

## 10. S1 规格(2026-08-19):影子写 —— 事件真正落盘,messages.jsonl 仍是真相

前提:P0(命令面)、S0(事件全集 v2 + 投影 + 合同测试)、one-core A 期(单引擎,G12 消解)均已提交。S1 让真实引擎开始产生 v2 事件并落盘,但**不切读路径**:`messages.jsonl` 仍是唯一真相,事件是影子;每个 run 结束时把两边投影做 canonical 比较,不等就记账。S2 才切读。

### 10.1 G1–G12 裁定

| # | 裁定 |
|---|---|
| G1 `Step.id` | 事件不带;投影确定性派生 `step-${callId}`;`canonicalChatMessage` 忽略 `step.id`,steps 按 `toolCallId` 排序比较 |
| G2 `Step.title` | 纯派生:`generateStepTitle(toolName, args, skillName)` 搬进 core(纯函数),投影调用;事件不带 title |
| G3 子步骤 | `tool/call.data.parentCallId?`(可选);recorder 能拿到就填,拿不到就平铺;投影按它建 `childSteps` |
| G4 占位 part | 永久渲染侧,不入事件 |
| G5 杂字段 | `thinkingTime` = 派生(reasoning 段 chunks 的 `time0+dt` 首尾差;无 reasoning 则 `first-token − request/start`);`skillUsed` → 新事件 `skill/activated {runId, messageId, skill}`;`steered/collab*/origin/mentions/reactions/replyTo` → `message/patched`(origin/mentions/replyTo 在 `user/message` 本体里已有,patched 只管事后改) |
| G6 `rejectionReason` | 投影按 `toolCallId` 把 `permission/answered{decision:'deny', reason}` 接到 toolCall/step 上;`tool/audit` 不冗余 |
| G7 孤儿 tool-input | 投影按孤儿 `assistant/chunks{kind:'tool-input'}` 合成 `status:'input-streaming'` 的 toolCall;`run/end` 非 completed 时转 `cancelled` |
| G8 附件/多模态 | `user/message.message.attachments[].base64Data` → `BlobRef`;blob 存 `sessions/<id>/blobs/<sha256-16>`(app 层 `app/session/blob-store.ts`,内容寻址,同 hash 只写一次);`projectModelHistory` 的 `buildMessageContent` 由宿主注入(desktop 那份),S1 断言"落点与回放同一函数" |
| G9 compact 预算 | `projectModelHistory`:surface 上存在 `session/compacted` 节点时,其后的工具结果用压缩预算(24k/80k),否则 200k/600k —— 与今天同口径 |
| G10 recipe | `request/recipe.messages[] = {messageId, contentHash}`(eventSeq 在 S2 由 id→seq 索引解析);采集点 = 今天 history builder 的**输入**(发出去的就是它),hash = 发出的正文 |
| G11 replaced | collab `MESSAGES_REPLACED` = `session/cleared` + 逐条 `message/imported`,S1 接上并加端到端测试 |
| G12 跨进程 seq | one-core A 期:一个 store 一个引擎;event-log 仍加**守卫**:首次启用读文件 lastSeq;append 前若文件 lastSeq > 内存 lastSeq(别的进程写过)→ 重新装载并 warn,不盲写 |

### 10.2 采集点(谁产生哪些事件)

| 来源 | 事件 |
|---|---|
| `sessionCommands`(P0 命令面,`app/session/commands.ts`)在 reducer 成功后翻译(§9.3 表) | `user/message`、`system/message`、`message/patched`、`message/deleted`、`user/message-edited`、`session/cleared`(+imported)、`session/*-changed`、`context/turn-update` |
| 引擎 run 生命周期(`stream-engine` handleSendMessage / retry / edit-resend / resume / steer / follow-up) | `run/start`(此处生成 `runId`,放进 agent-loop ctx)、`run/end` |
| agent-loop recorder(`app/engine/stream/session-event-recorder.ts` 扩展,挂 `onEvent`,执行前记账) | 既有 7 类(+runId)、`request/recipe`、`request/response`、`request/error`、`assistant/chunks`(内存攒批:2s / 64 条 / part 边界 / 请求结束先到者触发)、`assistant/part-end`、`skill/activated` |
| 权限/交互层(`Permission.ask/respond`、interaction registry) | `permission/asked|answered`、`interaction/asked|answered` |
| compact(`context-compact.ts`) | `session/compacted`(+surfaceOp replace + sourceEventSeqs) |
| 冷加载 `prepare`(S2) | 合成收尾(S1 不做) |

`runId` 生成:引擎执行入口 `randomUUID()`;`ChatMessage.runId?` 新增可选字段并持久化(messages.jsonl 仍写),供影子比较按 run 切片。

### 10.3 落盘纪律翻转(B5 的一半,剩下一半在 S3)

S1 仍是影子,所以写失败**不致命**,但必须**可见、可计数**:
- `app/session/event-log.ts`:①会话目录由事件层创建(`session/created` 是第一条),`storage-driver.jsonlExists` 同时认 `events.jsonl`(B4);②写失败不再 warnOnce 吞掉,计入 `<store>/log/session-shadow-stats.json`(`{appendFailures, runs, mismatches}`)并每会话 warn 一次;③**语义检查点 fsync**:调模型前 / 调工具前 / 响应收齐 / run 结束,`flushSessionEventLog(sessionId)` 等待队列排空并 fsync;④G12 守卫。
- blob store 同步写(小文件),失败同 ②。

### 10.4 影子断言与报告

- run 结束(`run/end` 落盘后):`projectChatMessages(events of this run)` vs `sessionReads.listMessages` 中属于该 run 的消息(按 `runId`),两边过 `canonicalChatMessage` 深比较;不等 → 追加一行到 `<store>/log/session-shadow.jsonl` `{time, sessionId, runId, diff: 字段级摘要 ≤ 2KB}`,stats.mismatches++;相等 → stats.runs++。
- `projectModelHistory` 也比:下一次请求前,用同一 surface 投影出的历史 vs 今天 `buildHistoryMessages` 的输出(即 recipe 的输入)做 hash 比较,不等同样记账(`kind:'history'`)。
- `bun run sessions:shadow-report`:打印 `{runs, mismatches, appendFailures, byKind, top10 sessions}`;**门 = runs ≥ 200 ∧ mismatches = 0 ∧ appendFailures = 0**(按量不按天)。
- 性能门:CDP 量主线程最长阻塞 < 16ms(一轮 50 工具调用脚本)—— 沿用拖拽量法记忆。

### 10.5 S1 明确不做
不切读路径;不迁移老会话;不删 messages.jsonl;不改 renderer;不做 `prepare` 合成收尾;不做 trace CLI/API(S3)。

### 10.6 分两批派工
- **S1a**:命令面翻译 + runId 贯穿 + recorder 扩展(chunks 打包 / recipe / response / error / part-end / skill) + 权限事件 + compact 事件 + blob store + event-log 纪律翻转(mkdir / 计数 / 检查点 fsync / G12 守卫)+ 投影侧 G1–G9 的补齐(core)。门:单测 + 既有合同测试扩展(新场景:孤儿 tool-input、permission deny reason、compact 预算)+ 真机脚本:发一条带工具的消息 → `events.jsonl` 出现完整 run 序列且 seq 连续。
- **S1b**:影子断言 + shadow.jsonl/stats + `sessions:shadow-report` + 性能量测脚本 + G11 端到端。门:report 跑通,mismatch 列表可读。

---

### 10.7 S1a 落地记录(2026-08-19)

**门**(逐字):`bun run typecheck` 只剩 `spaces/__tests__/provider-dials.test.ts`
的 3 条既有错;`ONETHING_SESSION_FREEZE=1 bun run test` **10772 passed / 2 failed**
(两条既有 `ui-token-vars.test.ts`)+ 1 条既有 unhandled rejection
(`AIProviderTab.interaction.test.ts`);`session:gate` **0**(none new);
`boundary:gate` 绿(13 known,none new);`lint:ci` **334**(与基线同数,零新增);
`packages/core/__tests__/architecture-boundaries.test.ts` 10 条全绿;
`server:build` 通过并**真机起服跑通**(见下);`transport:gate` 仍是 2603c665 那
4 条既有红,本期一行未加。

#### 交付

| 文件 | 角色 |
|---|---|
| `packages/onething-runtime/src/app/session/event-log.ts` | 纪律翻转:`session/created` **建目录**(且只有它有这个权力)、写失败计数不再静默、`flushSessionEventLog` 排空队列**并 fsync**、G12 跨进程守卫;新增 v2 入口 `appendSessionLogEvent` 与 `readSessionLogEvents(Sync)` |
| `packages/onething-runtime/src/app/session/event-stats.ts` | `<store>/log/session-shadow-stats.json` 的 `{appendFailures, runs, mismatches}`(节流写);每会话一次 warn |
| `packages/onething-runtime/src/app/session/blob-store.ts` | `sessions/<id>/blobs/<sha256-16>`:内容寻址、写一次、同步写;`textOrBlobForEvent` 是 64KB 线的唯一判点 |
| `packages/onething-runtime/src/app/session/event-surface.ts` | 每会话的**活 surface**(core `SurfaceIndex` + `messageId→eventSeq` 表,首次同步 fold 建起);`appendSurfaceAwareEvent` 是翻译器唯一的门 |
| `packages/onething-runtime/src/app/session/runs.ts` | run 登记处:`beginSessionRun`/`ensureSessionRun`/`rotateSessionRun`/`endSessionRun`/`markSessionRunOutcome` + `requestIndex` 与 **partIndex 分配器** |
| `packages/onething-runtime/src/app/session/event-translator.ts` | §9.3 的翻译表(user/system/patched/deleted/edited/cleared+imported/`session/*-changed`/turn-update/compacted);附件 base64 → `BlobRef` |
| `packages/onething-runtime/src/app/session/permission-events.ts` | `Permission`/`Interaction` 的记账接线(`backend.ts` 在两个 `initialize` 之后装上) |
| `packages/onething-runtime/src/app/engine/stream/session-event-recorder.ts` | 扩展:全部事件带 `runId`;新增 `request/recipe`、`request/response`、`request/error`、`assistant/chunks`(攒批)、`assistant/part-end`、`skill/activated`;`tool/result` 带全文/blob |
| `packages/onething-runtime/src/app/engine/stream/stream-executor.ts` | run 生命周期的**唯一入口**(四条引擎路径 + 图片特化流都过它) |
| `packages/onething-runtime/src/app/engine/stream/agent-loop-executor.ts` | 恢复路径的 run 兜底、`response-boundary` 换 run、abort/error 的收场预告、recorder 收尾 flush |
| `packages/onething-runtime/src/app/engine/context-compact.ts` | 成功/失败两条路各记一条 `session/compacted` |
| `packages/onething-runtime/src/app/stores/sessions.ts` | `session/created` 三个创建入口;删会话摘三张进程内表;**四条 store 端口(add/delete/两式 truncate)改为转调命令面** |
| `packages/onething-runtime/src/sessions/storage-driver.ts` | `jsonlExists` 认 `events.jsonl`(B4 的鸡生蛋随之消失) |
| `packages/core/session/events/types.ts` | 新增 `skill/activated`;`tool/call.parentCallId?`;`run/start.triggerMessageId?` |
| `packages/core/session/projection/{reducer,chat-messages,canonical,model-history,types}.ts` | G1–G9 的投影补齐(见下表) |
| `packages/core/engine/history.ts` | `forceCompactedToolResults?`(G9 的开关,surface 路径没有 `session.summary` 可推) |
| `packages/core/permission/index.ts`、`packages/core/interaction/registry.ts` | `setRecorder` 旁听席(core 仍零依赖:只是一个回调) |
| `packages/shared/ipc/chat.ts` | `ChatMessage.runId?` |
| 测试 | `app/session/__tests__/{event-log-s1,event-translator}.test.ts`、`app/engine/stream/__tests__/session-chunk-packer.test.ts`、扩写的 `session-event-recorder.test.ts`、`core/session/__tests__/projection-contract.test.ts` 新增 `S1a projection catch-up (G1–G9)` 一组 |

#### G1–G12 的落法

| # | 落法 |
|---|---|
| G1 | 事件不带 stepId;投影派生 `step-${callId}`;`canonicalChatMessage` **丢 step.id**,steps 按 `toolCallId` 排序(`childSteps` 递归同款) |
| G2 | `generateStepTitle` 本来就在 core(`engine/tool-step.ts`),投影直接调;`tool/audit.previewTitle` 不再当标题用。合同测试 A 线同步改成调它 —— 从前那边写死 `spec.name`,等于这一条合同是空的 |
| G3 | `tool/call.data.parentCallId?` 已在类型与投影上就位(`materializeSteps` 建 `childSteps`,子调用不在顶层重复);**采集侧今天填不出来**(`AgentToolCall` 没有父指针),见"S1b 缺口" |
| G4 | 占位 part 永久渲染侧,不入事件 —— 未做任何事 |
| G5 | `skill/activated` 由 recorder 在 `tool-call-done` 用 core 的 `detectSkillUsage` 算出;`thinkingTime` 派生自推理段 chunks 的 `time0+dt` 首尾差,无推理段退回 `first-token − request/start`,**0 不产出**(0 与"没量到"同义) |
| G6 | `permission/answered{approved:false,reason}` 按 toolCallId 落到 toolCall/step 的 `rejectionReason`;审批**早于** `tool/call` 是常态,所以归约器先存 `rejectionReasonByCallId`,`tool/call` 一到就取走 |
| G7 | 孤儿 `assistant/chunks{kind:'tool-input'}` 合成 `status:'input-streaming'` 的占位 toolCall,run 非正常收尾后转 `cancelled` |
| G8 | 附件 `base64Data` → `BlobRef`(翻译器落、`projectModelHistory` 的 `resolveBlob` 回放);**拿不到正文就摘掉那一格**,绝不让 `{hash,bytes}` 当 base64 发出去 |
| G9 | `projectModelHistory` 在 surface 上看见 `session/compacted` 节点就把 `forceCompactedToolResults` 打开(24k/80k),与今天同口径 |
| G10 | `request/recipe.messages = {messageId, contentHash}`;采集点是 history builder 的**输入**(带 id 的 `ChatMessage[]`,由执行器用 `sessionReads.listMessages` 注入),不是 provider 收到的 `AgentMessage[]`(那份没有 id)。`eventSeq` 留给 S2 |
| G11 | `replaceAll{replaced}` = `session/cleared` + 逐条 `message/imported`,翻译器测试里有端到端一条 |
| G12 | 守卫按**字节数**判:文件比"我们写进去的"还长 = 有第二个写者 → 重装计数器 + warn(500ms 一次的检查间隔,不是每次 append 都 stat) |

#### 口径裁定(原文没写死的地方)

1. **一条 assistant 消息 = 一次 run**。`beginSessionRun` 只在 `executeMessageStream`
   开;`executeAgentLoopStreamGeneration` 用 `ensureSessionRun` —— 按
   `assistantMessageId` 判同一次,普通发送走到那里是 no-op,只有"确认后恢复"
   (它绕过前者直接调)才真的开一条 `kind:'resume'`。谁开的谁收尾。
2. **`run/end` 的 outcome 不能照 finally 写**。abort / error 在执行器内部就被
   接住了(翻成 `stream:aborted` / 一条错误消息,不再往上抛),finally 看到的是
   一次正常返回。所以加了 `markSessionRunOutcome`:接住的那一处留一句,收尾时
   优先用它,且只认比 `completed` 更坏的结论。
3. **`store.addMessage` / `deleteMessage` / 两式 truncate 改为转调命令面**。
   这四条是 core 引擎写消息的端口(P0 §6 冻住了形状),与 `sessionCommands`
   是同一件事的两个门牌。真机脚本第一次跑出来的 `events.jsonl` **没有
   `user/message`** —— 病根就是引擎走的是另一扇门。语义逐字不变
   (`appendMessage{stampCollab:true}` 就是原来的 stamp + runtime.addMessage)。
4. **助手占位消息不翻译**。`appendMessage` 遇到 `role:'assistant' && isStreaming`
   直接返回:它在 surface 上的那一格是 `run/start`,翻一条 `system/message`
   就成了两格。非流式的 assistant / system / error 一律走 `system/message`
   (role 原样,与 `message/imported` 同形)。
5. **正文与派生字段永不进 `message/patched`**:`content`/`contentParts`/
   `reasoning` 来源是 chunks;`isStreaming`/`isThinking`/`thinkingStartTime`/
   `seq`/`steps`/`toolCalls` 是投影算得出来的。剩下全空就一条都不写。
6. **失败的压缩不遮蔽任何东西**。它记一条 `status:'failed'` 的
   `session/compacted`(UI 上那张红卡),但 `surfaceOp` 是 `append` —— 一段没压
   成功的历史照旧要发给模型。
7. **partIndex 是 run 级的、跨请求单调**,由 run 登记处统一分配。每次请求各数
   各的会让第二轮的正文插到第一轮前面(投影按 partIndex 排 `contentParts`)。
8. **`interaction/answered` 记决定不记正文**:`answer` 存的是 outcome
   (answered/declined/timeout/aborted)。自由文本答复属于那次工具调用的结果,
   不属于这条时刻账。
9. **审批合并(coalescing)时每个 toolCallId 各记一条 `permission/answered`**:
   投影是按 toolCallId 关联的,只记 head 那一个的话被合并的调用查不到自己的判决。

#### 真机脚本校验(§10.6 的门)

`bun run server:build` 之后,用临时 `ONETHING_STORE_PATH` + 一个本地假 provider
(OpenAI 兼容 SSE)起 `node dist/server/main.js`,发一条会触发工具调用的消息。
`sessions/<id>/events.jsonl` 的**实际类型序列**(seq 连续 1..27,全程一个 runId):

```
 1 session/created      2 user/message         3 run/start           4 message/patched
 5 context/turn-update  6 request/tools        7 request/header      8 request/recipe
 9 request/start       10 assistant/first-token 11 assistant/chunks  12 assistant/part-end
13 tool/call           14 tool/audit          15 tool/result        16 assistant/chunks
17 assistant/part-end  18 request/response    19 request/end        20 request/recipe
21 request/start       22 assistant/first-token 23 assistant/chunks 24 assistant/part-end
25 request/response    26 request/end         27 run/end
```

两处值得记下来的:①**凭证走 per-space 凭证池**(`workspaces/<id>/credentials.json`,
明文形态 `encryption:'none'`),`providers.json` 里的 `apiKey` 已经不是起流的来源
——脚本第一次跑报的是"空间「默认空间」未配置 OpenAI 的凭证";②**标题生成会打同
一个 provider 端点**,假 provider 要按"这次请求带不带工具目录"把它和真回合分开,
否则第一轮的工具调用被标题请求吃掉。

#### S1b 必须补的缺口

| # | 缺口 | 现状 |
|---|---|---|
| 1 | **影子断言**(§10.4)整条 | 没做:`session-shadow.jsonl`、`stats.runs/mismatches`、`sessions:shadow-report`、性能门都归 S1b |
| 2 | `tool/call.parentCallId` **没有生产者** | 类型与投影就位,但 `AgentToolCall` 上没有父指针(外部 agent 的 `parent_tool_use_id` 也没接出来)。今天一律平铺 |
| 3 | `assistant/part-end{kind:'image', blob}` 没有生产者 | 图片正文归媒体库管(`ContentPart` 里根本没有 base64 图片成员),事件侧留着位子 |
| 4 | `request/recipe.params` 没有生产者 | `getRequestParams` 端口留着,执行器没注入(温度/maxTokens/thinking 快照) |
| 5 | `providerResponseId` / `responseModel` 只认 `provider-data` 里的 `responseId`/`id`/`model` | 各家 provider 的自报字段没有统一过;认不得的就不填(不猜) |
| 6 | `upsertMessage` 命中已有那条 → `message/patched` | 语义上是"整条换掉",投影的叠加层能表达,但**正文字段会被丢掉**(第 5 条裁定)。真有整条换正文的调用点时要重看 |
| 7 | 老会话(只有 E0 七类)的 surface 是空的 | 对的 —— 它们的消息事实还在 `messages.jsonl` 里,S2 的迁移脚本才把它们变成 `message/imported` |
| 8 | `flushSessionEventLog` 的 fsync 每次都开一次文件句柄 | 检查点频率下可接受;真机大会话的耗时没量过(S1b 的性能门一起量) |

---

### 10.8 S1b 落地记录(2026-08-20)

**门**(逐字):`bun run typecheck` 只剩 `spaces/__tests__/provider-dials.test.ts`
的 3 条既有错;`ONETHING_SESSION_FREEZE=1 bun run test` **10787 passed / 2 failed**
(两条既有 `ui-token-vars.test.ts`)+ 1 条既有 unhandled rejection
(`AIProviderTab.interaction.test.ts`);`session:gate` **0**(none new);
`boundary:gate` 绿(13 known,none new);`lint:ci` **334**(与基线同数,新增文件
零命中);`server:build` 通过;
`bun run sessions:shadow-report --min-runs 20` → **runs 20 / mismatches 0 /
appendFailures 0,GATE GREEN**(10 个会话 × 2 个回合,假 provider 真机)。

#### 交付

| 文件 | 角色 |
|---|---|
| `packages/onething-runtime/src/app/session/shadow.ts` | **影子断言本体**:活投影缓存(O(新事件))、run 断言(`kind:'messages'`)、历史断言(`kind:'history'`)、字段级 diff 摘要(≤2KB)、`session-shadow.jsonl` 追加 |
| `packages/onething-runtime/src/app/session/event-stats.ts` | 统计表扩到 `{appendFailures, runs, mismatches, byKind, lastMismatchAt}`;新增总闸 `isSessionShadowEnabled()`(`ONETHING_SESSION_SHADOW=0` 关) |
| `packages/onething-runtime/src/app/session/event-log.ts` | 写入口挂一条**尾巴**(`drainSessionLogEventTail`):活投影按需取走刚分配 seq 的记录,不重读文件。关闸时尾巴恒空 |
| `packages/onething-runtime/src/app/session/runs.ts` | `run/end` 的 fsync 检查点**之后**排一次 run 断言(`setTimeout(0)`,不在热路径);`run/start` 带上助手消息的 `timestamp` 与 `origin` |
| `packages/onething-runtime/src/app/engine/stream/history-shadow.ts` | 历史断言的接线(读门面 + `buildHistoryMessages` + `historyProjectionRecipe`)。**独立成文件**:recorder 只该依赖会话事件那一层,直接 import 会把整棵 store 树拖进它的模块图 |
| `packages/onething-runtime/src/app/session/assistant-parts.ts` | 缺口 3:图片生成流的 `assistant/part-end{kind:'image', blob}` 生产者 |
| `packages/onething-runtime/src/app/engine/stream/message-helpers.ts` | 导出 `prepareHistoryInputForModel` / `historyProjectionRecipe` —— 影子两侧走**同一条配方** |
| `packages/onething-runtime/src/sessions/history-messages.ts` | 导出 `onethingHistoryBuildRecipe`(注入给 core builder 的那四件套) |
| `packages/core/session/projection/canonical.ts` | S1b 的**判定口径**(见下表)+ `canonicalHistoryMessages`(历史断言的唯一判据,与 `canonicalChatMessage` 并排) |
| `packages/core/session/projection/{reducer,types,model-history,chat-messages}.ts` | 投影补齐:结构化工具结局、`startTime/endTime/durationMs`、`requiresConfirmation`、工具自报标题、`partialResult`、assistant 的 `origin`;`materializeModelHistory` 新增 `prepareMessages` / `providerDataFromContentPart` 两个宿主口 |
| `packages/core/session/events/types.ts` | `run/start.{timestamp,origin}`、`tool/result.resultData` |
| `scripts/session-shadow-report.mjs` / `session-shadow-reset.mjs` / `measure-shadow-overhead.mjs` | 门 / 归零 / 性能量测(三条 npm 脚本) |
| 测试 | `app/session/__tests__/shadow.test.ts`(10 条)、`shadow-report.test.ts`(4 条)、`event-translator.test.ts` 的 G11 端到端一条、`core/session/__tests__/projection-contract.test.ts` 的每条场景加一行历史指纹断言 |

#### 影子断言长什么样

- **run 断言**(`kind:'messages'`):`run/end` 落盘(fsync)之后排一个宏任务 ——
  取 `sessionReads.listMessages` 里属于这个 run 的消息(按 `ChatMessage.runId`,
  加上 `run/start.triggerMessageId` 那条),与活投影里同一批节点物化出来的那几条
  过 `canonicalChatMessage` 深比较。相等 `runs++`,不等写一行摘要 +
  `mismatches++` / `byKind.messages++`。
- **历史断言**(`kind:'history'`):写 `request/recipe` 的同一刻(= 这次请求真正
  发出之前)同步比一次 —— `buildHistoryMessages(listMessages, session)` vs
  `materializeModelHistory(活投影, meta, 同一条配方)`,两侧过
  `canonicalHistoryMessages` 比**字节**。
- **两条都永不抛进引擎**:全 try/catch 自吞,出错记 warn 并 `skipped`。
- **活投影**:每会话一份 `SessionProjectionState`。首次用时从文件同步折一遍,
  之后只折写入口尾巴里的新事件 —— 每次断言 O(新事件),不是 O(会话)。

#### 判定口径:S1b 新写死的"不等但不算数"

判据只有一条:**S2 拿投影那一份当真相之后,用户看到的东西会不会变?** 会变的
一格都不许豁免(工具结局的 metadata 就是这么补了采集点、而不是被丢掉的)。

| 字段 | 处置 | 证据 |
|---|---|---|
| `data-steps` content part | 丢 | G4:步骤面板的**渲染锚点**,位置由"这一轮有没有工具调用"算得出来(`planAgentLoopTurnContentPersistence`),不是正文 |
| `thinkingTime` | 丢 | G5 已裁定它是派生量。真机实测:投影算出 20ms,messages.jsonl 那条一格都没有 |
| step / toolCall 的 `timestamp` `startTime` `endTime` `receivedAt` `durationMs` | 丢 | 同一件事的两次读表。实测差 1~2ms(引擎 `Date.now()` vs `tool/call` 事件时刻)。**投影照旧产出**,只是不参与"是不是同一条消息" |
| toolCall 的 `argsFinalizedBy` | 丢 | 流式层诊断位;agent-loop 的 `AgentToolCall` 只有 `{id,name,arguments}`,事件面上没有采集点(见下方缺口表) |
| toolCall 的 `requiresConfirmation: false` | 丢(只留 `true`) | 与 `isStreaming` 同一条规则:false 与缺席是同一件事 |
| step 的 `partialResult` / `partialResultIsPartial` | 丢 | **持久化层自己写的判据**:`session-dehydrate.ts:127` 落盘时整格摘掉(注释原话 "A settled partialResult duplicates toolCall.result"),冷加载再由 `rehydrateSessionFromStorage` 算回来 —— 同一条消息在重启前后本来就不是同一个值 |
| `usage.durationMs` | 丢 | 一次流的墙钟量测,不是用量;事件侧按 `request/response.usage` 求和 |

#### 真机跑出来的 8 类不等,以及每一类是怎么修的

第一次把影子挂到真机上,一个 run 报了 **8 类** 不等(下表按修法分两组)。这一节
是这一期最该被读到的部分 —— 它证明这道断言不是恒真的。

**补采集点 / 补投影**(5 类,都是"事件里真的少了东西"):

1. **`toolCall.result` 只有正文,没有结构** —— 引擎那份是
   `{title, output, metadata}`(工具卡渲染的 diff hunks / 退出码 / 文件路径全在
   `metadata` 里),事件里只记了给模型看的那段文本。修:`tool/result.resultData`
   记结构化结局的 JSON(同一条 64KB 线,超过走 blob),投影拿它当
   `toolCall.result`。**这一格若被豁免掉,S2 切读之后每张工具卡都会退化成一段
   纯文本,而门是绿的。**
2. **step 标题不对**(`Tool: time` vs `Current time in Asia/Shanghai`)——
   工具自己 `annotate{title}` 报的标题压过派生标题(引擎的 `finalTitle` 就是这条
   规则)。修:投影从 `resultData.title` 取,取不到才 `generateStepTitle`。
3. **助手消息的 `origin` 丢了** —— 引擎把命令来源**同时**盖在用户消息与助手
   占位消息上(`core-stream-engine.ts` 的 `origin: cmd.origin`),而占位消息不经
   翻译器。修:`run/start.origin`。**不能从触发消息上"推"**:输入被插件改写过时
   用户那份多一枚 `inputTransformed` 戳,助手那份没有。
4. **助手消息 `timestamp` 差几毫秒** —— 占位消息先建、run 后开,投影却取的是
   事件写入时刻。修:`run/start.timestamp` 带上消息自己的时刻。
5. **`startTime` / `endTime` / `durationMs` / `requiresConfirmation` 一格都没有**
   —— 修:投影从 `tool/call` / `tool/result` 的时刻派生(S2 的工具卡要靠它显示
   "跑了多久"),同时把这几格写进上面那张"不参与比较"的表(它们是两次读表)。

**写进判定口径**(3 类,见上表):`data-steps` 锚点、`thinkingTime`、
`partialResult` / `usage.durationMs`。

修完之后同一个脚本 20 个 run 全绿。顺带落下的两条:`upsertMessage` 命中已有
那条现在走 `fullBody` 档(正文照旧带上;归约器仍对 assistant 节点剥掉正文三件套
—— 它的正文唯一来源是 chunks),`request/recipe.params` 由执行器从**定稿后**的
runtime 注入(温度 / maxTokens / thinking / reasoningEffort / toolChoice)。

#### 性能量测(`bun run sessions:shadow-overhead`)

一次回合 50 个工具调用,临时 store + 假 provider,探针是一段临时的 `--require`
前置脚本(fsync 计数 + 1ms 定时器的迟到量),**产品代码一行没为量测改过**:

| 数 | 影子开 | 影子关(`ONETHING_SESSION_SHADOW=0`) |
|---|---|---|
| `events.jsonl` | 154,061 B / 272 行(50 条 `tool/call`) | 154,063 B / 272 行 |
| fsync 次数 | 55 | 55 |
| 端到端墙钟 | 425~442 ms | 420~563 ms |
| 主线程最长阻塞 | 40 / 44 / 58 / 60 ms | 35 / 39 / 43 / 46 / 106 ms |

结论三条:

1. **影子不写 `events.jsonl`、不加 fsync**(两列逐字节相同),墙钟差落在噪声里
   (多次量测里"关"甚至比"开"慢)。
2. **影子自己的开销直接量过**(临时打点):run 断言 **5ms**(一个 run 一次,而且
   排在 `setTimeout(0)` 里),历史断言 **1ms/请求**。
3. **`< 16ms` 这道门没过,但欠账不是影子的**。关闸那一列同样 35~106ms,而且
   1 / 5 / 50 个工具调用三档下都是同一个量级(39 / 29 / 44 ms)——
   不随工具数增长。最长阻塞发生在**回合的尾部**(量测窗口的 +480ms 附近,
   回合总长 ~430ms),即消息定稿/落盘那一段,与影子无关。这是一条**既有**的
   引擎账,记在这里等它的主人;S1b 该负的那部分(6ms)已经量清楚了。

#### 仍然敞着的缺口(S2 之前必须有答案)

| # | 缺口 | 现状 |
|---|---|---|
| 1 | `tool/call.parentCallId` **仍然没有生产者** | 两条可能的来源都堵着:①工具内部的子步骤走 `onStepStart`(那是**渲染用的 Step**,不是工具调用,事件面上没有它);②Claude Code 子代理的调用带 `parent_tool_use_id`,但连接器按既有约定**整条丢弃**(`claude-code-connector.ts:953`,"父 Task 调用已经代表它了")。要么改这两条之一的行为,要么这一格永远是平铺 —— 属于行为裁定,不在影子期自作主张 |
| 2 | `argsFinalizedBy` 没有采集点 | agent-loop 的 `AgentToolCall` 只有 `{id, name, arguments}`;这一位住在 `core/engine/stream-processor.ts` 的流式层。已写进"不参与比较" |
| 3 | `providerResponseId` / `responseModel` 仍然只认 `provider-data` 里的 `responseId`/`id`/`model` | 查过一遍:**没有一家 agent-loop provider 自报响应 id**(`agent-loop/providers/*` 里一处都没有;`providers/codex.ts` 的 `response-metadata` 是另一条老链)。不猜就是不填 —— 要补得先在 provider 适配层加一次上报 |
| 4 | `contentParts` 里的 `provider-data` part 没有生产者 | 加密推理那一格(claude / codex 会有)。事件的 `SessionAssistantPartKind` 只有 text/reasoning/tool-input/image,加一格是改 §9.2 的定稿事件全集,要先拍板。**在此之前,claude/codex 会话的影子会照实报不等** —— 这是对的,不是 bug |
| 5 | 图片生成回合的消息断言**会报不等** | `assistant/part-end{kind:'image'}` 已经有生产者(blob + 引用),但 messages.jsonl 那条的正文是**一段内嵌 base64 data URL 的 markdown 文本**(`ContentPart` 里根本没有 image 成员)。于是投影多一格 image part、少那段 markdown。**故意不掩盖**:把它豁免掉等于让 S2 切读之后图片正文凭空消失而门是绿的。收口(记 markdown 正文 vs 让渲染层认 image part)是 S2 的读路径裁定 |
| 6 | 老会话(只有 E0 七类)的 surface 是空的 | 同 S1a:它们的消息事实还在 `messages.jsonl` 里,S2 的迁移脚本才把它们变成 `message/imported`。影子对它们返回 `skipped`(不记账,也不误报) |
| 7 | 影子的模块边界 | `runs.ts → shadow.ts → reads.js → stores/*` 这条边让"只 mock `stores/paths`"的单测炸掉(`session-chunk-packer.test.ts` 因此就地 mock 掉 shadow)。S2 切读时这条边会消失(读门面自己就是投影),现在不为它加一层端口 |
| 8 | `flushSessionEventLog` 每次开一次文件句柄做 fsync | 量到了:一个 50 工具调用的回合 55 次,而最长阻塞与它无关(fsync 走的是 `fs.promises`,不占主线程)。维持现状 |
