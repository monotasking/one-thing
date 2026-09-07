# Backend 资源所有权审计（2026-09-06）

本清单对应架构方案 §9.3 的“每个受管写者、订阅、后台任务可追溯创建者及释放位置”。检查对象包括 Backend 的资源注册表、原 assembly 门禁列出的 59 个文件，以及门禁不统计的模块 `const Map/Set`、定时器、事件监听、脱离调用者返回值的 Promise 和无 `sessionId` 模型调用。

**清单存在不代表验收完成。** 下表将实际完成并验证的路径、进程级兼容状态和明确的验证范围分别标明。源码统计只用于发现候选，不能证明取消、等待或释放正确。只清空 Map、只 abort、只结束 `Promise.race` 的响应均不算真实任务已结束。

2026-09-07 的 macOS 完整回归曾出现 953 个文件、9421 条断言通过但进程 exit 1：inspector 的迟到 timer 在 Backend 释放后读 SessionLayer，形成未捕获异常。原清单将它归到可选的 collab actor shutdown，遗漏了 `collab: false` 的生产 MindPort 使用路径，也没有证明清表后入口不能重新建 timer。下表已按这次实际发现纠正所有者；不能用此前绿色的定向测试否认这个遗漏。

## 退出顺序与所有者

[`BackendResources`](../../packages/backend/lifecycle.ts) 按 `quiesce → drain → resources → flush → endpoints → release → restore` 执行，同阶段逆注册序。所有阶段共用一个截止时间；超时或清理失败不会继续释放 store lease 和切换宿主端口。迟到登记的清理 Promise 仍在 running 表中，退出错误带 pending 标签。

[`OnethingBackend`](../../packages/backend/backend.ts) 是 store lease、当前装配和资源表的所有者。普通 RPC 由 `runTask` 保留实际返回的 Promise；后台继续工作的 RPC 必须另外登记实际后台工作，不能因为入口响应结束就退出任务表。场景取消和全局退出共享实际任务所有权，但无会话工作归插件、评测或服务本身，不能伪造 `sessionId`。

| 资源 | 创建者 / 固定归属 | 停止接收与取消 | 等待、释放位置 | 实际证据与边界 |
| --- | --- | --- | --- | --- |
| Store lease、格式能力、环境与宿主端口 | Backend assemble；先取得固定 store lease | Backend 关闭闸 | `storeLease/release`；`hostPorts/restore`；16 格 host port 逆序撤回 | `__tests__/lifecycle.test.ts`、`assembly-lifecycle.test.ts`；失败与总截止时间保留 lease |
| RPC/传输请求 | Backend `activeTasks`、HTTP server 实例 | RPC 域卸载、HTTP 停止新请求 | `activeRequests/drain`；server runtime dispose | 实际 HTTP admission/lifecycle 测试；不自动涵盖 detached 工作 |
| 事件队列、blob/checkpoint IO | `acquireSessionEventLogStore` 的固定路径 owner | writer 闸与 store ownership 检查 | `flushSessionEventLedger/flush`，等待各 state queue 和 pending checkpoints 后释放 | `session/__tests__/event-log-store-lifecycle.test.ts`：A/B 同 session ID、真实 IO 延迟、失败；性能报告另见下方 |
| SessionLayer、投影、历史 recipe、删除协议 | Backend 创建 session layer；会话/删除 owner | 保留句柄拒绝关闭后的访问；删除 admission | session layer dispose、deletion drain、索引与 pending saves flush | `assembly-event-lifecycle.test.ts`、删除/恢复协议测试；读取 facade 并非另一个事实来源 |
| Agent 文件缓存与初始化 IO | `createOnethingAgentStore` 按 resolved agentsPath 创建缓存/初始化 binding；Backend await initializeAgents | 后续路径切换建立新 binding，不沿用旧 state；同步写在当前调用内完成 | 异步初始化在 await 前捕获原 binding，迟到规范化只写原文件；旧 binding 随已完成调用释放 | runtime 3 文件 27 例：A→B→A 不做 reset、同 ID 分别存在；A 真实读取暂停时 B 独立初始化，A 迟到写不覆盖 B；旧 facade 测试移除了掩盖跨目录问题的 invalidate |
| Ledger event broadcaster | 每次安装捕获自己的 EventBus、每会话 Promise 链 | uninstall 同步停止 observer | uninstall 等已接收链完成，再清链/卸安装 | 新增真实 A/B EventBus + 延迟 handler 测试：旧事件仅到 A，退出等待最后一条；与 layer 测试共 2 文件 7 例通过 |
| Outbound IM 发送与回执 | 每个 engine layer 创建 `OutboundReplyDispatcher`；固定 `channel-identity.json` 路径；发送开始捕获 connector hooks | `outboundRepliesAdmission/quiesce`；停止后拒绝新发送与过早重启 | `outboundRepliesDrain/drain` 保留真实 connector Promise；失败回执落旧 store；回执 IO 失败阻止释放 | `channel/__tests__/outbound-reply-lifecycle.test.ts`：延迟成功/失败、重复发送去重、A/B 路径和 hooks 隔离、真实 StoreLock + 总截止时间；相关 6 文件 26 例通过 |
| 影子统计缓存与 1 秒落盘 timer | 缓存记录自己的文件路径 | journal flush 取消 timer | flush 写缓存创建时的路径；加载 B 前刷新 A，B 不继承 A 的计数和 warn 去重 | `event-stats-ownership.test.ts`：真实 A/B 文件，不调用 reset 完成切换；诊断写入保留原有 best effort 策略，不是事实账本 |
| Variable registry 广播、microtask、异步 list | `createVariableSnapshotBridge` 捕获 registry、EventBus 和本安装 pending 集合 | disposer 同步退订并关闭排队 refresh | 等真实 provider list / emit Promise 后 registry reset | `variables/__tests__/snapshot-bridge.test.ts`：真实 registry、真实 EventBus、延迟 provider；排队任务停止后不读新 store，迟到结果不进入 B；与统计回归 5 文件 23 例通过 |
| TOC、任务派工 | 每个 Backend 的 trigger/dispatch layer | `sessionTocAdmission`、`taskDispatchAdmission` | 各自 drain；实际任务 Promise 进入 Backend | `wiring/toc/__tests__/lifecycle.test.ts` 和 task dispatch 生命周期测试 |
| 工具、终端与 detached 子进程 | `ToolExecutionRegistry`、具体 tool owner、Backend | registry quiesce/cancel；向真实执行与清理传 signal | registry drain；killAllTerminals / killTrackedDetachedChildren | `__tests__/tool-execution-lifecycle.test.ts`：实际 Backend lease、延迟 cleanup、旧 registry 与新 Backend 隔离 |
| 交互终端 PTY、强杀 timer、退出通知 | TerminalService 持有可见 terminal 与 pendingExits；从列表移除仍保留实际 exit Promise | kill 发 SIGHUP，关闭记录不再广播输出；进程组未结束时保留原 SIGKILL 阶段 | `killAllTerminals` 返回 Promise，由 Backend 原资源项 await；实际 onExit 与原进程组消失后清 timer、完成退出 | 4 文件 35 例通过、Node 类型通过：真实 zsh 的 onExit 已到且 PID 不存在后才删除临时 ZDOTDIR；单测覆盖此前 kill 移除的终端仍被 killAll 等待、迟到输出隔离、进程组存活时不提前完成。没有重试删除或吞清理异常 |
| 插件模型调用（允许无 session） | Backend `pluginModels` + 每 PluginState 的 `PluginLlmScope`；调用前捕获 usage recorder | Backend quiesce；disable/uninstall/refresh/shutdown 关闭该 scope 并 abort | 入口可先报超时，但原 provider Promise 留在 scope 与 Backend.runTask；Core manager await drainPlugin；signal listener/finally 解绑 | `__tests__/plugin-model-lifecycle.test.ts` 4 例，覆盖未加载完的 entry、忽略 abort、同 ID 重启及真实 Backend A/B；扩展 76 文件 995 例通过、2 条条件跳过 |
| 全局 usage 账本、buffer、flush timer、append IO | Backend lease 后创建固定目录 `OnethingUsageLedger`；异步生产者提前 `captureUsageRecorder()` | close 拒绝后续写，已失租也拒绝 | producer drain 完成后 `usageLedger/flush`；真实 append 串行排空；绑定最后 restore | runtime usage 生命周期测试：阻塞 append 不提前 close、固定目录、IO 失败；迟到插件 usage 只进 A，B 打开后旧 recorder 拒绝 |
| 插件 manager / bootstrapper | 精确 manager 实例 | Core PluginState disposed、scope quiesce | async shutdown 幂等；bootstrapper 只释放相同实例 | catalog broadcast 测试覆盖 A/B manager 与重复旧 shutdown；旧 manager 不 detach B |
| Evals run/replay/analysis/diagnose/roundReplay | Backend `EvalsTaskOwner`；caller 捕获 usage recorder 与 owner signal | 关闭所有入口，取消后保留 busy 到真实完成 | `evalsTaskDrain` 等模型和最终文件 IO | `evals-lifecycle` 等 3 文件 9 例：真实本地 HTTP、取消、最终文件 IO、lease 持有、冷重装；主任务提供执行结果 |
| Practice ticker/账本 | Backend.parts.practice 持有固定 lease 路径下的 PracticeService | `practiceAdmission/quiesce` 停 ticker、结算活动练习并关闭账本入口 | `practiceDrain/drain` 等实际 config/ledger IO；`practiceBinding/resources` 释放 | `__tests__/practice-lifecycle.test.ts` 与相关回归共 7 文件 36 例通过；执行结果由负责该切片的 agent 提供 |
| Voice、ASR/TTS、speech chain、音频订阅/timer | Backend 创建 voice service；捕获宿主端口；请求属于该 service | voiceAdmission：拒新、abort、停录音/唤醒、退订回复、清 timer、关闭运行时窗 | voiceDrain 等实际 ASR/TTS、AudioRouter 内部 connect/finish 与 speech chain；Doubao 缓存按 service signal 分开，abort 清缓存/idle timer | 9 文件 57 例通过：真实 Backend A/B、延迟且不配合 abort 的 provider；fetch 取消适配、底层连接工厂迟到、握手前关闭、缓存/计时器归属。没有请求外部语音供应商 |
| Todo watcher 与待办 store | 固定 Backend `TodoPlanRuntime`，watcher 与写入口共用 store/self-write 去重；lease/capability gate 后、首个服务读配置前清 Settings 缓存 | quiesce + generation fence；停止前开始的 mkdir 不再创建 watcher，旧 runtime 拒绝重启 | `todoPlanDrain/drain` 等真实 open 与 FSWatcher close，`todoPlanRuntime/resources` 释放实例 | `todo-watcher-lifecycle.test.ts`：实际 settings RPC 改目录、A 关闭时挂起 mkdir 保留 lease、B 不继承 A 配置；runtime `watcher-lifecycle` 验证 stop/start 与 OS 提前关闭；旧 watcher 测试验证实际磁盘通知和 self-write 去重。只读 prompt 路径查询无隐式 store |
| Music / radio / DJ patter / lyrics | Backend.parts.music 持有 MusicSubsystem，每代 service/radio/djVoice/operations 捕获固定 store、child env | `musicAdmission/quiesce` 关 scope、watcher、conductor，abort TTS，停止受管进程组 | `musicDrain/drain` 等实际模型/provider/child close 与后台 Promise；随后释放绑定 | `__tests__/music-lifecycle.test.ts` 与扩展回归共 18 文件 198 例通过：真实 A/B、本机 HTTP TTS 忽略 abort、真实 child 与 grandchild 退出；执行结果由负责该切片的 agent 提供 |
| 插件 credential strategy select | Backend `CredentialStrategyService` 与 PluginState 的 scope；同步 `decide` 后台 refresh 整体、内部原始 select 分别跟踪；scope 捕获 usage reader | `credentialStrategiesAdmission/quiesce` 与插件 disable/dispose 关闭 scope；registration 代次取消；每个 await 后核对身份与关闭状态 | `credentialStrategiesDrain/drain` 等真实账本读取和超时后仍未结束的 select；`credentialStrategyState/resources` 最后清决策/失败/缓存；超时只结束响应 | `__tests__/credential-strategy-lifecycle.test.ts` 3 例通过：真实 usage 文件暂停仍持 lease 且不进入 select；15ms 超时后忽略 abort 的 select 仍阻止释放；A 的 7 token/旧决策/失败元数据不进入 B 的 2 token/同 policy，旧 scope 和重复旧 dispose 不影响 B |
| Goal 重试 timer、pending usage、文件摘要 | bootstrap 实例的 `GoalRetryScheduler`；摘要捕获创建时 Backend.runTask | quiesce 清 timer、拒新 | drain 等实际 kick/扫描；session layer 释放前保存 pending usage，再清内存；旧 disposer 幂等 | 主任务 6 文件 33 例通过：45 秒重试不复活、37 token 冷恢复和后续 1 token 不混账、真实文件扫描暂停期间 lease 保留、摘要冷恢复可读 |
| Collab inspector 房间快照、节流 timer、事件发送 | 每个 Backend 创建独立 owner，包含 `collab: false`；捕获该实例 EventBus，并在读取前核验 Backend identity/closing | 关闭开始拒新；quiesce 清 rooms/source/timer；旧 timer 同时核验 owner 与 room state 身份 | drain 等实际 EventBus emit Promise；resources 身份安全解绑；actor runtime 单独释放自己的供数函数 | `collab-inspector-lifecycle.test.ts` 3 例：真实 Backend collab false/true、A→B 同房 ID、已出队旧回调失效、真实事件拦截挂起期间保 lease。与 digest/actor 真实组共 3 文件 14 例、原契约组 3 文件 62 例通过，无未捕获异常；Node 类型及结构门通过 |
| Collab actor 初始化、board 语义回调、mailbox IO | runtime 自己的 background Set、roomPending/agentPending 持有实际 Promise；Backend quiesce 阶段 await `shutdownCollabV3Runtime` | 先关订阅与 admission；停止后返回的未装配 mailbox 关闭并 flush，不再启动 actor | `drainRuntimeTasks` 等初始化；依次 stop 已装配 actor，再等后台恢复和所有 mailbox flush；board 直接写返回的 Promise 由 RPC/tool/worker 拥有 | `collab-actor-open-lifecycle.test.ts` 3 例通过：真实 agent/room mailbox read 挂起期间持 lease；A/B 不做 reset、B 同 ID 创建、旧 mailbox 禁写；既有调度另 4 文件 73 例通过。R5 已补齐：mailbox 保留 append/cursor 首个持久化错误；flush 等真实链再拒绝；已安装/未安装与清房释放路径统一收集错误，全部清理后汇总，Backend 拒绝退出成功并保留 lease。新增核心/真实 Backend 故障回归见验证记录 |
| Collab digest / MindPort 摘要 | Backend.parts.collabDigests 持有 runner；固定 lease 路径 digest store、创建时 usage recorder；controllers/inFlight 持有真实 auth/model Promise | `collabDigestAdmission/quiesce` 同时关闭 runner/store 并 abort；session deletion 调同一 owner 的 abortAndDrain | `collabDigestDrain/drain` 等包括超时后的真实 Promise；`collabDigestBinding/resources` 按身份释放；MindPort 创建时捕获 owner 并同步登记 finally 调度 | 6 文件 78 例通过：实际 Backend A/B、真实 TCP provider serializer/parser、挂起 auth/model、deadline、删除/身份变更、真实 MindPort 调度、60 天保留与旧 store 句柄；Node 类型通过，结果由负责切片的 agent 提供 |
| 删房通知后的 actor/mailbox 清理 | `onSessionsDeleted` 捕获创建时 runtime，在启动 disposeRoom 前登记 `trackRuntimeTask` | room 从已安装 Map 移除后，实际 stop/flush Promise 仍留在 runtime.background | Backend collab quiesce 的 `drainRuntimeTasks` 等待；迟到持久化错误进入 persistenceFailures，继续其他清理后汇总并保留 lease | `collab-mailbox-failure-lifecycle.test.ts` 新增真实删除期间挂起写入/失败用例；相关 6 文件 65 例通过、Node 类型/边界/装配通过，结果由负责该修复的 agent 提供 |
| MCP/ACP/SDK proxy | Backend 子系统实例、session/execution owner | admission、abort、连接/子进程取消 | 子系统 dispose + 实际调用与检查点确认 | 独立 capability/SDK 取消文档与测试；本审计不重复已验证协议工作 |
| HTTP/SSE、socket drain listener、stall timer | 每个 server/SSE delivery | 关闭入口；有界队列溢出明确 reset | 等 started frame、drain 或截止后断开并清 listener/timer | 主 `/api/events` 8 MiB 真慢读及真实客户端大 patch 恢复已验证；其他独立大 snapshot 通道边界见性能报告 |

## 原 59 个 assembly 文件逐项归类

这是原 gate 文件名册的逐项核对，不是生命周期完成率；后续删除一个全局变量不会使原文件从本审计消失。路径均相对于 `packages/backend/`。`绑定` 指撤回能力端口，不能推导该能力所启动的工作已结束；`进程` 指无 active writer 的常量/兼容缓存，仍列明失效边界。

| 文件 | 创建/状态 | 释放或归属结论 |
| --- | --- | --- |
| channel/connector-registry.ts | 插件/宿主注册 connector；hooks 单槽 | 注册返回按实例退订；发送捕获 hooks；真实发送由 dispatcher owner drain |
| channel/identity-service.ts | 惰性无缓存服务适配 | 同步读取 identity store；无 timer/listener；异步发送不借它的动态路径 |
| channel/identity-store.ts | 同步 identity store 适配 | 回执另有固定路径 adapter；修复缺省数组被读写共享到另一份空 store |
| channel/outbound-reply-dispatcher.ts | engine 创建专属 dispatcher；兼容 getter 保留 | 新增 quiesce/drain/固定回执；见上表实际测试 |
| channel/prompt-context.ts | 注入 prompt provider | engine dispose 注销；进程槽不拥有模型 Promise |
| channel/session-router.ts | 无独立 timer 的路由适配 | 同步查 identity/session；执行归调用层 |
| features/cordis-root.ts | 惰性 Cordis root context | root 无 timer/进程监听；每个挂载 feature 的 fiber/disposer 才拥有活动资源 |
| rpc/domains/evals.ts | 原后台 run controller/状态 | 迁入 Backend EvalsTaskOwner，入口响应结束不删除真实工作 |
| server/embed.ts | 当前内嵌 server 装配 | 返回 dispose；server/runtime 负责传输端口还原 |
| server/host-trust.ts | 宿主声明 | 按声明身份 restore；不是活动任务 |
| server/plugin-catalog.ts | 注入目录能力端口 | server 配置/还原；异步请求归 server/Backend |
| server/search-providers.ts | 注入搜索 provider 端口 | server 配置/还原；搜索服务本体另 dispose |
| session/event-broadcast.ts | 安装 owner 和发送链 | 本次改为捕获 EventBus + await chains |
| session/event-stats.ts | 缓存、timer、warn Set | 本次固定缓存路径；flush 清 timer；切 store 重新加载 |
| session/freeze.ts | 环境开关 | 进程诊断配置；不可把开关数量算作资源 |
| session/port-fact-assert.ts | 诊断 override 与有界 reported Set | 去重有容量上限；reset 用于诊断，不持有 IO |
| session/read-mode.ts | 外来 core warning 去重 | 进程诊断标记；无 writer/timer |
| session/testing/facade-mock.ts | 测试用 mock 槽 | 不在生产装配；测试 teardown 负责 |
| stores/docs-paths.ts | storePathHost 端口 | Backend hostPorts restore |
| stores/sessions.ts | 索引/cache/监听和 repository 适配 | SessionLayer/repository 的装配、关闭和 pending saves；真实 A/B 测试 |
| utils/ripgrep.ts | 可执行文件定位缓存 | 进程能力缓存；子进程的生命期归各实际工具执行 |
| wiring/auth/oauth-events.ts | 单 broadcaster；authService 两条进程监听 | 端口被 server 还原；两监听只安装一次且不随 Backend 卸载，属进程 authService，不能计作 Backend 已摘监听 |
| wiring/collab/actors/runtime.ts | room/agent actors、mailbox、judgment timers、pending open 与 background tasks | Backend quiesce await shutdown：关闭 admission/订阅、drainRuntimeTasks、关闭迟到未装配 mailbox，再停 actor、等后台恢复与 mailbox flush；见真实 A/B 证据。mailbox 明确持久化错误进入 runtime persistenceFailures；继续清理并最终 AggregateError；正常 board/model 业务错误仍按原有语义处理 |
| wiring/collab/agent-activity.ts | channels 与 registry 端口 | shutdownCollabAgentActivity 清表，collab shutdown 调用 |
| wiring/collab/external-observability.ts | sink、事件观察者 | install 返回 disposer，collab shutdown 撤回 |
| wiring/collab/inspector.ts | 每个 Backend 无条件创建的 inspector 拥有 rooms、snapshot source、timer 与实际 emit Promise | `collabInspectorAdmission/quiesce` 关入口清 timer；关闭开始即由 Backend identity/closing 闸拒读拒发；`collabInspectorDrain/drain` 等真实 EventBus Promise，`collabInspectorBinding/resources` 身份安全解绑。timer 捕获原 owner，并检查房间 state 身份；actor runtime 仅拥有自身 snapshot source 的 disposer |
| wiring/engine/triggers/index.ts | builtin trigger 安装闩 | 注册返回 disposer，Backend builtinTriggers 接住 |
| wiring/evals/events.ts | broadcaster 端口 | server 注入/还原；producer 另归 EvalsTaskOwner |
| wiring/evals/host-ports.ts | 宿主能力端口 | Backend hostPorts restore |
| wiring/external-agents/index.ts | connector 实例、可执行路径缓存 | disposeExternalAgentConnectors 等实例关闭；路径缓存不等于子进程 owner |
| wiring/gateway/host-ports.ts | 宿主能力端口 | Backend hostPorts restore；SDK/runner 的实际 Promise 独立拥有 |
| wiring/goals/runtime-hooks.ts | stream subscriptions、usage tick、每安装的 GoalRetryScheduler | quiesce 清 timer；drain 等真实 kick、保存 pending usage、清内存；旧 disposer 幂等 |
| wiring/logging/diagnostics.ts | 宿主诊断 callback 端口 | configureAppLoggingHost/reset；日志进程生命周期另见下一项 |
| wiring/logging/index.ts | 日志 sink 与宿主桥接 | host 创建的 logging 寿命可长于 Backend；Backend 自己配置的 logging 才登记 endpoints shutdown |
| wiring/music/radio.ts | MusicSubsystem 的每代 radio runtime；conductor/store、grant/cache/inflight | Backend music admission/drain，固定归属并等待真实工作；cache 清空在 producer 停止后 |
| wiring/music/service.ts | MusicSubsystem 的 service、now-playing watcher、sample listener | Backend music admission/drain/resources；不仅是 provider switch，正式退出亦覆盖 |
| wiring/permission/permission-grants.ts | 内部适配安装闩 | 进程内部 adapter，真实 Permission/Interaction 实例由 Backend shutdown |
| wiring/plugins/events.ts | progress broadcaster 端口 | server 注入/还原；插件 request/raw model 工作另归 manager/scope |
| wiring/plugins/host-ports.ts | 插件宿主能力端口 | Backend hostPorts restore |
| wiring/plugins/install.ts | npm 可用性 Promise、market URL/cache | 市场缓存/探测属进程；安装工作由调用 RPC/manager 拥有，不把缓存视作取消 |
| wiring/plugins/loader.ts | local/demolished ID、panel 声明缓存 | 插件扫描/刷新维护；manager 按实例 shutdown/释放 bootstrapper；不是模型 owner |
| wiring/project-dirs/index.ts | bootstrap 闩、注册能力 | 返回 disposer，Backend projectDirs 接住 |
| wiring/providers/builtin/github-copilot.ts | token/model 缓存 | provider/credential key 维度缓存；无 Backend 退出等待含义 |
| wiring/providers/credential-strategy.ts | Backend/PluginState scope、注册代次、决策、usage cache、detached refresh | 整体 refresh 与原始 select 独立持有；超时/撤销后的迟到结果不得写新 registration；Backend drain 后清瞬态状态 |
| wiring/providers/index.ts | 内部 provider adapter 安装闩 | 进程内部绑定；具体模型由 execution/service scope 拥有 |
| wiring/providers/space-credentials.ts | crypto adapter 安装闩 | 进程内部绑定；实际凭据选择后台工作见 credential strategy |
| wiring/scheduler/user-tasks.ts | userTaskHandles、scheduled callbacks | 各 handle stop；任务派工 owner 另 drain 实际运行，不以清 timer 代替 |
| wiring/search/providers.ts | 已装配 provider 适配闩 | 内部能力绑定；SearchService dispose 与插件 provider unregister 管实际实例 |
| wiring/settings/events.ts | settings broadcaster 端口 | server 按安装还原；不含 settings 副作用启动的 watcher |
| wiring/settings/host-ports.ts | 宿主设置能力端口 | Backend hostPorts restore |
| wiring/skills/loader.ts | 环境端口 + 内部 adapter 闩 | 环境端口 reset；内部 loader adapter 属进程能力 |
| wiring/skills/manage.ts | skill 管理 adapter 闩 | 无独立 timer/writer 的内部绑定；操作归调用 owner |
| wiring/skills/session-skills.ts | 初始化闩 | 初始化调用须由装配 await；技能注册本体由 catalog/loader 维护 |
| wiring/todo-plan/store.ts | hostPorts、Backend TodoPlanRuntime | Backend quiesce/drain/resources；等待实际 mkdir/FSWatcher close；绑定还原与活动资源清理分开 |
| wiring/toolkit/wiring.ts | built catalog、计数器、工具常量集 | catalog 安装由装配拥有；实际工具执行由 ToolExecutionRegistry |
| wiring/tools/core/sandbox.ts | sandboxHost 与内部 adapter 闩 | Backend hostPorts restore；实际子进程由工具 owner |
| wiring/usage/index.ts | 当前 usage 绑定 | 仅绑定 Backend 固定目录账本；最后 close/flush + restore |
| wiring/variables/index.ts | bootstrap 与 disposer 槽 | 本次 snapshot bridge 归属并排空，之后 registry reset |
| wiring/voice/service.ts | 当前 VoiceService 绑定 | 每 Backend 创建，quiesce/drain/释放绑定；见上表 |

## `const Map/Set` 与旁路资源补充

以下资源不会因 module `let` 门禁绿色而自动消失。

| 家族 | 具体模块与容器 | 所有权判断 |
| --- | --- | --- |
| 静态词汇/策略 | `rpc/domains/tools.HTTP_EXECUTABLE_TOOL_IDS`、`server/mcp-secrets.MCP_SERVER_PRIVATE_KEYS`、`settings-projection.sensitiveSettingKeys`、session command BODY/DERIVED/LEGACY keys、freeze TRUTHY/FALSY、room-folder SKIPPED_DIRS、skills musicSkillDirs、toolkit SIDE_EFFECT_GATE_TOOLS | 常量表，不是活动资源；不要求虚构 disposer |
| 事件/会话弱缓存与状态 | `delta-stamp.slots`、`stream-coalescer.debugLastSendAt`、`lifecycle-events.originStampCache`、`materialized-messages.memos/lists`、`refold.runCounts`、`runs.currentRuns`、session index/workdir caches | 弱引用由 key 生命周期约束；强 Map 由会话清理/装配释放约束。会话停止/删除/新 store 的真实测试比统计容器数量更有效 |
| 诊断去重 | content-part-guard.warnedTypes、projection-blobs.warned、port-fact-assert.reported、event-stats.warnedSessions | 不拥有异步 IO；有界/可重置的诊断状态，统计跨 store 已修 |
| 订阅/注册表 | `features/registry.mounted`、`rpc/registry.domains`、event-log.appendObservers、store session listeners、deeplink.actions、plugin-search.providers、variable gateway listener sets | 注册返回的 unsubscribe/dispose 是创建者凭据；Backend、feature、plugin或server须接住，不能用模块导入结束解释寿命 |
| 协作边表 | board-store.listeners/writeQueues/pendingBroadcasts、budget.cells、digest-runner.inFlight、say-tool.recentSays、wake-followup.pending | actor shutdown 清 activity/board广播/wake timer并等 mailbox；inspector 独立归每个 Backend，见上方纠正记录。board 直接写返回实际 Promise，由 RPC/tool/worker 拥有；board 语义回调另由 runtime background 集合拥有。digest 的实际 auth/model 与 MindPort 调度归 Backend collabDigests；不以清 Map 或 response timeout 代替等待 |
| 文件监听 | workspace-watch.watchersByScope/handlersByScope；todo watcher；server runtime 的工作区 watch | 订阅返回退订；`closeAllWorkspaceWatches` 和 runtime dispose 收底；todo 启动/关闭竞态另有 owner。平台 fswatch 行为需真实文件系统测试 |
| 插件状态表 | api.panelRefreshWindows/storeClosers/llmScopes、background.runtimeParams、sessions.triggerLedger/rateWindows、notify-sound.lastSoundAt | 插件 dispose 按 PluginState 清理；模型 scope 真实 drain；限流/去重表不是模型调用任务表 |
| 无 session 模型请求 | 插件 LLM、评测、音乐 DJ 等 | 按插件/评测/service owner 接入，固定 usage recorder。RPC 快速响应、插件 request race、30 秒 timer 都不能替代真实 provider Promise 归属 |
| 原生语音连接 | Doubao ASR/TTS factory、录音 final timer、TTS 空闲连接 cache | service signal 取消连接和缓存；工厂迟到返回必须立即关闭，握手前关闭必须结束 connect；缓存按 lifetime signal 隔离 |

## 验证记录与验收边界

- 本审计新增广播与 Outbound 的定向回归：6 文件 26 测试通过；另 5 文件 23 测试覆盖变量桥、统计、shadow 与关机 flush。两组有重叠，不相加成独立测试总数。
- 插件/usage 最终扩展回归：76 文件 995 测试通过，2 条原条件跳过；Node 类型检查、boundary 和 assembly 门禁通过；没有放宽基线。执行结果由负责该切片的 agent 提供。
- 评测实际生命周期：3 文件 9 测试通过；结果由主任务提供。
- Goal 实际生命周期：6 文件 33 测试通过；包含真实 Backend、文件扫描、冷恢复和退出等待；结果由主任务提供。
- Practice 实际生命周期：7 文件 36 测试通过；Music 实际生命周期及扩展回归：18 文件 198 测试通过。两者的 Backend owner/phase 已接入，结果由负责切片的 agent 提供；音乐验证包含本机 HTTP 与真实子孙进程退出。
- Voice 实际生命周期：9 文件 57 测试通过；Node 类型检查通过；assembly 与日志门禁通过，未改基线。`voice-lifecycle.test.ts` 使用真实 Backend、store lease 和重装；远端 ASR/TTS 由可控制的真实 Promise 代替，以验证不配合取消时仍等待，未进行外部付费调用。
- Todo 实际生命周期及兼容回归：Backend A/B、settings/todo RPC、6 个 prompt suite 与 runtime store 等 12 文件 82 例通过；另外本机实际 watcher 和 watcher-lifecycle 2 文件 6 例通过（其中生命周期 3 例与前组重叠）。受限文件系统环境首次运行收不到真实 watch/close 事件，因此这 2 文件在本机重验，1.51 秒完成；没有调大超时或放宽断言。最终覆盖为 13 个不同文件、85 个不同用例。
- Credential strategy 实际生命周期：新增 1 文件 3 例通过。测试使用生产同步凭证选择入口、真实 Backend/store lease、真实 usage 文件读取以及可控制但不配合 abort 的插件 select Promise；没有以 response timeout 代替实际完成，也未对旧调用做跨实例 reset。
- Agent store 路径归属：3 文件 27 例通过。缓存与初始化 Promise 随 resolved path 切换，晚到的规范化写固定原文件；测试显式验证同 ID 的 A/B 文件内容与不使用 reset 的兼容入口。
- Collab actor 与 mailbox：新增真实 Backend 1 文件 3 例通过，既有调度 4 文件 73 例通过。覆盖 board 语义触发的真实初始化读取、关机持 lease、迟到未装配 mailbox 不启动 actor，以及不同 store 同 ID 正常创建；执行结果由负责该切片的 agent 提供。
- Collab digest：6 文件 78 例通过、Node 类型检查通过。包含真实 Backend、TCP provider、固定 usage/store、超时后等待、删除/身份变更及真实 MindPort finally 调度；执行结果由负责切片的 agent 提供。
- Mailbox R5 故障传播：8 个不同文件 96 例通过、Node 类型检查通过。核心 3 文件 27 例、真实 Backend 2 文件 6 例、相邻 actor 3 文件 63 例；其中 6 条新例验证实际 append/cursor 文件错误、后续成功不清首错、挂起 IO、其他资源继续清理、未安装 mailbox 的错误保留及失败保 lease。与上方正常 actor/agent mailbox 回归存在重叠，不相加成独立总数。
- 交互终端实际退出：4 文件 35 例通过、Node 类型检查通过。全量发现 smoke 目录清理与 zsh 退出写历史竞争，根因是服务发信号后同步标记 exited、未等待真实 onExit；现已修成实际退出 Promise，Backend 自动 await 原资源项，真实 PTY 退出/PID 消失及原有 RPC 功能均已验证。
- 删除通知后的 mailbox 清理：后续独立检查确认 Map 移除前必须登记真实清理任务，已补齐固定 runtime 的 trackRuntimeTask；新增真实删除期间 IO 挂起及晚到失败回归，相关 6 文件 65 例通过。该组与上方 mailbox 回归重叠，不累加为独立总数。
- Inspector 的遗漏与修复：2026-09-07 完整 macOS 回归发现关闭后 timer 读已释放 SessionLayer，说明此前“collab shutdown 清表”的清单不足。现在由每个 Backend 无条件拥有其状态、timer 和真实 emit Promise；新回归及摘要/actor 实际链共 3 文件 14 例通过（主任务执行，`/tmp/backend-inspector-root-real.log`），原 inspector/actor/runtime 契约 3 文件 62 例通过（`/tmp/backend-inspector-contract-frozen.log`），均无未捕获错误。Node 类型、boundary/assembly/log 门与独立只读审查通过，基线未放宽；两组为本切片 6 个不同文件 76 例，不与前述重叠组累计。随后主任务在 macOS 与 Linux/arm64 用相同冻结源码分别完成 954 文件/9424 例完整回归，均 exit 0、无未捕获异常；最新真实 macOS 打包和退出也通过，详见 [跨平台证据](backend-platform-verification-2026-09-07.md)。
- SSE 主通道和文件系统 checkpoint 的真实基准、环境、样本、p50/p95 与明确未覆盖范围：[性能报告](backend-performance-2026-09-06.md)。不重复把吞吐测试当作所有后台资源退出证明。
- Collab mailbox 的 R5 保存失败传播已通过真实故障测试。写链保持原排队行为且不自动重放副作用，但首个持久化错误不会被后续成功清掉；所有实际 IO 和其余清理结束后，Backend 返回汇总失败并保留 lease。普通后台业务失败与保存失败分别处理，未把所有业务 rejection 都升级为关机失败。整体验收与发布 gate 由主任务统一执行；本文不替代它们。
