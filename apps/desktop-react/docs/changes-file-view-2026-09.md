# 改动面 · 整文件视图 + 「行」渲染基础件 `CodeLines`(2026-09-13)

上游:`changes-panel-2026-09.md`(改动面第一版,hunk 文本模型;本文取代它的 §3.4 面板形)。
样例:`changes-file-fold-proposal-2026-09-13.html`(整文件 + 两列行号 + 改动地图 + ↑↓ 计数;09-13 用户拍板后已改成无折叠)。
用户裁定(09-13 晚,原话在 git log `348f7e8e6`):**只有整个文件一种形态,不折叠**;上一处 / 下一处只留两枚箭头图标,**改动数要看得见**(「1 / 2」计数保留);diff 有横向滚动条时 UI 带不许跟内容跑。两条按推荐拍定:diff 块接件后**开**语法高亮;行高统一成**整数 px token**。

## 0. 一句话

今天壳里三处画代码:Markdown 代码块(shiki)、文件查看器(借代码块的 shiki,自己的行)、diff 块(无高亮,自己的行)。改动面复用第三个,所以看起来与别处不是一家。本文把「行」抽成一件基础件 `CodeLines`,三处都消费它;然后改动面换成**整文件**模型:后端交 HEAD 版与工作区版两份原文,壳里算行级 diff,用查看器的行加上加删装饰画出来。

## 1. 对象模型(面向对象审核)

| 对象 | 住哪 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| `CodeLines`(基础件) | `src/content/code/CodeLines.tsx` + `.module.css` | 画**一串行**:行号(无 / 单列 / 两列)、内容(token 或纯文本)、加删底色、当前行、折行、`content-visibility` 跳过屏外行、横滚纪律(内层盒按内容宽、行号列粘左带自己那一行的底色)、整数行高 | 不知道自己装的是代码块、diff 还是文件;不解析任何东西;不做 hunk 盒 |
| `highlight.ts` | `src/content/code/highlight.ts`(从 `blocks/kinds/code/` **搬**过来,老路径留一行再导出一批) | 唯一一台 shiki | — |
| `lineDiff`(纯函数) | `src/content/code/line-diff.ts` | 两份原文 → `CodeLine[]`(带 `oldNo` / `newNo` / `mark`)+ 改动块表(每块的首行下标) | 零 React、零 DOM |
| 代码块 `Code.tsx` | 原地 | `CodeLines` + 无行号 | — |
| diff 块 `Diff.tsx` | 原地 | hunk 盒 + hunk 头照旧;行交 `CodeLines`(两列行号、加删、高亮) | — |
| 查看器 `viewer/kinds/code.tsx` | 原地 | `CodeLines` + 单列行号 + 当前行 + 折行 + 跳过 | — |
| 改动面 `content/changes/ChangeFileView.tsx` | 替换 `ChangeBody` | `git:` 的 `file` 读法 → `lineDiff` → `CodeLines`(两列行号、加删);檐上 ↑ k/N ↓;右缘改动地图 | 不折叠、不画 hunk 头 |
| `git:` 资源 `file` 读法 | `runtime/files/git-resource-spec.ts` + `backend/wiring/resource/git-provider.ts` | 一个文件的 HEAD 版与工作区版原文 | 不算 diff(算法在壳里,后端只交事实) |

**陌生能力演练**:将来「按文件夹看改动」或「看某次提交的文件」= `git:` 多一条读法 + 壳里一个新的取数处;`CodeLines` / `lineDiff` / 查看器零改动。「一种新的行装饰」(评论标记、覆盖率)= `CodeLine` 上多一格可选字段 + `CodeLines` 里一处画法;三个消费方零改动。骨架不动。

## 2. `CodeLines` 的形

```ts
export interface CodeLine {
  readonly text: string
  readonly tokens?: readonly ThemedToken[]   // 缺席 = 纯文本
  readonly oldNo?: number                     // 两列行号:旧文件
  readonly newNo?: number                     // 新文件 / 单列时用它
  readonly mark?: 'add' | 'del'               // 缺席 = 未改
}
export interface CodeLinesProps {
  readonly lines: readonly CodeLine[]
  readonly numbers: 'none' | 'single' | 'both'
  readonly wrap?: boolean
  readonly currentLine?: number               // newNo 计
  readonly skip?: boolean                     // 屏外行 content-visibility(查看器的 VIEWER_SKIP_LINES 语义)
  readonly testId?: string                    // 宿主的 data-testid(查看器要保住 viewer-code 那一套属性)
  readonly rowAttrs?: (line: CodeLine, index: number) => Record<string, string | undefined>  // 宿主往每一行挂 data-*
}
```

三条硬规矩,全部落在 `CodeLines.module.css`,消费方一行样式都不写:

1. **横滚纪律**:滚动容器归宿主;`CodeLines` 自己的根 `min-width: max-content`,加删底色铺到最长那行;行号列 `position: sticky; left: 0`,带着自己那一行的底色(加 / 删 / 未改三档)。
2. **整数行高**:`--code-line-h` 一个 token(取今天三处最接近的整数;像素变化按收敛战役纪律**列明**,是规范修正不是漂移);`align-items` 不用 baseline,行号列与内容同一行高。分数行高 + 逐行 containment 的那道缝(`592103be9`)从根上除掉。
3. **跳过屏外行**:`skip` 打开时每一行 `content-visibility: auto; contain-intrinsic-size: auto var(--code-line-h)` —— 行高整数了才许逐行,判词写在样式上。

查看器今天依赖的 DOM 契约要**原样保住**:`data-testid="viewer-code"`、`data-viewer-lines`、`data-viewer-skip`、每行 `data-line` / `data-current`、`.lineSkip` 语义 —— 真机门(`gate:files` / `gate:focus` / `gate:a11y` 第 9 屏)与单测按它们取件。用 `testId` / `rowAttrs` 两口传进去,不在 `CodeLines` 里写查看器的名字。

## 3. 分批

| 批 | 内容 | 门 |
| --- | --- | --- |
| ① 抽件 | 新 `content/code/{CodeLines.tsx,CodeLines.module.css,highlight.ts}`;`blocks/kinds/code/highlight.ts` 改成再导出;代码块与查看器改消费 `CodeLines`;`--code-line-h` token | **迁移 = 等价替换**:真机逐态截图对照(代码块:短 / 长 / 无 lang / 横滚;查看器:折行开关 / 当前行 / 两万行跳过),像素差只许是行高整数化那一条并逐条报;壳 vitest 全绿;`gate:files` / `gate:focus` / `gate:a11y` 既有屏;`gate:chat-layout` 第五轴不退 |
| ② diff 接件 | `Diff.tsx` 的行交 `CodeLines`(`numbers: 'both'`,`oldNo` 由 `hunk.oldStart` 推,`mark`);逐行高亮(lang 由 `model.file` 的扩展名经 `languageIdOfExtension` 得,无 lang 纯文本);`.hunk` 盒与 `.hunkHead` 留着(聊天里的 diff 块仍是 hunk 模型);`Diff.module.css` 只剩 hunk 头那几条 | 单测(`block-shell.test` 那句「code 与 diff 同一条配方」改成断言两者都经 `CodeLines`);`gate:changes` 既有六步照过;dpr-2 缝数 0(量法在 `592103be9` 的提交信息里) |
| ③-a 后端 | `git:` 加读法 `file`:query `{ path }`,result `{ path, head: FileText \| null, work: FileText \| null }`,`FileText = { text, binary, truncated, bytes }`;head 经 `git show HEAD:<path>`(不在 HEAD = null,空仓 = null),work 经 fs(盘上没有 = null);`GIT_FILE_MAX_BYTES` 1 MiB 各自截断到最后完整行;NUL = binary 且 text 空;目标文件过 `resolveReadable` 三关(与 `diff` 读法同一句);`status` 结果每行多一格 `lang?`(扩展名 → 语言 id 的映射**不在后端**,壳自己用 `languageIdOfExtension`;这一格删掉,只是提醒别加) | vitest:六种状态各一例(modified 两版都在 / added 只有 work / deleted 只有 head / renamed 按新路径 / untracked 只有 work / binary);敏感文件拒;越界拒;1 MiB 截断;spec 契约用例;read-guard 不变 |
| ③-b 壳 | `content/code/line-diff.ts`(Myers O(ND),先查 `apps/desktop-react` 依赖里有没有现成 `diff` 包,**有就用,没有自己写**,两百行内,含单测:空 / 全同 / 全换 / 首尾增删 / 交错 / 两万行性能 ≤ 50ms);`data/changes-source.ts` 加 `fileQuery(root, path)`(与 `diffQuery` 同形,run/end 一并刷新);`ChangeFileView.tsx` 替换 `ChangeBody`:檐(路径 + ±统计 + `IconButton` ↑ / `k / N` / ↓;N = 改动块数,块 = 连续的 add/del 行)、`CodeLines`(`numbers: 'both'`,`skip: true`)、右缘 `ChangeMap`(每块一格,按行号比例定位,点一格跳过去);↑↓ 只滚自己那一格(不 `scrollIntoView`),当前块首行 `data-current`;删除文件只有 head(整篇 del),新增文件只有 work(整篇 add),二进制一句话;`diffQuery` 与 `changes-body-*` 四态用例改成 `file` 的;`ChangeList` / `ChangesHeader` 不动 | 三张状态表(生命周期 / UI 生命 / 交互)重填;`gate:changes` 改:① diff 体含那一行 → 整文件行数 = 文件行数且改动行有 `mark`;新 ⑦ ↑↓ 循环与计数 `1 / N`;⑧ 横滚 600px 后行号列左缘贴容器、加删底色宽 = 内容宽;⑨ dpr-2 缝数 0;⑥ 第五轴改量「两千行文件 + 两千处改动」的首帧 / 上屏,`BUDGET` 吃原数,达不到的进 `TRANSITIONAL` 写退场判据;`gate:a11y` 第 10 屏照扫 |
| ④ 行评论 | 另写正本(`composer-references` 加一种 `diff-range` 引用);坐标 = `{ root, path, newNo 范围 }`,③ 落地后才有 | — |

**派工顺序**:③-a 与 ① 并行(后端 / 壳互不相碰)→ ② → ③-b。每单交卷 Fable 亲审,haiku 提交,worktree `changes-file-view`。

## 4. 拍点(已定,不再问)

| # | 变化 | 定 |
| --- | --- | --- |
| 1 | 改动面形态 | 整文件唯一形态,不折叠,hunk 头不存在 |
| 2 | 改动导航 | ↑ `k / N` ↓,图标钮,计数保留;右缘改动地图 |
| 3 | 聊天里 diff 块 | 接件后开语法高亮 |
| 4 | 行高 | 统一整数 token,像素变化逐条列 |
| 5 | 横滚 | 文本行按内容宽,UI 带按视口宽粘左 |

## 5. 留账

- ↑↓ 的快捷键(F7 / ⇧F7 之类)不在本单;要加 = `keymap/commands.ts` 一行 + 改动面 `commands` 一格。
- 两份原文各 1 MiB 上限;超过的文件只画一句「太大」。
- 逐行高亮不带跨行语法状态(与 GitHub 同);整文件那一路是整篇高亮,不受此限。
- diff 块的 hunk 头画法(A–E)随整文件裁定作废,聊天里那块保持 `@@` 原文一行不动。
- **两万行文件在查看器里多出约 20k 个 DOM 节点(+22% 上屏耗时)**(批 ① 实测:
  160,001 → 180,001 节点,~1490ms → ~1820ms)。产地是 `CodeLines` 里正文那一层
  包裹 span —— 一行是 flex 行盒(行号列要粘左、正文要在折行档里伸缩),而 flex 容器
  会把每一段连续文本、每一个 token span 都变成独立的 flex 项,不裹起来就是几十个
  各自成盒的 token。查看器本来就不虚拟滚动,这一档不在任何门的预算表里;**接受**,
  记在这儿,要治得治「查看器该不该虚拟滚动」那件事,不是把包裹层拆掉。

## 6. 批⑤:列表与正文拆开 —— 改动面只剩文件列,看一个文件的改动 = 开一格内容,落点走「文件打开方式」(2026-09-14 用户提出)

用户原话:「能否把这个 diff 的文件列表和文件拆开?查看文件的 diff 走默认的文件的 tab 行为?」答案是能,而且形是现成的:目录面板点一个文件开的是 `file:<path>` 这一种内容,落在哪由 `data/file-open-mode.ts` 的七档(`panel` / `stage` / 四条边 / `float`)说,`panel` 档是在目录面板自己里面分栏。改动面照抄这一套,一个字不另起。

### 6.1 对象

| 对象 | 住哪 | 职责 |
| --- | --- | --- |
| `change` 内容种类(新) | `content/kinds/change.tsx` + `change-ref.ts` | 一个文件的整文件改动视图。`key` 的产地只有 `change-ref.ts` 一处(`changeRef(root, path)` / `changeRootOf` / `changePathOf`),形状必须经 `refId → parseRefId` 与拼贴树落盘往返不失真(用例钉);`singleton: false`、`level: 'space'`、`focusInto: 'diff'`、title = 文件名(tip 全路径 + 「改动」)、icon 走 `tabIconOf(文件名)`(它是「这个文件」不是「改动这件事」,标签上认文件);**不是伴随面**(它是人开出来的,与 `file` 同一档);`render` = `<ChangeFileView root path />` |
| `ChangeFileView` | 原地,**改成自足**:只收 `root` + `path`,自己 `useFileLive` + `fileQueryOf` + 从 `statusQuery` 里取自己那一行的 ± 与状态(行没了 = 「此刻没有改动」空态,tab 不自动关) | 檐 / 体 / 地图一字不改 |
| `ChangesPanel` | 原地 | **缺省只有文件列**(`ChangeList` 铺满,无分隔杆、无内联体);行的**单击与 ↵ 走同一条路**开 `change:`(照 `FilesPanel` 的 `onActivate(viaKeyboard)`:单击开、焦点留列;↵ 开、`activateScope('diff', { reason: 'open' })` 送焦点进那一格,`wantViewer` + `openTick` 那一套原样照抄);打开方式 = `useFileOpenMode` 那一格(**与文件共用同一档,不另立设置**);`panel` 档 = 今天的分栏内联(列 + `Splitter` + `ChangeFileView`),内联着哪个文件是这块面的**瞬态**本地状态(不落盘),行的开态点(`data-file-open`)由 `openStateOf(changeRef)` 或「内联着的就是它」答 |
| 行的右键菜单(新) | `ChangeList` 行 | 动作单产地:「打开改动」(缺省档)/「在查看器里打开文件」(`openFileInCurrentTarget`,已删除的文件灰)/「打开方式」子菜单(与目录面板同一张七档表,写同一格 `useFileOpenMode`)/「在文件管理器里显示」(`revealMutation`);**双击退役**(壳禁令) |

### 6.2 不变的

`diff` 种类(列表面,伴随会话 workdir)、`companion.seed`、`changes-source` 的三本在场账、run/end 刷新、`CodeLines` / `line-diff` / `ChangeMap`、`git:` 后端。

### 6.3 门

- 单测:`change-ref` 往返;`change-kind`(title / icon / focusInto / 不是伴随面);`changes-panel.test` 改:缺省零 `changes-body`、单击 → `workbench.openRef(changeRef)` 一次且 region 按档、↵ 多一发 `activateScope('diff')`、`panel` 档内联体在场、右键菜单四项、双击零处理器。
- `gate:changes`:①「点瓦 → 列」不变;新 ①-b 点第一行 → 中央区多一格 `change:` 标签且 `changes-body` 在那格里;②–⑤ 不变;⑥–⑨ 的量法把「面板里的 `changes-body`」换成「打开出来那一格里的」;新 ⑩ 把打开方式切到 `panel` → 点行 → 面板里长出分栏、中央区不多格;⑪ ↵ 之后 `document.activeElement` 在 `[data-focus-scope="diff"]` 里、单击之后仍在列里。`gate:a11y` 第 10 屏加扫打开出来的那一格。
- 三张状态表重填(`ChangesPanel` 两档形 × `ChangeFileView` 自足后的生命周期)。

### 6.4 留账

- 「打开方式」与文件共用一格是**裁定**:用户说「走默认的文件的 tab 行为」,分开设就是两处会漂的偏好。
- `change:` 标签在文件被撤销改动后留着显示空态,不自动关 —— 自动关等于替人关标签。
