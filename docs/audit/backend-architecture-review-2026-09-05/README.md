# 后端架构审查 · 2026-09-05

当前最需要修的是**写入所有权、持久化确认、断线恢复这三条可靠性边界**。多用户部署还需要补齐资源授权。模块拆分应排在这些行为修正之后。

现有后端已有可保留的骨架：宿主与 core 分离、统一 RPC、后端组合根、事件账本与投影、集中资源释放。问题主要在于部分接口宣称的保证，比实现真正提供的保证更强。

本次基于工作区当前代码，HEAD 为 `a8fe5b04`；保留了原有未提交修改。审查覆盖 Electron/server/CLI 启动路径、backend/runtime/core、会话存储、RPC 与客户端事件传输。核对了 9 月 4 日的审查材料，以下代码位置及验证结果重新取自当前工作区。本次只新增审查资料与隔离验证，没有修改业务实现。

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

| 编号 | 优先级 | 问题 | 验证程度 |
|---|---|---|---|
| R1 | P1 | 一个存储目录可能有多个写入进程；现有锁也有竞争窗口 | 启动链静态确认；锁竞争确定性复现 |
| R2 | P1 | 写入或 fsync 失败后，刷盘仍可报告成功 | 两种故障注入复现 |
| R3 | P1 | 默认客户端重连不能补回断线期间事件 | 真实 runtime 订阅接口复现 |
| R4 | P1，限需要隔离用户的部署 | 会话读接口检查归属，通用命令接口可绕过归属 | 真实 RPC 分发链＋引擎替身复现 |
| R5 | P2 | Electron 的信号退出跳过异步收尾 | 静态确认，未向用户运行中的应用发信号 |
| R6 | P2 | 业务模块内部装配与全局状态，让分层边界难以独立维护 | 依赖图及门禁实测 |

P1 表示应优先修复的数据、可靠性或隔离缺口；不表示这些问题在每次运行都会触发。R4 的前提是部署需要不同用户互相隔离；本机单用户、凭证不共享时，不应据此宣称存在未认证远程入侵。

## R1：把“一个目录一个写入进程”变成强制约束

**触发场景：**两个 standalone server 使用同一个默认存储目录，或桌面与 server 同时冷启动。

server 的启动检查只有在已有记录的 `owner !== 'server'` 时才进入阻止逻辑，两个同类 server 会绕过；`--force` 也允许继续。参见 [server 启动入口](/Users/yitiansong/data/code/start-electron/apps/server/src/main.ts:71)。桌面的“探活，否则自己创建 backend”同样是检查后再行动，见 [Electron 启动入口](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/main.ts:424)。两者都没有在写入前获取跨进程排他所有权；组合根的重复装配检查只检查进程内的当前实例，见 [backend 装配](/Users/yitiansong/data/code/start-electron/packages/backend/backend.ts:336)。

事件日志的序号在各进程内分配。已有的外部写入检测依靠文件字节数，且每 500ms 最多检查一次，属于发现冲突后的拒写机制，不能防止初次并发追加分配相同序号。参见 [外部写入检测](/Users/yitiansong/data/code/start-electron/packages/backend/session/event-log.ts:315)及[序号分配](/Users/yitiansong/data/code/start-electron/packages/backend/session/event-log.ts:481)。一旦重复序号进入账本，基于序号区间的替换和重放就可能处理错误历史。

**补充发现：已有 StoreLock 也不能直接当作完整修复。**CLI 使用了它，但实现先以 `wx` 创建空文件，再写元信息；另一申请者在空文件窗口读到 `null`，会把它当成陈旧锁删除。参见 [锁获取与陈旧清理](/Users/yitiansong/data/code/start-electron/packages/onething-runtime/src/storage/store-lock.ts:67)。隔离用例在“创建完成、元信息未写入”处模拟进程被抢占，两次 `acquire()` 都成功返回。这是确定性交错验证，未做操作系统多进程压力测试。

**建议：**在所有宿主共同使用的 backend 装配边界取得存储写入租约；持有到停止接收工作、排空写入之后再释放。先修正锁初始化与陈旧回收的竞争规则，再接入所有宿主；发现文件只负责找到服务地址。`--force` 不应绕过同一目录的写入排他约束。

**验收：**两个进程竞争同一目录时，至多一个进入写入阶段；覆盖元信息未完成、陈旧锁回收、异常退出以及不同目录可同时使用的场景。

## R2：持久化接口缺少可信的成功回执

**触发场景：**某次异步追加失败，或者 fsync 返回 I/O 错误，调用方随后等待刷盘完成。

`appendSessionLogEvent()` 先分配序号并更新内存，再排队追加；队列捕获异常后只记录 `writeFailure`。参见 [追加队列](/Users/yitiansong/data/code/start-electron/packages/backend/session/event-log.ts:495)。`flushOneSessionEventLog()` 等待这条已吞掉异常的队列，却不检查 `writeFailure`，见 [刷盘入口](/Users/yitiansong/data/code/start-electron/packages/backend/session/event-log.ts:625)。`fsyncSessionLog()` 又捕获所有异常并正常结束，见 [fsync 实现](/Users/yitiansong/data/code/start-electron/packages/backend/session/event-log.ts:700)。

本次复现了两个独立结果：

- 第 2 条追加返回序号 2，实际文件仍只有第 1 条；`await flushSessionEventLog()` 正常返回。第 3 次写入才抛出第 2 次的失败。
- 注入 fsync 的 `EIO` 后，刷盘仍正常返回。

这意味着“已排空并 fsync”的接口契约不成立，内存所见可能比可靠保存的事实走得更远。流式记录器的请求、工具检查点还使用 `void flushSessionEventLog(...)`，调用方不会等待它；见 [工具检查点](/Users/yitiansong/data/code/start-electron/packages/backend/wiring/engine/stream/session-event-recorder.ts:939)。run 结束路径也主动吞掉刷盘失败，见 [run 收尾](/Users/yitiansong/data/code/start-electron/packages/backend/session/runs.ts:311)。

另一个相关语义应写清：RPC 的 `success` 当前表示事件总线接收完成。总线不会等待异步订阅者，参见 [RPC 命令回执](/Users/yitiansong/data/code/start-electron/packages/core/events/ipc-operations.ts:69)与[总线分发](/Users/yitiansong/data/code/start-electron/packages/core/events/event-bus.ts:351)。隔离用例确认，业务订阅者尚未结束时已经返回成功。异步接受命令本身是合理设计，但不能让客户端把它理解为业务完成或已经持久保存。

**建议：**先修持久化语义：刷盘必须检查追加失败，并上报真实 fsync 错误；关键副作用前的检查点应可等待，失败要阻止该副作用继续。对命令区分“已接受”“已可靠保存”“执行完成”，用可关联的操作标识查询结果；对允许重试的写命令明确去重规则。不要为了修这个问题把所有事件订阅者改成串行等待。

**验收：**注入追加和 fsync 错误时，可靠提交接口必须失败；关键操作不能越过失败的持久化检查点。正常提交后的冷启动重放应得到相同事实。

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

## R3：默认订阅的续播协议实际没有闭合

**触发场景：**桌面或 Web 客户端短暂断线，期间会话产生新事件，随后连接恢复。

客户端默认请求 `/api/events`，重连携带一个数字 `after`，没有指定 `sessionId`，见 [HTTP 客户端](/Users/yitiansong/data/code/start-electron/packages/client/transport/http.ts:181)。HTTP 层把缺省会话设成 `*`，并把 `after` 继续传给 runtime，见 [SSE 入口](/Users/yitiansong/data/code/start-electron/packages/backend/server/http.ts:460)。runtime 只对具体会话执行 replay，`*` 分支直接订阅后续事件，见 [订阅实现](/Users/yitiansong/data/code/start-electron/packages/backend/server/runtime.ts:2230)。

**实测：**先产生事件再以 `afterSeq: 0` 订阅，具体会话收到历史事件，通配订阅收不到；通配订阅能正常收到之后的新事件。因此“已经重新连接”不能证明缺失内容已经补齐，界面可能继续显示旧状态。

也不能仅删除 `sessionId !== '*'` 解决：SSE 的 id 来自每个会话各自计数的 EventBus sequence，跨会话会重号、倒退；它不是持久账本游标。总线缓存还会因容量上限或进程重启丢失，见 [事件序号与 replay](/Users/yitiansong/data/code/start-electron/packages/core/events/event-bus.ts:111)。

**建议：**先让重连显式触发相关会话与列表的重新同步，并定义“游标失效，需要全量恢复”的协议。需要精确续播时，再选择每会话游标集合或具有明确作用域、epoch 的统一传输游标；避免让客户端用一个数字表达多个会话的进度。

**验收：**断线期间两个会话同时变化，重连后与完整快照一致；覆盖服务重启、缓存溢出以及最后一条事件恰好在断线窗口的场景。现有 SSE 测试只验证具体会话续播，未覆盖默认客户端路径。

另有待压测的传输风险：[writeSse](/Users/yitiansong/data/code/start-electron/packages/backend/server/http.ts:728)未检查 `response.write()` 的返回值，也没有慢连接缓冲上限。高事件量下应限制每连接积压，溢出后断开并要求重新同步；本次没有测得实际内存增长，不把它写成已发生的故障。

## R4：身份上下文没有统一落实为资源授权

**触发场景：**服务被用于需要用户隔离的场景，某个已认证用户知道另一个用户的 sessionId。

正常会话读取会调用归属判断；但通用 RPC 的 `session-command.emit` 在 HTTP 分支直接使用请求中的 sessionId 执行 abort、权限应答或发往总线，没有核对该会话属于 context 中的 owner，见 [命令处理器](/Users/yitiansong/data/code/start-electron/packages/backend/rpc/domains/session-command.ts:188)。通用分发器只核对域和方法是否注册，没有代做资源授权，见 [RPC 分发](/Users/yitiansong/data/code/start-electron/packages/backend/rpc/registry.ts:101)。

**实测：**为 Alice 创建会话，Bob 的会话列表看不到它；以 Bob 的 HTTP context 调用真实通用 RPC 分发链，仍返回 `{ok: true, data: {success: true}}`，引擎替身收到对 Alice 会话的 abort。验证替换了引擎执行端，没有终止任何真实会话，也没有调用运行中服务。

身份来源也需要明确定义：配置共享 Token 后，`userId/workspaceId` 直接取自请求 Header，Token 并没有在服务端绑定到某个用户，见 [请求上下文](/Users/yitiansong/data/code/start-electron/packages/backend/server/http.ts:649)。这适合“共享凭证代表同一个可信操作者”的模式，不能直接提供独立用户隔离。

**建议：**在命令应用层提供统一的“获取当前身份有权操作的会话”入口，让所有传输共用。多用户模式中，凭证应解析为服务端确定的身份；即使身份可信，具体会话、权限申请等资源仍需授权检查。若产品只支持单用户，应明确该部署限制，避免 owner 字段给出多用户安全保证的错觉。

**验收：**用户 B 对用户 A 的会话执行发送、重试、删除、abort、权限应答都被拒绝，且不触发引擎副作用；不能只验证列表过滤。

## R5：Electron 的两条退出路径提供不同的数据保证

普通窗口退出会阻止退出并等待 `backend.dispose()`，这部分已经具备正确形状。但 SIGTERM/SIGINT 处理器只删除发现文件，然后 `process.exit()`，见 [信号处理](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/main.ts:489)。

**触发场景：**开发重启、进程管理器终止或用户发送退出信号时，还有排队的会话写入、子进程或后台任务。它们不会经过已登记的异步清理链。强杀本来无法保证收尾，但普通退出信号有机会执行有界清理，当前主动跳过了这个机会。

**建议：**窗口退出与信号退出共用幂等、有超时预算的 shutdown：先停止接收新工作，再停止引擎和后台任务，最后排空存储并释放进程所有权。

**验收：**在隔离的桌面宿主测试中，带待写数据发送 SIGTERM，确认收尾执行及最后一个可靠检查点可重放；另测清理卡住时能按预算退出。

## R6：边界已画在包名上，但部分依赖仍靠全局槽和调用顺序维持

这里是维护与演进风险，不宣称当前必然崩溃。

本次以 TypeScript 解析和模块解析建立静态值依赖图：扫描 backend、runtime、core、shared 共 1,288 个非测试 `.ts` 文件，排除类型专用导入与导出，得到 3,990 条范围内依赖、6 组非平凡循环，规模为 18、5、3、3、3、2。动态导入和范围外依赖不在此统计内。

最直接的两组证据：

- Store 引用 Commands，而 Commands 又导入 Store 的读取、保存、刷新等实现：[stores/sessions.ts](/Users/yitiansong/data/code/start-electron/packages/backend/stores/sessions.ts:29)、[session/commands.ts](/Users/yitiansong/data/code/start-electron/packages/backend/session/commands.ts:59)。Commands 已提供端口工厂，却在模块末尾自行绑定生产实现并保存 singleton，见 [生产装配](/Users/yitiansong/data/code/start-electron/packages/backend/session/commands.ts:537)。
- Writer 和 Surface 双向引用：[event-writer.ts](/Users/yitiansong/data/code/start-electron/packages/backend/session/event-writer.ts:53)、[event-surface.ts](/Users/yitiansong/data/code/start-electron/packages/backend/session/event-surface.ts:33)。最大的 18 文件循环还连通了工具目录、协作、目标续跑和引擎接线。

装配门禁实测仍有 63 个文件、99 个模块级 `let`。它证明本次没有新增这类状态，不证明现有状态已经实例隔离。当前实例槽与“同进程拒绝第二次装配”是显式的一进程一 backend 设计；在当前产品前提下可以保留，但测试隔离和未来多实例能力不能只靠 `OnethingBackend` 是 class 来推断。

另一个拆分候选是 4,367 行的 `server/runtime.ts`：同一文件同时承担服务装配、owner 设置缓存、会话存储适配、文件沙箱和会话用例。具体入口包括 [runtime 装配](/Users/yitiansong/data/code/start-electron/packages/backend/server/runtime.ts:946)、[设置读取](/Users/yitiansong/data/code/start-electron/packages/backend/server/runtime.ts:3173)、[存储适配](/Users/yitiansong/data/code/start-electron/packages/backend/server/runtime.ts:3276)、[文件沙箱](/Users/yitiansong/data/code/start-electron/packages/backend/server/runtime.ts:3905)。文件长度只是导航信号，职责混合和依赖方向才是拆分理由。

**建议：**先把 Session Commands 的生产端口绑定移到组合根，让 Store 与 Commands 单向依赖；再把 Writer/Surface 的观察者接线移到会话子系统工厂。后续按明确职责抽出 Session 应用服务、Owner 策略、存储适配和事件交付，让 server runtime 只负责组合。不要一次性搬目录，也不需要为此改成微服务。

**验收：**循环数量按批下降，命令单测能只注入端口而不拉起整套 Store；每轮拆分保持 RPC 行为与事件重放结果一致。现有幂等、逆序清理和装配失败回滚应保留。

## 验证记录与修复顺序

| 检查 | 结果 | 能说明什么 |
|---|---|---|
| 现有 5 个相关测试文件 | 70/70 通过 | 现有断言满足；并不覆盖所有新发现 |
| 本次隔离缺陷验证 | 6/6 通过 | 这里的通过表示缺陷被复现，不能当作修复验收 |
| assembly gate | 通过，99 个已知状态槽 | 状态槽数量没有增加 |
| transport gate | 通过 | 传输分支等既有指标没有恶化 |
| boundary gate | 失败 | 命中了桌面构建产物中的原始控制字符，见下述说明 |
| 值依赖图 | 6 组循环 | 当前静态依赖结构仍有环 |

现有测试文件为 `event-write-failure.test.ts`、`event-log-s1.test.ts`、server 的 `http.test.ts`、client 的 `http-transport.test.ts`、`store-lock.test.ts`。

边界检查失败的具体位置是 `apps/desktop-react/dist-strict/assets/mermaid.core-Dq696-bW.js:270`，包含字节 `0x01`。这是构建目录被扫描到的问题，本次没有发现它对应 backend 分层违规，也没有改动或删除该产物。应核对门禁的产物排除范围，不能据此声称所有检查通过。

隔离复现保存在 [repro.test.ts](/Users/yitiansong/data/code/start-electron/docs/audit/backend-architecture-review-2026-09-05/repro.test.ts)，使用独立临时存储。由仓库根目录运行：

```sh
node node_modules/vitest/vitest.mjs run docs/audit/backend-architecture-review-2026-09-05/repro.test.ts --config docs/audit/backend-architecture-review-2026-09-05/vitest.config.ts
```

修复时应把这些“证明当前缺陷”的断言改成正确行为的断言，再纳入常规测试。SSE 验证使用真实 runtime 与 echo 后端；权限验证使用真实 RPC 和引擎替身；没有执行真实模型调用、真实用户操作或生产性能压测。本次并非全仓穷尽审计。

建议按三个批次推进：

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

1. **可靠性修复：**R1 单写入所有权、R2 可靠提交、R5 有界退出。若已经存在共享服务或用户隔离需求，R4 同批处理。
2. **客户端恢复：**R3 重连同步、游标失效和缓存溢出处理，再验证慢连接积压。
3. **结构收口：**R6 先拆 Session 依赖环，再抽 server runtime 的职责。对每批修改保留重放与传输行为验证。
