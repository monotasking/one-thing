# 运行时内存检查：2026-09-16

检查对象：当前运行的 onething Electron 开发实例，主进程 PID 20505。检查时间为北京时间 16:02–16:12，程序从 15:41 起运行；期间界面仍在使用，部分读数会随操作变化。

## 结论

完整关联环境在采样时约占 **2.0–2.6 GiB**。其中既有桌面程序，也有 MCP 工具、开发服务器，以及另一个已运行 6 天的旧后台实例。

已确认两个重要来源：

1. **React 开发性能记录持续累积。** 浏览器已保存约 17.76 万条记录；清除记录并进行垃圾回收后，界面进程从 **655 MiB 降至 463 MiB，减少约 192 MiB**。前后 DOM 数、事件监听数和 GPU 占用基本一致，这是本次最明确的对照结果。此操作仅临时清理诊断记录，没有修改程序代码；开发模式继续运行仍会重新累积。
2. **后端会话投影长期保留大量工具输出。** 主进程快照中的投影 Map 保留 **40 个会话、1,631 个投影节点**；沿投影数据结构及其存活键对应的物化缓存可达的对象浅大小去重合计约 **128.69 MiB**，其中字符串约 **122.10 MiB**。投影 Map 没有数量、字节或空闲时间淘汰策略，普通会话仓库的 10 项 LRU 不约束它。

另外，界面保留隐藏会话的 React/DOM，聊天历史会在空闲时逐步全部挂载；这些都是确定的常驻机制，但本次没有把它们各自的精确 MB 分离出来。

## 进程内存账目

采用 macOS `top MEM` / `vmmap Physical footprint` 口径，以覆盖已压缩的内存；表中 MiB/GiB 为近似值。不能只看 RSS：例如最初主进程 RSS 约 100 MiB，实际 footprint 已约 506 MiB。也不能把 `VSZ` 的 TB 级虚拟地址预留当作实际内存。

| 类别 | 包含内容 / PID | 16:06:35 | 16:12:21 |
|---|---|---:|---:|
| 主进程与内嵌后端 | 20505：Electron 宿主、会话数据、工具管理、搜索线程等 | 534 MiB | 485 MiB |
| 界面进程 | 20539：React、聊天内容、DOM、脚本、性能记录 | 637 MiB | 448 MiB |
| GPU 进程 | 20536：页面合成、图形资源等 | 481 MiB | 159 MiB |
| 网络服务 | 20537：Chromium 网络服务 | 15 MiB | 15 MiB |
| 当前实例的 MCP 工具 | 20709、20769、20794、20832、20871、20908、20909、20910 | 368 MiB | 370 MiB |
| 开发启动与构建服务 | 20255、20275、20368、20417、20441 | 188 MiB | 189 MiB |
| 旧后台实例及其 MCP | 13100、13174、13180、13203、13226、13229 | 414 MiB | 414 MiB |
| **合计** | 所列关联进程的 footprint 近似相加 | **2,637 MiB ≈ 2.58 GiB** | **2,080 MiB ≈ 2.03 GiB** |

后一次读数已经经过性能记录清理与快照采样。两列之间还发生了界面操作、垃圾回收及图形资源变化，**不能把总差额全部归因于性能记录清理**。

16:12 的组成：桌面四个 Electron 进程约 **1.08 GiB**；加当前实例 MCP 约 **1.44 GiB**；加开发服务约 **1.63 GiB**；再加旧后台约 **2.03 GiB**。其他编辑器、测试扩展、Codex 自身没有计入这张表。

当前 MCP 子进程里有两个 `chrome-devtools-mcp` 实例，各自带 npm 启动器和 watchdog，另有一个 puppeteer MCP。它们可能对应不同配置，本次只确认并计量，没有认定为重复故障或终止它们。旧后台的 PPID 为 1，已运行约 6 天；也没有未经核实就将它停掉。

## 界面：实测出的具体内容

### 1. React 开发性能记录：对照测量回收约 192 MiB

16:11:23–16:11:25 在同一页面进行对照：先垃圾回收并取样，再调用 `performance.clearMeasures()`，再次垃圾回收并取样。

| 指标 | 清理前 | 清理后 |
|---|---:|---:|
| PerformanceMeasure 条数 | 177,604 | 0 |
| 界面 footprint | 655 MiB | 463 MiB |
| JS heap used | 80.16 MiB | 77.45 MiB |
| CDP embedder heap used | 38.56 MiB | 16.63 MiB |
| CDP DOM 节点数 | 15,559 | 15,559 |
| 文档内元素数 | 3,017 | 3,017 |
| JS 事件监听数 | 2,615 | 2,615 |
| GPU footprint | 159 MiB | 159 MiB |

记录名称集中在 `ForwardRef(ButtonBase2)`、`Fold`、`SegmentView2`、`Tooltip`、`ToolStepRow2` 等组件，名称前带 U+200B，detail 包含 `devtools`。

本地安装的 React DOM 19.2.8 开发包会在组件 props 变化时调用 `performance.measure`，并记录 props 差异。它只检查浏览器是否提供相关 API，没有要求正在打开 DevTools 录制；该开发包及应用代码均没有清理这些 measure。生产版对应包没有这些 `performance.measure` 调用。

- [React 开发包创建组件计时记录](/Users/yitiansong/data/code/start-electron/apps/desktop-react/node_modules/react-dom/cjs/react-dom-client.development.js:4104)
- [调用 performance.measure](/Users/yitiansong/data/code/start-electron/apps/desktop-react/node_modules/react-dom/cjs/react-dom-client.development.js:4153)
- [计时启用条件](/Users/yitiansong/data/code/start-electron/apps/desktop-react/node_modules/react-dom/cjs/react-dom-client.development.js:25524)
- [当前开发启动方式](/Users/yitiansong/data/code/start-electron/apps/desktop-react/scripts/dev-app.mjs:68)

快照中 177,303 个原生 PerformanceMeasure 对象自身合计 20.42 MiB；这只是浅大小，未涵盖所有关联数据和浏览器分配器成本。对照测得的 192 MiB 释放量比它大，因此不能仅凭 JS heapUsed 来判断这一问题是否严重。应用自身的性能日志环形缓冲只有 200 项，不是这 17 万条记录的来源。

### 2. 隐藏会话与完整历史：确实仍在内存中

首次取样时，CDP 报告 **25,150 个 DOM 节点、20,924 个布局对象、3,134 个监听器**；文档内有 16,749 个元素，其中主内容区域约 16,511 个，明显集中在聊天内容。

随后另一轮取样发现 3 个隐藏会话 frame，分别含 917、308、2,233 个子元素，CSS 为 `content-visibility:hidden`。这说明隐藏页面并没有被卸载。期间用户操作改变了会话和 DOM 数，不能把两轮读数作为泄漏增长曲线。

代码中的保留机制：

- 每个 pane 额外保留 3 个切走会话的 UI；所有打开标签页也同时挂载。[session-park.ts](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/session-park.ts:90)、[PaneLeaf.tsx](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/workbench/PaneLeaf.tsx:345)
- 聊天初始窗口较小，但空闲任务每次向前扩 48 条，直到已加载历史全量挂载。`content-visibility` 能减少渲染工作，不释放 React/DOM。[ChatStream.tsx](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/ChatStream.tsx:821)
- UI 卸载后，还有最多 8 个会话数据源常驻，可能保留历史、工具结果与附件 base64；数量限制没有对应字节预算。[chat-source.ts](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/data/chat-source.ts:2291)
- 消息块解析有 2,000 项缓存；代码高亮器首次使用加载 16 种语言，并缓存 64 份源码/token 结果。[assemble/index.ts](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/assemble/index.ts:52)、[highlight.ts](/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/content/code/highlight.ts:30)

### 3. 界面堆快照的构成

清理性能记录前采集到约 133 万个快照节点。以下是快照记录到的浅大小分类，合计约 148.41 MiB，**并不覆盖界面进程的全部 footprint，也不是可直接释放的独占内存**：

| 分类 | 浅大小 | 说明 |
|---|---:|---|
| native | 75.43 MiB | 包括外部字符串存储 34.48 MiB、PerformanceMeasure 20.42 MiB、InternalNode 12.99 MiB 等 |
| code | 30.79 MiB | V8 编译代码及元数据 |
| string | 22.80 MiB | 普通 JS 字符串 |
| array | 10.19 MiB | 数组及内部存储 |
| object | 6.01 MiB | 普通对象，其中 9,791 个 FiberNode 自身约 1.34 MiB |
| 其他 | 3.19 MiB | 对象形状、闭包、数字等 |

这些行互不重复；说明栏中的数字是所属行的子项，不能再次加总。不能把所有 ExternalStringData、InternalNode 都归因给性能记录。

## 主进程：会话与工具输出是 JS 堆大头

当前桌面主进程直接承载 backend；搜索使用 worker thread，因此线程内存也计入该 PID。[main.ts](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/main.ts:236)、[搜索 worker](/Users/yitiansong/data/code/start-electron/packages/backend/wiring/search/worker.ts:122)

主线程快照记录约 172 万个节点，浅大小合计 220.27 MiB，其中：普通字符串 **167.26 MiB**，内部数组 **16.31 MiB**，code **13.40 MiB**，object **9.61 MiB**，closure **7.75 MiB**。快照前主线程 JS heap used 约 194 MiB；快照还包含部分 native 信息，因此不能与 JS heap 或进程 footprint 混作同一口径。

主要业务持有路径已经从快照确认：

```text
Electron App 生命周期事件
  → 主模块闭包
  → appendObservers
  → observer 闭包中的 projections Map
  → 会话 state.nodes
  → assistant.tools
  → 工具结果 metadata.output / annotatedText 等长字符串
```

另有物化视图：

```text
模块级 lists / memos WeakMap
  → ChatMessage[]
  → toolCalls[].result.attachments[].content
```

- **40 个会话投影的可达数据图浅大小去重合计约 128.69 MiB，其中字符串 122.10 MiB。** 这是沿数据属性、Map/Set 内部表及其存活键触发的 WeakMap 值引用遍历得出的可达大小，未做完整 dominator retained-size 分析，不能说淘汰 Map 就一定释放 128.69 MiB。
- 物化消息缓存 `memos` 有 **1,628 项**，`lists` 有 **37 项**；其数据图约 **45.68 MiB**，已包含在上述可达数据图中，**不能再加到 128.69 MiB 上**。
- 投影 Map 没有 LRU/容量/TTL，仅在会话删除、显式重置或整个 backend dispose 时清理。[projection-cache.ts:103](/Users/yitiansong/data/code/start-electron/packages/backend/session/projection-cache.ts:103)、[清理入口](/Users/yitiansong/data/code/start-electron/packages/backend/session/projection-cache.ts:298)
- 物化消息会深拷贝并补水；WeakMap 的键又被投影 Map 强引用，因而不会仅因“切走会话”而回收。[materialized-messages.ts:80](/Users/yitiansong/data/code/start-electron/packages/backend/session/materialized-messages.ts:80)、[深拷贝和补水](/Users/yitiansong/data/code/start-electron/packages/backend/session/materialized-messages.ts:154)
- 最大单个源码字符串约 **21.85 MiB**，其持有者是主 bundle 脚本的 `source`。磁盘上的 main.cjs 为 11.11 MiB，source map 为 27.28 MiB；磁盘文件大小本身不能直接充当运行内存。

全堆按直接引用字段归类，`output` 引用的字符串约 35.10 MiB、`text` 23.46 MiB、`content` 18.77 MiB、`result` 10.40 MiB、`diff` 9.98 MiB、`annotatedText` 7.12 MiB。这进一步支持工具输出与历史正文是业务数据的大头；同一字符串可能被多个字段引用，这些分类也不能直接相加。

主进程 footprint 中其余部分包含 Chromium/Electron 原生分配、其他 V8 isolate/线程、数据库、分配器保留页等。本次没有把全部剩余内存继续准确归到每个子系统；也不能简单用 footprint 减掉 heapUsed 就称为“泄漏”。

## 排除项与边界

- **不是本地语义模型的常驻权重。** 当前配置 `search.semantic.enabled=false`。语音虽开启，但 `alwaysOn=false`、wake disabled；本次没有本地唤醒模型开启的证据。
- **当前没有实际加载的内嵌网页 renderer。** Electron 的 webContents 列表只有主界面，以及一个 URL 为空、OS PID 为 0 的窗口对象。浏览器面板存在，不代表它已有完整网页进程。
- **事件 shadowTail 本次不是主因。** 主进程快照中查到的 41 份尾部数组均为空。代码的 200,000 条上限虽很宽，不能据此把当前内存归给它。
- **不能凭一组快照断言所有增长都是泄漏。** 当前明确确认的是开发计时记录积累，以及没有淘汰策略的会话投影常驻；其他缓存有些是有意用内存换切换速度。
- `vmmap` 对 Electron PartitionAlloc malloc zone 有解析警告，因此本次没有用其 malloc zone 分类硬推对象归属；进程 footprint、CDP 读数与堆图结合判断。

## 建议处理顺序

1. **先限制开发模式 User Timing 记录生命周期。** 在性能服务中设置保留策略，并保留显式录制能力；日常运行可用生产 renderer。仅关闭 StrictMode 不足以根治这个来源。
2. **给后端会话投影与物化数据统一设置字节预算和空闲回收。** 对活跃运行/已订阅会话固定保留；闲置历史可从检查点或事件日志恢复。大工具输出/附件尽量按引用与需用范围读取，避免完整补水后长期留在 Map 中。
3. **限制隐藏 UI 的成本，并采用真正有界的历史渲染窗口。** 可继续保留滚动位置/草稿，但不要让所有历史和最近会话的整个 DOM 无条件常驻。
4. **分别核实 MCP 多实例和旧后台的用途，再精简启动。** 开发服务约 189 MiB 属于开发环境成本，生产运行不应照搬这一总量。

本次只新增本报告，没有修改已有程序文件。执行过一次诊断性能记录清理和垃圾回收；临时开启的主进程 inspector 已关闭，原有 renderer 调试端口保持原状。没有关闭业务进程、重启程序或更改会话数据。

## 方法参考

实际结论来自本机进程采样与两份 heap snapshot；调试接口和内存 API 的定义参考 [Electron 主进程调试文档](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)、[Electron 调试开关](https://www.electronjs.org/docs/latest/api/command-line-switches)、[Electron process 内存接口](https://www.electronjs.org/docs/latest/api/process)。
