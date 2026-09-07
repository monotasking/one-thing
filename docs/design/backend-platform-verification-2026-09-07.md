# 后端跨平台本地验收

最新完整源码基线为 [stage11 文件监听与原生打包](backend-workspace-watch-implementation-2026-09-07.md)：macOS 980 文件 / 9,725 项通过，Linux 980 文件 / 9,724 项通过；两平台使用同一份 3,712 文件摘要，保留此前失败记录作为历史。其后的 [桌面启动恢复与退出修复](backend-startup-lock-recovery-2026-09-07.md)单独记录增量验证，不沿用旧全量结果冒充最新源码验收。stage11 的隔离 Linux 容器已在确认只剩 init/sleep 后正常停止，报告与数据卷保留。

在已有 Windows、Linux 或 macOS 主机上运行当前源码，无需提交、推送或创建云资源。入口只调用当前工作树的 `node_modules/vitest/vitest.mjs`，不会下载依赖。先在目标主机按锁文件安装适合该平台的依赖；不要复制 macOS 的 `node_modules` 到 Linux 或 Windows。

```sh
node scripts/backend-platform-probe.mjs --report-dir /absolute/path/to/new-report-directory
```

Windows PowerShell 示例：

```powershell
node scripts/backend-platform-probe.mjs --report-dir C:\backend-reports\persistence-run-1
```

默认 `--suite persistence` 严格读取当前 `.github/workflows/test.yml` 的 `jobs.persistence` 测试清单。清单发生不支持的格式变化时入口失败，不静默少跑用例。可选 `--suite full` 运行根 Vitest 配置的全部 Node 测试；桌面 renderer 是独立测试套件，不包含在此选项中。

运行 full 前还需在 `apps/mobile` 按其独立锁文件安装依赖，因为根套件包含 mobile 的纯 reducer/SSE 测试，其 TypeScript 配置继承 Expo。单独运行 renderer 测试或构建前，还需在 `apps/desktop-react` 按独立锁文件安装依赖；它也不在根 workspaces 内。Linux 真实终端测试需可用 shell、ripgrep 和适合当前 Node 的 node-pty 原生模块；本次通过 `npm rebuild node-pty` 准备。CI 已在相应测试/构建 job 加入准备步骤；随后补充 durable-json 首错误传播测试，当前持久性清单为 22 文件，历史 21 文件结果保持原样。

每次使用新的报告目录。入口在该目录内保存：

- `report.json`：实际 OS、架构、Node/Bun/Vitest 版本、Git HEAD 和未提交状态、命令参数、测试清单、源码摘要、实际子进程退出码与最终结果。
- `source-manifest.json`：运行前逐文件 SHA256，包括未提交和未跟踪源码。范围是 `packages`、`apps`、`scripts`、`.github` 及根目录配置/锁文件；依赖、构建输出、日志和环境文件排除。完整范围写入报告。摘要来自实际文件，不使用 Git 提交树代替工作树。
- `test-files.json`、`vitest.log`、`vitest-results.json`：精确测试文件、原始输出和 Vitest JSON 结果。初始化失败可能没有测试输出。
- `tmp`、`attachments`：测试临时文件和附件。入口把子进程的 `TMPDIR`、`TMP`、`TEMP` 指到 `tmp`，保留 Vitest 的临时用户目录隔离。

测试失败会保留失败退出码。源码在运行中改变时，实际测试退出码仍记录在 `execution.exitCode`，但入口返回 2，不能把该轮当成冻结源码的通过证据。被信号终止或初始化失败返回非零并记录原因。无 Git 元数据的源码副本可以运行，Git 状态明确记为不可用，仍生成实际文件摘要。

Linux Docker 验证时，把源码、平台原生依赖和报告目录放在 Linux 命名卷中，例如 `/workspace` 和 `/reports/run-1`。报告目录下的 `tmp` 也必须在该卷；macOS bind mount 的测试文件系统不能充当 Linux 原生文件系统验收。脚本报告文件系统类型数值与实际路径，供核对运行环境。Windows 持久性验收应在真实 Windows/NTFS 环境运行；其他平台通过不会记成 Windows 通过。

跨主机对照应核对 `source.digest`、`tests.files`、Node/Vitest 版本和目标文件系统。不同换行字节、源码修改、平台排除或测试失败都需按原报告说明，不能用旧提交的绿色 CI 替代当前工作树结果。入口本身不触发 GitHub Actions，也不上传源码或报告。

## 2026-09-07 实际记录

- macOS 本机入口：21 文件/195 例通过，源码前后未变，exit 0；报告 `/tmp/backend-platform-probe-macos-20260907-pass/report.json`。这是该次源码的证据。
- Linux 首轮：Debian bookworm、Linux 6.12.76-linuxkit、arm64、Node 22.23.2、Bun 1.3.14、Vitest 4.0.18；Docker Linux 命名卷，测试文件系统类型 61267（ext 系列），非 root 的 node 用户。持久性 21 文件/195 例通过，exit 0。
- 同份 Linux 首轮源码的全量执行：956 个文件被发现，8 文件失败；9352 例通过、14 例失败、8 例跳过，另有两个 mobile 文件因缺 Expo 配置而未能导入，exit 1。失败包括缺少 Linux 原生 PTY、依赖本机 OS/路径/时区的快照，以及递归监听在 Linux 创建底层句柄导致的测试识别错误。失败保留，未跳过或当作通过。
- 两次 Linux 执行的源码摘要均为 `b1d7532ae65197e16c3f4659decf1e05db3ac5ffd19545a4ecac1e8a3c21c4ca`（3642 个范围内文件），执行前后未变。完整输入归档含 4203 文件，归档清单摘要 `52aac5dc7a26244debd7387613cc77ff38c1a2fd9e85bfad2872775e8b98fb46`；两个摘要范围不同，不互相比较。
- 原始报告已复制到 `/tmp/backend-linux-reports-20260907-stage1/`，其中保留输入清单、两个 suite 的报告/输出/测试列表。这是当前执行环境的本地路径，不是发布产物或远端 CI 记录。

Linux 首轮输入早于后续 SDK、发布接线和平台测试修复，不能声称这些新改动已获整体验收。Windows/NTFS 仍待真实执行环境；未向公开 GitHub 仓库推送当前未提交源码。

### Linux 第二轮及同阶段 macOS 回归

第二轮输入已包含 OAuth/Foundry 网关扩展、实际路由校验和 Linux fixture 修复。环境不变，平台依赖在 Linux 卷内安装，未使用 macOS 原生模块。

- Linux 持久性再次 21 文件/195 例通过，exit 0；完整 Node 套件 953 文件/9421 例通过，另 3 文件/8 例跳过，106.08 秒，exit 0。
- Linux 两个入口的代码与配置摘要为 `1f37dfa027df06ebc9f357307fb80e2717fd99d9139976002e032eba3de26cc4`（3642 文件），运行前后未变；输入归档 4204 文件，清单摘要 `4725393b0cd26c99abb8eed860f2f6c6e493f6c73dfcb4e5a857341048b7e7fb`。报告在 `/tmp/backend-linux-reports-20260907-stage2/`。
- 随后的 Linux renderer 入口因尚未安装独立桌面包依赖，在读取配置时拒绝启动（缺 `@vitejs/plugin-react`）；整个组合脚本 exit 1，不记为组合通过。按桌面包锁文件安装依赖后，单独复验 241 文件/4028 例全部通过（Vitest 3.2.7，49.34 秒，exit 0），日志 `/tmp/backend-linux-renderer-stage2-installed.log`。
- 同阶段 macOS Node 全量虽 9421 例断言通过，但捕获一处协作 inspector 在 Backend 退出后的未处理回调，exit 1。日志 `/tmp/backend-sdk-platform-macos-20260907-full-1/vitest.log`，正在修复，不能计为成功。
- 逐文件比较确认 Linux 3642 个范围内输入与该次 macOS 对应文件逐字相同。macOS 旧版入口还额外收录了 125 个本地桌面构建文件及 1 个 mobile 本地工具配置，所以原摘要不同。入口已明确排除这些构建和工具目录；新一轮使用更新后的范围，历史报告保持原样。

第二轮 Linux 的成功不能关闭 macOS 捕获的生命周期问题，也不能替代该修复之后的整体验证。

### Inspector 修复后的最终一轮

每个 Backend 均无条件持有 inspector，停止时关入口和 timer，并等待真实事件发送完成。修复后重新冻结源码；3643 个代码/配置文件在 macOS 与 Linux 的 SHA256 摘要完全一致：`c7efdcf901a3b358a4220d460fe940660b308e8c7e40d6aeea66ff24e250229d`，两次运行前后均未变化。

| 检查 | macOS/arm64 | Linux/arm64 |
| --- | --- | --- |
| 环境 | Darwin 25.5.0、Node 22.22.3、Bun 1.3.14、Vitest 4.0.18 | Debian bookworm、Linux 6.12.76-linuxkit、Node 22.23.2、Bun 1.3.14、Vitest 4.0.18；非 root 用户、Linux 卷 |
| 完整 Node 回归 | 954 文件/9424 例通过，3 文件/8 例跳过；69.48 秒，exit 0，无未捕获异常 | 同样 954 文件/9424 例通过，3 文件/8 例跳过；103.02 秒，exit 0，无未捕获异常 |
| 单独持久性清单 | 前阶段 21 文件/195 例通过；本轮完整套件也包含这些文件 | 本轮单独再次 21 文件/195 例通过，exit 0 |
| Node 与桌面类型检查 | 均通过 | 均通过 |
| boundary/session/assembly/transport/log | 五项通过，未放宽基线 | 五项通过，未放宽基线 |
| UI 消费检查 | 32 项既有基线内，响应链违规 0 | 相同结果 |

Linux 此轮组合脚本实际 exit 0；报告和各检查日志在 `/tmp/backend-linux-reports-20260907-stage3/`。输入归档 4205 文件，清单摘要 `19159a76d5a97cbbc25778a70c3e778da65bfd38c0168e42deebc9f8295fb3e6`，同目录保留输入清单。macOS 完整报告在 `/tmp/backend-sdk-platform-macos-20260907-full-2/`；历史失败报告未覆盖。

最新 macOS Server、CLI、ad-hoc 未公证应用重新构建后，实际打包首启、HTTP/RPC 授权、搜索、窗口、正常退出、原生 PTY、MCP 子进程收尾，以及备份/校验/恢复均通过。构建/烟测日志前缀 `/tmp/backend-final-platform-`，详见主台账。渲染代码本轮未改，Linux 独立渲染套件的 241 文件/4028 例通过证据沿用上节结果。

以上关闭本轮已发现的本机回调错误与 Linux 平台差异。Windows/NTFS、正式 Ubuntu/x64 runner、外部执行器完整能力和具体发行/回滚产物仍待验收；不把 Linux 容器或本机 ad-hoc 包当成正式发行证明。

### Ubuntu 24.04/x64 本地翻译环境基线

同一份上述 stage3 冻结快照另在 Ubuntu 24.04、Node 22.23.2、Bun 1.3.14、Vitest 4.0.18 下运行。Docker Desktop 的 Linux/arm64 VM 使用其配置的 x64 翻译能力；进程实际报告 `linux/x64`、`x86_64`，不能据此声称已在原生 x64 硬件或正式 GitHub runner 验证。源码、依赖和测试临时目录均位于独立 Linux 命名卷，由非 root 的 backendtest 用户执行，报告文件系统类型为 61267（ext 系列）。

- 持久性 21 文件/195 例通过，实际 exit 0；代码/配置摘要仍为 `c7efdcf901a3b358a4220d460fe940660b308e8c7e40d6aeea66ff24e250229d`，运行前后未变。
- 原生 PTY 与真实 Anthropic/Foundry SDK 另运行 2 文件/14 例，44.67 秒，exit 0。组合脚本也 exit 0；未在此轮运行完整 Node 或 renderer 套件。
- 原始结果在 `/tmp/backend-ubuntu-amd64-reports-20260907/persistence/report.json` 与 `/tmp/backend-ubuntu-amd64-reports-20260907/native-execution.log`；输入清单一并保留。完整输入归档仍为 4205 文件，清单摘要 `19159a76d5a97cbbc25778a70c3e778da65bfd38c0168e42deebc9f8295fb3e6`。
- 基础 Ubuntu 官方镜像固定摘要 `sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517`；工具镜像 `codex/backend-ubuntu-amd64:20260907` 的构建日志为 `/tmp/backend-ubuntu-amd64-image-build-v2.log`。

该输入早于新增 Vertex、durable-json 错误传播修复及发行兼容入口。这一轮仅增加现有快照在 Ubuntu/x64 翻译环境的证据，不能覆盖这些后续变更，也不能替代 Windows/NTFS 或正式发行验收。

### 增量整体验收捕获的接线与退出问题（stage4 / stage5）

新增 durable-json、Vertex 和发行兼容验证后，完整 Node 入口发现 960 个文件。stage4 的 macOS 与 Linux 均因新兼容测试使用 `node:test` 而被 Vitest 判定没有测试套件，实际 exit 1；9441 例断言通过、8 例跳过并不能抵消此失败。另一本机装配门禁拒绝兼容子进程夹具的 6 个模块级可变状态。随后改用项目的 Vitest 入口，并把夹具状态与回调收进单次 main()，保持文件发现范围与门禁基线不变。4 个夹具测试、真实兼容入口 7 项、类型及装配门禁已分别复验通过。

stage5 的代码/配置摘要为 `64e7e9ea2628c4bb79592315f6b6341f335018b99b09f16b97761858b44bc533`（3651 文件），执行前后未变。macOS 完整回归 957 文件/9445 例通过、3 文件/8 例跳过，79.72 秒，exit 0；重新构建的本机应用、Server、CLI 与退出/备份烟测也通过。但同源 Linux 完整回归 119.83 秒、exit 1：Anthropic API key 的企业网关提前拒绝用例，在清理临时目录时出现 ENOTEMPTY，其他 9444 例通过。该失败证实原有网关路径也存在“SDK 关闭调用返回时真实子进程尚未退出”的竞态，需要把实际 close 所有权从 Vertex 扩到已启用检查点的网关路径，不能增加删除重试掩盖。

Linux stage4 和 stage5 的持久性清单各自 22 文件/199 例通过。这些结果仍不能把相应整轮标记为成功。原始记录保留在 `/tmp/backend-stage4-macos-full-20260907/`、`/tmp/backend-linux-reports-20260907-stage4/`、`/tmp/backend-stage5-macos-full-20260907/`、`/tmp/backend-linux-reports-20260907-stage5/`；门禁与构建日志前缀为 `/tmp/backend-stage4-`、`/tmp/backend-stage5-`。

### 统一 SDK 子进程所有权后的冻结复验（stage6）

公开 spawn 包装现在覆盖所有启用请求检查点代理的本地 SDK 回合，而非仅 Vertex。默认不启用该适配的路径保持原行为。Anthropic API key、Foundry 和 Vertex 的企业网关提前拒绝，均有真实 child close 与 PID 已消失断言。修复后单独实际 SDK 组 3 文件/34 例通过，30.74 秒，日志 `/tmp/sdk-proxy-close-all-real.log`；类型和 113 例既有兼容回归也通过。

输入归档含 4213 文件，清单摘要 `ef99ba9f9b30d28b4e48cdbb56ce2b5b966e1383ad290fe81bfa19288457d147`，归档摘要 `ae55e7be31a78c62a6d99aa31dd76312d9475b6bbb2656e8c95fe7134db5f32d`。代码/配置范围为 3651 文件，摘要 `80773725900038226b7617bcb7146a2df9979d693df06007e7a537b0bbbe8f30`。

Ubuntu 24.04/x64 本地翻译环境已用这份新输入复验：持久性 22 文件/199 例通过，入口执行前后源码未变；原生 PTY 与实际 Anthropic/Foundry/Vertex SDK 另运行 4 文件/35 例，56.93 秒，exit 0，组合脚本 exit 0。沿用独立 Linux 卷、非 root 用户及前述固定工具镜像；未运行 x64 完整 Node 或 renderer 套件。报告在 `/tmp/backend-ubuntu-amd64-reports-20260907-stage6/`，与旧快照基线分开保存。

macOS/arm64 完整回归也已通过：960 文件被发现，957 文件/9445 例通过，3 文件/8 例跳过，74.86 秒，exit 0；源码摘要与上述 x64 输入一致且运行前后未变。报告 `/tmp/backend-stage6-macos-full-20260907/`。Node/desktop 类型与 boundary/session/assembly/transport/log/UI consume 全部通过；装配层 93 项既有基线、58 文件、353 扫描文件，无新增模块级状态，未放宽规则。

同一轮重新构建 macOS ad-hoc 未公证应用、Server 和 CLI，实际首启、鉴权、RPC、搜索、sqlite-vec、窗口与正常退出通过；真实 PTY、MCP 收尾、SIGTERM/窗口关闭时保存元数据与账本并释放 lease，以及 CLI 备份/校验/恢复与拒绝损坏/覆盖均通过。组合脚本 exit 0，日志前缀 `/tmp/backend-stage6-`；core 烟测记录 Node 52ms、Electron main 69ms。仍属于本机构建，未推送、发布或认证历史发行产物。

Linux/arm64 最终组合脚本也 exit 0：持久性 22 文件/199 例通过；完整 Node 957 文件/9445 例通过，另 3 文件/8 例跳过，112.42 秒，无失败或未处理异常。Node/desktop 类型和五项架构门禁、UI consume 随后全部通过。源码摘要与 macOS 和 Ubuntu/x64 相同，执行前后未变；原始报告、输入清单及各门禁日志在 `/tmp/backend-linux-reports-20260907-stage6/`。

至此关闭 stage4 的测试接线问题及 stage5 的提前拒绝退出竞态；没有扩大跳过范围，8 个跳过项仍是 5 个真实 Claude CLI、1 个外部语音与 2 个条件插件验收。Windows/NTFS、正式 runner、SDK 全部路由/第三方协议和真实发行/回滚产物仍未完成；初始化前的 managed policy 改址绕过详见 SDK 合同，不能被本轮绿色回归抵消。

## stage7：原始请求核心与通道的增量验证

新增原始 fetch 检查点核心、独立确认通道及共享编码提取后，macOS/arm64 与 Linux/arm64 的相关组合均为 6 文件/122 例通过、无跳过，分别 31.74 秒、30.74 秒。包含原生 Anthropic/Foundry/Vertex 假服务与实际工具回归；Linux 使用 stage6 依赖卷并将当前 external-agents 源目录只读挂载，非 root、`--network none`。日志 `/tmp/claude-checkpoint-core-channel-real-final.log`、`/tmp/claude-core-channel-linux-final.log`。

组合后仅通道补充不可序列化动作的失败关闭处理；最新 21 例在 macOS/Linux 各通过，日志 `/tmp/claude-checkpoint-channel-v6.log`、`/tmp/claude-checkpoint-channel-linux-v6.log`。最新 Node 类型 exit 0，边界门禁 exit 0；未重新宣称完整 Node、renderer、应用重构建或所有平台门禁已覆盖这次新增源码。实现及测试身份见 [增量实施记录](claude-sdk-preload-implementation-2026-09-07.md)。

另外，两平台各 7 个实际进程完成 [preload 身份/继承诊断](claude-preload-identity-diagnostic-2026-09-07.md)，[raw fd3 诊断](claude-native-fd3-diagnostic-2026-09-07.md)在两平台完成两笔真实 fsync 确认及正常退出。Bun 的 Socket 接管路径曾在 macOS 失败，已保留；raw 三帧成功尚不等于通用 client、SDK 完整生命周期或生产装配通过。Windows 与完整外部协议的缺口不变。

## stage8：fd 适配、结束握手和 preload runtime

新增异步 fd 适配、显式结束握手、同步安装 fetch 的 runtime，以及 FormData/Request 正文和 drain 支持后，最终 macOS/arm64 与 Linux/arm64 各 9 文件/175 例通过，分别 32.74 秒与 32.81 秒，无跳过。日志 `/tmp/claude-preload-stage8-mac-group-final.log`、`/tmp/claude-preload-stage8-linux-group-final.log`。Node 类型及 boundary gate 均 exit 0；相关 12 文件摘要见 [stage8 记录](claude-sdk-preload-runtime-2026-09-07.md)。Linux 延续 stage6 依赖卷加当前 external-agents/诊断脚本只读覆盖、非 root、断网容器，未扩大为全仓新冻结基线或正式 runner 结果。

两平台的真正 native --version 已通过通用 fd adapter/client/host 的两笔 fsync ACK、finish、实际 fd 和进程关闭。取消实证要求宿主并行关闭对端，才能排空客户端挂起 read；macOS 单方 abort 超时的负向报告保留，不能算作成功。Linux 正向报告及冷读、摘要和清理结果见 [fd 适配器记录](claude-checkpoint-fd-adapter-2026-09-07.md)。新增 runtime 的默认生产连接器安装、真实默认 SDK 回合持久化/恢复、Windows 和正式发行验收仍待完成。

随后两平台还实际运行 native 中的 runtime + fd adapter + 宿主 journal 组合，验证原生 FormData/File/Response、两道保存门和正常结束。报告 `/tmp/claude-native-fetch-runtime-mac-0907-v1/report.json`、`/tmp/claude-native-fetch-runtime-linux-20260907-v1/report.json`。两者都以合成函数充当 transport，不调用网络/模型；不得将默认业务 URL 字符串外推为真实默认 SDK 路由已经通过。

## stage9：正式入口、连接器生命周期与真实 Backend 集成

最终 macOS/arm64 21 文件/281 例、Linux/arm64 22 文件/285 例分别在 35.62 秒、39.42 秒通过，exit 0、无跳过。日志 `/tmp/claude-preload-stage9-mac-group-final-v2.log`、`/tmp/claude-preload-stage9-linux-group-final-v2.log`。Node 类型和架构边界门禁均通过。共同组合增加环境/安装、真实 native、进程所有权及连接器生命周期与既有功能回归；Linux 额外的四例才是新 preload 的真实 SDK + Backend 冷恢复集成。两平台测试范围不能混写，也不累计重叠数量。

Linux 仍为 stage6 依赖卷加当前 external-agents、Backend stream 测试和诊断脚本只读覆盖，非 root、断网。新 SDK 回合保留默认业务 URL，原始 fetch 响应明确合成，没有调用真实云模型。macOS 完成真实 native 的环境继承和正式产物入口验证，但未运行新增四例 SDK query。三端构建、含空格自定义 Server 目录、按真实规则制作的隔离 ASAR 和正式 entry 的 native 生命周期也已通过；没有将其扩大为完整 Electron 发行验收。

首轮旧 Vertex 测试因永不结算 writer 及 afterEach 连带错误失败，两平台原始日志保留；已修可释放屏障，在真实进程关闭后证明 turn 仍等待保存，再放行真实写盘。Vertex 定向 8 例两平台各通过，修复后的上述完整相关组合也通过。详细源码身份、构建日志和仍需默认接线、Windows/NTFS、完整外部执行器及发行兼容的事项见 [stage9 记录](claude-sdk-preload-lifecycle-2026-09-07.md)。此前 stage6 全量基线仍属于历史证据，不能替代本轮未执行的全量检查。

## stage10：运行时预校验、实例所有权与完整回归

新增正式探针、受控启动、Node/Bun 适配、直接程序身份失败关闭、Backend 注册表所有权和三端物理入口解析。macOS 的 bundled native 2.1.214 与用户安装 2.1.259 已分别运行真实 SDK/Backend 四例；Linux 的 Bun npm `bun.exe` 识别误跳已修复。新运行时正式探针及完整日志边界见 [stage10 记录](claude-sdk-preload-startup-2026-09-07.md)和 [Backend 集成记录](claude-preload-backend-integration-2026-09-07.md)。

首次 macOS 全量在外层网络测试策略下有 9 项失败：4 项后台进程检查受 `ps` EPERM 影响，5 项协作摘要暴露夹具 partial mock 与 resetModules 的模块图失配。前者原样在根环境 3 文件/11 例通过；后者修复夹具并新增同模块 A→B 实例回归后 9 例通过，没有删生产关闭检查。随后 macOS v2 完整回归 975 文件/9,670 例通过、3 文件/9 例跳过，71.59 秒，exit 0。

Linux 同源 v2 首次完整回归为 2 文件失败：只读构建目录造成 EROFS，以及没有 init 回收孤儿进程导致 ACP 的 PID 消失断言失败。结果与 28 个真实 zombie 的进程审计已保留。测试容器改为 `--init`、非 root、`--network none`，源码只读、Linux 构建目录可写；在 Linux 重新构建三端产物，摘要与 macOS 正式 preload 一致。原 ACP 测试无需修改，在新容器中 1 例通过，6.33 秒。

v2 的两平台源码/配置发现范围为同一 3,704 文件，SHA256 `9e0cd4c54091347eb7ae3311a6bc44949a39e9422a3e8fbcb749e9d2a60f4ea2`，均运行前后未变。macOS 的成功不能抹去 Linux 的失败，也不替代随后网络见证夹具失败清理修复后的复验。

网络见证清理修复后，v3 使用相同的 3,704 个文件，摘要 `a1677058be60efd20bf4811522c8c9aa64095074a8da1d73cb83ba13899982f4`，前后不变。macOS 975 文件/9,670 项通过、3 文件/9 项跳过，102.20 秒、exit 0；Linux 同样的断言通过但有 2 条未捕获日志流 ENOENT，142.12 秒、exit 1。该失败促成 [插件异步退出与日志流所有权修复](backend-plugin-disposal-2026-09-07.md)，原始报告均保留在 `/tmp/backend-stage10-{macos,linux}-full-20260907-v3/`。

包含该生产修复的 v4 使用相同的 3,705 个文件，摘要 `1128972ab0bece7f13fd201991a462fe9a272498064ae0f02ba072edcb96c3fe`，两平台执行前后不变：

| 平台 | 文件 | 测试 | 时间及实际退出 |
| --- | --- | --- | --- |
| Linux/arm64 | 976 通过、3 跳过 | 9,689 通过、9 跳过 | 79.89 秒，exit 0 |
| macOS/arm64 | 975 通过、1 失败、3 跳过 | 9,688 通过、1 失败、9 跳过 | 60.48 秒，exit 1 |

报告 `/tmp/backend-stage10-{linux,macos}-full-20260907-v4/`。Linux 使用带 init 的断网容器、非 root、独立可写构建输出，实际三端重建后运行。macOS 唯一失败为 HTTP 文件监听 SSE 在 3 秒内只收到连接确认；该用例原样单跑通过仅是对照，不消除全量失败。两边均未再出现日志流未捕获错误。Node/桌面类型、架构边界和两平台 CLI/Server/Desktop shell 构建通过，不代表本轮正式 Electron 打包或公证。

macOS 随后的同源 v5 是增加原生监听旁路记录的诊断全量：仍为 975 文件/9,688 项通过、1 文件/1 项失败、3 文件/9 项跳过，61.66 秒、exit 1。轨迹确认 fs.watch 返回后未发生原生回调，超时后才关闭；同报告 TMPDIR 的 HTTP 整文件 33 项通过。未更改源码、单次业务写入或断言，仍不能视为解决。报告 `/tmp/backend-stage10-macos-watch-trace-20260907-v5/`，详见 [文件监听调查](backend-workspace-watch-investigation-2026-09-07.md)。

Windows/NTFS、正式 runner、默认宿主启用、完整外部协议及正式发行仍未完成。
