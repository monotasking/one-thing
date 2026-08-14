# 内核收缩：第一方功能插件化（学习 dsh，2026-08-14）

> 前情：`docs/design/dsh-architecture-adoption-2026-08.md` 落地了主线 T（传输面统一，进行中）与主线 E（事件日志与轨迹，E0-E2 完成）。本文是第三次架构动作，起点是用户 08-14 的质问：
> **"我们的插件总是在根据功能去改插件系统，always 是这样，那它还是插件系统吗？"**
> 诊断结论（已共识）：我们的插件系统是**枚举式扩展点**（每个新功能形态先在宿主钻洞），不是**生成式平台**。两条根因：(1) "宿主不执行插件代码"使表达力必须被宿主预先雕刻；(2) **第一方功能不吃狗粮**，API 只被外部需求被动拉扯。dsh 没有此病不是设计者更聪明，而是它没有特权内核——自家功能就是插件，API 被第一方天天锤。
> 本文回答：怎么在**不引入 Cordis、不推翻分层、不放弃第三方安全线**的前提下，拿到 dsh 的那个性质。

---

## 0. 改什么、不改什么

**改**：让第一方带界面的功能逐个迁到扩展 API 上运行（"builtin 插件"），迁移中发现的每一个 API 缺口按"原语规则"补进插件系统——API 生长从"功能来了现挖洞"变成"差距清单排优先级"。终态：插件 API 是第一方功能的**日常道路**，第三方拿到的是被我们自己磨过的原语。

**不改**：
- 不引入 Cordis，不做 fiber/inject 依赖调度（装配顺序仍由 `createOnethingBackend` 函数负责——顺序问题显式化的代价我们仍不吃）；
- core / runtime / app 三层与边界检查全部保留；
- 第三方插件的安全线**不放松**：descriptor tree + webview，宿主永不执行不可信代码；
- 主线 T 的通用 RPC 通道、主线 E 的事件日志全部保留，且是本线的原料。

---

## 1. 四个关键设计决策

### D1 双信任层级【✅ 用户已拍板 2026-08-14】

安全线从"宿主不执行插件代码"**重述**为"宿主不执行**不可信**代码"：

| 层级 | 谁 | 表达力 | 分发 |
|---|---|---|---|
| **builtin（可信）** | 本仓库内的第一方功能，随应用一起构建、一起签名 | 真 Vue 组件 + 完整扩展 ctx（等同今天内置代码的能力） | 不分发，就在 repo 里 |
| **third-party（不可信）** | npm ledger 安装的外部插件 | descriptor tree + webview 面板 + 既有锚点（现状不变） | 现有 npm 通道 |

依据：dsh 的 client 插件敢执行代码是因为它根本没有信任分层；我们不需要学它的莽，只需要承认**自己写的代码本来就是可信的**——今天的内置功能就是任意代码，把它们改挂到扩展 ctx 上并没有引入任何新的执行面。变的只是**接线方式**，不是信任模型。

### D2 可逆注册基座

新增一个轻量扩展上下文（工作名 `FeatureContext`，落在 `@onething/app`）：`registerTool / registerRpcDomain / registerPanel / registerSlashCommand / registerEventType / registerVariable / …` 全部**返回 disposer**，feature 卸载 = 逐个解绕。不发明依赖解析——`backend.ts` 按现有顺序逐个 `mountFeature(ctx, feature)`，顺序仍是代码写死的（这是我们与 dsh 的清醒分界：先要**可卸载**，不要**自动排序**）。副产品：S 线的"模型现场挂载/卸载功能"拿到了地基——动态插件只是"挂载时机不同的 feature"。

诊断配套：`dump-features` 开发命令，打印当前挂载的 feature 与它们各自的注册项清单（对齐 dsh `--dump-config` 的可观测性，但输出的是注册表不是配置树）。

### D3 API 生长三规则（08-14 共识入法）

1. **只长通用原语，不长功能形状的洞**——任何扩展 API 提案先回答"这是原语还是洞"；
2. **差距清单驱动**——每迁一个 feature，产出"纯插件 API 复刻不了什么"清单，缺口按原语化改写后排队；
3. **锚点加设问**——新锚点提案必须先回答"为什么 webview 面板与既有锚点接不住"（append-only 治理保留）。

### D4 事件域三分（命名现状，不新建设施）

学 dsh 把"选对事件域"立为第一决策，但我们只做**文档化命名**：持久事实 = `events.jsonl`（E0，未来接受 feature 命名空间的事件类型注册）；运行时协调 = EventBus；能力 seam = `configure*Host` 端口。写进 CLAUDE.md 的架构节，让每个改动先答"哪个域"。

---

## 2. 分期总览

| 期 | 名字 | 产出 | 验收门（自证） |
|---|---|---|---|
| **K0** | 可逆注册基座 | `FeatureContext` + disposer 语义 + `mountFeature` 装配改写（先只包住**现有注册面**：tool/rpc 域/斜杠命令/变量） + `dump-features` | 全量测试绿；`createOnethingBackend` 二次装配（mount→dispose→mount）测试通过；boundary 零新红 |
| **K1** | builtin 渲染层 | renderer 侧 slot/panel 注册表正式化（panel-registry 升级为可注册可注销；builtin feature 可注册真组件）；D1 双信任层级落文档与代码注释 | 一个现有面板（archive 或 media）改走注册路径，UI 走查零变化（快照测试） |
| **K2** | 第一个自迁移：轨迹 | 轨迹面板（E1/E2 全部成果）重构为 builtin feature：后端 = sessionEvents 域注册，前端 = panel + 聊天入口经 slot 注册；产出第一份**差距清单** | 功能等价（既有 105+ 测试全过）；`dump-features` 可见 trajectory；差距清单入本文档 §7 |
| **K3** | 批量自迁移 ×3 | practice / 音乐电台面板 / todo-plan 面板逐个迁移，各出差距清单；按 D3 规则消化缺口进第三方 API | 每迁一个：功能等价测试 + transport/boundary/ui 三门绿 |
| **K4** | 自进化接轨 | 原主线 S 并入：`feature_mount / feature_unmount / feature_inspect` 会话内工具（骑 K0 基座）+ 教学式报错；模型可现场挂卸 dev channel 功能 | 模型在会话内挂载一个 demo feature、UI 立即出现、卸载干净（自动化用例） |
| **K5** | 收口 | 装配名册化：`backend.ts` 的 feature 清单收敛为一张显式数组（数据而非散落调用）；评估是否值得 profile/patch（默认不做）；CLAUDE.md 架构节重写 | 加一个新 feature 的 checklist ≤ 3 步且零壳文件（与主线 T 的水位合流） |

依赖：K0 → K1 → K2 → K3 → K4 → K5 严格串行的只有 K0→K1→K2；K3 各项与 K4 可并行。主线 T 的域迁移与本线正交（T 迁一个域=给 K0 的 `registerRpcDomain` 多一个用户），继续按批推进。

---

## 3. 各期要点

**K0**：`FeatureContext` 不是新框架，是把今天散落在 `backend.ts` 流程里的注册调用**收拢并配上注销**。已有注销语义的（RPC 注册表返回 disposer、插件系统双侧 teardown）直接复用；没有的（部分工具/变量注册）补上。import 零副作用测试继续守门。

**K1**：panel-registry 今天是静态数组 + 插件面板拼接；升级为统一注册表后，builtin 与插件面板走同一条路（dsh 的 slot registry 判例）。**这一期不迁任何功能**，只把路修好并用一个最小面板验证等价。

**K2 选轨迹的理由**：最新、边界最清楚（消费事件日志的纯投影）、刚被 105+ 测试钉死（等价性可自证）、且它本来就是 dsh 里"pure-consumer plugin"的直接对应物——第一份差距清单的信号质量最高。

**K3 选型标准**：优先纯面板类（practice/音乐/todo-plan），回避与窗口管理、原生 API 深耦合的（搜索窗、终端、浏览器——那些是 seam 问题不是插件问题）。

**K4**：即原 S0-S2 的全部内容，地基换成 K0 的 FeatureContext（比原方案更顺——原方案要在 npm ledger 上绕，现在挂卸就是 mount/dispose）。

---

## 4. 与既有主线的关系

- **主线 T**：正交继续。RPC 域注册天然是 FeatureContext 的一个 register 面；T2（事件下行 allowlist）建成后同样收进 ctx。
- **主线 E**：成果即原料。K2 迁的就是 E1/E2；D4 的"持久事实域"就是 E0。E3（消息即投影）仍远期独立拍板。
- **原主线 S**：整体并入 K4，原 S 线撤销独立编号。

## 5. 风险与回退

- 最大风险在 K2/K3 的**功能等价**：靠既有测试群 + 快照走查兜底；每个迁移独立成批、可单独回退（旧接线删除前先绿）。
- K0 改 `backend.ts` 是全宿主共用路径：改法是包装不是重排（每个现有步骤原地包成 feature），装配顺序 diff 为零。
- 双信任层级若被否决（D1）：K0/K5 与 K4 仍成立（它们不依赖真组件渲染），K1-K3 退化为"webview 面板版自迁移"——价值打折但方向不变。

## 6. 明确不做

| 不做 | 理由 |
|---|---|
| Cordis / fiber / inject 依赖调度 | 顺序显式化的成本仍不值；可卸载 ≠ 自动排序 |
| 第三方执行真组件 | 安全线只重述不放松；第三方的生成阀门是 webview |
| profile / patch 配置树 | 单产品单装配；K5 的名册数组已够 dump 与审视 |
| 一次性大迁移 | 逐 feature、逐批、可回退；这是改造不是重写 |

## 7. 差距清单（K2 起累积）

（待 K2 产出。每条格式：缺口 → 原语化改写 → 采纳/拒绝 + 理由。）
