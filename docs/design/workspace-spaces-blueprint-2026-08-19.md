# 多空间（Space）现状蓝图 —— 什么存在哪、什么是状态

日期：2026-08-19。**这是现状，不是目标。** 取自本机真实 store（`~/.onething`）与工作区代码
（B1–B10、C1–C2 已落地但未提交）。目标与分期见 `workspace-spaces-2026-08.md`、
`workspace-provider-config-review-2026-08-18.md`。标注 ⚠ 的是已知缺口。

---

## 0. 一句话模型

单进程、单 store 根。**空间不是换根，是打在数据上的归属 + 一组按空间分家的文件。**
切换空间 = 改一个 window 级指针（`currentSpaceId`）→ 各读取面按它换源；活跃流不受影响。

```
                    ┌────────────────────────────────────────────┐
                    │  renderer window（主窗 / 设置窗 各一份）     │
                    │  currentSpaceId ← localStorage              │
                    │     'onething:current-space'（window 级）   │
                    └───────────────┬────────────────────────────┘
                                    │ 每次读写都带 spaceId / sessionId
                                    ▼
┌──────────────────────────── ~/.onething（唯一 store 根）───────────────────────────┐
│                                                                                    │
│  全局共享（与空间无关）                 按空间分家（workspaces/<id>/）               │
│  ───────────────────────               ───────────────────────────────            │
│  settings.json                          workspaces/index.json   ← 空间名册         │
│    .ai = {temperature, modelCatalog}    workspaces/<id>/                            │
│    其余（主题/工具/语音/…）               ├─ providers.json   ← 该空间整套 AI 配置    │
│  plugins/           插件（共享）           ├─ credentials.json ← 凭证池（加密信封）   │
│  app-state.json     分栏树 v5（内含每空间）├─ space.json       ← overlay（接入目录）  │
│  variables.json     变量（project 键带空间）└─ project-dirs/    ← 项目名册（非 default，按需建）│
│  usage/*.jsonl      账本（行带 workspaceId+credentialId）                          │
│  oauth-tokens.json  ⚠ 已迁入池后为 {}                                              │
│  backups/           迁移前 settings.json 快照                                       │
│                                                                                    │
│  混合（在原地、靠字段归属）                                                          │
│  sessions/<sid>/meta.json  ← workspaceId 字段（缺席=default）                       │
│  project-dirs/             ← default 空间的项目名册（原地，零迁移）                  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 空间本体

| 项 | 落点 | 形状 | 备注 |
| --- | --- | --- | --- |
| 空间名册 | `workspaces/index.json` | `{spaces:[{id,name,color?,icon?,createdAt}]}` | id 正则 `^[a-z0-9][a-z0-9_-]{0,63}$`（路径片段） |
| default 空间 | id 固定 `'default'` | 名「默认空间」 | 缺失自动补建 |
| 当前空间 | **不在后端**。renderer localStorage `onething:current-space` | string | window 级；多窗口同 origin 共享，其他窗口靠 `storage` 事件跟随 |
| 删空间 | 只许无会话且非 default | 连坐删 `workspaces/<id>/` 整目录 + 内存实例 |  |

```
workspaces/
├── index.json
├── default/                    ← 与其他空间同形（C2 起）
│   ├── providers.json          {ai:{provider, providers{pid:{enabled,selectedModels,model,baseUrl,档位,逐模型覆盖…}}, customProviders}}
│   ├── credentials.json        {version:2, encryption:'safeStorage'|'none', data|providers}
│   └── space.json              {overlay:{connectedDirectories?}}
└── space-mswl0is4es9d/         ← 「空间 2」
    ├── providers.json
    ├── credentials.json
    ├── space.json
    └── project-dirs/           ← 首次登记项目时才创建（本机尚无）
        ├── index.json
        └── data/<id>.json
```

---

## 2. Session 怎么存

**位置不变**：`sessions/<sid>/meta.json + messages.jsonl`（jsonl 目录式；旧 `sessions/<sid>.json` 惰性迁移）。
**归属靠字段**：`meta.workspaceId`，创建时由 core 写入；**缺席 = default**（本机 408 个会话中 7 个带字段：default 4、空间 2 3）。

```
sessions/
└── <sid>/
    ├── meta.json      { id, name, kind, agentId, workingDirectory, workingDirectoryRoots?,
    │                    lastProvider, lastModel, workspaceId?, createdAt, updatedAt, … }
    └── messages.jsonl
```

读取面怎么用它：

```
                 sessions index（全量加载）
                        │
                        ▼
      Sidebar.filteredSessions ── 按 currentSpaceId 过滤（缺席=default）
                        │
        ┌───────────────┼──────────────────┐
        ▼               ▼                  ▼
  项目分组(§3)     置顶/草稿/未归类     搜索窗 ⚠ 未过滤（有意留全局）
```

引擎侧：会话 → `resolveSessionSpaceId(sessionId)` → 该空间的 providers.json + credentials.json + overlay。
**永远按「会话归属的空间」取，不按「当前空间」**——A 空间的流在跑时切到 B，它仍用 A 的一切。

⚠ 批 C「sessions/ 物理迁入 workspaces/<id>/sessions/」未做；整空间导出未做。

---

## 3. Project 怎么存

**per-space 物理名册**：default 留在 `<store>/project-dirs/`（零迁移），其他空间在 `workspaces/<id>/project-dirs/`。
同一目录可在两个空间各自成项目（各有描述、多根）。

```
project-dirs/  (default)            workspaces/<id>/project-dirs/  (其他空间)
├── index.json                      ├── index.json
│   {projects:[{id,path,paths[],lastUsedAt}]}
└── data/<id>.json                  └── data/<id>.json
    {id, path, paths[], description, addedAt, lastUsedAt}
```

- `paths[0]` = 主根 = 会话 cwd 锚点；其余根只扩 `workingDirectoryRoots`（写沙箱/搜索/@）。
- 项目 id 与路径解耦（重排主根不换 id）。
- 自动登记：会话 workdir 变更 → `touch` 落进**会话归属空间**的名册。
- 项目级变量：`variables.json.project_variables[<spaceId>:<projectId>]`（default 老键无前缀）。

Session ↔ Project 结构（**弱关联，按目录推导，不存外键**）：

```
  Session.workingDirectory ──(canonical 匹配任一 root)──▶ Project{paths[]}
        │                                                      ▲
        │ 会话不记 projectId；分组/prompt/免审批都是每次现算   │
        └── workingDirectoryRoots ◀──(多根项目自动派生，只覆盖会话不拥有的 roots)
```

⚠ 侧栏项目组的**折叠集合**是 SessionList 组件内存（见 §6）。

---

## 4. Provider 怎么存（C2 起）

```
settings.json.ai = { temperature, modelCatalog }          ← 全局：只剩目录缓存
workspaces/<id>/providers.json = { ai: {                  ← 每空间一整套，无回落
    provider,                       默认 provider
    providers: { <pid>: {
        model, enabled, selectedModels,
        baseUrl, zhipuApiMode/qwenApiMode/qwenRegion/kimiApiMode/kimiRegion,
        逐模型 contextWindow/maxTokens 覆盖, 思考档位, …
        (无 apiKey/oauthToken —— 剥离线 SPACE_PROVIDER_STRIPPED_FIELDS)
    }},
    customProviders: [ …定义… ]
}}
workspaces/<id>/credentials.json = 池 { providers: { <pid>: {
    entries: [{ id, label, authType:'apiKey'|'oauth', apiKey|oauthToken,
                baseUrl?, apiMode?, region?,      ← entry 级旋钮（B10 裁决）
                source:'user'|'plugin:<id>', cooldownUntil? }],
    policy: 'single'|'priority-failover'|'round-robin'|'plugin:<id>:<name>'
}}}
```

生效配置的合成（唯一缝）：

```
 providers.json(空间) ──┐
 credentials.json(空间) ─┼─▶ getEffectiveOnethingProviderConfig(sessionId)
 env key(机器级，全空间可见)┘        │  两条解析链共用；适配器构造两处(provider-helpers / stream-engine-runtime)
                                    ▼
                          EffectiveAISettings（运行期形状 = 落盘 + 盖上 key/token/catalog）
                                    ▼
                    ModelSelector 三闸：enabled ∧ configured ∧ selectedModels（全空间同一套）
```

跨窗口：任何 per-space 文件写盘 → `notifySpaceDataChanged{spaceId,kind}` → 主进程 `spaces:changed`
广播 → 各窗口 store 重拉。（settings.json 仍走 `settings:changed`。）

⚠ `ProviderConfig` 类型仍兼落盘/生效两职（C4 拆）；⚠ 新建空间向导缺「源空间选择器」。

---

## 5. 其他 per-space 数据

| 项 | 落点 | 语义 |
| --- | --- | --- |
| 接入目录 | `space.json.overlay.connectedDirectories` | **全局 ∪ 空间**追加集（权限边界，有意宽松） |
| 分栏树 | `app-state.json.workspace`（v5：`spaces[sid][form]`） | 每空间×每形态一棵；切换换树零 I/O |
| 用量归因 | `usage/*.jsonl` 每行 `workspaceId` + `credentialId` | 只加写入，聚合待做 |
| 项目变量 | `variables.json.project_variables[<sid>:<pid>]` | agent/全局变量仍全局 |
| 变量以外的 goal/scheduler/todo/gateway | 全局 | 一期范围闸 |

---

## 6. 状态层：切换空间时「什么该变」——现状盘点 ⚠

这是本蓝图最需要诚实的一节。**持久数据**（§1–5）已按空间分家；**瞬时 UI 状态**只处理了两项，其余没盘。

```
切换 currentSpaceId 时……              现状          应然（Arc 语义：切回来一切如故）
────────────────────────────────    ──────────    ─────────────────────────────
会话列表过滤                          ✔ 跟随        跟随
项目名册（左栏项目组）                 ✔ 重载        跟随
分栏树（哪些会话开在哪个 pane）         ✔ 换树        按空间记忆 ✔
激活会话                              ✔ 校正        按空间记忆（当前实现：选该空间最近一条）
Provider 配置/模型选择器/设置页        ✔ 换源        跟随
项目组折叠集合（SessionList 内存 Set） ⚠ 不重播      按空间记忆（方案 b，另一会话在修）
列表滚动位置                          ⚠ 未处理      按空间记忆
正在重命名的行 / 右键菜单              ⚠ 未处理      切换时取消
分页 limit（"显示更多"）               ⚠ 未处理      按空间记忆或重置（拍板）
工作台页签（RightWorkbenchPanel）      ⚠ 跨会话全局   是否按空间？（拍板）
搜索窗 / todo 窗 / 最近流              有意全局      维持（一期闸）
Composer 未发送草稿                    ⚠ 未盘        跟随会话（会话已按空间）→ 应自然正确，需验
form-mode（chat/collab 形态）          有意全局      维持
```

**为什么会漏**：切片按「哪些数据 per-space」推进，验收靠单测（一份 Pinia、一次挂载），
瞬时状态从未成为清单项，也从未有真机走查门。**补法**：真机逐项走一遍上表，拍板每行，
一批修，验收加 playwright 走查脚本（切空间前后断言状态）。

---

## 7. 文件 → 代码位置索引

| 关注点 | 代码 |
| --- | --- |
| 空间名册/CRUD | `packages/onething-runtime/src/spaces/{types,persistence,store,ipc-operations}.ts` |
| overlay | `spaces/overlay.ts`；广播 `spaces/notifications.ts` |
| 凭证池/加密/轮换 | `spaces/credentials.ts`、`spaces/provider-credentials.ts`、`app/providers/{space-credentials,credential-rotation,credential-strategy}.ts` |
| providers.json | `spaces/provider-settings.ts`、`app/providers/{ai-settings-compose,space-ai-settings}.ts`、`shared/defaults/ai-settings.ts` |
| 迁移 | `app/providers/space-config-migration.ts`（挂 `app/backend.ts` initializeSettings 后） |
| 会话归属 | core `session/store-helpers.ts`（workspaceId）、`app/stores/sessions.ts`（`resolveSessionSpaceId`） |
| 项目名册 | `project-dirs/{persistence,store,prompt}.ts`（spaceId 参数）、`app/variables/gateways.ts`（touch/roots/变量键） |
| 引擎注入缝 | `providers/provider-runtime.ts` `getEffectiveOnethingProviderConfig` |
| renderer 状态 | `stores/spaces.ts`（currentSpaceId）、`stores/spaceProviders.ts`、`stores/projects.ts`、`stores/workspace*.ts`（分栏树 v5）、`composables/useSpaceProviderView.ts` |
| 侧栏 | `components/sidebar/{Sidebar.vue,SessionList.vue,useSessionOrganizer.ts}` |
| IPC | `shared/ipc/spaces.ts`、`apps/electron/src/{ipc,main/ipc}/spaces*.ts`、`preload/bridge.ts` |
