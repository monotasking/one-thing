# 插件系统:审查结论与修订设计(2026-08-06)

本文是对 [`plugin-system-capabilities-and-evolution.md`](./plugin-system-capabilities-and-evolution.md)
的四路代码审查结论(事实核查 / 架构契合 / 对抗批判 / 成熟插件架构对照)+ 修订后的设计。
**原文档第一、二部分(现状与病因诊断)经逐条核实基本成立,继续有效,勘误见 §2;
第三部分(P0–P7 方案)由本文档取代。**

一句话结论:原文档的诊断是认真做过功课的,不是"随便拉的一坨";但它的方案有一个
致命缺口(隔离要求全线无着落)、一个致命盲区(多宿主现实)、一处排期依赖写反、
若干接口层面的错误决定 —— **照它执行,做出来的会是"能跑但撑不起平台野心"的系统**。

---

## 1. 对原文档的判定

### 1.1 诊断部分(第一、二部分):合格,且经得起对抗核查

13 条核心事实断言逐条对照代码:10 条 confirmed、2 条 imprecise、1 条 wrong(见 §2)。
几个最有价值的判断都是真的:

- `CorePluginAPI` 13 项能力面与 `packages/core/plugins/types.ts:116-142` 逐行对应,无实质漏列
- `PluginSettings` 独立文件、`AppSettings` 无 plugins 字段 —— 属实,P0 的关键前提成立
- `minAppVersion` 全库唯一出现处就是声明处(`core/plugins/types.ts:7`),零消费 —— 属实
- §1.4 "够得着与够不着的注册表" 七个 ❌ 全部核实:函数都在,api.ts 的 host 对象对它们零转发
- 用户插件裸 `import()` 跑主进程、note-skills/log-monitor 零越界 vs soul-memory 16,989 行的对照组论证 —— 全部属实

"拆除测试(卸载后宿主树 git diff 为空)"这个北极星判据、A/B/C 三线正交拆分、
"AI 行为被严管而承载 AI 的代码不设防"的不对称提炼、P4 "泛化成员优于枚举"、
P2 拒绝让插件塞 Vue 组件 —— 这些都是对的,修订方案全部保留。

### 1.2 方案部分(第三部分):方向多数正确,但不能照着执行

按用户的两条核心要求衡量:

- **要求 A(强大——像 VS Code 一样"在上面开发产品")**:P2 声明式 UI 表达力天花板焊死
  (webview 无限期推迟)、无激活模型、无 API 稳定契约、§1.5 自己列的三个缺口
  (自定义事件/插件间通信/热重载)无一期承接 —— 达不到。
- **要求 B(隔离——插件出问题宿主可感知但不被拖垮)**:P0–P6 全是能力扩展,
  P7 三步没有一步是运行期故障处置,且 P7 被标注"只跑自家插件可以一直欠着"。
  **按路线图走完,要求 B 永远不被满足。** 这是最大的单点问题。

---

## 2. 原文档勘误表(需要回改原文的具体错误)

| 位置 | 原文说法 | 实际 |
| --- | --- | --- |
| §1.1 store 行 | KV 在 `<store>/agents/<agentId>/plugin-data/<id>.json` | 实际在 `<store>/plugin-data/<pluginId>.json`(`core/plugins/store.ts:19`、`runtime/src/storage/paths.ts:242-246`),没有 agent 作用域一层。**插件数据 per-agent 还是全局,是一个未做过的决策**(见 §5 R4) |
| §1.1 store 行 | (P1)"加原子写替换现在的全量重写" | 底层 `writeJsonFile` 已是原子写(写 tmp 再 rename,`core/storage/json-file.ts:205-211`)。缺的是分文件与跨进程锁,不是原子性 |
| §1.2 | 用户插件读 `manifest.json` | 实际读 `plugin.json`(`core/plugins/loader.ts:156`);缺失时降级为 `{name, version:'0.0.0'}` 继续加载,不是硬要求 |
| §1.2 / §1.5 / P7 | "三个内置插件" | soul-memory 删除后只剩 2 个:log-monitor、note-skills(`app/plugins/loader.ts:59-74`) |
| §1.5 错误隔离行 | "运行期异常没有专门的隔离边界" | **说反了。** 每个宿主→插件调用点都有 catch:事件 handler 双通道包裹(`core/plugins/api-builder.ts:155-172`)+ EventBus 再兜一层;promptContextProvider 逐 provider catch(`runtime/src/prompts/plugin-context.ts:98-121`);afterAssistantResponse 双层且 fire-and-forget(`core/plugins/lifecycle.ts:103-114`);工具异常转 `{success:false}` 工具结果(`core/tools/registry.ts:501-515`)。**异常不会打断流引擎。真正缺的是超时、熔断与可见性(§3.1),不是 catch** |
| §1.5 | 加载错误记进 `definition.error` | 实际写入 `CorePluginInfo.error`(`core/plugins/manager.ts:196`);UI 效果描述正确 |
| P0 落地步骤 2 | "schema 校验在 core/plugins/api-builder.ts 做,zod 已是既有依赖" | **撞 core 边界:boundary checker 的 CORE_FORBIDDEN_PATTERNS 禁 zod,packages/core 今天零处 zod。** 校验只能在 app 层做(`app/plugins/api.ts` 已 import zod),core 保留泛型契约 —— 与 registerTool 既有分层同构 |
| P1 落地步骤 3 | "manager.ts 的 uninstallPlugin 里加归档" | **uninstallPlugin 不存在。** CorePluginManager 只有 initialize/enable/disable/refresh/shutdown;今天唯一的"卸载"是用户手删目录,宿主无感知。P1 实际要先发明整个卸载流程 + 孤儿检测,成本被低估一档 |
| P2 | "4 处手工同步联合类型" | 当前分支实际 ≥6 处,且已经漂移出两处不一致:`Sidebar.vue:672` props 残留死成员 `'memory'` 而 `:676` 本地类型已无;`MediaPanel.vue:466` 多出 `'archive'` 成员;workspaceActions 漏 practice(只能靠 App.vue 的 window 事件进入)。**注册表方案动机反而被加强,但落地清单要重盘** |
| P3 | "现成的地基 defineRouter" | `core/ipc` 的 defineRouter 是死基建:全库唯一调用是它自己的测试,createRouterAPI 零消费者,注释还引用着已退役的 memoryFeedbackRouter。且它生成静态 domain:method 表,与动态 `pluginId+action` 分发是两种形状 —— **方案其实不需要它** |
| P4 验收 | "`packages/shared/ipc/chat.ts` 零改动" | 措辞不成立:ContentPart 就定义在该文件,加泛化成员本身就是改它一次。成立的说法是"**此后每个插件**零改动" |
| P6 表 | 开放 `registerBuiltinCapabilities` / `registerBuiltinTriggers` | 两个都是无参的内置打包函数(后者带 registered-once 闩)。该开给插件的是 `registerCapability`(`core/permission/capability-registry.ts:63,67`)与 `triggerManager.register`(`core/engine/triggers.ts:109,125`) |
| P6 建议 | "第一个试点变量提供者(无状态、卸载语义最简单)" | **恰好选反:VariableRegistry 是五个注册表中唯一没有 unregister 的**(`runtime/src/variables/registry.ts:46`)。形状最适配的是 IM 连接器(registerIMConnector 直接返回退订函数) |

---

## 3. 原方案未覆盖的关键缺口

### 3.1 【critical】要求 B 全线无着落 —— 但答案比原文档以为的便宜

勘误表已说明:异常层面的 catch 是齐的。真实的故障面是**挂起、慢与不可见**:

- `collectPluginPromptContext` 对每个 provider **顺序 await、无超时**
  (`runtime/src/prompts/plugin-context.ts:98-121`),挂在系统提示词装配上,即**每次发消息的热路径**
  (`prompts/builder.ts:457`)。一个挂起不 resolve 的 provider = **所有会话的消息发送永久卡死**,
  而插件卡片仍显示 Active —— error 只在加载期写入,运行期错误不进任何用户可见状态。
- `beforeContextCompact` 同样被 await 在压缩路径上(`app/engine/context-compact.ts:90`)。
- 用户插件 needsInstall 时走 **`execSync('npm install')`,timeout 120s**
  (`app/plugins/loader.ts:94-99`)—— 同步调用,期间整个主进程含全部 IPC 冻结最长 2 分钟。
- `refreshPlugins` 对所有 enabled 插件**顺序 await**,`await entry(api)` 无超时
  (`core/plugins/manager.ts:104-106,180`)—— 一个坏插件卡住其后所有插件,
  而 skills 加载明文排在 plugin bootstrap 之后(`main-process.ts:199-205,239`),等于间接卡掉 skills。

这些都是**天级成本、in-process 可做、不依赖沙箱**的"软隔离":逐 hook 超时预算、
失败计数熔断(连续 N 次自动禁用 + 设置页亮红)、运行期错误归因到插件卡片、
npm install 异步化、逐插件隔离加载。原方案把一切隔离都归入"第三方生态才需要"的 C 线,
是**把 A 线义务错捆进了 C 线** —— 自家插件一样会挂,soul-memory 的 capture 车道就是自家代码。

### 3.2 【critical】多宿主盲区:插件系统今天只在 Electron 桌面真正运行

原文档通篇没有说明这一点,而它直接决定 P0–P4 的价值边界:

- `bootstrapPluginSystem` **全库唯一调用点**是 `apps/electron/src/app/main-process.ts:201-202`;
  `createOnethingBackend` 本身不装配插件。
- **apps/server 的插件是目录假象**:`ServerPluginCatalogManager`(`apps/server/src/runtime.ts:920-1054`)
  扫 manifest 做目录,但所有 entry 都是 `noopEntry: async () => {}` —— `/api/plugins` 六条路由
  能 list/enable/disable,**插件代码在 server 上从不执行**,工具/提示词注入/hook 在 server 会话全部缺席。
- server 的插件设置文件在 `owners/<userId>/<workspaceId>/plugin-store/` 下,
  与桌面的 `getCorePluginSettingsPath()` **不是同一个文件** —— 两边 enabled 位各说各话。
- CLI daemon(HeadlessBackend)与 gateway 对 plugin 零引用。

因此 P3 承诺的"通道只加一次,任何插件零成本获得 Electron + web 双端能力"**今天没有 dispatch 目标**:
server 侧路由通了也无人应答。让它成立的前置(server 用真 PluginManager 替换 noop 目录)是一笔
未列入任何一期的工作。见 §6 的决策点。

### 3.3 【major】排期依赖写反:P2 依赖 P3,不是 P3 依赖 P2

P2 的声明式面板渲染在 renderer(web 端在浏览器),插件代码在 backend 进程 ——
枚举面板、拉 render 结果、回传 action、推送刷新,**每一步都要过一条 renderer→backend 的
插件寻址通道,这正是 P3**。P0 的设置读写同样隐式需要它(现有 plugins IPC 域只有
list/enable/disable/refresh/commands/execute-command,无 config 读写)。
**P0/P2/P3 共用同一条传输层,传输层必须先行。**

### 3.4 【major】序列化断层未被设计 —— 而它是"将来不用重来"的全部保险

`registerSettings` 收活 zod schema,但要渲染它的设置页隔着 IPC(web 端隔着 HTTP),
活对象过不去。修法现成:**过线一律 JSON Schema**(仓库已有先例:工具注册表用
zodToJsonSchema 给 provider 出参数),zod 只是插件侧书写糖。
这不是 P0 一处的问题,是一条要立刻立法的总原则(§4 宪法第 2 条):
P2 描述树碰巧可序列化做对了,但若不成文,它会是孤例;P7 真沙箱时
registerTool/provider/hooks 全要再议一遍 RPC 形态。`config.get()` 也要现在就定义成
**快照语义 + onChange 推送**,同步跨进程读取在硬隔离后不可能成立。

### 3.5 【major】API 稳定契约缺席,且契约整层泄漏宿主内部类型

`PluginPromptContext.settings` 直通整个 `AppSettings`;`AfterAssistantResponseContext`
暴露 `ChatSession/ChatMessage/ProviderConfig` 全型。这个仓库的历史就是设置结构、会话结构
反复重构 —— 每次重构都是对插件的静默 breaking change。VS Code 生态成立的前提恰是
vscode.d.ts 冻结面。缺:append-only 政策、窄类型视图、`minAppVersion` 真正生效(半天工作量)。

### 3.6 其余(严重度递减)

- **§1.5 自认的三缺口(自定义事件、插件间依赖/通信、热重载 ESM 缓存)无一期承接**,
  连"明确决定不做 + 理由"都没写。热重载是平台开发体验的地板(对照 VS Code 的 F5
  Extension Development Host);裸 `import(entryPath)` 无 cache-buster,改插件代码要重启整个 app。
- **无激活模型**:全量 eager load;manifest 化(§4 第 3 条)是懒激活的前置结构。
- **P4 plugin-status 无生命周期**:只有 label,没有 id / clear / 超时自清 ——
  插件中途崩掉,气泡状态永远停在"Extracting…"。与 3.1 互为放大器。
- **P3 请求通道无 abort/进度/流式语义**:产品级面板必有长任务;宿主工具执行上下文里
  abortSignal 是一等公民,插件通道反而没有,第一天就不够用。
- **拆除测试对数据/状态残留全盲**:git diff 只看代码树。plugin-data 文件、permission grants、
  usage 账本历史行、会话 JSONL 里的历史 tool-call(拆后 retry 走 tool-not-found)都不在判据内。
  soul-memory 自己就是判例:usage 至今要兼容 `source:'memory'`。
- **P6 只有问题清单没有决策框架**:四个注册表的停用难题一个倾向性答案都没给。

---

## 4. 架构本质与设计宪法

### 4.1 "强大 + 隔离"同时成立的本质:窄腰强 API

对照 VS Code / Figma / 浏览器扩展 / Obsidian,结论是同一个:
**把「插件能表达什么」与「插件代码在哪执行」解耦。** 宿主承诺一个语义化、可序列化、
可撤销的产品级 API 作为插件影响世界的**唯一通道**,并把最高频的集成 ——
在 UI 里占一席之地 —— 进一步降级为**纯数据声明**(contribution points / 描述树),连运行代码都不需要。
正因为一切影响都必须过这一条被中介的窄边界,API 才敢开得大:误用打不穿宿主内部状态、
插件侧可整体 kill/重启、UI 永不执行插件代码。**隔离不是把插件能力关小,
而是把通道收窄成唯一边界后,放心地把边界上的 API 做宽。**

反例就是今天的本仓库(= Obsidian 模式):通道即整个进程,"强大"免费,
但宿主被反向锁死 —— soul-memory 的 16,989 行就是这个模式的账单。

两个裁决性判例:

- **vm/Realms 类"同 realm 软隔离"从 P7 候选中划掉**:Figma 最初用 Realms shim,
  被安全研究者逃逸攻破后弃用改 QuickJS。选项收敛为"**独立进程,或不隔离**"。
- **QuickJS 类解释器沙箱也不可行**:本仓库用户插件带 package.json、loader 自动 npm install,
  是真 Node 程序 —— 能保留现有插件模型的硬隔离只有**独立进程**一条路。

本仓库距离目标形态比表面近得多,三个结构优势已经在手:

1. UI 与插件**已经隔着进程**(插件在 backend,UI 在 renderer/浏览器,中间是 IPC/SSE);
   "UI 不执行插件代码"这条 VS Code 花大力气守住的不变量,今天免费成立(唯一 UI 触点是 ui.notify)。
2. `CorePluginAPI` **已经是唯一注入对象**(api-builder 的 host-adapter 模式)——
   天然的 RPC 接缝,将来换成 RPC stub 插件无感。
3. NDJSON-over-unix-socket 的 RPC 传输在 CLI daemon 已有现成实现。

**缺的不是进程边界,是边界上的贡献机制(manifest 化声明 + 描述树 + 统一通道)
和 append-only 的 API 承诺;进程剥离反而是最后一小步。**

### 4.2 设计宪法(六条,先于一切排期)

1. **唯一通道**:插件的全部权力 = 注入的 `api` 对象。用户插件禁止 import 宿主 bundle 内模块
   (今天无守卫,R0 补)。这是日后任何沙箱化的先决条件。
2. **过线皆可序列化**:凡跨 api 边界的数据必须 JSON-可序列化 ——
   schema 过线用 JSON Schema(zod 只是插件侧糖);回调按 id 分发;描述树禁函数成员;
   `config.get()` 是快照语义 + onChange 推送。这一条是"P7 时不用重写全部 API"的保险。
3. **声明先于代码**:`PluginManifest` 加 `contributes` 段(panel / command / settings schema /
   permissions / activation)。宿主只读清单即可渲染插件的全部 UI 存在感,不执行一行插件代码。
   顺带解锁:懒激活、未启用插件的设置展示、权限声明的安放处。
4. **隔离分两层**:软隔离(超时预算、失败熔断、错误归因、健康状态)是 **A 线义务,立刻做**;
   硬隔离(backend 的 Node 子进程 extension host,不是 renderer 的兄弟进程)是生态门槛,
   但若 server 开始真跑插件则提前(远程可触发的主进程级代码)。
5. **API 契约**:`CorePluginAPI` 明文承诺 append-only;`minAppVersion` 立即生效;
   插件上下文只给窄类型视图,不再直通 `AppSettings` / `ChatSession` 全型。
   新 API 可标 `internal`(仅内置插件可用)作为 proposed 机制的简化形态。
6. **拆除测试升级为双面**:代码侧从一次性验收升级为常设 CI 守卫;数据侧补足迹契约 ——
   宿主可枚举一个插件的全部落盘足迹,孤儿检测 + 归档自动化。

---

## 5. 修订路线图(取代原 P0–P7 排期)

原各期的编号与正文继续沿用(便于对照),这里给出修订后的顺序、每期的修正点与新增期。

```
R0 守卫(原 P5 扩)      ── 独立,先行,后续各期受其保护
R1 软隔离(新增)        ── 要求 B 的 A 线义务,不依赖任何期
R2 地基(原 P3 前移+扩) ── 统一通道 + manifest contributes + minAppVersion 生效
      ↓
R3 配置(原 P0 修正)    ── 依赖 R2 的通道与 JSON Schema 约定
R4 数据(原 P1 修正)    ── 真卸载流程 + 孤儿检测;可与 R3 并行
      ↓
R5 声明式 UI(原 P2)    ── 依赖 R2 通道;面板注册表收编现有 ≥6 处同步点
R6 状态(原 P4 修正)    ── 小;R1 之后任意时点(需流结束清扫钩子)
R7 注册表(原 P6 修正)  ── R4 之后按需逐个开
H 线 多宿主与硬隔离      ── server 真跑插件 + backend 子进程 ext host(见 §6)
```

- **R0 守卫**(原 P5 三条全保留)新增两条:用户插件禁 import 宿主模块的静态检查;
  "拆除测试"CI 化(对每个内置插件做 registry 快照对比)。
- **R1 软隔离**(新):promptContext / compact 钩子逐 provider 超时预算(先例:权限 120s 降级);
  失败计数熔断 → 自动禁用 + 设置页红态 + `ui.notify`;运行期错误写入 `CorePluginInfo`
  级别的健康状态供 UI 消费;`execSync npm install` 改异步 + 状态可见;
  `refreshPlugins` 逐插件隔离(一个坏插件不卡队列,skills 不再被间接卡)。
- **R2 地基**:一条 `plugin:request` IPC 通道 + server `/api/plugins/:id/:action` 参数化路由
  (【勘误 2026-08-07】原文写"matchRoute 目前全是精确匹配,这是第一条带参路由"是错的 ——
  实施时核实 http.ts 已有 12 条参数化路由,沿用既有 `withX(encoded, handler)` 闭包模式即可;
  在 server 真跑插件前,该路由明确返回 501 而非静默无应答);
  通道语义从第一天含 **requestId / abort / progress**(对齐工具执行上下文的 abortSignal 一等公民);
  manifest `contributes` 段类型进 `core/plugins/types.ts`,loader 扫描期注册;
  `minAppVersion` 在加载前比对(与 needsInstall 检测同处);
  立法"过线皆 JSON Schema"(工具层 zodToJsonSchema 为先例)。
- **R3 配置**(原 P0 修正三处):校验与默认值填充在 **app 层**(core 禁 zod);
  schema 过线转 JSON Schema 供两端设置页渲染;`config.get()` 定义为快照 + onChange。
  存储设计(PluginSettings 加 config 字段)不变 —— 这部分原案是对的。
- **R4 数据**(原 P1 修正):先发明卸载流程(设置页入口 + IPC + 目录感知),归档才有挂点;
  补孤儿检测(启动/刷新时扫 plugin-data 下无主目录并归档)—— 手删目录这条现实路径才被覆盖;
  现有 KV 文件 `plugin-data/<id>.json` 并入 `plugin-data/<id>/` 目录一起归档;
  **决策并落文档:插件数据作用域是全局还是 per-agent**(现状是全局,原文档写错成 per-agent;
  本产品已是多 agent 形态,这个决策不能再糊着)。
- **R5 声明式 UI**(原 P2 修正):面板注册表除收编联合类型外,还要收编 App.vue 的
  window 事件入口(practice/agents/tasks)与 MediaPanel 的 archive 特例;
  描述树 schema 禁函数成员(宪法第 2 条);静态存在感(id/label/icon)走 manifest(宪法第 3 条),
  entry 只负责 render/onAction;**webview 逃生舱给明确期号(H 线)与前置条件
  (R1 软隔离 + 独立 origin + CSP + postMessage-only + ui.* token 注入,配方照抄 VS Code)**,
  不再"无限期不在第一版"。
- **R6 状态**(原 P4 修正):`{ id, label }` + `clear(id)` + 宿主在流结束时强制清扫兜底。
  投递轨道现成(`content:part` 会话事件经 IPCBridge/SSE 双扇出,desktop 与 web 免费);
  gateway 文本渠道不可达,写明是有意降级。
- **R7 注册表**(原 P6 修正):目标函数改为 `registerCapability` 与 `triggerManager.register`;
  先给统一卸载决策框架(拒绝停用 / 降级到默认 / 允许失败,三选一的判定标准),
  再逐个开;试点改为 **IM 连接器**(唯一自带退订函数、形状最适配 onDispose),
  变量提供者要先给 VariableRegistry 补 unregister 才能开。
  每开一个注册表,写明它"仅在跑插件的宿主生效"造成的行为分叉(desktop 有 / server 无)。

原文档 §1.5 三缺口的归属:**自定义事件**并入 R2(通道语义的自然延伸:插件可 emit 带
`plugin:<id>:` 前缀命名空间的事件);**热重载**并入 R2(import 加 cache-buster query,
配 dispose/reload 生命周期即可,平台开发体验的地板);**插件间依赖/通信**明确推迟到 H 线后
(写明"决定不做 + 理由:单一作者期无需求")。

---

### 5.1 R0/R1 落地后的评审修订(2026-08-07)

R0+R1 已实施(`a3114b48`、`888a25e8`)并经三路评审(代码审 ×2 + 独立复验)。
以下是评审后对方案本身的修订与澄清 —— **与原方案的差异逐条写明**:

**语义修订(评审发现原方案未定义、实施时需要拍板的点,现拍板如下):**

1. **熔断计数按 pluginId+scope,不按插件级混计**。原方案只写"失败计数熔断(连续 N 次)",
   未定义计数粒度。混计会产生假阴性(成功钩子清掉挂死 provider 的失败)与假阳性
   (纯事件插件偶发错误跨天累计)。修订:某一 scope 连败达阈(3)即触发插件级熔断,
   成功只清同 scope。
2. **自动禁用持久化 enabled:false,且 disabledReason 一并落盘**。原方案只写"自动禁用+可见",
   未言持久化。拍板:持久化(坏插件不应重启复活),且原因必须随之落盘 ——
   否则重启后变"无因禁用",可见性承诺只活一个进程周期。
3. **超时预算覆盖整个加载链**(模块动态 import + entry(api)),install 阶段单独预算。
   原方案措辞"entry(api) 加超时"字面不含模块加载,而 top-level await 挂起恰好从这条缝
   穿过去卡死 skills。
4. **api 注册入口带 disposed 闩**。超时后晚到的注册不再落成永久孤儿;彻底解法
   (可整体 kill 的子进程)仍在 H 线,闩是 in-process 能做到的最大止损。

**覆盖范围声明(原方案措辞会让人高估守卫能力,现写明边界):**

5. core-免知守卫只认**已知 token 集**(builtin 目录 id + 退役名单)。原方案验收例
   "core 里写 general.somePlugin.x 应报错"仅当 somePlugin 已在 token 集中才成立;
   新插件/新退役功能必须进名单才受保护。
6. 宪法第 1 条(插件只准用注入的 api)的静态检查当前仅覆盖仓库内两处范本
   (runtime 内置插件实现 + sample-plugins);**真实用户插件(`<store>/plugins/`)运行期
   仍是裸 import(),零拦截 —— 运行期强制留待 H 线子进程**。
7. 守卫是形状启发式,存在固有绕过面(参数改名、字符串拼接等);评审修复后覆盖常见形状,
   但它防的是"无意越界",不是恶意 —— 防恶意是 H 线沙箱的职责。

**已知余地(有意不做,记录在案):**

8. prompt provider 收集仍为顺序 + 逐 provider 预算,多个挂死 provider 时最坏 N×5s/条消息
   (熔断生效后收敛)。并行收集(allSettled 保序)留待 R2/R3 顺带做。
9. **结构性债:core 仍整体持有 ~700 行 log-monitor 原语实现**(含 `'search_agent_logs'`、
   `'/log-tail'` 等具体功能名 —— 守卫按作用域决定豁免标识符,故不红)。这是当前最大的
   一处"core 认识具体功能"残留,应在 R7 开注册表之前单独排一期迁到 `runtime/src/plugins/`,
   届时把守卫 token 从 pluginId 扩到工具名/命令名维度。
10. 拆除测试当前仅覆盖代码侧注册表(七类 + variables 订阅);数据侧足迹(plugin-data、
    permission grants、usage 行)按原计划归 R4。log-monitor 曾泄漏 WriteStream 的判例说明
    "非注册表资源残留"是真实类别,R4 时给 dispose 加资源句柄断言。
11. boundary baseline 的 28→13 收紧属于工作树上未提交的 soul-memory 退役改动,
    不在 R0/R1 提交内;那批改动落库后应重录基线。

### 5.2 R2 落地后的评审修订(2026-08-07)

R2 已实施(`806c390d` + 评审修复提交)。与原方案的差异与新拍板:

1. **请求通道纳入软隔离**。原方案 R2 条目只写了 requestId/abort/progress 三语义,
   没说这条新的运行期入口也要进 R1 的健康账 —— 评审发现它游离在熔断之外
   (失败只 log,UI 轮询必败 action 会无限连败而插件永远 Active)。拍板:
   请求 handler 失败/成功以 `request:<action>` 为 scope 上报;并加请求超时预算
   (常量归 runtime-guard 家族),abort/超时都立即向调用方返回、晚到结果丢弃 ——
   "宿主不再等"是 in-process 能保证的全部,真正杀死插件侧执行仍在 H 线。
2. **requestId 由 core 统一生成**(带序列号),宿主转发面不预生成;
   登记簿对重复在飞 id 拒绝。progress 按发起窗口的 event.sender 定向回送
   (多窗口下 IPCBridge 单 sender 广播面不够用 —— R3 设置窗就是第一个受害者)。
3. **热重载语义只绑定 disable→enable**;Refresh 是重扫目录,不重载代码。
   ESM 旧模块记录逐次泄漏是已知开发期代价。内置插件(静态 import)不参与热重载。
4. **插件自定义事件仅在主进程总线内投递**,不跨 IPC/SSE;R5 面板若要消费,
   届时另开投递面。事件订阅的全局/会话分流按显式全局事件名单判定
   (按 `plugin:` 前缀猜是评审抓出的误判面:插件会永远收不到 settings:changed 等全局事件)。
5. **序列化浅校验的能力边界如实化**:循环引用用 WeakSet 真检测;深度 4 以内抓形状错误,
   更深的逃逸记录在案(H 线 RPC 化时重估);Date 跨 IPC(保留)/HTTP(变 ISO 串)语义分叉写明。
6. **"四宿主共用同一份语义"的实况**:通道分发在 core、协议 host-neutral 成立;
   但真正接线的只有 Electron(server 按方案 A 走 501,CLI daemon 无 UI 需求不接)。
   contributes 在 R2 只建类型+解析+透出,消费者在 R3(settings)与 R5(panels)。
7. **minAppVersion 的判定只在配置了宿主版本的宿主生效**(Electron 已注入);
   server 只读镜像不做判定,列表呈现可能与桌面阻断态不一致 —— 方案 A 下接受,记录在案。

### 5.3 R3 落地后的评审修订(2026-08-07)

R3 已实施(`f39011fa` + 评审修复提交)。**本节对原 P0/R3 的接口形态做了实质改判**:

1. **`registerSettings` 被废弃,schema 唯一事实源是 manifest `contributes.settings.schema`(JSON Schema)**。
   原 P0 的运行期 `api.registerSettings({ schema: z.object(...) })` 是在 contributes 机制存在之前
   设计的:zod 活对象违背宪法第 2 条,运行期注册违背第 3 条(声明先于代码)。改判后运行期只有
   **访问面**:`api.settings.get()`(深冻结快照、已校验、已填默认)+ `api.settings.onChange(cb)`
   (每插件串行推送、合并只推最新;回调纳入软隔离,scope `settings:onChange`)。
   红利:设置页可渲染与编辑**未启用插件**的配置 —— 整条读写路径不执行一行插件代码。
   插件的两条取值路径要写进插件文档:启动时 get() 读一次 + 运行中收 onChange 推送。
2. **支持子集 = 可渲染控件集**,两份清单同生共死:`switch / text / number / select / string-list`
   (顶层单层 object;嵌套、oneOf、原 P0 例子里的 directory-picker 均在子集外)。校验器为手写
   JSON Schema 子集(不引 ajv),超子集 → 配置区显示"schema 不受支持"并一次列出全部原因。
   **`ui.control` 是纯呈现提示,校验一律按 schema type**;覆盖仅允许类型相容对(select 需字段
   自带 enum)。manifest 里的 `default` 本身也过校验,非法即计入不受支持原因。
   `required` **无强制语义,仅呈现**(必填标记)。
3. **校验器落在产品层**(`runtime/src/plugins/config-schema.ts`)而非文档原写的装配层 ——
   真实原因是 server 复用的列表投影(`plugin-list.ts`,产品层)需要同一份归约,放装配层会造成
   产品→装配反向依赖;renderer 不直接 import 它,只消费 IPC/HTTP 投影出的数据。core 零 zod 红线不变。
4. **配置存储只存用户偏离默认的部分**:保存时剥除与 default 深相等的键,未偏离的字段跟随
   manifest 默认演进(VS Code 同语义)。存量坏值读取时回退默认并 warn 一次。
5. **plugin-settings 文件加固**:config/enabled/health 同文件,写路径改原子写(tmp+rename),
   读到损坏 JSON 时挪 `.corrupt-<ts>` 备份、绝不让 `{}` 成为下一次写入的基底 ——
   R3 起这个文件承载用户手工数据,"崩溃后静默清库"从瑕疵升级为不可接受。
6. **web 端配置只读且标明"所示为默认值"**(server 未接真值读取,方案 A 下投影落 schema 默认;
   `configValuesAreDefaults` 标记过线)。server 真值统一留 H 线方案 B。
7. **性能语义**:`settings.get()` 走 per-plugin 缓存(写路径收口处失效),因为访问面天然会被
   插件接进事件热路径(log-monitor 的取值器即 1Hz)。
8. 评审判例记录:R0 守卫在本期实施中两次抓住越界写法(facade 碰 `api.*`、装配层测试伸手产品层),
   实施按守卫改代码而非放宽规则 —— 守卫体系开始自我执行。

### 5.4 R4 落地后的评审修订(2026-08-07)

R4 已实施(`c4025db1` + 评审修复 `7685503c`)。本期是首个"宿主主动搬移用户数据"的期数,
评审按"常见故障下数据静默丢失即 major 起步"从严裁决,抓到战役至今唯一 critical。差异与拍板:

1. **数据作用域拍板:全局 per-plugin**(`<store>/plugin-data/<pluginId>/`),不做 per-agent ——
   插件要按 agent 分,自行在目录内建子结构,数据主权归插件。原文档 §2 勘误表留下的
   未决问题就此关闭。
2. **孤儿归档必须带失效保护,这是方案层的教训**:原方案只写了"孤儿检测归档",评审证明
   无失效保护的孤儿检测本身就是最大的数据事故源(existsSync 在任何 stat 错误下返回 false,
   扫描降级空名单 → 一次 refresh 静默搬走全部用户插件数据)。落地为四层:
   扫描可信度信号(ENOENT=可信空,其余 errno=不可信即跳过本轮)、
   **所有权 = 源目录存在,与"可加载"解耦**(entry 缺失/manifest 损坏/symlink 安装都算有主)、
   sanity brake(候选超 3 个或用户插件数为 0 时拒绝自动归档)、NFC+casefold 比较。
3. **归档单步原子化**:遗留 KV 先并入数据目录(与既有 kv.json 冲突时落 `kv.legacy.json`,
   绝不覆盖)再单次整目录 rename,失败回滚;卸载删源失败时把已归档数据搬回原位,
   搬不回则 archivePath 一路带到 UI。EXDEV(跨卷)明确不支持归档,专门文案,不做
   copy+verify+delete 降级(记录在案)。
4. **readJson 三态**与 §5.3.5 对齐:不存在→fallback;损坏→挪 `.corrupt-<ts>` + 抛;
   静默吞坏文件会让插件用空状态覆盖损坏文件、销毁证据。错误统一为 `PluginStorageError`
   (code: invalid-name / not-serializable / unavailable / io),插件可编程区分
   "别重试"与"稍后重试"。
5. **命名空间与闩**:`kv.json`、`legacy-backup` 为保留名(api.storage 与 api.store 曾可
   双向静默互写);api.store 补 disposed 闩(晚到 set 曾能把已归档目录复活成鬼目录);
   storage 的 disposed 语义 = **写面抛、读面退化**(写静默 no-op 是"假装写成功")。
6. **足迹契约单源**:plugin-settings 键名单提为 `PLUGIN_SETTINGS_KEYS` 常量,footprint 与
   清理共用;孤儿归档同样清三键。判例:@shared 里零生产者零消费者的 `PluginDataFootprint`
   类型被删除 —— **契约面不停放空头类型**,需要时从 core 派生。
7. **熔断 scope 细化为 `storage.<op>`**:单车道会被 exists 的成功反复清掉 writeJson 的连败
   (§5.1 第 1 条的混计假阴性在 scope 内部复现)。与 R2 的 `request:<action>` 先例对齐。
8. **Date 的第三种过线语义**:storage 面 JSON 落盘,Date 一律退化为 ISO 字符串
   (IPC 保留 / HTTP 变串 / storage 变串),已写进契约注释。
9. 守卫判例:boundary 的 import 启发式(`\bfrom\s+['"]`)误报了一条测试标题字符串,
   实施选择改标题而不放宽规则(该启发式已两次抓到真实越界)。误报面记录:含 `from "` 的
   字符串字面量。
10. 已知余地:legacy-backup 无保留策略(与 sessions/legacy-backup 将来统一清理入口,
    不各自发明);footprint 的 IPC 出口与"插件占用了什么"UI 留待 R5 插件详情;
    api.storage 仅单层文件操作(list/删除/子目录留 H 线补齐到够用,否则插件仍会绕开它)。

### 5.5 R5 落地后的评审修订(2026-08-07)

R5 已实施(`a962c828` 注册表重构 + `1dd1cfb1` 面板功能 + `0eab2ab0` 评审修复)。

**对原 P2/R5 的两条改判:**

1. **静态存在感走 manifest**:面板 id/label/icon 声明在 `contributes.panels`,
   `api.registerWorkspacePanel({ id, render, onAction })` 只绑行为,未声明 id 直接拒绝并计熔断。
2. **不重写现有内置产品面板**。原 P2 验收"拿 Tasks/Practice 用描述树重写试炼"**作废** ——
   产品面板的 UX 不该降级到子集原语;"新增面板不再改 App.vue/Sidebar.vue"由**面板注册表重构**
   本身兑现(收编 ≥6 处手抄联合 + workspaceActions/navItems/normalizeNav + window 事件入口 + archive 特例)。
   插件路径的验收改为 log-monitor 贡献一个真实面板(文件列表 + 尾部预览 + 按钮),零宿主改动。

**语义拍板:**

3. **停用的插件不贡献面板入口;启用但加载失败的保留**(入口出自 manifest,这正是"声明先于代码"
   的价值:坏插件的入口还在,点开告诉你它坏了)。宪法第 3 条中"未启用插件也有入口"的旧表述以此为准修订
   —— 但**未启用插件的设置仍可编辑**(R3),两者不矛盾:配置读写不执行插件代码,面板渲染要执行。
4. **渲染与交互复用 R2 请求通道**(`panel:render:<id>` / `panel:action:<id>`),自动继承 30s 预算、
   abort、progress 与熔断账,不另起超时体系;`panel:` 为**保留命名空间**,插件不得自行注册,
   且描述树校验下移到 `manager.handleRequest`(通道级不可绕过,包装器可以被绕)。
5. **描述树的深度校验必须与树的深度上限匹配**:序列化浅校验默认深 4、面板树上限 12 ——
   评审判例,`list.items[].payload` 里的函数曾完全不被扫描。校验器现接受 maxDepth 参数。
6. **机械信号统一**:`plugin:notification` 带 `kind` 即为机械信号(不弹 toast),
   现有 `config-changed` / `panel-refresh` / `catalog-changed` 三种;判定从"名字白名单"改为
   "有没有 kind" —— 白名单的补集写法要求每加一种都有人记得回来改,这是同一个缺陷第三次出现。
7. **catalog-changed + 多窗口广播**:bootstrap(post-window 非阻塞)、enable/disable、refresh
   完成后统一广播;IPCBridge 对**通知类**事件多窗口广播(会话事件与流分片不变)——
   §5.2 第 2 条预警的"单 sender 广播面不够"在 R5 兑现为通用修复。
8. **refresh 三层防护**:main 侧 200ms 按 pluginId+panelId 去重、renderer 侧 150ms trailing debounce、
   render token latest-wins(并发响应曾可旧树盖新树);用户主动触发的刷新跳过 debounce。

**熔断烈度拍板(R7 实施):UI 请求类失败应降级面板,不禁用插件。**
熔断存在的理由是"运行期失败不可见";而面板动作失败是用户刚点下、当场看到错误态与重试按钮的,
前提不成立。钉子:prompt-context 与生命周期钩子每轮都跑,坏了拖垮全应用,禁用是较小伤害;
面板只在打开时跑,失败自限于一个界面,不该连坐掉插件的工具/命令/提示词/定时任务。
实现约束:严重度必须是 **core 里的一张策略表 + 测试**,不能撒在各上报点(否则必然漂移)。
与 R7 的"卸载语义决策框架"同属策略表,一并落地。

**验证口径的制度化修订(重要,适用于全战役):**

9. **"全量测试通过"是关于工作树的陈述,不是关于提交的。** 在脏工作树上逐 hunk 提交时,
   工作树的绿可以掩盖提交快照的红 —— `a962c828` 即如此(重构删了 memory 项但两个测试文件未更新,
   而工作树里那些断言已被 soul-memory 退役删除)。
10. **但快照验证会双向说谎**:worktree 里跑含绝对路径快照的用例会**制造假红**
    (路径替换被读成内容差异)。R5 实施方即据此误判"7 条预存红",并把错误归因写进了审计文档。
11. **制度**:任何从脏树窄携带的提交,提交后须在 clean worktree 上跑相关定向测试,
    并对含快照断言的用例回主树复核。独立复验对全部 **14** 个提交(13 个 plugin 提交
    + 1 个配套 UI 重构 a962c828)做过快照全量:**R0–R4 那 11 个提交零真实红**,
    该失效模式在整条链上只发生过一次(a962c828,唯一的窄携带提交)。

### 5.7 R7 落地(2026-08-07)—— 战役收官

R7 是最后一期。它交付的不是新能力,是**两张把判据收成一处的策略表**,以及按框架
开放的第一个既有注册表。

**1. 严重度表(§5.5 拍板的实施)。** `core/plugins/policy.ts` 的
`PLUGIN_SEVERITY_TABLE`:11 个 scope 家族,每个声明 `threshold` / `remedy` /
`rationale`。

- **用户主动触发的失败降级界面**(`ui-request` / `plugin-request` / `connector`):
  连败达阈只把**那一个界面**标记不可用,插件的工具/命令/提示词/定时任务照常。
  理由是熔断的前提在这里不成立 —— 面板动作是用户刚点下、当场看到错误态与重试
  按钮的。
- **每轮都跑的失败仍整体禁用**(`prompt-context` / `lifecycle-hook` /
  `event-handler` / `event-emit` / `storage` / `settings-change` /
  `conversation-control`):坏了拖垮全应用,禁用是较小的伤害。
- **注册期违规阈值 1**(`registration`):未声明的面板 id、抢占保留命名空间、
  连接器没有 id 都是**代码错误**而非运行期抖动,重试没有意义。
  (加载期错误 —— entry import 失败、依赖装不上 —— **不在表里**:它们走
  `markLoadError`,只写进健康态供设置页显示,不计连败、不触发罚则。
  R7 第一版把它们当判决车道放进表,是纯死规则。)
- 恢复是**一次成功就放回来** —— 用户点了重试并且成功了,面板必须回来。

防漂移做了两层:表本身用 `Record<PluginScopeFamily, 规则>`,往家族联合里加成员
而不给规则,typecheck 当场失败;而"有没有一个真实 scope 谁也不认识"由测试反查
源码里的 scope 字面量。这是本战役第五次治同一个病(熔断计数粒度、transient 的
两类、终止事件名单、白名单补集),修法始终是同一句话。

**2. 卸载语义决策框架(原 P6 的实质工作)。** 同文件的 `PLUGIN_REGISTRY_POLICY`。
三选一:`reject-disable`(停用即数据损坏,拒绝停用)/ `degrade-to-default`
(优雅撤下,调用方回落宿主默认)/ `fail-open`(直接撤下,调用方自理)。
每个开放的注册表必须回答两个问题:**停用时正在用它的东西怎么办**,以及
**只在跑插件的宿主生效造成什么行为分叉**(§6 方案 A)。两个字段都不许留空,
由测试断言长度。

**3. 试点:IM 连接器**(`fail-open`)。选它是因为它是候选五个里唯一
自带退订函数的 —— 形状最适配 onDispose。`api.registerIMConnector(connector)`
返回退订函数,但**插件不调也能拆干净**(退订函数进 disposeCallbacks):拆除语义
不建立在插件守规矩上,这是整条战役的主线。connector id 强制加
`plugin:<pluginId>:` 前缀(与 registerTool 同构),且拒绝顶掉已存在的 id ——
否则 B 插件用同名注册就静默劫持了 A 的渠道而 A 侧毫无察觉。
停用后经该 connector 的回复得到一个说得清的错误而不是静默丢消息;
已有会话不受影响(历史与状态在会话存储里)。

**试点当前没有生产流量**,这一点写进了策略表的 `hasProductionTraffic` 字段:
没有内置插件注册连接器,入站 `normalizeIncoming` 尚未接线,gateway 出站走的是
自己的通路。试点验证的是**契约与拆除语义**,不是投递链路 —— 把 gateway 出站
改走本注册表是下一步,不在 R7 范围内。运行期投递失败已接进熔断账
(scope `connector:<id>`),所以 `connector` 家族有真实生产者而不是一条死规则。

**降级必须有牙齿。** `degrade-surface` 不是"少罚一点":被降级的界面在
`manager.handleRequest` 上被**短路**,后续调用直接返回 `degraded: true` 的
结构化错误,插件根本不被调用。少了这一步,把 `request:*` 从 disable-plugin
改成 degrade-surface 的净效果就是**取消了该命名空间的熔断** —— §5.2 第 1 条
把请求通道纳入熔断账的理由正是"UI 轮询必败 action 会无限连败"。
UI 侧给它专门的一态("已停用 + 原因 + 再试一次"),显式重试带 `bypassDegraded`
放行一次,成功即恢复。

**4. 明确不开的注册表**(`PLUGIN_DEFERRED_REGISTRIES`,理由写进**代码**而不只是
文档 —— 下一个人想开哪一个,第一站会撞见理由,而不是从零重新论证一遍):

| 注册表 | 不开的理由 |
| --- | --- |
| AI provider | 会话正在用一个 provider 时把它抽走,语义最复杂(在飞请求、历史重建、能力协商都要有答案)。等真实需求,不为对称性而开 |
| 变量提供者 | VariableRegistry 至今没有 unregister,要先补退订面。**原方案建议拿它当第一个试点,恰好选反了** |
| 权限能力 | registerCapability 形状上可开,但它直接扩张安全面;插件还与宿主同进程时开放它,等于让插件自己定义自己的权限边界。与 H 线硬隔离一起设计 |
| 后置触发器 | 每轮都跑,属 disable-plugin 那一族;开放前要先有"一个坏触发器不拖垮整条回合"的证据 |
| 后台作业 | 与 api.scheduler 职责重叠,先看有没有 scheduler 表达不了的真实用例 |

**纪律:一次只开一个。** 开放下一个注册表要动**五处**(策略表 / `CorePluginAPI`
与 `CorePluginAPIHost` 类型 / api-builder 实现 / app 层转发 / 拆除快照测试),
清单写在 `PLUGIN_OPEN_REGISTRIES` 的注释里。守卫:policy.test 的
"宿主转发口 ↔ 开放清单"用例会在多了一个转发口却没登记时变红。

**已开放的注册表(append-only,按开放顺序)**:

| 注册表 | 开放于 | 拆除语义 | 备注 |
| --- | --- | --- | --- |
| `im-connector` | R7(试点) | `fail-open` | 无宿主默认渠道,撤下后投递抛可读错误 |
| `search-provider` | M2 | `fail-open` | 撤下后聚合器不再迭代它 |
| `deep-link-action` | H4 | `fail-open` | 撤下后确认卡直接说"该动作已不可用" |
| `credential-strategy` | 批 E(2026-08-16,space 蓝图) | **`degrade-to-default`** | **三个 fail-open 之外的第一条** —— 内置 `priority-failover` 是一条真实存在、而且本来就在跑的默认路径,所以撤下后选择**仍然成功**,只是挑法换回内置的。详见 `docs/design/workspace-spaces-2026-08.md` 批 E 勘误 2 |

## 6. 多宿主战线:已拍板方案 A(2026-08-06)

这是原文档完全没有讨论、但决定多期设计的一个真分叉。**已决定:方案 A —— 近期插件明确
桌面-only,server 真跑插件(方案 B)推迟到 H 线,届时再议。**

- **方案 A(已采纳):近期插件明确桌面-only。** 文档与 UI 写明 server 端插件目录只是只读镜像
  (或直接隐藏 server 端启停开关 —— 今天 server 上切开关改的其实是桌面下次启动的行为,
  还是写到另一个 settings 文件里,纯属陷阱);删除原 P3 "零成本双端"的承诺;
  R2 的通道协议保持 host-neutral(platformApi 双实现、无 IPC 假设),为将来留门。
- **方案 B(推迟):server 真跑插件进 H 线排期。** 用真 PluginManager 替换 noopEntry 目录,
  统一两份 plugin-settings 的事实源;**代价:硬隔离(子进程 ext host + 权限声明强制)
  从"生态期"提前到本期** —— server 常绑非 loopback 时,插件即远程可触发的主进程级代码。
  启动条件:出现真实的"web 端必须用到某插件"需求,且宪法第 1、2 条已落地。

选 A 的理由:R0–R7 的全部价值在桌面端即可兑现;B 的真实成本是"沙箱提前",
而沙箱的正确形态(backend 子进程 + RPC 化 CorePluginAPI)恰好依赖宪法第 1、2 条先落地 ——
顺序上 A 本来就在 B 前面。

方案 A 带来的即刻工作项(并入相应期):

1. **R2**:server 的 `/api/plugins/:id/:action` 路由在真跑插件前返回 501,不做静默无应答
2. **R5**:web 端设置页/面板对插件内容显示"仅桌面可用"态,不渲染假开关
3. **文档**:CLAUDE.md 插件条目注明"插件仅在 Electron 桌面宿主执行;server 目录为只读镜像"

---

## 7. 终局形态(H 线,与原 P7 的差异)

- 插件宿主 = **backend 进程的 Node 子进程**(Electron main / apps/server / CLI daemon 各自孵化),
  不是 renderer 的兄弟进程;RPC 传输复用 CLI daemon 的 NDJSON/unix-socket 机制。
- `CorePluginAPI` 经 RPC 承载:工具 execute 变反向 RPC(转发 abortSignal 与超时);
  事件订阅变推送流;store/config 变快照 + 变更推送 —— **宪法第 2 条落实到位的话,
  这一步插件无感;落实不到位的话,这一步 = 重写全部已发布 API。**
- 权限声明(原 P7 第 2 步)与 contributes 同落 manifest;强制点在 api-builder 的 host
  转发处逐方法查声明(四宿主共享);文件/网络级封锁等子进程按声明注入受限能力对象后才成立。
- ~~webview 逃生舱在此线开放(见 R5 前置条件)~~ **2026-08-09 修订**:webview
  与 ext host 解耦、提前单独落地(C 期)—— webview 的插件逻辑代码仍在 main
  进程,iframe 只装插件目录静态文件,隔离靠独立 origin + CSP + postMessage,
  技术前置只有 R1 软隔离(已完成)。差异详见 plugin-ui 表达力文档 §4.4 与
  rollout 文档 §6.2。H 线保留的是 backend 子进程本体与权限声明强制。
- 隔离的目标层次要说清楚:这一步买的首先是 **产品体验隔离**(UI 不冻不崩、宿主可重构、
  插件侧可整体 kill/重启)—— VS Code 的 ext host 也持完整 Node 权限;
  **用户机器安全** 是权限声明 + 受限注入叠加后的第二层,对应真正的第三方生态。

---

## 8. 一句话

原文档答对了"为什么 soul-memory 撑不住",但把插件系统当成了"缺几个 API 的功能清单";
真正要建的是一条**窄腰**:声明先于代码、过线皆可序列化、软隔离先于沙箱、API 只增不破 ——
腰立住了,"强大"是往腰上加宽 API 的日常工作,"隔离"是把腰外侧整体换成子进程的最后一步,
两者不再互相为敌。
