# 接入目录 × Obsidian/笔记 功能盘点(2026-09-08)

只读盘点,不含改动。目的:把散在 spaces / tools / search / markdown / plugins 五个域里的
「用户目录」相关能力摆到一张桌上,看清谁读哪一层、哪些是重复实现、哪些有定义没入口。

## 0. 一句话结论

- **接入目录**:后端三层语义(全局 ∪ 会话归属 space 追加集)已实现并被 8 个子系统消费,
  但**主干没有任何界面能添加/删除它**——全局层只能手改 `settings.json`,space 层只能走
  `spaces.setOverlay` RPC,而这个 RPC 在 apps/ 与 packages/client 里零调用。
- **Obsidian / 笔记**:七个设置字段(`dailyNotes.*` 五个 + 两个附件目录)同样**有读者、无写者、
  无 UI**;Obsidian vault 探测在三个域里各写了一份;「笔记根」有三条互不相同的解析链。
- 两者交汇处:markdown 附件把接入目录当笔记根,note-skills 技能根却有意不含接入目录,
  daily notes 只认单一目录——同一个目录在三个域里身份不同。

## 1. 接入目录(connectedDirectories)

### 1.1 数据模型与落盘

| 层 | 类型 | 落盘 | 归一 |
| --- | --- | --- | --- |
| 全局 | `ToolSettings.connectedDirectories?: string[]`(`packages/shared/ipc/tools.ts:209`,注释明说它是**权限面**) | `settings.json → tools.connectedDirectories`,默认 `[]`(`shared/defaults/settings.ts:264`) | `normalizeConnectedDirectories`(`settings.ts:703`):只收绝对路径,按**原字符串**去重 |
| space | `SpaceOverlay.connectedDirectories?`(`runtime/src/spaces/overlay.ts:38`);IPC 形状 `SpaceOverlayPayload`(`shared/ipc/spaces.ts:73`) | `workspaces/<id>/space.json → { overlay: { connectedDirectories } }`;C2 之后 overlay **只剩这一格**(provider 三格已并入 `providers.json`,类型保留只为迁移读) | `normalizeSpaceDirectories`(`overlay.ts:115`):只收绝对路径,按**去尾斜杠**的 canonical key 去重 |

合并:`mergeConnectedDirectories(global, overlay)`(`overlay.ts:199`)= 全局在前 + overlay 追加 + 去重。
取哪个 space 由**会话归属**决定(`stores/sessions.ts:464 resolveSessionSpaceId`),拿不到 sessionId
一律退纯全局层——后端不持有 currentSpaceId,猜错就是权限面出事(`stores/connected-directories.ts:24-31`)。

### 1.2 读写面

`packages/backend/stores/connected-directories.ts` 导出五个符号:

| 导出 | 语义 | 非测试消费者 |
| --- | --- | --- |
| `getConnectedDirectories()` | 纯全局层 | `wiring/tools/core/sandbox.ts:49`、`wiring/markdown/asset-service.ts:61`、`wiring/search/authorization.ts:29`(降级分支) |
| `getConnectedDirectoriesForSession(sessionId)` | 全局 ∪ 会话归属 space | `wiring/search/adapters.ts:32`、`wiring/search/authorization.ts:29`、`wiring/toolkit/catalog.ts:108,118,127`、`rpc/domains/files.ts:213` |
| `listConnectedSkillRoots()` | 全局层投影成 `custom:` 技能根 | `wiring/skills/loader.ts:65` |
| `getConnectedDirectoriesForSpace(spaceId)` | 全局 ∪ 指定 space | **无**(只被同文件的 ForSession 内部调用) |
| `resolveSessionSpaceId`(再导出) | 会话→space | **无**——7 处真实调用全部直连 `stores/sessions.js` |

RPC:
- **spaces 域**是 overlay 的唯一读写面:`getOverlay` / `setOverlay`(`rpc/domains/spaces.ts:91-104`),只对已登记的空间开放;`setOverlay` 直通 `writeSpaceOverlay`(整写,不先读后并——今天 overlay 只有一格所以无害,文档里提过的 `patchOverlay` 在代码里不存在)。
- **files 域**(读):`files.list` 传 `getConnectedDirs: () => getConnectedDirectoriesForSession(request.sessionId)`,只在非夹紧宿主注入(`files.ts:212-213`)。
- **settings 域**:无专门方法,全局层只能靠整份 `saveSettings`。
- **tools 域**:零命中。

### 1.3 消费点与它读的层

| 消费点 | 读哪一层 | 带 sessionId |
| --- | --- | --- |
| 写沙箱 `toolkit/families/file.ts:143,166`、bash 沙箱根 `process.ts:131`、toolkit 三份适配器 `wiring/toolkit/catalog.ts:108,118,127` | **会话归属 space** | 是 |
| @ 文件引用 `rpc/domains/files.ts:213` → `files/file-search.ts`(source=`connected`)← 壳 `data/file-mentions-source.ts:188` | **会话归属 space**(壳没有会话就不带) | 是(可缺) |
| 搜索授权全集 `wiring/search/authorization.ts:20-31 fileRoots()` | `ctx.principal.sessionId ?? getCurrentSessionId()`,拿不到退全局 | 是(带回落) |
| 搜索扫盘表 `capabilities/files.ts:68-92 getSearchDirs()` ← `wiring/search/adapters.ts:32` | **后端 app-state 的当前会话**所属 space(第三种口径) | 间接 |
| 进程级沙箱适配器 `wiring/tools/core/sandbox.ts:49` → `sandbox-runtime.ts:124 getOnethingDefaultReadRoots` | **全局层**(注释明说是无 sessionId 调用面的诚实降级) | 否 |
| markdown 附件笔记根 `wiring/markdown/asset-service.ts:56-63` | **全局层**;夹紧宿主下 `getNoteRoots: () => []` | 否 |
| 技能根 `wiring/skills/loader.ts:65` | **全局层**(技能加载是进程级缓存,掺 overlay 更糟,`stores/connected-directories.ts:88-92`) | 否 |
| `wiring/search/index.ts:206-217` | 09-07 事故后:`access.fileRoots` 只喂授权、不喂扫盘;`getSearchDirectories` 端口已删 | — |

### 1.4 UI 现状

**无。** `apps/desktop-react/src` 里只有两条注释提到它(`workspace/store.ts:54`、`WorkspaceOverview.tsx:31`「getOverlay 那是随后端批一起接的事」)。
`docs/design/workspace-spaces-2026-08.md:1033` 讨论的 `ConnectedDirectoriesPanel.vue` 随 Vue 壳一起没了,不在 HEAD。
`gate-workspace.mjs:13` 的说明文字点名了接入目录,但十条断言里没有它那一条。

### 1.5 测试

`backend/stores/__tests__/connected-directories.test.ts`(核心口径)、`rpc/__tests__/files-domain.test.ts:294`、`rpc/__tests__/spaces-domain.test.ts`、`wiring/markdown/__tests__/asset-service.test.ts`、`wiring/providers/__tests__/space-config-migration.test.ts:264`(迁移不动它)、`runtime/spaces/__tests__/{overlay,ipc-operations,notifications}.test.ts`、`runtime/tools/__tests__/{sandbox,sandbox-runtime}.test.ts`、`runtime/files/__tests__/file-search.test.ts`、`runtime/search/__tests__/files-scan-boundaries.test.ts:91`(禁止把 fileRoots 接回扫盘)、`runtime/skills/__tests__/loader.test.ts`、`shared/defaults/__tests__/settings.test.ts`。

### 1.6 问题清单(读到什么写什么)

| # | 问题 | 位置 |
| --- | --- | --- |
| A1 | 没有入口:全局层无设置 UI,space 层 `setOverlay` 零调用方 | 见 1.4 |
| A2 | 两层归一口径不同:全局按原字符串去重,overlay 按去尾斜杠去重;`overlay.ts:112-114` 注释声称「同一条门槛」只对「只收绝对路径」成立。走纯全局层的三个消费点会同时留下 `/a` 与 `/a/` | `settings.ts:703` vs `overlay.ts:115` |
| A3 | 消费点口径三分:会话归属 space / 全局 / 后端当前会话。搜索扫盘用 `getCurrentSessionId()`,而 React 壳从不告诉后端当前会话是谁(`capabilities/files.ts:42-44`) | `wiring/search/adapters.ts:32` |
| A4 | 读比写窄:写沙箱按 per-session 层,无 sessionId 的读路径按全局层。只登记在 space overlay 的目录,写得进却可能在 `checkFileAccess` / `findReadSandboxRootForPath` 上被判外部 | `file.ts:143` vs `sandbox-runtime.ts:124` |
| A5 | 两个导出无非测试消费者:`getConnectedDirectoriesForSpace`、`resolveSessionSpaceId` 再导出 | `stores/connected-directories.ts:56,59` |
| A6 | 同名端口四种签名:store 的 `getConnectedDirectories()`、搜索端口 `getConnectedDirectories?(): string[]`(无参)、toolkit 端口 `getConnectedDirectories?(sessionId?)`、沙箱运行时端口返回 `Array<string \| undefined>` | `search/providers.ts:142`、`toolkit/families/file.ts:36`、`sandbox-runtime.ts:33` |
| A7 | 注释里的路径大面积过期(`files/file-search.ts` / `app/skills/loader.ts` / `app/tools/builtin/read.ts` 等全 MISSING);「五件套」实为 8 处以上 | `stores/connected-directories.ts:12-17`、`wiring/tools/core/sandbox.ts:47` |
| A8 | `gate-workspace.mjs` 无接入目录断言 | `apps/desktop-react/scripts/gate-workspace.mjs` |

## 2. Obsidian / 笔记

### 2.1 设置项(全部「有读者、无写者、无 UI」)

`GeneralSettings.dailyNotes: DailyNoteSettings`(`shared/ipc/settings.ts:88-94`,默认 `defaults/settings.ts:209-215`):

| 字段 | 默认 | 唯一读者 |
| --- | --- | --- |
| `enabled` | `true` | `capabilities/daily-notes.ts:151`(false → 空 profile 表) |
| `directoryMode: 'personal' \| 'custom'` | `'personal'` | `daily-notes.ts:164`(personal → `getUserNoteDir()`) |
| `customDirectory` | `''` | `daily-notes.ts:165` |
| `useObsidianConfig` | `true` | `daily-notes.ts:170`(读 `.obsidian/daily-notes.json`) |
| `format` | `'YYYY-MM-DD'` | `daily-notes.ts:183,197`,**只对 `source:'folder'` 的 profile 生效**;obsidian profile 用 vault 自己的 format |

`EditorSettings`(`settings.ts:96-105`,默认 `''`):
- `markdownNoteAttachmentDirectory` — 读者 `runtime/markdown/asset-service.ts:314,353`、`wiring/plugins/builtin/note-skills.ts:26,36`、`wiring/markdown/asset-service.ts:42`
- `markdownProjectAttachmentDirectory` — 读者 `runtime/markdown/asset-service.ts:326,356`、`wiring/markdown/asset-service.ts:46`

误报:`BaseTheme` 的 `"obsidian"` 是主题名(`settings.ts:46`),且字段已 DEPRECATED。
运行时侧另有手抄镜像 `OnethingDailyNoteSettings`(`runtime/src/search/providers.ts:89-101`),`directoryMode` 放宽成 `| string`,两边不共享类型。

### 2.2 note-skills 内置插件

- 实现 `runtime/src/plugins/note-skills.ts`;manifest 无 commands、无 config schema。
- **只做一件事**:`api.registerSkillRoot(...)`(`:107-125`),把 `user_note_dir + work_note_dir` 两个变量目录(`wiring/plugins/builtin/note-skills.ts:32-35`,**不含接入目录**)注册为递归技能根;变量变更 → 失效技能缓存。
- prompt 片段 `<note_skill_context>`(`:154-195`):向上找 `.obsidian` → 读 `app.json` 的 `attachmentFolderPath`;非 vault 才用设置里的 `markdownNoteAttachmentDirectory`。注入点 `runtime/src/skills/loader.ts:606`。
- 装配:桌面走 `wiring/plugins/loader.ts:287-291`,**默认启用**;server 侧只登记目录、entry 是 noop(`backend/server/runtime.ts:762-766`)。
- 接入目录有意不走这条链(`stores/connected-directories.ts:80-84`:技能 id 嵌绝对路径 sha1、且会强塞 `<note_skill_context>`),改走 `listCustomSkillRoots`。

### 2.3 daily notes 搜索能力

- manifest(`capabilities/daily.ts:81-104`):`id:'daily'`、`kind:'indexed'`、`order:3`、`retrievers:{vector:{when:'relaxed'}}`、`preview:{mode:'lazy'}`;i18n 标签 `search.capability.daily` = "Notes"。
- 目录解析唯一产地 `getDailyNoteProfiles`(`daily-notes.ts:149-204`):配置目录 = `custom ? customDirectory : getUserNoteDir()`(**单一目录**,不含 work_note_dir、不含接入目录);`useObsidianConfig !== false` 时先 `readObsidianDailyProfile`(`:117-143`,读 `daily-notes.json` 的 folder/format/template),再补一条 `source:'folder'` profile。对外 `resolveDailyNoteSearchDirs`(`:237`)。
- "today" 快捷:`todayMatchesQuery`(`:206-210`)+ `buildDailyTodayShortcut`(`:265-289`);今天没建 → `SearchPage.actions` 上一条 `create-daily` 动作;建文件 `createDailyNote`(`:244-262`,有模板读模板,`flag:'wx'`)。
- 索引侧 `DailyNotesFeed`(`index/daily-feed.ts`):`.md/.markdown/.txt`、**不递归**、`policy.build='lazy'`;Worker 按 `notesDirs` 一目录一 feed(`worker.ts:61-63`);装配时读一次(`wiring/search/index.ts:279-289`,async 就是为了读 Obsidian 的 daily-notes.json)。
- 授权:目标路径与 `create-daily:` 动作都夹在 `resolveDailyNoteSearchDirs` 内(`wiring/search/authorization.ts:49-53,81-83`)。
- 真机对账(`docs/design/search-index-2026-09.md:849-851`):这台机器 `useObsidianConfig: true` 但 `resolveDailyNoteSearchDirs()` 答 `[]`,daily 两侧 0 条——与「无 UI 只能手改 settings.json」直接相关。

### 2.4 markdown 附件服务

runtime 半边 `runtime/src/markdown/asset-service.ts`:
- `markdownContext`(`:191-232`)三态,**Obsidian 优先**:向上找 `.obsidian` → `'obsidian'`;否则匹配 `getNoteRoots()` → `'note'`;否则 `'project'`。
- 附件根(`:305-329`):obsidian 用 `attachmentFolderPath`(空 → 文档所在目录);note 必须配 `markdownNoteAttachmentDirectory` 否则 `MISSING_NOTE_ATTACHMENT_DIR`;project 用 `markdownProjectAttachmentDirectory`。
- resolve 顺序(`:331-361`):`file:`/绝对路径直取 → [文档目录, root, 附件目录] 逐个 stat → 全落空且是 obsidian 且 target 无分隔符 → **全 vault basename 索引**兜底(`:363-428`,跳过 `.git/.obsidian/node_modules`,20 万条上限、TTL 30s)。
- wikilink:入口剥 `![[...]]`(`:236`);出口 obsidian 且 `useMarkdownLinks !== true` 时产 `![[vault 相对路径]]`(`:539-551`)。
- 逃逸守卫 `obsidianAttachmentRootStaysInside`(`:159-178`):`.obsidian/app.json` 是磁盘配置不是请求输入,单列一条;boundary 检查要求 app 层调用路径保留这三个守卫符号(`scripts/headless-boundary-check.ts:2891-2899`),并禁止主进程层重新发明 `ObsidianConfig` 等(`:1810-1827`)。

wiring 半边 `wiring/markdown/asset-service.ts`:`getNoteRoots` = `user_note_dir + work_note_dir + getConnectedDirectories()`(`:56-63`,**含接入目录、全局层**);夹紧宿主下笔记根清空、附件目录夹进沙箱;`prepareMarkdownRequest` 四处入口夹紧含 vault 配置(`:173`)。

消费者:仅 `rpc/domains/markdown.ts` 一个域(→ `runtime/markdown/ipc-operations.ts`)+ server `runtime.ts:214,216`。**没有 agent 工具消费它**。

### 2.5 UI 现状

**无。** `apps/desktop-react/src` 里 `dailyNotes` / `obsidian` / `markdownNoteAttachment` 零命中;仅两条 i18n 键(`search.capability.daily`、`search.action.createDailyNote`)。
提示词 `content/*.md` 与 `resources/skills/*` 零命中。

### 2.6 测试

`runtime/plugins/__tests__/note-skills.test.ts`、`wiring/plugins/builtin/__tests__/note-skills.test.ts`、`runtime/markdown/__tests__/asset-service.test.ts`、`wiring/markdown/__tests__/asset-service.test.ts`、`rpc/__tests__/markdown-sandbox.test.ts`、`runtime/search/__tests__/capabilities.test.ts:368,462`、`runtime/search/index/__tests__/daily-feed.test.ts`、`wiring/search/__tests__/index-service.test.ts:67-82`、`rpc/__tests__/search-domain.test.ts:89`、`backend/server/__tests__/http.test.ts:403-504,627`、`wiring/skills/__tests__/loader.test.ts:134`。

### 2.7 问题清单

| # | 问题 | 位置 |
| --- | --- | --- |
| B1 | **动作 id 两套前缀并存**:`daily-notes.ts:287` 写 `create-daily-note:` 到 `actionId`;`daily.ts:164` 的 `CREATE_DAILY_ACTION` 是 `create-daily:`,`invoke` 与 `authorization.ts:81` 只认后者;server 老路 `runtime.ts:1887` 与 `http.test.ts:627` 只认前者;`shared/ipc/search.ts:234` 注释也写的是老前缀 | 四处 |
| B2 | **`findObsidianVaultRoot` 三份实现**:`plugins/note-skills.ts:127`(同步)、`markdown/asset-service.ts:126`(异步,先把文件退成目录)、`search/capabilities/daily-notes.ts:107`(异步、私有)。读 `app.json` 两份(`readObsidianAppConfig` / `readObsidianConfig`),类型两个(`OnethingObsidianAppConfig` / `ObsidianConfig`) | 三个域 |
| B3 | 「配置附件目录 → 绝对路径」两份(`note-skills.ts:147` / `asset-service.ts:298`);家目录展开三份(`expandNoteSkillHome` / `expandHome` / `text-match.ts expandPath`) | 同上 |
| B4 | **「笔记根」三条解析链**:note-skills = `user+work`;markdown = `user+work+接入目录(全局层)`;daily = `custom ∥ user` 单目录。同一接入目录下的 md:附件按 note 语义、技能按 custom 语义、日记不认 | `builtin/note-skills.ts:32`、`wiring/markdown/asset-service.ts:56`、`daily-notes.ts:164` |
| B5 | `getDailyNoteProfiles` 两个循环去重判据不一致:`:179` 精确相等,`:193` 裸 `startsWith` 无分隔符边界(`/a/notes2` 被 `/a/notes` 吃掉) | `daily-notes.ts:176-196` |
| B6 | 壳正本 `search-panel-2026-09.md:214`(84 号)要求 `todayMatchesQuery` 收紧到 `q.length >= 2 && 整词前缀`,实际仍是 `word.includes(q) \|\| q.includes(word)`(单字母 `t` 就触发);`:205`(75 号)要求删后端英文句子,`daily.ts:231` / `daily-notes.ts:276,282` 仍在写 `Daily note` / `Today: …` / `Create in …` | 未落地 |
| B7 | 七个设置字段全部无写者无 UI(2.1) | — |
| B8 | `OnethingDailyNoteSettings` 是手抄镜像,改一边不报错 | `runtime/search/providers.ts:89-101` |
| B9 | `DailyNotesFeed` 不递归,Obsidian 按年/月分子目录的 daily folder 整段索引不到 | `index/daily-feed.ts` |
| B10 | `wiring/search/index.ts:80` 再导出的 `createDailyNote`(绑进程单槽)与 `@onething/runtime/search/capabilities` 同名导出(收 adapters)并存,名字无区分 | 两处 |

## 3. 两者交汇:用户目录来源总表

同一个「用户的目录」今天从五个来源进来,六个域各取一个子集:

| 来源 | 落盘 | 写入口 |
| --- | --- | --- |
| 会话 cwd / `workingDirectoryRoots` | session | 有(新建会话) |
| project-dirs 名册(per-space) | `project-dirs/` | 有 |
| `user_note_dir` / `work_note_dir` 变量 | `variables.json` | 有(变量面板) |
| 接入目录 全局层 | `settings.json tools.connectedDirectories` | **无** |
| 接入目录 space 层 | `space.json overlay` | **无**(RPC 有,调用方无) |
| `dailyNotes.customDirectory` | `settings.json` | **无** |
| 两个 markdown 附件目录 | `settings.json` | **无** |

| 域 | 取用 |
| --- | --- |
| 写/读沙箱 | cwd roots + 接入目录(写按 session 层、无会话读按全局层) |
| @ 文件引用 | cwd + 接入目录(session 层) |
| 搜索扫盘 | cwd + user/work 笔记根 + 接入目录(后端当前会话) |
| 搜索授权 | 全部会话 cwd + 笔记根 + 接入目录(session 层,回落全局) |
| 技能根 | user+work(note-skills 插件) + 接入目录(全局层,`custom:` 前缀) |
| markdown 附件 | user+work+接入目录(全局层)+ vault 自探测 |
| daily notes | `custom ∥ user` 单目录 + vault 自探测 |

## 4. 可整理的方向(待拍,本文不动手)

1. **给两组设置补入口**——这是所有「真机 daily 0 条」「接入目录只能手改」现象的共同根。React 壳今天连接入目录面板都没有;按「配置形状进 Settings」判例,接入目录(全局/space 两维)+ 笔记/日记/附件目录应是一个设置分区。
2. **Obsidian 探测收成一份**:`findObsidianVaultRoot` / `readObsidianAppConfig` / 家目录展开 / 附件目录解析各留一份(runtime 层一个 `obsidian/` 或 `notes/` 模块),三个域改吃它;B2/B3 一并消掉。
3. **「笔记根」一个定义**:决定接入目录到底算不算笔记根(今天 markdown 说算、note-skills 说不算、daily 不认),然后三条链读同一张表(B4)。
4. **`create-daily` 前缀二选一**(B1),server 老路与 `shared/ipc/search.ts:234` 注释随之改。
5. 小修:B5 前缀边界、B6 两条壳正本待办、A2 归一口径统一、A5/A7 死导出与过期注释、A8 gate 补断言。
6. 需要拍板的行为变化:A3(搜索扫盘应按请求会话而非后端当前会话——壳今天不告诉后端当前会话)、A4(无会话读路径要不要也按 space 层)、B9(daily feed 要不要递归)。
