# GPT 后端重构去留裁定(2026-09-07)

**对象**:2026-09-06/07 由 Codex 完成、未提交的一轮后端重构(470 文件,+14.7k / −6.1k,完整快照 tag `gpt-wip-2026-09-07`)。
**已发生的事**:两处阻断性问题已修——`/api/sync` 快照协议整条撤回(第二套真相,`docs/audit/session-sync-retirement-2026-09-07.md`);store 锁改回「死 pid 自动隔离回收」+ 壳/server 不取锁、关机 release/restore 阶段无条件执行。之后五路只读审查覆盖其余全部改动,本文是审查汇总与取舍。

## 0. 结论

**不整棵回退,也不整棵保留:留骨干,砍死码,修回归。** 理由:
- 值得留的是结构性的、且与 09-02 组合根方向一致:SessionLayer 组合根化(模块级 `let` 基线净收紧 4 行)、7 阶段关机 + 各子系统 `quiesce/drain`、删除会话的相位生命周期、`events-reads` 按节点缓存、账本保存屏障、fsevents 监听重写、契约层反向依赖修正、7 个独立真 bug 修、3 个门修复、CI 把发布接到同 tag 源码的测试。这些配了 3300+ 行真装配/真子进程/真文件系统的测试,不是替身。
- 该砍的是明确的:约 15k 行零调用点的代码(Claude SDK 检查点子系统 ~7000、诊断脚本 ~3100、example-im、未接线门)、一条指向已死协议的门断言、若干「改闸门迁就代码」。
- 该修的回归有名有姓(见 §2),每条都是 file:line 级、小改。
- 回退的代价不是零:HEAD 上会丢掉上面第一条全部,并且其中 A1/B1/C8 三块彼此缠绕,不可能靠 cherry-pick 几个文件重做。

**行为变化的默认口径**:用户可感知的行为变化,一律先回旧行为(08-18 判例),本文 §3 列出,用户点头的才保留。

## 1. 簇表(留 / 修 / 删)

| 片 | 簇 | 判定 | 备注 |
| --- | --- | --- | --- |
| A | SessionLayer 组合根化(commands/writer/surface/prepare/projection 收进实例) | **留** | 修 TDZ 互引 `session/index.ts:57↔78/102`、`event-layer.ts:41↔51`;`deletion.ts:120` import 归位 |
| A | 账本保存屏障 `flushSessionEventLog`(按水位 fsync、失败粘住上抛) | **留但修** | blob 每次检查点重读+重算 sha256(`event-log.ts:856-868`)改为只算一次;目录 fsync 只到会话目录与 `sessions/`,不一路到 `/`(`:871-885`、`durable-json.ts:47-50`) |
| A | `durable-json` 发布原语 | 留但修 | 同上 fsync 深度;删 `sessions/durable-file.ts` 纯再导出壳 |
| A | 删除意图持久化 + 代际 | **留但修** | `recover()` 只重放未 complete 的 intent,不再每次开机全量重放(`deletion-recovery.ts:200-222`);`isolate` 尾部无条件 fsync 去掉;`isDeleted(id, undefined)` 返回 true 改 false(`:227`);`saveSessionsIndex` 补 generation 不依赖 LRU 命中(`session-repository.ts:388-396`);墓碑 GC 另立单 |
| A | `session:removed` 删后发 + 归属凭据 | 留 | 消费者 `live-session-delivery.ts:45` 在树上,自洽 |
| A | `ensureWritable` 读路 `legacyMessages ?? eventsListMessages` | **修** | 倒过来:投影优先、抄本只在投影为空时兜底(`reads.ts:134`);缓存 `existsSync`(`legacy-reads.ts:12-14`);恢复被删的 §15.22 判例注释 |
| A | `events-reads` 按节点 rev 缓存 | **留** | 本轮最值钱的性能修。`view:'live-ui'` 半边(含 `includeUnsettledParts`)零调用点 → 删 |
| A | `store-format.json` 能力声明 + 首次开机全量扫账本 | **删** | 单向门写进用户库 + 装配链上同步逐字节扫 469 份 `events.jsonl`,最像 Codex 自己查不清的「装配阶段停住」 |
| A | 备份/校验/恢复 CLI + `store lock inspect/recover` | 留 | `scripts/gate-store-backup.mjs` 登记进 `package.json` 或删 |
| A | 会话归属 `initialOwner` / `storageGeneration` / `access.ts` | 留 | 与 C1 一起看;`access.ts:71/79` 两处重复枚举合一 |
| A | core 小加法(`EventDeliveryOptions`、三个新事件类型、`event-stats` 按 store 钉住) | 留 | — |
| B | 7 阶段 `BackendResources` + 各子系统 `quiesce/drain` | **留但修** | 骨架违规:`backend.ts` 里 33 行机械 `own(quiesce)/own(drain)` 收成 `interface Quiescible { quiesce(); drain() }` + `this.adopt(name, obj)`;「pending 集 + accepting 闸」手抄六遍抽基类;`backend.ts:604-612` 闭包引用后声明的 `sessionToc` 与 `parts.*!` 断言窗口 |
| B | session-toc 任务所有权 | **必修** | `triggers/session-toc.ts:67,80,135` `failures` 只增不清 → 一次写盘失败后每次删会话与关机都抛 |
| B | 执行检查点:模型前/工具前/工具后/响应后四点 `await` 排空 + fsync | **删(回旧行为)** | HEAD 无此四钩;一回合 2N+2 次同步落盘全在流式主路径。要保留任何一处须用户点头(§3) |
| B | 外部 agent 连接器注册表代际化、`TaskDispatchLayer`、variables 快照桥 | 留 | `dispatch.ts` `stop()` 后 `reportBack` 静默早退记一笔 |
| B | 工作区文件监听重写(macOS fsevents 原生流、HistoryDone 才算 start) | **留** | fsevents 是 N-API(`gate:native` 7/7 绿,21 个 `napi_*`、0 个 v8 符号),三条 build recipe external,真机测试 |
| B | 插件异步清理顺序 | **留** | 真 bug 修 |
| B | 授权/executionContext 全线贯通 | 留 | 桌面路径恒真;`stream-engine.ts:145-155` 双层 `trackSessionExecution`、`authorizeExecution` 一次发送跑 3–4 遍 → 去重 |
| B | Claude SDK 请求检查点 + preload runtime + fd 适配 | **删** | 全仓零宿主传 `claudeCheckpointPreload`,却被打进三份产物;连同 D 片 runtime 侧 2066 行源码 + 3284 行测试、`scripts/diagnostics/claude-*` 与 9 份 `docs/design/claude-*.md` 一起走 |
| B | `asarUnpack` 单文件 → `dist-electron/**` | 回旧值 | 新规则只证了「新的能跑」没证「旧的坏了」;`main.cjs`/`preload.cjs` 出 asar 改变签名姿态。改回后跑 `gate:packaged` 定夺 |
| C | `SessionAccess` 谓词 + 27 个域 153 处手写闸 | 留 | 单用户桌面恒真、门全绿。后续加域改成 router 契约一格 `session: 'sessionId'` 由 `dispatchRpc` 统一执法(骨架律),另立单 |
| C | `audience.ts` 归属规则被换(「无主=公开」→ 补默认值再比) | **修** | 改回 HEAD 语义;删 `audience.ts:20-41` 五段孤儿 JSDoc;`access.test.ts:26-27` 断言随之改 |
| C | 租户目录/HTTP 身份收口(`validateTenantId` 抛、token sha256 + `timingSafeEqual`) | 留 | — |
| C | 外设域操作员闸 | 留但修 | `voice.ts:89-97` `getState/stop` 对已删会话抛 → 不校验;`tools.ts:249` job 不存在时文案错;`evals-access.ts:20` 动态 import 整个 runtime barrel → 子路径 |
| C | `cancelTool` 从空操作变真取消 | 回旧行为(§3) | 顺带找回 `logger: consoleLog` |
| C | scratchpad 草稿归属 + `sessions.create` claim/adopt/recover | **删(回 HEAD)** | 4 倍复杂度换桌面上零收益 |
| C | app-state 按租户分文件 + `currentSessionId` 过滤 | 留但修 | 指向已删会话的 `currentSessionId` 被静默清空是副作用,记一笔 |
| C | `session/deletion.ts` 相位生命周期、`outbound-reply-dispatcher` 收据失败上抛 | **留** | 真 bug 修 |
| C | `@shared/contracts/*` 三件(契约层不再反向 import runtime) | **留** | 补一条门:`shared/contracts` 只许可序列化形状,不许 `defineRouter` |
| C | `registry.ts` 用 `backend.runTask` 包 dispatch | 留 | — |
| C | `workspace-watch-context.ts` 用 Symbol 往 `RpcDispatchContext` 塞函数端口 | 修 | 非枚举属性不过 spread;改显式参数/端口表 |
| C | `media.ts` −32 / `app-state.ts` −23 文件头判例注释 | **恢复** | 判例住在文件头里 |
| C | `connector-registry.ts:99` `const ownerHooks = hooks` | 删 | 噪音 |
| D | 标题生成 `await`(`core-stream-engine.ts:974`) | **必修** | 新会话第一条消息要等标题模型跑完才出字;改回发后不管 |
| D | agent-loop 检查点钩子面 | 随 preload 删 | 单摘 `runner.ts:704` 重试闸收紧(`toolExecutionStarted`)与 `stream.ts:91-95` abort 复查 |
| D | quiesce/drain 家族产品半边 | 留但修 | `usage/ledger.ts:74-76` `ledgerDir` 签名与求值时机不符;`record()` 会抛需确认调用方 |
| D | 七个真 bug 修 | **留** | mailbox `flush()` 吞写失败;网关审批队列跨会话冒批(`permission-coordinator.ts:81-110`);digest 路径穿越;agents 缓存换根;grok 无 tools 带 tool_choice 400(`ToolChoicePolicy`);ACP 陈旧连接回调;豆包 TTS 连接泄漏 |
| D | `practice` / `collab-digest` 单例改类 | 留 | `PracticeService` 困在 `.wiring.ts` 里,产品层拿不到 → 搬出 |
| D | `gateway/src/channels/example-im/` | **删** | 示例代码进产品树,零引用 |
| D | 两个测试放在 `__tests__/` 外、music `Proxy` 自动 track、scratchpad `move` 非原子 | 修 | 移位;改显式包装;记一笔 |
| E | fsevents 依赖链 | **留** | 见 B |
| E | CI 三个 workflow | 留但修 | ①`apps/desktop-react/bun.lock` 未跟踪 → 提交它或删 `bun install --frozen-lockfile` 三步;②`test.yml:37` `npm rebuild node-pty` 顶撞 N-API 律 → 删;③3 平台 persistence 矩阵未在 Win/Linux 真跑过,先放 `test.yml` 不接 tag 发布链 |
| E | dev 泳道关机重写 | 留但修 | `dev-unified.mjs:460` 优先级 bug;`lib:112` 信号死亡判失败(Ctrl-C 恒退 1);`lib:103-106` 无界 while;三条行为变化回旧(§3) |
| E | 检查器改动 | 一半打回 | `backend-public-boundary` AST 化留;`checkSessionEventSingleWriteDoor` 三个测试白名单删;`session-check.mjs:242-252` 藏进检查器的豁免搬回基线;「wildcard export 一律违规」顶撞 Alias Registry → 删 |
| E | 四个门 | 三留一退 | `gate-packaged` 泄漏修、`gate-web-shell` 死 testid 修、`gate-stream-structure --owner=desktop` 留(登记进 package.json);`gate-client-runtimes.mjs:135-142` 要求 `sync=1` → 回退 |
| E | 21 个未接线脚本(~3100 行) | **删** | `scripts/diagnostics/**`、`backend-*.mjs`、`investigate-stream-scroll.mjs`;唯一接线的 `build-claude-checkpoint-preload.mjs` 随 preload 一起删 |
| E | ~30 份 docs | 分类 | `backend-message-freeze-2026-09-07.md` + 三份 `.json` 读数删(整篇是已删协议的验尸);`backend-work-summary` §3「同步与重连」补撤回一句;9 份 `claude-*` 随 preload 删;其余留 |
| E | 非 GPT 的既存未跟踪文件 | 留,另行提交 | `docs/guides/code-reading-and-tracing.md`(08-24)、`docs/system-diagrams.md` + `.tldraw`(09-05)、`coding-agents-ledger-2026-08.md`(08-29)、`apps/desktop-react/bun.lock`(09-04) |

## 2. 必修回归(合入前红线)

1. 标题生成阻塞(D)。
2. session-toc 失败表只增不清(B)。
3. audience 归属规则被悄悄改掉(C)。
4. 读路旧抄本排在投影前(A)。
5. `voice.getState/stop` 对已删会话抛(C)。
6. dev 泳道退出码压平 + Ctrl-C 恒退 1 + 无界 while(E)。
7. `gate-client-runtimes` 指向已死协议(E)。
8. `sessions-domain.test.ts:792` 断言元数(C,一行)。
9. 存量红 `session-authorization.test.ts > sessions.rename` 全量跑超时(动态 import 整域)。

## 3. 行为变化,默认回旧,用户点头才留

| 变化 | 默认 | 若保留的代价 |
| --- | --- | --- |
| 四点执行检查点 fsync(B) | 删 | 每回合 2N+2 次同步落盘在流式主路径 |
| `cancelTool` 变真取消(C) | 回空操作 | 它其实是把说谎的按钮改真了;**可作独立小单再合** —— 工单 4 B1 已回旧:`tools.cancelTool` 与 `cancelOnethingToolForIpc` 回 HEAD 的「记一行日志恒回 success」,零消费者的接线 `cancelToolkitTool` 一并删。要再合的东西还在:`ToolExecutionRegistry.cancel`(授权 + abort + 等 `drained`)留在树上并有 `__tests__/tool-execution-lifecycle.test.ts` 钉着,整份实现在 tag `gpt-wip-2026-09-07`;那一单要做的只是把域处理器重新接到它,并让用户先点头 |
| `store-format.json` 单向能力门(A) | 删 | 老版本打不开新库,且首启全量扫账本 |
| dev 泳道:不再静默子进程输出 / 见残留 15s 清不掉就拒绝启动 / 宽限 1.2+1.8s → 10/15s(E) | 前两条回旧;宽限保留 10s(关机死线 8s 需要) | Ctrl-C 慢 5 倍 |
| `asarUnpack dist-electron/**`(B/E) | 回单文件 | 跑 `gate:packaged` 定 |
| `currentSessionId` 指向已删会话被清空(C) | 保留(算修 bug) | — |

## 4. 与本轮无关但被门抓出来的两件事

- **`gate:perf` ④ core 进程 CPU 中位 99%**:CPU profile 显示 ④ 窗口内 core **主线程** 9 秒只忙 0.89 秒(滞后 15ms 绿),忙的是**检索索引 worker 线程**(3.6 秒,85% 在 `refold → replaceKey → insertDocument`,每次影响文档的账本追加都把 5MB 会话整篇重折)。这是 09-05 检索重建 S3「整键重折」的设计代价,HEAD 上一样;门的判据(进程 CPU)与它的本意(主线程饿死)也已经不一致。另立单:worker 侧按会话去抖 / 增量折,门改判主线程。
- **`gate:stream-structure` midjoin V2 红**(重连后当前请求正文不见):**不是内容回归,是门自己的时间预算**。逐帧读数证明在飞正文一帧都没消失;门要在 ≥810ms 的直播窗口里完成「n>60 后触发 + 300ms 延时 + 两次点击」,而今天的壳进场前要绕一趟 Dock(会话总览不再默认挂架子,+505ms),直播窗口只剩 666ms,重连落在 `run/end` 之后 237ms,`seenLive` 恒 0。HEAD 上 5/5 绿是因为「重连时刻 (没做)」——窗口更短,轮询抓不到触发缝,V2 从来没跑过;GPT 的 run 收尾慢了 ~100ms(`event-log.ts:778-845` 检查点串行 + fsync)把那道缝撑到 165ms,第一次把这条空转断言点着了。反证:只把 `LATE_OPEN_MS` 2500→1800(服务端不动)→ V2 绿、重连后 39 帧可见。**裁定**:门改成把 Dock 绕行挪到 `sendTrigger()` 之前(还回落地期的预算,不动阈值);另立单:今天的壳点 Dock 总览瓦**不卸载聊天叶**,V2「壳重新 open、水位整份丢」的前提已不成立,素材要重做。

## 5. 施工序(建议)

1. **砍**:preload 整簇、diagnostics 脚本、example-im、store-format、scratchpad 草稿机器、四点 fsync 检查点、`live-ui` 半边、死文档。每一件删前 grep 零引用。
2. **修 §2 九条**。
3. **回旧 §3**。
4. **结构修**:`Quiescible` + `adopt()` 收 33 行;pending/accepting 基类;fsync 深度;`recover()` 只重放未完成 intent;`PracticeService` 出 wiring;Symbol 端口改显式;契约层门。
5. 全套静态门 + `bun run test` + 真机门(`log:smoke` / `gate:search-index` / `gate:stream-structure` / `gate:packaged`)绿后,按目录切几笔提交(GPT 重构 + 修复混在同一文件里,无法只提交修复)。
6. 另立两单:检索 worker 重折去抖;RPC 授权改 router 契约一格声明(骨架已于工单 5 §6 落地,见下表)。

## 6. RPC 授权契约化:骨架已落,余下 24 个域的迁移表(工单 5 §6)

**骨架**(已落地):
- `packages/core/ipc/index.ts` —— `RouteSessionAccess { param; op; optional? }`;`Router.session`
  是一张「方法 → 自述」的只读表;`defineRouter(domain, methods, session?)` 收下它并校验
  「声明了一个不存在的方法」当场抛。core 不认识任何一个具体动词(`Op` 是泛型参数)。
- `packages/shared/contracts/session-access.ts` —— 动词表 `SessionAccessOperation`
  (从 `backend/session/access.ts` 搬来,那边原样再导出)。契约层要说得出这句话,所以词汇
  住在契约层。
- `packages/backend/rpc/registry.ts` —— `dispatchRpc` 在 `runTask` **之前**读
  `entry.session[method]`,有声明就 `sessionAccess.resolve`(或 `resolveOptional`)一次;
  没声明的域一个字都不做,派发行为逐字不变。

**陌生能力演练(骨架律的交卷题)**:今天要给一个**全新的域**接上会话授权,要改的文件是
——「那个能力自己的契约文件里加一格 `session: { <method>: { param, op } }`」,完。
`rpc/registry.ts` 零改动,`rpc/index.ts` 零改动,任何一个宿主壳零改动,`core/ipc` 零改动。
执法点只有一处,而且它不认识任何一个域的名字。

**样板已迁**(手写闸已删,判据搬到派发面 `session-authorization.test.ts`):
`sessions`(21 格)、`chat`(3 格)、`scratchpad`(4 格)。

**余下的域**(按仍然手写会话闸的处数;每一格迁走前要先确认它是不是"一个 payload 字段 +
一个动词"这种简单形):

| 域 | 手写闸处数 | 迁移备注 |
| --- | --- | --- |
| `collab` | 13 | 最大的一块;多数是房间/成员的多 id 解析,先判哪些是单 id 单动词 |
| `session-events` | 6 | `list` / `listRaw` / `readBlob` / `getTrace` 形状规整,优先 |
| `sessions` | 4(剩余) | `create` / `delete` / `getCacheStats` —— 多 id 或未物化,**不迁** |
| `chat` | 3(剩余) | `abortStream` 的省略-sessionId 扇出,**不迁** |
| `goal` | 3 | 单 id 单动词,优先 |
| `variables` | 3 | 同上 |
| `tools` | 3 | 有 job 生命周期的分支,逐条看 |
| `permission` | 2 | `getPending` / `clearSession`,优先 |
| `interaction` | 2 | 同上 |
| `todo-plan` | 2 | 会话可缺省(`current`),用 `optional` 那一档 |
| `acp` / `files` / `plugins` / `usage` / `voice` / `evals-access` / `session-command` / `scratchpad` | 各 1 | `voice` 与 `session-command` 的目标是算出来的(设备绑定 / 嵌套命令),**不迁** |

口径:**能自述的才迁**。一次调用要动多条会话、或者目标要先算一遍才知道是谁(voice 的设备
绑定、session-command 的嵌套命令、chat 的全量 abort),那不是"契约里一格"能表达的东西 ——
它们的闸留在处理者里,并且要在处理者里写清楚为什么。

## 7. 落地记录(2026-09-07,工单 1–6)

§5 的施工序按六张派工单走完。**未提交**:六笔提交由另一个代理按目录切(core+runtime 产品层 / backend 脊柱与会话层 / backend 接线与服务面 / client+壳+CLI+server 进程壳 / 脚本·CI·构建·基线 / 文档),因为 GPT 的重构与我们的修复混在同一批文件里,没法只提交修复。

### 7.1 五单各做了什么

| 单 | 一句话 |
| --- | --- |
| 1 store 锁与关机链 | `lifecycle.ts` 的 `release` / `restore` 两阶段改成**无论前面成败或超时都跑**(删掉那条 `continue` skip、`break outer` 改成「记进 pending 但仍进 release/restore」,超时后每阶段一条独立小死线),总死线 5s → 8s 盖住 MCP 3s + ACP 3s;`store-lock.ts` 回「holder pid 不活就自动清理再重试一次」,并撤回 GPT 的「所有宿主都取锁」——回到 08-24 拍板:只有 CLI daemon 取锁,壳与 server 靠 `run/http.json` 让位 |
| 2 撤回 `/api/sync` | `/api/sync` + `GET /api/events?sync=1` + `session:sync` 帧 + client `onSync` + 渲染层 `synchronized` 分支 + CLI daemon `sync.*` 整条协议连测试一起删,渲染层退回「唯一账本 events.jsonl → 自己折投影 + StreamWater 流水位」那一条路;GPT 与 sync 无关的改动逐处保留。验尸另存 `docs/audit/session-sync-retirement-2026-09-07.md` |
| 3 砍死码与回旧 | §5 第 1 步 + §3 默认回旧:Claude SDK 检查点 / preload / fd 适配整簇(含 core 钩子面、三条 build recipe 的 preload 段、九份 `claude-*` 文档)、`scripts/diagnostics/**` 等 21 个未接线脚本、`gateway/.../example-im`、`store-format.json` 能力门、scratchpad 草稿机器、四点执行检查点 fsync、`events-reads` 的 `view:'live-ui'` 半边——每件删前后各 grep 一次零引用 |
| 4 修回归 | §2 九条逐条修(标题生成不再 `await`、session-toc 失败表可清、audience 归属规则回 HEAD 语义、读路改「投影优先、旧抄本兜底」、`voice.getState/stop` 不再对已删会话抛、dev 泳道退出码与 Ctrl-C、`gate-client-runtimes` 去掉指向已死协议的断言、`sessions-domain.test.ts` 断言元数、`session-authorization.test.ts` 超时),`cancelTool` 回 HEAD 的空操作(§3) |
| 5 结构修 | 骨架律:`Quiescible` + `OnethingBackend.adopt()` 收掉 `backend.ts` 里 33 行机械 `own(quiesce)/own(drain)`;六处手抄的「pending 集 + accepting 闸」抽成 core 零依赖的 `AdmissionGate`;保存屏障的目录 fsync 抽成 `syncDirectoryChain(path, stopAt)` 只做到会话目录 + `sessions/` 两级;`recover()` 只重放未 complete 的 intent;契约层门 `checkSharedContractsHoldShapesOnly`;RPC 授权契约化骨架 + 三个样板域(见 §6) |

### 7.2 最终门读数(工单 6,全部在本机真跑)

| 门 | 读数 | 判定 |
| --- | --- | --- |
| `bun run typecheck` | `typecheck:node` + `typecheck:desktop` 双绿,零输出 | 绿 |
| `bun run test` | 948 passed / 3 skipped(951 文件);**9408 passed / 8 skipped**(9416) | 绿 |
| `bun run boundary:gate` | `0 boundary failures` | 绿 |
| `bun run transport:gate` | IPC_CHANNELS 42 个常量,四壳合计 976 行,RPC 域 transport 读法 5 处 / 5 文件,新壳 `ipcMain` 1 条 | 绿(基线收紧:`server/http.ts` 770 → 742) |
| `bun run log:gate` | 4 known console call site(s), none new | 绿 |
| `bun run assembly:gate` | 93 known module-level let 在 58 文件,349 文件扫过,none new | 绿(未再下降,基线不动) |
| `bun run session:gate` | 4 known violation(s), none new | 绿(工单 4 已改成 4 条) |
| `bun run gate:native` | 7 targets, 0 failed(含新进来的 fsevents;electron 41.1.1 / node 24.14.0 / MODULE_VERSION 145) | 绿 |
| `bun run server:build && bun run log:smoke` | `[log-smoke] ok`,`[object Object]` 计数 0,默认无 provider dump 目录 | 绿 |
| `bun run gate:search-index` | ①②③⑥⑦⑧⑨ 与 ④⑤a⑤b 全绿;**⑤c 只有折的窗口主线程事件循环 p99 7.504ms < 5ms 红** | **存量红**,见 7.3 |
| `bun run gate:store-backup` | `PASS: real CLI backup / verify / new-directory restore; corrupt and overwrite refusals; no daemon/default-store access.` | 绿 |
| `app:build` + `gate:stream-structure` | `[structure-gate] ok`,185 帧,H 零双画,V1 41 帧 / V2 23 帧 | 绿 |
| `gate:stream-structure:desktop`(工单 1 的正题,额外跑) | `ok`,187 帧,并且 **`✓ [midjoin] desktop actual close code=0, PID=65011 gone`** | 绿 |
| `bun run gate:packaged` | `complete: GREEN`;`④-b search.status.mode=owner ✓(pending=0)`;`④-c 语义召回:开关默认关 ✓,sqlite-vec 扩展可装载 ✓`;`⑥ 退出干净(code=0 signal=null),发现文件已删,零残留` | 绿(`asarUnpack` 回单文件的定夺:**回单文件是对的**) |
| `bun run gate:web-shell` | `全绿:React 浏览器壳发送 → 账本 → SSE 流式回复上屏,且 token 不进 URL` | 绿 |
| `apps/desktop-react/scripts/gate-perf.mjs` | ①②③⑤ 全绿;④ **core 侧滞后 13ms ≤ 1000ms ✓ / core 进程 CPU 中位 103%(峰 180%,15 个采样)✗ < 40% / 屏幕滞后 2561ms(只记录,本趟渲染主线程单段最长 3437ms)** | **存量红**,即 §4 第一条 |

`bun run lint:ci`(不在派工单的门列表里,按工单 5 留账核实):**全仓 11959 error 是存量**,其中 11850 条来自
`apps/desktop-react/{dist-strict,ds-bundle,.ds-sync}` 三个没进 eslint 忽略表的构建/同步产物目录。
本轮改过的 573 个文件(425 改 + 148 新)单独跑 eslint:**新增 14 条 error 已全部修掉**
(`no-unsafe-finally` ×11 —— 都是「清理不许顶掉在飞错误」的**故意**写法,按仓里既有写法加
`eslint-disable-next-line <rule> -- 中文理由`;`no-empty` ×1 补注释;`prefer-const` ×1 给
`let timer` 补 `= undefined`),**剩 7 条逐条与 HEAD 同名文件对照过,读数逐字相同**
(`session-repository.test.ts` 的 `prefer-const` 1 条、`dev-unified.mjs` 的 `no-undef` 2 条、
`gate-packaged.mjs` 的 `no-empty` 4 条)。

契约层门核实(工单 4 说加了、工单 5 说没加):**在**,`scripts/headless-boundary-check.ts:4637`
`checkSharedContractsHoldShapesOnly()`,第 7087 行调用。**又做了一次反证**:临时往
`packages/shared/contracts/` 放一个 `export function` → `[boundary] failed: packages/shared/contracts
holds serializable shapes only (no @onething/* import, no defineRouter, no behaviour)` 红 → 删掉复绿。

### 7.3 `gate:search-index` ⑤c 是存量,不是本轮

判据不是读注释,是**在 HEAD 上跑同一道门**:临时 worktree 检出 HEAD、整目录软链 `node_modules`、
`server:build` 之后跑 `gate:search-index` —— HEAD 读数 **p99 7.672ms**,工作区两次读数
**7.578 / 7.504ms**,也就是说工作区**比 HEAD 略好**,不是回归。两边其余检查全绿。
病根与 §4 第一条同一件:整键重折,worker 侧的设计代价。**同一单**(检索 worker 按会话去抖 /
增量折,门改判主线程)一并解决。曾怀疑是工单 5 新加的 `durable-json` fsync 把主线程压住,
HEAD 对照读数把这条排除了 —— 记在这里,免得下一个人重走一遍。

### 7.4 留账汇总

**工单 1(锁与关机链)**
- 8s 总死线是「MCP 3s + ACP 3s + 余量」凑出来的,不是量出来的;真机上 quiesce/drain 各阶段的实测分布没有读数。见单 1 交卷。
- 其余见单 1 交卷。

**工单 2(撤回 sync)**
- `packages/client/transport/queue.ts` 有界队列**零消费者**——工单 3 已按此删。
- `docs/design/backend-work-summary-2026-09-07.md` §3「同步与重连」补的撤回一句、`backend-performance-2026-09-06.md` 文首那行(脚本与三份读数已随协议删)——工单 4 F.2 接手。
- 其余(逐文件「保留了什么与 sync 无关的 GPT 改动」)见单 2 交卷。

**工单 3(砍)**
- `cancelTool` 回了空操作,但 `ToolExecutionRegistry.cancel`(授权 + abort + 等 `drained`)整份实现**留在树上**并有 `__tests__/tool-execution-lifecycle.test.ts` 钉着;要把「取消按钮变真」重新合上,**是一单独立小单,且要用户先点头**(§3)。
- 其余见单 3 交卷。

**工单 4(修回归)**
- `dispatch.ts` `stop()` 之后 `reportBack` 静默早退(triage B 行「记一笔」),未修。
- `currentSessionId` 指向已删会话被静默清空:§3 判为**保留**(算修 bug),但没有 UI 提示,记一笔。
- scratchpad `move()` 非原子:保留 GPT 实现,记一笔。
- 其余见单 4 交卷。

**工单 5(结构)**
- `voice.ts` 的 `synthesize` / `testTTS` / `runtimeReady` / `runtimeEvent('none')` 与 `getState/stop` 同病(见单 5 规格 §7 的小项表),是否已统一成「只有写那条会话的口才校验归属」见单 5 交卷。
- RPC 授权契约化只迁了三个样板域(`sessions` / `chat` / `scratchpad`),余下 24 个域的迁移表在 §6,**另立单**;口径「能自述的才迁」。
- 墓碑 GC(删除意图 complete 且超 7 天即删)是否落到常量,见单 5 交卷。
- 其余见单 5 交卷。

**工单 6(门)**
- `gate:search-index` ⑤c 与 `gate:perf` ④ 两条存量红同源(整键重折),归 §4 第一条那一单。
- `gate:stream-structure` V2 的门预算裁定(把 Dock 绕行挪到 `sendTrigger()` 之前)与「素材要重做」(§4 第二条)仍在账上。
- **`gate:web-shell:react` 这个脚本名已经不存在**:React 那两条早已接管 `web:dev` / `web:build` / `gate:web-shell` 的原名,仓根 `CLAUDE.md` 的 Build 一节仍写着旧名 `gate:web-shell:react`,该改。
- `apps/desktop-react/{dist-strict,ds-bundle,.ds-sync}` 三个产物目录没进 eslint 忽略表,`lint:ci` 的 11959 error 里 11850 条来自它们 —— 这道门今天等于没有判据,该把忽略表补上再谈。
- 工作区里有一批与本轮完全无关的未跟踪文件 `outputs/piano-video/**`(6 个,09-06 的钢琴视频产物)与 `outputs/.DS_Store`,**六笔切提交都不该收它们**,切完 `git status --short` 会剩这几行,属预期。
