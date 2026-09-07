# macOS 工作区文件监听遗漏调查

2026-09-07。该问题在后端架构调整 stage10 最终全量回归中出现。本文保留修复前调查与探针证据；后续独立原生流、实例所有权与打包修复已完成 macOS/Linux 同源全量，见 [stage11 实施记录](backend-workspace-watch-implementation-2026-09-07.md)。不把早期单例通过当作整体通过，也不把上游可能的机制直接认定为本次根因。

## 已复现的行为

HTTP 用例通过通用 RPC 开启 Alice 工作区监听，确认 Bob 越界请求被拒绝，然后只写一次 `watched.txt`，要求已有 SSE 收到这次文件变更。macOS v4 在 3 秒内只收到 `: connected`，最终全量 975 文件/9,688 项通过，1 文件/1 项失败，3 文件/9 项跳过，60.48 秒、自然 exit 1。

同源 v5 增加进程级旁路记录，未改生产代码、业务写入或断言。包装真正的 `node:fs.watch`，只记录本测试隔离目录的 create、returned、callback、error、close；保留原回调、返回值及异常语义，不添加 error listener。完整回归再次发生同一个失败，61.66 秒、自然 exit 1，文件和测试结果与 v4 相同。

两次都是 3,705 个源码/配置文件，摘要 `1128972ab0bece7f13fd201991a462fe9a272498064ae0f02ba072edcb96c3fe`，各自运行前后未变。v5 是带旁路记录的诊断执行，不是未加观测代码的标准成功基线。

v5 原生层记录：

| 时间（Unix ms） | 原生监听行为 |
| --- | --- |
| 1788737009526 | 创建 `/tmp/backend-stage10-macos-watch-trace-20260907-v5/tmp/onething-server-files-FVAM6p/alice/files-workspace` 的 watcher |
| 1788737009526 | `fs.watch` 返回 |
| 中间 3,024 ms | 无 callback、无 error |
| 1788737012550 | 测试超时后调用 close |
| 1788737012551 | 收到实际 close |

这次证据把遗漏定位到原生监听层：不存在“已回调但被沙箱过滤/SSE 转发丢弃”或“提前关闭 watcher”的记录。它尚未区分原生异步启动窗口、系统事件合并/遗漏或其他负载相关因素。

## 对照与已排除项

- 原样单独运行目标 HTTP 用例：1 项通过、32 项按名称过滤，总计 6.08 秒、行为 122 ms。
- 使用同一个报告 TMPDIR 和同一旁路记录，执行整个 HTTP 文件：33 项通过，5.42 秒。原生返回 6 ms 后收到 `watched.txt` 的 rename，再正常关闭。证明当前记录方式能够捕获真实成功回调。
- 直接使用真正 `fs.watch`，每次创建独立目录并只写一次文件：默认临时目录、`/tmp`、`/private/tmp`、报告中的 TMPDIR 四组各 20 次全部收到变更。每次等待 watcher 实际 close 后才删除目录。它们没有复现全量并行负载，不是生产修复或可靠性保证。
- SSE 服务端写出 connected 后在同一同步调用栈登记 handler。测试再等待 watchStart、越界拒绝才写文件，不支持订阅尚未安装的解释。
- `readUntil` 中超时分支会立即结束循环并 cancel，没有遗弃一个读请求后继续读取、吞掉下一个事件的路径。
- 该用例只拥有一个 runtime。全仓唯一生产 `closeAllWorkspaceWatches` 调用处于可等待的 runtime shutdown 中；测试 afterEach 等待全部 shutdown，当前文件不并发执行用例，Vitest 保持默认文件隔离。未发现其他 runtime 晚清理误关此 watcher 的路径。
- libuv 会先 `realpath` 再建立 FSEvents 流。因此 `/tmp` 的别名本身没有直接源码证据；默认 `/var` 临时目录也有符号链接祖先，实际别名对照均通过。

本机 Node v22.22.3、libuv 1.51.0。对应上游的 fs.watch 启动确实先登记并通知 CF 线程就返回，另一线程才创建、启动 FSEventStream，而且从 SinceNow 开始；公开 API 没有原生 ready 确认。这是已确认的机制窗口，尚不是对此次失败的排他性归因。[上游启动实现](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/fsevents.c#L781-L794)，[实际流启动](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/fsevents.c#L339-L348)，[路径规范化](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/fsevents.c#L750-L758)。

## 调查阶段的修复约束与下一步

先明确并验证原生订阅的就绪与失败语义，再决定适配实现。单独增加 realpath、固定等待、重复业务写入或放宽断言，均不能证明问题修复。向被监听目录写就绪标记会增加目录写权限要求，也不能覆盖后续原生流重建，不宜直接作为完整方案。若使用独立原生监听后端，必须评估已有依赖、打包及平台支持，并让启动、失败和实际关闭拥有明确的完成信号；停止和 runtime 退出后不允许迟到安装或通知。

在该调查快照中，没有更改 workspace watcher 生产实现、测试时限或平台功能；当时 Linux 同源 v4 全量通过，macOS 仍失败。后续 stage11 的生产修改和完整验证单独记录，不覆盖这些失败证据。[实施台账](backend-implementation-status-2026-09-06.md)继续列出完整方案未交付的条件。

## 独立原生流的就绪候选

现有开发依赖中安装了 `fsevents 2.3.2`，但根及 workspace 均未将它声明为直接运行依赖；`@parcel/watcher` 未安装。该包允许指定历史游标，使用 `watch(realRoot, 0, handler)`，先丢弃历史业务事件，等待真实 `HistoryDone`（flags `0x10`）后再放行业务写入，可构成独立流的原生就绪候选。它不向被监听目录写额外就绪文件，也不依赖 libuv 共享流；从 0 回放历史的启动成本仍需测量，不能用一次新空目录的结果外推。

现有 arm64 二进制的 stop 路径实际执行 FSEventStreamStop、Unschedule、Invalidate、Release，然后中止并释放线程安全回调。调用方仍需保存第一次 stop 的 Promise 并同步关通知入口，不能依赖包内第二次 stop 来等待第一次，也不能让已排队回调在关闭后通知。

相同冻结探针的两次结果分别保留：

| 执行 | 就绪与单次写入 | 实际关闭及结果 |
| --- | --- | --- |
| 子任务环境 v1 | 15 秒内无任何 callback/HistoryDone；未放行写入，writeCount=0 | stop 约 0.95 ms；PID 61063 实际 close/ESRCH，未强杀，目录已清理；exit 1 |
| 当前环境 root-v2 | watch 返回 4.089 ms；222.579 ms 收到 HistoryDone；唯一写入在 222.852 ms 开始，235.648 ms 收到对应文件事件 | stop 在 238.341 ms 完成；关闭后回调 0；PID 61776 实际 close/ESRCH，未强杀，目录已清理；exit 0 |

执行环境确实不同，但 v1 没有具体 EPERM 证据，不能将失败直接归因于权限。v2 仅证明该 API 在当前隔离新目录下能够完成“原生就绪 → 唯一写入 → 事件 → 实际关闭”，没有验证完整并行负载、已有大型目录、桌面打包或生产适配。

继续实施前需保持的边界：显式声明 macOS 可选运行依赖并验证原生资源打包；让重复 start 共享实际 ready、stop/退出取消尚未就绪的安装并等待真实关闭；保留历史事件隔离与 canonical 路径到请求路径的安全映射；处理 dropped/root-changed 等需要重新扫描的信号；在只读目录、关闭并发和最终全量中验证。不能在原生就绪失败后无声回退到同样缺少就绪保证的实现并报成功。

## 本地证据

- 标准失败：`/tmp/backend-stage10-macos-full-20260907-v4/`。
- 带旁路记录的全量失败：`/tmp/backend-stage10-macos-watch-trace-20260907-v5/`。
- 失败原生轨迹：`/tmp/onething-watch-trace-20260907-47723.jsonl`。
- 同报告 TMPDIR 的 HTTP 整文件成功：`/tmp/claude-preload-stage10-http-fullfile-trace-v1.log`；原生轨迹 `/tmp/onething-watch-trace-20260907-53784.jsonl`。
- 四组直接原生对照：`/tmp/onething-watch-start-diagnostic-20260907.json`、`/tmp/onething-watch-start-diagnostic-tmp-alias-20260907.json`、`/tmp/onething-watch-start-diagnostic-tmp-physical-20260907.json`、`/tmp/onething-watch-start-diagnostic-report-tmp-20260907.json`。
- 旁路记录程序：`/tmp/onething-watch-trace-20260907.cjs`，SHA256 `ce62a1797af822f70ef98a50169a47f09285de25868c0851fe0c74e478407056`。
- 直接原生诊断程序：`/tmp/onething-watch-start-diagnostic-20260907.mjs`，SHA256 `9998fb5a6ae491960bdbf98915c11b4f01c7440e42c858f64de2201f623dde4f`。
- 独立流就绪探针：`/tmp/claude-fsevents-history-ready-probe.mjs`，SHA256 `b8365db92ef6c0f62cb5ef5c75b47a8597de4b7c9683a152ad036e37f462fe1e`；负向报告 `/tmp/claude-fsevents-history-ready-20260907-v1/report.json`，当前环境正向报告 `/tmp/claude-fsevents-history-ready-20260907-root-v2/report.json`。
