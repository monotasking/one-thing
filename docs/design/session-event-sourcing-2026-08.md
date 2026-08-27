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

> **【已删 —— 2026-08-26 批 6b(§15.22)】本节写于 2026-08-24,画的是"抄本仍在写"
> 那个世界。它作为**勘察记录**原样留着(S3w 的全部裁定都建在这张图上),但下面这
> 张图里的**左半支已经不存在了**:
>
> - `saveSessionToFile → AsyncSaveQueue → hybrid driver 脱水落 messages.jsonl`
>   这一支只剩 `meta.json` 那一格 —— `writeSuffix` / `rewriteAll` / `encodeSuffix`
>   与批 4 装的 `skipMessageWrites` 端口整段删除(批 6a 停写、批 6b 删码)。
>   `events.jsonl` 是会话历史的**唯一持久化**。
> - `appendSessionLogEvent` 那句"失败只计数不抛"也已作废:裁定 7 从"`off` 档的
>   特例"变成**无条件上抛**。
> - 下面那张"写侧回读残留清单"里,`reads.ts` 各 routed 方法的
>   `?? getSessionMessages(...)` 兜底半边**删掉 8 处、保留 3 处**(保留的三处不是
>   抄本兜底,是空会话形状口与能力缺口退路,逐条理由见 §15.22 第二节);
>   `messages.jsonl` 那几处**只读**取材点原样活着(裁定 9a:存量原地只读)。
> - 冷加载补水早在批 3(§15.10)就换成了投影;legacy 整文件会话按裁定 9b 在冷加载
>   那一刻**同步**迁进 `events.jsonl`,不再迁成抄本。
>
> 读这一节时请把它当成"S3w 开工前的现场照片",不是当前状态。当前状态见 §15.22。

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
   推导)。**它不依赖 messages.jsonl 文件** —— store 侧 `listMessagesFromTranscript` 读的
   是内存 store。停写后这道门**照跑不误**,且两侧仍是独立推导(reducer ≠ projection
   reducer)。

   > **方向已翻(F0,2026-08-27,§16.5)**:写这一段的时候 store 是真相 a、活投影是
   > 影子 b,一次不等读成"投影错了"。F0 把角色对调 —— **a = 事件/活投影(真相),
   > b = 内存 store(影子验证器)**,不等默认读成"写模型没跟上账本"。两侧的取数、
   > 判定、记账口径一字未动(比对是对称的),换的只有归因与日志两列的次序;这道门
   > 从此叫**恒等门**,到 F4 reducer 退役时与它一起退役。
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
| **F0 恒等门转向** — **已完成(§16.5,2026-08-27)** | 现 shadow(store=真相 vs 投影=影子)**角色对调**:事件/fold 侧成真相,老 reducer 降级为影子验证器;比对机制、记账口径沿用 session-shadow | 对调后真机 ≥200 run 0 失配 | 对调是比对方向,零行为变化 |
| **F1 写侧同步可见** — **已完成(§16.6,2026-08-27)** | 命令产出的事件先 fold 进活投影(projection-cache 增量 fold 已有)再异步落盘;「命令内读得到自己刚写的」成为纪律,fsync 检查点保留 | 恒等门 + 既有全量测试 | 开关 |
| **F2 命令面翻转(逐条)** — **已完成**:F2-a(§16.7,2026-08-27:appendMessage / deleteMessage / patchMessage)、F2-b(§16.8,2026-08-27:upsertMessage / truncateFrom)、**F2-c(§16.9,2026-08-27:replaceAll / patchSession + 两个非命令采集点搬家 + 翻译器整体退役 + `annotate` 产地)** | 13 条命令分小批改造:命令产出事件 → fold → store 视图从投影物化;翻译器逐命令退役(命令即事件)。顺序:append/delete/patch 类先,upsert/truncateFrom/compact 后(compact 携 §15 批 P 的遮蔽判例作回归)。**必做项(§15.6 裁定):工具自报结局 `annotate` 获得自己的事件产地**(否则停写后该格永久折不出),连同 §13.8 "采集点不二次派生"裁定一起重审 —— **两项都在 F2-c 落地**(新事件 `tool/annotate`;重审结论见 §16.9 第五节) | 每小批:F0 恒等门 0 失配 + battery + 全量 | 逐命令开关或 revert |
| **F3 写侧回读换语义** — **已完成(§16.10,2026-08-27)** | 「写侧读抄本」纪律(§13.18)整体翻面:它的理由(投影滞后)被 F1 消掉了,于是从**一刀切**改成**三类具名例外**(判据同源 / 事件产地缺口 / 只在 store 的运行时形状)。**勘误 §14.1 的"9 处全部改读投影"**:以 HEAD 实况重列后,一半在批 6b 删兜底时就已经在读投影,另一半逐处复核**全部留在 store**、各带具名理由,两类做过反证(②类反证 battery **RED / 305 失配**,①类实测 321 run **0 分岔**)——**代码取数面一处未动**。同批把五口的名字改成说实话的 `*FromStore` / `*InStore`(§16.5/§16.7/§16.8/§16.9 四笔留账一次结清) | 定向用例逐处 + battery | 随 F2 分批走 |
| **F4 reducer 退役** — **F4-a 已完成(§16.12,2026-08-27)**:占位值前递(`addMessage` 交回入库那一条,P0 形状冻结的唯一豁免)+ 两处 store 回读删除(F3 例外表②类摘除)+ 清账(HYDRATE 杆退役 / `clearSessionMessages` 死面删 / `hasSessionInStore` 永久标注)。**F4-b 已勘察,停在诊断(§16.13,2026-08-27)—— 未动一行代码,待用户拍板**:实测「物化视图 ≢ store 消息」(run 收尾逐格对拍 50 条路径分岔,恒等门按 canonical 判据对这 50 条**全盲**),其中四类是消费者真吃的格;而 §14.5 早有裁定「内存/IPC/渲染的双视图**保留**,不在范围内」—— 那正是 store。合一的前提是先推翻或另立那条裁定 | core/session/commands.ts reducer 与 projection/reducer 合一;P0 冻结的引擎 store 端口按新形状解冻重审(单独拍板);F0 影子门退役,refold 自洽环成为终局唯一常驻耐久门 | 全量 + battery + refold 常驻 0 | 本期才删码,revert |

### 16.3 F 线自己的待拍板(到期再拍)

1. **P0 冻结端口解冻范围**:core 引擎注入的 store 端口形状是 P0 明令冻结的,F4 必须
   解冻 —— 解到什么程度(只换实现 vs 换接口形状)到 F4 前拍。
2. **F0 影子验证器的退役条件**:F4 合一后两条推导变一条,「可对账」终结 —— 退役门
   (多少 run / 多久)与 refold 采样率一并拍。
3. **时机**:S3w-3 落地后浸泡多久开 F0。

### 16.4 风险登记(立项即记录)

- **安全网递减是 full 的本质代价**(§14.2 已述,用户知情拍板):F4 之后正确性凭据只剩
  refold(同源两路径),没有独立第二推导。F0–F3 期间恒等门仍在,风险集中在 F4 之后。
  **F0 已上岗(2026-08-27,§16.5)**:恒等门的归因已经翻向事件,F1–F4 每一批的
  "store 侧漂移"都会以 `a`=事件 / `b`=store 的形状记在 `session-shadow.jsonl` 里
  (每行带 `truth:'events'` 方向标记),不必再靠人去反读两列。
- **同步可见 vs 崩溃窗口**:F1 把「fold 先于落盘」钉成纪律后,崩溃时活投影可能领先
  磁盘 —— refold 会把这类窗口暴露为 refold 失配,语义 fsync 检查点是兜底,F1 落地时
  重审检查点位。
  **F1 已重审(2026-08-27,§16.6 第三节),结论修正**:这类窗口 refold **不会**报成
  失配,它按设计 `skipped` —— 守卫是「文件末条 seq == 定格游标」,领先时文件那侧更短,
  游标当场对不齐。这条不是 F1 新引入的:F1 之前活投影也是"读的时候把整条尾巴折进来",
  游标同样等于"已 append 的最后一条"。真正的定性是:**崩溃后重启,活投影从文件重折,
  领先的那一段随进程一起消失 —— 账本仍然自洽**(少一段 ≠ 错一段),而少的那一段的
  上界由语义 fsync 检查点(调模型前 / 调工具前 / 响应收齐 / run 结束)夹住,检查点位
  一处未动。
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
| 08-26/27 | 3 | S3w-1 翻默认(合同门绿为前提)+ 真机走查 — **已完成(§15.10)**,真机走查待用户 | — |
| 08-27 | 4 | S3w-2:TRANSCRIPT 三态默认 shadow + 写失败上抛 + refold 自洽环 + battery 断言改造 — **已完成(§15.11)**,含 §14.7 风险② flush 顺序审计(只出清单,动手归批 6) | — |
| 08-27→29 | 短窗 | 真机跑数(refold/shadow 要真数据,≈1–2 天正常使用;期间插批 5)—— **首杀已修**:refold 门在真机上抓到第一例失配(补水改写活投影),根因/修法/新场景见 §15.13。**第二笔账也来自真机**:refold 首采在 17MB 账本上一口气阻塞主进程 ≈115ms("答完顿一下"),已改协作式分片,连同当晚整轮延迟诊断的归责结论见 §15.14。**第三笔:history 影子 2 条假红**(steering 换锚点的同步点与消费侧之间那一小段窗口),同一个窗口里还藏着一颗压缩重建**真丢一整轮**的雷(今天没撞上),两处已收口,见 §15.15。**第四笔:渲染层"正文看不见"**(真机 9 条历史消息整条回答被卷进折叠区)——**不是数据丢失**,是空轮的渲染锚点被挂到了末尾,批 3 翻默认让"无锚点消息"成为常态点着了这根引信;修 A(锚点按轮次序就位)已落地,修 B 待拍板,见 §15.16 | 正常使用即可 |
| 08-28 | 5 | flush 收口四项(§15.11 清单 a–d,批 6 前置)+ S3w-4 体积治理 — **已完成(§15.12)**;events.jsonl 轮转只出方案未动手(§15.12 B3,待拍板) | — |
| 08-29/30 | 6 | **S3w-3 切 off + 删旧**(短窗判据绿)。**前置已做一半**(§15.18):`fallbackHits` 的结构性地板(§15.9 诊断 1)已归位 —— `stream-executor.ts` 的写侧取材改真相面口,battery 321 → 16;余下 16 条全部是 `agent-loop-executor.ts:249`(steer 换锚点)这同一处孪生,同款一行修法,**留在批 6 里一并收**,收完删兜底的"命中率 = 0"判据才干净 | **唯一确认点**:烧 S2b 回滚读前问一次 —— **用户已确认并预授权跳过浸泡期**(2026-08-26,单用户环境口径) |
| 08-26 | **6a** | **切 off(只翻默认与配套,不删码)** —— `ONETHING_SESSION_TRANSCRIPT` 默认 `shadow → off`(`shadow`/`primary` 降为显式回滚杆);孪生取材点 `rotateAssistantWriterIdentity` 一行修完 `fallbackHits` **16 → 0**;battery 泳道语义对调(停写泳道 → 默认档泳道 + 新增显式 `shadow` 回滚杆泳道,六条泳道);verify #6 改**存量只读对账**;§14.6 第三组裁定按推荐记录 —— **已完成(§15.19)** | — |
| 08-26 | **6a 尾款** | 批 6a 遗下的两条真机存量红收口 —— `source-seqs-incomplete` 读侧收敛到"只对消息节点问责"(`ec2437ff` 自愈)、`Session cleared` 化石进 verify 基线(同一行同时收掉 hydration-contract 的 fail 1);verify:gate **0 new** —— **已完成(§15.21)**。**写侧留一次拍板**:让 `tool/result` 走 `appendSurfaceAwareEvent`(新账完整 + 顺带收编辑重发尾随格),是可感知行为变化,按旧行为停手 | **待拍板**:§15.21 第 1 条写侧 |
| 08-26 | **6b** | **删旧**:storage-driver 消息写半边删(meta/index 保留)、reads 兜底删 8 留 3、sanitize 死码清(`sanitizeSessionsOnStartupWithAdapters` 整体退役)、`session:check` 白名单收一条、裁定 9b(legacy 首触**同步**迁进 events)与 10(`messages.cleared-*` 退役)的实施;两根抄本回滚杆 + `ONETHING_SESSION_READ` 回滚读一起烧掉(写失败上抛因此成为无条件默认),battery 六泳道两探针 → 四泳道一探针,verify 基线摘 13 条已自愈 —— **已完成(§15.22)**,回滚 = `git revert` | ~~待拍板~~ **已拍并落地**:`ONETHING_SESSION_HYDRATE=messages` 那根杆已随 F4-a 退役(§16.11 拍板 5 / §16.12 第三节) |
| 08-31→09-04 | 7–11 | F 线:**F0 门转向(§16.5)/ F1 同步可见(§16.6)/ F2 命令翻转 三小批(§16.7/§16.8/§16.9)/ F3 回读换语义(§16.10)/ F4-a 值前递 + 清账(§16.12)—— 均已完成**;余下 **F4-b**:补流中占位的事件产地(拍板 3)→ reducer 合一 → F0 恒等门退役+端口解冻 | 端口解冻已拍(§16.11 拍板 1 + `addMessage` 唯一豁免);拍板 3/4/5 已拍并落地 |
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

### 15.10 批 3 落地记录:S3w-1 翻默认 —— 冷加载从投影补水(2026-08-25,opus 执行,未提交)

**这一批只翻一个常量,但翻的是 §14.1 点名的那根梁**:产品读路早已全线投影
(S2b),而写模型(内存 store)的**起点**一直还在 `messages.jsonl` 上。批 1 把
岔口和合同门都装好了、默认留在老路;这一批把默认扳过去。

**改动面(4 个文件,零逻辑新增)**:

- `backend/session/read-mode.ts` —— `DEFAULT_SESSION_HYDRATE_MODE`
  `'messages' → 'projection'`。**解析逻辑一个字没改**:两个值本来就都显式认,
  所以 `ONETHING_SESSION_HYDRATE=messages` 原地变成**回滚杆**,语义逐字保留
  (开关注释里改写成这个口径:扳回去 = 冷加载读抄本;抄本在 S3w-2 之前还在写,
  所以回滚零数据损伤、不需要迁移也不需要重放)。
- `backend/session/hydrate.ts` —— 文件头那句"本批不翻默认"换成落地口径。
- `backend/session/__tests__/reads-read-mode.test.ts` —— **语义对调**:原先靠
  "什么都不设"表达 messages 档的那条,改成显式 `setSessionHydrateModeForTesting('messages')`
  并改名为"回滚杆";新增一条**默认即 projection** 的断言。
  这条断言钉的是**常量 `DEFAULT_SESSION_HYDRATE_MODE`**,不是"什么都不设时读到
  什么" —— 后者要去读进程环境变量,于是谁在 shell 里扳过回滚杆这条就红,而那是
  开关在正常工作、不是默认值改了(实测:`ONETHING_SESSION_HYDRATE=messages bun
  vitest` 下最初的写法当场红,遂改)。两档各自的行为仍由三条显式设档的用例担着。
- `scripts/shadow-battery.mjs` —— **补水泳道改成两条**(见下)。

**battery 泳道语义对调**:批 1 的第二泳道是"显式 `projection` 档一条"。默认翻过
之后那个写法会骗人 —— 它验的其实就是默认路,而**回滚杆一条用例都没有**。改成:

- `default (= projection)` —— 不设 `ONETHING_SESSION_HYDRATE`,验产品出厂那条路;
- `legacy rollback (ONETHING_SESSION_HYDRATE=messages)` —— 验**回滚杆本身**:扳回
  老路后冷加载仍要读出完整历史、接着写的那轮仍要 0 失配。
  *没人跑的回滚杆,等到真要回滚那天才发现是坏的。*

三条配套纪律:①两条泳道取样**互不相交**(`exclude` 按 sessionId 去重),否则"是
哪一档漂的"变成一道推理题;②`startServer` 先 `delete env.ONETHING_SESSION_HYDRATE`
再叠 `extraEnv` —— 开发者 shell 里恰好导出过这一格时,"默认档泳道"会被悄悄变成显式
档,而报告照样说自己在验两档;③**`skipped` 也算红**:静默少跑一档 = 门不再看着
回滚杆。判据照旧是既有的影子法官(泳道期间新增失配行 = 0),不新造。

**门(全部实跑)**:

- `bun run typecheck` 绿(node + web)。
- 定向 `packages/backend/session` + `runtime/src/sessions` + `core/session`:
  **45 文件 / 426 用例全绿**;`reads-read-mode.test.ts` 在**两档下各跑一遍**都 18/18。
- `bun run sessions:shadow-battery` **GREEN**:28 场景 ×7 pass,runs 282 /
  historyChecks 393 / mismatches 0 / appendFailures 0 / shadow.jsonl 0 行;
  **两条补水泳道各 8 会话、failed 0、新失配行 0**。
- `boundary:gate` ok(0)、`session:gate` ok(0 新)、`log:gate` ok(4 已知,0 新)。
  本批零 `console.*` 新增。
- **合同门真机重跑**(`~/.onething`,全程只读):436 会话 →
  **pass 417 / fail 0 / baseline-skip 9 / no-events 10**,与批 1 **逐字相同**。
  脚本本就与档位无关(它自己物化两侧,不经 `hydrateSessionMessagesFromProjection`),
  这次重跑要的就是这句"新默认下行为不变"的实证。

**两条读数,原样留给后续批(本批不改)**:

1. `fallbackHits = 282`,恰好 = run 数 —— §15.9 诊断 1 说的那条**结构性地板**
   (`stream-executor.ts` 在 `run/start` 之前读助手占位消息),翻默认后**一格没动**,
   佐证它确实与补水档无关。压到 0 属 S3w-3 删兜底的前置。
2. 全量 `packages/backend`(2344 用例)跑出 1–3 条红,失败集**每轮不同**、单跑全绿,
   且**在回滚档下同样复现**(`ONETHING_SESSION_HYDRATE=messages` 那轮红的是同两条
   `sessions-delete-cascade` / `http.test.ts`)—— 本机高负载抖动,与本批无关。

**留给用户的一件事**:§15.8 表里批 3 的"真机走查"。翻默认之后,桌面重启起来的第一
件事就是从投影冷加载;合同门已经对全量真机会话证过形状等价,走查要看的是**人眼那
一层**(历史渲染、锚点、滚动位置)。

### 15.11 批 4 落地记录:S3w-2 三态开关 + 写失败上抛 + refold 自洽环(2026-08-25,opus 执行,未提交)

按 §14.3 的安全网三件套与 §14.6 裁定 5 / 6 / 7 落地。**机制全装,默认一档不动** ——
`ONETHING_SESSION_TRANSCRIPT` 停在 `shadow`,切 `off` 是批 6(那一步烧掉 S2b 的回滚读,
§15.7 的唯一确认点)。

#### 一、三态开关(裁定 5)

`backend/session/read-mode.ts` 新增第三个开关,与既有两个并排、同款写法(现读环境
变量 + 测试 setter + 三个值都显式认、拼错回默认):

  `ONETHING_SESSION_TRANSCRIPT = primary | shadow(默认)| off`

三档的语义写在开关注释里,这里只记两处**刻意**的取舍:

1. **`primary` 与 `shadow` 的写路径完全相同**。`shadow` 不是新行为,是**正式定性**:
   产品读路(S2b)与冷加载补水(S3w-1)都已全线投影,抄本已经没有任何产品消费者,
   它今天的唯一用处是耐久层对账。`primary` 留着只为记账口径与回滚叙事 —— 哪天要把
   "抄本是真相"这句话重新讲一遍,扳到那一档即可,不必翻代码考古它当年是什么行为。
2. **`off` 只停 jsonl 会话的消息写半边**,`meta.json`(会话外壳 + `log` 索引)照写;
   **legacy 整文件会话不受它管**(那种格式的消息与外壳在同一个文件里,停写等于停掉
   整条会话);**`migrateToJsonlNow` 也不受它管**(那是把既有数据换个格式落地,不是
   写路径,停掉它等于把 legacy 历史丢在 backup 里)。

落点是产品层驱动上的一个可选端口 `HybridSessionStorageDriverOptions.skipMessageWrites?()`
—— 与 S3w-1 的 `hydrateMessagesFromProjection` 同一判例:**产品层只问"这一刻还写不写
消息",不知道有几种档**;判档在装配层(`backend/stores/sessions.ts` 与
`backend/server/runtime.ts` 的 echo/test 仓库,两处都接,少接一处就等于多一条暗路)。
`writeJsonl` 里的岔口是一句前置:停写档走 `writeMetaOnly`(mkdir + writeMeta),
**`states` 行表一个字节不动** —— 于是盘上那份与内存索引始终自洽,分页读那条路仍然
成立,只是从此停在停写那一刻。

#### 二、写失败上抛(裁定 7,生效条件 = `off` 档)

新增 `SessionEventWriteError`(`event-log.ts`)。三个产地、一条纪律:

| 产地 | `primary`/`shadow` | `off` |
|---|---|---|
| G12 拒写(外写者在场) | 计 `appendFailures` + 每会话一次 warn,返回 `undefined`(批 1 的行为) | 同样记账,**再抛** |
| events append 落盘失败 | 计数自吞 | 粘住(`state.writeFailure`),**下一次同步写口抛** |
| blob 写失败 | 计数 + 返回 `undefined`(调用方退回"正文进事件行") | **抛** —— 那条退路(正文还在抄本里)已经不存在(§14.7 风险④) |

**"下一次写口"这个落点是被迫的,也是唯一诚实的**:append 是**排队异步**落盘的,失败
天生晚于调用它的那一句,没有任何同步返回值能当场说出它。于是把失败粘在会话状态上,
`off` 档的下一次 `appendSessionLogEvent` 直接抛。粘上就不翻回去:一段丢掉的事件补不
回来,后面写得再顺也不改变"这份文件缺了一截"这个事实。队列自己的 `.catch` 里**不抛**
—— 那条链没人接,抛出去只会变成一次 unhandledRejection。

**顺带改了一处 S1 纪律**:`event-translator.ts` 的 `safely()` 从前一律自吞(理由是
"翻译坏了不能影响聊天")。`SessionEventWriteError` 说的不是"翻译坏了",是"这条事件
没落进磁盘";停写档下吞掉它等于让一段历史悄悄消失。所以 `safely` 现在**只对这一类、
只在停写档**放行,其余一字不变。这一改也是让上抛真的到得了命令面的那一步:
`sessions.removeMessage` → `sessionCommands.deleteMessage` → 翻译器 → 写口,中间原本
就横着这道 `safely`。

**已知的不完美,原样记下**:上抛发生在 reducer **之后**(store 已经改了、事件没写成),
没有回滚。裁定 7 要的是"调用方能感知",这一条做到了;"写不成就当没发生"要等 F 线的
命令即事件(F2)才谈得上。

#### 三、refold 自洽环(§14.3-B):新模块 `backend/session/refold.ts`

两侧同源(同一份事件)、**路径独立**:`events.jsonl` 的**文件字节**重读 + 全量 fold,
对上**内存活投影**(写入口那条尾巴的增量 fold)。判据是 `canonicalChatMessage`
(单法官,不开豁免)。不等记 `session-shadow.jsonl` 一行 `kind:'refold'`,计数进
`refoldChecks` / `refoldMismatches`。

**挂点选 `runs.ts` 的 `endSessionRun`,紧挨着 `scheduleSessionRunShadow`。理由三条**:

1. **只有这里"文件字节此刻是全的"这个前提成立**。refold 比的是**文件**,而事件是排队
   异步落盘的;`endSessionRun` 的那条 `.then` 链排在 `flushSessionEventLog(sessionId)`
   (队列排空 + fsync,§10.3 ③ 的语义检查点)**之后**。挂在采集点上就是在比一份还没
   写完的文件。
2. **侵入面最小 —— 两行**(一句 import、一句 schedule),缝是现成的:影子已经在这里
   拿到"run 收尾 + 已落盘"这两个条件,refold 要的是同一对条件。备选的
   `session-event-recorder.ts` 收尾处要自己再找一次检查点、自己判 run 归属
   (steering 轮换后 `runId` 与 handle 不是一回事,`endSessionRun` 的归属判据是现成的)。
3. **两道门同缝而不同判据**,读代码的人一眼看得出这是两件事:语义层(store vs 投影)
   与耐久层(文件 vs 内存),各记各的账 —— refold 的不等**不进** `mismatches`,
   `mismatches` 也不进 `refoldMismatches`。

采样:每会话每 `ONETHING_SESSION_REFOLD_EVERY` 个 run 一次(默认 **5**),**首个 run
必采**(计数是进程内的,重启后从 1 重数 —— 而"冷启动后第一个 run"恰恰最值得看一眼,
那一份投影是从文件折出来的)。`ONETHING_SESSION_REFOLD=0` 关掉。

两处**宁可少比一次,不许报一次假红**的守卫:

- **游标对齐**:新增 `liveSessionProjectionCursor()`(projection-cache),文件最后一条
  `seq` ≠ 活投影折到的 seq 就跳过 —— 中间有人又写了一条(或有一条还没落盘)时,比出
  的"多一段/少一段"说明的是采样撞上了写,不是账本坏了。
- **尾巴闸**:活投影靠写入口那条尾巴增量推进,尾巴关着时它会停在第一次折出来的那一刻。
  判据只该有一份,所以由 `event-log.ts` 导出 `sessionEventTailEnabled()` 对外说。

门:`sessions:shadow-report` 打印 `refoldChecks`(不进门,采样数是配置问题)与
`refoldMismatches`(**进门,必须是 0**)。门的口径因此从三条变四条:
`runs ≥ 200 ∧ mismatches = 0 ∧ appendFailures = 0 ∧ refoldMismatches = 0`。

**这道门上线第一天就抓了自己一次(值得记下来)。** 第一版把活投影那一侧的物化排在
`await readFile` **之后**,battery 上 4 跑 1 红(`tool-args-truncated`:A 那条助手消息
`content` 为空、B 有正文)。查下来是**我这边的竞态,不是账本的毛病**:
`reduceSessionProjection` 是移动语义的,而活投影全进程只有一份 —— 读路径的
`eventsListMessages`(battery 的 driver 一直在轮询 `sessions.getMessages`)、影子断言、
下一次采样都会 `getLiveSessionProjection` 把新事件**就地**折进去。于是 `await` 回来
物化到的是一份"比游标多一段"的投影,而文件那边没有。改法:**活投影这一侧连同游标
一起在第一次 await 之前定格**(`canonicalChatMessage` 产出的是全新的朴素对象,快照
一旦取出就不再受就地推进影响);游标对齐检查照旧,只是现在比的是"文件 vs 那一刻的
快照"。回归用例
(`transcript-off.test.ts` 的 *does not cry wolf…*)做过反证:把物化挪回 await 之后,
它当场红。留下的判例一句话:**任何拿活投影去比对的代码,都必须在第一次 await 之前
把它变成快照** —— 一份全进程共用、就地推进的 state,await 之后就不是你借出来的那份了。

#### 四、battery:第四条泳道 + 两枚探针

- **停写泳道**(`runTranscriptOffLane`):`ONETHING_SESSION_TRANSCRIPT=off` 下把**全部
  26 个场景**再跑一遍(**一趟**,不乘 passes —— 这条泳道要的是"每个场景在停写档下都
  走得通",不是再攒一遍 run 数)。判据按 §14.3-C 换口径:场景自证照旧(它们读的是
  `sessions.getMessages`,S2b 之后本来就是投影)+ 这条泳道期间**新增失配行 0**
  (那份文件里现在有 `messages`/`history`/`refold` 三类,一条都不许有)+ 一条只有这条
  泳道有的断言:**`messages.jsonl` 不许长**(每条会话跑完必须仍是 0 字节 / 不存在)。
  放在两条补水泳道**之后**:前面那两条要的正是"抄本还在"的世界,顺序不能反。
- **写失败探针**(`runWriteFailureProbe`,跑两档):把会话的 `events.jsonl` chmod 成
  只读 —— 这是能在真 server 上造出"账本写不进去"的最省事的一刀,而且命中的正是那条
  排队落盘链。观察点选 `sessions.removeMessage`(经命令面 → 翻译器 → 写口,同步,
  不开新一轮执行,一次 RPC 的成败就是答案;`send-message` 会散落在收尾链好几处,
  判据不干净)。断言:`off` 至少一次报错**且错误文本是这件事**(`session event log
  write failed`,免得拿一个 "Message not found" 当绿灯),`shadow` 两次都不报错但
  `appendFailures > 0`(证明这一刀真的咬到了)。**探针跑在各自的临时 store 上** ——
  它故意制造 `appendFailures`,留在主 store 里会让最后那道 shadow-report 以一个假理由
  变红。

一处**实测推翻了预设**:探针最初只认 `rpcCall` 抛出的错(信封 `ok:false`),第一轮判红
"the append failure was swallowed"。真因是 `sessions.removeMessage` 的实现
(`removeOnethingMessageForIpc`)自己 catch 成 `{success:false, error}` —— **那也是
"调用方感知得到"**,只是长相不同。探针改为两种长相都认。

#### 五、§14.7 风险② 的 flush 顺序审计(**本批只审计,不动手**)

结论四条,全部代码实证:

1. **`flushSessionEventLog()` 在三条关停链上一次都没有被调用。** Electron
   `before-quit.ts:106` / `createOnethingBackend.shutdown`(backend.ts:319)/
   `HeadlessBackend.shutdown`(wiring/headless/backend.ts:143)三条都只
   `await flushAllPendingSaves()` —— 那是 `sessionRepository.flushAllPendingSaves()`,
   排的是 **messages.jsonl** 的 300ms 节流写队列。事件账本的每会话写队列与 fsync
   **没有任何关停期的排空点**,今天全靠"语义检查点在跑的时候顺手 flush"。
   `apps/server` 的 SIGTERM 有 5s flush 预算(main.ts:189),调的是
   `runtime.flushAll` → 同一只 repository,同样不含事件队列。
   **停写之后这就是 §14.7 风险②的正面**:退出那一刻队列里还剩什么,就丢什么。
2. **四个语义检查点全是 `void flushSessionEventLog(...)`**(recorder :823/:923/:1046
   + runs.ts:247),fire-and-forget。设计如此(收尾路径不该多一次等待),但代价要写明:
   ①检查点返回时"已落盘"这句话并不成立;②flush 内部的失败没有出口
   (`fsyncSessionLog` 自吞)。裁定 7 的上抛因此**也够不着 flush 这条路** ——
   它的落点只能是下一次同步写口。
3. **`flushSessionEventStats()` 零生产调用点**(只有测试),尽管它自己的注释写着
   "关停调它"。统计表靠 1s 节流 + `unref` 定时器落盘,快速退出丢最后 ≤1s 的计数 ——
   而门读的正是这张表。
4. **§15.6 的退出竞速仍在,且本批新挂的 refold 也在它下游**:`endSessionRun` 与批 9
   取消采集挂在 `completeAgentLoopStream` 的异步收尾链上,而 before-quit 的同步段跑完
   就走人;refold 排在那条链更后面(flush → shadowGate → schedule),退出时同样跑不到。
   这是**采样门在退出路径上静默不采**,不是误报 —— 但它意味着"退出那一刻的账"永远
   不会被 refold 看一眼。

**要动的点清单(批 6 前置,本批一个都不动)**:

- (a) 三条关停链的收尾表里补 `await flushSessionEventLog()`,排在 `flushAllPendingSaves`
  同级或之前;
- (b) 同处补 `flushSessionEventStats()`;
- (c) 四个检查点的 `void` 是否至少在 run/end 那一处改成 `await`(与 (a) 一起拍:
  改了就要接受收尾路径多一次 fsync 等待);
- (d) `apps/server` SIGTERM 的 5s 预算里把事件队列纳入 `flushAll`。

#### 门(全部实跑)

- `bun run typecheck` —— 0。
- 定向 vitest:`packages/backend/session` + `packages/backend/rpc` +
  `packages/backend/server` + `packages/backend/wiring/engine` +
  `packages/onething-runtime/src/sessions` + `packages/core/session` ——
  **108 文件 / 891 用例全绿**(含新增 `transcript-off.test.ts` 11 条与
  `storage-driver.test.ts` 的停写档新用例)。
- `bun run sessions:shadow-battery` —— **GREEN**。26 场景 × 7 passes 全 PASS;
  两条补水泳道各 8 会话 failed 0 / 新失配 0;**停写泳道 26 场景 failed 0 /
  新失配 0 / transcript-grew 0**;两枚写失败探针 PASS。报告:
  runs 320、mismatches 0、appendFailures 0、**refoldChecks 224 / refoldMismatches 0**、
  shadow.jsonl 0 行。
  **上面那条竞态修完之后跑了 11 趟(全矩阵 5 趟 + `--only` 6 趟),0 红**;
  修之前是 4 跑 1 红。(排查中间有一次假红:`--no-build` 跑的是修改前的
  `dist/server/main.js` —— battery 默认每次重建正是为了防这一手,自己却踩了一次。)
- `boundary:gate` ok(0)、`session:gate` ok(0 新)、`log:gate` ok(4 已知,0 新)、
  `transport:gate` ok(42 常量 / 2392 行,不变)。本批零 `console.*` 新增。
- **合同门真机重跑**(`~/.onething`,全程只读):436 会话 →
  **pass 417 / fail 0 / baseline-skip 9 / no-events 10**,与批 1 / 批 3 **逐字相同**,
  无回归。

#### 明确没做的

- **没切 `off`**:默认停在 `shadow`,批 6 才切(§15.7 的唯一确认点)。
- **没动 flush 顺序**:审计结论与清单在上面第五节,动手是批 6 前置。
- **没删任何兜底**:`reads.ts` 的 `?? getSessionMessages` 一处未删(`fallbackHits`
  今天还有结构性地板,见 §15.10 读数 1),`messages.cleared-*` / legacy 按裁定 9/10
  留到 S3w-3。
- **上抛不回滚**:reducer 已改、事件没写成的那一格没有补偿,登记进 F 线 F2。

### 15.12 批 5 落地记录:flush 收口四项 + S3w-4 体积治理(2026-08-25,opus 执行,未提交)

批 4 的 flush 审计(§15.11 第五节)只出了清单,这一批照单施工;S3w-4 按"保守圈定"
落地 —— **只做引用扫描与测量,不做任何自动删除**。

#### 一、flush 收口(§15.11 清单 a–d)

**(a) 三条关停链补事件账本排空。** 新增 `flushAllSessionEventLogs({timeoutMs})`
(`backend/session/event-log.ts`):排空**全部活跃会话**的写队列并 fsync,带
**2s 时限**,超时返回 `{timedOut:true}` 并 warn 一行,**不抛、不阻退出**。它与
既有的 `flushSessionEventLog()`(不传 sessionId)是同一件事,多的只有两样 ——
一个在关停表里说得出用途的名字(`flushAllPendingSaves` 排的是 messages.jsonl 的
300ms 节流队列,两条队列一眼要能分开),和那道时限。

时限是**被迫的,不是保险起见**:Electron 的 `before-quit` 不被 await(第一个
await 之后就在和进程消失赛跑,§15.6),`apps/server` 的 SIGTERM 之后编排器很快
就是 SIGKILL。所以这一步**尊重既有的竞速结构**:不重构退出机制,只在既有
`flushAllPendingSaves` 旁边加一格,而且这一格自己不会把关停钉住。

**(b) 同处补统计表落盘。** `flushSessionEventLedger()` = 排空 + fsync **然后**
`flushSessionEventStats()`,两件事写在一个函数里只为让**顺序**只有一处定义:
排空过程本身会记上 `appendFailures`(队列尾巴那几条正是最容易失败的),统计表
必须排在它之后落盘,否则门读到的是少一截的账。三条关停链各调一次:

| 链 | 落点 |
|---|---|
| Electron `before-quit` | `apps/electron/src/app/before-quit.ts` 新增可选项 `flushSessionEventLedger`,排在 `flushAllPendingSaves` **之后**、`shutdownAppLogging` 之前;各自 try/catch(抄本那一刀失败恰恰是账本最需要落盘的时刻,不能挂在前一步的成功上)。宿主在 `main-process.ts` 注入。 |
| `createOnethingBackend.shutdown` | `backend.ts` 收尾表末尾一行 |
| `HeadlessBackend.shutdown` | `wiring/headless/backend.ts`,同样紧跟 `flushAllPendingSaves` |

**(d) apps/server 的 SIGTERM 预算。** 不新增第二个调用点:标准 server 的
`serverRuntime.shutdown()` → `backend.shutdown()`(`ownsBackend:true`)已经走到
(a) 那一行,而整段 `drained` 本来就罩在 `SHUTDOWN_FLUSH_TIMEOUT_MS`(5s)里 ——
于是事件队列自动进同一预算,外加账本自己那层 2s。`runtime.ts` 的 `shutdown()`
上补了一段注释把这条链写明(**借来的 backend**,即桌面内嵌 HTTP 面
`ownsBackend:false`,这一步是 no-op —— 那份账本归宿主的 before-quit 收)。

**(c) 四个语义检查点里只有 `run/end` 改成可 await。** `endSessionRun` 从
`void` 改为 `async` / 返回 `Promise<void>`,返回的**只是那一次 flush**:

- **刻意不含影子与 refold 那条链** —— `input.shadowGate` 是调用方自己开的闸,
  完全可能永远不 resolve(它自己的注释就这么写),await 它等于把收尾挂死。
  链子照旧 fire-and-forget,只有 flush 被交出去;flush 上挂 `.catch(()=>undefined)`,
  因为它现在有两个消费者,而 flush 的失败不该变成收尾路径上的异常(写失败的
  出口是 `appendFailures` 与裁定 7 的上抛,不是这里)。
- **函数体在第一个 await 之前是同步的**:`run/end` 的落账与 `currentRuns` 的清账
  都在那之前,所以幂等与顺序语义一字未变,不 await 的调用方照旧工作。
- 四个执行器出口改 `await`(`stream-executor.ts` 的 catch + finally、
  `agent-loop-executor.ts` 的 catch + finally);`runs.ts` 内部两个**同步**调用点
  (`beginSessionRun` 收陈旧 run、`rotateSessionRun` 收上一条 run)保持 `void`,
  理由逐条写在调用点上 —— 前者是开执行的同步路径,后者是 steering 的同步点,
  在那里等一次盘 = 每次 steering 加一次盘等待。
- 另三处(recorder :823/:923/:1046)**保持 `void`**,理由写进代码:它们在**流的
  中途**,每回合/每工具各一次,等下去就是把一次盘等待摊进每一轮;而它们最坏丢的
  只是"还没到下一个检查点的那一小段"(队列本身保序)。

**(c) 的延迟实测**(本机 APFS,300 次采样,逐字复刻 flush 的两步 = 排空在途
appendFile + `open('r')`+`sync()`+`close`):

| 文件大小 | p50 | p90 | p99 | max |
|---|---|---|---|---|
| 29KB | 4.60ms | 5.40ms | 6.97ms | 11.56ms |
| 21MB | 4.04ms | 4.92ms | 5.60ms | 6.18ms |

**代价 ≈ 每个 run 多 5ms,且不随账本长大**(fsync 的代价是脏页数,不是文件
大小 —— 大文件那一行反而更稳)。一次执行只发生一次,收尾路径本来就在等更贵的
东西,接受。

#### 二、S3w-4 体积治理(保守圈定)

**B1 blob GC —— 归档,不硬删。** 新增 `backend/session/blob-gc.ts` +
`bun run sessions:blob-gc`(**默认 dry-run**,`--apply` 才动手)。孤儿移进
`sessions/<id>/blobs/orphan/`(还在会话目录里,会话删了它跟着走)。

判据与 `sessions:verify` 的引用完整性检查**同源**:本批把那段递归扫描上移进
core,成为 `collectSessionBlobRefHashes`(`core/session/events/types.ts`,紧挨
`isBlobRef`),`session-verify.ts` 改为 import 它。理由一句话:verify 问"有引用
没文件",GC 问"有文件没引用",两侧是同一张表的两侧,**判据分家迟早会分出一边
删掉另一边认的东西**。

孤儿的唯一来处是"写了 blob 但那条事件没落进去"(队列失败 / G12 拒写 / 进程在
两步之间没了);被 `surfaceOp: replace` 遮蔽的正文**不是**孤儿 —— 引用集按
**全量事件**算(遮蔽只影响模型可见面,不影响账本)。四道跳过闸,每一道拦住的
都是"看着像孤儿其实不是"的一类:

| 闸 | 拦住什么 |
|---|---|
| `no-events` | 没有 `events.jsonl`(legacy 整文件 / 未迁移老会话)——引用集为空,整个 `blobs/` 会被当成孤儿 |
| `malformed-events` | 事件文件有坏行:`parseSessionLogEventLog` 会**静默跳过**那一行(append-only 的读侧纪律),它里面的引用会凭空消失 |
| 年龄(默认 24h) | blob 是**同步**写的,引用它的事件是**排队异步**落盘的 —— 两步之间那个文件在盘上确实"没有引用" |
| `orphan/` 自己 | 扫描只看文件不看子目录,归过档的不会被再数一遍 |

启动后延迟触发**默认关**:`ONETHING_SESSION_BLOB_GC` 未设 / `0` = 不跑,
`dry-run` = 跑但只记账,`1`/`apply` = 真归档;延迟 5 分钟、定时器 `unref`、
disposer 挂在 `backend.shutdown` 上。

**B2 体积测量。** 新增 `bun run sessions:storage-report`(全程只读):每会话
events / blobs(orphan 单列)/ messages / meta / `messages.cleared-*` /
`legacy-backup/` 六格 + 全库合计 + **events÷messages 比值**(§14.6 那句"存储脚本
给出目标值"就是它)。比值只在两份都在的会话上算,覆盖面单列一行 —— 拿一个
覆盖 30% 的比值当全库结论是这类报表最容易犯的错。

**真机只读跑数(`~/.onething`,436 会话,2026-08-25)**:

```
events.jsonl        410.7MB
blobs/                1.0MB   (orphan/ 0B)
messages.jsonl      376.7MB
meta.json             1.5MB
messages.cleared-*   14.3MB   ← §14.6 裁定 10 待拍;今天没有治理器
legacy-backup/      381.4MB   ← S1a 迁移留下的原抄本副本;同样没有治理器
其它                554.8KB
sessions/ 全部        1.16GB
events+blobs ÷ messages = 1.09   (目标 1.10–1.20,426 条两份都在的会话同为 1.09)
```

blob GC dry-run:436 会话 → **扫过 4 条**(422 条根本没有 blobs 目录、10 条没有
事件),**孤儿 0 个 / 0 字节 / 未移动任何文件**,`missing refs` 0。

**这两个数一起说明了本期最该记下的一件事:blob 不是体积问题。** 全库 blob 才
1MB,而两块**没有任何治理器**的存量各是 14MB 与 381MB。真正的比值(1.09)已经
低于 §8 的目标带 —— S3w-3 停写之后 messages.jsonl 那 376.7MB 变成只读存量,
`legacy-backup/` 那 381.4MB 则是它的第二份副本。**"停写省下多少"的账要按这三块
一起算**,而不是只看 events 与 messages 的比。裁定 9a(存量原地只读)与裁定 10
(cleared 存档退役)因此各自对着一块具体的数字,不再是抽象取舍。

#### 三、events.jsonl 的轮转/归档 —— **只出方案要点,本批不写代码(待拍板)**

它是**唯一账本**,而今天全仓每一个读侧(refold 全量重折、`sessions:verify`、
trace 装配、冷加载补水、surface 索引首建)读的都是**整份文件**。任何截断或分卷
都要先回答"读侧怎么把它拼回来",所以这里只立三段要点:

1. **触发条件不该是时间,只能是字节 + 一个语义边界。** 时间轮转会把一次执行
   劈到两个文件里(`run/start` 在旧卷、`run/end` 在新卷),而 `surfaceOp: replace`
   的区间是按 **eventSeq** 的闭区间 —— 跨卷之后遮蔽区间的两端可能不在同一个
   文件里。可行的切点只有**没有活跃 run、且不在任何未闭合遮蔽区间中间**的那一
   刻,配上一个够大的字节阈值(真机今天最大的单份 events.jsonl 才 5MB 级,
   全库 410MB 分在 436 条会话上 —— **这件事今天并不急**)。
2. **归档格式:分卷 + 清单,不是 gzip 覆盖原文件。** `events.<n>.jsonl`(+ 可选
   `.gz`)加一份 `events.index.json` 记每卷的 `[firstSeq, lastSeq]` 与字节数;
   活跃卷永远是未压缩的 `events.jsonl`。这样 seq 仍然是全局单调的(G12 的字节数
   守卫只盯活跃卷),`prepare` 的尾部窗口扫描不必改。gzip 就地压缩会让 append
   与 `expectedBytes` 守卫两条纪律同时失效。
3. **读侧兼容是这件事的全部成本,分三档。** ①**尾部读**(prepare / surface 首建 /
   `findLastSessionEventSync`)只需活跃卷,零改动;②**全量读**(投影 / refold /
   verify / trace)必须按清单顺序拼多卷,`parseSessionLogEventLog` 之上加一个
   "按 index 顺序喂文本"的读取器;③**refold 的判据要重新定义** —— 它今天的前提
   是"文件字节此刻是全的",分卷之后要么每次拼全(代价随卷数长),要么改成
   "只折活跃卷 + 一个已封存卷的投影快照",而后者等于给"事件是唯一真相"引入一份
   派生缓存。**③是真正要拍的那一格**,不是格式问题。

**结论:本批不动。** 数字不支持现在做(单会话 5MB 级),而它要动的是账本自己的
形状与那道常驻耐久门的前提 —— 应当排在 F 线之后、独立立项。

**dumps / 日志侧不碰**:§15.4 已裁定事件账本不塞进日志 janitor,`LOG_DIR_POLICY`
管的那半边一字未动。

#### 门(全部实跑)

- `bun run typecheck` —— 0。
- 定向 vitest:`packages/backend` + `packages/core/session` +
  `packages/onething-runtime/src/sessions` + `apps/electron/src` ——
  **359 文件 / 2979 用例全绿**(含新增 `shutdown-flush-and-blob-gc.test.ts` 10 条
  与 `before-quit.test.ts` 的第 6 条)。
- `bun run sessions:shadow-battery` —— **GREEN**。runs 320 / mismatches 0 /
  appendFailures 0 / refoldChecks 223 / refoldMismatches 0 / shadow.jsonl 0 行;
  四条泳道与两枚写失败探针全 PASS。**(c) 改 await 之后照旧全绿,延迟见上表。**
- `boundary:gate` ok(0)、`session:gate` ok(0 新)、`log:gate` ok(4 已知,0 新)、
  `transport:gate` ok(42 常量 / 2392 行,不变)。本批零 `console.*` 新增
  (两个新脚本在 `scripts/` 白名单内)。
- 真机 dry-run 与体积报表见上,`~/.onething` **全程只读,零字节改动**。

**一处如实记下:`sessions:verify:gate` 在本批开工前就是红的。** 用未改动的
HEAD 版脚本 stash 后重跑,同样红(4 条新 issue:`46dcec05` / `ec2437ff` 各一条
`unclosed-run`,`ec2437ff` 一条 `surface: source-seqs-incomplete` 与一条
messages 不等)。两次跑出来的条数还不一样(4 → 2),因为那两条是**正在被写的
活会话** —— 这是基线记录之后的真机漂移,与本批无关。它归 §13.16 那条"真机暴露"
线,不在本批门内。

#### 明确没做的

- **没切 `off`**:默认仍是 `shadow`,批 6 才切。
- **没有任何自动删除**:GC 只归档、只在显式 `--apply` 下动手,启动触发默认关;
  真机本批只 dry-run 报数。
- **没动 events.jsonl 的形状**:轮转/归档只有上面三段要点,待拍板。
- **`messages.cleared-*` 与 `legacy-backup/` 只测量不治理**:前者归裁定 10,
  后者随裁定 9a 一起看 —— 本批把它们的字节数摆到台面上,治法不擅自替用户拍。

### 15.13 refold 门真机首杀:补水改写了活投影(2026-08-25,opus 执行,未提交)

**门报对了。** 批 4 装上的 refold 自洽环(§14.3-B:`events.jsonl` 的**文件字节**
全量重折 ≡ **内存活投影**)在短窗真机上抓到第一例失配 —— 不是误报,是真的
不变量被打破。文件侧完好(7096 seq 连续、零坏行),被写脏的是**内存里的活投影**。

#### 根因(一条链,五站,四次浅展开 + 一次就地写)

S3w-1 开的补水岔口把**活投影节点的内部引用**一路交到了一个就地写者手里:

1. `core/session/projection/chat-messages.ts` `materializeMessageNode` —— 对
   `message/imported` 节点是**浅展开**(`{...carried}`):`steps` 数组与其中的
   step 对象都是活投影节点**本体**;
2. `backend/session/events-reads.ts` `toChatMessage` —— 浅展开续传;
3. `backend/session/hydrate.ts` `hydrateSessionMessagesFromProjection` —— 摘 `seq`
   那一步又是浅展开,续传;
4. `runtime/src/sessions/session-repository.ts` `loadStoredSession` —— 把它整体
   换进 `stored.messages`,**不 clone**;
5. `runtime/src/sessions/session-dehydrate.ts` `rehydrateSessionFromStorage` ——
   **就地**写:`step.toolCall = linked`(以及终态 step 的 `partialResult` 补算)。

于是活投影的 `message/imported` 节点上永远多出**事件里根本没有的**
`steps[].toolCall`;下一次 refold 一比,文件侧折出来的没有这一格,当场失配。

**只有 imported 节点会中招**:assistant 节点的 steps 是每次物化**现造**的
(`materializeSteps`),写者改的是那份一次性产物,改不着任何人。这也正是前两条
补水泳道(§15.10)漏掉它的原因——它们接的都是本进程自己写出来的会话。

#### 修法(诊断首选,两处代码 + 两道钉子)

- **补水出口 clone**(`backend/session/hydrate.ts`):返回前 `structuredClone`
  整条消息(摘 `seq` 那步不动)。冷加载每会话一次,成本吃得起;**没有**放进
  `toChatMessage`(读路热路径)。
- **纪律入注**(`core/session/projection/chat-messages.ts`
  `materializeMessageNode` 注释头):MessageNode 交出的消息是**活对象**,任何
  就地写者必须先 clone。实现不动 —— 让物化深拷是次选方案,那会把每次读都变成
  一次全树复制。
- **判例引用**:隔壁 `dehydrateProjectedMessages` 早就立过同一条纪律
  ("rehydrate 就地改对象,所以先 `structuredClone` 一份,绝不动调用方
  (投影缓存 / 活投影节点)里的那份")—— S3w-1 开的这条新缝漏了它。同一条纪律
  第二次被漏,说明它只写在**用它的那个函数**头上不够;所以这次同时钉在**产地**
  (`materializeMessageNode`)。

#### 两道新门(都做过反证)

- **单测**(`backend/session/__tests__/reads-read-mode.test.ts`,
  `S3w-1 — projection hydrate never writes back into the live projection`):折一份
  含 `message/imported`(脱水形状:step 只有 `toolCallId`,消息级 `toolCalls` 齐)
  的投影 → `hydrateSessionMessagesFromProjection` → 交给真的
  `rehydrateSessionFromStorage` → 断言活投影里那条
  `MessageNode.message.steps[0].toolCall` **仍然没有**,同时断言写模型手里那一份
  **补上了**(断开的是引用,不是行为)。**反证**:撤掉 clone,这条红。
- **battery 新泳道** `imported-history-cold-hydrate`(`scripts/shadow-battery.mjs`):
  产品自己建会话外壳 → 停机后往账本尾巴补两条迁移形态的 `message/imported`
  (历史只能在停机后补:写侧 surface 与活投影都在内存里)→ 空 LRU 新进程冷加载
  (`ONETHING_SESSION_HYDRATE` 默认投影)→ 接一轮 → run/end **首个 run 必采**的
  refold 必须 match。判据两条:本泳道新增失配行 = 0 **且** `refoldChecks` 真的
  有增量(否则"0 失配"只是没人看)。**反证**:撤掉 clone,该泳道
  `new-mismatch-lines=1`、`refoldMismatches 1`、battery RED。

#### 验收

`typecheck` 0;定向 47 文件 / 450 测试全绿;`sessions:shadow-battery` **GREEN**
(runs 321、mismatches 0、appendFailures 0、refoldChecks 225、refoldMismatches 0,
新泳道 PASS `refold-checks=1`);`boundary:gate` / `session:gate` / `log:gate` 全绿;
零 `console.*` 新增。`~/.onething` 全程只读。

`sessions:hydration-contract` 真机**只读**重跑:436 会话 → **pass 418 / fail 0 /
baseline-skip 8 / no-events 10**。与批 1/3/5 记的 `pass 417 / baseline-skip 9`
差一条,**与本批无关**:那个脚本**不 import** `session/hydrate.ts`(它按同一条链
自己走一遍),clone 一个引用都碰不着它;而且 clone 改的是引用不是值,合同的
判官(`canonicalChatMessage`)比的是值。差的那一条是**真机漂移** —— 一条在册
基线会话上一轮跑数时正被写(§15.12 末尾记的同一种活会话漂移),这轮不再有差异,
于是从 `baseline-skip` 升成 `pass`。

### 15.14 refold 主进程卡顿:一口气 115ms → 协作式分片(2026-08-26,opus 执行,未提交)

短窗跑数期间用户报"答完之后顿一下"。当晚一整轮真机延迟诊断的**归责结论**先摆在
这里,免得下次再从头查一遍:

| 疑犯 | 判决 | 依据 |
|---|---|---|
| 后端推送(coalescer → IPC) | **清白** | 19ms/delta 是**厂商吐字的节奏**,不是我们攒批攒出来的;攒批闸本身 16ms 有序缓冲,量出来没有额外堆积 |
| U0 事件流双发 | **清白**(legacy 档零开销) | 档位在**装配时**读一次(`agent-loop-executor.ts` 的 `isUiEventStreamEnabled()` 三元),口不接上时 `ctx.emitUiEvent?.(…)` 连事件对象都不构造 —— 可选调用短路掉实参求值 |
| grok 的 reasoning 爆发节奏 | **体感主因,但不是回归** | 长思考段一次性涌出,渲染侧一帧要吃一大块;这是模型侧的吐字形状,与本线改动无关 |
| **refold 首采** | **真凶,已修(本节)** | run 收尾后的 `setTimeout(0)` 宏任务里一口气跑 ≈115ms 同步代码 |

**顺带记一条有意为之、别当 bug 修的东西**:`backend/wiring/engine/stream/agent-loop-executor.ts:815`
的 `onResponseBoundary`(→ `rotateAssistantWriterIdentity`)**不受 UI 事件流的档位闸
控**,与它同一个对象字面量里的 `emitUiEvent` 才在闸后面。这是对的:runId/锚点上提
解决的是**账本正确性**(§10.15 那条竞态 —— 新响应的开头被记在旧消息上),不是 UI
特性;关掉 UI 事件流不该把账本改回错的那一版。

#### 病灶

`checkSessionRefold` 的 `await readFile` 之后是**一整块同步代码**:整份日志 parse →
全量 fold → 重折侧物化 → 逐字段深比。真机那本 17.1MB / 7915 行的账本上实测
(bun,只读):

```
parse 34.2ms + fold 16.8ms + 重折侧物化 30.8ms + deepEqual 10.8ms = 93ms 一口气
另加 await 之前的活投影侧定格 21.8ms(同步,见下)= 单次 refold ≈115ms
```

> **勘误**:诊断稿里那句"deepEqual 56.6ms / 合计 164ms"高估了。那一格当时是用
> `JSON.stringify(a) === JSON.stringify(b)` 近似量的,而生产的 `deepEqual` 是结构化
> 短路比较,真值 ≈10.8ms。真凶的量级(百毫秒级、一口气、run 收尾时)不变。

触发:每会话第 1、6、11… 个 run(`DEFAULT_REFOLD_EVERY=5`,**首个 run 必采**)。
所以"每次答完都可能顿一下"里的**首答必顿**,正是它。

#### 修法:协作式切片,不是 worker

`worker_threads` 被否:`dist/server` 是 `inlineDynamicImports` 的单文件包,装不下
第二个入口脚本(CLAUDE.md 的单文件/TDZ 判例),而 refold 要用的正是 core 那一整套
投影函数。

改成**把那一整块切开**(新文件 `packages/backend/session/refold-slices.ts`):四个
分片函数 + 一个分片闸,每跑够**半帧(8ms)**就 `setImmediate` 让出一次事件环。
`setImmediate` 而不是 `queueMicrotask` —— 微任务仍在同一个宏任务里排队,让出去的
还是自己(与 `shadow.ts` 选 `setTimeout(0)` 同一个理由)。

| 段 | 分片粒度 | 与原写法的等价关系 |
|---|---|---|
| `parseSessionLogEventLogSliced` | 每行 | ≡ `parseSessionLogEventLog`:同一份行切分(`indexOf` 逐段扫,省掉一次 17MB 的整体 `split`,段集合一模一样)、同一个稳定排序 |
| `foldSessionProjectionSliced` | 每事件 | ≡ 顺序 `reduceSessionProjection` 全折(折的是私有 state,让出期间谁也碰不到) |
| `canonicalProjectionMessagesSliced` | 每节点 | ≡ `visible.map(canonical∘materialize)`,同一份物化选项 |
| `deepEqualPairsSliced` | 每对消息 | ≡ `deepEqual(a,b)`(两侧都是数组时),首个不等即短路进 diff 汇总 |

**每一步问一次表,不隔 N 次问**:问表是一次 `Date.now()`(几十纳秒),7915 行的账本
上总共不到 0.3ms。第一版隔 64 次问一次,在真机另一本 **50MB 却只有 258 行**的账本
(单行 200KB)上一片塞进 64 个 200KB 的 `JSON.parse` —— 29.2ms 破帧。改成每步问一次
之后同一本账 9.2ms。

**诚实交代一条地板**:"逐条"是这个粒度的底。单条 200KB 级的巨行 / 巨消息本身就是
一步,再往下切得改 `JSON.parse` / `deepEqual` 本身。真机三本账上没踩到(最长单步
远小于半帧),记在这里等哪天真有一条 MB 级消息时不用重新查。

#### 唯一**不**分片的那一格:活投影侧定格(≈22ms)

让出事件环 = 一次 `await`,而批 4 早就用一次 battery 红换来了那条纪律:活投影
**必须在第一次 await 之前取成快照**(`reduceSessionProjection` 是移动语义的,全进程
共用一份;await 期间任何消费者把新事件折进去,回来物化到的就是"比游标多一段"的
投影 → 假红)。所以这 22ms 是这道门里唯一无法避免的连续阻塞,**正确性优先,明账
收着**。

#### 游标守卫:不加新机制,加一段注释

分片期间账本可能又被写,但这次比对的两侧此刻**都已与外界脱钩** —— 活投影侧是定格
出来的朴素对象,文件侧从 `readFile` 返回起就只是一个字符串。所以守卫仍然只有原来
那一道(**文件末条 seq == 定格游标**,parse 之后立刻问一次);分片完再问一遍没有
意义,两个被比较的量一个都没变。这道理写进了 `refold.ts` 的头注释,免得后人以为
"分片了就得补一道新守卫"。

#### 门

- **合同断言**(新增 `backend/session/__tests__/refold-slices.test.ts`,9 例):同一份
  输入,原写法 vs 分片写法 `toEqual`。预算一律传 `0`(每一步都让出),把分片点踩满。
  覆盖难看日志(空行 / 乱序 seq / 同 seq 重复行 / 未来类型 / 坏包封 / 末尾半行 /
  末行无 `\n`)、空文件、500 行、fold、物化、逐对深比与短路。外加一条**行为**断言:
  同步版跑完期间"别人的宏任务"一次都插不进来,分片版必须插得进来。
- **真机只读实测**(探针 `scratchpad/refold-slice-probe.ts`,跑的是**生产同一份**
  分片代码 + 同一个闸,只在外面套秒表):

| 账本 | 修前一口气 | 修后墙钟 | 片数 | **最长连续阻塞** | 结果 |
|---|---|---|---|---|---|
| 17.1MB / 7915 行(诊断那本) | 93ms | 84ms | 12 | **8.4ms** ✅ | parse/canonical 逐字节相同,判定同为 match |
| 50.4MB / 258 行(单行 200KB) | 68ms | 78ms | 12 | **9.2ms** ✅ | 同上 |
| 25.2MB | 36ms | 35ms | 7 | **11.7ms** ✅ | 同上 |

  总耗时基本持平(让出往返的开销落在噪声里),**最长一次连续阻塞全部 ≤16ms**。

#### 验收

`typecheck` 0;定向 `packages/backend/session` 22 文件 / 214 测试全绿;
`sessions:shadow-battery` **GREEN**(runs 321、mismatches 0、appendFailures 0、
**refoldChecks 225、refoldMismatches 0** —— 分片后的这条路在 225 次真采样上判定不变);
`boundary:gate` / `session:gate` / `log:gate` 全绿;零 `console.*` 新增。
`~/.onething` 全程只读。

### 15.15 steer 换锚点窗口:history 影子的两条假红 + 压缩重建的真雷(2026-08-26,opus 执行,未提交)

真机 `session-shadow.jsonl` 上两条 `kind:'history'` 的失配(展开是 24 条 vs 4 条、
两侧差一整轮的那种形状)。查下来两条同源,而**同一个窗口里还坐着一颗今天没撞上
的真雷** —— 那颗才是这一批的重点:假红只是账记歪,真雷是**发给模型的请求真的少
了一轮**。

#### 一、窗口是怎么来的(U0 的结构性遗留)

U0(§10.15)把换锚点劈成两半:

- **同步的那一半** `rotateAssistantWriterIdentity`(`agent-loop-executor.ts`):
  agent-loop 发 `response-boundary` 的那一刻**同步**跑完 —— 建新助手消息、
  `rotateSessionRun` 把旧 run 收掉、新号盖回消息、`state.recordingAssistantMessageId`
  改成新号;
- **异步的那一半** `createNextAssistantWriter` → `finishCurrentAssistantWriter`:
  必须排在上一条消息 `processor.finalize()` 之后,而那是个 `await`,所以留在
  **chunk 消费侧**,由 `turn-start` 那一格触发
  (`createNewAssistantOnNextTurnStart`,core `applyAgentLoopTurnStartWithAdapters`)。

于是从 boundary 到消费侧接手之间有一段窗口。窗口里 store 的样子是:**新消息已经
建好、旧 run 已经收掉,而上一条 assistant 还挂着 `isStreaming: true`**。

#### 二、假红:窗口里比历史,真相侧自己少一轮

历史影子挂在 `onRequestRecipe`(`history-shadow.ts` ← `session-event-recorder.ts`
写 `request/recipe` 的那一刻,也就是"发出去之前"),它从 store **现算**
`buildHistoryMessages`。而 `core/engine/history.ts` 的 :753 / :812 两处都有
`if (message.isStreaming) continue` —— 窗口里那条上一轮的 assistant 被**整条**滤掉。
投影侧不认 `isStreaming`(它是 `run/start`…`run/end` 之间的派生态,
`event-translator.ts` 的 `DERIVED_KEYS` 里),照常产出那一轮。两侧差一整轮,
**而投影没错**。

messages 类断言早就有同判例的闸:`EndSessionRunInput.shadowGate`
(`session/runs.ts`,`rotateAssistantWriterIdentity` 建闸、消费侧接手与执行 finally
开闸),走的是"**等一下再比**"。history 类没有这道闸 —— 这就是缺口。

**修法**:`checkSessionHistoryShadowForRequest` 加第三个参数
`{ pendingAssistantRotation }`,由执行器现读 `state.pendingAssistantRotation` 交进来;
非空就**这一次不比**,记一笔 `skipped['history-steer-window']`
(`session/shadow.ts` 的 `countSessionShadowSkip`,与 `legacyPartial` 同一张表)。
历史断言是**每次请求**跑的,"等一下"等于把这一次请求的口径挪到别的时刻,所以这边
取跳过而不是等待 —— 两道闸的判例互相在注释里指认。跳过既不进 `mismatches` 也不进
`historyChecks`(这一次请求根本没比),`sessions:shadow-report` 的 `skipped` 行照打。

#### 三、真雷:压缩重建落在同一个窗口里,模型**真的**看不到上一轮

`beforeTurn` 里判成 `finalPlan.kind === 'rebuild'`
(`core/engine/agent-loop-runtime.ts`:1109)时,`rebuildAgentMessagesFromSession`
(`runtime/src/agent-loop/stream-runtime.ts`)会**从 store 重新拼一遍历史**交给模型。
它走的是同一个 `buildHistoryMessages` —— 落在窗口里就是**真丢一整轮**,不是账记歪。

而且它不是概率竞态,是**确定的顺序**:`afterTurn` 那一处 boundary
(`core/agent-loop/runner.ts`:836)发完就 `continue`,下一轮的 `beforeTurn`(压缩重建
就在这里)**排在消费侧那一格 `turn-start` 之前**。只要那一轮判成 rebuild,读到的
就必然是没收尾的 store。

**修法(顺序修正,不是新语义)**:执行器新增
`settlePendingAssistantWriterBeforeStoreRead` —— **只把收尾那一半提前跑掉**
(`finalize()` + `isStreaming:false` 广播 + 开影子闸),`pendingAssistantRotation`
原样留着、`finished` 打上标记;换身份那一半仍然由消费侧在原来那一格接手,
`createNextAssistantWriter` 见 `finished` 就不再收第二遍。这样"两次 boundary 挤在
一个 `turn-start` 前面折叠成一条新消息"(`rotateAssistantWriterIdentity` 的早退)
这条既有语义**一字未动**。

接线是一个可选口 `beforeRebuildMessages`,顺着现成的
`BuildAgentLoopStreamRuntimeOptions`(执行器 `prepareRuntime` 已经在用它传 emitter)
下到产品层的 host adapters,在 `rebuildAgentMessagesFromSession` **读 store 之前**
`await` 一次。**core 里没有加任何特判**;不接这个口 = 直接读,行为逐字不变。

此刻队列里不会有还没消费的正文 chunk:boundary 是同步推进队列的
(`bridge.ts` 的 `AgentEventQueue` 无背压),而 `beforeTurn` 的第一个 `await` 就已经
把消费侧放过去了 —— 提前的只是"什么时候写 `isStreaming:false`",不是"写进去的是
什么"。

#### 四、改了什么

| 文件 | 改动 |
|---|---|
| `backend/session/shadow.ts` | `SessionShadowSkipReason` 类型化 + 导出 `countSessionShadowSkip`(关闸时连账都不记) |
| `backend/wiring/engine/stream/history-shadow.ts` | 第三参 `pendingAssistantRotation` → 跳过 + 记账;窗口成因与 `shadowGate` 判例写在头注释 |
| `backend/wiring/engine/stream/agent-loop-executor.ts` | `pendingAssistantRotation.finished` 一格;新增 `settlePendingAssistantWriterBeforeStoreRead`;`createNextAssistantWriter` 认这个标记;`prepareRuntime` 接上 `beforeRebuildMessages`;`onRequestRecipe` 交出窗口态 |
| `backend/wiring/engine/stream/agent-loop-runtime.ts` | `BuildAgentLoopStreamRuntimeOptions.beforeRebuildMessages` → host adapters |
| `runtime/src/agent-loop/stream-runtime.ts` | 两个 adapters 接口各加一格可选口;`rebuildAgentMessagesFromSession` 读 store 前 `await` 一次 |

#### 五、反证(修前真的丢、修后真的不丢)

`runtime/src/agent-loop/__tests__/rebuild-steer-window.test.ts` —— 走**真的**
`buildOnethingAgentLoopStreamRuntime` + **真的** `buildOnethingHistoryMessages`
(`isStreaming` 整条跳过就发生在它里面),store 摆成窗口里的样子
(`u1` / `a1{isStreaming:true}` / `u2`),`beforeTurn` 判成 rebuild:

- **不接 `beforeRebuildMessages`(= 修前)**:重建出来的历史里两条 user 都在
  (证明重建确实跑了、确实读到了 store),**唯独 `a1` 的正文不在** —— 一整轮丢了;
- **接上(= 修后)**:`a1` 的正文回到历史里。

`backend/wiring/engine/stream/__tests__/history-shadow-steer-window.test.ts` ——
窗口里跳过且 `skipped['history-steer-window'] === 1`、`historyChecks === 0`;
窗口外照常走比对、不记这笔账。

#### 六、验收

`bun run typecheck` 0;定向 `packages/backend/wiring/engine` + `packages/backend/session`
+ `packages/onething-runtime/src/agent-loop` 127 文件 / 1249 测试全绿,
`packages/core/{engine,agent-loop,session}` 21 文件 / 261 测试全绿;
`sessions:shadow-battery` **GREEN**(runs 321、historyChecks 448、mismatches 0、
appendFailures 0、refoldMismatches 0、`skipped {}` —— 新闸在电池里一次都没触发,
即**零行为变化**:电池的假提供者跑得太快,消费侧从不落后,那个窗口只在真机上张开);
`boundary:gate` / `session:gate` / `log:gate` 全绿;零 `console.*` 新增。
`~/.onething` 全程只读 —— 真机 stats 里那 2 条 `mismatches` 不清不改,下次
`sessions:shadow-reset` 自然归零。

### 15.16 渲染层"正文看不见":空轮锚点挂尾 → 整条回答被卷进折叠区(2026-08-26,opus 执行,未提交)

真机会话 `e0267646-3dc5-4315-a0bf-2cba1bf8701b` 上,`seq2`–`seq18` 共 **9 条** assistant
消息在界面上"只剩一个折叠头,回答正文不见了"。

#### 一、现象定性:不是数据丢失,与 edit-resend 无关

先把最容易误判的两条排掉:

- **盘上正文完好**。这 9 条在 `messages.jsonl` 里的 `content` 字段一字不少
  (1.1KB–3.7KB 各不等),`contentParts` 里的 `text` 段也在。丢的不是数据,是
  **渲染时的组/尾分界**把整条正文划进了折叠区;
- **与 edit-resend 无关**。曾怀疑是编辑重发截断了消息 —— 不是。这些消息没有被重发过,
  形状是正常收尾的多轮回合,问题出在**加载路径合成渲染锚点**的那一步。

也就是说:这是一条纯渲染层的账,事件日志/投影/持久化三层都没有出错。

#### 二、根因链(三段,缺一不成灾)

**第一段 —— 空轮是常态,不是例外。**
`packages/core/engine/agent-loop-executor.ts:1441-1447`:`turnIndex === 1` 且此刻还没有
正文时,这一段 reasoning 走 `'top'` 落到 `message.reasoning`,**不进 `contentParts`**。
于是"第 1 轮有工具、却没有任何内容 part"是每一条多轮消息的固定形状;中间轮只调工具
不作叙述时同理。真机三条的实测形状:

| 消息 | `contentParts` 的轮次 | `steps` 覆盖的轮次 | 空轮 |
|---|---|---|---|
| seq2 | reasoning 2–14 + text 14 | 1–13 | 1 |
| seq4 | reasoning 2,3,4,5,7,8,9,10,11 + text 11 | 1–10 | 1、6 |
| seq6 | reasoning 2–36,38–48 + text 48 | 1–47 | 1、37 |

**第二段 —— 兜底把空轮的锚点挂到了末尾。**
`packages/renderer/stores/helpers/content-parts.ts` 的 `insertDataStepsByTurn`:锚点原本
"跟在同轮内容 part 之后"插入,找不到同轮内容 part 的轮次走兜底 —— 旧写法是**一律 push
到 parts 末尾**。空轮既然是常态,兜底就成了主路:seq4 合成出来的锚点顺序是
`[2,3,4,5,7,8,9,10, 1, 6]` —— 轮 1 和轮 6 这两个孤儿排在**最终正文之后**。

**第三段 —— 分界被孤儿锚点推到末位。**
`packages/renderer/stores/helpers/work-group.ts:100-144`:`lastProcessIndex` 是"最后一条
属于过程的 entry",工作组 = `[0, lastProcessIndex]`、尾巴 = 其后。孤儿 `data-steps` 有真
step 可渲染,于是它把 `lastProcessIndex` 顶到了数组末位 → `tailEntries` 空 → **整条正文
落进 work group**。而 ProcessRail 对历史消息默认收起、收起时不挂载内容 —— 用户看到的
就是"回答没了"。

#### 三、引信:批 3 翻默认(S3w-1)

第二段这个 bug 一直在,但此前没有引信:S2b 之前冷加载读的是 `messages.jsonl` 抄本,
盘上带着流式期写下的 `data-steps`/`tool-call` 锚点,`synthesizeToolAnchors` 见到已有锚点
直接 no-op,兜底路径根本走不到。批 3(§15.10)把冷加载翻成**从投影补水**之后,投影按
canonical G4 **故意不产出渲染锚点**(锚点是渲染侧派生物,不进事件、不进投影),于是
"无锚点消息"成为常态,S3w-0 的锚点自合成成为唯一路 —— 兜底路径从此每条消息都走一遍,
空轮的孤儿锚点就此显形。真机 9 条中招,`seq20` 之后的消息因为是新写的、盘上仍带锚点
而幸免(`seq22`–`seq32` 的 `contentParts` 里 `data-steps` 齐全)。

#### 四、修 A(已落地):锚点按轮次序就位,不再挂尾

`insertDataStepsByTurn` 的兜底改为**按轮次序就位插入**:轮次 `t` 的锚点插在
**第一个轮次大于 `t` 的 part 之前**;只有 `t` 确实大于所有 part 的轮次(末轮工具之后
再无内容)时才允许挂尾。seq2 修后的形状是 `[data-steps:1, reasoning:2, data-steps:2, …,
reasoning:14, text:14]` —— 孤儿回到队首,`lastProcessIndex` 停在 `reasoning:14`,
`tailEntries = [text]`,正文回到全音量区。

一句话口径:**锚点的位置由轮次序决定,末尾只留给真正在最后的那一轮。**

钉死用的 fixture:`packages/renderer/stores/__tests__/rebuild-content-parts.test.ts` 里
新增 `synthesizeToolAnchors × 真机 fixture(e0267646 seq2/seq4/seq6)` —— 正文脱敏成占位串,
轮次结构逐格保真(轮 1 空轮 / 中间空轮 / 每轮多工具 / 末轮只有正文),四条断言:
锚点覆盖且升序、空轮锚点排在第一个更大轮次的 part 之前、最终正文在所有锚点之后、
`tailEntries` 恰为那条 text。`work-group.test.ts` 另加一条纯函数用例,把"锚点排正文前 →
正文进 tail / 锚点挂正文后 → 正文被卷进组"两种分界同时钉住。**反证**:撤掉修 A 后
这 4 条定向用例必红(seq4 的锚点顺序当场退回 `[2,3,4,5,7,8,9,10,1,6]`)。

#### 五、修 B(待用户拍板,本批未动)

第三段还缺一层保底:`work-group` 的分界今天完全由锚点位置决定,**没有"最后一段正文
永远留在 tail"的硬保底**,ProcessRail 收起时也不挂载被卷进去的内容。任何一个新的锚点
错位都会以同样的方式复现"正文看不见"。要不要加这层保底(以及收起时是否仍渲染正文)
是**用户可感知的行为变化**,按裁定不自行拍 —— 列在这里等确认,本工单不动。

#### 六、修 C(只记档,不动手)

批 3 的补水路径在把投影结果写回 `messages.jsonl` 抄本时,用的是**投影形状**,而投影
不带渲染锚点 —— 于是补水会把盘上原有的 `data-steps` 锚点一并抹掉(真机上 `seq2`–`seq18`
盘上锚点已经没了,正是这一步的痕迹)。这不是新引入的第二个 bug 面:S3w-3 切 `off`
之后抄本停写,这条口径**自然消亡**,专门去修反而给一个即将退役的路径加代码。
故只记档,不动手。

#### 七、验收

`bun run typecheck` 0;定向 `packages/renderer` 的 `rebuild-content-parts` /
`stores/work-group` / `components/chat/message/work-group` 三个文件 40 测试全绿;
`bun run ui:gate` 不新增(本批零 `.vue`/CSS 改动)。按工单未跑全量(另一会话在途的
renderer 布局改动会干扰)。`~/.onething` 全程只读(fixture 是读出来后脱敏重写的形状,
不是拷贝真实内容)。


### 15.17 修 B 裁定(2026-08-26,用户):不做,先观察

work-group 分界的"正文永不进折叠区"硬保底(§15.16 修 B)用户裁定**暂不加**,只靠
修 A(锚点就位插入,3e6de773)+ 三条真机 fixture 观察。若锚点错位类再次出现同样的
"正文被吞"形状,再回来拍 b1/b2。

### 15.18 批 6 前置:写侧读抄本的 `fallbackHits` 地板归位(2026-08-26,opus 执行,未提交)

**病灶**(§15.9 诊断 1 已点名):`fallbackHits` 恒等于 run 数,不是"投影折不出会话
历史"这件坏事,而是**一处写侧取材点走错了口**。`wiring/engine/stream/
stream-executor.ts` 的 `executeMessageStream` 在写 `run/start` **之前**要读一次助手
占位消息(把它的时刻/agentId/source/origin 带进 `run/start`),而这条 assistant 此刻
在事件账本里还没有产地 —— 翻译器故意不翻 `isStreaming` 的 assistant,`run/start`
才是它的那一格。于是走 routed 的 `sessionReads.getMessage` 时 `fromEvents` 恒折不出,
每个 run 必然掉进 `?? getSessionMessages` 兜底、计一次 `fallbackHits`。

**修法**(一行 + 一段注释,行为逐字等价):改走真相面
`sessionReads.getMessageFromTranscript`。这不是换个名字图省事,是把这处取材点归到
§14.1「写侧回读残留」表 + 批 7 纪律(§13.18 发现 B)该在的位置上:**事件写侧的取材
恒读抄本,永不随 `ONETHING_SESSION_READ` 分岔**。取到的消息与从前逐字相同 —— 兜底
半边读的就是同一个 `getSessionMessages(sessionId)` —— 只是不再经过"投影折不出 →
兜底"这条路径、不再计数。S3w-3 删兜底前那个"命中率必须量成 0"因此才可能成立。

**读数**(`sessions:shadow-battery`,同一台机器前后两跑):

| | runs | fallbackHits | mismatches / appendFailures / refoldMismatch |
|---|---|---|---|
| 修前 | 321 | **321**(= run 数,§15.9 说的结构性地板) | 0 / 0 / 0 |
| 修后 | 321 | **16** | 0 / 0 / 0 |

**余下 16 条,全部同一处,已用堆栈实证**(临时在 `countSessionReadFallback` 里打栈
跑一次 battery,读完即删,未入库):

```
countSessionReadFallback ← transcriptFallback ← sessionReads.getMessage
  ← rotateAssistantWriterIdentity (agent-loop-executor.ts:249)
  ← createNextAssistantWriter ← applyAgentLoopTurnStartWithAdapters
```

**它是 stream-executor:182 在 steer 那条路上的孪生**:`rotateAssistantWriterIdentity`
刚 `store.addMessage` 出一条新的 assistant 占位(为读回 `stampCollabAgentId` 盖上的
`agentId`/`source`),紧接着就要用它去 `rotateSessionRun` —— 也就是说,**这次读的
产物正是它自己那一格 `run/start`**,读的时候账本里当然还没有。同一病灶、同一修法
(改 `getMessageFromTranscript`),16 = battery 里 steering 场景的换锚点次数。

**本批不动它**(用户令:核对与列清单,不扩大改动面),留给批 6 一并收:改完
`fallbackHits` 应当到 0,S3w-3 的删兜底判据届时才是干净的。

**§14.1 表其余各行的核对结论**(逐条看过,无第三处):

- `commands.ts:209/275/291`、`event-translator.ts:220`、`agent-loop-executor.ts:525/
  567/617` —— 已经是 `*FromTranscript`,不经过 `fromEvents`,**不计**。
- `agent-loop-executor.ts:762`(resume 占位)、`tool-orchestrator.ts:120`、
  `tool-execution.ts:126`、`agent-loop-executor.ts:874`、`agent-loop-runtime.ts:207/269`、
  `stream-engine-runtime.ts:68/70`、`context-compact.ts:90/304`、
  `triggers/session-toc.ts:44/122` —— 这些读都发生在 `run/start` **之后**,那条
  assistant 在投影里已经有产地,`fromEvents` 折得出,battery 实测零命中。它们仍是
  §14.1 表意义上的"写侧回读"(F3 期要换语义),但**不构成 `fallbackHits` 地板**。
- `rpc/domains/sessions.ts:173/188`、`server/runtime.ts`、`stores/sessions.ts` ——
  产品读路/杂用,本就该走 routed 口,不在本批口径内。

**验收**(全部实跑):`bun run typecheck` 0;定向
`vitest run packages/backend/wiring/engine packages/backend/session` 84 文件 / 667 用例
全绿;`sessions:shadow-battery` GREEN(runs 321、mismatches 0、appendFailures 0、
refoldMismatch 0、fallbackHits 16);`boundary:gate` / `session:gate` / `log:gate` 全绿。

### 15.19 批 6a 落地记录:S3w-3 切 off —— 抄本停写成为默认(2026-08-26,opus 执行,未提交)

**这一批把 `messages.jsonl` 从磁盘上抹掉了 —— 对新写入而言。** `events.jsonl` 从此
是会话历史的**唯一持久化**。批 4 (§15.11) 装好的三态开关默认停在 `shadow`,这一批
把默认扳到 `off`;和批 3 (§15.10) 翻补水默认一样,**主体只是一个常量**,配套才是
工作量。

**本批只翻默认与配套,不删码** —— 删 storage-driver 的消息写半边、删 reads 兜底、
清 sanitize 死码、收缩 `session:check` 白名单是**批 6b**。理由是回滚成本:只要写
代码还在,回滚就是扳一根环境变量;删了之后回滚只能 `git revert`。

#### 一、用户裁定(2026-08-26)

- **§15.8 表里批 6 的"唯一确认点"**(烧掉 `ONETHING_SESSION_READ=messages` 这条
  S2b 回滚船)—— 用户确认烧。
- **§14.6 裁定 5 的观察期阈值(≥2 周真机 ∧ ≥200 run)—— 用户按 §15.8 的单用户
  环境口径预授权跳过**。判据里可自证的那几项(shadow=0 ∧ refold=0 ∧
  appendFailures=0 ∧ verify 全库 0 新红 ∧ battery 全泳道 GREEN)照旧要真跑,跳掉的
  只是"墙上的两周"。
- **§14.6 第三组(S3w-3 开工前拍)按推荐记录**:
  - **裁定 8(steps/toolCalls 双存)= 认**。磁盘双存随停写免费消失;内存/IPC/渲染
    的双视图**长期保留**,形状收敛另立门户或接受为长期形态 —— 两边都有硬吃者
    (history builder / StepsPanel / collab / resume-history / evals),收敛 = 渲染层
    + history 大改而存储收益为零。
  - **裁定 9a(`messages.jsonl` 存量)= 永久原地只读**。零风险零迁移;归档只省目录
    整洁,却要多开一次批量搬文件的风险窗口。本批的 verify #6 改造就是这条裁定的
    落法(见下)。
  - **裁定 9b(legacy 整文件会话 `sessions/<id>.json`)= 首触迁移进 events**。
    reads 兜底半边要把命中率量成 0 才能删,永久保留兜底 = 那批代码永远删不掉。
    **实施在批 6b**(它属于"删旧"的前置)。
  - **裁定 10(`messages.cleared-*` 存档)= 退役**。`session/cleared` 只遮蔽不删,
    事件本身就是档;保留等于给"事件是唯一真相"开第一个例外。**实施在批 6b。**

#### 二、默认翻转(`backend/session/read-mode.ts`)

`DEFAULT_SESSION_TRANSCRIPT_MODE` `'shadow' → 'off'`。**解析逻辑一个字没改**:三个
值本来就都显式认,所以 `shadow` / `primary` 原地变成**显式回滚杆**,语义逐字保留。
注释按回滚语义重写,并写清两件容易想当然的事:

- 扳回 `shadow` = 让抄本**重新长出来**,写失败也随之退回"只计数不打扰"。但切 off
  之后新会话没有抄本存量,**扳回来只能从那一刻起攒新的对账料**,不会凭空补出旧抄本
  ——"零数据损伤"指的是事件账本没被动过,不是"抄本原地复活"。
- **批 6b 删掉写代码之后,这两根杆随之退役**,届时回滚 = `git revert`;这句话写在
  开关注释里,免得半年后有人扳一根已经不接线的杆。

连带口径:**写失败上抛(裁定 7)从"某一档的特例"变成了默认行为** —— 唯一账本写不
进去不再是可吞的旁路故障。

**测试语义对调**(`__tests__/transcript-off.test.ts`,照批 3 的判例):

- 默认那条断言**钉常量 `DEFAULT_SESSION_TRANSCRIPT_MODE`**,不钉"什么都不设时读到
  什么" —— 后者要去读进程环境变量,于是谁在 shell 里扳过回滚杆这条就红,而那是
  开关在正常工作、不是默认值改了(§15.10 实测过的坑)。
- 新增一条"`shadow` / `primary` 是回滚杆"的显式用例;拼错那条改成回到**新**默认。
- 四条写失败用例里"观察期"那一半**显式扳到 `shadow`** —— 它现在是回滚杆,不再是
  "什么都不设"的那一档。同理 `event-log-s1.test.ts` 整个文件问的是 S1a 的**降级**
  纪律(写失败只计数、G12 拒写不打扰调用方),`beforeEach` 里显式扳回 `shadow`;
  升级语义有它自己的用例,两套判据不该互相盖住。

#### 三、孪生取材点一行修(§15.18 留下的那一处)

`wiring/engine/stream/agent-loop-executor.ts` 的 `rotateAssistantWriterIdentity`:
`sessionReads.getMessage` → `getMessageFromTranscript`。与 §15.18 改
`stream-executor.ts:194` **同一病灶、同一修法、行为逐字等价**:它刚 `store.addMessage`
出一条新的 assistant 占位(为读回 `stampCollabAgentId` 盖上的 `agentId`/`source`),
紧接着要用它去 `rotateSessionRun` —— 这次读的产物**正是它自己那一格 `run/start`**,
读的时候账本里当然还没有,于是走 routed 口时 `fromEvents` 恒折不出、每次换锚点必掉
一次兜底。

`reads.ts` 的遥测注释同步更新:两处写侧取材点都已归位,**`fallbackHits` 的结构性
地板清零**,S3w-3 删兜底的判据("命中率量成 0")从此是干净的 —— 再有非零读数就
真的是"事件里折不出这段历史"。

#### 四、battery 泳道语义对调(`scripts/shadow-battery.mjs`,四条 → 六条)

`off` 成默认之后,原来那条显式设 `ONETHING_SESSION_TRANSCRIPT=off` 的"停写泳道"
会骗人 —— 它验的其实就是默认路,而**抄本回滚杆一条用例都没有**。与批 3 补水泳道
一模一样的处置(§15.10 判例),`runTranscriptOffLane` 泛化成 `runTranscriptLane`:

- **`default (= off)`** —— 不设 `ONETHING_SESSION_TRANSCRIPT`,验产品出厂那条路;
  断言 `messages.jsonl` **不许长**;
- **`shadow rollback (ONETHING_SESSION_TRANSCRIPT=shadow)`** —— 验回滚杆本身;
  断言 `messages.jsonl` **必须长出来**(否则"扳回去了"只是句口号)。

**顺序反了过来**,而且这是本批唯一有结构性后果的一处:补水回滚杆泳道
(`ONETHING_SESSION_HYDRATE=messages`)要的是一批**带抄本**的会话,而默认档跑出来
的会话已经没有 `messages.jsonl` 了。所以抄本泳道排在补水泳道**之前**,并且补水回滚
杆的取材池换成 `shadow` 泳道跑出来的那批(全仓唯一还有抄本的会话),同时把
`ONETHING_SESSION_TRANSCRIPT=shadow` 一起扳过去 —— 真要回滚补水,抄本当然也得继续
写,否则接下来那一轮就再也补不回来了。从前的顺序理由("停写泳道放最后,前面的泳道
要'抄本还在'的世界")在默认翻转之后自动失效。

三条配套纪律照批 3 的判例逐条落:①**取样互不相交** —— 两条补水泳道现在连取材池都
不同源,`laneTaken` 留着把这件事钉住;②**env 先清再叠** —— `startServer` 现在
`delete env.ONETHING_SESSION_TRANSCRIPT` 之后才叠 `extraEnv`(从前只清了
`ONETHING_SESSION_HYDRATE`),免得开发者 shell 里恰好导出过这一格,把"默认档泳道"
悄悄变成显式档而报告照样说自己在验两档;③**`skipped` 也算红**,并且"两条泳道没都
跑到"(`transcriptLanes.length !== 2`)直接判红,不再是静默少看一格。

两枚**写失败上抛探针照跑**,一格没改:`off` 那枚现在验的是**默认行为**(命令报错),
`shadow` 那枚验的是回滚杆连同它的旧语义(只计数)一起回来了。

#### 五、verify #6 改「存量只读对账」(`scripts/session-verify.ts`)

裁定 9a("存量永久原地只读")的落法。切 off 之后抄本**停在原地**而 `events.jsonl`
继续独走,老口径("投影里抄本不认识的消息 = 红")会对每一条切档后还在用的会话恒红。
新判据按**抄本实际的末条**截断:

- 投影里落在抄本覆盖区**之内**、抄本却不认识的消息 —— 仍然是洞,照旧红;
- 抄本末条**之后**的那一段 —— events 独走的新历史,计数进 `coverage` 那行
  (`N beyond the transcript (events-only, S3w-3)`),**不进门**;
- 新会话根本没有 `messages.jsonl` —— 老代码本来就 `if (transcript && …)` 跳过,
  不算异常,只把这句写进文档口径。

**基线一字不动**:`sessions:verify:gate` 按整行匹配,所以那条 `projection has N
message(s) unknown to messages.jsonl` 的文案**故意保持逐字不变**(改字面量 = 把两条
已知残余"治愈"掉再以新面孔重新出现)。`coverage` 那行对既有会话逐字等价
(`beyondTranscript = 0` 时新旧算式恒等)。

用例侧:原来那条"抄本讲了另一个故事"改成**洞在覆盖区之内**(抄本漏了中间那条),
新增两条 —— 独走的尾巴不算错(且必须出现在 `coverage` 里,否则这条放行是静默的)、
停写后新建的无抄本会话不算错。

#### 四之二、跑验收时抓到的两条真 bug(都由本批开出,都在本批收口)

**① 迁移之后 `load()` 交空壳 —— 不是每只仓库都装了投影补水。**
第一版实现是"迁完 `loadJsonl()` 再读回来",于是 `load()` 交出去的是 `meta.json` 那层
外壳,消息要靠装配层的 `hydrateMessagesFromProjection` 才填得回来。桌面 / 真 server /
CLI 三条路都装了那个口,**但 server 的 echo/test 仓库没装** ——
`packages/backend/server/__tests__/http.test.ts` 的 "uses the onething desktop app state
and chat sessions by default"(它铺的正是一条 legacy 整文件会话)当场红。
改法:`load()` **仍然交出手里读到的那一份**(带消息)——那正是迁移的输入,与迁完
再折出来的投影逐条同源。迁移是为了让**下一次**冷加载能从事件里折出它,不是为了让
**这一次**读不到。同时给 `createLocalServerSessionStore`(echo/test 那只仓库)补上
补水口,与 app store 那只同一句 —— 少接一处就等于多一条暗路;只在
`resolvedStorePath === getOnethingStorePath()` 时接(补水口读的是**进程级** store 路径,
开在别处时接了会去读另一个 store 的账本,那比读空还坏)。

**② 分页口对"没有抄本的会话"答了一个理直气壮的空页。**
顺着 ① 查下去发现的更深一层,而且**与 legacy 无关 —— 它对每一条批 6a 之后出生的
会话都成立**:驱动的 `getMessagesPage` / `getUserMessageMarkers` 从前问的是
`jsonlExists()`("是不是 jsonl 布局"),那时候一条 jsonl 会话必然带着
`messages.jsonl`;停写之后不再必然。而 `loadJsonl` 会给这种会话存下一份
`lines: []` 的行表,于是分页从"给不出"(`undefined`,调用方降级)变成
**`success:true, totalCount:0`** —— 把调用方整条降级链短路掉。真机上这条错答被
`sessionReads.pageMessages` 的事件侧挡在前面,所以没爆;echo/test 仓库没有事件侧,
一读就是空。改法:判据换成 `hasTranscript()`(盘上真的有 `messages.jsonl` 吗),
冷热两态都验(用例先冷问一遍、再 `load()` 焐热后问第二遍 —— 病灶正是热态)。

#### 五之二、`sessions:hydration-contract` 的口径补齐(**本批唯一的门口径改动**)

跑验收时这道门报 **fail 2**,逐条查完两条**都不是本批的锅**,但其中一条揭出一个
真问题:

1. **`7f0ab096`(projection 330 / transcript 296)** —— 抄本自批 6a 停写之后冻在
   296 条,而这条会话一直在用,事件涨到了 330。合同问的是"投影 ≡ 抄本",**在停写
   之后这句话只在抄本还认识的那一段上成立**;不设边界的话这道门会在每一条还在用的
   会话上恒红,而且一天比一天多 —— 那不是合同破了,是合同问错了。
   §15.19 批 6a 已经给**兄弟门** `session-verify.ts` #6 立过"存量只读对账"的口径
   (按抄本末条截断:之前是洞,之后是独走段),当时**漏了这一道**。本批把同一段
   逻辑逐字搬过来:`lastCoveredIndex` 之后的只计数进 `beyond-transcript(events-only)`
   类目、只打印;条数改成只比覆盖段。**这不是新裁定,是把已有裁定应用到第二个消费者。**
2. **`room-1`(projection 1 / transcript 0)** —— 这是我摘基线摘出来的:那一行在
   `verify` 上确实已自愈(#6 有截断),而 `hydration-contract` 读的是**同一份基线**
   却没有截断,于是摘掉行 = 取消豁免 = 露出老问题。截断补齐之后它自然回到 pass
   (抄本 0 条 → 覆盖段为空),不必把行加回去。

补齐后:**443 会话 / 0 failed / 8 baseline-skip**。

#### 六、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | **绿**(node + web) |
| 定向 `packages/backend/session` + `wiring/engine` + `wiring/permission` + `stores` + `runtime/src/sessions` | **119 文件 / 908 用例**,红 1 = `sessions-delete-cascade`(§15.10 记过的同一只本机高负载抖动,单跑 3/3 绿) |
| `bun run sessions:shadow-battery` | **GREEN** —— **27** 场景(含 §15.20 新增的 `abort-while-awaiting-permission`)×7,runs 368 / historyChecks 512 / mismatches 0 / appendFailures 0 / refoldChecks 260 / refoldMismatch 0 / shadow.jsonl 0 行;**六条泳道全 PASS**;两枚写失败探针 PASS |
| **`fallbackHits`** | **16 → 0**(§15.18 留下的孪生点收完;结构性地板清零) |
| `boundary:gate` / `session:gate` / `log:gate` | **全绿**(0 / 0 新 / 4 已知 0 新) |
| `bun run sessions:hydration-contract`(真机 `~/.onething`,全程只读) | 441 会话:**pass 422 / fail 1 / baseline-skip 8 / no-events 10**。批 3 那次是 436 会话 fail 0 —— 多出来的 5 条与那 1 条 fail **都是这两天真机新写的**,fail 的成因与本批无关(诊断见下) |
| `bun scripts/session-verify.ts --all` / `sessions:verify:gate`(真机全库,只读) | **2 NEW**(诊断见下);13 healed,其中 **2 条正是 verify #6 新口径故意放行的那个形状**(`9c94531d` 与 `room-1` 的 `projection has 1 message(s) unknown to messages.jsonl`;`room-1` 现在整条 `ok`)。**基线一字未动** |

**battery 六条泳道逐条**:

```
per scenario            26/26 PASS
transcript lanes        PASS  default (= off)                      scenarios=26 wrong=0
                        PASS  shadow rollback (=shadow)            scenarios=26 wrong=0
hydrate lanes           PASS  default (= projection)               sessions=8
                        PASS  legacy rollback (HYDRATE=messages)   sessions=8
imported-history        PASS  new-mismatch-lines=0 refold-checks=1
write-failure probes    PASS  off=命令报错   PASS  shadow=只计数
```

#### 七、**门红:两条真机新红,与本批无关 —— 停在诊断**

`sessions:verify:gate` **FAILED: 2 NEW issue(s) vs baseline**。两条都在**今天(08-26)
才写过**的会话上,而且**在 HEAD 版本的 `session-verify.ts` 下同样复现**(用
`git stash push -- scripts/session-verify.ts` 把本批的改动摘掉重跑,两条一字不变)——
所以既不是本批弄出来的,也没有被本批的新口径掩盖:

1. **`ef079fd7` `messages: canonical differs for message 55a915aa`** ——
   **新失配类:`rejectionReason: 'Session cleared'` 只有投影侧有**。
   同一件事在三个地方各留了一份证据:
   - 真机 `session-shadow-stats.json`:`mismatches: 4`(`byKind: {messages: 1,
     history: 3}`),**全部出自这一条会话、这一个工具调用**,时间戳都在今天 17:03–17:09;
   - `session-shadow.jsonl` 的 `messages` 那行diff 是
     `1.steps.1.rejectionReason` / `1.steps.1.toolCall.rejectionReason` /
     `1.toolCalls.1.rejectionReason`,三处一律 **a=`(absent)` / b=`Session cleared`**;
   - 账本里 `permission/answered` 带 `approved:false, reason:"Session cleared"`
     (seq 3865),投影 reducer 把它盖到了 step/toolCall 上,而 store 的写侧
     reducer 在这条**自动否决**路径(会话被清空/中止导致的拒批,不是用户点"拒绝")
     上没有盖 `rejectionReason`。三条 `history` 失配是同一格在模型历史里的回声
     (`276.content.1.result` 的 1012 vs 1048 字节)。
   - `hydration-contract` 的那唯一 1 条 fail(`steps.1.rejectionReason`)是同一格。
   **这是一个真正的写侧/读侧不对称,而且方向是"投影更全"**;它属于 §15.8 短窗
   要抓的那类未知真机类(第五笔)。
   **→ 已在 `dc810f4f` 修掉**(§15.20):`'Session cleared'` 是拆除现场留给等待方
   的一句内部话,不是判决理由;事件侧才是说错的那一侧。修在**单一构造点**
   (`core/permission/index.ts` 的 `settlePendingReject` 加 `SettleKind`)。
   **`ef079fd7` 那条会话的账本存量修不掉**(事件已经落盘),所以它在
   `sessions:verify:gate` 上作为**已知 legacy 残余**继续红,与 §15.3 P-a 的
   grok 成本残余同一口径 —— 要么进基线,要么留着当"这一天发生过什么"的化石。
2. **`ec2437ff` `surface: session/compacted@6068: source-seqs-incomplete`** ——
   verify 检查 #2(`foldSurface` 的 replace 校验),与抄本、与本批的任何一处改动
   都不沾边;会话最后写于今天 00:36。**根因已定位**(只读实算,未动手):
   那次压缩 `surfaceOp {op:'replace', start:2, end:5518}` 遮掉 surface 上 75 格,
   `sourceEventSeqs` 声明了 173 个 seq —— 全部存在于文件里,但**遮掉的 75 格里恰好
   有 1 格没被声明:`seq 4243`,一条 `message/deleted`**。写侧
   (`event-translator.ts` 的 `sessionCompacted`)是按"被压掉的那些**消息**"凑
   `sourceEventSeqs` 的,而 `message/deleted` 是 surface 上的一格却不是一条消息,
   于是永远进不了那张清单;读侧的完整性检查(`surface.ts:158` `shadowCompact`
   —— 从第一个被声明的 seq 起,后面每一格都必须被声明)当场报缺。
   **不是行为漂移**:`shadowCompact` 用 `order.slice(0, to+1)` 遮蔽,整段照样遮全,
   模型历史没有多看或少看 —— 这是一条**记账完整性**的抱怨。
   它与 §15.3 P-b 是同一张表的两侧(P-b 修的是"非节点 seq 进了 order",这条是
   "节点没进声明"),修法应当同源:要么写侧把 `message/deleted` 一并计入,要么
   读侧口径改成"只校验消息节点"。**须拍板,不在本批范围。**

**处置**:第 1 条的**成因**已由 `dc810f4f` 修掉(§15.20),新写入不再产生这一格;
留在盘上的那一条是**存量化石**,改不掉也不该回填(G3:事件只追加)。第 2 条
(`ec2437ff` 的 `source-seqs-incomplete`)仍未诊断,与抄本、与本批任何一处改动都
不沾边 —— 单独立条。

> **勘误(§15.21,08-26)**:上面第 2 条里"遮掉 75 格 / 差的那 1 格是
> `seq 4243` 一条 `message/deleted`"**点错了**。只读实算的真相是:遮蔽 **257 格**、
> 声明 **173 个**、差的 **84 格全是 `tool/result`**(`message/deleted` 根本不是
> surface 节点类型,永远不会进 `removed`)。类别判断没错(差的都是"占一格却不代表
> 一条消息"的格),但产地是 `tool/result` 的两个写入点绕开了活 surface 索引 ——
> 全部改正见 §15.21。两条红都已在那一批收口。

**回滚成本**:本批一行写代码都没删,回滚 = 把 `DEFAULT_SESSION_TRANSCRIPT_MODE`
改回 `'shadow'`(或设 `ONETHING_SESSION_TRANSCRIPT=shadow`),抄本立刻重新开始写。

### 15.20 拆除口径修复:`settlePendingReject` 不向账本报内部场景理由(2026-08-26,`dc810f4f`)

> 本节由 `docs/design/s3w-batch-notes-2026-08-26.md` 并入(该文件随并入删除)。
> 修本身已提交为 `dc810f4f`;battery 新场景 `abort-while-awaiting-permission`
> 因 `scripts/shadow-battery.mjs` 当时属批 6a 在途文件,随批 6a 一起落(见 §15.19)。

#### 现象

`~/.onething/log/session-shadow.jsonl` 恰好 4 行,全出自会话
`ef079fd7-d6ca-42a4-887b-499767593b7a`(2026-08-26 17:03–17:09 本地时间):

| # | 时刻(UTC) | kind | runId | 差异 |
| --- | --- | --- | --- | --- |
| 0 | 09:03:27.937 | messages | 3b4733dd | `1.steps.1.rejectionReason` / `1.steps.1.toolCall.rejectionReason` / `1.toolCalls.1.rejectionReason`,抄本侧 `(absent)`,投影侧 `"Session cleared"` |
| 1 | 09:03:31.373 | history | 1c25d390 | `276.content.1.result`,1012 → 1048 字符 |
| 2 | 09:06:42.089 | history | 2b6c7aac | 同上 |
| 3 | 09:09:01.257 | history | fe36f8ee | 同上 |

**四条是同一个根因**,不是两类:messages 那条是投影在消息上多写了一格
`rejectionReason`;history 那三条是同一格顺着 `failureResultForAI` 流进模型历史。

#### 字段级定位

那 36 个字符就是 `,"rejectionReason":"Session cleared"`(1 + 17 + 1 + 17 = 36),
插在 `toolFailureResultForAI`(`packages/core/tools/tool-result.ts:176`)的键序里
`parameters` 与 `status` 之间。真机数据实算复核:抄本侧 1012、投影侧 1048,delta 恰 36。

涉事调用 `call_01_ET_P8C7TyUxm0MWaXuQ6P9R9393`(bash,那条 `echo "=== jira cli? ==="`)。

**抄本侧**(`messages.jsonl`,那次调用的全部字段):

```
{"id":"call_01_ET_…","toolId":"bash","toolName":"bash","status":"cancelled",
 "timestamp":…,"receivedAt":…,"argsFinalizedBy":"parse","startTime":…,
 "endTime":…,"error":"User cancelled"}
```

没有 `rejected`,没有 `rejectionReason` —— 收尾修复(`sessions/stream-abort.ts`)
写的就是 `{status:'cancelled', error:'User cancelled'}` 那两格。

**事件侧**(`events.jsonl`,seq 3863–3869,时刻线一秒之内):

```
3863 tool/call          bash
3864 permission/asked   requestId ab1324cd  toolCallId call_01_…
3865 permission/answered approved:false  reason:"Session cleared"   ← 说谎的那一条
3866 tool/audit          outcome:"aborted"          ← 账本自己已经说对了
3868 tool/result         cancelled:true  resultPreview:""
3869 run/end             outcome:"aborted"
```

投影按 G6(`packages/core/session/projection/reducer.ts:691` `permission/answered`)
把 `reason` 接成 `tool.rejectionReason`,再由 `materializeToolCall`(reducer.ts:1227)/
`materializeStep`(reducer.ts:1308)落到消息上,最后由 `toolFailureResultForAI`
带进模型历史。

#### 构造点

- 抄本侧:`packages/onething-runtime/src/sessions/stream-abort.ts` —— abort 收尾把
  未结束的调用判死成 `{status:'cancelled', error:'User cancelled'}`。
- 事件侧:`packages/core/permission/index.ts` `clearSession()` →
  `settlePendingReject` → `emitSettled(entry,'rejected',{reason})` →
  `Permission.Recorder.onAnswered` → `packages/backend/session/permission-events.ts:41`
  写 `permission/answered {approved:false, reason}`。
- 触发链:用户按停止 → `CoreStreamEngine.abort()`(core-stream-engine.ts:484)
  最后一行 `onSessionCleared()` → `clearPermissionSession` 端口
  (`backend/wiring/engine/stream-engine-runtime.ts:142`)→
  `Permission.clearSession` + `Interaction.clearSession`。

#### 归责

**双侧独立构造的字面分歧**,且**事件侧是说错的那一侧** —— 不是采集缺口。

判据是账本自己给的:同一次调用的 `tool/audit` 写的是 `outcome:"aborted"`,既没有
`decision:"deny"` 也没有 `asked:true`;而**真正被人拒**的两次(seq 3370 / 3512)
写的是 `{decision:"deny", asked:true, outcome:"denied"}`,抄本侧同时有 `rejected:true`
+ `rejectionReason`,两侧一致、影子无失配。

也就是说:`Permission.clearSession` 的 `'Session cleared'` 是**拆除现场留给等待方
的一句内部话**,不是判决理由 —— 会话根本没被清,是流被 abort 了。把它记成
"被拒,理由 X" 之后,投影会凭空给模型多看一句 `rejectionReason: "Session cleared"`。

#### 修复(单一构造点)

`packages/core/permission/index.ts`:给 `settlePendingReject` 加一个显式的收场
**方式** `SettleKind = 'answer' | 'teardown'`;`clearSession` 走 `'teardown'`。

- `teardown` 那一支**不向账本旁听席报理由** —— 因为没人答过。
- 等待方拿到的 `RejectedError`(`message` 与 `reason` 都含 `'Session cleared'`)
  **一个字节没变**,总线事件 `permission:settled` 本来就不带理由,也没变。
- 事件仍然照记 `permission/answered {approved:false}`:投影靠它清
  `awaitingPermission`(A12),丢了会造出新的失配。
- 没有在 canonical 加豁免,没有回填历史,没有改 reducer。

`packages/core/session/trace/assemble.ts:591` 早就是 `reason !== undefined` 条件
展开,拆除路少一格 `reason` 不影响轨迹面。

#### 反证

`packages/backend/wiring/permission/__tests__/permission.test.ts` 新增两只:

1. `records a teardown without a rejection reason (the awaiting side still gets one)`
   —— 拆除路:等待方仍 `err.reason === 'Session cleared'`、`err.message` 仍含那句话,
   而旁听席只收到 `{approved:false}`。**回退 `'teardown'` 实参后此只必红**,实测:
   `expected [{approved:false, reason:"Session cleared"}] to deeply equal [{approved:false}]`。
2. `still records the reason when a human actually rejected` —— 防过度修复:
   真人 `respond({response:'reject', rejectReason})` 那一支照旧带理由。

**battery 场景 `abort-while-awaiting-permission`**(随批 6a 落,场景数 26 → 27):
审批挂起 → 不答 → `command:abort`,断言账本上该 callId 的 `permission/answered` 是
`{approved:false}` 且**无 `reason`**、`tool/audit.outcome === 'aborted'` 且非
`decision:'deny'`,那一轮两侧仍逐字相等(影子不长新行)。反向那半边由既有的
`permission-denied` 守着,不重复造。

**这条场景的反证已实跑**(把 `permission/index.ts:630` 的 `'teardown'` 实参临时改回
`'answer'`,跑完即 `git checkout` 还原):

```
FAIL  abort-while-awaiting-permission ok=0 failed=1 mismatch-lines=1
      the teardown reported a rejection reason to the ledger: "Session cleared"
[shadow] GATE RED: mismatches 3 ≠ 0
```

—— 两层独立判红:场景自己的断言,以及**影子法官各自记下 3 条失配**(默认档泳道 1 +
shadow 回滚杆泳道 1 + 主矩阵 1)。也就是说这条场景端到端复现的就是真机那一类,
不是只钉住了一句 assert。

#### 验收(`dc810f4f` 自己那一批)

| 门 | 结果 |
| --- | --- |
| `bun run typecheck` | 0 |
| 定向(permission / shadow / event-log / event-translator-write-side-read / trace / projection-contract / stream-abort) | 9 文件 159 只全绿 |
| `boundary:gate` / `session:gate` / `log:gate` | ok / 0 新 / 4 已知 0 新 |
| `sessions:shadow-battery` | 当时未跑(`shadow-battery.mjs` 属批 6a 在途文件),随批 6a 统一跑 —— 结果见 §15.19 |

#### 一处未解、不影响根因的观察

同一格失配在真机上只被记了 3 个 run(1c25d390 / 2b6c7aac / fe36f8ee),per-run 去重
(`backend/session/shadow.ts` `rememberMismatch`)另折了 10 条重复;但 09:12 之后的
5 个 run(277ae232 / 7d62998d / f0a08e3e / 1bab5390 / 1c884683)**不再失配**,而那条
消息在这 5 个 run 的每一次 `request/recipe` 里都还在(`hasMsg276=true`,全程无
`session/compacted`)。events.jsonl 里在 09:09–09:12 之间没有任何触碰该 callId /
该消息的事件。

统计口径:`session-shadow-stats.json` 记 `mismatches:4`(`byKind` messages 1 /
history 3)、`duplicateMismatches:10`、`skipped:{history-steer-window:4}`、
`fallbackHits:79`(≈ runs 78 —— 正是 §15.18/§15.19 收掉的那块结构性地板)。
怀疑与 `getLiveSessionProjection` 的活投影生命周期或 `buildBudgetedToolResultContent`
(history.ts:323,per-result 200k / total 600k 字符预算)在长历史下的落点有关,
但没有直接证据 —— 记在这里,不当作根因的一部分。**全量重放这段事件是确定性的:
那格 `rejectionReason` 必然出现**,反证单测即按这条时刻线复现。

### 15.21 批 6a 尾款:两条真机存量红收口(2026-08-26,opus 执行,未提交)

批 6a 结束时 `sessions:verify:gate` 上还剩两条真机红(§15.19 末段)。这一小批只做
它们的收口,不碰任何写侧行为。

#### 1. `ec2437ff` `surface: session/compacted@6068: source-seqs-incomplete`

**§15.19 的根因描述有一处点错了,实算更正**(只读实算那份 events.jsonl):
遮蔽的是 **257 格**(不是 75),声明了 **173 个**,差的 **84 格全部是 `tool/result`**
——**没有一条 `message/deleted`**(`message/deleted` 压根不是 surface 节点类型,
它带 replace op 但自己不占格,永远不会出现在 `removed` 里)。

但**类别的判断是对的**:差掉的那些格都是"**在 surface 上占一格、却不代表一条
消息**"的格(`surfaceMessageIdOf` 认不出它们)。真正的产地是另一处:

- `tool/result` 是 `SESSION_SURFACE_NODE_TYPES` 里的节点,但它的两个产地
  (`backend/wiring/engine/stream/session-event-recorder.ts:984` / `:1119`)走的是
  `appendSessionLogEvent`,**不是** `appendSurfaceAwareEvent` —— 于是它进不了
  `event-surface.ts` 的**活** `SurfaceIndex`。
- 活索引在 `ensureState` 首次建起来时会 fold 一遍盘上已有的事件(那一遍**认得**
  `tool/result`),所以缺的只是**本进程内**新落的那些 `tool/result`。
- 写侧 `event-translator.ts` 的 `sessionCompacted` 按 `order.slice(0, at+1)` 凑
  `sourceEventSeqs` —— 活 order 里没有这些格,清单里自然也没有。
- 读侧整份日志重放,`order` 里**有**这些格,`shadowCompact` 的完整性检查当场报缺。

**不是行为漂移**:`shadowCompact` 用 `order.slice(0, to+1)` 整段遮全,模型历史没有
多看或少看一条 —— 这是一条**记账完整性**的抱怨。

**读侧改了(本批)**:`core/session/projection/surface.ts` 的两处声明区校验
(`shadowCompact` / `applyReplace`)只对**消息节点**问责 —— 新增
`messageNodeSeqs`(`surfaceMessageIdOf` 认得的那些格)与私有
`declaredMessageGap`;非消息 surface 格(`tool/result`)缺席不抱怨。会真正变成
§7.1 B5 那种静默历史错乱的只有消息节点漏声明,校验因此收敛到它们。老文件
(`ec2437ff`)当场自愈:`bun scripts/session-verify.ts ec2437ff-…` 由 FAIL 转
`ok events=7293 messages=137`。合同测试新增一条双面用例
(`does not blame a compaction for cells that are not messages`:漏 `tool/result` 绿、
反证漏消息节点仍红);既有的 `flags a replace that forgot to declare what it shadows`
不受影响(它漏的是 `run/start`,是消息节点)。

**写侧没有改 —— 停在诊断,须拍板**。任务书里那一句"`covered → sourceEventSeqs`
补全为全部被遮格"在 `event-translator.ts` 里**无处下手**:写侧手上那份 order 本身
就没有 `tool/result`,而它拿不到(现读整份 events.jsonl 是 §7.2 M7 点名禁止的主线程
同步全文件读)。唯一的真修法是把上面两处 `tool/result` 改走
`appendSurfaceAwareEvent`,让活索引与重放一致 —— 但那**是一次可感知的行为变化**,
不只影响压缩:

- `sessionSurface().rangeFrom/wholeRange` 会开始把 `tool/result` 算进去,于是
  编辑重发 / 删除 / 清空写下的 `surfaceOp.end` 可能从一条 `run/start` 变成它后面
  那条 `tool/result`,**被遮蔽的格因此变多**。
- 顺带会照出一处**同源的既有分岔**(本批只记录、不动):今天编辑重发写下的 `end`
  是活 order 的末格(通常是 `run/start`),而读侧 order 里那条 `run/start` 后面还
  跟着若干 `tool/result` —— `applyReplace` 的 `to` 停在 `run/start` 上,**那些
  尾随的 `tool/result` 在读侧没有被遮掉**。它们不物化成历史消息,所以今天看不出
  症状;要不要一起收,和上面是同一次拍板。

按"用户可感知的行为变化默认保持旧行为"的口径,这一条留给用户裁定。

#### 2. `ef079fd7` `Session cleared` 化石进基线

成因已由 `dc810f4f` 修掉(§15.20:`'Session cleared'` 是拆除现场留给等待方的一句
内部话,不是判决理由;修在 `core/permission/index.ts` 的单一构造点)。盘上那条
`permission/answered` 是**修复前**写的,按 G3(事件只追加、不回填)不动它,红线
进基线静音:`docs/audit/session-verify-baseline-2026-08-20.txt` 追加

```
ef079fd7-d6ca-42a4-887b-499767593b7a messages: canonical differs for message 55a915aa-c27d-40bc-aee9-ffe215a76d20
```

**`sessions:hydration-contract` 的 fail 1 也是它**,而且**同一行就收掉两道门**:
`scripts/session-hydration-contract.ts` 读的就是这份基线(按会话 id 把红降级成
`baseline-skip`),contract 没有第二份基线机制。改完 contract 由 `1 failed` 转
`441 session(s), 0 failed`(`baseline-skip` 8 → 9)。

#### 验收(实跑)

| 项 | 结果 |
| --- | --- |
| `bun run typecheck` | 0 |
| 定向 `packages/core/session` + `packages/backend/session` | 30 files / 364 tests 全绿 |
| `bun run sessions:shadow-battery` | **GREEN** —— runs 368 / historyChecks 512 / mismatches 0 / appendFailures 0 / refoldMismatch 0 / fallbackHits 0 / shadow.jsonl 0 行 |
| `bun run boundary:gate` | 0 failures |
| `bun run session:gate` | 0 known, none new |
| `bun run log:gate` | 4 known, none new |
| `node scripts/session-verify-gate.mjs`(真机只读) | **ok — 13 known issue(s), none new** |
| `bun run sessions:hydration-contract` | 441 session(s), **0 failed**(baseline-skip 9) |

**另记(不属本批,只报告不动手)**:verify 门这一轮打印 **13 条 healed**,全部
**先于本批**就已经绿了(本批只改 violation 的问责范围,动不了 canonical 投影;
逐条复跑证过:`46dcec05` `ok`、`room-1` `ok`、`a5157107` 的 `unclosed-run` 在
stash 掉本批改动后同样已自愈 —— 基线第 24 段本来就预告了它会自愈)。要不要就此
收紧基线是另一次动作,不在本批范围。

### 15.22 批 6b 落地记录:S3w-3 删旧收官 —— 抄本写代码退场(2026-08-26,opus 执行,未提交)

批 6a 只翻默认与配套、**一行写代码都没删**,理由写在那一段里:回滚成本。这一批
兑现了它留下的每一句预告 —— `messages.jsonl` 的写代码、两根抄本回滚杆、reads 的
抄本兜底、`messages.cleared-*` 留档,全部删除。**回滚从此是 `git revert`。**

前置判据在开工前逐条实跑过(不是引用批 6a 的旧读数):
`sessions:verify:gate` 0 new(13 healed,见下)、真机全库只读实算
**400 间会话已 `message/imported` / 33 间原生覆盖 / 0 间"有事件却折不出消息" /
10 间空壳(0 条消息、无 `events.jsonl`)/ legacy 整文件 0 间** —— 也就是说,
删掉读兜底在这台机器上**结构性无损**。

#### 一、删除清单(逐项)

**1. `runtime/src/sessions/storage-driver.ts` 的消息写半边。**
`encodeSuffix` / `writeSuffix` / `rewriteAll` / `writeMetaOnly` 与
`HybridSessionStorageDriverOptions.skipMessageWrites`(批 4 装的端口)整段删除;
`writeJsonl` 收成 `mkdir + writeMeta` 两句。`SessionWritePlan` **留在签名里但不再被
读**(`void plan`)——写计划是命令面 reducer 的产物,它的退役属于 F 线,不是这里。
连带删掉 `encodeJsonlHeaderLine` / `encodeJsonlMessageLine` 两个 import(写侧唯一
的用户)与 `writeGenerations` / `migrationScheduled` / `migrationDelayMs`(异步惰性
迁移的三件套,见第 4 条)。

**2. `backend/session/reads.ts` 的抄本兜底。**
`transcriptFallback` 包装、`fallbackCarriesHistory` 判据、`event-stats.ts` 的
`fallbackHits` 计数器与 `countSessionReadFallback` 全删,`sessions:shadow-report`
少打一行。**11 处兜底删掉 8 处**(`listMessages` / `getMessage` / `findMessage` /
`getMessageIndex` / `countMessages` / `lastMessageOfRole` / `firstUserPreview` /
`iterateMessages`)—— 保留 3 处,理由在第二节。

**3. `ONETHING_SESSION_READ`(S2b 的回滚读)。**
§15.8 表里批 6 的"唯一确认点",用户已确认烧。这不是顺手清理:兜底删掉之后
`messages` 档只会读出一片空 —— **一根扳下去就把历史读没的杆,比没有杆危险**。
`SessionReadMode` / `DEFAULT_SESSION_READ_MODE` / `getSessionReadMode` /
`isSessionEventsReadMode` / `setSessionReadModeForTesting` 全删;`fromEvents` 从
"档位岔口"变成"投影取数 + 吞异常"(warn 措辞同步改掉,没有第二侧可退了)。
`event-log.ts` 的 `wantsEventTail()` 因此恒真(留着函数是为了让"为什么恒真"有个
落点,不是为了将来还能关掉)。

**4. `ONETHING_SESSION_TRANSCRIPT` 三态开关。**
`SessionTranscriptMode` / `DEFAULT_SESSION_TRANSCRIPT_MODE` /
`getSessionTranscriptMode` / `isSessionTranscriptOff` /
`setSessionTranscriptModeForTesting` 全删,`read-mode.ts` 里给它留一段墓志铭。
**连带口径固化**:事件 / blob 写失败上抛(裁定 7)从"`off` 档的特例"变成
**无条件默认行为** —— `event-log.ts`(粘住的队列失败 + G12 拒写)、
`blob-store.ts`(blob 写失败)、`event-translator.ts`(`safely` 放行
`SessionEventWriteError`)三处的档位判断一并删掉。

**5. `messages.cleared-*` 留档(裁定 10)。**
驱动的 `archiveMessages`、`stores/sessions.ts` 的 `archiveSessionMessages`、命令面
`SessionCommandsPorts.archiveMessages` 与 `ReplaceAllResult.archivePath`、
`clearSessionMessages` 的返回字段,以及 `replaceAll{clear}` 里**留档前那一次强刷**
(它存在的唯一理由是"留档必须在 flush 之后")全删。存量 179 个 / 14.3MB 按裁定 9a
原地不动。`session-storage-report` 那一格改口径:产地关了,这个数从此不该再涨。

**6. `sanitizeSessionsOnStartupWithAdapters`(core)+ 它的两个类型 + 它的单测。**
这是**启动期全量扫描 → sanitize → 写回**那条老路的适配器,零生产调用点(仓库早
改成 `repairOnFirstTouch` 冷加载修一次),而它整个函数的出口就是
`options.saveSession(...)` —— **纯粹为"抄本写回"而存在**,写半边没了它连理论上的
用处都不剩。`port-seam-audit` 也早点过它的名(§697 行:零生产实现)。

**7. `session:check` 白名单收一条**:`storage-driver.ts`。它进白名单的理由是消息
写半边要逐条编码 `session.messages`;剩下的两处访问落在驱动自己的
`SessionLike { messages?: unknown[] }` 上,元素类型是 `unknown`,本来就不构成规则 A
说的"一条会话的消息日志"。实测拿掉 0 命中。

**8. `verify` 基线 13 条已自愈**:46dcec05 × 10、9c94531d × 1、room-1 × 1、
a5157107 unclosed-run × 1。门在本批**开工前**就打印 healed(所以不是这批治好的),
按基线一直以来的纪律摘除,各段留 `[已自愈…]` 批注。剩 13 条,`0 new`。

**9. battery 六条泳道 → 四条,两枚探针 → 一枚**(见第三节)。

#### 二、保留清单与理由

| 保留 | 理由 |
|---|---|
| `messages.jsonl` 的**读**半边(`loadJsonl` / `readLineRange` / 冷尾页 / 游标页 / 锚点页 / marker / `readTranscriptFile` / `readTranscriptBuffer`) | 裁定 9a:存量抄本永久原地只读。`history` 工具、`verify #6` 的存量对账、影子的真相侧都还从它取数 |
| `sessionReads.*FromTranscript` 三口 | F11:影子断言与事件写侧取材的**真相面**,本来就不经过投影;抄本没了它们读到空,判据不变(错的是"两侧同源",不是"读得到") |
| `pageMessages` / `listUserMarkers` 右边那半 | **不是第二份真相**,是**空会话的形状口**:前者返回值不可空,而事件侧对"还没有任何消息事件的会话"返回 `undefined`,空页的形状总得有人给 |
| `sliceForHistory` 下面那条 store 切片 | **能力缺口**的退路,与"事实在哪一侧"无关:①没装 `historyBuilder`(轻量单测)②给了 `upToMessageId`(事件版要按 seq 折,至今无调用点)。而且它取的是**内存 store**(S3w-1 起由投影补水),不是抄本文件 |
| `SessionWritePlan` / `dirtySeq` 整套 | 命令面 reducer 的产物(`core/session/commands.ts`),驱动只是不读它了;退役归 F 线 |
| `sanitizeSessionOnStartup` / `repairOnFirstTouch` 本体 | **没有一格是"仅服务于写回"的**:`prepare` 只承担了中断 step/toolCall 的结局合成,`isStreaming` 与会话级时间线元数据(summary / contextSize / lastInputTokens)仍然只有它管 |
| `loadSessionWithAdapters` 里的 `saveSession(repaired)` | **意思变了但没死**:修复的消息半边落不了盘(每次冷加载现算,幂等),但会话半边正是住 `meta.json` 的那几格。就地写清楚了 |
| `ONETHING_SESSION_HYDRATE` 开关 | 见"待拍板" |
| `session-dehydrate.ts` 的 `session:check` 白名单条目 | 实测也已 0 命中,但它**不是被这一批改没的**(本批一个字没动它),超出授权范围,原样留着 |

#### 三、裁定 9b:legacy 整文件会话首触迁移进 events

触发点从"冷加载后 1 秒的惰性定时器"改成**冷加载那一刻同步做完**
(`driver.load()` → `migrateLegacySessionNow`)。**同步是必须的,不是偏好**:
事件层"这条会话记不记账"的判据是**会话目录在不在**(`event-log.ts` 的
`resolveEnabled`);legacy 会话没有目录,于是从加载到迁移完成之间的每一条事件都被
静默丢掉 —— 从前那 1 秒窗口无所谓(真相在 `messages.jsonl` 里),现在事件是唯一
账本,丢掉就是丢历史。同步做完之后,第一条命令跑起来时目录与 imported 都已在盘上,
`ensureState` 一读就接上号(不必碰 `resetSessionEventLogCache`:legacy 会话此前
`resolveEnabled` 恒假,不可能留下过期的 seq 状态)。

产物形状与 `scripts/migrate-sessions-events.mjs` 的 `makeImportedRecord`
**逐字段同形**:一条消息一条 `message/imported`,`seq` 从 1 起,`time` 取消息自己
的 `timestamp`(迁移不给历史重新盖时间戳),`data.synthetic: true` 是带内幂等标记
(`coverageState` 认的就是这个类型),`surfaceOp: 'append'`。编码走 core 的
`encodeSessionLogEventLine`,校验走 `decodeSessionLogEventLine` 逐条对 id —— 与从前
迁抄本时同一道门。

**只走全量导入这一档**:能走到这里 = `jsonlExists()` 为假 = 这条会话连
`events.jsonl` 都没有,所以运维脚本那套覆盖感知合并 / 整体重编号
(`planNativeMerge` / `shiftEventRecord`)在这条路上**结构性用不到** —— 没有既有
事件可合、可平移。有既有事件的会话仍然走
`scripts/migrate-sessions-events.mjs --apply`,那边一行没动。因此**没有把脚本的核心
搬成库函数**:要复用的只有 6 行记录构造,而为它把 `planNativeMerge` 一起搬过来会
在产品层留一段永远走不到的分支。

先写暂存目录 → 逐条校验 → 原子 `rename` 换入 → 原件移进 `sessions/legacy-backup/`。
从前那道"代际比对"(读与提交之间可能有写落盘)**结构性消失**:同步路径上读到提交
之间一个 `await` 都没有。只留一条让路规则:**在途 legacy 写还挂着就这一轮不迁**
(`inFlightWrites.has(...)`),下次冷加载再试 —— 否则会读到旧内容,而那次写随后又把
legacy 文件重建出来,新数据永久落进无人读取的 backup(这正是 1.3 那条回归)。
`storage-driver-migration-race.test.ts` 按新口径重写,钉的还是同一件事:**m2 不能丢**。

**用例**:`storage-driver.test.ts` 三条 —— 冷加载 legacy 会话产出 8 条
`message/imported`(seq 1..8、time 取消息 timestamp、`synthetic:true`、
`surfaceOp:'append'`)且**不产出 `messages.jsonl`**、原件进 legacy-backup;已是事件
会话 = no-op;坏掉的 legacy 文件安全失败(不留 `.migrating`、原文件原样)。

**真机现状**:legacy 整文件会话 **0 间**(B8 记的那 1 间早已被旧的惰性迁移转成
jsonl)。所以这条路今天是**为正确性而写,不是为存量而写** —— 它守的是"有人从备份
恢复出一个 legacy 会话"那一类场景。

#### 四、battery:六条泳道 → 四条,两枚探针 → 一枚

- **抄本泳道**从两条收成一条。`shadow rollback` 那条验的是回滚杆能不能把写路径接
  回去 —— 杆没了,泳道也没了。留下的那条(`no transcript (deleted in 6b)`)语义又变
  了一次:它不再验"某一档",而是**删除本身的运行时证据** —— 全场景跑一遍,
  `messages.jsonl` 一个字节都不许长。`expectTranscript: 'present'` 那半边判据一并删。
- **补水泳道**从两条收成一条。`legacy rollback`(`ONETHING_SESSION_HYDRATE=messages`)
  的取材池是"带抄本的会话",而那批会话只可能由 `shadow` 抄本泳道写出来 —— 池子的
  产地没了,泳道也就没了可跑的会话。`laneTaken` 留着:哪天补回第二条,
  "取材互不相交"这条纪律还在。
- **写失败探针**从两枚收成一枚。上抛成了无条件行为,`shadow` 那枚对照探针没有了
  对象;留下的那枚判据不变(至少一次 `removeMessage` 报错,而且报的必须是
  `session event log write failed` 这件事,不是随便一个错误)。
- `startServer` 里 `delete env.ONETHING_SESSION_TRANSCRIPT` 那句删掉(没有可清的了),
  `ONETHING_SESSION_HYDRATE` 那句照旧。

#### 五、测试改动(语义,不是修补)

| 文件 | 改法 |
|---|---|
| `runtime/sessions/__tests__/storage-driver.test.ts` | 整体重写:写侧断言改"只落 meta.json / 三档写计划对存量抄本一视同仁";读侧用 `seedTranscript` **直接铺存量化石**(驱动不再有路写出它),整会话读回 / 崩溃截断自愈 / 冷尾页 / 游标页 / 锚点页 / marker 一条不减;新增裁定 9b 三条;新增"没有抄本时两口都答 undefined(冷热两态)"—— 那是上面 ② 的钉子 |
| `runtime/sessions/__tests__/storage-driver-migration-race.test.ts` | 1.3 的回归换口径:从"先 await 排空在途写"改成"见到在途写就让这一轮",断言仍是 m2 不丢 |
| `runtime/sessions/__tests__/crash-recovery.test.ts` | 四条用例的"落盘现场"改 `seedTranscriptFossil` 直写;第一条末尾的"修复必须写回磁盘"换成**"再冷加载一次照样修得对"**(修复从此只在内存里,幂等) |
| `backend/session/__tests__/transcript-off.test.ts` → `event-write-failure.test.ts` | 三态开关那组整组删;上抛四条从"对照"变"直断";refold 那组一字未动 |
| `backend/session/__tests__/event-log-s1.test.ts` | G12 拒写与 blob 写失败两条从"返回 undefined"改"上抛";`beforeEach` 里那句显式扳 `shadow` 删掉 |
| `backend/session/__tests__/reads-read-mode.test.ts` → `reads-projection.test.ts` | "两档一致"整组换成**"只认投影"**(仓库替身里那份故意改坏的抄本一个字也漏不进来);新增一组**删兜底自证**:事件折不出历史时读门面给空,而 `*FromTranscript` 照旧读得到 |
| `backend/session/__tests__/{shadow-read-mode,events-reads,event-translator-write-side-read}.test.ts` | 去掉档位钉子;`events-reads` 里"开关本身"那条删,"折不出历史退回抄本"那条**反过来**断言给空 |
| `backend/rpc/__tests__/sessions-domain.test.ts` | 读路由那组从"两档对照"收成"两条读入口都落在投影上";会话存在性仍问仓(投影折不出 ≠ 查无此会话),那条逐字保留 |
| `backend/session/__tests__/commands.test.ts` / `backend/stores/__tests__/sessions-clear-messages.test.ts` | 留档相关断言退役;`clear` 只剩写完那一次强刷。**顺带查明**:`stores` 那个 `clearSessionMessages` **今天零生产调用点** —— 群聊「清空聊天记录」走的是命令面 `sessionCommands.replaceAll{clear}`(`wiring/collab/room-config.ts`),`session/cleared` 是那条路写的。所以这个文件只断言"不再留档 + 被清的消息事件原样还在",遮蔽事件的判据在 `event-translator.test.ts` |
| `backend/stores/__tests__/core-session-store-helpers.test.ts` | 启动期全量 sanitize 那条随函数一起删 |

#### 六、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | 0 |
| 定向测试(`core/session` + `backend/**` + `runtime/sessions`) | **304 文件 / 2609 用例全绿**(1 skipped) |
| `bun run boundary:gate` | 0 boundary failures |
| `bun run session:gate` | 0 known / 0 new |
| `bun run log:gate` | 4 known,none new |
| `bun run transport:gate` | 42 常量 / 四壳 2392 行,无上升(本批未碰传输面) |
| `node scripts/session-verify-gate.mjs`(真机只读) | 13 known,**0 new**,0 healed |
| `bun run sessions:hydration-contract`(真机只读) | 443 会话 / **0 failed** / 8 baseline-skip(口径补齐见上节) |
| `bun run sessions:shadow-battery` | **GREEN** —— 27 场景 × 9 passes;runs 321 / mismatches 0 / appendFailures 0 / refoldChecks 225 / refoldMismatches 0 / `session-shadow.jsonl` 0 行;四条泳道 + 一枚探针全 PASS |
| `bun run sessions:storage-report`(真机只读) | 见下 |

**删旧后的存储基准(2026-08-26,443 会话 / `sessions/` 全部 1.20GB)**:

```
events.jsonl        432.0MB   ← 唯一持久化,从此只有它涨
messages.jsonl      392.6MB   ← 存量化石,冻在停写那一刻(裁定 9a)
blobs/                9.0MB   (orphan 0B)
meta.json             1.5MB
messages.cleared-*   14.3MB   ← 产地已关(裁定 10),这个数不该再涨
legacy-backup/      381.4MB   ← S1a 迁移的原抄本副本,同样无治理器
其它                618.4KB
events+blobs ÷ messages = 1.12   (§8 的 S3w-3 验收目标 1.10–1.20 ✔)
```

#### 七、待拍板 / 留账

1. **`ONETHING_SESSION_HYDRATE=messages` 这根杆要不要一起退役。** 本批**没动它**
   (授权范围只写了抄本那两根),但它现在是一根**只对存量有效、而且已经不安全**的
   杆:①停写之后出生的会话没有抄本,扳过去补出来的是空;②停写之前出生、之后又聊过
   的会话,抄本冻在停写那一刻,扳过去等于把那之后的历史补丢。已在 `read-mode.ts`
   就地写明"不要扳它",并撤掉了它的 battery 泳道(取材池没了)。**建议退役**,等
   用户裁定。
2. **§15.21 第 1 条写侧仍待拍板**(让 `tool/result` 走 `appendSurfaceAwareEvent`),
   本批一字未动。
3. **`clearSessionMessages` 零生产调用点**(见上表)。它是 `store.ts` /
   `stores/index.ts` 的导出面,删它属于面收敛,不在本批范围。

### 16.5 F0 落地记录:恒等门转向(2026-08-27,opus 执行,未提交)

**一句话**:`session-shadow` 那道门的两侧一个字没换,换的是**谁被 blame** —— 从
「store 是真相、投影是影子」翻成「**事件/活投影是真相、内存 store 是影子验证器**」。
比对是对称的,所以这批**零行为变化**:同一对不等,昨天红今天也红(battery 逐项对照
见第四节)。

#### 一、对调落点清单

| # | 文件 | 改了什么 |
|---|---|---|
| 1 | `packages/backend/session/shadow.ts` | 文件头重写(「S1b 影子断言」→「恒等门」,新增一张转向前后对照表 + "为什么零行为变化");纪律 4 从"真相侧永远是抄本"改成"**验证器侧永远是 store,不许经过投影**"(取数纪律不变,变的是它守的角色);`SessionShadowKind` 注释按新语义;`SessionShadowDiffEntry.a/b` 的语义对调(a=事件真相 / b=store 验证器);新增 `SESSION_SHADOW_TRUTH` 常量 + `SessionShadowTruth` 类型 + `SessionShadowRecord.truth?` 字段;`appendSessionShadowLine` 在**唯一写入口**盖章 `truth:'events'`;`recordMismatch` 形参改名 `a/b` → `truth/verifier`;`checkSessionRunShadow` 变量 `actual` → `storeMessages`,`a/b` 两侧对调赋值;`checkSessionHistoryShadow` 两侧对调;`sessionEventCoverageIsPartial` 注释 |
| 2 | `packages/backend/session/shadow.ts`(入参) | `SessionHistoryShadowInput.actual` → **`fromStore`**(`actual` 这个名字本身就编码着旧方向) |
| 3 | `packages/backend/wiring/engine/stream/history-shadow.ts` | 文件头重写(真相=`materializeModelHistory`,验证对象=`buildHistoryMessages(store)`);steer 窗口那段"投影没错"→"哪一侧都没错";调用点 `actual:` → `fromStore:` |
| 4 | `packages/backend/wiring/engine/stream/agent-loop-executor.ts` | `onRequestRecipe` 上方那三行注释的"真相侧"→"store 侧" |
| 5 | `packages/backend/session/reads.ts` | `listMessagesFromTranscript` 的文档:「影子断言唯一合法的**真相侧**取数」→「恒等门唯一合法的**验证器侧**取数」;删掉停写后已失真的"永远来自 messages.jsonl";补一句"F0 换的是方向,'两条独立推导'这条纪律与方向无关" |
| 6 | `packages/backend/session/refold.ts` | 文件头补方向段:`refold` 类的 `a` 从一开始就是**文件重折**(真相),F0 没动它;写入口盖的 `truth:'events'` 对这一类同样成立 |
| 7 | `scripts/session-shadow-report.mjs` | 文件头补「方向」段;新增打印行 `[shadow] direction : A = events(真相) / B = store(影子验证器) [F0]`;`buildReport` 新增 `directions {events, legacy}`(**不进门**),打印行 `[shadow] lineDirections`;`formatDiff` 的两列改**随方向标记取名**(`diffColumnLabels`):有 `truth` 的按新语义、**没有 `truth` 的按旧语义打印**(拿今天的列名去贴昨天的行 = 把归因贴反),`refold` 类另有一对名字 |

**没动的**(刻意):`kind` 取值、`stats` 的任何字段名(`runs`/`mismatches`/`byKind`/
`skipped`/`refold*`…)、采样率、去重指纹口径、门判据、`ONETHING_SESSION_SHADOW` 开关。
报表要能跨 F0 读同一条时间线,断代一次就再也拼不回来。

#### 二、护航断言:`truth` 方向标记

- **形状**:`session-shadow.jsonl` 每行多一格 `"truth":"events"`。**缺这个字段的行 =
  F0 之前记的**,它的 A/B 两列语义正好相反。
- **盖章点**:`appendSessionShadowLine`(**唯一**写入口,`messages`/`history`/`refold`
  三类共用)。各采集点自己填迟早漏一处,而漏掉的那一行会被人当成老记录读反。
- **报表**:`lineDirections` 把两种行分开数;`last diffs` 的列名逐行随标记走。
- **它给 F1–F4 的用处**:写模型翻转期间一次不等的默认归因是"store 侧漂了",
  日志里 `b` 列就是漂掉的那一份,不必再靠人反读。

#### 三、用例

| 用例 | 位置 | 钉住什么 |
|---|---|---|
| `records one line + one counter when the bodies differ` | `session/__tests__/shadow.test.ts` | 改的是 store 侧('HELLO'),断言 **`a==='hello'`(事件)/ `b==='HELLO'`(store)** —— 谁把两侧调回去当场红;顺带断言 `truth==='events'` |
| `puts the projection in column A and the store in column B` | 同上(history 类) | **新增**。只有 store 侧才有的那句话必须落在 `b` 列、且**不许**出现在 `a` 列 |
| `every recorded line carries the F0 direction marker` | 同上 | **新增**。一次 `messages` + 一次 `history` 两行都必须带 `truth:'events'` |
| `counts the F0 direction marker apart from the pre-F0 lines` | `session/__tests__/shadow-report.test.ts` | **新增**。带标记 / 不带标记的行分开计数(`{events:1, legacy:1}`) |
| 既有 12 处 `actual:` | `shadow.test.ts` | 随入参改名 `fromStore:`(纯改名,断言值一字未动) |

#### 四、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | **0** |
| 定向 `packages/backend/session` + `packages/backend/wiring/engine` | **84 文件 / 659 测试全绿** |
| `bun run sessions:shadow-battery` | **GREEN** —— runs **321** / historyChecks 449 / mismatches **0** / duplicates 0 / appendFailures **0** / refoldChecks **225** / refoldMismatches **0** / `session-shadow.jsonl` **0 行**;四条泳道 + 一枚探针全 PASS |
| `bun run boundary:gate` | ok — 0 failures |
| `bun run session:gate` | ok — 0 known, none new |
| `bun run log:gate` | ok — 4 known, none new |
| 真机只读 `bun run sessions:shadow-report` | 打印正常(含新的 `direction` / `lineDirections` 两行);runs 32 / mismatches 0 / refoldMismatch 0 / shadow.jsonl 0 行。**GATE RED 只因 `runs 32 < 200`** —— 真机计数在批 6b 之后重新起算,与本批无关;全程只读,`~/.onething` 一字未写 |

**battery 对照(这批"零行为变化"的门)**:批 6b 的落地记录(§15.22 验收表)是
runs **321** / mismatches **0** / appendFailures **0** / refoldChecks **225** /
refoldMismatches **0** / `session-shadow.jsonl` **0 行**,四泳道一探针全 PASS ——
本批**逐项相同**。(`historyChecks` 是请求粒度、批 6b 表里没列;它随场景内的请求轮数
浮动,不参与判定。)

**报表两种行的打印**另在一份三行 fixture 上验过(临时 store,读完即删):老行打成
`A(store, 旧方向)/B(events, 旧方向)`,新行打成 `A(events 真相)/B(store 验证器)`,
`refold` 行打成 `A(events 文件重折)/B(内存活投影)`,`lineDirections` 报
`2 events / 1 pre-F0`。

#### 五、留账

1. **`listMessagesFromTranscript` / `getMessageFromTranscript` / `findMessageFromTranscript`
   这组名字里的 "Transcript"** 停写之后已经名不副实(它读的是**内存 store**,不是抄本
   文件)。F0 只改了文档,**没改名** —— 写侧取材(§13.18)也在用这两口,改名会把 F3
   的一半提前拽进来。**归 F3**(那一批本来就要把"写侧读抄本"整体翻面)。
   → **已办**:§16.10(2026-08-27)。改名做了,取数面**一处未动** —— 逐处的
   "留"各自换了具名理由,不再靠那条一刀切纪律。
2. **F0 影子验证器的退役条件**(§16.3 第 2 条)仍待拍:F4 两条推导合一那天这道门
   失去对象,退役门(多少 run / 多久)与 refold 采样率一并拍。
3. **真机 ≥200 run 0 失配**这条 F0 自己的门今天只有 32 run —— 它按设计是**浸泡期**
   拿的(批 6b 之后重新起算),不是本批能一次跑出来的数;battery 的 321 run 是它的
   离线替身。

### 16.6 F1 落地记录:写侧同步可见(2026-08-27,opus 执行,未提交)

**一句话**:一条事件被写入口分配到 seq 的那一刻,**还在同一个同步段里**就折进了这个
进程的每一份活状态(活投影 + 活 surface),然后才排队落盘。"命令内读得到自己刚写的"
从"每个读口都记得先 drain 一次"的**约定**,变成写入口自己保证的**机制**。

> **勘误(见 §16.15)**:本批"活 surface 从此看得见 `tool/result`"这一条带出了一个
> 当时没想到的后果 —— 截断类命令的 replace 区间会顺手圈进**在途 run 落下的那一格
> 结局**(工具在途时用户插一句话就长这个形状),读侧的工具结果剪枝据此把一次还活着
> 的调用整个摘掉。真机 `ef079fd7` 两条坏区间已烙进账本。本批下面写的"这一段遮蔽比
> F1 之前更全:那是已拍定的行为,不是本批的副作用" —— 前半句仍然对,后半句只对
> **归属在段内**的那些格;归属在段外的那一类是本批的回归,由 §16.15 三刀收口。

#### 一、勘察结论(改动量取决于它):**半同步 —— 记录同步、fold 惰性**

开工前的真实时序(HEAD `5f073752`):

```
appendSessionLogEvent(sessionId, type, data)          ← 同步段开始
  ├─ seq = ++state.lastSeq                            ← 同步
  ├─ record = {seq,time,type,data,surfaceOp,…}        ← 同步(原件只此一份)
  ├─ state.expectedBytes += byteLength(line)          ← 同步(G12 守卫的账)
  ├─ state.shadowTail.push(record)                    ← 同步:**记录进内存,但没折**
  └─ state.queue = state.queue.then(appendFile)       ← 异步排队落盘
                                                       ← 同步段结束,返回 seq

……(此后任意时刻)……

getLiveSessionProjection(sessionId)                    ← 读的时候才推进
  ├─ (首次) prepareSessionEventsOnce + readSessionLogEventsSync 全量 fold
  ├─ drainSessionLogEventTail(sessionId)              ← **取走式**尾巴
  └─ for (record of drained) reduceSessionProjection  ← **这里才 fold**
```

- **活投影是读取时惰性折**(不是写入时同步折)。结果上"读得到自己刚写的"成立 ——
  因为每个读口第一句都是 drain;但它是约定,不是机制:任何一个不 drain 的读法
  (`peekSessionProjection`、拿着上一次返回的 state 不放)都看不见刚写的那条。
- **写侧 surface 与活投影是两份独立推进,而且推进器不同**:
  - 活投影靠**取走式尾巴**(单消费者,`projection-cache.ts` 独占);
  - 活 surface(`event-surface.ts` 的 `SurfaceIndex` + `seqByMessageId`)靠
    `appendSurfaceAwareEvent` **自己写完之后复刻一条记录再 push**,与尾巴无关。
- 于是有一处**结构性缺口**:走另一扇门(`appendSessionLogEvent`)落的事件,活 surface
  **永远看不见**。而 `tool/result` 恰好既是 `SESSION_SURFACE_NODE_TYPES` 里的节点、
  产地(`session-event-recorder.ts:984 / :1119`)又只走那扇门 —— 这正是 §15.21 第 1 条
  那条真机病历(`ec2437ff`:遮 257 格、声明 173 个,差的 84 格全是 `tool/result`)。

所以 F1 不是"补合同断言收窄",是**真有改动量**:把两份独立推进合成一条 —— 写入口
在同步段里通知,活投影与活 surface 都只从这一个源头前进。

#### 二、落地内容(3 个源文件 + 1 个用例文件)

| # | 文件 | 改了什么 |
|---|---|---|
| 1 | `packages/backend/session/event-log.ts` | 新增**同步可见钩子**:`SessionLogEventAppendObserver` 类型 + `registerSessionLogEventAppendObserver(observer): () => void` + 私有 `notifySessionLogEventAppended`;`appendSessionLogEvent` 在**排队落盘之前**调它。三条纪律写在类型上方:①观察者只推进**已经存在**的活状态(建表要读整份文件,挂在写路径上就是把 §7.2 M7 点名的那口同步 IO 搬进每一次 append);②注册发生在**运行期**,不在 import 期(装配层 import 纯净栅栏);③观察者抛出**不许**挡住落盘 —— 逐个 try/catch 记一行 `error`,事件照样进队列。`SHADOW_TAIL_MAX` 的注释补一段"F1 之后尾巴降级成兜底" |
| 2 | `packages/backend/session/projection-cache.ts` | 注册一个观察者(在 `getLiveSessionProjection` 里 `ensureAppendObserver()`,进程内幂等):活投影存在就当场 `reduceSessionProjection` 并推进 `lastSeq`;不存在就原地返回(那一段仍由尾巴兜)。reduce 抛出 → **删掉这份缓存**(移动语义下 state 可能只改了一半,已经不可信)再上抛,下一次读从文件整份重折。文件头补一节"推进从读的时候提前到写的时候" |
| 3 | `packages/backend/session/event-surface.ts` | 同样注册一个观察者(在 `ensureState` 里),`states` 里有表就 `applyToState`;`appendSurfaceAwareEvent` 改成**先 `ensureState` 再写**,并**删掉写完自己复刻一条记录 push 的那段** —— 推进从此只此一条路,而且观察者拿到的是写入口分配 seq 时的**原件**(不再有第二个 `Date.now()`) |
| 4 | `packages/backend/session/__tests__/write-side-visibility.test.ts` | **新增**,见第四节 |

**磁盘侧一个字没动**:仍然是每会话一条 `queue` 串行 `appendFile`,语义 fsync 检查点
(`flushSessionEventLog`)四处一处未动,`flushAllSessionEventLogs` / 关停预算不变。

#### 三、崩溃窗口重审(§16.4 第 2 条)

**refold 的游标守卫在新时序下不误报 —— 而且它本来就不会**:

- 守卫是 `events[events.length-1].seq !== cursor → skipped`(`refold.ts:174`)。活投影
  领先磁盘时,文件那一侧**更短**,末条 seq < 定格游标,当场对不齐 → `skipped`,
  既不进 `refoldChecks` 也不可能记 `refoldMismatches`。
- **这不是 F1 引入的新局面**:F1 之前活投影也是"读的时候把**整条尾巴**折进来",
  而尾巴里装的是"已经 append 的全部" —— 两个时代的 `cursor` 是同一个数
  (= 这个进程 append 过的最后一条 seq)。F1 只把折的**时刻**从读挪到写,
  没有改变**折了多少**。既有的反向用例(`event-write-failure.test.ts` 的
  `skips instead of crying wolf when the cursor moved between flush and read`,
  文件比投影长)与本批新增的正向用例(投影比文件长)现在两头都钉着。
- 挂点也没变:`scheduleSessionRefold` 仍排在 `endSessionRun` 的 `flushSessionEventLog`
  **之后**,那一刻文件字节是全的,所以正常路径上 `skipped` 率不受影响
  (battery 实测 refoldChecks 225,与 F0 逐项相同)。

**定性(写进 §16.4)**:崩溃时活投影可能领先磁盘;重启之后活投影是**从文件重折**出来的,
领先的那一段随进程一起消失。**账本仍然自洽** —— 丢的是"还没到检查点的那一小段",
是**少一段**而不是**错一段**,而这一段的上界由语义 fsync 检查点夹住(调模型前 /
调工具前 / 响应收齐 / run 结束)。检查点位一处未动:F1 没有让这个窗口变大,
它只是让窗口内**内存里那一份**变得更早可见。

#### 四、合同断言 + 反证

新文件 `packages/backend/session/__tests__/write-side-visibility.test.ts`(5 例),
harness 与 `event-translator-write-side-read.test.ts` 同款(跑**真的**事件日志 / 投影 /
surface,只替身最底下的会话仓库)。

**断言用 `peekSessionProjection` 而不是 `getLiveSessionProjection`** —— 后者自己会
drain 尾巴,惰性折的年代它也照样返回含这条事件的投影,拿它断言等于什么都没钉住。

| 用例 | 钉住什么 |
|---|---|
| `appendMessage:翻译调用返回时,不推进的活投影里已经有这条消息` | 代表面 1 |
| `patchMessage:补丁当场落在活投影的那条节点上` | 代表面 2 |
| `truncateFrom(regenerate):遮蔽当场生效,活投影里那条已经 hidden` | 代表面 3(13 条命令不逐条,选这三个) |
| `走 appendSessionLogEvent 落的 tool/result 也进得了写侧 surface` | 两扇门都算数;并断言写侧 `order()` 与读侧 `foldSurface(整份文件).order` **逐字相同** |
| `折在前、落盘在后 —— 那一段没落盘时游标对不齐,refold skipped 而不是 mismatch` | 第三节的崩溃窗口。先跑一次 `match` 证明这道门通电,再把 `fs.promises.appendFile` 换成"答应了但什么都没写"制造领先,断言 `skipped` |

**反证(实跑)**:把 `appendSessionLogEvent` 里那句 `notifySessionLogEventAppended`
去掉(推进退回 drain 时惰性),这 5 例**全红**(投影三例 `expected [] to deeply equal
[ 'u1' ]` 之类,surface 例 `expected [] to include 2`);恢复后全绿。

#### 五、性能确认

真机最大账本**只读**实算(`reduceSessionProjection` 逐条折 + `SurfaceIndex.push` 逐条推,
与活路径同一段代码):

| 会话 | 字节 | 事件数 | 投影 fold mean / p95 / p99 / max | surface push mean / p99 |
|---|---|---|---|---|
| `fe5261d9`(事件数最多) | 14.0 MB | 9435 | 1.6µs / 3.5µs / 11.2µs / 1188µs | 0.1µs / 0.3µs |
| `46dcec05` | 19.6 MB | 9272 | 2.1µs / 6.0µs / 30.0µs / 1253µs | 0.1µs / 0.3µs |
| `08f1fe09`(字节最大) | 48.2 MB | 258 | 3.9µs / 3.9µs / 10.7µs / 347µs | 1.2µs / 2.7µs |

**读数结论**:单事件增量 fold 是 **µs 级**(p99 ≤ 30µs),整条 9000+ 事件的会话全量
折一遍也只有 15–20ms。热路径预算不受影响 —— 而且这**不是新增开销**,是同一次 fold
从"下一次读的时候"挪到了"写的时候",进程总功不变。唯一的尖峰(max ≈1.2ms)是
`session/compacted` 那一条(它要走一遍全部节点),每会话只有几条,且在 F1 之前
同样要付,只是付在读口上。

#### 六、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | **0** |
| 定向 `backend/session` + `backend/wiring/engine` + `backend/__tests__` + `core/session` | **94 文件 / 813 测试全绿** |
| `bun run sessions:shadow-battery` | **GREEN** —— runs **321** / historyChecks 449 / mismatches **0** / duplicates 0 / appendFailures **0** / **refoldChecks 225 / refoldMismatches 0** / `session-shadow.jsonl` **0 行**(与 §16.5 F0 表逐项相同) |
| `bun run boundary:gate` | ok — 0 failures |
| `bun run session:gate` | ok — 0 known, none new |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run transport:gate` | ok — 42 常量 / 四壳 2392 行,无上升 |
| 真机只读 `bun run sessions:verify:gate` | ok — 13 known issue(s), none new(存量账本不受影响:F1 只改这个进程**新写**的那几条 seq 清单) |
| 真机只读 `bun run sessions:shadow-report` | 打印正常;runs 32 / mismatches **0** / refoldMismatch **0** / shadow.jsonl 0 行。**GATE RED 只因 `runs 32 < 200`**(浸泡期计数,与本批无关);全程只读 |
| `npx vitest run`(全量) | 1203 文件 / **11893 通过**,2 红:①`packages/renderer/components/__tests__/App.container-layout.test.ts` —— **他会话**在途的 `App.vue` 改动(工作树里 renderer 三个文件是别人的);②`packages/backend/stores/__tests__/sessions-delete-cascade.test.ts` —— 高负载抖动,**单跑绿** |

#### 七、留账 / 需拍板

1. **本批唯一带行为的动作:`§15.21 第 1 条`被这条机制顺带收掉了 —— 而它当时是
   "留给用户裁定"的。** §15.21 提的修法是"把 `session-event-recorder.ts` 的两处
   `tool/result` 改走 `appendSurfaceAwareEvent`";F1 走的是另一条路(写入口统一通知),
   但**效果相同**:活 surface 从此看得见 `tool/result`。可感知的差别只有一处 ——
   `sessionSurface().rangeFrom/wholeRange` 会把 `tool/result` 算进去,于是编辑重发 /
   删除 / 清空写下的 `surfaceOp.end` 可能从一条 `run/start` 变成它后面那条
   `tool/result`,**被遮蔽的格因此变多**,`sourceEventSeqs` 也变全。
   - 好的一面:写侧活 surface 与读侧 `foldSurface(整份文件)` 从此**逐字相同**
     (新增用例钉住);§15.21 顺带记录的那处"尾随 `tool/result` 在读侧没被遮掉"的
     同源分岔一并消失。
   - 代价:这是**新写下去的账本字节**的变化(存量文件一个字不动)。
   - 影响面实测:battery 321 run / refold 225 次采样 **0 失配**,真机 verify
     **none new**。
   - **要回退只需两步**:`event-surface.ts` 的观察者体改成空(或不注册),并把
     `appendSurfaceAwareEvent` 里写完复刻一条 `applyToState` 的老写法放回去。
     **请裁定是留还是回退。**
2. **`core/session/projection/surface.ts` 的 `declaredMessageGap` 收窄(批 6a 尾款)
   现在有了第二重身份**:它当初是为了绕开这个缺口才只对消息节点问责。缺口没了之后
   它仍然必须留着 —— **存量账本**(`ec2437ff` 这类)是缺口时代写的,读侧永远要认。
   本批一字未动,只是它从"绕开"变成了"向后兼容"。
3. **尾巴(`shadowTail`)没有删**:活投影还没建起来的会话(`trace.ts` /
   `events-reads.ts` 明确不许"读一眼就把活投影建起来")仍然靠它。F1 之后它是
   **兜底**而不是主路;取走时 `seq <= lastSeq` 天然幂等,所以两条路重叠也不会折两次。
4. **F2 的地基已经就位**:命令翻转时"产出事件 → 当场 fold → 从投影物化 store 视图"
   这一串里,中间那一步现在是写入口自己做的,命令面不必再显式推一次。

### 16.7 F2-a 落地记录:简单消息命令翻成「命令即事件」(2026-08-27,opus 执行,未提交)

**一句话**:`appendMessage` / `deleteMessage` / `patchMessage` 这三条命令的事件**产地**
从"翻译器从 store 的 mutation 反推"翻成"命令面自己第一手构造",执行序随之变成
**事件 append(F1 保证同步可见)→ reducer 应用到 store**。写下去的事件字节一字未变
(HEAD worktree 双跑逐行比对),变的只是谁先说话。

#### 〇、先勘误 §16.2 的 F2 行口径

F2 行原文写的是「命令产出事件 → fold → **store 视图从投影物化**」。**F2 不做最后那一步**
—— "store 从投影物化"是 **F4** 的终局;F2 期间老 reducer 必须**继续独立地**把命令应用到
store,因为它正是 F0 恒等门(§16.5)那第二条推导。翻转前后的角色是:

| | 事件 | store |
|---|---|---|
| 翻转前 | 派生物(从 mutation 反推) | 唯一推导 |
| **F2 翻转后** | **第一手表达**(命令直接产出) | **影子验证器**(F0 的 B 列),独立推导同一件事 |
| F4 终局 | 唯一源头 | 物化缓存(不再独立推导,恒等门随之退役) |

「两条独立推导」是恒等门存在的前提;F2 期间一步都不能少。

#### 一、逐命令翻转表

| 命令 | 事件构造搬到哪 | 翻译器删了哪段 | 新执行序 |
|---|---|---|---|
| `appendMessage` | `session/command-events.ts` → `sessionCommandEvents.appendMessage`(逐字搬迁) | `event-translator.ts` 的 `appendMessage` 方法整段删除 | `events.appendMessage()` → `ports.messages.addMessage()` |
| `deleteMessage` | 同上 → `sessionCommandEvents.deleteMessage` | `deleteMessage` 方法整段删除 | 存在性判定 → `events.deleteMessage()` → `ports.messages.deleteMessage()` / `deleteMessageWhere()` |
| `patchMessage` | 同上 → `sessionCommandEvents.patchMessage`(含 `fullBody` 档) | `patchMessage` 方法整段删除 | 存在性判定 → `events.patchMessage()` → `ports.messages.patchMessageFields()` |

**共用取材件也一并搬走,而且只有一份**:`messageForEvent` / `attachmentsForEvent` /
`safely` / `BODY_KEYS` / `DERIVED_KEYS` 现在住 `command-events.ts` 并导出,
`event-translator.ts` 从那里 import。两个产地各自演化出一份 `messageForEvent`,
就是"同一条消息在两种事件里长得不一样"的温床。

**翻译器上现在只剩 6 个方法**:`upsertMessage` / `truncateFrom` / `replaceAll` /
`patchSession` / `sessionCreated` / `sessionCompacted`(用例逐字钉住这份名单)。
`upsertMessage` 仍是老口径(reducer 后翻译),但它借道**同一份**
`sessionCommandEvents.appendMessage` / `.patchMessage({fullBody:true})` —— 借的是构造,
不是复制一份。

#### 二、判例迁移清单(一条都没丢)

| 判例 | 出处 | 现在住哪 |
|---|---|---|
| assistant 且 `isStreaming` → **不写**(`run/start` 才是它在 surface 上的格) | §9.3 | `sessionCommandEvents.appendMessage` 第一句 |
| user → `user/message`;其余(system / error / 落定的 assistant)→ `system/message`,role 原样 | §9.3 | 同上 |
| 附件 `base64Data` → `BlobRef`;blob 写不进去就**摘掉**而不是留原文 | §10.1 G8 | `attachmentsForEvent` |
| 正文三件套(`content`/`contentParts`/`reasoning`)永不进 `message/patched` | §9.2 | `BODY_KEYS`(`fullBody` 是唯一放行档,只给 upsert) |
| 派生字段(`isStreaming`/`isThinking`/`thinkingStartTime`/`seq`/`steps`/`toolCalls`)一律丢弃 | §9.2 | `DERIVED_KEYS` |
| `turnContext` 单独走 `context/turn-update`,不是一条 patch | §9.2 | `sessionCommandEvents.patchMessage` |
| 丢完剩下全空 → 一条事件都不写 | §9.3 | 同上 |
| `deleteMessage` 只遮蔽**它自己那一格**(后面的照旧在 surface 上) | §9.3 | `sessionCommandEvents.deleteMessage` |
| legacy 会话(不记账)一条都不写 | §9.3 | 三个方法开头的 `isSessionTranslationEnabled` |
| 写侧取材走抄本真相面,永不走随读模式分岔的门面 | §13.18 发现 B | 命令面的 `hasMessageInTranscript` / `findMessageFromTranscript`(整体翻面归 F3) |
| `SessionEventWriteError` 上抛,其余自吞 | §14.6 裁定 7 | `safely`(搬迁后一字未改) |

#### 三、"改没改成"的判据怎么接住

翻转之前,事件写不写由 reducer 的回执 `changed` 决定(`if (changed) translator.…`)。
翻转之后不能再等它 —— 等回执就是又把事件排到了 store 后面。所以命令面**自己先问一次
同一个问题**:

- `appendMessage`:reducer 的 `changed` **恒为 true**(`applyAppend` 无条件返回)——
  没有要问的,直接产出。
- `patchMessage` / `deleteMessage`:reducer 只有一个 false 的理由 ——
  `findIndex(item => item.id === messageId) === -1`。于是命令面在**同一份 store** 上问
  存在性,判据一字未变。
- `deleteMessage(matchMarker)`:**本来就是**先找后删(事件要写 id,而端口只返回布尔),
  F2-a 只是把事件从"删完之后"提到了"删之前"。

新增 `sessionReads.hasMessageInTranscript(sessionId, messageId)`(`reads.ts`)。
为什么不复用 `getMessageFromTranscript(...) !== undefined`:那一口会 `guard()` 一整条消息
(dev / vitest 下是**深冻结**),而 `patchMessage` 是逐 token 的热路径,每次补丁冻一条
带 steps/toolCalls 的消息不划算。存在性问答不把消息交出去,也就不需要冻。

#### 四、字节回归(U0 的方法:HEAD worktree 双跑)

一份**固定命令脚本**(17 条事件:`appendMessage` 四种分支含附件 / `run` 一对 /
三种 `patchMessage` 含 turnContext 与 ghost / `upsertMessage` 两支 / 三种 `deleteMessage` /
`truncateFrom` 两支 / `replaceAll` 两支 / `patchSession`),在同一份临时 store 上跑完,
把 `events.jsonl` 抄出来:

| 树 | 行数 | 原始字节 |
|---|---|---|
| HEAD `fc572b20`(worktree) | 17 | 3029 |
| F2-a(本树) | 17 | 3029 |

逐行比对(`time` 与随机 `runId` 归一后)**diffs 0 —— 逐字节相同**。归一前唯一的两处
差异就是那两个 uuid(`run/start` / `run/end` 的 `runId`)。临时用例与 worktree 已删除。

#### 五、用例

新文件 `packages/backend/session/__tests__/command-events-order.test.ts`(8 例),
harness 与 `write-side-visibility.test.ts` 同款(跑**真的**事件日志 / 投影 / surface,
替身只有最底下的会话仓库与 store 端口)。

**时序怎么钉**:store 端口(= reducer 那一步)**内部**回头 `peekSessionProjection` 看一眼
——事件真的先落了,那一刻投影里就已经有这次命令的结果。用 `peek`(不推进)而不是
`getLiveSessionProjection`(自己会 drain 尾巴),后者拿来断言等于什么都没钉住。

| 用例 | 钉住什么 |
|---|---|
| `翻译器不再认得 appendMessage / deleteMessage / patchMessage` | 产地唯一 —— 逐字断言翻译器上只剩那 6 个方法名 |
| `事件逐字段与翻转前相同` | `user/message` 的 `surfaceOp:'append'` + 整条消息;`message/patched` 的 `{messageId,patch}`;`message/deleted` 的 `surfaceOp{replace,2,2}` + `sourceEventSeqs[2]` |
| `正文 / 派生字段照旧不进 message/patched` | BODY_KEYS / DERIVED_KEYS 判例 |
| `那条消息不在 = 一条事件都不写` | 新判据与 reducer 的 `changed` 同源 |
| `appendMessage:store 端口被调到的那一刻,活投影里已经有这条消息` | 时序 1 |
| `patchMessage:补丁在 store 端口之前就落在活投影的那条节点上` | 时序 2(端口内读到 `patches:{u1:{steered:true}}`) |
| `deleteMessage(messageId):遮蔽先生效` | 时序 3 |
| `deleteMessage(matchMarker):先找、先记事件、后删 store` | 时序 4 |

既有四个用例文件的调用点随产地改名(`sessionEventTranslator.` → `sessionCommandEvents.`,
断言值一字未动):`event-translator.test.ts` / `write-side-visibility.test.ts` /
`event-write-failure.test.ts` / `event-translator-write-side-read.test.ts`。

**反证(实跑)**:把 `commands.ts` 里这三条的顺序倒回去(`reducer` 先、事件后,判据换回
`if (changed)`),四条时序用例**全红**;恢复后全绿。产地那四条不受顺序影响 —— 它们钉的
是另一件事。

#### 六、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run sessions:shadow-battery`(**F0 恒等门 = 本批主门**) | **GREEN** —— runs **321** / historyChecks 449 / mismatches **0** / duplicates 0 / appendFailures **0** / **refoldChecks 225 / refoldMismatches 0** / `session-shadow.jsonl` **0 行**;与 §16.5 / §16.6 逐项相同 |
| 字节回归(HEAD worktree 双跑) | 17 行 / 3029 字节,**diffs 0** |
| `bun run typecheck` | **0** |
| 定向 `backend/session` + `core/session` + `backend/wiring/engine` | **94 文件 / 818 测试全绿** |
| `packages/backend` 全包 | **280 文件 / 2380 通过**(1 文件 3 例 skipped,live provider) |
| `bun run boundary:gate` | ok — 0 failures |
| `bun run session:gate` | ok — 0 known, none new |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run transport:gate` | ok — 42 常量 / 四壳 2392 行,无上升 |
| 真机只读 `bun run sessions:verify:gate` | ok — 13 known issue(s), **none new**;全程只读,`~/.onething` 一字未写 |

#### 七、留账

1. **`hasMessageInTranscript` 这个名字里的 "Transcript" 与 §16.5 留账 1 是同一笔账** ——
   停写之后它读的是**内存 store**,不是抄本文件。改名连同 `get/find/listMessagesFromTranscript`
   一起**归 F3**(那一批本来就要把"写侧读抄本"整体翻面成读投影)。
2. **`createSessionCommands` 现在有两个可选事件端口**:`events`(已翻转的命令)与
   `translator`(没翻转的)。F2-b/c 每翻一条就从后者挪到前者;F2 走完 `translator` 只剩
   `sessionCreated` / `sessionCompacted` 两个**非命令**采集点,那时再决定它叫什么。
3. **`event-translator.ts` 里的 `translationRunId` 是死导出**(全仓零调用点)。本批未动
   —— 它与 F2 无关,清理留给 F4 的删码批。
4. **F2-b 的下一站**:`upsertMessage`(携 §13.18 的 existed 探测判例)与 `truncateFrom`
   (携双追加 / 占位替换判例);`replaceAll` / `compact` 排 F2-c(compact 携 §15 批 P 的
   遮蔽判例)。

### 16.8 F2-b 落地记录:upsertMessage / truncateFrom 翻成「命令即事件」(2026-08-27,opus 执行,未提交)

**一句话**:两条**带判据**的消息命令翻转产地 —— `upsertMessage`(存在性决定 append
还是 fullBody patch)与 `truncateFrom`(删除支 / 编辑重发支)。写下去的事件字节一字
未变(HEAD `40a8e6ad` worktree 双跑逐行比对,26 行 / 4438 字节,diffs 0),变的是谁先
说话。翻译器从 6 个方法削到 **4** 个,其中只剩 2 个还是命令。

#### 一、逐命令翻转表

| 命令 | 事件构造搬到哪 | 翻译器删了哪段 | 新执行序 |
|---|---|---|---|
| `upsertMessage` | `session/command-events.ts` → `sessionCommandEvents.upsertMessage`(逐字搬迁;两支照旧借道**同一份** `appendMessage` / `patchMessage({fullBody:true})`) | `event-translator.ts` 的 `upsertMessage` 方法整段删除 | 存在性判定 → `events.upsertMessage()` → `ports.messages.upsertMessage()` |
| `truncateFrom` | 同上 → `sessionCommandEvents.truncateFrom` + 新私有件 `editedMessage()` | `truncateFrom` 方法整段删除(连同它那个 `updatedMessage` 兜底参数) | 取材(编辑支)→ 存在性判定 → 取时刻 → `events.truncateFrom()` → `deleteMessageAndTruncate()` / `updateMessageAndTruncate()` |

**翻译器上现在只剩 4 个方法**:`replaceAll` / `patchSession`(还是命令,F2-c 翻)+
`sessionCreated` / `sessionCompacted`(**非命令**采集点)。用例逐字钉住这份名单。
`event-translator.ts` 因此不再 import `sessionReads` 与 `sessionCommandEvents` ——
它最后两处"写侧读消息"随这两条命令一起搬去了命令面。

#### 二、判例迁移清单(一条都没丢)

| 判例 | 出处 | 现在住哪 |
|---|---|---|
| upsert 的 existed 探测走**抄本真相面**:流中 assistant 在活投影里还没那一格,`getMessage` 的 fromEvents 岔口会误判成"新增"、把一条 patch 写成 `system/message` | §13.18 发现 B / §14.1 表 `commands.ts:209` | `commands.ts` 的 `hasMessageInTranscript`(同口同义,只是不把消息交出去、也就不必冻) |
| upsert 命中已有 = **整条换掉** → `message/patched` 的 `fullBody` 档,正文三件套照旧带上;安全边界在归约器的 `sanitizePatch`(assistant 节点仍剥正文) | §10.7 缺口 6 | `sessionCommandEvents.upsertMessage` 第二支 |
| upsert 未命中 = 与 `appendMessage` **同一条**构造(流中 assistant 一条都不写) | §9.3 | 同上第一支(直接调 `sessionCommandEvents.appendMessage`) |
| `truncateFrom{inclusive}` → `message/deleted` + replace 遮蔽"这条到末尾" | §13.1 A5 | `sessionCommandEvents.truncateFrom` 删除支 |
| `truncateFrom{!inclusive}` → `user/message-edited` + 同样的 replace,新节点接上 | §9.3 | 编辑支 |
| range / `sourceEventSeqs` 从**活 surface** 取,不用手数下标(压缩之后会错位) | §10.6 | `sessionSurface(...).rangeFrom(...)`,搬迁后一字未改 |
| 编辑重发的取材走抄本真相面,永不走随读模式分岔的门面(否则把编辑前的旧正文永久焊进 `user/message-edited.data.message`) | §13.18 发现 B / `commands.ts:275` 与翻译器 `:206` 的兜底 | `commands.ts` 的 `getMessageFromTranscript` —— **翻转之后它取的是编辑"前"那条**,理由见下 |
| `contentParts` 只在 payload **显式带了那个键**时才动(`null`/空 = 清空,键不在 = 一格不动) | core `applyTruncate` 的 `hasContentParts` | `command-events.ts` 的 `editedMessage()`,逐字镜像归约器 |
| 那条消息不在 = 一条事件都不写 | §9.3 | 命令面的存在性判定(见第三节) |
| legacy 会话(不记账)一条都不写 | §9.3 | 两个新方法开头的 `isSessionTranslationEnabled` |
| `SessionEventWriteError` 上抛,其余自吞 | §14.6 裁定 7 | `safely`(共用件,一字未改) |

**关于 replace 范围**:F1 之后活 surface 上多了 `tool/result` 这类格子,所以
`rangeFrom` 遮蔽得比 F1 之前更全。这是 F1 已拍定的行为、不是本批的副作用 ——
字节回归因此以 **F1 之后的 HEAD(`40a8e6ad`)** 为对照,而不是 F1 之前的老字节。

#### 三、"改没改成"的判据怎么接住

沿用 §16.7 第三节那条纪律:**命令面在写事件之前自己问一次同一个问题,问的是与
reducer 同一份 store**。

- `upsertMessage`:reducer 的 `changed` **恒为 true**(insert / replace 两支都
  `changed: true`)。所以这里的"存在性"不是"改不改得成",而是**分支判据** ——
  它同时回答 reducer 的 `findIndex === -1` 和事件的 append/patch 两档,于是只问一次。
- `truncateFrom`:reducer 只有一个 false 的理由 —— `applyTruncate` 的 `index === -1`。
  删除支单问一句存在性;编辑支的**底稿在不在**就是同一个答案,不再多问一次。

#### 四、裁定:编辑重发的时刻由命令决定(本批唯一的新接线)

`truncateFrom{inclusive:false}` 是十三条命令里**唯一一条由归约器合成消息字段**的 ——
`applyTruncate` 给被改写的那条盖 `target.timestamp = now`。翻转之前,翻译器在 reducer
**之后**把改好的那条整条读回来,所以事件与 store 上的 `timestamp` 天然是同一个数;
翻转之后事件排在前面,再各读一次表就**等于让恒等门去比两个时钟**(消息级 `timestamp`
是 `canonicalChatMessage` **参与比较**的字段 —— `DERIVED_CLOCK_KEYS` 只作用在
step / toolCall 那一层)。

裁定:**时刻由命令决定一次,同时喂给事件与 reducer**。落地是一格可选参数:

| 位置 | 改动 |
|---|---|
| `backend/session/commands.ts` | `SessionMessageCommandRuntime.updateMessageAndTruncate` 的 `options` 多一格 `now?: number`;`CreateSessionCommandsOptions` 多一格 `now?: () => number`(默认 `Date.now`,可注入是为了字节回归能在两棵树上跑出同一个数,与 `OnethingSessionMessageRuntime` 的 `options.now` 同款做法) |
| `runtime/src/sessions/session-message-runtime.ts` | 那一条命令的 `now: options?.now ?? this.now()` |

**没有碰 P0 冻结的引擎 store 端口**:`core/engine/stream-runtime.ts` /
`core/session/storage/types.ts` / `backend/stores/sessions.ts` 的
`updateMessageAndTruncate` 一字未动 —— 多出来的那格是可选的,老调用点走
`?? this.now()` 与从前逐字相同。`deleteMessageAndTruncate` **不加**这一格:
它的事件(`message/deleted`)里没有时刻。

#### 五、字节回归(U0 的方法:HEAD worktree 双跑)

一份**固定命令脚本**(26 条事件),在同一形状的临时 store 上跑完,把 `events.jsonl`
抄出来。覆盖面按工单点名逐项落实:

| 要覆盖的 | 脚本里的哪一步 | 落在账本上的 |
|---|---|---|
| 流中 upsert | 新增一条 `isStreaming` 的 assistant | **一条都不写**(`run/start` 才是它那一格) |
| settle upsert | 同一条 id 再 upsert 一次(落定) | `message/patched`(fullBody) |
| upsert 新增支 | upsert 一条没见过的 user | `user/message` |
| truncate 删除支 | `inclusive:true` | `message/deleted` + replace |
| truncate 编辑重发支 | `inclusive:false` ×3(带 contentParts / 不带 / 显式 `null`) | `user/message-edited` ×3 |
| replaced 导入支 | `replaceAll{reason:'replaced'}` | `session/cleared` + `message/imported` ×2 |
| (顺带)append 四支 / run 一对 / patch 三种 + ghost / delete 两式 / clear / normalize / patchSession | | 其余 12 条 |

| 树 | 行数 | 原始字节 |
|---|---|---|
| HEAD `40a8e6ad`(worktree) | 26 | 4438 |
| F2-b(本树) | 26 | 4438 |

逐行比对(`time` 与随机 `runId` 归一后)**diffs 0 —— 逐字节相同**。归一前唯一的差异
就是那两类墙钟 / uuid(实测:`time` 全行 + `run/start`/`run/end` 的 `data.runId`,
再无第三处)。三条 `user/message-edited` 的 `timestamp` 在两棵树上都是脚本注入的
那个固定值 —— 新树由命令递给 store 端口,HEAD 由 store 端口自取,**两边同数**,
正是第四节那条裁定的现场证据。临时用例与 worktree 已删除。

#### 六、用例

`command-events-order.test.ts` 从 8 例扩到 **17 例**(harness 不变;store 端口补齐
`upsertMessage` / `deleteMessageAndTruncate` / `updateMessageAndTruncate` 三口,
后者按归约器那一半真的改抄本 + 盖命令递来的时刻)。新增 9 例:

| 用例 | 钉住什么 |
|---|---|
| 名单(改写) | 翻译器上只剩 `patchSession` / `replaceAll` / `sessionCompacted` / `sessionCreated` **四个**方法名 |
| `那条消息不在 = 一条事件都不写`(补两行) | truncate 两支的 ghost 也一条不写 |
| `upsertMessage:流中 = 一条不写;落定 = fullBody 的 message/patched` | §14.1 的 existed 探测判例 |
| `upsertMessage:新增支写的就是 appendMessage 那一条` | 借的是同一份构造,不是复制一份 |
| `truncateFrom(regenerate):message/deleted 遮蔽"这条到末尾"` | replace 区间是 `{2,3}` 而不是它自己一格 |
| `truncateFrom(edit):底稿来自抄本,正文与时刻来自命令` | 事件 message 逐字段 + store 侧盖的是**同一个数** |
| `truncateFrom(edit):contentParts 只在显式带了那个键时才动` | 归约器镜像(不动档) |
| `truncateFrom(edit):显式 contentParts:null = 清空那一格` | 归约器镜像(清空档,断言的是**键不在**) |
| 时序三例(upsert / truncate 删除支 / truncate 编辑支) | store 端口进门那一刻,活投影上已经是这次命令的结果 |

既有三个用例文件的调用点随产地改名(断言值一字未动):`event-translator.test.ts`
(两条 truncate 例)、`write-side-visibility.test.ts`(一条,并删掉已无用的翻译器
import)、`event-translator-write-side-read.test.ts`。最后一个的**判例语义随翻转而变**:
从前它问"翻译器有没有读到 reducer 落定后的新正文/新时刻",翻转之后正文与时刻都由命令
自己产出,还能问的是**底稿从哪儿来** —— 所以它改成走真的命令面(mock 补齐命令面那几
口生产接线),让抄本与滞后投影在 `model` 那一格上故意分岔,断言事件里是抄本那一份。

**反证(实跑)**:把 `commands.ts` 里这两条的顺序倒回去(reducer 先、事件后,判据
换回 `if (changed)`),**三条时序用例全红**(`upsertMessage` / `truncateFrom` 两支);
恢复后全绿(倒序那一跑是 `14 passed | 3 failed`)。产地那十条不受顺序影响 ——
它们钉的是另一件事。

#### 七、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run sessions:shadow-battery`(**F0 恒等门 = 本批主门**) | **GREEN** —— runs **321** / historyChecks 449 / mismatches **0** / duplicates 0 / appendFailures **0** / **refoldChecks 225 / refoldMismatches 0** / `session-shadow.jsonl` **0 行**;与 §16.5 / §16.6 / §16.7 逐项相同 |
| 字节回归(HEAD `40a8e6ad` worktree 双跑) | 26 行 / 4438 字节,**diffs 0** |
| `bun run typecheck` | **0** |
| 定向 `backend/session` + `core/session` + `backend/wiring/engine` | **94 文件 / 827 测试全绿**(§16.7 是 818,+9 = 本批新例) |
| `packages/backend` 全包 | **280 文件 / 2389 通过**(1 文件 3 例 skipped,live provider);连跑 3 次全绿 |
| `bun run boundary:gate` | ok — 0 failures |
| `bun run session:gate` | ok — 0 known, none new |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run transport:gate` | ok — 42 常量 / 四壳 2392 行,无上升 |
| 真机只读 `bun run sessions:verify:gate` | ok — 13 known issue(s), **none new**;全程只读,`~/.onething` 一字未写 |

#### 八、留账

1. **`session:gate` 当场拦了一次,拦得对**。`editedMessage()` 第一版是"复制一份再逐格
   赋值 + `delete`",四条规则 B 命中(消息字段赋值只允许在 core reducer 里)。改成
   **纯构造**(展开 + 条件展开;清空那一档先把键从底稿上解构掉)后归零。这条纪律与
   F2 并不冲突:命令面算的是"要写进事件的那一份",本来就不该改任何一条在册的消息 ——
   何况 `before` 是只读的(dev / vitest 下深冻结)。
2. **`upsertMessage` 丢掉了 `if (changed)` 这层壳,但没丢判据**:reducer 的 `changed`
   对 upsert 恒为 true,端口那个布尔只在**整条会话不在**时才是 false。那种情形下现在
   会多写一条 `user/message` / `system/message` —— 而这**正是 F2-a 的 `appendMessage`
   已经接受的同一个洞、同一条事件**(insert 支在 reducer 那边也是同一个 `applyAppend`)。
   两条命令口径一致,不新开例外;真要堵,堵在 F2-c/F4 一次堵掉两条。
3. **`hasMessageInTranscript` / `getMessageFromTranscript` 的名字问题照旧归 F3**
   (§16.7 留账 1):停写之后它们读的是内存 store,不是抄本文件。本批新增的两处取材
   用的是同一对口,改名时一起改。
4. **`event-translator.ts` 的 `translationRunId` 仍是死导出**(§16.7 留账 3),本批
   未动。
5. **F2-c 的下一站**:`replaceAll`(携 G11 的 cleared + 逐条 imported 判例)与
   `sessionCompacted`(携 §15 批 P 的遮蔽判例、§13.2 的锚点解不出退化告警),外加
   §15.6 裁定的**必做项** —— 工具自报结局 `annotate` 拿到自己的事件产地。走完这一批
   `translator` 上只剩 `sessionCreated` / `sessionCompacted` 两个非命令采集点,
   §16.7 留账 2 说的"那时再决定它叫什么"就到期了。

### 16.9 F2-c 落地记录:命令翻转收官 + 翻译器退役 + `annotate` 拿到产地(2026-08-27,opus 执行,未提交)

**一句话**:最后两条命令(`replaceAll` / `patchSession`)翻成「命令即事件」,两个
**非命令**采集点(`session/created` / `session/compacted`)搬进按角色命名的新家
`lifecycle-events.ts`,`event-translator.ts` **整个文件删除**;同一批给工具自报结局
一个自己的事件产地(新事件 `tool/annotate`),补上 §15.6 裁定的必做项,并顺手堵掉
F2-a/F2-b 留账的那个洞(「整条会话不在」时照写事件)。命令那一半的事件字节一字未变
(HEAD `aee4fcb2` worktree 双跑,31 行 / 5049 字节,diffs 0);annotate 那一半是
**纯增行**(逐条列在第六节),既有的每一行一字未动。

#### 一、逐条收官表

| 命令 / 采集点 | 事件构造搬到哪 | 新执行序 |
|---|---|---|
| `replaceAll` | `session/command-events.ts` → `sessionCommandEvents.replaceAll`(逐字搬迁) | 会话存在性(命令第一句本来就在问)→ `events.replaceAll()` → `ports.messages.replaceAllMessages()` |
| `patchSession` | 同上 → `sessionCommandEvents.patchSession`(逐字搬迁) | 取 `before`(快照 + 判据一次取材)→ `events.patchSession()` → `ports.patchSession()` |
| `session/created` | **新文件** `session/lifecycle-events.ts` → `sessionLifecycleEvents.sessionCreated` | 不变(它本来就是这份日志的第一条,会话目录由它建,B4) |
| `session/compacted` | 同上 → `sessionLifecycleEvents.sessionCompacted` | 不变(压缩结局落到消息上之后) |

**为什么后两条不叫"翻转"**:它们不是命令 —— 没有哪条 `sessionCommands.<cmd>` 对应
它们,也从来不是从 store 的 mutation 反推出来的:调用方(`stores/sessions.ts` 的
`createSession`、`wiring/engine/context-compact.ts` 的成功/失败两条收尾路)本来就是
把事实直说给它。所以这一步只是**改名字与住址**,行为一字未动。§16.7 留账 2 说的
"那时再决定它叫什么"到期了,答案是:文件名说实话 —— 命令的产地叫
`command-events.ts`,非命令的生命周期采集点叫 `lifecycle-events.ts`。

**`patchSession` 有三个产地,共用同一份构造**(§13.10 M7):命令面(翻转后事件在
reducer 之前)、`stores/sessions.ts` 的 `updateSessionAgent`、server 的
`sessions.update`。后两条**绕开命令面**,而且必须留在写成功之后 —— 它们的 `to` 取的是
**落库之后**那一格(agent 那一格在仓库里带着"空值回落默认 agent"的规范化;server
那条路的会话对象是就地改的)。所以 `sessionCommandEvents.patchSession` 对"谁先说话"
中立:它拿的是调用方算好的 `patch` 与 `before`,顺序由调用方的事实决定。

#### 二、翻译器退役清单

| 动作 | 落地 |
|---|---|
| 删文件 | `packages/backend/session/event-translator.ts`(204 行)整体删除 —— **不留纯类型/常量残留**:全仓零依赖(六个 import 点全部改指新家),`translationRunId` 这个死导出(§16.7 留账 3 / §16.8 留账 4)随文件一起消失,F4 删码批少一笔 |
| 删导出键 | `packages/backend/package.json` 的 `"./session/event-translator.js"` 换成 `"./session/lifecycle-events.js"` |
| 改调用点(6 处) | `session/commands.ts`(整条 `translator` 可选端口删掉)、`stores/sessions.ts` ×2(`sessionCreated` → lifecycle,`updateSessionAgent` 的 patchSession → command-events)、`server/runtime.ts` ×1、`wiring/engine/context-compact.ts` ×2 |
| 改用例文件名 | `event-translator.test.ts` → `event-production.test.ts`;`event-translator-write-side-read.test.ts` → `event-production-write-side-read.test.ts`(断言值一字未动,只换产地名) |
| 名单用例改判据 | 从"翻译器上只剩这几个方法名"改成 **①`event-translator.ts` 这个文件不存在**(`fs.existsSync`)+ **②两份产地名单逐字钉住**:`sessionCommandEvents` 七个方法(appendMessage / deleteMessage / patchMessage / patchSession / replaceAll / truncateFrom / upsertMessage)、`sessionLifecycleEvents` 两个(sessionCompacted / sessionCreated) |
| 扫尾注释 | 三处指名道姓引用这个文件的注释改指新家(`session/read-mode.ts`、`core/session/projection/surface.ts`、`wiring/engine/stream/history-shadow.ts`) |

#### 三、堵洞裁定:「整条会话不在」时一条事件都不写

F2-a/F2-b 各留了一笔同样的账(§16.8 留账 2):`appendMessage` / `upsertMessage` 的
reducer **恒为"改得成"**,唯一改不成的情形不是"那条消息不在",而是**整条会话不在**
—— `OnethingSessionMessageRuntime.run` 取不到 session 就整条 no-op。翻转之后命令面
不再等回执,于是"往一条不存在的会话追加消息"会在账本上留下一条 `user/message`,
而 store 上什么都没有。

**裁定:一条事件都不写。** 理由与 §9.3 的"只写事实"同一条 —— 事件账本记的是发生过
的事,不是意图;而"会话都不在"连意图都算不上。落地是 `sessionReads` 上一口新的
存在性问答:

```
hasSessionInTranscript(sessionId) = getSessionMessages(sessionId) !== undefined
```

与 reducer 的判据**同源同义**(`run()` 取不到 session 就整条 no-op),而且与
`hasMessageInTranscript` 同一口井(抄本真相面,§13.18 发现 B)、同样不把消息交出去
所以不必冻。三条命令口径一致:

| 命令 | 判据 | 为什么是这一条 |
|---|---|---|
| `appendMessage` | 会话在不在 | reducer 的 `applyAppend` 恒返回 changed |
| `upsertMessage` | 会话在不在(再问消息在不在,分 append / fullBody patch 两档) | 同上,两支都 `changed: true` |
| `patchSession` | 会话在不在 | `applyMetadataMutation` 唯一的 false 理由;而命令面本来就要取 `before` 算快照 —— **一次读、两个用途**,不多问一次 |
| `replaceAll` | 会话在不在 | 判据本来就在命令第一句(`ports.getSession` 取不到就直接返回) |

#### 四、`annotate` 的产地:新事件 `tool/annotate`

**病历(§15.6)**:工具自报结局 —— `ctx.emit({type:'annotate', title, details})` ——
今天只落 store(引擎 `applyAgentLoopToolMetadata` 当场盖掉 `step.title` /
`step.result`)。事件账本里它**没有产地**:记录器只把它攒在内存表
(`reportedTitleByCallId` / `changesByCallId`)里,等 `tool/result` 落账时顺带写出去。
退出竞速(Cmd+Q → abort → 收尾链挂在异步上,进程先走了)一来,那条 `tool/result`
永远不会来,两格永久消失 —— `a5157107` 的「提问已取消」就是这么丢的。full 之下停写
`messages.jsonl` 后,这一格从"偶发丢文案"恶化成"永久折不出"。

**选型(为什么是新事件而不是 `tool/result` 上加一格)**:`tool/result` 那条行本身就
是可能永远不出现的那一条 —— 把自报结局挂在它身上等于把救生圈绑在正在沉的船上。
所以新增一类:

```ts
tool/annotate { callId, runId?, title?, result?: {text} | {blob} }
```

采集点是**annotate 的 emit 链上侵入最小的那一处**:记录器已有的
`case 'tool-metadata'`(agent-loop 把 `ctx.emit({type:'annotate'})` 投影成的那条流
事件)。工具说一次,账本记一条。

**结局正文过引擎那把判定点,不在采集点重写规则**:`applyAgentLoopToolMetadata` 里
"`metadata.output` 是字符串就用它,否则整份 metadata 的 JSON"这条规则提成
`core/engine/tool-orchestration.ts` 的 `resultTextFromToolMetadata`,引擎与记录器
**共用同一份**(与 §13.17 的 `changesFromToolMetadata` 同款纪律;引那一个叶子文件而
不是执行器 barrel,记录器的模块图不被撑开)。执行器那边是纯提取,行为逐字未变。

**投影侧**(`core/session/projection/reducer.ts`):

| 格 | 规则 |
|---|---|
| `ToolState.reportedTitle` | `tool/annotate.title` 与 `tool/result.reportedTitle` **两个产地写同一个值**,最后一条赢(与引擎逐字相同的覆盖规则)。老账本只有后者 |
| `ToolState.annotatedText` / `annotatedBlob` | 新增两格,`tool/annotate.result` 折进来(与结局正文同一条 64KB 线,超了走 blob,物化时由同一个 resolver 换回来) |
| `step.result` | **结局优先**:`tool/result` 在场就用它(引擎那边也是收尾覆盖);缺席时(以及 R-a 的合成中断结局把它压掉时)退到自报的那一份 |
| `step.error` | 自报的那一份与 `cancelled` 同类 —— 引擎那一刻在 step 上写的正是**两格并存**(`result` 是执行途中自报的,`error` 是收场那句话)。所以"有正文就不写 error"这条只对**结局**那一份成立;判据从 `!hasResultText \|\| cancelled` 放宽到再或上"正文来自自报" |
| `toolCall.result` | **一格都不动**:引擎的 annotate 只写 step,不写调用那一格 |

**大小的价钱,以及怎么收的**:自报结局里可能带着上百 KB 的 diff / 命令输出
(edit 的 `metadata` 含截断后的 diff + hunks,上限 2000 行 / 200KB)。三条纪律把它
按住:①与 `tool/result` **同一条 64KB 线**(`textOrBlobForEvent`,超了走内容寻址
blob,同一份 metadata 说两次只占一份字节);②**逐字相同的正文不再写第二遍**
(记录器新增 `annotatedResultByCallId` 备忘录;edit 收尾那两条 annotate 只差一个
标题,第二条因此只写 title);③标题照旧每条都写 —— 它便宜,而且它才是 §15.6 里丢掉
的那一格。实测代价见第六节。

**向后兼容(§10.16 成对交付)**:老账本没有这一类事件 → 那两支一次都不触发,投影
与修复前逐字相同(占位标题、没有结局正文)。合同里有一条 `§16.9 fallback` 专门钉
这个等式。

#### 五、§13.8「采集点不二次派生」裁定重审

**原裁定**(§13.8 第一类,`captureCancelledToolResults`):"**不在这里第二次派生任何
一格**(§10.10)"——它禁的是:收场那一刻**从收尾结果反推**再造一份结局
(哪几次调用还没有结局由记录器的 `callSeqByCallId` 说了算;标题取
`reportedTitleByCallId`,与正常那条 `tool/result` 同源)。病根是 §10.10 那类
"fixture 自己写下了结论"的空转 —— 采集点凭自己的推理造出一格账本上本来没有的
事实,两边就再也对不上了。

**新裁定(2026-08-27,F2-c)**:**工具自报结局是第一手事实,采集它不违反原裁定
精神。** 三条理由:

1. **说话的人不同**。`annotate` 是**工具自己**在执行途中说的一句话,不是任何人从
   别的东西推出来的。采集它 = 把一句已经说出口的话记下来;原裁定禁的是"没人说过
   的话由采集点替它说"。
2. **判定点仍然只有一个**。结局正文过的是引擎写消息时用的**同一个函数**
   (`resultTextFromToolMetadata`),不是采集点自己写的第二份规则 —— 这正是 §13.17
   给 `changes` 定下的做法("抄引擎写消息的**同一把**判定点折出")。
3. **原裁定的那条路一个字都没改**。`captureCancelledToolResults` 照旧不二次派生;
   `tool/annotate` 是另一条独立的、更早的产地。两条并存时结局优先(第四节的表),
   所以既有的 §13.8 判例一条都没动。

**边界(重申)**:采集点可以记"某人说过的话",不可以记"我推出来的结论"。判断标准
是**这句话在别处有没有产地** —— 有,就抄同一把判定点;没有,就是二次派生。

#### 六、字节回归(U0 的方法:HEAD worktree 双跑,两半分开做)

**A. 命令那一半(要求逐字节相同)**。一份固定命令脚本走完十三条命令 + 两个生命周期
采集点(31 条事件):`sessionCreated` / append 四支(user / system / 流中 assistant
不写 / 带附件)/ run 一对 / patch 三种 + ghost / upsert 两支 / delete 两式 /
truncate 三支(带 contentParts、不带、inclusive)/ replaceAll 三支(normalize 不写、
replaced、clear)/ patchSession 三格 / **compact 两支**(占位→completed 带 replace、
占位→failed 只 append)。两棵树跑在同形状的临时 store 上:

| 树 | 行数 | 原始字节 |
|---|---|---|
| HEAD `aee4fcb2`(worktree) | 31 | 5049 |
| F2-c(本树) | 31 | 5049 |

逐行比对(`time` 与随机 `runId` 归一后)**diffs 0 —— 逐字节相同**。

**B. annotate 那一半(只增不改,逐条列出)**。一份固定记录器脚本(bash 正常收尾两条
annotate + edit 收尾三条 annotate + ask_user 的退出竞速一条 annotate),两棵树对拍:

| 树 | 行数 | 原始字节 |
|---|---|---|
| HEAD `aee4fcb2` | 11 | 2547 |
| F2-c(本树) | 17 | 3760 |

差异**全部是插入**,既有的 11 行一字未动(`tool/result` 的 `reportedTitle` /
`changes` / `resultData` 逐字段相同)。新增的 6 行逐条:

| 新增 | 内容 | 说明 |
|---|---|---|
| ×2(bash) | `{callId:call-1, title:'echo hi', result:{text:'{...exitCode:-1,output:""}'}}` / `{... exitCode:0, output:'hi'}` | 工具说了两次,记了两条 |
| ×3(edit) | `{title:'Editing a.ts', result:{...diff:""}}` / `{result:{...完整 diff}}`(**无 title**) / `{title:'Edited a.ts'}`(**无 result**) | 第三条命中去重:与上一条正文逐字相同,只补标题 |
| ×1(ask_user) | `{title:'提问已取消', result:{text:'{"interaction":"ask_user","outcome":"aborted"}'}}` | **这一条就是 §15.6 病历里永久丢掉的那一格** |

这个脚本是刻意的 annotate 密集形状(6 条 annotate / 3 次调用),真实会话里的比例远低
于此;去重那一格把 edit 这类"同一份大 metadata 说两次"的最坏情形按住了。临时用例与
worktree 已删除。

#### 七、用例

| 文件 | 新增 | 钉住什么 |
|---|---|---|
| `session/__tests__/command-events-order.test.ts` | 17 → **24** 例 | 产地名单换判据(翻译器**文件**不存在 + 两份名单逐字);`replaceAll` 三支判例;`patchSession` 三格判例 + 会话不在;**堵洞**:append / upsert 在"整条会话不在"时一条不写;时序两例(`replaceAll(clear)` 遮蔽先生效、`patchSession` 事件先折进活投影的 `sessionMeta`) |
| `wiring/engine/stream/__tests__/session-event-recorder.test.ts` | 29 → **31** 例 | `tool/annotate` 逐字段(title + 过引擎判定点折出的 result + runId);去重那一格(同一份 metadata 只写一次 result,标题照写) |
| `core/session/__tests__/projection-contract.test.ts` | 78 → **83** 例(新 `describe('§16.9')`) | 退出竞速形状(只有 annotate、没有 `tool/result`)仍折得出 title + result,且 `error` 与它**两格并存**;最后一条 annotate 赢;`tool/result` 一到以结局为准;合成的中断结局不遮住自报那一份;**§16.9 fallback**:老账本没有这类事件 = 占位标题、没有结局正文 |
| `core/session/__tests__/session-event-codec.test.ts` | 覆盖率自检 +1 | 新类型进 round-trip 名单(双向穷尽守卫要求的那一行) |

`event-production.test.ts` / `event-production-write-side-read.test.ts` 只改了产地名与
文件名,断言值一字未动。

**反证(全部实跑)**:

| 改回旧写法 | 变红 |
|---|---|
| `replaceAll` / `patchSession` 的顺序倒回去(reducer 先、事件后,判据换回 `if (changed)`) | **2 条时序用例**(其余 22 条不受顺序影响 —— 它们钉的是另一件事) |
| 投影不认 `tool/annotate` 的结局正文(`annotatedText` 恒 undefined) | **3 条**(退出竞速 / 最后一条赢 / 合成中断结局不遮住) |
| 记录器不写 `tool/annotate` | **2 条**(产地两例) |

#### 八、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run sessions:shadow-battery`(**F0 恒等门 = 本批主门**) | **GREEN** —— runs **321** / historyChecks 449 / mismatches **0** / duplicates 0 / appendFailures **0** / **refoldChecks 225 / refoldMismatches 0** / `session-shadow.jsonl` **0 行**;与 §16.5–§16.8 逐项相同(第一跑 refoldChecks 报 224,复跑 225 —— 那一格是**采样次数、不进门**,它的跳过闸是"文件末条 seq == 定格游标"这条竞态守卫,annotate 多写几行就更容易撞上;两跑 refoldMismatches 都是 0) |
| 字节回归 A(命令,HEAD `aee4fcb2` worktree 双跑) | 31 行 / 5049 字节,**diffs 0** |
| 字节回归 B(annotate,同上) | 11→17 行 / 2547→3760 字节,**全部是插入,既有行一字未动**(逐条列在第六节) |
| `bun run typecheck` | **0** |
| 定向 `backend/session` + `core/session` + `backend/wiring/engine` | **94 文件 / 841 测试全绿**(§16.8 是 827,+14 = 本批新例) |
| `packages/backend` 全包 | **280 文件 / 2398 通过**(1 文件 3 例 skipped,live provider);第一跑 `sessions-delete-cascade` 1 例并发抖动,单跑 3/3 绿、复跑全包全绿 |
| `bun run boundary:gate` | ok — 0 failures |
| `bun run session:gate` | ok — 0 known, none new |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run transport:gate` | ok — 42 常量 / 四壳 2392 行,无上升 |
| 真机只读 `bun run sessions:verify:gate` | ok — 13 known issue(s), **none new**;全程只读,`~/.onething` 一字未写(跑完 `find -newermt '-10 minutes'` 零命中) |

#### 九、留账

1. **F2 走完了,`translator` 这个词从代码里消失了**。命令的事件产地只有
   `command-events.ts` 一处,非命令的生命周期采集点只有 `lifecycle-events.ts` 一处;
   工具链上的采集点仍在 `wiring/engine/stream/session-event-recorder.ts`
   (`tool/annotate` 就是本批加在那里的)。
2. **`hasMessageInTranscript` / `getMessageFromTranscript` / 新加的
   `hasSessionInTranscript` 名字里的 "Transcript" 照旧归 F3**(§16.7 留账 1 /
   §16.8 留账 3):停写之后它们读的是内存 store,不是抄本文件。三口一起改名。
   → **已办**:§16.10 第三节,五口一次改完(`*FromStore` / `*InStore`)。
3. **账本变大了,而且这是有意的**。`tool/annotate` 让 edit / bash 这类 metadata 大的
   工具每次调用多 1–3 行。这是把"工具自报结局"从**只在 store**变成**两侧都有**的
   价钱 —— 换来的是 full 之下这一格折得出来,以及恒等门从此**比得到它**
   (§13.8 第一类的两条真机病历现在有两条独立的路都能对上)。真机浸泡时值得盯一眼
   `events.jsonl` 的增长曲线;真要再压,下一刀在"结局正文与 `changes` 的重叠"
   (同一份 diff 今天在 annotate 与 `tool/result.changes` 里各存一份),那是 F4
   删码批的事,不是现在。
4. **`resultTextFromToolMetadata` 与 `buildToolMetadataStepUpdate` 仍是两份**:后者是
   **旧编排器**那条路上的近亲(它没有 `Object.keys > 0` 那道闸,`{}` 会折出
   `"{}"`),本批没有并它 —— 并它是行为改动,而它在生产里没有构造点。F4 删码批一起收。
5. **F3 的下一站**:§14.1 的 9 处写侧回读残留整体翻面成读投影;F2-c 新加的那口
   `hasSessionInTranscript` 与既有两口一起翻。
   → **已办(§16.10,2026-08-27),但结论与这句预期不同**:纪律翻面了,**取数面
   一处没翻** —— 逐处复核后每一处都露出一条 F1 修不了的新理由(三类具名例外),
   其中两类做过反证。五口改名一次做完(`*FromStore` / `*InStore`)。

### 16.10 F3 落地记录:写侧回读换语义 + 名字说实话(2026-08-27,opus 执行,未提交)

**一句话**:§13.18 那条「写侧取材**一律**读抄本」的**理由**在 F1 之后就死了(投影不再
滞后),所以本批把它从**一刀切**改成**具名例外表**;逐处复核之后 —— **代码取数面
一处未动,而且每一处的"不动"都换了新理由、其中两类做过反证**。真正改掉的是纪律文本
与那五口的**名字**(`*FromTranscript` / `*InTranscript` → `*FromStore` / `*InStore`:
抄本停写之后它们读的是**内存 store**,不是 `messages.jsonl`)。

#### 〇、先说结论:为什么"全留"不是偷懒

§16.2 的 F3 行原话是"§14.1 的 9 处写侧回读残留**全部改读 fold 后投影**"。以 HEAD
实况重列之后,这句话要分成两半看:

- **一半早就做完了,不在本批**:§14.1 表里 `reads.ts` 各 routed 方法右边那排
  `?? getSessionMessages(...)` 兜底,在批 6b(§15.22)就删掉了 —— 写侧凡是走
  `listMessages` / `getMessage` / `findMessage` 的取材点(§15.18 核对结论里那
  "routed 但不构成地板"的一批),**今天读的已经就是活投影**,一行都不用再改。
- **另一半改不动,而且是好事**:剩下真正读 store 的那些点,原来挂的理由都是
  §13.18 的"投影滞后"。本批逐处追问"F1 之后这条理由还成立吗",答案是**都不成立**
  —— 但每一处底下都露出了**另一条 F1 修不了的理由**。它们不是同一个问题,所以
  归成三类,逐口写进代码。

**三类具名例外**(取代原来那条一刀切纪律):

| 类 | 是什么 | 为什么 F1 修不了 | 解冻时机 |
|---|---|---|---|
| **① 判据同源** | 命令面的存在性探测与编辑底稿 | 它回答的不是"账本上有没有",是"**这次命令改不改得成**" —— 而"改成"的那一侧是 reducer,reducer 问的是 store。两侧同判据,写事件与改 store 才不会一边发生一边不发生 | **F4**(reducer 退役,两条推导合一) |
| **② 事件产地缺口** | 流中 assistant 占位在账本上**没有那一格** | `appendMessage` 对 `isStreaming` 的 assistant 一条事件都不写(`run/start` 才是它的产地),而这两处读的产物**正是那条 `run/start`**。这是"还不存在",不是"滞后" | 给流中 assistant 开产地那天(未排期) |
| **③ 只在 store 的运行时形状** | 收尾链的 `steps[]` 结局、`contentParts` 上的 `data-steps` 渲染锚点 | `steps` 在 `DERIVED_KEYS` 里、从不进消息事件;锚点投影**故意不产出**(canonical G4 丢弃比较)。投影侧那几格是 `tool/*` 物化的,而收尾这次要写的**正是**那几条 `tool/result` | §14.5 双存移除 / F4 |

另有 **F0 验证器纪律**(`shadow.ts` / `history-shadow.ts`):恒等门的验证器侧永远是
store,**本批按令未动**。

#### 一、逐处改 / 留表(HEAD 实况重列,行号为本批之后)

**A. 已经在读活投影 —— 无代码改动(§15.18 那批"routed 但不构成地板")**

| 位置 | 读什么 | 一行理由 |
|---|---|---|
| `wiring/engine/stream-engine-runtime.ts:68/70` | core 引擎 store 端口的 list/get | 批 6b 删兜底后 routed = 投影唯一路;读发生在 `run/start` 之后,折得出 |
| `wiring/engine/stream/agent-loop-runtime.ts:207/269` | 回合内重建历史 / turnContext | 同上 |
| `wiring/engine/stream/agent-loop-executor.ts:774` | resume 占位 | 同上(resume 时那条 assistant 已有产地) |
| `wiring/engine/stream/agent-loop-executor.ts:886` | 收场快照映射 | 同上 |
| `wiring/engine/stream/tool-orchestrator.ts:120` | 摘工具残留 | 同上 |
| `wiring/engine/stream/tool-execution.ts:126` | 工具执行取消息 | 同上 |
| `wiring/engine/context-compact.ts:90/304` | 压缩取历史 | 同上 |
| `wiring/engine/triggers/session-toc.ts:44/122` | TOC 触发器取末条 | 同上 |
| `session/validation.ts:66` | 活动消息校验 | 同上 |

**B. 仍读 store —— 逐处留,各带具名理由**

| 位置 | 读什么 | 类 | 一行理由 |
|---|---|---|---|
| `session/commands.ts:255` | `appendMessage` 的会话存在性 | ① + **投影答不出** | 投影对"零事件的会话"与"不存在的会话"给同一个答案,而这道判据要分的正是这两者 |
| `session/commands.ts:278` | `upsertMessage` 的会话存在性 | 同上 | 同上 |
| `session/commands.ts:279` | `upsertMessage` 的 `existed` 探测 | ① | 与 reducer 的 `findIndex === -1` 同一份 store、同一个判据;它同时决定事件分 append / `fullBody` 两档 |
| `session/commands.ts:297` | `patchMessage` 存在性 | ① | 同上;另加一笔热路径账:投影侧最便宜的存在性口 `eventsGetMessage` 每次物化**整条会话** |
| `session/commands.ts:358` | `truncateFrom(edit)` 的底稿 | ① | 底稿同源:reducer 的 `applyTruncate` 拿 store 那条改,事件里 `data.message` 必须与它逐字同源,否则恒等门比两份形状不同的底稿 |
| `session/commands.ts:360` | `truncateFrom(regenerate)` 存在性 | ① | 同 `patchMessage` |
| `session/commands.ts:390` | `deleteMessage{messageId}` 存在性 | ① | 同上 |
| `session/commands.ts:398` | `deleteMessage{matchMarker}` 找目标 | ① | 下一行 `deleteMessageWhere` 的 reducer 在同一份 store 上跑同一个谓词,两边找到的必须是同一条 |
| `wiring/engine/stream/stream-executor.ts:199` | `run/start` 前读助手占位 | ② | 读的产物正是那条 `run/start`;此刻账本上没有这一格。**反证见第二节** |
| `wiring/engine/stream/agent-loop-executor.ts:256` | steer 换锚点(上一处的孪生) | ② | 同上 |
| `wiring/engine/stream/agent-loop-executor.ts:533` | `captureCancelledToolResults` | ③ | 收尾修复写在 `steps[]` 上,而这次采集要写的正是那几条 `tool/result` —— 读投影则读空、采集不触发、账本缺账 |
| `wiring/engine/stream/agent-loop-executor.ts:578` | 收尾修复 read-modify-write | ③ | 要回落的是 `steps[]`(不进事件);读投影会拿到占位标题,把引擎写好的自报标题抹掉 |
| `wiring/engine/stream/agent-loop-executor.ts:629` | `completeAgentLoopStream` settle 快照 | ③ | store 那份 contentParts 带 `data-steps` 渲染锚点,投影故意不产出 —— 换掉就是 §15.16「正文看不见」的同一根引信 |
| `session/shadow.ts:369/446` | 恒等门验证器侧 | **F0 纪律** | 按令未动:验证器侧永远是 store,不许经过投影(否则两侧同源,门以错误的理由变绿) |
| `wiring/engine/stream/history-shadow.ts:70` | history 恒等门验证器侧 | **F0 纪律** | 同上 |

**C. 杂用(§14.1 表最后一行)—— 留,且本就不是"写侧回读"**

| 位置 | 读什么 | 一行理由 |
|---|---|---|
| `rpc/domains/sessions.ts:174` | `store.getSessionMessages(id) === undefined` | 正文早已走 `listMessages`(投影);这一句只借仓库的 `undefined` 还原 NOT_FOUND 契约 —— 与 B 表第一行同一个"投影答不出会话在不在" |
| `server/runtime.ts:3129` | server 自己的 `readMessages` | server 端另一只仓库,不经过桌面读门面,不在本批口径内 |
| `stores/sessions.ts:842` | `clearSessionMessages` 的 `clearedCount` | 清空**之前**的计数,取的是即将被 `replaceAll` 换掉的那一份;返回值给调用方看,不进账本 |

#### 二、两次反证(这一批的判据,不是嘴上说的)

改与不改都要能证伪,所以两类例外各做了一次**真的把它改过去**再跑门:

| 反证 | 做法 | 结果 |
|---|---|---|
| **② 事件产地缺口** | 把 `stream-executor.ts` 与 `agent-loop-executor.ts` 两处孪生取材点换成 routed 的 `getMessage`,跑 `sessions:shadow-battery` | **RED —— runs 16 / mismatches 305**。失配形状正是缺口:assistant 的 `origin` **整格缺失**(`A(events): (absent)` / `B(store): {receivedAt, resolvedIdentity…}`)、`timestamp` 差 3ms(占位读不到 → `run/start` 自己取了个时钟)。**这一处翻不动是被门证明的,不是被注释声称的** |
| **① 判据同源** | 把命令面四个**消息级**判据(upsert existed / patch / truncate / delete)同时接上 store 与投影两条答案、逐次比对并记录分岔,跑整轮 battery | **321 run / 0 次分岔**。也就是说:投影**答得对**,今天换过去不会错 —— 但换过去也**没有收益**,反而丢掉"与 reducer 同判据"这条性质、并给逐 token 的热路径加一次整会话物化。所以判定是**留到 F4**(reducer 退役那天两侧合一,这一口跟着退役),而不是"投影不可信" |

> 口径提醒:第二次反证是**测量**不是改动,探针跑完即删,未入库。

#### 三、改名对照表(全仓同步)

抄本(`messages.jsonl`)自批 6a 停写、批 6b 删码之后,这五口读的是**内存 store**,
名字里的 "Transcript" 早已名不副实(§16.5 留账 1 / §16.7 留账 1 / §16.8 留账 3 /
§16.9 留账 2 点名的那笔账,本批一次结清)。命名与既有 `eventsListMessages` /
`listMessages`(投影面)对仗:**读 store 的带 `Store` 字样**。

| 旧名 | 新名 | 取数面(一字未变) |
|---|---|---|
| `listMessagesFromTranscript` | **`listMessagesFromStore`** | `getSessionMessages(sessionId) ?? []` |
| `getMessageFromTranscript` | **`getMessageFromStore`** | `getSessionMessages(...)?.find(id)` |
| `findMessageFromTranscript` | **`findMessageFromStore`** | `getSessionMessages(...)` + 谓词 |
| `hasMessageInTranscript` | **`hasMessageInStore`** | `getSessionMessages(...)?.some(id)` |
| `hasSessionInTranscript` | **`hasSessionInStore`** | `getSessionMessages(...) !== undefined` |

**没改名的**(刻意,它们的 "Transcript" 是**诚实**的 —— 真的在读 `messages.jsonl`
那个文件):`sessionReads.readTranscriptFile` / `readTranscriptBuffer`、
`scripts/session-verify.ts` 的 `messagesFromTranscript`、
`wiring/collab/actors` 的 `collabRoomMembersFromTranscript`(另一个域的"抄本",无关)。

调用点同步:`session/commands.ts`(8)、`session/shadow.ts`(2)、
`wiring/engine/stream/{stream-executor,agent-loop-executor,history-shadow}.ts`(6)、
6 个用例文件。`session:check` 白名单与 `session:gate` 基线**不含这些名字**(它们守的是
`session.messages` 的持有点),因此无需改;实跑确认 none new。

#### 四、纪律文本翻面的落点

| 文件 | 改了什么 |
|---|---|
| `session/commands.ts` 文件头 | 「事件写侧取材纪律(§13.18 发现 B)」整段重写成「**F3 已整体翻面**」:先写死原理由(投影滞后)、再写死它为什么不成立(F1 + 批 6b 烧开关),然后是**写侧默认可以读活投影**与三类具名例外 |
| `session/command-events.ts` 纪律 3 | 「写侧取材走抄本真相面」→ 例外表版本 |
| `session/reads.ts` 五口的文档 | 逐口换理由:`getMessageFromStore` 挂②③并写下反证读数;`hasMessageInStore` 挂①并补热路径那笔账;`hasSessionInStore` 写明**投影答不出这个问题**;`findMessageFromStore` 写明唯一消费者与同源关系;`listMessagesFromStore` 的 F0 验证器纪律**一字未动** |
| `stream-executor.ts` / `agent-loop-executor.ts`(5 处) | 每处把"永不随 `ONETHING_SESSION_READ` 分岔"(那个开关批 6b 就烧了)与"投影滞后"换成各自那一类的真理由;两处孪生点写上反证读数 |
| `__tests__/event-production-write-side-read.test.ts` 文件头 | 从"证明纪律普遍成立"改成"**三类例外的护栏**",并说明谁把某处改回 routed 会在这里当场红 |

#### 五、用例

| 用例 | 位置 | 钉住什么 | 反证 |
|---|---|---|---|
| `a streaming assistant placeholder has no ledger slot yet: store sees it, the projection does not` | `session/__tests__/event-production-write-side-read.test.ts` | **新增**。②类的可证伪表述:同一条流中 assistant,`getMessage` 给 `undefined`、`getMessageFromStore` 给得出 `timestamp`;并断言账本上**一条 `system/message` 都没有** | 拿掉 `command-events.ts` 里 `role==='assistant' && isStreaming` 那道 return → **红**(实跑) |
| `hasSessionInStore separates an empty session from a missing one; the projection cannot` | 同上 | **新增**。空会话 vs 不存在的会话必须分得开,而投影两者同答 | 把 `hasSessionInStore` 改成 `length > 0`(投影式口径)→ **红**(实跑) |
| 既有 4 条(truncate 底稿 / get / find / 收尾自报标题) | 同上 | 语义未变,标题与文件头随纪律翻面重写(`transcript` → `store`) | — |
| `listMessagesFromStore keeps answering from the store` | `session/__tests__/shadow-read-mode.test.ts` | 标题里那句"from `messages.jsonl`"停写之后已经不真,改成 store | — |

#### 六、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `bun run typecheck` | **0** |
| 定向 `packages/backend/session` + `packages/core/session` + `packages/backend/wiring/engine` | **94 文件 / 841 测试全绿** |
| `bunx vitest run packages/backend`(全包) | **280 文件通过 / 1 skipped,2400 测试通过 / 3 skipped** |
| `bun run sessions:shadow-battery` | **GREEN**,且**逐项同基线**:runs **321** / historyChecks **449** / mismatches **0** / duplicates 0 / projectionIssues 0 / droppedParts 0 / appendFailures **0** / refoldChecks **225** / refoldMismatches **0** / `session-shadow.jsonl` **0 行**(本批开工前先跑了一次基线,与 §16.5 表逐项相同;收工再跑,三个数字一个不差) |
| `bun run boundary:gate` | ok — 0 failures |
| `bun run session:gate` | ok — 0 known, none new |
| `bun run log:gate` | ok — 4 known, none new |
| `bun run transport:gate` | ok — 42 常量 / 四壳 2392 行,无上升 |
| 真机只读 `bun run sessions:verify:gate` | ok — **13 known, none new**;全程只读,`~/.onething` 一字未写 |

**F0 恒等门的两条推导仍然恒等** —— 而且本批**没有**用"改绿"换过它:唯一一次红
(反证②的 305 条失配)是**故意跑出来的**,跑完当场 revert,不是修出来的绿。

#### 七、留账

1. **①类的解冻点是 F4,不是"以后有空"**。F4 把 core reducer 与投影 reducer 合一那天,
   "改不改得成"只剩一条推导,命令面这 8 处判据连同 `hasMessageInStore` /
   `hasSessionInStore` / `findMessageFromStore` 三口一起退役。**②③两类与 F4 无关**,
   各自的解冻条件写在第〇节的表里。
2. **②类值得单独记一笔**:给流中 assistant 一个自己的事件产地(而不是让 `run/start`
   兼任),会同时消掉 §15.18 那条"结构性地板"的病根、这两处取材点、以及
   `reads.ts` 上②类那段注释。它是**行为改动**(账本每 run 多一条事件),按
   §16.3 的规矩要单独拍板,本批只记录不动手。
3. **`hasSessionInStore` 可能永远留在 store 侧**:会话在不在是 `meta.json` /
   仓库那一层的事实,不是消息事件折得出来的 —— 除非 F4 之后"会话存在性"另找产地。
   本批不预设结论,只把"投影答不出"这件事写进注释与用例。
4. **§14.1 那张表可以退休了**:它画的是"抄本仍在写"那个世界,本节的 A/B/C 三张表是
   它在 HEAD 上的替身。§14.1 已经挂了批 6b 的删除说明,本批不再动它。

### 16.11 F4 方案与拍板包(2026-08-27,Fable 设计,待用户拍板后开工)

F4 = F 线终局:core/session/commands.ts 的 reducer 与 projection/reducer 合一,store 从
"独立写模型"退化为**投影的物化缓存**;F0 恒等门退役,refold 成为唯一常驻耐久门。
规模 1–2 批。五项拍板(推荐加粗):

1. **P0 端口解冻范围**:**A. 只换实现不换形状(推荐)**——引擎注入的 store 端口签名
   保持(P0 合同继续有效),实现底下改为"命令面(事件产地)→ 投影物化视图";
   B. 端口改说事件词汇——彻底但把 F4 变成引擎接口重构,留给远期。
   > **勘误 / 豁免(2026-08-27,用户跳出本拍板重拍;落地见 §16.12)**:形状冻结继续
   > 有效,**唯一指名豁免 —— `addMessage` 返回入库成品**(`void → TMessage`)。
   > 理由 = 消灭占位回读的时序窗口:盖章(`stampCollabAgentId`)是 COW 的,"我刚写
   > 进去的那条长什么样"只有写入那扇门自己答得起,让它答,盖章仍是一处实现,而
   > 那次回读连同它的时序窗口一起消失。**只此一格**,不作为动其他端口的先例。
2. **F0 恒等门退役条件**:**A. F4 落地批内退役(推荐)**——合一后 store=物化视图,
   比对失去对象;退役前跑一次全量 battery + 真机 verify 作最终对账;refold(文件字节
   vs 内存活投影,两条独立路径仍在)升格唯一常驻门,采样率维持 EVERY=5 首 run 必采;
   B. 保留一段时间比"物化 vs 重折"——与 refold 重复,不推荐。
3. **流中 assistant 独立事件产地(F3 ②类)**:**A. 做,且是 F4 的硬前置(推荐)**——
   合一后 store 物化自投影,而流中占位在账本上没那一格(F3 反证:硬读投影 305 失配,
   origin 整格缺失),不补产地则物化缓存折不出占位、②类两处取材当场断粮。落法:
   run/start 已是占位的事件产地,把占位所需全量字段(origin/timestamp 等)补齐在
   run/start.data 上(不新增事件类型,每 run 零额外行);读侧投影物化出占位消息
   (isStreaming 语义由 run 开闭推导)。B. 不做——F4 无法合一,等于否决 F4。
   > **勘误(2026-08-27,F4-a 勘察)**:本条把"F3 反证 305 失配"当成了"那两处取材
   > 非回读不可"的证据,**这一半不成立**。反证证明的是"不能改读投影",不是"必须
   > 回读 store":那两处是 `run/start` 的**生产者**而非消费者,恒等门判据下字段
   > 一格不缺 —— 病根是**值的路由**(值在创建点手里,却绕 store 一圈取回)。
   > 用户按 A′ 优先裁定、勘察否掉 A′ 后再跳出重拍 B(见 §16.12 〇/一),两处回读
   > 已整体删除。**本条正文其余部分照旧成立**:产地缺口这件事实还在,补产地仍是
   > F4 合一的硬前置,只是它不再有"两处取材断粮"这个附带理由。
4. **hasSessionInStore 归宿**:**A. 永久留在 store/meta 侧(推荐)**——"会话在不在"
   是 meta.json/目录层事实,不是消息事件折得出来的;写进 §16.10 例外表成为永久纪律
   (**已落地**:`reads.ts` 与 `commands.ts` 文件头都补了"永久"标注,§16.12 第三节);
   B. 强行事件化(session/created 反查)——零事件老会话与不存在会话不可分,F3 用例
   已证伪。
5. **顺带清账(推荐都做)**:`ONETHING_SESSION_HYDRATE=messages` 回滚杆退役(批 6b
   已注"不要扳它",不安全杆不该存在);`stores/clearSessionMessages` 死面删除
   (批 6b 查明零生产调用)。 —— **两项均已落地(§16.12 第三节)**。

**F4 之后**:F 线完结,full 终态成立(命令即事件、状态即折叠、refold 唯一耐久门)。
剩余路线图:B 期 + U1/U2 renderer 同窗(细案届时出),远期另册(events 分卷轮转、
legacy-backup 处置、tool/result 进 surface 的写侧一票已由 F1 收、②类同源注释清理)。

### 16.12 F4-a 落地记录:占位值前递(`addMessage` 交回入库那一条)+ 清账(2026-08-27,opus 执行,未提交)

F4 的第一小批。目标只有一件事:**把 `stream-executor.ts` / `agent-loop-executor.ts`
那两处"写完再回读一次"的 store 取材整体删掉**,顺带结清 §16.11 拍板 4/5 两笔清账。

#### 〇、先勘察盖章面(它决定方案怎么走)

工单要求先读清 `stampCollabAgentId` 的产地与全部调用点,再决定方案。实况:

| 问 | 答 |
|---|---|
| 产地 | `packages/backend/stores/sessions.ts` 的一个模块内函数(P0.1 起 **COW**:返回新对象,不改调用方手里那条),`export { stampCollabAgentId }` 只为命令面装配 |
| 调用点 | **只有一处**:`session/commands.ts` 的 `appendMessage`,且要 `payload.stampCollab === true` |
| 有没有第二个盖章点 | **没有** |
| 盖哪些消息 | 判据是 `role==='assistant' && !agentId` **且**会话形态 ∈ room/work/agent;但**这道门本身覆盖所有消息** —— `stampCollab:true` 的四个调用点是 `stores/sessions.addMessage`(= core 引擎注入的 store 端口,它下面挂着 core 的 6 个创建点、`context-compact`、`agent-loop-runtime` 的注入消息、steer 换锚点、`rpc/domains/sessions`)、collab `ingress`(user)、`say-tool`(自带 agentId 的 assistant) |
| 盖的依据 | `sessionRepository.getSession(sessionId)` 的 `kind` / `agentId`,加消息自己的 `source` / `origin.source`(见函数上那段 W14b 注释) |

**结论:A′(整体前移到消息出生管线)不成立。** 三条理由,任一条都足够:

1. 助手占位的**出生点在 `packages/core`**(`core-stream-engine.ts` 三处),而 core 不认识
   也不该认识 `stampCollabAgentId`。前移要新开一个"消息出生装饰"端口
   (`CoreStreamEngineRuntime` 12 槽 → 13)。
2. 盖章今天覆盖的是**所有**经 `store.addMessage` 的消息,不只是助手占位。只前移助手
   占位那一类 = 立刻多出**第二个盖章点**(正是勘察要防的那件事);全部前移 = 一个
   判定摊到 ~10 个创建点(core 6 + compact + 注入 + steer + 两个 collab 写点)。
3. `store.addMessage` 侧降级为断言,等于要求包括 `rpc/domains/sessions` 在内的每个
   写点都记得先盖章 —— 把一条"进门必过"的纪律换成一条"请你记得"的约定。

于是先按工单的退路做了 **A**(创建点前递未盖章的对象 + 宿主复用同一个盖章函数补盖,
幂等)。A 的代价是**第二次调用盖章函数** —— 实现仍是一处,但调用点多了一个。

#### 一、改判:A → B-窄版(2026-08-27,用户跳出既有拍板重拍)

用户在 A 落地后跳出原拍板重拍:**不走 A′/A,走 B-窄版** ——
`addMessage` 端口从"无返回"改成**返回真正入库的那一条**。

B 比 A 省在哪里,正是上面勘察给出的:盖章是 COW 的,所以"入库的它长什么样"这个问题
**只有写入那扇门自己答得起**。让它答,盖章仍然只发生一次、仍然只有一处实现,而
A 的第二次调用、以及"回读"这个可以不存在的时序窗口,一起消失。

**这是 P0 端口形状冻结的唯一指名豁免**,记在 §16.11 拍板 1 名下(见那一节的勘误注)。

#### 二、逐处改动表

| 文件 | 改了什么 |
|---|---|
| `core/engine/stream-runtime.ts` | `StreamEngineStoreAdapter.addMessage` 返回 `TMessage`(带整段理由与豁免出处) |
| `core/session/storage/types.ts` | 仓库端口的 `addMessage` 同一条口径 |
| `backend/session/commands.ts` | `SessionCommands.appendMessage` 返回 `ChatMessage`;实现把盖过章的 `message` 交回 |
| `backend/stores/sessions.ts` | `addMessage` 返回 `sessionCommands.appendMessage(...)` 的结果 |
| `core/engine/core-stream-engine.ts` ×3 | send / edit-resend / retry 三个创建点接住返回值,经 `assistantMessage:` 递给宿主 |
| `backend/wiring/engine/stream/stream-executor.ts` | `StreamExecutionParams` 新增 `assistantMessage?: Record<string, unknown>`;**删除** `sessionReads.getMessageFromStore` 那一处回读;进 core 的参数包里把这一格摘掉(下游逐字不变) |
| `backend/wiring/engine/stream/agent-loop-executor.ts` | steer 换锚点那处**删除**回读,改用 `store.addMessage` 的返回值 |
| `backend/session/reads.ts` | `getMessageFromStore` 摘掉②类"事件产地缺口",只剩①类;`hasSessionInStore` 补**永久例外**标注(拍板 4) |
| `backend/session/commands.ts` / `command-events.ts` 文件头 | 例外表 三类 → **两类** |
| `backend/session/runs.ts` | `agentId` / `messageSource` 两格的口径改成「单实现,调用点指认此处」(原文把"回读"写进了纪律) |

**两处刻意没动**,都写在代码注释里:

1. `message:assistant-created` 事件**仍然发创建点手里那条**(未盖章的)。改成发入库
   那条是一次可感知的行为变化(渲染层会突然看见 `agentId` / `source`),按
   §16.3 的规矩不在本批自作主张。
2. 缺席不回落:`params.assistantMessage` 没给时 `run/start` 那几格就空着,**不**退回去
   读 store —— 回落等于把删掉的那条路留在原地。生产四条路径全都前递。

#### 三、清账(§16.11 拍板 4 / 5)

| 项 | 处置 |
|---|---|
| `ONETHING_SESSION_HYDRATE` 回滚杆(拍板 5) | **退役**。`read-mode.ts` 的档位一族(`SessionHydrateMode` / `DEFAULT_*` / `getSessionHydrateMode` / `isSessionProjectionHydrateMode` / `setSessionHydrateModeForTesting`)整体删除并留墓志铭;`hydrate.ts` 去掉档位判据(补水无条件走投影);`session-repository.ts` / `stores/sessions.ts` 两处注释、`shadow-battery.mjs` 的两处 `delete env` 与三段泳道注释、`session-hydration-contract.ts` 的表头与前言同步。用例:`reads-projection.test.ts` 的"默认值"与"回滚杆"两条随档位退役,剩两条验唯一那条路。**这个文件本身没有档位了,只剩跨进程告警** |
| `stores/clearSessionMessages`(拍板 5) | **删除**(P0.2 之后零生产调用点;群聊清空走命令面 `replaceAll{reason:'clear'}`)。连带 `stores/index.ts` / `store.ts` 两处再导出;`sessions-clear-messages.test.ts` 里清空那三条断言退役,文件按角色改名为 `sessions-collab-cursor.test.ts`(只剩已读游标那条);`room-config.test.ts` 的 store 替身摘掉这一口;battery 的 TODO 行改口。**renderer 的 `chatStore.clearSessionMessages` 同名不同物,一字未动** |
| `hasSessionInStore`(拍板 4) | 例外表里补**永久**标注与理由:它不随 F4 退役 —— 会话存不存在是目录 / `meta.json` 那一层的事实,消息事件里永远没有它的产地 |

#### 四、用例

| 用例 | 位置 | 钉住什么 |
|---|---|---|
| `addMessage hands back the stored message, stamp included (F4-a port contract)` | `stores/__tests__/sessions-collab-turn.test.ts` | **新增**。端口豁免的护栏:返回的那条盖过章、入参那条一字未动(COW)、返回的就是落库那条(不是第三个副本)。谁把 `addMessage` 改回 `void` 或让它返回入参,这里当场红 |
| `addMessage returns the message unchanged where nothing stamps it` | 同上 | **新增**。不盖章的会话原样返回入参(`toBe` 同一性) |
| `a streaming assistant placeholder has no ledger slot yet…` | `session/__tests__/event-production-write-side-read.test.ts` | **身份改变,断言不变**:它不再是"第二类例外的护栏"(那两处回读没了),而是钉住**产地缺口这件事实本身** —— §16.11 拍板 3 说的 F4 硬前置。哪天补上产地这里会红,那是前置做完了的信号 |
| `S3w-1 — projection hydrate source` | `session/__tests__/reads-projection.test.ts` | 4 例 → **2 例**(档位退役) |
| `clearSessionMessages` 三例 | `stores/__tests__/` | **退役**(存储原语已删) |

#### 五、字节回归(HEAD worktree 双跑 + **同树对照组**)

方法:HEAD(`be2cfb7d`)开 worktree(独立 `node_modules/@onething/*` 指向 worktree 自身
的包,否则会编译到本树源码),两棵树各 `server:build` 后跑
`shadow-battery --passes 1 --seed 4041 --concurrency 1 --keep-store`,再逐会话对拍
`events.jsonl`。

battery 三次全 GREEN 且**逐项同基线**:

| 树 | runs | historyChecks | mismatches | appendFailures | refoldChecks | refoldMismatch |
|---|---|---|---|---|---|---|
| HEAD 第一跑 | 87 | 119 | 0 | 0 | 63 | 0 |
| HEAD 第二跑(对照组) | 87 | — | 0 | 0 | 63 | 0 |
| 本树(B) | 87 | 119 | 0 | 0 | 63 | 0 |

**逐会话对拍(55 会话,归一化掉 store 路径 / 仓库路径 / uuid / 时钟 / `dt` / 小时粒度的
`datetime` 变量与由它派生的 `systemPromptHash`)**:

| 对拍 | 逐字节相同 | 有差异 |
|---|---|---|
| **对照组** HEAD 第一跑 vs HEAD 第二跑 | 35 / 55 | 20 |
| **本批** HEAD 第一跑 vs 本树 | 35 / 55 | 20 |

**"本批有差异而对照组没有"的会话:0 条;反向也是 0 条。** 两张差异表逐条同名 ——
也就是说本批在 `events.jsonl` 上**一个字节都没改**,那 20 条是**环境噪声地板**,与
代码无关。噪声的两个来源(逐条查明):① 一次性 store 目录名(`onething-shadow-battery-XXXXXX`)
会被烘进工具入参正文与它的 `hash` / `contentHash`(`len` 两侧逐字相同,只有 hash 不同);
② `file-mutations` 的审计路径带墙上时刻。

**F3 反证的同型验证(本批的核心判据)**——87 条 `run/start` 逐条对拍:

| 判据 | 结果 |
|---|---|
| key 集合不一致 | **0** |
| 非易失值(`kind`/`provider`/`model`/`origin` 结构)不一致 | **0** |
| `origin` 在场数(HEAD / 本树) | **83 / 83** |
| `timestamp` 在场数 | **87 / 87** |
| `triggerMessageId` 在场数 | **83 / 83** |

F3 那次反证(硬换读投影)当场 305 失配、`origin` **整格丢失**、`timestamp` 差 3ms;
本批同一处改动之后**这两格一条都没少**。

覆盖缺口(如实记):battery 的场景矩阵里没有 room / agent 形态会话,所以
`agentId` / `messageSource` 两格在双跑里都是 **0 / 0** —— 盖章那条路**不由 battery 覆盖**,
它由上面新增的两条端口合同用例覆盖。

#### 六、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `typecheck` | 0 |
| `boundary:gate` | ok — 0 failures |
| `session:gate` | ok — 0 known, none new |
| `log:gate` | ok — 4 known, none new |
| `transport:gate` | ok — 42 常量 / 四壳 2392 行,不变 |
| `packages/backend` + `packages/core` + runtime 定向 | 3422 passed / 1 failed |
| `sessions:shadow-battery`(seed 4041) | **GREEN**,逐项同基线(见上表) |
| 真机 `sessions:verify:gate`(只读) | 见下 |

那 1 条 failed 是 `stores/__tests__/sessions-delete-cascade.test.ts` 的
「会话目录与它的轨迹目录一起消失」:它的 `waitGone` 只等 1s(100×10ms),整包并跑时
超时。**已证是本机负载抖动、与本批无关**:单跑绿(1056ms,贴着上限),而且**同一条
在干净的 HEAD worktree 上并跑时同样红**。

#### 七、留账

1. **②类例外没了,但它指向的那件事还在**:流中 assistant 占位在账本上没有产地。
   §16.11 拍板 3 说的"把占位所需字段补齐在 `run/start.data` 上"仍是 F4 合一的硬前置,
   `event-production-write-side-read.test.ts` 那条用例现在就守着它。
2. **`message:assistant-created` 的载荷**是本批唯一刻意留下的不一致(发的是未盖章
   那条)。它是可感知行为,改不改要单独拍板。
3. **端口豁免只此一格**。`addMessage` 之外的 P0 端口形状仍然冻结;下一个想动的人
   请先回到 §16.11 拍板 1,而不是引用本条当先例。

### 16.13 F4-b 勘察结论:**停在诊断**——「store 退化为物化缓存」与 §14.5 既有裁定正面冲突(2026-08-27,opus 勘察,**零代码改动**)

工单要求「先勘察后动手」,并写明**若勘察发现物化视图与老 reducer 产物有真差异就停在
诊断、不硬改绿**。勘察做完了,结论是**停**。本节是那份诊断:三道勘察题的答案、一次
真机量测的读数、四类阻塞、以及给用户的拍板包。**本批一行生产代码都没改**(唯一动过的
是一枚跑完即删的探针,见第一节),文档只改了 §16.2 的 F4 行 + 本节。

#### 〇、一句话

F4-b 的终局定义是「**store 从独立写模型退化为投影的物化缓存**」。而 §14.5 早就为
**同一件事**下过一条相反的裁定 ——

> **内存/IPC/渲染的双视图保留,不在 S3w 范围**。消费者两边都有硬吃者:history builder
> (`core/engine/history.ts:96-97`,toolCalls 出工具结果、steps 出 turn 切分)、renderer
> (StepsPanel / tool-display / work-group,`step.toolCall` 与顶层同引用)、collab
> worker-mind-port、resume-history、evals。收敛这层形状 = 渲染层 + history 大改,存储
> 收益为零 —— **另立门户,或接受"两个视图"为长期形态**。

—— **那个"内存视图"就是 store**。§16.10 的③类例外也是拿这条裁定当解冻条件的
(表里写的是"§14.5 双存移除 / F4")。所以 F4-b 不是"再干一批活",是**要先推翻 §14.5**;
而推翻它的代价 §14.5 自己已经算过:渲染层 + history 大改,存储收益零。

这不是"实现难",是**方案层的前置没做**。硬做的话第一步就要替用户拍四个可感知的
行为变化(见第三节),而 §16.3 的规矩是这类事单独拍板。

#### 一、勘察题①:物化视图 vs store 消息,**逐格**等价吗?——不等价,50 条路径

**方法(可复现)**:在 `shadow.ts` 的 `checkSessionRunShadow` 里加一枚 `ONETHING_F4_PROBE`
门控的探针 —— 在恒等门 canonical **之前**把两侧原样逐格对拍(同一对入参:
`materializeNode(node)` vs `listMessagesFromStore`),把每一处路径与两侧短值写成一行;
跑 `sessions:shadow-battery --passes 1 --seed 4041`(27 场景 / 87 run / 172 条消息命中),
读完当场 `git checkout` 撤掉。**探针不入库**,与 §16.10 第二节两次反证同一条做法。

读数:**恒等门 `mismatches` = 0,而逐格对拍 = 50 条不同路径**。两个数字都对 ——
canonical 的整张豁免表(`ALWAYS_DROPPED_KEYS` / `DERIVED_CLOCK_KEYS` /
`DERIVED_STEP_CACHE_KEYS` / `isTransientPart` / 空数组 / `undefined` / step `id` /
`argsFinalizedBy`)丢掉的**正是这 50 条**。也就是说:

> **恒等门证明的是"canonical 之后相等",不是"可以互换"。这两句话之间的缝,恰好就是
> F4-b 要往里塞 store 的那条缝。**

按频次分档(A=投影物化 / B=内存 store,命中数 = 有此路径分岔的消息条数):

| # | 路径 | 命中 | A(投影) | B(store) | 定性 |
|---|---|---|---|---|---|
| 1 | `eventSeq` | 172 | 有 | 缺 | 噪声(投影独有坐标) |
| 2 | `isStreaming` | 88 | 缺 | `false` | 噪声(`false` ≡ 缺席) |
| 3 | `thinkingStartTime` | 88 | 缺 | 有 | 噪声(纯 UI 活跃态) |
| 4 | `usage.durationMs` | 74 | 缺 | 有 | 噪声(墙钟) |
| 5 | **`thinkingTime`** | 73 | **有** | **缺** | **④ 可感知**:换过去屏幕上会凭空多出"思考了 74ms" |
| 6 | `toolCalls` | 58 | 缺 | `[]` | 噪声(空数组) |
| 7 | **`steps[].id`** | 42 | `step-<callId>` | uuid | **① 硬阻塞**,见第二节 |
| 8 | `toolCalls[].argsFinalizedBy` / `steps[].toolCall.argsFinalizedBy` | 40 / 40 | 缺 | 有 | 噪声(流式诊断位,§10.8 公开缺口) |
| 9 | **`steps[].partialResult.*`** | 28+28+24×4+10+4×10+2×4 | **另一种形状** | **另一种形状** | **③ 可感知**,见下 |
| 10 | **`contentParts` 整族**(`.length` 24 / `[].type` 26 / `[].content` 26 / `[].turnIndex` 22 / 整格缺 2) | — | 无 `data-steps` | 有 `data-steps` | **② 硬阻塞**,见第二节 |
| 11 | `toolCalls[]` / `steps[]` / `steps[].toolCall` 的 `timestamp` `startTime` `endTime` `receivedAt` `durationMs` | 19/19/19/11/11/11/11/8 | 差 1–2ms | 差 1–2ms | 噪声(两次读表) |
| 12 | `steps[].toolCall.canRespond` / `requiresConfirmation` | 6 / 4 / 2 | `false`↔缺 | 双向 | 噪声(确认闸收场态) |

第 9 条展开(它是"两个结构不同的对象",不是"某一格差一点"):

| 侧 | `steps[].partialResult.details` 的键 |
|---|---|
| A 投影 | `command` `workingDirectory` `exitCode` `path` `diff` `diffHunks` `additions` `deletions` `originalContentHash` `afterContentHash` `auditId` `auditPath` `bytesWritten` `lineCount` `created` |
| B store | `title` `metadata{command,workingDirectory,exitCode,output}` `output` `attachments` |

canonical 之所以敢丢它,理由写在 `DERIVED_STEP_CACHE_KEYS` 上:「同一条消息在**重启
前后**本来就不是同一个值」。那句话成立 —— 但它说的是**冷加载**换形状,不是**流中**
换形状。F4-b 要换的是后者。

#### 二、两条硬阻塞(不是审美,是机械上跑不通)

**① `steps[].id` —— 引擎按 id 寻址步骤,而物化视图换了一套 id。**

`core/engine/event-only-emitter.ts:343` 的 `sendStepUpdated(stepId, updates)` 同时做两件事:
`store.updateMessageStep(sessionId, msgId, stepId, updates)` + 往渲染层推一条
`STEP_UPDATED`。那个 `stepId` 是引擎自己 `createCoreId()` 生成的 uuid;而 reducer 的
`patchStep` 用 `steps.findIndex(step => step.id === command.stepId)` 认它。物化视图里
step 的 id 是 `step-${callId}`(投影派生,`materializeStep`)—— 换过去之后每一次
`patchStep(uuid)` 当场 `findIndex === -1` **静默 no-op**,而渲染层那侧照收
`STEP_UPDATED`(它不经过 store)。结果是**内存与屏幕分家**,而且没有任何一道门会红:
canonical 明文丢掉 step `id`(G1),恒等门看不见这件事。

要跨过它只有两条路,都超出"只换实现不换形状":把引擎的 step id 改成
`step-${callId}`(id 语义变化 + 渲染层 key 变化 + 旧会话 id 断代),或者让 store 保留
自己的 id 只吃投影的内容 —— 后者不是"物化",是**第三条推导**,比今天更糟。

**② `contentParts` —— 投影按裁定**故意不产出** `data-steps`,数组因此错位。**

canonical G4 与 §14.4 都写死了:渲染锚点住渲染侧,「投影产出 data-steps」是**已被否决
的备选**(原话:"违反'锚点住渲染侧'(G4),canonical 要开豁免")。实测后果不是"少一格"
而是**整条数组错位**:`contentParts[i].type` 在 26 条消息上对不上号
(A 的 `reasoning` 撞 B 的 `data-steps`、A 的 `text` 撞 B 的 `reasoning`)、
`.turnIndex` 22 条不同、`.length` 24 条不同、还有 2 条消息 store 侧只有
`[{type:'data-steps',turnIndex:1}]` 而投影侧整格没有。

S3w-0(`8682d980`)让**渲染层自合成**锚点,所以"显示"这一侧接得住;接不住的是
**收尾链**:`agent-loop-executor.ts:629` 的 `completeAgentLoopStream` settle 快照拿的
就是 store 那份带锚点的 `contentParts`(§16.10 ③类原话:"换掉就是 §15.16「正文看不见」
的同一根引信"),以及 `:533` `captureCancelledToolResults` / `:578` 收尾修复读的
`steps[]` 结局 —— 被取消的工具从来没有 `tool/result`,读投影**读空**、采集不触发、
账本缺账。

#### 三、两类可感知行为变化(硬做的话第一步就得替用户拍)

| # | 变化 | 用户看得见什么 |
|---|---|---|
| ③ | `steps[].partialResult` 换成投影那一份 | 工具卡在**执行当中**显示的结构化结局换一套形状(自报标题 `details.title`、`output`、`attachments` 消失;`diff` / `diffHunks` / 审计路径出现) |
| ④ | `thinkingTime` 从投影物化进 store | 每条助手消息**凭空多出**一个思考时长读数(今天 store 上常常根本没有这一格) |

按 §16.3 的规矩(以及用户对"行为裁定须先问"的既有指令),这两条不该由执行侧顺手拍。

#### 四、勘察题②:F3 ①类 8 处在合一后怎么自然解决 —— **路径成立,但它是果不是因**

答案本身是干净的,记在这里备用:合一之后"改不改得成"只剩一条推导(投影),命令面
那 8 处 `hasMessageInStore` / `getMessageFromStore` / `findMessageFromStore` 判据源
一起改成投影面(`getMessage` / `findMessage` / `hasMessage`),`reads.ts` 上①类那三口
随之退役。**判据可信度已经量过**:§16.10 第二节的①类反证跑了 **321 run / 0 次分岔**
—— 投影答得对。唯一不跟着退役的是 `hasSessionInStore`(§16.11 拍板 4 已定为永久例外:
"会话在不在"是 `meta.json` / 目录层的事实,消息事件里永远没有它的产地)。

代价也量过并记在案(§16.10):`patchMessage` 是逐 token 的热路径,而投影侧最便宜的
存在性口 `eventsGetMessage` 每次物化**整条会话**。合一时要么给投影加一个 O(1) 的
`hasMessage(sessionId, messageId)`(`byMessageId.has`,现成的),要么这条热路径变慢。
推荐前者,顺手可做。

**但**:这 8 处的解冻**依赖**合一,不是反过来。合一停了,它们原地不动 —— §16.10
给它们挂的理由("与 reducer 同一份 store,两侧同判据")今天仍然逐字成立。

#### 五、勘察题③:引擎流式写手与物化缓存怎么共存 —— **口径写出来了,但它自证了阻塞**

> **勘误(F4-b2,§16.17 第二 / 五节)**:下表"settle"那一行的判据("读的正是投影
> **不产出**的那几格")**只对锚点那一半成立,对结局那一半不成立** —— F2-c 的
> `tool/annotate` 与投影的 `lingeringToolError` 之后,收场结局在事件侧有产地了;
> 收尾链读不成投影的真原因是**它自己就是那条 `tool/result` 的产地**(自引用)。
> 而锚点那一半本来就该住写手 / 渲染侧(G4)。所以那一行的结论从「**不能**」改成
> 「**不需要** —— 物化缓存本来就不该管活 run 窗口」,阻塞②随之拆除。

勘察前的预设是「活 run 的消息仍由引擎写手持有,settle 时账本收尾,缓存物化覆盖」。
把它写成纪律之后,自己就露了底:

| 阶段 | 谁持有那条消息 | 物化缓存能不能覆盖 |
|---|---|---|
| `run/start` 之前 | 引擎创建点(F4-a 之后由 `addMessage` 交回入库那一条) | 账本上还没有这条消息的那一格(§16.12 留账 1) |
| run 进行中 | 引擎写手按 **id 寻址**(`patchStep(stepId)` / `updateMessageToolCalls` / `addMessageContentPart`),同一批值同时推给渲染层 | **不能**:覆盖 = 换掉 step id(阻塞①)+ 抹掉锚点(阻塞②)+ 换掉 partialResult 形状(③) |
| settle | 收尾链**读** store 的 `steps[]` / `contentParts`,再写回 | **不能**:读的正是投影不产出的那几格(§16.10 ③类) |
| run 结束之后 / 冷加载 | 已经是物化了(S3w-1,`hydrate.ts` 无条件走投影) | **已经成立** —— 这一格 F 线早就做完了 |

也就是说,「物化缓存」这个终局在**冷侧已经是现状**,阻塞全部集中在**活 run 那个窗口**;
而那个窗口正是 §14.5 说的"内存/IPC/渲染双视图"的作用域。三题的答案在这里合流。

#### 六、给用户的拍板包(F4-b 要往下走,必须先答这三条)

1. **§14.5 的裁定翻不翻?** 翻 = 接受"渲染层 + history 大改"(§14.5 自己的估价),
   收益是 F 线终局成立、reducer 少一份、F0 门可退役;不翻 = **F 线到 F4-a 为止收官**,
   `core/session/commands.ts` 作为 F0 影子验证器**长期留任**(它今天不是死码,是恒等门
   的另一侧),refold + F0 两道门并存。**推荐后者**,理由与 §14.2 当初推荐 lite 同一条:
   丙的纯度收益换不回它的风险与安全网损失,而 F0–F4-a 已经把用户可感知的价值全拿到了
   (命令即事件、单一持久化、双存从磁盘消失、写侧同步可见、回读窗口消灭)。
2. **若翻**:第三节那两条可感知变化(`partialResult` 形状 / `thinkingTime` 现身)照旧
   要逐条拍;第二节两条硬阻塞各自需要一个子期(step id 语义统一 / 锚点与收尾链改造),
   规模远超"1–2 批"。
3. **若不翻**:§16.2 的 F4 行、§16.11 拍板 2(F0 门退役条件)、§16.10 留账 1(①类
   解冻点)三处都要改口 —— 它们今天都写着"F4 那天"。本节先不动它们,等拍板。

#### 七、本批的账

- **代码改动:0**(探针跑完即删,`git checkout` 已确认与 HEAD 逐字相同)。
- **文档改动:2 处** —— §16.2 的 F4 行改口 + 本节。
- **实跑读数**:`sessions:shadow-battery --passes 1 --seed 4041` —— runs 87 /
  historyChecks 119 / **mismatches 0** / duplicates 0 / projectionIssues 0 /
  droppedParts 0 / appendFailures 0 / refoldChecks 63 / **refoldMismatches 0** /
  `session-shadow.jsonl` 0 行;四条泳道与写失败探针全 PASS。
  (`--passes 1` 下 `runs 87 < min-runs 200`,门按口径判 RED —— 与 §16.12 第五节
  字节回归那三跑同一个已知口径,不是失配。)
- **告别对账没有跑**:它是"切换完成之后"的动作,而本批没有切换。F0 恒等门**照旧上岗**。

#### 八、真机只读对账捎带读到一条**新红**(与本批无关,停在诊断)

跑 `sessions:verify:gate` 时顺手跑了 `sessions:shadow-report`(只读),读数:

```
runs 62 / historyChecks 209 / mismatches 4 / duplicateMismatches 7
projectionIssues 0 / droppedParts 0 / appendFailures 0
refoldChecks 16 / refoldMismatches 0
byKind { history: 4 }   skipped { history-steer-window: 1 }
```

`sessions:verify:gate` **ok — 13 known, none new**;红的是 shadow 那一侧的 4 条
`kind:'history'`,时刻 2026-08-27 03:24–03:31(用户当时正在真机上聊天),**全部落在
同一条会话 `ef079fd7`** —— 就是 §15.21 那条 `Session cleared` 化石会话。

**与本批无关**是可判定的:本批生产代码改动 0(`git diff` 对 `packages/` 空),
本批的 battery 跑在一次性临时 store 上,从头到尾没写过 `~/.onething`。

形状(四行同型,取最后一条):

| 位置 | A(events 真相) | B(store 验证器) |
|---|---|---|
| `.length` | 372 | **375** |
| `356.content` | 比 B **多**一段("工具列表正常,说明 chrome-devtools 这个 MCP…") | 少那一段 |
| `358` | `role:user`("chrome没有弹出来mcp连接申请,") | `role:assistant` + `toolCalls:[call_00_ET_…20941]` |
| `359` | `role:assistant`(下一轮正文 + reasoningContent) | `role:tool`(那次调用的结果) |
| `360`… | 整体**前移 2 格** | — |

也就是说:**事件侧的模型历史少了一对 `assistant(toolCalls)` + `tool(result)`**,
而那一轮的正文被并进了前一格。

**已排除数据丢失**(只读核对该会话 `events.jsonl`,5.9MB):那个 callId
`call_00_ET_05UwmNXVnWDX8QtMa8V20941` 在账本里**五条俱全** ——
`assistant/chunks`(seq 5123)/ `assistant/part-end`(5124)/ `tool/call`(5125)/
`tool/audit`(5128)/ `tool/result`(5130)。**事实全在账上,分岔在
`materializeModelHistory` 的轮次切分**:那一轮没有被切成独立的一格,正文被折进了
上一格。嫌疑指向这条会话上的 `session/cleared` 遮蔽段与轮次重建的交叉(§15.21 收口
的是同一条会话的 **surface** 化石,这一条是 **history**,不是同一个类)。

**按 §15.19 第七节的先例:停在诊断,不在本批修**。它是真实使用那半边门的产出
(CLAUDE.md 说的"unknown unknowns"),需要单独一批,而且要先决定它是投影缺陷还是
这条化石会话的既有伤 —— 判据是**换一条干净会话能不能复现同一形状**。

---

### 16.15 F1 回归修复批落地记录:被别人的截断溅到的 `tool/result`(2026-08-27,opus 执行,未提交)

**一句话**:F1(`fc572b20`)让写侧的活 surface 看得见 `tool/result` 之后,截断类命令的
replace 区间会顺手圈进**在途 run 落下的那一格结局**;读侧的工具结果剪枝按 `resultSeq`
判,就把一次**还活着**的调用整个摘掉 —— 每次请求复发一条历史失配。三刀:写侧收口(A)、
读侧判据改正(B,治已烙的存量)、外加一颗与 F1 无关的独立老雷(C:分裂重放会静默吞掉
未结算那一轮的真实正文)。

#### 一、回归链(从 §16.13 第八节那条"新红"追下来)

真机 `ef079fd7-d6ca-42a4-887b-499767593b7a`,场景是**工具在途时用户插话 → steer →
edit-resend**。账本上那一段的形状:

```
seq 5106  run/start   r1 → a1            ← 这条 assistant 消息的 surface 格
seq 5125  tool/call   c=…20941 (turn 2)  ← 第 2 轮的调用,还在跑
seq 5127  user/message u2 "chrome没有弹出来mcp连接申请，"   ← 用户插话,落到 surface 上
seq 5130  tool/result c=…20941           ← 在途那次调用的结局,排在插话**后面**
seq 5132  user/message-edited  replace[5127..5130]  sourceEventSeqs=[5127,5130]
```

1. **写侧**(`backend/session/event-surface.ts:119` 的 `rangeFrom`):按位置 `order.slice(at)`
   一刀切到末尾,于是 5130 进了区间 —— 而它归属的 `run/start@5106` 在段外,**那条
   assistant 消息还在 surface 上**。
2. **读侧**(`core/session/projection/model-history.ts:282` 的 `pruneShadowedToolCalls`):
   判据是"`resultSeq` 被遮 → 摘掉整次调用"。于是 `a1` 少了一次调用。
3. **后果**:`splitAssistantMessageIntoTurnGroups` 因此只剩 1 组 → 退回 collapsed →
   模型历史里**少一对 `assistant(toolCalls)` + `tool(result)`**,那一轮的正文并进前一格。
   §16.13 第八节记的 `.length a=401 / b=404`、`358.role a=user / b=assistant` 就是它。

引擎那边这次截断只删了用户那句往后的消息,`a1` 连同它的两次调用**一个字节没动** ——
所以这是**投影单边错**,不是两侧都错。

**全库只读扫描**(433 份 `events.jsonl`,`foldSessionProjection` + 现判据):
`pruneShadowedToolCalls` 今天在整个真机 store 上**只剪掉过这 2 次调用**,全都是这一类
坏区间,全都在 `ef079fd7`。压缩那一路一次都没走到这里 —— 整段前缀遮蔽时那条 assistant
消息自己也被遮了,节点根本不进 `nodes`。

#### 二、三刀

**A —— 写侧收口**(`packages/backend/session/event-surface.ts`)。
`rangeFrom` 的 replace 区间与 `sourceEventSeqs` 不再吞"**归属节点起点在 `start` 之前**"
的尾随格:活 surface 额外记一张 `tool/result seq → 它所属 run 的 run/start seq` 的表
(`run/start` 建号 → `tool/call` 把 callId 挂到当前 run → `tool/result` 优先按 runId 解、
其次按 callId、最后退回最近一条 `run/start`;三条线索都缺 = 没有归属 = 不设限,与修复前
逐字相同),`rangeFrom` 从尾部往回剥掉归属在段外的那些格。`wholeRange` 不动。

只修**尾随**格是机械约束不是取巧:replace 的 op 在 `SurfaceIndex.applyReplace` 里是
`order.slice(from, to+1)` 的**位置连续段**,中间挖洞表达不出来。而这一类格只会出现在
尾部 —— 它们正是"这条消息落账之后、这次截断之前"那段时间里在途 run 落下的结局。

**B —— 读侧判据改正**(`core/session/projection/{surface,model-history}.ts`)。
判据从"`resultSeq` 被遮"改成"**调用与结果被同一次遮蔽一起摘掉**"。
`tool/call` 不是 surface 节点,`shadowed` 里永远没有它,所以问法必须是**区间**的:
`SurfaceIndex` 记下每一次遮蔽实际摘掉的那一段(`{from,to}` = removed 的 seq 最小/最大)
与"每一格是被第几次遮蔽摘的",新口 `isShadowedWith(eventSeq, memberSeq)` 回答"摘掉
`memberSeq` 的**那一次**,连 `eventSeq` 一起摘了吗"。问同一次而不是任何一次 —— 别的
截断顺手覆盖到这个 seq 号段与这次调用毫无关系。

- `ef079fd7` 两条坏区间当场自愈:`tool/call@5125` 落在 `[5127..5130]` 之外 → 不剪。
- 压缩整段前缀遮蔽:调用与结果都在段内 → 照剪,行为不变(而且如上所述,今天真机上
  这条路一次都没走到)。
- 这是**读侧语义修正治存量**,与批 P 同判例;canonical 零豁免。

**C —— 独立老雷收口**(`core/engine/history.ts` + `core/session/projection/model-history.ts`,
与 F1 无关,是本次诊断顺手挖出来的)。

`contentParts` 有一道 `requestSettled` 闸(被 abort / 出错重试的那一轮不落 part),
`message.content` **没有** —— 那一轮的正文实时写在 content 上却没有对应的 part
(reducer.ts:1655 有闸 / 1686 `materializePartText` 无闸,不对称)。而分裂重放
(`splitAssistantMessageIntoTurnGroups`)只按 part 重放,于是那一段**真实正文**在下一次
请求里凭空消失。从前那里只挡住"一格 part 文本都没有"这一端。

- **C①**:判据收紧成"逐格相加 == 整条正文"(比较忽略空白 —— 分裂路径按 `\n\n` 重粘,
  content 是 delta 直接累加,健康的消息只在空白上不同)。对不上就**退回 collapsed**:
  宁可少一次忠实重放,不肯丢一个字。判定只此一处
  (`historyContentPartsCoverContent`,导出给投影侧用同一个函数问)。
- **C②**:`checkTurnSplitFallback` 补盲。这一格从前是盲的 —— 掉了那一格 part 之后
  剩下的常常只属于一个回合,`if (!missing && turns.size <= 1) return` 提前返回,把一次
  **真的少了一段正文**当成正常情况放过去。现在先问"正文装全了吗",不全就记一条
  新的 `ProjectionIssue{kind:'content-parts-incomplete', where:'history.contentParts'}`。

**C 的行为方向是"更不丢内容"**,并且**两侧同时改**:store 侧那条消息的
`contentParts` 也缺同一格(引擎的落点就是 `persistTurnContentParts`),所以两侧一起
退回 collapsed,恒等门照旧相等。

#### 三、反事实读数(全部实跑,只读)

**存量自愈证明(真机 `ef079fd7`,只读重折)**。b 侧的输入用 `projectChatMessages(events)`
顶替 store —— 那正是 S1 影子断言在每个 `run/end` 钉住的等式(这条会话的 chat 影子是绿的),
而它的 `messages.jsonl` 早已永久停写(63 行,根本没有这两条消息),离线取不到 store 那一份。
两侧过**同一条** `buildHistoryMessages` 配方,只差取数路:

| 判据 | `a` = `projectModelHistory` | `b` = 引擎配方 | 逐条不等 |
| --- | --- | --- | --- |
| 旧(`resultSeq` 被遮就剪) | 381 | 382 | **54** 条(自 idx 327 起全线错位) |
| 新(同一次遮蔽才剪) | 382 | 382 | **0** |

**全库回归**(433 份账本,同一对比逐会话跑两遍):`worse: 0 / better: 1 / same: 432`
—— 只有 `ef079fd7` 从 54 → 0,没有任何一条会话因为 B 变差。

**C 的影响面**(全库扫描,`canSplit` 新旧判据对比):surface 上 400 条助手消息里
**5 条**(分布在 3 个会话)从"能分裂"翻成"退回 collapsed",一共**追回 10142 个
非空白字符**的真实正文 —— 那正是从前每次请求都在静默丢掉的那一段。

#### 四、用例与反证

| 用例 | 位置 | 反证(必红) |
| --- | --- | --- |
| B:在途结局被别人的截断溅到 → 不剪,`c1`/`c2` 与两条结局都在,且 `a==b` | `core/session/__tests__/projection-contract.test.ts` §16.15 组 | 把第二问换成 `return false`(退回旧判据)→ 红 |
| A:尾随的"别人家"`tool/result` 不进区间 | `backend/session/__tests__/write-side-visibility.test.ts` F1-a 组 | `trimForeignTrailingToolResults` 换回 `order.slice(at)` → 红 |
| A 的对照:归属就在段内的结局照旧跟着遮 | 同上 | —(收口只针对"别人家") |
| C:未结算那一轮的正文退回 collapsed 且不丢 + `content-parts-incomplete` 可见 | `core/session/__tests__/projection-contract.test.ts` §16.15 组 | 判据换回 `hasPartText` → 红 |

三条反证均已实跑确认为红,随后原样还原。

#### 五、验收

- `typecheck` 0(node + web);
- `packages/core/session` + `packages/core/engine` + `packages/backend/session` 定向 451/451 绿;
- `packages/backend` 全包 2398 绿 / 1 skip(首轮有一条 `sessions-delete-cascade` 的
  `waitGone` 计时抖动,单跑与复跑均绿);
- 全量 `vitest run` 11927 绿,唯一一条红是 `renderer/App.container-layout` —— 它属于
  工作树里**另一条会话**未提交的 `App.vue` / `useShellLayout.ts` 改动,与本批零交集;
- 四门:`boundary:gate` ok(0)、`session:gate` ok(0 new)、`log:gate` ok(4 known,none new)、
  `transport:gate` ok(42 常量 / 四壳 2392 行,未变);
- 真机只读 `sessions:verify:gate` ok —— 13 known,**none new**;
- `sessions:shadow-battery` **GREEN**:runs 321 / historyChecks 449 /
  mismatches **0** / duplicates 0 / projectionIssues 0 / droppedParts 0 /
  appendFailures 0 / refoldMismatch 0 —— 零项逐项同基线。

#### 六、留在账上的两条

1. **A 只修尾随格**。归属在段外、却排在段**中间**的 `tool/result`(在途 run 在插话之后
   又落了一格结局、再之后才开了新 run)今天表达不出来 —— replace 的 op 是位置连续段。
   全库零例;真要修,得先给 surface 的 op 词汇加"非连续遮蔽",那是另一批。
2. **`pruneShadowedToolCalls` 今天在真机上是一条零命中的路**。它存在是为了 §3.1 表里
   那格"工具结果剪枝"将来能用同一个 replace 机制表达 —— 那个生产者还没写。真写的时候
   要一并决定"只遮结果格"这种 op 下 `isShadowedWith` 怎么答(今天它会答 false =不剪),
   而不是默默让它生效。

### 16.14 F4-b 战役重排(2026-08-27,用户拍板 B:翻 §14.5,硬推终局)

用户在 §16.13 三条拍板上选 **B**:推翻 §14.5"内存双视图长期保留"的旧裁定,接受
渲染层 + history 改造代价,把 reducer 合一推到底。§14.5 原文就此作废(翻案记录:
2026-08-27,用户;原裁定的"收敛=大改、存储收益零"事实判断仍准确,被推翻的是
"因此不做"的结论)。战役分四期:

| 期 | 交付 | 门 |
|---|---|---|
| **F4-b1 step id 语义统一** ✅ **已落地(§16.16)** | 两硬阻塞之一:step 身份在发射器(uuid)与投影(`step-<callId>`)两侧统一为单一语义(以 callId 派生为准或事件携带 id,勘察后定),STEP_UPDATED 的渲染层绑定全程不断 | battery + 渲染层定向 + 流式真机走查 |
| **F4-b2 收尾链脱锚** ✅ **已落地(§16.17)** | 两硬阻塞之二:settle 快照(:629)与结局读取(:533/:578)不再依赖 store-only 形状(锚点住渲染层 S3w-0 已定;被取消工具结局经 tool/annotate+captureCancelled 已有产地);**活 run 共存口径成文**:活 run 窗口内消息由引擎写手持有,物化缓存只答已收尾世界 | battery + §15.16 同型走查(正文不丢) |
| **F4-b3 合一切换** ⛔ **停在诊断(§16.18)** | 原案:13 条命令的 core reducer 分支删除,store=投影物化缓存;①类 8 处判据源切投影(补 O(1) hasMessage);告别对账(全量 battery+真机 verify 全绿)→ 恒等门退役,refold 独守;session:check 规则改写("字段赋值只许在投影 reducer")。**勘察结论:切不动** —— 引擎九个热写入口**绕开命令面**、那条路上零事件产地(逐口实测不等,`content` 126/126);§16.11 拍板 3(占位产地)三期都没做(88/88 `<整条投影缺>`);§16.17 第四节的共存口径与"store=物化产物"正面冲突。待用户在 §16.18 第五节两条上拍板 | 告别对账全绿为前置(**未开跑**) |
| **F4-b4 终局总结** | §16.x full 终态声明、终态架构图、常驻门清单、全部留账归档 | — |

**③④ 两条可感知差的处置(默认口径,用户如异议随时改)**:
- ③ `partialResult` 键集差:按 F4-b2 的共存口径**结构性消解**——它是活 run 瞬态,
  settle 后本就剥离(dehydrate 判例),物化缓存不携带,活窗口由引擎对象持有,
  终态无行为变化。
- ④ `thinkingTime`:合一后统一取投影值(store 侧今天缺失)——方向是"多保留一格
  真实读数",接受。

风险登记:F4-b3 之后正确性凭据只剩 refold(§16.13 已述,用户知情拍板);b1/b2 期间
恒等门仍在场护航,按批推进门红即停。

### 16.16 F4-b1 落地记录:step 身份语义统一(2026-08-27,opus 执行,未提交)

§16.14 战役表第一期。**硬阻塞①(§16.13 第二节)已拆除**:step 的身份在全链路
(引擎发射器 → store → IPC/渲染层 → 事件 → 投影物化)只剩一种语义。

#### 一、勘察:step id 今天的全部产地与消费者

| # | 产地 | id 形状 | 生产里活着吗 |
|---|---|---|---|
| 1 | `core/engine/stream-processor.ts:526` `handleToolInputStart` | `createStepId()` = `createCoreId()` **uuid** | **是** —— agent-loop 那条路的占位 step 就出自这里 |
| 2 | `backend/wiring/engine/stream/tool-execution.ts` `createStep` → `createToolExecutionStepWithFactory({createId: createCoreId})` | **uuid** | 旧编排器路径(`tool-orchestration.ts:975`,只在"按 id / 按 toolCallId 都找不到既有 step"时才走) |
| 3 | `runtime/src/toolkit/ipc-observer.wiring.ts` `stepFromEvent` | `` `${callId}:${event.id}` `` | **零生产者** —— 全仓没有一个工具发 `ToolEvent{type:'step'}`(子步骤是有合同没产地的观察面) |
| 4 | `core/session/projection/reducer.ts` `materializeStep` / `materializeOrphanSteps` | `` `step-${callId}` `` | 是(投影侧) |
| 5 | `renderer/stores/helpers/tool-step-view.ts` `stepFromToolCall` | 裸 `callId` | 渲染层本地合成,不持久、不回写 |

消费者:
- **store**:`core/session/commands.ts:329` 的 `patchStep` —— `steps.findIndex(step => step.id === command.stepId)`,**严格按 id**,找不到就静默 `noChange`;
- **渲染层**:`chat.ts` 的 `handleStepAdded` / `handleStepUpdated` / `findMessageStep` 三处**早就是 `s.id === stepId || s.toolCallId === …` 的双判据**,`useSessionEvents.ts` 的 `STEP_UPDATED` 是单判据(`s.id === event.stepId`);
- **事件账本**:`events.jsonl` 的事件类型表里**根本没有 step 这一类**(`core/session/events/types.ts`),`stepId` 从来没有落过盘。

**非工具 step:不存在。** 这是选方案的关键读数 —— `CoreStepForToolCall.toolCallId` 是
**必填**;三个产地(占位 / 编排器 / 子步骤)每一个都写了 `toolCallId`;`Step.toolCallId`
在契约上可选,只是因为渲染层那份合成 view 复用了同一个类型。所以"纯 reasoning/text step
没有 callId 怎么办"这一格是空的,甲方案不需要第二条派生来源。

#### 二、选甲(全链路统一为 callId 派生),理由

**决定性的一条:那个 uuid 没有任何持久存在。** `messages.jsonl` 自 F4-a 起停写
(§15.22),冷加载 `hydrate.ts` **无条件**走投影(S3w-1,档位已在 F4-a 烧掉)——
也就是说 uuid 只活在**进程内的那一个 run 窗口**里,重启之后同一条 step 本来就已经
叫 `step-<callId>` 了。§16.13 记的"旧会话 id 断代"这条代价,**读数上早就是现状**,
甲不新增它。

对照方案乙(事件携带引擎 uuid):要给 `run/start` 或 `tool/call` 加一格 `stepId`,
换来的是 ① 账本增量(每次调用多一个 36 字节的 uuid,而它承载的信息量 = 零,因为
它与 callId 一一对应)② 老账本必须走降级路径(没有那一格时回落派生),而降级路径
一旦存在,两套语义就**永远**并存 —— 那正是这一期要消灭的东西 ③ canonical 要为
新字段开新豁免。三条都是净负债。

**甲的成本清单(逐条兑现):**
- 事件账本:**零字节变化**(下面第四节有实测);
- 老账本:**不需要降级路径** —— 它们本来就是从投影折出来的,折出来就是 `step-<callId>`;
- 渲染层绑定:`chat.ts` 三处双判据、`tool-step-view` 三处 `toolCallId ||` 优先,**一处都不用改**;steps 列表也不拿 `step.id` 当 Vue `:key`(全仓核过);
- 唯一语义变化:新会话的 step id 从 uuid 变成 `step-<callId>` —— 而屏幕上没有任何一处显示 step id。

#### 三、改了什么

**唯一产地**:`core/engine/tool-step.ts` 新增 `coreStepIdForToolCall(callId) => \`step-${callId}\``,
从 `core/engine/index.ts` 导出。全链路四个点都改成调它:

1. `stream-processor.ts:handleToolInputStart` —— `createStepId()` 改成 `coreStepIdForToolCall(toolCallId)`;
2. `createToolExecutionStep` —— `options.id` 这个入参**删掉**,就地从 `toolCall.id` 派生
   (连带 `CreateToolStepOptions.id` / `CreateToolStepWithFactoryOptions.createId` 两个口一起删);
3. `reducer.ts` 的 `materializeStep` / `materializeOrphanSteps` —— 两处 `` `step-${…}` `` 字面量换成调用;
4. `CreateCoreStreamProcessorOptions.createStepId` / `CreateOnethingStreamProcessorOptions.createStepId`
   **两个注入口一起删** —— 这不是顺手清理:一个"可以注入任意 id 工厂"的缝就是这条 bug
   的形状本身,留着它等于把已经补好的洞重新打开(6 处测试调用点随之更新)。

子步骤(`stepFromEvent` 的 `<callId>:<stepId>`)**不动**:它已经是 callId 派生的确定性
id、与 `step-<callId>` 不冲突,而投影侧根本没有它的物化点(零生产者)。硬统一它只会
改一个没人读的字符串。

**边缝**:`headless-boundary-check.ts` 的 `checkRuntimeOwnsStreamProcessorAdapter`
从前把 `createCoreId` 列为 runtime 适配器的必备符号、把 `createStepId: createCoreId`
列为后端门面的禁令 —— 两条钉的都是"step id 的工厂归谁"。工厂已经不存在,两条一起
下线(禁令那条留着就是一条**永远匹配不到**的僵尸断言,P2 清过同一类);规则本身要守的
"装配 core 处理器的是 runtime 适配器"由 `createCoreStreamProcessor` 照旧钉住。

#### 四、canonical G1 **不收紧**(评估后的结论,附读数)

G1 = 「step 的 `id` 不参与比较」。合一之后它的原始理由("两侧本来就不可能相等")
已经消失,所以问题是真的:能不能收紧成"比对 id",让恒等门直接盯住 step 语义?

**答案是不能,而挡路的是老账本,不是纯度。** `sessions:verify`(真机常驻门)拿
`messages.jsonl` —— F4-a 起**永久停写**的存量抄本 —— 逐条过 `canonicalChatMessage`
零豁免比对。而那些抄本里的 step id 是停写那一刻的 uuid。真机实测:

| 读数 | 值 |
|---|---|
| `~/.onething/sessions` 会话数 | 443 |
| 带 `messages.jsonl` 的 | 441 |
| **抄本里带 uuid step id 的会话** | **284** |
| **抄本里的 uuid step id 条数** | **18126** |
| 抄本里已经是 `step-` 形状的 | 846 |

收紧 = 给 `sessions:verify` 加一条"老抄本 step id 豁免"。工单口径写死了这一条:
**若收紧需老账本豁免路径则不收**。照办,理由记在 `canonical.ts` 的 G1 注释里
(那条注释同时改口:前提已消掉,豁免留任的原因换成了老抄本)。

门看不见的那件事由**一条常驻合同**接住,见下。

#### 五、合同用例(流式走查替身)

`packages/core/session/__tests__/step-identity-contract.test.ts`,场景 = **多工具多轮 + steer**
(一条 run 两次调用其中一次流式参数 + steering 劈出第二条助手消息里的第三次调用)。

它**跨两条路取值**,不是两边问同一个函数(那样就恒真了):
- 引擎侧:真跑 `createCoreStreamProcessor.handleToolInputStart(...)`,读它自己记的
  `getStepIdForToolCall(callId)` —— 生产里 `sendToolInputEnd` / `existingStepId` /
  `stepIdsByToolCallId` 拿的都是这一格;
- 投影侧:真喂一份事件账本给 `projectChatMessages`。

断言 = 把投影物化出来的消息**当作 store**,replay 引擎会发的每一次 `patchStep(stepId)`,
三次全部命中且真的改到了(不是"返回值说命中")。第二个用例是反面:换回旧语义
(现生 uuid)三次全部 `changed === false` 且 `session` 原样返回 —— **静默落空**,
正是它当初躲过所有门的样子。

**反证实跑**:把 `handleToolInputStart` 的 id 临时改回一个随机串,该用例当场红
(`projection/engine step id split for call_bash_1: expected 'step-call_bash_1' to be 'COUNTERPROOF-…'`),
改回即绿。

#### 六、验收

| 项 | 结果 |
|---|---|
| `typecheck` | 0 |
| **battery** | **GREEN** —— 27 场景全 PASS(ok=7 failed=0 mismatch-lines=0 逐项),投影冷加载 lane / imported-history lane / 抄本 lane / write-failure lane 全 PASS;runs **321** / mismatches **0** / appendFailures **0** / refoldMismatch **0** / shadow.jsonl **0 行** —— 逐项同基线 |
| **字节回归** | **零**。结构上不可能变:事件类型表里没有 step 这一类,`STEP_ADDED`/`STEP_UPDATED` 是 IPC/总线事件、从不进账本。实测复核:battery 产出的 11 条会话 / 469 行 / 399KB 账本里,`data` 的键名**没有一个**匹配 `/step/i`;全库唯一提到 step 的那一行是 `message/imported` 的 fixture,而它那条 step 连 `id` 都没有 |
| 定向测试 | core/session + core/engine + backend/session + backend/wiring/engine + renderer/stores + renderer/composables + runtime toolkit/external-agents:**2131 passed / 0 failed** |
| 全量测试 | 11929 passed / **1 failed** —— 唯一红是**他会话在途**的 `App.container-layout.test.ts`(`App.vue` + `useShellLayout.ts` 的未提交改动,与本批零交集,已 `git diff` 逐文件核过) |
| 四门 | boundary:gate **0 failures** / transport:gate ok(42 常量 · 2392 行,一字未变)/ log:gate ok / session:gate ok(0)/ ui:gate ok(81 已知) |
| 真机 `sessions:verify:gate` | **ok — 13 known issue(s), none new**(全程只读) |

#### 七、留给 F4-b2 / b3 的账

- **硬阻塞②(锚点与收尾链)原样待拆** —— F4-b2 的题目,本批一个字没动;
- **③ `partialResult` 形状差 / ④ `thinkingTime`** 照 §16.14 的默认口径待兑现;
- **G1 的收紧点挂在存量抄本上**:哪一天 `messages.jsonl` 存量退役(或 `sessions:verify`
  的抄本对账 lane 退役),G1 就可以无豁免地收紧成"比对 id",届时恒等门自己就盯得住
  step 语义,第五节那条合同用例可以随之降级为回归护栏。**在那之前它是唯一的凭据。**

### 16.17 F4-b2 落地记录:收尾链脱锚 + 活 run 共存口径成文(2026-08-27,opus 执行,未提交)

§16.14 战役表第二期。**硬阻塞②(§16.13 第二节)已拆除**,但拆法不是"把那几格搬进
投影" —— 勘察下来那条路是错的。真正的答案是:**那三处根本不是"读 store",是读
活 run 的写手视图**;把这件事从"F3 遗留的例外"改判成**一条正式纪律**,并给它一个
说实话的名字与一道机械门。本批**没有任何行为改变**(生产改动是一次同实现的改名 +
三个调用点),账本字节零差。

#### 一、勘察题 1::629 settle 快照拿 contentParts 做什么

链路(实读):`completeAgentLoopStream`(`backend/wiring/engine/stream/agent-loop-executor.ts`)
→ core 的 `completeAgentLoopStreamWithAdapters` → `emitAgentLoopFinalMessageUpdateWithAdapters`
(`core/engine/agent-loop-executor.ts:1231`)。那一口做三件事:

1. `getMessage` 取材(**收尾修复的 read-modify-write 底稿**);
2. `finalizeLingeringAgentLoopToolWork` 算出 `{toolCalls?, steps?}` 的 COW 修复,
   经 `patchMessage{hint:'settle'}` 落盘;
3. `buildAgentLoopFinalMessageUpdate({...底稿, ...修复})` 发一条 `MESSAGE_UPDATED`,
   `updates` 的八格是 `content / reasoning / contentParts / toolCalls / steps / usage /
   errorDetails / isStreaming:false`。

**锚点在其中的作用 + 下游是谁**:第 3 步那条 `MESSAGE_UPDATED` 是**推送**,
**不是账本** —— `session-event-recorder.ts` 没有一处监听 `MESSAGE_UPDATED`
(实查:全仓 `MESSAGE_UPDATED` 的消费者是 IPCBridge / SSE / 网关外发 / core 的
`session.ts` 状态机,记录器一个都不在)。它的唯一去处是渲染层的
`chat.ts:updateSessionMessage`,而那一步是**整体覆盖**(`{...messages[i], ...updates}`),
**不跑** `rebuildContentParts`、**不补** `synthesizeToolAnchors`。所以快照里的
`contentParts` 带不带 `data-steps`,直接决定收尾那一刻渲染层还有没有锚点。

结论:**这是渲染侧的一份推送快照,不是账本取材** —— 它带渲染锚点不但不违反 G4,
正是 G4 的应有之义(锚点住渲染侧,而活 run 的引擎写手是它唯一的产地)。

#### 二、勘察题 2::533/:578 的结局读取 —— F2-c 之后还缺格吗

**不缺,但也不能改读投影 —— 理由整个换了。**

- 投影**能**产出收场结局:`reducer.ts` 的 `lingeringToolError`(:1103–1117)按
  `run.ended` + `run.outcome` 派生那句收场话;`materializeStep` 的 `annotatedText`
  (F2-c,:1297)在结局缺席时退到 `tool/annotate.result`,自报标题走 `reportedTitle`。
  §16.13 写的"投影不产出 steps 结局"**这句话已经不准**,本节勘误。
- 但 `captureCancelledToolResults` **读不成投影**,原因是**循环**:被取消工具那条
  `tool/result{cancelled:true}` 正是它自己经 `recordCancelledToolResults`
  (`session-event-recorder.ts:1135`)写出去的,而投影的 `tool.cancelled` 由
  `reducer.ts:632` 从那条事件派生。**产地读自己的产物 = 自引用,永远读空。**
  这是 §10.10「采集点不二次派生」的另一面,不是缺口。
- 顺带一条时序事实:收尾链整条跑在 `run/end` **之前**,`lingeringToolError` 的
  `run.ended` 此刻还是 false —— 就算不循环,窗口内也答不出。

判定:**改判,不是补格**。这两处的正确身份是"活 run 窗口内的写手视图读取",与
`getMessageFromStore`(reducer 底稿同源)是两个问题。

#### 三、脱锚路径:选 (b) 写手视图口,理由

工单给了两条路。**(a) 引擎写手自持对象**实测**不成立**:`AgentLoopExecutorState`
只有 `turn.orderedParts`(**单轮**),跨轮的 `contentParts` 全量只在 store 那一份上;
而且 `contentParts` 有第二产地(生图 `image-stream.ts` 的 `addMessageContentPart`),
让引擎另攒一份 = 新的第三条推导 + 一定会漏格(§15.16 同款风险)。

选 **(b) 查询面为活 run 提供"写手视图"口** —— 侵入最小(同实现改名),且它把
"F4-b3 要守什么"变成一个**可指认的口**,而不是散在三处注释里的默契。

| 位置 | 改前 | 改后 |
|---|---|---|
| `backend/session/reads.ts` | — | **新增** `getLiveRunWriterMessage(sessionId, messageId)`,实现与 `getMessageFromStore` 逐字相同,文档承载共存口径全文 |
| `agent-loop-executor.ts:530` `captureCancelledToolResults` | `getMessageFromStore` | `getLiveRunWriterMessage`,理由改判为"产地不读自己的产物" |
| `agent-loop-executor.ts:575` `emitFinalAssistantMessageUpdate` | 同上 | 同上,理由改判为"这次要写的 `tool/result` 是下面采集点的产物" |
| `agent-loop-executor.ts:629` `completeAgentLoopStream` | 同上 | 同上,理由改判为"锚点由写手产出、只走推送路;快照是整体覆盖" |
| `core/engine/agent-loop-executor.ts` | — | `CoreAgentLoopFinalMessageUpdate` 头注释 = 共存口径全文(core 侧落点),两处 `getMessage` 选项各挂一句指针 |

`getMessageFromStore` 因此**只剩一个消费者**:`commands.ts:379` 的
`truncateFrom{inclusive:false}` 底稿(①类判据同源),随 F4-b3 reducer 退役一起翻。

#### 四、共存口径(纪律原文)

> **活 run 窗口内,该 run 的 assistant 消息由引擎写手对象持有并唯一可信;
> 物化缓存只回答已收尾世界;窗口的边界 = `run/start` 到 settle 完成。**

三句逐句:

1. **"引擎写手对象"今天就是内存 store 上的那一条。** 引擎在窗口内按 id 寻址往它上面写
   (`patchStep` / `updateMessageToolCalls` / `addMessageContentPart`),同一批值同时推给
   渲染层。它不是"另一份缓存",是那条消息在活窗口内的**正身**。
2. **"物化缓存只回答已收尾世界"是给 F4-b3 的约束**:store 退化成投影物化缓存那天,
   物化**不得覆盖活窗口内的那条消息**。冷加载 / `hydrate.ts` 今天本来就只在窗口外跑
   (S3w-1),这条约束零成本。
3. **窗口边界**:`run/start` 起,到收尾链(`completeAgentLoopStream` /
   `emitFinalAssistantMessageUpdate` + `captureCancelledToolResults`)跑完为止。
   窗口外读写手视图没有意义 —— 那时该读 `listMessages` / `getMessage`(投影)。

**纪律覆盖的全部读取点(穷举,全仓 3 处,全在 `wiring/engine/stream/agent-loop-executor.ts`)**:

| # | 行 | 取材点 | 窗口内为什么非它不可 |
|---|---|---|---|
| 1 | :530 | `captureCancelledToolResults` | 产地不读自己的产物(第二节) |
| 2 | :575 | `emitFinalAssistantMessageUpdate`(错误 / abort 收场支) | 修复要回落的 `steps[]` 结局,正是 #1 待写的那几条 `tool/result` |
| 3 | :629 | `completeAgentLoopStream`(正常收尾支) | 快照的 `data-steps` 渲染锚点只在写手侧(第一节) |

落点:`reads.ts` 那一口(全文)、`core/engine/agent-loop-executor.ts` 的
`CoreAgentLoopFinalMessageUpdate` 头注释(全文)、本节。

#### 五、F3 ③类清单的处置:整类**改判并搬走**,写侧取材表只剩一类

| 文件 | 改了什么 |
|---|---|
| `session/reads.ts` | `getMessageFromStore` 的③类段删除,换成"F4-b2 又摘掉一条 + 只剩底稿同源一个消费者";新增 `getLiveRunWriterMessage` 承载口径 |
| `session/commands.ts` 文件头 | 例外表 二类 → **一类**(判据同源);③类改判段写明"F2-c 之后'投影不产出'不准,真理由是窗口 + 产地" |
| `session/command-events.ts` 纪律 3 | 同上,并指向 `getLiveRunWriterMessage` |
| `__tests__/event-production-write-side-read.test.ts` 文件头 | 从"两类例外的护栏"改成"一类例外 + **活 run 共存口径**两组护栏" |

**§16.13 第五节那张共存表随之勘误**:表里"settle 那一格 = 不能"的判据是"读的正是
投影不产出的那几格" —— 第二节证明那句话对结局那一半不成立,对锚点那一半成立但它
**本来就该住写手侧**。两格合起来,那一行的结论从"不能"改成"**不需要** —— 物化缓存
本来就不该管活窗口"。

#### 六、用例与反证(全部实跑)

| 用例 | 位置 | 钉住什么 | 反证 |
|---|---|---|---|
| `ships the data-steps render anchor in the settled snapshot` | `wiring/engine/stream/__tests__/settle-emit-writer-view.test.ts`(**由 `settle-emit-transcript.test.ts` 改名**) | **调用点门**:spy 让两条读法分岔,断言 `completeAgentLoopStream` 打的是 `getLiveRunWriterMessage`、`getMessage` 一次都没被叫,且快照仍带 `data-steps` / `tool-call` | 三个取材点任一改回 routed `getMessage` → **红**(实跑:改名当口这条门第一时间红) |
| `the settle snapshot keeps render anchors when it reads the live-run writer view (§15.16 同型)` | `wiring/engine/__tests__/core-agent-loop-executor.test.ts` | **§15.16 同型合同**:同一条消息两种取材(带锚点 / 投影形状),逐字复刻 renderer 的整体覆盖,断言 ①写手侧覆盖后锚点还在 ②投影侧覆盖后锚点归零 ③**两侧正文逐字相同**(§15.16 定性:丢的是分界不是数据) | 结构自证(两支同表断言) |
| `render anchors (data-steps) live only on the writer view, never on the run-path ledger fold` | `session/__tests__/event-production-write-side-read.test.ts` | **口门**:账本侧只有正文(run 路上锚点无产地)、写手侧带锚点,断言收尾链那一口取写手那份 | 断言里换成 `getMessage` → **红**(实跑) |
| `the live-run writer view keeps the tool's self-reported title…`(原"批 9") | 同上 | 断言一字未动,**理由改判**为"窗口 + 产地",取材口随之改名 | — |

**勘察实况一条(用例里已记档)**:`appendMessage` 那条路(整条已收尾消息直接落账)
**是**会把 `contentParts` 原样写进事件的 —— 所以"账本里从来没有 `data-steps`"只对
**run 那条路**成立。第一版用例照"永远没有"写,当场红,按实况改成 run 路的搭法。

#### 七、字节回归(HEAD `9fd5eccb` worktree 双跑)

两棵树各跑 `shadow-battery --passes 1 --seed 4041 --keep-store`,把 55 条会话的
`events.jsonl` 全量对拍:

| 项 | 读数 |
|---|---|
| 会话 / 行 | **55 / 55**,**1629 / 1629** |
| 事件类型直方图(28 类) | **逐格相同** |
| 会话的事件类型序列(35 种) | **逐条相同** |
| 归一后差异行 | **0**(见下) |

归一掉的全部是**跨树不可比的环境坐标**,每一条都追到成因:时钟 / 序号
(`time` `seq` `dt` `time0` `durationMs`)、随机身份(uuid / `auditId` 的
`时间戳_callId_随机`)、以及**路径依赖量** —— 两棵树的仓库根与临时 store 名不同,
于是 `turnContext.skills`(内含技能 SKILL.md 绝对路径)、`systemPromptHash`、
`assistant/chunks` 的工具参数正文(`mkdir -p <store>/work/...`)与它们的散列 /
长度(`hash` `contentHash` `len`)必然不同。归一后剩下的最后 2 行差异是
`/private` realpath 前缀 —— **归一器自身的残留**,不是账本差异。
worktree 与两份临时 store 已删除。

(结构上也不可能变:本批生产改动是**同实现改名 + 三个调用点**,记录器一处都没动,
`MESSAGE_UPDATED` 从来不进账本。)

#### 八、验收(全部实跑)

| 项 | 结果 |
|---|---|
| `typecheck` | **0**(node + web) |
| **battery** | **GREEN** —— 27 场景全 PASS(ok=7 failed=0 mismatch-lines=0 逐项);runs **321** / historyChecks 449 / mismatches **0** / duplicates 0 / projectionIssues 0 / droppedParts 0 / appendFailures **0** / refoldChecks 225 / refoldMismatch **0** / shadow.jsonl **0 行** —— **逐项同 §16.16 基线**;四条泳道(投影冷加载 / imported-history / 抄本 / 写失败探针)全 PASS |
| 字节回归 | **0 差异行**(第七节) |
| 定向测试 | `packages/backend` + `packages/core`:**367 文件 / 3421 passed / 0 failed** |
| 全量测试 | **11931 passed / 1 failed** —— 唯一红是**他会话在途**的 `App.container-layout.test.ts`(`App.vue` + `useShellLayout.ts` 的未提交改动,与本批零交集),与 §16.16 那一轮同一只 |
| 五门 | boundary:gate **0 failures** / transport:gate ok(42 常量 · 2392 行,一字未变)/ log:gate ok(4 已知)/ session:gate ok(0)/ ui:gate ok(81 已知) |
| 真机 `sessions:verify:gate` | **ok — 13 known issue(s), none new**(全程只读) |

#### 九、留给 F4-b3 的账

- **b3 的唯一新约束**:物化缓存**不得覆盖活 run 窗口内的那条消息**(第四节第 2 句)。
  三个受纪律保护的读取点已经在第四节穷举成表,b3 照表核对即可,不必重新勘察。
- **①类 8 处**(判据同源)原样待 b3 —— `getMessageFromStore` 今天只剩 `truncateFrom`
  底稿那**一个**消费者,b3 补 O(1) `hasMessage` 之后可以整口退役。
- **③ `partialResult` 形状差**照 §16.14 默认口径:它是活 run 瞬态,窗口内由写手持有、
  settle 后本就剥离(dehydrate 判例),物化缓存不携带 —— **本批的共存口径已经把它
  结构性消解了**,b3 只需不去物化它。**④ `thinkingTime`** 仍待 b3 兑现。
- **一条与本批无关的现场事实(只报告)**:开工时 `docs/design/session-event-sourcing-2026-08.md`
  的工作树版本把 **§16.16 整节 132 行删掉了**(HEAD `9fd5eccb` 有,工作树没有;
  文件 mtime 落在本批跑全量测试的那几分钟内 = **他会话在途覆盖**)。本批按 HEAD 原样
  补回了那 132 行,另一处纯空白改动(第 5950 行附近)未动。若那次删除是有意的,
  撤回这次补回即可。

### 16.18 F4-b3 勘察结论:**停在诊断**——「命令即事件」在**五条绕开命令面的引擎热写路**上从来没有成立过(2026-08-27,opus 勘察,**零生产代码改动**)

工单第 1 步是勘察,并写明「任何一步与勘察矛盾就停在诊断」「剩真差 → 停诊列清」。
勘察做完了,结论是**停** —— 但阻塞点**不是** §16.13 说的那两条(b1/b2 确实把它们
处理掉了),而是一件此前三期都没量过的事:**F4-b3 要切换的那条"命令 → 事件 →
fold → 物化"的链,在引擎最热的九个写入口上根本不经过命令面,那条路上一条事件
都不产生**。本节是那份诊断:两枚探针的读数、逐口不等表、以及给用户的拍板包。

#### 〇、一句话

F4-b3 的前提是「命令产出事件 → fold(F1 同步可见)→ store 视图从物化取」。
**前半句对 13 条命令成立(F2 已成),但引擎的流式写手不走这 13 条命令。**
实测:`packages/backend/stores/sessions.ts` 上有 **23 处** `sessionMessageRuntime!.*`
直接调用,它们是 core 引擎注入的 store 端口实现(文件头自己写着"不是死路径…
接口形状 P0 不许动"),`addMessageContentPart` 那一处的注释更是明写
「引擎的 `persistTurnContentParts` 走的是这条路(**不是命令面**)」。

于是在这九个口上,「事件」与「store 写」是**两个不同的生产者在不同时刻各写一次**
(store 写在这里,事件由 `session-event-recorder.ts` 另行采集)。两条推导到
**run 收尾**时重新合流(恒等门因此常年 0 失配),但在**每一次写的那一刻**是错相的
—— 而"物化替代 reducer"要的恰恰是**那一刻**相等。

#### 一、探针与读数(两枚,跑完即删,`git checkout` 已确认与 HEAD 逐字相同)

**探针 A(§16.13 原法复跑)**:`shadow.ts` 的 `checkSessionRunShadow` 里,恒等门
canonical **之前**把 `materializeNode(node)` 与 `listMessagesFromStore` 逐格对拍。
`sessions:shadow-battery --passes 1 --seed 4041`,读数:

| 项 | §16.13(b1/b2 之前) | 本次(HEAD `bf3ea781`) |
|---|---|---|
| 恒等门 `mismatches` | 0 | **0** |
| 逐格不同的**路径**数 | 50 | **51**(1212 行) |
| `steps[].id` | **42 命中** | **已消失** ✅(b1 的成果) |
| `contentParts` 整族 | 在 | **原样在**(`[].type`×24 / `[].content`×24 / `.length`×24 / `[].turnIndex`×21 / 整格缺×2 / `contentParts[]`×34) |
| `thinkingTime`(④) | 73 | **74**(A 有 / B 缺) |
| `partialResult` 族(③) | 在 | **原样在**(`details.*` 十余格 + `partialResultIsPartial`×10) |
| `<消息数>` | — | **88 条记录全部相等** |

51 vs 50 是重新分桶(`partialResult.details.title/metadata` 与 `contentParts[]`
从 §16.13 的合并行拆开单列),不是新增回归。**b2 在数据层一格都没动**——它是改判
不是补格,这一点与 §16.17 自述一致。

**探针 B(本节新法,回答工单真正要问的问题)**:把「每条命令/每个端口执行完的那一
刻,投影物化出来的消息数组 ≡ reducer 写进 store 的那份吗」直接量出来 ——
命令面用一层透明包装,九个绕行端口就地采样。同一条 battery,读数:

| 口 | 采样 | 不等行 | **结构性不等**(非豁免噪声) |
|---|---|---|---|
| `appendMessage` | 176 | 868 | **`<整条投影缺>`×88 + `<消息数>`×88** —— 每一个 run 的 assistant 占位 |
| `patchMessage` | 152 | 1044 | `isStreaming` A=true/B=false ×38;`toolCalls[].status` A=executing/B=cancelled ×6 |
| `truncateFrom` | 4 | 4 | **无**(只有 `eventSeq`) |
| `deleteMessage` | 3 | 3 | **无**(只有 `eventSeq`) |
| `patchSession` | 56 | 56 | `<投影折不出>`×56(会话级命令,不涉消息数组) |
| **`port:updateMessageContent`** | 126 | 1551 | **`content` A="" / B="我查一下。" ×126 —— 126/126,无一例外** |
| **`port:updateMessageReasoning`** | 18 | 108 | **`reasoning` A缺 / B有 ×18 —— 18/18** |
| **`port:addMessageStep`** | 42 | 496 | `steps` A缺×30、`toolCalls` A缺×30、`steps.length` 1↔2 ×12 |
| **`port:updateMessageStep`** | 206 | 4242 | `steps[].result` A=""/B={content:[]} ×62、`toolCalls[].changes`(edit diff)A缺×12 |
| **`port:updateMessageToolCalls`** | 208 | 3268 | `toolCalls` A缺×114、`steps` A缺×84、**`steps[].toolCall.status` A=completed/B=executing ×44**(这次是**投影领先**) |
| **`port:addMessageContentPart`** | 128 | 2432 | `contentParts[]` A缺×54、`[].type` A=reasoning/B=data-steps ×42 |
| **`port:updateMessageStreaming`** | 94 | 1710 | **`isStreaming` A=true/B=false ×118**、`usage` A缺×74 |
| **`port:updateStepsUsageByTurn`** | 112 | 2102 | `contentParts` 整格 A有/B缺×68(**投影领先**)、`.length` 3↔2 ×22 |

读法只有一句:**在九个热写入口上,把 store 换成"此刻物化出来的那一份",等于把这次
写的东西丢掉(或者把还没写的东西提前写进去)**。`content` 那一行最干脆 ——
126 次采样 126 次不等,投影侧是空串,store 侧是这次刚写进去的正文。

#### 二、三条阻塞(按"能不能只换实现"排序)

**① 九条热写路不经过命令面,那条路上零事件产地。**
第一节的表就是证据。要让物化成为替代,得先把这九个口的事件产地搬到**与 store 写
同一个同步段**里 —— 那不是"删 reducer 分支",那是把 `session-event-recorder.ts`
的采集时机整体重排,而记录器的采集点本身还带着 §10.10「采集点不二次派生」与
§16.17 第二节那条**自引用**约束(`captureCancelledToolResults` 读的正是它自己
待写的 `tool/result`)。规模是一整期,不是本批的一步。

**② 流中 assistant 占位在账本上仍然没有那一格 —— §16.11 拍板 3(F4 的硬前置)没做。**
`command-events.ts:126` 一行写死:`if (message.role === 'assistant' && message.isStreaming) return`
—— 占位一条事件都不写,它在 surface 上的那一格要等 `run/start`。探针 B 量到的
**88/88 `<整条投影缺>`** 就是这件事的实测形态(88 = 本次 battery 的 run 数)。
§16.12 留账 1 与 §16.11 拍板 3 都把"补齐 `run/start.data` 上的占位字段"列为
**F4 合一的硬前置**;b1 做的是 step id,b2 做的是收尾链,**这一条三期都没人做**。
在它补上之前,`appendMessage` 之后物化 = 把刚创建的 assistant 消息删掉。

**③ §16.17 第四节的共存口径,与工单的终局定义正面冲突。**
b2 立的纪律原文是:「活 run 窗口内,该 run 的 assistant 消息**由引擎写手对象持有
并唯一可信**;物化缓存**只回答已收尾世界**」,并且第 1 句自己交代了「引擎写手对象
**今天就是内存 store 上的那一条**」。而工单的终局是「store 的消息数组 = 投影物化
产物 …… 老 reducer 路径删」。两句话要同时成立,只能是引擎另持一份写手对象 ——
而 §16.17 第三节**实测过那条路不成立**(`AgentLoopExecutorState` 只有单轮
`turn.orderedParts`,跨轮 `contentParts` 全量只在 store 那一份上;`contentParts`
还有生图 `image-stream.ts` 这个第二产地)。

所以本批第 2 步"逐命令把 reducer 应用改为物化取值"没有一个**逐格等价**的落点:
13 条命令里只有 `truncateFrom` / `deleteMessage` 两条零结构性不等,而它们恰好是
**不产出消息内容**的两条数组形状命令,换掉它们既不减一条推导也不动一格内容。

#### 三、③④ 两条可感知差:口径仍然成立,但它们不是瓶颈

- **③ `partialResult` 形状**:§16.14 的默认口径(活 run 瞬态、settle 后由
  dehydrate 剥离、物化不携带)在**语义上**成立,探针 A 也确认它整族仍落在
  `DERIVED_STEP_CACHE_KEYS` 豁免里。**但它是被阻塞①②挡在后面的**,本批没有兑现的
  落点。
- **④ `thinkingTime`**:74 命中,A 有 B 缺,`ALWAYS_DROPPED_KEYS` 明文豁免
  (理由写在表上:"投影从 chunks 的时刻算,引擎那份账里它是渲染层事后写上的")。
  用户已拍"取投影值"。同样等合一。

两条都不是停的原因 —— 停的原因是第二节那三条。

#### 四、①类 8 处判据源:原样待解冻,理由一字未变

§16.13 第四节已经量过(321 run / 0 分岔)、§16.17 留账也点过名。但那一节自己
写死了因果:「这 8 处的解冻**依赖**合一,不是反过来」。今天 reducer 仍是"改不改得成"
的裁决者,判据就必须与它问同一份 store —— 否则会出现"事件写了而 store 没改"
(或反过来)。合一没发生,这 8 处原地不动;`hasMessage` 那个 O(1) 口也不该先加
(加了就是一个零消费者的口)。

#### 五、给用户的拍板包(F4-b3 要往下走,必须先答这两条)

1. **先补 §16.11 拍板 3 吗?** 它是三期都跳过的硬前置,而且是**唯一一条**
   §16.11/§16.12 早就点名、至今没人做的。建议单列一期 **F4-b2.5**:让流中
   assistant 占位在 `run/start.data` 上有完整产地(model / provider / agentId /
   timestamp / role),门 = battery + 探针 B 上 `appendMessage` 的
   `<整条投影缺>` 从 88 归 0。
2. **九条热写路怎么办?** 三选一,都要单独一期:
   - **甲(补产地)**:把九个端口的事件产地搬进与 store 写同一个同步段,
     记录器相应改成"只做那些命令表达不了的采集"。收益最大,代价是重排采集时机,
     并要直面 §16.17 第二节那条自引用。
   - **乙(承认两个世界)**:正式把 §16.17 的共存口径写成**终局**而非过渡 ——
     store 在活 run 窗口内是写手正身、窗口外是物化缓存,`applySessionCommand`
     缩成"写手"并改名,F0 恒等门保留。F 线到此收官,`session:check` 规则改成
     "字段赋值只许在投影 reducer **或写手**"。
   - **丙(硬推工单原案)**:同时做甲 + 让投影产出 `data-steps` / `isStreaming`
     —— 后者与 G4 和 §16.13 阻塞②的既有裁定直接冲突(原话:"违反'锚点住渲染侧'
     (G4),canonical 要开豁免"),**不推荐**。

按 §16.3 与用户"行为裁定须先问"的既有指令,这两条不由执行侧顺手拍。

#### 六、本批的账

- **生产代码改动:0**(两枚探针跑完即删;`git diff HEAD -- packages/backend
  packages/core packages/onething-runtime/src/sessions` 空,`packages/` 下 4 个
  untracked 全是他会话在途的 grok / renderer 文件)。
- **文档改动:2 处** —— §16.14 战役表的 b3 行改口 + 本节。
- **实跑读数**:
  - `sessions:shadow-battery --passes 1 --seed 4041`(带探针,三跑)—— runs **87** /
    historyChecks 117–119 / **mismatches 0** / duplicates 0 / projectionIssues 0 /
    droppedParts 0 / appendFailures 0 / refoldChecks 62–63 / **refoldMismatches 0** /
    `session-shadow.jsonl` **0 行**。(`--passes 1` 下 `runs 87 < min-runs 200`,
    门按口径判 RED —— 与 §16.13 / §16.12 那几跑同一个已知口径,不是失配。)
  - 真机 `sessions:verify:gate` —— **ok, 13 known, none new**(全程只读)。
- **告别对账 / 恒等门退役 / `session:check` 改写:都没跑,也不该跑** —— 它们是
  "切换完成之后"的动作,而本批没有切换。**F0 恒等门照旧上岗。**

#### 七、真机只读对账:§16.13 第八节那条红**还在,而且长大了**(仍停在诊断)

顺手跑 `sessions:shadow-report`(只读),读数:

```
runs 72 / historyChecks 251 / mismatches 10 / duplicateMismatches 14
projectionIssues 0 / droppedParts 0 / appendFailures 0
refoldChecks 18 / refoldMismatches 0
byKind { history: 10 }   skipped { history-steer-window: 3 }
lastMismatchAt 2026-08-27T03:42:21.729Z
```

与 §16.13 第八节读到的是**同一条**:全部 `kind:'history'`、全部落在化石会话
`ef079fd7`(§15.21 那条 `Session cleared`)、形状仍是"事件侧的模型历史少了一对
`assistant(toolCalls)` + `tool(result)`,那一轮正文被并进前一格"。从 4 条长到
10 条,是用户 03:31→03:42 继续在那条会话上聊天的自然结果,**不是新类**。

**与本批无关**可判定:本批生产代码改动 0,battery 跑在一次性临时 store 上,
从头到尾没写过 `~/.onething`。**按 §15.19 第七节的先例,照旧停在诊断**;它的
判据 §16.13 已经写好 —— **换一条干净会话能不能复现同一形状**。

`refoldMismatches 0`(耐久层)在真机与 battery 上双绿,这一条对"恒等门将来能不能
只留 refold"是正面读数。

### 16.19 现状架构梳理 + F4-c 三定律方案(2026-08-27,Fable;用户要求"梳理与方案同卷")

#### A. 现状全图(HEAD bf3ea781,每条注明出处批)

**磁盘层(已终局)**:每会话唯一持久化 = `events.jsonl` + `blobs/`(批 6a/6b);
messages.jsonl 停写删码,存量只读化石(裁定 9a);meta.json 存会话外壳。

**事件写入(两扇门一只眼)**:
- `appendSurfaceAwareEvent`(event-surface.ts:255)——带 surface 记账的门(命令面用);
- `appendSessionLogEvent`(event-log.ts:385)——素门(采集器用);
- `registerSessionLogEventAppendObserver`(event-log.ts:354,F1)——**同步可见钩子**:
  两扇门都过它,活投影与活 surface 在排队落盘**之前**单源前进。
  磁盘侧异步队列 + 四处语义 fsync 检查点 + 关停排空(批 5)。

**四条数据流**:

1. **命令流(用户发/编辑/删/清)**——已完成"命令即事件"(F2 三批):
   renderer → RPC → sessionCommands → **command-events(13 命令唯一事件产地)** →
   appendSurfaceAwareEvent(F1 同步可见)→ 老 reducer 应用 store(F0 验证器侧)→ 推送。
   实测:非流式命令的"物化 ≡ store"已近零差(§16.18 探针 B:truncate/delete 零)。
2. **流式流(AI 回答中)——终局唯一未竟之地**:
   provider SSE → 引擎 chunk →
   (a) 渲染:coalescer 16ms 合帧 → session:stream(U0 双发闸默认 legacy);
   (b) **store 热写:18 个 `sessionMessageRuntime` 端口直调**(stores/sessions.ts,
       updateMessageContent/Reasoning/Streaming/Steps/ToolCalls/addMessageStep/
       addMessageContentPart 等)——**这条路零事件产地**;
   (c) 账本:recorder 吃共享 part 边界状态机(U0,core/session/part-boundary.ts),
       打包成 assistant/chunks,段末/检查点经素门落账;run/start|end、request/*、
       tool/call|annotate|result 各有产地(F2-c 后 annotate 齐)。
   → **store 与账本在流式窗口内是两个生产者,run 收尾才合流**(§16.18 探针 B:
   九路热写全错相,126/126 content 差、88/88 占位整条缺)。
3. **读流(产品读路)**:sessionReads → 投影 fold+materialize(S2b);冷加载补水=投影
   (批 3);渲染锚点 renderer 自合成(S3w-0);IPC/SSE 推送面不变。
4. **收尾流**:settle → finalize(写手视图口 getLiveRunWriterMessage,F4-b2)→
   恒等门比对(F0:事件=真相 a,store=验证器 b)+ refold 采样(批 4,文件字节 vs
   内存,分片 ≤16ms)。

**门体系**:refold(耐久,常驻)、恒等门(语义,F0 方向)、verify(存量只读对账)、
hydration-contract、battery(27 场景四泳道)、五道棘轮(boundary/session/log/
transport/ui)。

**终局堵点一句话**:流式窗口的 18 端口热写没有事件产地,"store=fold"在窗口内无米下锅
(§16.18 三阻塞;其中占位产地=拍板 3 未兑现,恒等门常绿系只在合流点比)。

#### B. F4-c 三定律方案(优雅版;取代 §16.14 战役表 b3 之后的路线)

**定律一:只有一种词汇,delta 是逻辑单位。** 每个事实(模型吐一字、工具出一段、
用户发一条)是一条逻辑事件;折叠、reducer、canonical、UI 流只说这种话。不存在
"瞬态/持久"两个事件物种。

**定律二:打包是压缩,不是语义。** events.jsonl 的打包行(assistant/chunks 攒 N 字)
定性为**存储编码**:写入端逻辑 delta 进编码器,编码器按段落边界刷打包行(时机与
字节与今天逐字节相同);读取端解码回 delta 流再折。U0 的共享边界状态机迁居编码器
(它本来就该住那)。唯一合同:**decode(encode(x)) ≡ x**(编解码器性质测试)。
上一版"瞬态事件道+边界交接断言"两个补丁由此消失。

**定律三:短命事实必须被证明会被取代。** 一种事件允许不持久化,当且仅当后续某条
持久事件使它冗余(工具中途输出 ⊂ 最终结果)。短命种类登记在词汇表旁**封闭策略表**,
每种一条收敛性质测试(带它折与取代后不带它折,同态)。

终局:**store = fold(事件流),无活窗例外**——第一个字即事件,折叠当场前进;
编码器写缓冲是唯一"内存领先磁盘"窗口,归存储层(fsync 检查点原管),非语义例外。
磁盘格式/账本体积/渲染层/IPC:零变化。

**现状件 → 终局归宿映射表**:

| 现状件 | 终局角色 |
|---|---|
| part-boundary 状态机(U0) | **编解码器的编码半边**(迁居,合同随迁) |
| recorder 的打包段 | 编码器写入端(素门落账时机不变) |
| 18 个热写端口 | 签名不动,实现=**发逻辑事件**(折叠前进即写) |
| 老 reducer(core/session/commands.ts) | **删除**(c4)—— c4 停在诊断(写手窗口);**c4-b 已退役写手窗口**(§16.25 三把钥匙);**c4-c 把 B 案真做了一遍并回退**(§16.26):性能前提成立(`getSession` ~39 次/run,不逐 token)、静默期物化 ≡ store(90 采样 89 等),但 `retry-message` 当场红 —— 根因是**流式 assistant 占位在账本上没有 append 期产地**(产地是其后的 `run/start`,实测 322/644 次落后一拍),读侧换装会清掉写模型手里刚建的那条占位。**c4-d 一批切完**(§16.27,用户裁甲第二形态):`run/start` 提前到与 `store.addMessage` 同一同步段,读侧改从物化取,15 端口空转,5 条零调用命令面包装删除。**reducer 本身没删** —— 它今天是「会话级派生的算法 + S0 合同测试 A 线的词汇」,不再是消息数组的维护者 |
| 恒等门(F0) | c4 告别对账后**退役** —— **已退役**(§16.24) |
| refold | **保留**,唯一常驻耐久门(比对点=编码器刷新点,游标守卫语义不变) |
| 投影 reducer | 唯一状态推导;学会折逻辑 delta(数组累积 O(1)) |
| coalescer / IPC / renderer | **零变化** |
| command-events / lifecycle-events | 原样(命令流已终局) |
| getLiveRunWriterMessage(F4-b2) | 退役(窗口消失,c4)—— **c4-b 已删除**(§16.25 钥匙①/②/③ 拆掉三条依赖:锚点现算、abort 按登记簿寻址、用量结算从折叠产物取) |
| canonical 豁免表 | 按定律三重述(短命=策略表条目,非杂项豁免) |

**分期(c1–c5,每期是定律的一块)**:

| 期 | 交付 | 门 |
|---|---|---|
| **c1** | ~~出生事实补齐:run/start 携占位全字段,折叠出生占位(拍板 3 兑现)~~ **已改判并结案(§16.20):产地与折叠分支 F4-a 时就齐了,88 是取样窗口的读数**。c1 的实际产出 = 那份读数 + 窗口宽度记档,零生产改动 | ~~88→0~~ 改判:`run/start` 落账那一刻 88/88 逐格相等(实测) |
| **c2** | 编解码器就位:状态机迁居、读侧解码折叠、素门/带 surface 门写入走编码器;decode∘encode 性质测试;老文件逐字节同折合同 | **✅ 已落地(§16.21)**:字节回归 0 差、decode∘encode 性质测试绿、全库 433 账本折叠指纹 0 差、性能 1.04×、battery GREEN |
| **c3** | 18 端口翻转为发事件(分 2–3 小批,流式性能实测每 delta 折叠开销) | 探针 B 九路全零 + 性能预算 + battery。**c3-a 已落地(§16.23)**:18 口全量分类表 + 流式首刀(逻辑 delta 盖章即折)—— `reasoning` 18/18→**0**、`content` 126/126→**8/124**(残差 6 非前缀 + 2 整段,全是 C 类"另有产地"的非 provider 正文产地,不是滞后);`isStreaming` 按读数**改判不翻**(见 §16.23 第五节)。剩 c3-b(工具三口)/ c3-c(收尾三口) |
| **c4** | 非流式合一收尾、老 reducer 删除、告别对账、恒等门退役、session:check 改写、策略表+收敛测试落地 | **✅ 已落地(c4-d,§16.27;策略表+收敛测试顺延 c5)**;过程记录:**🟡 部分落地(§16.24)**:告别对账全绿(runs 321 / mismatches 0 / 真机 verify 无新增)→ **恒等门已退役**;三个死口删除;`thinkingTime` 兑现"取投影值";`refold` 补采;新立**端口事实断言**(逐格替身,battery 比过 265 次 0 失配)。**老 reducer 删除与 A 类端口空转停在诊断** —— 三条硬证据(settle 读写手视图的 `steps`/`data-steps` 锚点、abort 按 `isStreaming` 寻址、truncate 用量结算)都指向同一个根因:§16.17 的**活 run 写手窗口**今天由内存 store 承担,而本批口径是不动它。往下走要先裁定"写手窗口退役吗"(§16.24 第五节)。**c4-b 已把那三条依赖全部拆除并删掉 `getLiveRunWriterMessage`**(§16.25:锚点由共享纯件从折叠产物现算、abort 按活 run 登记簿寻址、截断用量结算从折叠产物取;施工中探针抓到三处真回归并各留一条合同用例)。**端口空转与 reducer 分支删除仍未做**,但挡路的只剩一格 —— store 的消息数组还由老 reducer 维护、而归约器自己要读它;往下 = 一次"读侧改从物化取"的切换 + 一次 A/B/C 性能裁定(§16.25 第四节)。**c4-c 按拍定的 B 案施工并回退**(§16.26,零生产代码留存):B 的性能前提**成立**、静默期物化 ≡ store **成立**(顺带结清 §16.23 第四节 C 类残差那次产地裁定 —— 它是时机差,静默期归零),但 battery 红在 `retry-message`,根因是**流式 assistant 占位没有 append 期产地**(`command-events.ts` 对 `isStreaming` 的 assistant 一条不写,产地是其后的 `run/start`)。挡路的已不是性能,是**一次产地裁定 + 一批不可再拆的完全切换**。**c4-d 一批切完(§16.27)**:用户裁甲第二形态 —— `run/start` 落账提前到与 `store.addMessage` 同一同步段(不开第二产地,§9.3 原样),占位在创建段末尾 **306/306 在场**、任何一次外部读上 **9626 次 0 缺**;读侧现取 + 失效号缓存(不是 `lastSeq`)、补水链 + 先深拷、仓库 `refreshMessagesFromProjection` 单点换装;15 端口整批空转、5 条零调用命令面包装删除、`session:check` 规则 B 第四次改写 + 规则 C 具名例外。**施工中查明 §16.26 没写到的第二条结构事实**:换装接上之后老 reducer 会在**自己刚写的那条事件之后**再应用一次同一条命令(delete/truncate 当场 `changed:false` —— `retry-message` 的红就是它,不是占位窗口),解法是把**归约器那一步**圈进一个定格段。battery GREEN、五门 ok、全仓 11934 绿 |
| **c5** | 三定律成文为系统宪法(§17),终态架构图,门清单;**定律三的策略表 + 收敛性质测试**(从 c4 顺延) | **✅ 已落地(§17 + `core/session/events/ephemeral-policy.ts`)**:7 条封闭策略条目(各带取代事件 / 收敛性质形状 / 可解析的证明指针),`canonical.ts` 的豁免表就此分家为**策略条目**与**杂项**两族;新增 `ephemeral-policy.test.ts` 8 条(指针逐条解析回磁盘 + 5 条收敛性质,各带反证);`content-part-guard.ts` 改从同一张表读,全仓不再有第二份瞬态名单。验收:battery GREEN(runs 321 / portMismatches 0 / refoldChecks 224 / refoldMismatches 0 / shadow.jsonl 0 行)、typecheck 0、五门 ok、真机 verify 仅 `room-1` 已知条 |

规模:c3 为主,全程约 4–6 批 —— **实际 c1…c5 共 8 批**(c1 / c2 / 真机污染三修 /
c3-a / c4 / c4-b / c4-c 停诊 / c4-d / c5),其中两批停在诊断、一批施工后整批回退。
§16.14 战役表 b3/b4 由本节取代(b1/b2 成果原样有效:step 身份、收尾链定性、
共存口径降级为 c3 完成前的过渡描述)。

**分期表终态化(c5 收章)**:上表五行今天全部结案 —— c1 改判结案(零代码)、
c2 / c3-a / c4-d / c5 落地、c3-b / c3-c 两小批**没有单独跑**:c4-d 的"读侧改从
物化取 + 15 端口整批空转"把它们的目标一次吃掉了(端口不再有"自己的写"要翻转,
翻不翻发事件这个问题随之消失)。终态口径见 §17。

### 16.20 F4-c c1 结论:**改判并结案**——88 是取样窗口的读数,不是产地缺口;`run/start` 落账那一刻占位 88/88 逐格相等(2026-08-27,opus 勘察,**零生产代码改动**)

工单第 1 条写死了岔路:「若发现 88 的根因是**取样窗口**而非产地缺失,如实改判并
停诊报告」。勘察走完,**正是那一支**。

#### 〇、一句话

c1 要补的那件事(「`run/start` 携占位全字段 + 折叠侧从 `run/start` 物化出占位」)
**F4-a(§16.12)那一批就做完了**,只是当时没人从这个角度量过。今天实测:
**`run/start` 落账返回的那一刻,88 个占位在折叠侧全部在场,而且与 store 那一份
逐格相等(canonical 判据 0 差,88/88)**。§16.18 探针 B 读到的 88/88
「整条投影缺」是真的,但它量的是 **`appendMessage` 返回那一刻** —— 那一刻
`run/start` 还没写。中间那段就是窗口,宽 **p50 0.21ms / max 2.4ms**。

于是 §16.18 第二节阻塞 ②(「§16.11 拍板 3 三期都没人做」)与 §16.12 留账 1
(「产地缺口这件事实还在」)两条,**按本节的读数一并结清**:产地在,字段齐,
折叠分支在。留下的是**次序**问题,而次序是 c3 的活。

#### 一、勘察题 ①:折叠侧的 `run/start` 分支今天物化出什么

**一条完整的占位助手消息,不是半条。** 逐处:

| 环节 | 位置 | 事实 |
|---|---|---|
| 事件产地 | `backend/session/runs.ts` `beginSessionRun` | `run/start.data` 带 `runId` / `kind` / `assistantMessageId` / `agentId` / `messageSource` / `provider` / `model` / `triggerMessageId` / `triggerEventSeq` / `timestamp` / `origin` / `continuesRunId` |
| 取材 | `wiring/engine/stream/stream-executor.ts:216-237` | 全部取自 **F4-a 前递进来的那条入库占位**(`params.assistantMessage`),不回读 store |
| 折叠 | `core/session/projection/reducer.ts:455` `case 'run/start'` | 当场 `register` 一个 `AssistantNode`,`time = data.timestamp ?? event.time`,`agentId`/`messageSource`/`provider`/`model`/`origin` 逐格搬过去 |
| 物化 | `core/session/projection/chat-messages.ts:130` `materializeAssistantNode` | 产出 `{id, role:'assistant', content:'', timestamp, provider, model, agentId, source, origin, isStreaming:true}` —— `isStreaming` 正是**由 run 未闭推导**(`...(node.ended ? {} : {isStreaming:true})`),与 §16.11 拍板 3 写的口径一字不差 |

**也就是说拍板 3 的两句话("补齐 `run/start.data` 上的占位字段"、"读侧物化出占位、
`isStreaming` 由 run 开闭推导")在代码里已经各有落点。** §16.18 之所以判成"没做",
是把探针 B 的窗口读数当成了产地读数 —— 这一处本节改判。

#### 二、勘察题 ②:88 缺在哪一环 —— **缺在取样点,不缺在产地**

探针(§16.18 探针 B 同型,两个采样点):
`appendMessage` 命令返回那一刻采一次(= §16.18 的取样点),
`run/start` 的 `appendSurfaceAwareEvent` 返回那一刻(F1 同步可见已发生)再采一次。
`sessions:shadow-battery --passes 1 --seed 4041 --concurrency 1`,**跑三次读数逐条相同**:

| 采样点 | 采样数 | 折叠侧在场 | canonical 逐格相等 | 备注 |
|---|---|---|---|---|
| `appendMessage`(流中 assistant 占位) | 88 | **0** | — | `<整条投影缺>` **88/88**,§16.18 的 88 一字复现 |
| `appendMessage`(user / system 消息) | 88 | 88 | **88/88** | 对照组:非流式那一半本来就齐(与 §16.18 truncate/delete 零结构差同一读数) |
| **`run/start`** | 88 | **88** | **88/88** | **零结构性不等**;`<整条投影缺>` **0** |

**判据之外的生料对拍**(判据会不会把缺口盖住?——列出来自己看):

| 格 | 命中 | 判据处置与出处 |
|---|---|---|
| `thinkingStartTime` | 88/88(store 有 / 投影无) | `ALWAYS_DROPPED_KEYS` —— 「纯 UI 活跃态(渲染侧自己走秒)」 |
| `toolCalls: []` | 88/88(store 有 / 投影无) | 「空数组 丢 —— `toolCalls: []` 与没有 toolCalls 是同一件事」 |
| `contentParts: []` | 4/88(store 有 / 投影无) | 同上一行,**实测值就是空数组**(探针打印过 part 类型:`[]`) |
| `eventSeq` | 88/88(投影有 / store 无) | 「投影独有的事件坐标,命令线没有它」 |

四格全部是 canonical 判据表上早有条目、且理由与本议题无关的格。**没有一格是
"占位少了个字段"。** 所以"补齐全字段"这件事没有落点 —— 它已经齐了。

覆盖缺口如实记:battery 的场景矩阵没有 room / agent 形态会话,`agentId` /
`messageSource` 两格在这 88 条上都是**两侧同缺**(与 §16.12 第五节的 0/0 同一条
缺口)。那两格由 §16.12 新增的两条端口合同用例覆盖,不由本探针覆盖。

#### 三、时序钉死:窗口是 **store 先、`run/start` 后**,宽 p50 0.21ms

工单第 3 条要的读数。三跑一致:

| 量 | 读数 |
|---|---|
| 次序 | **88/88 全部为正** —— `store.addMessage` 恒在 `run/start` 之前 |
| Δt(ms) | min 0.086 / p50 **0.21** / p90 0.43–0.70 / max 1.23–2.45(三跑) |
| 窗口内落账的事件条数(含 `run/start` 自己) | **1 条 ×84,2 条 ×4** —— 也就是说窗口里除了 `run/start` 本身,基本没有别的账 |

**窗口里跑的是什么**(逐行,`core-stream-engine.ts:916` → `stream-executor.ts:218`):

1. `store.addMessage(占位)` ← 窗口开始;
2. `await eventBus.emit(MESSAGE_ASSISTANT_CREATED)` —— **渲染层已经看见这条消息了**;
3. `store.getSession` + `history.buildMessages(store.listMessages())` —— **模型历史从一份账本还没记的 store 上建**;
4. `executeMessageStream` → `ensureSessionRun` → `appendSurfaceAwareEvent('run/start')` ← 窗口结束。

这就是三定律说的「写在事实前」的原形:窗口很窄(亚毫秒),但它里面**已经有两个
消费者**(渲染推送、模型历史)读到了账本上还不存在的东西。**本批只量、不改**
—— 改它是 c3(18 端口翻转为发事件)那一期的活,§16.19 的分期没有变。

顺带钉一条:`run/start` 之后紧跟的 `patchMessage{runId}`(`stream-executor.ts:240`)
发生在探针采样**之后**,所以上表那个"逐格相等"不是靠它凑齐的 —— 采样那一刻
两侧都还没有 `runId`。

#### 四、`command-events.ts:126` 那行 `return` 原样保留

工单第 2 条已经写明,本节的读数是它的正面证据:占位的产地是 `run/start`,
`appendMessage` 不该再写第二条(那就是 §9.3 判例说的"同一格两个产地")。
`event-production-write-side-read.test.ts` 里那条
`a streaming assistant placeholder has no ledger slot yet…` **照旧成立且照旧该绿**
—— 它钉的是"`appendMessage` 不写事件",不是"折叠侧折不出占位"。§16.12 留账 1
说的"哪天补上产地这里会红"这句预期**不成立**:产地补在 `run/start` 上,这条用例
不会因此变红。**这一句也一并改判。**

#### 五、本批的账

- **生产代码改动:0**。探针是三处临时改动(新增 `packages/backend/session/probe-c1.ts`
  + `commands.ts` / `runs.ts` 各两行钩子),跑完 `git checkout` 卸载;
  `git diff HEAD -- packages/backend packages/core packages/onething-runtime/src/sessions`
  **空**(`packages/` 下其余在途改动是他会话的 grok / renderer 文件)。
- **文档改动:2 处** —— §16.19 分期表 c1 行改口 + 本节。
- **用例:未新增**。按 §16.18 的停诊先例,本批不落任何代码。**建议但未擅自落地**:
  一条"`run/start` 折叠后立即物化出占位(含 id/role/timestamp/provider/model/
  origin/isStreaming)"的合同用例,把本节读数变成常驻棘轮 —— 它是纯增测试、零行为
  变化,但按 §16.3 与"行为裁定须先问"的规矩,停诊批不夹带,交给用户拍。
- **可复跑探针**:`scratchpad/probe-b-c1/`(`run-probe.mjs` 一条命令跑完
  装探针 → 建包 → battery → 出读数 → 卸探针;`probe-c1.ts` + `hooks.patch` 是料)。

#### 六、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `typecheck` | **0**(带探针时也是 0) |
| `boundary:gate` | ok — 0 failures |
| `session:gate` | ok — 0 known, none new |
| `log:gate` | ok — 4 known, none new |
| `transport:gate` | ok — 42 常量 / 四壳 2392 行,不变 |
| `packages/backend` + `packages/core` + `runtime/src/sessions` | **3520 passed / 0 failed**(1 skipped 文件 = voice live) |
| `sessions:shadow-battery`(seed 4041,带探针,**三跑**) | runs 87 / historyChecks 119 / **mismatches 0** / duplicates 0 / projectionIssues 0 / droppedParts 0 / appendFailures 0 / refoldChecks 63 / **refoldMismatches 0** / `session-shadow.jsonl` 0 行 —— **逐项同 §16.18 基线**(`--passes 1` 下 `runs 87 < 200` 照旧按口径判 RED) |
| 字节回归 | **不适用**:`run/start` 一格没加,生产代码零改动,双跑无从产生差异 |
| 真机 `sessions:verify:gate`(只读) | **FAILED,1 条新红** —— 见下节 |

#### 七、真机只读对账:一条**新红**,`room-1` 的 seq 断号(与本批无关,停在诊断)

```
[session-verify-gate] FAILED: 1 NEW issue(s) vs baseline:
  + room-1 seq: expected seq 2 at position 1, got 3
```

只读勘察:

- `~/.onething/sessions/room-1/events.jsonl` 只有 **2 行**:`seq 1 message/imported{synthetic}`
  (时刻是 epoch+1ms,批 6b 的补水合成)、`seq 3 user/message`(2026-08-27T07:12:06.307Z)。
  **`seq 2` 从来没落到盘上。**
- **全库扫描 433 个 `events.jsonl`,seq 不连续的只有这一条**(其余 432 条全连续)。
  所以它是一次孤立事件,不是一类。
- `app.jsonl` 全表 `appendFail` / `dropped` / `append failed` 关键词 **0 命中**;
  07:00–07:30 UTC 那段里 `room-1` 一条日志都没有(那段全是另一条会话
  `fe5261d9` 的权限流量)。**没有 appendFailure 记账,seq 却断了** —— 这两件事
  同时成立本身就是线索。

**与本批无关可判定**:本批生产代码改动 0;三跑 battery 全在一次性临时 store 上,
`ONETHING_STORE_PATH` 由 battery 脚本指走,从头到尾没写过 `~/.onething`;而那条
`user/message` 的时刻(本地 15:12)**早于本会话开工**(本会话第一次工具调用时
scratchpad 目录 mtime 已是 15:47),期间桌面端一直在跑(`app.jsonl` 写到 16:04)。

按 §15.19 第七节 / §16.13 第八节 / §16.18 第七节的一贯先例,**停在诊断**。
下一个人的判据(写在这里省得重推):**seq 是谁分配的、断的那一号是哪条事件** ——
`appendSurfaceAwareEvent` 返回 `undefined` 的那几支(会话不记账 / 写失败)会不会
已经把号占掉;`prepareSessionEventsOnce` 合成 import 那一步与随后第一条真事件之间
有没有第三方在同一条会话上分过号。`room-1` 是协作房间,它的入站不只桌面一条路。

**另记**:§16.13 第八节 / §16.18 第七节追着的那条化石会话 `ef079fd7` 的
`history` 失配,本批没有复跑 `sessions:shadow-report`(那是另一条线的账),
不在本节读数里。

### 16.21 F4-c c2 落地记录:**编解码器就位**——打包被判定为存储编码,写侧字节 0 差、读侧全库 0 差(2026-08-27,opus 施工)

定律二("打包是压缩,不是语义")这一期兑现完毕:**逻辑层只有 delta**,
`assistant/chunks` 那一行降格成存储编码;写入端把逻辑 delta 交给编码器,读取端
把打包行交给解码器展开再折。磁盘格式、账本体积、渲染层、IPC:**零变化**。

#### 一、模块落点

**`packages/core/session/events/chunk-codec.ts`(新,零依赖、零 node 引用)**,
经 `events/index.ts` 出口(`@onething/core/session` 与新增的
`@onething/core/session/events/chunk-codec` 两个入口都到得了)。三段:

| 半边 | 内容 |
|---|---|
| **段边界状态机** | U0 那台机器**整体迁居**(逐字保留三条规则与全部行为):`createCoreAssistantPartBoundaryMachine` + `CoreAssistantPartRef` / `…BoundaryResult` / `…BoundaryKind` / `…BoundaryOptions` / `…BoundaryMachine` |
| **编码半边** | `createSessionChunkEncoder` —— 攒批 + 两道闸(2s / 64 条)+ 刷行,`SESSION_CHUNK_BATCH_SIZE` / `…INTERVAL_MS` 的定义也搬来了。定时器 `schedule`、时钟 `now`、批大小全可注入(缺省 = 生产值),所以性质测试不必碰假时钟 |
| **解码半边** | `forEachSessionChunkLogicalDelta(data, visit)`(热路径:**借一格出去**,整行共用一个对象)+ `decodeSessionChunksEventData(data)`(数组形态,一条一个独立对象);`SessionLogicalDelta` = 一条已盖章的逻辑 delta(段身份 + 到达时刻 + 正文) |

**谁不住进去**:一段身上挂着什么(runId / messageId / turnIndex / 正文累计 /
len+hash / UI 流 / 掉账记账)仍然是调用方的账 —— 编码器按 `resolvePart` 向它问
身份,按 `onPartOpened` / `onPartEnded` / `onDelta` / `onPartDropped` 把判定回吐。
抄一份到编码器里就是第二个真相(`messageId` 会随 response-boundary 换锚点)。

#### 二、迁居清单(逐件)

| 从 | 到 | 备注 |
|---|---|---|
| `core/session/part-boundary.ts`(185 行,**整文件删除**) | `events/chunk-codec.ts` 上半 | 导出名一字未改;`core/session/index.ts` 的 `export * from './part-boundary.js'` 改成注释指路,`package.json` 的 `./session/part-boundary` 出口换成 `./session/events/chunk-codec` |
| recorder 的 `ChunkBatch` / `flushBatch` / `flushAllBatches` / `pushDelta` 的攒批半边 / `applyPartBoundary` / `state.batches` / `state.parts` | 编码器 | recorder 净减 ~140 行 |
| recorder 的 `SESSION_CHUNK_BATCH_SIZE` / `…INTERVAL_MS` 定义 | 编码器 | recorder 原样再导出,老调用点(两只测试)一字不改 |
| recorder 的 `deltaInto` / `tool-call-*` / `reserve` / `endAllOpenParts` / `flush` | 改喂编码器(`encoder.delta` / `toolInputStart|Delta|Done` / `reservePart` / `endAll` / `flushAll`) | 落账时机一格不变 |
| 留在 recorder | `registerPart`(段身份登记)、`endPart`(len/hash + `assistant/part-end` + UI 流)、`onDelta` 里的正文累计与 UI 小批、掉账计数 | 判定与记账分家之后,编码器才可能是纯件 |

读侧:`projection/reducer.ts` 的 `case 'assistant/chunks'` 不再 `text.join('')`,
改成 `forEachSessionChunkLogicalDelta(...)` → 新增的 **`foldAssistantLogicalDelta`**
(投影 reducer 学会的那句"折一条逻辑 delta")。同段连着来时带一个 `memo` 跳过
`ensurePart` 的重复查表(段号对不上照常查),正文累计是 `+=`(V8 rope,O(1) 摊还)。

#### 三、合同读数(全部实跑)

| 合同 | 做法 | 读数 |
|---|---|---|
| **写侧字节回归** | 新增 `backend/wiring/engine/stream/__tests__/session-chunk-bytes.test.ts`:固定剧本(四道闸各走一遍 + 换 kind 换段 + 参数流 + 自合成正文)、假时钟假定时器、runId 归一,读回 `events.jsonl` **原始文本**与金样逐字节比。金样 `fixtures/chunk-bytes-golden.jsonl` 是**在搬家前的树上录的**(把五个文件 `git checkout HEAD --` 回去跑一遍 `ONETHING_RECORD_CHUNK_BYTES=1`,再换回来比) | **0 差**(19 行 / 4262 字节,含 64 条闸、2 秒闸、part 边界、请求结束各一行) |
| **decode ∘ encode ≡ id** | 新增 `core/session/__tests__/session-chunk-codec.test.ts`:**用生产那台编码器本人**(不是测试里再写一份打包逻辑),真机形状剧本 1 条 + 定值种子随机剧本 200 条(随机批大小 1–6、随机 tick / 定时器 / 分界),解回来按段逐条比 | 5 条用例全绿 |
| **老文件解码折叠 ≡ 今天直接折** | `~/.onething` 只读全库:每份账本折两次 —— ① 直接折;② **把每行打包行拆成 N 条单 delta 行**再折;canonical 指纹比对。另与**搬家前 reducer** 的指纹逐会话比 | 433 账本 / 2,123,836 条 delta / 36,801 行打包行:①②**0 差**;搬家前 vs 搬家后 **0 差**(433/433) |
| **c1 建议的占位用例** | `projection-contract.test.ts` 新增 `c1: run/start alone materializes a complete streaming placeholder`(纯增,零行为变化):`run/start` 一落账就物化出 id/role/content/timestamp/agentId/source/provider/model/origin/isStreaming 齐全的占位,`run/end` 之后 `isStreaming` 消失 | 绿。**顺带钉住一格事实**:消息上的 `runId` **不在** `run/start` 那一刻(产地是紧跟其后的 `patchMessage{runId}`,§16.20 第三节),折叠侧照实说"还没有",不猜 |

#### 四、性能读数(全库真机只读,三跑取最小)

| | 搬家前 | 搬家后 | 比 |
|---|---|---|---|
| 433 账本折叠合计 | 1006.5 ms | **1045.6 ms** | **1.04×** |
| 最重的账本 `fe5261d9`(446k delta) | 38.0 ms | 46.9 ms | 1.23× |
| delta 最多的前 10 条账本 | — | — | 1.09–1.33×(最坏 `0c0adc56`:9.3 → 12.4 ms) |

预算(劣化 ≤2×)通过,**"打包直折"的快路没有保留**——一条路走到底。

到这个读数中间过了两轮:最朴素的写法(逐 delta 建对象 + 逐 delta `ensurePart`)
是 **1.23×**、重账本 2.1–2.8×(**超预算**);`memo` 跳重复查表拿到 1.18×;真正的
那一刀是**热路径不逐条分配对象**(整行借一格出去)→ 1.04×。这条经验记在这里:
**折叠热路径上,一条 delta 一个对象就是全库多花一倍时间的那一半。**
refold 门照常(battery 里 225 次采样,0 失配)。

#### 五、验收(全部实跑)

| 门 | 结果 |
|---|---|
| `typecheck` | **0** |
| `boundary:gate` | ok — 0 failures |
| `session:gate` | ok — 0 known, none new |
| `log:gate` | ok — 4 known, none new |
| `transport:gate` | ok — 42 常量 / 四壳 2392 行,不变 |
| `packages/backend` + `packages/core` + `runtime/src/sessions` | **3526 passed / 3 skipped**,失败集每轮不同(`sessions-delete-cascade` 的 `waitGone`、plugins 的三只 storage/KV 用例),**四只单跑 22/22 绿** —— 本机满载抖动的老毛病(与 4e4c79a5 那一批同款),四只都不在编解码器路径上 |
| `sessions:shadow-battery` | **GREEN** —— runs 321 / historyChecks 449 / mismatches 0 / duplicates 0 / projectionIssues 0 / droppedParts 0 / appendFailures 0 / refoldChecks 225 / **refoldMismatches 0** / `session-shadow.jsonl` 0 行 |
| 字节回归 | **0 差**(金样录自搬家前的树) |
| 全库真机只读折叠合同 | **0 差**(433 账本,两条判据都是 0) |
| 真机 `sessions:verify:gate`(只读) | FAILED,**仍是 §16.20 第七节那一条** `room-1 seq: expected seq 2 at position 1, got 3`,**无新增**(那条与本批无关,仍停在诊断) |

#### 六、本批的账

- **生产代码**:新增 1 件(`core/session/events/chunk-codec.ts`),删除 1 件
  (`core/session/part-boundary.ts`),改 4 处(`core/session/index.ts` /
  `core/session/events/index.ts` / `core/package.json` 出口表 /
  `core/session/projection/reducer.ts` / `backend/.../session-event-recorder.ts`)。
- **用例**:新增 2 个文件(codec 性质 5 条、字节回归 1 条 + 金样)+ 1 条纯增合同
  (c1 占位)。
- **未做,留给 c3**:18 个热写端口翻转为发事件(那一期才是"store = fold"落地),
  以及 `stream-coalescer` 侧的 UI 小批 —— 它今天吃的就是编码器盖过章的 delta,
  形状没变,所以本批一个字都不用改。

---

### 16.22 真机 store 测试污染三修落地记录(2026-08-27,opus 施工,未提交)

#### 〇、一句话

`vitest` 的某些用例用换 `HOME` 隔离 store,而事件账本的**落盘是排队异步的** ——
seq 在临时库同步分配,`appendFile` 的路径却写在队列回调里、要等回调跑到才解析;
回调常常跨过 `HOME` 恢复点,于是那条事件的字节**写进了真机库**,零异常、零记账。
三修:(a) 落点在同步段钉死并闭包进队列;(b) vitest 全局 setup 把 `HOME` 换成
per-worker 临时目录,让测试进程**结构上**够不着 `~/.onething`;(c) 收编三处
`os.homedir()+'.onething'` 直拼。数据清理与 verify 主人判据是 (d),**本批不做**。

#### 一、(a) 根治跨库写 —— `packages/backend/session/event-log.ts`

一条新纪律,一个新字段:`SessionEventLogState.logPath` —— **这本账钉死的落点**,
在"启用"那一刻解析一次,之后一律用它。语义边界说得出口:**一个会话的账本属于
它启用时的那个 store**;生产里 store 路径整个进程只解析出一个值,所以对生产
**逐字节无变化**,跨 store 的只有测试,而那正是要挡的(测试换 store 后想重新认路,
走 `resetSessionEventLogCache()` —— 所有 store 相关用例本来就这么做)。

逐处判定(全文件的路径解析点一个不落):

| 位置 | 从前 | 现在 | 理由 |
| --- | --- | --- | --- |
| `appendSessionLogEvent` 的队列回调 | 回调**里面**现算 | 同步段取 `state.logPath`,闭包进回调 | **这就是那个 bug**:seq/`expectedBytes` 记在旧 state 上,字节落进新 store,两边都不报错、两边的账都错 |
| `tryEnable` / `ensureSessionEventDir` | 各自现算 | **仅有的两个解析点**,解析后写进 `state.logPath` | 启用 = 认路 |
| `reloadCounters` | 自己现算 | 改收 `logPath` 参数 | 让解析点只有上面那两个 |
| `guardForeignWriter` 的 `statSync`(G12) | 现算 | `state.logPath` | 本来就在同步段,但它必须 stat **队列将要写的那份文件**;拿别的 store 的字节数去比,得出的"外写者在场"是假的 |
| `flushSessionEventLog` → `fsyncSessionLog` | `await state.queue` **之后**现算 | 新增 `flushOneSessionEventLog`:**第一个 await 之前**取 `logPath`,`fsyncSessionLog(logPath)` 收路径不收 sessionId | 与 append 同一类延迟解析。顺带:没有 state = 这个进程没往这个会话写过东西,自然没有在途写入要刷(从前那一次 fsync 打开的是"当前 store 里同名会话"的文件,能刷到什么纯属巧合) |
| `findLastSessionEventSync` / `readSessionEvents` / `readSessionLogEvents` / `readSessionLogEventsSync` | 现算 | `sessionLogPathFor()`(有 state 用钉死的,没有才现算) | 读侧必须读**写侧写的那份文件**;而且读的两处 `await` 版本现在都在**进 await 之前**同步解析 |
| `blob-store.ts` 的 `putSessionBlob` / `readSessionBlob*` | 现算 | **不动** | 逐一确认过:blob 那一路**全程同步**,没有"路径解析晚于调用"的窗口 |

反证用例:`packages/backend/session/__tests__/event-log-store-pinning.test.ts`
(2 条,不 mock 任何东西,就用真的 store 解析口)。在 append 与 flush 之间把
`ONETHING_STORE_PATH` 从 A 换到 B,并且**预先把 B 库里同名会话的目录摆好** ——
那正是真机的样子(目录存在 = 旧代码那次跨库写安安静静地成功,而不是 ENOENT)。
**修前 2/2 红**(`git stash` 掉 `event-log.ts` 实跑,字节确实落在 B),
**修后 2/2 绿**。

#### 二、(b) 全局硬闸 —— `vitest.setup.ts`

闸门装在 **`HOME`** 上,**不**装在 `ONETHING_STORE_PATH` 上。这一处与诊断给的
措辞不同,理由是实跑出来的:

- 装 `HOME`:默认 store 变成 `<临时 HOME>/.onething`,真机库结构上够不着;
  而已有那 9 个"自己换 `HOME` 做隔离"的用例**照旧生效**(它们只是把 `HOME` 从
  闸门给的临时目录换成自己的),显式设 `ONETHING_STORE_PATH` 的用例也照旧优先。
  顺带还盖住了 store 口以外的 home 直拼(rg 二进制目录、`login-shell-env` 缓存……)。
- 装 `ONETHING_STORE_PATH`:env 优先级高于 home,那 9 个用例的换 `HOME` 会当场
  变成一句空话 —— **实跑验证过**:`presence` / `sessions-delete-cascade` /
  `skill-review` 当场红 6 条(隔离没了,同 worker 内互相串味)。

粒度是 **per-worker**:同一个 worker 进程会顺序跑多个测试文件(env 在进程里活着),
所以用 vitest 自己的 `VITEST_WORKER_ID`(退到 `VITEST_POOL_ID` / pid),
`mkdtemp` 的随机后缀保证跨轮次不撞;`process.on('exit')` 收摊,
`ONETHING_VITEST_KEEP_STORE=1` 保留现场,`ONETHING_VITEST_REAL_HOME=1` 是逃生口。
`setupFiles` 在每个测试文件的模块求值之前跑,所以任何模块级 `getOnething*Path()` /
`os.homedir()`(Node 的 homedir 读 `$HOME`)也已经在闸后。

**9 个换 HOME 的用例在硬闸下全绿,一个字都没改。**

#### 三、(c) 收编硬编码

`rg` 全仓扫 `homedir()`(除 `scripts/` 与 `scratchpad/`),真正绕开 store 口的
直拼 **3 处,全收**:

| 文件 | 从前 | 现在 |
| --- | --- | --- |
| `runtime/src/themes/theme-runtime.ts:77` | `homedir()/.onething/debug/theme-tokens` | `path.join(getOnethingDebugDir(), 'theme-tokens')` |
| `runtime/src/themes/index.ts:441`(`getThemesFolderPath`,**还会 mkdir**) | `homedir()/.onething/themes` | `path.join(getOnethingStorePath(), 'themes')` |
| `backend/rpc/domains/evals.ts:118`(自动夹具**写**目录) | `homedir()/.onething/evals/fixtures/auto` | `getOnethingEvalsFixturesAutoDir()` |

一处**改判**:`themes/__tests__/theme-runtime.test.ts` 从前断言路径含 `.onething` ——
那是在给"直拼 home"背书(而且顺手在真机库里 mkdir 了一个 `themes/`)。改成
断言它**就是** `path.join(getOnethingStorePath(), 'themes')`:该断言的是"在当前
store 底下、名字叫 themes",不是 store 叫什么。

**留档不改(逐条理由)**:

- `runtime/src/files/ripgrep.ts:101`(`adapters.homeDir ?? homedir()` + `.onething/bin`)
  —— 是 **rg 二进制的安装位置**,不是 store 数据;改吃 store 根会让已下载的二进制
  找不到,而且会静默丢掉那个注入口。
- `apps/electron/src/app/login-shell-env.ts:68` —— 桌面启动期的机器级缓存,不是
  store 数据;搬家是可感知的行为变化,不在本批授权内。
- `apps/web/dev-api-proxy.ts` / `apps/electron/src/main/cli/paths.ts` /
  `gateway/src/core/storage.ts` / `core/storage/paths.ts` —— **不是违规**:它们是
  各自的 store 根解析器,`ONETHING_STORE_PATH || homedir()/.onething` 一字不差,
  而且后两个所在的包按边界规则本来就不能 import runtime 的 paths。

#### 四、验收(全部实跑)

| 门 | 读数 |
| --- | --- |
| 反证用例 `event-log-store-pinning` | **修前 2/2 红 / 修后 2/2 绿** |
| `typecheck` | **0** |
| `boundary:gate` / `transport:gate`(42 常量 / 四壳 2392 行)/ `log:gate` / `session:gate` / `ui:gate` | **五门全 ok,无上升** |
| 全量 `vitest` | **11940 passed / 8 skipped**,唯一失败是 `App.container-layout.test.ts`(另一路在途的 renderer 改动,基线同样红,与本批无关);抖动的 `sessions-delete-cascade` / `server/http` 每轮不同、单跑与整目录跑 3/3 绿 —— 本机满载的老毛病 |
| **真机零写入哨兵**(本批的真机门) | 哨兵文件落地 → 跑完一整轮全量 vitest → `find ~/.onething -newer <哨兵>` = **0**。**对照组**:把三修整体 `stash` 之后跑同一轮,同一道 `find` 数出 **7** 条 —— `app-state.json`、`channel-identity.json`、`debug/theme-tokens/flexoki-dark.json`、`evals/traces/s1/m1/round-{1,2,3}.json`(泄漏是活的,这就是它) |
| `sessions:shadow-battery` | **GREEN** —— runs 321 / historyChecks 449 / mismatches 0 / appendFailures 0 / refoldMismatches 0 |
| 真机 `sessions:verify:gate`(只读) | 仍是 §16.20 第七节那一条 `room-1 seq: expected seq 2 at position 1, got 3`,**无新增**(`events.jsonl` mtime 停在本批开工前的诊断复现那一刻) |

#### 五、本批的账

- **生产代码**:改 4 件(`backend/session/event-log.ts` / `backend/rpc/domains/evals.ts` /
  `runtime/src/themes/theme-runtime.ts` / `runtime/src/themes/index.ts`)。
- **测试基建**:`vitest.setup.ts` 加硬闸;新增反证用例 1 件;改判断言 1 处。
- **未做((d),等用户拍板)**:真机夹具沉积的**数据清理**(`~/.onething` 里那些
  测试年代留下的会话 / traces / debug 快照),以及 `room-1` 断号那条 verify 红线的
  **主人判据**(是收进基线、还是修数据)。本批全程只读真机库。

---

### 16.23 F4-c c3-a 落地记录:18 端口全量分类 + 流式首刀(逻辑 delta 盖章即折)(2026-08-27,opus 施工,未提交)

#### 〇、一句话

18 个 `sessionMessageRuntime` 端口按三定律逐口分了类(下面第二节那张表就是 c3 后续
小批的施工图);**首刀量出来的事实与工单的假设不同**:流式正文/推理这两口的差
**不是产地缺口,是纯滞后** —— 探针实测 `content` 126 次采样 126 次不等,而其中
**120/120 是"A 是 B 的前缀"**(112 次 A 整段为空)。产地早就在(recorder 盖章),
差的只是**折叠什么时候动**:编码器为了攒批把 delta 压在写缓冲里(2s / 64 条),
折叠要等打包行落账才前进。于是首刀不是"补产地",是**把逻辑事实与存储编码解耦**:
盖过章的那一条 delta 当场进折叠,字节照旧按两道闸攒。

读数:`reasoning` **18/18 → 0**,`content` **126/126 → 8/124**(残差 8 全是 C 类
另有产地的非 provider 正文,见第四节)。字节 **0 差**、battery **GREEN**、
每 delta 折叠开销 **0.017 µs**。

`updateMessageStreaming` 那一刀**按读数改判、没有翻**——它不是 D 类可空转的,
理由与反证在第五节。

#### 一、探针 C3(§16.18 探针 B 的逐口复刻;跑完即删)

装在 `stores/sessions.ts` 那 18 个导出包装的调用点上(**不包 runtime 对象**),
每次写完当场采一次:A = 活投影物化出的那条消息,B = store 缓存里的那条,
判据 = `canonicalChatMessage`(与恒等门同一台机器),外加一份生料差。
`sessions:shadow-battery --passes 1 --seed 4041 --concurrency 1`。

**探针自己踩过三个坑,每一个都会伪造读数,记在这里省得下一个人再踩:**

1. **`process.on('SIGTERM', () => { dump(); process.exit(0) })`** —— 这把 server
   自己的优雅收尾(flush 挂起写入)整个抢掉了,imported-hydrate 泳道于是拿到一个
   没落盘的 store,**当场两条失配**(`history` + `messages`,store 侧 0 条消息)。
   探针不许改变进程生命周期:**只挂 `'exit'`**。
2. **包装 runtime 对象**(复制属性表)—— 那个对象有自有可变字段
   (`pendingSqliteMessageSyncs` / `streamSyncThrottleMs` / …),复制一份就让
   "探针那份"与"本体那份"各自演化。改 `Proxy` 也不够干净,最后落到**调用点直接
   喊一声**。
3. **`getLiveSessionProjection` 会建表**(`prepareSessionEventsOnce` + 同步读整份
   文件)。挂在写路径上就改变了产品自己的建表时机 —— 采样前先问
   `hasLiveSessionProjection`,没有就不采。

三坑修完,带探针的 battery 与基线**逐项相同**(runs 87 / mismatches 0 /
refoldMismatches 0),读数才可信。

#### 二、18 端口全量分类表(c3 后续小批的施工图)

分类口径就是 §16.19 的三定律:**A 已有产地**(事实已在流上,端口翻转 = 空转或
发已有事件)/ **B delta 道**(增量,喂编码器)/ **C 需补新事实**(真事实、账本
无产地)/ **D 短命-被取代**(不持久化,fold 推导或仅活窗装饰)。

`samples/unequal` = 本次 battery 的采样数与 canonical 不等数(**c3-a 之后**的读数)。

| # | 端口 | 类 | 生产调用点(非测试) | 账本产地 / 折叠落点 | samples/unequal | 处置 |
|---|---|---|---|---|---|---|
| 1 | `updateMessageContent` | **B**(+C 残差) | `core/engine/stream-processor.ts:449`(provider 正文);另三个非 provider 产地:`image-stream.ts:67/80/83`、`context-compact.ts:170/221/259`、`media/image-generation.ts` | `assistant/chunks` → `foldAssistantLogicalDelta`;生图/压缩那三处另有各自产地(`assistant/part-end{synthetic|contentOnly}` / `session/compacted`) | **126/126 → 8/124** | **c3-a 已翻**(盖章即折)。残差 8 = C 类,见第四节 |
| 2 | `updateMessageReasoning` | **B** | `core/engine/stream-processor.ts:463`(仅 `placement==='top'`) | 同上;`materializeTopReasoning` 只取头一段 | **18/18 → 0** | **c3-a 已翻,归零** |
| 3 | `updateMessageStreaming` | **D(改判:今天翻不得)** | `stream-processor.ts:594`(finalize)、`image-stream.ts:87`、`stream-abort.ts` 三处、`image-generation.ts` 三处、`rpc/domains/chat.ts` | `isStreaming` 由 `run/start`/`run/end` 开闭推导(`chat-messages.ts:181`),**折叠早就会** | 94/90 | **不翻**,理由与反证见第五节 |
| 4 | `updateMessageContentParts` | A | `tool-orchestrator.ts:136` | `assistant/part-end` + parts 物化 | **0 调用**(本 battery) | 随 c3-c 收尾链一起 |
| 5 | `updateMessageSteps` | A | `tool-orchestrator.ts:129` | `tool/call|result|audit` | **0 调用** | 随 c3-c |
| 6 | `updateMessageStep` | A | `event-only-emitter.ts:343`、`rpc/domains/{chat,tools}.ts`、`tools/tool-call-state.ts`、`stream-abort.ts` | `tool/call` / `tool/result` / `tool/annotate`(F2-c 后 annotate 齐) | 206/114 | **c3-b** |
| 7 | `updateMessageToolCalls` | A | `stream-processor.ts` ×5、`tool-orchestration.ts` ×5、`agent-loop-executor.ts` ×4、`tool-execution.ts:127`、`rpc/domains/tools.ts` | 同上;参数流是 `tool-input` kind 的 delta 段 | 208/208 | **c3-b** |
| 8 | `updateMessageThinkingTime` | **D** | `rpc/domains/chat.ts`(**渲染层写回**)、`server/runtime.ts:2074` | `deriveThinkingTime` 从 chunks 时刻算;`ALWAYS_DROPPED_KEYS` 明文豁免 | **0 调用** | **不再写**(用户已拍"取投影值");退役随 c4 |
| 9 | `updateMessageSkill` | A | `event-only-emitter.ts:365` | `skill/activated` → `run.skillUsed`(reducer:694) | 2/2 | **c3-c**(端口改发已有事件或空转) |
| 10 | `updateMessageError` | A | `agent-loop-executor.ts:210/2370` | `run/end.error` → `run.errorDetails`(reducer:513) | **0 调用** | **c3-c** |
| 11 | `updateMessageReplyTo` | **死口** | **零生产调用**(只剩测试) | `message/patched`(已走命令面 —— 测试注释原话:"迁移前这条写走 `store.updateMessageReplyTo`;命令面上它是一次普通 patch") | — | **c4 直接删** |
| 12 | `updateMessageReactions` | **死口** | **零生产调用** | 同上 | — | **c4 直接删** |
| 13 | `updateMessageMentions` | **死口** | **零生产调用** | 同上 | — | **c4 直接删** |
| 14 | `updateMessageTurnContext` | A | `agent-loop-runtime.ts:266/271` ← `session-turn-context.wiring.ts` | `context/turn-update` → `node.turnContext`(reducer:684) | **0 调用** | **c3-c**(空转) |
| 15 | `updateMessageUsage` | A | `agent-loop-executor.ts:953` | `request/response.usage` 求和 → `node.usage`(reducer:529) | 74/74 | **c3-c** |
| 16 | `updateStepsUsageByTurn` | A | `agent-loop-executor.ts:741`、`agent-loop-turn.ts:38` | `request/response.usageTurnIndex` → `run.usageByTurn` → `steps[].usage`(reducer:536,§13.9) | 110/84 | **c3-c**(84 里 78 是 `contentParts <B缺>`——**投影领先**) |
| 17 | `addMessageStep` | A | `event-only-emitter.ts:338` | `tool/call` → `materializeSteps` | 42/42 | **c3-b** |
| 18 | `addMessageContentPart` | A | `agent-loop-executor.ts:1441`(`persistTurnContentParts`)、`image-stream.ts:72`、`image-generation.ts` | `assistant/part-end`;`data-steps` 锚点按 G4 **故意不进**(渲染坐标,非正文) | **124/4** | **c3-c**(已近零 —— c2 的编解码器收掉了大头) |

**三条读出来的结论:**

- **"九条热写路"其实是"三死口 + 五零调用 + 十条真在跑"**。§16.18 那张表把
  `updateMessageReplyTo/Reactions/Mentions` 算在里面 —— 它们**生产上一次都不调**
  (W8/W13.2/W14a 那三条 IM 写路早就走命令面的 `patchMessage` 了,测试注释白纸黑字
  写着"迁移前")。c4 删这三个口是纯减法,不需要任何产地。
- **C 类只有一格,而且只在 `content` 上**:生图/压缩那三条"引擎自己合成一段正文"
  的路。它们各自**有**产地(`recordSynthesizedText` / `session/compacted`),
  但产地不在**每一次 `updateMessageContent`** 上 —— 见第四节。
- **A 类占压倒多数(12/18)**:事实全都已经在流上,端口翻转是"空转 + 读改物化",
  不是"补词汇表"。**词汇表本批一个类型都不用加**。

#### 三、首刀:逻辑 delta 盖章即折(定律二的最后一格)

**判据先量,再动手。** 探针给 `content` / `reasoning` 每次采样多记一格:A 与 B
的字符串关系。

| | 改前 | 改后 |
|---|---|---|
| `content` | 126 采样 / 126 不等 —— **120 次 "A 是 B 的前缀"**(其中 112 次 A 整段为空)、0 次非前缀 | 124 采样 / **8** 不等 —— **116 次逐字相等**、6 次非前缀、2 次 A 整段为空 |
| `reasoning` | 18 / 18 —— **18/18 "A 是 B 的前缀"**,全是 A 整段为空 | 18 / **0** —— 18/18 逐字相等 |

**"纯滞后"这三个字就是本批的全部诊断**:产地在(recorder 盖章在前,引擎写 store
在后,同一条 `AgentStreamEvent` 分岔 —— `attachSessionEventRecorder` 里
`recorder.handle(event)` 排在 `existing?.(event)` 之前),折叠不在。**同一个 delta
本来就只进一次流**,工单担心的"重复写路"不存在;要归一的是**时机**。

改了什么(6 件,+185 −11):

| 件 | 改动 |
|---|---|
| `core/session/projection/reducer.ts` | 新导出 `foldSessionLogicalDeltaAhead(state, runId, delta)` —— 把私有的 `foldAssistantLogicalDelta` 开一个口给"提前折"。折的是与打包行**逐字相同**的那条逻辑 delta |
| `core/session/events/chunk-codec.ts` | `onDelta` 回吐口多一格 `at`(= 编码器盖的那个时刻,与打包行里 `time0 + dt[i]` 逐字相同)。**不加这一格**,提前折那份与重折那份的 `reasoningFirstAt/LastAt` 会差几微秒 |
| `backend/session/projection-cache.ts` | 新口 `foldLiveSessionLogicalDelta` + `liveSessionProjectionAheadDeltas`;`LiveProjection` 多一格 `aheadDeltas`(领先磁盘几条)。两条边界与 F1 那个观察者**逐字相同**:不主动建表、折坏了就丢缓存 |
| `backend/session/event-log.ts` | `appendSessionLogEvent` 的 options 多两格 `SessionLogEventAppendHints`(`projectionPreFolded` / `preFoldedDeltaCount`),透传给观察者。**不进 record,不落盘** —— 它是写入口对活状态说的话,不是账本内容 |
| `backend/wiring/engine/stream/session-event-recorder.ts` | `onDelta` 里提前折一次并逐段计数;`emitChunks` 按**逐条数对得上**声明这一行折过了 |
| `backend/session/refold.ts` | `aheadDeltas > 0` 时 skip 这次采样(§16.19 原话「比对点 = 编码器刷新点」) |

**两条自证纪律**(都写进了代码注释,也都有反证用例):

1. **声明按"逐条数对得上"发,不发"都折过了"**。只要这一批里有一条没折成
   (会话还没有活投影 / 那次执行的节点还不在),计数就对不上,整行照旧交给折叠
   —— 宁可整行重折一次(幂等,因为那几条本来也没折进去),不肯让一段正文静默消失。
2. **观察者不盲信那句声明**,它还要看这份投影自己记的 `aheadDeltas`。中间若因为
   尾巴溢出 / 折坏而**重建过**(`projections.delete` + 从文件整份重折),提前折进去
   的那几条已经随旧 state 一起没了,计数归零 —— 这一行就必须照常折。少这一句自证
   = 一段正文静默消失。

**磁盘格式 / 账本体积 / 渲染层 / IPC:零变化。** 字节回归金样(c2 录的)0 差。

#### 四、残差 8 是什么:C 类,不是滞后

改后 `content` 剩 8 次不等,分两种,**都不是时机问题**:

- **6 次"非前缀"** —— 投影侧与 store 侧是两段**不同的话**,不是一段话的两截。
  产地是 `updateMessageContent` 的三条**非 provider** 调用路:
  `image-stream.ts` 的失败分支正文、`context-compact.ts` 的三处(进度 /
  完成 / 失败卡片正文)、`media/image-generation.ts`。它们各自在账本上**有**产地
  (`recordSynthesizedAssistantText` 的 `contentOnly` / `session/compacted`),但那些
  产地落在**别的时刻、别的形状**上 —— 比如压缩卡片的正文在账本上是
  `session/compacted{summary,status}` 折出来的一整块,而 store 上是
  `buildContextCompact*Content` 拼的那段 markdown。
- **2 次"A 整段为空"** —— 提前折返回 `false` 的那两次(采样那一刻折叠侧还没有
  这次执行的节点),打包行随后自己折,不丢账。

**这两种都不该由 c3-a 处理**:第一种是"同一格两个产地"的老议题(§9.3 判例),
要么让那三条路也走盖章、要么承认卡片正文由 `session/compacted` 单独负责 —— 那是
一次**产地裁定**,按 §16.3 与"行为裁定须先问"不由执行侧顺手拍;第二种是采样窗口
(与 §16.20 第三节同型)。两条都留给 c3-c 与用户拍板。

#### 五、`updateMessageStreaming` 改判:D 类**语义**成立,但今天翻不得(带反证)

工单第 2 步写的是「按 D 类处理,端口实现改空转或断言」。语义上完全对 ——
`isStreaming` 确实由 run 开闭推导,折叠侧 `chat-messages.ts:181`
(`...(node.ended ? {} : { isStreaming: true })`)早就会。**但读数说反了方向**:

```
updateMessageStreaming  samples 94 / unequal 90
   isStreaming <B缺> × 90      ← A(投影)有,B(store)没有
```

也就是说这一口被调用的那一刻(`finalize()`,`false`),**store 当场把这一格摘掉,
而折叠侧的 run 还没闭**(`run/end` 落在其后的收尾链里)。端口改空转的后果是:
store 那条消息从此**一直带着 `isStreaming: true`**,而投影在 `run/end` 之后把它
丢掉 —— canonical 对这一格有专门条目(`if (value === true) out.isStreaming = true`),
**F0 恒等门在每个 run 收尾当场红**。

这不是"再等等"的谨慎,是一条结构约束:**这一口的空转必须与"store 读改物化"
同批落地**,而那是 c4 的活(§16.19 映射表把恒等门退役也排在 c4)。
本批照实翻案,不夹带。

**顺带钉一条同族的**:第 8 号 `updateMessageThinkingTime` 的 D 类判定**成立且无
成本** —— 它本 battery 零调用,生产上唯一的写者是**渲染层回写**
(`rpc/domains/chat.ts`),而 canonical 早就把它列进 `ALWAYS_DROPPED_KEYS`。
它可以随 c4 直接退役,不必等读改物化。

#### 六、为什么读侧那一半没做(`store 消息读取=物化活投影节点`)

工单第 1 步的最后一句是「store 消息读取 = 物化活投影节点」。**没做,而且不该在
c3 做**,理由写在 `reads.ts:158-171` 那段注释里,一字未改:

> `listMessagesFromStore` 是恒等门(`session/shadow.ts`)**唯一合法的验证器侧取数**
> …… 一旦这里也接上事件读法,`sessions:shadow-battery` 会在
> `shadow-read-mode.test.ts` 上当场红 —— 那条用例故意让 store 与事件分岔,断言
> 这道门**必须**报出来。

c3-a 的做法保住了两侧同源性:**store 照旧自己写,折叠提前到同一刻** —— 于是
两条推导仍然独立,却不再错相。读侧翻面(连同恒等门退役、老 reducer 删除)是 c4
的一整批,§16.19 分期表本来就是这么排的。

#### 七、验收(全部实跑)

| 门 | 结果 |
| --- | --- |
| **探针 C3(首刀靶)** | `content` **126/126 → 8/124**(116 逐字相等);`reasoning` **18/18 → 0**;`addMessageContentPart` 6→4;`updateStepsUsageByTurn` 86→84;其余路**无一变差** |
| **字节回归** | **0 差** —— c2 那份搬家前录的金样 `session-chunk-bytes.test.ts` 原样绿(19 行 / 4262 字节) |
| `decode ∘ encode ≡ id` | `session-chunk-codec.test.ts` 5 条全绿 |
| **每 delta 折叠开销** | **0.017 µs/条**(20 万条 3.4ms,5 跑取最小)。对照 c2 的全库读侧折叠 ≈0.49 µs/条 —— 提前折那一句是它的 **3.5%**,而一条流式 delta 本身要走 SSE 解析 + 事件总线 + 合帧,量级在**微秒到几十微秒**。预算(≤1.5×)通过,余量三个数量级 |
| 新增合同用例 | `write-side-visibility-delta.test.ts` **7 条全绿**,含**两条反证**:①不声明 `projectionPreFolded` → 正文当场翻倍(证明那句声明承重);②投影重建过之后声明仍被折(证明不盲信) |
| `typecheck` | **0** |
| `boundary:gate` | ok — 0 failures |
| `session:gate` | ok — 0 known, none new |
| `log:gate` | ok — 4 known, none new |
| `transport:gate` | ok — 42 常量 / 四壳 2392 行,不变 |
| `packages/backend` + `packages/core` + `runtime/src/sessions` | **3535 passed / 1 failed / 3 skipped** —— 唯一失败是 `sessions-delete-cascade` 的 `waitGone`,**单跑 3/3 绿**(§16.21 记过的同一只本机满载抖动,不在 delta 路径上) |
| `sessions:shadow-battery`(全量) | **GREEN** —— runs 321 / historyChecks 433 / mismatches 0 / duplicates 0 / projectionIssues 0 / droppedParts 0 / appendFailures 0 / refoldChecks **224** / **refoldMismatches 0** / `session-shadow.jsonl` **0 行** |
| 真机 `sessions:verify:gate`(只读) | FAILED,**仍是 §16.20 第七节那一条** `room-1 seq: expected seq 2 at position 1, got 3`,**无新增**(本批全程未写 `~/.onething`,battery 跑在一次性临时 store 上) |

**refoldChecks 224 vs §16.21 的 225**:少的那一次正是新加的守卫
(`aheadDeltas > 0` 时跳过)。它是 §16.19 明文授权的口径(「比对点 = 编码器刷新点」),
代价是每 321 个 run 少采一次样,`refoldMismatches` 仍然 0。

#### 八、本批的账

- **生产代码**:改 6 件(`core/session/projection/reducer.ts` /
  `core/session/events/chunk-codec.ts` / `backend/session/event-log.ts` /
  `backend/session/projection-cache.ts` / `backend/session/refold.ts` /
  `backend/wiring/engine/stream/session-event-recorder.ts`),**+185 −11**。
  新增词汇表类型:**0**;canonical 新豁免:**0**;磁盘格式变化:**0**。
- **测试**:新增 1 件(`write-side-visibility-delta.test.ts`,7 条含两条反证)。
- **探针**:装在 `stores/sessions.ts` 上,跑完 `git checkout` 卸载;
  `git status packages/backend packages/core` 只剩上面那 6 件 + 1 件新用例。
- **留给 c3-b / c3-c 的账**(第二节那张表就是工单):
  - **c3-b**(工具三口):`updateMessageToolCalls` / `updateMessageStep` /
    `addMessageStep`。注意 c3-a 之后它们的差**换了形状**——参数流(`tool-input`
    kind)现在也提前折了,于是出现 `toolCalls[].streamingArgs <B缺>` /
    `arguments.command <A缺>` 这类**投影领先**的新格。那是预期,不是回归
    (battery 恒等门 0 失配)。
  - **c3-c**(收尾与元数据五口):`updateMessageUsage` / `updateStepsUsageByTurn` /
    `updateMessageSkill` / `updateMessageError` / `updateMessageTurnContext` /
    `addMessageContentPart` / `updateMessageContentParts` / `updateMessageSteps`。
  - **c4 纯减法**:三个死口(`ReplyTo` / `Reactions` / `Mentions`)整体删除;
    `updateMessageThinkingTime` 退役;`updateMessageStreaming` 随读改物化一起空转。
- **两条待用户拍板**(本批不擅自拍,§16.3 + "行为裁定须先问"):
  1. **压缩 / 生图卡片正文的产地**(第四节那 6 次非前缀):让那三条路也走盖章,
     还是承认卡片正文由 `session/compacted` / `assistant/part-end{contentOnly}`
     单独负责、`updateMessageContent` 在那三处不参与折叠对账?
  2. **`refold` 少采那一次**要不要补 —— 例如收尾链 `flushAll()` 之后**必采一次**,
     把守卫的代价还回来。

### 16.24 F4-c c4 落地记录:恒等门告别退役 + 死口删除 + 端口事实断言;**reducer 收官停在诊断**(2026-08-27,opus 施工,未提交)

#### 〇、一句话

三定律的终局批交了**四件成品**与**一份诊断**。成品:三个死口纯减法删除、
**恒等门告别退役**(告别对账读数在第一节)、`updateMessageThinkingTime` 兑现
"取投影值"、`refold` 补采;诊断:**老 reducer 删不掉、A 类端口空转不了**,
根因是同一条 —— §16.17 立的**活 run 写手窗口**今天由内存 store 承担,而工单
第 3 步明写"引擎写手活对象窗口按既有共存口径"(即本批不动它)。三条硬证据
在第五节,一条都不是"再等等"的谨慎。

替代品不是一句相信:恒等门退役的同时立了**端口事实断言**
(`session/port-fact-assert.ts`)—— 端口写下某一格的那一刻,与活投影上同一格
的折叠值比一次,判据仍然是 `canonicalChatMessage` 那把**唯一的尺**。真机
battery 上它**比过 265 次、0 失配**。

#### 一、告别对账(退役**之前**最后一次两侧独立的全量读数)

| | 读数 |
|---|---|
| `sessions:shadow-battery`(全量,27 场景 × 7 pass) | runs **321** / historyChecks **433** / mismatches **0** / duplicates 0 / projectionIssues 0 / droppedParts 0 / appendFailures 0 / refoldChecks 222 / refoldMismatches **0** / `session-shadow.jsonl` **0 行** |
| 真机 `sessions:verify:gate`(只读) | FAILED,**仍是 §16.20 第七节那一条** `room-1 seq: expected seq 2 at position 1, got 3`,**无新增** |

这是恒等门作为「事件投影(真相)vs 内存 store(验证器)」两条**独立推导**跑的
最后一次全量。它从 S1b 立门(§10.4)一路护航到 F4-c,退役时手上是干净的。

#### 二、退役清单(删了什么,以及为什么现在删)

**判据先讲**:恒等门要有意义,两侧必须是两条独立推导(F11:判据同源 = 判据污染)。
验证器侧唯一合法的取数口是 `sessionReads.listMessagesFromStore`(故意不经过投影)。
而产品读路自 S2b + S3w-3 批 6b 起**只剩投影一条路** —— `listMessages` /
`getMessage` / `pageMessages` / `iterateMessages` / `firstUserPreview` /
`sliceForHistory` 全部 `fromEvents`。于是验证器侧那一口今天**零产品消费者**,
留着它只会让下一个人把它当成第二份真相。

| 删掉 | 位置 | 说明 |
|---|---|---|
| run 断言 `checkSessionRunShadow` / `scheduleSessionRunShadow` | `session/shadow.ts` | 每个 run 收尾比一次整条消息 |
| 历史断言 `checkSessionHistoryShadow` + 入参类型 | `session/shadow.ts` | 每次请求发出前比一次模型历史 |
| 接线 `history-shadow.ts` + 它的窗口闸用例 | `wiring/engine/stream/` | 整文件删除;`onRequestRecipe` 回调口**留着**(它是"配方写下去那一刻"的通用旁听口,不是那道门的私产) |
| 不等去重 / `recordMismatch` / 老会话覆盖面豁免 / `countSessionShadowSkip` | `session/shadow.ts` | 只服务那两道断言 |
| `listMessagesFromStore` | `session/reads.ts` | 验证器侧取数口,零消费者 |
| `shadow-recipe-contract.test.ts` | `session/__tests__/` | F5 的"入参类型必须认得宿主配方每一格"—— 入参类型没了 |
| 三个 IM 死口(见第三节) | `stores/sessions.ts` + `session-message-runtime.ts` | 纯减法 |

**留下来的**:`session/shadow.ts` 变成**记录面** —— 差异摘要(2KB 预算)、
`session-shadow.jsonl` 写入口、方向标记盖章。它今天服务两个写者:`refold`
(耐久门,唯一常驻)与新的 `port` 断言。`SessionShadowKind` 从
`'messages' | 'history' | 'refold'` 变成 `'refold' | 'port'`;**老日志里那两个
取值照旧读得懂**(报表按字符串认,不靠联合类型),两列的标签仍按 `truth` 标记
分开打印 —— 拿今天的名字贴老行等于把归因贴反。

**`runs` 换了产地**:它从前是 run 断言顺手记的一笔,门退役就没人记了。现在由
`endSessionRun` 自己记(`if (isSessionShadowEnabled()) bumpSessionShadowStats({ runs: 1 })`)
—— 它回答的本来就是"这一轮跑了多少个 run",与哪道门在比无关。**读数自证**:
搬家前后同一条 battery 都是 **321**。

**报表与 battery 改成"仅 refold + 直接断言"口径**:
`sessions:shadow-report` 的门 = `runs ≥ 200 ∧ refoldChecks > 0 ∧
refoldMismatches = 0 ∧ mismatches = 0 ∧ portMismatches = 0 ∧ appendFailures = 0`。
新加的 **`refoldChecks > 0`** 是一条纪律:恒等门退役之后 refold 是唯一在跑的
比对,而"那道门根本没跑"与"那道门全绿"在报表上长得一模一样。
`mismatches` / `historyChecks` 字段**留着且仍然进门** —— 老
`session-shadow-stats.json` 里的非零必须仍然是红。

#### 三、死口删除 + 5 个"零调用口"逐个判

**三个死口整体删除**(§16.23 第二节的 #11 / #12 / #13),纯减法:
`updateMessageReplyTo`(W13.2 引用快照)/ `updateMessageReactions`(W8 表情)/
`updateMessageMentions`(W14a @身份)。三条 IM 写路早在 P0.2 就整体迁到命令面的
`patchMessage`(产地 `message/patched`),生产上一次都不调。删的是
`backend/stores/sessions.ts` 的三个导出、`stores/index.ts` + `store.ts` 的再导出、
`session-message-runtime.ts` 的三个方法,以及五只测试里那几处认得旧名字的
mock 属性。**消息形状不动**(`reactions` / `replyTo` / `mentions` 三格还在,
`CoreSessionMessage*` 三个类型还在 —— 它们描述的是消息,不是那三扇门)。

**5 个"零调用口"**(表里 `samples 0` 那几个)逐个判 —— 注意 `0 调用`说的是
**本次 battery** 没走到,不是生产上没有调用点:

| # | 端口 | 生产调用点 | 判 |
|---|---|---|---|
| 4 | `updateMessageContentParts` | `tool-orchestrator.ts:136` | **留**:活 run 写手视图的产地之一(见第五节) |
| 5 | `updateMessageSteps` | `tool-orchestrator.ts:129` | **留**:同上 |
| 8 | `updateMessageThinkingTime` | `rpc/domains/chat.ts`(**渲染层回写**) | **空转**(见下) |
| 10 | `updateMessageError` | `agent-loop-executor.ts:210/2370` | **留 + 挂断言**:A 类,产地 `run/end.error` |
| 14 | `updateMessageTurnContext` | `agent-loop-runtime.ts:266/271` | **留 + 挂断言**:A 类,产地 `context/turn-update` |

**`updateMessageThinkingTime` 兑现"取投影值"**(用户已拍板):这一格从来不是
引擎的事实,是渲染层算完"思考了几秒"再经 `chat` 域写回来的 —— 全仓唯一的生产
写者是 `MessageList.vue`。账本上它早有产地(`deriveThinkingTime` 从
`assistant/chunks` 的时刻算),判据侧 `canonicalChatMessage` 更是把它列进
`ALWAYS_DROPPED_KEYS`。端口实现因此只剩"这条消息在不在"(RPC 面靠这个布尔回
`success`),**不再写 store、不再产生 `message/patched`**。端口与 RPC 契约都留着
—— 删 `chatRouter.updateMessageThinkingTime` 是一次传输面改动,与本批无关;
渲染层**一行没改**。

#### 四、端口事实断言:恒等门的逐格替身(`session/port-fact-assert.ts`,新增)

§16.23 把 12 个端口判成 **A 类:事实已经在流上**。那句话从前的证据是恒等门每个
run 比一次整条消息;门退役了,它就需要一个**逐口逐格**的替身,否则退化成一句相信。

端口被调用的那一刻,拿它的入参与活投影上同一条消息的同一格比一次。四条边界:
①默认关(`ONETHING_SESSION_PORT_ASSERT`,缺省跟 `ONETHING_SESSION_FREEZE` 走 =
vitest 下开),关着时第一行就 return,生产零成本;②**不主动建表**(建表要同步读
整份文件 —— §16.23 探针坑 3);③**永不抛进引擎**,不等只记一行
`session-shadow.jsonl{kind:'port'}` + `portMismatches`;④**判据只有一把尺**:
`canonicalChatMessage`。

今天在表上的四格,以及每一格为什么在:

| 端口 | 比的那一格 | 账本产地 |
|---|---|---|
| `updateMessageUsage` | `node.usage` | `request/response.usage` 求和(reducer:529) |
| `updateMessageSkill` | `node.skillUsed` | `skill/activated`(reducer:694) |
| `updateMessageError` | `node.errorDetails` | `run/end.error.message`(reducer:513) |
| `updateMessageTurnContext` | `node.turnContext` | `context/turn-update`(reducer:684) |

不在表上的按**为什么不比**分三堆:`content`/`reasoning` 的残差是 C 类产地议题
(第七节);`isStreaming` 是两个时刻不是分岔(§16.23 第五节);
`steps`/`toolCalls`/`contentParts`/`steps[].usage` 的正确判据是**整条消息的
canonical 相等**,在这里手写第二个数组判官 = 把刚退役的那道门换个名字再建一遍。

**两个自己踩的坑,都写进了代码注释,也都固化成了反证用例:**

1. **第一版直接 `deepEqual`,battery 当场 265 条假红**,全是 `usage.durationMs`
   —— 那一格 canonical 明文丢掉("一次流的墙钟量测,不是用量",`canonical.ts:233`)。
   手写的第二个判官一定会与唯一的那把尺分叉,而分叉的方向永远是"报一堆假红,
   把真的那条淹掉"。改法:两侧各包成 `{ [fact]: value }` 的单格消息,过同一个
   `canonicalChatMessage` 再比。
2. **拿 `content` / `reasoning` 试挂过一次,battery 报 `portMismatches` 0 ——
   而那个读数什么都没证明**:`AssistantNode` 上根本没有这两格(正文住
   `parts: Map<number, PartState>`),断言每一次都在 `folded === undefined`
   那行就 return 了。于是加了 **`portChecks`**(真的比过几次)—— 与
   `refoldChecks > 0` 是同一条纪律。往那张表加新一行的人请先看着这个数涨。

**读数**:battery 全量 **`portChecks` 265 / `portMismatches` 0**。
诚实地补一句覆盖面:265 次里绝大多数是 `usage`(`updateMessageSkill` 本 battery
只有 2 次调用,`updateMessageError` / `updateMessageTurnContext` **0 次** ——
与 §16.23 分类表的 `samples` 列一致)。那两口的断言是**装上了但还没被真正考过**,
不能算已证。

#### 五、**停在诊断**:老 reducer 删不掉、A 类端口空转不了(三条硬证据)

工单第 2 步是「12 个 A 类端口改为空转 + 断言」,第 4 步是「老 reducer 分支删除
(命令应用 = 事件 fold + 物化)」。两步都**停在诊断**,而且是同一个根因。

**根因一句话**:§16.17 立的**活 run 写手窗口**——「活 run 窗口内,该 run 的
assistant 消息由引擎写手对象持有并唯一可信」——今天的"写手对象"就是**内存
store 上的那一条**,而维护它的正是那 18 个端口与老 reducer。工单第 3 步明写
"引擎写手活对象窗口按既有共存口径",即**本批不动这个窗口**;窗口不动,喂它的
端口就空转不得,维护它的 reducer 就删不得。

三条证据,每一条都是一个具体的产品行为,不是"理论上可能":

1. **收尾链读写手视图的 `steps[]` 与 `contentParts`**
   (`wiring/engine/stream/agent-loop-executor.ts:530/575/629`)。
   `contentParts` 上带着 `data-steps` **渲染锚点**,而锚点按 canonical **G4 故意
   不进事件、不进投影**(裁定,不是缺口);settle 快照是**整体覆盖**广播给
   renderer 的。喂它的是 `addMessageContentPart` / `updateMessageContentParts` /
   `updateMessageStep` / `addMessageStep` / `updateMessageSteps` —— 这五口一空转,
   §15.16「正文看不见」当场复发。
2. **abort 按 `isStreaming` 寻址**:`runtime/src/sessions/stream-abort.ts:143`
   的 `session.messages.find(message => message.isStreaming)` 读的是 store 上那条
   消息。`updateMessageStreaming(false)` 一空转,这一格永远留着 `true`,下一次
   停止会摸到一条早就收尾的消息。(§16.23 第五节判它"今天翻不得"的理由是恒等门
   会红;门退役之后理由换成这一条,**结论没变**。)
3. **truncate 的用量结算读 `message.usage`**:老 reducer 的 `applyTruncate` 把被
   删消息的 token 用量从会话总量里扣回去(`meta.subtractedUsage` →
   `logSubtractedMessageUsage`)。`updateMessageUsage` 一空转,扣减恒为 0。

**要往下走,先要一次裁定**(不由执行侧顺手拍,§16.3 +「行为裁定须先问」):
**活 run 写手窗口退役吗?** 退役意味着至少三件事各有出路 ——(a)`data-steps`
锚点改由 renderer 自合成(S3w-0 的 `synthesizeToolAnchors` 已具备能力,但 settle
的整体覆盖路今天不跑 `rebuildContentParts`);(b)abort 改按"当前开着的 run"
寻址,而不是按 `isStreaming` 找消息;(c)truncate 的用量结算改从投影取。
三件都是可感知行为的改动,应当列给用户选,而不是在收官批里夹带。

**session:check 因此按"理由换了、名单没换"处理**:规则 B 的白名单仍然只有
`packages/core/session/commands.ts`,但它守的东西从"命令面是唯一实现处"变成
"**活 run 写手对象只有一个维护者**"。理由原文写进了 `scripts/session-check.mjs`。
`session:gate` 仍然 0。

#### 六、refold 补采(用户裁定已兑现,但按"补格"而不是"必采")

c3-a 给 refold 加的 `aheadDeltas > 0` 守卫是对的,代价是**那一次采样白花了**
(计数已经加过,下一次要再等 N 个 run)—— 就是 refoldChecks 225 → 224 的那一格。

本批的补法:守卫命中时把采样计数**退回去**(`refundSample`),于是下一个 run
立刻补采一次。run 收尾链的 `recorder.flush()` 排在 `endSessionRun` 之前,补的
那一次几乎必然采得成。**读数**:同一条 battery 从 222 回到 **225 / 223 / 222**
(三次跑,并发下有抖动),`refoldMismatches` 始终 0。

**与用户原话的偏差,明账记着**:裁定原文是「run 收尾 flush 后**必采一次**」。
按字面做会把一道"每 5 个 run 采一次"的耐久门变成**每个 run 都全量重折一遍**
(真机大账本上每次 ≈22ms 连续阻塞,§15.14)。那是换一档采样率,不是"把跳采的
格补回" —— 换档是另一次拍板。若用户要的就是字面那一档,把
`ONETHING_SESSION_REFOLD_EVERY=1` 打开即可,不需要改代码。

#### 七、C 类残差 8 为什么**没有**归零(它挂在第五节上)

工单裁定「C 类正文认既有产地,残差 8 应随读侧物化消失」。**读侧物化这一步在
c4 之前就已经完成了**(S2b + 批 6b:产品读路只剩投影一条路),所以 c4 没有可以
"切换"的读侧 —— 这一批在读侧做的是**删掉那条故意绕开投影的验证器口**。

而 §16.23 第四节量到的残差 8 是**「物化 ≡ store」**这个探针的读数,它归零的
条件是那三条非 provider 正文路(生图失败分支 / 压缩卡片三处 / 生图收尾)
**不再写 store** —— 也就是 `updateMessageContent` 在那三处空转。那正好落在
第五节停手的那一格里(写手视图的正文也归它写)。所以:**残差 8 的归零与 A 类
空转是同一件事的两个说法**,一起等那次裁定。

本批没有重装 §16.18 的探针 B(它要 `git checkout` 卸载,而它量的那个数今天
必然与 c3-a 相同 —— 中间没有任何一条端口的写路被改)。取而代之的是第四节那个
**常驻的**逐格断言:它比探针便宜、进门、而且不会跑完就没。

#### 八、验收(全部实跑)

| 门 | 结果 |
| --- | --- |
| **告别对账**(退役前最后一次) | battery runs **321** / historyChecks **433** / mismatches **0** / refoldMismatches **0** / `shadow.jsonl` **0 行**;真机 verify **仅 room-1 已知条** |
| `sessions:shadow-battery`(新口径,全量) | **GREEN** —— runs **321** / **portChecks 265 / portMismatches 0** / refoldChecks **222** / refoldMismatches **0** / mismatches 0 / appendFailures 0 / duplicates 0 / projectionIssues 0 / droppedParts 0 / `session-shadow.jsonl` **0 行** |
| 真机 `sessions:verify:gate`(只读) | FAILED,**仍是那一条** `room-1 seq …`,**无新增**(本批全程未写 `~/.onething`) |
| **字节回归** | **0 差** —— `session-chunk-bytes.test.ts` 原样绿(c2 录的金样,19 行 / 4262 字节) |
| `typecheck` | **0** |
| `boundary:gate` | ok — 0 failures |
| `session:gate` | ok — 0 known, none new |
| `log:gate` | ok — 4 known, none new |
| `transport:gate` | ok — 42 常量 / 四壳 2392 行,不变 |
| `ui:gate` | ok — 81 known, none new |
| `packages/backend` + `packages/core` + `runtime/src/sessions` | **3522 passed / 0 failed / 3 skipped**(388 文件) |
| 新增合同用例 | `port-fact-assert.test.ts` **5 条全绿**,含**三条反证**:①canonical 丢掉的那一格不许报(`usage.durationMs`);②没有活投影时一次都不比、`portChecks` 一次不涨;③总开关关掉时一条账都不记 |

#### 九、本批的账

- **生产代码**:新增 1 件(`session/port-fact-assert.ts`,182 行);
  删除 1 件(`wiring/engine/stream/history-shadow.ts`);改 9 件
  (`session/{shadow,reads,runs,refold,event-stats}.ts`、
  `stores/{sessions,index}.ts` + `store.ts`、
  `wiring/engine/stream/{agent-loop-executor,session-event-recorder}.ts`、
  `runtime/src/sessions/session-message-runtime.ts`)。
  **净 +374 / −1280**(含测试与脚本)。新增事件类型:**0**;
  canonical 新豁免:**0**;磁盘格式变化:**0**;渲染层改动:**0**。
- **测试**:新增 1 件(5 条含三条反证);删除 2 件(恒等门的两只);
  改判 1 件(`shadow-read-mode.test.ts` —— 夹具一字未动、结论翻面:从
  "门必须报出 store 与事件的分岔"改成"**store 被改成什么样,产品读面都只回答
  事件折出来的那一份**",并补一条反证证明篡改确实发生过);
  重写 1 件(`shadow.test.ts` 只剩记录面 + `runs` 产地 + 关闸)。
- **脚本**:`session-shadow-report.mjs`(仅 refold 口径 + `refoldChecks > 0` +
  `portMismatches` 进门)、`shadow-battery.mjs`(开 `ONETHING_SESSION_PORT_ASSERT`)、
  `session-check.mjs`(规则 B 的理由改写)。
- **留给下一批的工单**(全部挂在第五节那次裁定上):
  1. **活 run 写手窗口退役吗**(a/b/c 三条出路,列给用户选);
  2. 裁定之后:12 个 A 类端口空转、老 reducer 删除、`session:check` 规则 B 改写
     成"只许在投影 reducer"、C 类残差 8 归零、`getLiveRunWriterMessage` 与
     `getMessageFromStore` / `hasMessageInStore` / `findMessageFromStore` 三口
     判据同源的退役(`hasSessionInStore` 是**永久例外**,§16.11 拍板 4);
  3. `updateMessageError` / `updateMessageTurnContext` 的断言**还没被考过**
     (本 battery 零调用)—— 给它们各补一个场景。

### 16.25 F4-c c4-b 落地记录:**写手窗口退役** —— 三把钥匙落齐,`getLiveRunWriterMessage` 删除;老 reducer 收官仍停在**最后一格**(2026-08-27,opus 施工,未提交)

#### 〇、一句话

§16.24 第五节点名的**三条写手对象独有依赖**全部拆除,`getLiveRunWriterMessage`
与"活 run 写手视图"这个概念一起删除。收尾链改读折叠产物,渲染锚点由**共享纯件**
从 steps 现算,停止按钮改按**活 run 登记簿**寻址,截断的用量结算改从折叠产物取。

**但 A 类端口空转与老 reducer 分支删除仍然没做** —— 拆掉三条依赖之后,挡在前面的
只剩**一格**,而且它不再是"依赖",是**身份**:内存 store 的消息数组今天仍由老
reducer 维护,而"命令应用 = fold + 物化"要的是让**读**侧改从物化取。那一步自带一次
性能/时机裁定(第五节),按 §16.3 与「行为裁定须先问」不由执行侧顺手拍。

施工过程里**探针抓到三处真回归**,每一处都是"改读投影"这句话在某个具体位置上不成立
(第四节)。三处都当场修掉并各留了一条合同用例 —— 这一节最有价值的部分是它们,不是
钥匙本身。

#### 一、三把钥匙(逐把:拆掉了什么依赖、换成了什么产地)

| 钥匙 | 从前的依赖(§16.24 第五节) | 今天的产地 | 落点 |
|---|---|---|---|
| ① **渲染锚点** | settle 快照读写手视图的 `contentParts`,`data-steps` 只有写手一个产地 | 锚点是 steps 的 `turnIndex` 的**纯函数**,推送侧从折叠产物**现算** | 新件 `packages/core/session/render-anchors.ts`(`synthesizeCoreToolAnchors`,零依赖纯件);renderer 的 `synthesizeToolAnchors` 收缩成一行转调(**单实现**:−93 行);主进程 `readSettleMessage` 用同一份 |
| ② **abort 寻址** | `session.messages.find(m => m.isStreaming)` —— 停止按钮钉在 store 那一格布尔上 | **活 run 登记簿**(`currentSessionRun(sid).assistantMessageId`),消息本体取折叠产物 | `stream-abort.ts` 的 `getSession` 换成 `getActiveRunMessage` 端口;装配层在 `rpc/domains/chat.ts` 填 |
| ③ **truncate 用量结算** | 归约器 `sumUsage(被删的那些 store 消息)` —— 扣多少钉在 `message.usage` 上 | `request/response.usage` → `node.usage`;命令面从折叠产物算好递进归约器 | `truncateFrom` 命令多一格 `subtractedUsage`(不给则归约器按老算法自取,老调用点一字未动) |

**`isStreaming` 因此回到了它唯一的语义**:由 run 开闭推导出来的**结论**,不再兼职
当寻址索引。这正是 §16.23 第五节判它"今天翻不得"的那条理由的解除条件。

**`getLiveRunWriterMessage` 删除**(`session/reads.ts`)。它 F4-b2 立、c4-b 死,
一共活了两批;三只测试改判到 `getMessageFromStore`(两口实现逐字相同,反证力度未减)。

#### 二、施工里最该记住的一句:**"改读投影"不是一句口号,它在三个具体位置上不成立**

三处都是探针量出来的,不是想出来的。三处的形状一模一样 ——
**"折叠产物在那一刻还没有/永远不会有那一格"**,而 settle 快照是**整体覆盖**广播的,
照抄"没有"就等于把渲染层那一格抹掉。

| # | 位置 | 探针读数 | 真回归 | 修法 |
|---|---|---|---|---|
| 1 | `usage` | **266/266** `usage:B缺` | 折叠侧只在 `node.outcome === 'completed'` 时交出 `node.usage`,而 `run/end` 排在收尾链**之后** → 快照 `usage: undefined` → 渲染层那条消息的 token 读数被抹掉,直到下次重载 | 正常收尾那一路补 `state.accumulatedUsage`(就是 `updateMessageUsage` 写进去的**同一个对象**,端口事实断言逐次比过);中止 / 出错两路**必须不补**(账本口径:被打断的那条消息本来就没有用量)——不加这个条件,探针当场多出 16/330 条凭空带用量的快照 |
| 2 | `contentParts` **整格缺** | **16/330** 丢锚点 | 一次"只调了工具、一个字都没说"的收场(中止在途工具是常见形态),折叠侧 `materializeAssistantNode` 只在 `length > 0` 时才带 `contentParts` → 快照把渲染层的 contentParts 整体覆盖成 `undefined` → **工具行当场消失**(§15.16 同一根引信) | `message.contentParts ?? []`。**那两个字符是承重的**,不是防御性写法 |
| 3 | `steps` / `toolCalls` 的**收尾修复** | **48/330** 整批丢账 | `captureCancelledToolResults` 是 `tool/result{cancelled:true}` 的**产地**,它要"这次修复判死了哪几个 step"。改读投影**永远读不到**:修复的落盘走 `patchMessage{steps,toolCalls}`,而这两格在 `message/patched` 的 **`DERIVED_KEYS`** 里(投影只认 `tool/*` 折出来的那一份,不认补丁)→ 投影侧那几个 step 永远停在 `running` → 采集点一条都不写 | **不回读**:核心侧新增 `onSettled?(message)`,收尾修复把产物**直接递给**采集点。零时序窗口,而且"产地读自己的产物"那条自引用从此不存在 |

**第 3 条推翻了 §16.24 第五节证据一的一半措辞**:那里说自引用"是产地纪律";
真相更硬 —— 那条补丁**根本进不了账本**。修法因此也不是"换个地方读",是**不读**。

#### 三、探针 C4B(临时,跑完即删)与它的终局读数

装在 `readSettleMessage` 上:每次收尾取材,把**新那一份**(折叠产物 + 现算锚点)
与**老那一份**(`getMessageFromStore`,即写手视图)逐格对拍,两侧各跑一次收尾修复
(settle 真正广播出去的是修复**之后**那一份),判据是那把唯一的尺
`canonicalChatMessage`。跑 `sessions:shadow-battery` 全量。

**终局读数(330 采样 = 266 正常收尾 + 32 收场路 × 各自的取材点):**

| 项 | 读数 | 判 |
|---|---|---|
| `contentParts` 正文逐字(text / reasoning) | **330 / 330 相等** | 正文一个字都没丢(§15.16 的定性:丢的是分界不是数据) |
| `message.content` 逐字 | **330 / 330 相等** | 同上 |
| 渲染锚点 | 104 行涉及锚点:**equal 80 / lost 0 / extra 24** | **lost 0 是硬指标**;`extra 24` 见下 |
| canonical 残差 | 只剩 **2 类** | 见下 |

**残差两类,都不是分岔:**

1. **`isStreaming:A缺` × 330** —— 老那一份(store)已经被 `finalize()` 摘掉这一格,
   折叠侧的 run 还没闭所以恒为 `true`。**两个时刻,不是分岔**(§16.23 第五节同型),
   而且它**根本到不了渲染层**:`buildAgentLoopFinalMessageUpdate` 无条件写
   `isStreaming: false`。
2. **`steps[].result:异` × 8** —— `A="{\"content\":[]}"` / `B=""`,**空结果的两种写法**
   (§16.18 探针 A 记过同一类)。两侧渲染出来都是"空结果";而重载之后本来就是 `B`
   那一份,所以这一格是**向重载视图收敛**,不是丢东西。

**`extra 24` 是改善,不是回归 —— 但它是一次可感知的呈现变化,明账记着:**
新那一份在 24 行上比写手视图**多**合成了锚点,两种形状:
`old=0 new=1`(写手整格没有 contentParts,快照从前把渲染层那一格覆盖成 `undefined`,
工具行看不见)与 `old=1 new=2`(两轮工具,写手只留了直播时那一个锚点)。
两种都让**收尾那一刻看到的分界**与**刷新之后看到的分界**变成同一个 ——
因为算它们的就是同一个函数(renderer 加载路径用的也是 `synthesizeCoreToolAnchors`)。
方向与 §15.16 修 A 完全一致,但它**确实改变了个别历史消息的 work-group 分界**,
所以写在这里而不是埋进"顺手修好了"。

#### 四、为什么**没有**做端口空转与 reducer 删除:只剩一格,而那一格是身份不是依赖

三条依赖拆完之后,重新走了一遍"把 A 类端口改空转"的路,结论**换了**,而且比 c4 那次
具体得多:**挡路的不再是三条产品行为,是一条结构事实** ——

> 内存 store 的消息数组今天仍然由老 reducer 维护,而**归约器自己要读它**。

最硬的一处:`applyTruncate` / `applyRepairOnLoad` 都调
`computeSessionTimelineMetadataRepair(..., messages, {recomputeContextSize:true})`,
而 `deriveRetainedContextSize` 读的正是 `message.usage`。`updateMessageUsage` 一空转,
**冷加载之后**那条会话的 `contextSize` 就会按"没有用量"重算 —— 钥匙③解决的是
`subtractedUsage` 那一格,解决不了这一格(它不是命令面能递进来的一个数,是归约器
对整份消息数组的一次派生)。

所以往下走**只剩一次切换**,不是十几件事:

> **store 的消息数组 = 折叠产物的物化(读侧现取,按投影版本缓存)。**

它一落地,15 个端口(3 个死口已删、`thinkingTime` 已空转)可以整批空转,
`appendContentPart` / `upsertStep` / `patchStep` / `patchStepsUsageByTurn` /
`setToolCalls` 五条**端口专用**的 reducer 分支随之零流量(实测:这五条命令在
`sessionCommands` 上是零调用的包装,生产上端口直调 runtime),整批删除。

**而它自带一次必须先问的裁定(这就是本批停手的理由):**

| 选项 | 代价 | 备注 |
|---|---|---|
| **A. 写侧刷新**(每次端口写完把物化盖回 store) | 逐 token 一次 `materializeNode` = 一次 run 里 O(n²) 的常数放大 | 施工前算过:今天 `updateMessageContent` 每 token 写一次全量正文本来就是 O(n²),但物化还要重建 parts/steps/toolCalls 数组,常数是 5–10× |
| **B. 读侧现取 + 版本缓存**(推荐) | 零逐 token 成本;代价是 `getSession()` 这条**极热**的路上多一层缓存判定,以及"活 run 窗口内谁去读 store 就重折一次" | 缓存失效点现成:F1 的 append 观察者。真正要量的是 `getSession` 的调用频次 |
| **C. 带节流的写侧刷新** | 引入"store 中途是陈旧的"这一条新语义 | 那正是 §16.17 共存口径的反面,不该在收官批里偷偷立一条新口径 |

请用户在 A / B / C 上拍一次板(推荐 B)。拍完之后剩下的活是**一批**,不是四批:
端口空转 + 五条 reducer 分支删除 + `session:check` 规则 B 改写 + C 类残差 8 归零
+ `getMessageFromStore` / `hasMessageInStore` / `findMessageFromStore` 三口退役
(`hasSessionInStore` 是**永久例外**,§16.11 拍板 4)。

**探针 B 的"全路归零"也挂在这次裁定上**,理由与 §16.24 第七节一字不变:它量的是
"物化 ≡ store",而在读侧切换之前那两者本来就是两个生产者。本批因此没有重装探针 B ——
装了也只会复述 c3-a 的读数(端口的写路一行没改)。取而代之的是上面那枚探针 C4B:
它量的是**本批真正改了的那条缝**(收尾取材),而且量出了三处真回归。

#### 五、③ `partialResult` / ④ `thinkingTime` 收尾(§16.14 口径)

- **④ `thinkingTime`**:c4 已兑现(端口空转、取投影值),本批一行未动。
- **③ `partialResult` 形状差**:§16.14 的默认口径(活 run 瞬态、settle 后由 dehydrate
  剥离、物化不携带)本批**实测确认仍然成立且已无成本** —— 探针 C4B 的 canonical 残差
  里**一条 `partialResult` 都没有**(它整族落在 `DERIVED_STEP_CACHE_KEYS` 豁免里,
  施工中途的原始 JSON 对拍能看到 `partialResult:异 × 64`,过了 canonical 就归零)。
  §16.18 第三节说它"被阻塞①②挡在后面",今天那两条阻塞在**收尾取材这条缝上**已经
  不存在,所以这一格**按口径结案**,不再挂账。

#### 六、验收(全部实跑)

| 门 | 结果 |
| --- | --- |
| `sessions:shadow-battery`(全量,新口径) | **GREEN** —— runs **321** / portChecks 265 / **portMismatches 0** / refoldChecks **222–225**(并发抖动)/ **refoldMismatches 0** / mismatches 0 / appendFailures 0 / duplicates 0 / projectionIssues 0 / droppedParts 0 / `session-shadow.jsonl` **0 行** |
| **探针 C4B**(收尾取材,跑完即删) | 330 采样:正文 **330/330 逐字相等**、`content` **330/330**、锚点 **lost 0**;canonical 残差只剩 `isStreaming`(时刻,到不了渲染层)与 `steps[].result` 空结果两种写法 ×8 |
| **字节回归** | **0 差** —— `session-chunk-bytes.test.ts` 原样绿(19 行 / 4262 字节) |
| `typecheck` | **0** |
| `boundary:gate` | ok — 0 failures |
| `session:gate` | ok — 0 known, none new |
| `log:gate` | ok — 4 known, none new |
| `transport:gate` | ok — 42 常量 / 四壳 2392 行,不变 |
| `ui:gate` | ok — 81 known, none new |
| `packages/backend` + `packages/core` + `runtime/src/sessions` | **3525 passed / 0 failed / 3 skipped**(388 文件;另一轮同机满载时 `server/http.test.ts` 的 SSE 等待抖动一次,单跑 29/29 绿) |
| 全仓 | **11936 passed / 2 failed** —— 两只都与本批无关:`App.container-layout`(**他会话在途的 renderer 改动**,`git stash` 掉那批后单跑 11/11 绿)与 `terminal/service.smoke`(满载抖动,单跑绿) |
| 真机 `sessions:verify:gate`(只读) | FAILED,**仍是 §16.20 第七节那一条** `room-1 seq: expected seq 2 at position 1, got 3`,**无新增**(本批全程未写 `~/.onething`) |

#### 七、本批的账

- **生产代码**:新增 1 件(`core/session/render-anchors.ts`,零依赖纯件);
  改 8 件(`core/engine/agent-loop-executor.ts` 加 `onSettled` /
  `core/session/commands.ts` 加 `subtractedUsage` / `core/package.json` 加一个 exports 叶子 /
  `backend/session/{commands,reads,command-events}.ts` /
  `backend/wiring/engine/stream/agent-loop-executor.ts`(新 `readSettleMessage`)/
  `backend/rpc/domains/chat.ts` /
  `runtime/src/sessions/{stream-abort,session-message-runtime}.ts`);
  renderer **只动一件**且是**净减**(`stores/helpers/content-parts.ts`,−93 行,
  实现上收为共享纯件)。
  新增事件类型 **0**;canonical 新豁免 **0**;磁盘格式变化 **0**;账本零变化
  (锚点只加在推送这一路上)。
- **测试**:新增 3 条合同用例(`onSettled` 递的是修复**之后**那一份、
  停止按钮不许按陈旧 `isStreaming` 寻址、`subtractedUsage` 递进来时归约器认它);
  改判 4 件(settle 那道门**判据翻面、断言的产品事实一字未动**,文件随之改名
  `settle-emit-writer-view` → `settle-emit-render-anchors`;写侧取材那两条
  改成"锚点是折叠产物的纯函数";两条反证口从 `getLiveRunWriterMessage`
  换成 `getMessageFromStore`)。
- **脚本**:`session-check.mjs` 规则 B 的理由第三次改写(名单仍然没换 ——
  今天它守的是"内存 store 的消息数组只有一个维护者")。
- **留给下一批的工单**:全部挂在第四节那一次 A/B/C 裁定上,拍完是**一批**。

### 16.26 F4-c c4-c 勘察结论:**停在诊断** —— B 案的性能前提成立、静默期等价成立,但「命令产事件→F1 同步可见」这条前提在**流式助手占位**上从来没成立过(2026-08-27,opus 施工后回退,**零生产代码留存**)

#### 〇、一句话

按 §16.25 第四节拍定的 **B 案(读侧现取 + 版本缓存)**把切换真做了一遍,
`sessions:shadow-battery` **当场红在 `retry-message`**(ok=0/failed=7,
`timed out waiting for idle (≥1 assistant)`)。用一行诊断实验证实了根因,
而根因不是性能、不是缓存、也不是"哪一格还没折" ——

> **流式 assistant 占位在账本上没有 append 期的产地。**
> `sessionCommandEvents.appendMessage` 对 `role==='assistant' && isStreaming`
> 一条都不写(`command-events.ts`,§9.3 的裁定),它在账本上的那一格是
> **`run/start`**,由引擎在其后写。于是 `store.addMessage` 返回的那一刻,
> 折叠产物里**没有**这条消息 —— 实测 **322 / 644** 次 `addMessage` 采样如此。

读侧一旦现取,这条占位就在那个窗口里被物化视图**换掉**,而写模型下一刀正是
建立在它之上的。§16.20 把这个窗口结案成"取样窗口,不是产地缺口"——那句结论
在"没有人从投影读"的世界里成立;c4-c 要的正是让投影成为读的唯一真相,
窗口于是从**取样问题**升级成**真相缺口**。

**这是一次产地裁定,不是性能裁定**,按 §16.3 与「行为裁定须先问」不由执行侧
顺手拍。工单四步全部挂在它上面,本批因此零生产改动收工(`git diff HEAD` 对
`packages/{backend,core}` 与 `runtime/src/sessions` 为空)。

#### 一、探针 B(c4-c 版,跑完即删)与它的读数

装法:`stores/sessions.ts` 的 18 端口用**一层 `get` 陷阱**(不复制属性表、
`this` 一律绑回本体 —— §16.23 坑 2 的干净解)+ `getSession` / `flushSessionSave`
两个读点。判据是那把唯一的尺 `canonicalChatMessage`,逐消息、逐格,外加一份
数组级生料差。跑 `sessions:shadow-battery` 全量(battery 全程 GREEN,
runs 321 / portMismatches 0 / refoldMismatches 0 —— 探针没有伪造读数)。

**读数一:`getSession` 是 ~39 次/run,不是逐 token 的。**

| 项 | 读数 |
|---|---|
| `getSession` 调用次数 | **12,612**(321 个 run) |
| 其中投影已建、可比的采样 | 11,310 |
| 不等 | 3,295(29%) |

逐 token 的写者走的是 runtime 自己的 `repository.getSession`,**不经过**这条
导出读面。**B 案的性能前提因此成立**:读侧现取 + 版本缓存的稳态成本是一次
map 查询 + 一次 `!==`,物化次数与读次数同阶,不与 token 数同阶。A 案担心的
O(n²) 常数放大在 B 上不存在。

**读数二:静默期(最后一次写之后 1s)物化 ≡ store,90 采样 89 相等。**

| 曾经出现过的分岔 | 静默期 |
|---|---|
| 曾 usage 缺(59 条会话) | **已收敛** |
| 曾中止分岔(`steps[].status A=running B=cancelled` / `error <A缺> User cancelled`,23 条) | **已收敛** —— c4-b 的 `onSettled` 真的把 `tool/result{cancelled}` 写出来了 |
| 曾 `content 异`(压缩卡片 / 生图失败正文,10 条) | **已收敛** |
| 曾少一条 | **已收敛** |
| 唯一残差 ×1 | `steps[].toolCall <A缺>`(imported 会话) |

**这条读数结清了 §16.23 第四节留的那次"产地裁定"**:C 类残差 8
(压缩 / 生图卡片正文)**不是永久分岔,是时机差** —— 它在静默期归零。
那两条"待用户拍板"里的第 1 条(卡片正文的产地)**按读数结案,不再挂账**。

**唯一的静默期残差 `steps[].toolCall`** 不是账本缺口,是**补水链**:
`rehydrateSessionFromStorage` 就地把 `step.toolCall = linked` 补上,而投影
故意不带这一格。物化视图必须跑同一条补水链(施工版已经这么做了,方案见第三节),
且**必须先深拷**——`materializeMessageNode` 对 `message/imported` 是浅展开,
不深拷就等于把事件里没有的字段写进活投影,refold 当场破(§15.13 真机首杀)。

**读数三:活 run 窗口内的四类差,逐条定性。**

| 差 | 次数 | 定性 |
|---|---|---|
| `msgs.length A少1 尾=assistant` | 306(`getSession`)/ 322(`addMessage`) | **本批的红** —— 见第二节 |
| `usage <A缺>` | 1,862 | 折叠侧 `node.usage` 门在 `outcome==='completed'`(`chat-messages.ts:176`),`run/end` 在收尾链之后 |
| `isStreaming <B缺>` | 1,950 | 两个时刻:store 在 `finalize()` 摘掉,折叠侧等 `run/end`(§16.23 第五节同型) |
| `contentParts <B缺>` / `steps 异` / `toolCalls 异` | 604 / 573 / 64 | 投影领先或落后一拍,静默期全收敛 |

#### 二、红在哪:`retry-message`,以及那一行诊断实验

施工版(已回退)做了三件事:①`projection-cache.ts` 加**失效号**(每次 state
前进 +1,整份重建**跳号** —— 它不是 `lastSeq`:提前折的 delta 没有自己的行,
seq 不动而 state 动了);②新件 `session/materialized-messages.ts`(读侧现取 +
按失效号缓存 + 走同一条补水链 + 没有活投影就退回 store 那一份);
③仓库多一个注入口 `refreshMessagesFromProjection`,`getSession` /
`getCachedSession` 各换装一次 —— `session.messages = next` **只在那一处**发生
(规则 B 守的"只有一个维护者"因此仍然成立,只是维护者换成了折叠产物)。

`typecheck` 0,`battery` **RED**:

```
FAIL  retry-message   ok=0 failed=7 mismatch-lines=0
      retry-message#0: [retry-message] timed out waiting for idle (≥1 assistant) (messages=1)
```

诊断实验(一行,证伪/证实用,已随施工版一起回退):

```ts
// 折叠落后一拍时不换装
if (next.length < (session.messages?.length ?? 0)) return session
```

加上它,`retry-message` **PASS**、`no transcript` 那条 27 场景的泳道 **PASS**、
battery **GREEN**。根因由此钉死:

> 读侧换装把**写模型手里刚建好的那条助手占位**清掉了,而下一刀正建立在它上面。

**那一行不能留**:它是 §16.25 拒掉的 C 案换了个样子("store 中途是陈旧的"
这条新口径),而且它的判据是长度启发式 —— `deleteMessage` / `truncateFrom`
本来就该让数组变短,一条按长度短路的规则迟早会把真的删除也挡下来。

#### 三、往下走要什么:一次产地裁定 + 一条不可分割的施工

**挡路的不是"再修一格",是一条结构事实**:store 的消息数组今天既是**读视图**
又是**写模型**,两个身份不能同时切一半 —— 而 c4-c 想切的正是读那一半。

- **完全切换**(端口整批空转 + 老 reducer 消息分支删除 + 读侧现取)之后,
  没有任何写建立在那份数组上,占位窗口就退化成一次 ~0.2ms 的**读可见性**延迟,
  不再是数据丢失。**但它没法分两批验证** —— 本批的红正是"只切一半"造成的。
- 而且完全切换之后,那 ~0.2ms 里 `getSession().messages` 仍然缺最新占位。
  实测这个窗口里的读者 **290/306 是 `CoreStreamEngine.handleSendMessage` 的
  `sessionForHistory`**(`core-stream-engine.ts:925`),它只取 `summary` /
  `summaryUpToMessageId` / `name` 这几格会话级字段,消息数组一格不读
  (历史来自 `this.store.listMessages`,那已经是投影)—— 另外 16 次是
  `handleEditAndResend` / `handleRetryMessage`,它们瞄的是**更早**的消息。
  所以窗口本身**今天无人受伤**,但它让"store = fold(事件流),无活窗例外"
  这句宪法在那一瞬间是假的。

**因此要请用户拍的是这一条(§16.23 第四节那两条待拍板里的第 2 条已由第一节
读数结清,这是新的一条):**

> **流式 assistant 占位要不要 append 期产地?**
>
> - **甲:补产地** —— `sessionCommandEvents.appendMessage` 对流式 assistant
>   也写一格(`assistant/placeholder` 或让 `run/start` 提前到同一同步段)。
>   代价:同一条消息在账本上有两个产地的风险(§9.3 当初正是为了避免它才
>   `return`),要重新裁定 `run/start` 与它的关系。收益:窗口消失,"无活窗例外"
>   真的成立,c4-c 可以一批切完。
> - **乙:承认窗口,写进宪法** —— 保留 `run/start` 是唯一产地,并把
>   "**新建的流式占位在 `run/start` 落账前不在读视图上**"写成一条**明账口径**
>   (像 §16.17 共存口径那样),然后一批完成切换。代价:宪法上多一条例外;
>   收益:零新产地、零账本变化。
> - **丙:不切** —— 老 reducer 与 15 个端口原样留着,c4 就此收在 c4-b。
>   代价:两个维护者永久共存(今天的状态),`session:check` 规则 B 的理由
>   第四次改写。

拍完之后剩下的活是**一批**(不可再拆),内容与 §16.25 第四节列的一字不变:
读侧现取 + 15 端口空转 + 五条端口专用 reducer 分支删除 + `session:check`
规则 B 改写 + `getMessageFromStore` / `hasMessageInStore` / `findMessageFromStore`
三口退役(`hasSessionInStore` 永久例外,§16.11 拍板 4),外加本批新查明的两件:
**物化视图必须跑补水链且必须先深拷**、**失效号不能用 `lastSeq` 代替**。

#### 四、本批的账

- **生产代码**:**0**(施工版 3 件改 + 1 件新增全部回退;
  `git diff HEAD -- packages/backend packages/core packages/onething-runtime/src/sessions` 为空)。
- **探针**:`packages/backend/session/probe-b.ts`,跑完即删。
- **结清**:§16.23 第四节待拍板第 1 条(压缩 / 生图卡片正文的产地)——
  静默期收敛,**不是永久分岔**,不再挂账。
- **新挂账**:第三节那条产地裁定(甲 / 乙 / 丙)。
- **验收**:`typecheck` 0;`sessions:shadow-battery` 带探针 **GREEN**
  (runs 321 / portChecks 265 / portMismatches 0 / refoldChecks 222–225 /
  refoldMismatches 0 / mismatches 0 / appendFailures 0 / `session-shadow.jsonl` 0 行);
  施工版 **RED**(`retry-message` 7/7);回退后 `git diff HEAD` 为空,
  五门与三包全量按"与 HEAD 逐字相同"免跑。真机 `~/.onething` 全程只读
  (battery 跑在一次性临时 store 上)。

### 16.27 F4-c c4-d 落地记录:**一批切完** —— 占位产地同步化 + store 消息数组改由折叠产物维护(2026-08-27,opus 施工,未提交)

#### 〇、一句话

用户裁定**甲第二形态**(`run/start` 落账提前到与 `store.addMessage` 同一同步段,
不开第二产地,§9.3 原样),c4-d 按 §16.26 第三节那份"不可再拆的一批"施工完成:

> **内存 store 的消息数组 = 折叠产物的物化。** 唯一维护者是
> `session-repository.refreshMessagesFromProjection`;15 个热写端口整批空转;
> `getLiveRunWriterMessage` 之后连"写模型自己那份数组"也退役了。

`sessions:shadow-battery` **GREEN**(runs 321 / portMismatches 0 / refoldChecks 224 /
refoldMismatches 0 / mismatches 0 / appendFailures 0),五门 ok,全仓 11934 绿。

**施工中查明 §16.26 没写到的第二条结构事实**(见第二节):`retry-message` 那条红
**不是**占位窗口造成的 —— 占位窗口修完它照样红。真因是"读侧现取"让老 reducer
读到了**自己刚写的那条事件之后**的世界,于是把同一条命令在已经折好的数组上再应用
一次:`delete` / `truncate` 找不到目标,当场 `changed:false`,命令返回"没改成",
引擎当场 `Message not found` 收工。§16.26 的一行长度启发式之所以"看起来能修",
正是因为它顺手挡住了这次二次应用 —— 病根被那一行盖住了。

#### 一、第一步:占位产地同步化(甲第二形态)

| 环节 | 落点 |
|---|---|
| 新端口 | `core/engine/stream-runtime.ts` 的 `StreamEngineStreamsAdapter.openAssistantRun?(options)` —— **同步、无返回值、可缺席**,签名上写死"必须紧贴 `store.addMessage`,中间不许有 `await`" |
| 调用点 | `core/engine/core-stream-engine.ts` 三处创建点(send / edit-resend / retry),都在 `store.addMessage` 返回的**下一行** |
| 实现 | `backend/wiring/engine/stream/stream-executor.ts` 的 `openAssistantRun` → `beginSessionRun(..., { claimed: false })` |
| 取材单实现 | 新 `buildAssistantRunInput`:预开与认领两处共用一份字段口径(算两遍就是两个产地) |
| 认领 | `session/runs.ts` 的 `SessionRunHandle.claimed` + `ensureSessionRun` 多一支:预开那条**没有收尾人**,第一个 `ensureSessionRun` 认领它并拿 `started:true`,收尾照旧归 `executeMessageStream` 的 finally;绕开创建点的那条路(确认后恢复 / 单测直调)照旧在那里开张 |

**retry 那一处顺带前移了一行**:`triggerMessageId` 从前是追加占位**之后**从
`listMessages` 里现取的,而开账要与入库同一同步段,所以这一问提前到追加之前。
答案逐字相同(追加的是一条 assistant 占位,不改变"最后一条用户消息是谁"),
`historyMessages` 那次 `listMessages` 一字未动。

**`sessionCommandEvents.appendMessage` 一行没改**:流式 assistant 照旧一条事件都不写
(§16.20 第四节那条用例照旧成立且照旧该绿)。变的只是 `run/start` **什么时候**落账。

#### 二、第二步施工中的红,以及它教的那件事

按 §16.26 的三件套装完(失效号 / 物化视图 / 单点换装)+ 15 端口空转之后,
`retry-message` **仍然** `ok=0 failed=7`,读数与 c4-c 一模一样
(`timed out waiting for idle (≥1 assistant) (messages=1)`)。

**这一次读了账本**:那三条会话的 `events.jsonl` 停在 `message/deleted`,
**新 run 一条都没开** —— 也就是说引擎在 `deleteMessageAndTruncate` 那一行就收工了,
根本没走到建占位。顺着 `handleRetryMessage` 往回读:

```
truncated = store.deleteMessageAndTruncate(...)   ← false
if (!truncated) { emitStreamError('Message not found'); return }
```

而 `sessionCommands.truncateFrom` 的执行序是 **判据 → 事件 append(F1 同步可见)
→ 老 reducer**。读侧现取一接上,第三步里 reducer 自己那次 `repository.getSession`
就**换装到了自己刚写的那条事件之后**:目标消息已经被折掉了,`applyTruncate` 的
`findIndex === -1`,`changed:false` —— 连带 `updatedAt` / 用量结算 / 索引计数 /
落盘计划整批不发生,返回值还成了"没改成"。

同族的另一半:`appendMessage` 会在已经含有这条消息的数组上**再追加一份重影**
(下一次换装才冲掉)。`patchMessage` 因为幂等而看不出来 —— 它是这条病最会骗人的一格。

**修法:定格只圈归约器那一步。**
`materialized-messages.ts` 加一个嵌套计数 `pinDepth` 与 `withSessionCommandPin(fn)`,
命令面把 `ports.messages.*` 那一次调用圈进去:

- 它**前面**的判据 / 底稿取材照旧现取 —— 那正是"此刻"该有的那一份;
- 它自己看到的是**事件之前**那一份 —— 也就是紧邻它的那次判据读刚换装上去的那一份;
- 不跨 `await`(`replaceAll` 只圈同步那一半),所以立的**不是** §16.25 拒掉的 C 案
  那条"store 中途是陈旧的"新语义:定格的宽度是一次同步调用。

一条纪律写在 `pinDepth` 的注释上:**换装点只有一个,定格段也只有一个**。

#### 三、第二步:终极切换(三件套 + 定格)

| 件 | 落点 | 要点 |
|---|---|---|
| **失效号** | `session/projection-cache.ts` `LiveProjection.version` + `liveSessionProjectionVersion()` | 每次 state 前进 +1;号从**进程级**计数器取,整份重建天然跳号。**不是 `lastSeq`** —— 提前折的逻辑 delta(c3-a)那一行还压在编码器写缓冲里,`lastSeq` 不动而 state 动了,拿 seq 当版本号会让一整段正文被缓存吃掉 |
| **物化视图** | 新件 `session/materialized-messages.ts` | 读侧现取 + 按失效号缓存 + **跑同一条补水链**(`rehydrateSessionFromStorage`)+ **先深拷**(§15.13 判例:`materializeMessageNode` 对 `message/imported` 是浅展开,补水是就地写者,不深拷就把事件里没有的字段写进活投影,refold 当场破);没有活投影 / 折不出消息 → `undefined`,调用方保留自己那一份。**不主动建表** |
| **单点换装** | `session-repository.ts` 的 `refreshMessagesFromProjection`,由 `getSession` / `getCachedSession` 各调一次 | 全仓**唯一**一处 `session.messages = …`;换的是同一个会话对象上的那一格(LRU / 挂起写快照 / `AsyncSaveQueue.getLatest` 握的都是这个对象的引用)。`getCachedSessionMessages` 改走 `getCachedSession`,免得一份缓存两种读法 |

**c4-c 那行长度启发式诊断实验一个字都没有出现。**

#### 四、第三步:收官清单,以及其中一条的**改判**

- **15 端口整批空转**(`backend/stores/sessions.ts`,新私有口 `portTargetExists`):
  content / reasoning / streaming / contentParts / steps / step / toolCalls /
  skill / error / turnContext / usage / stepsUsageByTurn / addStep /
  addContentPart(+ 早已空转的 thinkingTime)。四条 A 类断言(usage / skillUsed /
  errorDetails / turnContext)与 contentPart 守卫**留任**。空转之后它们只答一个
  问题——"这条消息在不在":有活投影问新口 `eventsHasMessage`(走 `byMessageId`,
  **O(1)、不物化**),没有就退回内存 store 那一份。`updateStepsUsageByTurn` 的
  `string[]` 返回值全仓零消费者,返回 `[]`。
- **`updateMessageStreaming` 一并空转**:§16.23 第五节判它"今天翻不得",理由是
  **恒等门会当场红**;恒等门 c4 已退役(§16.24),而"读改物化"正是那一节写的
  解除条件 —— 两件本批同批落地。
- **5 条端口专用命令面包装删除**(`appendContentPart` / `upsertStep` / `patchStep` /
  `patchStepsUsageByTurn` / `setToolCalls`):生产零调用,连带
  `SessionMessageCommandRuntime` 的 5 个成员、facade-mock 的 5 个方法、两条只钉
  它们写计划档位的用例。
- **改判:core 那一侧的五条 reducer 分支`没有`删。** §16.25/§16.26 判它们"整批
  删除",理由是"生产零流量"—— 那句话对**命令面包装**成立,对 reducer 分支不成立:
  `core/session/__tests__/projection-contract.test.ts` 的 **A 线**(「命令序列 →
  `ChatMessage[]`」,与「事件序列 → 投影」逐格对拍)正是拿这五条表达"引擎往消息
  上写了什么"。删了 A 线就说不出话,**一条活着的判据会当场退化**。据实改判,记在这里。
- **`session:check`**:规则 B 的理由第四次改写(今天守的是"对 `ChatMessage`/`Step`/
  `ToolCall` 的字段赋值只有一个算法处";reducer 不再是消息数组的维护者,它的两个
  身份是会话级派生的算法 + 合同测试 A 线的词汇);新增**规则 C 具名例外**
  `RULE_C_ALLOWED = { session-repository.ts }` —— 唯一维护者总要有一处把折叠产物装上去。
- **三口判据同源`没有`退役**(`getMessageFromStore` / `hasMessageInStore` /
  `findMessageFromStore`)。§16.26 把它们的退役挂在"reducer 退役"上,而 reducer
  按上一条**没有**退役:它仍然在算会话级派生,判据仍然要与它同源。今天这三口读的
  已经就是物化视图(store == fold),所以它们**不再是第二份真相**,只是同一份真相的
  store 侧门牌。`hasSessionInStore` 照旧是永久例外(§16.11 拍板 4)。
- ③ `partialResult` / ④ 已在 §16.25 第五节结案,本批一行未动。

#### 五、验收(全部实跑)

| 门 | 结果 |
| --- | --- |
| `sessions:shadow-battery`(全量) | **GREEN** —— runs **321** / portChecks 265 / **portMismatches 0** / refoldChecks **221–225**(并发抖动)/ **refoldMismatches 0** / mismatches 0 / appendFailures 0 / duplicates 0 / projectionIssues 0 / droppedParts 0 / `session-shadow.jsonl` **0 行** |
| **探针 C4D**(三采样点,跑完即删) | `openAssistantRun` 返回那一刻占位在场 **306 / 306**(miss 0);**任何一次 `getSession`,活 run 的那条占位在折叠产物里 —— 9,626 次采样 miss 0**(c4-c 同类是 306 次缺)。`addMessage` 返回那一刻 **322 / 322 缺** —— 与 c4-c 的 322 逐字复现,**按构造如此**:落账是它的下一行语句,中间没有 `await`,所以这个"缺"对任何读者都不可观测(单线程同步段)。真正可观测的那一格就是上面那 9,626 次 0 |
| **字节回归** | **0 差** —— `session-chunk-bytes.test.ts` 原样绿 |
| `typecheck` | **0**(node + web) |
| `boundary:gate` | ok — 0 failures |
| `session:gate` | ok — 0 known, none new(规则 C 例外落地后) |
| `log:gate` | ok — 4 known, none new |
| `transport:gate` | ok — 42 常量 / 四壳 2392 行,不变 |
| `ui:gate` | ok — 81 known, none new |
| `packages/backend` + `packages/core` + `runtime/src/sessions` | **3523 passed / 0 failed / 3 skipped**(389 文件;`sessions-delete-cascade` 满载时抖动一次,单跑 3/3 绿) |
| 全仓 | **11934 passed / 2 failed** —— 两只都是 `App.container-layout`(**他会话在途的 renderer 改动**,本批未碰 renderer 一个字节) |
| 真机 `sessions:verify:gate`(只读) | FAILED,**仍是 §16.20 第七节那一条** `room-1 seq: expected seq 2 at position 1, got 3`,**无新增**(本批全程未写 `~/.onething`) |

#### 六、性能读数(真机会话只读拷进临时 store)

| 会话 | 账本 | 消息数 | 冷折(建活投影) | 一次物化(缓存未命中) | **缓存命中 p50 / p99** |
|---|---|---|---|---|---|
| `08f1fe09` | 50.4 MB | 258 | 176.2 ms | 46.0 ms | **0.125 µs / 1.375 µs** |
| `7e94ef0e` | 25.2 MB | 76 | 84.4 ms | 14.5 ms | **0.042 µs / 0.834 µs** |

- **稳态(投影没前进)= 一次 map 查询 + 一次 `!==`**,亚微秒级 —— §16.25 给 B 案
  写的那句预期成立,`getSession` 这条极热路上的新增成本可以忽略。
- **代价在活 run 窗口内**:每条 delta 都会换失效号,所以流式期间每次
  `getSession` 都要重物化一次。实测频次 ~30 次/run(探针那 9,626 次 / 321 run),
  在上面那条 258 消息的巨型会话上就是 ~30 × 46 ms。battery 的会话很小,量不出来。
  **留账**:真要治,方向是**按节点缓存物化**(只重算改动过的那几条),不是回头去改
  换装点 —— 那是 c5 之后的事,本批只记读数不动手。

#### 七、本批的账

- **生产代码**:新增 1 件(`backend/session/materialized-messages.ts`);
  改 9 件(`core/engine/{stream-runtime,core-stream-engine}.ts` /
  `backend/session/{projection-cache,events-reads,runs,commands}.ts` /
  `backend/stores/sessions.ts` /
  `backend/wiring/engine/{stream-engine-runtime.ts,stream/stream-executor.ts}` /
  `runtime/src/{product-stream-runtime.ts,sessions/session-repository.ts}`)。
  新增事件类型 **0**;canonical 新豁免 **0**;磁盘格式变化 **0**;账本零变化。
  renderer / providers / tsconfig **一个字节没碰**。
- **删除**:5 条端口专用命令面包装 + 它们在 `SessionMessageCommandRuntime` /
  facade-mock 上的成员 + 两条只钉写计划档位的用例。
- **脚本**:`session-check.mjs` 规则 B 理由第四次改写 + 规则 C 具名例外(新)。
- **测试**:1 处 mock 补 `openAssistantRun`(`stream-engine-resume-agent-loop`)。
- **探针**:`backend/session/probe-c4d.ts` + 三处两行钩子,跑完即删
  (`git status` 已确认无残留)。
- **留账三条**:①活 run 窗口内大会话的重物化成本(第六节);②老 reducer 与三口
  判据同源**没有**退役,理由见第四节两条改判;③策略表 + 收敛性质测试(定律三)
  仍在 c5。

---

## 17. 系统宪法(F4-c c5 收章,2026-08-27)

> **三句话读懂这个系统。**
>
> 1. 会话里发生的每一件事——用户发一条、模型吐一个字、工具跑完一步——都是一条
>    **逻辑事件**,汇进同一条流;这条流是全系统**唯一的生产线**。
> 2. 往一边,投影 reducer 当场把它折成状态,`session.messages` 只是那份状态的
>    **物化视图**;往另一边,编码器把同一条流压成打包行落进 `events.jsonl` ——
>    磁盘上**只有这一份真相**。
> 3. 一件事实允许不落盘,当且仅当**另一条落了盘的事实使它冗余**,而且那句"使它
>    冗余"要有一条跑得起来的测试。
>
> 下面三节把这三句话写成定律、画成图、拆成纪律。第 17.5 节是所有还没做完的事。

### 17.1 三定律

底本是 §16.19 B 节。措辞按 c1–c5 的落地实况修订过,**语义没有变**。

---

**定律一:只有一种词汇,delta 是逻辑单位。**

每个事实——模型吐一个字、工具出一段输出、用户发一条消息——是**一条逻辑事件**。
折叠、投影 reducer、判据(`canonicalChatMessage`)、UI 流,全都只说这一种话。

**不存在"瞬态事件"与"持久事件"两个物种。** 一条 delta 从写入端走到读取端,身份
自始至终是它自己;中途被攒进一行还是单独一行,是存储的事,不是它的事。

> *落地实况*:c3-a 起,流式的每一条逻辑 delta 在**盖章那一刻**就折进活投影
> (§16.23 第三节),而不是等打包行刷出去。"提前折"因此不是优化,是定律一的
> 直接后果。

---

**定律二:打包是压缩,不是语义。**

`events.jsonl` 里那条 `assistant/chunks`(一行攒 N 条 delta)**定性为存储编码**:

- **写入端**:逻辑 delta 进编码器,编码器按段落边界与两道闸(2s / 64 条)刷出
  打包行 —— **时机与字节与从前逐字节相同**;
- **读取端**:打包行经解码器展开回逻辑 delta 流,再交给投影 reducer 折。

唯一合同:**`decode(encode(x)) ≡ x`**。

U0 的段边界状态机迁居编码器——它本来就该住那儿:"这条 delta 落在哪一段、哪一段
该收了"决定的正是"刷哪一行"。

> *落地实况*:`packages/core/session/events/chunk-codec.ts`(§16.21)。写侧字节
> 0 差、读侧全库 433 个账本折叠指纹 0 差、性能 1.04×。上一版方案里的"瞬态事件道"
> 与"边界交接断言"两个补丁,因为这条定律而**整个消失了**。

---

**定律三:短命事实必须被证明会被取代。**

一种事实允许不持久化,**当且仅当**后续某条**持久事件**使它冗余(工具中途的输出
⊂ 它最终的结果)。

短命种类登记在词汇表旁的**封闭策略表**
(`packages/core/session/events/ephemeral-policy.ts`),每条必须交齐三样:

1. **取代它的持久事件**(事件类型的名字,不是一句话);
2. **收敛性质的形状**——只有两种,不许自创第三种:
   - `strip-homomorphism`:折到取代事件**之后**把这一格抹掉,`canonical` 一字不变;
     折到取代事件**之前**抹掉会变(**反证**,证明这条登记不是空转);
   - `substitute-derivable`:取代事件在场时替身逐格算得出来,缺席时替身**不出现**
     (不补 0 假装有);
3. **证明指针**——落到具体的 `it(...)` 名字上,而且
   `__tests__/ephemeral-policy.test.ts` 会**逐条把它解析回磁盘**。文件搬家、用例
   改名,那道门当场红:指针因此不会烂。

**反过来,不是"被取代"的豁免不许写进策略表。** 坐标(`seq`)、派生量
(`thinkingTime`)、两次读表的时钟噪声(`startTime`/`endTime`)、渲染锚点
(`data-steps`,G4)留在 `canonical.ts` 的**杂项表**里,各带各的一句人话。两张表
分家的意义就在这里:策略表里每一条都有一条机器能跑的收敛证明,杂项表里每一条都
只有一句人话——混在一起时没人分得清哪条是哪条。

**表外还有一条**:登记一条短命事实**不等于**允许产品行为退化。判据仍然是 §9.4
那句话——*拿投影那一份当真相,用户看到的东西会不会变?* 会变的一格不许进这张表,
它该做的是**补一个采集点**(工具结局的 metadata 就是这么补上来的,不是豁免掉的)。

**今天登记在册的 7 条**(全表见源文件):

| id | 短命事实 | 取代它的持久事件 | 性质 |
|---|---|---|---|
| `message.isStreaming` | "这条助手消息还在生成中" | `run/end` | strip |
| `message.thinking-activity` | `isThinking` + `thinkingStartTime`,UI 活跃态 | 推理段 `assistant/chunks` → `thinkingTime` | substitute |
| `step.partialResult` | 工具执行途中的结局缓存(+`partialResultIsPartial`) | `tool/result` → `toolResultToStructured` | substitute |
| `toolCall.streamingArgs` | "参数还在生成"(消息上那一格是空串) | `tool/call.argumentsRaw` | strip |
| `contentPart.placeholder` | `waiting` / `image-loading` 两种占位 | 同位真正的正文 / 图片 part | substitute |
| `contentPart.plugin-status.unsettled` | 未结算的插件状态行 | `plugin/status`(带 `durationMs` / `cleared`) | substitute |
| `codec.unflushed-delta` | 编码器写缓冲里还没刷出的 delta | `assistant/chunks` 打包行 | strip |

**终局的一句话**:`store = fold(事件流)`,**无活窗例外**。第一个字即事件,折叠
当场前进;编码器的写缓冲是唯一"内存领先磁盘"的窗口,它归存储层(fsync 检查点
原管),**不是语义例外**。磁盘格式 / 账本体积 / 渲染层 / IPC:零变化。

### 17.2 终态架构(数据流一条线)

```
                        ┌──────────────────────────────────────────────┐
  事实源                │            逻辑事件流(唯一生产线)          │
  ─────────             │  一条事实 = 一条逻辑事件,delta 是最小单位   │
                        └──────────────────────────────────────────────┘
  用户命令 ──────────┐                        │
   backend/session/  │                        │
   command-events.ts │                        │
   (13 命令唯一产地)  │                        │
                     ├──▶ 事件写入口(两扇门) │
  模型 delta ────────┤    · appendSurfaceAwareEvent (event-surface.ts) —— 带 surface 记账
   provider SSE →    │    · appendSessionLogEvent   (event-log.ts)     —— 素门
   引擎 chunk        │           │
                     │           ├── F1 同步可见钩子 registerSessionLogEventAppendObserver
  工具事实 ──────────┘           │      两扇门都过它:落盘**之前**单源前进
   tool/call|annotate|result     │
   session-event-recorder.ts     ▼
                        ┌────────────────────┬────────────────────────┐
                        │   ① 折叠(读那半)  │   ② 编码(写那半)      │
                        └────────────────────┴────────────────────────┘
                                 │                        │
   core/session/projection/      │                        │  core/session/events/
   reducer.ts  ─ 折 ─▶  活投影   │                        │  chunk-codec.ts
   (唯一状态推导)      LiveProjection (backend/session/    │  · U0 段边界状态机
                                 projection-cache.ts)     │  · 两道闸 2s / 64 条
                                 │  + 失效号 version      │  · decode∘encode ≡ x
                                 ▼                        ▼
   chat-messages.ts     物化视图 materialized-messages.ts   events.jsonl + blobs/
   materializeNode      · 现取 + 按失效号缓存               (**磁盘上唯一的真相**)
                        · 跑同一条补水链 · 先深拷           messages.jsonl 永久停写
                                 │                              │
                    单点换装 refreshMessagesFromProjection       │ 冷加载:解码 → 折叠
                    (runtime/src/sessions/session-repository.ts) │
                    全仓**唯一**一处 `session.messages = …`  ◀───┘
                                 │
                                 ▼
          读者:引擎收尾链 / sessionReads / IPC·SSE 推送 / renderer
          （渲染锚点 data-steps 由 core/session/render-anchors.ts 从折叠产物现算，
            不进账本、不进正文）
```

**三处必须记住的落点**:

1. **写入口是两扇门、一只眼**。两扇门(带 surface / 素门)对应两类产地(命令面 /
   采集器),那只眼(F1 观察者)让**活投影与活 surface 在排队落盘之前就前进** ——
   "命令产事件、事件当场可见"这件事就靠它。
2. **18 个热写端口签名不动,实现空转**。它们今天只答一个问题——"这条消息在不在"
   (有活投影问 `eventsHasMessage`,O(1) 不物化;没有就退回内存 store)。四条 A 类
   断言(usage / skillUsed / errorDetails / turnContext)与 contentPart 守卫留任,
   它们是**端口事实断言**(`backend/session/port-fact-assert.ts`)的采样点。
3. **常驻门只剩三类**:耐久(refold)、逐格(端口事实断言)、语义(策略表收敛 +
   S0 合同 + 编解码器性质)。恒等门在 c4 告别对账之后**已退役**(§16.24)。

### 17.3 终态纪律清单

每条一句话 + 出处。这些是**已经被真机或回归打脸打出来的**,不是审美偏好。

| # | 纪律 | 出处 |
|---|---|---|
| 1 | **F1 同步可见**:两扇写入门都过 `registerSessionLogEventAppendObserver`,活投影在排队落盘**之前**就前进——否则"命令产事件"在同一个 tick 里读不出来 | 批 F1;§16.19 A |
| 2 | **单点换装**:全仓唯一一处 `session.messages = …` 在 `refreshMessagesFromProjection`;`session:check` 规则 C 给它一条**具名**例外,不是通配 | §16.27 三/四 |
| 3 | **`withSessionCommandPin` 圈住归约器那一步**:换装接上之后,老 reducer 会在**自己刚写的那条事件之后**再应用一次同一条命令(`delete`/`truncate` 当场 `changed:false`)。定格段只圈 `ports.messages.*` 那一次调用,它前面的判据/底稿照旧现取 | §16.27 二 |
| 4 | **补水前先深拷**:`materializeMessageNode` 对 `message/imported` 是**浅展开**,而补水是就地写者——不深拷就会把事件里没有的字段写进活投影,refold 当场破 | §15.13 判例;§16.27 三 |
| 5 | **缓存键是失效号,不是 `lastSeq`**:提前折的逻辑 delta 那一行还压在编码器写缓冲里,`lastSeq` 不动而 state 动了——拿 seq 当版本号会让**一整段正文**被缓存吃掉 | §16.27 三 |
| 6 | **G4:锚点住渲染**:`data-steps` 是步骤面板的**渲染坐标**,位置由"这一轮有没有工具调用"算得出来,不是正文——事件里没有它也不该有它 | §10.1 G4;§16.25 钥匙① |
| 7 | **`hasSessionInStore` 是永久例外**:"这间会话的外壳在不在 store 里"是 store 自己的事实,不是折叠产物。`getMessageFromStore` / `hasMessageInStore` / `findMessageFromStore` 三口今天读的已经是物化视图,不再是第二份真相 | §16.11 拍板 4;§16.27 四 |
| 8 | **§13.8 新裁定**:采集点可以记"**某人说过的话**",不可以记"**我推出来的结论**"。判断标准是**这句话在别处有没有产地**——有,就抄同一把判定点;没有,就是二次派生 | §16.9 五 |
| 9 | **成对交付**:新字段缺席 = **修复前的行为**。老账本上一格都不许猜 | §10.16 |
| 10 | **判据只有一把尺**:`canonicalChatMessage`。不许为某条路开局部豁免——"canonical 之后相等"证明的不是"可以互换" | §9.4;§16.13 |
| 11 | **不许调绿**:门红了改事实,不改门 | §8;`backend/session/shadow.ts` |
| 12 | **命令是 COW**:先捕获 `session.messages`、再 `await`、再读那个变量会拿到旧数组。`await` 之后重读 | P0(`docs/design/session-commands-p0-2026-08.md`) |
| 13 | **端口签名冻结**:18 个 `sessionMessageRuntime` 口签名不动、实现空转;A 类断言与 contentPart 守卫留任(它们是端口事实断言的采样点) | §16.27 四 |
| 14 | **真机只读**:跑门不写 `~/.onething`。跨库写已根治 + `vitest.setup.ts` 全局硬闸 | §16.22 |
| 15 | **停诊批不夹带**:勘察结论是勘察结论,一行生产代码都不落;要落先拍板 | §16.3;"行为裁定须先问" |

### 17.4 常驻门清单

| 门 | 它证明什么 | 落点 |
|---|---|---|
| `sessions:shadow-battery` | 27 场景四泳道跑一遍,refold + 端口事实全绿 | `scripts/shadow-battery.mjs` |
| **refold**(耐久) | 文件字节重折 ≡ 内存活投影(比对点 = 编码器刷新点) | `backend/session/refold.ts` |
| **端口事实断言**(逐格) | 恒等门的逐格替身:端口收到的值 ≡ 折叠算出的值 | `backend/session/port-fact-assert.ts` |
| **策略表收敛 + 指针解析** | 定律三:每条短命登记都被取代,且证明指针不烂 | `core/session/__tests__/ephemeral-policy.test.ts` |
| **`decode∘encode ≡ id`** | 定律二:打包是压缩不是语义 | `core/session/__tests__/session-chunk-codec.test.ts` |
| **字节回归** | 打包行的时机与字节与从前逐字节相同 | `session-chunk-bytes.test.ts` |
| **S0 合同(A/B 两线)** | 期望折叠产物 ≡ 事件线(#8a 起 A 线不再说"命令"),模型历史逐字节相同 | `core/session/__tests__/projection-contract.test.ts` |
| **step 身份合同** | 两条路上 step id 语义同源 | `step-identity-contract.test.ts` |
| `sessions:verify`(只读) | 存量账本对账 | `scripts/session-verify.ts` |
| 补水合同 | 冷加载补水 ≡ 投影 | `scripts/session-hydration-contract.ts` |
| 五道棘轮 | boundary / session / log / transport / ui | `scripts/*-gate.mjs` |

### 17.5 留账归档表(全部未竟项)

一张表收全。**没有第二个地方记这些事**——往下开工先看这里。

| # | 留账 | 状态 / 判据 | 出处 |
|---|---|---|---|
| 1 | **大会话按节点物化缓存** | 稳态是亚微秒(一次 map 查询 + 一次 `!==`),代价全在**活 run 窗口内**:每条 delta 换失效号,`getSession` ~30 次/run,258 条消息 / 50MB 的巨型会话上一次物化 46ms。方向是**只重算改动过的那几条**,不是回头改换装点 —— **§17.7.1 批 1 已落地**(memo 成为节点自持属性,外挂簿记整体删除;实测 49.5ms → 一条 delta 0.026ms) | §16.27 六;§17.7.1 批 1 |
| 2 | ~~**老 reducer 远期退役**~~ **已结清(§17.7.1 批 3)** —— `applySessionCommand` 与 7 条分支、`SessionCommand` 联合、`adoptSessionCommandResult`、`OnethingSessionMessageRuntime` 整层全部真删;会话账改由事件折叠产出,落盘档与索引元数据归写门。原文如下 | c4-d 改判保留两个身份;**#8a(08-28)已兑现退役条件、消掉身份 2** —— A 线改说事件(`ExpectedLine`),5 条生产零流量的端口专用分支与 15 个零调用端口口真删,`SessionCommand` 12→7。**剩下的唯一身份是「会话级派生的算法」,而它是真生产依赖**(7 条活分支各在写路上,全仓唯一的 `updatedAt`/`lastProvider`/总账扣减/`contextSize`·`summary` 失效/lazy 档产地)。往下 = **#8b**,并入 #3 出方案 | §16.27 四;§17.7 #8a |
| 3 | ~~**三口判据同源退役**~~ **已结清(§17.7.1 批 3)** —— `get/has/findMessageFromStore` 随 reducer 一起删,判据改问投影(`eventsHasMessage` / `getMessage`);`hasSessionInStore` 按纪律 7 永久留任。`withSessionCommandPin` / `pinDepth` 同批删除(它防的"归约器二次应用"不存在了)。原文如下 | 挂在第 2 条上 —— **#8a 未动它**:三口全部挂在那 7 条**活**分支上当"写不写事件"的判据(`pin` 同理),分支活着就不能退。今天三口读的已是物化视图,**不是第二份真相**,只是同一份真相的 store 侧门牌。真正的退役随 #8b | §16.27 四;§17.7 #8a |
| 4 | **`tool/result` 进 surface 的写侧一票** | **已由 F1 收**(§16.15);另册里那条记录作废 | §16.15;§16.11 |
| 5 | **A 只修尾随格** | 归属在段外、却排在段**中间**的 `tool/result` 表达不出来(replace 的 op 是位置连续段)。全库零例;真要修得先给 surface op 词汇加"非连续遮蔽" | §16.15 六-1 |
| 6 | **`pruneShadowedToolCalls` 是零命中路** | 生产者还没写。真写时要一并决定"只遮结果格"这种 op 下 `isShadowedWith` 怎么答,而不是默默让它生效 | §16.15 六-2 |
| 7 | **`events.jsonl` 分卷轮转** | 只出了方案要点(触发条件 = 字节 + 语义边界,不是时间;归档 = 分卷 + 清单,不是 gzip 覆盖;refold 的"文件字节此刻是全的"前提要重定义),**待拍板** | §15.12 B3 |
| 8 | **`legacy-backup/` 381.4MB** | S1a 迁移留下的原抄本副本,**没有治理器**。同批的 `messages.cleared-*`(14MB)同理。只测量未治理 | §15.12;裁定 10 |
| 9 | **真机夹具沉积清理 + `room-1` 主人判据** | `~/.onething` 里测试年代留下的会话 / traces / debug 快照要不要删;`room-1 seq: expected seq 2 at position 1, got 3` 这条 verify 红是**收进基线**还是**修数据**——**待用户拍板**。它自 §16.20 起**每一批原样复现**(c5 这批仍是它,无新增) | §16.20 七;§16.22 五(d) |
| 10 | **结算态 `plugin-status` 无产地** | **§17.7.2 勘察更正:上一版这一行的"取代事件已落盘"是错的** —— `plugin/status` 只有词表条目与一条"记录在案但不改投影"的归约分支,**全仓零生产者**;插件状态这一格从头到尾是流内的(`CorePluginStatusRegistry` → chunk 流 → renderer `content-parts.ts`)。缺的不是折叠少折一步,是**写侧没有采集点**。补它 = 新起一条 plugins → 账本的采集线 + 裁定"重开会话后还看不看得到已结算的状态行"(**可感知的行为变化**)—— 停在诊断,待拍板 | §17.7.2 四-2 |
| 11 | ~~**`toolCall.argsFinalizedBy` 无采集点**~~ **已结清(§17.7.2 四-1)** —— 定性为**采集过程的注记**("我们的流式层怎么知道参数说完了"),不是会话事实;实测全仓零消费者(只有生产者),进 canonical 豁免表是**终态**而不是欠一条产地 | §10.8;§17.7.2 |
| 12 | **两个端口断言没被考过** | `updateMessageError` / `updateMessageTurnContext` 的 A 类断言在 battery 里**零调用**,各欠一个场景 | §16.24 九-3 |
| 13 | **U1 / U2 + B 期路线** | B 期换管 + U1 renderer fold/影子 + U2 切换删旧(renderer 一次大动),细案届时出 | §16.11 尾;`docs/design/ui-event-stream-2026-08.md` |
| 14 | **②类同源注释清理** | 远期另册,纯文字 | §16.11 尾 |
| 15 | **usage / `contextSize` 的正向写者没有事件产地** | `applySessionTokenUsage`(agent-loop 收尾)/ `updateSessionContextSize`(provider-finish)/ server 的 `applyServerSessionUsage` 三处**就地写会话容器**,不经命令面也不产事件。§17.7.1 批 3 **明确不接管**(接管 = 改 token 记账行为,与"零可感知行为变化"相悖);折叠侧照旧折得出自己那一份,只是不落格。补产地与否是单独一次拍板 | §17.7.1 批 2 五 / 批 3 八 |
| 16 | **冷加载修复仍以存储突变落盘** | `sanitizeSessionOnStartup` 已改为直调 `computeSessionRepairOnLoad`(纯派生、COW),但结果仍由 `loadSessionWithAdapters` 写回 `meta.json`。"搬成纯派生出口"那一半**停在诊断**:它唯一的差别是盘上带不带修好的值(下次冷加载幂等地再修一遍),属于存储可见的变化而没有消费者要求 | §17.7.1 批 3 二 |

### 17.6 两态图 artifact 与终态的出入(图待更新,本节只记差异)

`会话流水线两态`(artifact `1ef58ddd`)画的是 §16.19 **方案态**的终局。c1–c5 走完
之后有五处与实况不符,更新时按下面这五条改:

1. **老 reducer 没有删除**。图里"− 消失"首条与下图"已删除/退役"框都写了它。实况:
   c4-d **据实改判**保留——它不再维护消息数组,但仍是会话级派生的算法与 S0 合同
   A 线的词汇(留账表第 2 条)。
2. **18 个热写端口没有删,是"空转"**。"热写直改 store"这件事确实消失了(图上这句
   对),但端口本身签名冻结、实现空转,而且仍答"这条消息在不在";四条 A 类断言与
   contentPart 守卫**留任**,它们是端口事实断言的采样点。
3. **"`run/start` 携占位全字段(出生即可折)"不是新增**。§16.20 改判:那些格
   F4-a 时就齐了,88 是**取样窗口**的读数而非产地缺口,c1 零代码改动。c4-d 真正做
   的是把 `run/start` 的**落账时机**提前到与 `store.addMessage` 同一同步段——
   新增的是时机,不是字段。
4. **"store = 物化视图"下面缺三件**:唯一维护者是 `refreshMessagesFromProjection`
   (**单点换装**)、缓存键是**失效号**(不是 `lastSeq`)、取材要**先深拷再跑补水链**。
   这三件是 c4-d 施工里代价最大的三格,图上一格都没有。
5. **恒等门退役之后有替代者**。图上只画了"恒等门消失",实况是它被
   **端口事实断言**(`port-fact-assert.ts`,battery 比过 265 次 0 失配)逐格接住;
   终态常驻门是 **refold + 端口事实断言 + 语义三件套**(策略表收敛 / S0 合同 /
   编解码器性质),不是"refold 一个"。

另有一处位置差(不影响读图):短命策略表画在流侧,实际住在**词汇表旁**
(`core/session/events/ephemeral-policy.ts`),消费者是 `canonical.ts` 与
`content-part-guard.ts` 两处。

### 17.7 留账方案集(2026-08-28,Fable;评审口径=可维护性+可迭代性两轴,hotfix 即架构告警)

用户裁定口径:若某项的"当前修法"是补丁形态,即视为架构有病,宁调架构不惧复杂度。
本节对 §17.5 中需要方案的每项给 1–2 案,标注 hotfix 味与推荐。#1/#4 属数据处置授权
不设方案。

**#3 物化缓存粒度**
- 现状 hotfix 味:失效号是**外挂账本**(进程级计数器 + 模块内 Map),缓存的"谁作废"
  与领域对象(投影节点)分离——典型的旁挂簿记。
- 方案 A(细化外挂):失效号按消息分桶,Map<messageId, 版本>。可维护性:簿记逻辑
  仍在物化模块里,两份真相(节点态 vs 桶号)要人肉对齐;可迭代性:再加一层视图
  (如 U 线的 renderer 视图)就要再挂一套桶。**hotfix 味未除。**
- 方案 B(节点自持,推荐):物化成品成为 **ProjectionNode 自己的惰性属性**——reducer
  触碰节点时顺手清掉该节点的 memo,列表组装=对可见节点 map 一次(命中即取 memo)。
  缓存与失效跟着对象走,外挂簿记消失。可维护性:失效逻辑住在唯一会改节点的地方
  (reducer),不可能漏;可迭代性:任何新视图(UI 折叠、trace、history)都白捡同一份
  节点级 memo。面向对象审核:通过(状态与其呈现内聚于对象)。

**#2+#1 verify 账本主人判据(连带夹具清理)**
- 现状 hotfix 味:verify 把"谁的账本"当成不存在的问题,外部进程污染与引擎断号同色;
  夹具沉积靠基线静音。
- 方案 A(判据补丁):verify 按会话 id 模式排除夹具名单。名单要维护,新夹具再漏
  再加——补丁。
- 方案 B(账本自证身份,推荐):`session/created` 事件携带**产地印章**(store 路径指纹
  /宿主类型),verify 读第一条事件即知账本主人,非本机产地=降级为"外来账本"单列。
  可维护性:判据从名单变成事实;可迭代性:未来多 store/多宿主(server、移动端)
  天然有身份可查。落地时顺带清夹具沉积(授权已在)。

**#5 events.jsonl 分卷轮转**
- 方案 A(外部治理脚本):janitor 式按字节切卷+清单文件。hotfix 味:治理逻辑住在
  账本之外,清单是第二份真相,refold/trace 都要学会读清单——三个读者三次适配。
- 方案 B(编码器第二职责,推荐):轮转定性为**存储编码的一部分**(定律二的自然延伸):
  编解码器管"逻辑事件流 ↔ 物理文件组",分卷边界=段边界的放大版,卷索引是**可再生
  缓存**(丢了从卷头重建)而非真相。可维护性:读者仍只面对"一条逻辑事件流",三个
  读者零适配;可迭代性:未来压缩算法、远端归档都是编码器内部演进。前置:数字到
  阈值再动(现 400MB 未到)。

**#6 事件写入的"两门一眼"收敛**
- 现状 hotfix 味:带 surface 门 + 素门 + F1 观察者眼,三件拼出"写入口"——历史累积
  形态,ec2437ff 病历(素门事件活 surface 看不见)正是拼缝的产物,F1 的眼是补拼缝的。
- 方案(单门,推荐,无 B 案):合并为**一个写入口对象**,surface 记账成为它的内部
  步骤(所有 surface 格同门),观察者眼降级为门内实现细节。可维护性:"事件怎么进
  系统"一个类讲完;可迭代性:未来任何新事件类型自动获得 surface/折叠/落盘全套,
  不再有"走哪扇门"的选择题。注:edit-resend 遮蔽范围会因 tool/result 同门而更完整
  ——即 §15.21 挂起那一票,随本案自然落定(读侧兼容批 P 已铺)。

**#7 三条产地小尾巴**
- 结算态 plugin-status:按定律一补产地(一条 `plugin/status` 终态事件),短命表里
  unsettled 的取代者从此真实存在。无 B 案——"没有产地的事实"在本宪法下就是 bug。
- argsFinalizedBy:同上,归 `tool/call` 已有事件补一格,或判定为派生量进豁免表
  (勘察定,倾向后者:它描述"参数怎么定稿的",是采集过程注记不是会话事实)。
- 两个端口断言未经真机:非方案项,浸泡自然覆盖。

**#8 reducer/三口的最终退役**
- 现状:reducer 降格为合同测试 A 线的"活词汇"留任——这是权宜,不是终态。
- 方案 A(留任制度化):A 线合同改名"引擎写入语义样本",reducer 永久保留为测试
  基准。可维护性:两份语义长期并存,改命令仍要看两处——与"不乱"目标相悖。
- 方案 B(A 线改说事件,推荐):合同测试的输入从"命令序列"改为"事件序列 + 期望
  折叠产物"(事件即词汇,不再需要 reducer 当翻译),reducer 与三口随之真删。可维护
  性:全仓最后一份双语消失;可迭代性:新命令的合同=写一段事件剧本,门槛更低。
  排期:独立小批,随时可做。
- **08-28 勘察勘误(#8 首棒停诊,一行未改)**:上面"随之真删"是对 §17.5 #2 的
  **摘要丢格**——#2 原文记着 reducer 的**两个身份**,本节只复述了"A 线词汇"一个。
  逐口实测(非测试文件零漏):15 个消息级端口生产零调用(§16.27 那批,确实只剩
  A 线在用),但 **7 条分支活在生产写路上**(append / upsert / patch / delete /
  truncate / replaceAll / repairOnLoad),它们是全仓**唯一**的会话级派生产地:
  `updatedAt`(会话列表排序唯一写者)、`lastProvider/lastModel`、截断时把
  `subtractedUsageFromProjection` 减到会话总账、`contextSize`/`lastInputTokens`/
  `summary` 失效、`result.lazy`(5s lazy 落盘档判据)。下游真消费者:index meta、
  plugins/sessions 上下文占比、radio DJ 闸、evals、tasks dispatch。三口
  (`get/has/findMessageFromStore`)全部挂在这 7 条活分支上当"写不写事件"判据,
  pin 防的也是活分支的二次应用——**分支活着,三口与 pin 就不能动**。
  已死可划掉的两格:`writePlan` 被 storage-driver 收下不再读(批 6b);sqlite
  适配器零注入,`commandMessageSeq`→sqlite 链空转。
- **据此拆两半**:
  - **#8a(立即施工,无争议)**:A 线改说事件(`CommandLine`→`ExpectedLine`,
    21 条场景一条不丢;纪律:期望产物必须从场景描述按引擎写法逐格拼,**绝不能**
    抄投影输出当字面量——否则合同静默退化成恒真等式,此纪律落进文件头注释;
    `truncateFrom{inclusive:false}` 的 timestamp 覆盖与 truncate 的 usage 扣减
    两格要显式表达,今天是白捡 reducer 的)+ 只删 5 条生产零流量分支
    (`appendContentPart`/`upsertStep`/`patchStep`/`patchStepsUsageByTurn`/
    `setToolCalls`)及专用类型,`SessionCommand` 联合收缩到 7 条;
    `session:check` 规则 B 理由改写成只剩身份 1。三口与 pin 原地不动。
  - **#8b(并入 #3,同一条定律①)**:「**会话账也是折叠产物**」——`updatedAt`/
    `lastProvider,lastModel`/usage 总账/`contextSize` 失效/lazy 档全部改为从事件
    折叠得出,与 #3 的节点自持物化是同一方案的两个层级(消息级 memo + 会话级
    derived)。#8b 落地后 7 条活分支、三口、pin 才能一起真删。方案随 #3 细案一起出。

**#8a 落地记录(2026-08-28,opus 施工,未提交;7 文件 +410 −562)**

*A 线迁移清单* —— `CommandLine`(命令序列 → 老 reducer)换成 `ExpectedLine`
(场景描述 → 期望折叠产物,普通对象数组落格)。**21 条 A/B 对拍场景一条不丢,逐条
过**:single text turn / turn with reasoning / reasoning 两个落点(top vs inline)/
steering 劈两条消息 / steer 无 `continuesRunId` 的兜底推断 / 失败但完成的工具保留
结构化结局与自报标题 / edit changes 上 toolCall 与 step.toolCall / `providerCostUSD`
一路到 `steps[].usage` / 两次请求含 denied 权限 / 流式 bash 读 SKILL.md 的
skill-read+skillUsed / abort 中止在飞工具 / abort 在参数流中(孤儿占位活、未完成回合
不落 parts)/ regenerate 砍旧回合 / edit-and-resend 改写并截断 / 中段删除 / 压缩
(UI 留、模型历史折)/ collab clear 并继续写 / 系统标记来去 / imported 老消息逐字
透传 / 链式 surface replace(压缩后再编辑)/ turn context 落用户消息并回放进历史。
另有 3 处 A 线读点同步迁移:`flushPendingExecutionUsage`、`compact`/`failedCompact`
的 `session.messages.findIndex` 与摘要写入(改走 `patchSession`)、§13.10 M3 用例
的 `scenario.a.messages[4].timestamp`(getter 未变,零改动)。该文件 86 tests 全绿。

*两条纪律已落进文件头注释*:① 期望产物按引擎写法逐格拼、**绝不抄投影输出当字面量**
(否则退化成 B7 点名的恒真等式),派生仍由 `getStepType` / `detectSkillUsage` /
`createCoreToolInputStartArtifacts` / `finalizeLingeringAgentLoopToolWork` /
`buildContextCompactContent` 现算;② `truncateFrom{inclusive:false}` 的 timestamp
覆盖与 truncate 的 usage 扣减由 `ExpectedLine.truncateFrom` **显式**表达 ——
扣减之后照旧交给 `computeSessionTimelineMetadataRepair` 决定 `summary`/`contextSize`
存废(`summary` 进 `sessionMeta`,是模型历史断言的入参,漏了链式 replace 那条当场分岔)。

*删除清单*:core `applySessionCommand` 的 5 条端口专用分支 +
`SessionCommandMeta.updatedStepIds` + `CoreToolCallState` import,`SessionCommand`
联合 12 → **7**;`OnethingSessionMessageRuntime` 的 **15 个零调用端口口**
(content/reasoning/streaming/usage/toolCalls/contentParts/addContentPart/
thinkingTime/skill/error/turnContext/addStep/updateStep/updateSteps/
stepsUsageByTurn);`core/session/__tests__/commands.test.ts` 的 5 组分支单测;
`session-message-runtime.test.ts` 的 `owns content, tool, and step mutations` 一只。

*一处方案外的牵连,已就地解决(不是停诊项)*:`step-identity-contract.test.ts`
(§17.4 常驻门"step 身份合同")是这 5 条分支的**第二个**测试侧消费者,拿
`applySessionCommand({type:'patchStep'})` 当"引擎发一次 patchStep"的落法。它证的
从来不是 reducer,而是"引擎手上的 step id ≡ 投影物化出来的那一条",所以改由本地
`patchStepById` 按 id 寻址 —— 认领规则、命中即 COW、落空即原样返回,与被删分支逐字
同义,正反两只用例(命中 3/3、旧 uuid 全部静默落空)判据一字未动。

*端口签名冻结(§17.3 纪律 13)未被破*:那条冻的是**引擎侧** `backend/stores/sessions.ts`
那 15 个同名口的形状,因为四条 A 类事实断言(usage/skillUsed/errorDetails/turnContext)
与 `assertContentPartIsCarriable` 守卫挂在**那里**。本批删的是 runtime 那一层的同名
方法,其上一条断言都没有;引擎侧签名与五处断言/守卫一个字未动。

*门读数*:typecheck 0(node+web);core+backend/session+runtime/sessions 定向
**1362 绿 / 133 文件**;`sessions:shadow-battery` **GATE GREEN**(runs 321、
refoldChecks 224 > 0、refoldMismatch 0、mismatches 0、portMismatches 0
[端口事实比过 265 次]、appendFailures 0、shadow.jsonl 0 行);字节回归
`session-chunk-bytes` 1 绿 + `session-chunk-codec` 5 绿 + `ephemeral-policy` 8 绿;
四棘轮 boundary 0 / session 0 / log 4 known-none-new / transport 42 常量·四壳 2392
均未动。`sessions:verify` 9 条 FAIL —— **与 HEAD(8c4f54bd)干净工作树逐条同集**
(另建 worktree 实跑对照),本批零新增;验收词条"只剩 room-1"是旧读数,真机 store
上另外 8 条是存量抄本对账的既有失配,归 §17.5 存量账,不属本批。真机 `~/.onething`
只读。

**#9 U1/U2 + B 期(下一场战役,细案另出)**
- 唯一结构正确路径,无 B 案:renderer 直接 import core 投影 reducer(U-b 已拍)、
  消费事件词汇(U-a 已拍)、删自建拼装、ui-shadow 门;B 期同窗换管。它对两轴的
  意义:渲染层从"第三份手写推导"变成同一次折叠的第三个出口——本宪法覆盖到屏幕。
  细案在开工前出,含消息列表虚拟化与等待指示(用户已并入)。

**建议施工序**(全部按推荐案;08-28 随 #8 勘察修订):#8a(小,A 线改说事件+删
5 条死分支;已落地 502c0909)→ #3+#8b(节点自持物化 + 会话账折叠化,一个方案两个
层级;落地后 reducer 7 条活分支/三口/pin 一起真删)→ #6(单门,含 #7 产地两条)
→ #2+#1(主人印章+清夹具)→ #9(U/B 战役)→ #5(数字到阈值再动)。

#### 17.7.1 #3+#8b 合并细案(2026-08-28,Fable;定律①的同一件事,两个层级)

一句话:**折叠产物是唯一状态**这条定律,今天在消息级靠外挂簿记撑着、在会话级还
没兑现。本案两个层级一起兑现,兑现完 reducer 的最后一个身份消失,连同三口与 pin
一起真删——#8b 的"搬去哪儿"答案就是:**搬进折叠**。

**层级一(#3):物化 memo 成为 ProjectionNode 的自持属性**

- 现状:`backend/session/materialized-messages.ts` 用进程级失效号 + 模块内 Map 当
  缓存账本,任何一条 delta 换号 → 整列表重物化(258 条消息/50MB 的会话一次 46ms,
  `getSession` ~30 次/run)。缓存的"谁作废"与领域对象分离,是旁挂簿记。
- 改法:物化成品(深拷+补水后的 `ChatMessage`)变成节点的惰性 memo。**失效机制
  由施工前勘察定夺,两条路二选一**:
  - 若投影 reducer 对节点是 COW(触碰即新建节点对象)——memo 天然随旧对象报废,
    **零失效代码**,列表组装 = 对可见节点 map 一次,命中(对象同一性)即取 memo;
  - 若 reducer 就地改节点——在唯一改节点的那几个 mutation helper 里清 memo,
    失效逻辑住在唯一会改节点的地方,不可能漏。
- 纪律不变:memo 存的是**深拷贝后补过水**的成品(§15.13 判例、§17.3 纪律 4/5),
  交出去的引用不许被就地改(freeze 闸照旧);`refreshMessagesFromProjection` 仍是
  唯一换装点,只是从"整列表重算"退化成"map 节点取 memo"。进程级失效号与模块 Map
  整体删除。
- 面向对象审核:通过——状态(节点)与其呈现(物化成品)内聚于同一对象,任何新
  视图(UI 折叠 / trace / history)白捡同一份节点级 memo。

**层级二(#8b):会话账也是折叠产物**

reducer 剩余 7 条分支的全部产出是**会话级派生**,逐格给出折叠产地:

| 会话账格 | 今天(reducer) | 折叠产地 |
|---|---|---|
| `updatedAt` | 每条消息命令盖 `now` | 账目事件的 `time` 折叠(只有对应今天 7 条命令的事件才盖——`tool/audit` 等旁录不盖,行为不变) |
| `lastProvider` / `lastModel` | append assistant 时盖 | `run/start`/`request/*` 已带的 provider/model 字段 |
| usage 总账三件 | append 时累加、truncate 时按 `subtractedUsageFromProjection` 扣 | `request/response.usage` 累加;truncate 事件**已携带** `subtractedUsage`(c4-b 钥匙③),折叠侧直接消费 |
| `contextSize`/`lastInputTokens`/`summary` 失效 | `computeSessionTimelineMetadataRepair` | 同一函数,调用点搬进会话账折叠(truncation 类事件触发) |
| lazy 落盘档 | `result.lazy` | **不是状态,是写门的事**:事件种类 → 写档的映射表放在写入口(流式 delta=lazy,结构变更=即时),`session-repository.ts:238` 改读它 |
| `meta.message`(B-窄版回读) | reducer 回传 | F1 同步折叠后从物化节点取(B-窄版语义不变:返回的仍是"入库成品") |

- 会话账折叠器落在 core(纯函数,吃事件流出会话账块),与消息投影同源同刷新点;
  换装点扩成"消息 + 会话账"一次换。refold 门**扩栏**:文件字节重折的会话账 ≡ 活
  会话账(新增比对格)。
- 三口(`get/has/findMessageFromStore`)的调用点(写门里的"写不写事件"判据)改为
  直接问投影节点表;`hasSessionInStore` 永久例外照旧(纪律 7)。
- `adoptSessionCommandResult` / `withSessionCommandPin` 随 reducer 一起删(pin 防
  的"reducer 二次应用"不再存在)。
- 消费者(index meta / plugins-sessions 上下文占比 / radio DJ 闸 / evals / tasks
  dispatch)读的字段名不变,零改动。

**施工分批与迁移护栏**(影子先行,沿用本战役屡次抓真雷的打法):

- **批 1(#3)**:节点 memo + 删外挂簿记。门:battery 同基线全绿 + refold 0 失配 +
  巨会话物化耗时采样(46ms → 应降一个量级)。
- **批 2(#8b-i,影子)**:会话账折叠器上线**只比不接**——reducer 照跑,每次写后
  比对两边会话账逐格相等(battery + 真机影子线),红了先修折叠器。
- **批 3(#8b-ii,切换)**:写门断开 reducer(7 条分支/`adoptSessionCommandResult`/
  pin/三口真删,no-op 判据改问投影),会话账改读折叠块,影子比对退役。门:全套
  (typecheck/三包/battery/refold 扩栏/四棘轮/字节回归/verify 零新增),真机只读。

每批遇到与本细案冲突的事实(如 reducer 之外还有会话账写者、COW 判断两可)一律
停在诊断,不硬切。

**批 1(#3)落地记录(2026-08-28,opus 施工,未提交;3 文件改 + 1 个新门,+152 −101)**

*勘察三问的答案*:

1. **reducer 对节点是就地改,不是 COW** —— 判据不是猜的,是文件头那条写死的
   「所有权约定」:归约器返回**同一个** state 对象(`return state`),内部的
   Map / 数组 / 节点是**线性持有**的(每条事件复制全部节点会让活跃会话的增量
   维护退化成 O(n²),而它跑在主线程上)。所以细案里"零失效代码"那一支不成立,
   走的是另一支:**失效住进唯一会改节点的地方**。落法是 `forWrite(node)` ——
   归约器里每一条要往节点(或它挂着的 part / tool)上写的分支都从它手里取节点,
   号顺手前进,一共 18 处;纯读的取法(`partTurnIndex` / `findToolInputPartEnd` /
   物化那一半)不经它。**`hidden` 不进 rev**:它不是产物的一部分,是"这条节点
   进不进列表"的判据,组装时每次现问(删除 / 清空 / 截断三处因此不换号)。
   一条同样重要的结构事实:**物化只吃节点**(`materializeNode(node, options)`
   一格 state 都不读)—— 没有这一条,按节点缓存根本不成立。

2. **补水链的落点**:成品 = `materializeNode` → `structuredClone` → 
   `rehydrateSessionFromStorage`,三步全在**memo 生成的那一刻、每节点一次**。
   §15.13 那条判例在按节点缓存之后更要命:物化对 `message/imported` 是浅展开
   (`steps` 与其中的 step 对象是活投影节点本体),补水又是就地写者,所以顺序
   钉死为"先深拷再补水";而若把补水挪到**取** memo 的时候,它就会写在缓存的成品
   上,下一次取到的是被写过的那一份 —— 缓存当场从加速器变成污染源。纪律已落进
   `materialized-messages.ts` 文件头。顺带核实 `rehydrateSessionFromStorage` 是
   **逐条消息独立**的(每条自建 `toolCallsById`),所以"整份补水"与"每条各补一次"
   逐字等价。另:c4-d 那段代码里 `seq` 的"加了再摘"是读路自己的往返
   (`eventsListMessages` 补 `seq: eventSeq`,物化视图再摘掉),投影本身不产
   `seq`,所以新路两步都省掉,交出去的键与键序不变。

3. **失效号与那张 Map 的读者**:`liveSessionProjectionVersion` 全仓只有
   `materialized-messages.ts` 一个消费者(含测试零命中),模块内那张
   `Map<sessionId, {version, messages}>` 是私有的,而它的清理口
   `resetMaterializedSessionMessages` **零调用**(死导出)。三样一起删干净,
   `LiveProjection.version` / 进程级计数器 / 6 处换号点随之消失。

*取舍(节点自持 vs WeakMap)*:**号在节点上,成品在 WeakMap 里**。`BaseNode.rev`
是领域事实("我变过没有"),归 core;成品是**这条读路**独有的(深拷 + 补过水的
`ChatMessage`),而 core 的 `materializeNode` 的产物取决于**物化选项**——refold
那道门与模型历史各自带着自己的选项走同一口,把成品塞进节点会让三个消费者抢同一格。
所以成品按 `WeakMap<ProjectionNode, {rev, message}>` 存在装配层:键是节点对象,
节点没了成品跟着没,没有"谁去清"这个问题(也就没有清漏的可能),core 也不必认识
产品层类型。另有一张 `WeakMap<SessionProjectionState, ChatMessage[]>` **不是缓存
是实例稳定器**:换装点那句 `if (next === session.messages) return session` 从前
靠整份缓存成立,按节点组装之后每次都是新数组;逐条同一就交回上一次那个数组,
读侧看到的与 c4-d 逐字相同。两张表都随领域对象生灭,外挂簿记为零。

*新门*:`backend/session/__tests__/materialized-memo.test.ts` —— 这套东西的唯一
失败模式是**漏一处 rev**(改了节点没换号,读侧悄无声息地交出上一刻那一份),
所以逐条事件地问"memo 组装 ≡ 完全不用 memo 现算",脚本走过 30 条事件覆盖每一种
会写节点的类型;第二只用例问**粒度**(改第二条 run 时第一条消息交出来的必须还是
同一个对象),第三只问数组实例稳定。**负对照实跑**:分别摘掉 `run` 侧与 `message`
侧的 `forWrite` 各跑一次,两次都当场红。

*门读数*:typecheck 0(node+web);三包全量 **7838 绿 / 777 文件**(= 基线 7835 +
本批新增 3;三轮里两轮全绿,另一轮 2 只本机高负载抖动
[`server/http` + `stores/sessions-delete-cascade`],单跑 32/32 绿,与本批无关);
`sessions:shadow-battery` **GATE GREEN**(runs 321、refoldChecks 222 > 0、
refoldMismatch 0、mismatches 0、portMismatches 0、appendFailures 0、
shadow.jsonl 0 行);四棘轮 boundary 0 / session 0 / log 4 known-none-new /
transport 42 常量·四壳 2392 均未动;字节回归 `session-chunk-bytes` 1 +
`session-chunk-codec` 5 + `ephemeral-policy` 8 全绿;`sessions:verify` 9 条 FAIL,
与 HEAD(502c0909)**逐条同集**(同机 stash 对照实跑,零新增)。真机
`~/.onething` 只读 —— 采样用的两条会话是**拷到临时 store** 上跑的。

*性能采样*(真机账本拷贝,中位数 / 11 次,预热后):

| 会话 | 账本 | 可见消息 | 改前:整份重算 | 改后:一条 delta | 改后:最贵那条节点 | 稳态(无变化) |
|---|---|---|---|---|---|---|
| `08f1fe09` | 48.1MB / 258 事件 | 258 | **49.5ms** | **0.026ms** | 5.7ms | 0.006ms |
| `46dcec05` | 19.7MB / 9272 事件 | 182 | **96.5ms** | **0.015ms** | 5.9ms | 0.009ms |

"改前"是 c4-d 主体的逐字复刻(整份物化 + 整份深拷 + 整份补水),"改后"是真的
`materializeSessionMessages`。典型情形(一条 delta 落在活 run 上)降三个量级;
即便撞上账本里最贵的那条节点,单条重算也在 6ms 以内 —— §16.27 六那条留账
("方向是只重算改动过的那几条")就此结清。折一遍整份文件仍要 360ms / 215ms,
那是**建表**一次性的账,不在本批范围。

*未做 / 留给后批*:`getLiveSessionProjection` 之外的读口
(`eventsGetMessage` / `eventsGetMessageIndex` / `eventsLastMessageOfRole` /
`eventsPageMessages` / `eventsListUserMarkers`)仍是每次现物化整会话,**没有**
接这份 memo —— 它们的产物不带补水(形状不同),要共享得先裁定"读口的产物统一
成哪一种"。本批不动,行为与 HEAD 逐字相同。

**批 2(#8b-i,影子)勘察结论:停在诊断 —— 会话账有四格在事件流上没有产地
(2026-08-28,opus 勘察,零生产代码改动)**

一句话:细案的「会话账逐格产地表」把 reducer 的**盖章面**记宽了一格、记窄了两格,
而且把 usage 累加的产地记在了 reducer 身上。逐条实测之后,`updatedAt` 这一格在
**四种情形**上从事件流里推不出来 —— 其中两种是"reducer 盖了章但一条事件都没写",
一种是"两条盖章面不同的命令写出同一种事件、事件上没有判据",一种是"事件有、但
它同时也在 reducer 不盖章的路上出现"。按施工令「一格都别硬折」,本批不落一行
生产代码。

*一、reducer 今天的盖章面(逐分支实测,`packages/core/session/commands.ts`)*

`updatedAt` 的赋值点全仓只有 5 处:282(upsert 命中替换)、320(delete)、
336(replaceAll)、363(`applyAppend`)、414(`applyTruncate`)。于是:

| 命令 | 盖 `updatedAt` | 其余会话级派生 |
|---|---|---|
| `appendMessage`(:271→`applyAppend`) | **是** | assistant 且带 provider/model → `lastProvider`/`lastModel`(:364-366) |
| `upsertMessage`(:274) | **是**(两支都盖) | 新增支同 append;命中支只盖 `updatedAt` |
| `patchMessage`(:292) | **否** | 无(`indexMetaChanged: false`) |
| `truncateFrom`(:307→`applyTruncate`) | **是** | usage 三件**扣减**(:415-419)+ `computeSessionTimelineMetadataRepair`(:421,`recomputeContextSize: true`) |
| `deleteMessage`(:310) | **是** | 无 |
| `replaceAll`(:332) | **是**(三种 reason 都盖) | 无 |
| `repairOnLoad`(:346) | **否** | `computeSessionTimelineMetadataRepair` 的 patch/deletes |

另核实:`session.updatedAt` 在 `backend/stores/sessions.ts` 与
`onething-runtime/src/sessions/session-repository.ts` 上**一个赋值点都没有** ——
桌面侧"reducer 是唯一写者"这句话成立(server 那份 store 是另一只仓库,
`server/runtime.ts:1869/2416/2536` 自己写 `updatedAt`)。

*二、7 条命令的事件产出(`backend/session/command-events.ts`)*

| 命令 | 事件 |
|---|---|
| `appendMessage` | user → `user/message`;**assistant 且 `isStreaming` → 一条都不写**(:126,§9.3 判例);其余 → `system/message` |
| `upsertMessage` | 不在 → 同 append(:214);**在 → `message/patched{fullBody}`**(:217) |
| `patchMessage` | `message/patched` 与/或 `context/turn-update`;`kept` 空则一条不写(:190) |
| `truncateFrom` | inclusive → `message/deleted`;否则 → `user/message-edited` |
| `deleteMessage` | `message/deleted` |
| `replaceAll` | `clear`/`replaced` → `session/cleared`(+ N 条 `message/imported`);**`normalize` → 一条都不写**(:296,判例) |
| `repairOnLoad` | **零事件**(写门 :486-488 根本不叫事件面) |

*三、四处对不上(每一处都是"折叠推不出 reducer 的那一格")*

1. **流式 assistant 占位:reducer 盖章、账本零事件。** 这是最热的一条路(每个
   助手回合一次)。它在账本上的那一格是 `run/start`,但那条事件由
   `wiring/engine/stream/stream-executor.ts:248 openAssistantRun` 写,不是写门 ——
   拿它当 `updatedAt`/`lastProvider`/`lastModel` 的产地有**两个**问题:
   (a) 时刻是**另一次** `Date.now()`(见第四节);
   (b) **它比盖章面宽** —— 绕过创建点的那条路(确认后恢复 / 单测直调)在
   `executeMessageStream` 里以 `started:true` 开张 `run/start`,而那条路上**没有**
   `addMessage`,reducer 一格都没盖。拿 `run/start` 折 `updatedAt` = 在恢复时凭空
   把会话顶到列表最前面。
2. **`message/patched` 一格两义。** `upsertMessage` 命中支盖 `updatedAt`、
   `patchMessage` 不盖,两者写出的是**同一种事件**,数据形状是同一个
   `{messageId, patch}`(upsert 只是多带正文三件套)。事件上没有任何判据能分开
   它们 —— 靠"patch 里有没有 `role`"这类形状猜测正是纪律 8 禁的"记我推出来的
   结论"。流量:`sessionCommands.upsertMessage` 桌面侧**零调用点**,唯一生产
   调用者是 server(`server/runtime.ts:2357 upsertServerMessage`),而
   `sessions:shadow-battery` 正是在 server 上跑,所以这条歧义在门上是活的。
3. **`replaceAll{normalize}`:reducer 盖章、判例明写不产事件。** 今天生产零调用
   (`replaceAll` 的生产调用只有 `wiring/collab/room-config.ts:150/160` 的
   `clear` 与 server 的 `replaced`),所以没有流量,但它是盖章面上折叠表达不了的
   一格,切换时必须先有裁定。
4. **`repairOnLoad`:细案把它算成"写路上的活分支",实况不是。**
   `sessionCommands.repairOnLoad` **生产零调用点**;这条分支在生产上是被
   `sanitizeLoadedSession` / `sanitizeSessionOnStartup`(`core/session/commands.ts:494/501`)
   直接调到的 —— 冷加载路径,**整条绕开命令面与事件面**,却真的会写
   `contextSize`/`lastInputTokens` 并删 `summary` 三件。它不盖 `updatedAt`,所以
   不影响排序那一格,但"会话账搬进折叠"要面对它:折叠侧看不到这次修复。

*四、时钟同源勘察结论:硬前提今天不成立,而且不止差一次读表*

- 事件的 `time` 在 `backend/session/event-log.ts:476` 由 `Date.now()` 现读,
  append 口**没有**注入时刻的形参。
- reducer 的 `now` 由 `OnethingSessionMessageRuntime` 在构造命令时现读
  (`session-message-runtime.ts:215/224/272/384/410/428/438`,`this.now = Date.now`)。
- 执行序是「写门先 append 事件(读表 T1)→ 端口再构造命令(读表 T2)」,
  T2 ≥ T1,同毫秒是常态、跨毫秒是偶发。
- **唯一已经同源的那一处不是这件事**:`truncateFrom` 的 `at`(`commands.ts:394`)
  同时喂给事件数据里被改写消息的 `timestamp` 与 reducer 的 `command.now`
  (§16.8);它与事件记录自己的 `time` 仍是两次读表。
- 所以"命令面取一次、既递 reducer 又盖事件"要落地,得给
  `appendSurfaceAwareEvent` / `appendSessionLogEvent` 加一格可选 `time` 并从写门
  贯下去。**这一步本身可做且行为等价**,但它只覆盖写门自己产的事件 ——
  第三节第 1 条那条 `run/start` 在写门之外,改不到。单独落它属于夹带(纪律 15),
  故本批未动。

*五、细案表另外三格与实况的出入(不阻塞,但记账)*

- **usage 总账的累加产地不是 reducer,也不在命令面。** reducer 只**扣**
  (`applyTruncate`);累加住在
  `wiring/engine/stream/agent-loop-executor.ts:1026 updateSessionUsage` →
  `backend/session/usage.ts:13` → `core/session/store-helpers.ts:836
  applySessionTokenUsage`,就地改 session,**同时**按 `lastTurnUsage` 写
  `contextSize`/`lastInputTokens`。折叠版若改吃 `request/response.usage` 累加,
  那是**另一套算法**与一个活着的非命令写者并存,不是"同一本账"。
- **truncate 事件并**不**携带 `subtractedUsage`。** c4-b 钥匙③递的是
  命令面 → 端口 → reducer 那条线(`commands.ts:401`),事件数据里全仓无此字段
  (`grep subtractedUsage` 零命中于 `events/types.ts`)。折叠侧要自己按
  `subtractedUsageFromProjection` 同一把判定点现算 —— **可行**,只是表上那句
  "已携带"是错的。
- **`contextSize`/`lastInputTokens` 有三个写者**:上面那条 `applySessionTokenUsage`、
  `session-repository.ts:501 updateSessionContextSize`(由
  `events/event-only-emitter.ts:73` 在 provider-finish 时叫)、以及 reducer 的
  truncate 修复。"搬进折叠"要连前两个一起翻,否则折叠块与就地写者互相盖。

*六、要拍板的三件事(#8b 能不能往下走全看它们)*

1. **`updatedAt` 的产地**:是(a)给写门产的每条账目事件补一格显式 `time` 并
   让 `run/start` 也走写门(= 把流式占位的 `updatedAt` 产地补上),还是
   (b)承认 `updatedAt` 是**写门的事**(与 lazy 档同类,不是折叠产物)、
   #8b 只搬 usage/timeline 那几格。(b)最省,但 §17.5 #2 的"reducer 退役"
   就此只完成一半。
2. **`message/patched` 要不要分家**:upsert 命中支改写一种自己的事件
   (如 `message/replaced`),还是承认 upsert 的 `updatedAt` 盖章是历史包袱、
   与 `patchMessage` 拉平(**这是可感知的行为变化,必须用户拍**)。
3. **`normalize` 与 `repairOnLoad` 两条无事件路**:补产地,还是明确记成
   "不进折叠账"的具名例外。

*勘察阶段交付*:零生产代码改动。三件裁定见上一节;施工照裁定继续,记录见下。

**批 2(#8b-i,影子)落地记录(2026-08-28,opus 施工,未提交;10 文件改 + 2 新件 +
1 新门)**

*一、选型与理由(照勘察定案,裁定 4 认可)*

会话账是**独立的 `SessionAccountState`**(`packages/core/session/account.ts`),
值语义、每条事件返回新对象;**不挂进** `projection/reducer.ts` 的 state。两条理由
写在文件头:①会话账里唯一要看整份消息列表的那一格(截断触发的
`computeSessionTimelineMetadataRepair`)若住进消息归约器,就等于让**每一条**事件
都背上一次可能的整会话物化,而它一个会话一生只跑几次;②消息归约器是**移动语义 +
线性持有**(节点就地改、`forWrite` 换 rev),会话账是值语义,两种所有权约定同住一个
state 上迟早有人拿旧引用读新账。

刷新点仍然同源:装配层把它挂在**同一个** F1 写入口观察者上
(`projection-cache.ts` 的 `foldRecord` —— 消息投影与会话账同一行推进、同一次重建),
截断类事件才惰性问一次"之后还剩哪些消息"(`accountFoldContext`)。

*二、时钟同源(裁定 1 第一件)*

勘察结论(上一节第四节)是"今天不同源,而且不止差一次读表"。落法:

- `event-log.ts` 的 append 口加可选 `time`,`appendSurfaceAwareEvent` 透传;
- 写门 `backend/session/commands.ts` **一条命令取一次刻**,既盖账目事件、又经
  `options.now` 递给归约器。六个会盖 `updatedAt` 的端口口
  (`addMessage`/`upsertMessage`/`deleteMessage`/`deleteMessageWhere`/
  `deleteMessageAndTruncate`/`replaceAllMessages`)各加一格 `options.now`,
  缺省仍自取(老调用点与单测一字未动);`patchMessageFields` 不收 —— 那条分支不盖章。
- **流式助手占位那一档**(命令面唯一不写事件的一档)的刻在**创建点**就取过一次:
  它同时是消息的 `timestamp` 与 `run/start.timestamp`(`buildAssistantRunInput`)。
  写门对这一档认那个数(`at = message.timestamp`),折叠对 `run/start` 也认
  `data.timestamp` —— 三处于是同一个刻,而不是三次读表。

*三、两格新事实(裁定 1 第二件 / 裁定 2)*

- `SessionRunStartEventData.createdAssistantMessage?: boolean` —— 只有
  `openAssistantRun` 与 **steer 换锚点**(`rotateAssistantWriterIdentity`)带它;
  绕过创建点的 `started:true` 开张不带。折叠只对带它的 `run/start` 盖
  `updatedAt`/`lastProvider`/`lastModel`。
- `SessionMessagePatchedEventData.via?: 'upsert'` —— `fullBody` 这一档就是 upsert
  的整条替换。两格都 append-only、可选,旧账缺席 = 不盖(纪律 9)。

*四、对拍覆盖面(裁定 4 口径:比容器上此刻的值,不是 reducer 算的值)*

两类断言,合起来盖住老 reducer 在会话级的全部产出:

| 断言 | 挂点 | 比什么 |
|---|---|---|
| **绝对值** | 6 条会盖章的命令写路收尾(微任务,每会话每次去重一条) | `updatedAt` / `lastProvider` / `lastModel` 折叠值 vs 容器此刻的值 |
| **增量** | `truncateFrom` 收尾(同步) | usage 三件的扣减 + `contextSize`/`lastInputTokens` 改写 + summary 是否被清 —— 折叠的 `lastTruncation` vs 容器的前后差 |

增量而非绝对值的理由(勘察第五节):usage / `contextSize` 的**正向**产地不在事件流上
(`applySessionTokenUsage` 等三个写者),拿绝对值比就是在比两套累加算法,而批 3 要
接管的恰恰只有这个增量。折叠侧那几格的绝对值照旧在折,只是影子期不拿它去对无关
写者的账。

**排在微任务里**是必须的:流式占位那一路的账目事件 `run/start` 由
`openAssistantRun` 在 `store.addMessage` **返回之后**的下一行落账(同一同步段),
同步段里比就是在比一份"事件还没写"的折叠 —— 那是采样时机,不是不等。

两条**具名例外**(裁定 3,各带指针注释):`replaceAll{normalize}`(盖章却判例明写
不产事件,生产零调用点)与 `repairOnLoad`(根本不在命令写路上)。

*五、门当场抓到的三条真雷(全部**修产地不修门**)*

首跑 **40 条失配 / 666 次比对**,三类,逐条查到根因:

1. **steer 换锚点漏了那一格事实(16 条)**。`rotateAssistantWriterIdentity` 里
   `store.addMessage` 与 `rotateSessionRun` 是**同一个同步段**——与
   `openAssistantRun` 逐字同一件事,可它的 `run/start` 没带
   `createdAssistantMessage`,于是每一次 steering 会话账都少盖一次章(实测
   `updatedAt` 容器侧领先 89ms / 1162ms 两种形态)。补上那一格。
2. **模型选择器的写没有产地(16 条)**。`stores/sessions.ts` 的
   `updateSessionModel` 绕开命令面**且一条事件都不写** —— 与 `updateSessionAgent`
   同一个病,而 §13.10 M7 当年只补了 agent 那一格。于是一条"只挑了模型还没开跑"
   的会话上,容器有 `lastProvider`/`lastModel` 而账本没有(真机 `dall-e-3` /
   `battery-cost-model` 两个场景稳定复现)。按 agent 那条路数补一条
   `session/model-changed`,用的是**同一份**事件构造;用户可感知行为一格未变,
   只多了一行账。折叠侧相应认这一格(裁定 4 的口径:无论谁写)。
3. **观测者改变了被观测的事(8 条,施工自伤)**。截断的增量对拍要在归约器两侧
   各取一次快照,而 `ports.getSession` 会顺手把 store 的消息数组**换装到此刻**的
   折叠产物 —— 快照排在事件落账之后,归约器(定格段里)看到的就是一份已经删干净
   的数组,`findIndex === -1` 当场 `changed:false`,`updatedAt`/用量结算/索引计数
   整批不发生(纪律 3 说的正是这一幕,而定格只挡得住定格段**里面**的换装)。
   快照移到事件之前。判例已落进 `commands.ts` 的注释:**影子的读不许穿过定格窗口**。

三条修完,**8 → 0**。

*六、门读数*

typecheck 0(node + web);`sessions:shadow-battery` **GATE GREEN** —— runs 321、
refoldChecks 224 > 0、refoldMismatches 0、mismatches 0、portMismatches 0
(比过 265 次)、**accountMismatches 0(比过 682 次)**、appendFailures 0、
shadow.jsonl 0 行;四棘轮 boundary 0 / session 0 / log 4 known-none-new /
transport 42 常量 · 四壳 2392 均未动;字节回归 `session-chunk-bytes` +
`session-chunk-codec` 5 + `ephemeral-policy` 8 + S0 合同 86 + step 身份 2 全绿;
三包全量见下;`sessions:verify` 与 HEAD 逐条同集零新增。真机 `~/.onething`
**只读**(battery 全程在临时 store 上)。

*七、留给批 3 的三件*

1. `replaceAll{normalize}` 与 `repairOnLoad` 两条具名例外的终局(裁定 3 已定方向);
2. usage / `contextSize` 的**正向**写者(`applySessionTokenUsage` /
   `updateSessionContextSize` / server 的 `applyServerSessionUsage`)还没有事件产地
   —— 批 3 要么给它们补产地、要么明确它们留在容器上由折叠账**不接管**;
3. 影子对拍本身随切换退役(`account-shadow.ts` 整件删,`accountChecks` /
   `accountMismatches` 两个计数留成读老账的字段)。

*七、裁定(2026-08-28,Fable;裁定原则=零可感知行为变化——凡真正改行为的选项
一律不选、保旧行为,故三件均可在"按序开工"授权内就地定,不须用户改判;若用户
另有偏好,推翻本节任何一条都只影响批 2/3 的实现,不影响已落库的批 1)*

1. **`updatedAt` 是折叠产物,走(a)改良版**。理由:它是"这间会话最后一次变账
   是什么时候",本质是账目事件时间的折叠——判给写门(b 案)等于承认有一格状态
   永远折不出来,§17.5 #2 只退役一半,与定律①相悖。落法三件:
   - **时钟同源**:`event-log.ts` 的 append 口加可选 `time` 形参;写门取一次时刻,
     既盖事件又递 reducer(影子期两边同值;切换后事件是唯一来源)。行为等价
     (消掉的只是同一毫秒内两读 `Date.now()` 的差)。
   - **`run/start` 补一格事实**:`openAssistantRun` 的同步段里 `addMessage` 与
     `run/start` 本就同刻落账(c4-d),让 `run/start` 带上"本次开张**创建了**
     占位消息"的显式字段(写者亲知的事实,§13.8 合规;确认后恢复那条
     `started:true` 的 `run/start` 不带它)。折叠只对带此字段的 `run/start` 盖
     `updatedAt`/`lastProvider`/`lastModel`——**盖章面与今天 reducer 逐字相同**。
     不走"折叠时看节点存不存在"的推断路:显式事实优于推断(§13.8 的取向)。
   - 该字段 append-only、可选,旧账本零迁移(缺席=不盖,而旧账本里对应时段的
     盖章早已物化在 meta.json,冷账不受影响)。
2. **`message/patched` 补事实、不拉平**。"拉平盖章"是可感知行为变化,不选。
   `message/patched` 加可选 `via: 'upsert'`(命令面亲知的调用类别,是事实;
   "盖不盖 `updatedAt`"这条**策略**住在折叠器一处)。不另起 `message/replaced`
   事件种:形状与 patched 完全同构,分种只多一个词汇分支。append-only,旧账
   缺席=按 `patchMessage` 待遇=不盖,与历史行为一致(旧账里 server upsert 的
   盖章同上,已物化不回溯)。
3. **`normalize` 与 `repairOnLoad`:批 2 记具名例外,终局方向已定不硬切**。
   - `replaceAll{normalize}`:生产零流量,影子期**排除在对拍外**(具名例外+指针);
     批 3 勘察它是补产地还是随死码删(倾向后者——零流量的分支不值得一个事件种,
     但删除要按 #8a 的口径先证零消费)。
   - `repairOnLoad`:它是**读侧修复**(冷加载对遗留/损坏状态的确定性归一),
     终局归宿是折叠/补水出口(修复=可再生派生,不该以存储突变的形态存在)——
     与 `computeSessionRepairOnLoad` 已在读路的既有形态同向。批 2 排除对拍;
     批 3 勘察其产出(`contextSize`/`lastInputTokens`/`summary` 三件)的消费面
     后把修复搬到读路出口,`sanitizeSessionOnStartup` 直调 reducer 那条旁路
     随 reducer 一起退役。
4. **细案表三处更正照单全收**(usage 累加产地在 `applySessionTokenUsage` 不在
   reducer;truncate 事件不携带 `subtractedUsage`,折叠侧按同一把判定点自算;
   `contextSize` 三写者)。**影子对拍的口径随之修正**:账折叠器对拍的对象是
   "会话容器上这些字段此刻的值"(无论谁写的),不是"reducer 算的值"——三写者
   互相盖的时序如在影子里现形为失配,那是真病灶,修产地不修门(纪律 11)。
   选型照批 2 勘察定案:独立 `SessionAccountState` 增量折叠,truncate 类事件
   向投影要一次消息列表,不挂进消息 reducer。

**批 3(#8b-ii,切换)落地记录(2026-08-28,opus 施工,未提交;20 文件改 + 3 件整删)**

*一、切换选型与理由*

**会话账落在写门的命令收尾处**(`backend/session/commands.ts` 读
`peekSessionAccount`),不扩 `refreshMessagesFromProjection`。理由是**幂等性**:

- 身份三格(`updatedAt`/`lastProvider`/`lastModel`)是绝对值,谁写都一样;
- 但**截断效果**(用量扣减)是**增量**,在每次 `getSession` 的换装点上应用会
  一扣再扣;
- 而 usage / `contextSize` 的**正向**写者(`applySessionTokenUsage` /
  `updateSessionContextSize` / server 的 `applyServerSessionUsage`)**本批不接管**
  (裁定:保持行为逐字不变)——换装点若无条件盖会话账,等于每次读会话都把这三个
  写者的成果抹掉。

所以落点与批 2 的两类影子断言**一一对应**:命令收尾落身份三格(绝对值),
`truncateFrom` 收尾落 `lastTruncation`(增量)。批 2 的 682 次 0 失配证的正是这两笔。

折叠是否真为**这一次**截断算过,靠 `lastTruncation` 的**对象同一性**判(折叠每次
截断新建一个 effect 对象)——判据丢了就是上一次的扣减被静默再扣一遍。

**账本没启用时的取处**:`isSessionEventLogEnabled === false`(事件目录还没落盘的
那一瞬)折叠给不出答案,此时按命令**自己取的那一刻**盖 `updatedAt`。这不是第二套
算法:时钟同源(批 2 裁定 1)之后,折叠对这几条命令给出的 `updatedAt` 就是这个数。

*二、删除清单(真删,不是空转)*

| 删的东西 | 出处 |
|---|---|
| `applySessionCommand` + 7 条分支 + `SessionCommand` 联合 + `SessionCommandResult`/`Meta`/`RepairPatches` + `CoreSessionWritePlan`/`CORE_STRUCTURAL_WRITE_PLAN` + `adoptSessionCommandResult` + `resolveLazy`/`sumUsage`/COW 小工具 | `core/session/commands.ts`(507 行 → 110 行) |
| `withSessionCommandPin` / `pinDepth` | `backend/session/materialized-messages.ts` |
| `getMessageFromStore` / `hasMessageInStore` / `findMessageFromStore` | `backend/session/reads.ts`(`hasSessionInStore` 留任,纪律 7) |
| `OnethingSessionMessageRuntime` **整件**(9 个命令口 + `run`/`patchMessage`/`runDeleteMessage`/`commandMessage(Seq)`/`logSubtractedMessageUsage` + 全部 sqlite 同步 + `cancelPendingSqliteMessageSyncs`)与它的测试 | `onething-runtime/src/sessions/session-message-runtime.ts` 文件删除 |
| `getSessionMessageCommandRuntime` + `repositoryPort` + 两处构造 | `backend/stores/sessions.ts` / `backend/server/runtime.ts` |
| `SessionCommands.repairOnLoad`(命令面那层包装) | 生产零调用点,#8a 口径纯减法 |
| `account-shadow.ts`(批 2 的影子对拍)整件 | 计数字段留成读老账的字段 |
| `checkRuntimeOwnsSessionMessageRuntime`(boundary 检查) | 守的那一层不存在了;它守的那句话由 `session:check` 规则 A/B/C 用 AST 守 |

**类型词汇留任**:`CoreSessionCommandMessage` / `CoreSessionCommandStep` /
`CoreSessionCommandSession` 有真消费者(`store-helpers.ts` 与 S0 合同测试),
留的是形状不是算法。`SessionCommandWriteHint` 搬进写门(它今天是写档的入参)。

`sanitizeLoadedSession` / `sanitizeSessionOnStartup` **留任但换实现**:直调
`computeSessionRepairOnLoad`(纯派生、COW,语义一字未改),不再借道归约器。
**修复仍在原位落盘**:"不再以存储突变落盘"那一半**没有做** —— 它唯一的差别是
`meta.json` 上带不带修好的值(下次冷加载会再修一遍,幂等),属于存储可见的变化
而没有消费者要求它,按"存疑停诊"留给后批。

*三、lazy 落盘档映射表(逐字复刻归约器退役前的 `resolveLazy`)*

| 命令 | 写档 |
|---|---|
| `patchMessage` + `hint:'stream'` | **lazy**(5s) |
| `patchMessage` + `hint:'settle'` | 常规(300ms) |
| `patchMessage` 无 hint,键集合 ⊆ {content, reasoning, contentParts, thinkingTime} | **lazy** |
| `patchMessage` 无 hint,其余(含空补丁) | 常规 |
| `appendMessage` / `upsertMessage` / `truncateFrom` / `deleteMessage` / `replaceAll` | 常规 |
| 判据不成立(会话/消息不在) | **一次盘都不写** |

**写计划(`SessionWritePlan`)整体不再计算**:存储驱动自 S3w-3 批 6b 起就不读它了
(`storage-driver.ts` 的 `void plan`),归约器一死它连产地都没有 —— 与其在逐 token
的热路径上为一个没人读的字段做一次下标查找,不如不算。仓库缺省 structural,
落盘调度行为逐字不变。

*四、判据换产地 + 三处补接线(施工中门抓出来的)*

判据从 store 消息数组改问**投影**:存在性 `eventsHasMessage`(节点表 O(1),不物化),
底稿 / 谓词查 `sessionReads.getMessage` / `listMessages`。三处必须一起补:

1. **底稿不许带读路坐标**。`eventsGetMessage` 会补 `seq` / `eventSeq`(这条消息由
   哪条事件开头),而底稿是要**写回事件体**的 —— 坐标进了账本就是第二个真相,
   下一次重折还会得到不同的数。写门新增 `editBaseline` 摘掉这两格(单测钉死)。
2. **standalone server 那只仓库没接活投影**。c4-d 把消息数组的维护者交给折叠时
   只接了 app store 一只 —— 那只仓库当时还有老 reducer 在写数组,少接看不出来。
   reducer 一删就是"消息没有维护者"。按与它旁边那句 `hydrateMessagesFromProjection`
   **逐字相同的判据**(同一个 store 才接)补上 `materializeMessagesFromProjection`。
3. **假引擎(echo/test 后端)的助手消息没有产地**。它不写 `run/start` 也不写
   `assistant/chunks`,助手正文只从 `MESSAGE_UPDATED` 那一口进来,而
   `message/patched` 的正文三件套永远被丢弃(`BODY_KEYS`)—— 从前靠老 reducer
   把补丁写进内存数组才看得见。补法是让这只**测试替身**以落定形态入账:创建时
   不再标 `isStreaming`(它本来就不是存储字段,投影按 run 开合现算),更新走
   upsert 的 `fullBody` 档。真引擎那条路一格未动。

顺带一处产地补齐:standalone server 的 `createSession` 从前不写 `session/created`,
于是它的会话**没有账本**;现在与桌面 / 真 server 同一条路。

*五、`normalize` 定局:留着,不删*

`replaceAll{reason:'normalize'}` 生产零调用点(全仓 grep 只剩类型声明),账本上
照旧一条事件都不写(判例:一次"什么都没发生"不该在 surface 上变成一次全量遮蔽)。
**没有随死码删** —— 它是 `ReplaceAllPayload.reason` 的合法取值,删它要连带改三处
形状,而一个零流量的枚举值不值得一次形状变更。批 2 给它的"排除在对拍外"随影子
一起退役(影子没了)。

*六、影子退役 + refold 扩栏*

`account-shadow.ts` 整件删除;耐久判据并进 **refold**:文件字节重折的**会话账**
≡ 内存活会话账,与消息那一栏同一次采样、同一份事件。两者必须在**同一遍**里折
(`foldSessionProjectionAndAccountSliced`)—— 会话账的截断分支要问"这条事件折进去
之后还剩哪些消息",那是**当时**那一份投影,不是整份折完的最终态;分两遍折出来的
账会在每一次截断上算错,而那正是这道门要守的那一格。

`session-account.test.ts` 的确定性预检留任(它守"折叠器只读事件字段")。

*七、门读数*

typecheck 0(node + web);三包全量 **7835 绿 / 776 文件**(基线 7849 −
`session-message-runtime.test.ts` 的 2 只 − 老 reducer 那 12 只 + 新增/改写的
若干;两只文件级加载红是本机高负载抖动,单跑 4/4 绿);
`sessions:shadow-battery` **GATE GREEN** —— runs 321、refoldChecks 224 > 0
(**已含会话账栏**)、refoldMismatches 0、mismatches 0、portMismatches 0(265 次)、
appendFailures 0、shadow.jsonl 0 行;四棘轮 boundary 0(退役一条死检查)/
session 0(2212 文件 0 命中)/ log 4 known-none-new / transport 42 · 2392 未动;
字节回归 + S0 合同 86 + step 身份 2 绿;`sessions:verify` 9 条 FAIL 与 HEAD 逐条
同集零新增;真机 `~/.onething` 只读。

*八、留账*

- **usage / `contextSize` 的正向写者仍无事件产地**(`applySessionTokenUsage` /
  `updateSessionContextSize` / server `applyServerSessionUsage`)。本批**明确
  不接管**(裁定,保持行为逐字不变),折叠侧照旧折得出自己那一份但不落格 ——
  要不要给它们补产地是单独一次拍板。
- **冷加载修复仍以存储突变落盘**(见二);"搬成纯派生出口"那一半停在诊断。

#### 17.7.2 #6 单门 + #7 产地两条落地记录(2026-08-28,opus 施工,未提交)

*一、单门的形状与收编清单(#6)*

新件 `packages/backend/session/event-writer.ts` —— **全仓唯一的写入口**:

```
writeSessionEvent(sessionId, type, data, options)
  ├─ prepareSessionEventsOnce     崩溃残留在写第一个字之前收掉(§13.10 M6)
  ├─ ensureSessionSurfaceState    活 surface 立起来(首次从文件 fold 一遍)
  └─ appendSessionLogEvent        分配 seq → 编码 → **同步通知观察者** → 排队落盘
       └─ 观察者(门内实现细节):活 surface / 活投影 + 会话账
```

收编清单:

| 从前 | 现在 |
|---|---|
| `appendSurfaceAwareEvent`(带 surface 门) | **删除**;它多做的两步成了门的第 1、2 步 |
| `appendSessionLogEvent`(素门,17 个生产调用点直调) | 降为**低层落账**,只有门能调 |
| `registerSessionLogEventAppendObserver`(F1 的眼,外挂第三件) | 门的契约:`registerSessionEventObserver` 从门出口,消费者(活 surface / 投影缓存)不再去底层模块找 |
| `ensureState`(event-surface 私有) | 具名导出 `ensureSessionSurfaceState`,唯一调用者是门 |

对外签名只有一个方法 + 一个观察者注册。**新事件类型不再有选择题**:走这扇门就
自动拿到 surface / 折叠 / 落盘全套;是不是 surface 节点由**词表**
(`isSessionSurfaceNodeType`)决定,不由调用点决定。

新棘轮:`scripts/headless-boundary-check.ts` 的
`checkSessionEventSingleWriteDoor` —— **除了门与定义处,全仓(含测试)不许提
`appendSessionLogEvent`**。它看的是**剥掉注释之后**的代码(与形状类规则同一条
纪律:注释里提个名字不该打假红,假红会逼人放宽规则)。

*二、素门调用点勘察表(合并前 17 处生产调用,逐一确认 surface 待遇)*

| 事件种 | 调用点 | 是 surface 节点吗 | 合并后待遇 |
|---|---|---|---|
| `request/tools` `request/header` `request/recipe` `request/start` `request/response` `request/end` `request/error`×2 | `session-event-recorder.ts` | 否 | 门内自然分流:不落 surface 格 |
| `assistant/chunks` `assistant/part-end`×2 `assistant/first-token` | 同上 | 否 | 同上(`assistant/chunks` 仍走 `projectionPreFolded` 那条快路) |
| `tool/call` `tool/annotate` | 同上 | 否 | 同上 |
| **`tool/result`×2** | 同上 | **是** | **本案的那一格**:见第三节 |
| `skill/activated` | `events/event-only-emitter.ts` | 否 | 门内自然分流 |

**一条"为了合门给非 surface 事件强造 surface 格"都没有** —— 门不发明格,格由词表判。

*三、`tool/result` 写侧落定(§15.21 那票)与读侧零回归的证据*

先把事实说准:§15.21 写这一票时,活 surface 的推进还挂在带 surface 门自己身上,
所以素门落的 `tool/result` **完全**进不了活索引。**F1(§16.6)已经把推进挪到了
写入口的观察者上**,从那以后只要这条会话的 surface 表**已经立着**,素门落的
`tool/result` 就进得去 —— `trimForeignTrailingToolResults`(F1-a,§16.15)正是
为"`tool/result` 已经出现在 range 里"而写的。

所以本案真正补上的是**剩下那半格**:素门不做 `ensureState`,于是"表还没立起来时
落的那些 `tool/result`"仍然会漏。合并之后每一条事件都先立表,写侧活索引与读侧
`foldSurface(整份文件)` 从此**在任何时刻**看到同一串事件。

读侧零回归的证据(实跑):

- `sessions:shadow-battery` **GATE GREEN**:runs 321、refoldChecks **218**、
  refoldMismatches 0(refold 比的正是"文件字节重折 ≡ 内存活投影 + 活会话账",
  写侧活 surface 一旦多算/少算一格,遮蔽范围就会在这里现形);
- `sessions:verify` 9 条 FAIL,与 HEAD **逐条同集**(存量账本的 surface 声明区
  校验一条没有新红);
- `packages/backend/session` + `packages/core/session` 39 文件 400 只用例全绿
  (含 S0 合同的 surface 双面用例与 `write-side-visibility` 那两只)。

*四、#7 两条的定性与落法*

**(1) `argsFinalizedBy` —— 定性为采集过程的注记,进豁免表是终态(留账 #11 结清)。**
判据是 §13.8 那把尺子的另一面:它说的不是"模型/工具做了什么",是"**我们的流式层
怎么知道参数说完了**"。逐口实测消费面:全仓只有生产者
(`core/engine/stream-processor.ts` 盖章 → `event-only-emitter.ts` 顺
`TOOL_INPUT_END` 发出去),**没有任何一处拿它做判断** —— renderer 零引用、工具
执行链零引用、权限链零引用。它连"影响读侧行为"的资格都没有,补产地只会让账本
多记一句没人读的自述。`canonical.ts` 的表格行与 `canonicalToolCall` 的注释从
"留作 §10.8 公开缺口"改写为这条定性(零行为改动)。

**(2) 结算态 `plugin/status` —— 停在诊断,留账 #10 不结清。**
任务书的前提("取代事件已经落盘,只需折叠侧物化")**实测是错的**:

- 词表里有 `plugin/status`(`events/types.ts`),归约器把它列在"记录在案但不改
  投影"那一档 —— 但**全仓没有任何生产者往账本写过它**(逐口 grep:只有词表条目、
  归约分支、一条编解码单测的字面量)。
- 插件状态这一格从头到尾是**流内**的:`CorePluginStatusRegistry`
  (`core/plugins/status.ts`)把 part 推进 chunk 流,renderer 的
  `stores/helpers/content-parts.ts` 就地更新/结算那一格。它从来没有经过会话账本。

所以缺的不是"折叠少折一步",是**写侧根本没有采集点**。补它 = 新起一条
plugins → 会话账本的采集线,而且要裁定一件**用户可感知**的事:**重开会话之后
还看不看得到那条已结算的状态行**(今天看不到 —— 它随流消失)。按"行为裁定须先问"
停在诊断。`ephemeral-policy.ts` 的那条 `note` 已按实测更正(它此前记着一句错的
"已经落盘"),`content-part-guard.ts` 对已结算 `plugin-status` 判红的口径一字未动。

*五、门读数*

typecheck 0(node + web);三包全量 **7834 绿 / 775 文件**(2 只文件级红是本机
高负载抖动:`server/http` 的 watch-SSE 与 `terminal/service.smoke`,合并单跑
30/30 绿);`sessions:shadow-battery` **GATE GREEN**(runs 321、refoldChecks 218 > 0、
refoldMismatches 0、mismatches 0、portMismatches 0(265 次)、accountMismatches 0、
appendFailures 0、shadow.jsonl 0 行);四棘轮 boundary 0(**新增单门检查**)/
session 0 / log 4 known-none-new / transport 42 · 2392 未动;字节回归 + S0 合同 +
step 身份 + 账折叠预检绿(`ephemeral-policy` 8 只含 unsettled 取代者指针);
`sessions:verify` 9 条与 HEAD 逐条同集零新增;真机 `~/.onething` 只读。
