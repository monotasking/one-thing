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
| 共享边界 | 插件（安装与启用）、主题、模型目录缓存（settings.ai 里 ~500KB 的 models.dev 缓存）全局共享 |
| API key | **per-space 严格隔离，不回落全局**；新建 space 时二选一：导入（从全局或指定 space 复制快照，copy 不引用）或空白开始 |
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
  7. **未做（有意）**：音乐/电台组（`musicGroup`）与 rail 的最近流/房间列表不参与
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
     忽略。默认空间的凭证层就是 `settings.ai`;往它的 credentials.json 里再写
     一份就是造第二份真相。读它也一律返回空(解析在第一步就短路)。
  8. **渲染层永远拿不到密钥原文**。IPC 回的是摘要(`hasApiKey` + `sk-abc••••6789`
     预览);保存永远是整条覆盖写。这与连接区(它直接持有 `settings.ai` 的原文)
     不一致 —— 是有意的:新面能少传就少传,老面不为此改造。
  9. **设置页走了「独立小面板」这条路**,没有嵌进 `ConnectionsSection`。理由:
     连接区(1100 行)编辑的就是**默认空间**的凭证层,在它内部再插一个空间维度
     等于让同一组输入框在两种落盘通道之间切换(settings 的 `update:settings`
     vs spaces IPC),保存失败时没法说清哪一层没写进去。新面板
     `SpaceCredentialsPanel.vue` 挂在同一个 tab 末尾,后端答不上话时整段不画。
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
    并解决盲点 5 的刷新单飞锁。
- **批 E：插件策略注册表**：脱敏上下文（entry id/label/用量统计/错误分类）进，
  entry id 出，插件不见密钥原文；失效 = degrade 回内置 failover。
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
