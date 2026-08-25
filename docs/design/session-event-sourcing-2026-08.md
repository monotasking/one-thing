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
| B8 | **迁移输入集合与回滚未定义** | 未覆盖 `segments.jsonl`(66)、`messages.cleared-*.jsonl`(~90)、`agent-dm-*` 非 uuid 会话、1 个 `sessions/<id>.json`、`legacy-backup/` 276MB、`onething.sqlite` 同步副本、meta.json 字段合成事件的假时间戳;"就地作快照"与"备份到 legacy-backup"矛盾;无 `StoreLock` 检查;影子期 events 与迁移出的 `message/imported` 的 seq 对齐未写;无 `sessions:rollback` | 脚本需白名单 + 未知文件清单 + 运行中检测(无活 core 硬检查;~~lock owner `migrate`~~ 2026-08-24 裁定不引入锁)+ dry-run + 重编号 + 回滚命令 |

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

---

### 10.9 真机第一天:两类 mismatch 的修复(2026-08-20)

**门**(逐字):`bun run typecheck` 只剩 `spaces/__tests__/provider-dials.test.ts`
的 3 条既有错;`ONETHING_SESSION_FREEZE=1 bun run test`(按目录分四批跑,合计
1141 个文件)**10957 passed / 2 failed / 8 skipped** —— 2 条是既有的
`ui-token-vars.test.ts`,外加 1 条既有 unhandled rejection
(`AIProviderTab.interaction.test.ts`);`session:gate` **0**(none new);
`boundary:gate` 绿(13 known,none new);`log:gate` 绿(4 known,none new);
`lint:ci` **334**(与基线同数);`server:build` 通过;
`sessions:shadow-report --min-runs 1`(**临时 store**)→ `runs 3 / mismatches 0 /
appendFailures 0 / skipped {"legacyPartial":2}`,**GATE GREEN**。

影子开着跑完第一天,`~/.onething/log/session-shadow.jsonl` 攒下 **12 行不等**
(`runs: 0`,`byKind: {history: 10, messages: 2}`)。两类,**一类是断言问的问题不对,
一类是投影真的错了**。

#### 类别 1(10 行,`kind:'history'`):断言问了一个老会话答不上来的问题

全部来自同一条会话 `fd899977…`,diff 永远是同一句:`.length` **A 101 / B 1**,
后面 100 条清一色 `b: "(absent)"`。

这条会话建于 S1a 之前。它的 `events.jsonl` 第一条是 `request/tools`(不是
`session/created`)—— 事件日志是从升级那一刻才开始写的,**只覆盖了历史的一段
尾巴**。拿它去比"整段模型历史",投影侧当然只有今天这一轮:那不是投影错了,
是**没有可比的东西**。§10.7 缺口表第 6 条已经预判过"老会话 surface 是空的",
但只处理了 `nodes.length === 0` 这个极端;**部分覆盖**这一档漏了。

**改法**(`app/session/shadow.ts`):历史断言在比之前先问一句"这条会话的事件覆盖
全吗" —— 判据是 **messages.jsonl 里有、投影的 `byMessageId` 不认识的消息 id**
(比"第一条事件是不是 `session/created`"更直接:后者只认得出"从中间开始",
认不出"中间掉了一段")。覆盖不全就跳过,计一次
`skipped.legacyPartial`。判定每会话只做一次并缓存 `true`(事件只增不减,一条
会话一旦覆盖不全就永远是);判成完整的每次重算 —— 那正是这道断言要盯的东西,
不能缓存掉。

**run 断言照常跑**:一个 run 自己的那几条消息**是**事件覆盖的(用户刚发的那条
和这次生成的那条都在今天的事件里),老会话上它一样有效 —— 真机上那 2 行
`kind:'messages'` 里就有一行来自这条老会话,而它抓到的是下面的类别 2,是真 bug。
唯一的例外是**触发消息比事件还老**(对一条老消息 retry / edit-resend):事实侧
有它、投影侧没有,同样按 `legacyPartial` 跳过。

`skipped` 是 `session-shadow-stats.json` 的新一格(`Record<string, number>`),
`sessions:shadow-report` 打印它。**跳过 ≠ 不等**:门(`runs ≥ 200 ∧ mismatches = 0
∧ appendFailures = 0`)一格不动 —— 跳过的是"没有可比的东西",不是"比出来不等"。

> **老会话在迁移之前不进历史影子。** 它们的消息事实仍在 `messages.jsonl` 里,
> S2b 的迁移脚本把它们变成 `message/imported` 之后,这道断言自然重新覆盖它们
> (那时 `byMessageId` 就认识全部消息了,不需要再改代码)。

#### 类别 2(2 行,`kind:'messages'`):投影把 reasoning 多物化了一格 —— 真 bug

diff 是 `contentParts.length` **A 1 / B 2**,且 B 的第 0 格是推理正文、后面每一格
整体后移一位(A 的 11 格 vs B 的 12 格,`turnIndex` 跟着错位)。

根因:**引擎的推理有两个落点,投影只认得一个**。判据在
`core/engine/agent-loop-executor.ts` 的 `getAgentLoopReasoningPlacement`:

| placement | 条件 | 引擎的落点 |
|---|---|---|
| `'top'` | 第 1 轮请求、且此前这次执行还没产出过正文 / 工具调用 / 可见 part | `updateMessageReasoning` → **`message.reasoning` 字段**,不进 contentParts |
| `'inline'` | 其余全部(工具回来之后的第 2 轮推理、turn 1 里正文之后又冒出来的推理) | `appendOrderedPart` → **`contentParts` 里一格 `reasoning`** |

投影侧 `materializeContentParts` 把**所有** reasoning part 都物化成 contentPart,
`materializePartText(node,'reasoning')` 又把**所有** reasoning 文本塞进
`message.reasoning` 字段 —— 两个落点合成了一个,于是每条带推理的助手消息都比
事实多一格,后面的 part 整体错位。

**改法**(`core/session/projection/`):

- `reducer.ts` 新增 `topReasoningPartIndexes(run)`:按 `partIndex` 排序后**开头
  那一串连续的 reasoning 段**(且 `turnIndex === 1`)就是 `'top'`。这条等价成立
  是因为 recorder 的 `deltaInto` **换 kind 就换段**(`session-event-recorder.ts`):
  turn 1 里正文之后又冒出来的推理会拿到一个**新的、更大的** partIndex,不会跟
  开头那段合并;
- `materializeContentParts` 跳过这些 partIndex;
- 新增 `materializeTopReasoning(run)`,`chat-messages.ts` 的 `reasoning` 字段改用它
  (从前是全部推理的 fold —— 多轮推理的会话那一格也是错的,只是被 diff 的
  `DIFF_MAX_ENTRIES` 截掉没露头)。

**recorder 与 partIndex 复核过,没有问题**:真机 `8b74a9f7…` 那一轮的事件是
`partIndex 0 = reasoning` / `partIndex 1 = text`,`request/response.parts` 逐格对得上;
排掉 top 那一格之后,投影的 contentParts 下标与引擎的逐格一致。S1a 的采集面
不用改。

#### 合同测试为什么没抓到:fixture 和投影一起错

§9.5 的"带 reasoning"场景一直是绿的 —— 因为 A 线的构造器
(`projection-contract.test.ts` 的 `applyTurnCommands`)**每段推理都同时**
`patchMessage{reasoning}` **和** `appendContentPart{type:'reasoning'}`。
两边错成同一个样子,合同测试就成了恒真。

修法是让 A 线照抄引擎的落点规则(而不是让 B 线迁就 A 线):按
`turnIndex === 1 && text.length === 0 && toolCalls.length === 0` 分流,`'top'` 只写
字段、`'inline'` 只写 part。另加一条场景
**`reasoning has two landing spots`**(turn 1 推理→正文→工具,turn 2 推理→正文)
—— 这正是 `fd899977…` 那条 diff 的最小复现。回退投影的修复,这两条当场变红。

`canonicalChatMessage` 没有遮盖:它从来不丢 `reasoning`,也不排序 `contentParts`
(§9.7 判例 10 明确写死"contentParts 的顺序就是正文本身")—— 所以错位一露头就
被抓住了。真正掩盖它的是 fixture。

#### 门(真机自证,临时 store)

`scratchpad/s1b-mismatch-fix.mjs`:临时 store + 会吐 `reasoning_content` 的假
provider,两个场景各跑一遍。

- **(a) 全新会话**:parts = `0:reasoning 2:tool-input 1:text 3:reasoning 4:text`;
  `message.reasoning = "first I think about it"`(top),
  `contentParts = [text, data-steps, reasoning, text]`(inline 那格在)——
  **两个落点都走到**,`mismatches: 0`,`runs: 1`。
- **(b) 模拟老会话**:先正常跑一个回合,停机,往 `messages.jsonl` **前面**塞 4 条
  "升级之前"的老消息(events.jsonl 一条都不覆盖它们),重启再发一个回合 ——
  6 条消息全部读回,历史断言 `skipped.legacyPartial: 2`,run 断言照常
  `runs 2 → 3`,`mismatches: 0`。
- `sessions:shadow-report --min-runs 1` → `runs 3 / mismatches 0 /
  appendFailures 0 / skipped {"legacyPartial":2}`,**GATE GREEN**。

真实 store 的 `session-shadow.jsonl` / `-stats.json` **没有动**(只读)。
`sessions:shadow-reset` 归零由用户自己决定什么时候跑 —— 那 12 行是这次修复的证据。

#### 交付

| 文件 | 改动 |
|---|---|
| `packages/core/session/projection/reducer.ts` | 新增 `topReasoningPartIndexes` / `materializeTopReasoning`;`materializeContentParts` 跳过 top 推理段 |
| `packages/core/session/projection/chat-messages.ts` | `reasoning` 字段改用 `materializeTopReasoning` |
| `packages/onething-runtime/src/app/session/shadow.ts` | `sessionEventCoverageIsPartial`(+ 每会话缓存与 `resetSessionShadowCoverageCache`);历史断言与"触发消息更老"两处按 `legacyPartial` 跳过 |
| `packages/onething-runtime/src/app/session/event-stats.ts` | `SessionShadowStats.skipped: Record<string, number>` |
| `scripts/session-shadow-report.mjs` | 读并打印 `skipped`(不进门) |
| `packages/core/session/__tests__/projection-contract.test.ts` | A 线按引擎的落点规则分流;"带 reasoning" 加断 contentParts;新增场景 `reasoning has two landing spots` |
| `packages/onething-runtime/src/app/session/__tests__/shadow.test.ts` | 新增两组:真机形状的两落点 run(class 2)、老会话的跳过/不跳过三条(class 1) |
---

## 11. S2 规格(2026-08-20):读切换(分两半;前半不改默认行为)

S1a/S1b 已提交(be0a7cb9 / 5a7b875b),真机影子门绿。S2 把读路径建到事件上。**按用户要求夜间只做 S2a**:一切在开关之后,默认仍读 `messages.jsonl`;切默认与真实 store 迁移(S2b)等用户拍。

### 11.1 S2a(开关后,默认关)
- 开关:`ONETHING_SESSION_READ = 'messages'(默认) | 'events'`,单一入口 `app/session/read-mode.ts`;测试可临时切。
- **事件倒读 pager**(§3.2):`core/session/storage/events/` 纯函数:从文件尾按 chunk 倒读 → 逐行 decode → 按 surface 规则(先遇 replace 先遮蔽)fold → 攒够 N 条消息边界即停;游标 `{eventSeq, fileOffset}`;`hasMoreBefore = offset > headerEnd`;跳转(按 messageId / eventSeq)首次正向扫建**内存** id→{seq,offset} 索引(每会话一次,不落盘)。app 层 `sessionReads.pageMessages/listUserMarkers/getMessage/...` 在 `events` 模式下走它;`listMessages`(引擎激活全量)在 `events` 模式下 = 全量 fold(复用 S1 的活投影缓存,已在内存就不读文件)。
- `ChatMessage.seq` → 在 `events` 模式下填 `eventSeq`(投影节点的首个事件 seq),pager 游标/`hasMoreAfter` 语义按 seq 重写;`messages` 模式不变。
- **`prepare`**(冷加载合成收尾,§3.1 采纳):`app/session/prepare.ts`:打开会话时扫未闭合的 run(有 `run/start` 无 `run/end`)→ 合成 aborted `tool/result`(对无 result 的 call)+ `run/end{outcome:'interrupted'}`,**只提交一次**(幂等:再次 prepare 无事可做);两种模式下都跑(`messages` 模式下它只补事件账本,不动消息——因为 `sanitizeSessionOnStartup` 仍在管消息)。
- **`sessions:verify <id>|--all`**:全量 fold + surface 校验 + seq 连续 + blob 引用完整 + (有 messages.jsonl 时)canonical 对比,输出报告;只读。
- **迁移脚本 `scripts/migrate-sessions-events.mjs`,本期只实现 `--dry-run`**:白名单输入(`messages.jsonl`/`meta.json`/`events.jsonl`/`segments.jsonl`/`messages.cleared-*.jsonl`/`legacy-backup/`/`<id>.json` legacy/`agent-dm-*`),未知文件清单,每会话 before/after 字节与事件数估算,合成 `message/imported` 的规则(从 messages.jsonl 逐条 imported,时间戳用消息 timestamp,`synthetic:true`;已有 events.jsonl 的会话:把 imported 插在现有事件**之前**并整体重编号 → 本期只算不写);`StoreLock`/运行中检测(发现文件 + 桌面进程)只检测不执行;`--apply` 明确拒绝("S2b 未拍板")。
- 门:`events` 模式下跑现有 session/pager 测试套件(参数化两种模式);S0 合同测试的每个场景再加"倒读 pager 分页 N 条 ≡ 全量 fold 取尾 N 条";真机脚本(临时 store,假 provider):5 轮对话后 `events` 模式下 `pageMessages(tail 40)` 与 `messages` 模式结果 canonical 相等;`prepare` 对人为截断的 events.jsonl 合成收尾且二次幂等;`verify --all` 对临时 store 全绿;迁移 `--dry-run` 对**真实 `~/.onething` 只读**跑通并打印汇总(不写任何文件)。

### 11.2 S2b(待用户拍板,本期不做)
切默认 `ONETHING_SESSION_READ=events`;`--apply` 迁移真实 store(备份到 `legacy-backup/`);`messages.jsonl` 退役为只读遗留;`sanitizeSessionOnStartup` 退役由 `prepare` 接管;性能门(48MB 会话首屏 ±10%、翻页 p95 ≤50ms)。

---

### 11.3 S2a 落地记录(2026-08-20)

**门**(逐字):`bun run typecheck` 只剩 `spaces/__tests__/provider-dials.test.ts`
的 3 条既有错(`typecheck:web` 单独跑过,零错);
`ONETHING_SESSION_FREEZE=1 bun run test` **10874 passed / 2 failed**(两条既有
`ui-token-vars.test.ts`)+ 1 条既有 unhandled rejection
(`AIProviderTab.interaction.test.ts`);`session:gate` **0**(none new);
`boundary:gate` 绿(13 known,none new);`lint:ci` **334**(与基线同数,新增文件
零命中);`server:build` 通过;
`bun run sessions:shadow-report --min-runs 20` 在**两种读模式下各跑一遍**都是
**runs 20 / mismatches 0 / appendFailures 0,GATE GREEN**;
`bun run sessions:verify --all` 对那两个临时 store 全绿。

**默认没变**:`ONETHING_SESSION_READ` 缺省 `messages`,一切新读路径在开关之后。

#### 交付

| 文件 | 角色 |
|---|---|
| `packages/core/session/storage/events/pager.ts` | **倒读 pager**(纯函数,fs 由调用方注入):按块倒读/正读逐行、`foldEventPageBackward`/`Forward`、`pageEventMessages`(游标 `{sessionId,seq,includeAnchor,offset}`)、`buildSessionEventJumpIndex`(内存 id→{seq,offset})、`listEventUserMessageMarkers` |
| `packages/onething-runtime/src/app/session/read-mode.ts` | 开关单一入口(`ONETHING_SESSION_READ`,默认 `messages`,`setSessionReadModeForTesting` 供测试临时切) |
| `packages/onething-runtime/src/app/session/projection-cache.ts` | 活投影**从 `shadow.ts` 提出来共用**(见下方裁定 1) |
| `packages/onething-runtime/src/app/session/events-reads.ts` | `events` 模式的七个读实现 + `events.jsonl` 的字节面(fs 适配器)+ 跳转索引缓存 |
| `packages/onething-runtime/src/app/session/prepare.ts` | 冷加载收尾合成(尾部窗口扫未闭合 run → aborted `tool/result` + `run/end{interrupted}`) |
| `packages/onething-runtime/src/app/session/reads.ts` | 七个方法各加一行按模式的岔口;`fromEvents()` 出错就退回消息模式(读路径不许因为新路炸掉) |
| `packages/onething-runtime/src/app/session/event-log.ts` | 写尾巴的闸从"影子开着吗"放大成"内存里有没有消费者"(影子 **或** events 读模式) |
| `packages/onething-runtime/src/app/session/runs.ts` | `beginSessionRun` 开头调一次 `prepareSessionEventsOnce` |
| `scripts/session-verify.ts`(`bun run sessions:verify`) | 只读自证:seq 连续 / surface 校验 / 能折出投影 / blob 引用完整 / 未闭合 run(全量)/ 与 messages.jsonl 的 id 序列对照 |
| `scripts/migrate-sessions-events.mjs`(`bun run migrate:sessions:events`) | **只有 `--dry-run`**;`--apply` 退出码 2("S2b 未拍板") |
| 测试 | `core/session/__tests__/event-pager.test.ts`(14 条)、`projection-contract.test.ts` 每条场景加一行"倒读一页 ≡ 全量 fold 取尾一页"、`app/session/__tests__/events-reads.test.ts`(10 条,七个读**参数化两种模式**)、`prepare.test.ts`(7 条)、`session-verify.test.ts`(10 条,两个脚本) |

#### 倒读为什么是安全的(这一期最该被读到的一段)

事件日志纯追加,于是有一条铁的时序:**任何"让一条消息不再显示"的事件,一定
晚于那条消息自己的事件**。所以对任意后缀 `[k, EOF]`,落在后缀里的节点,它的
全部遮蔽事件也在后缀里 —— 折这一段得到的 `hidden` 与折整份文件**相同**。
"分页 N 条 ≡ 全量 fold 取尾 N 条"就是从这条不变量来的,不是巧合。

三个例外必须显式处理,否则这条不变量当场破:

1. **`user/message-edited`** 遮蔽的是"被编辑那条(含)到它自己"的一整段,而
   被编辑那条可能在窗口之外。倒读时遇到它就把 messageId 记进
   `pendingEditTargets`,**没找到之前不许停**。朴素实现(攒够 N 条就停)会把
   本该消失的消息照旧显示出来 —— `event-pager.test.ts` 那条"编辑目标远在尾巴
   之前"就是钉这一条的;
2. **`session/cleared`** 遮蔽它之前的一切:遇到它就是**头**,收工(再往前读
   一个字节都没有意义);
3. **`message/deleted`** 只遮蔽一条,那条若在窗口外,本来也不在这一页里。

#### 口径裁定(原文没写死的地方)

1. **活投影只能有一份**。S1b 的活投影是 `shadow.ts` 的私有物,S2a 的读路径也
   要它 —— 而写入口那条尾巴(`drainSessionLogEventTail`)是**取走式**的:两份
   缓存会互相偷走对方的记录,两边的投影都缺一段。所以提成
   `projection-cache.ts`,`shadow.ts` 只留两个转发名字。
2. **`totalCount` 只在真的数得出来时才给**。事件坐标不是位置,`hasMoreAfter =
   seq < totalCount` 那个比较在这里没有意义;而为了一个计数把 48MB 全扫一遍
   正是 §3.2 拒绝的事。所以:整份文件都折过了(尾页读到头)才填 `totalCount`,
   否则缺席 —— renderer 本来就以 `hasMoreBefore` 为准(`MessageList.vue:657`
   的注释原话)。
3. **`pageMessages` 有冷热两条路**。活投影已经在内存里就直接从它分页(更准也
   更便宜);没有才走文件 pager,而且**文件 pager 不建活投影** —— 建了的话
   "不整份加载"这句话当场作废。两条路的结果逐字段相同,测试互比。
4. **老会话必须原样退回消息模式**。只有 E0 七类的会话折出来是零个节点,那是
   **对的**(它们的历史事实还在 `messages.jsonl` 里,要等 S2b 的迁移)。所以
   events 模式的每个入口在"折不出任何消息"时返回 `undefined`,由 `reads.ts`
   退回原路。不是兜底,是事实所在处不同。
5. **`prepare` 只扫尾巴,不扫全量**。一次进程死亡只会留下**它最后那条** run
   未闭合,而 prepare 每次打开会话都跑;全量扫等于每次开会话都读一遍整份日志。
   倒读因此在**第一条完整闭合的 run**(先遇 `run/end`、再遇它自己的 `run/start`)
   处收手 —— 那时手上开着的那些 run 都已扫全(它们的 `tool/call` 一定晚于自己
   的 `run/start`),常见情形下只读约一个半回合;另有 4MB 硬窗口兜底。结果里
   `stoppedAt: 'head' | 'closed-run' | 'window'` 自报停在哪。窗口/边界之外万一
   真有更老的残留,`sessions:verify` 会**全量**扫出来并报告 —— 不会静默丢掉。
6. **`prepare` 不反过来依赖 run 登记处**。它靠的是**调用点**:两个入口
   (`beginSessionRun` 的开头、活投影第一次建起来之前)都排在这条会话的任何
   一次执行之前,而 `prepareSessionEventsOnce` 每进程每会话只真的跑一次。
   依赖 `currentSessionRun` 会把 prepare 拖进 `runs → shadow → reads` 那个环
   (S1b 缺口 7 记的正是它)。
7. **进程内还要记得自己刚做过什么**。合成的 `run/end` 是排队异步落盘的,所以
   紧接着的第二次扫描很可能仍看到那条 run 开着 —— 真机脚本第一版就这样给同一个
   runId 写了两条 `run/end`。账本的幂等是**跨进程**口径;进程内由
   `closedRuns` 表兜住。
8. **写尾巴的闸放大了**:从"影子开着吗"变成"内存里有没有消费者"(影子 **或**
   events 读模式)。两条都关时尾巴仍然恒空 —— 一条永远没人取的队列只会吃内存。
9. **迁移 dry-run 只打 stdout**。真实 store 上跑它必须一个字节都不写,连日志
   都不许落进去(用例 `writes nothing at all` 钉住;真机跑完用
   `find -newermt` 复核过,零文件被改动)。

#### 性能量测(合成 fixture,字节是真的)

`scripts/__s2a-perf.ts`(临时脚本,已移出仓库):每回合 9 条事件、正文 1.2KB
× 3 段、带一次工具调用与一份 3.6KB 结果。中位数(3 次):

| fixture | 尾页(40 条) | 再往上翻一页 | 全量 fold | 冷建跳转索引 | 整文件读一遍(基线) |
|---|---|---|---|---|---|
| 2000 回合 / 18000 事件 / **19.1MB** / 4000 消息 | **2.1ms** | 1.8ms | 32.0ms | 53.5ms | 3.3ms |
| 5000 回合 / 45000 事件 / **47.9MB** / 10000 消息 | **1.3ms** | 1.2ms | 67.4ms | 87.1ms | 6.7ms |

两条结论:①尾页与文件大小**无关**(它只读末尾那几个块),48MB 会话上比"把
文件整读一遍"还快 5 倍;②全量 fold 是 O(文件),67ms/48MB —— 与今天
`loadJsonl` 同量级(§3.2 的判据),而它每会话只发生一次(活投影缓存)。
S2b 的性能门(首屏 ±10%、翻页 p95 ≤50ms)按这两行看是宽裕的,但**真机 48MB
会话的首屏还没量过** —— 上表是合成 fixture。

真机(临时 store + 假 provider,5 轮对话):`messages` 模式 3.9ms /
`events` 冷路 pager 3.3ms / 全量 fold 2.1ms,三者投影出的尾 40 条
`canonicalChatMessage` **逐字节相等**。

#### 迁移 `--dry-run` 对真实 `~/.onething` 的一次只读跑(汇总)

- 会话目录 **408** 间,legacy 整文件 **1** 份;
- 合成 `message/imported` **8563** 条;已有事件 2165 条,其中 **5** 间会话要重编号;
- `events.jsonl` 字节 **1.1MB → 347.8MB**(`messages.jsonl` 现为 346.0MB);
- 不认识的文件 **13** 个:1 个 `sessions/.DS_Store` + 12 个
  `.meta.json.<pid>.<ts>.<n>.tmp` 残留(原子写留下的临时文件)。迁移不会碰它们,
  但**它们本身是一条既有的清理欠账**;
- run 检测:`run/backend.lock` 存在但进程已不在(陈旧锁),没有人拿着这个 store;
- 复核:跑完用 `find ~/.onething -newermt` 查过,**零文件被改动**。

`bun run sessions:verify --all` 对真实 store 也跑过一遍(同样只读,零文件被改动):
**408 间会话全绿** —— 其中绝大多数是"事件里还没有历史"(只有 E0 七类或空),
那不是错,是等着 S2b 迁移的状态。

#### S2b 必须决定的事

| # | 待决 | 现状 / 影响 |
|---|---|---|
| 1 | **切默认读模式** | `ONETHING_SESSION_READ=events` 变默认 —— 用户拍板项,本期一行没动 |
| 2 | **`--apply` 迁移真实 store** | 脚本拒绝执行。真跑之前还要定:备份策略(`legacy-backup/`)、迁移期间禁止写入(**不用锁** —— 2026-08-24 裁定:查发现文件 + 进程探测的"无活 core 硬检查",见 §14.6 裁定 3)、347MB 的写入要不要分批 |
| 3 | **深翻页时"更晚的遮蔽事件"看不见** | 带游标往上翻只扫游标之前的字节,所以"很久以前的消息在今天被删掉了"在深翻页时会照旧显示。首屏(从 EOF 倒读)永远准,活投影在内存里时也准。要么接受,要么让游标带上一个有界的 hidden 集合 |
| 4 | **`totalCount` 在大会话上缺席** | 见裁定 2。UI 的"上面还有 N 条"在大会话上会退成"已加载条数";要精确就得付一次全量扫 |
| 5 | **读门面里还有四个方法没路由** | `sliceForHistory` / `findMessage` / `iterateMessages` / `firstUserPreview` 仍走 `getSessionMessages`(§11.1 只点名了七个)。其中 `sliceForHistory` 是模型历史的取数口 —— 它的事件版落点是 `projectModelHistory`,不是"再抄一遍投影",所以留给 S2b 一并接 |
| 6 | **`pageMessages` 的其它调用点还没走读门面** | `apps/electron/src/main/ipc/sessions.ts` 与 `app/server/runtime.ts` 直接调 `store.getSessionMessagesPage`,不经 `sessionReads` —— 开关对它们无效(这是 P0.2 留下的口子,不是 S2a 新开的)。切默认之前必须收口 |
| 7 | **图片回合的正文形态** | S1b 缺口 5 原样敞着:messages.jsonl 那条是内嵌 base64 的 markdown,投影是一格 image part。切读之后渲染层认哪一种,是 S2b 的读路径裁定 |
| 8 | **`sanitizeSessionOnStartup` 的退役** | 今天 `prepare` 只补事件账本,消息那边仍由它管。两者的收尾口径要不要合并成一条 |
| 9 | **`.meta.json.*.tmp` 残留** | 真实 store 里 12 个(见上)。迁移白名单把它们列为"不认识",但清理它们是另一件事 |

## 12. S3 规格与落地记录(2026-08-20):只读查询面

S3 是**读**的一期,但它与 S2 的"切读"是两件事:S2 换的是产品行为的事实来源
(聊天区读哪份),S3 只是把已经写下来的账**读给人看**。因此它不依赖 read mode ——
S1a/S1b 起事件就一直在写,不管默认读的是哪边,查询面都有完整的料。这也是它能在
S2 还没切默认的时候先落地的原因。

### 12.1 一个装配器,三个出口

设计文本(`logging-system-2026-08.md` §2.7.5)把装配器放在
`packages/onething-runtime/src/sessions/trace.ts`。**落地时上移到了 core**:

| | 位置 | 为什么 |
| --- | --- | --- |
| 装配器(纯) | `packages/core/session/trace/assemble.ts` | 事件词表与两个投影已经住在 core(S0 的判例),装配器是同一批事实的第三种排法。放 runtime 会让 renderer 只能靠 `export type` 擦除去引它的形状,而 S3 的形状是要给面板**用**的 |
| 读实现 | `packages/onething-runtime/src/app/session/trace.ts` | 只负责"从哪拿事件":文件 vs 活投影 |
| RPC | `sessionEvents` 域加两个方法 `getTrace` / `getResponseText` | 不新开域:轨迹面板已经骑在这个域上,加方法 = router 一行 + handler 一段,四个壳零改动 |
| HTTP | **没有专用 REST 路由** —— `POST /api/rpc` 一条通用路由,body 是 `{domain:'sessionEvents', method:'getTrace'|'getResponseText', payload}` | 见 §12.1.1 |
| CLI | `onething trace <sessionId> [--run <id>|--last] [--json] [--response <k>]` | **不经 daemon**(第二个这样的 scope,前一个是 `plugin`):轨迹的事实是一个纯追加文件,读它不该要求引擎活着 —— 排障时引擎往往正是那个起不来的东西 |

#### 12.1.1 为什么 HTTP 侧没有 `GET /api/sessions/:id/trace`

初稿(本期第一版实现)按 `logging-system-2026-08.md` §2.7.5 的字面往
`app/server/http.ts` 加了两条手写 REST 路由。**评审当场退回,已删除** ——
理由是结构性的,不是风格:

- `sessionEvents` 的两个 router 方法**已经**给了 web 侧完整的能力,走的是
  T0 立下的通用 RPC 单路由。再加一条 REST 等于同一份树有两个出口、两套入参
  消毒、两处会漂移的错误口径;
- `transport:gate` 量的正是 `http.ts` 的**行数**,而它量这个就是为了挡住
  "加功能顺手加条手写路由"。基线 1989、`http.ts` 早已 2027 —— 在一把已经红着的
  尺子上再加 32 行,是把债做实,不是维持现状;
- 脚本 / curl 一侧没有损失:一条 `POST /api/rpc` 带 `{domain, method, payload}`
  和一条 GET 一样能用,而且**多域共用同一条**。

于是纪律落成一句:**加功能走 router 域,不再往 `http.ts` 加手写通道。**
删完之后 `http.ts` 与 HEAD 逐字节相同(`git diff` 为空),
`transport:gate` 上 `http.ts` 那一格回到 2027 —— 本期对它的净贡献是 **0**。

拒绝的表现形式因此也变了:路径形态的 sessionId 由**域自己的门**
(`isSafeSessionId`)挡下,RPC 通道永远回 200 信封,拒绝是 `data.trace === null`,
不是一个 HTTP 状态码。真机脚本按这个口径断言。

树的形状:

```
SessionTrace
└─ SessionTraceRun(key, runId, synthetic, kind, agentId, trigger.preview,
   │               provider/model, outcome, error, startTime/endTime)
   └─ SessionTraceRequest(requestIndex, startSeq, provider/model/systemPromptHash/
      │                   toolsHash/toolCount/recipeMessageCount, startTime/
      │                   firstTokenTime/endTime, usage, finishReason, parts[], errors[])
      └─ SessionTraceToolCall(callId, name, argumentsRaw, callTime/resultTime,
                              resultPreview | resultRef, audit{effects/decision/asked/
                              outcome}, permission{approved/reason})
SessionTrace.compactions[]   ← 压缩发生在 run 之外,是会话级的一行
```

### 12.2 四条纪律(装配器文件头逐条钉着)

1. **只记时刻,时长现算**。树上一个 `duration` 字段都没有 —— CLI 的
   `+340ms`、面板的 `2.4s` 都是两个时刻相减。真机脚本里有一条
   `!/"duration/i.test(JSON.stringify(trace))` 的断言。
2. **正文不进树**。响应正文的唯一来源仍是 `assistant/chunks` 的 fold;树上只有各
   part 的 `{kind, len, hash}`。要正文就调 `materializeTraceResponseText` /
   `getResponseText` / `--response k`。带正文的树在 CLI 上刷爆终端,在 HTTP 上把
   一次列表请求变成几 MB。
3. **没有账就是没有账**。拿不到的格子一律缺席,不用 `0` / `''` 冒充"量到了但是零"
   (与轨迹面板的 `unavailable` 同一条)。
4. **老文件不编 runId**。只有 E0 七类的会话没有 `run/start`,按
   `request/start.messageId`(助手那条消息的 id)合成分组,`key` 是
   `legacy:<messageId>`、`runId` 留空串、`synthetic: true` 如实标出。

### 12.3 分组判据(三档),与真机上找出的那个坑

```
1. data.runId                        → 真 run
2. data.messageId
   ├─ 命中 run/start 的 assistantMessageId → 那个真 run
   └─ 没命中                                → legacy:<messageId>(合成组)
3. 两样都没有                         → "当时开着的那一组"
```

第二档里那一次查表**是真机逼出来的**:S3 首跑时
`GET /api/sessions/:id/trace?last=1` 返回了 `totalRuns: 2`,第二棵是一个
`runId: ''`、`requests: []` 的空组。原因是采集点**并不齐** ——
`tool/audit` 只带 `messageId`,没有 `runId`(真机 27 条事件里唯一的一条),
于是装配器为它凭空开了一棵 run。查表之后它归位到自己的 run;查不到的
messageId(迁移当天那种混合文件里的老事件)仍然自成一个 legacy 组,
**不缝进任何 run**——缝要靠猜,而猜出来的树看上去和真的一模一样。
两条都有回归测试(`trace-assemble.test.ts` 场景 9 / 10)。

> 顺带记下这个采集缺口本身:`tool/audit` 该带 `runId` 而没带。S3 是只读面,
> **没有去改写侧**(改采集点是另一件事,且会动 T0 的门);装配器容下它,
> 缺口留在这里等写侧一并收。

### 12.4 只读是硬约束,不是形容词

`getLiveSessionProjection` 的第一步是 `prepareSessionEventsOnce` —— 它会为上次
进程死亡留下的未闭合 run **补写** `run/end`。一个只读出口触发它,就等于"看一眼
轨迹改了账本",而 CLI / HTTP 随时可能在别的进程里跑。所以读实现的判据是
**`hasLiveSessionProjection` 为真才用活投影**(那说明引擎已经在跑它了,prepare 早
跑过),否则一律读文件。两条断言钉着:

- 单测 `app/session/__tests__/trace.test.ts`:构造一个**未闭合的 run**,读完之后
  整个 store 的文件内容逐字节相同;
- 真机:CLI 跑两次(树 + `--response`)前后 store 的 `shasum` 相同。

### 12.5 轨迹面板:加一层,不换投影

面板的 ledger 与时间条带**照旧**读 `sessionEvents.list` 那份七类瘦事件 —— 那条路
被 105+ 测试钉死,而且 v2 全集里的 `assistant/chunks` 带着每一条 delta,整份发给
renderer 是几 MB。run 那一层单独走 `getTrace`,由
`buildTrajectoryRuns(groups, trace)` 做一次**连接**:按 `request/start` 的 seq
(`TrajectoryGroup.startSeq` ↔ `SessionTraceRequest.startSeq`)把已有的请求组挂到
run 下面。两份解析会在"哪个请求属于哪次执行"上分叉,所以这里不重新解析事件。

- 老会话(树上 `hasRunEvents: false`)→ `buildTrajectoryRuns` 返回空数组,面板
  **照旧平铺**,一个 run 头都不画;
- 连不上任何 run 的组进一格显式的 `run-unlinked`,不悄悄丢掉;
- run 头用共享的 `LedgerGroupHeader`(不自绘第二种分组头),**刻意不 sticky** ——
  两层同时吸顶会在滚动时叠成一堵墙;
- 请求组的 inspector 多一节 `Response`:选中组时才去 `getResponseText`,取不到就
  写"这次请求没有记下响应正文",不留空白。
- `getTrace` 失败时面板退回平铺(`.catch(() => ({ trace: null }))`),不把 ledger
  一起拖垮。

### 12.6 门(全部实跑,2026-08-20)

| 门 | 结果 |
| --- | --- |
| `bun run typecheck` | node 侧只剩 3 条既存红(`spaces/__tests__/provider-dials.test.ts`);web 侧 0 |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 10931 passed;失败全在并发进行中的日志线(gateway ×3、`rpc:logs` 名册 ×2)与既存的 `ui-token-vars` ×2 |
| `bun run session:gate` | 0,none new |
| `bun run boundary:gate` | 13,none new |
| `bun run ui:gate` | 81,none new |
| `bun run log:gate` | 822,none new(CLI 新代码走 `stdout()`,不是 `console`) |
| `bun run transport:gate` | 5 个指标红,**全是既有的**。其中四个(`channels:IPC_CHANNELS`、`channels.ts` 行数、`bridge.ts`、`web.ts`)来自并发进行中的日志线;第五个 `http.ts` 在 HEAD 上就已经超基线(1989 → 2028)。删掉手写路由后 `http.ts` 与 HEAD **逐字节相同**(`git diff` 为空),这一格从 2059 回到 2028,**本期净贡献 0 行**(§12.1.1)。〔2028 是 gate 的计数口径(按 `split('\n')`),`wc -l` 是 2027;HEAD 同口径也是 2028〕 |
| `bun run server:build` / `bun run build` | 绿 |
| 真机(临时 store + 假 provider,`scratchpad/s3-realmachine.mjs`) | 27 条事件 → `POST /api/rpc {sessionEvents.getTrace, last:true}` 返回 1 run / 2 requests / 1 tool call;树里没有正文也没有 duration;`getResponseText` 折出 `let me check the time`;`../../etc` 形态的 sessionId 被域的门挡下(信封 ok、`data.trace === null`);**`GET /api/sessions/:id/trace` 返回 404**(手写路由确实不存在) |
| 真机 CLI(同一个 store,直接读文件、无 daemon) | `onething trace` / `--last` / `--run` / `--json` / `--response 1` 全通;前后 store `shasum` 相同 |

### 12.7 留下的尾巴

| # | 事项 |
| --- | --- |
| 1 | `tool/audit` 没有 `runId`(§12.3)。写侧的采集缺口,S3 只是容下它 |
| 2 | `log:tail --session --run`(设计文本 §2.7.5 的第四个出口)没做 —— 它属于日志线那半,由 `app.jsonl` 的 fields 过滤,与本期的账本树无关 |
| 3 | `SessionTraceRequest.params`(`request/recipe.params`)原样透传,没有裁剪策略。今天它只有采样参数那几格,大了再说 |
| 4 | 面板的 run 层没有折叠。`LedgerGroupHeader` 支持 `collapsible`,但折叠状态该记在哪(每会话?每窗口?)是一次呈现裁定,没有先斩 |
| 5 | `getTrace` **没有分页**:一条几百个 run 的会话会一次返回整棵树。`last` 是唯一的减法。真要分页应该按 run 而不是按事件 |

### 10.10 真机第二批:steps[].type 写死(2026-08-20)

第三类 mismatch(3 条,`fe5261d9` 等):`steps[].type` A=command / B=tool-call。引擎按 `getStepType(toolName, args)` 派生 step 类型(bash 按命令内容分 command/file-read/skill-read/file-write,`core/engine/tool-step.ts:56`;实时调用点 `app/engine/stream/tool-execution.ts`),投影 reducer 写死 `'tool-call'`(`reducer.ts:738`)。合同测试没抓到的原因与 title/reasoning 两案相同:**A 线 fixture 也写死了 `'tool-call'`**(`stepOf`,又一处空转)。修复:reducer 与 A 线 fixture 都改调 `getStepType`(参数以 argumentsRaw 解析结果为准);`ProjectedStep.type` 放宽为 `CoreStepType`。规律至此确立:**凡"引擎派生字段",合同 A 线必须调用引擎同一个函数,禁止在 fixture 里手写字面量** —— 已有三案(title/G2、reasoning 落点、step type)。

### 10.11 真机第三批:引擎的两个缺陷 —— step.type 冻在占位、skillUsed 从未落到消息(2026-08-20)

第四、五类 mismatch(`fe5261d9`,3 行影子日志):

| # | 路径 | A(`messages.jsonl`) | B(投影) |
| --- | --- | --- | --- |
| 4 | `steps[].type` | `command` | `file-write` / `skill-read` |
| 5 | `skillUsed` | (缺席) | `lenovo-scripts` |

**裁定:修引擎,不供养怪癖。** 与 §10.10 是**反过来**的一次:那次是投影写死了字面量,
这次 A 线(投影已经按 `getStepType(最终参数)` 派生,§10.10 刚改对)是对的,**是引擎在说谎**。

#### 缺陷 1 —— step.type 冻在占位创建那一刻

占位 step 建于 `tool_input_start`(`core/engine/stream-processor.ts` 的
`createCoreToolInputStartArtifacts`),那一刻参数还是 `{}`,类型只能由
`coreStepTypeForToolName(toolName)` 给出 —— bash 一律 `command`。参数定稿、工具开跑时:

- **agent-loop 这条路**(生产唯一活着的那条,`startAgentLoopToolExecution` →
  `buildAgentLoopToolStartStepUpdate`)只发 `{status:'running', toolCall}` —— `type` 一个字都不改。
- **旧编排器那条**(`executeCoreToolAndUpdate` 的 `existingStep` 分支)重算了 `title` 却没重算 `type`
  —— 一半新一半旧。

于是 `cat …/SKILL.md` 在账上永远写着 `command`。修复:两条路都在**参数定稿那一刻**
重算 `type: getStepType(toolName, finalArgs)`,并把它带进 `sendStepUpdated` 的补丁里。

#### 缺陷 2 —— skillUsed 从未落到消息上(两个判定点)

`skill/activated` 事件由**事件记录器自己**跑一遍 `detectSkillUsage`
(`session-event-recorder.ts` 的 `tool-call-done` 分支)写出来;而 agent-loop 这条路上
**引擎根本没认过技能** —— `detectSkillUsage` 只在旧编排器 `executeCoreToolAndUpdate` 里有。
结果就是账本上有 `skill/activated`、消息上没有 `skillUsed`。

**一个判定点、两个落点**(本期的设计裁定):

```
引擎(参数定稿那一刻)detectSkillUsage → emitter.sendSkillActivated(skill)
        ├─ store.updateMessageSkill   → message.skillUsed      (产品事实)
        └─ appendSessionLogEvent      → skill/activated 事件行  (那条 run 的账)
```

- 判定点唯一,在 core:`startAgentLoopToolExecution`(agent-loop)与
  `executeCoreToolAndUpdate`(旧编排器)。`sendSkillActivated` 因此进了
  `CoreAgentLoopToolExecutionEmitter` 契约(不是可选的 —— 引擎必须announce得出去)。
- 两个落点都挂在宿主侧的同一次宣告上(`app/events/event-only-emitter.ts` 的
  `updateMessageSkill` 端口),异常自吞(记账坏了不许影响聊天)。
- 记录器**不再认技能**;它只记引擎宣告过的事。`safeParseArgs` 随之删除(死码)。
- 事件行的 `runId` 由 `currentSessionRunId(sessionId)` 现取,拿不到就只带 messageId
  —— 投影的 `resolveRun` 本来就按 runId → messageId → 活跃 run 三级回落。

#### 顺带修掉的投影缺陷:run 级技能名串到别的 step 上

`materializeStep` 原来把 **run 级**的 `run.skillUsed` 传进 `generateStepTitle`,于是同一回合里
**每一条** step 的派生标题都变成"Reading X skill documentation"。引擎那一份是**逐调用**判的
(`createToolExecutionStep(toolCall, { skillName })`)。改成 `detectSkillUsage(这次调用自己的参数)`。
真机上一直没暴露,只是因为 bash / read / write 都自报标题(`annotate{title}`),派生标题根本没被用到 —— 新加的合同用例(同回合 skill-read + file-write)当场把它抓了出来。

#### 门(全部实跑)

| 门 | 结果 |
| --- | --- |
| `bun run typecheck` | 只剩 3 条既存红(`spaces/__tests__/provider-dials.test.ts`) |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 10960 passed;红的只有既存的 `ui-token-vars` ×2 与 `AIProviderTab.interaction` 的既存 unhandled rejection |
| `bun run session:gate` / `boundary:gate` / `log:gate` / `lint:ci` | 0 / 13 / 4 / 334,none new |
| `bun run server:build` | 绿 |
| 真机(临时 store + 假 provider,参数流式的 `cat …/SKILL.md` + `mkdir`) | `steps[0].type='skill-read'`、`steps[1].type='file-write'`、`message.skillUsed='lenovo-scripts'`、**恰好一条** `skill/activated`;`sessions:shadow-report --min-runs 1` **GREEN**,shadow.jsonl 0 行 |
| 反向对照(把引擎那一处改动 stash 掉再跑同一个脚本) | 复现真机原样的 mismatch:`1.steps.0.type A:command B:skill-read` / `1.steps.1.type A:command B:file-write`,且 skillUsed 五条断言全红 —— 证明这套验证咬得住 |

#### 留下的尾巴

| # | 事项 |
| --- | --- |
| 1 | **step.title 在 agent-loop 这条路上从不按 `generateStepTitle` 派生**:占位是"调用工具: X",之后由工具自报的 `annotate{title}` 覆盖。今天所有内建工具都自报标题,所以与投影(`reportedTitle ?? generateStepTitle`)对得上;哪天来一个不自报标题的工具,这就是第六类 mismatch。属于"用户可感知的标题变化",没有裁定不动 |
| 2 | `session-shadow-stats.json` 是 1s 节流写、`unref` 的定时器,**关停时没人 flush** —— 进程立刻退出会丢最后一次计数(真机脚本里靠 sleep 2.5s 绕开)。要么在 shutdown 链上调 `flushSessionEventStats()`,要么接受它 |
| 3 | 旧编排器那条路(`ToolOrchestrator` / `executeCoreToolAndUpdate`)在生产里已经**没有构造点**(只有测试构造它)。本期照样修了它的同款不对称,但它是否该退役是另一次裁定 |

### 10.12 真机第四批:steering 把一次执行劈成两条消息 + 失败工具的结局(2026-08-20)

真机 `session-shadow.jsonl` 攒下 **16 行**(`runs 10 / mismatches 16 /
byKind {history: 13, messages: 3}`),全部来自同一条会话 `5e4d2cea…`。**两类**,
病根各一个,**没有一格需要豁免** —— 16 行里的每一条路径都变成了一处修复。

#### 逐路径的账(16 行全展开)

先把三行 `kind:'messages'` 与十三行 `kind:'history'` 摊平(影子的 diff 摘要有
`DIFF_MAX_ENTRIES` 截断,下表是拿真机 `events.jsonl` 原地重放投影得到的**完整**
差异,不是日志里那一份被截过的):

| 路径 | A(`messages.jsonl`) | B(投影) | 归属 |
| --- | --- | --- | --- |
| `steps[].result`(失败的 `read`) | `Offset 330 is beyond end of file (205 lines total)` | 缺席 | 第 6 类 |
| `steps[].title` | `Reading 0820 EMEA FAC ….md` | `Tool: read: 0820 EMEA FAC ….md` | 第 6 类 |
| `steps[].toolCall.result` / `toolCalls[].result` | `{"error":"…","success":false}` | 缺席 | 第 6 类 |
| `usage`(被 steering 打断的那条消息) | 缺席 | `{in 137813, out 3012, …}` | 第 5 类 |
| `contentParts.length` / `[0..3].content` / `[2].type` / `reasoning` | 4 格,开头是推理 part,`reasoning` 字段空 | 3 格,推理搬进了 `reasoning` 字段 | 第 5 类 |
| `steps[].turnIndex` ×3 | 4 / 2 / 3 | 3 / 1 / 2 | 第 5 类 |
| `usage.{cacheRead,input,output,total}Tokens` | 含第 1 轮 | 不含第 1 轮 | 第 5 类 |
| `130.reasoningContent` ×13(`kind:'history'`) | 8470 字推理 | 缺席 | 第 5 类(同一条消息的下游) |

那 13 行历史不等是**第 5 类的下游**,不是独立的一类:`contentParts` 里少了那格
推理,`buildHistoryMessages` 的多轮拆分(`splitAssistantMessageIntoTurnGroups`)
就拆不出那一轮的 `reasoningContent`;而那条消息之后每一次请求的历史里都有它,
于是同一句话报了 13 遍。

#### 第 5 类 —— 一条 assistant 消息 = 一次 run,但**一次执行 ≠ 一次 run**

`5e4d2cea…` 里有一次 steering:第 1 轮流着的时候用户插了一句话,
`beforeTurn` 把它注进历史并发 `response-boundary`,引擎换了一条助手消息、
`rotateSessionRun` 换了一条 run。账本上于是有两条 run;**引擎那边只有一次
agent-loop 执行**,而它的两个计数器一格都不重置:

| 引擎侧 | 事实 | 投影从前的猜法 |
| --- | --- | --- |
| `turnIndex` | 接着数(新消息的第一次请求是第 **2** 轮) | 每条 run 从 1 数起 |
| `accumulatedUsage` | 接着加,收尾时**一次性**写进 `ctx.assistantMessageId`(= 接手的那条消息) | 每条 run 各算各的和 |

两个后果串成一条:回合号一错,`getAgentLoopReasoningPlacement` 的
`turnIndex === 1` 判据(§10.9 的两个落点)就跟着错 —— 新消息开头那段推理在
引擎那里是 `'inline'`(进 `contentParts`),投影却当成 `'top'`(进
`message.reasoning`),于是后面每一格整体错位,历史里那一轮的 `reasoningContent`
也随之消失。用量则是**两头都错**:被打断的那条凭空多出第 1 轮的用量,接手的那条
少了它。

**修法:让账本说出"这条 run 接着那条 run"**,其余全是派生。

- `run/start.continuesRunId`(`core/session/events/types.ts`)—— **只有**
  `rotateSessionRun` 填它(它手里正好有被接手的那条 run 的 id);
- 归约器在 `run/start` 上把被接手那条的 `turnByRequest` / `turnCount` /
  `usageByTurn` / `usage` **抄一份**过来,并给被接手的那条盖上
  `continuedByRunId`;
- `materializeAssistantNode` 见到 `continuedByRunId` 就**不产出 `usage`** ——
  与引擎的 `updateUsage` 落点逐字相同(它只在整次执行收尾时写一次,落在那一刻
  的助手消息上)。step 级的每轮用量照旧有:那是 `updateStepsUsageByTurn` 在
  turn-end 当场写的,发生在换消息之前。

**没有存派生值**:抄过去的是"执行到此为止的计数器状态",与 `partIndex`
是同一类东西 —— 事件说得出来的事实,不是从别处算出来的和。

**倒读分页的第 4 个例外**(`storage/events/pager.ts`):后缀里只有接手那条 run 的
话,这一页里那条消息的三样又全错了。与 `user/message-edited` 同一条治法 ——
`pendingContinuedRuns` 没清空之前不许停。合同测试里 `expectPagerMatchesFold`
当场抓到了这一条(每条场景都跑它,所以这不是补一条测试补出来的,是那道断言
自己报的)。

#### 第 6 类 —— 一次**失败但跑完了**的工具

真机上是一次 `read` 越过文件末尾。引擎那份账(`agent-loop-executor.ts` 的
`settleAgentLoopToolResult` / `buildAgentLoopToolResultPresentation`,即生产里
唯一活着的那条路)的口径是:

```
toolCall.result = toJsonValue(result.data ?? result.content)   // 成败都写
toolCall.error  = result.error                                  // 失败才有
step.result     = resultText(result)   // 失败时它就是 error 那句话
step.error      = result.error
step.partialResult = result.error ? undefined : structured
step.title      = 最后一条 annotate{title}(stepUpdate 里根本没有 title 这一格)
```

也就是说 **`result` 与 `error` 不是二选一**,而投影从前把 `isError` 当成
"没有结果":结构化结局整个丢掉、`result` 也不写。工具卡上于是只剩一句错误
文本,`ToolCall.result` 里的 `{success:false,error}` 消失。

标题是另一半:`executionResultFromOutcome`(`app/toolkit/ipc-observer.ts`)
**只在成功那一支**把累积的标题抄进 `data.title`;失败那一支返回的是
`{success:false, error}`,一格标题都没有。而引擎的 step 标题在**过程中**就被
`applyAgentLoopToolMetadata` 盖成了工具自报的那一个("Reading X.md")。于是
账本上那格标题凭空消失,投影退回 `generateStepTitle` 的 "Tool: read: X.md"。
—— 这正是 §10.11 尾巴第 1 条预告过的"第六类",只是它先从**失败**那一支冒出来。

**修法:补采集点 + 按引擎口径改投影。**

- 记录器认 `tool-metadata` 事件(agent-loop 的 `onEvent` 上本来就有,只是从前
  落到了 `default:` 里),按引擎同一条规则(非空字符串才覆盖)记住最后一个标题,
  写进 `tool/result.reportedTitle`;
- `toolResultFields`:结构化结局**不再看成败**,`error` 与它并存;
- `materializeStep`:`result` 无条件产出,`error` 失败时并存,`partialResult`
  失败时不产出;标题取 `reportedTitle ?? resultData.title ?? generateStepTitle`
  (中间那一格留给本期之前写的老文件)。

#### 交付

| 文件 | 改动 |
| --- | --- |
| `packages/core/session/events/types.ts` | `run/start.continuesRunId`、`tool/result.reportedTitle` |
| `packages/onething-runtime/src/app/session/runs.ts` | `rotateSessionRun` 把被接手的 runId 带进 `run/start` |
| `packages/onething-runtime/src/app/engine/stream/session-event-recorder.ts` | 认 `tool-metadata`,把工具自报的标题记到 `tool/result.reportedTitle` |
| `packages/core/session/projection/reducer.ts` | run 节点按 `continuesRunId` 承接回合号/用量;`toolResultFields` 与 `materializeStep` 改按引擎口径(result/error 并存、失败无 partialResult、标题优先 `reportedTitle`) |
| `packages/core/session/projection/chat-messages.ts` | 被接手的那条消息不产出 `usage` |
| `packages/core/session/storage/events/pager.ts` | 倒读的第 4 个例外:`pendingContinuedRuns` |
| `packages/core/session/__tests__/projection-contract.test.ts` | `TurnSpec.continuesRunId` / `ToolSpec.{resultData,reportedTitle}`;A 线按引擎口径(回合号跨 run 接着数、消息 usage 只在执行收尾写一次、step 的 result/error 并存、标题优先自报);两条新场景 |
| `packages/onething-runtime/src/app/engine/stream/__tests__/session-event-recorder.test.ts` | 两条:失败结局带自报标题、`rotateSessionRun` 盖 `continuesRunId` |

#### 门(全部实跑)

| 门 | 结果 |
| --- | --- |
| 真机**只读重放**(拿 `~/.onething` 的 `events.jsonl` 投影,与 `messages.jsonl` 逐字段比) | 修复前:那 16 行逐条复现(外加 diff 摘要截掉的 3 条);修复后(把两格新采集面按本期规则补进内存里的事件流)**13 条 assistant 消息全部 0 差异** |
| 合同测试 | 30 条全绿(新增 2 条场景) |
| 反向对照 ×7 | 逐个撤掉:归约器的承接播种 / `continuedByRunId` 抑制 usage / `toolResultFields` 在失败时丢结构化结局 / step 的 result 与 error 二选一 / 标题不看 `reportedTitle` / 倒读第 4 例外 / `rotateSessionRun` 不盖 `continuesRunId` —— **每一处当场变红** |
| 真机(临时 store + 假 provider,`scratchpad/s1b-class56-verify.mjs`) | (a) steering:两条 run、`continuesRunId` 对、被打断那条无 usage、接手那条推理在 `contentParts{turnIndex:2}`、usage 130+250=380;(b) 失败的 `read`:`reportedTitle` 落账、step.title 用它、`step.result` 与 `step.error` 并存、`toolCall.result` 是结构化结局。两个场景 `shadow.jsonl` **零行** |
| `sessions:shadow-report --min-runs 1`(两个临时 store) | 各 **GATE GREEN**(runs 1 / mismatches 0 / appendFailures 0) |
| 反向对照(把本期产品侧改动整体 stash 掉再跑同一个脚本) | 复现真机原样:(b) `steps.0.result` / `steps.0.title`("Reading notes.md" vs "Tool: read: notes.md")/ `steps.0.toolCall.result` / `toolCalls.0.result` 四条,(a) `1.usage` 一条 |
| `typecheck` / `ONETHING_SESSION_FREEZE=1 test` / `session:gate` / `boundary:gate` / `log:gate` / `lint:ci` / `server:build` | 见本节末 |

真实 `~/.onething` 的 `session-shadow.jsonl` / `-stats.json` **一个字节没动**(只读)。

#### 新发现:记录器可以跑赢引擎整整一个回合(未修,待裁定)

写真机脚本时撞上的:`response-boundary` 是引擎在 **chunk 队列**那一侧处理的
(`createNextAssistantWriter` → `rotateSessionRun`),而记录器挂在 provider 的
`onEvent` 上、**同步**。零延迟的假 provider 下,记录器把第 2 轮**整段**
(recipe / start / chunks / response / end)都用**旧的 runId 与旧的 messageId**
写完了,`run/start(steer)` 才姗姗落在 `run/end` 之后 —— 账本上那一轮整个记错了
消息,而 `messages.jsonl` 是对的(引擎按队列顺序处理,先换消息再收正文)。

真机 `5e4d2cea…` 没踩到:模型第 2 轮的首字节延迟(~1.5s)天然把这一段盖住了,
`run/start(seq 1772)` 排在第 2 轮的 first-token(1774)之前。脚本里按同样的量级
补了 800ms 延迟复现真机次序,并钉了一条断言:**第 2 轮的正文不许落在旧 run 名下**
(`request/recipe` / `request/start` 落在旧 run 上是无害的 —— 回合号正是靠它们
在旧 run 上的编号接上的)。

这是**采集面的次序风险**,不是引擎缺陷(用户看到的消息一直是对的),但它能让
一次 steering 的账整段记错。三条可能的修法(改任何一条都动引擎的时序,按
"行为裁定须先问"没有自作主张):① 让 `response-boundary` 在 `onEvent` 那一侧就
把 run 换掉(要把新助手消息的 id 提前铸出来);② 记录器在 `response-boundary`
之后挂起,等引擎宣告新锚点再落账;③ 给 chunk 队列加背压。留待裁定。

#### 留下的尾巴

| # | 事项 |
| --- | --- |
| 1 | **孤儿工具调用(G7)不进 `steps`**:观察期里新冒出来的一条真机消息(`17b342a2…`,用户中途 abort)显示,引擎给"参数流到一半被打断"的那次调用建了一条 step(标题是占位的"调用工具: bash"、`status:'cancelled'`、`toolCall.error:'User cancelled'`),而投影的 `materializeOrphanToolCalls` 只把它补进 `toolCalls`、不补进 `steps`,且 `toolId`/`toolName` 是空的、没有 error。同一条消息上 abort 的那条 run 还有"引擎不写 usage 而投影写了"。**这是第 7 类**,不在本期这 16 行里,证据已留在 `~/.onething` 那条会话上 |
| 2 | `session/compacted` 之外,`continuesRunId` 目前只有 steering 一个生产者。"确认后恢复"(`kind:'resume'`)开的是一次**新**执行(回合号从 1 起),真机上没有反例;哪天它也接着数,这一格照样能表达 |

### 10.13 影子门改混合制(2026-08-20 用户拍板)

原门"真机 runs ≥ 200 ∧ mismatch = 0"全靠人肉使用攒量,慢且每次修复后要重攒。改为:
1. **脚本场景矩阵**(待建,`scripts/shadow-battery.mjs`):起真 server(dist 构建)+ 假 provider,枚举场景 × 变体驱动真引擎——多轮工具循环 / 权限拒绝 / abort / retry / edit-resend / compact / 技能读取 / 业务失败工具 / 图片 / steering / reasoning 双落点 / 同 run 续轮…;每个已修失配类固化为一个场景(§10.9–§10.12 逐条回填)。门:**矩阵 ≥200 run 零失配**,分钟级,修复后一键回归。
2. **真实使用**:不再要求凑数,负责"未知的未知"——观察期内**零新失配类**即可(脚本模拟不出真实 provider 的流式怪癖 / 真实 skill / 真实工具边界失败;已有六类全部来自真机)。
S2b 前置 = 两者同时绿。

### 10.14 第 7 / 8 类 + 场景矩阵落地(2026-08-20)

两件事一起交:**abort 那一路的三处失配**(§10.12 尾巴第 1 条预告的第 7 类)与
**`scripts/shadow-battery.mjs`**(§10.13 第 1 条)。矩阵一建起来就当场又抓到一类
(第 8 类)和两处采集缺口 —— 那正是它存在的理由:六类失配全靠人肉聊天撞出来,
现在 44 秒撞 200 个 run。

#### 第 7 类 —— 用户按下停止的那一瞬间,引擎写了什么

真机证据是 `5e4d2cea…` 会话里的消息 `17b342a2…`(§10.12 尾巴留的那条)。把
`events.jsonl` 原地重放、与 `messages.jsonl` 逐字段比,**四处**不等,病根是同一句话:
**投影没有复刻引擎的收场动作**。

| 路径 | A(`messages.jsonl`) | B(投影,修复前) | 引擎那一侧的出处 |
| --- | --- | --- | --- |
| `steps` 少一条 | 有占位 step(`type:'command'`、`title:'调用工具: bash'`、`status:'cancelled'`) | 缺席 | 占位调用与占位 step 是**同一行代码**建的两样(`createCoreToolInputStartArtifacts`),投影只补了前者 |
| `toolCalls[].toolId/toolName` | `bash` | `''` | 事件面上没有采集点 —— `tool/call` 永远不会来 |
| `toolCalls[].error` / `streamingArgs` | `'User cancelled'` / `''` | 缺席 / 半截参数原文 | `finalizeLingeringAgentLoopToolWork` 写的那句话;`streamingArgs` 在**消息上**从建卡起就是空串(delta 只发渲染层) |
| `contentParts` 多一格 | 被打断那一轮的推理**不在** | 在 | 引擎只在 `finish` chunk 上 `persistTurnContentParts`,走不到就一格都不落 |
| `usage` | 缺席 | 有(前两轮之和) | `updateUsage` 排在 chunk 循环之后,abort 从 catch 里走,一次都没跑 |

**修法(四处,全部是"照引擎那一份说话")**:

- **采集面补一格** `toolName`:`assistant/chunks` 与 `assistant/part-end` 的
  `tool-input` part 上带工具名(`tool-call-start` 那一格本来就有)。没有它,
  投影说不出"被打断的那次调用是谁"。
- **`materializeOrphanSteps`**(新):孤儿参数流也产出 step,`type` 调
  `coreStepTypeForToolName`、标题调新导出的 `coreToolInputStartStepTitle` ——
  引擎的两个函数,不手抄字面量(§10.10 的规矩)。
- **收场修复进投影**:`lingeringToolError(run)` = 引擎那三条收场路各自写的那句话
  (`aborted → CORE_ABORTED_TOOL_ERROR`、`completed`/`error → CORE_LINGERING_TOOL_ERROR`,
  两个常量从 `agent-loop-executor` 导出;`interrupted` **没有**收尾修复,那是进程
  没了之后补的墓碑)。它同时盖在**所有**没结局的调用上,不只是孤儿 —— "abort 时
  正在跑的那个工具"是同一件事。
- **`settledRequests`**:`request/end`(记录器在 `turn-end` 写的那条,从前在归约器
  里是空分支)= "这一轮的 part 落到消息上了"。没走到它的那一轮不产出 contentParts。
- **usage 只在 `outcome === 'completed'` 时产出**。

#### 第 8 类 —— 不自报标题的工具(§10.11 尾巴第 1 条,矩阵当场抓到)

生产里活着的那条路(agent-loop)上,step 标题只有两步:占位 `调用工具: X`,
之后被工具自报的 `annotate{title}` 盖掉。**没有第三步** —— `generateStepTitle`
只在旧编排器里,而它在生产里已经没有构造点(§10.11 尾巴第 3 条)。于是一个
**参数校验就失败**的调用(模型把 `path` 写成 `file_path`,天天发生)在账上永远停在
占位标题,而投影退回 `generateStepTitle` 给出 `Tool: read`。

**裁定:改投影,不改引擎 —— 理由与 §10.11 相反的那次一样,是"谁在说谎"。**
这次说谎的是投影:引擎写下的就是占位标题,用户今天看到的也是它。让投影说
`Tool: read`,才是"S2 切读之后用户看到的东西变了"。所以 `materializeStep` 的兜底
从 `generateStepTitle` 换成 `coreToolInputStartStepTitle`,A 线 fixture 同步。

> **仍然待裁定的是引擎那一侧**:按 §10.11 缺陷 1 的先例(`step.type` 冻在占位 →
> 参数定稿时重算),标题也该在参数定稿时按 `generateStepTitle` 重算。那是一次
> **用户可感知的标题变化**,按"行为裁定须先问"不自作主张。真要那么改,投影这一格
> 跟着改回去即可(一行)。

#### 顺带补的两处

| # | 事情 | 修法 |
| --- | --- | --- |
| 1 | **失败工具的字符串结局丢了一格**:参数 JSON 断在半路时 `result.data` 缺席、`result.content` 是空串,引擎写 `toolCall.result = toJsonValue(data ?? content)` = `""`,而记录器只记 `data` 且"字符串结局不写" | `structuredResultForEvent` 改取**引擎那一行的同一个表达式**(`data ?? content`),并且**失败时字符串也记**(那时 `result.text` 装的是错误话,两者不是同一个东西) |
| 2 | **桌面的停止按钮与网页留下两种账**:`cancelOnethingStreamingStepsForAbort`(只有桌面 IPC 走)抢在引擎的收尾修复之前把 step 判死,却不写 `error`;网页走 `/api/streams/abort`,由引擎自己修,写 `error`。谁先跑到本来就是竞态,记录不该跟着变 | 引擎的修复**筛得到**的那些 step(`running` 且不在等确认),桌面这一支照它的字段写;等确认的那一支一个字没动(引擎的修复明确放过 `requiresConfirmation` 的调用)。另:`canRespond: false` 与缺席同义,写进 `canonicalChatMessage`(与 `requiresConfirmation` 同一条理由) |

#### `scripts/shadow-battery.mjs` —— 场景矩阵

```
bun run sessions:shadow-battery            # 默认:18 场景 × 9 遍 ≈ 207 run,44 秒
bun run sessions:shadow-battery --only abort-mid-tool-input --keep-store
bun run sessions:shadow-battery --seed 7 --passes 3 --concurrency 2
```

它做的事:`server:build` → 临时 store + 假 provider(本地 SSE,零成本)→
真 server(`dist/server/main.js`)→ 按场景表用 HTTP 驱动**真引擎** →
`sessions:shadow-report --min-runs 200` 当门。三条纪律写在文件头:不碰真实 store、
**变体只由 `--seed` 决定**(没有一处不带种子的 `Math.random`)、假 provider 零成本。

| 场景 | 盯的那一类 |
| --- | --- |
| `plain-text` | 基线:一轮纯文本 |
| `reasoning-top` / `reasoning-two-spots` | §10.9 类别 2(推理的两个落点) |
| `tool-loop` | 多轮工具循环(同 run 续轮) |
| `bash-step-types` | §10.10(`steps[].type` 写死)+ §10.11 缺陷 1(type 冻在占位) |
| `skill-activation` | §10.11 缺陷 2(skillUsed)+ 同期那处"技能名串标题" |
| `tool-failure` | §10.12 第 6 类(失败但跑完了:result 与 error 并存 + 自报标题) |
| `tool-invalid-args` | §10.14 第 8 类(不自报标题的工具) |
| `permission-denied` | G6:拒绝 + reason |
| `abort-mid-text` | 第 7 类:被打断那一轮的 contentParts 不落地 + 无 usage |
| `abort-mid-tool-input` | 第 7 类:孤儿参数流的占位 step / 占位调用 / `User cancelled` |
| `tool-args-truncated` | 参数流没写完就 stop —— 引擎兜底照样执行(**不是**孤儿) |
| `steering` | §10.12 第 5 类(一次执行劈成两条消息)。第 2 轮**故意**留 800ms 首字节延迟 —— 零延迟下记录器会跑赢引擎的 chunk 队列(§10.12 末 / §10.15,已定性为架构问题归 U0),矩阵不在这里替它打补丁,也不假装它不存在 |
| `edit-and-resend` / `retry-message` / `delete-message` | surface replace 的三条路 |
| `compact` | `session/compacted` |
| `long-multipart-text` | part 边界与攒批闸 |

**两条"矩阵造不出来"的诚实交代**:
1. **真正的孤儿只有 abort / 请求出错**。"provider 开了参数流却直接 stop"造不出孤儿
   —— 核心的 `agent-loop/stream.ts` 会在收尾时**补一条** `tool-call-start` 并拿半截
   参数执行(`tool-args-truncated` 那一格钉的就是这个事实)。
2. **会话清空进不了矩阵**:后端 `clearSessionMessages` 今天没有 HTTP/命令出口
   (桌面直接调 store 函数,web 端只清渲染层),脚本尾部按 TODO 打印。

写脚本时踩到并写进注释的三个坑(以后别再踩):

- **忘了重建 bundle**:矩阵验的是 `packages/**`,跑的是 `dist/server/main.js`。
  现在**默认每次都重建**(`--no-build` 只给反向对照用)。
- **`isStreaming:false` 不等于收干净了**:它由 `processor.finalize()` 写下,而收尾
  修复排在它后面一行。驱动方还要等"没有活状态的调用"。
- **引擎释放会话又比 `stream:complete` 晚一步**:那一步里发过去的下一条消息会被
  当成 **steering** 排队,而不是开一轮新的。`waitIdle` 因此还要看
  `/api/streams/active`,并在之后再确认一次。

#### 门(全部实跑)

| 门 | 结果 |
| --- | --- |
| `bun run sessions:shadow-battery` | 18/18 场景 PASS,`runs 207 / mismatches 0 / appendFailures 0`,**GATE GREEN**,44 秒 |
| 反向对照(把第 7 类那三处 stash 掉重跑 abort 两格) | `runs 0 / mismatches 2`,**GATE RED**:`steps.length A:2 B:1`、缺席的占位 step、`contentParts` 多出被打断那一轮、`usage` 凭空多出来 —— 逐条复现真机 `17b342a2…` 的那四处 |
| 合同测试 | 33 条全绿(新增:`abort mid tool-input`、G7 的两条、G2 改口径) |
| `bun run typecheck` | 只剩 3 条既存红(`spaces/__tests__/provider-dials.test.ts`) |
| `ONETHING_SESSION_FREEZE=1 bun run test` | 10969 passed;红的只有既存的 `ui-token-vars` ×2 与 `AIProviderTab.interaction` 的既存 unhandled rejection |
| `session:gate` / `boundary:gate` / `log:gate` / `lint:ci` | 0 / 13 / 4 / 334,none new |
| `bun run server:build` | 绿 |

真实 `~/.onething` 的 `session-shadow.jsonl` / `-stats.json` **一个字节没动**(只读)。

#### 留下的尾巴

| # | 事项 |
| --- | --- |
| 1 | **等确认时按停止**还没有口径:引擎的收尾修复明确放过 `requiresConfirmation` 的调用,而桌面那一支把它判死;投影两边都对不上(`requiresConfirmation:true` 在事件面上也没有采集点)。矩阵**有意不造**这一格 —— 它需要一次裁定,不是一次修补 |
| 2 | 第 8 类的**引擎侧**裁定(标题要不要在参数定稿时重算)见上,待拍板 |
| 3 | `session/cleared` 至今没有端到端场景(见上"矩阵造不出来"第 2 条)。要么给 `clearSessionMessages` 一个命令面出口,要么承认它只有单测覆盖 |

### 10.15 §10.12 竞态定性(2026-08-20):架构问题,归 U0

用户点破:recorder 领先引擎一个 turn 不是时序 hack 能修的,是**身份在事实下游被分配**——事实(delta/boundary)生于 agent-loop,身份(runId/messageId)定于 executor(隔异步队列),recorder 记账时查的是可能未更新的登记簿。修法与 U0 的'delta 源头带 messageId/partIndex'同一原则:run 轮换上提到 agent-loop 发 boundary 的同步点,事件出生即带 runId;executor 退为消费已盖章事件。归 U0 交付,不单独修。

### 10.16 旧词汇 steer 兜底(2026-08-20)

真机重现第五类签名,但根因已变:9dde092d 只修了**新事件**,`5e4d2cea` 里修复前写的 steer `run/start` 没有 `continuesRunId`,history 断言每请求比全量历史 → 该会话每轮一报。修:投影加**词汇演进兜底**——`kind:'steer'` 只有 `rotateSessionRun` 一个产地(必然延续上一条 run),缺字段时按"账本里最近开张的 run"推断(`lastRunId`),推出的正是当年该写的值;显式字段仍优先。合同新增"pre-fix vocabulary"场景(剥字段 ≡ 带字段)。真实会话只读回放:reasoningContent 差异消失。

**两条从复发学到的规矩**:①词汇演进成对交付——事件加新字段必须同时回答"旧文件缺它时投影怎么办",读侧兜底不是可选项(9dde092d 只交付了写侧,故同一症状二次出现);②回放验证用文件原字节——§10.12 批次的验证曾把缺字段补进内存流再验,验证方法掩盖了验证对象。

**已知残余(不影响门,归 S2b)**:该旧 steer run 的 `run/end` 是 prepare 补的 `interrupted`(当年没收尾),投影按"completed 才计 usage"给不出 usage,而真实消息上有(执行实际完成)——信息当年未被记录,不可重建。S2b 迁移对**混合覆盖会话**须让 `message/imported` 快照压过修复前的缺陷事件段(surfaceOp replace 遮蔽旧段是自然做法)。

### 10.17 历史文件门:sessions:verify 覆盖感知 + 棘轮(2026-08-20)

用户质问"机器测试为什么什么都没测出来"——成立。battery 在全新 store 里跑,结构性测不到"现在的代码读**过去的代码**写的文件";而能测这个的 `sessions:verify` 是全量长度对比,混合覆盖会话恒 FAIL,真回归被淹没,也没进修复后必跑清单。补齐:
1. verify 覆盖感知:磁盘消息先按存储驱动同一函数补水(`rehydrateSessionFromStorage`),再对事件覆盖到的消息逐条 canonical 比较(stableStringify 免键序假阳性);legacy 前缀只计数不算错。
2. `bun run sessions:verify:gate` 棘轮(基线 `docs/audit/session-verify-baseline-2026-08-20.txt` = 8 条已知残余:steps.type×4 占位冻结、usage×2 §10.16、skillUsed×1 断链、fd899977 content/order 待归类)——**任何新增 = 新代码弄坏旧文件,当场红**。
3. 门口径更新:S 线任何投影/词汇/recorder 改动,必跑三件套 = 合同测试 + shadow-battery(新文件)+ **sessions:verify:gate(旧文件)**。这次复发若有第三件,当场即被拦下。

---

## 13. 静态审计(2026-08-20,用户要求"别再测了,从代码逻辑上看"):两路逐字段对读,28 项发现

方法:一路逐字段对"引擎写什么 vs 事件带什么 vs 投影算什么"(消息侧 A1–A20),一路对模型历史 builder 全规则集 + 影子盲区 + 崩溃窗口 + 多写者(F1–F14)。不跑测试,纯读。已修的 8 类不重复计入。**结论:真分歧 19 项,其中日常必现 5 项——影子攒 run 的策略在这些面前是低效的,静态对读一次挖穿。**

### 13.1 消息侧真分歧(A 系)

| # | 内容 | 判定 | 触发 |
|---|---|---|---|
| A1+A13+A14 | **provider-data part 无采集点**:引擎把 Claude thinking 签名块/codex 加密推理落成 `contentParts` 的 provider-data 格(且会切断 text 分段),recorder 无此词汇;codex 内联生图正文同路无声 | 必现(Claude 开思考即触发) | 日常 |
| A2 | **图片 part-end 被 `settledRequests` 闸吃掉**:§10.14 引入的闸把 S1b 缺口 3 的采集成果废了(图片流不经 agent-loop,requestIndex 永不 settled),`assistant-parts.ts` 头注释已过时 | 回归 | 一次生图 |
| A3 | 图片消息 `content`(内嵌 base64 markdown)无事件:`appendContentPart`/图片路径不经 translator | UNCARRIED | 一次生图 |
| A4 | `agentId` 无承载:core 三入口(send/edit-resend/retry)不传 `params.agentId`,collab 工作会话的助手消息 A 有 B 缺 | UNCARRIED | agent 执行会话 |
| A5 | **retry 中段截断只遮一条**:`truncateFrom{inclusive:true}` 翻译成单条 `message/deleted`,reducer 只 hide 目标;对非末尾消息 retry 时 B 面整段多出来(surface 半对 → 历史绿、消息红) | 条件必现 | 中段 retry |
| A6+A7 | **工具身份未归一**:`tool/call.name` 是 provider 原始名,引擎 `resolveToolIdentity` 归一(MCP→服务器名、别名表);steps.type/skillUsed 连带 | 必现(装了 MCP) | 日常 |
| A8 | **>64KB 工具结果**:事件侧换 BlobRef,投影 `steps[].result` 整格缺席(A 是全文) | 必现(大结果) | read 大文件 |
| A9 | **附件 base64 单向**:`user/message` 落成 BlobRef,投影不回填,canonical 必红 | 必现(带图消息) | 日常 |
| A10 | **prepare(补账本)与 sanitize(补消息)口径从未对齐**:崩溃重启后 title/error/result/status 四格打架(§11.3 待决 8 的实证) | 每次非正常退出 | 崩溃 |
| A11 | `publish:false` 的不可见工具调用:recorder 无条件记,投影无条件产出 | 条件 | fallback 补位路径 |
| A12 | `awaiting-confirmation`/`requiresConfirmation:true`/等确认 error 三格无来源(permission/asked 其实已有,投影没 join 出状态) | 条件 | 权限挂起时退出 |
| 结构 | `appendContentPart`/`upsertStep`/`patchStep`/`patchStepsUsageByTurn`/`setToolCalls` 五命令无 translator 且无守卫;`repairOnLoad` 改字段却无事件(translator 跳过理由"集合没变"套不上它) | 缺口之源 | — |

等价确认:runId/steered/source/voice/replyTo/mentions/reactions/collab*/contextUpdate/turnContext/errorDetails/图片 usage(A15–A18、A20);canonical 既有豁免全部仍成立(A19)。**`ignoreKeys` 生产零使用——凡分歧必红,没有静默豁免档。**

### 13.2 历史侧 + 时序 + 多写者(F 系)

| # | 内容 | 判定 |
|---|---|---|
| F1 | 压缩分支 providerData **last-only** 规则未被 G9 还原(投影压缩后走非摘要分支逐条求值);今天被 A1 无生产者掩盖,A1 一补即成 codex/claude 压缩后确定性错误(重复 N 份加密推理) | 定时炸弹 |
| F2 | **`hasCompacted` 不看 status**:一次失败压缩(真机发生过:deepseek 空摘要)让整份历史切换压缩口径——预算掉 8 倍、旧摘要锚点失效整段重放、消息组劈两段 | 最小改动最大爆炸 |
| F3 | `prepareMessages` 按 surface 分段应用 vs 引擎整份应用一次(goal drive 折叠/房投影会出两份);还有 `indexOf(throughSeq)===-1` 时 replace 静默退化为 append 且零 violation | 条件 |
| F4 | **合同测试验的是生产从不走的 core 缺省配方**;宿主配方(`historyProjectionRecipe`)只有真机影子在验;core 缺省对 legacy `contextUpdate` 的渲染与宿主铁律不同字节 | 覆盖洞 |
| F5 | 影子的 `build` Pick 类型漏了 `prepareMessages`/`providerDataFromContentPart`,重构一次就静默丢配方且门照绿 | 类型洞 |
| F6 | blob 读不到时投影**整格摘掉且无错**(附件静默变短) | S2b 数据丢失面 |
| F8 | turn 分裂重建的**硬条件**(每 part 有 turnIndex)被投影镜像成**可选字段**,解不出就整条掉 collapsed 且 reasoning 口径随之改变 | 条件 |
| F9 | **影子统计通胀**:每 turn 重跑一次同一比较,"200 run"实为 200÷平均轮数个独立比较;`request/recipe` 第 2 轮起记的不是实际发出的(agent-loop 内存演进、瞬态尾块、steering 注入都不在);G10 自证账只对第 1 轮成立 | 门口径 |
| F10a | **canonical 键序盲区**:判等对键排序,而 `stringifyToolResult`/arguments 对键序敏感——影子判等但 wire 可以不同字节(cache miss);全表唯一"判等但不等价" | 盲区 |
| F11 | **`ONETHING_SESSION_READ=events` 下影子变自比**:真相侧 `sessionReads.listMessages` 已有 events 岔口,两侧同源,legacyPartial 判定失效,门以错误理由变绿 | **判据污染,必须先修** |
| F12 | 崩溃窗口表:W-B(正文,消息侧 300ms 粒度赢,事件侧丢最多一个 turn,无人收口)/W-C(prepare 把真跑完的工具**伪造成失败**)/W-D(turnContext 两侧各错一半 → 必然一次 cache 全失效)/W-A、W-E 为 S2b 后翻转项 | 无人收口 |
| F13 | recorder 三处"身份查不到就静默丢账"(flushBatch/endPart/openPart,2s 定时器晚于 endSessionRun 清账即触发);`findLastSessionEventSync` 读过期文件可能重写 40KB 工具目录;权限事件 rotate 后归属错 run(结局仍按 toolCallId 接得上) | 小洞群 |
| F14 | **server:start 无 StoreLock(用户裁定撤销)+ `--force` 绕过发现文件 = 双写者铸同 seq → replace 遮错区间且校验放行**;§11.3 迁移待决预设的锁不存在 | 与撤锁裁定冲突,须重议 |

### 13.3 裁决与分批(待用户拍)

- **P 批(判据先行,必须最先)**:F11(影子真相侧强制走 messages 读法)、F9 统计口径(按 run 去重计数)、F5 类型洞、F10a(结局/参数比较改为对记录字符串而非解析对象)。——门不真,其余修了也无从证明。
- **Q 批(日常必现的采集/投影缺口)**:A1+A13+A14(provider-data 词汇 + 分段对齐)、A2(图片闸回归)、A6+A7(工具身份归一进事件)、A8+A9(blob 回填,投影注入 resolver)、A5(truncateFrom 遮全段)、A4(agentId 贯通)、F2(hasCompacted 看 status)、F1(providerData last-only)。
- **R 批(收口与约定)**:A10+F12-W-C(prepare/sanitize 单一口径——需拍板)、A12(permission join 出 awaiting 状态)、A11(可见性)、F3、F8、F13、F6(blob 缺失报错)、A3(图片 content 表示——需拍板:进 chunks 还是专用事件)、translator 五命令守卫、F4(合同改跑宿主配方)。
- **S 批(裁定)**:F14 server 双写者——撤锁裁定与 S2b 前提冲突,选项:①迁移脚本+切读前置"无活 core 硬检查"(不复活常驻锁)②仅 events.jsonl 追加时文件锁 ③复活 server StoreLock。**(2026-08-24 已裁:②③出局——用户重申不要 lock;①并入 S3w-1 的门,G12 守卫升级拒写见 §14.6 裁定 3。)**

### 13.4 P 批落地记录(2026-08-20):判据先行

**一句话**:这一批一行采集点都没动 —— 修的全是**尺子**。F11 之前那道门可以在读模式一切就变成"投影跟投影比",F9 让"200 个干净 run"读起来比实际覆盖面大一个数量级,F10a 承认了一类判等但 wire 不同字节的格,F5 让整份配方靠 spread 吊着命。四条都属于"门不真,其余修了也无从证明"。

#### F11:真相侧强制走抄本(判据污染)

- `sessionReads` 加了 **`listMessagesFromTranscript(sessionId)`**(`app/session/reads.ts`):永远 `getSessionMessages` → `messages.jsonl`,**故意不经过 `fromEvents`**。它不是 `listMessages` 的便利别名,注释里把理由和"改我之前先回答什么问题"逐条钉着。
- 三个真相侧取数点改用它:`shadow.ts` 的 run 断言、`sessionEventCoverageIsPartial`(legacyPartial 判定)、`engine/stream/history-shadow.ts` 的历史断言输入。
- **裁定:切读之后影子照跑**。这道比对的口径与"谁在给产品供数"无关,始终是**抄本 vs 投影**;S2b 之后它就是那本回头看的迁移账,而不是自动退役。`SessionHistoryShadowInput.actual` 的注释也照此改写(它不再敢自称"今天真正发出去的那一份")。
- 门:新用例 `app/session/__tests__/shadow-read-mode.test.ts` —— 跑**真的** `reads.ts`(只替身最底下的会话仓库),把读模式钉在 `events` 上,让抄本与事件故意分岔。**回归实证**:把真相侧改回 `listMessages` 再跑,events 档当场 `expected 'match' to be 'mismatch'` —— 修之前它就是这么绿的。另外 `shadow.test.ts` 的 `reads.js` 替身里 `listMessages` 现在**直接抛**,谁把它接回去谁当场红。

#### F9:统计口径(run 粒度 ≠ 请求粒度)

- **历史断言仍然每次请求跑一遍**(那正是它的正确性所在:第 2 轮发出去的历史与第 1 轮不是同一份),但**同一个 run 里同一处不等只记一次**:指纹 = `kind` + 那份 ≤2KB 的字段级摘要,`shadow.ts` 里一个上限 200 个 run 的插入序 Map。折叠的是**重复**,不是不等 —— 同一个 run 里换一处不等照记。
- 账单加两格(`event-stats.ts`):`historyChecks`(请求粒度,一个 run 可有十几次)与 `duplicateMismatches`(被折叠掉的重复数)。`runs` 的语义一字未改并复核过:只有 run 断言判等时 +1,由 `runs.ts` 在 `run/end` 之后排一次 —— **每个 run 一次**,没有通胀。
- `scripts/session-shadow-report.mjs` 同步:两个新数只打印、**不进门**(门仍是 `runs ≥ 200 ∧ mismatches = 0 ∧ appendFailures = 0`),老账单缺这两格读成 0 而不是读崩。
- **明确不在本批**:F9 的第二半 —— `request/recipe` 从第 2 轮起记的不是**实际发出的**那一份(agent-loop 的内存演进、瞬态尾块、steering 注入都不在它里面),于是 G10 的自证账只对第 1 轮严格成立。那是 recipe 采集形状本身的问题,归未来的 recipe 重设计,**不在 P 批**。

#### F10a:wire 字节 vs 对象形状

- 判等器对对象**排序键**,而工具结局与工具参数在 wire 上是整个被 `JSON.stringify` 成一串字节的(`JSON.stringify` 保留插入序)。于是存在一类"判等但不等价":影子绿,provider 拿到两段不同的前缀,prompt cache 全失效。
- 一份实现,两个消费者:`stringifyToolResult` / `toolCallArguments` 从 `agent-loop/messages.ts` 的私有函数搬进新的 **`packages/core/agent-loop/wire-format.ts`**,`messages.ts` 改成 import(行为一字未改),`canonicalHistoryMessages` 用**同一把尺**把 `role:'tool'` 的 `content[].result` 与 assistant 的 `toolCalls[].args|arguments` 换成那一串再比。抄一份到判等器里等于埋一个"wire 改了而判据没跟上"的洞。
- 其余一切照旧排序(它们在 wire 上是逐字段映射的,键序是拼装顺序的副产物)。`args` 与 `arguments` 两种写法归一到同一串 —— 它们本来就是同一件事。
- 门:`packages/core/session/__tests__/canonical-history.test.ts` 6 例(键序不同 → 不等;逐字相同 → 相等;信封与 content part 的键序仍然忽略)。

#### F5:类型洞

- `SessionHistoryShadowInput.build` 的 `Pick` 补上 `prepareMessages` 与 `providerDataFromContentPart` —— 它们原来只是**顺着 spread 活下来的**。危险在于:按类型重构一次入参,那两格静默消失,而**两侧同时少了同一遍预处理时结果仍然相等**,门照绿。
- 门:`app/session/__tests__/shadow-recipe-contract.test.ts` 双保险 —— 编译期 `recipe satisfies NonNullable<build>`(`bun run typecheck` 把关),运行期断言配方键集 = 类型认领的五格(将来长出第六格而类型没跟上,当场红)。

#### 门(P 批实跑)

`typecheck` 3 红全是既有的 `provider-dials`;`bunx vitest run app/session core/session` 21 文件 212 例全绿;全量 `ONETHING_SESSION_FREEZE=1 bun run test` = 1141/1145 文件绿,2 红全是既有的 `ui-token-vars` + 1 个既有的 `AIProviderTab` 悬挂拒绝;`session:gate` 0 / `boundary:gate` 13 / `log:gate` 4 均无新增;`lint:ci` 335(把 P 批全部改动 stash 掉再跑仍是 335 —— 差额来自同窗的 Q 批在途文件,P 批净增 0)。

`bun run sessions:shadow-battery` **GREEN**,20 个场景全 PASS,并且第一次把 F9 的通胀量在真跑里摆了出来:

```
[shadow] runs           : 207   (run 粒度 —— 门只看它)
[shadow] historyChecks  : 333   (请求粒度,一个 run 可有多次)
[shadow] mismatches     : 0
[shadow] duplicates     : 0   (同 run 同一处,已折叠)
```

207 个 run 对 333 次历史比对 —— 场景矩阵里多轮 run 只占一部分就已经是 1.6 倍;真机上多工具长 run 的比例更高,"200 个干净 run ≈ 比过 200 次"从来不成立。两个数从此各说各的。

### 13.5 Q1 批落地记录(2026-08-20):日常必现的采集/投影缺口

§13.3 的 Q 批做掉八项里的六组:A1+A13+A14、A2、A6+A7、A5、A4、F2、F1。
(A8+A9 的 blob 回填不在本批。)每一项的规矩都是同两条:**引擎派生的字段只许调
引擎那个函数**(§10.10),**新字段与读侧兜底成对交付**(§10.16)。

#### 各项选了什么

**A1+A13 —— provider-data 有了词汇,而且它是一条分段边界。**
`SessionAssistantPartKind` 加一格 `'provider-data'`(同时抽出
`SessionAssistantDeltaPartKind` = 有 delta 的那几种,`assistant/chunks` 只认它们),
`assistant/part-end` 加一格 `providerData?: {text} | {blob}`。载荷与工具结局同一条
64KB 线(`textOrBlobForEvent`)—— 真机 410 个会话实测 p50 1.2KB / p99 12KB /
max 37KB / 超 64KB 的 0 条,所以 blob 那一支是上限保护而不是常态。

采集点(`session-event-recorder.ts`)做两件事,少一件就错位:**先把正在攒的
正文/推理段收了**(引擎的 `appendOrderedPart` 只合并相邻同类,一格 provider-data
夹进去就把前后两段正文切成两格),**再占一个 partIndex**。
"这一条会不会变成一格 part"由**引擎与采集点共用的一张表**回答 ——
`planOnethingProviderDataPart`(`agent-loop/providers/provider-data.ts`),
`applyOnethingAgentLoopProviderData` 自己也改用它,不是两处各判一遍。

投影侧:`materializeContentParts` 物化成 `{type:'provider-data', providerData,
turnIndex}`(与引擎逐字同形);`topReasoningPartIndexes` 遇到 provider-data
**跳过而不是中断** —— 引擎判"可见产出"的那一行写着
`orderedParts.some(part => part.type !== 'provider-data')`。

**A14 —— codex 内联生图的正文:确认为真·未承载,已补。**
`provider-data.ts:113-127` 那段 markdown 是引擎调 `handleTextChunk` **合成**的,
provider 流里没有对应的 `text-delta`,`onEvent` 上一条都不会出现,所以采集点确实
看不见它(不是"其实已经记了")。补法是一个回传口:
`ApplyOnethingAgentLoopProviderDataOptions.onSynthesizedText` → 宿主
(`app/engine/stream/agent-loop-executor.ts`)→ `recorder.recordSynthesizedText()`,
走的是与 `text-delta` **同一条** `deltaInto('text')`,合并规则天然一致;
回传的是**落定的那一份** `displayContent`,不是合成前的原文。
不写 `assistant/first-token`(那一条记的是"模型第一次吐字",这段不是)。
**已知残留**:这段合成正文产生在**消费 chunk 的那一刻**,而 recorder 挂在 onEvent
上跑在队列前面 —— turn-end 若已经先到,这段会落进下一个 partIndex。正文的 fold
永远是对的,part 边界在这一条路上不保证;修复前它整段不存在,现在最差是分段偏差。

**A2 —— 图片 part 的闸:改成 kind 豁免,而不是给图片流补记一对 request 事件。**
`isSettleExemptPartKind(kind) === 'image'`。理由写在 reducer 里:图片生成不是
agent-loop 产的,它没有发生过"向模型发一次请求、收齐一次响应"那件事,补记一条就是
往账本里写一件没发生的事,还会连带派生出引擎那边没有的 `firstRequestStartAt` /
`thinkingTime`。`app/session/assistant-parts.ts` 的过时头注释同步改掉。

**A6+A7 —— 工具身份归一进账本,一个判定点。**
`tool/call` 加 `resolvedToolId?` / `displayName?`,值取自**引擎那一个函数**
(`app/engine/stream/stream-processor.ts` 的 `resolveToolIdentity`,身后是别名表 +
MCP 服务器名)。记录器不 import 它(那个函数身后挂着 MCP 管理器与整棵 store 树,
会撑爆记录器的模块图,单测当场炸),而是走**注入端口**
`SessionEventRecorderContext.resolveToolIdentity`,由宿主在 `attachSessionEventRecorder`
那一处接上 —— 与 `onRequestRecipe` 同一条路数。参数解析用 agent-loop 自己的
`safeParseAgentToolArguments`(引擎解出来的 args 正是它的产物,而 MCP 短名补全会看参数)。
投影侧 `toolName = displayName ?? name`、`toolId = resolvedToolId ?? audit.toolId ?? name`,
`steps[].type`(`getStepType`)因此自动跟着显示名走 —— 引擎读的就是 `toolCall.toolName`。
`skillUsed` 不动:它的唯一判定点已经在引擎(§10.11 S3.1),事件只是记录那次宣告。

**A5 —— 中段截断遮一整段。**
`truncateFrom{inclusive:true}` 那条 `message/deleted` 早就带着覆盖整段的 replace 与
`sourceEventSeqs`(翻译器一个字没改),错的是归约器只 hide 目标那一格。现在
`hideEventCoveredNodes` 按事件的账本层字段隐藏整段(`sourceEventSeqs` 优先,退回
[start,end])。**只给 `message/deleted` 用** —— 压缩带的也是一段 replace,但那是另一种
"看不见"(被压掉的消息在 UI 上照旧显示),所以这段代码没有做成通用规则。

**A4 —— agentId 从占位消息上取,不另立规则。**
不在 `beginSessionRun` 里重写一遍"哪种会话才盖章":`session.agentId` 是**每条会话都有**
的,照它盖章会让普通聊天的投影凭空多出一格;真正的事实是
`stampCollabAgentId`(`stores/sessions.ts`)在 `addMessage` 那一刻按 room/work/agent
三形态盖在**助手占位消息**上的那一格。所以三个 run 入口各自把它递进来 —— 与
`timestamp` / `origin` 完全同一条路数,而且那两格本来就在同几行读同一条消息:
`stream-executor.ts`(send/edit-resend/retry 的交汇点)、
`agent-loop-executor.ts` 的 resume 入口、`rotateSessionRun`(steering;读的是
**落库之后**的那一条,不是 plan 里还没盖章的对象)。
`runs.ts` 因此没有多出任何模块边 —— 它一旦 import 读门面,两个刻意把 store 树挡在
外面的单测(session-chunk-packer / skill-activation-landing)会当场炸。

**F2 —— `hasCompacted` 只认成功的压缩。**
一次失败的压缩在引擎那边就是一条 `role:'system'` 的消息,被角色过滤直接跳过,
**整份历史零影响**。三处一起改:`hasCompacted` 判据加 `status === 'completed'`
(它同时管 `forceCompactedToolResults` 与 `session = undefined`),循环里失败节点
**连 `flush()` 都不做**(否则宿主的 `prepareMessages` 会被劈成两段各跑一次 —— F3 的
同一条病根)。

**F1 —— 压缩之后 providerData 只跟最后一条保留消息走。**
摘要分支里那条规则(`message === recentMessages[last]`)在 surface 路径上没了来源。
`buildHistoryMessages` 加选项 `providerDataLastMessageOnly`(缺省 false = 今天的非摘要
分支一个字不变),判据与摘要分支**逐字相同**(比的是数组最后一个元素,不是"最后一条
被采纳的消息");`materializeModelHistory` 在 `hasCompacted` 时打开它。A1 一补上生产者,
不修这一条就是 codex/claude 压缩后每条消息各带一份加密推理。

#### 新字段的旧文件兜底(§10.16 逐条)

| 新字段 | 缺席时 | 合同测试 |
|---|---|---|
| `assistant/part-end.providerData` | 不产出任何 part(= 修复前的事实) | `A1 fallback: an old part-end without the payload projects no provider-data part` |
| `assistant/part-end.kind:'provider-data'` | 老文件里不存在这个 kind | 同上 |
| `tool/call.resolvedToolId` | 退回 `tool/audit.toolId`,再退回 `name` | `A6+A7 fallback: an old tool/call without the resolved identity keeps the raw name` |
| `tool/call.displayName` | 退回 `name`(= 修复前的 `toolName`) | 同上 |
| `run/start.agentId` | 缺席仍是缺席,不猜 | `A4: run/start carries the agent, and its absence stays an absence` |
| 采集侧不注入 `resolveToolIdentity` | `tool/call` 逐字保持老形状 | `A6+A7: without the resolver the event keeps exactly the old shape` |

A2 / A5 / F1 / F2 **不引入新字段** —— 它们读的都是老文件里早就写着的东西
(part kind、`surfaceOp`/`sourceEventSeqs`、`session/compacted.status`、contentParts),
所以旧账本立刻享受修复,没有第二条兜底路。

#### 合同测试:每一条都验过"不修就红"

新增 `describe('Q1: …')` 8 条 + 采集点集成 4 条。**逐条做过反证**(把修复就地改回旧
写法再跑):

| 改回旧写法 | 变红的用例 |
|---|---|
| 投影不认 provider-data part | A1 分段 / A1 top-推理 / F1 |
| `isSettleExemptPartKind` 恒 false | A2 |
| `message/deleted` 只 hide 一格 | A5 |
| `toolName` 用原始名 | A6+A7 |
| `providerDataLastMessageOnly: false` | F1 |
| `hasCompacted` 不看 status | F2 |
| 失败压缩照旧 `flush()` | F2(靠 `prepareMessages` 探针:切了段就会打两个 `[LAST]` 标记) |
| 采集点不写 provider-data part / 不先收正文段 | 采集点 A1 |
| 采集点不写归一身份 | 采集点 A6+A7 |
| `recordSynthesizedText` 不落 delta | 采集点 A14 |

F2 那条的判据是**字节差**不是口头承诺:场景里挂了一个 40k 的工具结果(压缩口径
per-result 上限 24k,普通口径 200k,正好夹在中间),口径切错当场就是两条线不等。

#### 门(全部实跑)

`typecheck` 3 条老红(provider-dials);`session:gate` 0;`boundary:gate` 13;
`log:gate` 4;`lint:ci` 335 —— **与摘掉本批改动后的数字相同**(那多出来的 1 条来自
P 批在途文件,不是本批);`server:build` 通过;
`ONETHING_SESSION_FREEZE=1 bun run test` = 1141 文件通过 / 2 条老红
(`ui-token-vars` ×2)+ AIProviderTab 的老 flake;
`sessions:shadow-battery` GREEN(207 runs / 333 historyChecks / 0 mismatch);
`sessions:verify:gate` **8 条,基线未动** —— 老会话没有因为新词汇多出任何一条红。

#### 明确没做的(留给后续批)

1. **影子电池没有 provider-data 场景**:电池的假 provider 说的是
   deepseek/openai-compatible 那套 SSE,而 provider-data 只有 `claude.ts` 与
   `codex.ts` 两条产地 —— 要覆盖就得再起一个说 Anthropic Messages 线格式的假
   provider(另一套端点/鉴权/事件名),不是本批的量级。provider-data 目前由合同
   测试的 A/B 两线 + 采集点集成测试(真 agent-loop + 会 yield provider-data 的
   provider)覆盖。
2. **孤儿参数流的工具身份仍是原始名**:引擎的占位卡用的是
   `resolved.displayName`(而 step type 用 `rawToolName`),而
   `assistant/chunks|part-end.toolName` 记的是 provider 原始名。要对齐得再加一格
   (改现有字段的含义会违反 §10.16),而"孤儿 × MCP"是罕见交集,留作公开缺口。
3. **`onMissingSummaryAnchor` 那条路**:摘要锚点找不到时引擎退回非摘要分支
   (逐条求值 providerData),而投影仍按 `hasCompacted` 走 last-only。那条路上两侧
   本来就已经因为 surface 遮蔽而大幅分叉(F3 点名的 `indexOf === -1` 静默退化),
   归 F3 一起收口。

### 13.6 Q2+R 批落地记录(2026-08-20):收口、可见性、崩溃口径

§13.3 的 R 批 + Q 批剩下的两项(A8+A9),外加用户 2026-08-20 的三条裁定
(R-a 崩溃收口以 prepare 为准、R-b 图片正文进 chunks+blob、R-c 切读/迁移前硬检查)。

#### 三条裁定各自落成了什么

**R-a —— 崩溃收口只有一份口径,以 `prepare` 为准。**
新文件 `packages/core/session/interrupted.ts` 是那份口径的**唯一**住处
(`CORE_INTERRUPTED_TOOL_ERROR` / `CORE_INTERRUPTED_PERMISSION_ERROR` /
`CORE_INTERRUPTED_TOOL_STATUS`),三个消费者共用:`app/session/prepare.ts` 的合成、
core 的 `computeInterruptedStepRepair` / `computeInterruptedToolCallRepair`、
投影的 `lingeringToolError`。收口后的四格:

| 格 | 从前(消息侧) | 现在(三处一致) |
|---|---|---|
| `step.status` / `toolCall.status` | `failed` / `cancelled` 各说各的 | **`cancelled`** |
| `step.error` / `toolCall.error` | `Interrupted: app was closed` | **`CORE_INTERRUPTED_TOOL_ERROR`** |
| `step.title` | 改写成 `Interrupted: X` | **不动**(占位标题原样留着) |
| 等审批时被打断 | 只在 toolCall 上写一句 | 两格都写 `CORE_INTERRUPTED_PERMISSION_ERROR` |

标题那一格是这条裁定的关键:那次改写在事件账本里**没有任何来源**,投影永远重建
不出来 —— 留着它就等于让每一条崩溃修复过的消息永远不等。投影侧另外两处跟着改:
`lingeringToolError` 认了 `interrupted` 这一档(从前返回 undefined,于是每条崩溃过
的消息在投影里都少一句话),`prepare` 合成的那条 `tool/result` 被认出来
(判据是那句话本身)之后判 `cancelled` 且**不进** `step.result` / `toolCall.result`
—— 消息侧那次修复只写 status + error。**这是一次用户可感知的变化**(已获批准)。

**R-b —— 生图正文进 `assistant/chunks`,base64 走 blob 占位符。**
`![Generated Image](data:image/png;base64,…)` 那一整段 data URL 落进 blob store,
事件行里留 `onething-blob://<hash>`(`core/session/projection/blobs.ts` 的
`projectionBlobUrl`),投影按同一张表换回去 —— `content` 与 `contentParts` 两格
与 `messages.jsonl` **逐字节相同**。采集口是 `assistant-parts.ts` 的
`recordSynthesizedAssistantText`(会话级,不是 run 级:生图流没有 agent-loop,
但它有 run),挂在**正文落到消息上的那一刻**(`image-stream.ts` 包住注入的
`addMessageContentPart`,而不是 `saveMediaImage`)——两侧因此天然对齐。

`assistant/part-end` 加一格 `synthetic`:这一格是引擎直接落到消息上的,
**不受"这一轮收齐了吗"那道闸管**(它没有 `turn-end`),也**不派生 `turnIndex`**
(消息上那一格就没有,凭空补一个就每次生图都不等)。

`recordGeneratedImagePart`(S1b 缺口 3 记的那条 `kind:'image'` part)**退役**:
它产出的是一格产品里根本不存在的 `ContentPart`(§9.2 那条"故意不掩盖的偏差"
说的就是它),而真正的正文整段缺席。老账本里的那些 image part 照旧按 A2 的豁免
物化(修复前的事实,一个字节不改)。

**R-c —— 切读/迁移前硬检查,不复活锁。**
- `scripts/migrate-sessions-events.mjs`:活的 core(pid 活着 **且** 发现文件上那个
  端口连得上)= **拒绝运行**,退出码 3,dry-run 与 --apply 两条路都拦,**没有绕过
  开关**。理由写在函数注释里:迁移要重编号整份 `events.jsonl`,而活着的 core 正
  拿着内存里的 seq 计数器往同一个文件追加 —— 撞号之后 `surfaceOp: replace` 遮蔽的
  是别人的区间,而校验会照样放行。
- `app/session/read-mode.ts` 加 `warnOnForeignCoreForEventsRead`:`events` 读模式
  下发现另一个活 core 就**喊一声**(不崩 —— 已经开着的桌面不该因为一个环境变量
  挂掉)。`apps/server/src/main.ts` 在 `configureLogging` 之后调它。
- `server:start --force` 的警告升级成明说:两个写者会铸出同一个 seq,
  **事件账本会被悄悄写坏**(replace 遮错区间而校验放行),不再只是"自负后果"。

#### 静态审计其余各项

| # | 落成了什么 |
|---|---|
| **A8** | `tool/result` 的 `{blob}`(正文与 `resultData` 两支)在物化时经注入的 `resolveBlob` 换回**全文**:`steps[].result` / `toolCall.result` / 结构化结局与标题全都跟着回来。换不回来就照实留引用 + 一条 issue |
| **A9** | `user/message` 附件的 `base64Data` 同一条路回填(消息路上换不回来**照实留引用**,模型历史路上仍然摘掉 —— `{hash,bytes}` 当 base64 发出去是最难查的一类脏请求) |
| **F6** | 每一次退化产出一条 `ProjectionIssue`(`blob-missing` / `turn-split-fallback`)。宿主端 `app/session/projection-blobs.ts` 是**唯一**装配处:计进 `session-shadow-stats.json` 的 `projectionIssues`、每会话 warn 一次;`sessions:verify` 单独打印一段(**不进门** —— 它说的是历史数据缺了什么,不是新代码弄坏了旧文件) |
| **A12** | 投影 join `permission/asked`(无 `answered`、无结局)→ `toolCall.status='pending'` + `requiresConfirmation:true`、`step.status='awaiting-confirmation'`,逐字镜像引擎的 awaiting 分支。**批准与拒绝都**收掉这个状态(修之前归约器对批准那一条整条跳过) |
| **A11** | `tool/call` 加 `hidden?`,值来自引擎那一个判定点(`stream-processor.ts` 的 `rememberVisibility`,`publish` 这个入参从此只在那一处被解释),经注入端口 `isToolCallHidden` 回传给记录器;投影把 hidden 的调用从 `toolCalls[]` / `steps[]` 摘掉,**轨迹与审计照旧看得见** |
| **F3** | `prepareMessages` 对**整份保留序列**跑一次(切段发生在 prepare 之后,按每条消息在原序列里的位置归段);成功的压缩却什么都没遮蔽 = 新的 surface 违规 `compact-anchor-unresolved`(写侧同时 warn 一句) |
| **F8** | 回合重放的硬条件由引擎导出(`canSplitHistoryTurnGroups`,判定点仍只有一个),投影在**自己**那份物化消息上算一遍:多回合消息掉回 collapsed 时记一条 issue。字节一个没改 —— 要的是"退化看得见" |
| **F13** | ①攒着的批与开着的段在**开它的时候**就记下自己的 runId(2 秒定时器晚于 `endSessionRun` 也不再丢账);②`endPart` 的 `finishedParts.push` 挪到 `if (!id)` 之后(从前写不出去的段仍然进了 `request/response.parts` 的指纹表);③开不出段计一个 `droppedParts`;④`findLastSessionEventSync` **先问这个进程刚写过什么**(`event-log.ts` 的 `lastByType`),文件读退回冷启动兜底 |
| **翻译器守卫** | `app/session/content-part-guard.ts`:进消息的 part 分三档(承载 / 判据豁免 / 红)。开关与深冻结同一个(`ONETHING_SESSION_FREEZE`,vitest 下默认开)——开发期当场抛,生产期每种类 warn 一次。两个调用点(命令面 + store 面)共用一个判定函数,因为引擎的 `persistTurnContentParts` 走的是后者 |
| **F4** | 模型历史的宿主配方合同搬进 `app/session/__tests__/projection-contract-host.test.ts`(core 的测试不许 import 装配层)。第一条用例就是 F4 点名的那格:老会话的裸 `contextUpdate` 在宿主配方下逐字渲染,而 core 缺省配方根本不认识它 —— 用例里连"两者不同字节"一起钉住 |

#### 新字段的旧文件兜底(§10.16 逐条)

| 新字段 | 缺席时 | 合同测试 |
|---|---|---|
| `tool/call.hidden` | 可见(= 修复前的事实) | `A11: without the port the event keeps exactly the old shape` / `A11: … its absence means visible` |
| `assistant/part-end.synthetic` | 照旧按收齐闸判、照旧派生 turnIndex | `R-b: an image turn …`(尾部那段 legacy 断言) |
| 正文里的 `onething-blob://` | 老账本里不存在;换不回来时**原样留占位符** + 一条 issue | `R-b: an unresolvable image blob keeps the placeholder and reports it` |
| 未注入 `resolveBlob` | 引用照实留着(消息)/ 摘掉那一格(模型历史),两条路都记 issue | `A8` / `A9` 两条的后半段 |
| 未注入 `isToolCallHidden` | `tool/call` 逐字保持老形状 | 同上 |

#### 合同测试:每一条都验过"不修就红"

新增 `describe('Q2+R: …')` 12 条 + 宿主配方 3 条 + 采集点/守卫/迁移 8 条。
**逐条做过反证**(把修复就地改回旧写法再跑,脚本化):

| 改回旧写法 | 变红的用例 |
|---|---|
| 结果 blob 不回填 | A8 |
| 附件不回填 / blob 缺失不记 issue | A9(两条) |
| `hidden` 不生效 | A11 |
| 不 join `permission/asked` | A12 |
| `interrupted` 不给话 / 合成结局当 failed | R-a 投影、A12×R-a |
| 消息侧改回 `failed` + 标题改写 | R-a(两侧对齐那条) |
| `synthetic` 不豁免闸 / 正文占位符不回放 / 采集点不换占位符 | R-b(三条) |
| `prepareMessages` 分段跑 | F3(一次) |
| 压缩锚点解不出不报违规 | F3(违规) |
| 不算回合重放硬条件 | F8 |
| `findLastSessionEventSync` 不问内存 | F13(内存优先) |
| `openPart` 静默丢账 | F13(计数) |
| 守卫什么都放行 | 翻译器守卫 |
| 宿主配方换回 core 缺省 | F4 |
| 迁移不拦活 core | R-c |

影子电池加一条 `permission-approved`:审批**批准**之后那条消息两侧仍要逐字相同
(修之前归约器对 `approved:true` 整条跳过,而 A12 之后那条事件是收掉"等确认"
状态的唯一来源)。**明确没进电池的两条**:崩溃中断(要杀掉进程再对同一个 store
重启,电池驱的是一个活 server,不可驱动)与生图(假 provider 说的是 SSE 文本流,
生图走的是 provider 的 image API + apiKey)—— 两者都由单测覆盖:
`prepare.test.ts` + 合同 `A12 × R-a` / `synthesized-text.test.ts` + 合同 `R-b`。

#### 门(全部实跑,数字见提交说明)

`typecheck`(3 条老红 provider-dials)/ 全量 `ONETHING_SESSION_FREEZE=1 bun run test` /
`session:gate` / `boundary:gate` / `log:gate` / `lint:ci` / `server:build` /
`sessions:shadow-battery` / `sessions:verify:gate`。

**`sessions:verify:gate` 的基线会动**:R-a 改了 sanitize 的输出,而**已经被旧代码
修复过**的那些历史会话上写着旧口径(`failed` / `Interrupted: app was closed` /
被改写过的标题),它们不会被再修一次(修复只认 running/pending)。所以那些会话
的投影(新口径)与磁盘(旧口径)从此不等 —— 这是**一次性的、历史数据侧的**位移,
不是新代码弄坏了旧文件。S2b 的迁移对这类会话按 §10.16 的既有做法处理:
`message/imported` 快照压过修复前的缺陷事件段。

#### 明确没做的(留给后续)

1. **F9 的第二半**:`request/recipe` 从第 2 轮起记的不是实际发出的那一份 ——
   归 recipe 采集形状本身的重设计(§13.4 已列)。
2. **孤儿参数流的工具身份**仍是 provider 原始名(§13.5 尾巴第 2 条,未变)。
3. **A11 的采集时机**:记录器跑在 provider 流上、比消费 chunk 的执行器早一步,
   所以对"参数流从没开过头"的补位调用,藏与不藏的决定与 `tool/call` 落账几乎同刻,
   答不上来时按可见记。今天生产里 `publish:false` **没有产地**(agent-loop 那条路
   一次都不传),所以这一格是给将来的守卫,不是在描述现状。
4. **A12 的 `toolCall.error`**:引擎在 awaiting 那一刻写的是工具返回的那句
   `result.error`,而事件账本上没有它(那条路根本没有 `tool/result`),投影因此
   不产出这一格。
5. **生图的错误分支**:失败时只 `updateMessageContent`、不写 contentPart,
   账本上因此没有那段正文(采集口挂在 `addMessageContentPart` 上)。
6. **S2b 归属的项**:切默认读模式、迁移脚本的 `--apply`、W-A/W-E 两个崩溃窗口。

**剩下的 §13 项**:F9 第二半(recipe 采集形状)、孤儿 × MCP 的工具身份归一、
以及 S2b 名下的那几项(切读、迁移 apply、W-A/W-E)。A/F 两系的其余全部收口。

### 13.7 真机第五批(2026-08-20 深夜):三条**修完之后**新长出来的不等

背景与前四批都不同:桌面在 21:48 起来(HEAD `fd351702`,P/Q1/Q2+R 全在里面),
21:49 之后 `session-shadow.jsonl` 又长了三行 —— 全在 `5e4d2cea`。所以这三条不是
"旧文件的历史残余",是**今天的代码在今天的执行上**记下的。

诊断法与 §13 同一条:不猜,把那条会话拷到临时目录只读回放
(`foldSessionProjection` + 宿主配方 `historyProjectionRecipe`),
拿投影与账本逐字节对。

#### 0 号发现:影子**没有**跳过,而且它跳得对

报告里 `skipped: {}`,第一反应是 P 批把 `sessionEventCoverageIsPartial` 改坏了。
不是:这条会话的 `events.jsonl` 从 `seq 1 = session/created` 开始,41 条消息
**一条不缺**地在 `state.byMessageId` 里(回放实测 missing = 0)。它不是混合覆盖
会话 —— `legacyPartial` 沉默是因为**没有可豁免的东西**,三条不等全是真的。

#### 第一/二条(kind:history,run `b1e3c4d9`):投影少了整整一条助手消息

现象:A 187 条 / B 181 条,缺的 6 条正是这个 run 自己那条助手消息
(`d4b669fa`)按回合拆出来的 assistant/tool 段;而它后面那条 steering 用户消息
两边都在。**判据是字节级的**:把投影那条消息的 `isStreaming` 摘掉再物化,
长度与每一格的字节数逐一对上影子日志记下的 A(184/187 条,
230 / 7952 / 2072 / 8217 / 10307 / 4519 / 59)—— 两侧唯一的差别就是这一格。

- 投影侧:`chat-messages.ts:170` —— `run/start`…`run/end` 之间的助手节点带
  `isStreaming: true`,而 `buildHistoryMessages`(`core/engine/history.ts:812`)
  **跳过 isStreaming 的消息**。投影说的是实话:那次执行当时确实还在跑。
- 抄本侧:那条消息**当时已经不是 streaming 了**。全仓能在 run 中途清掉这一格的
  只有一条路 —— `session-repository.ts` 的 `getSession()` 冷加载修复:
  LRU 默认 10 条(`cacheSize ?? 10`),一次活着的执行中途被挤出去,下一次
  `getSession` 从盘上读回来时 `sanitizeSessionOnStartup` 把**正在跑的那条消息**
  当成上一个进程的崩溃残留修了(清 `isStreaming`、把 running/pending 的
  step / toolCall 改写成 cancelled),而且 `loadSessionWithAdapters` 还会把这一份
  `saveSession` 写回盘。真机现场吻合:那一分钟里(turn 2 请求 13:49:26 与 turn 3
  请求 13:49:42 之间)设置窗口刚被打开(app.jsonl 13:49:29/30 有它的 renderer 引导),
  而 turn 2 的那次请求两侧还是相等的 —— 分岔正好发生在这中间。

**裁定:修引擎(§10.10 那条规矩的又一次应用)。** 投影没有说谎,是那条修复落错了
对象。影子只是最先看见它的人:同一次误修还会让"停止"找不到那条流式消息
(`stream-abort.ts` 按 `find(m => m.isStreaming)` 定位)、让正在执行的工具在 UI 上
变成 cancelled、让半条助手消息进入任何一次历史重建。

**修法**:崩溃修复只在**这个进程第一次接手**这条会话时做一次
(`session-repository.ts` 的 `repairOnFirstTouch` + `processOwnedSessions`)。
判据用"接手过没有"而不是"有没有活跃 run":读侧不该为了这件事去认识引擎,
而且这条更宽 —— 本进程写过的会话,任何时候再冷加载回来都不是崩溃残留。
写路径(`saveSessionToFile`)也记账(新建 / 只写过没读过的会话同样是本进程的),
`clearAllSessionCache` 清空、删除会话时释放。

#### 第三条(kind:messages,run `d55cf1bd`):steer run 的 `usage` 被扣掉

现象:A 的助手消息带 `usage {cacheRead 1588480 / input 1617045 / output 16284 /
total 1633329}`,B 没有。B 没有是**对的推理配上错的账本**:投影只在
`outcome === 'completed'` 时给 usage(`chat-messages.ts:165`),而账本上这条 run
写着 `interrupted`。

账本为什么是 `interrupted`:那次执行 13:53:50 以 `finishReason: 'stop'` 正常收流
(引擎照常写了整次执行的 usage),但 `run/end` 是 **13:56:03** 才出现的,由下一条
用户消息进 `beginSessionRun` 时按"陈旧 run"补的(`runs.ts:126`)。根因在收尾的
归属判据:`executeMessageStream` 的 finally 拿的是**进门时**那个 runId
(`stream-executor.ts:196`),而 steering 在执行中途 `rotateSessionRun` 换了一条;
`endSessionRun` 只认 `handle.runId === runId`,于是那一下直接 return —— 这次执行
**从来没有收掉自己的 run**。

**修法**(`runs.ts`):`SessionRunHandle` 记住这次执行轮换之前用过的 runId
(`continuedRunIds`,`rotateSessionRun` 传承),`endSessionRun` 的归属判据改成
"**这次执行的 run**"而不是"这一个 runId"。跨执行不传递:一次迟到的收尾仍然收不掉
别人的 run(用例钉着)。

**只读回放实证**(文件原字节,§10.16):把那条 run 的 `run/end.outcome` 换成修好
之后会写的 `completed` 再跑一次 run 断言 —— `equal: true`;不换就是影子日志上那条
`0.usage`。usage 的数字也对得上:`b1e3c4d9` + `d55cf1bd` 两条 run 的
`request/response.usage` 求和 = 消息上那一份,一个 token 不差。

#### 机器测试为什么又没拦住(§10.17 的同一个问题,这次答案更难看)

`sessions:shadow-battery` 里**有** steering 场景,而且一直是绿的 —— 因为
**bug 自己把能抓到它的那道断言关掉了**:run 断言排在 `endSessionRun` 里,而这个
bug 的症状恰恰是那条 run 永远没有收尾。实测:同一套电池,修之前
`runs = 216`,修之后 `runs = 234` —— **18 次 run 断言从来没跑过**(而且补跑之后
全绿)。教训记在这里:一个"永远不发生的收尾"在计数上表现为"少了 18 次比对",
而门只看 `runs ≥ 200` 与 `mismatches = 0`,两个数都没喊。

#### 门(全部实跑)

`typecheck` 3 条老红(provider-dials);`ONETHING_SESSION_FREEZE=1 bun run test`
1142 文件通过 / 2 条老红(`ui-token-vars` ×2)+ AIProviderTab 老 flake;
`session:gate` 0 / `boundary:gate` 13 / `log:gate` 4 / `lint:ci` 335 —— 全部无新增;
`sessions:shadow-battery` **GREEN**(234 runs / 351 historyChecks / 0 mismatch)。

`sessions:verify:gate` 的基线**加了一行**(`5e4d2cea` 的 `2bf9d289`):它是
**修复前的代码**昨晚写死在盘上的那条 `interrupted`,与既有的 `03e1006d`
(§10.16 那条 prepare 补的)同类不同产地。修好之后不再新增。

#### 回归用例(逐条做过反证)

| 用例 | 改回旧写法 |
|---|---|
| `crash-recovery.test.ts`:`does not crash-repair a live session this process evicted mid-run` | 修复恒真 → 当场红(`isStreaming` 被抹) |
| `crash-recovery.test.ts`:`still repairs on the first touch…` | 保底:新进程第一次接手照旧修 |
| `event-translator.test.ts`:`closes the rotated run — with the runId the execution walked in with` | 归属判据只认 runId → 红(账本上只剩一条 `run/end`,下一次开张补一条 `interrupted`) |
| `event-translator.test.ts`:`a worse outcome still wins after a rotation` | 同上 → 红 |
| `event-translator.test.ts`:`still refuses to close another execution's run` | 守住旧保证(轮换的凭据不跨执行) |

#### 明确没做的

1. **冷加载本身的"陈旧读"**:被淘汰的活会话再读回来,读到的是盘上那一份 ——
   300ms 节流窗口内还没落盘的写入不在里面(`pendingSessionValues` 只兜底
   `getLatest`,没接读路径)。这次只堵住了"把活的当死的修",没有堵住"读回来的
   可能比内存里旧"。归 LRU/丢写那条老线(07-11 审计)。
2. **两写者**:另一个进程崩在流式中途、而本进程已经接手过这条会话时,这一格
   `isStreaming` 要等下次启动才被清掉。两写者本来就是已知的接受风险区间。
3. **F9 第二半**不变:history 断言的 A 侧从第 2 轮起是一次**重建**,不是当时真正
   发出去的字节 —— 这三条不等说明的是"投影与抄本的重建不一致",不是"模型看到了
   另一段历史"。

### 13.8 真机第六批(2026-08-21):**收场那一刻引擎写了什么**,与生图失败的正文

`session-shadow.jsonl` 在 §13.7 修完之后又长了四行,两两成对:

| 会话 | kind | 差在哪 |
|---|---|---|
| `web-7abaca68`(bash `sleep 20`) | messages | `steps.0.result` A=`{"content":[]}` B 缺席;`steps.0.title` A=`sleep 20` B=`调用工具: bash` |
| `fd899977`(ask_user) | messages | `steps.1.result` A=那段 `{"interaction":"ask_user","outcome":"aborted",…}` B 缺席;`steps.1.title` A=`提问已取消` B=`调用工具: ask_user` |
| `web-40232e65` / `web-da46cc33` | messages | `content` A=`图片生成失败: fetch failed` B=`""` |

两条都是**采集缺口**,不是投影说错了话。

#### 第一类 —— 工具**已经派工**时按下停止

与 §10.14 第 7 类(`abort-mid-tool-input`)差一步:那一格停在参数流上,`tool/call`
根本不会来;这一格参数已经定稿、工具正在跑。账本上因此有 `tool/call`、有
`tool/audit{outcome:'aborted'}`,**唯独没有 `tool/result`** —— agent-loop 的那条
`tool-result` 流事件永远不会到。

而**消息上**引擎那一刻是有话说的,三样东西并存:

- `step.result` —— 执行途中已经落下的结局正文。两个产地都是引擎的既有代码:
  `applyAgentLoopToolMetadata`(工具的 `annotate{metadata}` → `JSON.stringify(metadata)`,
  ask_user 那段 aborted 结局就是它)与 `buildAgentLoopToolPartialStepUpdate`
  (最后一次 partial 的正文,被杀的 bash 那句 `{"content":[]}` 就是它);
- `step.title` —— 工具自报的 `annotate{title}`(`sleep 20` / `提问已取消`);
- `status:'cancelled'` + `error:'User cancelled'` —— 收场修复
  (`finalizeLingeringAgentLoopToolWork`)加的那两格,它**不动**上面两格。

**修法:在那一个收场点采一次。** 采集点是
`app/engine/stream/agent-loop-executor.ts` 的 `captureCancelledToolResults`,排在
`emitAgentLoopFinalMessageUpdateWithAdapters` **之后**(收场修复经命令面落盘之后
才读得到,COW 的老坑)。它从消息上读 `status === 'cancelled'` 的那些 step,把
`{callId, result}` 交给记录器的新口 `recordCancelledToolResults` —— **不在这里第二次
派生任何一格**(§10.10)。哪几次调用还没有结局由记录器自己说了算
(`callSeqByCallId` 就是那张表,报过结局的调用一个字都不会被重写);标题取
`reportedTitleByCallId`,与正常那条 `tool/result` 同源。

事件上多一格词汇:`tool/result.cancelled: true` —— "这条结局是收场修复记下的,
不是工具自己报的"。投影据此复刻消息侧的四格(全部在 `projection/reducer.ts`):

| 格 | 规则 |
|---|---|
| `toolCall.status` / `step.status` | `tool.cancelled` → `cancelled`(引擎写的就是它) |
| `toolCall.result` | **没有** —— 那次修复只写 status + error(`toolResultFields` 短路) |
| `toolCall.error` / `step.error` | 仍由 `lingeringToolError` 从 run 的收场方式派生;判据从"没有结局时刻"放宽成"没有结局时刻**或**这条结局是收场记的" |
| `step.result` / `step.title` | 记下来的那段正文 / `reportedTitle` |

`isError` 照实写 `false`:收场判死不是"工具失败",那句话不是工具报的错。
**什么都没留下**的那次调用也照记一条(账上多一个结局时刻),而投影的每一格与
"没有这条事件"逐字相同 —— 合同里有一条用例专门钉这个等式,所以采集点不必先问
"引擎写过东西没有"。为此 reducer 多一条例外:`cancelled` 的结局**不走**
`resultPreview` 那条老文件兜底(退回预览会凭空造出一格 `step.result: ''`)。

两处交汇都验过:①`prepare` 的悬空扫描判据是"这次调用有没有 `tool/result`",
真的有了就既不再合成中断结局、也不会因此多写什么(`prepare.test.ts` 新用例);
②R-a 的 `lingeringToolError` 不会被这条真结局盖掉 —— 它本来就是从 run 的收场
方式派生的,与结局正文无关。

#### 第二类 —— 生图**失败**分支的正文没有落点

R-b(§13.6)把生图正文接进了账本,采集点挂在 `addMessageContentPart` 上 ——
而**失败分支根本不写 contentPart**:`image-generation.ts` 只
`updateMessageContent('图片生成失败: …')`,然后 `streaming=false`、flush。
`event-translator` 的 `sanitizePatch` 又按设计把 assistant 的正文从
`message/patched` 里剥掉,于是账本上那条消息的正文整段缺席。

**修法:同一条路照记,形状说清楚。** `CoreImageStreamStoreAdapter` 多一格
`updateMessageErrorContent`(缺席时退回 `updateMessageContent`,行为一字不变)——
单独一格是必须的:`updateMessageContent` 在**成功**分支也会被调用一次,挂在它
上面会把同一段正文记两遍。宿主在 `image-stream.ts` 把它接到
`recordSynthesizedAssistantText(…, { contentOnly: true })`,位置与 R-b 的成功
分支一样(正文落到消息上的那一刻,早于 `streaming=false` 与 run 收尾)。

`assistant/part-end` 因此多一格 `contentOnly`:这一段只落在 `message.content`
上,引擎没有给它建 contentPart。投影里 `materializePartText`(content 的 fold)
照收,`materializeContentParts` 跳过 —— 只写一格是这条分支的**事实**,补一格
contentPart 就是新的不等。

#### 新字段的旧文件兜底(§10.16 逐条)

| 新字段 | 缺席时 | 合同测试 |
|---|---|---|
| `tool/result.cancelled` | 老账本里那些调用**根本没有** `tool/result` → 投影照旧走"没等到结局"那一支(占位标题、没有结局正文)= 修复前的事实 | `§13.8-1 fallback: an old ledger without the cancellation result keeps the placeholder` |
| `assistant/part-end.contentOnly` | 照旧两格都产出(修复前进账本的合成正文只有生图**成功**那一种,它本来就有 contentPart) | `§13.8-2 fallback: without the flag the body still becomes a contentPart` |

#### 合同测试:每一条都验过"不修就红"

`projection-contract.test.ts` 新增一个 `describe('§13.8: …')` 6 条(A 线走的是
引擎本人那个收场函数 `finalizeLingeringAgentLoopToolWork`,fixture 只描述"工具
在飞时留下了什么"),外加采集点 2 条(`session-event-recorder.test.ts`)、
生图失败 1 条(`synthesized-text.test.ts`)、prepare 交汇 1 条(`prepare.test.ts`)。
**逐条做过反证**(脚本化,把每一处改回旧写法再跑):

| 改回旧写法 | 变红的用例数 |
|---|---|
| B 线不记那条收场 `tool/result` | 2 |
| `toolResultFields` 不为 cancelled 短路(结局对象又爬回 `toolCall.result`) | 2 |
| `step.error` 不认 cancelled(有结局正文时那句收场话被吞) | 2 |
| `toolCallStatus` 不认 cancelled | 4 |
| `lingeringToolError` 的判据不放宽 | 4 |
| `resultPreview` 兜底不排除 cancelled(凭空多一格 `step.result: ''`) | 2 |
| `materializeContentParts` 不跳过 `contentOnly` | 1 |

#### 影子电池:两格新场景,都验过反向

- **`abort-tool-in-flight`** —— 假 provider 派一条真的慢命令(`bash sleep 20`),
  驱动方等到调用 `executing` 再按停止。断言除了 `cancelled` / `User cancelled`
  之外,专钉 `step.title === 'sleep 20'`(修复前这里是占位标题,影子当场记一条)。
  与既有的 `abort-mid-tool-input` 补位:那一格是参数流,这一格是派工之后。
- **`image-generation-failure`** —— 会话钉在 `dall-e-3` 上就转进生图特化流,
  请求打到假 provider 的 `/v1/images/generations`(那里固定回 500),失败分支
  因此天然发生。断言 `content` 以"图片生成失败:"开头 **且 `contentParts` 为空**。

反证实跑:把两处采集点各注释掉一行重建 bundle,同一套电池
`abort-tool-in-flight` 与 `image-generation-failure` 各记 2 条 mismatch,门 RED;
装回去 GREEN。

#### 门(全部实跑)

`typecheck` 3 条老红(provider-dials);`ONETHING_SESSION_FREEZE=1 bun run test`
1143 文件通过 / 2 条老红(`ui-token-vars` ×2)+ AIProviderTab 老 flake;
`session:gate` 0 / `boundary:gate` 13 / `log:gate` 4 / `lint:ci` 335 —— 全部无新增;
`server:build` 通过;`sessions:shadow-battery` **GREEN**(21 场景 × 8 pass,
224 runs / 320 historyChecks / 0 mismatch)。

`sessions:verify:gate` 的基线**加了 4 行**(9 → 13):就是上表那四条真机残余。
它们是**修复前的代码**昨夜写死在盘上的,与本次改动无关 —— 反证做过:把整批改动
`git stash` 之后跑同一道门,这 4 条一字不差地照样在。理由逐条写在基线文件的
注释里(与 §13.7 的 `2bf9d289` 同类)。

#### 明确没做的

1. **正常收尾那条路上的未结调用**:采集点挂在 `emitFinalAssistantMessageUpdate`
   (中止 / 请求最终出错两条路)。`completeAgentLoopStreamWithAdapters` 那条成功
   收尾的路没有挂 —— 那里出现未结调用意味着 agent-loop 自己漏了一次结局,今天
   没有已知产地。要挂的话是同一个函数,一行。
2. **等确认时被中止**:桌面的 `cancelOnethingStreamingStepsForAbort` 会把
   `awaiting-confirmation` 的 step 也改成 `cancelled`,而它**不写** `error`
   (`engineWouldRepair` 只认 `running`);投影那边 `lingeringToolError` 照给一句。
   这一格两侧本来就不等,与本批无关,采集点只是照样记一条空结局(不改变任何
   一格投影)。归 A12 的尾巴。
3. **`step.partialResult` / `partialResultIsPartial`**:判据表里它们是派生缓存
   (§9.4),两侧不比,所以这条收场结局不写 `resultData` —— 写了反而会让
   `toolCall.result` 凭空长出来。

### 13.9 真机第七批(2026-08-21):**外部执行器**那条路上,一次请求不等于一个回合

三条不等,一条误报,外加一条从 2026-08-19 起就躺在 `session-shadow.jsonl` 第一行、
从未诊断过的老账。

| 会话 | kind | 差在哪 |
|---|---|---|
| `web-14d8bc3f`(provider `claude-code-agent`,一次工具调用) | messages | `1.contentParts.0.turnIndex` / `1.contentParts.1.turnIndex` a=2 b=1;`1.steps.0.usage` a=(absent) b={cacheRead 62254, cacheWrite 10800, input 4, output 93, total 97} |
| `agent-exec-…`(Iris 的 agent 执行会话,`lastMismatchAt` 1787242767681) | messages | `1.source` a=`collab-turn` b=(absent) |

#### 0 号发现:"5 条 `assistant/part-end` 都没有 `kind`"是**误报**

工单里的第三条不成立。逐字节读那五行,`kind` 一格不少:
`tool-input` / `text` / `provider-data` / `text` / `provider-data`。产生误报的是**读法**——
一个把长字符串截断的转储脚本把 `'provider-data'`(13 字符)截成了 `'provider'`,看起来
像另一个词汇,顺手也让人以为整格缺席。采集点这条路一个字都不用改。
(教训与 §10.16 第二条同源:**看文件原字节**,别看自己写的摘要。)

#### 病根(前两条是同一条):账本的回合词汇只有 `requestIndex`

引擎的 `turnIndex` 只在两处动:
① `turn-start` —— `state.turnIndex = turn`(`applyAgentLoopTurnStartWithAdapters`);
② **每一条 finish chunk** —— finishReason 属于 tool-calls 那一族时 +1
(`planAgentLoopFinishChunk`)。而记录器给 `requestIndex` 发号只在 `turn-start`。

平时两者恒等(一次请求 = 一条 finish = 一个回合),于是投影一直靠
`turnOf(requestIndex)` 推回合号,并且推得对。**外部执行器**(Claude Code SDK 连接器)
把一整段多轮会话装进一次 `streamTurn`:每当"工具结果到齐、新一轮正文开始",它就发一条
`finish(tool_calls)` 当轮分界(`external-agents/claude-code-connector.ts` 的
`withRoundBoundary`),而 `agent-loop/runner.ts:448-456` 那段 2026-08-11 的判据
(有调用、且一个都没进本地执行队列 = 外部执行)**当场转发**它。于是:

- 引擎的回合号在一次请求里从 1 涨到 2 —— 工具之后的正文与 provider-data 是第 2 回合
  (真机 `contentParts.*.turnIndex` a=2),投影推出来是 1;
- 带 usage 的是**最后**那条 finish(轮分界那几条不带 usage),引擎的
  `updateStepsUsageByTurn` 因此把这次请求的用量记在第 2 回合上,第 1 回合那个工具 step
  **一格 usage 都没有**(a=absent);投影按 `turnOf(requestIndex)=1` 发下去,凭空多一格。

回合号不只影响这两格:`turnIndex !== 1` 是"开头那段推理算不算 `top`"的判据,而模型历史
按它把一条消息拆成 assistant/tool 交替段(`buildHistoryMessages`)。这条路上多轮工具是
常态,所以它必现于每一次 claude-code-agent 的工具回合。

#### 修法:判定点搬出来,采集点照抄,投影只读不推

1. **一个判定点**(§10.10):`isAgentLoopToolCallsFinishReason` 与新的
   `nextAgentLoopTurnIndexAfterFinish` 搬进 **`packages/core/engine/agent-loop-turn.ts`**
   (44 行、零依赖的叶子文件),`agent-loop-executor.ts` 改成 import + 原样再导出
   (导出路径一字未改),`planAgentLoopFinishChunk` 自己也改调它。单独立文件的理由是
   记录器要读它:引 `@onething/core/engine` barrel 会把整棵执行器模块图拖进记录器的
   单测(与 A6+A7 当年不 import `resolveToolIdentity` 同一条理由)。别名表加一行
   `@onething/core/engine/agent-loop-turn`(排在 barrel 之上)。
2. **采集点镜像引擎的回合号**(`session-event-recorder.ts`):`state.turnIndex` 在
   `turn-start` 上取 `event.turn`、在**新增的 `finish` 分支**上调上面那个函数推进,
   并记下推进**之前**那个值(`usageTurnIndex` —— 引擎的 `updateStepsUsageByTurn` 正是
   排在推进之前)。镜像是可靠的:记录器挂在 `onEvent` 上、执行器消费的是由同一条
   有序事件流派生的 chunk 队列,两边看到同一条 finish 的相对位置相同。
   分界那一下**还要收段**(`endAllOpenParts`)—— 引擎在那一刻
   `persistTurnContentParts` + 换一份 turn state,不收段的话分界前后的正文会折进同一个
   `partIndex`,投影出来比事实少一格。
3. **四格新词汇**,全部是"引擎盖过的章"的抄本,投影只读不推:
   `assistant/chunks.turnIndex` / `assistant/part-end.turnIndex`(开段时的回合号)、
   `tool/call.turnIndex`(这次调用的回合号)、`request/response.usageTurnIndex`
   (这份 usage 被记到哪个回合的 step 上)。投影侧:`partTurnIndex()` 一个函数收口
   (contentParts、`topReasoningPartIndexes` 的 `!== 1` 判据、孤儿 step 三处共用),
   `tool/call` 的 `turnIndex` 直接读,`usageByTurn` 按 `usageTurnIndex` 落键。
4. **Iris 那条(第三项):A4 少接了同一刻盖的另一格。**
   `stampCollabAgentId`(`app/stores/sessions.ts:719-728`)在建助手占位消息那一刻按
   room / agent 形态**同时**盖 `agentId` 与 `source: 'collab-turn'`;§13.5 的 A4 只把
   前一格接进了 `run/start`。修法与 A4 逐字同一条路数:`run/start.messageSource`
   (名字不叫 `source` —— `run/start` 已经有 `origin.source`,那是入站渠道,两件事),
   三个 run 入口各自从**那条占位消息**上取(`stream-executor.ts` / resume 入口 /
   `rotateSessionRun` 走的同一个 `BeginSessionRunInput`),投影物化成 `message.source`。
   **同类不同产地**:与 A4 是一个批次的漏项,不是新病。

#### 新字段的旧文件兜底(§10.16 逐条)

| 新字段 | 缺席时 | 合同测试 |
|---|---|---|
| `assistant/chunks|part-end.turnIndex` | 退回 `turnOf(requestIndex)`(= 修复前的答案,也是普通 provider 上的同一个数) | `§13.9-1 fallback: an old ledger without the turn stamp derives it from the request` |
| `tool/call.turnIndex` | 退回 `run.turnCount || 1`(= 修复前的写法) | 同上 |
| `request/response.usageTurnIndex` | 退回 `turnOf(requestIndex)` —— 于是用量照旧落回第 1 回合的 step | 同上 |
| `run/start.messageSource` | 缺席仍是缺席,不猜(与 A4 的 `agentId` 同一条) | `§13.9-3: run/start carries the collab turn marker, and its absence stays an absence` |

另有一条"新旧同值"的正面证据:`§13.9-1: without a boundary the stamp and the derivation
agree byte for byte` —— 没有分界的场景把两格新词汇剥掉再投一次,canonical 逐字节相同。
§10.16 那条老的 `pre-fix vocabulary` 用例也顺手改成**连回合号一起剥**(那一代的账本本来
就两样都没有),否则新字段会把 `continuesRunId` 兜底那条断言遮成空转。

#### 合同测试:每一条都验过"不修就红"

`projection-contract.test.ts` 新增 `describe('§13.9: …')` 4 条,采集点集成
(`session-event-recorder.test.ts`,**真的** agent-loop + 一个说外部执行器那套话的假
provider:`externallyExecuted` 的调用 + 中途 `finish(tool_calls)` + 收尾
`finish(stop, usage)`)2 条。fixture 侧多了一格 `RequestSpec.roundBoundary`
(分界之后的工具 / 正文 / provider-data),两条线各写各的。**逐条脚本化反证**:

| 改回旧写法 | 变红的用例数 |
|---|---|
| 采集点不在 finish 上推进回合号 | 1 |
| 采集点分界处不收段(两段正文折进一个 partIndex) | 1 |
| `tool/call` 不带回合号 | 2 |
| `request/response` 不写 `usageTurnIndex` | 2 |
| 投影不认 part 的回合号 | 1 |
| 投影不认 `usageTurnIndex` | 1 |
| 投影不认 `tool/call.turnIndex` | 1 |
| 投影不产出 `source` | 1 |

第 7 行值得记一笔:第一版场景里工具只在分界**之前**调过一次,`run.turnCount` 推出来的
1 与事实相等 —— 那条反证当场是**绿**的。补上"分界之后又调一次工具"(外部执行器多轮
工具的常态)才把它逼红。**一条修复没有反证 = 那条修复今天没有判据**。

#### 影子电池:这条路**表达不了**,如实记在这里

`sessions:shadow-battery` 的假 provider 说的是 deepseek / openai-compatible 那套 HTTP+SSE,
而"一次请求里发好几条 finish 当轮分界"是**外部执行器**(Claude Code SDK 连接器,不走
HTTP 那条路)独有的形状:要在电池里表达,就得把整个 SDK 连接器换成一个假实现,那不是
本批的量级。所以这一批的机器判据是**合同测试 + 采集点集成测试**(真 agent-loop、真
记录器、provider 说的就是那套话),电池只负责证明"普通 provider 上一个字节没变"。
与 §13.5 尾巴第 1 条(provider-data 也无法进电池)同一类空白。

#### 门(全部实跑)

`typecheck` 3 条老红(`provider-dials`);`session:gate` 0 / `boundary:gate` 13 /
`log:gate` 4 —— 全部无新增;`server:build` 通过;
`bunx vitest run app/session core/session app/engine` 全绿。
`lint:ci` **335**(与基线相同;本批改到的 11 个文件逐个跑 eslint 是 0 problem)。
中途曾读到 337 —— 那两条来自同窗真机走查在仓库根目录留下的临时脚本 `scratch-diff.ts`,
它跑完自删之后数字自己回到 335。

`ONETHING_SESSION_FREEZE=1 bun run test` = 1143 文件通过 / 2 条老红(`ui-token-vars` ×2),
11047 例通过。

`sessions:shadow-battery` **GREEN**(21 场景 × 8,224 runs / 0 mismatch)—— 但**第一次跑是
RED**,如实记在这里:`tool-args-truncated` 那一格出了 2 条 mismatch(兜底那一轮的正文
"参数没写完:…" 在抄本上落在引擎新开的第二条助手消息上,在投影上还留在第一条)。之后
之后同一颗种子又跑了 4 次全量、外加该场景单独跑 8 遍,全绿 —— 复现率 1/5 全量跑。
**判定为 §10.15 那条已知未修的身份竞态**,不是本批:
① 这一格的两条 finish 都是 `stop`,`nextAgentLoopTurnIndexAfterFinish` 返回原值 ——
本批新增的 finish 分支在这条路上**既不推进回合号也不收段**,只多写两格数字;
② 消息归属来自 `openPart` 那一刻的 `ctx.getMessageId()` / `currentSessionRunId()`,
本批一个字没动它们;而 `createNextAssistantWriter` 是 `await` 的 —— 记录器赢下这一步就
把段记在上一条消息上,正是 §10.15 定性的"事实在上游、身份在下游"。
③ 修复前后这条 mismatch 的形状逐字相同(那一格 `turnIndex: 2` 两条口径都给 2)。
电池里第一次抓到它,值得单开一张票(§10.15 / U0 的实证之一),但本批不改。

`sessions:verify:gate` 基线**加了 1 行**并附理由(见基线文件注释):真机今夜写下的
`agent-exec-…` 那条 `source` 残余 —— 它的 events 是**修复前**的代码写的,投影走
"缺席仍是缺席"的兜底,改动前后逐字节相同。同一次跑里另有 **2 条 healed**
(`web-7abaca68` / `web-da46cc33`,§13.8 的两条):它们**不是被本批修好的** ——
那两条会话今夜已经从 `~/.onething/sessions/` 上消失了(目录不存在),没有会话就没有比对。
基线里那两行原样留着,等真机稳定之后再统一重录。

#### 顺手记两张票(诊断于 2026-08-21;**连同压缩日志那张共三张,当日已修**,收口见本节末)

1. **删会话不级联 `evals/traces/<sessionId>/`**。轨迹目录的写侧是
   `packages/onething-runtime/src/evals/trace-store.ts:58`(`getTracesDir`)/ `:62`
   (`getTurnTraceDir`)/ `:97`(`createTurnTraceRecorder`),而删除只删会话目录:
   `packages/onething-runtime/src/app/stores/sessions.ts:499`(`deleteSession`,只清三张
   进程内表 + 通知监听器)→ `packages/onething-runtime/src/sessions/session-repository.ts:697`
   (`deleteSessionFile`,`storageDriver.delete(id)` 只管 `sessions/<id>/`)。
   于是每删一条会话,`evals/traces/<sessionId>/` 整棵留在盘上(`pruneTraceRing`
   `trace-store.ts:296` 只按环大小裁,不认"会话没了")。
2. **`POST /api/sessions/:id/model` 会改写空间的 `providers.json` —— 报告的路由说错了,
   但缺陷是真的,在隔壁那条命令上**。逐函数读过:`handleUpdateSessionModel`
   (`app/server/http.ts:1643`)→ `updateSession`(`:1661`)→ 服务端 `sessions.update`
   (`app/server/runtime.ts:2808`)→ `applySessionPatch`(`:5399-5489`)→ `persistSession`
   (`:1442`)全程**不碰** settings,只写会话文件 —— 那条路是干净的 setter。
   真正会写盘的是 CLI 守护进程的 `provider.use`(`apps/electron/src/main/cli/daemon-server.ts:210`)
   → `HeadlessBackend.useProvider`(`packages/onething-runtime/src/app/headless/backend.ts:510-515`,
   `getSettings()` → 改 → `saveSettings(settings)`)→
   `useOnethingHeadlessProvider`(`packages/onething-runtime/src/headless/cli-projections.ts:156-168`:
   `settings.ai.provider = providerId` **不看 `enabled`**,再把 `model` 写进那个
   provider 记录)。拿到的 `settings` 是**合成过的有效设置**:
   `composeEffectiveAISettings`(`packages/shared/defaults/ai-settings.ts:82-102`)给每个
   目录里认识的 provider 都填一个 `{model:'', selectedModels:[], enabled:false}` 空壳
   (只为显示),而落盘时 `splitEffectiveAISettings`(`:111-156`)本该用
   `isBlankProviderRecord`(`:56-74`)把空壳丢掉 —— 一旦 `model` 被写成非空,这道闸就
   失效,于是 `enabled:false` 的空壳连同被翻掉的 `ai.provider` 一起写进
   `workspaces/<id>/providers.json`(`app/stores/settings.ts:114-129` 的 `prepareSave`
   → `writeSpaceProviderSettings`)。

#### 三张票的收口(2026-08-21):都是**产品行为**,不是影子

上面两张票加上压缩日志那张,共三处,当日全部修掉。三处都不在影子链路上 ——
影子只是把它们照出来了。

1. **`provider use` 不再拿一个没开的 provider 去翻空间默认**
   (`packages/onething-runtime/src/headless/cli-projections.ts` 的
   `useOnethingHeadlessProvider`)。病根不在拆分那一侧:`isBlankProviderRecord`
   区分「没表达过」与「表达成关」是对的,把 `{model:'x', enabled:false}` 当成
   「表达过」也是对的 —— 用户完全可以配好模型再把 provider 关掉,那份 model
   必须留着。真正错的是**先改状态、后不校验**:`providers[id]` 在,只说明它
   在目录里有个名字(合成会给每个目录里认识的 provider 补一条全灭壳),不说明
   这个空间配过它。现在 `enabled !== true` 直接抛
   `Provider is not enabled: <id>`,`ai.provider` 与那条壳一个字不动 ——
   选一个没开的 provider 是错误,不是一次静默降级。
   判据:`headless/__tests__/cli-projections.test.ts` 里合成 → 调用 → 拆分
   走一遍,钉住「默认没翻、壳没长出 model、`space.providers` 里没有它」。
2. **删会话级联轨迹目录**。`evals/trace-store.ts` 新出
   `getSessionTraceDir` / `deleteSessionTraces`(id → 目录名的清洗函数收敛成
   `safeTraceSegment` 一处),`app/stores/sessions.ts` 的 `deleteSession` 在清
   三张进程内表的同一个循环里按 id 调它。**不走 `onSessionsDeleted` 那个观察者
   接缝**:那个接缝是给装配层子系统留的(直接引会把层反过来),而 trace-store
   是一片没有回边的产品叶子,直接调既不反层,又让每个宿主(桌面 / server /
   CLI)天然都有,不需要各自注册。别名只登记了叶子
   `@onething/runtime/evals/trace-store`,**故意不登记 `evals` 那颗 barrel** ——
   删会话只需要一个 `rm`,不值得把整套评估台拖进每个宿主的包。
   判据:`app/stores/__tests__/sessions-delete-cascade.test.ts`(会话目录与轨迹
   目录一起消失 / 只收自己那一份 / 没有轨迹也不炸)。
   **孤儿清扫(`pruneTraceRing` 顺手删掉"会话已不存在"的目录)故意没做**:
   轨迹的 sessionId 不保证对应一个盘上的会话文件(评估台与回放跑的是合成 id),
   按「`sessions/<id>` 不在就删」扫一遍,第一个被误删的就是排障时最想要的那份。
   环形淘汰按年龄/体积赶人,定点级联按 id 收 —— 两条各管各的,不互相猜。
3. **压缩失败不再是一句"failed"**。`app/engine/context-compact.ts` 的两道闸
   (空摘要 / 无 `## Goal`)此前只有 `catch` 里那一句
   `compact session failed`,模型到底回了什么一个字不落,失败的压缩因此无法排障。
   现在两道闸各记一条 `log.warn`(`engine.compact`),字段里带
   `providerId` / `model` / 长度,以及返回文本的 **400 字截断预览**(全文可能上万字,
   不进日志)。仍然是 `getLogger` + 结构化字段,没有 `console.*`。

### 13.10 真机第三轮(2026-08-21):压缩标记的第二格 / 收尾排在下一句话后面 / 换 agent 无声

临时 store + `claude-code-agent` 那一轮找出的三条,病根各不相同,但都是
**"两个来源说同一件事"没被收口**。

| # | 症状 | 病根 |
|---|---|---|
| M3 | 一次(失败的)压缩之后投影比 `messages.jsonl` **多 N 条**(N = 尝试次数),活下来的那条冻在 `compacting`,时刻还差 5–9ms | `session/compacted` 无条件再登记一格,而那条标记消息在账本上早已有 `system/message` 那一格 |
| M6 | 冷启动读到 `tool/call \| user/message \| tool/result(interrupted) \| run/end` | prepare 的入口只排在"任何一次**执行**之前",而账本上先落地的是那条**用户消息** |
| M7 | `POST /api/sessions/:id/agent` 在账本上一个字都没有 | 桌面那条路绕开命令面;server 那条路**快照取晚了**(改完才问改之前) |

#### M3 —— 收尾那一格是**换掉占位**,不是再来一格

`context-compact.ts` 是三步:`store.addMessage(标记消息)`(翻译器记成一条
`system/message`,正文 `status:'compacting'`)→ 可选的进度刷新 →
`updateMessageContent(completed|failed)` + `sessionEventTranslator.sessionCompacted`。
正文补丁按 §9.2 不进账本(正文只有一个来源),所以那条 `system/message` 永远停在
`compacting`;而归约器对 `session/compacted` 又 `register` 了一格。两格、一条消息。

**裁定:病在归约器,不在翻译器,也不在采集点。** 两条事件记的都是**真事**
(消息建出来了 / 压缩有了结局),账本没有多写;错的是投影把"同一条消息的第二次
陈述"当成了第二个节点。修法:

- `state.byMessageId` 里已有那条占位 → **隐藏它**,新节点**插在它后面**
  (占位隐藏之后,可见位置正是它原来那一格;两条事件之间登记过的节点仍排在后面,
  与 `messages.jsonl` 同序);
- 新节点的 `time` 取**占位那条消息自己的时刻**(与 `run/start.timestamp` 同一条
  道理:记账时刻晚几毫秒,而消息的 timestamp 才是事实);
- 找不到占位(迁移 / 导入出来的会话)→ 照旧追加,那正是修复前的事实(§10.16)。

**成功的压缩犯的是同一条病。**真机第三轮没驱动起来(摘要必须有 `## Goal`),
判据补在合同里。

**为什么合同测试当年没抓到:B 线 fixture 从来没写那条 `system/message`。**
与 §10.10 的 `stepOf` 同一类空转 —— fixture 自己写下了结论。本批把 `compact()` /
`failedCompact()` 两个 fixture 都改成**照抄翻译器**:先 `system/message`(占位正文)、
再 `session/compacted`(晚一个时钟刻度),失败那条还补上了 A 线的
`compacting → failed` 正文补丁。

#### M6 —— prepare 的口径是"写第一个字之前",不是"执行之前"

prepare 从前两个入口:`beginSessionRun` 的开头、活投影第一次建起来之前。而崩溃
重开之后,`handleSendMessage` 是**先** `store.addMessage`(账本上就是 `user/message`)
**才** `beginSessionRun` —— 于是用户新说的那句话把上一条 run 的合成收尾挤到了自己
后面。内容一直是对的(结局按 callId / runId 归位,与物理位置无关),错的是次序,
而次序正是历史按回合切段时要看的东西。

修法是**加第三个入口,并且它才是那条硬口径**:`appendSurfaceAwareEvent` 的开头 ——
**这个进程往这份账本写第一个字之前**。翻译器与 run 登记处都只走这一扇门,所以它
是唯一一个"覆盖得住"的位置。递归安全靠 `prepareSessionEventsOnce` 自己:它在真跑
之前就把会话记进 `prepared`,合成出来的那几条事件走回这扇门时是一次 `Set.has`。
"不碰活着的 run"照旧由调用点保证 —— 这个入口比另外两个都早。

#### M7 —— 两个产地,两处修,一条规矩

`session/agent-changed` 这个词汇 §9.2 早就有了,翻译器的 `patchSession` 也早就会
写它(`event-translator.ts:275`)。缺的是**产地**:

1. **桌面 / IPC**:`store.updateSessionAgent` 直接走仓库的
   `applyMetadataMutation`(agent 那一格带着"空值回落默认 agent"的规范化,所以当年
   没走命令面),命令面因此从头到尾没被叫到。修:写成功之后调翻译器,`to` 取
   **落库之后**那一格(规范化在仓库里发生,记入参就会记下一个没存进去的值)。
2. **server / HTTP**(`POST /api/sessions/:id/agent` → `sessions.update`):
   `applySessionPatch` **就地改**那只会话对象,而真后端上它正是 app store 里的
   那一份 —— 等 `persistSession` → `sessionCommands.patchSession` 再回头问
   "改之前是什么",问到的已经是改之后的值。修:快照在 `applySessionPatch`
   **之前**取(`sessionMetaFieldsOf`,取快照与取新值用同一个函数),写成功之后
   连同新值一起交给翻译器。agent / model / workdir 三格因此**一起**回来了 ——
   它们本来就是同一条无声。

投影侧:三条 `session/*-changed` 与 `session/created` 折进
`SessionProjectionState.sessionMeta`(`{agentId, model, provider, workingDirectory}`)。
**它不是一条消息** —— 换 agent 在屏幕上什么都不多出来,`materializeChatMessages`
一个字节没改。旧文件缺这条事件就是缺:会话级元数据停在建会话那一刻。

#### 新字段的旧文件兜底(§10.16 逐条)

| 新字段 / 新行为 | 缺席时 | 合同测试 |
|---|---|---|
| `session/compacted` 之前的那条 `system/message` 占位 | 照旧追加一格、时刻退回记账时刻(= 修复前的事实) | `§13.10 M3 fallback: a compacted event without its placeholder still appends a node` |
| `session/agent-changed` | 会话级元数据停在 `session/created` 那一格,不猜 | `§13.10 M7 fallback: an old ledger without the event keeps the created agent` |

M3 / M6 都**不引入新字段**:M3 读的是老账本里早就写着的那条 `system/message`,
M6 只改合成事件的**落账时机** —— 所以旧账本立刻享受修复,没有第二条兜底路。

#### 合同测试:每一条都验过"不修就红"

`projection-contract.test.ts` 新增 `describe('§13.10: …')` 6 条;
`prepare.test.ts` 新增 1 条;新文件
`app/stores/__tests__/session-agent-switch.test.ts`(桌面产地)3 条、
`app/server/__tests__/session-agent-event.test.ts`(HTTP 产地)2 条。
**逐条脚本化反证**:

| 改回旧写法 | 变红的用例 |
|---|---|
| 归约器对 `session/compacted` 照旧无条件 `register` | **7 条**:`compact keeps the UI messages…` / `pushing events one at a time equals folding them all` / `F2` / `F1` / §13.10 M3 三条 |
| `appendSurfaceAwareEvent` 不先 prepare | `§13.10 M6` |
| `store.updateSessionAgent` 不叫翻译器 | 桌面产地 2 条 |
| server 的快照在 `applySessionPatch` 之后取 | HTTP 产地 1 条 + 电池 `agent-switch` |

#### 影子电池:两条新场景,和一处**电池表达不了**的空白

新增两条(全量 23 × 8 = **264 runs / 0 mismatch**,GREEN):

- `compact-failure` —— 假 provider 现在会**故意压失败**:摘要请求自己不带场景标记,
  但它把被压掉的那段历史原样喂了进来,所以 `flat` 里有 `@@bat:compact-failure:…@@`,
  这是驱动那条真机必现路径唯一的抓手。断言:红卡出现、**恰好一条**标记消息、
  账本上 `session/compacted{status:'failed', surfaceOp:'append'}`(失败的压缩不遮蔽
  任何东西)、之后照旧能继续说话。
- `agent-switch` —— 走真的 `POST /api/sessions/:id/agent`,断言消息一条不多、
  账本上**恰好一条** `session/agent-changed{to}`。反证过:摘掉 server 那处修复,
  这一格当场 `the ledger never got a session/agent-changed`。

为此给 `Driver` 加了 `ledgerUntil(type)`(电池自己建的临时 store,场景因此能断言
"这件事**记下来了**",不只是"屏幕上对")。

**空白如实记:电池**结构上**看不见 M3。**影子的 run 断言只比
`assistantMessageId` / `triggerMessageId` / `runId === 本 run` 那几条消息
(`shadow.ts:358-380`),而压缩标记既不属于任何 run,也不是谁的触发消息 ——
所以它永远不进比对窗口。实测:把归约器改回旧写法再跑 `--only compact`,电池
照样 GREEN。**看得见 M3 的是 `sessions:verify`**(整份文件逐条 canonical 比),
见下。

#### 门(全部实跑)

`typecheck` 3 条老红(`provider-dials`);`session:gate` 0 / `boundary:gate` 13 /
`log:gate` 4,全部无新增;`lint:ci` **335**(与基线相同;本批改到的文件逐个跑
eslint 是 0 error);`server:build` 通过 —— 顺带证明了
`event-surface ↔ prepare` 那个新的模块环在**单文件包**里没有 TDZ 问题
(电池起的就是 `dist/server/main.js`)。
`ONETHING_SESSION_FREEZE=1 bun run test` = 1146 文件通过 / 2 条老红
(`ui-token-vars` ×2)+ AIProviderTab 的老 unhandled rejection,11063 例通过。
`sessions:shadow-battery` **GREEN**(23 场景 × 8,264 runs / 0 mismatch,一次跑过)。

**`sessions:verify:gate` ok —— 11 条已知,无新增,并且 healed 了 3 条。**
其中 `fd899977… messages: covered message order differs` 正是 **M3 在真历史文件上
的反证**:把归约器改回旧写法再跑一次,这一行立刻回来(12 条),修好就消失(11 条)——
§10.17 基线里那条"待归类"的 order 差异,病根就是压缩标记的第二格。
另外两条(`web-7abaca68` / `web-da46cc33`)是 §13.9 记过的"会话已从盘上消失",
不是本批修好的。**基线不动**,按 §13.9 的既有做法等真机稳定之后统一重录。

#### 留下的尾巴

1. **影子的 run 窗口挡住了整类"不属于任何 run 的消息"**(压缩标记是第一例,
   系统标记消息是第二类)。今天靠 `sessions:verify` 兜住,但那是**旧文件**的门 ——
   一条新写出来的会话要等它被 verify 扫到才会暴露。要不要给影子加一道"整会话
   canonical"的低频断言,是另一次裁定。
2. **`session/model-changed` / `session/workdir-changed` 的桌面产地仍然缺席**:
   本批只补了 agent 那一格的桌面产地(`updateSessionModel` /
   `updateSessionWorkingDirectory` 走的是同一条绕过命令面的仓库路)。HTTP 那条路
   三格一起修好了。同类不同产地,归下一批。
3. **`sessionMeta` 今天没有消费者**:它是 M7 要求的"投影承载会话级事实"的落点,
   轨迹面板 / 归因要用它得再接一次。

### 13.12 M5 裁定(2026-08-21 用户):文本流崩溃 —— 投影为准,保留半篇

W-B 窗口(F12):进程在助手文本流中途被杀,重启后 `messages.jsonl` 那条助手消息是 `content:''`(被丢),而投影从 `assistant/chunks` 重建出**用户实际已看到的半篇**。真机第三轮 M5 实测两侧确实分叉,方向是"投影更全"。

**裁定:投影为准。** 崩溃恢复保留半篇是事件溯源应有的忠实度;S2b 切读后崩溃后发给 provider 的上下文因此更接近用户所见,是改进不是回归。

连带(S2b 本体一并做,本条不单独动代码):
1. **写侧对齐**:S2b 迁移/切读时,被崩溃截断的助手消息在快照侧也保留半篇 —— 今天 `sanitizeSessionOnStartup` 把它清空(`content=''`)的行为要改成"保留已落盘的 chunk fold",与 R-a 收口口径同批;否则两侧仍分叉,只是方向反转。
2. **半篇 + 未收尾工具一致收口**:半篇文本保留 + 那条中断工具走 R-a 的 `cancelled` 约定(§13.6/§13.8),两者是同一次崩溃的两半,收口口径必须一致。
3. 这条与 F12 表里 W-B "无人收口"的记录合并:W-B 不再是"两侧各错",而是"投影对、快照待 S2b 对齐"。

### 13.13 真机第四轮(2026-08-23):S2b 前把 `sessions:verify:gate` 收干净的四项

真机上 `sessions:verify` 冒出的四类新残余。诊断法与 §13 同一条:把那条会话
拷进只读回放,两路逐字段对读。分类:三项修代码(#2/#3/#4)、一项重录基线(#1)。

| # | 症状 | 病根 | 裁定 |
|---|---|---|---|
| #1 | 一条**中止**的 edit-resend run,消息上有 usage,投影没有 | 修复**前**的引擎在中止路径上仍写了 message-level `usage`;投影按"只有 completed 才结算 usage"这条铁律正确地不产出 | 与 §13.7 `2bf9d289` 同类:重录基线,不改代码 |
| #2 | 压缩卡的时刻比 `messages.jsonl` 晚几毫秒(真机 3–73ms) | M3(§13.10)那次修复读错字段:`placeholder.time` 是 `system/message` 的**记账时刻**,不是那条标记消息自己的 `timestamp` | 改归约器:读 `placeholder.message.timestamp` |
| #3 | 图片附件的 `base64Data` 投影出来是 `�PNG…`(腐蚀) | 附件以**原始字节**落 blob(正确),但读侧一律 `utf8` —— 二进制被改写 | dsh 方案 B:blob 存二进制,读口按 mime 分流(image/* → base64,text/* → utf8),base64 只在边界产生 |
| #4 | 一张 `read` 工具读回来的图片:磁盘脱水态是 `[Image: … omitted]`,投影是全量 base64 | `dehydrate` 省略工具结果里的图片正文、`rehydrate` 不还原;投影(A8)把 blob 换回全文 | 选项 1:投影**也**省略,复用**同一把** `dehydrate` 函数 |

#### #2 —— 压缩卡取标记消息自己的 timestamp

`packages/core/session/projection/reducer.ts` 的 `session/compacted` 分支:
`time` 从 `placeholder?.time ?? event.time` 改成
`(placeholder.kind==='message' ? placeholder.message.timestamp : undefined) ?? placeholder?.time ?? event.time`。
`placeholder.time` 是 `addMessageNode` 记的 `event.time`(记账时刻),而真事实是那条
标记消息自己的 `timestamp`。合同 fixture 当年抓不到,是因为它把 `system/message`
事件的 `time` 写成与消息 `timestamp` 相等 —— 合同里新增一条**故意错开**两者的用例
(`§13.13 #2`,completed / failed 各一),反证:读回 `placeholder.time` 当场红。

#### #3 —— blob 存二进制,读口按 mime 分流(dsh 方案 B)

`event-translator.ts:61` 一直是对的:`Buffer.from(base64,'base64')` 存原始字节。
错在读侧 `blob-store.ts` 一律 `utf8`。改法:

- `readSessionBlob` 读回 `Buffer`,`readSessionBlobBase64 = readSessionBlob()?.toString('base64')`,
  `readSessionBlobText` 走 `readSessionBlob()?.toString('utf8')`(三者一条读路)。
- 投影读口(`projection-blobs.ts` 的 `sessionProjectionOptions`,以及 `session-verify.ts`
  自己那份)按 `BlobRef.mime` 分流:`image/*` 等二进制 → base64,`text/*`(或没有 mime 的
  正文占位符路径)→ utf8。附件走 `image/png`、超 64KB 的工具结果走 `text/plain` —— 实测
  两条各归各路。**base64 只在这个边界产生**,盘上永远是二进制。
- **sha256 读时自校验(dsh 的安全网)**:blob 内容寻址,文件名**就是** sha256 前 16 位
  (`hashSessionBlob`)。`readSessionBlob` 读回来重算一遍,对不上 = 损坏 → 返回 undefined
  (调用方走 F6 `blob-missing` 退化,不抛),不把被截断 / 被覆盖的脏字节投出去。
- **老数据无需迁移**:盘上那些 blob 本来就是对的二进制(只有读错),修读即恢复。

#### #4 —— 投影复用 dehydrate 的同一把省略

`dehydrateSessionForStorage` 把 `toolCall.result` / `step.partialResult` 里的图片正文
(`content` / `data` 键、超 2000 字符)换成 `[Image: … data omitted: N chars]`,`rehydrate`
不还原;投影(A8)把 blob 换回全文 —— 两侧分叉。新导出
`dehydrateProjectedMessages`(`session-dehydrate.ts`)= `rehydrate(dehydrate(messages))`
(先 `structuredClone`,绝不动活投影缓存),投影侧过一遍它,两侧于是逐字节相同。
作用域只在 dehydrate 碰的那两格 —— 消息级 `content` / `contentParts` /
`attachments.base64Data` 一格不动(#3 与 R-b 不受影响)。图片本体仍在 blob 里一份,
轨迹 / UI 按需取。今天落在 `sessions:verify` 的比对侧 + 合同测试;S2b 切读时生产读路
(`eventsListMessages`)一并套上同一把(与 §13.12 "S2b 本体一并做"同批,本条不单独动
生产读路)。合同 `§13.13 #4`(host)两条:套上后与磁盘脱水态相同、不套(裸投影全量
base64)当场分叉。

#### 门(全部实跑)

- `sessions:verify:gate` **GREEN**:#2×3 实例 / #3 healed;#1 追进基线(1 条,注明中止
  run、修前字节、不再新增);顺带 healed 一条老图片腐蚀红(`fd899977/977b78fc` —— #3
  的读口修好之后那条附件也对上了)。基线里已有的 healed 行按既有做法留着不动。
- `session:gate` 0 / `log:gate` 4 无新增;targeted vitest(`core/session` + `backend/session`
  + `runtime/src/sessions`)**367 绿**(含新增 #2 core 2 条、#3 backend 4 条、#4 host 2 条)。
- `sessions:shadow-battery` **GREEN**(264 runs / 0 mismatch)。#3 影子**看不见**:run 断言
  比的是活内存(全量),崩溃前两侧都是全图;#4 影子同理看不见(活内存两侧都全)——
  两者都由单测兜住,`sessions:verify`(整文件逐条 canonical)是它们的门。
- `server:build` 通过。
- 与本批**无关**的在途红(另一 session 的 provider/compact 改动,未提交):`typecheck`
  在 `shared/ipc/chat.ts`(`JsonObject`)/ `wiring/engine/stream/message-helpers.ts` 两处
  (它们改了引擎类型,本批一个字没碰);`boundary:gate` 一条 `wiring/agent-loop/providers/
  media-reader.ts`(未跟踪文件)。本批改到的 9 个文件 typecheck / boundary 全净。

### 13.14 S2b 落地记录

#### B —— 主读路径收口到 `sessionReads`(2026-08-23)

**病灶**:UI 的两条消息读入口绕过了读门面 —— 于是 `ONETHING_SESSION_READ=events`
对界面是空开关(门面自己在 `fromEvents()` 上分叉,但没人经过门面)。本步只搬调用点,
不动读法本体(`reads.ts` / `model-history.ts` 由并行的 C 负责,`migrate-sessions-events.mjs`
由 E 负责,本步一个字没碰)。

**改到的调用点(两个文件)**:

1. `packages/backend/rpc/domains/sessions.ts` —— 桌面 IPC 与浏览器
   (`POST /api/rpc`)共用的会话读面,真正到 UI 的那条:
   - `getMessages` 的 `getSessionMessages` 端口:`store.getSessionMessages(id)` →
     `sessionReads.listMessages(id).messages`。
   - `getMessagesPage` 的 `getSessionMessagesPage` 端口:`store.getSessionMessagesPage(...)` →
     `sessionReads.pageMessages(...)`。
2. `packages/backend/server/runtime.ts`:
   - `createAppBackedServerSessionStore.getMessagesPage`(app-store 背书、`persistsMessages`
     的生产读门面):`getAppStoreSessionMessagesPage(request)` →
     `appSessionReads.pageMessages(request)`。**同一读门面的 `getMessages` 早已收口**
     (`appSessionReads.listMessages`,S2a),本步只补齐它的分页那半;`getAppStoreSessionMessagesPage`
     成了孤儿导入,一并删。

**形状适配(只在调用点,不动 `reads.ts`)**:读门面把「查无此会话」折成 `[]`,而
`getOnethingSessionMessagesForIpc` 的契约是——回调交出 `undefined` 才回 `NOT_FOUND`。
直接换会把「不存在」误判成「存在但空」。`getMessages` 端口因此在空结果时补一句
`store.getSessionMessages(id) === undefined ? undefined : messages`,把仓的 `undefined`
信号原样还原:`messages` 模式下与收口前**逐字相同**(不存在→`NOT_FOUND`,存在空→`success:[]`)。
`readonly ChatMessage[]` 回到可变签名靠一次 `as ChatMessage[]`(投影只读它、产出新数组,
不改原数组,安全)。`pageMessages` 无此问题——它返回带 `success` 标志的整只页信封
(`hasMoreBefore/After` / `totalCount` / `cursor`),`messages` 模式下逐字走同一个
`getSessionMessagesPage`(`store.js` 再导出的就是 `stores/sessions` 那份),直接换即可。

**故意留 raw 的调用点(判断依据)**:

- `server/runtime.ts` 的 `createLocalServerSessionStore`(echo/test 后端,`persistsMessages:false`)
  的 `repository.getSessionMessages` / `repository.getSessionMessagesPage`:它挂的是**自己那只**
  `createOnethingSessionRepository`(与 app store「是真的两只」,各有缓存与写队列),而
  `appSessionReads` 只认得 app store 那只。换过去 = 读错一份内存真相,`messages` 模式下当场
  分叉、echo 后端崩。留 raw。
- `server/runtime.ts` 的 meta-refresh(`refreshSessionMeta` 的两处 `store.getMessages` 取数)
  与投影内部的 `upsertServerMessage` / `markStreamingComplete`:这些调的是 store adapter 的
  `getMessages` 方法(app-backed 那只早已经过 `appSessionReads`,是既有状态,本步没碰这些行);
  按任务约定不动这些行,meta 刷新可能本就需要原始仓,判其非「UI 读入口」,原样保留。

**测试**(`packages/backend/rpc/__tests__/sessions-domain.test.ts`,+3 条):桩门面分叉的
**两口井**(`stores/sessions.js` 的原始仓 / `session/events-reads.js` 的事件投影)而**不桩门面本体**
——读门面与真读模式(`setSessionReadModeForTesting`)都真跑。`messages` 模式两条读入口取原始仓、
`events` 模式取投影(`eventsList/PageMessages` 被调到);另证 `getMessages` 的 `NOT_FOUND`/空
两态被保住、`getMessagesPage` 的页信封(`hasMoreBefore/After`/`totalCount`)穿透不变。把调用点
改回 `store.*` 直读 → `events` 那支当场红。

#### 门(全部实跑)

- `typecheck` 干净;targeted vitest(`packages/backend/rpc` + `server` + `session`)**533 绿**
  (含新增 3 条);`session:gate` 0 / `boundary:gate` 0;`sessions:shadow-battery` **GREEN**
  (264 runs / 0 mismatch)。
- 影子看不见本步:比对口径始终是**抄本 vs 投影**(`listMessagesFromTranscript` 故意不经
  `fromEvents`,见 F11),与「谁给 UI 供数」无关;切读只改产品读路,不改判据侧。

#### C —— 读门面里最后四个方法接事件投影(2026-08-23)

§11.3 待决 5 的收口:S2a 只路由了七个方法,`findMessage` / `firstUserPreview` /
`iterateMessages` / `sliceForHistory` 仍无条件走 `getSessionMessages`——`events` 读模式
对它们是空开关。本步把它们接上。B / E 是并行步,本步只碰 `reads.ts`(+ 一处
`backend.ts` 装配)与新测试,一个字没碰 `rpc/domains/sessions.ts` / `server/runtime.ts` /
`migrate-sessions-events.mjs`。

**三个走投影(与 S2a 那七个同一条岔口)**:`findMessage` / `firstUserPreview` /
`iterateMessages` 各加一行 `fromEvents(() => eventsListMessages(sessionId)) ??
getSessionMessages(...)`——`events` 模式且这条会话事件里真有历史时取投影,否则(默认 /
老会话)一字不改走原路。`messages` 模式下逐字节与今天相同。

**`sliceForHistory` 走 `projectModelHistory`,不是「再抄一遍投影」**(§11.3 裁定的关键):
它是**模型历史**的取数口,两条路都产出 provider 形状的历史(不是 `ChatMessage` 切片):
- `messages` 模式:抄本切片过宿主的 `buildHistoryMessages`;
- `events` 模式:活投影上的 `materializeModelHistory`(= `projectModelHistory` 的物化半)
  + **同一份**宿主配方 `historyProjectionRecipe`(`buildMessageContent` / `getAIToolName` /
  `failureResultForAI` / `prepareMessages` / `providerDataFromContentPart`)+
  `sessionProjectionOptions`(blob 回放 `resolveBlob` + 退化留痕)。

两侧因此逐字节相同——这正是切读的历史安全前提,也是历史影子
(`checkSessionHistoryShadow`)比的那两份(抄本过 `buildHistoryMessages` vs 投影过
`materializeModelHistory`)。压缩会话上「可见消息投影」与「模型历史」不同,所以事件版
**必须**落在 `projectModelHistory` 而不是 `eventsListMessages`。

**G9 由 `projectModelHistory` 自己保住,本步不碰历史逻辑**:压缩后 per-result 预算
(`COMPACTED_HISTORY_*` 常量在 `core/engine/history.ts`,未动)由
`materializeModelHistory` 按 surface 上有没有 `session/compacted` 节点决定
`forceCompactedToolResults`(§10.1 G9),`sliceForHistory` 只是把状态与配方交过去,
一行 budget 逻辑都不重写。

**注入而非直接 import(关键的结构约束)**:`buildHistoryMessages` /
`historyProjectionRecipe` 住在 `wiring/engine/stream/message-helpers.ts`,身后是整棵
provider/collab/agents 树;而 `reads.ts` 被 ~30 个轻量会话层模块(`commands.ts` /
`validation.ts` / permission / usage / tasks …)与它们的单测**静态引用**——一旦
`reads.ts` 静态 import 了 message-helpers,那些「只 mock 了 `stores/paths`」的单测会当场
把整棵树拉起来炸(与 history-shadow.ts 用回调避开 recorder→message-helpers 同一条纪律)。
所以 `reads.ts` 只留一个端口 `configureSessionHistoryBuilder({ fromMessages, recipe })`
(只静态依赖 core 的 `materializeModelHistory` + 本地 `projection-cache` /
`projection-blobs`,全轻量),宿主在 `configureAppRuntimeAdapters()`(幂等)里把两个重函数
装进来。未装(纯轻量单测)时 `sliceForHistory` 退回抄本 `ChatMessage` 切片,保住 P0.1 老
形状;`upToMessageId` 落在 `events` 路上暂不支持(要按 seq 折,今天无调用点),退回消息
模式。`sliceForHistory` 全仓无生产调用点(引擎历史走 `listSessionMessages` +
`buildHistoryMessages`),所以返回形状从 `ChatMessage[]` 收成 provider 历史对产品行为零
影响,也不在影子路径上。

**测试**(`packages/backend/session/__tests__/reads-read-mode.test.ts`,11 条,跑真的
`reads.ts`、只替身最底下的会话仓库):(1) 四个方法各证 `events` 与 `messages` 两条读路
在同一条会话上**答案一致**(S2b 安全前提);(2) `sliceForHistory` 的 `events` 版逐字段
等于独立算出的 `materializeModelHistory`(同一配方 —— 影子投影侧那份);(3) 一组**故意
分岔**用例(抄本 `TAMPERED` / 事件 `EVENTS`):`events` 模式必须读到事件那一份——把任一
方法改回 `getSessionMessages` 当场红(一致性用例内容相同,证明不了岔口真接上,靠这组兜)。

#### 门(C,全部实跑)

- `bun run typecheck` 干净;`bunx vitest run packages/backend/session packages/core/session`
  **299 绿**(含新增 11 条);`session:gate` 0 / `boundary:gate` 0;
  `sessions:shadow-battery` **GREEN**(264 runs / 0 mismatch —— `sliceForHistory` 改动不在
  影子路径上,历史影子照绿)。
- 交付:`packages/backend/session/reads.ts`(四方法路由 + `SessionHistoryBuilder` 端口)、
  `packages/backend/backend.ts`(`configureAppRuntimeAdapters` 里装 builder)、
  `packages/backend/session/__tests__/reads-read-mode.test.ts`。`model-history.ts` 未改
  (`materializeModelHistory` 已足够,无需新投影入口)。

#### E —— 迁移脚本 `--apply` / `--rollback`(2026-08-23)

`scripts/migrate-sessions-events.mjs` 从「只有 `--dry-run`」补齐成真能写。R-c 硬前置
(有活的 core 拿着 store 就退出码 3,没有绕过口)照旧在最前面,`--apply` / `--rollback`
都过它。B / C 是并行步,本步一个字没碰 `rpc/domains/sessions.ts` / `server/runtime.ts` /
`reads.ts` / `model-history.ts`。

**`--apply` 做什么**:对**折不出任何一条消息节点**的会话(E0 七类 / 空事件),把
`messages.jsonl` 逐条合成 `message/imported`(`surfaceOp:'append'`、`time` = 消息自己的
timestamp、`data.synthetic:true`、seq 从 1 起、正文原样),插在现有事件**之前**;现有
E0 事件整体重编号到 `[N+1, …]`,内部 seq 引用(`surfaceOp.{start,end}` /
`sourceEventSeqs[]` / `data.sourceSeq` / `data.triggerEventSeq` /
`request/recipe.data.messages[].eventSeq`)全过一张 old→new 映射同步平移(映射认不出的
悬引用按 +N 兜底)。合成行与 dry-run 的 `importedLineBytes` **逐字段同形**,所以 apply
落的字节与 dry-run 报的一致。

**谁被迁 / 谁不动(§11.3 裁定 4 / §10.16)**:判据看事件类型——
- 已有 `message/imported` → **no-op**(带内幂等标记,不需要额外标记文件也认得);
- 已有 `user/message` / `system/message` / `run/start` / `session/compacted` /
  `user/message-edited` 任何一类**原生消息节点** → **跳过并报告**。真·混合覆盖会话
  (原生尾覆盖 + 未覆盖头)要 S2b 的覆盖感知合并:朴素的「全量导入 + 重编号」会把尾巴
  导重、投影撞 id、`verify` 的「covered message order」当场红——所以这里**不碰、不弄坏**,
  留给后续。真实 store 上绝大多数会话是 E0/空(§11.3),走得通的正是这条主路。
- 否则(E0 / 空)→ **要迁**。

**备份策略 = copy,不 move**(B8 的「就地作快照 vs 备份到 legacy-backup」矛盾判给复制)。
原 `messages.jsonl`(及迁移前的 `events.jsonl`,如果有)**复制**进会话目录内的
`legacy-backup/`(白名单子目录),原地那份继续被 `messages` 读模式读——切默认前不断供。
一份 `legacy-backup/events-migration.json` 记出处(imported 条数、shiftedBy、字节、备份
相对路径),供 `--rollback` 认路。**先备份、再原子写**(`events.jsonl.migrate-tmp.<pid>`
→ rename);备份已存在 = 拒绝覆盖(那是更早的原件)。任何一间出错收进结果的 error 字段,
跳过并汇报,决不半写坏 `events.jsonl`。

**幂等**:重跑 `--apply` = 检出 `message/imported` 已在 → 全 no-op,一个字节不动。

**`--rollback <sid>|--all`**:凭 `events-migration.json` 标记复原——有迁移前事件的
原子写回、没有的删掉合成出来的 `events.jsonl`,再删掉**本脚本造的**那几份备份 + 标记
(复制来的,原件一直在原地;`legacy-backup/` 里别的东西不碰,空了才 rmdir),让这间回到
真正的迁移前状态(否则下次 `--apply` 撞「备份已存在」)。`--all` 只碰有标记的会话(种进去
但没标记的 imported 不是我们迁的,不动)。R-c 同样在最前面。

**临时 store e2e(全绿)**:三类 fixture ——(a) legacy(仅 messages)→ 全量 imported +
`messages.jsonl` 进 `legacy-backup/`;(b) mixed(全份 messages + 尾 E0 工具事件)→ E0
重编号、`sourceSeq` 2→6 随之平移;(c) already-migrated(种了 imported)→ no-op。三类迁完
`sessions:verify --all` **GATE GREEN**(legacy=3 / mixed=4 / done=1 messages);`--apply`
再跑 = 全 no-op;`--rollback --all` 复原(legacy 删 events、mixed 回 4 条 E0、done 不碰),
复原后 `verify` 仍绿、`--apply` 可再迁。**退出码 3 实证**:临时 store 放一份假发现文件
(pid 活 + 端口开)→ `--apply` / `--rollback` 都退出 3。真实 `~/.onething` 上跑 `--dry-run`
时桌面 core 正活着(pid 97205 / http :63082),被 R-c 如实拦下(退出 3)——即真机上的
硬前置实证;**apply 一次都没对真实 store 跑过**。

#### 门(E,全部实跑)

- `bun run typecheck` 干净;`bunx vitest run
  packages/backend/session/__tests__/migrate-apply.test.ts` **14 绿**(coverageState /
  apply 五类 / 备份 / 幂等 / 重编号 + sourceSeq 平移 / rollback 五条);既有
  `session-verify.test.ts` **11 绿**(未破 dry-run);`session:gate` 0 / `boundary:gate` 0。
- 交付:`scripts/migrate-sessions-events.mjs`(+`--apply`/`--rollback`,新导出
  `applySession` / `applyMigration` / `rollbackSession` / `rollbackMigration` /
  `coverageState`;dry-run 与 `buildPlan`/`planSession` 一字未动,仍只读)、
  `packages/backend/session/__tests__/migrate-apply.test.ts`。

#### D —— M5 写侧对齐(其实是读侧无为)+ 覆盖感知合并(2026-08-23)

派工把 D 定为"M5 写侧对齐 + 定性混合覆盖迁移(二者同根)"。逐代码读下来,**两件事
不同根、方向相反**,而"写侧对齐"这条的前提是错的。逐条记在这里。

**Phase 1 —— 先读代码,后动手(全部实证)**

1. **§13.12 连带项 1 的前提在 HEAD 上是错的。** 它说"今天 `sanitizeSessionOnStartup`
   把崩溃截断的助手消息清成 `content=''`"。实际不是:该函数的纯计算本体
   `computeMessageRepair`(`packages/core/session/timeline.ts`)只做三件事 —— 清
   `isStreaming`、修中断的 step / toolCall、把卡死的 **system** compact 消息改判 failed;
   **从不碰 `content`**。盘上看到的 `content:''` 是**流式落盘缺口**:`assistant/chunks`
   是攒批写进 `events.jsonl` 的,而消息正文那格要到 `part-end` / `run-end` 才 flush 进
   `messages.jsonl` —— 崩在文本流中途,`messages.jsonl` 那格是空,`events.jsonl` 里却有
   用户实际看到的半篇。方向是**事件比 messages.jsonl 更全**。

2. **M5 读路径无需改代码。** `reducer.ts` 的 `assistant/chunks` 分支无条件累加
   `part.text`,物化(`materializeContentParts`/`materializePartText`)读的也是 `part.text`,
   **不以 `part.ended` 为门**。所以 `events` 读模式下 `projectChatMessages` 从 chunks 折出
   那半篇 —— 哪怕这条 run 没有 `part-end`、没有 `run/end`(纯崩溃),或只补了 `prepare`
   合成的 `run/end{interrupted}`。§13.12"投影为准"在读侧**本就成立、且免费**。切默认到
   `events` 后,`messages.jsonl` 退役为只读遗留、不再供产品读,所以"把快照侧也改成保留
   半篇"既无必要(读路径已对)也不该做(那等于往退役文件里回写重建)。**D 的 M5 这一半
   = 读路径无为 + 一条回归护栏**:`packages/core/session/__tests__/projection-crash-half.test.ts`
   钉住"crash-half 折出半篇、不是空",把 fold 改成"要 ended 才算"当场红。§13.12 的"写侧
   对齐"至此撤销 —— 前提不成立。

3. **真实 `~/.onething` 的覆盖形态(只读扫,只打计数,不 cat 内容)。** 427 间会话目录:
   **399 间 E0/空**(`coverageState==='none'`,其中 396 间连 `events.jsonl` 都没有)、
   **28 间原生覆盖**(`native`)、0 间已迁(`imported`)、1 份 legacy 整文件。对 28 间
   `native` 按**消息 id**逐条比对(事件的 `user/message.data.message.id` /
   `run/start.data.assistantMessageId` 等 vs `messages.jsonl` 的消息 id):**18 间事件已全
   覆盖**(尾=全,切读安全),**10 间是真·混合覆盖**——事件只从 S1 升级切面起记着尾巴的
   原生节点,`messages.jsonl` 里还压着升级前的**未覆盖头**。头的规模:40 / 28 / 64 / 169 /
   169 / 140 / 64 / 122 / 43 / **506** 条(最后一间 `5b151462` 共 536 条,事件只覆盖尾 30)。

4. **这才是 S2b 切默认的门槛级 bug,且不是 M5 同根。** `events-reads.ts` 的
   `eventsListMessages` 只在 `state.nodes.length === 0` 时返回 `undefined`(退回 messages
   模式);混合会话 fold 出的尾节点 > 0,于是它返回**只有尾巴**、`?? getSessionMessages()`
   兜底**不触发**——头被静默丢掉(`5b151462` 会丢 506 条)。方向是**messages.jsonl 比事件
   更全**,病根是 S1 升级切面(2026-08-19 才开始写事件),与 M5 的流式 flush 缺口**方向
   相反、根因不同**。§13.14-E 的 `--apply` 对这 10 间全是 `skipped`(有原生节点),留了
   "覆盖感知合并"这条尾巴——不切默认时无害,一旦切默认就丢头。

**Phase 2 —— 覆盖感知合并落进 `--apply`(§13.14-E 那条尾巴的了结)**

采用**导头留尾**(不是"整份快照 replace 遮蔽尾巴"):混合会话只把**未覆盖头**合成
`message/imported`(`surfaceOp:append`、seq 1..H),原生尾事件整体 +H 重编号(复用 E 已有的
`shiftEventRecord` 引用平移),投影 = 头(imported)+ 尾(原生)= 全份历史。**留尾**而非
整份 replace 的理由:尾巴的原生事件带着 chunk-fold(含 M5 半篇)、tool/audit、请求细节,
比 `messages.jsonl` 的扁平快照更全——replace 掉它等于把 M5 的收益在尾巴上吐回去。

`applySession` 的 `coverage==='native'` 从"一律 skip"改为 `planNativeMerge` 分流:
- **干净前缀/后缀**(未覆盖恰是一段头、其后全覆盖)→ `merged`:导头、留尾、重编号;
- **已全覆盖**(头长 0)→ `covered`:一个字节不动(切读后本就读得回全部);
- **有洞**(尾巴里仍有未覆盖消息)→ `skipped`:朴素导入会撞 id,不硬合,留人工。
  真实 10 间**全是干净前缀**(扫描实证 `notInEvents === head` 逐间成立),所以全部走
  `merged`;"有洞"是防御分支(真实数据 0 例)。覆盖 id 的认法与 `events-reads` 的节点身份
  一致(`session/compacted` 的压缩卡 id 不认——认不出的覆盖被"干净后缀"判据当未覆盖,从而
  保守跳过,绝不硬合)。备份(copy 进 `legacy-backup/`)/ 标记 / 幂等 / `--rollback` /
  R-c 硬前置全部沿用 E,未新开路径。marker 记 `mode:'merged'` + `firstCoveredIndex`。

**apply 一次都没对真实 store 跑过**(与 §13.14-E 同纪律):只在临时 store 上测。用户自己
在需要时手动 `--apply`(备份 + 可回滚 + 幂等),切默认是其后的独立一步。

**门(全部实跑)**

- `bun run typecheck` 干净(node + web)。
- `bunx vitest run packages/core/session packages/backend/session` **306 绿**(含新增:
  migrate-apply `merged`/`covered`/有洞跳过/合并回滚 + M5 crash-half 2 条;`native()` 用例
  从 `skipped` 改判 `covered`,`tallies mixed` 加 `mixnat` 走 `merged`/`covered`)。
- `session:gate` 0 / `boundary:gate` 0。
- `sessions:shadow-battery` **GREEN**(264 runs / 0 mismatch——D 没碰投影/recorder/core,
  影子路径不受影响)。
- `sessions:verify:gate`:**RED,但与 D 无关**。新增 2 条落在真实会话 `9c94531d`
  (`canonical differs` + `projection has 1 message unknown to messages.jsonl`),另有 4 条
  healed(§13.13 的 fd899977 等,advisory)。把 D 的三份改动全部按下(verify 路径 =
  `session-verify-gate.mjs` → `session-verify.ts` → 投影,**D 一个字没碰**)后复跑,同样这
  2 条——证明是**真机自升级以来的漂移**(§10.17 说的"现在的代码读过去的文件"),不是 D 的
  回归。这条 `9c94531d` 的方向是"事件比 messages.jsonl 多一条"(≠ 混合覆盖的丢头),是
  S 线的一条**新真机 mismatch 类待归类**,留给后续批(不在 D 范围:D = M5 + 覆盖感知合并)。

- 交付:`scripts/migrate-sessions-events.mjs`(`coveredMessageId`/`coveredMessageIds`/
  `planNativeMerge` + `applySession` 覆盖感知分流 + tally/CLI 加 `merged`/`covered`)、
  `packages/backend/session/__tests__/migrate-apply.test.ts`(改 2 用例 + 加 4 用例 + 2 fixture)、
  `packages/core/session/__tests__/projection-crash-half.test.ts`(M5 读侧护栏,新增)。
  **投影 / recorder / `session-verify.ts` / 基线一字未动。**

### 13.16 真机 mismatch 类归类:`9c94531d`——「事件比 messages.jsonl 多一条」= 末轮 edit-resend 的 messages 落盘丢写(2026-08-23)

§13.14-D 留下那条"待归类":`sessions:verify:gate` 在真实 `9c94531d` 上新长 **2 条**红
(`canonical differs for f4bd0a05` + `projection has 1 message unknown to messages.jsonl`),
是 S 线 S2b 切默认前最后一道判过的门。逐字段读完:**不是投影 bug,是 `messages.jsonl` 丢了
末轮 edit-resend 的落盘,事件更全**——与 §13.14-D Phase 1 第 1 条(流式 flush 缺口)**同方向**
(事件 > `messages.jsonl`),但**根因不同**:那条是崩在文本流中途;这条是一次**正常收尾**的 run
的 messages 落盘丢了。

**证据(全程只读:`sessions:verify --json` + 事件流 + 文件 mtime,不 cat 会话内容)**:

- **稳定,非活写竞态**:无 `run/http.json`(无活 core),8 秒间隔两跑字节全同(events=81,
  bytes=182657,issues 全同)。排除文档记过的两写者/流式 flush 瞬态。
- **事件流**:同一条用户消息 `f4bd0a05` 上 **三轮** edit-resend——
  run1(seq 3–44,assistant `ff482307`,带工具)→ `user/message-edited`(seq 45)→
  run2(seq 46–63,ts 07:30:11,assistant `159eda23`,stop,run/end)→ `user/message-edited`(seq 64)→
  run3(seq 65–81,ts 11:33:08,assistant `e0727dca`,`request/end` stop + `run/end` **完整收尾**)。
  seq 1..81 连续无重、无未闭合 run、surface 无违规——事件账本自洽。
- **`messages.jsonl` 只有 2 条**:user `f4bd0a05`(ts=07:30:11.139,= run2 的 edit 时刻)+
  assistant `159eda23`(run2 答案)。**停在 run2 之后的状态,根本没有 run3。**
- **投影(事件)= 2 条**:user `f4bd0a05`(ts=11:33:08.026,= run3 的 edit 时刻)+ assistant
  `e0727dca`(run3 答案)。两条红同一个根:①`f4bd0a05` 的 canonical 差**只差 `timestamp`**
  (run2 vs run3 的 edit 时刻——两侧都在 edit 时重盖 ts,`messages.jsonl` 自己也把 run1→run2
  的 ts 盖过,只是冻结在不同轮);②`e0727dca` 是 run3 的助手,`messages.jsonl` 里没有 = 那条
  "projection has 1 message unknown"。
- **mtime 定根**:run3 start 11:33:08.055;`messages.jsonl` mtime **11:33:08.340**(run3 起步后
  285ms,内容仍是 run2 态)；`events.jsonl` mtime **11:33:11.935**(run3 收尾后 ~3.9s);
  meta.json 11:33:11.825。messages 仓是 LRU + 300ms 节流异步存,run3 收尾(~11:33:11.9)那次
  flush 排到 ~+300ms 时进程已退,末次真正落盘的是 08.340 那次(run2 态);`events.jsonl`
  每事件即时 append,把整条 run3 收全了。

**裁定**:

- 分类 = **NEW-CLASS「events-ahead / 末轮丢写」**,S 线新真机类。非 TRANSIENT(稳定,无活写)、
  非 PRE-FIX-rebaseline(基线那些是"投影照出修复前引擎 bug 的字节";这条相反——投影**比快照
  更对**)、非 OPEN-needs-projection-fix(**投影零 bug**:它忠实回放了真实发生的 run3,`e0727dca`
  是完整连贯的真实答案,不是凭空造节点)。
- **对 S2b 是利好,不是拦路**:切读到事件后,用户看到的是他最后真正拿到的 `e0727dca`;
  `messages` 模式反而给的是过期的 run2 答案。这条红恰恰证明事件读路更可靠。
- **投影 / recorder / core / `session-verify.ts` 一字不该动**;也**不是 `--apply` 覆盖感知合并
  的对象**(那治"messages 更全的丢头";这条是"事件更全")——切默认后 `messages.jsonl` 退役为
  只读遗留,这次丢的落盘自然作废。

**建议(留给用户拍板,本次未改基线)**:按 §10.17 门的口径(红线 = 新代码弄坏旧文件;这条是
"现在的代码读过去的文件"的真机漂移,非回归——§13.14-D 已反证:把 D 全 stash 后同样这 2 条),把
这 2 条收进 `docs/audit/session-verify-baseline-2026-08-20.txt`,带一段区分注释(与既有"修复前
引擎 bug"条目不同类:events-ahead 丢写,事件更全,切读即自愈)。待收基线两行:

```
9c94531d-2d44-41e0-89b6-4ef99f3c2440 messages: canonical differs for message f4bd0a05-d0a2-4de2-a18c-723b011097d2
9c94531d-2d44-41e0-89b6-4ef99f3c2440 messages: projection has 1 message(s) unknown to messages.jsonl
```

另有 4 条 healed(§13.13 的 `fd899977` 等,advisory,门不因此红)可在收基线时一并清掉。

### 13.17 S2b 拦路虎:dehydrate 往返丢 `toolCall.changes` —— 裁定唯一持有点 + 两侧同款归一 + 事件面补采集点(2026-08-23,方案)

迁移 `--apply`(427 间)后 `sessions:verify:gate` 冒出 **156 条新红 / 42 间会话**,S2b 切默认
(阶段 2)因此冻结。根因已查实(见派工记录,复现件在诊断 scratchpad 的 `synthetic.ts`):
`session-dehydrate.ts` 的 `dehydrateStep`(line ~114)在 `step.toolCallId` 命中
`message.toolCalls[].id` 时把整份 `step.toolCall` 置 `undefined`,rehydrate 从
`message.toolCalls` 重建 —— 而**老形态会话的 `changes`(edit/write 的结构化 diff hunks)只在
`step.toolCall` 上**,顶层没有,于是往返一次 `changes` 永久蒸发。本节把设计一次定完:changes
存哪、往返怎么保真、verify 怎么转绿、事件词汇的缺口怎么补、体积账、门与反向测试。

#### 病根全景:三个磁盘形态、两个时代、一个事件词汇缺口(全部只读实证于真机 store)

对真机 427 间 `messages.jsonl` 逐条扫(共 364MB、2207 份 changes、38.2MB):

| 磁盘形态 | 间数 | mtime 区间 | 含义 |
| --- | --- | --- | --- |
| stepOnly(changes 只在 `steps[].toolCall`) | 34 | 全部 2026-07-07 | 老写路径:step 存全份拷贝,顶层无 changes |
| both(两处都有) | 6 | 全部 2026-07-07 | 同一时代的过渡形态 |
| topOnly(changes 只在 `message.toolCalls[]`) | 86 | 2026-07-07 ~ 08-22 | **现行写路径** |

三个关键事实,每一条都改写了派工时的判断:

1. **现行引擎把 changes 写在顶层 `message.toolCalls[]`,不是 step 上**(代码与磁盘双证)。
   `packages/core/engine/tool-orchestration.ts` 的 `buildToolMetadataStepUpdate`(line ~795):
   `tool-metadata` 更新到达时 `changesFromToolMetadata(update.metadata)` 折出 changes,
   `metadataUpdates.toolCall = { ...toolCall, changes }` 经 `updateToolCall` 命令落到会话的
   `message.toolCalls[]` 条目上;step 只拿到一份**本地游标**拷贝(line ~1022 注释原话)。
   所以**活引擎自己的新写不丢 changes**(dehydrate 对顶层只剥 `originalContent`)——
   丢失只发生在 34+6 间 2026-07-07 老形态会话被**再次脱水落盘**时(rehydrate 保留盘上的
   全份 step 拷贝,下一次 dehydrate 判它冗余、连 changes 一起扔)。潜伏,但真实:
   任何一次触碰老会话(补一条消息、启动 sanitize 重写)都是一次销毁。
2. **"18 间原生 verify 绿"的真正原因是两个都不是**(派工问的二选一)。不是"原生写路径把
   changes 放进了 message.toolCalls 所以往返无损"(这句对,但不是绿的原因),也不完全是
   "它们没有 edit changes"——准确表述:**真机 events 账本里 changes 的载体只有
   `message/imported`(713 条),原生事件零条;原生覆盖范围内含 changes 的消息 = 0**
   (逐 id 对过:2207 份 changes 全部落在 imported 覆盖区)。S1 上线(08-19)以来真机没跑过
   一次产出 changes 的 edit/write,原生绿是"没考到这道题",不是"答对了"。
3. **事件词汇没有 changes 的采集点 —— 这是比 dehydrate 更深的 S2b 拦路虎**。
   `session-event-recorder.ts` 的 `tool/result` 只记 callId/isError/resultPreview/result/
   resultData/reportedTitle;`tool/audit`(`wiring/toolkit/audit-sink.ts`)只记
   effects/decision/outcome。而 changes **不可从已落账的 result 派生**:对 2207 份 changes
   查其同调用的 `toolCall.result`,含 hunks 的只有 19 份(stepOnly 12/659、topOnly 7/1399)——
   hunks 活在 `tool-metadata` 的 `update.metadata`(diff/diffHunks/path/additions/…)里,
   结局正文里没有。切读之后第一次真原生 edit run 就会:UI 的 diff 卡片空掉(events-reads
   物化不出 changes)+ 影子 `run/end` 比对当场 mismatch(`shadow.ts` 直比 canonical,
   canonical **不**豁免 changes)+ verify 新红。影子电池 264 runs 全绿也是同一个盲区:
   没有一格场景驱动过带 diff metadata 的工具。

#### 裁定一(changes 该存哪):`message.toolCalls[]` 是唯一磁盘持有点,step.toolCall 是运行时游标

三个候选里选**提升顶层唯一持有**:

- **维持"只在 steps[]"+ 残桩**:否。现行引擎一年里写的就是顶层(86 间 topOnly 为证),
  选 steps 等于让磁盘上并存两种"正常"形态直到永远,dehydrate/verify/canonical 三处都要
  终身伺候双形态。
- **降级为派生缓存(像 `partialResult` 一样脱水时丢、rehydrate 重算)**:否,数据上不成立——
  result 里没有 hunks(19/2207),丢了就是丢了。
- **提升 `message.toolCalls[]` 唯一持有(选定)**:与现行写路径逐字一致(引擎零改动);
  rehydrate 本来就用顶层条目重建 `step.toolCall`(同引用),渲染层读
  `step.toolCall.changes`(`renderer/stores/helpers/tool-display.ts` 等)拿到的就是它,
  UI 零改动;老形态在下一次脱水时**归并归位**(见裁定二),磁盘逐步收敛到一种形态。

事件面同款:`tool/result` 事件的 `changes` 字段是同一形状(`CoreToolCallChangesLike`,
天然不含 `originalContent` —— `changesFromToolMetadata` 从来不折它,只有 hash/auditPath)。

#### 裁定二(往返保真的具体改法):dehydrate 把 step 上的 changes **归并到顶层**,再摘 step 拷贝

`session-dehydrate.ts` 的 `dehydrateSessionForStorage` 消息级两遍(纯函数、COW、不动入参,
与现有风格同款):

1. 先收集 `stepChangesById`:每个 `steps[].toolCall.changes` 存在、且 `toolCallId` 命中顶层
   id 的,记 `toolCallId → changes`。
2. 顶层 `toolCalls` 那一遍:条目**缺** changes 且 `stepChangesById` 有的,补
   `{ ...entry, changes }`;随后照旧过 `dehydrateToolCall`(`originalContent` 剥离作用在
   归并结果上,协同天然成立——先归并后剥离,一个顺序写死)。**顶层已有 changes 时不覆盖**
   (both 形态 6 间:结算后两份本就相同,顶层那份是引擎正写,选它是确定性规则)。
3. steps 那一遍:照旧摘被链上的 `step.toolCall`(现在摘之前 changes 已在顶层安家)。

性质逐条:**幂等**(第二遍时 step 拷贝已不在、顶层已有 changes,两遍都是 no-op);**纯**
(全 COW,`ONETHING_SESSION_FREEZE` 冻结对象不被就地改);**向后兼容三种老文件**——
(a)stepOnly 全份形态:读得回(rehydrate 不动已存在的 step.toolCall),下次落盘归并保真、
且净**缩**(扔掉的是整份冗余拷贝,保住的只是 changes 一格);(b)已丢形态(老会话在激进
dehydrate 落地后被重存过的):changes 已蒸发,无从复活,往返自洽(两侧都没有,verify 不红);
(c)现行 topOnly:字节级 no-op。`rehydrateSessionFromStorage` **一字不动**(`step.toolCall
= linked` 本来就把顶层 changes 带回 step,同引用,和活引擎内存形态一致)。
无链 step(toolCallId 不命中)照旧保留剥离后的拷贝,changes 本就不丢,行为钉死不变。

#### 裁定三(verify 口径):counterpart 侧同走 `dehydrateProjectedMessages` —— 只修 roundtrip 不够,156 条不会自己全绿

156 条红是**两个亚类**,只修 dehydrate 只治其一:

- 亚类 A(changes 蒸发):投影(imported 事件逐字回放盘上老形态)带 changes,过
  `dehydrateProjectedMessages` 丢掉;磁盘侧 rehydrate 保有 → canonical 差在 changes。
- 亚类 B(`originalContent` 不对称):40 间老会话的 `changes.originalContent`(27.6MB)还在
  盘上;投影侧往返会剥它,磁盘侧只 rehydrate 不剥 → 即便 changes 保真了,这一格还是不等。
  (42 ≠ 34+6+1 的差额就是它:topOnly 带 originalContent 的也在红名单里。)

而且修完裁定二后还会出现**新的不对称**:投影侧往返把 changes 归并到顶层,磁盘侧(只
rehydrate)的老形态 changes 还在 step 上 —— 位置不同,canonical 照红。三个不对称同一个根:
**两侧没走同一把归一函数**。修法与 §13.13-#4 同款判例:`scripts/session-verify.ts` 里
counterpart 侧从 `rehydrateSessionFromStorage({ messages: real })` 改为
`dehydrateProjectedMessages(real)`(它内部就是 clone → dehydrate → rehydrate,对新形态磁盘
是恒等,对老形态是归一;`hydrated.length` 等 coverage 计数语义不变)。**canonical 一字不动、
不加豁免**——"一个判官"的纪律保住,归一发生在判官之前、且用的是磁盘同款那把函数。

预期:156 条中 changes/originalContent 两亚类全部转绿;剩 `9c94531d` 的 2 条(§13.16
events-ahead 类,与本节无关)按 §13.16 已写好的两行收基线,4 条 healed 一并清掉 → 门归零。

#### 裁定四(事件面补采集点):`tool/result` 事件带上 `changes`,采集点照抄判定点

- **采集**:recorder 已经在听 `tool-metadata`(`session-event-recorder.ts:814`,今天只留
  title)。扩这一格:对 `update.metadata` 跑**同一把** `changesFromToolMetadata`(从
  `@onething/core` 导入,与引擎写消息的判定点同源),存进 run 状态表 `changesByCallId`
  (与既有 `callSeqByCallId`/title 表同款);`tool/result` 落账时附 `changes`。
  时序天然成立:metadata 在 apply 中途到,result 在 settle 后写。
- **体积纪律**:沿用 §9.1 —— 序列化 ≤64KB 进事件行,超了走 blob(镜像
  `resultData`/`resultDataBlob` 的既有机制,blobs.ts / verify 的 `collectBlobHashes` 一并
  认识新引用)。真机数据:去掉 originalContent 后 2207 份里只有 3 份超 64KB(最大 85KB),
  绝大多数 ~4.8KB。
- **投影**:reducer 把 `changes` 当不透明 JSON 存进 call 状态;`chat-messages.ts` 物化时
  attach 到 `toolCalls[]` 条目与 `step.toolCall`(两处今天就取自同一份 call 状态,一个
  attach 点覆盖)——与活引擎内存形态一致,events-reads(不脱水)交给 UI 的消息 diff 卡
  照常。旧事件文件没有这一格 = 物化不 attach,与今天逐字相同(§10.16 兜底口径:新字段
  缺席即旧行为)。
- **旧账不补**:原生覆盖区含 changes 的消息 = 0(实测),没有需要回填的事件;imported
  事件已逐字带着 changes(713 条),**不需要重跑迁移**。

#### 体积账(用户关心的那笔,全部真机实测)

- `messages.jsonl` 侧:**保真不放大**。changes 今天已经在盘上(38.2MB / 364MB ≈ 10.5%,
  其中 27.6MB 是 40 间老会话的 legacy `originalContent`,照旧在下次落盘时剥掉);现行写
  路径本来就存顶层 changes,裁定二对新写零新增;老会话再存时净缩(扔全份 step 拷贝 ≥ 留
  changes 一格)。
- `events.jsonl` 侧:新增的只有**今后**每次 edit/write 的一格 changes,均值 ~4.8KB
  (不含 originalContent,它从不进这条链),64KB 以上走 blob(历史数据里 3/2207)。
  对照现状:events.jsonl 已 386MB(其中 imported 带 changes 的 713 行占 233MB——那是
  整条消息行的账,迁移时已付清)。量级结论:**新增两位数 KB / 每次编辑,无存量放大**。

#### 反向测试(每一条"不修就红")

1. **合成往返**(scratchpad `synthetic.ts` 移植进
   `packages/onething-runtime/src/sessions/__tests__/session-dehydrate.test.ts`):
   stepOnly 形态过 `dehydrate→rehydrate`,断言 `step.toolCall.changes` 与
   `message.toolCalls[].changes` 都在 —— HEAD 上输出 `*** CHANGES LOST ***`。
2. **真机 f9b2181e**(stepOnly,38 份 changes):`bun scripts/session-verify.ts
   f9b2181e-…`(只读)—— HEAD 红(canonical differs),修后绿。
3. **幂等 + originalContent 协同 + both 不覆盖 + 无链 step 保留**:四条 contract test,
   逐条对 HEAD 反证(幂等与无链两条 HEAD 本绿,是钉行为的回归桩)。
4. **采集点**:recorder 单测喂 `tool-metadata`(带 diff/diffHunks/path)+ `tool-result`,
   断言事件行带 `changes`、投影物化后 `toolCall.changes`/`step.toolCall.changes` 都在 ——
   HEAD 上字段缺席即红。
5. **影子**:电池加一格 "edit-changes" 场景(mock provider 发 edit 调用、真工具改临时
   store 里的文件、产出 diff metadata)—— HEAD 上该场景 mismatch(投影缺 changes),
   修后 0。若电池表达不了(参照 §13.9 的先例),降级为 `shadow.ts` 级单测:actual 带
   changes vs 投影带 changes 比对为空、且"投影不带"那一侧 HEAD 红。

#### 给 opus 的执行清单(按批,门全部实跑)

- **批 1 —— 往返保真**:改 `packages/onething-runtime/src/sessions/session-dehydrate.ts`
  (裁定二的归并;`dehydrateStep` 的链上摘除逻辑挪到消息级两遍,rehydrate 不动);
  contract test 上面 1/3 两组进 `session-dehydrate.test.ts`。
- **批 2 —— verify 归一**:`scripts/session-verify.ts` counterpart 侧改走
  `dehydrateProjectedMessages`(裁定三,一处);
  `packages/backend/session/__tests__/session-verify.test.ts` 加 fixture(stepOnly 老形态
  transcript + imported 事件)反向用例;`projection-contract-host.test.ts` 补 changes 往返
  逐字节断言。跑真机 `sessions:verify:gate`(只读):预期新红只剩 `9c94531d` 2 条。
- **批 3 —— 事件采集**:`session-event-recorder.ts`(tool-metadata 收 changes、tool/result
  落账,≤64KB 行内 / 超走 blob)+ `packages/core/session/projection/reducer.ts`(不透明
  存)+ `chat-messages.ts`(物化 attach)+ 电池 "edit-changes" 场景(或 shadow 级单测,
  见反向 5)+ recorder/投影 contract test(反向 4)。
- **批 4 —— 收基线**:`9c94531d` 2 行按 §13.16 写好的文字收进
  `docs/audit/session-verify-baseline-2026-08-20.txt`(带 events-ahead 区分注释),4 条
  healed 清掉。
- **批 5 —— 切读默认(S2b 阶段 2 收尾)**:`packages/backend/session/read-mode.ts`
  `DEFAULT_SESSION_READ_MODE: 'messages' → 'events'`(文件头注释同步);自证脚本(只读):
  events 模式下物化 `f9b2181e` 断言 diff changes 俱在(不做人肉走查)。
- **每批门**:`bun run typecheck`;定向 vitest(`packages/onething-runtime/src/sessions`
  `packages/backend/session` `packages/core/session`);`session:gate` 0(session-dehydrate
  在白名单内,新改不出白名单);`boundary:gate` 0(recorder 是 wiring、reducer 改动是
  core 内部,均无新跨层边);批 3/5 后加跑 `sessions:shadow-battery` GREEN 与
  `sessions:verify:gate`(批 4 后应为 0 新红)。
- **坑位提示**:COW 纪律(冻结对象就地改当场 TypeError);电池新场景 mock provider 的
  工具调用要落在真 edit 工具上才会产出 diff metadata;blob 分支记得让 verify 的
  `collectBlobHashes` 认识新引用,否则 blob 引用检查误报。

#### 明确没做的

- 不改 canonical(位置/originalContent 归一都由"两侧同一把脱水函数"完成,判官零豁免)。
- 不重跑迁移、不回填旧事件(原生含 changes 的历史 = 0,imported 已带)。
- 不动引擎写路径与渲染层(裁定一选的就是"现状即规范"的那一格)。
- `messages.jsonl` 老形态不做批量就地改写 —— 归并只在"本来就要落盘"的那一次发生
  (切默认后 messages.jsonl 渐冻,老形态大多永远停在盘上,verify 归一已让它不碍事)。

### 13.18 批 5 冻结的两只拦路虎:活引擎 settle 丢 changes(A,推翻 §13.17 前提)+ events 读模式下编辑重发事件取材自滞后投影(B)——根因、裁定与解冻清单(2026-08-23,方案)

§13.17 的批 1–4 已落地提交(dehydrate 往返保真、verify 归一、事件补 changes 采集、收基线),
`verify:gate` 全绿、`shadow-battery` 在 messages 读模式 GREEN。批 5(翻
`DEFAULT_SESSION_READ_MODE → 'events'`)在执行时暴露两个**引擎/投影级**的真 bug,切读默认
因此冻结。本节把两个发现一次裁完。先说清与 §13.17 的关系:**本节推翻的是 §13.17
「病根全景」第 1 条的事实断言("现行引擎把 changes 写在顶层"、"活引擎自己的新写不丢
changes"),裁定一~四(顶层唯一持有点 / dehydrate 归并 / verify 归一 / 事件采集点)全部
存活** —— 变的不是"changes 该住哪",而是"引擎今天根本没把它送回家"。§13.17 原文按
append-only 纪律不改,以本节为准。

#### 发现 A:活引擎的 agent-loop settle 链把 changes 丢在了半路 —— 消息(顶层与 step)两头都存不下

**根因链(逐 file:line,全部 HEAD 实证)**:

1. §13.17 事实 1 引的 `executeCoreToolAndUpdate` 编排链是**死代码**:
   `packages/core/engine/tool-orchestration.ts:884` 的该函数,测试外唯一 import 是
   `packages/backend/wiring/engine/stream/tool-execution.ts:117` 的 `executeToolAndUpdate`
   壳,而这个壳的唯一 import 方 `packages/backend/wiring/engine/stream/tool-orchestrator.ts:7`
   (`ToolOrchestrator` 类,line 43)**全仓零实例化**(只有 `__tests__`)。同文件的
   `executeToolDirectly` 倒是活的(`agent-loop-runtime.ts:35` 引它)——死的只是
   "AndUpdate 落账"那半截,即 §13.17 描述的那套"metadata → `updateToolCall` 命令 →
   顶层落盘"机器。
2. 活路径是 agent-loop 的 chunk 分发(`packages/backend/wiring/engine/stream/agent-loop-executor.ts:498`
   → `coreApplyAgentLoopStreamChunkWithAdapters`,store 桥只带 `updateMessageToolCalls`,
   line 511-513)。`tool-metadata` 到达时(`packages/core/engine/agent-loop-executor.ts:2217`)
   调 `applyAgentLoopToolMetadataWithAdapters`(line 1954):`applyAgentLoopToolMetadata`
   (line 1518)确实折出 `{ ...toolCall, changes }`(line 1535-1538,判定点
   `changesFromMetadata` line 1493 与事件侧同源)——但这份新 toolCall **只进
   `sendStepUpdated`,谁都没把它写回工作表 `processor.toolCalls`,选项束里连 store 都没带**
   (对照 line 2198 的 tool-result 分发:有 store)。
3. settle(`settleAgentLoopToolResultWithAdapters`,line 1724)从工作表按 id 重取
   toolCall —— 那份**从未有过 changes** —— `settleAgentLoopToolCallResult`(line ~1560,
   settled 展开在 ~1619)展开出的 settled 自然没有;`store.updateMessageToolCalls(整表快照)`
   (line ~1755)把无 changes 的快照写进 `message.toolCalls[]`;紧接着
   `buildAgentLoopToolResultPresentation`(line 1641,`stepUpdate.toolCall = { ...toolCall }`
   在 ~1667)经 `sendStepUpdated` 落 `patchStep` 命令 —— 而 patchStep reducer
   (`packages/core/session/commands.ts:323-331`)是浅覆盖:`updates.toolCall` **整体换掉**
   `step.toolCall`,metadata 时刻写上去的那份带 changes 的 step 拷贝也被抹掉。
4. 结论:现行活路径上,edit/write 的 changes **顶层与 step 两头都不落盘**;瞬时只存在于
   metadata 到 settle 之间的 step 上与 IPC 流里(所以流中 UI 有 diff、重载后消失)。批 3
   之后,`tool/result` 事件(`session-event-recorder.ts:857/896` 的 `changesByCallId` 表)
   成了 changes 在活路径上**唯一**可靠的持久落点。

**矛盾数据点解除(真机 `46dcec05-73e4-44ea-8a3e-11488effec08`,全程只读)**:该会话
(created 08-18,grok-oauth/grok-4.6,agent-loop 路)97 条消息 / 385 个 toolCall,顶层带
changes 的 26 个(write 21 / edit 5)**全部**落在 2026-08-18T15:36 ~ 08-19T06:20(UTC)
窗口;step 侧 0 个;08-20T16(UTC)起的 178 个 edit/write **零** changes。R4b 删旧工具树
(`6b9fa5a0`)提交于 2026-08-19 11:19 +0800 = 03:19Z,断点窗口 [08-19T06:20Z, 08-20T16:00Z]
恰好覆盖 R4b 后桌面首次重启。所以 26 条不是 native-tool provider 的别道,是**时间断层**:
旧执行链(R4b 删除的 runtime/tools 树)的遗产。§13.17 表格里 topOnly "mtime 至 08-22" 的
误导由此解释 —— mtime 是重写时刻,不是 changes 出生时刻;46dcec05 自己就是"晚重写的老
changes"。顺带:该会话 events.jsonl 380 条 `tool/result` 零 changes(先于批 3),与 §13.17
事实 2("原生事件零条")继续吻合。也就是说,**丢 changes 是 08-19 起就存在的真机产品回归**
(重载后 diff 卡空),与 S2b 无关,只是被批 5 的排查照了出来。

**裁定 A:修 settle 链,让 changes 在 metadata 时刻进工作表、settle 自然携带 —— 不认账
"事件是唯一家"。** 理由:

- §13.17 裁定一已拍"`message.toolCalls[]` 是唯一磁盘持有点";发现 A 推翻的是"引擎已经
  这么做了"的事实,不是裁定本身。让引擎去符合裁定,比反过来改裁定便宜且自洽 —— 认账方案
  要付的是:messages 读模式(今天的默认、以及切读后的回滚路径)下新 edit 永远无 diff、
  canonical 被迫开 changes 豁免(违反"一个判官零豁免"纪律)、批 1 的 dehydrate 归并沦为
  只服务 2026-07 老文件的死逻辑、且 08-19 起的真机回归被固化成规范。全部不可接受。
- 修法(单点,core):`applyAgentLoopToolMetadataWithAdapters`(agent-loop-executor.ts:1954)
  的选项束加 `sessionId` / `assistantMessageId` / `store`(与 settle 同款
  store-like);当 `metadataUpdates.toolCall` 存在时,先
  `replaceCoreToolCall(options.toolCalls, metadataUpdates.toolCall)` 换进工作表,再
  `store.updateMessageToolCalls(sessionId, assistantMessageId, coreToolCallSnapshot(...))`
  整表快照写回(COW 已天然满足:`{ ...toolCall, changes }` 本就是新对象),然后照旧
  `sendStepUpdated`。分发点(line 2217)把束里已有的三样传进去即可,wiring 零改动
  (line 511-513 的 store 桥已带 `updateMessageToolCalls`)。
- 生效路径:settle 从工作表重取的 toolCall 现在带 changes → settled 展开继承 → 顶层快照
  有、`stepUpdate.toolCall = { ...settled }` 有 → patchStep 的整体替换写上的就是带 changes
  的那份 —— **顶层与 step 同时归位,message == projection,messages.jsonl 重新自足**。
  `requiresConfirmation` 分支同样继承(edit 审批卡上的 diff 也回来了)。
- 连带影响:
  - shadow/verify:canonical 继续**不豁免 changes**。修后消息侧与投影侧(批 3 事件 →
    reducer.ts:633/1199 物化)同有,天然相等。**修前**(HEAD)任何真实 edit 在 messages
    模式的 run/end 影子比对都该 mismatch(投影有、消息没有)——这正是反向判据;若电池的
    edit-changes 场景(§13.17 反向 5)今天在 HEAD 上是绿的,先查两件事:场景是否真的产出
    diff metadata、比对是否真的看得见 changes —— **门要先能在 HEAD 上看见 A,修 A 才算数**。
  - dehydrate/verify(批 1/2)零改动:新写落顶层 = "现行 topOnly 字节级 no-op"那格。
  - 事件侧(批 3)零改动:recorder 的 `changesByCallId` 与引擎写回同判定点
    (`changesFromMetadata`),两侧同源不重复。
  - 旧账不补:08-19 ~ 修复日之间真机产生的 edit,metadata 早已丢弃,无从回填(与 §13.17
    "旧账不补"同口径;这段的 diff 只活在事件缺采集前的空白里,认损)。

#### 发现 B:events 读模式下,`user/message-edited` 事件取材自"还没看到这条事件"的投影 —— 写侧自引用

**根因链**:

1. `handleEditAndResend`(`packages/core/engine/core-stream-engine.ts:1020`)调
   `store.updateMessageAndTruncate(sessionId, messageId, 新正文, {contentParts})`;core
   reducer `applyTruncate`(`packages/core/session/commands.ts:458` 起)**做对了所有事**:
   `target.content = command.newContent`、`target.timestamp = now`,并把改写后那条放进
   `meta.updatedMessage` 交回。真相在写侧手里。
2. 命令面 `truncateFrom`(`packages/backend/session/commands.ts:243`)在端口写成功后,给
   翻译器递的却是**回读**:`sessionReads.getMessage(sessionId, payload.messageId)`
   (line ~262);翻译器自己的兜底同款(`event-translator.ts:197`
   `updatedMessage ?? sessionReads.getMessage(...)`)。
3. `sessionReads.getMessage`(`packages/backend/session/reads.ts:178`)带着 S2a 的岔口:
   `fromEvents(...)` 优先 —— events 读模式下返回**活投影**的物化消息。而此刻
   `user/message-edited` 事件**正要由这次翻译写出**,活投影(`projection-cache.ts:42/51/64`
   随 append 折叠)还停在编辑前:回读拿到旧正文 + 旧 timestamp,原样写进
   `data.message`(event-translator.ts:201-206)→ **旧正文永久落账**。投影 reducer
   (`projection/reducer.ts:354`)无辜:它忠实回放了账本上的错事件。
4. 触发条件由此完全解释:messages 模式下同一处回读走内存 store(reducer 刚落定,新正文)
   → 事件正确 → 电池绿;events 模式下自引用 → 16 条红(history:8 / messages:8,全部
   edit-and-resend,正文回退 + 时间戳差)。注意这是**写坏账本**的 bug,不只是读错:events
   模式下每次编辑重发都会把错误事件焊进 events.jsonl(电池是一次性 store,真机默认未切,
   尚无存量损伤;这也是批 5 必须先修 B 的硬理由 —— 切了默认,第一次编辑就开始写坏账)。

**裁定 B:修事件写侧 —— 写侧取数一律走抄本真相面,永不走随读模式分岔的门面。** 修法:

- `sessionReads` 加 `getMessageFromTranscript(sessionId, messageId)`(与
  `listMessagesFromTranscript`(reads.ts:164)并排,同一段 F11 纪律注释:**故意不经过
  `fromEvents`**);`commands.ts` truncateFrom 的递参(~262)与 `event-translator.ts:197`
  的兜底改走它。
- **同类全扫**(写侧自引用不止这一处,events 模式下都是定时炸弹):
  `commands.ts:200` upsertMessage 的 existed 探测(流中 assistant 消息投影里还没有 →
  误判成"新增",翻译错类)、`commands.ts:~276` deleteMessage 按 marker 的
  `sessionReads.findMessage`(投影滞后 → 找不到 → 该翻译的 `message/deleted` 整条丢失)。
  各换 transcript 真相读(找不到现成方法就补 `findMessageFromTranscript`)。
- 纪律钉死:`event-translator.ts` 与 `commands.ts` 文件头补一条规矩 —— **事件写侧
  (命令面 + 翻译器)的一切消息读取走 `*FromTranscript`;`fromEvents` 岔口只属于产品读路**。
  配一条 contract test 把读模式钉在 `events` 上逐条驱动三个命令(见反向测试),防回潮。
- 否决的备选:①把 reducer 的 `meta.updatedMessage` 穿过存储端口交给命令面 —— 语义最正
  (事件取材 = reducer 产物),但要动 `SessionCommandsPorts` 三层接口,而 transcript 读给出
  的是同一份字节;②改投影 reducer 忽略 `data.message` 正文 —— 治标,账本本身就是错的,
  事件是词汇的载体,必须在产地写对。
- 连带影响:timestamp 差同根同修(真相面上的 timestamp 是 reducer 盖的 now);canonical /
  verify / UI 零改动;§13.16 的 events-ahead 类无涉(那是 flush 丢写,方向相反)。

#### 给 opus 的执行清单(接 §13.17 编号,批 6–8;门全部实跑)

- **批 6 —— A:settle 链归位 changes**。改
  `packages/core/engine/agent-loop-executor.ts`(`applyAgentLoopToolMetadataWithAdapters`
  选项束加 sessionId/assistantMessageId/store + 工作表写回 + 快照落盘;分发点 line ~2217
  传参)。contract test 进
  `packages/backend/wiring/engine/__tests__/core-agent-loop-executor.test.ts`(既有 settle
  用例旁):喂 `tool-metadata{diff,diffHunks,path}` → settle,断言 store 收到的整表快照与
  `stepUpdate.toolCall` **都带** changes —— HEAD 红。电池侧:确认 edit-changes 场景真的
  产出 diff metadata 且比对看得见 changes(HEAD 上该场景在 messages 模式应为红;若绿,
  先修场景/比对的盲区再修 A —— "不修则红"是本批的准入门)。**反向判据:上述 contract
  test 与电池场景在 HEAD 红、修后绿;`46dcec05` 类只读复核(修后新 edit 的顶层
  changes 在,老窗口 26 条不变)。**
- **批 7 —— B:写侧真相读**。改 `packages/backend/session/reads.ts`(+
  `getMessageFromTranscript`,必要时 `findMessageFromTranscript`)、
  `packages/backend/session/commands.ts`(truncateFrom ~262 / upsertMessage 200 /
  deleteMessage ~276)、`packages/backend/session/event-translator.ts`(197 兜底 + 文件头
  纪律)。contract test 进 `packages/backend/session/__tests__/event-translator.test.ts`:
  读模式钉 `events`(`ONETHING_SESSION_READ=events`),店里放 user 'v1',驱动
  `truncateFrom{inclusive:false, newContent:'v2'}`,断言 `user/message-edited.data.message`
  的 content === 'v2' 且 timestamp === reducer 落定值 —— HEAD 在 events 模式红、messages
  模式绿(两个断言都写,把触发条件钉进测试);再各一条覆盖 upsert-existed 与
  marker-delete 的同类。**反向判据:`sessions:shadow-battery` 以
  `ONETHING_SESSION_READ=events` 跑 —— HEAD 16 红(edit-and-resend 全家),修后 0。**
- **批 8 —— 切读默认(原批 5 照单执行)**。前置条件全部满足后翻
  `DEFAULT_SESSION_READ_MODE: 'messages' → 'events'`(`read-mode.ts:16`,文件头注释同步)
  + 原批 5 的自证脚本(events 模式物化 `f9b2181e` 断言 diff changes 俱在,只读)。
- **每批门**:`bun run typecheck`;定向 vitest(批 6:`packages/core/engine`
  `packages/backend/wiring/engine`;批 7:`packages/backend/session`
  `packages/core/session`);`session:gate` 0;`boundary:gate` 0(批 6 是 core 内部 +
  既有 store 桥,批 7 是 backend 包内,均无新跨层边);批 6/7/8 均加跑
  `sessions:shadow-battery`(messages 与 events 双泳道)与 `sessions:verify:gate`
  (0 新红;批 6 修后真机新 edit 不再制造"投影有消息没有"的 changes 差)。
- **依赖顺序**:A、B 代码互不相交,可并行开发;**合入顺序 A(批 6)在前** —— A 是
  messages 模式(今天的默认)下就存在的真机回归与影子红源,先修先止血;B 只在 events
  模式发作,但**批 8 硬依赖 A、B 双完成 + 电池 events 泳道 GREEN**,缺一不翻。
- **坑位提示**:COW/FREEZE 纪律照旧(工作表换新对象,不就地改);批 6 别顺手"优化"成
  settle 时从 `changesByCallId` 侧表补 —— 单一写回点在 metadata 时刻,settle 只继承;
  批 7 的测试要留神 `read-mode.ts` 对 env 的读取时机(若 configure 期缓存,测试内切模式
  需走它的显式入口)。

#### 明确没做的

- 不改 canonical、不加 changes 豁免(批 6 修的就是让豁免永远不需要存在)。
- 不回填 08-19 ~ 批 6 之间真机丢失的 changes(metadata 已灭失),不重跑迁移。
- 不复活 `executeCoreToolAndUpdate` 编排链,也不在本轮删它 —— 死码清理另立门户
  (`ToolOrchestrator` / `executeToolAndUpdate` 及其 checker 断言一起),与解冻无关。
- 不把 `meta.updatedMessage` 穿端口(裁定 B 已述);不动投影 reducer 的
  `user/message-edited` case。

## 14. S3w(写切换 + 删旧)方案勘察(2026-08-24;S3w-0 已落地 `8682d980`,其余子期待 §14.6 拍板后开工)

**命名先说清**:§12 已经把 "S3" 这个名字用在了只读查询面(trace)上;本节勘察的是
§8 分期表里那行 **S3 = 删旧**(旧写路径退役、`messages.jsonl` 停写、双存消失)。为免
歧义,下文称 **S3w**(w = write switch)。§8 那行定义写于 S1/S2 落地之前,本节按
HEAD(S2b 批 8 已切读默认 `events`、迁移 `--apply` 已落地)的真实代码重摸一遍。

### 14.1 当前写模型全图(全部 HEAD 实证)

**先纠正 §8 原始定义里的一个时代错位**:"旧 `updateMessage/…` 写路径删除,只剩 append"
—— 那批 mutator 早已在 P0 收进命令面;今天没有"旧写路径"可删。真正要切的是
**架构本身**:今天不是事件溯源,而是「store 写模型 → 双份派生」:

```
命令(13 条,backend/session/commands.ts)
  → applySessionCommand(core/session/commands.ts,纯 reducer,COW)   ← 真相在这里落定
  → 写回内存 store(session-repository LRU(10) + 冻结守卫)
  ├→ saveSessionToFile → AsyncSaveQueue(300ms 节流,session-repository.ts:157)
  │    → hybrid driver 脱水落 messages.jsonl(storage-driver.ts:257 writeJsonl
  │      → :226 writeSuffix / :208 rewriteAll;:178 writeMeta → meta.json)
  │      脱水 = session-dehydrate.ts:141(changes 归并顶层、settled partialResult 剥、
  │      inline base64 剥)
  └→ sessionEventTranslator(event-translator.ts)把 mutation 翻成事件
       → appendSessionLogEvent(event-log.ts:241,异步队列 appendFile,
         失败只计数不抛 :282-286;语义检查点 fsync;G12 跨进程守卫)
```

**events.jsonl 有两个采集面**,S3w 一个都不用动:

- **翻译器**(结构性词汇,命令派生):`appendMessage`→`user/message`|`system/message`
  (assistant `isStreaming` 不翻,run/start 是它的那一格);`upsertMessage`→
  `message/patched{fullBody}`;`patchMessage`→`message/patched`(丢 BODY_KEYS 与
  DERIVED_KEYS——**`steps`/`toolCalls` 在 DERIVED_KEYS 里,消息命令的 step/toolCall
  变更从不进事件**;`turnContext`→`context/turn-update`);`truncateFrom`→
  `message/deleted`|`user/message-edited`;`deleteMessage`→`message/deleted`;
  `replaceAll`→`session/cleared`(+`replaced` 时逐条 `message/imported`;`normalize`
  不翻);`sessionCompacted`→`session/compacted`;`patchSession`→仅 agent/model/workdir。
- **recorder**(执行词汇,挂 `AgentLoopOptions.onEvent`,wiring/engine/stream/
  session-event-recorder.ts,1092 行):`run/*`、`request/recipe|response|error`、
  `assistant/chunks|part-end`、`tool/call|result(带 changes,§13.17 裁定四)|audit`、
  `skill/activated`、`recordCancelledToolResults`(批 9);permission-events.ts 另采
  `permission/*`。**工具/step/正文的事件事实全部来自 recorder,不来自命令面** ——
  这就是"双存从存储消失"在事件侧早已成立的原因(投影的 steps/toolCalls 是
  chat-messages.ts:127/131 从 `tool/*` + chunks 物化出来的两个视图)。

**store 的双重身份**:它既是**写模型**(reducer 的落定处、翻译器与收尾链的取材面),又是
**运行时缓存**(LRU + 冷加载补水)。关键:**冷加载补水今天仍走 `messages.jsonl`**
(session-repository.ts:604 loadSession → storage-driver loadJsonl:271;冷加载时
`sanitizeSessionOnStartup`:633 + rehydrate:238 重建 `step.toolCall` 链接)。产品读路
(S2b)已经全线投影,但**写模型的起点还是 messages.jsonl** —— 这是 S3w 真正要换的那根梁。

**写侧回读残留清单**(全部**故意**读内存 store、永不随读模式分岔;§13.18 发现 B 的纪律):

| 位置 | 读什么 | 为什么必须读抄本 |
|---|---|---|
| backend/session/commands.ts:209 | upsertMessage 的 existed 探测 | 流中 assistant 投影里还没有,误判成新增 |
| backend/session/commands.ts:275 | truncateFrom 递翻译器的兜底 | 投影还没看到正要写出的事件 |
| backend/session/event-translator.ts:206 | 同上(翻译器自己的兜底) | 同上 |
| wiring/engine/stream/agent-loop-executor.ts:407 | captureCancelledToolResults | 投影没看到收尾修复,读空则账本缺 tool/result |
| wiring/engine/stream/agent-loop-executor.ts:450 | 收尾修复 read-modify-write | 投影的占位标题会反焊回去 |
| wiring/engine/stream/agent-loop-executor.ts:498 | completeAgentLoopStream settle 快照 | 投影 contentParts 无 data-steps 锚点(见 14.4) |
| backend/session/reads.ts:165/180/190 | `*FromTranscript` 三口本体 | F11:影子/写侧的真相面 |
| backend/session/shadow.ts | listMessagesFromTranscript | 影子的"事实"侧 |
| backend/server/runtime.ts:3084、rpc/domains/sessions.ts:170、stores/sessions.ts:829 | 存在性/计数杂用 | — |

另:reads.ts 各 routed 方法的 `?? getSessionMessages(...)` 兜底半边
(143/215/224/239/245/251/261/308/323)在 events 折不出消息时(未迁移老会话 / legacy
整文件 / fromEvents 出错)退回消息模式 —— S3w 要把这批兜底的**命中率量成 0** 才能删。

### 14.2 范围分档与推荐

**S3w-lite(推荐)**:只停写 `messages.jsonl`,events 成唯一持久化;store 保留为运行时
写模型(命令仍 mutate store → 派生事件 → 只 append events);冷加载从投影补水;
read-your-own-write 照旧读 store(它是运行时真相,不再是"文件的镜像")。

- 改动面:repository 冷加载岔口 + storage-driver 写半边(`writeMeta`/meta.json 保留)+
  reads 兜底 + verify/shadow/battery 门改造 + 事件写失败语义翻转。**采集点(翻译器 +
  recorder)零改动,core reducer 零改动,引擎端口(P0 冻结形状)零改动,渲染层只有
  14.4 那一个前置。**
- "什么都读 events" 达成度:文件层 100%(唯一持久化);内存 store 变成"投影的写侧
  孪生"(加载=物化,增量=reducer),语义上是事件的运行时缓冲,不再是第二真相。

**S3w-full(丙,纯事件溯源)**:命令 emit 事件 → fold → 状态;core reducer 退役给
projection/reducer;store 退化为物化缓存;mid-command 读 fold 后投影。

- 爆炸半径:13 条命令 + core 引擎注入的 store 端口全套(P0 明令冻结的接口形状)+
  `appendSessionLogEvent` 从异步队列改成写侧同步可见(否则 read-your-own-write 读不到
  自己刚写的)+ 上表 9 处回读残留全部换语义 + 翻译器消亡(命令即事件)。§13 一整章
  实战换来的"写侧读抄本"纪律全部作废重建。
- **反而拆掉安全网**:今天 shadow 之所以是真门,靠的是 store(reducer)与投影
  (projection/reducer)是**两条独立推导**;S3w-full 合并成一条后,"写模型 vs 读模型"
  的恒等比对失去对象。单一真相的正确性从"可对账"退化成"只能信"。

**推荐 S3w-lite**。丙的纯度收益(删一份 reducer 双实现)换不回它的风险与安全网损失;
而 lite 已经拿到 S3 的全部用户可感知价值:单一持久化、双存消失、存储量下降、
messages.jsonl 落盘丢写类(§13.16)整类消亡。丙留作远期(或永不做)。

### 14.3 安全网(S3w 能否落地的关键)

**先把"两个独立来源"看准**:今天有两层对账 ——

1. **语义层**(shadow,run/end + 请求前):内存 store(reducer 推导)vs 活投影(事件
   推导)。**它不依赖 messages.jsonl 文件** —— 真相侧 `listMessagesFromTranscript` 读的
   是内存 store。停写后这道门**照跑不误**,且两侧仍是独立推导(reducer ≠ projection
   reducer)。
2. **耐久层**(verify #6 + §13.16 那类真机对账):`messages.jsonl` 文件 vs 投影。它守的
   是**落盘本身**:append 丢没丢、行坏没坏、seq 乱没乱。停写后这一层的**新增量**没有了
   对象 —— 这才是真正消失的第二来源。

**方案(三件套,推荐)**:

- **A. 分两步停写,观察期带影子**:`ONETHING_SESSION_TRANSCRIPT = 'primary'(今天)|
  'shadow' | 'off'`。`shadow` 档:messages.jsonl 照写,但正式降级为纯对账影子(产品读
  路零消费、写失败只计数不打扰);观察期内 verify #6 / §13.16 类真机对账原样有效。
  达标(建议:≥2 周真机 ∧ ≥200 run ∧ shadow=0 ∧ verify 全库 0 新红)才切 `off`。
  **这一档同时保住 S2b 的回滚船**:`ONETHING_SESSION_READ=messages` 的回滚杆要求
  messages.jsonl 还在写 —— 停写之前必须先确认再也不需要回滚读(见 14.7 时机)。
- **B. 文件重折自洽环(耐久层的替身,`off` 之后的常驻门)**:run/end 采样(每会话每
  N 个 run 一次)把 `events.jsonl` **文件字节**重折出的投影与**内存活投影**(尾部增量
  折叠,projection-cache)做 canonical 对比,不等记 `session-shadow.jsonl`
  `kind:'refold'` 并计数。两侧同源(同一份事件)但**路径独立**(文件重读+全量 fold vs
  内存增量 fold + 队列 append)—— 它恰好覆盖耐久层守的那几类:append 静默丢
  (§13.16 的反方向)、坏行、seq 错乱、fsync 缺口、G12 外写者。verify 的 1–5 项
  (seq/surface/投影/blob/未闭合 run)本来就不依赖 messages.jsonl,原样保留。
- **C. shadow(store vs 投影)转正为常驻恒等门**:S3w 后它不再是"迁移对账",而是
  "写模型 vs 读模型"的永久合同;battery 场景矩阵照跑(battery 是一次性 store,需把
  其中依赖 messages.jsonl 的断言改为 refold + store 断言)。

**配套的纪律翻转**(停写那一刻生效):`appendSessionLogEvent` 写失败与 blob 写失败从
"计数自吞"升级为**命令失败上抛**(event-log.ts:282-286)。唯一持久化的账本写不进去
不再是可吞的旁路故障;blob 尤其要紧 —— 今天附件 base64 落 blob 失败时"正文还在
messages.jsonl"(§10.1 的兜底),停写后同一失败 = 正文永久丢失。

### 14.4 加载路径与渲染锚点(S3w 前置)

**现状链条**:投影**故意不产出** `data-steps`(canonical G4:渲染锚点是派生物;
materializeContentParts 不合成);`messages.jsonl` 的 contentParts 带着它;renderer
`rebuildLoadedContentParts` 见 parts **非空即信**(投影给了 text/reasoning 就不再合成
锚点)。S2b 切读后这条断裂已经咬过两口:collab work-group 消失与收尾覆盖
(43b47b2a / 011df77a),止血法都是**收尾链改读抄本**(agent-loop-executor.ts:450/:498
的注释即此)。**这个止血依赖"store 由 messages.jsonl 补水"** —— S3w 抽掉补水源后,
冷加载进 store 的消息 contentParts 就是投影形状(无锚点),FromTranscript 读回的也是它,
止血自动失效。

**裁定建议:渲染层自合成,定为 S3w-0 前置。** `rebuildLoadedContentParts` 的判据从
"parts 非空即信"改为"**缺锚点且有 steps → 按 turnIndex 合成/归并 data-steps**"
(rebuild-content-parts.test.ts 已有'旧 tool-call parts ≡ 新 data-steps'的等价性基架,
扩一组'投影形状(text/reasoning-only)+ steps'用例)。落地后:①投影补水的消息渲染
完整;②:450/:498 两处对"抄本才有锚点"的依赖解除(读投影补水的消息也不掉渲染);
③G4 纪律原样(投影仍不产出,canonical 仍丢弃比较)。
备选(均否):投影产出 data-steps —— 违反"锚点住渲染侧"(G4),canonical 要开豁免;
维持抄本依赖 —— 等于否决 S3w。

**补水的形状门**:冷加载改投影补水后,store 里的消息会被后续命令改写、再经翻译器写出
新事件 —— 补水形状的任何漂移(`eventSeq` vs 退役的 `seq`、attachments 的 BlobRef、
data-steps)都会**反射进新事件**。过渡期需要一道一次性合同:对全量真机会话断言
"投影补水 + rehydrate ≡ loadJsonl + sanitize + rehydrate"(canonical 口径),绿了才许
切补水源。这道门是 S3w-1 的核心验收。

### 14.5 steps/toolCalls 双存移除

- **磁盘双存随停写免费消失**:events 里工具事实只有一份(`tool/call|result|audit` +
  chunks),`steps[]`/`toolCalls[]` 是 materialize 的两个视图。§8 那句"双存从存储消失
  (投影仍产出)"在 S3w-lite 落地日自动成立,不需要单独动手。
- **内存/IPC/渲染的双视图保留,不在 S3w 范围**。消费者两边都有硬吃者:history builder
  (core/engine/history.ts:96-97,toolCalls 出工具结果、steps 出 turn 切分)、renderer
  (StepsPanel / tool-display / work-group,`step.toolCall` 与顶层同引用)、collab
  worker-mind-port、resume-history、evals。收敛这层形状 = 渲染层 + history 大改,存储
  收益为零 —— 另立门户,或接受"两个视图"为长期形态。
- §13.17 裁定一("`message.toolCalls[]` 是唯一磁盘持有点")语义顺延为
  "`tool/result` 事件是唯一磁盘持有点,顶层是物化视图" —— 裁定四已把事件面的 changes
  采集补齐,不冲突。

### 14.6 子分期、门与待拍板清单

| 期 | 交付 | 门 | 回退 |
|---|---|---|---|
| **S3w-0** 渲染锚点自合成 | **已落地 `8682d980`(§14.8)** rebuildLoadedContentParts 判据改造 + :450/:498 依赖解除说明 | work-group/rebuild 测试 + battery 双泳道 GREEN + 真机重载走查 | 纯渲染层,git revert |
| **S3w-0b** 单写者硬化 | server 双写者裁定重审(2026-08-19 明言"事件成唯一真相前必须重审",就是现在)。**不引入锁**(server StoreLock 方案 P0.4 已按用户裁定撤回,单写者走 one-core 发现文件):G12 守卫从"重装+warn"升级为拒写上抛,并裁定发现文件盖不住的残余双写窗口 | 双进程真机用例:第二个写者写不进 events | 开关 |
| **S3w-1** 冷加载补水切投影 | repository 冷加载岔口(events 有消息覆盖→物化补水+rehydrate;无→老路);reads 兜底命中遥测(fallback-hit 计数);补水形状合同(14.4) | 全量真机"补水 ≡ loadJsonl"canonical 合同绿 + fallback-hit=0(观察)+ 全量测试/battery | 岔口开关,默认老路先行 |
| **S3w-2** 停写观察期 | `ONETHING_SESSION_TRANSCRIPT` 三态,默认切 `shadow`;事件/blob 写失败上抛;refold 自洽环(14.3-B)上线 | ≥2 周真机 ∧ ≥200 run:shadow=0 ∧ refold=0 ∧ appendFailures=0 ∧ verify 全库 0 新红 | 切回 primary,零损伤 |
| **S3w-3** 切 off + 删旧 | 默认 `off`;storage-driver 消息写半边删(meta.json/index 写保留);reads 兜底删(legacy 整文件除外,见拍板 8);sanitize 死码清;session:check 白名单收缩;verify #6 改"存量只读对账";battery 断言落定 | 棘轮归零 + verify 全库 + 存储量目标(≈messages×1.1–1.2,§8)| 本期才删码,回退=revert |
| **S3w-4** 体积治理 | events/blobs 上限、gzip 轮转、blob GC(引用扫描已有 collectBlobHashes)、cleared 历史段归档策略 | 存储脚本给出目标值并达标 | 独立 |

**待用户拍板(裁定单,2026-08-24 整理)**。按"什么时候必须拍"分三组;每条给出
问题、选项(推荐加粗)、推荐理由与拍错的代价。已经被落地事实解决的一条(原 5)单列
在末尾追认。

**第一组 —— 现在就拍(决定下一批能否开工)**

1. **范围档位:S3w-lite vs S3w-full(丙)** —— 整个 §14 的总开关,后面每条都以它为前提。
   - **A. S3w-lite(推荐)**:只停写 `messages.jsonl`,events 成唯一持久化;store 保留为
     运行时写模型,冷加载从投影补水。采集点/reducer/引擎端口零改动(§14.2)。
   - B. S3w-full:命令即事件、reducer 退役、store 退化为物化缓存。爆炸半径 = 13 条命令 +
     P0 冻结的 store 端口全套 + §13 全章纪律重建,且拆掉 shadow 门的"两条独立推导"
     (§14.2)。
   - 代价对比:lite 已拿到全部用户可感知价值(单一持久化、双存消失、§13.16 类消亡);
     full 的纯度收益只有"删一份 reducer 双实现"。**拍 B 意味着本节大半方案作废重写。**
   - **裁定(2026-08-25,用户):走 full。** lite 推荐被推翻。落法修正:批 P/0b/1/2/3/4
     的实施内容**不作废**——它们同时是 full 的必经前站,原样作为第一阶段执行;full 的
     增量(命令即事件、reducer 退役、翻译器消亡)立为 **F 线**,设计见 §16,在 S3w-3
     浸泡后开工。"大半方案作废"仅指终局与安全网叙事:§14.3 的 shadow 转正为永久恒等门
     改为 F 线过渡门(F4 退役),refold 自洽环升格为终局唯一常驻耐久门。
2. **命名:写切换期就叫 S3w,还是重编号 §8 分期表** —— 纯记账问题。
   - **A. 定名 S3w(推荐)**:§12 的 "S3"(trace)已入库不动,文档与提交信息统一用 S3w。
   - B. 重编号整表:改动波及 §8/§12 与既有提交信息的引用,收益为零。
3. **单写者硬化(S3w-0b 的全部内容,拍完即可开工)** —— 2026-08-19 "desktop + dev
   server 共享 `~/.onething` 的双写者风险,事件成唯一真相前必须重审"指的就是现在:
   停写后双写者 seq 撞号 = 静默历史错乱,比 messages 双写(最后写者赢)严重一个量级
   (§14.7 风险③),所以 0b 是 S3w-1 的硬前置。
   **锁方案不在选项里**:server StoreLock P0.4 已按用户裁定撤回,2026-08-24 用户重申
   不要 lock —— 进程级单写者由 one-core 发现文件(`run/http.json` 启动拒绝)承担,
   S3w 不引入任何新锁。要拍的只剩一问:
   - **A. G12 守卫从"重装 + warn"升级为拒写上抛(推荐)**:events 写侧发现文件被
     别的进程写过(字节数守卫命中)→ 该次 append 直接失败上抛,不再重装计数器继续写。
     发现文件盖不住的残余窗口(两个 `server:start` 互不拒绝、`--force` 绕过)全部由
     这道拒写兜底 —— 窗口本身接受为已知边界,不另设机制。
   - B. 维持"重装 + warn":**不推荐** —— 等于带着已知的静默错乱源停写。
   - 连带关闭:§13.3 S 批 F14 的选项③(复活 server StoreLock)出局;选项①(迁移/切换
     前置"无活 core 硬检查",查发现文件 + 进程探测,不引入常驻锁)并入 S3w-1 的门。
4. **时机:S3w-1 起何时开工**。
   - **A. S3w-0b 拍板后即做;S3w-1 起等 S2b 真机浸泡 ≥1–2 周(推荐)**:批 8
     (`bad54a31`)刚切读默认,事件读路的未知真机类还在暴露期(§13.16 即真机暴露);
     更硬的一条 —— 停写 = 烧掉 `ONETHING_SESSION_READ=messages` 这条 S2b 回滚船,
     必须先确认"再也不需要回滚读"。
   - B. 全线立即:省 1–2 周,换来的是回滚船提前烧掉 + 未知类直接落在唯一账本上。

**第二组 —— S3w-2(停写观察期)开工前拍**

5. **停写策略:三态开关 + 观察期,还是一步停写**。
   - **A. `ONETHING_SESSION_TRANSCRIPT = primary | shadow | off` 三态(推荐)**:先切
     `shadow`(messages.jsonl 照写但降级为纯对账影子),达标才切 `off`。观察期内
     verify #6 与 §13.16 类真机对账原样有效,回滚 = 切回 primary 零损伤(§14.3-A)。
   - B. 一步停写:少一个开关状态,换来的是耐久层对账直接失去对象、回退有损。
   - **随本条一并拍观察期阈值**,建议:≥2 周真机 ∧ ≥200 run ∧ shadow=0 ∧ refold=0 ∧
     appendFailures=0 ∧ verify 全库 0 新红(不达标不切 off,没有"差不多了"档)。
6. **安全网组合:§14.3 三件套是否成立**。三件 = A 观察期带影子(见上条)+
   B refold 自洽环(off 之后的常驻耐久门:run/end 采样把 events.jsonl 文件字节重折与内存
   活投影 canonical 对比,盖住 append 静默丢/坏行/seq 错乱/fsync 缺口/外写者)+
   C shadow 转正为"写模型 vs 读模型"永久恒等门。
   - **认三件套(推荐)**:这是"停写后第二来源消失"的唯一替代方案;否决其中任何一件
     需要给出替代的耐久性证明,否则 S3w-2 的门没有判据。
   - 附带口径:battery 是一次性 store,其中依赖 messages.jsonl 的断言改为
     refold + store 断言 —— 认不认这个改造口径也在本条内。
7. **写失败语义:events append / blob 写失败,升级上抛还是维持计数**。
   - **A. 升级为命令失败上抛(推荐,停写那一刻生效)**:唯一持久化的账本写不进去不再是
     可吞的旁路故障。blob 尤其要紧:今天附件落 blob 失败时"正文还在 messages.jsonl"
     (§10.1 兜底),停写后同一失败 = 正文永久丢失(§14.7 风险④)。
   - B. 维持计数自吞:保住"写失败不打扰用户",代价是静默丢正文从"影子少一笔"变成
     "账本少一笔",用户看不见。
   - 派生细节(可授权实施时定):上抛的 flush 时点与异步队列语义在 S3w-2 重审
     (§14.7 风险②)。

**第三组 —— S3w-3(删旧)开工前拍**

8. **steps/toolCalls 双存**:磁盘双存随停写免费消失(§14.5,这半句不用拍);要拍的是 ——
   内存/IPC/渲染的双视图**长期保留**、形状收敛**另立门户**(或接受为长期形态),认不认。
   - **认(推荐)**:双视图两边都有硬吃者(history builder / StepsPanel / collab /
     resume-history / evals),收敛 = 渲染层 + history 大改而存储收益为零。
   - 不认 = 把一个存储工程扩成渲染重构工程,S3w-3 的规模估算作废。
9. **legacy 处置(两小问)**:
   - 9a. `messages.jsonl` 存量:**永久原地只读(推荐)** vs 观察期后归档进
     legacy-backup。推荐理由:原地只读零风险零迁移;归档只省目录整洁,多一次批量搬文件
     的风险窗口。
   - 9b. legacy 整文件会话(`sessions/<id>.json`):**首触迁移进 events(推荐)** vs
     永久保留只读兜底代码。推荐理由:reads 兜底半边(§14.1 末)要把命中率量成 0 才能删,
     永久保留兜底 = 那批代码永远删不掉。
10. **clear 留档:`messages.cleared-*` 存档保留还是退役**。
    - A. 保留:事件之外另一份物理存档,清空误操作时有独立副本。
    - **B. 退役(推荐)**:`session/cleared` 只遮蔽不删,事件本身就是档 —— 保留等于给
      "事件是唯一真相"开第一个例外。
    - 若拍 A,需同时指定它的 janitor 策略(今天没有任何治理器管这批文件)。

**已被落地事实解决,待追认**

- **渲染锚点归属**(原 5):勘察推荐"渲染层自合成,定为 S3w-0 前置",**已按推荐落地**
  (`8682d980`,§14.8)。备选两项(投影产出 data-steps —— 违 G4;维持抄本依赖 ——
  等于否决 S3w)自动关闭。若要否决,revert 即回,但 S3w-1 的补水前提随之消失。

### 14.7 effort / risk 与时机

- **规模**(S3w-lite 全程):约 5–7 个工作批。S3w-0 小(1 批,纯渲染);0b 小(拍板
  后 1 批内);1 中(最险的一批:补水形状合同 + 兜底清零);2 中小(机制少、门重);
  3 中(删码 + 四个脚本/门改造);4 独立中小。
- **风险 Top4**:①补水形状漂移反射进新事件(翻译器以 store 为取材源 —— 14.4 的合同门
  就是为它设的);②崩溃窗口:events append 是异步队列,停写后"队列未刷即崩"从
  "影子少一笔"变成"账本少一笔"(语义 fsync 检查点已比 messages 的 300ms 节流强,但
  上抛语义与 flush 时点要在 S3w-2 重审);③双写者 seq 撞号 = 静默历史错乱,比 messages
  双写(最后写者赢)严重一个量级 —— 0b 是硬前置;④blob 写失败 = 正文永久丢
  (messages.jsonl 今天兜着的那层没了)。
- **现在做 vs 推迟**:**S3w-0 现在做** —— 它修的是 S2b 已现形的真机渲染断裂的根
  (43b47b2a/011df77a 是止血不是治法),独立于停写决策都值得落。**S3w-1 起建议推迟到
  S2b 真机浸泡 ≥1–2 周后**:批 8(bad54a31)刚切默认,事件读路的未知真机类还在暴露期
  (§13.16 那类就是真机暴露出来的);更硬的一条 —— S2b 的回滚杆
  `ONETHING_SESSION_READ=messages` 依赖 messages.jsonl 还在写,**停写 = 烧掉 S2b 的
  回滚船**,必须等"再也不需要回滚读"这个判断先成立。

### 14.8 S3w-0 落地记录(2026-08-24,`8682d980`)

按 §14.4 推荐项落地,纯渲染层三文件:

- `packages/renderer/stores/helpers/content-parts.ts` 新增 `synthesizeToolAnchors`;
  `rebuildContentParts` 判据从「contentParts 非空即信」改为「缺工具锚点(无
  data-steps/tool-call part)且有 steps/toolCalls → 按 turnIndex 补合成 data-steps」。
  幂等、不破坏流式、turnIndex 对齐。
- `packages/renderer/stores/chat.ts` 接线;`rebuild-content-parts.test.ts` +6
  反向/幂等用例(含「投影形状(text/reasoning-only)+ steps」组)。
- 效果即 §14.4 预期三条:投影补水的消息渲染完整;agent-loop-executor.ts:450/:498 对
  「抄本才有锚点」的依赖解除(work-group settle 修复从止血升级为终局);G4 纪律原样
  (投影仍不产出 data-steps,canonical 仍丢弃比较)。

下一步:§14.6 裁定单第一组(1 档位 / 2 命名 / 3 G12 拒写升级 / 4 时机)拍完即可开工
S3w-0b;第二、三组分别在 S3w-2 / S3w-3 开工前拍。锁方案已全部出局(2026-08-24 用户
重申不要 lock),S3w 全线不引入任何锁。

## 15. 影子门红灯诊断(2026-08-25)+ S3w 实施方案

### 15.1 影子门红灯:runs 76 / mismatches 30 —— 两类,全部查到根因

`sessions:shadow-report` RED。`runs 76 < 200` 只是 reset 后累计不足(battery 238 runs
即可挣满,不是病);要治的是 `mismatches 30`(另 duplicateMismatches 183、
projectionIssues 5)。30 条**全部来自同一个会话** `46dcec05`(日常主力会话),
08-24 11:55 起。两类:

**A 类(history,20 条):压缩遮蔽在投影侧失效 —— 真相侧 114 条(压缩口径),
投影侧 227 条(全量,从第一条 "hi" 开始)。**
> **勘误(08-25,§15.5)**:下面第 2–4 步的机制描述在执行批 P 时被代码推翻 ——
> `tool/result` 本来就是 surface 节点,replace 解析并未失败;真因是**压缩落账在前、
> 迁移把 43 条 imported 补到头部在后**,头部节点越过了 covered 起点。现象与影响面
> 描述仍准确,机制以 §15.5 为准。原文保留供对照:

1. 该会话的事件日志**诞生于一次 run 中途**(迁移前备份首行 seq 1 =
   `request/tools`,没有 `session/created`;早期 43 条消息只在 messages.jsonl)。
2. 08-21 15:43 第一次压缩落账时,写侧 `sessionCompacted`
   (`backend/session/event-translator.ts:346-382`)从写侧 surface 的 order 取
   `covered = order.slice(0, at+1)`,写出的 `surfaceOp.start=7` —— 指向一条
   **`tool/result`**。
3. 读侧 `SurfaceIndex.applyReplace`(`core/session/projection/surface.ts`)按
   `order.indexOf(start)` 解析;`tool/result` 不是读侧 surface 节点 → `-1` →
   `replace-start-missing` → **静默不遮蔽**,摘要节点还被 splice 到错误位置。
   第二次压缩(08-23 00:09,start=上一条 compacted 节点)能解析,但第一段已漏,
   总账仍是全量。
4. 08-23 21:19 的 merged 迁移(imported 43、shiftedBy 43)**无错**:均匀移位后
   end 仍精确指向锚点 run/start(1170→1213、1905→1948)。病根在压缩落账那一刻。

定性:**写侧 surface 与读侧 SurfaceIndex 对"什么算节点"在"半截 run 开头的日志"上
判定不一致**(写侧 order 里进了 seq 7;它怎么进去的,修复批读
`backend/session/event-surface.ts` 时钉死)。F3(§13.2)防的是"找不到切点退化成
append",这次是同病第二形态:**切点找到了,但切在读侧不存在的格上**。影响面:
全库 400 个迁移过的会话里带 completed compact 的仅 3 个。**这不只是影子账面问题**:
S2b 已切读 events,这个会话的发送历史**真的在按全量走**(预算翻倍、摘要与原文同时
在场 —— F3 注释预言的后果,真机兑现了)。

**B 类(messages,10 条):`steps[].usage.providerCostUSD` store 有、投影缺。**
Provider OO P4 批(1491a19b 起)让 grok/openrouter 方言把上游成本写进 usage
(`runtime/src/agent-loop/providers/base/usage.ts`);但 recorder 的 `normalizeUsage`
(`backend/wiring/engine/stream/session-event-recorder.ts:702-717`)是六字段白名单,
没收新字段 → 事件不带 → 投影 materialize 不出 → 每个带成本读数的 run 记一条。
**这正是影子门的本职**:新字段上线、事件面漏采,门当场红。在 canonical 里豁免是
错修(停写后该字段永久丢);正修 = 采集补齐。

### 15.2 S3w 实施方案(分期总览)

裁定状态(2026-08-25):**档位已拍 = full**(§14.6 裁定 1)——本表 P–4 原样保留,
作为 full 的**第一阶段**(终局叙事见 §16 F 线);命名(S3w)/ G12 拒写 / 时机三条
用户未提异议,按推荐执行。**批 P 已派工执行**(2026-08-25,opus)—— 它修的是已在
真机流血的缺陷(A 类在放大真实请求预算),同时是 S3w-2 影子门判据成立的前提。
执行按用户分工:Fable 拆分/审查,opus 执行,haiku 提交。

| 期 | 交付 | 规模 | 门 | 回退 |
|---|---|---|---|---|
| **P 清障** | P-a providerCostUSD 采集补齐;P-b compact 遮蔽写读两侧修复 + 存量自愈 | 1 批 | 全量测试 + battery(新增 2 场景)+ shadow-reset 后真机泡 0 失配 | 纯修复,revert |
| **0b 单写者硬化** | G12 守卫升级:发现外写者 → 本次 append 拒写并计数(不再重装计数器继续写);S3w-2 起随裁定 7 升级为命令失败 | 1 批内 | 双进程真机用例:第二个写者写不进 events | 开关 |
| **1 冷加载补水** | repository 冷加载岔口(events 有消息覆盖→物化补水+rehydrate;无→老路);补水形状合同门;reads 兜底 fallback-hit 遥测 | 1–2 批(最险) | 全量真机会话"投影补水 ≡ loadJsonl+sanitize"canonical 合同绿 + fallback-hit=0 观察 | 岔口开关,默认老路先行 |
| **2 停写观察** | `ONETHING_SESSION_TRANSCRIPT=primary\|shadow\|off` 默认切 shadow;写失败上抛(裁定 7);refold 自洽环;battery 断言改 refold+store 口径 | 1 批 + 观察期 | ≥2 周 ∧ ≥200 run ∧ shadow=0 ∧ refold=0 ∧ appendFailures=0 ∧ verify 0 新红(裁定 5 阈值) | 切回 primary 零损伤 |
| **3 切 off 删旧** | 默认 off;storage-driver 消息写半边删(meta/index 保留);reads 兜底删;sanitize 死码清;session:check 白名单收缩;verify #6 改存量只读对账;legacy/clear 按裁定 8/9/10 | 1–2 批 | 棘轮归零 + verify 全库 + 存储量 ≈ messages×1.1–1.2 | 本期才删码,revert |
| **4 体积治理** | events/blobs 上限、gzip 轮转、blob GC(collectBlobHashes 已有)、cleared 归档 | 独立 1 批 | 存储脚本达标 | 独立 |

浸泡时钟:S2b 真机浸泡期(≥1–2 周)从**批 P 落地 + shadow-reset** 起算 —— 批 P 之前
的影子读数带着两类已知失配,不构成干净基线。

### 15.3 批 P 细化(唯一现在就开工的批)

**P-a providerCostUSD(小)**:
1. `session-event-recorder.ts` `normalizeUsage` 白名单 + `providerCostUSD`;
   `SessionResponseUsage` 类型(core/shared 两处形状)同步;投影 materialize 侧
   透传(request/end → step.usage 的路,预计零改动,合同测试钉死)。
2. battery 新场景:带成本 usage 的 run(fake provider 回 usage 带 providerCostUSD),
   断言投影 step.usage 与 store 逐字段等。
3. **历史残余**:P4 落地(08-22)后、本修复前的 grok run,messages 里有成本、events
   里没有 —— `sessions:verify:gate` 基线追加为已知 legacy 残余(棘轮只减不增),
   不回填、不豁免 canonical。

**P-b compact 遮蔽(中)**:
1. **写侧修正**:`event-translator.ts` sessionCompacted 的 covered 只能由**节点 seq**
   构成 —— 修 `event-surface.ts` 里非节点 seq 进 order 的那条路(半截 run 开头的
   日志),使 start 永远落在读侧认得的格上。
2. **读侧语义兜底**(老文件自愈,不改数据):`SurfaceIndex.applyReplace` 对
   `session/compacted` 的 `replace-start-missing` 增加第二步解析 —— 按
   `data.compactedThroughMessageId` 找锚点节点,从 surface 头遮到它(压缩语义本来
   就是"从头到锚点");仍解析不出才落 violation。canonical 单法官纪律不动
   (兜底在投影内核,两侧同款)。
3. **verify 新判据**:completed compact 且 shadowed 覆盖数为 0 → 红(今天这类
   静默漏遮从此进门)。
4. battery 新场景:半截 run 开头(日志首事件非 session/created)+ compact。
5. 受影响存量:46dcec05 及全库另 2 个"迁移+compact"会话,读侧兜底落地即自愈,
   `sessions:verify` 全库跑一遍确认。
6. 收尾:`sessions:shadow-reset`,真机开始积干净的 ≥200 run。

### 15.4 后续各期的实施要点(开工前再细化成工单)

- **0b**:改 `backend/session/event-log.ts` G12 段(:196 附近)——检测到外写者时
  本次 append 拒绝并计入 appendFailures(warn 一次),**不**回退重装继续写;
  命令失败语义留到 S3w-2 随裁定 7 一起翻转(观察期里 messages.jsonl 还在,拒写
  只该记账不该打扰)。双进程用例进 battery 或独立脚本。
- **1**:岔口开在 `session-repository.ts:604 loadSession`;补水函数 = 物化投影 +
  `rehydrate`(:238)同款链接重建;合同脚本对全量真机会话断言
  "投影补水+rehydrate ≡ loadJsonl+sanitize+rehydrate"(canonical 口径),绿了才许
  把岔口默认翻过去;`reads.ts` 各 `?? getSessionMessages` 兜底加命中计数,进
  shadow-stats(fallbackHits),S3w-3 删兜底前必须量到 0。
- **2**:三态开关读点在 event-log 写入口与 storage-driver 写入口;refold 自洽环
  新模块(建议 `backend/session/refold.ts`,run/end 采样:文件字节重折 vs 内存活
  投影,不等记 `kind:'refold'` 进 session-shadow.jsonl);battery 里依赖
  messages.jsonl 的断言改 refold+store。
- **3**:删码清单以 §14.1 的写侧回读残留表和 reads 兜底清单为准;`scripts/
  session-check.mjs` 白名单同步收缩;`messages.cleared-*` 与 legacy 按裁定 8/9/10。
- **4**:`LOG_DIR_POLICY` 不管 sessions(它只管 log/),事件账本的治理是新策略面,
  单独设计,不塞进日志 janitor。

## 16. F 线:full 终局(写模型翻转)设计轮廓(2026-08-25 立项,S3w-3 浸泡后开工)

用户 2026-08-25 拍板走 full(§14.6 裁定 1)。F 线是 S3w 第一阶段(批 P–4)之后的
增量:把写路径从「命令 → reducer 改 store → 翻译成事件」翻成「命令 → 产出事件 →
fold 出状态」。终局:**事件是唯一源头,store 是物化缓存**;core reducer 与翻译器
退役,投影 reducer 成为唯一状态推导。

### 16.1 为什么必须排在 S3w-3 之后

- 翻转的前提是「事件已经是唯一持久化并被证明可信」:refold 自洽环(S3w-2)与停写
  观察期就是这份证明。事件还只是影子/双写时翻写模型,等于把未验证的账本直接扶正。
- S3w-1 的补水形状合同(投影补水 ≡ 老加载)在 F 线里复用为「fold 出的状态 ≡ reducer
  出的状态」恒等门的基架 —— 先落 S3w-1,F 线的门就有现成判据。

### 16.2 分期草案(开工前再细化成§15.3 粒度的工单)

| 期 | 交付 | 门 | 回退 |
|---|---|---|---|
| **F0 恒等门转向** | 现 shadow(store=真相 vs 投影=影子)**角色对调**:事件/fold 侧成真相,老 reducer 降级为影子验证器;比对机制、记账口径沿用 session-shadow | 对调后真机 ≥200 run 0 失配 | 对调是比对方向,零行为变化 |
| **F1 写侧同步可见** | 命令产出的事件先 fold 进活投影(projection-cache 增量 fold 已有)再异步落盘;「命令内读得到自己刚写的」成为纪律,fsync 检查点保留 | 恒等门 + 既有全量测试 | 开关 |
| **F2 命令面翻转(逐条)** | 13 条命令分小批改造:命令产出事件 → fold → store 视图从投影物化;翻译器逐命令退役(命令即事件)。顺序:append/delete/patch 类先,upsert/truncateFrom/compact 后(compact 携 §15 批 P 的遮蔽判例作回归)。**必做项(§15.6 裁定):工具自报结局 `annotate` 获得自己的事件产地**(否则停写后该格永久折不出),连同 §13.8 "采集点不二次派生"裁定一起重审 | 每小批:F0 恒等门 0 失配 + battery + 全量 | 逐命令开关或 revert |
| **F3 写侧回读换语义** | §14.1 的 9 处写侧回读残留全部改读 fold 后投影(F1 是前提);「写侧读抄本」纪律(§13.18)整体翻面 | 定向用例逐处 + battery | 随 F2 分批走 |
| **F4 reducer 退役** | core/session/commands.ts reducer 与 projection/reducer 合一;P0 冻结的引擎 store 端口按新形状解冻重审(单独拍板);F0 影子门退役,refold 自洽环成为终局唯一常驻耐久门 | 全量 + battery + refold 常驻 0 | 本期才删码,revert |

### 16.3 F 线自己的待拍板(到期再拍)

1. **P0 冻结端口解冻范围**:core 引擎注入的 store 端口形状是 P0 明令冻结的,F4 必须
   解冻 —— 解到什么程度(只换实现 vs 换接口形状)到 F4 前拍。
2. **F0 影子验证器的退役条件**:F4 合一后两条推导变一条,「可对账」终结 —— 退役门
   (多少 run / 多久)与 refold 采样率一并拍。
3. **时机**:S3w-3 落地后浸泡多久开 F0。

### 16.4 风险登记(立项即记录)

- **安全网递减是 full 的本质代价**(§14.2 已述,用户知情拍板):F4 之后正确性凭据只剩
  refold(同源两路径),没有独立第二推导。F0–F3 期间恒等门仍在,风险集中在 F4 之后。
- **同步可见 vs 崩溃窗口**:F1 把「fold 先于落盘」钉成纪律后,崩溃时活投影可能领先
  磁盘 —— refold 会把这类窗口暴露为 refold 失配,语义 fsync 检查点是兜底,F1 落地时
  重审检查点位。
- **13 条命令翻转是长尾**:compact/truncateFrom/upsert 三条携带 §13 一整章的真机判例
  (双追加、占位替换、existed 探测),每条翻转都要把对应判例搬进用例。

### 15.5 批 P 落地记录 + §15.1 勘误(2026-08-25,opus 执行,未提交)

**先勘误 —— §15.1 A 类的机制描述(第 2–4 步)是错的,执行时被代码推翻:**

- `tool/result` **本来就是** surface 节点(`SESSION_SURFACE_NODE_TYPES`,
  `core/session/events/types.ts:903`),写读两侧从一开始就共用 `isSessionSurfaceNodeType`
  —— "写读节点判定不一致"不成立,`replace-start-missing` 在这份文件上**一条都没有**
  (修复前实测 `foldSurface` violations 为空)。
- 真正的病根是**顺序**:压缩落账在 08-21(covered 从当时的 `order[0]` = seq 7 起),
  迁移在 08-23 把 43 条 `message/imported` 补到**头部** —— 43 个更早的节点插到了
  covered 起点前面,永远留在 surface 头上。§15.1 说迁移"无错"只在 seq 平移算术上
  成立;**语义上正是迁移制造了这个形状**。投影 632 条 / 真相 519 条。
- 第三个真机反例(`fd899977`)逼出补充规则:那次压缩当年锚点解不出,写侧退化成
  "遮蔽整条 surface"(声明 [61..458]),而迁移把锚点消息补到了第 14 格 —— 只按锚点
  遮会把 400 多格原文放回历史。**终局规则:completed 压缩遮蔽
  `[0 .. max(锚点位, 声明 end 位)]`(只许长不许缩,两种说法取并集)。**

**落地内容**(9 文件,+813/−81 中属本批的部分;工作树另有他会话的 renderer 改动勿混):

- **P-a**:`SessionResponseUsage`/`ProjectedStepUsage` + `providerCostUSD`;recorder
  `normalizeUsage` 白名单补字段;投影 reducer 透传到 `steps[].usage`,**消息级 usage
  显式摘掉成本**(镜像引擎累加器 `agent-loop-executor.ts:2560` 逐字段列名的行为,
  否则造出新失配);battery 场景 `provider-cost-usage`(反证:撤掉采集行单跑即红)。
- **P-b**:`surfaceMessageIdOf` 上收 core 成为写读唯一判定(写侧自抄的 `messageIdOf`
  删除);`SurfaceIndex` 自持 `seqByMessageId`,compact 的 replace **与 append 两条路**
  都按锚点语义重解(F3 的"退化成 append"读侧也救);`sourceEventSeqs` 校验只查声明区,
  新 violation `source-seqs-incomplete`;`shadowedCount()` 供 verify 逐条判;
  `sessions:verify` 新判据 `compact-shadowed-nothing`。
- battery 只放得下 A 类的**活进程半边**(首事件非 `session/created` 时压缩照样遮净);
  "离线改过的文件被新进程重折"那半边活进程里造不出红(写侧 surface 与活投影常驻
  内存),落在 fold 级合同用例(`projection-contract.test.ts` +3)—— 结构性事实,
  记录在案。
- **基线**:`session-verify-baseline` +9 条(全部 46dcec05 的 providerCostUSD 存量残余;
  stash 反证:本批不新增不治愈任何 verify 红线)。

**门(全部实跑)**:typecheck 绿;battery GREEN(26 场景×7 pass,runs 266 /
mismatches 0);boundary:gate / session:gate / log:gate 全 ok;定向 2428 用例 16 失败
均为本机冷启动抖动(两文件单跑 32/32 绿,与近两 commit 记录同款)。

**真机只读验证**(零写入):全库 424 会话 surface 类问题 0;三个"迁移+compact"会话
全部自愈 —— `46dcec05` order 444→401、模型历史 520 条首条为摘要(与影子真相侧
逐字对上),`fd899977` 58→30,`fe5261d9` 311→247;`compact-shadowed-nothing` 全库
零命中。

**遗留待裁定(3 条,均先于本批存在,verify:gate new 12→3)**:
`a5157107` 的 unclosed-run 与 aborted ask_user 类 canonical differs(§13.8 第一类新
实例)、`room-1` 的 projection 多 1 条 —— 要不要按既有分类并入基线,待用户拍。

**收尾顺序**(待用户指令):审查通过 → haiku 提交(只圈本批 9 文件 + 两份 docs,
勿裹他会话的 renderer/tsconfig 改动)→ 重启桌面换上新代码 → `sessions:shadow-reset`
→ 真机开始积干净的 ≥200 run(S2b 浸泡时钟起点)。

### 15.6 P2 诊断:不是取消采集缺口,是退出竞速(2026-08-25,opus 诊断,零代码改动)

工单前提(interaction 取消路径漏采)被代码与账本推翻。真链条:

```
Cmd+Q → before-quit.ts:100 await shutdownStreamEngine()
      → CoreStreamEngine.abortAll()(同步 abort 全部控制器)
      → InteractiveTool AbortScope 同步 withdraw → Interaction.abort(全仓唯一调用者
        wiring/toolkit/adapters.ts:113)→ settle('aborted')
      → interaction/answered(seq 247)+ ask-user.ts:237 annotate(「提问已取消」进
        store)+ tool/audit(seq 248)—— 同步/微任务,全部落账 ✅
      → run/end(runs.ts:225 endSessionRun)与批 9 取消采集
        (agent-loop-executor.ts:404/480)都挂在 completeAgentLoopStream 异步收尾链
        → before-quit 随后同步跑三个 shutdown + flush 就走人,链没跑完,两笔账没了 ❌
```

**硬证据**:messages.jsonl mtime = 事故那一秒(01:29:23.739,「提问已取消」是引擎
活着写的,不是 sanitize —— interrupted.ts 裁定表本来就不动 title);app.jsonl 同秒是
整串退出日志,13 秒后冷启动;endSessionRun 零产出。

**三条修正既有认知**:
1. 批 9 只封住"活进程中止"半边;"abort 由退出发出"是没盖到的一格(基线第 24 行
   "不再新增"口径过宽,已在基线注释更正)。
2. `unclosed-run` 那格**会自愈**:prepareSessionEvents(S2a §11.1)在会话下次打开时
   补 tool/result(interrupted) + run/end(interrupted)。a5157107 只是从没被再打开。
3. 自愈不了的只有**工具自报结局那一格**(step.title「提问已取消」/ step.result
   details):`annotate` 在事件账本里没有产地,只能经收尾链间接到达 —— 而 §13.8 明确
   裁定"采集点不二次派生、只抄收尾后引擎写下的那一份"。救这一格 = 推翻该裁定。

**三个可选修法(待拍板)**:甲 退出路径等收尾(before-quit 不被 Electron await,
结构上无法保证,且退出变慢)/ 乙 annotate 自己成为事件产地(根治,但动事件词汇 +
canonical 兜底 + 推翻 §13.8 裁定)/ 丙 收编为判例(退出即中断由 prepare 兜底成
interrupted 占位,自报标题接受丢失 —— 今天的实际行为)。

**与 F 线的关系(方案侧意见)**:full 拍板后「事件是唯一源头」成为终局 —— 自报结局
若在事件里没有产地,停写后这一格**永久**折不出来,丙就从"接受偶发丢失"变成"接受
永久丢失"。所以乙不是要不要做、是什么时候做:建议**现在收丙(零码,写进 §13.8 作
第一类子形状),乙挂进 F 线**(F2 命令/词汇翻转时给 annotate 一个事件产地,连同
§13.8 裁定一起重审)。甲不做。

**这起事故同时是 §14.7 风险②的真机预演**:停写之后,同样的退出竞速丢的就不是
"影子少一笔"而是"账本少一笔" —— S3w-2 重审写失败语义与 flush 时点时,必须把
"引擎收尾链 vs 进程退出"的顺序一并纳入(before-quit 的 flush 只救了 store 落盘,
救不了没跑到的收尾链)。

基线:+2 行(a5157107 的 unclosed-run 与 canonical differs,注释写明该类**尚未修**、
unclosed-run 会随会话打开自愈届时应摘)。全库 verify:25 known / 0 new,无第二个
会话命中此类。

**裁定(2026-08-25,用户):丙 + 乙挂 F 线,甲不做。** 即:今天收编为判例 ——
退出竞速导致的半截 run 由 prepare 兜底成 interrupted 占位,自报结局文案这一格接受
现阶段丢失(§13.8 第一类的子形状);**乙(annotate 成为事件产地)登记为 F 线 F2 的
必做项**(full 之下停写后该格永久折不出,不做乙则丙从"偶发丢文案"恶化为"永久丢"),
届时连同 §13.8 "采集点不二次派生"裁定一起重审。

### 15.7 时机改拍:全线直接推(2026-08-25,用户)

用户裁定不等日历浸泡窗口,S3w 各期背靠背推进(§14.6 裁定 4 从推荐 A 改拍 B 的变体)。
落法:**日历门取消,技术门全留** —— 补水形状合同、battery、verify、shadow 短窗判据
一个不少;各期仍按批走(写码 → Fable 审 → haiku 提交),门红即停。两个仍然保留的
检查点:①任何评估都以**重启桌面换上批 P 代码 + shadow-reset 之后**的读数为准(旧进程
的账不算);②S3w-3(切 off 删旧)是烧掉 S2b 回滚读的那一步,开工前单独跟用户确认
一次。风险知情:压缩浸泡期意味着未知真机类的暴露机会变少,靠 refold 自洽环与 verify
全库扫补位。

### 15.8 直通排期(2026-08-25 用户令"全线直接干完";Fable 自动逐批推进)

流水线节奏:opus 写一批 → Fable 审 → haiku 提交 → 立即派下一批;门红即停修。
日期为一路全绿的估计,每次门红顺延。U-a/U-b 按推荐执行(事件词汇同名同形、
renderer 直接 import core reducer)。

| 日期(估) | 批 | 内容 | 用户动作 |
|---|---|---|---|
| 08-25 晚 | 1 | 0b G12 拒写 + S3w-1 补水岔口/合同门/遥测(在途) | — |
| 08-26 | 2 | U0 源头标注+runId 上提+双发(steering 竞态结构性消失) | 落地后**重启桌面 + shadow-reset** |
| 08-26/27 | 3 | S3w-1 翻默认(合同门绿为前提)+ 真机走查 | — |
| 08-27 | 4 | S3w-2:TRANSCRIPT 三态默认 shadow + 写失败上抛 + refold 自洽环 + battery 断言改造 | — |
| 08-27→29 | 短窗 | 真机跑数(refold/shadow 要真数据,≈1–2 天正常使用;期间插批 5) | 正常使用即可 |
| 08-28 | 5 | S3w-4 体积治理(独立,提前插空) | — |
| 08-29/30 | 6 | **S3w-3 切 off + 删旧**(短窗判据绿) | **唯一确认点**:烧 S2b 回滚读前问一次 |
| 08-31→09-04 | 7–11 | F 线:F0 门转向 → F1 同步可见 → F2 命令翻转(3 小批,含 annotate 产地+§13.8 重审)→ F3 回读换语义 → F4 reducer 退役+端口解冻 | F4 端口解冻范围到期拍板 |
| 09-05→09-08 | 12–14 | B 期换管 + U1 renderer fold/影子 + U2 切换删旧(renderer 一次大动) | B 期细案到期过目 |
| ≈ 09-08 | 终 | 全线收口:事件唯一真相、UI 同词汇;refold 常驻唯一耐久门 | — |

不做:U3(可选期,未要);甲(退出等收尾,已裁不做)。

### 15.9 批 1 落地记录:0b 拒写 + S3w-1 补水岔口(2026-08-25,opus 执行,未提交)

**0b(G12 拒写升级)**——`backend/session/event-log.ts`:

- `guardForeignWriter` 从"重装计数器 + warn 后照写"改为**返回布尔的拒写判据**;
  state 新增 `foreignWriter`,判定一次就**一路拒到底**(不再每 500ms 重新 stat,
  也永不翻回去:这个进程已经不是唯一写者,写下去的每一条都是错乱的种子)。
- `appendSessionLogEvent` 命中即 `countSessionEventFailure(...)` + 返回
  `undefined` —— 调用方拿不到 seq,不会有人引用一条根本没写出去的事件。
  **不上抛**(观察期里 messages.jsonl 还在写;命令失败语义留到 S3w-2 随裁定 7)。
- 用例改写(`event-log-s1.test.ts`,临时 store):第二写者追 3 条后,本进程两次
  append 全被拒、盘上只剩对方那 4 条、`appendFailures = 2`、warn 出现一次。

**S3w-1(冷加载补水,默认老路)**:

- **岔口**在 `session-repository.ts` 的 `loadStoredSession`(`getSession` 的取数
  口,`rehydrate` 的**上游**)。新可选端口
  `hydrateMessagesFromProjection(sessionId)`:返回非空就用它顶掉抄本那一格消息
  (**外壳仍来自 meta.json**),整体替换用展开(规则 C:`session.messages = …`
  不许);随后照旧过 `rehydrateSessionFromStorage`(重建 `step.toolCall` /
  `partialResult`)与 `repairOnFirstTouch → sanitizeSessionOnStartup`
  —— **两条路收在同一个出口,一步不减**。
- **档位**在装配层:`backend/session/read-mode.ts` 新增
  `ONETHING_SESSION_HYDRATE = 'messages'(默认)| 'projection'`;实现
  `backend/session/hydrate.ts`(`eventsListMessages` 物化 + 摘掉位置字段 `seq`,
  理由同投影"不产出位置")。产品层仓库只知道"有没有人给我一份消息"。
- **sanitize 的逐项判**:事件侧的 `prepare`(S2a)已经按 `interrupted.ts` 的单一
  口径合成过中断结局,所以 step/toolCall 判死那部分投影天然承担;`isStreaming`
  与会话级时间线元数据(`summaryUpToMessageId`/`contextSize`/`lastInputTokens`)
  仍然只有 sanitize 管 —— 故**两条路都跑**,不给投影开特例。
- **兜底遥测**:`reads.ts` 11 处 `?? getSessionMessages(...)` 统一裹
  `transcriptFallback()`,计进 `session-shadow-stats.json` 的 `fallbackHits`
  (`shadow-report` 打印,不进门)。两条**不计**:`messages` 模式;**抄本也是空的**
  (空会话的例行读 —— 不排除它,battery 上直接计出 820 次噪声,门永远没有判据)。
- **battery 第二泳道**:泳道一写完 → 杀进程 → 换空 LRU 的新进程 +
  `ONETHING_SESSION_HYDRATE=projection` → 在其中 8 条会话上各接一轮。第一次
  `getSession` 就是冷加载(store 从投影物化),那一轮 run 收尾时**既有的影子法官**
  照常比 store vs 投影 —— 补水形状漂一格当场红,不新造判据。另断言历史没缩水。

**合同门(§14.4 的核心验收)**:新脚本 `scripts/session-hydration-contract.ts`
(`bun run sessions:hydration-contract`,**全程只读**),对全量真机会话断言
「投影补水 + rehydrate + sanitize ≡ loadJsonl + rehydrate + sanitize」,判官是
`canonicalChatMessage`(零本地豁免),两侧比前都过 `dehydrateProjectedMessages`
(`sessions:verify` #6 立下的既有归一口径,§13.17 裁定三)。

**真机实跑结果(`~/.onething`,只读)**:436 会话 → **pass 417 / fail 0 /
baseline-skip 9 / no-events 10**。9 条 baseline-skip 全部是 `sessions:verify` 基线
在册的已知残余(`46dcec05` 的 providerCostUSD ×7、`5e4d2cea`/`fe5261d9` 的
usage/steps.type/skillUsed、`fd899977` 与 `a5157107` 的 step.result、`room-1`
投影多 1 条、`web-…` 的 content),**没有一条新类**;10 条 no-events 是产品代码
本来就不补水的会话(agent-exec/dm 等无事件历史)。**混合覆盖(legacy 前缀未迁移)
在真机上一条都没有** —— 这正是翻默认前最担心的那一类。

**门(全部实跑)**:`typecheck` 绿;定向 2577 用例全绿(backend + runtime/sessions
+ core/session);`sessions:shadow-battery` **GREEN**(28 场景 ×7 pass,runs 274 /
mismatches 0 / appendFailures 0,**hydrate lane PASS:8 会话 / 0 新失配行**);
`boundary:gate` / `session:gate` / `log:gate` 全 ok;合同门如上。

**两条留给下一批的诊断(本批不改)**:

1. **`fallbackHits` 有一条结构性地板**:battery 实测命中数恰好 = run 数,产地是
   `wiring/engine/stream/stream-executor.ts:182` —— 它在 `run/start` **之前**读助手
   占位消息(为了把时刻带进 `run/start`),而那条消息此刻在账本里没有产地(翻译器
   故意不翻 `isStreaming` 的 assistant)。它本身是 §14.1 表里的"写侧读抄本",按批 7
   的纪律本该走 `getMessageFromTranscript`(那口不经过 `fromEvents`,也就不算兜底)。
   **要把这个数压到 0,先把这类写侧取材点归位** —— 属 S3w-3 删兜底的前置,不在本批。
2. **`sessions:verify:gate` 真机 1 条新红**:`ec2437ff` 的
   `session/compacted@6068: source-seqs-incomplete`(事件写于 08-25 16:49)。产地是
   **仍在运行的旧桌面**(批 P 未提交、未重启换代码),判据是**批 P 新加的**那条
   `sourceEventSeqs` 只查声明区的校验 —— 与本批零关系(本批不碰写侧、不碰 checker)。
   按 §15.7 检查点①,它的处置要等"重启桌面换上批 P 代码 + shadow-reset"之后再判:
   若换代码后不再新增,则并入基线;若仍新增,则是批 P 遗留的写侧缺口。**本批不动基线。**
