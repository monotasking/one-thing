# 会话持久化改造:JSONL 追加式存储设计方案

状态:Phase 0-2 已实施(2026-07-07)。flag `settings.storage.sessionFormat` 默认 **jsonl**(设 legacy-json 即回滚);
惰性迁移在会话冷加载时触发(暂存目录 + 写代际冲突检测 + 逐条校验 + legacy-backup);
真实数据灰度:164 会话 276MB 双向转换往返,语义 diff = 0。
偏差记录:~~`rebuild:sqlite:node` 保留(memory 系统仍用 better-sqlite3,test 脚本依赖)~~
**2026-09-03 结清**:memory 系统 2026-08-06 已整体退役,better-sqlite3 从此零消费者;
本日把依赖、`@types/better-sqlite3`、`rebuild:sqlite:node`、`migrate:sessions:sqlite`
与 dev-unified 的 ABI 标记块一并删掉,`postinstall` 只剩 `fix:node-pty-perms`、
`test` 直接 `vitest run`。下文 §"清理清单" 里那句"根 package.json 的 better-sqlite3
依赖因 memory 仍需保留"随之作废。
repository/message-runtime 的 `sqlite?` 适配器接口位与 `syncSessionToSqliteIfReady` 调用链**仍是**空挂钩
(它们只是形状,不 import 任何 sqlite 包,删除是一次跨 backend/runtime 的重构),后续单独清理。
Phase 3(steps/toolCalls 去重已由 session-dehydrate 覆盖大半;blob 外置)待实施。
日期:2026-07-07
前置阅读:`docs/design/long-session-storage-and-rendering.md`(旧 SQLite 方案,已废弃)

---

## 1. 背景与问题

### 1.1 现状

自 `16881b1d`(2026-07-04)起,聊天会话持久化只剩 JSON 文件一条路径:

- 每个会话一个整文件:`~/.onething/sessions/<sessionId>.json`,会话列表元数据在 `sessions/index.json`。
- 写路径:`OnethingSessionRepository`(`packages/onething-runtime/src/sessions/session-repository.ts`)持有 LRU(10) 内存缓存,`AsyncSaveQueue`(`packages/core/storage/async-save-queue.ts`)以 300ms 节流,把**整个会话对象** `JSON.stringify(data, null, 2)` 后 tmp+rename 原子写盘。
- 读路径:`getSessionMessagesPage` 三级降级:SQLite 分页(已断开,永远 miss)→ JSON 字节扫描分页(`packages/core/session/storage/json-message-page.ts`)→ 整文件加载。
- SQLite 会话代码(core 的 schema/mappers、runtime 的 sqlite-repository/driver、main 的空壳桩、迁移脚本)仍在仓库中,均为死代码。
- Electron 主进程与 apps/server 复用同一套 repository,均未接 SQLite 适配器。

### 1.2 实测数据(2026-07-07,开发机)

| 指标 | 值 |
|---|---|
| 会话数 | 165 |
| 会话总体积 | 303MB |
| 最大单会话文件 | 51MB(258 条消息) |
| 最大单会话中 `steps` 字节占比 | 34.7MB(68%) |
| 最大单会话中 `toolCalls` 字节占比 | 12.1MB(24%) |
| 最大单条 assistant 消息 | 6.8MB |
| 启动 `sanitizeAllSessionsOnStartup` 全量读盘耗时 | ~1.4s |

### 1.3 问题定位

1. **写放大 O(整个会话)**:流式期间每 300ms 触发一次全量重写。对 51MB 会话,每次落盘 = 同步 `JSON.stringify` 51MB(阻塞主进程事件循环,进而阻塞所有窗口 IPC)+ 51MB 磁盘写。格式错配是根因:**追加式数据(消息日志)用了必须全量重写的容器(JSON 数组)**。
2. **启动全量扫描**:`sanitizeAllSessionsOnStartup` 把 303MB 全部读入并解析,只为修复个别脏会话。
3. **pretty-print 膨胀**:`JSON.stringify(data, null, 2)` 使文件体积膨胀约 30–40%,序列化更慢。
4. **数据卫生**:工具执行结果同时内联在 `steps` 与 `toolCalls` 中(疑似重复存储),单条消息可达 6.8MB。

### 1.4 为什么不是"把 SQLite 接回来"

- 原生模块(better-sqlite3)在 Electron 中是长期税:ABI rebuild、electron-builder 三平台打包、asar unpack。2026-07-04 拆除时已确立"原生依赖留在 headless server,Electron 走 HTTP 代理"的架构原则(memory 系统即此模式),会话存储应遵循同一原则。
- 聊天数据 99% 的操作是追加与顺序读,结构性修改(编辑重发/分支/删除)低频。JSONL 与数据形态匹配,不需要关系引擎。
- 将来若需全文搜索/跨会话查询,在 apps/server 建索引(纯 Node,无 ABI 问题),而非回到主进程开库。

---

## 2. 目标与非目标

### 目标

- G1:流式期间单次落盘成本从 O(整个会话) 降到 O(当前消息),主进程无大对象同步 stringify。
- G2:启动阶段不再全量读取所有会话文件。
- G3:崩溃语义明确且不劣于现状:最多丢失"当前正在生成的消息自上次检查点以来的增量"。
- G4:分页读取(`getSessionMessagesPage` / `getSessionUserMessageMarkers`)不整文件加载。
- G5:对上层(`sessionMessageRuntime`、IPC、renderer)**零 API 变化**;Electron 与 apps/server 两个宿主共用同一实现。
- G6:旧格式惰性迁移、可回滚;SQLite 死代码彻底清理。

### 非目标

- 不做跨会话全文搜索(留给 apps/server 未来方案)。
- 不改变 `index.json`(会话列表元数据)机制。
- 不解决多进程并发写同一会话的一致性(见 §9 待决问题,现状同样存在)。

---

## 3. 总体方案与阶段概览

**一句话:每会话一个目录,元数据小文件 + 消息追加日志;流式只做"当前消息级"检查点;结构性修改在 worker 中全量重写;旧格式惰性迁移。**

```
~/.onething/sessions/
├── index.json                      # 不变:会话列表元数据
├── <legacy-id>.json                # 旧格式,惰性迁移后归档
└── <id>/                           # 新格式:目录即会话
    ├── meta.json                   # 会话级元数据(小,整写)
    ├── messages.jsonl              # 消息日志,一行一条,按 seq 有序
    └── blobs/                      # Phase 3:外置大 payload
        └── <sha256>.json
```

### 阶段总览(先看全貌,再看细节)

| 阶段 | 内容 | 依赖 | 风险 | 预期收益 |
|---|---|---|---|---|
| **Phase 0 止血** | 流式改边界落盘 + 启动惰性 sanitize + 去 pretty-print | 无 | 低 | 流式卡顿消除大半;启动 -1.4s;体积 -30% |
| **Phase 1 新格式** | jsonl 编解码/分页/恢复 + 存储驱动 + 仓库接入(feature flag,默认关) | P0 | 中 | 写成本 O(当前消息);分页 O(页) |
| **Phase 2 迁移与默认化** | 惰性迁移旧格式;flag 默认开;SQLite 死代码清理 | P1 | 中 | 全量收益落地;代码面收敛 |
| **Phase 3 数据卫生** | steps/toolCalls 去重;大 payload 外置 blobs/ | P2 | 低 | 单会话体积预计 -60%+ |

Phase 0 与 Phase 1 可并行开发;Phase 0 的改动在 Phase 1 落地后依然有效(边界落盘策略被新驱动继承)。

---

## 4. 详细设计:文件格式

### 4.1 `meta.json`

会话对象中除 `messages` 外的全部字段,外加格式版本与日志摘要:

```jsonc
{
  "formatVersion": 2,
  "id": "…",
  "name": "…",
  "provider": "…", "model": "…",
  "usage": { … }, "lastTurnUsage": { … },
  "variables": [ … ], "promptContext": { … },
  "summary": "…", "summaryUpToMessageId": "…",
  "createdAt": 0, "updatedAt": 0,
  "log": {
    "messageCount": 258,        // 活跃消息数
    "lastSeq": 257,             // 最后一条消息的 seq
    "compactedAt": 0            // 最近一次压缩重写时间戳
  }
}
```

- 写入方式:沿用 `writeJsonFileAtomic`(tmp+rename),**保留 pretty-print**(小文件,可读性优先)。
- `meta.json` 是唯一"整写"的文件,每次消息边界落盘时随消息一起更新(几 KB,成本可忽略)。

### 4.2 `messages.jsonl`

- 第 1 行固定 header:`{"t":"h","v":2,"sessionId":"…"}`。
- 其后每行一条消息:`{"t":"m","seq":N,"m":{ …ChatMessage }}`,**单行紧凑 JSON(无缩进)**,`\n` 结尾。
- **不变量:行序 = seq 序 = 消息序;每条消息在文件中只出现一次(最终版本)。** 读路径因此不需要去重/last-wins 合并。

维持该不变量的代价由写路径承担(§5):

- 追加新消息 → `appendFile` 一行。
- 修改已落盘的消息 → **后缀重写**:从被修改消息的字节偏移处 `ftruncate`,重新追加该消息及其后所有消息。实践中被修改的几乎总是最后一条(usage 回填、steps 更新),成本 ≈ 单条消息体积。
- 删除中间消息 / 编辑重发截断 / 分支 → **全量压缩重写**(worker 中执行,tmp+rename)。

> 备选方案(已否决):upsert 日志(append `put`/`del` 行,读时 last-wins 合并)。追加语义更纯粹,但把复杂度转嫁给了读路径——tail 分页必须处理"旧消息的新版本出现在文件尾部",分页器无法依赖行序。会话的修改频率不足以证成这个复杂度。

### 4.3 崩溃恢复语义

- 加载时若最后一行不完整(无 `\n` 或 JSON 解析失败),**静默截断丢弃**,并在下次落盘时修复文件。这替代了现在的启动全量 sanitize。
- `ftruncate` + 追加的后缀重写若中途崩溃,文件仍是"合法前缀"(丢失后缀消息)。可接受:后缀重写只发生在流式检查点,丢的是本来就不完整的当前轮。
- 落盘默认依赖 OS 页缓存刷写;`flushSessionSave`(stream 收尾、删除前)与 `before-quit`(`apps/electron/src/app/before-quit.ts`)时机执行 `fdatasync`。

---

## 5. 详细设计:写入路径

### 5.1 落盘时机(替代 300ms 节流)

现状:`sessionMessageRuntime` 的每个 `update*`(逐 token 的 `updateMessageContent`、`updateMessageReasoning` 等)都调 `saveSessionToFile` → 300ms 节流全量写。

新策略:**内存为主,边界检查点。**

| 事件 | 动作 |
|---|---|
| `addMessage`(用户消息 / assistant 占位) | 用户消息立即 append;assistant 占位**不落盘**(isStreaming 中间态不进日志) |
| 流式 token(`updateMessageContent/Reasoning/ContentParts` 等) | 仅更新 LRU 缓存,标记 dirty,**不落盘** |
| step 完成 / 工具调用结束(`updateMessageStep` 收尾、`updateMessageToolCalls`) | 检查点:后缀重写当前消息 |
| 兜底定时器(dirty 且距上次检查点 > 5s) | 检查点(防长 step 期间长时间无落盘) |
| 消息 finalize(`updateMessageStreaming(false)` / usage 回填) | 检查点 + 更新 `meta.json` + `fdatasync` |
| 编辑重发 / 删除 / 分支(`deleteMessageAndTruncate`、`updateMessageAndTruncate` 等) | worker 全量压缩重写 |

崩溃丢失上界:当前消息最近 5s 的增量。相比现状(300ms 全量写)理论上多丢几秒的中间态,换来的是写成本从 51MB/300ms 降到几十 KB/边界;且现状的"每 300ms"在大会话上本来就因 stringify 耗时而事实退化。

### 5.2 存储驱动抽象

在 repository 与 fs 之间引入驱动接口,新旧格式各一个实现,上层无感:

```ts
// packages/core/session/storage/driver.ts
interface SessionStorageDriver<TSession, TMessage> {
  load(sessionId): TSession | undefined            // 含恢复逻辑
  appendMessage(sessionId, seq, message): void      // 追加一行
  checkpointFrom(sessionId, seq, messages): void    // 后缀重写(dirty 起点起)
  rewriteAll(sessionId, session): Promise<void>     // worker 压缩重写
  updateMeta(sessionId, metaPatch): void
  readPage(request): GetSessionMessagesPageResponse | undefined
  readMarkers(sessionId): UserMessageMarker[] | undefined
  delete(sessionId): void
  flush(sessionId): Promise<void>
}
```

- **脏区跟踪**:runtime 内存中为每个打开的会话维护 `lowestDirtySeq`;检查点即 `checkpointFrom(lowestDirtySeq)`。`updateStepsUsageByTurn` 等触碰历史消息的路径会自然下推 dirty 起点,后缀重写自动覆盖。
- `AsyncSaveQueue` 保留,但调度单元从"整会话重写"变为"驱动检查点",串行化语义(同会话 promise 链)不变。
- 大重写(`rewriteAll`、迁移、压缩)统一走 `worker_threads`(Electron 主进程与 apps/server 均可用;不用 `utilityProcess`,保持宿主无关)。序列化在 worker 内完成,主线程只传会话对象的结构化克隆。

### 5.3 代码落点

| 模块 | 路径 | 内容 |
|---|---|---|
| 行编解码 + 恢复扫描 | `packages/core/session/storage/jsonl/codec.ts` | 纯函数:encode/decode 行、尾部截断检测 |
| 反向分块分页器 | `packages/core/session/storage/jsonl/pager.ts` | 纯函数:给定 fd 读取接口做 tail/cursor 分页 |
| fs 驱动 | `packages/onething-runtime/src/sessions/jsonl-driver.ts` | 实现 `SessionStorageDriver`,含 worker 压缩 |
| 旧格式驱动 | `packages/onething-runtime/src/sessions/legacy-json-driver.ts` | 现有整文件读写包一层同接口 |
| 仓库接入 | `packages/onething-runtime/src/sessions/session-repository.ts` | options 增加 `driver`,替换 `writeJsonFileAsync` 直写 |
| 路径 | `packages/onething-runtime/src/storage/paths.ts` | `getOnethingSessionDir(sessionId)` 等 |

---

## 6. 详细设计:读取路径

### 6.1 分页(`getSessionMessagesPage`)

请求/响应类型不变(`packages/core/session/storage/types.ts` 的 seq cursor 语义直接复用):

- **tail 锚点(打开会话)**:从文件尾反向按 2MB 块读取,反向切行,解析出最后 N 条。不需要全文件扫描,不需要索引。
- **cursor 翻页**:首次访问时后台构建该会话的**内存偏移表**(一次顺序扫描,只记 `seq → byteOffset`,不保留消息体;51MB 约 100–200ms,worker 中执行),缓存于 LRU,压缩重写后失效。此后任意页 = seek + 读 N 行。
- 偏移表不落盘(v1)。若实测冷翻页延迟不可接受,再在压缩时把偏移表写进 `meta.json.log.offsets`(稀疏,每 100 条一个)——留作后续优化,不进首版。

`resolveSessionMessagesPage` 的三级降级简化为两级:驱动分页 → 整载兜底;`shouldScheduleMigration` 语义复用为"旧格式 → 调度 jsonl 迁移"。

### 6.2 markers(`getSessionUserMessageMarkers`)

构建偏移表时顺带记录 `role === 'user'` 的 `(id, seq)`,与偏移表同缓存同失效。

### 6.3 整会话加载(`getSession`)

流式写入、编辑等仍需完整对象:`load()` = 读 `meta.json` + 顺序解析 `messages.jsonl`(含尾行恢复)。与现状的整文件 `JSON.parse` 同量级,不劣化;LRU 缓存策略不变。

---

## 7. 详细设计:迁移与兼容

### 7.1 惰性迁移(复用既有 scheduleMigration 概念)

1. `load(sessionId)`:先探测 `sessions/<id>/meta.json`;不存在则回落 `sessions/<id>.json`(旧格式驱动),照常服务,同时调度一次后台迁移。
2. 后台迁移(worker):旧 JSON → 写 `<id>/`(meta.json + messages.jsonl)→ 逐条校验 count 与末条 id → 旧文件改名为 `sessions/legacy-backup/<id>.json` → 完成。迁移期间写请求到达则放弃本次迁移,下次再试(避免双写竞态)。
3. `index.json` 不动;`getSessionsList` 路径零变化。

### 7.2 Feature flag 与回滚

- `settings.storage.sessionFormat: 'legacy-json' | 'jsonl'`,Phase 1 默认 `legacy-json`(新代码路径仅在显式开启时生效),Phase 2 切默认 `jsonl`。
- 回滚:flag 切回即可——旧格式驱动一直保留;`legacy-backup/` 保留 30 天;另提供 `scripts/convert-sessions.mjs --to=json|jsonl` 双向转换脚本(替代删除的 `migrate-sessions-to-sqlite.mjs`)。

### 7.3 死代码清理(Phase 2,迁移默认化后)

删除:

- `packages/core/session/storage/sqlite-schema.ts`、`sqlite-mappers.ts` 及 `index.ts` 中的相关导出
- `packages/onething-runtime/src/sessions/sqlite-repository.ts`、`sqlite-driver.ts`、`sqlite-types.ts`、`resilient-sqlite-adapters.ts`
- `src/main/stores/session-repository/sqlite-repository.ts`、`sqlite-schema.ts` 与 `src/main/stores/sessions.ts:106-174` 的空壳桩
- `scripts/migrate-sessions-to-sqlite.mjs`、`package.json` 的 `rebuild:sqlite:node`
- 相关测试:`sqlite-message-seq.test.ts`、`sqlite-repository.test.ts`、`core-sqlite-mappers.test.ts`
- repository/messageRuntime 接口中的 `Sqlite` 命名适配器(`OnethingSessionRepositorySqliteAdapters` → `SessionSideStoreAdapters` 或直接删除)

注意:`packages/onething-runtime/src/memory/**` 的 better-sqlite3 是记忆系统,**保留**;根 `package.json` 的 better-sqlite3 依赖因 memory 仍需保留。

CLAUDE.md 更新:"会话持久化 = meta.json + messages.jsonl;索引/搜索能力属于 apps/server"。

---

## 8. 详细设计:数据卫生(Phase 3)

1. **查明 steps/toolCalls 重复**:实测 steps(34.7MB)与 toolCalls(12.1MB)疑似内联同一批工具结果。若确认,持久化层只存一份,另一侧存引用(`toolCallId`)。预期最大会话直接 -40%。
2. **大 payload 外置**:持久化前检查每个 content part / tool result,超过 **256KB** 写入 `sessions/<id>/blobs/<sha256>.json`,消息内替换为 `{ "$blob": "<sha256>", "bytes": N, "preview": "…" }`;加载按需解析(分页读取不解析 blob,只有 renderer 明确展开时经 IPC 取)。删除会话时连目录一起删,无引用计数问题。
3. **写入硬上限**:单条消息序列化后 > 8MB 时告警并强制外置,防止未来某个工具输出回潮。

---

## 9. 待决问题

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | Electron 主进程与 apps/server 可能同时打开同一 store(`~/.onething`),并发写同一会话无保护(**现状亦如此**,整文件写互相覆盖) | v1 引入 per-session `.lock` 文件(advisory,含 pid+时间戳),冲突时后来者只读并告警;彻底方案(会话所有权划分或全部经 server)另立设计 |
| Q2 | 检查点兜底间隔 5s 是否合适 | 上 flag `storage.checkpointIntervalMs`,默认 5000,灰度期观察 |
| Q3 | 偏移表是否落盘 | v1 不落,依据灰度期 `[Perf][SessionPage]` 日志决定 |
| Q4 | blob 阈值 256KB | 依据 Phase 3 前的分布统计微调 |

---

## 10. 实施计划

### Phase 0 — 止血(1–2 天,可立即开始,不动格式)

| # | 改动 | 位置 |
|---|---|---|
| 0.1 | 流式 `update*` 只写缓存;检查点时机按 §5.1(仍整文件写,但频率从 300ms 降到边界/5s) | `session-message-runtime.ts`、`session-repository.ts` |
| 0.2 | 会话文件写入去掉 `null, 2`(index.json / settings 等小文件保留) | `packages/core/storage/json-file.ts` 增紧凑写变体 |
| 0.3 | 启动 sanitize 惰性化:删除两处启动调用,把 `sanitizeSessionOnStartup` 挪进 `loadSessionWithAdapters` 首次加载 | `apps/electron/src/app/main-process.ts:120`、`src/main/headless/backend.ts:108`、core session 加载路径 |

验收:打开 51MB 会话流式对话,主进程无 >50ms 的 stringify 阻塞(用 `[Perf]` 日志验证);冷启动到窗口可交互时间 -1s 以上;全量 vitest 通过。

### Phase 1 — 新格式驱动(3–5 天)

1.1 core:jsonl codec + pager + driver 接口(纯函数,先行 TDD)
1.2 runtime:jsonl-driver(append/checkpoint/rewrite/worker)+ legacy-json-driver 包装
1.3 repository 接驱动 + feature flag;`resolveSessionMessagesPage` 降级链改造
1.4 双宿主接线:`src/main/stores/sessions.ts` 与 `apps/server/src/runtime.ts:5326`

验收:flag 开启下全部会话操作(发送/编辑重发/分支/删除/翻页/markers)行为与 legacy 一致(对拍测试);kill -9 注入测试满足 §4.3 恢复语义。

### Phase 2 — 迁移默认化 + 清理(2–3 天)

2.1 惰性迁移 + 校验 + legacy-backup;转换脚本
2.2 内部灰度(开发机真实 303MB 数据全量迁移验证)
2.3 flag 默认 `jsonl`;§7.3 死代码删除;CLAUDE.md 更新

### Phase 3 — 数据卫生(2–3 天,可延后独立排期)

3.1 steps/toolCalls 重复调查与去重
3.2 blob 外置 + 加载/IPC 按需取 + 删除级联
3.3 写入硬上限与告警

### Phase 4 — legacy 退役(观察期后执行)

前置条件(2026-07-08 已达成前三项):
- ✅ 存量批量转换完成(`convert-sessions.mjs --to=jsonl` + `--verify` 全过,sessions/ 下无裸 `<id>.json`)
- ✅ Electron 新会话默认 jsonl
- ✅ server 新会话切 jsonl(不再产生新 legacy 数据)
- ⏳ 真实使用观察 1–2 周:`[Perf][SessionPage]` source 稳定为 jsonl-log,无反复 `jsonl log recovered` 告警

观察期过后删除:
- storage-driver 中 legacy 分支与惰性迁移机制(`convert-sessions.mjs` 脚本永久保留)
- `json-message-page.ts` 字节扫描分页(core 与 `src/main/stores/session-repository/` 两份,只服务 legacy)
- flag 的 `'legacy-json'` 取值;`resolveSessionMessagesPage` 降级链简化为 jsonl-log → 整载兜底
- repository/message-runtime 遗留的 `sqlite?` 空挂钩与 `syncSessionToSqliteIfReady` 调用链(同批清理)
- `legacy-backup/` 数据文件满 30 天后删除(与删代码解耦;脚本可随时把备份转回)

若未来对外发布:legacy 读路径 + 惰性迁移需跨至少一个发布版本再删(升级用户盘上是旧格式);写路径可先删。

---

## 11. 测试计划

- **单元**:codec 行编解码往返;尾行截断恢复(逐字节截断 fuzz);反向分块分页(块边界跨行 case);后缀重写偏移正确性。
- **性质测试**:随机操作序列(add/update/delete/truncate/branch)同时打到 jsonl 驱动与内存模型,断言任意时刻 load() 结果一致。
- **迁移**:用 `legacy-backup` 前的真实 165 会话语料跑双向转换,round-trip 逐字段 diff。
- **崩溃注入**:子进程中执行写入,随机 SIGKILL,重启后断言恢复语义。
- **性能基准**(vitest bench,51MB fixture):流式检查点耗时、tail 分页耗时、冷偏移表构建耗时,纳入 CI 观察。
- ###### **回归**:现有 `same-file-edit-order`、`agent-loop-executor`、分页相关测试全量通过。

---

## 12. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 后缀重写实现缺陷导致日志损坏 | 高 | 不变量简单可断言(行序=seq 序);性质测试 + 崩溃注入;恢复逻辑兜底;legacy-backup 30 天 |
| 双进程并发写(Q1) | 中 | v1 advisory lock;现状本就无保护,不构成回归 |
| 检查点间隔导致崩溃丢失变多 | 低 | 5s 兜底 + step 边界;丢失上界明确且仅限当前消息 |
| 迁移期间数据不一致 | 中 | 迁移原子性(校验后才改名旧文件);写请求到达即放弃本次迁移 |
| worker 序列化大会话的内存峰值 | 低 | 结构化克隆按需;压缩重写低频;监控日志 |
