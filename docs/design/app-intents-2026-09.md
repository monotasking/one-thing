# 应用能力面:让 AI 能操作每一个应用(2026-09-09 方案)

> 状态:**方案,未动手**。用户 09-09 原话:「既然做了一个操作系统式的应用,设计之初就要给 AI 留口子——所有应用 AI 都能操作、能帮你做事;后面甚至接到真实应用上(邮箱等)。现在音乐是给了一个工具,能不能换一种更合理的方式?」
>
> 接在 `apps/desktop-react/docs/desktop-os-2026-09.md`(对象模型:应用 / 文档 / 窗口)之后。**09-09 再往下一层:`atom-2026-09.md`(资源 · 读 / 做 / 看)是本文脚下的地板,本文的能力面 = 那里一个 scheme 的 `ResourceSpec` + 几格登记;分期以那篇的 K0–K5 为准。**那篇定义了「应用」是什么,本文回答「应用怎么被操作」—— 人操作、AI 操作、脚本操作走**同一张表**。

## 0. 一句话

**应用自述它能做什么(实体、动作、状态),AI 读表。** 不再为每个功能手写一个工具;每个应用交一份能力面,壳从它生成菜单、命令面板、快捷键,引擎从它生成 AI 看到的工具,自动化从它生成可调度的动作,外部真实应用则是「同一份能力面 + 另一种驱动」。这与仓库 09-02 立法「凡按能力枚举的地方改成能力自述、别人读表」是同一条法,检索面已经这样做了一遍(`packages/core/search/capability.ts` 的 manifest + 注册表)。

## 1. 「给一个工具」为什么不够(以音乐为例)

`toolkit/builtin/radio.ts` 是今天的做法:一个工具,输入 `{ action: 'open' | 'retune' | 'close' | 'status' | 'request', … }`。它能用,但有五个结构性的洞,每加一个应用就再挖一遍:

1. **人机两套**:用户在音乐面板里点的按钮和 AI 调的 `radio` 各写各的,功能会漂(面板能收藏,工具不能);
2. **AI 看不见状态**:它只能「调一下 status」,不知道现在放到哪、面板开没开、用户刚做了什么;
3. **权限按工具不按应用**:用户没法说「AI 可以操作音乐,不可以动邮件」;
4. **提示词随应用数线性膨胀**:20 个应用 = 20 个工具 + 20 段说明,每一回合都带;
5. **接真实应用时全部重来**:邮箱接进来又是一个新工具、一套新参数、一份新说明。

## 2. 能力面(App Capability Manifest)

每个应用一份,三部分,零依赖的纯数据 + 一组纯函数,住在 `packages/core/apps/`(与 `core/toolkit` `core/search` 并列):

```ts
interface AppManifest {
  id: string                       // 'music' | 'files' | 'sessions' | 'mail' …(与 desktop-os 的应用登记表同一个 id)
  title: string
  /** ① 实体:这个应用管什么东西。有 id、有名字、可查。 */
  entities: Record<string, EntitySpec>       // Track / Playlist / Directory / File / Session / MailMessage …
  /** ② 动作:能对它做什么。同一张表喂人、喂 AI、喂自动化。 */
  actions: Record<string, ActionSpec>
  /** ③ 状态:它此刻的样子。AI 不用问就能看见。 */
  state: Record<string, StateSpec>           // nowPlaying / currentRoot / openDocuments / unreadCount …
}

interface ActionSpec {
  title: string                    // 人看的名字(菜单 / 命令面板用它)
  params: JsonSchema               // 参数(与 toolkit 一样用 JSON Schema,zod 只在产品层)
  effects: EffectClass[]           // 复用 core/toolkit/effects.ts 的七类:read / silent / ask / … —— 权限看这里
  runsIn: 'core' | 'shell'         // 在引擎进程跑,还是要有一个界面宿主才能跑(开面板、聚焦)
  when?: (ctx) => boolean          // 前置(没有正在放的歌就没有「暂停」)
  keymap?: boolean                 // 要不要进快捷键表(缺省 false)
  entity?: string                  // 作用在哪种实体上(右键菜单按实体聚合)
  describe?: (params) => string    // 审批卡与审计里的一句人话
}

interface StateSpec {
  title: string
  schema: JsonSchema
  volatility: 'stable' | 'turn' | 'live'   // 沿用变量系统的三档:进 system 前缀 / 进 turn 尾块 / 只按需查
}

interface EntitySpec {
  title: string
  schema: JsonSchema
  query?: { params: JsonSchema }   // 「找一找」的参数;结果是实体数组
}
```

**驱动**(Driver)是能力面的另一半,住在产品层 / 装配层,按应用一份:

```ts
interface AppDriver {
  run(action: string, params: unknown, ctx: RunContext): Promise<Outcome>
  query?(entity: string, params: unknown): Promise<unknown[]>
  readState(key: string): unknown | Promise<unknown>
  subscribe?(key: string, cb: (value) => void): () => void   // 状态变化推给引擎(live 档)
}
```

同一份能力面可以换驱动:音乐今天的驱动是 `ncm-cli-driver.ts`(已有);邮箱的驱动可以是一个 MCP server;macOS 上的「提醒事项」可以是 Shortcuts / AppleScript 驱动;Windows 上是 UI Automation 驱动。**AI 那一侧一个字不改。**

## 3. 一张表,四个消费者

| 消费者 | 从能力面生成什么 | 今天对应的东西 |
| --- | --- | --- |
| **人**(壳) | 右键菜单按 `entity` 聚合;命令面板列所有 `actions`;`keymap: true` 的进快捷键表;实体的查询喂 @ 引用与检索 | `LeafActions` / `SessionActionsMenu` / `FileActionsMenu` 手写;`KEYMAP_COMMANDS` 手写;`search` 能力注册表 |
| **AI**(引擎) | **每个应用一个工具**,输入是 `{ action, …params }` 的可辨识联合(从 `actions` 生成);`state` 按 volatility 进提示词(stable 进 system,turn 进 `<context-update>` 尾块,live 只在工具结果里);一个元工具 `apps` 答「有哪些应用、某个应用能做什么」 | `radio` 手写;变量系统的 `datetime` / `workdir`(已按 volatility 分层) |
| **自动化**(调度 / 插件 / 网关) | 调度任务的动作从表里选;插件 `api.apps.run(app, action, params)`;网关命令映射到动作 | 调度器、插件 `registerCommand`、网关命令 |
| **外部**(deeplink / CLI) | `onething://music/play?track=…`;`onething app music play --track …` | deeplink 域、CLI |

「每个应用一个工具」而不是「每个动作一个工具」的理由:模型对 20 个工具各带 5 个动作,比对 100 个工具准得多、便宜得多;工具说明只描述应用,动作说明在参数 schema 的 `description` 里。这与 `radio` 今天的形一致,只是不再手写。

## 4. 与引擎的接缝(哪些已经有)

| 事 | 用什么 | 状态 |
| --- | --- | --- |
| AI 调动作 | toolkit 一族新适配器 `AppTool`(与 `PluginTool` / `McpTool` 同列):`plan` = 校验参数 + 把 `ActionSpec.effects` 摊成 `Intent.effects`;`apply` = `driver.run` | 新,形照 `plugin-tools.ts` |
| 权限 | `Intent.effects` → 既有 `Authorizer.decide`;**再加一层按应用的许可**:设置里每个应用一格「允许 AI 操作」(off / 只读 / 全部),off 时该应用的工具不进回合面 | effects 已有;按应用许可新 |
| 回合面 | `resolveScene` 已按场景减法;加一条:**应用工具只在「该应用开着」或「用户提到它」或「AI 用 `apps` 元工具点名要」时进面** | scene 已有;规则新 |
| 状态进提示词 | 变量系统(`VariableBoardSource` 走 turn 尾块、按块去重) | 已有,把 `state` 投影成变量 |
| `runsIn: 'shell'` 的动作 | 引擎在 core,面板在 renderer;经 SSE 发一条 `app:command` 给**托管这条会话的壳**,壳跑完经 RPC 回结果;没有壳(headless / 服务器)= 结构化降级「这个宿主没有界面」 | 与 `hasVoiceHost()` / `hasTerminalHost()` 同一种宿主判据;通道新 |
| 审计 | 每次 `run` 落一条 `tool/audit` 到 `events.jsonl`,`describe(params)` 是那一句人话 | 已有 |
| AI 在操作时的界面反馈 | 被操作的应用面板顶上一条状态行「AI 正在:播放 xxx」,来自 `api.status` 那条既有的流内状态线 | 已有一半 |

## 5. 把现有的迁过来(三个样板,证明形对)

| 应用 | 实体 | 动作 | 状态 | 驱动 |
| --- | --- | --- | --- | --- |
| 音乐 | Track / Playlist / Station | play / pause / next / retune / like / open / close | nowPlaying(live)/ isOpen(turn) | `ncm-cli-driver`(已有);`radio` 工具退役 |
| 目录 | Directory / File | open(files-root)/ reveal / rename / newFile | currentRoot(turn)/ openDocuments(turn) | renderer(`runsIn: 'shell'`)+ backend files 域 |
| 会话 / 工作区 | Session / Workspace | new / open / rename / archive / switchWorkspace / sendMessage | envSession / workspace(stable)/ openTabs(turn) | `session-open.ts` / `spaces` 域;`send_message` 工具与插件 `api.sendMessage` 并到它下面 |

三个各代表一类:纯 core 驱动(音乐)、纯 shell 驱动(目录)、混合(会话)。三个都跑通,形就定了;之后每个应用只是一份 manifest + 一份 driver。

## 6. 接真实应用

| 真实应用 | 驱动 | 能力面从哪来 |
| --- | --- | --- |
| 邮箱 / 日历 / IM(有 API 的) | MCP server(仓库已有 MCP 客户端与 OAuth) | manifest 手写一份,动作映射到 MCP 工具;或从 MCP 工具表**自动投影**一份粗的(实体 = 无,动作 = 工具,状态 = 无),再手工补实体与状态 |
| macOS 本机应用(提醒 / 备忘 / 音乐 app) | Shortcuts / AppleScript(`osascript`)驱动 | 手写 manifest |
| Windows 本机应用 | UI Automation 驱动(后置) | 手写 manifest |
| 任何有 CLI 的 | 进程驱动(与 `ncm-cli-driver` 同族) | 手写 manifest |

判据:**能力面是契约,驱动是运输。** 邮箱接进来 = 一份 manifest + 选一个驱动;AI、菜单、命令面板、权限、审计全部自动有。不接受「为邮箱写一个 mail 工具」。

## 7. 盲点

1. **提示词膨胀**:必须靠回合面减法 + `apps` 元工具按需展开;否则 20 个应用就是 09-02 那种「工具结果占请求 80%」的翻版。
2. **权限要按应用给,不只按效果**:用户的心智是「AI 能不能动我的邮件」,不是「AI 能不能做 ask 类效果」。两层都要,应用那层在设置里可见。
3. **破坏性动作**(删邮件、发消息、清空歌单)走 `ask`,并且 `describe` 必须说人话;`never-grantable` 留给真正不可逆的(清空账户)。
4. **AI 要看得见,不只是能调**:没有 `state` 的能力面是残的。音乐不报 nowPlaying,AI 就会「再放一遍」。
5. **`runsIn: 'shell'` 在多壳 / 无壳时的归属**:哪扇窗跑?托管这条会话的那一扇;都没有就降级。与 desktop-os §4.8 审批归属同一个答案。
6. **外部应用慢、会失败、要凭证**:驱动必须带超时与结构化失败;凭证走既有凭证池,manifest 不碰密钥。
7. **循环与刷屏**:AI 操作应用会产生事件,事件会进提示词,提示词又触发操作。沿用插件信使的两条闸(hop 上限、每分钟次数)。
8. **人机一致性的代价**:壳里手写的菜单要逐个改成读表,这是 desktop-os P1 的活,不是额外的。
9. **观测用户的操作**:「用户刚在音乐面板点了下一首」要不要告诉 AI?默认**不**(隐私 + 噪声),只在应用 manifest 显式声明某个状态为 `turn` 档时才进提示词。
10. **测试**:manifest 是纯数据,每个应用自动得到一份契约测试(动作 schema 合法、effects 在表内、`when` 纯函数);驱动可以用假驱动替换,门不用起真应用。

## 8. 分期

| 期 | 做什么 | 门 |
| --- | --- | --- |
| A0 内核 | `packages/core/apps/`:manifest 类型 + 注册表 + 纯投影(→ 工具 schema / → 命令表 / → 变量);`AppTool` 适配器;`apps` 元工具;`app:command` 壳通道 | 契约测试 + 假驱动跑通一个空应用 |
| A1 三样板 | 音乐 / 目录 / 会话迁到 manifest,`radio` 退役,右键菜单与命令面板改读表 | 旧 `radio` 的用例改成 `music` 全绿;菜单项一条不少(对表) |
| A2 权限与设置 | 按应用许可三档 + 设置页一格 + 审计人话 | 许可 off 时工具不进面(单测);审批卡文案对表 |
| A3 状态 | `state` → 变量投影;live 档订阅 | 提示词快照:nowPlaying 进 turn 尾块且按块去重 |
| A4 外部驱动 | MCP 投影驱动 + 进程驱动 + macOS Shortcuts 驱动,各接一个真应用 | 假驱动门 + 一次真机 |
| A5 生态 | 插件贡献 manifest + driver(= desktop-os P6);deeplink / CLI 投影 | 插件契约测试 |

A0–A1 与 desktop-os 的 P0–P1 同一批做:应用登记表(desktop-os §2)和能力面是同一张表的两面,一起立才不用迁两次。

## 9. 加一个应用要动多少 / 应用市场(用户 09-09 追加)

### 9.1 加一个应用要动什么

有了 A0,**加一个应用 = 一个包,三样东西,零处 core 改动**:

| 样 | 是什么 | 谁读它 |
| --- | --- | --- |
| `manifest` | §2 的能力面 + 图标 / 标题 / 作用域(desktop-os 的应用登记那几格) | Dock(出一块瓦)、命令面板、右键菜单、引擎(出一个工具)、设置(出一格许可) |
| `driver` | §2 的驱动:动作怎么跑、状态怎么读 | `AppTool` |
| `panel?`(可选) | 面板长什么样:插件系统既有的**声明式描述树**(`contributes.panels`,纯数据,壳不执行插件代码) | 壳的内容种类 `plugin-panel` |

这正是根 CLAUDE.md 09-02 那条法要的答案:「陌生能力演练」的答案必须是「能力自己的模块 + 它的壳渲染模块 + 各一行注册」。这里连「各一行注册」都省了 —— 注册表从包的 manifest 读。**做不到这一点就是 A0 没抽到位,打回。**

### 9.2 应用市场 = 插件市场 + 一格

市场今天已经有(CLAUDE.md「Distribution」段):插件是零运行时依赖的 npm tarball,发在市场仓 `monotasking/plugin` 的 GitHub Releases,索引是那个仓的 `index.json`;设置页有市场区(搜索、manifest 优先的确认页、离线缓存);安装走 npm `--ignore-scripts` + SRI 校验 + 失败回滚;数据在 `plugins/<id>/`,代码在 `plugins/node_modules/`。**「发到 GitHub → 市场里搜到 → 下载 → 像一个应用」这条链已经通了一半**,缺的是:

1. **插件 manifest 多一格 `contributes.app`** = §2 的 `AppManifest`。有这一格的插件在 Dock 上就是一块瓦、在引擎里就是一个工具、在设置里就是一格许可 —— 不再是「插件」这个二等身份,市场页上也按「应用」列(图标 + 一句话 + 能做的动作)。没有这一格的插件照旧(纯工具 / 纯主题 / 纯 UI 块)。
2. **确认页多说三句**:这个应用能操作什么实体、哪些动作要审批、要不要 AI 许可 —— 从 manifest 直接投影,与今天「持久槽位披露」同一种做法。
3. **索引不改形**:仍是市场仓的 `index.json`,条目多 `app: { icon, entities, actions }` 摘要供搜索;「发在 GitHub 上」= 发 Release + 提一条索引 PR(今天就是这样)。要「任何 GitHub 仓打个 topic 就能被搜到」是第二步,先不做:索引仓是唯一的审核口,去掉它就是把供应链门打开。

### 9.3 一个盲点,而且是最大的

**插件宿主在今天的桌面上没跑。** CLAUDE.md 写明「插件只在 Electron 桌面宿主执行」,而那指的是已退役的 Vue 宿主;React 壳「assembles no plugin manager today」,所以今天装一个插件,它的工具、面板、UI 块在 React 壳里一个都不出现(`getPluginManager()` 为空,插件域全部结构化降级);UI 槽位契约也「没有 React 消费者」。也就是说:**市场能装,装完没地方跑。** 做应用市场之前先把这一件补上:

- React 壳的 `assembleOwnCore` 装配插件管理器(`createOnethingBackend` 的 `plugins` 那一路,宿主口 `configurePluginsHost` 给文件对话框与子进程运行器);
- 壳里加内容种类 `plugin-panel`(渲染描述树)与 `composer.above` / `message.footer` 等五个锚点的 React 消费者;
- 这两件是 desktop-os P6 的前置,也是 A5 的前置。没有它们,§9.2 的三条都是纸。

### 9.4 落到分期

A0 的 manifest 就按「插件也能交」来定形(同一个类型,内置应用与插件应用零差别);A1 三样板证明内置那条路;**A5 之前插一期「插件宿主回到桌面」**(装配 + `plugin-panel` + 锚点消费者),然后 A5 = `contributes.app` + 市场页按应用列 + 确认页三句。
