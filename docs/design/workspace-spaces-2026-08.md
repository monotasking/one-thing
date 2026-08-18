# Workspace（Space）与 Project 多根 —— 需求共识与分期蓝图

日期：2026-08-13。本文是与用户逐轮对齐后的最终共识，实施以此为准。
调研底稿：project-dirs / connectedDirectories / workspace 三线现状盘点（见 §7 现状附录）。

## 1. 需求

1. **project 允许多个目录**：project-dirs 名册每条记录从单 `path` 升为多根 `paths[]`。
2. **workspace（内部命名 space）**：切换后是另一个工作空间——独立的 session、project、
   接入目录、provider 凭证；体验对标 Arc 浏览器的 space 切换（毫秒级、活跃流不断）。

## 2. 已拍板的决策

| 决策点 | 结论 |
| --- | --- |
| 多目录语义 | project-dirs 名册升多根；接入目录（已是数组）不动 |
| 隔离模型 | **作用域为主 + 预留硬隔离**：单进程单 store 根，数据打 workspaceId，per-space 数据收进 `workspaces/<id>/` 子目录，给未来硬隔离/整空间导出留门 |
| 切换体验 | Arc 式：所有 space 同时活着，切换 = 换过滤条件 + 换 overlay 层，无 teardown、无锁交接；A 空间在跑的流切走后继续跑 |
| 共享边界 | 插件（安装与启用）、主题、模型目录缓存全局共享。~~provider 定义 / per-model 覆盖 / selectedModels 之外的一切 AI 设置留全局~~ **已推翻（C2，2026-08-18）**：用户原话「不同的空间，provider 设置应该是完整的、独立的两套。对齐。」自此 **`workspaces/<id>/providers.json` = 该空间整套 AI 配置**（默认 provider/model、每 provider 的 enabled / selectedModels / 端点 / 档位、逐模型 contextWindow·maxTokens·思考档位覆盖、自定义 provider 定义），`settings.ai` 只剩 `temperature` 缺省 + `modelCatalog`（models.dev 目录缓存，~500KB，缓存不是设置）。**无回落**：空间没表达过的就是没有。见 `workspace-provider-config-review-2026-08-18.md` §8 |
| provider 设置 | **整套 per-space，不回落**（C2）：`workspaces/<id>/providers.json`。B7/B9 的 overlay 三格（`selectedModels` / `defaultSelection` / `providerEnabled`）已并入其中，overlay 只剩接入目录等非 provider 项 |
| API key | **per-space 严格隔离，不回落全局**；新建 space 时二选一：导入（从指定 space 复制快照，copy 不引用）或空白开始。~~默认空间的凭证源 = `settings.ai`（零迁移）~~ **已推翻（C1，2026-08-18）**：那条特例造出两套数据形状，每个消费者都要 `isDefaultSpace ? A : B`，是「开关不独立 → 默认模型不独立 → 旋钮设不了 → 切空间外观变」这一串问题的同一个病根。C1 一次性迁移之后 **default 也是普通空间**，凭证与偏好都在 `workspaces/default/`。唯一的机器级例外是环境变量 API key：它全空间可见（C1 拍板 1）。见 `workspace-provider-config-review-2026-08-18.md` §6 |
| 凭证形态 | **第一天就是凭证池** `entries[]`（哪怕 UI 先只支持一条），支持多 key / 多 OAuth 登录 + 轮换策略 |
| 插件面 | 策略可插（不见别人的钥匙）；订阅接入可插（auth connector + 声明性描述）；wire 格式实现继续关 |
| 覆盖端 | 一期只做 Electron 桌面；server 的 `owners/<uid>/<wid>` 多租户树不碰 |
| 命名 | 内部叫 **space**，避开 renderer `stores/workspace.ts`（分栏树）的撞名 |

### 为什么不是「换 store 根 + 重建 backend」

Arc 体验的本质是所有 space 同时活着。换根重建必然 abort 活跃流、MCP 重连秒级，
体验是「重启」不是「滑动」。且换根要趟过一整片雷区：StoreLock 构造时固化路径、
settings/sessions 模块级单例缓存（含 300ms 节流脏写队列）、SQLite 连接、MCP/插件单例。
作用域模型全部绕开——根本不换根。代价是非物理隔离，由「预留硬隔离」的目录布局兜底。

## 3. 存储布局

```
~/.onething/
├── settings.json              # 全局层：模型目录缓存、主题、插件配置、非 ai 杂项
├── plugins/                   # 共享
├── sessions/                  # 一期留在原地，meta 打 workspaceId；批 C 迁入 per-space
└── workspaces/
    ├── index.json             # space 列表 + currentWorkspaceId
    └── <id>/
        ├── space.json         # name / color / icon / settingsOverlay
        │                      #   overlay 含：接入目录、默认模型、selectedModels、persona
        ├── credentials.json   # provider 凭证池（独立成文件：导出时默认剔除）
        └── project-dirs/      # 每空间独立的项目名册（多根版）
```

`workspaces/<id>.json` + app-state `currentWorkspaceId` 是现成无主坑位
（`storage/paths.ts:127-155`、`storage/app-state.ts:61`，生产代码零读写），直接接管改造。

### credentials.json schema（第一天定死，避免二次迁移）

```jsonc
{
  "providers": {
    "<providerId>": {
      "entries": [{
        "id": "…",                    // 稳定 id，与内容无关
        "label": "…",
        "authType": "apiKey" | "oauth",
        "apiKey": "…", "oauthToken": {…},
        "source": "user" | "plugin:<id>",   // 批 F 依赖，第一天进 schema
        "cooldownUntil": 0                   // 配额耗尽冷却，持久化
      }],
      "policy": "single" | "priority-failover" | "round-robin" | "plugin:<id>:<name>"
    }
  }
}
```

`ProviderConfig` 三类字段的归属拆分：凭证（apiKey/authType/oauthToken/apiMode/baseUrl）
→ per-space credentials.json；使用偏好（selectedModels/默认模型/contextWindow 覆盖）
→ space.json overlay；目录缓存（models + modelsLastFetched，~500KB）→ 全局 settings 保留。

## 4. 分期

- **批 A：project 多根**（独立先行，不依赖 space）——**已实施 2026-08-13**。
  实施勘误两条：①roots 自动派生做在了会话 workdir 变更处（`app/variables/gateways.ts`
  的 `syncProjectDerivedRoots`），规则是「只替换会话不拥有的 roots」：空 roots 或
  恰好等于某注册项目全根集合的 roots（即上次派生的产物）才会被覆盖，AI/用户手动
  设置的 roots 不动；②发现并修了一个计划外消费点——`projectStoreGateway.resolveKey`
  原来用 `projectIdFromPath(cwd)` 当项目级变量 scope key，多根下副根会裂出第二个
  scope，已改为先查名册取项目 id（注册项目的旧 key 恰好等于 sha(主根)，数据无缝）。
  - `Project.path: string` → `paths: string[]`；id 与 path 解耦（旧记录 id 不变、
    `path` 包成 `paths:[path]`；新建用随机 id）。顺手治掉「挪目录 = 换 id」旧毛病。
  - store 主键从 path 改「任一根命中」（get/touch/update/remove）；prompt 匹配改
    任一根包含 cwd；`touch` 来自会话 workdir 变更（`variables/gateways.ts`）。
  - IPC / web parity（`platform/web.ts`）/ server parity（`projectDirsStoreForContext`
    的 server-local 实现）五处形态同步。
  - `useSessionOrganizer` 多根归组；左栏项目 UI 支持添加多目录。
  - 白捡项：新建会话时 `project.paths` 灌进已有的 `session.workingDirectoryRoots`，
    写沙箱自动对齐。
  - **cwd 语义（用户特别提醒）**：工具的 cwd 保持单值 —— 会话 `workingDirectory` =
    项目主根 `paths[0]`。bash 执行目录、相对路径解析全锚在这一个 cwd 上，不产生
    多根歧义；其余根只扩边界（workingDirectoryRoots：写沙箱/搜索/@ 引用），去别的
    根用绝对路径或 cd（仍在 roots 内）。prompt 侧项目匹配按「cwd 落在任一根」，但
    须把全部根列给模型，否则模型不知道其他根存在。
  - **两个 UI 补丁（2026-08-13 追加）**：①项目右键菜单给每个副根加一条
    「设 X 为主根」（`set-primary:<root>`，与「移除 X」同在「目录」分组），
    走 `projectsStore.setPrimaryRoot` → 重排 `paths` 后整表 update，项目 id 不变；
    ②组头「＋」在多根项目上先弹一张根选择菜单（主根排第一），选中的根成为草稿的
    `workingDirectory`——cwd 是单值，替用户猜就是猜错；单根项目行为不变直通。
- **批 B：space 骨架**
  - `workspaces/index.json` + `<id>/space.json` CRUD 与 IPC；session meta 加
    `workspaceId`（旧会话缺省归 default space，零迁移）；左栏/搜索/最近流按当前
    space 过滤；settings overlay merge；接入目录 per-space；凭证池 schema +
    单条 UI + `policy:'single'` + 新建向导（导入/空白）；切换器 UI（⌘1..9 +
    颜色/图标 + 动画）；分栏树持久化 v4→v5（per-space × per-form）。
  - **一期必须进的归因字段**：usage ledger 行加 `workspaceId` + `credentialId`
    （不写永远补不回来）。

  #### B1 切片（space 骨架）—— 已实施 2026-08-13

  范围严格限定为 **space CRUD + session 归属与过滤 + 切换器 UI**；settings
  overlay、接入目录 per-space、凭证池、新建向导、分栏树 v5、ledger 归因全部
  留给后续切片。只覆盖 Electron 桌面，web 端优雅降级。

  落地清单：

  - `packages/onething-runtime/src/spaces/`（types / persistence / store /
    ipc-operations / index，仿 project-dirs 的四层形态）；`onething.aliases.ts`
    登记五条 runtime 子路径 + `@onething/electron-host/ipc/spaces`。
  - 存储 `<store>/workspaces/index.json`（`{ spaces: [{id,name,color?,icon?,
    createdAt}] }`）+ 每个 space 一个 `workspaces/<id>/` 空目录占位（后续切片
    往里放 `credentials.json` / `space.json`）。路径经 `getOnethingWorkspacesDir()`。
    default space（id 固定 `'default'`、名「默认空间」）在 initialize 时补建。
  - `session.workspaceId`：core `CoreSessionMeta` / `CreateCoreSessionRecordOptions`
    / `createCoreSessionRecord` / `createSessionWithAdapters` 的 prependSessionMeta
    / `extractSessionMeta`；shared `SessionMeta` + `ChatSession` +
    `CreateSessionOptions`；runtime `sessionRepository.createSession(id, name,
    { workspaceId })`；app `createSession` / `createSessionWithoutFocus` +
    新增 `countSessionsInWorkspace`。**创建时定死，不做 patch 补写；读取端一律
    缺省 default，零迁移。**
  - IPC 五步：`SPACES_{LIST,CREATE,UPDATE,REMOVE}` + `shared/ipc/spaces.ts` +
    `apps/electron/src/ipc/spaces{,-controller}.ts`（portable factory 形态，与
    project-dirs 同构）+ `main/ipc/spaces.ts` 转发 + `handlers.ts` 注册 +
    preload bridge + renderer 类型 + `platform/web.ts`。
  - renderer `stores/spaces.ts`（Pinia + localStorage `onething:current-space`，
    **window 级、不进后端**）、Sidebar 顶部极简切换器（色点 + 名字 + 「＋」+
    右键重命名/删除）、`filteredSessions` 输入侧按当前 space 过滤（置顶/草稿/
    项目组语义不动）。

  实施勘误与偏离（原样记录）：

  1. **`workspaceId` 的写入点选在 core，而不是「建完再 patch」**。补写要多一次
     index 读改写 + 一次会话落盘，且会让「归属」出现一个短暂的 default 窗口。
     代价是动了 `packages/core`（五处，全是可选字段透传，零行为改变）。
  2. **web 端抽了一个 `softJson` 降级读法**（`platform/web.ts`）。原计划只说
     「请求失败时优雅返回 `{success:false}`」，四个 spaces 方法都要这套，于是
     抽成函数而不是抄四遍。它只服务「宿主还没有这条路由」这一档。
  3. **space id 字符集在门口卡死**（`^[a-z0-9][a-z0-9_-]{0,63}$`）。id 会成为
     `workspaces/<id>/` 的路径片段，放行 `..` 或分隔符等于放行任意路径写入。
     建会话那一侧对非法 `workspaceId` **静默降级为缺席**（= default），不因为
     一个归属字段拖垮建会话这条路。
  4. **删除的占用统计由宿主注入**（`removeOnethingSpaceForIpc.countSessions`）。
     spaces store 不认识会话；`countSessionsInWorkspace` 住在 app 层，口径与
     渲染层的 `sessionBelongsToSpace` 一致。三种拒绝各自成码（`DEFAULT_SPACE` /
     `NOT_EMPTY` / `NOT_FOUND`），UI 才能说人话。
  5. **切换器的显隐判据是「后端答上话了」，不是「空间数 > 1」**。只有一个空间时
     那一行仍然画着（带一个「＋」），否则用户永远找不到新建空间的入口。
  6. **重命名做成了就地输入框**，不是弹窗：`window.prompt` 被 ui-gate 的
     `native-confirm` 规则禁掉，为一个字段新起一个 Dialog 不划算。默认空间的
     重命名/删除两条都是灰的。
  7. **未做（有意）**【2026-08-17 更新：侧栏电台组已按用户裁决整段删除——它绕开空间过滤、切到任何空间都在顶上，属多余逻辑；电台会话归音乐面板管】：音乐/电台组（`musicGroup`）与 rail 的最近流/房间列表不参与
     space 过滤 —— 与「搜索窗/最近流本切片不动」同一条闸；项目名册保持全局可见；
     `apps/server` 没有 `/api/spaces` 路由（web 端因此永远走降级支路）。
  8. **顺手改**：`SessionList` 的 `new-session-in-project` 事件多带一个触发事件
     参数（多根项目要靠它给「落在哪个根」的菜单定位）；三处 Sidebar 挂载测试补了
     `@/stores/spaces` 的 mock。

  #### B2 切片（per-space overlay + 接入目录三层语义 + ledger 归因）—— 已实施 2026-08-13

  范围：`workspaces/<id>/space.json` overlay 存储与 IPC、接入目录的三层语义与
  五件套按会话取、设置页 space 维度、usage ledger 的 `workspaceId` 归因。
  **明确排除**：provider 凭证池 / credentials.json、分栏树 v5、⌘1..9 快捷键、
  server `/api/spaces` 路由（web 端继续走 B1 的 softJson 降级）。

  落地清单：

  - `packages/onething-runtime/src/spaces/overlay.ts`（新）：schema
    `{ overlay: { connectedDirectories?: string[] } }`、整份判废式解析、目录归一
    （尾斜杠不敏感、只收绝对路径）、`mergeConnectedDirectories(global, overlay)`、
    按**绝对文件路径**为 key 的读缓存。`onething.aliases.ts` 加
    `@onething/runtime/spaces/overlay` 一条。
  - IPC 两条新通道 `SPACES_{GET,SET}_OVERLAY` 全链路：`shared/ipc/channels.ts`
    + `shared/ipc/spaces.ts`（`SpaceOverlayPayload` 等五个类型）+ `shared/ipc/index.ts`
    导出 + runtime `spaces/ipc-operations.ts`（`get/setOnethingSpaceOverlayForIpc`）
    + `apps/electron/src/ipc/spaces{,-controller}.ts` + preload bridge + renderer
    类型 + `platform/web.ts` softJson 降级。
  - `app/stores/connected-directories.ts`：`getConnectedDirectories()`（全局层，
    语义不变）之外新增 `resolveSessionSpaceId` /
    `getConnectedDirectoriesForSpace` / `getConnectedDirectoriesForSession`。
  - 设置页 `ConnectedDirectoriesPanel.vue`：「全局（所有空间）」+ 各 space 的
    Select；选空间时全局那几条以只读的「来自全局」行列在上方。
  - usage：`OnethingUsageLedgerRecord/RecordInput` 加 `workspaceId?`，
    `buildOnethingUsageLedgerRecord` 透传，`app/usage/index.ts` 的 `recordUsage`
    从会话解析（缺席 = `'default'`）。**聚合与旧行解析一行未动。**
  - 新增/扩充测试：`spaces/__tests__/overlay.test.ts`（13 条：归一、判废、
    round-trip、坏文件、非法 id 落回 default、缓存失效、整层写入语义）、
    `spaces/__tests__/ipc-operations.test.ts` +1、
    `app/stores/__tests__/connected-directories.test.ts` +6（三态 + 去重 +
    技能根停在全局层）、`usage/__tests__/ledger.test.ts` +1。

  实施勘误与偏离（原样记录）：

  1. **三层语义定成「全局 ∪ overlay」的追加集，不是替换**。全局层继续存在、
     全空间共享 —— 零迁移，老用户无感；space 只能往上加。设置页因此必须把全局
     那几条画成只读的继承行，否则用户切到空间会以为目录消失了。
  2. **overlay 走两条自己的 IPC 通道，没有并进 `SPACES_UPDATE`**。update 的载荷
     是空间**身份**（name/color/icon），overlay 是它的配置层：生命周期不同（改名
     很少、改目录很频），失败语义也不同（overlay 写盘失败不该让改名一起回滚）。
     挤在一条通道里迟早要靠一个 `if (request.overlay)` 分岔。
  3. **overlay 写入是整层写，不是 patch**。只有一格时两者无差别，但字段变多之后
     「漏传 = 清空」是个陷阱，所以入口就定成整写，由调用方显式决定要不要先读后并。
  4. **overlay 读缓存 key 用绝对文件路径而不是 spaceId**。换 store 根（headless
     宿主、测试的 `setRootDirForTests`）天然换 key，于是 persistence 不必反过来
     依赖 overlay 去做失效钩子 —— 省掉一个循环依赖。
  5. **`connected-directories.ts` 直接 import `./sessions.js`**，形成
     `connected-directories → sessions → tools/core/sandbox → connected-directories`
     的模块环。全部引用都在函数体内（函数声明提升 + `expandPath` 只在函数里用），
     两个方向的求值顺序都安全；全量 vitest（1026 files / 9268 tests）与
     `typecheck:node` 已验证。若将来有人在这三个文件里加**模块顶层**的跨模块求值，
     这个环会立刻变成 TDZ 崩溃 —— 记在这里当路标。
  6. **`getConnectedDirectoriesForSpace` 也一并暴露**，虽然本切片没有生产调用点
     （设置页读的是 overlay 原始值）。它是 `ForSession` 的实现体，也是将来
     「按当前空间取」的合法入口 —— 分开命名，免得有人用 `ForSession` 传一个
     其实是 spaceId 的东西。
  7. **`SPACES_SET_OVERLAY` 只对已登记的 space 开放**（`hasSpace` 门）。否则一个
     手滑的 id 会在 `workspaces/` 下长出一个没有主人的目录。`space.json` 的路径
     解析同时把非法 id 落回 default（id 是路径片段，`..` 必须挡在门口）。
  8. **usage 归因只做 `workspaceId`，没做 `credentialId`** —— 后者要等凭证池切片。
     写入端加维度、读端零改动：旧行没有这个字段，`parseUsageLedgerLine` 是透传的，
     读回来就是 `undefined`（盲点 10）。

  #### 五件套的实际取法（逐条，含降级）

  | 件 | 接线点 | 会话上下文怎么来的 | 结论 |
  | --- | --- | --- | --- |
  | 写沙箱（write/edit/bash 的 analyze） | `app/tools/builtin/{write,edit,bash}.ts` → runtime 同名工具 | 适配器签名从 `getConnectedDirectories()` 改成 `getConnectedDirectories(sessionId?)`，工具在 analyze 里递 `ctx.sessionId`（`CoreToolRuntimeContext` 一定带） | ✅ 真·按会话归属 |
  | 读沙箱（read 的 analyze） | `app/tools/builtin/read.ts` → runtime `read.ts` | `getDefaultReadRoots(sessionId?)`；app 侧用 `getDefaultReadRoots({ getConnectedDirectories: () => …ForSession(sessionId) })` 这个 adaptersOverride 现成口子，不动全局适配器 | ✅ 真·按会话归属 |
  | @ 引用 / 文件选择器 | `renderer/composables/usePickerOrchestration.ts` → `platformApi.listFiles` → `apps/electron/src/main/ipc/files.ts` | `OnethingListFilesRequest` 加 `sessionId?`，渲染层把 `effectiveSessionId` 带上来（宿主不认识「当前空间」，只能由请求携带） | ✅ 真·按会话归属 |
  | 搜索根 | `app/search/providers.ts` | 搜索窗是 UI 驱动、没有请求级会话号；用适配器里现成的 `getCurrentSessionId()` | ⚠️ 按**当前会话**取（≈当前空间）。当前会话缺席时退全局层 |
  | 技能根 | `app/stores/connected-directories.ts` 的 `listConnectedSkillRoots` → `app/skills/loader.ts` | 技能是**进程级一次扫描 + 全局缓存**，整条链上没有会话 | ❌ **停在全局层**（有意）。掺 overlay 会让「哪些技能存在」取决于扫描发生时恰好是哪个空间，比不做更糟 |
  | markdown 附件根 | `app/markdown/asset-service.ts` | 请求坐标是一个文档路径；笔记编辑器可以在没有任何会话打开时使用 | ❌ **停在全局层**（有意）。猜当前空间会让同一份文档在不同时刻解析出不同的附件根 |

  另有一处不在五件套里但同源：`app/tools/core/sandbox.ts` 的
  `configureAppToolSandbox` 仍注入**全局层** getter。它服务的是签名里根本没有
  sessionId 的调用面（`checkFileAccess` / `findReadSandboxRootForPath` 等），
  退回全局层是那里的正确答案，不是遗漏。

  #### 计划外发现

  - `boundary` 有一条 `search provider facade must stay thin`（`app/search/
    providers.ts` 行数上限）。第一版三行注释直接把它顶红了 —— 这条守门规则对
    注释也计数，改那个文件时注意。
  - `packages/renderer/types/index.ts` 的 `@shared/ipc` 类型是「先 import 再
    export」两段式，新增类型要**同时**加进两段（只加 export 段会得到
    `TS2304: Cannot find name`），且 `packages/shared/ipc/index.ts` 的 barrel
    也要显式列名（它不是 `export *`）。一个新类型四处登记。

  #### B3 切片（per-space provider 凭证池）—— 已实施 2026-08-13

  范围：`workspaces/<id>/credentials.json`（第一天就是池）、严格隔离的解析与
  起流前置拦截、ledger `credentialId` 归因、新建空间向导（导入/空白）、
  设置页最小编辑面。**明确排除**：轮换策略与多条目 UI（批 D）、per-space OAuth
  登录流、错误分类、分栏树 v5、server `/api/spaces/*` 路由（web 端继续走
  B1 的 softJson 降级）。

  落地清单：

  - `packages/onething-runtime/src/spaces/credentials.ts`（新）：§3 schema 的
    解析/校验/整份判废、按绝对文件路径为 key 的读缓存（与 overlay 同构）、
    单条 upsert / clear、`selectSpaceCredentialEntry`（policy `'single'`）、
    导入快照构建器、`previewSpaceCredentialApiKey`。
  - `packages/onething-runtime/src/spaces/provider-credentials.ts`（新）：
    **三态解析规则** —— default → `{kind:'settings'}`（原样透传）／有 entry →
    覆盖 `{apiKey, baseUrl?, apiMode?}`／无 entry 或 OAuth → `unavailable`
    （带人话文案）。结果压成 `providerConfig.spaceCredential` 运行期标记。
  - `packages/onething-runtime/src/app/providers/space-credentials.ts`（新）：
    宿主接线（会话→space、provider 是否 OAuth、名字）+ 设置页读写面 +
    `resolveSessionCredentialId`（账本归因）+ `importDefaultSpaceCredentials`。
  - IPC 四条新通道 `SPACES_{GET_CREDENTIALS,SET_CREDENTIAL,CLEAR_CREDENTIAL,
    IMPORT_CREDENTIALS}` 全链路（channels → `shared/ipc/spaces.ts` →
    `shared/ipc/index.ts` 显式列名 → runtime `spaces/ipc-operations.ts` →
    `apps/electron/src/ipc/spaces{,-controller}.ts` → preload bridge →
    `renderer/types/index.ts` 两段 + electronAPI 签名 → `platform/web.ts` 降级）。
  - `onething.aliases.ts` 加两条（`spaces/provider-credentials`、
    `spaces/credentials`，长前缀在上）。
  - 渲染层：`stores/spaces.ts` 加 `getCredentials/setCredential/clearCredential/
    importCredentials`，`create(name, {importCredentials})` 返回
    `{space, importResult}`；Sidebar 的「＋」改成两态 ContextMenu（空白开始 /
    从默认空间导入凭证）；新组件
    `components/settings/provider/SpaceCredentialsPanel.vue` 挂在 AI Provider tab
    末尾。
  - 测试：`spaces/__tests__/credentials.test.ts`（23 条）、
    `spaces/__tests__/provider-credentials.test.ts`（10 条）、
    `providers/__tests__/space-credential-gate.test.ts`（10 条）、
    `app/providers/__tests__/space-credentials.test.ts`（9 条）、
    `spaces/__tests__/ipc-operations.test.ts` +6、`usage/__tests__/ledger.test.ts` +1、
    `settings/provider/__tests__/SpaceCredentialsPanel.test.ts`（5 条）。

  #### provider 解析出口清单（盘点结果 + 各自的处理）

  盲点 2「provider 解析链是两套统一的」在代码里的落点是
  `getEffectiveOnethingProviderConfig`（`providers/provider-runtime.ts`）——
  它的注释里就钉着 deepseek-goes-codex 那次事故。所以注入口选它。

  | # | 出口 | 有会话号? | 处理 |
  | --- | --- | --- | --- |
  | 1 | `providers/provider-runtime.ts` `getEffectiveOnethingProviderConfig` | ✅ | **主注入口**。新增可选适配器 `applySpaceCredentials(sessionId, providerId, config)`，在 `withResolvedProviderBaseUrl` **之前**调用（entry 的 apiMode 要参与端点派生） |
  | 1a | 聊天流：core `resolveProvider` → `stream-provider-adapter.getEffectiveConfig` | ✅ | 经 #1 覆盖。宿主在 `app/engine/stream-engine-runtime.ts` 注入 |
  | 1b | `app/engine/stream/provider-helpers.ts` `getEffectiveProviderConfig`（消费者：`collab/actors/referee-judge.ts`、`collab/digest-runner.ts`、`engine/prompt/system-prompt-snapshot.ts`） | ✅ | 经 #1 覆盖，同一个注入函数 |
  | 2 | `providers/provider-config.ts` `resolveProviderConfigForChat`（→ `provider-helpers.getProviderConfigForChat`） | ✅ | 自己读 settings，**单独挂了一次**闸（可选 `applySpaceCredentials`）。本切片无生产调用点，但留着不挂等于留个雷 |
  | 3 | `app/providers/utility-provider.ts` `createUtilityProvider` | ✅（`options.sessionId`） | 直接调用 `applySessionSpaceCredentials`。未配置 → 拿不到 auth → 与「没配工具模型」同一条出路:静默跳过 |
  | 4 | core `core-stream-engine.ts` `generateSessionTitle`（`resolveToolCallModel` 直读 settings） | ✅（`sessionId` 在签名里） | core `StreamEngineProviderAdapter` 加可选 `applySpaceCredentials`，标题这条路单独再用一次同一个注入函数 |
  | 5 | `providers/provider-config.ts` `resolveProviderAuthWithAdapters` / `getProviderApiKeyWithAdapters` | ❌ | **阻断点**（不是解析点）：看见 `spaceCredential.unavailable` 就返回 null，挡在 OAuth 刷新与 env 兜底**之前**，也挡在外部 agent 的空凭证豁免之前 |
  | 6 | `app/plugins/llm.ts` `resolveManagedProvider` | ❌（插件 `llm.complete` 没有会话语境） | **停在全局层**（有意）。同 B2 的技能根/markdown 附件根：猜"当前空间"会让同一次调用在不同时刻用不同的钥匙 |
  | 7 | `app/voice/providers.ts`（ASR/TTS 借 openai/openrouter 的 key） | ❌ | **停在全局层**。语音在盲点 9 的范围闸之外，一期不动 |
  | 8 | `app/providers/model-registry.ts`（models.dev 目录缓存） | ❌ | **不是凭证出口**。§3 明确目录缓存留全局 |
  | 9 | `app/engine/stream/image-stream.ts`、`agent-loop/providers/*` | — | 吃的是上游解析好的 config，随 #1 自动生效 |
  | 10 | 外部 agent（`acp` / `isExternalAgentExecutorProvider`） | — | 引擎侧凭证本来就是空串（走各自 CLI 登录），不受影响；但那条豁免排在 #5 的闸**之后**，不能用来绕过隔离 |

  #### 实施勘误与偏离（原样记录）

  1. **§3 schema 加了两个表外可选字段**:`entry.baseUrl?` 与 `entry.apiMode?`。
     §3 列的字段一个不少、语义一字未改，但 UI 要求「apiKey + 可选 baseUrl」，
     而池里两条 key 完全可以指向不同端点 —— 把 baseUrl 提到 provider 级就表达
     不了这件事。`apiMode` 走一张 provider→字段名的小表(zhipu/qwen/kimi),
     本切片没有 UI 写它,只有存储与生效。
  2. **判定与阻断分开做**。解析点(`getEffectiveConfig`)有 sessionId、鉴权点
     (`resolveAuth`)没有,所以判定结果盖成 `providerConfig.spaceCredential`
     这个**运行期字段**(与 `providerOptions` 同一手法,永不落盘),由鉴权侧读它
     返回 null。这样「未配置」只判一次却在三处生效:起不了流、文案说人话、
     账本归因。
  3. **动了 `packages/core` 两处**(与 B1 动 core 同性质:可选、加法、零行为改变):
     `StreamEngineProviderAdapter` 新增可选 `describeMissingCredentials`(让
     「未配置」能说出空间名,不实现就落回原来那两句通用文案)与可选
     `applySpaceCredentials`(标题生成那条路自己从 settings 取 config)。
  4. **未配置时把钥匙也抹掉**,不只是盖标记。只盖标记等于把「别用这把钥匙」
     写在便签上再把钥匙递过去 —— 下游任何一处漏读标记就漏了。
  5. **环境变量兜底一并挡掉**。`resolveOnethingProviderApiKey` 有 env 兜底
     (`DEEPSEEK_API_KEY` 等)。env 是机器级的,让它漏进非默认空间等于隔离说了
     不算,所以闸挂在 #5 而不是「config.apiKey 为空时」。导入快照同理**只看
     settings 里写着的原文**,不把 env 固化进某个空间的文件。
  6. **`resolveSessionSpaceId` 从 `app/stores/connected-directories.ts` 搬到
     `app/stores/sessions.ts`**(它是会话表的投影,不是目录概念)。旧位置保留
     一个再导出——它与 `getConnectedDirectoriesForSpace/ForSession` 在同一句
     语义上成对出现。代价:`connected-directories.test.ts` 的 `../sessions.js`
     mock 里多了两行同判据的重实现(真会话仓库太重)。
  7. **默认空间的 credentials.json 写入被拒绝**(`DEFAULT_SPACE` 码),不是静默
     忽略。~~默认空间的凭证层就是 `settings.ai`~~(**C1 已推翻**,见
     `workspace-provider-config-review-2026-08-18.md` §6);往它的 credentials.json 里再写
     一份就是造第二份真相。读它也一律返回空(解析在第一步就短路)。
  8. **渲染层永远拿不到密钥原文**。IPC 回的是摘要(`hasApiKey` + `sk-abc••••6789`
     预览);保存永远是整条覆盖写。这与连接区(它直接持有 `settings.ai` 的原文)
     不一致 —— 是有意的:新面能少传就少传,老面不为此改造。
  9. **设置页走了「独立小面板」这条路**,没有嵌进 `ConnectionsSection`。理由:
     连接区(1100 行)编辑的就是**默认空间**的凭证层,在它内部再插一个空间维度
     等于让同一组输入框在两种落盘通道之间切换(settings 的 `update:settings`
     vs spaces IPC),保存失败时没法说清哪一层没写进去。新面板
     `SpaceCredentialsPanel.vue` 挂在同一个 tab 末尾,后端答不上话时整段不画。

     > **⚠️ 这条路线已于 2026-08-15 被用户推翻(见下方 B7 切片)。** 原话:
     > 「多空间的认证不是一个多余的新表单让你填,而是我切换 workspace 的时候,
     > 它就自动切换过去了。」
     >
     > 推翻的不是那条技术理由(两条落盘通道确实不能共用一组输入框),而是它推出的
     > 结论。正确的解法不是**并列**两块面板让用户自己挑,而是**替换**:连接区
     > 本身就是「当前空间的」连接区,非默认空间下那一段整个换成凭证池编辑器 ——
     > 两条通道永远不同框,同时用户也永远只看见一个凭证入口。
     > `SpaceCredentialsPanel.vue` 已删除,能力原样搬进
     > `SpaceCredentialPool.vue`(per-provider)。
  10. **新建向导用 ContextMenu,不是 Dialog**。为一次二选一起一个 Dialog 不划算,
      而 `window.confirm` 被 ui-gate 的 `native-confirm` 规则禁掉(与 B1 的重命名
      同一条理由)。导入是**建完之后的第二步**:导入失败不回滚刚建好的空间。
  11. **导入结果里只报 OAuth 跳过**,不报「这个 provider 本来就没配 key」——
      后者是绝大多数条目,报出来会把真正该看的那条淹掉。
  12. **`policy` 只实现 `'single'` 的语义**(第一条不在冷却里的 entry),其余取值
      合法但按同一句解析。提前写半吊子的 round-robin 只会让批 D 先删掉它。
      `cooldownUntil` 已经在读侧生效(冷却中的 entry 不会被选),写侧留给批 D。
  13. **ledger 只动写入与类型**:`OnethingUsageLedgerRecord/RecordInput` 加
      `credentialId?`,`buildOnethingUsageLedgerRecord` 透传,`recordUsage` 从
      「会话归属的 space + providerId」解析。**默认空间诚实缺席**(settings 源
      没有 entry id,不造 `'legacy'` 假值);聚合与旧行解析一行未动(盲点 10)。

  #### 计划外发现

  - `CoreProviderConfigLike` 与 `CoreSpaceCredentialMarker` 原来不在
    `packages/onething-runtime/src/providers/index.ts` 的桶里(`provider-config.js`
    整个没被再导出,只有 `provider-runtime.js` 捎带出去一个
    `CoreProviderSelectionOverride`)。宿主侧要给注入函数写签名就得有这两个类型,
    补了一条显式 `export type`。
  - `AIProviderTab.interaction.test.ts` 原来完全不装 Pinia(它把用到的 store 逐个
    `vi.mock` 掉)。新面板用了 `useSpacesStore`,于是那条测试线也得把
    `@/stores/spaces` mock 掉(`available: false` = 整段不画,与 web 降级同一支路)。
  - `packages/renderer/platform/electron.ts` 是**整只 spread** `electronAPI`,
    新方法不需要在那里登记 —— 只有 `web.ts` 要逐条写降级。
  - `RoomSettingsDialog.test.ts` 在全量跑里偶发一次红(单跑必绿,与本切片无关)。
    记一笔当路标。

  #### B4 切片（项目名册 per-space）—— 已实施 2026-08-13

  用户实测报的是一句话:「切换空间的时候项目也带过来了」。那是 B1 有意留的空档
  (B1 §7:「项目名册保持全局可见」),这一刀补上。

  范围:名册的**物理分家** + 全部消费点补空间上下文 + 删空间连坐。
  **不含**:跨空间搬项目、名册导出/导入(批 C)、server 端 space 维度。

  落地清单:

  - `project-dirs/persistence.ts`:`rootDir()` → 导出的 `projectDirsRoot(spaceId?)`。
    **default space 留在 `<store>/project-dirs/` 原地(零迁移)**,非 default 走
    `spaceDir(spaceId)/project-dirs/`(复用 spaces 自己的 `spaceDir`)。
    `loadIndex/saveIndex/loadProject/saveProject/deleteProject` 五个函数统一加
    尾参 `spaceId?`。
  - `project-dirs/store.ts`:`ProjectsStore` 加 `constructor(spaceId = 'default')`;
    进程单例改 **per-space 实例表**(`Map`,仿 server 的 `*ByOwner`)。
    `getProjectsStore(spaceId?)` 缺省/`'default'`/**非法 id** 一律映到 default 那份;
    `resetProjectsStoreForTests()` 清整表(返回值仍是 default 实例,旧签名兼容);
    新增 `forgetProjectsStore(spaceId)`。
  - `project-dirs/prompt.ts`:`buildProjectDirsPromptVars` 的 options 加 `spaceId?`,
    三处 store 读取一并带上。
  - `app/project-dirs/index.ts`:`buildProjectDirsPromptVars` 由**再导出改成薄包装**
    —— 收 `{ sessionId }`,用 `resolveSessionSpaceId` 换成 `spaceId` 再下发。
    装配层是唯一知道「会话 → 空间」的地方,产品层的 `prompt.ts` 只认 spaceId。
  - 提示词两条链路把 sessionId 递到这一层:`prompts/system-prompt-snapshot.ts` 的
    `buildProjectDirsPromptVars(wd, { sessionId })`、`agent-loop/stream-runtime.ts` 的
    `buildProjectPromptVars(wd, { sessionId: ctx.sessionId })`(两处接口声明 + 一处调用)。
    两个宿主注入点(`app/engine/prompt/system-prompt-snapshot.ts`、
    `app/engine/stream/agent-loop-runtime.ts`)**一行未改** —— 包装同名同位。
  - `app/variables/gateways.ts` 三处:workdir 变更的 `touch`/`update`、
    `syncProjectDerivedRoots` 的「是不是上次派生的」判据、
    `projectStoreGateway.resolveKey`,全部 `getProjectsStore(resolveSessionSpaceId(sessionId))`。
    **自动登记落进会话归属的 space** —— 这是那句症状的病根本身。
  - `app/variables/index.ts` 的 `isPreauthorizedDirectory` 按会话 space 判(下详)。
  - IPC 五件:runtime + shared 的请求类型都 `extends ProjectDirsWorkspaceScoped`
    (`workspaceId?`,新增 `ProjectDirsListRequest`);`ipc/project-dirs-controller.ts`
    的 list handler 开始接载荷(缺席补 `{}`);`ipc/project-dirs.ts` 五件按
    `request.workspaceId` 取 store;preload bridge / renderer types / `platform/web.ts`
    形态同步(末位 `workspaceId?`)。
  - renderer `stores/projects.ts`:`load()` 带 `currentSpaceId()` 并记
    `loadedSpaceId`;add/updatePaths(addRoot/removeRoot/setPrimaryRoot 共用)/remove
    全部带当前 space。Sidebar 加一条 `watch(() => spacesStore.currentSpaceId)` → 重载。
  - `spaces/store.ts` 的 `remove()`:`removeSpaceDir` 之外补 `forgetProjectsStore(spaceId)`。

  实施勘误与偏离(原样记录):

  1. **非 default 的名册根走 `spaces/persistence.ts` 的 `spaceDir()`,不是自己拼
     `getOnethingWorkspacesDir()`**。好处是两个模块共用同一套测试根覆盖:
     project-dirs 的 `setRootDirForTests` 此后**只管 default 那一份**,非 default
     的名册跟着 spaces 的 `setRootDirForTests` 走。代价是多一条 project-dirs →
     spaces 的模块依赖(单向,spaces 不反向依赖 persistence)。
  2. **`isPreauthorizedDirectory` 的实际取法:按会话 space,不是保守回退**。
     查了真实调用链 —— 唯一调用点是 `variables/providers/core.ts` 的
     `enforceSetPermission`,它手上就有 `ctx.sessionId`。于是给适配器加了第二参
     `ctx: { sessionId }`(产品层接口 + 唯一调用点 + 宿主实现三处),按会话的
     space 取名册。真没有 sessionId 时 `resolveSessionSpaceId` 给 default ——
     **更严**;全空间并集一次都没做(那等于任一空间的名册替所有空间免审批)。
  3. **`forgetProjectsStore` 放进 `SpacesStore.remove()`**,尽管这让 spaces 反向
     引用了 project-dirs 的 store。理由:空间只在这一个地方死,判定散到宿主
     (只有 Electron 装配了 spaces IPC)就等于让另外两个宿主天然漏掉。目录本身
     早就连坐了 —— `removeSpaceDir` 是 `rmSync(recursive)`,`project-dirs/` 在
     `workspaces/<id>/` 里面;这一行补的是**内存实例**,不补的话幽灵 store 会把
     索引写回刚删掉的目录。
  4. **同一目录在两个空间是两个项目,但项目级变量 scope 仍然共享**。
     `projectIdFromPath` 是路径的确定性哈希,所以 `/repo` 在 A、B 两空间拿到同一个
     id,而 `variables.json` 是全局的。本切片**没有**动这一点(变量分层是另一件事);
     记在这里,免得下次有人把它当 bug 查。
     **✅ 已于批 B8-3 清掉**(scope key 加空间前缀,default 保持旧形状;见下方 B8 切片)。
  5. **web 端收下 `workspaceId` 即丢**。`apps/server` 没有 space 维度,把它转发给
     一个不认识它的宿主只会造出「以为分家了」的假象,所以 `platform/web.ts` 的
     五个方法签名对齐、参数命名 `_workspaceId` 明示丢弃。
  6. **`ProjectDirsListRequest` 是新类型**(原来 list 无载荷)。controller 对
     `undefined` 补 `{}`,所以老渲染层/老 preload 的无参调用行为与本切片前完全一致。
  7. **重载挂在 Sidebar 的 watch 上,不是 `selectSpace` 里**。删空间会把当前空间
     弹回 default(`spacesStore.remove` → `switchTo`),那条路不经过 `selectSpace`。

  新增/更新测试:`project-dirs/__tests__/store-per-space.test.ts`(5 条:根解析与
  非法 id 落回、实例表折叠、双空间隔离与落盘、清表后各自重载、forget)、
  `app/variables/__tests__/workdir-gateway-space.test.ts`(5 条:登记落对空间、
  同目录两空间互不干扰、派生 roots 只认本空间、变量 scope key、prompt vars 按空间
  且无 sessionId 时落 default)、`spaces/__tests__/store.test.ts` 加删空间连坐一条、
  `variables/__tests__/providers.test.ts` 断言 `ctx.sessionId` 确实递到了预授权判据、
  `apps/electron/src/ipc/__tests__/project-dirs.test.ts` 加 workspaceId 透传一条、
  `renderer/stores/__tests__/projects-space.test.ts`(2 条:切空间整份换、五件套
  带当前 space)。

  #### 计划外发现（B4）

  - `platform/web.ts` 的 `projectDirsRemove` 与其余四件**不在一起**(它排在 spaces
    的凭证方法后面),差点漏改。形态同步的清单最好按调用面数,不按代码块位置。
  - `app/project-dirs/index.ts` 原本是纯再导出层,改成薄包装后**所有既有
    `vi.mock('.../project-dirs/index.js')` 的测试一行没改就过了** —— 因为包装保持了
    同名同位。这条经验值得复用:给一条链路加语境,优先在装配层同名包装,而不是
    改调用点。

  #### B5 切片（分栏树 per-space v4→v5 + ⌘1..9 空间切换）—— 已实施 2026-08-14

  用户可感知的洞:B1 之后切空间左栏过滤了,但**分栏树还是全局一棵** —— 打开的
  会话还是旧空间的(B1 只做了「激活会话不属新空间时校正」,树本身没分家)。

  范围:存档 v4→v5、切空间换树、⌘1..9。**不含**:跨空间搬会话、server 端
  space 维度(web 端继续走 B1 的 softJson 降级)。

  ##### v5 格式定义

  ```jsonc
  // app-state 的 `workspace` 字段(渲染层 localStorage 之外的那一份)
  {
    "version": 5,
    "spaces": {
      "<spaceId>": {                       // 缺席 = 那个空间还没开过任何分栏
        "forms": { "chat": {…}, "collab": {…} }   // 形状与 v4 的 forms 逐字一致
      }
    }
  }
  ```

  迁移:读到 **v4(或更老)时,现有的每形态树整体归 default 空间**,其他空间
  无树;写盘一律 v5。v1/v2/v3 的老路一条没动 —— 它们先被整份归给 default,
  再走既有的 v2/v3→v4 认领逻辑。

  落地清单:

  - `stores/workspace-persistence.ts`:新增 `PersistedWorkspaceV5` /
    `PersistedWorkspaceSpace` / `PersistedWorkspaceSpaceEntry`,
    `splitWorkspaceArchive(persisted, defaultSpaceId)`(整份 → 每空间一片)与
    `serializeWorkspaceArchive(spaces)`(每空间一片 → 整份)。
    `rebuildWorkspace` 的入参从 `PersistedWorkspace` 收窄到
    `PersistedWorkspaceSpaceEntry`(v5 不是"一棵树",它是一张表)。
  - `stores/workspace.ts`:`roots` / `activeLeafIds` 的语义变成「**当前空间**那两
    棵树」,别的空间寄存在 `parkedSpaces`;新增 `spaceId` / `setSpace()` /
    `flushPersist()` / `snapshotArchive()`;`closeSession` 从「扫两棵树」改成
    「扫每个空间的两棵树」;`hydrate` 先 split 再逐空间 rebuild。
  - `components/sidebar/Sidebar.vue`:`selectSpace` 瘦成只调 `switchTo`,换空间的
    全部后果(重载名册 + 换树 + 校正激活会话)统一挂在既有的
    `watch(() => spacesStore.currentSpaceId)` 上。
  - `composables/useShortcuts.ts`:新增纯函数 `spaceShortcutIndex(event)` +
    `onSelectSpace` handler;`App.vue` 接上(只调 `spacesStore.switchTo`)。

  ##### 快捷键探查结论与最终键位

  **⌘1..9 是空的,直接用,不必退让到 ⌘⌥1..9。** 探查结果:

  | 位置 | 结论 |
  | --- | --- |
  | `composables/useShortcuts.ts` | ⌘1..9 原本按位置切页签,随多页签一起退役(U2),原注释明写「这几个键位现在留白,不抢」 |
  | `ShortcutSettings`(`shared/ipc/settings.ts`) | 8 个具名条目,无一个数字键 |
  | 应用菜单(`apps/electron/src/menu/application-menu.ts`) | 只有 ⌘W / ⌘T / ⌘, |
  | 系统级全局快捷键(`apps/electron/src/shortcuts/global-shortcuts.ts`) | 由 `ShortcutSettings` 派生,同上 |
  | 其余数字键位 | `editor/MarkdownDocumentEditor.vue` 的 ⌘⇧7/8/9(有序/无序/任务列表) |

  所以最终键位 = **⌘1..9 / Ctrl+1..9**,且**⌥ 与 ⇧ 一律不认**(⌘⇧7 已被编辑器
  占着;⌘⌥数字留给将来)。⌘0 也不认 —— 空间从 1 数起。

  实施勘误与偏离(原样记录):

  1. **快捷键做成固定键位,不进 `ShortcutSettings`**(与 ⌘, 同一档)。那张表是
     「一个动作一个键」,装不下一段 9 键的区间;为它改表结构等于为一个导航键
     动整个设置面。落点仍是既有的注册机制 —— `useShortcuts` 的
     `handleGlobalKeydown`,**没有新挂裸 keydown 监听**。设置页因此也没有新行。
  2. **判断抽成纯函数 `spaceShortcutIndex(event)`**,而不是塞在
     `handleGlobalKeydown` 里。理由是可测:起一个组件只为了敲一次键盘,测的是
     Vue 不是键位。
  3. **切空间的全部后果收进 Sidebar 那条 watch**,`selectSpace` 只剩一行
     `switchTo`。B4 的勘误 7 已经证明「挂在 selectSpace 里」会漏掉删空间弹回
     default 那条路;⌘1..9 是第二个绕过 `selectSpace` 的入口 —— 与其让每个入口
     各写一遍,不如让它们都只改「当前空间」这一个值。代价:**Sidebar 没挂载时
     没有换树**(其它窗口不画左栏,本来也没有分栏树)。
  4. **树不在内存里"惰性载入",而是 hydrate 时把每个空间都还原好寄存**。
     一棵树几十字节,换来的是切换零 I/O、零异步;也顺手回避了「寄存的是原始
     v2/v3 存档还是活树」这个二义性(全是活树)。
  5. **`closeSession` 改成扫每个空间**。留给下次 rebuild 去清也行,但那要等到
     重启 —— 中间那次切换看到的就是空壳格。
  6. **"不属于本空间"的会话走既有的无效叶清理路**,不新造判据:rebuild 时的
     `isValidSessionId` 从「在会话表里」加严成「在会话表里**且**属于这个空间」,
     整格丢掉 + 空分栏收起这些行为一行没改。
  7. **切换前 `flushPersist()`**。换树会改掉 `roots`,debounce 窗口里挂着的那次
     写盘醒来看到的已经是新空间的树 —— 最后一次分栏操作会无声无息地丢。
  8. **形态(form-mode)保持全局,校正激活会话时也只在当前形态里挑候选**。
     否则目标空间最近的一条恰好是房时,`openSession` 会把人从对话形态拽去协作
     ——「换个空间」不该顺手换掉「我在看哪类活」。这一形态没有会话时落空态屏,
     与切形态那边「那个形态还没被用过」同一口径。
  9. **校正激活会话改走 `workspaceStore.openSession`**,不再直接
     `sessionsStore.switchSession`。B1 那种写法只改 currentSessionId、不动树,
     正是「树没分家」这个洞的一部分;判据也从 `sessionsStore.currentSessionId`
     换成 `workspaceStore.activeSessionId`(树才是主区的真相,且 watch 是异步的)。
  10. **切换绝不 abort 任何活跃流** —— `setSpace` 只碰树,一行都没有碰会话/流的
      生命周期(Arc 语义,§2)。

  ##### 计划外发现（B5）

  - `packages/onething-runtime/src/storage/app-state.ts` 里的
    `OnethingPersistedWorkspace` 还写着 `version: 2` + 单 `root`,**从 v3 起就已
    经与渲染层对不上**。它只是个透传形状(`mergeOnethingUiState` 整字段搬,
    `readJsonFile`/`writeJsonFile` 不校验),所以 v3/v4/v5 一路照写不误 ——
    但它是个会骗人的类型。本切片没动它(动它要牵一串 IPC 类型);记在这里。
  - 全量 vitest 里 `RoomSettingsDialog.test.ts` 的偶发红(B3 记过)仍在。

- **批 C：物理归位**：sessions/ 迁入 `workspaces/<id>/sessions/`（复用 jsonl 惰性
  迁移先例）；整空间导出/导入（默认剔除 credentials.json）。
- **批 D：多凭证管理 UI + 内置轮换**（priority-failover / round-robin；挂在 core
  agent-loop 的 turn 级重试边界，不另起重试链）。

  **B3 留下的接口（批 D 直接接手，不必迁移数据）**：
  - 存储已经是池：`credentials.json` 的 `providers[<pid>].entries[]` + `policy`
    第一天就是最终形状；`upsertSpaceProviderApiKey` 只替换 `entries` 里的第一条
    apiKey 条目，**其余 entry 原样保留**（含 `source: 'plugin:<id>'` 的）。
  - 选择器是单点：`selectSpaceCredentialEntry(credentials, now)`
    （`spaces/credentials.ts`）——今天返回「第一条不在冷却里的」，轮换只需要在
    这一个函数里按 `policy` 分岔，上游一行不用改。
  - 冷却已经是读侧生效的字段：`cooldownUntil` 参与选择（`isSpaceCredentialEntryCooling`），
    只差**写**它的人（错误分类 → 盲点 6）。
  - 归因已经打通：命中的 entry id 经 `providerConfig.spaceCredential.entryId`
    传到下游，并由 `resolveSessionCredentialId` 写进账本 `credentialId`。
    轮换后按 key 出账/按 key 看错误率，读侧不用再加维度。
  - 「未配置」是一等状态：`resolveSpaceProviderCredential` 返回
    `{kind:'unavailable', reason, message}`，reason 目前两种（`no-entry` /
    `oauth`）。批 D 的「全池耗尽」是第三种 reason，加在同一个联合里即可 ——
    阻断点（`resolveProviderAuthWithAdapters`）与文案出口
    （`describeMissingCredentials`）都已经就位。
  - per-space OAuth：`entry.authType === 'oauth'` + `oauthToken` 已在 schema 里，
    解析侧目前一律判 `unavailable`。要打开只需把
    `resolveSpaceProviderCredential` 的那一个分支换成「取本空间的 token」，
    并解决盲点 5 的刷新单飞锁。**（已于批 B6 打开，见下方 B6 切片；数据零迁移，
    B3 第一天定死的 schema 原样接手。）**

  #### 批 D（多凭证管理 UI + 内置轮换）—— 已实施 2026-08-15

  范围：三种策略全部生效、统一错误分类器、冷却写侧、「全池耗尽」第三态、
  多条目管理 UI。**明确排除**：插件策略注册表（批 E）、per-space OAuth（→ 批 B6）、
  server `/api/spaces/*` 路由（web 端继续 softJson 降级）、`Retry-After` 透传
  （见勘误 3）。零数据迁移 —— B3 第一天定死的池形状原样接手。

  落地清单：

  - **策略实现全部收在 `selectSpaceCredentialEntry`**
    （`spaces/credentials.ts`），上游一行未改。新增
    `selectSpaceCredentialEntryDetailed`（返回 `{entry?, exhausted?}`）承担第三态，
    老签名成了它的薄封装（多一个可选的 `cursorKey` 形参）。
  - **统一错误分类器**：`agent-loop/provider-error-classification.ts`，
    输出 `quota-exhausted / rate-limited / auth-invalid / transient / unknown`
    + `rotates` + 冷却常量表 `PROVIDER_ERROR_COOLDOWN_MS`。
  - **轮换边界**：core `AgentLoopOptions.rotateCredential`（可选、加法）挂在
    `runner.ts` 的 attempt 循环 catch 块；宿主实现在
    `app/providers/credential-rotation.ts`；provider 重建口子是
    `buildOnethingAgentLoopStreamRuntime` 新返回的 `reprovision`。
  - **IPC 只加一条**：`spaces:set-credential-pool`（整池写 = 排序 + 删除 + 策略）；
    `spaces:set-credential` 加 `entryId?` / `label?`。
  - `SpaceCredentialsPanel.vue` 升级成多条目面板（条目列表 + 冷却标记 +
    上下移 + 两段式删除 + 就地换密钥 + 策略选择器）。

  实施勘误：

  1. **重试路径原本不重走凭证解析——这是批 D 的真问题，不是一句"确认"。**
     凭证在 `createProvider` 时就被烤进 provider 闭包（claude 的 `x-api-key`、
     deepseek 的 `Authorization` 都是构造时拼好的字符串），
     `buildAgentLoopRuntimeFromStreamContext` 一次解析之后，turn 级重试
     （`runner.ts` 的 attempt 循环）重放的是**同一个 provider 对象**。
     全仓唯一会重新解析凭证的重试是 goal 层的 run 级重试
     （`app/goals/runtime-hooks.ts`，它重新走整条 send-message 管线），
     那条路只服务 goal 会话。**接法**：core 把 `options.provider` 换成一个
     `let activeProvider`，只在 attempt 循环的 catch 块里由新的
     `rotateCredential` 钩子换掉；宿主侧「重新解析」的落地就是
     `resolveSessionProviderCredential` + `reprovision({apiKey, baseUrl})` 重建。
     `resolveAuth` 那条路没动——它没有 sessionId，B3 的结论仍然成立。
  2. **轮换必须在 `isRetryableAgentError` 之前问。** 配额耗尽命中
     `retry.ts` 的 `FATAL_PATTERNS`（`insufficient_quota` / `quota_exceeded` /
     `billing`），按老规矩**一次都不重试**——对同一把 key 这是对的，对下一把
     不是。所以轮换是一个**独立于**「这个错误可不可重试」的重试理由。
     副作用闸（`resultsByToolCallId.size > 0`）仍排在最前面：换钥匙不会让
     重复执行工具变安全。
  3. **没有一个 provider 透传 `Retry-After`。**(**✅ 已于批 B8-2 清掉** ——
     五家的错误构造处都接上了响应头/响应体,见下方 B8 切片的逐家形态表。以下是
     批 D 当时的原样记录。)五个家族没有一处读
     `response.headers.get('retry-after')` 或 `x-ratelimit-reset`。分类器里
     `retryAfterAt` 字段先占位（`providerErrorCooldownUntil` 已经会优先用它），
     但目前恒为 undefined，冷却一律走默认值。要真用上得先改 provider 的
     错误构造语句，那是另一件事。
  4. **各家族错误形态（实测自代码，不是文档）——五家里只有一家把状态码放在顶层**：

     | 家族 | 抛出处 | 形状 |
     | --- | --- | --- |
     | claude / claude-code | `providers/claude.ts` | 裸 `Error`，`Claude agent loop API error: <status> <body>` |
     | deepseek | `providers/deepseek.ts` | 裸 `Error`，`DeepSeek agent loop API error: <status> <body>` |
     | gemini | `providers/gemini.ts` | 裸 `Error`，`Gemini agent loop API error: <status> <body>` |
     | openai-compatible（zhipu/qwen/kimi/grok/openrouter/custom…） | `providers/openai-compatible.ts` | `Error` + `{responseBody, data:{providerId, statusCode, responseBody}}` — statusCode **藏在 data 里一层** |
     | codex | `providers/codex.ts` | `Error` + `{statusCode, responseBody, isRetryable}` |

     因此取状态码是三段兜底：顶层 → `data.statusCode` → **锚定前缀**的消息抠取
     （`API error: 429` / `request failed (429)`）。**不照抄 `retry.ts` 的
     `\b(4\d\d|5\d\d)\b` 全消息扫描** —— 响应体里一个 `"max_tokens": 500`
     就够让它读错（这条另有一测钉住）。顺带记下：`retry.ts` 的 `errorStatus`
     只读顶层，读不到 openai-compatible 家族的 `data.statusCode`，那一整族今天
     纯靠消息正则分类。批 D 没有去修它（那是 retry 自己的账），只是没有继承它。
  5. **保守优先级的三个具体判例**（写测试时逐条抓出来的）：
     - **Gemini 用 400 报 `API key not valid`**。所以鉴权证据分两档：强字面
       （`invalid_api_key` / `api key not valid` / `authentication_error` …）
       **与状态码无关**；弱词（`unauthorized` / `permission_denied`）只在
       401/403 上作数。只按 401/403 判会漏掉一整个家族。
     - **429 没有配额字样一律按限流**。Gemini 的 `RESOURCE_EXHAUSTED` 同时用于
       限流与配额；歧义时取冷却更短的那个——猜短的代价可逆（轮回来再撞一次），
       猜长的代价是白白闲置一把好 key。
     - **Anthropic 529 `overloaded_error` 是 transient，不是限流**。它是服务端
       过载，与这把钥匙无关；冷却它等于替 provider 的抖动惩罚用户的钱包。
       同理 403 没有鉴权字样时不判（可能是地区封禁/模型无权限，换 key 无用）。
  6. **冷却时长依据**（`PROVIDER_ERROR_COOLDOWN_MS`，集中可调）：
     quota 5 分钟 / rate-limit 60 秒 / auth-invalid 24 小时。
     quota 取 5 分钟不是因为它准——真实窗口从分钟到一天不等，没有响应头就无从
     知道——而是因为**猜短的代价可逆**。rate-limit 取 60 秒是因为绝大多数
     provider 的 RPM 窗口就是 60 秒。auth-invalid 取 24 小时是「这一天别再撞它」，
     它不会自己恢复；真正的修复是用户换 key，而**换 key 会整条覆盖写 entry，
     顺手把 `cooldownUntil` 抹掉**（不是额外一行代码，是覆盖写的自然结果）。
  7. **轮转游标不落盘**，进程内存 `Map<`spaceId:providerId`, number>`。落盘会把
     一个纯调度细节变成需要迁移、需要并发保护的状态；重启后从头轮一遍顶多让第一条
     key 多担一次请求。游标走在**可用集**上而不是全集——冷却掉的 entry 不该占着
     一个轮次让整池空转。没有 `cursorKey` 时 round-robin 退化成 failover，
     而不是编一个全局共享游标（那会让两个 provider 互相拨对方的表）。
  8. **`single` 的语义一字未改**：候选集是**全部 entry**（头一条不在冷却里的），
     不跳过用不了的 entry。只有两种轮换策略才额外剔掉 OAuth 型 / 空 key 的
     entry——跳过一条用不了的去用后面那把真 key，正是「failover」这个词的意思。
     没有池的用户不该因为批 D 的到来看见任何行为变化。
  9. **「全池耗尽」只在候选非空且全部冷却时成立**。空池 / 全是 OAuth 型仍然是
     `no-entry`（未配置）。两者出路完全不同：前者是「等」，后者是「去配」——
     说反了用户会去再配一把同样耗尽的 key。文案带出最早恢复时间。
  10. **整池写的载荷是 `entryIds` 而不是整份 entries**。渲染层拿不到密钥原文
      （B3 决策 8），它能诚实回传的只有「这些 id、按这个顺序」。删除 = 不在列表里；
      排序 = 列表顺序；策略同一次写。密钥本身只有「添加」与「换密钥」两个入口。
      后端拒绝空列表（`INVALID`）：删最后一条与「清除整段」是两个不同的动作，
      不该由一次误发的排序请求顺手完成。
  11. **`set-credential` 的缺省语义变了**：`entryId` 缺席时 B3 是「覆盖头一条
      apiKey entry」，批 D 起是「追加一条」。多条目 UI 上「添加」与「保存」是两个
      按钮，后端也得是两个意思。B3 那个语义没有调用点遗留（唯一的调用方就是这块面板）。
  12. **`packages/core` 又动了两处**（与 B1/B3 同性质：可选、加法、零行为改变）：
      `AgentLoopOptions` 新增 `rotateCredential?` / `maxCredentialRotations?`，
      `retry.ts` 新增 `MAX_CREDENTIAL_ROTATIONS = 3`。轮换预算是**按 run 算**
      而不是按 turn——按 turn 算的话一次运行能把任意大的池走穿，用户对着转圈等。
  13. **删除做成两段式就地确认**，不是 Dialog、不是 `window.confirm`
      （后者被 ui-gate 的 `native-confirm` 禁掉，与 B3 决策 10 同一条理由）。
      密钥删掉从面板上找不回来，一次点击太轻。

  ##### 计划外发现（D）


  - `StreamProviderConfig`（`app/engine/stream/stream-processor.ts`）过去没有声明
    `spaceCredential`——B3 盖的那个运行期标记一直只在**值**上存在，类型上看不见。
    批 D 要从它读 entryId，顺手补了声明（补在这条"活的" stream config 上，
    不是 `ProviderConfig`——那是设置的落盘形状，标记永不落盘）。
  - `CoreSpaceCredentialMarker.unavailable.reason` 是一处**手写重复**的联合
    （`provider-config.ts` 与 `provider-credentials.ts` 各写一份），加第三态要改两处。
    没有合并（合并要让 core 的类型依赖 spaces 模块），记在这里。
  - `agent-loop/stream-runtime.ts` 的 `reprovision` 声明成了**可选**：既有测试夹具
    手写了 `BuildAgentLoopStreamRuntimeResult` 的 supported 分支，声明成必填会顶红。
    执行侧因此带一个 `prepared.reprovision ? … : undefined` 的守卫。
  - 全量 vitest 本批次全绿（1069 文件 / 9732 测试），B3/B5 记过的
    `RoomSettingsDialog.test.ts` 偶发红这一轮没有复现。
  #### B6 切片（per-space OAuth）—— 已实施 2026-08-15

  范围：拆掉「OAuth 型 provider 在非 default 空间一律 unavailable」这道 B3 临时闸。
  非 default 空间的 OAuth 凭证变成**池里的 oauth entry**：在该空间单独登录、token
  落进 `workspaces/<id>/credentials.json`、同一 provider 允许多个账号、参与批 D 的
  轮换与冷却。**default 空间的 OAuth 行为一字未动**（源仍是 `<store>/oauth-tokens.json`）。
  **明确排除**：MCP OAuth 与外部 agent 登录态（盲点 5 已写明一期留全局）、
  server `/api/oauth/*` 的 space 维度（web 端收下即丢）、跨空间搬账号。

  ##### 探明的 OAuth 链路（本切片的调研结论，原样记录）

  任务书猜的是「token 大概率在 `settings.ai.providers[*].oauthToken`」——**猜错了**。
  `ProviderConfig.oauthToken` 这个字段在类型里存在、在 `ConnectionsSection.vue`
  里被读来判「配过没有」，但**没有任何生产代码往它里面写**。真正的落点是另一处：

  | 环节 | 落点 |
  | --- | --- |
  | 存储 | `<store>/oauth-tokens.json`，`{ [providerId]: <safeStorage 加密串> }`，`OnethingTokenStore`（`auth/token-store.ts`），进程单例 `app/auth/token-store.ts` |
  | 登录流 | `OnethingAuthService`（`auth/auth-service.ts`）三种 `flowKind`：`device-code`（Copilot/Kimi Code）、`pkce-callback`（本地回调服务器 `auth/callback-server.ts`）、`manual-pkce`（手输码，Claude Code） |
  | provider 定义 | `auth/registry.ts` 的 `OnethingAuthProviderDefinition`（端点/clientId/scopes/参数构造/token 归一） |
  | IPC | `oauth:{start,callback,device-poll,refresh,status,logout}` → `apps/electron/src/main/ipc/oauth.ts` → `authService.*`；渲染层组合在 `useProviderAuth.ts` |
  | 过期判定 | `tokenStore.isTokenExpired(token)` = `now >= token.expiresAt`；`refreshTokenIfNeeded` 另有 **5 分钟** 提前量（`REFRESH_BUFFER_MS`） |
  | 起流时取 token | `resolveProviderAuthWithAdapters` → 适配器 `resolveOAuthAuth` → `authService.resolveProviderAuth` → `refreshTokenIfNeeded` |
  | **回合中途**取 token | provider 闭包里的 `refreshOAuthToken(providerId, forceRefresh)`，宿主实现在 `app/agent-loop/providers/factory.ts` 的 `createRefreshOAuthToken` —— 这一处**既没有 sessionId 也没有 space**，是本切片最容易漏的一格 |

  ##### 写回目标参数化的实际接法

  新增一个纯数据类型 `OnethingCredentialTarget`（`auth/credential-target.ts`）：

  ```ts
  { kind: 'settings' }                                   // 缺省 = 今天的行为
  { kind: 'space', spaceId, entryId?, label? }            // entryId 缺席 = 追加新 entry
  ```

  它被加到 `OnethingAuthService` 的**每一个碰 token 的方法**末位（`start` /
  `completeManualCode` / `pollDeviceFlow` / `refreshToken` / `refreshTokenIfNeeded` /
  `getToken` / `saveToken` / `deleteToken` / `isLoggedIn` / `getStatus` /
  `resolveProviderAuth`），流程本身一行未改 —— 只有「存到哪儿、从哪儿取」变成
  `readToken/writeToken/removeToken` 三个私有分派。space 那一支走新的
  `OnethingSpaceAuthTokenStore`（`auth/space-token-store.ts`，读写凭证池的
  `entry.oauthToken`），由 `createOnethingAuthServiceOptions` 默认装上。

  「解析点有 sessionId、鉴权点没有」这条 B3 老规矩被复用了第二次:B3 用
  `providerConfig.spaceCredential` 把「未配置」送到鉴权点，B6 用**同一个标记**把
  「token 在哪儿」送过去（标记新增 `authType?: 'apiKey' | 'oauth'`）。因此鉴权点
  不必反查会话属于哪个空间 —— 反查就是第二份判据。

  ##### 单飞锁的位置

  `OnethingAuthService.refreshToken` 内，`private refreshInFlight = Map<string, Promise<TToken>>`，
  key = `credentialRefreshKey(providerId, target)` = `${providerId}::settings` 或
  `${providerId}::space:<spaceId>:<entryId>`。`refreshTokenIfNeeded` **必须**走公开的
  `refreshToken` 才能进锁（绕过去就等于没有锁，这一条有测试钉住）。

  粒度的两条理由：粗一格（只按 providerId）会让 A 空间的调用拿到 B 空间的 token；
  细一格（按调用点）等于没锁。`entryId` 缺席（新登录）用 `*` 占位 —— 那一路还没有
  entry，同一空间同一 provider 同时开两个新登录本来就该串起来。

  ##### 解析/刷新链路的出口复查（B3 §「provider 解析出口清单」逐条过）

  | # | 出口 | B6 处理 |
  | --- | --- | --- |
  | 1 | `getEffectiveOnethingProviderConfig` | 主注入口不变；`applySpaceProviderCredential` 新增 `oauth-entry` 分支：盖 `oauthToken` + 标记，**抹掉 settings 的 apiKey** |
  | 1a/1b | core `resolveProvider` / `provider-helpers.getEffectiveProviderConfig` | 经 #1 覆盖 |
  | 2 | `resolveProviderConfigForChat` | 经 #1 的同一个注入函数覆盖；其 `resolveOAuthAuth` 已改为带标记 |
  | 3 | `createUtilityProvider` | 已带标记（`applySessionSpaceCredentials` → `resolveProviderAuth`），且把 `spaceCredential` 一并塞进 runtime config，中途刷新才回得对 |
  | 4 | core `generateSessionTitle` | 走 `stream-provider-adapter` 的 `resolveAuth`，已带标记 |
  | 5 | `resolveProviderAuthWithAdapters` / `getProviderApiKeyWithAdapters` | **改造点**：两处都把 `providerConfig.spaceCredential` 递给 `resolveOAuthAuth` / `refreshOAuthToken`。`unavailable` 闸仍排在最前 |
  | 6 | `app/plugins/llm.ts` | 仍停在全局层（有意，同 B3） |
  | 7 | `app/voice/providers.ts` | 仍停在全局层（盲点 9 的范围闸） |
  | 8 | `model-registry.ts` | 不是凭证出口 |
  | 9 | `agent-loop/providers/*` | **新增一处**：`createRefreshOAuthToken` 从 `config.spaceCredential` 取目标。这是回合中途刷新的唯一入口，不带目标就会把某空间刷出来的 token 写进默认空间那份文件 |
  | 10 | 外部 agent / acp | 不受影响（凭证本来就是空串，且排在 #5 的闸之后） |

  复查结论：链路上**没有**第二处在空间池场景下仍读 settings 的 token。唯一还落在
  settings 的是 `app/agent-loop/providers/codex.ts` 里那个直接构造 codex provider 的
  逃生口 —— 它没有生产调用点（只被 `app/agent-loop/index.ts` 再导出、只有测试用），
  且当调用方传了 `refreshOAuthToken` 时那条兜底根本不执行。记在这里当路标。

  ##### 落地清单

  - `auth/credential-target.ts`（新）：目标类型 + `credentialTargetKey` /
    `credentialRefreshKey` / `normalizeCredentialTarget`（**非法或 default 的
    spaceId 一律落回 settings** —— spaceId 是路径片段，与 B1 决策 3 同一条闸）/
    `credentialTargetFromSpaceMarker`。
  - `auth/space-token-store.ts`（新）：`OnethingSpaceAuthTokenStore` 接口 +
    `createOnethingSpaceTokenStore()` + `parseSpaceOAuthToken`（形状检查与
    `OnethingTokenStore.parseToken` 逐字一致）。
  - `auth/auth-service.ts`：目标参数 + 三个私有分派 + 单飞锁 +
    **登录流按目标分家**（`providerFlowIds` / `providerErrors` 的 key 从
    `providerId` 变成 `providerId::<target>`，`OnethingAuthFlowState` 加 `target`）+
    刷新/交换失败的错误挂上 `statusCode`。
  - `auth/service-factory.ts`：默认装上 spaceTokenStore；`auth/index.ts` 导出新面。
  - `spaces/credentials.ts`：`upsertSpaceProviderOAuthToken`（缺 entryId = 追加）/
    `removeSpaceProviderCredentialEntry` / `getSpaceCredentialEntry`；
    `isSpaceCredentialEntryUsable` 认 oauth+token；
    `selectSpaceCredentialEntryDetailed` 加 `authType?` 形态过滤。
  - `spaces/provider-credentials.ts`：新解析态 `oauth-entry`；OAuth 型 provider 按
    `authType:'oauth'` 选池；文案从「请在默认空间使用」改成「在本空间登录」。
  - `providers/provider-config.ts` / `provider-runtime.ts` / `stream-provider-adapter.ts`：
    `resolveOAuthAuth` / `refreshOAuthToken` 末位加可选的 `CoreSpaceCredentialMarker`；
    `CoreSpaceCredentialMarker` 加 `authType?`。
  - `agent-loop/provider-error-classification.ts`：新增 `classifyOAuthRefreshError`。
  - `app/providers/space-credentials.ts`：`credentialTargetFromMarker` /
    `resolveSessionSpaceOAuthAuth`（鉴权点唯一入口，失败时写冷却）/
    `markSpaceOAuthRefreshFailure` / `removeSpaceProviderOAuthEntry`；摘要投影补
    `hasOAuthToken` / `oauthExpiresAt` / `oauthAccount`。
  - `app/providers/credential-rotation.ts`：`oauth-entry` 分支 —— 先
    `refreshTokenIfNeeded` 再 `reprovision({oauthToken, spaceCredential})`；
    刷不动就写 auth-invalid 冷却并放弃这一轮。
  - `agent-loop/stream-runtime.ts` 的 `reprovision` override 加 `oauthToken` /
    `spaceCredential`（换 token 时**连 `authContext` 一起顶掉**，否则 provider 会继续
    拿旧账号的 token 拼请求头）。
  - `packages/core/engine/agent-loop-runtime.ts`：`spaceCredential` 进
    `providerRuntimeConfig`（第四次动 core，仍是可选、加法、零行为改变）。
  - IPC 形态同步：`shared/ipc/oauth.ts` 的六个请求 `extends OAuthCredentialTargetRequest`
    + `shared/ipc/index.ts` 显式列名 + `apps/electron/src/ipc/oauth.ts` +
    `main/ipc/oauth.ts`（`targetOf()` 归一）+ preload bridge + `renderer/types/index.ts`
    两段 + `platform/web.ts` 降级（收下即丢）。`shared/ipc/spaces.ts` 的
    `SpaceCredentialEntrySummary` 加三个 OAuth 字段。
  - `SpaceCredentialsPanel.vue`：OAuth 行从灰态换成「登录」入口 + 已登录账号列表
    （账号/有效期/冷却）+ 两段式「退出登录」+ 三种流程的引导（device code 提示、
    手输码输入框、回调等待）。

  ##### 实施勘误与偏离（原样记录）

  1. **池里的 oauth token 是明文**。(**✅ 已于批 B8-1 清掉** —— 整份
     `credentials.json` 走同一个 safeStorage 端口加密,惰性升级零迁移;见下方
     B8 切片。以下是批 B6 当时的原样记录。)`oauth-tokens.json` 走 safeStorage 加密，
     `credentials.json` 从 B3 起就明文存 apiKey。同一个文件一半明文一半密文，会让
     「这个文件安不安全」变成一个要逐字段回答的问题。整份文件的定位是**秘密区**
     （批 C：整空间导出默认剔除它），所以选了口径一致而不是局部加密。
  2. **`isSpaceCredentialEntryUsable` 的语义扩了**：批 D 时「usable」= 有 apiKey，
     因为那时非 default 空间的 oauth entry 必然是空壳。现在它可以真的装着 token，
     继续把它当不可用等于让轮换永远跳过用户刚登录的账号。判据仍是「有没有凭证
     材料」这一句，只是材料多了一种。**批 D 勘误 8 的那句话因此需要读作**：
     failover/round-robin 剔掉的是「空 key / 空 token」，不是「OAuth 型」。
  3. **`selectSpaceCredentialEntryDetailed` 加的是形态过滤，不是新策略**。
     `authType` 缺省不过滤 —— 批 D 之前的调用点行为一字未改。OAuth 型 provider 传
     `'oauth'`，apiKey 型 provider **不传**（传了会把 `single` 的候选集从「全部
     entry」收窄，那是行为变化）。
  4. **OAuth 刷新失败单独一个分类器**，没有并进 `classifyProviderError`。
     同一个 400 在两处含义相反：聊天端点的 400 是程序性错误（分类器有意判
     `unknown`、绝不轮换），token 端点的 400 是 RFC 6749 §5.2 的 `invalid_grant`
     出口 —— 一条死掉的凭证。合成一个函数必然有一边判错。
  5. **`Token refresh failed: <status>` 的错误对象挂上了 `statusCode`**。
     分类器取状态码是**锚定前缀**的（`API error: NNN` / `request failed (NNN)`，
     批 D 勘误 4），裸消息匹配不上，不挂就永远是 `unknown`、永远不写冷却。
  6. **单飞锁给默认空间也上了**。这在严格意义上是默认空间路径的一处行为变化
     （并发刷新从 N 次变 1 次），但盲点 5 说的那件事对 settings 源同样成立 ——
     rotation 语义下第二次拿着已被消费的 refresh token 去换，换回来的是错误。
     单次调用的可观察行为完全不变，回归测试钉的是这一条。
  7. **登录流按目标分家**（`providerFlowIds` 的 key 加了目标）。不改的话，
     在 A 空间点登录、再在 B 空间点登录，第二次会 `clearProviderFlow` 掉第一次的流；
     更糟的是手输码那一支会认领错流程，把 B 的码换成的 token 写进 A。
  8. **登录完成的判据是「池里多了一条带 token 的 oauth entry」**，不是 oauth 状态
     查询。新登录那一刻还没有 entryId（后端在写入时才分配），状态查询无从定位；
     而三种流程的落地信号完全一致 —— 池里出现新条目。一个判据覆盖三条路。
  9. **`entryId` 缺席的缺省语义定成「追加」**，与批 D 勘误 11 的 `set-credential`
     同向。多账号是这一刀的原始需求；缺省定成覆盖，第二个账号就永远登不进去。
  10. **写 token 顺手抹掉 `cooldownUntil`**。刚登录/刚刷新成功的凭证还坐在冷板凳上
      说不通 —— 与批 D 勘误 6「换 key 会抹掉冷却」是同一句话（都是整条 entry
      覆盖写的自然结果）。
  11. **换 token 时 `authContext` 一起顶掉**。`reprovision` 只改 `oauthToken` 的话，
      `preparation.providerRuntimeConfig` 里首次解析烤进去的 `authContext.token`
      还是旧账号的，provider 会拿它拼请求头 —— 换了个寂寞。
  12. **导入向导继续跳过 OAuth,理由从「还没做」升级为「刻意」**。复制一份
      oauth token = 两个空间共用同一串 refresh token；在 refresh rotation（刷新时
      旧 refresh token 立即作废）下，谁先刷新谁就把另一个空间踢下线，而且症状是
      随机的。UI 与 `importDefaultSpaceCredentials` 的注释都写明了这一条。
  13. **web 端收下即丢**（`platform/web.ts` 的 `_target`）。`apps/server` 没有 space
      维度，转发给一个不认识它的宿主只会造出「以为分空间登录了」的假象 ——
      与 B4 勘误 5 同一条口径。
  14. **宿主没装 `spaceTokenStore` 时 space 目标降级为 settings**，不抛错。
      CLI daemon / server 本来就只有默认空间，让一个不适用的功能变成 crash 不划算。

  ##### 计划外发现（B6）

  - **`ProviderConfig.oauthToken`（`shared/ipc/providers.ts:142`）是个从来没人写的
    字段**。注释写着 "Stored OAuth token (encrypted in storage)"，实际上真正的
    存储是 `oauth-tokens.json`；唯一的读者是 `ConnectionsSection.vue:651` 拿它判
    「这个 provider 配过没有」（恒为 false，所以那句判断实际只剩
    `selectedModels.length > 0` 在起作用）。本切片没有动它（动它要牵一串类型），
    但它是个会骗人的字段。
  - **`createOnethingProviderFacade` 的 `requiresOAuth` / `refreshOAuthToken` 两个
    适配器在 `provider-facade.ts` 里声明了却从未被调用**，连
    `resolveOnethingOAuthProviderConfig` 这个 import 也是死的。那条路
    （`generateChatResponse` 等工具调用）今天不走 OAuth。没有顺手删（不在本切片
    范围），记在这里。
  - **`packages/renderer/styles/__tests__/ui-token-vars.test.ts` 在全量跑里红 2 条**，
    来源是工作区里一个**未跟踪**的新文件
    `packages/renderer/components/chat/todo-paper.css`（直接写了几十个 hex 颜色）。
    与本切片无关，未动。

  #### B7 切片(provider 设置与模型选择器「空间化」)—— 已实施 2026-08-16

  **这一片是纠偏,不是新功能。** B3 起后端的凭证解析就是 per-space 的(§「provider
  解析出口清单」逐条覆盖过),但**渲染层的编辑面与展示面一直盯着全局 `settings.ai`**:
  切到空间 B 打开设置,看见的是默认空间的 key;模型选择器列的是全局勾的模型;
  空间的凭证得去 tab 末尾另一块面板里改。用户 08-15 的原话:

  > 「多空间的认证不是一个多余的新表单让你填,而是我切换 workspace 的时候,
  > 它就自动切换过去了。」

  范围:渲染层的「当前空间 provider 视图」抽象 + 连接区/模型选择器/模型总账改吃它 +
  `selectedModels` 落进 overlay + 设置窗跟随当前空间 + `SpaceCredentialsPanel` 退役。
  **明确排除**:默认模型(`providers[*].model`)与逐模型调参仍在全局层(见勘误 4)、
  引擎侧 `selectedModels` 兜底(勘误 5)、server `/api/spaces/*` 路由(web 端继续
  softJson 降级)、批 E/F。**零数据迁移** —— 默认空间的两个源一字未动。

  ##### 落地清单

  - **视图抽象两件**(渲染层):
    - `packages/renderer/stores/spaceProviders.ts`(新):当前空间那一侧的状态 ——
      凭证摘要 + overlay 的 `selectedModels` + `refresh/ensureLoaded/applyCredentials/
      writeSelectedModels`;`watch(spaceId)` 是**唯一**的刷新点(主窗切换、设置窗
      跟随、删空间弹回 default 全汇流到这里)。
    - `packages/renderer/composables/useSpaceProviderView.ts`(新):三态合流的读写口 ——
      `credentialOf / isConfigured / selectedModelsOf / setSelectedModels` +
      纯函数 `buildSpacePoolCredentialView` / `isSpaceCredentialEntryUsable`。
  - `spaces/overlay.ts`:`SpaceOverlay.selectedModels?: Record<string,string[]>` +
    `normalizeSpaceSelectedModels` + `getSpaceOverlaySelectedModels`;
    `shared/ipc/spaces.ts` 的 `SpaceOverlayPayload` 同步。**没有新 IPC 通道** ——
    B2 的 `SPACES_{GET,SET}_OVERLAY` 原样够用。
  - `stores/spaces.ts`:`getOverlay` / `patchOverlay`(**先读后并**)/
    `adoptExternalSpaceId` / `onCurrentSpaceIdChanged`(`storage` 事件订阅,
    store 建立时装上)。
  - `ConnectionsSection.vue`:`isConnected` / `connectionSummary` 改问视图;
    非默认空间下凭证区整段换成 `SpaceCredentialPool`(ACP / 本地 agent 不走这一支)。
  - `SpaceCredentialPool.vue`(新,per-provider):B3/D/B6 那块面板的多条目列表、
    上下移、两段式删除、就地换密钥、策略选择器、OAuth 三种登录流 **原样搬过来**,
    只是作用域从「整张表 × 一个空间选择器」收成「一个 provider × 当前空间」。
  - `useProviderSettings.ts` / `useModelLedger.ts` / `ModelSelector.vue`:
    `selectedModels` 的读与写改经视图;`ModelSelector` 的可见 provider 多一道
    「本空间配了凭证没有」的闸(仅非默认空间)。
  - `SettingsPage.vue`:标题栏加「当前空间 + 可切换」标识,`onMounted` 拉一次空间列表。
  - `ConnectedDirectoriesPanel.vue`:overlay 写入改走 `patchOverlay`(见勘误 2)。
  - 删除:`SpaceCredentialsPanel.vue` 与它的测试;`provider/index.ts` 的导出换名。
  - 测试:`stores/__tests__/space-provider-view.test.ts`(9 条:三态 / 严格隔离 /
    selectedModels 落回与覆盖 / 先读后并 / 写失败回滚 / 切空间换整份 / 跨窗口跟随)、
    `provider/__tests__/SpaceCredentialPool.test.ts`(15 条,迁移自旧面板)、
    `provider/__tests__/ConnectionsSection.space.test.ts`(4 条)、
    `chat/__tests__/ModelSelector.space.test.ts`(2 条)、
    `spaces/__tests__/overlay.test.ts` +5、`ConnectedDirectoriesPanel.test.ts` +1。

  ##### 消费者逐条(改了哪些、哪些有意留全局)

  | 消费者 | 处理 |
  | --- | --- |
  | `ConnectionsSection.vue`(已配置判定 / 行摘要 / 凭证编辑区) | ✅ 改吃视图 |
  | `chat/ModelSelector.vue`(可见 provider + 模型清单) | ✅ 改吃视图 |
  | `provider/useProviderSettings.ts`(`availableModels` / `currentSelectedModels` / `isModelSelected` / `enabledProviders` / `toggleModelSelection` / `addCustomModel`) | ✅ 改吃视图 |
  | `provider/useModelLedger.ts`(`rows` / `warmModelCaches` / `removeModel` / `renameModel` 的 id 清单) | ✅ 改吃视图 |
  | `provider/ProviderModels.vue` | ✅ 间接(prop 由连接区喂,已是视图的值) |
  | `agents/AgentConfigForm.vue`(给 agent 挑模型) | ❌ **留全局**。agent 是跨空间资产(名册不分空间),它的模型覆盖也不该随空间变;且这个表单没有会话/空间语境 |
  | `settings/ToolsSettingsTab.vue`(工具调用模型)、`settings/MusicSettingsTab.vue` | ❌ **留全局**。它们写的是 `settings.tools.toolCallModel` 这类全局配置,列表跟着空间变会让「这一格能选什么」取决于打开设置时恰好在哪个空间 |
  | `SettingsPage.vue` 的自定义 provider 新建 | ❌ **留全局**。那是 provider **注册**(把 id 写进 `ai.providers`),不是「这个空间用哪些模型」 |
  | `stores/settings.ts`(默认值 / OpenRouter 加模型) | ❌ **留全局**。settings 的形状本身 |
  | `core/engine/title.ts`、`core-stream-engine.ts` 的 `selectedModels?.[0]` 兜底 | ❌ **留全局**(见勘误 5) |
  | `app/voice/providers.ts` 借 openai key | ❌ **留全局**,同 B3 出口 #7(语音在盲点 9 的范围闸外)——本片没有动它 |

  ##### 实施勘误与偏离(原样记录)

  1. **`selectedModels` 是覆盖层,不是追加层** —— 与 B2 给接入目录定的「全局 ∪
     overlay」相反。理由是两件事的直觉相反:多一个目录不碍事,多一个「这个空间不
     该出现的模型」就是隔离漏了。但**缺席 ≠ 空**:overlay 里根本没有这一格 = 这个
     空间没表达过 → 落回全局(刚建的空间不该是一个空的模型选择器);一旦表达过就
     以它为准,**包括表达成空的**。归一函数因此保留空数组,只丢非法形状。
  2. **`ConnectedDirectoriesPanel` 的 overlay 写入是本片修的一个真 bug 的前置。**
     B2 勘误 3 把 overlay 定成整层写,并说明「由调用方显式决定要不要先读后并」——
     只有一格时两者无差别,所以那个面板一直只递 `{connectedDirectories}`。
     overlay 长出第二格的那一刻,改一次接入目录就会把 `selectedModels` 抹掉。
     解法是把先读后并收进 `spacesStore.patchOverlay`,两个调用点共用一条 ——
     而不是在每个面板里各抄一遍 read-modify-write。
  3. **视图的 default 分支吃的是「调用方给的 settings」,不是 settings store。**
     设置页手里那份是 `localSettings`(未保存的草稿):用户刚敲进去的 key 必须立刻
     让状态点亮。视图自己去 `useSettingsStore()` 取会拿到已保存的那份,同一个界面
     上就出现两份真相。所以 `settings` 是 options 里的一个 getter:设置页给草稿,
     聊天侧给 store。
  4. **默认模型(`providers[*].model`)与逐模型调参仍在全局层。**
     > **⚠️ 这一条的前半句已于 2026-08-17 被用户推翻(见下方 B9 切片)。** 原话:
     > 「不同的空间,它的默认模型以及这个模型列表都是要不一样的。」默认 provider +
     > 默认模型自 B9 起是 per-space 的(overlay 的 `defaultSelection`)。后半句
     > (逐模型调参永远留全局)仍然成立,未变。
     > 同日用户还推翻了「provider 启用开关留全局」:「Provider 的开关也要是独立的。」
     §3 把
     「selectedModels/默认模型/contextWindow 覆盖」一起归给 overlay,本片只搬了
     `selectedModels`(那是用户这次说的那件事)。后果是:一个空间的当前模型可能
     不在它自己的 selectedModels 里。模型选择器**照常把它列出来**——「当前模型
     永远可见」是既有规则,藏起正在用的那个才是说谎。这一条有测试钉住。
     逐模型调参(maxOutput / contextLength / capabilities / temperature)有意
     永远留全局:它们描述的是「这个模型是什么样」,不是「这个空间想用哪些」。
  5. **引擎侧的 `selectedModels` 兜底没动**(`core/engine/title.ts` 的
     `resolveToolCallModel`:没配工具模型时拿 `providerConfig.model ||
     selectedModels[0]`)。它选的是「用哪个模型」,而**凭证解析在它下游已经是
     per-space 的**(B3 出口 #4),所以不会跨空间用错钥匙。改它要给 core 再开一个
     注入口(`selectedModels` 是从 settings 结构里读的,不是从适配器),
     不在本片范围。记在这里当路标。
  6. **`ProviderConfig.oauthToken` 那个骗人的字段继续被读。** B6 计划外发现已经
     证明它从来没人写(真存储是 `oauth-tokens.json`),于是 default 空间的
     「OAuth 配没配」实际只剩 `selectedModels.length > 0` 在起作用。视图把这段判据
     **一字不改**地搬了进来 —— 本片的底线是默认空间零回归,顺手"修正"一个判据
     会让所有升级用户的连接状态点在同一次更新里变样。治它是另一件事。
  7. **池编辑器单条时不画顺序号、不画策略选择器。** 池是**能力**,不是必须先理解的
     概念:非默认空间里第一次配 key 的人看见的应该是「名称 + Key + Base URL + 保存」,
     与默认空间无异;第二条 key 出现时顺序与策略才长出来。这也是把 B3 那块面板搬
     进连接卡片之后唯一的 UI 语义变化。
  8. **默认空间不显示任何池控件,也不显示"灰态说明"。** 任务书给了两个选项
     (不显示 / 灰态说明「默认空间使用全局配置」),选了不显示:默认空间是绝大多数
     用户的**唯一**空间,给他们看一个永远点不动的控件 + 一句解释另一个他们没建过的
     概念,是纯粹的噪音。「你在改哪个空间」这件事由标题栏那块标识回答 —— 那是一行
     字,不是一个控件。
  9. **设置窗跟随走 `storage` 事件,没有新 IPC。** 「当前空间」是 window 级状态
     (B1 决策:只落 localStorage、不进后端),而同 origin 的多窗口共享同一份
     localStorage、`storage` 事件只在**别的**窗口触发 —— 它天然就是这条通道。
     为一个纯窗口态开后端通道等于在后端造第二份真相。已有先例:`TodoPlanPanel.vue`
     用同一手法同步编辑模式。标题栏那个选择器写的也是同一份 `currentSpaceId`,
     所以在设置窗切空间,主窗会跟着切 —— 这是有意的:只有一个「当前空间」。
  10. **`useSpaceProviderView` 在组件外调用时不注册 `onMounted`**
      (`getCurrentInstance()` 守卫)。`useModelLedger` 有一条纯逻辑单测直接调用
      composable,注册的钩子不会触发,只会在控制台留一条噪音警告。
  11. **凭证写操作回传的摘要由 `applyCredentials` 收下,不再拉一次。** 每条写通道
      (set / set-pool / clear)本来就回整份写后摘要(B3/D 定的),收下它比重新
      `getCredentials` 便宜,也没有中间态。OAuth 那几条路仍走 `refresh()` ——
      它们的完成信号是「池里多了一条 entry」(B6 勘误 8),本来就要重读。
  12. **模型勾选是乐观更新 + 失败回滚。** 勾一个模型要等一次磁盘往返才打勾,手感
      是坏的;而写失败必须回滚,不能留下界面上勾着、盘上没有的模型。与
      `ConnectedDirectoriesPanel` 的 `commitOverlay` 同一条口径。
  13. **三处既有测试改了 mock,不是改判据**:`AIProviderTab.interaction.test.ts`
      与 `SettingsPage.test.ts` 各补一份「后端答不上话」的空间 store(整条空间支路
      不参演,壳子断言一字未动);`useModelLedger.test.ts` 补 `setActivePinia`
      (它现在经过两个 store,跑的仍是默认空间那一支)。

  ##### 计划外发现(B7)

  - **`Select` 的 `aria-label` 是 fall-through attr,不在 `props()` 里。** 旧的
    `SpaceCredentialsPanel.test.ts` 里那句 `.find(c => c.props()['aria-label'] === …)`
    从来没匹配上过,一直靠后面的 `?? [1]` 位置兜底在跑。迁移时改成
    `c.attributes('aria-label')`。按 props 找组件时值得留一眼。
  - **全局测试 setup 里那份 `localStorage` 桩没有 `clear()`。** 需要清空的 store
    测试得自己 `Object.defineProperty` 铺一份内存版(`projects-space.test.ts` 已经
    这么干过,本片两处照抄)。
  - `packages/renderer/styles/__tests__/ui-token-vars.test.ts` 的 2 条红仍在
    (来源是工作区里未跟踪的 `components/chat/todo-paper.css`,B6 已记过,与本片无关)。

  #### B8 切片(三项加固:凭证加密 / Retry-After / 变量 per-space)—— 已实施 2026-08-16

  **这一片不加功能,只清雷。** B4 勘误 4、批 D 勘误 3、B6 勘误 1 各记了一颗
  「知道但没做」的雷,三者互不相干、各自独立可验,所以合成一片一次清掉。
  **零数据迁移** —— 三处都用「老形态照读,下一次写入自然升级」的惰性口径。

  ##### B8-1 `credentials.json` 落盘加密(清 B6 勘误 1)

  **加密端口复用,没有新造。** 全仓唯一的加密器注入口是
  `configureAuthHost({ tokenCryptoAdapter })`(`app/auth/host-ports.ts`;Electron
  注入 `getElectronSafeStorage`,headless 宿主不注入)。`OnethingTokenStore` 拿它的
  方式是构造参数 `cryptoAdapter: () => getAuthHostPorts().tokenCryptoAdapter?.()`。
  凭证池住在**产品层**(`spaces/credentials.ts`,一组模块函数而不是类),它既不认识
  electron 也不认识装配层,所以中间加了一格同构的 late-bound 转接:

  - 产品层:`configureSpaceCredentialsCrypto(provider)` —— 存一个**每次现问**的
    取值函数(与 `getAuthHostPorts()` 同一条纪律,宿主晚 wire 也来得及)。
  - 装配层:`configureAppSpaceCredentialsCrypto()`(`app/providers/space-credentials.ts`),
    把 `getAuthHostPorts().tokenCryptoAdapter` 转接下去,由
    `configureAppRuntimeAdapters()` 调用(幂等,已进 `import-side-effect-free` 的
    「每个 adapter 恰好一次」断言表)。

  **口径从「整份明文」翻成「整份密文」,不是逐字段加密。** B6 当时选明文的理由是
  「一半明文一半密文会让『这个文件安不安全』变成逐字段问题」——这条理由本身是对的,
  只是选错了那一头。整份文件的定位就是秘密区(批 C 导出默认剔除它),所以整份加密
  才是那个一致的口径;顺带把 `label` / `policy` / entry id 也盖住,将来加字段不用
  重新审一遍「这个字段算不算秘密」。

  盘上三种形态,读侧全认(`parseSpaceCredentialsDocument`):

  ```jsonc
  { "providers": {…} }                                              // B3~B7 老明文,无信封
  { "version": 2, "encryption": "none",       "providers": {…} }    // 加密器缺席时的诚实明文
  { "version": 2, "encryption": "safeStorage", "data": "<base64>" } // 密文
  ```

  **惰性升级不是一段迁移代码,是写侧的自然结果**:`serializeSpaceCredentialsDocument`
  永远按**此刻的加密能力**产出,所以任何一次正常写入(换密钥、登录、调策略、写冷却)
  都把老明文文件顺手升级成密文。读到老明文照样读得出,没有一次性迁移动作。

  **加密器不可用时如实降级**:写明文并在文件里写 `encryption: "none"`。
  假装加密比不加密更坏 —— 它会让人以为这份文件可以随便复制。
  `spaceCredentialsEncryptionAtRest()` 是「此刻到底加没加密」的唯一读法,不靠猜。
  加密器自己抛异常(safeStorage 在 app ready 之前会)按「没有加密能力」处理,不炸。
  解不开的密文(换机器 / keychain 重置)按坏文件处理 → 空池 + 一条 warn,
  **绝不半个池**。

  渲染层未动:它本来就只拿得到 `previewSpaceCredentialApiKey` 的掩码,
  掩码算在解密后的内存结构上,加密只是落盘形态。

  ##### B8-2 `Retry-After` 透传(清批 D 勘误 3)

  批 D 把 `retryAfterAt` 留成占位字段、恒 undefined,冷却一律走
  `PROVIDER_ERROR_COOLDOWN_MS` 的默认常量。本片把五个家族的错误构造处接上响应头。

  **逐家真实形态(实测自各家文档 + 代码,不是推演)**:

  | 家族 | 出处 | 头 / 载体 | 形态 | 本片取法 |
  | --- | --- | --- | --- | --- |
  | claude / claude-code | `providers/claude.ts` `!response.ok` | `retry-after` + `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset` | 前者 delta-seconds,后者 **RFC 3339 时刻** | `retry-after` 优先,否则取四个 reset 里最早的 |
  | deepseek | `providers/deepseek.ts` | `retry-after` + `x-ratelimit-reset-*` | OpenAI 那套 | 同上 |
  | gemini | `providers/gemini.ts` | **没有头** —— `RetryInfo` 在响应体 `error.details[]` 里 | `{"@type":"…google.rpc.RetryInfo","retryDelay":"27s"}` | 必须把 body 一起喂给解析器,否则整族拿不到任何恢复时刻 |
  | openai-compatible | `providers/openai-compatible.ts` | `retry-after` + `x-ratelimit-reset-requests` / `-tokens` | **Go duration**(`6m0s` / `2m59.56s` / `340ms`) | 同上;`retryAfterAt` 挂**顶层**(不去动 `statusCode` 藏在 `data` 里的既有形状) |
  | codex | `providers/codex.ts` `createCodexAgentApiError` | `retry-after` / `x-ratelimit-reset-*` | 同 OpenAI | headers 本来就传进来了(取 request-id),顺手解析 |
  | (附带)OAuth token 端点 | `auth/auth-service.ts` | `retry-after` | 秒 | `classifyOAuthRefreshError` 本来就会消费,本片补上唯一的生产者 |

  实现落在 `agent-loop/provider-error-classification.ts`(不新开文件 = 不动 alias 表):
  `parseProviderRetryAfterValue` / `parseProviderRetryAfter` / `withProviderRetryAfter`
  / `providerErrorRetryAfterAt`。

  三条判断:

  1. **错误类的公共契约一字未改** —— `withProviderRetryAfter` 只 `Object.assign`
     一个**可选** `retryAfterAt`;取不到就原样返回,连一个 `undefined` 键都不留。
  2. **纯数字的歧义按量级分**:`> 1e12` 是 epoch 毫秒,`> 1e9` 是 epoch 秒,
     其余是 delta-seconds。三段边界之间差着几十年,不会误判。
     认不出的(`soon` / `-30` / `6m0x` / 坏日期)一律 undefined —— 解析层猜一个
     出来会直接变成冷却时长。落在过去的时刻同样丢弃(否则等于没有冷却)。
  3. **多个候选取最早的那个**(`retry-after` 在就直接用)。与批 D 勘误 6 的
     「猜短的代价可逆」同一句:挑晚的那个,万一限住的是早重置的桶,就白白闲置了
     一把好 key。

  消费侧:`classifyProviderError` / `classifyOAuthRefreshError` 外面统一贴一层
  `withRetryAfter`(而不是让每一条 `classified(...)` 记得带上 —— 那种写法漏一条
  就是永远拿不到)。`providerErrorCooldownUntil` 有值时冷却到该时刻,并**夹在
  `PROVIDER_RETRY_AFTER_MAX_MS = 1h`** 以内:响应头是 provider 单方面写的一串
  字符,一个 `Retry-After: 86400` 就够把用户的 key 冷一整天。夹取发生在消费点而
  不是解析层,好让日志/勘误仍看得见 provider 的原话。

  **有意没修**:`retry.ts` 的 `errorStatus` 只读顶层、读不到 openai-compatible 家族的
  `data.statusCode`(批 D 勘误 4 记过)。那是 retry 自己的账,本片没继承也没去还。

  ##### B8-3 项目级变量 per-space(清 B4 勘误 4)

  **决策:给 scope key 加空间前缀,不搬文件。**

  - default 空间 → `<projectId>`,**与本片之前逐字一致**。老用户的
    `project_variables` 一个键都不会变,零迁移。
  - 其余空间 → `<spaceId>:<projectId>`。空间 id 过 `/^[a-z0-9][a-z0-9_-]{0,63}$/`
    的门、项目 id 是 hex 哈希或随机 id,两者都不含 `:`,前缀不会与老键撞车。

  为什么不是「project 变量跟着 project 记录搬进 `workspaces/<id>/`」:那要给
  `VariablesStore` 开第二个持久化根、给 default 留一条特判读路径,而且 agent 级与
  全局级变量仍然得留在 `variables.json` —— 一个文件变三个,换来的隔离与前缀完全
  等价。前缀是同一份隔离里最小的那个改动。

  **agent 级与全局级变量有意保持全局(勘误)**:agent 定义本身(`agents/`)是全空间
  共享的,同一个 agent 在哪个空间都是同一个人格,它的变量跟着定义走才自洽;
  真要按空间分家,该分的是 agent 定义,不是变量。全局级同理 —— 它就是「跨一切」
  那一层的定义。

  **消费点清单(顺链路查全)**:项目变量的 key 只有一个生产者 ——
  `projectStoreGateway.resolveKey(sessionId)`(`app/variables/gateways.ts`)。
  `KeyedStoreProvider`(`variables/providers/keyed-store.ts`)的 `list/get/set/append/
  remove` 全部经它取 key,而变量注册表、prompt 注入(`formatStateVariablesForPrompt`)、
  IPC 变量面板(`main/ipc/variables.ts` → 注册表)、AI 的 `variable` 工具又全部经
  `KeyedStoreProvider`。**所以改 `resolveKey` 一处即全链路生效**,`getScopedVariables
  ('project', …)` 全仓只有这一个调用点(已核)。新增导出
  `scopedProjectVariableKey(spaceId, projectId)` 把这条规则显式化。

  ##### 新增/更新测试

  - `spaces/__tests__/credentials-encryption.test.ts`(10 条:密文往返不落明文 /
    oauth token 同样盖住 / 解不开 = 空池 / 老明文读得出 / 下一次写入自动升级 /
    加密器缺席写 `encryption:"none"` / `isEncryptionAvailable()` 为 false 等同缺席 /
    加密器抛异常不炸 / 掩码在加密态下仍正确)。
  - `agent-loop/__tests__/provider-retry-after.test.ts`(20 条:五家各一条真
    `Response` 喂进去的「带头 → retryAfterAt 正确」+ claude 的 RFC 3339 单头 +
    HTTP-date 两条 + 6 条畸形头 + 过去时刻丢弃 + 分类器优先消费 / data 兜底 /
    1h 上限 / 非轮换类不冷却)。
  - `app/variables/__tests__/workdir-gateway-space.test.ts` +4(同目录两空间互不
    可见 / default 老键零迁移读回 / 两空间读写互不串 / agent 与全局跨空间共享),
    原有「按空间取名册」那条按新 key 形态更新。
  - `app/__tests__/import-side-effect-free.test.ts`:adapter 表加
    `space-credentials-crypto`,并把 `providers/space-credentials.js` 加进
    「import 什么都不配置」那一串。

  ##### 计划外发现(B8)

  - `auth/space-token-store.ts` 的顶注整段在讲「明知的偏离:这里的 token 是明文」,
    已随本片改写。**记档的雷散在代码注释里而不只在设计文档里** —— 清雷时两处都要扫,
    否则代码里会留一句与事实相反的注释。
  - `getSpaceCredentialEntry(spaceId, providerId, entryId)` 的 `entryId` **必填**,
    缺席时返回 `undefined` 而不是「第一条」。名字读起来像个通用 getter,实际是
    「按 id 取」;写测试时踩了一次。
  - `packages/renderer/styles/__tests__/ui-token-vars.test.ts` 的 2 条红仍在
    (未跟踪的 `components/chat/todo-paper.css`,B6/B7 都记过,与本片无关)。

- **批 E：插件策略注册表**：脱敏上下文（entry id/label/用量统计/错误分类）进，
  entry id 出，插件不见密钥原文；失效 = degrade 回内置 failover。

  #### 批 E(插件凭证策略注册表)—— 已实施 2026-08-16

  用户 08-13 的原话:「能否把这个 auth 作为一个插件能够去改变的东西 …… 甚至去设置
  不同的使用策略,这个用完用另一个。」批 D 把内置三策略落在**唯一分叉点**
  `selectSpaceCredentialEntryDetailed` 上,批 E 只做一件事:让那个分叉点多认一种
  policy 取值 —— `plugin:<pluginId>:<name>`。

  范围:第四个对插件开放的既有注册表(`credential-strategy`)、脱敏上下文、
  按 `credentialId` 的用量聚合、面板策略选择器接注册表实时清单 + 灰态。
  **明确排除**:批 F 的订阅接入(`registerProviderAuthConnector` + 声明性 provider
  描述)、策略自持久化状态(用 `api.storage` 已有能力)、策略改写冷却(宿主决定
  冷却,策略只选)、默认空间(无池,不参与)。**零数据迁移**。

  ##### 注册表五处代码位(照 `PLUGIN_OPEN_REGISTRIES` 注释里的清单逐条对)

  | # | 清单里的话 | 本批的落点 |
  | --- | --- | --- |
  | 1 | 策略表加一条(拆除/在飞/宿主分叉/是否有真实流量) | `core/plugins/policy.ts`:`PLUGIN_OPEN_REGISTRIES` += `'credential-strategy'`,`PLUGIN_REGISTRY_POLICY` 加一行(**`degrade-to-default`** —— 见勘误 2) |
  | 2 | `CorePluginAPI` 加方法 + `CorePluginAPIHost` 加转发口 | `core/plugins/types.ts` `registerCredentialStrategy(registration)` + 泛型位;`core/plugins/api-builder.ts` `CorePluginAPIHost.registerCredentialStrategy?` |
  | 3 | api-builder 里实现(disposed 闩 + 退订进 disposeCallbacks + 失败进熔断账) | `core/plugins/api-builder.ts`,与 `registerDeepLinkAction` 逐条同构 |
  | 4 | app 层 host 对象加转发 | `app/plugins/api.ts` → `app/providers/credential-strategy.ts` 的 `registerPluginCredentialStrategy` |
  | 5 | 拆除快照测试加一行 + C17「转发口 ↔ 开放清单」守卫仍绿 | `app/plugins/__tests__/builtin-teardown.test.ts` 加 `credentialStrategyPolicies`;C17 由 `registerCredentialStrategy` → `credential-strategy` 自动对上 |

  另加(严重度表那一族,与"开注册表"是两件事):`pluginScope.credentialStrategy`
  工厂 + `PLUGIN_SCOPE_FAMILIES` 成员 + `PLUGIN_SEVERITY_TABLE` 行 +
  `classifyPluginScope` 归族 + `describePluginSurface` 折叠。

  ##### 落地清单

  - **契约**(新)`packages/core/plugins/credential-strategy.ts`:权限名
    `credentials:strategy` + 披露文案、名字/policy 形状、2s 超时预算、
    `PLUGIN_CREDENTIAL_ENTRY_FIELDS` 白名单、`toPluginCredentialEntryView`
    (**正向投影**)、`isPluginCredentialChoiceValid`、address/surface 两把同尺。
  - **产品层**`spaces/credentials.ts`:`PLUGIN_SPACE_CREDENTIAL_POLICY_PATTERN` +
    `isPluginSpaceCredentialPolicy`;`normalizeSpaceCredentialPolicy` **放行**合法
    的插件策略(见勘误 3);新宿主端口
    `configureSpaceCredentialPluginStrategyHost`;分叉点加插件分支(排在
    round-robin 之前,取不到裁决即 `available[0]` = priority-failover);
    `SpaceCredentialSelection` += `pluginPolicy: {policy, applied}`;
    `SelectSpaceCredentialEntryOptions` += `spaceId` / `providerId`(纯加法,
    内置三策略一个字不看)。
  - **装配层**(新)`app/providers/credential-strategy.ts`:注册表、脱敏 ctx 构造、
    超时、熔断、用量聚合(60s 缓存)、裁决槽、同步裁决口 `decide`,以及
    `configureAppPluginCredentialStrategyHost()`(进 `configureAppRuntimeAdapters`,
    幂等、import 无副作用)。
  - **轮换边界**`app/providers/credential-rotation.ts`:分类完 + 写完冷却之后
    **await** 一次策略(带 `attempt+1` 与 `lastFailure`),再走既有的重新解析;
    `notePluginCredentialFailure` 把失败分类记给下一次 ctx。
  - **账本**`usage/summary.ts` 新增 `computeOnethingCredentialUsage` /
    `getOnethingCredentialUsage` —— **`credentialId` 这个维度从批 B3 就在写,
    这是它的第一个读侧消费者**(见勘误 4)。
  - **IPC 零新通道**:`SpaceCredentialsSummary` 加 `strategies?`(注册表实时快照)
    与 per-provider `policyUnavailable?`,沿既有五条 spaces 通道原样流出。
  - **渲染层**`stores/spaceProviders.ts` 加 `strategies`;`SpaceCredentialPool.vue`
    的选择器改吃 `policyOptions`(内置三条 + 实时清单 + **补回**用户已选但已不在
    清单里的那一项,带「(不可用)」后缀),加一行灰态说明。

  ##### 实施勘误与偏离(原样记录)

  1. **裁决是「异步算、同步取」,不是同步调 handler。** 分叉点整条上游链是同步的
     (`selectSpaceCredentialEntryDetailed` → `resolveSpaceProviderCredential` →
     `applySessionSpaceCredentials` → `getEffectiveOnethingProviderConfig` → core 的
     `StreamEngineProviderAdapter.getEffectiveConfig`),而 handler 的契约是
     `string | Promise<string>`。把整条链改成异步要动 **core 引擎的适配器契约** ——
     与「接线点唯一」这条纪律直接相悖。所以异步的那一半住在装配层:
     `refreshCredentialStrategyDecision` 在**请求/重试边界**上 await handler、掐超时、
     记熔断、落一条裁决;`decide` 同步取用并排下一次刷新。
     **代价说清楚**:进程冷启动后的第一次选择走内置 failover(那一刻还没有裁决),
     池增删改排序会让裁决按指纹作废、同样先走一次 failover;而**错误路径(轮换)
     是 await 的、恒新鲜** —— 那正是「这个用完用另一个」的主场。
  2. **拆除标签是 `degrade-to-default`,不是前三个注册表的 `fail-open`。**
     im-connector / search-provider / deep-link-action 都标 fail-open,理由逐字相同:
     「没有宿主默认路径,标 degrade-to-default 是在描述一个不存在的回退」。
     这一条**反过来**:内置 `priority-failover` 就是那条默认路径,而且它本来就在跑。
     标签由测试反查行为(策略撤下后选择**仍然成功**、回落到 `available[0]`),
     不是一句字符串。
  3. **`normalizeSpaceCredentialPolicy` 的行为改了一处(批 D 的一个真 bug)。**
     批 D 时它把 `plugin:*` 压成 `'single'`,而 `setSpaceProviderCredentialPool`
     在整池写时会调它 —— 用户刚选的插件策略当场被抹掉,**插件策略根本存不进去**。
     现在形状合法就原样落盘;「此刻能不能用」在读侧现问。判的是**形状不是注册状态**
     也是有意的:插件停用时规范化掉它,等于替用户撤销他的选择,插件回来也不恢复。
     `credential-rotation.test.ts` 里那条断言 `plugin:x:y → single` 的老测试随之改写。
  4. **用量聚合是新写的最小面,不是复用既有 bucket 体系。** `usage/summary.ts` 的
     bucket 按时间分桶、按 provider/model/platform/source 分维,没有 credentialId 这一维,
     也不需要为了批 E 给它加一维(那会动所有既有消费者)。新函数只回答一个问题:
     「一个 provider × 一个空间 × 一个窗口,按 entry id 的总量」。窗口取 24h,
     结果按 `<spaceId>:<providerId>` 缓存 60s —— 它挂在起流边界上,不该每次读盘。
     **没有 `credentialId` 的行(默认空间与旧行)直接跳过**,不编一个 `legacy` 桶。
  5. **`ctx.usage` 落在 `entries[].usage` 上,而不是 ctx 顶层的一张表。**
     蓝图把它列成 ctx 的一格(「每 entry 的近期用量摘要」),两种写法信息量相同;
     放在 entry 上少一份 id → 用量的映射,也让白名单测试(「entry 的键集合 ⊆
     `PLUGIN_CREDENTIAL_ENTRY_FIELDS`」)一把尺量到底。窗口长度另立
     `ctx.usageWindowMs`。
  6. **`baseUrl` / `apiMode` 也不进脱敏视图**,尽管它们不是"密钥"。端点能泄露账号
     归属与套餐档位(zhipu 的 coding-plan 就是一个例子),而策略挑钥匙用不着它们。
     红线 1 的字面是「绝无 apiKey/token 原文」,这里比字面更紧一格。
  7. **投影是正向构造,不是删字段。** `toPluginCredentialEntryView` 只把白名单里的键
     装进新对象。反过来写(`delete next.apiKey`)每给 `SpaceCredentialEntry` 加一个
     字段就漏一次 —— 而那个 schema 从 B3 的 §3 表已经长到今天这样(多了 baseUrl /
     apiMode / oauthToken / cooldownUntil),那条路早晚会漏。
     `PluginCredentialEntrySource` 因此**刻意不写索引签名**:写了它,产品层那个没有
     索引签名的 `SpaceCredentialEntry` 反而传不进来(TS2345)。
  8. **「返回冷却中的 id」不需要单独一条判据。** 递给策略的候选集已经剔过冷却,
     所以指名一条冷却中的 entry 在实现上就是「指了一个不在集合里的 id」——
     一条判据(`isPluginCredentialChoiceValid`)覆盖两种错法。同理,让策略看见冷却中的
     条目等于给它开一个绕过冷却的口子,所以候选集**必须**先过滤。
  9. **降级之后连 handler 都不调。** 与搜索供给方同规:再让它每次吃满 2s 超时预算,
     只是在给每一次起流加卡顿。半开靠时间(`PLUGIN_SURFACE_PROBE_INTERVAL_MS`)。
  10. **`PLUGIN_DEFERRED_REGISTRIES` 无需回写。** 那五条(ai-provider /
      variable-provider / permission-capability / post-trigger / background-job)
      没有一条覆盖「凭证策略」—— 它是一个新开的注册表,不是某条延迟条目的兑现。
      按 append-only 规则,新开的进 `PLUGIN_OPEN_REGISTRIES`,延迟表原样不动
      (policy.test.ts 里「开放与推迟不能同时成立」那条守卫仍绿)。批 F 落地时才轮到
      回写 `ai-provider`(盲点 12 记的就是那一条)。
  11. **面板的灰态判据来自后端,渲染层不自己再判一遍。** `policyUnavailable` 由
      `getSpaceCredentialsSummary` 算(注册着 **且** 没被降级),投影出去。渲染层再判
      一次就会长出第二份判据,而"降级"这件事渲染层根本看不见。
  12. **策略缺席不记熔断。** 「插件没装/没启用」不是运行期失败;只有超时/抛错/
      返回非法值才记。否则用户卸载一个插件,会给那个已经不在的插件记一串失败。

  ##### 新增/更新测试

  - `core/plugins/__tests__/credential-strategy.test.ts`(16 条:命名空间与内置名
    物理分家 / policy 形状 / surface 两把同尺 / 罚则是 degrade-surface /
    **白名单正向投影** 3 条 / 返回值合法性 / 声明门与披露文案两个半句 /
    预算落在 300ms 与 15s 之间)。
  - `app/providers/__tests__/credential-strategy.test.ts`(13 条:命名空间注册 /
    未声明结构化拒绝且不计熔断 / 非法名 / **脱敏 ctx 序列化不含任何密钥与端点** /
    用量聚合按 provider 与空间过滤 / 非法 id 回落+记账 / 冷却 id 同归一路 /
    超时回落+记账 / 连败降级后不再调 handler 且不连坐同插件另一条策略 /
    策略缺席不记熔断 / 两侧拆除 + 裁决随策略作废 /
    **degrade-to-default 标签由行为反查** / 无生产流量如实声明)。
  - `app/providers/__tests__/credential-rotation.test.ts` +4(轮换边界 await 策略并
    带上 attempt 与 lastFailure、候选集已剔冷却 / 策略缺席回落 / 策略抛错回落+记账 /
    策略指冷却中的 entry 回落)。
  - `spaces/__tests__/credentials.test.ts` +8(形状判定 / 规范化放行 / **整池写能把
    插件策略落盘** / 宿主没装裁决口即回落 / 裁决生效且 ctx 原样 / 非法 id 回落 /
    冷却 id 回落且候选集已剔 / 全池耗尽先判且策略压根不被问 / 内置三策略不看裁决口)。
  - `usage/__tests__/summary.test.ts` +4(按 credentialId 分桶 / 无 credentialId 的行
    跳过而不是编桶 / 旧行缺 workspaceId 按 default 读 / 不给无价行编成本)。
  - `settings/provider/__tests__/SpaceCredentialPool.test.ts` +3(插件策略进选项 /
    选中后显示它自己的说明 / **插件不在时灰而不删**:提示文案 + 选项仍在 +
    带「不可用」后缀)。
  - `app/plugins/__tests__/policy.test.ts`:开放清单 + 两处工厂样本表。
  - `app/plugins/__tests__/builtin-teardown.test.ts`:快照加
    `credentialStrategyPolicies`。
  - `app/plugins/__tests__/local-plugins.test.ts`:窄化 API 的黑名单加
    `registerCredentialStrategy`(本地脚本没有 manifest,声明不了这条权限)。
  - `app/__tests__/import-side-effect-free.test.ts`:adapter 表加
    `credential-strategy-host`,并把 `providers/credential-strategy.js` 加进
    「import 什么都不配置」那一串。

  ##### 计划外发现(批 E)

  - **`setSpaceProviderCredentialPool` 会抹掉插件策略**(勘误 3)。这不是批 E 引入的,
    是批 D 留下的一个"位子留了、路却堵着"的洞:policy 字段的注释写着
    「`plugin:<id>:<name>` 是批 E 的位子」,而同一个文件里的规范化函数保证它永远
    存不进去。**留位子的时候要把写路一起验一遍**,否则位子是假的。
  - `usage` 账本的 `credentialId` 维度**从批 B3 起写了三批都没有任何读者**。
    批 E 是第一个。写侧先行本身没问题(账本 append-only,补维度要趁早),但
    「有维度」与「查得出来」是两件事,后者一行代码都没有过。
  - `packages/renderer/styles/__tests__/ui-token-vars.test.ts` 的 2 条红仍在
    (未跟踪的 `components/chat/todo-paper.css`,B6/B7/B8 都记过,与本片无关)。
  #### B9-0 跨窗口凭证/overlay 缓存过期(用户真机发现)—— 已修 2026-08-17

  **现象(用户真机,事实)**:在空间 2(`space-mswl0is4es9d`)的**设置窗**里给
  DeepSeek 配了 key、登录了 Kimi Code;**主窗**的 InputBox 模型选择器里两个 provider
  都不出现。盘上数据是对的(overlay 有 kimi-code 的 selectedModels,credentials.json
  存在且已加密,全局 settings 里 deepseek 的 enabled 缺省 = true、kimi 家族读法也过)。
  切走再切回空间、或者重启,就恢复。

  **根因**:跨窗口缓存过期,不是权限也不是加密。设置窗与主窗是两个独立
  BrowserWindow、两份 Pinia。写凭证/登录走 IPC 落盘没问题,但写完之后只有**发起写的
  那个窗口**把新摘要收进了自己的 `spaceProviders` store(`applyCredentials`);主窗
  那份早就 `loadedSpaceId === spaceId`,`ensureLoaded` 直接返回,缓存里既没有 deepseek
  的 entry 也没有 kimi-code 的登录态 → `isConfigured` 全 false → ModelSelector 第三道闸
  (`usableHere`)把它们藏了。`watch(spaceId)` 是唯一的刷新点,所以「切走再切回就好」
  正是缓存过期的指纹。overlay(`selectedModels`,以及 B9 新加的 `defaultSelection` /
  `providerEnabled`)在同一场景下**同样过期** —— 不修这条,B9 会在同一个坑里再摔一次。

  **广播链路**(沿用仓库现成模式,五段):

  | # | 层 | 做了什么 |
  | --- | --- | --- |
  | 1 | 产品层 | `spaces/notifications.ts`(新):`subscribeSpaceDataChanged(cb)` + `notifySpaceDataChanged({spaceId, kind})`,与 `ProjectsStore.subscribe` 同形。产品层禁 electron/shared 的 IPC 契约,所以它**只提供订阅点** |
  | 2 | 落盘入口 | `writeSpaceCredentials` 与 `writeSpaceOverlay` 各在**写盘之后**通知一次。这两个是仅有的落盘入口(OAuth 登录写 token 也经 `upsertSpaceProviderOAuthToken` 走到前者) |
  | 3 | Electron 主进程 | 新 channel `SPACES_CHANGED: 'spaces:changed'`;`@main/ipc/spaces.ts` 在 `registerSpacesHandlers()` 里订阅并 `broadcastToAllWindows` |
  | 4 | preload / platform | `onSpacesChanged(cb)`(照 `onSettingsChanged` 的写法)+ renderer types + `platform/web.ts` 的 noop |
  | 5 | renderer store | `spaceProviders` 在 store 内订阅:`spaceId` 对上且非 default 空间 → `refresh()`。放 store 不放组件 —— 「这个 store 是唯一刷新点」是 `watch(spaceId)` 已经立下的规矩,挂组件上会随卸载失效,而设置窗改东西时主窗的选择器未必挂着 |

  **两处决定**:

  - **不排除发送者**。settings 那条广播排除发送者,是因为它回灌的是整份 settings
    (会打断正在编辑的草稿);这里回灌的只是一句「去重拉」,重复刷一次无害。而且
    OAuth 登录这类由主进程自己触发的写**根本没有 sender**,排除它反而要在两种来源
    之间分岔。
  - **通知在写盘之后**。反过来的那一刻,收到通知的人会读到旧文件。

  **顺手修的一处静默**:ModelSelector 的三道闸(开关 / 有没有模型 / 这个空间配没配
  凭证)对用户完全不可见 —— 「开着却不出现」是最难自查的一种。设置页 provider 卡上
  (仅非 default 空间)在 `isProviderEnabledIn` 为真而 `isConfigured` 为假时补一行小字
  「本空间未配置凭证,不会出现在模型选择器」。不是新控件,是把已有的摘要文案
  (`本空间未配置` / `本空间未登录`)连到它的可见性后果上。

  #### B9 切片(默认 provider/model + provider 启用开关 per-space)—— 已实施 2026-08-17

  **这一片是纠偏,不是新功能。** 用户 08-17 两条裁决,各推翻 B7 的一条「有意留全局」:

  > 「不同的空间,它的默认模型以及这个模型列表都是要不一样的。」
  > 「Provider 的开关也要是独立的。」

  模型列表(`selectedModels`)B7 已 per-space;本片补**默认 provider + 默认模型**与
  **provider 启用开关**。两者语义与 selectedModels 一致:**缺席 = 回落全局**(刚建
  的空间开出来能直接用,不会突然全灭),**表达过即以空间为准**;default 空间继续
  读写 `settings.ai`,零迁移、不复制。

  ##### overlay 字段形状

  ```jsonc
  { "overlay": {
      "connectedDirectories": ["/a"],              // B2
      "selectedModels": { "deepseek": ["..."] },   // B7
      "defaultSelection": { "provider": "zhipu", "model": "glm-5" },  // B9
      "providerEnabled": { "zhipu": false }                            // B9
  } }
  ```

  - `defaultSelection` 是**一个对象**而不是两个平行字段(`defaultProvider` /
    `defaultModel`):一个 model id 只在它自己的 provider 下有意义,拆成两格的第一天
    就能出现「provider=deepseek / model=glm-5」这种谁也解释不清的组合。`model` 可以
    单独缺席(只钉 provider),那一格再落回该 provider 的全局默认模型。
  - `providerEnabled` 与 `selectedModels` 同风格,**逐 provider 缺席**:键不在 = 那一个
    没表达过 → 回落全局 `settings.ai.providers[pid].enabled`(缺省 true)。
  - 归一/判废照 overlay 现有写法:结构不认(不是对象/不是 record)整份判废,字段级
    脏值只丢那一格。`defaultSelection` 里 provider 是脏的 = 「半句话」→ 当缺席,
    **不判废整份**;`providerEnabled` 里非布尔的值一律丢弃(当成 true 就是替用户
    表达了一次他没表达过的东西)。
  - 写入一律走 `spacesStore.patchOverlay` 的先读后并(B7 勘误 2 修的那条整层写雷)。

  ##### 引擎接线点(只此一函数,两处构造)

  空间默认插在解析链的**会话之下、全局之上**:

  ```
  override(渲染层算好的 agent 绑定 / 会话置顶)> session.lastProvider > 空间默认 > 全局默认
  ```

  | # | 位置 | 做了什么 |
  | --- | --- | --- |
  | 1 | `providers/provider-config.ts` `getEffectiveProviderConfig` | 新增第 4 个可选参 `spaceDefault`,在 session 支与 global 支**之间**插一格。缺席 = 逐字等于今天 |
  | 2 | `providers/provider-runtime.ts` `getEffectiveOnethingProviderConfig` | 新增适配器 `resolveSpaceDefaultSelection(sessionId)`,把那一格递下去。**B3 的注入缝原地加第二格**,不新开缝 |
  | 3 | `app/providers/space-defaults.ts`(新) | `resolveSessionSpaceDefaultSelection` = `resolveSessionSpaceId` → default 空间恒 `undefined` → 否则读 overlay |
  | 4 | `app/engine/stream/provider-helpers.ts` | 挂适配器(解析链之一) |
  | 5 | `app/engine/stream-engine-runtime.ts` | 挂适配器(核心引擎的 `StreamEngineProviderAdapter`,解析链之二) |

  > **勘误(重要)**:任务书写的「只此一处」在**函数**这一级成立(两条链共用
  > `getEffectiveOnethingProviderConfig`),但在**适配器构造**这一级是**两处** ——
  > 与 B3 的 `applySpaceCredentials` 完全同形(§B3 出口清单 #1 与
  > `stream-engine-runtime.ts` 各挂一次)。少挂的那一条,就是会话悄悄用回全局默认
  > 的那一条。

  渲染层的镜像 `stores/helpers/provider-model.ts` 的 `resolveProviderModelSelection`
  同步加了 `spaceDefault` 这一格(**两边必须逐条同形**,否则又是一次「选择器显示
  deepseek、请求发往 codex」),并有一条测试直接拿同一组输入比对两边的结论。

  ##### 「改默认」入口清单(两种空间下的落点)

  | 入口 | default 空间 | 非 default 空间 |
  | --- | --- | --- |
  | `chat/ModelSelector.vue` `selectOption`(点一个模型) | `settingsStore.saveAIProviderDefault` | `spaceView.setDefaultSelection` → overlay |
  | `chat/ThinkToggle.vue` `setLegacyPairThinking`(思考档换成对模型) | 同上 | 同上 |
  | `settings/provider/useModelLedger.ts` `setDefault`(总账的 ★) | 一次 settings 写(provider + model) | overlay |
  | `settings/provider/useProviderSettings.ts` `setDefaultProvider` / `setDefaultModel` | **死导出**(返回了但没有任何 .vue 消费),本片未动 —— 见计划外发现 | 同左 |
  | `stores/settings.ts` `removeCustomProvider` 删掉当前默认后回落 OpenAI | 全局层的自洽,与空间无关,未动 | 未动 |

  「★ 打在哪一行」也跟着空间走(`useModelLedger.rows` 的 `isDefault` 改读
  `spaceView.defaultSelection`)。

  ##### provider 开关的读写点清单

  **读法只有一处**:`stores/helpers/provider-model.ts` 的 `isProviderEnabledIn`
  加了第三参 `spaceOverride`。家族(API + 订阅,如 Kimi)的派生**留在函数内部**,
  只是把「空间覆盖 → 全局」变成它每个成员的读取源 —— 在调用点手写覆盖会让
  「家族卡上打开、模型选择器里不出现」这种分家在每个调用点各长一次。

  | 读取点 | 处理 |
  | --- | --- |
  | `chat/ModelSelector.vue:303` | ✅ 改吃 `spaceView.isProviderEnabled` |
  | `settings/provider/useModelLedger.ts`(`rows` / `warmModelCaches`) | ✅ 同上 |
  | `settings/provider/useProviderSettings.ts`(`enabledProviders` / `isProviderEnabled`) | ✅ 同上 |
  | `settings/ToolsSettingsTab.vue`、`settings/MusicSettingsTab.vue`、`agents/AgentConfigForm.vue` | ✅ 传第三参(`spaceProviders.providerEnabled`)。这三处没有 `spaceView`,直接吃 store 那一格;default 空间恒 `undefined`,逐字不变 |

  | 写入点 | default 空间 | 非 default 空间 |
  | --- | --- | --- |
  | `useProviderSettings.setProvidersEnabled`(唯一写路;`toggleProviderEnabled` 与 ConnectionsSection 的开关都汇流到它) | 写 `settings.ai.providers[*].enabled` | `spaceView.setProvidersEnabled` → overlay(家族两个成员**一次写**,顺序写会互相覆盖) |

  ##### 诚实边界(两条,故意保留)

  1. **空间默认指向本空间未配置凭证的 provider**:照样选中它、照样在选择器里列出来,
     起流时由 B3 的隔离闸诚实拦截(「当前空间「X」未配置 Y 的凭证」)。静默改选别的
     才是说谎。
  2. **空间默认指向 `settings.ai.providers` 里根本不存在的 provider**(删掉了 / 从没
     配过):落到全局 —— 与 override、session 两支**同一条不变式**(B3/既有代码里的
     dangling-override 处理)。这与第 1 条是两回事:那一档 provider 配置在,只是
     entry 不在。

  ##### 不做(范围闸)

  - per-model 调参(contextWindow / maxOutput / capabilities / temperature 覆盖)
    仍全局:它们描述的是「这个模型是什么样」,不是「这个空间想用哪些」(B7 勘误 4
    的后半句未被推翻)。
  - agent 自带的 provider/model 覆盖语义不变:**agent 覆盖 > 空间默认 > 全局默认**。
    agent 绑定在渲染层折进 `override` 递给引擎,所以引擎侧只需保证 override 仍排第一
    (有测试钉住)。
  - `resolveOnethingProviderConfigForChat` 那条路**没接**空间默认 —— 见计划外发现。

  ##### 测试

  - `spaces/__tests__/overlay.test.ts` +9(两个新字段的归一、半句话当缺席、
    非对象整份判废、缺席 ≠ 表达成 false、三格互不牵动)
  - `spaces/__tests__/notifications.test.ts`(新,+5:两个落盘入口各叫一次、退订、
    一个监听器抛错不拖垮写入)
  - `providers/__tests__/space-default-selection.test.ts`(新,+10:三态回落、
    只钉 provider、override/session 压过空间、dangling provider、未配置凭证仍诚实
    选中、两条解析链各走一遍)
  - `app/providers/__tests__/space-defaults.test.ts`(新,+4:default 恒无、
    没表达过恒无、表达过递出去、两空间互不牵动)
  - `stores/helpers/__tests__/provider-model.test.ts` +11(空间默认这一格 + 与引擎
    逐条同形 + 家族读法在空间覆盖下的四种组合)
  - `stores/__tests__/space-provider-view.test.ts` +9(视图的 `spaceDefault` /
    `defaultSelection` / `setDefaultSelection` / 开关读写 / 家族一次写 /
    B9-0 跨窗口重拉的三种过滤)
  - `chat/__tests__/ModelSelector.space.test.ts` +5(两种空间下的当前选中、
    改默认的落点、空间里关掉的 provider 不列)
  - `settings/provider/__tests__/provider-defaults.space.test.ts`(新,+8:总账 ★
    与 provider 开关两个入口在两种空间下的落点)
  - 11 个既有组件测试补 `setActivePinia(createPinia())` —— 空间层住在 pinia 里,
    这些独立挂载的组件测试从此需要一个(与 ModelSelector 的测试早已如此同理)。

  ##### 计划外发现(B9)

  - **`getProviderConfigForChat` / `resolveOnethingProviderConfigForChat` 是一条
    没有任何消费者的死路**。全仓只有它自己的定义与两个测试引用它。它自带一套
    独立的「session > 全局」解析(与 `getEffectiveProviderConfig` 各读一次 settings),
    B3 当年为它单挂了一次 `applySpaceCredentials`。本片**没有**给它接空间默认 ——
    接一条没人走的路只会让「两条链」这个说法在下一次审计里再骗一个人。
    它要么该删,要么该并回主链,不在本片范围。
  - **`useProviderSettings` 的 `setDefaultProvider` / `setDefaultModel` /
    `defaultProviderModel` / `defaultProviderSelectedModels` 也是死导出** ——
    返回了,但没有任何 `.vue` 消费它们。真正的「设默认」入口是模型总账的 ★。
  - **`ProviderConfig.enabled` 后端零消费者**:全仓的读法只在渲染层
    (`isProviderEnabledIn` 一族)。所以「开关 per-space」是纯渲染层改动,不需要
    第二个引擎注入口 —— 但也意味着**开关只影响"看得见什么"**,不影响"能不能发"。
    一个在空间里被关掉的 provider,如果会话已经钉了它,照样能发 —— 这与今天的
    全局开关行为一致(不是本片引入的)。
  - `packages/renderer/stores/spaces.ts` 里一句注释写着 `ipcRenderer.invoke`,
    正好被 `architecture-boundaries.test.ts` 的「渲染层不得直接 IPC」正则命中
    (在途批次留下的红)。本片改了措辞 —— **注释也在正则的射程里**。
  - `packages/renderer/styles/__tests__/ui-token-vars.test.ts` 的 2 条红仍在
    (未跟踪的 `components/chat/todo-paper.css`,B6/B7/B8/E 都记过,与本片无关)。

  #### B10 切片(provider 专属旋钮 per-space + 设置页外观同构)—— 已实施 2026-08-18

  > **本节状态**:B10 收尾时的状态。用户随后拍板了 C1–C4 结构性重构
  > (`docs/design/workspace-provider-config-review-2026-08-18.md`:default 空间也变成
  > 普通空间、`settings.ai` 只留全局共享、`isDefaultSpace` 分支全部消失)。
  > **审计表里的「default 空间数据源 / 非 default 空间数据源」两列在 C1 起统一模型后
  > 将整体失效**;留在这里是为了让 C1 知道它要接管的是哪几格。C1 用统一的
  > `providerOptions{apiMode, region, baseUrl}` 承接本片新加的两个 entry 字段,
  > **不要再起第三个字段名**。

  两条用户裁决,一前一后:

  > 08-17:「不同的空间,provider 选择、开关、模型选择,都要独立。」
  > 08-18:「同一张设置页,切空间只换数据、不换外观。」

  第一条 B9 做掉了「选择/开关/模型列表」,漏了 **provider 专属旋钮**;第二条推翻的是
  B7 的落地形态 —— 数据源折进来了,外观没跟上。

  ##### 病灶(核实过,不是推测)

  `ConnectionsSection.vue` 在非默认空间下把整个凭证区换成 `SpaceCredentialPool`
  (`v-if="usesSpacePool"`),而 Zhipu 的 `apiMode`、Qwen 的 `region + apiMode`、
  Kimi 的 `region + apiMode` 这五个选择器**长在 default 那一支的 `v-else` 块里**。
  池条目 UI 只有 apiKey + baseUrl 两格,`SpaceCredentialEntry` 连 `region` 字段都没有。
  结果:**空间 2 里 Kimi/Qwen/Zhipu 的地区与套餐既设不了也看不见**,静默沿用全局。
  代价不是外观走样 —— Kimi 从「编程套餐」退回「开放平台按量」是**在订阅之外再扣一次钱**。

  ##### 落地清单

  **一、旋钮 per-space 四处贯通**

  | # | 位置 | 做了什么 |
  | --- | --- | --- |
  | 1 | `spaces/credentials.ts` | `SpaceCredentialEntry.region?`(与既有 `apiMode?` 同一格语义)+ 解析 + 归一;新增私有 `patchedEntryDials()`,`upsert` / `add` 两处共用 |
  | 2 | `spaces/provider-credentials.ts` | 新增 `PROVIDER_REGION_FIELD` 表 + `PROVIDER_ENDPOINT_OWNED_BY_ENTRY` 名单;entry → `qwenRegion` / `kimiRegion` |
  | 3 | `spaces/ipc-operations.ts` + `shared/ipc/spaces.ts` | 摘要加 `apiMode` / `region`(**不是密钥,原样投影**);`SpacesSetCredentialRequest` 加两格,`apiKey` 变可选 |
  | 4 | `app/providers/space-credentials.ts` | 摘要投影、`setSpaceProviderCredential` 透传、`importDefaultSpaceCredentials` 带上档位(新增 `pickProviderDials`) |

  baseUrl 派生**没有复制第二份**:覆盖仍发生在 `withResolvedProviderBaseUrl` 之前
  (`provider-runtime.ts:254`,B3 就定好的顺序),所以 entry 的档位既进 `baseUrl`
  也进 `providerOptions` 那个不透明包 —— 两条下游一次到位。

  **二、外观同构(08-18 裁决)**

  - **新增 `components/settings/provider/provider-dials.ts`** —— 五张选项表 + 归一函数
    + 「哪一行此刻有意义」收成**全仓唯一一张表**。归一一律复用 runtime 里那份
    (`providers/qwen.ts` / `kimi.ts`),渲染层不自己写第二份判据。
  - **新增 `components/settings/provider/ProviderCredentialRows.vue`** —— API Key 行 +
    Base URL 行 + 旋钮行 + env 徽章。**default 与空间池两边共用这一份模板**,
    样式一并搬进来(父级 scoped CSS 只命中子组件的**根元素**,留在
    `ConnectionsSection` 里会让空间那一支画出一堆裸行)。
  - `SpaceCredentialPool.vue` 拆成两态:**单条态**(`entries.length ≤ 1` 且未披露)
    渲染 `ProviderCredentialRows`(OAuth 型渲染 default 那张 `AuthCard`),
    **多条态**才是原来那套(顺序/策略/冷却/灰态/插件策略)。中间靠一条
    `.text-action` 小字过渡(「＋ 再添加一把 key」/「＋ 再登录一个账号」)——
    池是**能力**,不是必须先理解的概念。
  - 单条态里**不出现**「本空间」「凭证池」这类只在这一支存在的措辞(有测试钉住)。

  ##### 设置页控件级审计表(B10 收尾时状态)

  「同构」= 非 default 空间下画的是不是同一组行/同一组 aria-label。

  | 控件 | default 数据源 | 非 default 数据源 | 外观同构 | 结论 |
  | --- | --- | --- | --- | --- |
  | 卡片列表来源(`connCards`) | 后端 provider 名录 + `settings.ai.customProviders` | 同左 | ✅ | **有意留全局**:provider **定义**是「这个软件认识哪些服务」,不是「这个空间用哪些」 |
  | 卡片启用开关 | `settings.ai.providers[*].enabled` | overlay `providerEnabled` | ✅ | B9 已 per-space |
  | 家族频道页签(API/订阅) | 纯呈现 | 同左 | ✅ | 无数据源 |
  | API Key | `settings.ai.providers[*].apiKey` | 凭证池 entry | ✅ **本片对齐** | B3 已 per-space,B10 对齐外观 |
  | Base URL | `settings.ai.providers[*].baseUrl` | entry `baseUrl` | ✅ **本片对齐** | 同上 |
  | Zhipu `apiMode` | `zhipuApiMode` | entry `apiMode` | ✅ **本片新增** | **本片从「静默沿用全局」改成空间层** |
  | Qwen `apiMode` / `region` | `qwenApiMode` / `qwenRegion` | entry `apiMode` / `region` | ✅ **本片新增** | 同上 |
  | Kimi `apiMode` / `region` | `kimiApiMode` / `kimiRegion` | entry `apiMode` / `region` | ✅ **本片新增** | 同上 |
  | env key 徽章(`Env XXX`) | 机器环境变量 | **不显示** | ✅(该格不存在) | **有意留全局且不下放**:env 是机器级的,非 default 空间不吃它(勘误 1) |
  | OAuth 登录卡 | 全局 `oauth-tokens.json` | 空间 entry 的 token(B6) | ✅ **本片对齐**(复用 `AuthCard`) | B6 已 per-space |
  | 多凭证顺序 / 轮换策略 / 冷却 | 不存在(settings 没有池) | 凭证池 | ➖ 渐进披露 | 空间独有能力,单条态收起 |
  | 模型勾选(`selectedModels`) | `settings.ai.providers[*].selectedModels` | overlay `selectedModels` | ✅ | B7 已 per-space |
  | 总账 ★ 默认模型 | `settings.ai.provider` + `providers[*].model` | overlay `defaultSelection` | ✅ | B9 已 per-space |
  | ProviderModels 的「设为当前模型」(`setActiveModel`) | `providers[*].model` | **仍写全局** | ✅ | ⚠️ **未完成,移交 C1** —— 见下 |
  | per-model 调参(maxOutput / contextLength / capabilities / temperature / 重命名) | `settings.ai.providers[*]` 各 map | 同左(全局) | ✅ | **有意留全局**(B9 范围闸):它们描述「这个模型是什么样」,不是「这个空间想用哪些」 |
  | 自定义模型新增 | `settings` + 勾选走空间 | 定义全局、勾选按空间 | ✅ | 与上一行同一条理由 |
  | 自定义 provider 增删改 | `settings.ai.customProviders` | 同左(全局) | ✅ | **有意留全局**(B7);⚠️ 卡上那句「provider 定义为全局共享,凭证与开关按空间」**本片未加**,移交 C1 |
  | 模型目录缓存 / 刷新 | 全局 `settings`(~500KB) | 同左 | ✅ | **有意留全局**(§3 归属拆分表) |
  | ACP agent 配置 | `settings.ai.acpAgents` | 同左(全局) | ✅ | ⚠️ 未标「全局设置」,移交 C1 |
  | 用量卡(`ProviderUsageCard`) | 全局订阅账号 | **不渲染** | ➖ | 它查的是全局那把凭证的用量,在空间里显示就是说谎;**静默消失**这一点未治,移交 C1 |
  | 本地 CLI agent 提示行 | 无数据源 | 同左 | ✅ | 天然全局 |

  ##### 实施勘误(原样记录)

  1. **env 兜底在非 default 空间算不算「回落」——算,所以挡掉。** 判据不是「它属于
     哪个空间」,而是「它是机器级的」:一台机器上导出的 `KIMI_API_KEY` 漏进任何一个
     空间,严格隔离就说了不算。B3 的 `resolveOnethingProviderApiKey` 已经挡了,本片
     只是把 UI 对齐 —— **非 default 空间根本不画那个徽章**,而不是画一个骗人的。
  2. **旋钮定在 entry 级,不是 provider 级。** 任务书让判,判据是:国内版与海外版是
     **两个互不相通的账号**,一把 `moonshot.cn` 的 key 拿到 `moonshot.ai` 去就是 401;
     coding-plan 的 key 与 standard 的 key 也不是同一把。所以它属于**这一条凭证**。
     池里两把 key 指向两个地区不但说得通,而且正是 failover 的用法(有测试钉住)。
  3. **「缺席」的语义从「跟全局」改成「这家 provider 的缺省」——这是行为变更。**
     只抹档位不抹 `baseUrl` 等于没抹:`resolveOnethingZhipuBaseUrl` 在 `zhipuApiMode`
     缺席时直接返回 settings 里那条 coding 地址,全局档位顺着地址原路漏回来。所以
     **有档位的三家(zhipu/qwen/kimi)两格一起清**(`PROVIDER_ENDPOINT_OWNED_BY_ENTRY`)。
     代价:**B10 之前建的空间 entry 没有档位字段,升级后会退回该 provider 的缺省
     (standard / cn),而不是继续跟着全局**。这是刻意的 —— 那条「跟着全局」正是用户
     报的 bug;而且它现在在界面上看得见、一次点击可改。没有档位的 provider 不在名单里,
     全局自建代理仍然管用。
  4. **`SpacesSetCredentialRequest.apiKey` 变成可选,而不是新开一条 IPC 通道。**
     改一条 entry 的地区不该要求重新粘一次密钥(渲染层根本拿不到原文,B3 决策 8)。
     语义分两支:**没有 `entryId`(追加)时 key 仍然必填**(否则池里会多出一行永远
     用不了的东西),**有 `entryId` 时 key 缺席 = 不动密钥**。为此新开一条
     `spaces:update-credential-entry` 要动 8 个文件(channels / shared / ipc-operations /
     controller / handler / preload / platform×2),而语义上它就是同一个 upsert。
  5. **三个非密钥字段(baseUrl / apiMode / region)一律 patch 语义**:缺席 = 沿用旧值,
     空串 = 清空。旧写法是「缺席即清空」——「换密钥」的表单里没有这三格,于是换一次
     key 会顺手把端点和档位抹掉,**而用户在界面上看不出发生了什么**。这是发现的一个
     既有 bug(baseUrl 那格),顺手治了。
  6. **`importDefaultSpaceCredentials` 原来不带档位。** 从默认空间导入的 Kimi 会从
     「编程套餐」悄悄退回「开放平台按量」—— 那是在订阅之外再扣一次钱,不是外观走样。
  7. **样式必须随模板搬家。** `.settings-row` / `.env-detected-badge` 那几条留在
     `ConnectionsSection` 的 scoped 块里,子组件内部一条都命中不了(scoped 只穿透到
     子组件**根元素**)。这是「子组件根元素会被父级 scoped CSS 命中」那条老坑的反面。
  8. **`AuthCard` 的 aria-label 在 `Select` 上是 prop 不是 attr。** `Select.vue` 声明了
     `ariaLabel` prop,所以 `wrapper.attributes('aria-label')` 恒为 `undefined` ——
     既有测试靠 `?? [0]` 的兜底才一直是绿的。新测试改用 `props('ariaLabel')`。

  ##### 未完成,移交 C1(明确交接)

  1. **`setActiveModel`(ProviderModels 的「设为当前模型」)在非 default 空间仍写
     `settings.ai.providers[*].model`** —— 一个空间里的动作改了全局那一格。它是 B9
     「改默认」入口清单漏掉的一行。原打算并进本片(路由到
     `spaceView.setDefaultSelection`),因 C1 接管三态解析而停手:C1 会把
     「provider 的默认模型」并进统一模型,现在改一次等于改两遍。
  2. **三处「全局设置」标注未加**:自定义 provider 卡上那句「provider 定义为全局共享,
     凭证与开关按空间」、ACP 配置块、per-model 调参区。审计表已逐行钉住归属,
     UI 标注留给 C1 一次做完(C1 之后「default 也是普通空间」,措辞本身要重写)。
  3. **用量卡在非 default 空间静默消失**(它查的是全局凭证的用量,显示就是说谎)。
     该给一句「本空间使用独立凭证,用量请在对应账号处查看」,未加。

  ##### 测试

  - `spaces/__tests__/provider-dials.test.ts`(新,+12):region 进 schema / 空串不落盘 /
    两条 entry 各有地区 / 换密钥不抹三格 / 只改档位不带 key / 空串是清空 /
    zhipu coding-plan 与 kimi intl 两条端点派生(含 `providerOptions` 包)/
    缺席 ≠ 跟全局 / 无档位 provider 的全局代理仍在 / default 恒等返回 / 导入带档位
  - `spaces/__tests__/ipc-operations.test.ts` +2(带 entryId 不带 key 放行;追加那一支仍拦)
  - `app/providers/__tests__/space-credentials.test.ts` +2(摘要投影两格;导入带档位)
  - `settings/provider/__tests__/SpaceCredentialPool.test.ts` +4 / 改 6
    (单条态同构、旋钮行跟 provider 走、改档位是 patch、没条目时先攒着、
    OAuth 单账号复用 AuthCard、多账号态才展开列表)
  - `settings/provider/__tests__/ConnectionsSection.space.test.ts` 改 1
    (从「两个输入框不再出现」改成「同一组行、同一组 aria-label」—— 前者正是被推翻的)
  - `stores/__tests__/spaces.test.ts` +1(**设置窗首帧就是主窗当前空间**:
    `currentSpaceId` 初值同步取自 localStorage,不 await 任何东西)

  ##### 计划外发现(B10)

  - **设置窗的空间时序本来就是对的**:`useSpacesStore` 的
    `currentSpaceId = ref(readStoredSpaceId())` 是**同步**初始化,不存在「先按 default
    画一帧再跳」。本片只补了一条测试钉住它,没有改代码。
  - **`upsertSpaceProviderApiKey` 的「缺席即清空」是个既有 bug**(勘误 5):UI 上
    「换密钥」只送 key,于是每换一次 key 就把 baseUrl 清一次。B3 起就在,没人报过 ——
    因为空间池的 baseUrl 本来就少有人填。
  - **`PROVIDER_API_MODE_FIELD` 里的 `'kimi-code'` 那一行是死的**:kimi-code 是 OAuth 型,
    走 `oauth-entry` 分支,那一支根本不读 apiMode。留着不碍事,但它不是「支持了」。
  - `packages/renderer/styles/__tests__/ui-token-vars.test.ts` 的 2 条红仍在
    (未跟踪的 `components/chat/todo-paper.css`,B6/B7/B8/E/B9 都记过,与本片无关)。

- **批 F：插件订阅接入**：`registerProviderAuthConnector`（login/refresh/revoke
  代码钩子）+ 声明性 provider 描述（baseUrl / wireFormat 枚举 / headerTemplate /
  models[]）；wire 格式流式实现继续关（等 H 线硬隔离）。manifest 权限
  `auth:provider` + 安装页披露；id 命名空间 `plugin:<id>:<name>`。

## 5. 盲点清单（实施对照）

1. **五件套 getter 无参，但 per-space 后必须按「会话归属的 space」取**，不是「当前
   space」——A 空间会话在跑时切到 B，其工具执行仍取 A 的可写根。接入目录读出口
   （`app/stores/connected-directories.ts`）与 provider 凭证解析同理，都要加
   sessionId 上下文。整个功能 2 最容易做错的一处。
2. **provider 解析链是两套统一的**（"选 deepseek 走 codex"历史），改一侧必须同步另一侧。
3. **settings overlay 别走 `mergeWithDefaults`**——有吞白名单外字段前科；overlay
   独立 merge，换层触发一次 `invalidateSettingsCache`。
4. **`currentWorkspaceId` 别做成全局单值**——放 window 级，为「两窗口开两 space」留路。
5. **OAuth 跟凭证走 per-space**：同 provider 两个 space 各自登录；token 刷新单飞锁
   （并发 refresh 会互相作废 refresh token）；写回落到发起会话所属 space。
   MCP OAuth、外部 agent 登录态一期留全局。
   —— **已于批 B6（2026-08-15）实施**；单飞锁落在 `OnethingAuthService.refreshToken`，
   key = `providerId × 写回目标`。MCP OAuth 与外部 agent 登录态仍留全局。
6. **「用完」判定要先有统一错误分类**（手写 provider 各家 429/quota 长相不同）；
   轮换只发生在请求/重试边界，**流中不能换 key**。
7. **严格隔离创造的「provider 未配置」一等状态**，正好被批 F 复用为插件 provider
   拆走后旧会话的降级态。
8. **teardown 数据侧**：卸载插件要归档其 provider 凭证（照 message-state
   archive-on-uninstall 模式），CI teardown 测试加这一族。
9. **范围闸**：scheduler、goal、gateway 路由、todo 一期留全局。
10. usage `source` 字段有历史包袱（还接受 `'memory'`），加维度别动旧行解析。
11. jsonl 流式写入中补 meta 字段走现有 300ms 节流通道，别整写竞态。
12. 治理：批 F 落地时按 append-only 规则回写 `PLUGIN_DEFERRED_REGISTRIES.ai-provider`
    条目（2026-08-13 重审：拆出 auth-connector + 声明性描述两层开放，wire 实现继续关）。

## 6. 与两套既有目录概念的关系

- **connectedDirectories（接入目录，settings.tools）**：保持五件套语义，批 B 起变
  per-space（overlay）。
- **project-dirs（项目名册）**：批 A 升多根，批 B 起归属 space。
- session 已有 `workingDirectoryRoots?: string[]` 多根字段且已流进写沙箱——project
  多根与 space 接入目录共同决定新会话的 roots。

## 7. 现状附录（调研结论摘要）

- 路径层全部惰性（`getOnethingStorePath()` 每次现算、store 拿 getter 函数），换根
  不痛在路径，痛在内存态与锁——这是选作用域模型的依据之一。
- server `owners/<uid>/<wid>` + `*ByOwner` Map 已有 workspace 维度，但只对非默认
  owner 生效；桌面走 default-owner 旁路吃进程单例。一期不碰，语义（多租户）与本文
  space（单人多语境）不同，将来对齐时再议。
- renderer `stores/workspace.ts` 是分栏树（per-form 一棵，v4 序列化），与 space
  正交；批 B 给它加 space 维度成 per-space × per-form。
- settings.json 单文件无分层，`ai` 段占 96%（~500KB models 缓存）——分层时把缓存
  留在全局的动机即来于此。
