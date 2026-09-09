# Dock 瓦与内容的作用域(2026-09-08 方案)

> 状态:**方案,未动手**。用户 09-08 原话:「dock 的 item 需要做成分作用域的:workspace 是全局的(跨 workspace);file viewer 可以创建多个(同一 workspace 下);有些同一 workspace 下只能有一个窗口;directories(Dock 上的「目录」瓦)也要同一 workspace 下多个,和 session 的 workdir 绑定,切换 session 会切到对应的 directory。会根据作用域有不同的行为。」
>
> 09-08 追补:第一稿把「目录」写成了后端的 project dir 名册,用户纠正:**说的是 Dock 上那块「目录」瓦(`files` 瓦 → `files-root` 面板),与后端 `projectDirs` 域无关**。§4 按此重写。
>
> 本文接在 `pane-tree-2026-09.md` §五(家具 / 偏好分界)、`workbench-2026-09.md` §1.1(内容模型)、`workbench-tabs-2026-09.md` §3(目录面板按目录多开)之后,只谈**作用域**这一条轴。骨架法条照旧:`workbench/store` / `workbench/tree` / `workspace/per-space` / `stage/residency` 里**不许出现任何一种内容的名字**,作用域是内容自述、核心读表。

## 0. 一句话

「作用域」不是一个枚举,是**三条互不相干的自述**:

| 轴 | 问句 | 值 | 谁答 |
| --- | --- | --- | --- |
| **层级** `level` | 这一格家具记在哪一本账上 | `app`(跨工作区,换空间它跟着人走)/ `space`(每个工作区各一套,今天的全部) | 内容种类,`panel` 转问瓦表那一行 |
| **同键实例** `singleton` | 同一个 `key` 在它那一层里许不许两份 | `true` / `false`(已有) | 内容种类(许可按 key 分答) |
| **跟随** `follow` | 环境会话变了,这一种里哪一份是「对应的那一份」 | `follow.keyOf(session)`:会话 → 这一种的 key(目录面板 = workdir) | 内容种类自述,一条壳级投影读表去切 |

用户点的四种情形落在表上就是:

| 用户说的 | level | singleton | follow |
| --- | --- | --- | --- |
| workspace 瓦跨工作区 | `app` | `true` | 无 |
| 有些瓦同一工作区只能一个窗口 | `space` | `true` | 无(= 今天全部瓦的行为,**一字不改**) |
| file viewer 同一工作区可多开 | `space` | `false`(已是) | 无 |
| 目录面板同一工作区多个、绑会话 workdir、切会话切到对应那份 | `space` | `false`(已是) | `keyOf = 会话的 workdir`:切会话激活同根那份,没有就在旁边开一份 |

## 1. 现状(调研 09-08,file:line 见调研稿)

1. `StageItemSpec.scope: 'session' | 'global'`(`stage/types.ts:97`)**没有注释、没有行为**:唯一消费者是 `Dock.tsx:44-54`,把两组排开、中间画一条分隔线。名字被占了,语义是空的。
2. 11 块瓦全部登记成 `panel` 一种(`content/kinds/panel.tsx:29`,`singleton: true`)。「能不能多开」今天落在**种类**这一级,没有逐瓦的口。
3. 家具全按 workspace 换装(`workspace/layout-scope.ts:44-81` 五个 store + 文件树),`hiddenItems` 是全局偏好(`stage/transitions.ts:271-273`),`memory`(每块瓦的位置记忆)是家具。所以「一块瓦在这个工作区里开着」今天**天然就是 per-space** —— 它是树的投影(`stage/residency.ts`)。换工作区时**没有任何东西跟着人走**,开着的 workspace 总览也会随旧空间一起收进账。
4. `floats[id]` / `floatOrder` / `memory[id]` / `placements[id]` 全部以**瓦 id** 为键(`residency.ts:68-72`)。
5. `files-root:<绝对路径>` 已是多实例内容(`content/kinds/files-root.tsx:43`),但**根在开出来那一刻冻结**(`FilesPanel.tsx:331-343`);「跟随会话」只发生在点瓦那一下(`files-launcher.tsx:96-102` 问一次 `envSessionId` 的 cwd 再开一份钉住的)。
6. `envSessionId`(`content/session-projection.ts:26-37`)已经是「文件树的根、检索的 cwd、⌘N 继承哪个项目」的单产地,带粘性(焦点落到文件叶不换)。跟随要读的就是它,不必再立一格。
7. 「目录」瓦(`files`,`item.dirs`)是启动瓦:点 = 问一次环境会话的 workdir 开一份 `files-root:<那个目录>`,右键 = 最近目录(`workbench.recentRoots`,per-space,20 条)+「打开目录…」。**与后端 `projectDirs` 域、`connectedDirectories` 接入目录都无关**,那两个是权限面与名册,本方案一个字不碰。
8. 既有的「瓦自述、Dock 读表」扩展点是 `stage/launchers.ts` 的 `StageLauncher`(`open` / `dragRef` / `residentKind` / `MenuRows`)。Dock 里没被它收编的 `if` 只剩 `workspace` 瓦两处(`Dock.tsx:263, 309`)。

## 2. 层级 `level`:`app` 与 `space`

### 2.1 定义

`space`(缺省)= 今天的全部行为:实例、位置、记忆都在这个工作区的账上,换空间收进账、回来摊开。

`app` = **这一格内容随人走**。它在哪棵树、哪片叶、浮窗多大、位置记忆是什么,换到任何工作区都一样;在 B 空间关掉它,回到 A 它也不在。对用户的意思是「这东西不属于哪个工作区,是这台壳的」。

### 2.2 谁是 `app`(建议表,每一行改一格就换)

| 瓦 | level | 理由 |
| --- | --- | --- |
| `workspace` | **app** | 用户点名。它就是切换器,切过去它还在才对 |
| `settings` | **app** | 设置页本身是这台机器的(空间覆盖层在页里分区,不是分页) |
| `apps` | **app** | 「所有应用」是恢复入口,与 `hiddenItems` 同为全局 |
| `notifications` | **app**(拍点 2) | 未读是机器级事实,不按空间分 |
| `providers` | space | 模型表有 per-space 覆盖层(`SpaceOverlayPayload.selectedModels`) |
| `sessions` | space | 总览本来就按空间过滤 |
| `search` | space | cwd / 会话范围都是空间的 |
| `files` 「目录」瓦 → `files-root` | space | 多份、绑会话 workdir,见 §4 |
| `diff` | space,**多开**(09-09 用户追加) | 今天是 mock 面板。改成多实例内容 `diff:<目标>`:目标今天是会话 workdir(一个仓一份改动面),将来按文件 `diff:<workdir>#<file>` 同一形状;`singleton: false`,`follow.keyOf = session.projectId` 与目录面板同一句(它看的就是当前仓的改动,不跟随的 diff 没有意义;拍点 8)。「改动」瓦点 = 召唤环境会话 workdir 那份,与「目录」瓦同一条启动器写法 |
| `terminal` / `browser` | space | 今天是 mock;将来按 cwd 多开时在各自模块自述(§6 演练) |
| `file` / `session` / `pair` | space | 会话按归属就是空间的;`pair` 见 §2.5 |

### 2.3 机制:**换装时剥离再携带**,不另立一棵全局树

考虑过的两条路:

- **另立一套不换装的区域**(全局浮窗层 / 全局架子):区域是壳的家具、可枚举,理论上合法。但架子是一条边一棵树,没法「半棵全局半棵空间」;中央区同理。要么限制 app 级内容只能浮窗,要么每条边长出第二棵树。两者都要动 `AppShell` 网格与拖拽几何,代价与收益不对等。**否决。**
- **携带**:树照旧全部 per-space。换空间那一拍,把 app 级的格从**离场的活树**里捡出来,原样放进**进场的树**。进场的树先把自己账上残留的 app 级格剥掉(它们是上一次离场时留下的旧影),再装携带来的那份。**采用。**

一条规则写全:

```
spread(进场家具, 离场活状态?):
  没有离场方(开机)        → 原样摊开(账上有什么就是什么)
  有离场方(切换)          → 剥掉进场树里所有 level=app 的格
                             → 从离场活树里捡出所有 level=app 的格(连同它所在的区域坐标)
                             → 放进进场树:同名区域存在就 append 到那片叶;
                               edge:<side> 不存在就按单叶政策造一片;
                               float:<id> 整个区域连 rect 连 floatOrder 位次一起搬
```

为什么开机不剥:当前空间的账在 `partialize` 时就是活树,app 级格存在里面,那正是要恢复的东西。剥只在「有人来接班」时做,才不会两份。

为什么不改持久化:app 级格永远在**当前空间**那一格账里落盘,别的空间账上的残影在下一次进场时被剥掉。零迁移、零新 key。

### 2.4 骨架落点(核心层零种类名)

| 文件 | 改什么 |
| --- | --- |
| `workbench/kinds.ts` | `ContentKind.level?: 'app' \| 'space' \| ((ref) => 'app' \| 'space')`,缺席 = `space`;一只读法 `residencyLevelOf(ref)`(与 `focusIntoScopeOf` 同形)。`singleton: boolean \| ((ref) => boolean)`,读法 `isSingletonContent(ref)` 取代 `isSingletonContentKind(id)`(`tree.sanitize` 那一处去重跟改) |
| `workbench/tree.ts` | 两只纯函数:`stripByLevel(regions, level)` 与 `carryByLevel(from, to, level)`。判据只经 `residencyLevelOf`;单元测试用假种类 |
| `workspace/per-space.ts` | `PerSpaceSpec` 加一口 `carry?(incoming: F, outgoingLive: S): F`;`swapSpace` 在 `spreadSpace` 之后调它一次。**这只文件仍不认识树、不认识瓦** |
| `workbench/store.ts` | `WORKBENCH_PER_SPACE.carry` = 剥 + 携带 regions,`hidden` 表里 app 级的 ref 同样携带(隐藏着的 app 级格换空间也不该丢) |
| `stage/store.ts` / `stage/transitions.ts` | `STAGE_PER_SPACE.carry`:`floats[id]` / `floatOrder` / `memory[id]` 三张表里 app 级瓦那几条携带。判据是「这块瓦的 `panelRef` 的 level」,经 `residencyLevelOf` 问 —— stage 层因此也不点名 |
| `workspace/layout-scope.ts` | 不动。次序照旧(workbench 换装 → stage 换装 → `syncStageResidency` 重算投影);携带发生在各自 `swapSpace` 里,投影自然正确 |
| `stage/types.ts` / `stage/items.ts` | `scope: 'session' \| 'global'` **改名为** `level: 'app' \| 'space'` 并写上注释;`SESSION_ITEMS` / `GLOBAL_ITEMS` 的去留见拍点 1 |
| `content/kinds/panel.tsx` | `level: (ref) => findItem(ref.key)?.level ?? 'space'`;`singleton` 同理可按瓦答(今天全部 `true`) |

### 2.5 边角

- **复合**(`pair`)跨级:两格 level 不同就**并不了**(`compose` 答 `null`,提示沿用 `pair` 既有的「并不了」文案)。同级的 `pair`,level 等于它的格。这是 `pair.tsx` 自己的事,核心层不判。
- **常驻**(`resident`)与 `app` 互斥:常驻是「这个区域里至少留一格」,是空间的事;一种内容同时自述 `resident` 与 `level: 'app'` 在登记时**抛**。
- **全屏**:换空间清零(既有裁定),app 级格全屏着换空间 → 先 `exitFull` 再携带,它落回原叶。
- **隐藏**:`hiddenItems`(Dock 上藏瓦)已是全局;`workbench.hidden`(藏一格内容)里的 app 级 ref 携带。
- **焦点**:携带不搬焦点。换空间那一拍焦点落到进场树的中央区(既有行为)。
- **两窗口开两 space**(spaces.ts 留的路):携带是窗口内的事,与它不冲突。

## 3. 同键实例 `singleton`

不变。只把「按种类答」放宽为「许按 key 答」(§2.4),今天没有任何一种要用到:`panel` 全 `true`,`file` / `files-root` / `session` / `pair` 全 `false`。放宽的理由只有一条 —— §6 演练三要求「一块瓦想多开」不许惊动核心层。

`app` 级的单例是真单例(携带保证全壳只有那一份);`space` 级的单例是「这个空间里一份」(今天就是)。语义因此可以写成一句:**同一个 key 在它那一层的账上至多一格。**

## 4. 跟随 `follow`:目录面板绑会话 workdir

> **09-09 被取代**:用户口述「切回会话要回到上次中断的地方(哪个目录、哪个文件、哪一行)」,按 workdir 找同根面板这一条做不到。改为**伴随面按会话记住、按会话收放**,正本 `session-continuity-2026-09.md` §3。本节原文保留作比较(那篇 §3.4 末尾的「另一条路」就是它)。

### 4.1 用户要的形

同一个工作区里开着几份目录面板,每一份是一个目录(`files-root:<绝对路径>`,今天就是)。会话有 workdir。**切到哪条会话,就切到根等于它 workdir 的那一份目录面板。** 「多份」是用户自己摆的,「切到对应的」是壳替人做的。

### 4.2 自述:`ContentKind.follow`

```ts
follow?: {
  /** 这条会话对应这一种里的哪一个 key;答 null = 这条会话没有对应的一份。 */
  keyOf(session: SessionSummary): string | null
}
```

`files-root` 答 `session.projectId`(= 归一过的 workingDirectory,`expose/projection.ts:162`;没绑目录答 null)。核心层不知道 key 是路径。

### 4.3 投影:一条壳级订阅,读表办事

新文件 `content/session-follow.ts`(与 `content/session-projection.ts` 同族,零种类名),订 `envSessionId`,变了就对**每一种自述了 `follow` 的内容**做一遍:

```
key = kind.follow.keyOf(环境会话)
key 为 null                                → 什么都不做
这个空间里一份该种类的实例都没有            → 什么都不做(用户把这个功能关了,不替他开)
有同 key 的实例(摊开 pair 也算)             → 激活它:tab-activate 那片叶;架子收着就只换 activeId 不展开;
                                               浮窗被压着不提前;**不搬焦点**
有实例但没有同 key 的                       → 在阅读序第一份实例所在的叶里 append 一格新的,激活它;
                                               同时 rememberRoot(key)
```

理由逐条:①「一份都没有就不开」是因为目录面板可以被关掉,关掉之后切会话它又冒出来,那是壳在跟人抢;有一份在场才说明用户想看目录。②「没有同根就在旁边开一份」是「多份」的自然来源:三条会话三个 workdir,用完就是三格标签,关掉哪一格由人定,关掉的不会因为切会话再回来 —— 除非那时一份都不剩(①),那就从头来。③「不搬焦点」与 `envSessionId` 的粘性是同一句话的两面:焦点在会话叶上,目录面板只是跟着换脸。④ `keyOf` 答 null(会话没绑目录)什么都不做,`NoWorkdirNotice` 照旧只在那条会话自己那棵(根 = `~`)上说。

规则里没有「跟随实例」「钉住实例」两种身份 —— **对应关系是算出来的(根 == workdir),不存任何一格**。落盘零改动,`recentRoots` 顺手多记一条。

### 4.4 「目录」瓦不改

点 = 召唤环境会话 workdir 那一份(`summonRef(files-root:<cwd>)`,已有,四态照旧);拖 = `files-root:<cwd>`(已有);右键 = 最近目录 + 打开目录…(已有)。运行点按种类亮(拍点 6)。**这一块瓦今天的行为已经与 §4.3 一致,零改动。**

### 4.5 边角

- 同根两份(用户拖一份出去对照)→ 激活阅读序第一份。
- 面包屑点祖先段换根(`retargetFilesRoot`)→ 这一格从此对应另一个 workdir(或谁都不对应),下次切会话按新根算。没有「跟随被打断」的概念,因为没有跟随态。
- 会话 workdir 被改(`setWorkingDirectory`)→ 投影同样订 `projectId` 变化,按 §4.3 走一遍。
- 换工作区 → `envSessionId` 由 `session-projection` 在新空间里重算,本投影跟着跑一遍;新空间一份目录面板都没有就什么都不做。

## 5. Dock 与总览怎么读这张表

- **Dock 分组**:今天的分隔线按 `scope: session | global` 画。改名之后如果照 `level` 画,分组会从「files diff terminal ｜ 其余」变成「files diff terminal browser search sessions providers ｜ notifications workspace settings apps」。这是用户可感知的变化 → 拍点 1,**缺省保持今天的分组**(保留一张只服务视觉的 `dockGroup` 字段,不再与作用域同名)。
- **`workspace` 瓦的两处 `if`**(色底、右键快切表)本单顺手收进 `StageLauncher`:`MenuRows` 既有,加一口 `face?()`。Dock 从此零 `if (id === …)`。这是结构修,不改行为。
- **总览 / 所有应用**那张清单可在每行后标一枚「跨工作区」小字(拍点 3,缺省不标)。

## 6. 陌生能力演练(法条要求,交卷前必做)

| 假想能力 | 要改的文件 | 结论 |
| --- | --- | --- |
| 一 · 「剪贴板历史」面板,跨工作区常驻浮窗 | `content/kinds/clipboard.tsx`(自述 `level: 'app'`,`singleton: true`)+ `content/kinds/index.ts` 一行 + 瓦表一行 | 携带、单例、隐藏、记忆全部由核心层按表办 |
| 二 · 终端按 cwd 各一个、跟随会话 | `content/kinds/terminal.tsx`(`follow.keyOf = session.projectId`)+ `index.ts` 一行 | `content/session-follow.ts` 那条投影一个字不改,自动也管它 |
| 三 · 「搜索」瓦想同一空间开两份并排 | `content/kinds/panel.tsx` 里 `singleton: (ref) => findItem(ref.key)?.multi !== true` + 瓦表那一行加 `multi: true` | 若 `singleton` 仍是种类级布尔,这一条就要动 `tree.sanitize` —— 这正是 §2.4 把它放宽成可按 key 答的理由 |
| 四 · 某种内容在 A 空间是 app 级、在 B 空间不是 | 答不出:level 是内容自述,不是空间的属性 | **明确不支持**,写进 §8;一种内容只有一个 level |

三条都是「能力自己的模块 + 壳渲染 + 一行登记」,骨架不动。第四条是有意的边界。

## 7. 拍点(用户可感知的行为变化,缺省 = 保持旧行为)

| # | 变化 | 缺省 | 建议 |
| --- | --- | --- | --- |
| 1 | Dock 分隔线改按 `level` 分组 | 保持今天的分组 | 改按 level:分隔线从此说的是真话(「左边的随空间、右边的随人」) |
| 2 | `notifications` 是 `app` 还是 `space` | space | app |
| 3 | 总览 / 所有应用里标「跨工作区」 | 不标 | 不标(Dock 分隔线已说明) |
| 4 | 切会话时目录面板跟着切(§4.3):有同根激活、没同根在旁边开、一份都没有不开 | 今天 = 不跟 | 如 §4.3。另一条路是「只一份、换根不开新标签」(第一稿),标签不累积但每份目录的树状态混在一格里;按用户「多个 + 切到对应的」的原话取多份 |
| 5 | 会话没绑目录时切过去,目录面板不动(§4.3 ④) | — | 不动;要它显示 `~` 就是又一份 `~` 面板,没意义 |
| 8 | `diff` 多实例 + 跟随会话(与目录面板同一 `keyOf`) | 今天 mock 单例 | 多实例是用户 09-09 追加;跟随是我加的一句(不跟的改动面看的不是当前仓),不要就删 `follow` 一行 |
| 6 | 启动瓦运行点按种类亮(§4.3) | 永不亮 | 改 |
| 7 | 跨级二合一拒绝(§2.5) | — (新行为) | 拒绝 |

拍完才动手。1 / 2 / 3 只是表里一格,施工序不依赖它们。

## 8. 分批与门

| 批 | 内容 | 门 |
| --- | --- | --- |
| S1 · 自述 + 携带 | `kinds.ts` 两口读法、`tree.ts` 两只纯函数、`per-space.ts` 的 `carry`、workbench / stage 两份 `carry`、`panel.tsx` 转问瓦表、瓦表改名 | 单测:剥 / 携带 / 开机不剥 / float 连 rect 搬 / hidden 携带 / resident+app 登记抛。`gate:workspace` 加一屏:开着 workspace 总览浮窗切空间,它在原位;在新空间关掉,切回来它不在 |
| S2 · 跟随 | `kinds.ts` 加 `follow` + 读法 `followKeyOf(kind, session)`;新 `content/session-follow.ts`(订 `envSessionId` 与会话 `projectId`,四条规则);`files-root.tsx` 自述 `keyOf`;`workbench/store` 若缺「在某叶 append 并激活但不搬焦点」这一口则补 | 单测四条规则各一例 + 摊开 pair + 同根两份取第一。`gate:files` 加一屏:两条会话不同 workdir,开一份目录面板 → 切会话 → 旁边多一格标签且激活、焦点仍在输入框 → 切回 → 激活回第一格、不多开 → 关掉两份再切 → 零新标签 |
| S3 · Dock 收尾 | 拍点 1 / 6、`workspace` 瓦两处 `if` 收进 `StageLauncher.face` | `gate:a11y` 既有九屏零违例;grep `Dock.tsx` 零 `=== WORKSPACE_ITEM_ID` |
| 文档 | 本文 §1 现状改成落地记录;`workbench-2026-09.md` §1.1 `singleton` 那句改;`pane-tree-2026-09.md` §五 分界表加「app 级内容:携带」一行 | — |

自证:S1 结束时 `grep -c "'app'\|'space'" workbench/tree.ts workspace/per-space.ts stage/residency.ts` 只许命中 `residencyLevelOf` 的调用与类型字面量,零种类名;这一条并进既有的种类名零命中自证。

## 9. 留账

- **后端 `projectDirs` 域与 `connectedDirectories` 接入目录都不在本单里。** 第一稿把「目录」混成了前者,已纠正;它们是名册与权限面,目录面板是看目录的窗,三者是三件事。
- **一种内容只有一个 level**(演练四)。
- **跟随只认 `envSessionId`。** 两片会话叶并排时它们真的会分家(既有裁定),目录面板跟的是焦点粘住的那条;要「每片叶各跟各的」是另一条轴,不在本单。
- **「没同根就在旁边开」会让标签累积**,这是「多份」的代价,由人关;若真机用下来嫌多,退路是拍点 4 里那条「只一份、换根」。
- **`diff` / `terminal` / `browser` 仍是 mock。** 表里给它们的 level 是占位,真做那天各自在自己模块里自述。
- **携带的落位是「同名区域 append」。** 进场树的那片叶正在全屏、或那条边的架子收着,携带来的格就在里面等着;不替用户展开。
- **`memory` 携带的是 app 级瓦的那几条。** 若将来 `memory` 整体改成偏好(全局),这几条携带就成了空转,删掉即可。
