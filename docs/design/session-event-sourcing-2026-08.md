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
