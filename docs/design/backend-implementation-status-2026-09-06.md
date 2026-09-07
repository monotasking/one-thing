# 后端方案实施台账

更新：2026-09-07，持续实施 [主方案](backend-maintainability-plan-2026-09-06.md)。**第一轮同步优化后的空闲恢复没有解决实际流式卡顿；第二轮已修复真实事件投影的历史重复物化，以及工具后正文的流式位置与刷新问题。前端 89 项、core 4 项、真实 Backend 缓存验证及桌面独占后端的 542 帧工具流式门通过。此前 stage11 的 macOS/Linux 同源全量结果不覆盖这两轮补丁；整体架构计划仍未完成，默认宿主启用、Windows/正式 runner、外部执行器完整覆盖及发行兼容继续保留为缺口。** 各平台及分组测试存在重叠，不累计为总数。

## 本次增量（长历史会话同步性能回退）

第一轮让服务端比较已持有的不可变快照与当前捕获，仅分离实际补丁值；客户端按变化路径复制，未变化的历史消息对象继续复用。数组新增和截短使用增量补丁，新增消息不再把全部历史放入回放队列。慢消费者只合并同一段未交付状态，普通业务事件、ready 和 invalidate 构成顺序边界，保留权限事件与前后状态的相对次序。同一轮 projection、EventBus 和索引通知合并捕获，列表变更仍覆盖相关会话的重新授权；关闭时同步停止新通知。

第一轮 4 文件/25 项组合验证及 desktop 构建通过，约 6.54 MB、233 条消息的合成状态完成 128 次更新，覆盖真实 HTTP/client、对象引用复用、慢消费和事件顺序，但没有覆盖真实 SessionService 每次读取时对历史节点重新物化、读取 blob 并校验哈希的成本。主进程 PID 15658 恢复后的低 CPU 和 HTTP 200 只证明启动与空闲界面恢复；用户随后仍遇到严重流式卡顿，并报告工具调用后的正文出现在工具之前。

第二轮在 events-reads 中按实例、会话、节点 revision 缓存物化结果；默认历史 DTO 与 live-ui DTO 使用独立缓存，改变的节点才重新物化并分离可变数据，旧快照保持隔离，会话清理同时释放缓存。同步专用 live-ui 读取提供带 partIndex 的未完成可见片段，默认历史语义不变；前端重新合并流式片段并按 rAF 合并发布，保留工具前后的位置及最终快照交接。前端 89 项、core 4 项通过；Backend 缓存定向组 2 文件/4 项及相关契约组 4 文件/25 项通过，Node/桌面类型与桌面构建通过。

真实 Backend 回归使用约 6 MB、233 条消息和实际 blob 文件，执行 128 次当前节点更新，确认历史节点不再重新读取 blob，旧历史对象及快照保持稳定，流式末条内容和顺序正确。作为正向对照，原先无缓存的物化算法单次捕获实际读取 8 次 blob、共 1 MiB；这不是旧发行版端到端性能认证。捕获与 diff 仍扫描消息字段，当前活动节点仍需按其实际内容物化，不能声称所有成本都只随新增 token 大小增长。

独立桌面门通过 `--owner=desktop --only=tool --pieces=6` 运行：桌面主进程 PID 67292 自己持有 owner=shell 的后端，采集 542 帧，A/B/D/E/F/G/H/T 全部通过，流式末帧结构与冷加载一致，工具后正文没有跨到工具之前；退出实际 code 0，PID 已消失。日志为 `/tmp/onething-streaming-desktop-gate-20260907.log`。这是短多工具场景的真实桌面渲染验证，与上述约 6 MB 历史的 Backend 回归分别证明不同路径，不能将它表述为长历史桌面 CPU 基准。

用户应用已恢复为主进程 PID 55335，HTTP 200、界面可用，最终空闲观察 main CPU 0.5%、renderer 0%。没有向真实用户会话自动发送模型测试；真实用户持续流式负载的最终 CPU 尚不能由空闲值外推。此次没有运行覆盖最新补丁的完整全量；现场、性能对照及恢复范围见 [发送消息后的卡死调查](backend-message-freeze-2026-09-07.md)。

并行的独立 CLI 锁诊断与离线恢复入口已完成，默认只读，恢复须显式提供审核身份和全部宿主停机的人工断言；真实 CLI 隔离集成 7 项通过。使用方法与限制见 [锁诊断与离线恢复](backend-store-lock-recovery-cli-2026-09-07.md)。该 CLI 切片不作为本次桌面同步修复或应用恢复成功的证据。

## 此前本机启动故障恢复

用户数据目录中 1.1.7 遗留的 PID 70476 旧锁阻塞了新后端启动。确认所有相关宿主退出后，已用既有离线恢复 API 原子归档准确身份的旧锁，重新构建启动桌面；新锁和发现记录对应同一存活进程，鉴权接口返回 200，桌面原有会话加载正常。重复退出信号、开发启动器过早强制停止及关联失败误报已修复，15 项组合测试与桌面类型检查通过，证据与当前验证范围见 [启动恢复记录](backend-startup-lock-recovery-2026-09-07.md)。下述 stage11 全量结果发生在这次退出增量之前，不能直接作为该增量的全量验证。

## 最近完整回归（stage11：文件监听与原生打包）

macOS 不再把 fs.watch 返回当作监听已就绪，改由独立原生流的 HistoryDone 确认；监听器和订阅者属于当前 server surface，RPC 在既有沙箱预检后使用私有绑定的窄端口。相同 scope/root 的两个 runtime 不会互相停止监听，退出从第一个 await 之前关闭新监听入口，再等待实际初始化及关闭。关闭后 SSE 返回正常错误，响应已经开始后的失败不再重复写 headers。

最终 macOS 完整 Node：980 文件/9,725 项通过，3 文件/9 项跳过，64.87 秒、exit 0，原样文件监听用例在全量通过。Linux 同源完整 Node：980 文件/9,724 项通过，3 文件/10 项跳过，78.50 秒、exit 0；额外跳过的是 macOS 原生包验证。3,712 个源码/配置文件摘要 `08ef1c12df9f098ad6bc6e5db43564430bc9e3fd4f7b72cd45e5d03057176f8d`，两平台运行前后未变。报告 `/tmp/backend-stage11-{macos,linux}-full-20260907-v1/`；跨平台类型缺口和外置构建问题均已修复。

三端已在两平台重新构建；实际 macOS 隔离应用包中，系统 Node 与包内 Electron 均完成监听启动、停止及真实进程退出。修复了单文件 unpack 规则导致的真实归档损坏，相关新旧打包组合 7 项通过。该包未签名、未发布或替换用户应用，不能外推为正式发行认证。源码、历史失败、包摘要与验证边界见 [stage11 实施记录](backend-workspace-watch-implementation-2026-09-07.md)。

## 上一增量（stage10：启动校验与资源所有权）

可选 preload 现在先按 SDK 实际 command/env/cwd 验证运行时，等待正式握手与探针真实退出后才启动 query。取消或校验失败不会迟到启动。Backend 在早期装配时拥有连接器注册表及失败回滚，旧引用和旧清理函数不能接管新实例。新增三端物理产物 resolver，尚未在默认入口启用。用户安装 Claude 2.1.259、Node 和 Bun 的最终正式探针均通过，三端最新产物一致。

全量回归暴露了日志流尚未真正关闭就删除目录的问题。插件清理现在拥有异步回调及实际 I/O，完成最终保存后关闭存储；管理器等待全部清理并保留失败，等待中的刷新不能在 shutdown 后重新安装插件。日志流、管理器和真实 Backend 清理均有定向验证；插件模块两平台各 71 文件/970 例通过，另 2 例跳过。Node/桌面类型与架构边界通过，CLI、Server、Desktop shell 已在两平台重新构建。详见 [插件退出修复](backend-plugin-disposal-2026-09-07.md)。

最终 v4 的 3,705 个源码/配置文件摘要为 `1128972ab0bece7f13fd201991a462fe9a272498064ae0f02ba072edcb96c3fe`，两平台执行前后均未变化：Linux 976 文件/9,689 例通过，另 3 文件/9 例跳过，79.89 秒、exit 0；macOS 975 文件/9,688 例通过，1 文件/1 例失败，另 3 文件/9 例跳过，60.48 秒、exit 1。唯一失败是 HTTP 文件监听 SSE 在期限内只收到连接确认。原样单例通过仅作对照，尚未消除全量失败。报告分别为 `/tmp/backend-stage10-linux-full-20260907-v4/` 和 `/tmp/backend-stage10-macos-full-20260907-v4/`。

带原生监听旁路记录的 macOS v5 同源全量再次复现唯一失败，61.66 秒、exit 1。记录证明 watcher 创建后未收到任何原生回调，超时后才关闭；同一临时目录下 HTTP 整文件 33 项通过，尚未确定系统层遗漏的具体原因。独立 FSEvents 流的原生就绪候选在当前环境完成“HistoryDone → 唯一写入 → 事件 → 实际关闭”探针；子任务环境未就绪的负向结果也保留，生产适配和打包未接入。完整轨迹、四组单次写入对照和候选限制见 [工作区文件监听调查](backend-workspace-watch-investigation-2026-09-07.md)。未修改业务写入或延长测试时限。

首次 macOS 全量的进程查询权限及摘要模块夹具问题已经修复；Linux 后续全量发现并促成上述日志与退出修复。历史失败、真实运行时证据和限制保留在 [stage10 实施记录](claude-sdk-preload-startup-2026-09-07.md) 与 [平台证据](backend-platform-verification-2026-09-07.md)。完整方案继续进行。

## 上一增量（stage9：连接器生命周期与三端构建）

正式入口现在校验直接父子进程身份、保留原 BUN_OPTIONS，并在触碰 fd/fetch 前排除继承 preload 的后代。连接器在 ready 前扣住 prompt，合法结束时先停止新输入，再完成 finish 并关闭 stdin；修复追话/控制计时器竞争、取消误报存储失败，以及清理错误跳过实际进程等待的问题。检查点超时会关闭新动作和子进程，但仍等待已经接受的 writer 真正结算。

CLI、Server、Desktop shell 的正常构建均生成稳定的物理 ESM preload，独立产物的 3 例测试通过，含真实 native 握手、结束和 PID 消失。Server 之前忽略自定义输出目录的问题也已修复。最终相关组合在 macOS/Linux 分别 35.62/39.42 秒通过；Node 类型和架构边界通过。此前组合中的 Vertex 超时夹具永不结算及清理连带失败已修复，旧失败日志保留。

Linux 的额外 4 例使用真实 SDK、原生 Write 与真实 Backend，验证主/标题独立确认、结果保存前零工具副作用、拒绝/迟到 writer 和冷恢复拒绝重放；原始传输明确由合成函数提供，不代表真实云认证或全部默认路由已验收。实现、构建位置、证据和下一步接线条件见 [stage9 实施记录](claude-sdk-preload-lifecycle-2026-09-07.md)及 [Backend 集成验收](claude-preload-backend-integration-2026-09-07.md)。默认工厂仍未启用该选项，完整方案保持进行中。

## 上一增量（stage8：原生适配与 preload runtime）

请求核心新增 FormData、可接管的 Request 正文和正常 drain；确认通道新增显式结束握手，已接受的请求及保存继续完成，全部动作配对后才接受正常 EOF。新增 fs 异步 fd 适配器和同步安装 fetch 的 runtime。原生 macOS/Linux 两笔真实 fsync ACK、finish 与进程退出均通过；同时保留真实负向证据：客户端单方面 abort 不能释放空闲 read，宿主必须并行关闭对端，再等待实际回调及 fd close。该约束已经写入接口与接线记录。

最终组合在 macOS/Linux 分别 32.74/32.81 秒通过，Node 类型和架构边界通过。真实 SDK 的既有网关验证包含在组合内，但新 runtime 尚未接入默认 SDK/Backend 回合。具体代码、测试范围、源码摘要及生产接线条件见[stage8 实施记录](claude-sdk-preload-runtime-2026-09-07.md)。

补充实际 native 组合验证：两平台均在原生进程内连接 runtime、fd 适配和真实写盘宿主，验证 FormData/File、Response/clone、before ACK 前零发送及 after ACK 前零结果/工具字节，再经过 finish 和真实进程退出。传输函数明确为合成实现；这是组件组合证据，不是实际 SDK 模型默认路由或 Backend 冷恢复证据。

## 上一增量（stage7：SDK 核心与通道）

新增可复用 fetch 核心，固定将要发送的业务参数，保留网络扩展引用，并让完整请求和依赖结果分别等待持久化确认；既有网关复用同一编码和 SSE 判断模块，修复 CR 事件边界。新增独立进程确认通道，处理身份、并发、阶段、真实关闭及保存首错；它尚未接入默认生产连接器。

macOS 与 Linux/arm64 的 6 文件/122 例相关组合分别在 31.74 秒、30.74 秒通过，包含真实 SDK 与现有功能。最后新增不可编码动作的失败关闭处理后，通道最新 21 例在两平台另行通过；Node 类型及边界门禁通过。原生身份/环境继承诊断在两平台各有 7 个实际进程证据；raw fd3 在两平台完成两笔真实 fsync 确认，但 Bun 的通用通道适配仍未认证。详细范围、代码摘要、回归入口和未完成接线见 [增量实施记录](claude-sdk-preload-implementation-2026-09-07.md)。

## 此前完整基线（stage6）

| 检查 | 结果与范围 |
| --- | --- |
| macOS 与 Linux/arm64 完整 Node | 各发现 960 文件，957 文件/9445 例通过，3 文件/8 例跳过；分别 74.86 秒与 112.42 秒，均 exit 0。3651 个代码/配置文件摘要一致且运行前后未变。 |
| Linux 存储 | Linux/arm64 与 Ubuntu 24.04/x64 本地翻译环境各自 22 文件/199 例通过；后者另有原生 PTY 与真实 SDK 4 文件/35 例通过。x64 未运行完整 Node 或 renderer，也不代表正式 runner。 |
| 类型与架构门禁 | macOS/Linux 的 Node、desktop 类型，boundary/session/assembly/transport/log 与 UI consume 全部通过；未改发现范围或放宽基线。 |
| 本机重新构建与实际验收 | macOS ad-hoc 未公证应用、Server、CLI 通过首启、鉴权、搜索、窗口、原生进程收尾、退出保存与释放 lease，以及完整备份/校验/恢复。无正式发布。 |
| 发行兼容验证入口 | 真实 Backend、实际 CLI 与同 tag 的历史锁组件 7 项通过；夹具 4 例纳入项目 Vitest。当前构建夹具的外部产物适配自测有独立记录，不能当成历史发行认证。 |

最新报告与此前失败均保留，见下方验收记录和 [平台证据](backend-platform-verification-2026-09-07.md)。渲染代码本轮未改，沿用前阶段 241 文件/4028 例的独立 renderer 结果。

**生产启用范围补充核查：**SDK 请求代理目前只有显式构造适配的验证，默认生产连接器未传入该配置，普通 provider 的 baseUrl/fetch 设置也不会接入它。实际生产还会优先使用用户安装的 CLI，且策略动态改址没有完整屏障保证。因此不能把下述代理回归写成生产逐请求保障已交付；SDK 生产接线和完整 transport 适配仍是 B1 的缺口，详见 [装配核查](claude-sdk-request-checkpoint-contract-2026-09-06.md#生产装配核查与适配启用边界)。stage7 已新增核心与通道并调整共享编码实现，其验证范围单列于上文。

## 恢复后的增量验证

- **存储首个错误被覆盖已修复。** 实际复现 fsync 失败被随后 close 或临时文件清理错误覆盖；修复前 4 例中 2 例失败。`durable-json` 现在保留首个写入/同步错误，仍执行清理，独立 close 失败仍上报。修复后与格式、备份及删除恢复一起验证，4 文件/48 例通过，Node 类型检查通过；CI 持久性清单增加对应测试，现为 22 文件。日志 `/tmp/backend-durable-json-first-failure-before.log`、`/tmp/backend-durable-json-first-failure-after.log`。
- **Ubuntu 24.04/x64 基线通过。** 在本地 ARM Docker VM 的 x64 翻译环境、独立 Linux 卷及非 root 用户下，既有冻结快照的持久性 21 文件/195 例、原生 PTY 与 Anthropic/Foundry SDK 2 文件/14 例均通过。该快照不含本节新增改动；详情见 [平台记录](backend-platform-verification-2026-09-07.md)。
- **SDK 检查点适配的退出竞态已修复，Vertex 仍有已证实的覆盖失败。** 使用公开 spawn 接口保持 SDK 启动参数，持续消费 stderr，并在提前拒绝/取消后等待真实 child close；最初在 Vertex 发现、随后 Linux 全量在 Anthropic 路径复现的共因已统一修复。启用检查点的 Anthropic/OAuth/Foundry/Vertex 本地 SDK 回合均持有实际退出完成信号，默认未启用该适配的路径保持原行为。企业网关拒绝测试同时检查关闭事件与 PID 已消失，未添加删除重试。修复后的真实组 3 文件/34 例通过（30.74 秒，`/tmp/sdk-proxy-close-all-real.log`），兼容组 9 文件/113 例通过。断网的 Ubuntu/x64 容器中，managed policy 改址后，目标在初始化结果与 getSettings 之前收到两次 rawPredict，用户 prompt 尚未提交；这是已证实的初始化屏障绕过，不是通过结果。证据和默认 Vertex 限制见 [SDK 合同](claude-sdk-request-checkpoint-contract-2026-09-06.md)。
- **发行兼容入口已可执行，真实旧版的降级风险也已确认。** [隔离验证与产物契约](backend-release-compatibility-2026-09-07.md) 的 7 项基础检查通过，包括持有真实文件 IO 时退出仍排他、拒绝未知格式/能力且业务字节与空目录不变，以及实际 CLI 完整恢复后冷读 owner、消息、blob 和绝对媒体路径。此前同 tag 锁组件和当前构建夹具仅属局部证据；现已取得并校验官方 v1.1.7 mac-arm64 ZIP，在隔离合成目录实际运行其 headless CLI。新旧锁两方向互斥成立，但旧版遇到未知 capability 仍完成 Backend 初始化，新增 3 个业务文件和 25 个目录，明确不满足「拒绝未知能力且业务零改动」。5 个拥有的进程均实际 close，无强杀或进程残留。这不证明已有数据损坏，也不构成桌面应用或完整发行兼容认证。详见 [历史官方产物诊断](backend-historical-artifact-2026-09-07.md)，原始报告 `/tmp/ot-v117-daemon-0907/report.json`。支持的回滚方案仍未确定，发行认证保持未完成。
- **SDK 默认地址的请求前拦截取得可继续实施的证据。** 公开 `BUN_OPTIONS --preload` 入口已在锁定 native 验证；Linux/arm64 断网容器的真实 SDK 进一步捕获默认地址下的标题和主请求。v2 两例通过：只批准标题不放行主请求；逐条拒绝并主动取消后，forward attempt 与实际转发均为 0，两个 native 均真实 close、PID 消失。v1 因漏计自动标题和误判中止错误而失败，已保留。这里使用合成确认及假服务，未接真实落盘、响应结果屏障或完整传输兼容，生产未启用。可重跑入口和明确的后续条件见 [preload 诊断](claude-sdk-preload-fetch-diagnostic-2026-09-07.md)。该诊断阶段当时仅新增诊断代码和文档；其后 stage7 的核心与通道实现已有独立增量记录，不能继续沿用此前「生产源码未变」的快照判断。

## 前一轮完整基线（stage3）

| 检查 | 实际结果 |
| --- | --- |
| 完整 Node 正常测试 | 最新冻结源码在 macOS 与 Linux/arm64 分别通过：954 文件、9424 例；另 3 文件/8 例跳过。macOS 69.48 秒、Linux 103.02 秒，均 exit 0、无未捕获异常。两平台 3643 个代码/配置文件摘要一致，执行前后未变。 |
| 桌面渲染测试 | Linux 本轮单独运行 241 文件、4028 例通过（49.34 秒）；macOS 此前同套件 241 文件、4028 例通过（40.34 秒）。前端代码本轮未修改。 |
| 类型检查 | 最新 Node 与 renderer 类型在 macOS、Linux 均通过。 |
| 架构门禁 | 最新 macOS、Linux 的 boundary、session、assembly、transport、log 五项均通过（transport 1002 壳行）。未放宽基线。 |
| UI 消费门 | 32 处既有基线内债务，响应链违规为零。 |
| 构建 | 最新 Server、CLI 和 mac-arm64 未公证的 ad-hoc .app 均重新构建通过，包含 SDK 与 inspector 修复。新签名应用通过空目录首启、HTTP/RPC 授权、索引/搜索、实际窗口及正常退出验收（GREEN，exit 0）。 |
| Server 实际烟测 | HTTP 200/404/500、结构化日志、匿名 401、自动正常退出通过。 |
| CLI 实际烟测 | 前阶段临时 store 真实 daemon 的 help/status/create/list/rename/show/delete/stop 通过，socket 与 lease 正常清理；最终 CLI 构建的真实备份/校验/恢复及拒绝损坏、覆盖路径再次通过。 |
| Electron 实际烟测 | 最新 Node/core 与 Electron 启动、HTTP、原生 PTY、MCP 提前关闭零残留子进程通过（core 43 ms / Electron main 58 ms）；真实主进程 SIGTERM 和关窗均保存元数据及账本后释放 lease。 |
| Web 实际烟测 | 本阶段较早构建与真实 Chromium、React 浏览器壳联调通过：发送消息、账本保存、HTTP/SSE 流式回复上屏；浏览器及代理转发 URL 均无 token，代理 Authorization 头正确。最终前端业务未再修改；最终 Server 与真实 Node/Electron 客户端分别复验。使用隔离 store 与测试 provider，结束后已清理。 |
| 平台 | macOS 与真实 Linux/arm64 Debian 容器均已有本轮完整 Node 证据；Linux 卷上非 root 用户的保存与恢复 21 文件/195 例再次通过。Windows/NTFS 及 GitHub Ubuntu/x64 runner 尚无本轮结果。进程崩溃测试不等于断电证明。 |

完整测试曾暴露的失败已处理：修正 Node/渲染环境混跑；迁移正式装配 fixture；工具进度保留原调用 ID 语义；取消测试等待实际输出后取消；同步测试经权威元数据写口改变归属，索引不能覆盖权威 owner；大型目录测试保留 5005 项与真实附件，去除无关文件写入风暴；TOC 测试持有整个冷启动装配 Promise，清理等待迟到实例。后续还修复了待办/代理跨 store 缓存、评测正式凭据断链、终端未等实际退出，以及协作保存错误和删除清理漏出排空的问题。

8 个跳过用例为两组真实 Claude CLI 共 5 例、外部实时语音 1 例、插件验收的条件用例 2 例；不计为通过，也不用于关闭外部执行器/服务验收缺口。

## 工作包

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

| 工作包 | 已落地及阶段证据 | 未关闭事项 |
| --- | --- | --- |
| B0 基线、正常回归、CI | 最新 macOS/Linux 完整 Node 回归、类型和门禁通过；macOS 真实打包首启和退出通过。三平台持久性入口包含 mailbox 保存失败与真实 Backend 保锁回归；发布先经过同一标签的测试门禁，独立应用依赖按锁文件安装。 | Windows 与正式跨平台 CI 的实际 runner 结果。 |
| B1 可靠保存与检查点 | 主引擎/TOC、journal/blob 依赖及首错水位已接。协商 ACP 扩展有真实进程、HTTP/工具副作用、ACK 前后 SIGKILL 和冷恢复证据。Claude 显式自定义网关支持 API key、OAuth、Foundry key/Bearer；显式 Vertex endpoint 增加原生 ADC/region/启动采样及工具屏障验证，提前拒绝等待真实子进程退出。 | 未协商 ACP 第三方实现、SDK 默认第一方完整功能、默认云路由与目标平台；已实证 managed policy 在 Vertex 初始化前改址时绕过屏障。网关模式不能代表全部 SDK 请求覆盖。 |
| B2 统一 lease | 各自有 Backend 共用规范化目录 lease；借用 HTTP 不重复持有。发现入口在持锁时清理，真实子进程竞争、离线恢复和三宿主烟测通过。 | 目标平台证据与受支持文件系统核验。目录锁不提供无人值守自动抢占。 |
| B3 统一退出 | 分阶段资源表、总期限、在途请求、SSE 结束、真实排空与最终保存后释放 lease。本仓已核查资源见 [所有权清单](backend-resource-ownership-2026-09-06.md)；信箱保存失败汇总后保锁，终端等待实际进程退出，旧引用不能写入新 store。 | 外部执行器完整能力及其他平台退出语义的实际证据。 |
| B4 会话边界与恢复 | SessionLayer、删除意图、代际及冷恢复已接。store-format 在业务启动前检查四项最低能力（含 external-execution-checkpoints-v1）。完整备份/校验/暂存恢复已落地，恢复 marker、三个崩溃窗口与真实 Backend 原址恢复媒体读取验证通过。 | 支持的回滚发行版仍需发布准备；任意旧程序不受新门禁保护，更换 store 路径不属于本恢复命令承诺。 |
| B5 身份与资源授权 | 固定可信上下文、42域核查、初始 owner 原子发布、草稿恢复；媒体、电台、history/notebook/board、provider→connector→MCP→tool 的遗漏已补齐，正常/拒绝路径均有回归。 | 已识别资源授权遗漏已关闭；最终发布需沿核查表复核宿主能力配置，不宣称互不信任用户的完整机器隔离。 |
| B6 快照与重连 | 不可变版本快照、scope/epoch、就绪、有界缓冲及客户端接线已落地；真实 HTTP 重连、内容/权限/运行状态、归属失效及超大 commit 恢复验证通过。显式未知协议拒绝，缺省 legacy 保持，已提供 [协议兼容矩阵](backend-client-sync-compatibility-2026-09-06.md)。 | 当前支持范围为通过协议 1 契约的构建；具体已发布二进制范围仍待认证，不以应用版本号推断。 |
| B7 公开边界与扩展 | shared 反向实现边收敛为零，显式 exports/真实路径检查、server 窄适配已接；工作区筛选和 example-im 有实际扩展与回归，最终本机构建与门禁通过。 | 正式发行环境的构建范围认证；后续新增切片继续遵守相同边界。 |

## 本轮补齐的关键实现

- **本轮跨平台与发布接线：**增加记录源码摘要、真实平台与退出码的 [跨平台验收入口](backend-platform-verification-2026-09-07.md)。修复 Linux 干净安装缺少原生 PTY、独立 mobile/desktop 依赖的问题；快照固定 OS/文档路径/时区等输入，监听测试区分业务订阅和 Linux 真实子句柄并等待全部关闭。完整回归已收敛。发布工作流复用同一标签源码的测试和门禁，保持原有公开发布策略，未执行发布；历史版本事实与缺口见 [发行兼容核查](backend-release-compatibility-2026-09-07.md)。
- **协作状态定时回调：**完整 macOS 回归曾在 9421 例断言通过后捕获 inspector 退出回调异常，正确返回 exit 1。修复为每个 Backend 无条件持有 inspector：停止时关闭入口、拒绝旧 timer、等待真实 EventBus 发送，旧供数口解绑不能影响新实例。6 文件/76 例针对性回归通过，最终两平台全量也通过；未用捕获异常或跳过用例掩盖。
- **SDK 新认证与路由验证：**保留既有自定义网关的 OAuth 和 Foundry key/Bearer 认证，首次用户输入前校验 SDK 实际 provider 与有效 endpoint，拒绝保存的企业网关和配置旁路。最终真实组 2 文件/24 例通过，兼容组 9 文件/110 例通过，均进入最终 Node 回归。Vertex 只有隔离 ADC/STS 可行性探针，尚未并入生产；默认第一方与其余云路径仍有交付缺口。
- **真正取消工具：**Backend 持有逐调用注册表，身份与会话在创建时固定；取消只作用目标工具，等待真实 prepare/apply/plugin/权限清理。真实 bash、退出持锁与新旧实例隔离已验证。
- **外部执行器：**ACP 协商版本 1、durableSeq ACK、重复内容校验、超时停止、未知结果不重放；真实进程中杀死 agent 或 client 均有冷恢复证据。Claude 自定义网关保持文本流式显示，等待响应检查点后才向 SDK 交付可执行工具内容；失败不重试。详见 [能力矩阵](execution-checkpoint-capabilities-2026-09-06.md) 和 [SDK 网关契约](claude-sdk-request-checkpoint-contract-2026-09-06.md)。
- **备份：**完整文件校验、同步保存、维护 lease、不可覆盖备份和暂存目标；恢复只在原 canonical 路径激活，避免已有绝对媒体路径指向错误目录。详见 [停机恢复步骤](backend-store-backup-2026-09-06.md)。
- **性能与慢客户端：**真实文件系统和 HTTP 测量已保存；主事件 SSE 尊重背压，编码队列上限 1 MiB、分块 64 KiB，丢弃未开始事件时明确要求同步重建。暂停读取的 socket 缓冲 p95 从约 7.6 MB 降至约 65.8 KB，不能把重同步当作完整送达。见 [测量报告](backend-performance-2026-09-06.md)。
- **评测与练习：**评测跑批/回放/分析/诊断/轮次回放归 Backend 所有，取消等待真实模型请求及文件收尾；3 文件/9 例含真实 HTTP/lease/重装证据。Practice 固定 store 实例、配置串行写入、ticker 禁止复活、活动练习只结算一次；7 文件/36 例含双 IO 阻塞与旧引用隔离。广播/Outbound/统计/变量也已完成独立生命周期切片。
- **插件、语音、待办与音乐：**插件模型持有真实 provider Promise，使用所属 Backend 的账本；语音等待 ASR/TTS 实际收尾（9 文件/57 例），待办 watcher 等待真实文件监视器关闭并清除跨 store 的 settings 缓存（13 个不同文件/85 例）。音乐服务等待非配合式请求及真实子进程组退出，旧实例不能操作新 store（18 文件/198 例）。这些分组互有重叠，详情见 [资源所有权清单](backend-resource-ownership-2026-09-06.md)。
- **凭据策略：**注册项和选择任务归所属 Backend/插件实例；从 usage 文件读取开始登记任务，超时返回 fallback 后仍等待忽略取消的真实选择 Promise。替换策略后旧结果、旧注销函数不能覆盖新策略；真实 Backend 的 3 例测试验证持锁排空及不同 store 的决策、usage、失败状态隔离。
- **协作任务：**board 事件、agent/room 信箱打开与恢复任务归运行实例；关闭后等待实际文件读取，再关闭未安装的信箱。固定账户和日志存储，旧 actor/account 拒绝新实例上的晚写；真实 Backend 3 例及正常调度等 4 文件/73 例通过。代理目录缓存改为按规范化路径归属，3 文件/27 例验证 A→B→A 与延迟初始化不串目录。摘要生成同步登记并持有真实授权与模型 Promise，超时、删除、身份变化均阻止晚写；6 文件/78 例通过，包含真实本地 TCP 模型与 Backend 持锁重装。
- **协作保存失败：**信箱保留首个 append/cursor 文件错误，等待真实写链后仍报告失败；关闭继续清理其他资源后汇总错误，由 Backend 保留 lease。已安装、未安装和正在删房的信箱均覆盖；基础修复 8 文件/96 例通过，独立复核补齐删房清理登记后 6 文件/65 例通过（含新增真实挂写后 EISDIR 的验证，分组不累加）。
- **桌面空目录启动：**进程采样定位到实际 Keychain 读取；迁移改为确有凭据时才探测加密，空配置不写空凭据文件。已有密文、OAuth 延后迁移、非空加密及失败保护保持，2 文件/33 例通过，真实重新签名应用启动验收通过。装配失败也写入现有启动日志。
- **终端实际退出：**发送关闭信号与进程实际退出分开记录，kill/killAll 返回实际退出 Promise，已经移出列表但仍退出中的 PTY 继续归属服务；保留进程组强杀阶段。4 文件/35 例与 Node 类型检查通过，真实 PTY 验证退出通知与 PID 消失后才删除目录。
- **评测正式凭据：**修复评测只读 legacy settings、迁移后找不到密钥的既有断链，改走正式空间凭据选择入口，保留 OAuth 限制、冷却与来源模型 fallback。3 文件/16 例通过；真实 HTTP 用正式保存的凭据验证 Authorization、取消、文件收尾、持锁与旧引用拒绝，全部纳入最终完整回归。请求提前失败会暴露原始错误，不再以等待测试超时代替诊断。
- **目标后台任务：**重试 scheduler 属于单次 Backend，退出关闭 timer 并等待已发起的 kick；完成后的文件变更摘要归创建时 Backend.runTask，最终 usage 在 session layer 释放前保存。6 文件/33 例通过，包含真实 Backend 退出后 45 秒不复活、37 token 冷恢复再增加 1 token 不叠加旧内存，以及真实文件扫描暂停时持锁、摘要完成后冷恢复可读。

- **最低可写能力：**新增 store-format.json 的单调能力声明与同步门禁。未知能力/格式拒绝；无声明但已有删除凭据、owner/代际、草稿迁移记录时只读识别，不能被低能力版本误当 legacy。能力声明可靠保存后才初始化业务。20项新增测试，联合删除/草稿/存储48项通过；实际 Backend 拒绝未知能力时业务文件零改动，正常冷重装通过。测试的回滚能力组合明确模拟遵循门禁的受支持版本，不冒充未修改旧程序。
- **电台：**14 个 RPC 方法限定固定本机运营者；radio 工具保留独立可信 context；持久 DJ 引用先验归属，再读正文、改 persona 或授予目录权限；候选会话先过滤，新会话首次保存 owner，异步取上下文后再次检查并显式携带身份发命令。相关5文件68例通过。
- **内部工具/MCP：**history 的正文、候选名称与统计使用授权范围；notebook 按 owner/workspace/agent 分区，固定默认身份兼容历史文件；board 排队后实际执行前复核。补齐 provider→connector→MCP→tool 上下文；MCP 定义捕获 binding token，旧定义不能借新回合的身份/发言牌。联合72通过文件1038例通过，真实 CLI 条件下5例跳过。
- **媒体：**列表/画廊/预览/bytes 按真实来源会话预检；删除/未知来源不降级为无来源；混合来源全部授权，导入首个记录保存可信 owner，去重按来源集合/独立 owner 分区。重建/隐藏/清空批次在副作用前完整预检。媒体库固定实例、路径与 Backend 生命周期，真实下载期间退出保持 lease，I/O 结束才可重装，旧方法引用拒绝。16文件131例通过，补充同物理文件多来源 bytes 15例通过；全部进入本轮完整回归。

## 仍未完成的交付条件

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

1. SDK 默认第一方完整功能、默认 Bedrock/Vertex/Foundry 云路由、真实云认证与第三方 ACP agent 的完整检查点能力；Vertex managed policy 改址在初始化之前绕过屏障已实证。显式网关的成功与退出竞态修复不能外推为完整覆盖。
2. Windows/NTFS、正式 Ubuntu/x64 runner 及发行目标文件系统的实际结果；本轮 macOS 打包、Linux/arm64 全量及本地 Ubuntu/x64 翻译环境的限定验证已通过。已有跨平台离线验收入口，Windows 环境信息仍待提供。
3. 最低可写能力对应的受支持发行/回滚版本。备份/原址恢复已有操作和本机验证，任意旧程序、跨路径迁移与断电证据仍不在承诺范围。
4. 客户端及服务端的具体已发布二进制兼容范围。当前通过的是协议 1 契约和本机构建，不以版本号推断发布兼容。其他独立 SSE 路由的既有通知语义见性能报告，不能外推为主会话同步协议的恢复保证。

## 此前 stage6 验收记录（最新 stage10 见上文）

stage6 的 macOS 完整 Node 报告在 `/tmp/backend-stage6-macos-full-20260907/`；Linux/arm64 的持久性、完整 Node、类型与门禁在 `/tmp/backend-linux-reports-20260907-stage6/`；Ubuntu/x64 限定验证在 `/tmp/backend-ubuntu-amd64-reports-20260907-stage6/`。三者代码/配置摘要同为 `80773725900038226b7617bcb7146a2df9979d693df06007e7a537b0bbbe8f30`，运行前后未变。Linux renderer 的未改代码证据仍为 `/tmp/backend-linux-renderer-stage2-installed.log`。该阶段本机类型/门禁日志为 `/tmp/backend-stage6-{node-types,desktop-types,boundary,session,assembly,transport,log,ui-consume}.log`；构建与实际验收为 `/tmp/backend-stage6-{unpack,server-build,packaged,server-smoke,core-smoke,backup}.log`，其中 unpack 已构建 CLI。这些结果不替代 stage10 新增源码的验证。

此前 stage3 成功、stage4 验证接线失败、stage5 Linux SDK 退出竞态失败，以及 `/tmp/backend-final-verified-*.log`、`/tmp/backend-lifecycle-final-renderer.log`、`/tmp/backend-lifecycle-final-client-runtimes.log` 均保留，详见平台文档。这些是当前执行环境的本地证据路径，不是远端 CI 或正式发布记录。

验证使用隔离目录和子进程，不触及用户真实会话数据。保留实施前用户已有修改。详见 [复审报告](backend-maintainability-plan-review-2026-09-06.md) 和 [资源核查表](backend-rpc-access-audit-2026-09-06.md)。
