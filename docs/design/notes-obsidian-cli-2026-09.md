# 笔记系统:Obsidian 走官方 CLI(2026-09-08,v2)

前置盘点:`docs/audit/connected-directories-obsidian-inventory-2026-09-08.md` §2。
v1 只讲「把三份手解析收成一个领域」;v2 按用户 09-08 给的功能清单重写:**vault 列表 / 搜某个 vault / 搜 all /
新建笔记与附件 / 每个 vault 的技能加载可控 / Obsidian 整体可控(插件或开关)/ `user_note_dir` `work_note_dir`
退场 / 搜笔记与建日记的方式都换成 CLI 的**。拍板前不动手。

## 0. 一句话

Obsidian 支持做成**产品内置的「笔记」领域 + 一个总开关 + 每个 vault 一行开关**,不做成插件。理由在 §2,
一句话:插件系统今天在桌面上没在跑,要先把它救活、再开三个新注册表、再给壳补插件设置 UI,才轮得到
Obsidian;而内置领域按「驱动注册表」留好接缝,将来插件宿主回来时抬成插件是一次搬家,不是重写。

## 1. Obsidian CLI 真机读数(2026-09-08,1.13.7 / installer 1.12.4)

| 事实 | 读数 | 约束 |
| --- | --- | --- |
| 必须 app 在跑 | 官方文档:「If Obsidian is not running, the first command you run launches Obsidian」 | **后台路径不碰 CLI**(索引装配、prompt、附件解析),先探进程;死了走快照 |
| 退出码 | 恒 `0`,`Vault not found.` / `Error: File "x" not found.` / eval 抛错都是 stdout 首行 | 按 stdout 首行判错,包成一个错误类 |
| stdout 被提前关掉 | 进程挂死(20s alarm 才回) | 永远读完 stdout,硬超时 10s |
| 延迟 | 单次 0.23s;5 并行 0.44s | 可并行;每回合每文档一发太贵 → 快照 + 短 TTL |
| `vault=` | 名或 `obsidian.json` 里的 id,必须第一参数;缺省 = cwd 是 vault 就它,否则「活动 vault」 | 永远显式 `vault=<id>`;**vault 名册 = `obsidian.json`**(mac `~/Library/Application Support/obsidian/`,win `%APPDATA%\obsidian`,linux `~/.config/obsidian`),离线可读 |
| `daily:path` | 返回 vault 相对路径,文件不存在也返回;日记文件夹不存在报错 | 「新建今日」走哪条 P0 定(`daily:append` / `create template=`) |
| `search:context format=json` | `[{file, matches:[{line,text}]}]`;`search format=json` 只有路径数组;`limit` 按文件数 | 可做显式检索器(§4.3) |
| `files ext=md` / `file path=` | 相对路径一行一条 / tsv(size, created, modified) | 逐文件问 mtime 太贵;正文与 mtime 读 fs |
| `file file=<名>` | 按 wikilink 规则解析 basename | 替代全 vault basename 索引 |
| `eval code=` | `app.vault.getConfig(...)`、daily-notes 插件 `options`、`app.fileManager.getAvailablePathForAttachment(name, src)`(四种附件模式都对)、`generateMarkdownLink(file, src)` | 不再猜语义的全部来源;Developer 组命令,稳定性拍板 R8 |
| `create path= content= template=` / `append` / `open path=` / `daily:append` | 建笔记带模板、追加、在 Obsidian 里打开 | 前台动作可用 |

## 2. 插件 vs 内置开关

| | A 插件(用户提的第一选项) | B 内置领域 + 开关(推荐) |
| --- | --- | --- |
| 插件宿主 | **今天桌面不跑插件**:`bootstrapPluginSystem` 自 09-04 Vue 宿主退役后零调用(`50ff9cbd`);`apps/desktop-react/electron/host-ports.ts:147` `plugins: null`。要先在 React 壳救活插件系统 | 不依赖 |
| 设置 UI | React 壳零插件设置 UI(`contributes.settings.schema` 没有消费者);vault 列表、每 vault 技能开关都没地方画 | 壳加一个「笔记」设置区(本来就要加) |
| 检索 | 插件检索供给方是 `kind:'remote'`、结果**不许带 `filePath`**(`core/plugins/search-provider.ts` 第 1 条纪律:防伪装内置结果),点击只回插件;进不了索引、没有 vector、没有 facet、all 档不能作为索引型参与 | 直接是一个索引型能力,与 chats / files 同一条流水线 |
| 附件 / 沙箱根 / 技能根 | 要新开「笔记系统驱动」注册表 + 检索能力注册表(带文件目标)+ 沙箱根供给三个宿主动词面,每个都要过 `PLUGIN_DEFERRED_REGISTRIES` 的开放纪律 | 领域内部端口 |
| 子进程 | 插件在主进程 `import()` 进来,能起子进程,但 `PluginsHostPorts.execCommand` 是给插件命令的,不是给插件代码的 | 领域自己 `spawn`(照 `music/process-runner.ts`) |
| 多宿主 | 方案 A 桌面-only,server / CLI 没有 | server / CLI 同码(Obsidian 在同一台机器就能用) |
| 可控 | 插件启停 | `settings.notes.obsidian.enabled` 总开关 + 每 vault 一行 |

选 B。但 B 的骨架按 A 的形状立(`NoteSystemDriver` 注册表,§3.2),Obsidian 驱动一个目录、零外部依赖,
将来插件宿主回来 = 把那个目录搬进插件包 + 开一个 `note-system` 注册表。

## 3. 领域模型

### 3.1 对象

`packages/onething-runtime/src/notes/`:

```ts
interface NoteVault {
  readonly id: string; readonly name: string; readonly root: string
  readonly system: 'obsidian' | 'folder' | string        // 只给 UI / 日志 / 变量看,消费方不许 switch
  dailyNote(date?: Date): Promise<{ path: string; exists: boolean }>
  createDailyNote(date?: Date): Promise<string>
  appendToDaily(content: string): Promise<void>
  createNote(rel: string, init: { content?: string; template?: string }): Promise<string>
  attachmentPathFor(fileName: string, sourceDoc: string): Promise<string>
  linkTextFor(target: string, sourceDoc: string, kind: 'embed' | 'link'): Promise<string>
  resolveByName(name: string, sourceDoc: string): Promise<string | null>
  listNotes(folder?: string): Promise<string[]>
  liveSearch?(q: string, o: { folder?: string; limit?: number; signal?: AbortSignal }): Promise<NoteHit[]>
  openInApp?(path: string): Promise<void>
}
interface NoteSystemDriver { readonly id: string; discover(config: NotesConfig): Promise<NoteVault[]> }
class NoteSystemRegistry { register(driver); vaults(): NoteVault[]; vaultFor(absPath): NoteVault | null }
```

- **`ObsidianDriver`**(`notes/obsidian/`):`registry.ts` 读 `obsidian.json` 得 `{id, path}[]`(**不再向上找
  `.obsidian`**);`cli.ts` 唯一碰 `child_process`(读完 stdout、首行判错、10s 超时、`mayLaunch` 门、进程探活
  `pgrep -x Obsidian` / `tasklist`);`scripts.ts` 集中全部 `eval` 片段(每段一个名字、返回类型、依赖的 API);
  `snapshot.ts` 每 vault 一份 `{dailyFolder, dailyFormat, dailyTemplate, attachmentFolderPath, useMarkdownLinks,
  newLinkFormat, capturedAt}` 落 `<store>/notes/obsidian/<id>.json`,活着就刷新,没跑就用;`vault.ts` 实现 `NoteVault`。
- **`FolderDriver`**(`notes/folder/`):`settings.notes.folders[]` 里每个目录一个 `FolderVault`:日记
  `<root>/<format(date)>.md`、附件 = `markdownNoteAttachmentDirectory`、链接 = 标准 md、`resolveByName` = basename
  索引(现有 `buildVaultAssetIndex` 搬来)。给没装 Obsidian 的机器。
- **纪律**:配置与语义问 Obsidian、字节读 fs;`eval` 只住 `scripts.ts`;前台动作可拉起、后台永不。

### 3.2 陌生能力演练

加 Logseq = `notes/logseq/` + `wiring/notes/index.ts` 一行注册;六个消费方(检索、附件、技能根、沙箱根、变量、
壳设置)零改动。加消费方 = 调 `registry.vaultFor(...)`,不出现 Obsidian 字样。`packages/core` 零改动。

### 3.3 设置模型(全局,不 per-space,R6)

```ts
settings.notes = {
  obsidian: { enabled: boolean },                 // 总开关;缺省 = obsidian.json 存在
  vaults: Record<vaultId, { enabled: boolean; skills: boolean }>,   // 缺席 = { enabled: true, skills: false }
  primaryVaultId?: string,                        // 「今天的日记」「新建笔记」缺省落点
  folders: string[],                              // 非 Obsidian 笔记目录(FolderDriver)
  dailyFormat: string,                            // 只管 FolderVault
}
```

`general.dailyNotes` 五格删、`editor.markdownNoteAttachmentDirectory` 留(FolderVault 用)。

### 3.4 变量退场(R2)

`user_note_dir` / `work_note_dir` 删。今天的读者与去向:

| 读者 | 去向 |
| --- | --- |
| `wiring/tools/core/sandbox.ts:41`(无会话读根) | `registry.vaults().map(v => v.root)` + `folders` |
| `search/capabilities/files.ts:85`(扫盘根)、`wiring/search/authorization.ts:26` | 同上 |
| `wiring/markdown/asset-service.ts:59`(笔记根) | `registry.vaultFor(doc)`;接入目录退出(R5) |
| `wiring/plugins/builtin/note-skills.ts:34`(技能根) | `registry.vaults().filter(v => config.skills)` 进 `listCustomSkillRoots`;note-skills 内置插件**退役**(今天本来没在跑) |
| `wiring/variables/gateways.ts:258-275`(AI 用 `variable` 工具「重指目录」+ 审批) | 删。改笔记库走设置 |
| `backend/server/runtime.ts:4036-4056` | 删 |
| prompt 变量板 | 新只读派生变量 `notes`:启用的 vault(name / root / system)+ 主库今日日记路径。AI 从这里知道笔记在哪 |

一次性迁移(挂 `initializeSettings` 后,幂等带标记):`settings.notes` 缺席 → 从 `obsidian.json` 建 vault 表
(全部 `enabled:true, skills:false`);老 `user_note_dir` / `work_note_dir` 的值若是某个 vault 的根 → 该 vault
`skills:true`,`user` 那个当 `primaryVaultId`;不是 vault 的 → 进 `folders`;然后从 `variables.json` 删这两条。

## 4. 六个消费面

### 4.1 检索:`notes` 能力(替掉 `daily`)

- `kind:'indexed'`,feed = 每个启用 vault 一个 `VaultFeed`(`DailyNotesFeed` 改名扩展:**递归**整个 vault,跳
  `.obsidian` / `.trash` / `node_modules`,`.md` / `.markdown` / `.txt`;策略 lazy,key 相对路径,指纹 `mtime:size`);
  `folders` 里的目录同样一个 feed。
- facets:`vault`(enum,启用的 vault)、`path`、`time`、`daily`(布尔 chip:只看日记文件夹)。**「搜某个 vault」= `vault`
  facet;「搜 all」= all 档里 notes 组按索引型参与(不 defer)。**
- 「今天」快捷:主库 `dailyNote()`;不存在 → 页级动作 `create-daily`(前缀统一,`create-daily-note:` 老路删)。
- 页级动作 `create-note`:词非空且没有精确命中 → 「在 <主库> 新建 “<词>”」;facet 选了 vault 就落那个 vault;
  走 `vault.createNote`(Obsidian 在跑 = CLI `create`,吃它的模板;没跑 = fs 写空文件),建完按现有 `open-file` 目标开进壳。
- 行动作(可选,P5)`open-in-app`:`vault.openInApp`,`mayLaunch:true`。
- 授权:目标路径夹在 `registry.vaults().map(root)`(替今天 `resolveDailyNoteSearchDirs`)。

### 4.2 附件(markdown 域)

`markdownContext` 三态保留(vault / note / project),vault 判定 = `registry.vaultFor(doc)`;附件落点 =
`vault.attachmentPathFor`;找不到 = `vault.resolveByName`;链接文本 = `vault.linkTextFor`。删两份 `.obsidian` 解析、
`buildVaultAssetIndex`(搬 FolderVault)、wikilink 自拼。`obsidianAttachmentRootStaysInside` 改名
`noteAttachmentRootStaysInside`,边界检查器 `:2891` / `:1810` 两处同批改。

### 4.3 Obsidian 原生搜索(R3)

索引是缺省(离线、vector、与会话同一条流水线)。Obsidian 自己的搜索作为**第三个检索器** `obsidian-live`
(`manifest.retrievers['obsidian-live'] = { when: 'explicit' }`):查询带 Obsidian 操作符(`tag:` / `path:` /
`file:` / `[prop]`)或用户点了「用 Obsidian 搜」chip 时才跑,`search:context format=json` → 文件路径映射回 docId 并入
RRF;app 没跑 → chip 灰、理由「Obsidian 未运行」。core 里检索器仍是数据,不出现名字。

### 4.4 技能根

`skills:true` 的 vault 根进 `listCustomSkillRoots`(与接入目录的 `custom:` 同一条路),递归;`<note_skill_context>`
里的 `attachment_directory` 由 `vault.attachmentPathFor` 给。每个 vault 一个开关 = 用户要的「vault 的 skill 加载可控」。

### 4.5 沙箱根

无会话读根 / 扫盘根 / 授权全集里的「笔记根」= 启用 vault 根 + `folders`。**只有启用的 vault** 进权限面 —— 关掉一个
vault 就是把它从 AI 能读的范围里拿掉,这是开关的真实含义。

### 4.6 壳:设置区「笔记」

React 壳今天设置页只有 provider 一块是真的(`providers/components/ProviderSettingsPanel.tsx`),笔记区是一块新面板:
总开关(Obsidian:已安装 / 未注册 CLI / 未安装三态)→ vault 表(名 / 路径 / 启用 / 技能 / 主库单选;Obsidian 在跑时
每行可「在 Obsidian 打开」)→ 文件夹列表(增删)→ 日记格式。派工按 09-05 规矩带三张状态表 + 组件树。

## 5. 分期

| 期 | 内容 | 门 |
| --- | --- | --- |
| **P0 探针**(半天,只读,只对开着的 vault) | 「新建今日」走 `daily:append` 还是 `create template=`;对没开的 vault 发 `vault=` 会不会弹窗;三平台 `obsidian.json` 路径与 win 可执行名;`eval` 在 1.12 / 1.13 返回格式;探活方式 | 读数回写 §1 |
| **P1 领域 + 设置 + 迁移** | `notes/` 全套 + `wiring/notes` + `settings.notes` + 迁移 + `notes` 派生变量 | 假 CLI runner 单测(录真实 stdout 当夹具,含 `Error:` 与挂死用例);迁移单测钉 `ONETHING_STORE_PATH`(C1 事故);`gate:notes` 本机 Obsidian 在跑才跑只读命令,否则打印原因跳过 |
| **P2 检索** | `notes` 能力 + `VaultFeed` + facets + 今天 / 新建动作 + 前缀统一 + 删 `daily` 能力与 `dailyNotes` 设置 | `gate:search-index` 绿;golden snapshot 只允许 daily → notes 的改名差异;`gate:search-scan` 不动 |
| **P3 附件 / 技能 / 沙箱 / 变量** | §4.2 §4.4 §4.5 §3.4 表全部;note-skills 插件退役;边界规则改名 | 两半 asset-service 测试改夹具;`markdown-sandbox` 绿;`boundary:gate` 绿;`sandbox` 测试改根来源 |
| **P4 壳设置区** | §4.6 | 面板单测 + `gate:a11y` 加一屏 |
| **P5 Obsidian 活检索器 + 在 Obsidian 打开** | §4.3 + 行动作 | 检索器单测(假 CLI);`gate:notes` 加一步 |
| **P6 `note` 工具**(可选) | AI 侧 `note` 工具:create / daily_append / open,场景面按 `settings.notes` 启用与否进出 | 工具单测 |

P1 之后 P2 / P3 / P4 互不依赖可并行。每单 Fable 拆分审查、opus 执行、haiku 提交。

## 6. 待拍板(可感知的行为变化;默认 = 推荐)

| # | 变化 | 推荐 |
| --- | --- | --- |
| R1 | 插件还是内置开关 | **内置开关**(§2);骨架按驱动注册表留接缝 |
| R2 | `user_note_dir` / `work_note_dir` 两个变量删,换 `settings.notes` + 只读派生变量 `notes`;AI 用 `variable` 工具「重指笔记目录」的审批流随之消失 | 推荐删 |
| R3 | 搜笔记缺省走索引;Obsidian 原生搜索只在带操作符 / 点 chip 时跑 | 推荐;另一选择是有 Obsidian 在跑就一律用它(没 vector、每键 0.2s+) |
| R4 | Obsidian 没在跑:后台不拉起;用户主动动作(新建、在 Obsidian 打开)允许拉起 | 推荐 |
| R5 | 日记从「`user_note_dir` 单目录」变成「每个启用 vault 的日记都可搜,主库那本是『今天』」;接入目录不再算笔记根;`dailyNotes` 五格删零迁移 | 推荐 |
| R6 | `settings.notes` 全局,不按 space 分 | 推荐全局(笔记库是机器的,不是空间的);要 per-space 是另一单 |
| R7 | 迁移缺省:名册里所有 vault `enabled:true, skills:false`;老两目录 `skills:true`,user 那个当主库 | 推荐 |
| R8 | 依赖 `eval`(Developer 组) | 推荐接受,集中一文件、`gate:notes` 盯着;不接受就退回读 `.obsidian/*.json`(只是把三份收成一份) |
| R9 | 关掉一个 vault = 它同时退出检索、附件、技能、**AI 可读范围** | 推荐一个开关管全部,不拆四个 |

## 7. 留账

- 插件宿主在 React 壳的复活是独立议题;复活后本领域抬成插件的路径 = §2 末段。
- `VaultFeed` 递归会让大 vault 首次索引变慢(workbook 1032 文件 351MB 含附件;只索引 md 文本)。P2 量一次冷建时间。
- 接入目录的设置 UI(盘点 A1)不在本单;它与「笔记」是两个设置区。
- Obsidian Headless(官方无桌面 sync 方案)与 server 的关系未看。
