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
| **CLI 的传输是一条 unix socket `~/.obsidian-cli.sock`**(09-18 `lsof -U -c Obsidian` 实测;launcher 是 Mach-O,连的就是它) | socket 存在且能连 = app 在跑且 CLI 已注册;连不上 = 一条命令都别发(发了就是拉起) | **探活 = 试连 socket**,不用 `pgrep`;Windows 对应物 P1 查(named pipe) |
| **`obsidian.json` 每个 vault 带 `open: true/false`** | 本机 6 个 vault 里 3 个 open | 缺省只对 `open` 的 vault 发命令;对没开的 vault 发 `vault=` 视同拉起(只许前台动作) —— 原 P0 ②「会不会弹窗」不用测了 |
| **daily-notes 核心插件实例有 `getDailyNote()`**(`eval` 列出 instance 方法:`getDailyNote / getFolder / getFormat / getDailyNoteTemplateBeforeAppLoads / iterateDailyNotes …`) | 「新建今日」= `eval` 调 `getDailyNote()`:走 Obsidian 自己的模板与文件夹逻辑,不开窗 | 原 P0 ① 答案;比 `daily:append content=""` 干净。P1 的 `gate:notes` 只对**今日已存在**的 vault 调它(幂等),不在用户 vault 上造文件 |

### 1.5 检索骨架核对(2026-09-18,用户提醒「现在的搜索逻辑和之前不一样」)

方案 §4.1 / §4.3 按**重建后**的检索骨架写,与今天 HEAD 逐条对得上:一类 = 一个文件(`capabilities/daily.ts` =
manifest + `retrievers: [createSqliteLexicalRetriever(...)]` + `invoke` + `preview`),feed 由 `workerData.notesDirs`
在 `index/worker.ts:125` 一目录一 `DailyNotesFeed`,`manifest.retrievers[id] = { when }` 是数据(`RetrieverWhen =
'relaxed' | 'explicit' | 'always'`,`explicit` 还能按 `surfaces` 列谁算明说),`SearchPage.actions` 承载页级动作,
`wiring/search/index.ts` 的 `applySemantic` → `IndexWorkerHost.restart()` 是「设置改了换 Worker、间隙请求排队」的
现成先例 —— `settings.notes` 改了 vault 表就走这一条。09-08 之后检索域的提交只动语义召回(开关热生效、模型下载
拆开、占用空间),骨架未变。**旧扫描路已死**:方案里没有任何一格走 `executeOnethingSearch` / 六扫描器那一族。

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
  `.obsidian`**);`cli.ts` 唯一碰 `child_process`(读完 stdout、首行判错、10s 超时、`mayLaunch` 门、探活 =
  试连 `~/.obsidian-cli.sock`,Windows 对应物待查);`scripts.ts` 集中全部 `eval` 片段(每段一个名字、返回类型、依赖的 API);
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
  systems: Record<driverId, { enabled?: boolean }>,   // 每种笔记系统一行总开关,键 = 驱动 id;缺席 = 开
  vaults: Record<vaultId, { enabled?: boolean; skills?: boolean }>,   // 缺席 = { enabled: true, skills: false }
  primaryVaultId?: string,                        // 「今天的日记」「新建笔记」缺省落点
  folders: string[],                              // 非 Obsidian 笔记目录(FolderDriver)
  dailyFormat: string,                            // 只管 FolderVault
  attachmentDirectory?: string,                   // FolderVault 附件目录;P3 把 editor.markdownNoteAttachmentDirectory 并进来
  migratedAt?: number,                            // P1 播种标记
}
```

(09-18 P1 陌生能力演练打回的三处:原 `obsidian: { enabled }` 是契约层点驱动名,改成 `systems` 表;错误码
`'obsidian-not-running'` 改 `'system-not-running'`;basename 索引的跳过表不再点名 `.obsidian`。加一种系统 =
`notes/<id>/{vault,driver}.ts` + `wiring/notes/index.ts` 一行注册,契约层 / core / defaults / 迁移零改动。)

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
| prompt 变量板 | 新只读派生变量 `note_vaults`(文件 `variables/providers/note-vaults.ts`;`providers/notes.ts` 是老两变量的产地,P3 随变量一起删):启用的 vault(name / root / system)+ 主库今日日记路径。AI 从这里知道笔记在哪 |

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
- 行动作(P5,已落地)`open-in-app`:`vault.openInApp`,`mayLaunch:true`。动作号是
  `open-in-app:<encodeURIComponent(绝对路径)>`,与两条 create 同一条规矩(路径编在 id 里,
  授权夹的就是那一格)。
  **这条落地时补了一格机制,因为检索面没有「行动作」这回事**(2026-09-18 盘点):
  契约的 `SearchResult` 上没有 `actions`(`SearchActionDescriptor` 只挂在页 / 块 / 预览上),
  core 的 `Candidate` 上也没有,壳的行右键菜单只画「打开」+「只看这一类」+ 目标渲染器自报的
  **续搜**。`continuations.ts` 文件头把这笔账记过了。P5 没有发明第二套动作协议,而是:
  ① 后端把一格**能力位**编在 `NoteTarget.payload.openInAppActionId` 上(在场 = 这篇笔记
  所在的库答得出 `openInApp`),② 壳的 `SearchTargetRenderer` 多一个可选槽
  `rowActions?(row)`,与既有的 `continuations?(row)` 同一个落点、同一张右键菜单,
  ③ 按下去走既有的 `search.invoke`(壳这一侧那条端口 P5 才开 —— 在这之前没有一个能力
  声明过动作)。**到位的形仍然是「后端在候选上自报一张 `actions` 表」**,那要动契约 +
  服务层 + core 的 `Candidate` 三处,自成一批(§7 留账)。
- **「把库本身唤到前台」这件事做不到**(2026-09-18 真机量的,P4 留账 2 由此结清):
  Obsidian CLI 整张动词表里没有它 —— `open` 硬性要 `file` 或 `path`(`open path=` 答
  `Missing required parameter: file or path`),`vault` 只读信息。所以 `notes.openInApp`
  的无 `path` 档如实答 `unsupported`(不发那条必然失败的命令),**设置页那一行上没有
  「打开」钮**,「在 app 里打开」唯一真做得到的落点是检索结果那一行(它手上有路径)。
  真要一颗「把这个库调出来」,得走 `obsidian://open?vault=<name>` 那条 URI = `shell.openExternal`,
  而 React 壳今天的 `shell` 端口是 `null` —— 自成一批(§7 留账)。
- 授权:目标路径夹在 `registry.vaults().map(root)`(替今天 `resolveDailyNoteSearchDirs`)。
  `open-in-app:` 与两条 `create-*:` 同夹一张表 —— 它更要夹:它是唯一会把一台 app 拉起来的
  动作,一条编着库外路径的动作号 = 用一次点击打开机器上的任意文件。

### 4.2 附件(markdown 域)

`markdownContext` 三态保留(vault / note / project),vault 判定 = `registry.vaultFor(doc)`;附件落点 =
`vault.attachmentPathFor`;找不到 = `vault.resolveByName`;链接文本 = `vault.linkTextFor`。删两份 `.obsidian` 解析、
`buildVaultAssetIndex`(搬 FolderVault)、wikilink 自拼。`obsidianAttachmentRootStaysInside` 改名
`noteAttachmentRootStaysInside`,边界检查器 `:2891` / `:1810` 两处同批改。

### 4.3 Obsidian 原生搜索(R3)

索引是缺省(离线、vector、与会话同一条流水线)。各个库自己的搜索作为**第三个检索器**
`notes-live`(P5 已落地;**id 不叫 `obsidian-live`** —— 能力自述里不点任何一个笔记系统的名字,
谁答得上由每个库的 `liveSearch` 在不在决定):查询带那台 app 的搜索操作符(`tag:` / `path:` /
`file:` / `line:` / `section:` / `block:` / `task:` / `[prop]`,判词 `looksLikeLiveQuery`)或用户
打开了那颗片时才跑,`search:context format=json` → 每条命中按 `note:<绝对路径>` 造候选(与索引
那一路**同一个产地** `noteResultId`,出处走 feed 的 `vaultRelativeKey`)并入 RRF。

**三件落地时改判的事**:

1. **跑不跑由能力自己判,不由 core 的 `retrieverRuns` 判**。core 认的两种「明说」是
   `query.filters.semantic === true` 与 `ctx.surface` 在 `policy.surfaces` 里 —— 这一路两个都不是
   (「用户点了那颗片」「这个词长得像 Obsidian 的语法」在 core 的词汇表里没有名字),而
   `semantic` 那一格**借不得**:词法那一侧(`sqlite-index.ts` 的 `facetClause`)把 `filters` 里
   的每个键都翻成一条 facet `EXISTS` 子句,借它等于让每一次活检索的词法路零命中。所以
   manifest 里那行 `{ when: 'explicit' }` 是**自述**(给读表的人看的),而「这一次跑不跑」由
   `wantsLiveSearch` 答,融合仍然用 core 的 `rrfFusion`(算法只有一处产地)。让 core 也驱动得了
   它,要给 `RetrieverWhen` 加一格「按召回器 id 的显式开关」—— core 的改动,§7 留账。
2. **那颗片是一个 facet,不是新协议**。`notesManifestOf` 在「有一个在册的库答得出
   `liveSearch`」时多摆一格 `{ key: 'live', type: 'boolean' }`,壳画片的既有判据(`facetKeysOf`)
   照着就画出来了 —— 壳一个笔记系统的名字都不需要认识。它是**控制位不是文档 facet**,所以
   进索引之前由 `withoutControlFilters` 摘掉。片名是名词(「Obsidian 搜索」),值才是「用 /
   不用」——与 09-05 那条「按下去代表反义」的判例同一形。
3. **app 没跑时那颗片不灰,而是页上一句话**。「Obsidian 此刻活着吗」是一次 socket 连接
   (异步),而 manifest 是同步的自述 —— 拿一份过期的答案把片画灰,比让用户按下去之后看见
   一句诚实的解释更坏。所以:片照画、按得动(按它不会把 app 拉起来),答不上的库把
   `NoteVaultUnavailable.reason` 交出来,能力把它变成页上一条 `kind:'notice'` 的项,壳把
   `notice` 从动作行里择出去画进页脚(与「已放宽」「索引不可用」同一行读数)。
   **`SearchPage` 上今天没有「提示」这一格**,而 `actions` 是唯一一处「不属于任何一条结果、
   属于这一页」的开放槽,所以它走那一格 —— 该有一格 `notices` 是 core 的改动,§7 留账。

预算:单库 3s(CLI 自己的 10s 是给前台动作的),做法是
`AbortSignal.any([ctx.signal, AbortSignal.timeout(3000)])` 一路递到
`NoteProcessRunner.run` —— **P5 把 `NoteLiveSearchOptions.signal` 真接上了**(P1 留的那格注
写着「今天不生效」):已经 abort 的信号进来 = 一次 `spawn` 都不发生,跑到一半 abort = SIGTERM
→ 1s → SIGKILL,`done` 以 `NoteProcessAborted` 落定。「用户换了词」与「这个库太慢了」因此是
同一条取消路的两个源头,领域那一侧只认识 `signal` 一格。

`liveSearch` 自己带两道闸(库开着 ∧ app 活着 = `canQueryLive`),不成立就抛并把理由交出来 ——
`cli.run` 那一侧只拦得住「app 没跑」(它探活),拦不住「库没开着」,而对一个没开的库发命令
等于把那个库的窗口弹出来。

**零命中时 CLI 答的是一句人话,不是 `[]`**(2026-09-18 `gate:notes` ⑧ 第一次跑就撞上的真读数):
整段就是 `No matches found.`,不带 `Error:` 前缀,所以判错那一闸放它过来(零命中本来就不是错)。
领域与门认同一句常量,别让它走进 `JSON.parse` 的 catch —— 两者今天答案相同(空表),但一个是
事实、一个是「我看不懂它说什么」,混在一起下次格式真变了就没人发现。

core 里检索器仍是数据,不出现名字。

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
| **P0 探针** — **已结(09-18)** | ① 新建今日 = `eval getDailyNote()`;② 不测,按 `obsidian.json.open` 判;③ mac 路径实证,win / linux 按官方文档(`%APPDATA%\obsidian` / `~/.config/obsidian`)P1 写进代码并留单测;④ 本机只有 1.13.7,`=> <json>` 一种格式,P1 解析器容错「无 `=> ` 前缀」;⑤ 探活 = 连 `~/.obsidian-cli.sock` | 读数已回写 §1 |
| **P1 领域 + 设置 + 迁移(播种)** — **已入库 a1c7372bb(09-18)** | `notes/` 全套 + `wiring/notes` + `settings.notes` + 迁移**只播种不删**(从 `obsidian.json` + 老两变量的值种出 vault 表;两个变量的定义与读者 P3 一起删)+ `notes` 派生变量 | 假 CLI runner 单测(录真实 stdout 当夹具,含 `Error:` 与挂死用例);迁移单测钉 `ONETHING_STORE_PATH`(C1 事故);`gate:notes` 本机 socket 能连才跑只读命令,否则打印原因跳过 |
| **P2 检索** — **已入库 167b9f7c6(09-18)** | `notes` 能力 + `VaultFeed` + facets + 今天 / 新建动作 + 前缀统一 + 删 `daily` 能力与 `dailyNotes` 设置;热生效订 `NotesSubsystem.onRefreshed`;两条动作把目标路径编进 id 供授权夹 | `gate:search-index` 绿;golden snapshot 只允许 daily → notes 的改名差异;`gate:search-scan` 不动 |
| **P3 附件 / 技能 / 沙箱 / 变量** — **已入库 9faf5fc02(09-18)** | §4.2 §4.4 §4.5 §3.4 表全部;note-skills 插件退役;边界规则改名;`noteRootsNow()` 是笔记根唯一定义;两个变量、`general.dailyNotes`、`editor.markdownNoteAttachmentDirectory` 已删;`BasenameIndex` 改收所有文件且无扩展名先找笔记 | 两半 asset-service 测试改夹具;`markdown-sandbox` 绿;`boundary:gate` 绿;`sandbox` 测试改根来源 |
| **P4 壳设置区** — **已入库 5ae122634(09-18)** | §4.6;`notes` RPC 域 `list/refresh/openInApp`;状态四态由驱动自述 `NoteSystemDriver.state?()` | 面板单测 + `gate:a11y` 加一屏 |
| **P5(已入库 415b45cba,09-18) 活检索器 + 在 app 里打开** — **已实施(09-18)** | §4.3 的 `notes-live` + §4.1 行动作;`NoteLiveSearchOptions.signal` 真接上;`search.invoke` 壳侧端口开;页脚提示 | 检索器单测(假库)+ 真 runner 的 abort 用例;`gate:notes` 加 ⑧ / ⑧b 两步(活检索真跑一发 + 已 abort 的信号零 spawn) |
| **P6 `note` 工具**(可选) | AI 侧 `note` 工具:create / daily_append / open,场景面按 `settings.notes` 启用与否进出 | 工具单测 |

P1 之后 P2 / P3 / P4 互不依赖可并行。每单 Fable 拆分审查、opus 执行、haiku 提交。

## 6. 拍板(2026-09-18 用户拍 R1–R3;R4–R9 未反对,按推荐执行)

| # | 变化 | 结论 |
| --- | --- | --- |
| R1 | 插件还是内置开关 | **拍定:内置开关**;骨架按驱动注册表留接缝 |
| R2 | `user_note_dir` / `work_note_dir` 两个变量删,换 `settings.notes` + 只读派生变量 `notes`;AI 用 `variable` 工具「重指笔记目录」的审批流随之消失 | **拍定:删** |
| R3 | 搜笔记缺省走索引;Obsidian 原生搜索只在带操作符 / 点 chip 时跑 | **拍定:走索引**。用户附注「现在的搜索和之前逻辑不一样,注意」→ §1.5 已按重建后骨架逐条核对 |
| R4 | Obsidian 没在跑:后台不拉起;用户主动动作(新建、在 Obsidian 打开)允许拉起 | 推荐 |
| R5 | 日记从「`user_note_dir` 单目录」变成「每个启用 vault 的日记都可搜,主库那本是『今天』」;接入目录不再算笔记根;`dailyNotes` 五格删零迁移 | 推荐 |
| R6 | `settings.notes` 全局,不按 space 分 | 推荐全局(笔记库是机器的,不是空间的);要 per-space 是另一单 |
| R7 | 迁移缺省:名册里所有 vault `enabled:true, skills:false`;老两目录 `skills:true`,user 那个当主库 | 推荐 |
| R8 | 依赖 `eval`(Developer 组) | 推荐接受,集中一文件、`gate:notes` 盯着;不接受就退回读 `.obsidian/*.json`(只是把三份收成一份) |
| R9 | 关掉一个 vault = 它同时退出检索、附件、技能、**AI 可读范围** | 推荐一个开关管全部,不拆四个 |

## 7. 留账

- **core 的 `RetrieverWhen` 表达不了「按召回器 id 的显式开关」**(P5 量出来的)。今天
  `retrieverRuns` 的 `explicit` 只认一格全局 `query.filters.semantic`(而且全仓**零生产者**)与
  `ctx.surface`,于是 `notes-live` 的「跑不跑」只能由能力自己判。补法是给 `RetrieverPolicy` 一格
  「这一路的显式开关叫什么」或给 `SearchQuery` 一格 `retrievers?: string[]` —— core 的改动,
  自成一批。**顺带一个今天摸不到的雷**:`SEMANTIC_FILTER_KEY` 真被谁填上的那一天,
  `createSqliteLexicalRetriever` 会把它当成一条 facet 条件,那一路当场零命中。
- **`SearchPage` 该有一格 `notices`**。「这一次少用了一条召回路,原因如下」今天借
  `actions` + `kind:'notice'` 走,壳在两处把它择出去(序列、页脚)。它与 `partial` 是两件事
  (那一格说「只扫到一半」)。
- **契约上没有「行动作」**:`SearchResult` / core 的 `Candidate` 都没有 `actions`。P5 的行动作
  靠「payload 上一格能力位 + 目标渲染器自报」落地(§4.1),到位的形要动契约 + 服务层 + core。
- **「把某个库调到前台」需要 `shell.openExternal('obsidian://open?vault=…')`,而 React 壳的
  `shell` 端口是 `null`**(`apps/desktop-react/electron/host-ports.ts:155`)。填它 + 让驱动答这件事
  = 一批。在那之前设置页那一行上没有「打开」钮。
- 插件宿主在 React 壳的复活是独立议题;复活后本领域抬成插件的路径 = §2 末段。
- `VaultFeed` 递归会让大 vault 首次索引变慢(workbook 1032 文件 351MB 含附件;只索引 md 文本)。P2 量一次冷建时间。
- 接入目录的设置 UI(盘点 A1)不在本单;它与「笔记」是两个设置区。
- Obsidian Headless(官方无桌面 sync 方案)与 server 的关系未看。
