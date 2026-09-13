# 快捷键按内容分派:从「各面自报键位」到「命令一张表、响应者认领」(2026-09-12)

起因:用户报「焦点在浏览器里按 ⌘T,该开的是一格新浏览器标签,不是一条新会话」,并要求整体调查
快捷键在全局 / 标签 / 内容三级上的行为,给一份符合人类使用习惯的方案。

## 0. 一句话

今天一个键的意义散在五个产地(全局命令表、七块面各自的局部键表、终端礼让表、Electron
默认菜单、以及「没人认领所以掉给页面」这一档),没有一个人持有「⌘T 是什么」这句话。
方案是把**键**与**意义**拆开:**每个键只对应一条具名命令**(如 `tab.new`),
**谁在活动路径上就谁来做**(浏览器叶答「开一格新标签」、终端叶答「开一格新终端」),
**做不了才落到应用层**(只有真正全局的命令有这一层:呼出一块面、切工作区),**再做不了就放行**给页面 / PTY / 系统。
「新建」两个键(⌘T / ⌘N)**没有**应用层兜底(09-12 用户裁定):焦点在哪种内容里就新建哪种,不在内容里就不响。
这就是 macOS 的响应者链(responder chain:一次按键从第一响应者往外问,谁认得就谁做)
在壳里的形;派发器、活动路径、三层立法一个字不动,动的只是「表长什么样」。

## 1. 调查:今天的机制(事实,不评价)

**骨架(09-01 / 09-02 立法,`CLAUDE.md`「快捷键三层」+「响应链」)**:全壳唯一派发器
`src/focus/dispatch.ts`(window 捕获相位一条 keydown),沿活动路径由深到浅问每格作用域的
局部键表,都没接住才问全局命令表。三层:①全局档 `keymap/transitions.ts` `KEYMAP_COMMANDS`,
可改绑;②面域局部键,声明在 `focus/scopes.ts` `FOCUS_SCOPES[id].keys`,落点是实例注入的
`keyHandlers`,**不可改绑**;③结构键(方向 / ↵ / Space / Tab / Esc)不进表。

**全局档出厂键(13 条)**:`toggle:search` ⌘P、`toggle:terminal` ⌃\`、`toggle:sessions` ⌘E、
`toc.toggle` ⌘⇧O、`agent.menu` ⌘J、`session.new` **⌘N**、`workbench.toggleFull` ⌘⇧↵、
`workspace.palette` ⌘⇧W、`workbench.moveTabLeft/Right` ⌘⌥⇧← / →、`workspace.slot:1/2/3`
⌘1 / 2 / 3、四条架子 ⌘⌥← → ↓ ↑。其余 Dock 瓦(files / diff / browser / music / settings)
出厂未绑。

**面域局部键全表(`FOCUS_SCOPES`)**:

| 作用域 | 键 | action | 备注 |
| --- | --- | --- | --- |
| viewer | ⌘S / ⌘L / ⌘F | save / jump / find | labelKey `viewer.*` |
| files | ⌘I / ⌘↵ | detail | 两行同一动作 |
| search | ⌘[ / ⌘] | history.back / forward | 查询历史 |
| expose | ⌘⇧P | pin.toggle | 会话总览置顶 |
| leaf | ⌘W | closeTab | 拼贴台一片叶(标签条) |
| browser | ⌘L / ⌘F | address / find | 同时是原生视图保留键 |
| terminal | ⌘F + (Win/Linux) Ctrl+P/E/J/N/W | find + `pty:<letter>` | 礼让表:接住什么都不做,交给 PTY |

**每格作用域的 `keyHandlers` 是动态的**:`routeKey` 只在 `node.keyHandlers[action]` 存在时才算
命中(叶没有活动 tab 时 `closeTab` 是 `undefined`,⌘W 穿过去)。这一点方案要保留。

**原生视图键位下沉(`content/native-view/keymap-downlink.ts` + `electron/browser/keymap-bridge.ts`)**:
渲染进程把「已绑定的组合键」(全局命令 ∪ `browser` 作用域局部键)整表推给主进程;
`WebContentsView` 的 `before-input-event` 里,在表里的键 `preventDefault` 并推回壳走唯一派发器,
不在表里的键页面自己吃。

**内容种类注册表(`workbench/kinds.ts` `registerContentKind`)**:每种内容(session / file / dir /
terminal / browser / panel / pair)自述 `singleton / level / title / icon / render / focusInto /
beforeClose / dispose / companion / composite / fullable / tabWide`。**这张表今天没有任何一格与键盘有关**。

**应用菜单:壳没有设**(`electron/main.ts` 只 import `app / BrowserWindow / ipcMain`,全 `electron/`
零处 `Menu`)。按 Electron 文档(`electron.d.ts` `setApplicationMenu`:「The default menu will be
created automatically if the app does not set one. It contains standard items such as File, Edit,
View, Window and Help」),**Electron 的默认菜单在场**。macOS 默认菜单的加速键:File→Close ⌘W;
View→Reload ⌘R、Force Reload ⇧⌘R、Toggle DevTools ⌥⌘I、Reset Zoom ⌘0、Zoom In ⌘+、Zoom Out ⌘−、
Toggle Full Screen ⌃⌘F;Window→Minimize ⌘M;App→Hide ⌘H、Quit ⌘Q。菜单加速键在页面**没有**
`preventDefault` 时才触发(Electron `before-input-event` 文档原话:preventDefault「prevents the page
keydown/keyup events and the menu shortcuts」),所以叶接住的 ⌘W 不会关窗,但没人接的 ⌘R 会。

## 2. 问题清单(每条带证据与后果)

**P1 · ⌘T 无人认领。** 它既不在全局表(`session.new` 是 ⌘N)也不在任何局部表。焦点在浏览器页面里按
⌘T:不在保留表 → 页面自己吃 → 页面不处理 → 默认菜单也没有 ⌘T → **什么都不发生**。焦点在壳里按
⌘T:派发器走完两层没命中 → 不 `preventDefault` → 同样什么都不发生。用户感觉「开了一条会话」的那一下
多半是 ⌘N(它是全局键,在浏览器里也响)。两个事实合起来就是报障:**「同类再开一格」这件事今天没有
名字**,于是既开不出浏览器标签,也没法说清 ⌘N 在浏览器里该不该开会话。

**P2 · Electron 默认菜单是一张没人审过的全局键表,而且它的目标永远是整台壳。**
焦点在网页里按 ⌘R(全世界浏览器的「重载这一页」):不在保留表 → 页面不处理 → 默认菜单 Reload →
`BrowserWindow.reload()` → **重载整台壳**:所有终端 detach(`electron/terminal-reload.ts` 就是给这件事
收尸的接线)、所有浮窗 / 拼贴树重建、在飞的流式回复丢 UI 状态。⌘+ / ⌘− / ⌘0 缩放的是壳而不是网页。
⌘W 在焦点落在 Dock / 设置 / 会话总览(没有叶在活动路径上)时是 **Close Window**。⌥⌘I 在 prod 包里照样
开壳的 devtools。这一条**真机未量**,是按上面引的 Electron 文档推断的;K1 的门第一步就是把它量出来。

**P3 · 同一件事在不同面是三行三个名字三个键,靠人手对齐。** ⌘F 在 viewer / terminal / browser 三格各
一行,labelKey 三句(`viewer.findLabel` / `terminal.find` / `browser.find`),combo 各写一遍;⌘L 两行;
⌘[ ⌘] 在 search 是「查询历史」,浏览器的「后退 / 前进」还没做,做的时候会是第三个产地。
「撞车表」(`scopedCollisionsOf`)把这件事当**事实**列给设置页——但它列的正是本该是**设计**的东西:
「查找在每块面里都是 ⌘F」不该是三行恰好相同的巧合。后果一:局部键不可改绑,用户把某条全局命令改到
⌘F,设置页只会说「被占着」,三块面里 ⌘F 仍各行其是。后果二:加一块面要「找到」每个约定俗成的键再抄
一遍。

**P4 · 标签级命令整族缺席。** 拼贴台的叶(`leaf` 作用域)今天只有 ⌘W。没有:新标签(⌘T)、
切上一 / 下一标签(⌘⇧[ / ⌘⇧] 与 ⌃Tab / ⌃⇧Tab)、重开刚关的标签(⌘⇧T)、按序号切(⌘1–9,
但它们已被工作区槽位占着——08-31 拍板)。浏览器标签**就是**拼贴台标签(`browser-launcher.ts`
`placeBrowserTabNear` → `moveRefIntoLeaf(browserRef(tabId), leafId)`),所以这一族一旦立在叶上,
浏览器 / 终端 / 会话三种内容同时得到。

**P5 · 应用级命令在内容里「越级」响。** 「保留键先于页面」把**全部**已绑定的全局键都截在页面前面:
网页里按 ⌘P(浏览器惯例 = 打印)弹的是 onething 的检索面;按 ⌘E 弹的是会话总览。这与 Chrome 的做法
一致(Chrome 也不让网页拿走 ⌘P),但今天这个「一致」是副作用不是决定——命令表上没有「这一条要不要
先于页面」这一格。

**P6 · 礼让表被塞进了「局部键」的形。** 终端在 Win / Linux 上的 Ctrl+P/E/J/N/W 是「这个键归 PTY,
应用别碰」,实现成「局部键 + 一个把控制字节写回 PTY 的 action」。它与「查找」不是一类东西:一个是
**认领并放行**,一个是**认领并执行**。模型里要能说出这两类,否则下一个 `Esc 归页面` 之类的声明又要
找地方塞。

**P7 · 结构:声明按面枚举,意义各面自造。** `ScopedKey { scope, combo, labelKey, action }` 把
「哪块面」写死在声明里;加一种内容 = `scopes.ts` 加行、`types.ts` 加格、i18n 加句(封闭表,这是
09-02 有意的),但**键位语义**仍要那块面自己发明并自己保证与邻居一致。设置页的「谁在用 ⌘F」是事后
从撞车里推出来的。

## 3. 参照:人类在 macOS 上已经养成的手(跨应用对照)

| 键 | Safari / Chrome | Terminal / iTerm | VS Code | Claude / ChatGPT 桌面 | 本壳今天 | 本壳应当 |
| --- | --- | --- | --- | --- | --- | --- |
| ⌘T | 新标签 | 新标签 | 新文件(无标签义) | — | 无 | **同类再开一格**(标签级) |
| ⌘N | 新窗口 | 新窗口 | 新文件 | 新对话 | 新会话(全局) | **新建这一种内容**(响应者级,不再全局;09-12 用户裁定) |
| ⌘W | 关标签 | 关标签 | 关编辑器 | 关窗 | 关标签(叶) | 关标签(叶,不变) |
| ⌘⇧T | 重开关闭的标签 | 重开 | 重开编辑器 | — | 无 | 重开(标签级) |
| ⌘⇧[ ⌘⇧] | 上 / 下一标签 | 上 / 下一标签 | 上 / 下一编辑器 | — | 无 | 上 / 下一标签(标签级) |
| ⌃Tab ⌃⇧Tab | 下 / 上一标签 | 下 / 上一标签 | MRU 切换 | — | 无 | 同上(第二组键) |
| ⌘1–9 | 第 n 标签 | 第 n 标签 | 第 n 编辑器组 | — | 工作区 1–3 | **焦点叶的第 n 标签**;工作区槽位出厂解绑(09-12 用户裁定,推翻 08-31) |
| ⌘R | 重载页面 | — | — | — | **重载整台壳** | 重载**这块内容**;壳绝不重载 |
| ⌘F | 页内查找 | 查找 | 查找 | 查找 | 三面各一行 | 一条命令,三个响应者 |
| ⌘L | 地址栏 | — | 选整行 | — | 浏览器地址栏 / 查看器跳行 | 两条命令共用一键(不同时在场) |
| ⌘[ ⌘] | 后退 / 前进 | — | 缩进 | — | 检索面查询历史 | 一条 `nav.back/forward`,浏览器与检索面两个响应者 |
| ⌘+ ⌘− ⌘0 | 页面缩放 | 字号 | 编辑器缩放 | — | **缩放整台壳** | 浏览器页面缩放;别处放行(不缩壳) |
| ⌘P | 打印 | — | 快速打开 | — | 检索面(截在页面前) | **让出**:检索面改 ⌘⇧F(VS Code / JetBrains 的「全局搜索」同键),⌘P 出厂不绑(09-12 用户裁定) |
| ⌘, | 偏好设置 | 偏好设置 | 设置 | 设置 | 无(settings 瓦未绑) | 出厂绑 `toggle:settings` |

读法:**「新」这两个键都跟着焦点走,没有一条是全局的**(09-12 用户裁定:「我正在看浏览器,按了 ⌘N,
后面新建了一条会话,怎么个事」)。区别只在**摆法**:⌘T 是「在这一排里再来一格同样的」,永远是紧挨着当前
标签的一格新标签;⌘N 是「新建这一种内容」,按这种内容自己的打开方式摆——会话按 `sessions.openMode`
(缺省 replace),浏览器 / 终端本来就只有标签一种摆法,所以在它们里 ⌘N 与 ⌘T 同义。焦点不在任何内容里
(Dock、设置)时两个键都**不响**,不再兜底成新会话。

## 4. 模型:命令 + 响应者

四种对象,各住一处;派发器与活动路径原样。

**① 命令(`Command`,`keymap/commands.ts`,一张表)**。每条:`id`、`labelKey`、`defaultCombo`、
`app?: boolean`(应用层有没有兜底实现)、`nativeView: 'reserve' | 'yield'`(焦点在原生视图里时
要不要先于页面截下来)。今天 `KEYMAP_COMMANDS` 的 13 条原样进表(全是 `app: true`,`reserve`);
七块面的局部键**改写成命令**进同一张表:`view.find` ⌘F、`view.save` ⌘S、`viewer.gotoLine` ⌘L、
`browser.address` ⌘L、`files.detail` ⌘I / ⌘↵、`nav.back` ⌘[、`nav.forward` ⌘]、`expose.pin` ⌘⇧P、
`tab.close` ⌘W。**全部可改绑**(改的是命令的键,每个响应者自动跟着)。
**三条出厂键按 09-12 用户裁定改**:`session.new` 退役,换成响应者级的 `content.new` ⌘N(`app: false`,
会话叶 / 会话总览 / composer 答「新会话」,浏览器叶答「新标签」,终端叶答「新终端」);
`workspace.slot:1–3` 进表但**出厂不绑**,⌘1–9 给 `tab.select:n`(叶响应者);`toggle:search`
出厂键改 **⌘⇧F**,⌘P 出厂不绑。

**② 响应者(`Responder`)= 一格作用域实例**。`FocusScope` 的 `keyHandlers={{ action: fn }}` 改名
`commands={{ 'view.find': fn }}`,键是命令 id 而不是各面自造的 action 名。声明侧 `FOCUS_SCOPES[id]`
的 `keys` 换成 `answers: readonly CommandId[]`(「这种面**可能**答哪些命令」,给设置页画「谁答」那一
列用,不需要实例在场);实例侧照旧动态——`commands[id]` 缺席就是「此刻答不了」,派发器穿过去。

**③ 认领(`KeyClaim`)**。作用域声明 `claims: readonly Combo[]`:「这几个键归里面那台程序,壳别碰」。
派发器命中 claim 时**不 `preventDefault`、不再往外问**,让事件照常落到 xterm / 页面。终端礼让表就是
它(五个 `pty:x` action 与 `controlByteOf` 一起退役——xterm 本来就会把 Ctrl+P 写成 `\x10`,壳今天是
先截下来再自己写一遍)。它不是命令,不进设置页的改绑表,但设置页的「谁答」列会说「终端里这个键归 PTY」。

**④ 内容种类的键盘能力(`ContentKind` 加字段,`workbench/kinds.ts`)**:
`spawn?(ref): Promise<ContentRef | null>`(同类再开一格,返回新那一格的 ref,叶把它摆到活动 tab 旁边)、
`snapshot?(ref): unknown` + `restore?(snapshot): ContentRef | null`(重开关闭的标签——浏览器关 tab 是
删行,重开要靠 url 快照;会话 / 文件 / 终端的 ref 本身就是快照,`snapshot` 缺席 = 用 ref)。
**叶是这些能力的唯一读者**:`tab.new` 的响应者是叶,它问活动 tab 的种类有没有 `spawn`;有就调,
没有就答不了(`commands['tab.new']` 为 `undefined`)让给应用层。**core 里不出现任何种类的名字**。

**派发(`routeKey` 改一处)**:

```
onKeyDown(e):
  candidates = 绑到这个键上的全部命令(一个键可以绑多条,见冲突规则)
  for node in activePath 由深到浅:
    if node.claims 命中 → return(不 preventDefault)
    for c in candidates: if node.commands[c] → run, preventDefault, return
  for c in candidates: if c.app → runShellCommand(c), preventDefault, return
  放行(不 preventDefault:页面 / PTY / 系统菜单接着走)
```

**冲突规则(一条,`bindCombo` 与出厂表同用)**:一个键上的多条命令,**`app: true` 的至多一条**,
其余每两条的 `answers` 作用域集合必须**两两不交**(不同时在场才许共键)。⌘L 上 `browser.address`
与 `viewer.gotoLine` 合法(browser 与 viewer 不会同在一条活动路径上);用户把 `toggle:search` 改到
⌘F 合法(它是唯一 app 级,三块面在场时局部先接);再把 `session.new` 改到 ⌘F 被拒。
`scopedCollisionsOf` 退役,换成 `answerersOf(commandId)` 投影:设置页一行一命令,右侧列「谁答」——
「查找 ⌘F:浏览器(这一页)/ 终端(这块屏幕)/ 查看器(这份文件)」。三句话仍是三句(i18n 纪律),
挂在**响应者**上(`answers` 的每一格可带 `labelKey` 覆盖),不再各绑一次键。

**原生视图保留表**从命令表派生:`nativeView === 'reserve'` 且已绑定的键 ∪ 在场作用域的 claims 取反
(claims 不下沉,页面本来就该拿到)。`boundChordsFor` 只是换了输入。

**应用菜单(主进程)**:壳自己设 `Menu`,把默认菜单里那张没人审过的键表拿掉。第一步只做减法:
`appMenu` + Edit(`undo/redo/cut/copy/paste/selectAll` 角色——**没有它们 macOS 上输入框里 ⌘C/⌘V 不
工作**)+ Window(`minimize/zoom/front`)+ Help;**不放** File→Close、不放 View 的 reload / zoom /
devtools(dev 档保留 Toggle DevTools 与 Reload,键改到 ⌥⌘I / ⌥⌘R 之外的 ⌃⌥⌘R,避免与内容命令撞)。
第二步(K4)把命令表推给主进程画成菜单栏(标签 / 键位 / 响应者说明都从同一张表来,菜单点击推回壳走
唯一派发器),用户在菜单栏上就能看见「⌘T 新标签」——这是 macOS 用户找快捷键的第一反应。

### 4.1 面向对象审核

| 对象 | 职责 | 今天散在 |
| --- | --- | --- |
| `Command` / `CommandTable` | 键 ↔ 意义,唯一;绑定、冲突、有效键 | `KEYMAP_COMMANDS` + 七处 `keys` + 礼让表 |
| `Responder`(作用域实例) | 「我此刻能做哪些命令」 | `keyHandlers` 按各面自造的 action 名 |
| `KeyClaim` | 「这个键归里面」 | 伪装成局部键的 `pty:x` |
| `ContentKind` | 种类自述:能不能再开一格、怎么快照 | 无(`spawn` 的知识散在 `*-launcher.ts` 与 `+` 钮 `onClick`) |
| `Dispatcher` | 沿活动路径问候选命令 | `routeKey`(改一处) |
| `AppMenu` | 系统菜单栏 = 命令表的另一种投影 | Electron 默认菜单(未审) |

可迭代性:新命令 = 表里一行;新响应者 = 那块面 `commands` 里一格;新内容种类的「再开一格」= 它自己的
manifest 一格。可扩展性:`nativeView` 与 `app` 两个轴是数据,派发器不读任何命令名。

### 4.2 陌生能力演练(仓根 CLAUDE.md 09-02 法)

演练一:**加一个 PDF 查看器**,要 ⌘F 页内查找、⌘+ / ⌘− 缩放、⌘R 重读文件、⌘T 再开一份同目录的 PDF。
要改的文件:`content/kinds/pdf.tsx`(manifest:`focusInto: 'pdf'`、`spawn`)、`content/pdf/PdfLeaf.tsx`
(`<FocusScope scope="pdf" commands={{ 'view.find', 'view.zoomIn', 'view.zoomOut', 'view.reload' }}>`)、
`focus/scopes.ts` 一行 + `focus/types.ts` 一格 + i18n 一句(作用域封闭表,09-02 有意)。
`keymap/commands.ts`、`focus/dispatch.ts`、`KeymapSettings.tsx`、`keymap-downlink.ts`、主进程:**零改动**。
设置页自动多出「查找 ⌘F — 也在:PDF」。通过。

演练二:**加一条新命令 `tab.duplicate` ⌘⇧D**(复制当前标签)。`keymap/commands.ts` 一行(`app: false`,
`reserve`)+ `PaneLeaf.tsx` `commands` 一格(读活动 tab 种类的 `spawn`,与 `tab.new` 同一条路)。
设置页、保留表、菜单栏自动带上。通过。

演练三:**Esc 归页面**(浏览器今天靠「不声明 `onEscape`」表达)——不属于本模型,留在 Esc 那条独立的
结构键路径上;本方案不动 §4.4。写出来是为了说明边界:claims 只管带修饰的组合键,结构键不进任何表的
第三条立法不变。

## 5. 分期(每期结束壳都能用,行为变化逐条列)

**K0 · 表合一(零行为变化)。已入库 `24e7ff3bb`(2026-09-12;与派工偏差:`claiming` 实例开关、保留表判据保留「在场作用域答得出」那一半、`effectiveCombos` / `lookupCommands` 改名、`keymap/platform.ts` 断环)。** `keymap/commands.ts` 立命令表;`ScopedKey` 退役,七块面的局部键改写成
命令行 + `answers`;`keyHandlers` → `commands`;`routeKey` 改候选命令;`lookupCommand` 返回候选集;
冲突规则落到 `bindCombo`;`scopedCollisionsOf` → `answerersOf`;设置页一行一命令 + 「谁答」列;
`keymap-downlink` 换输入;礼让表改 `claims`(Win / Linux 行为逐字不变:那五个键仍到 PTY)。
门:比对表用例——旧表每一条 `(scope, combo, action)` 在新表里都有唯一的 `(command, responder)`;
`gate:focus` / `gate:terminal` / `gate:browser` 全绿;设置页截图逐态对照(组件收敛纪律)。
反证:拆冲突规则 → `bindCombo` 用例红;拆 `claims` 分支 → Win 档终端 Ctrl+P 用例红。

**K1 · 应用菜单接管(行为变化:⌘R / ⌘+− 0 / ⌥⌘I 不再作用于壳;无叶在场时 ⌘W 不再关窗)。已入库 `08e04dcc9`(2026-09-12;P2 真机量实——默认表原样贴在提交信息里;⌃⌘F 全屏放回 Window 菜单;`KEYS_RESERVED_FOR_CONTENT` 七条是「还给内容层的键」唯一产地)。**
`electron/app-menu.ts`(纯模板函数,零 electron import,单测钉「没有 reload / close / zoom 角色」),
`main.ts` 一行 `Menu.setApplicationMenu(buildAppMenu({ dev }))`。
门:`gate:browser` 加一条——页面焦点下按 ⌘R,壳的 `did-start-navigation` **不**发生,页面的发生;
壳焦点下按 ⌘R 什么都不发生。**先量后改**:这一步开工第一件事是在现壳上把 P2 真机量出来。
反证:去掉 `setApplicationMenu` 那一行 → 门红。

**K2 · 标签族命令(行为变化:⌘T / ⌘⇧T / ⌘⇧[ ] / ⌃Tab 生效)。已入库 `cf67077a4`(2026-09-13;与派工偏差:`Combo.offHand` + 出厂表 `byPlatform` 分档、`expose` / `composer` 也落 `content.new` 的 handler、`NATIVE_VIEW_HOST_SCOPES=['leaf']` 让叶那一族在网页焦点下也到得了主进程、终端重开走 `spawnTerminalAt(cwd)` 新壳;留账:录制录不出 `offHand` 归 K5,四条无用 i18n 键待删)。** 命令表加 `tab.new` ⌘T(`app: false`,
没有内容在场就不响)、`tab.reopen` ⌘⇧T、`tab.next` ⌘⇧] 与 ⌃Tab、
`tab.prev` ⌘⇧[ 与 ⌃⇧Tab(一条命令两个出厂键——表要能一行两键,或两行同命令;取**两行**,与 `files`
那两行同判例:表要能逐条说出「⌃Tab 被谁占着」)、`tab.select:1–9` ⌘1–9(叶响应者,`9` = 最后一格,
浏览器惯例)、`content.new` ⌘N(见 §4)。同批把 `workspace.slot:*` 与 `toggle:search` 的出厂键改掉
(解绑 / ⌘⇧F),`KEYMAP_PERSIST_VERSION` 升一版做迁移:用户没改过的键跟着出厂表走,改过的保留。`ContentKind` 加 `spawn` / `snapshot` / `restore`;
browser(`openBrowser({near})`,url 快照)、terminal(`openTerminal near`)、session(新会话)三种实现
`spawn`;`workbench/store` 加关闭栈(每叶,深 10)。叶响应者实现四条。`browser` 叶檐上的 `+` 钮改调
同一条 `spawn`(一件事一个产地)。
门:`gate:workspace` 加「浏览器叶 ⌘T 开出浏览器标签且在旁边、终端叶 ⌘T 开出终端、会话叶 ⌘T 开出
新会话标签、查看器叶 ⌘T 回落成新会话」四段;`gate:browser` 加「页面焦点下 ⌘T 同样成立」(保留表)。
反证:拆 `spawn` 读取 → 四段前三段红。

**K3 · 内容族命令统一(行为变化:浏览器 ⌘R 重载、⌘[ ⌘] 后退前进、⌘+ − 0 页面缩放;检索面 ⌘[ ⌘]
不变)。 已入库 `a56c11c50`(2026-09-13;`zoom` op 归 `ui_change`、梯子一个产地 `nextZoomLevel`、无历史不交 `nav.*` 处理器;`nav.back/forward` 通名 `keymap.nav*`,检索面说法挂回 `answers`;`gate:browser` ㉓d 证「页面 `did-start-navigation` 1 次、壳 0 次」——P2 闭环)。** 命令表加 `view.reload`、`view.zoomIn/Out/Reset`;`nav.back/forward` 收编检索面的两条;
浏览器叶实现六条(`browserOps.reload/back/forward` 现成,缩放走 `resource-spec` 加 `zoom` 一个 op)。
门:`gate:browser` 各一条。

**K4 · 菜单栏从命令表画(行为变化:macOS 菜单栏列出全部命令与当前键位)。已入库 `265614e73`(2026-09-13;`keymap` 动词扩 `{chords, menu}`、`menu-projection.ts` 纯函数按 id 形状分四节、`routeCommand` 与 `routeKey` 同判据、`registerAccelerator: false` 全表、菜单点击经 `dispatchHostCommand` 走唯一派发器、㉕ 四句)。** `keymap` 下沉 verb 扩成
`{ chords, menu }`,主进程按表建菜单,点击推 `{ kind: 'command', id }` 回壳走 `runCommand`;改绑即重画。
这一期做完,「哪个键干什么」在设置页、菜单栏、保留表三处只有一个产地。

**K5 · 键位组与导入 / 导出(09-12 用户提出)。已入库 `2a2b327b3`(2026-09-13;三层落 `effectiveCombos`、内置三组按平台算、`bindCombo` 改追加一枚 + `removeCombo`、`comboFromEvent` 认 offHand、`keymap/chord.ts` 两向、`profile-io` / `import-vscode` / `profile-file`;K3 那四条内容族命令两组不映射——VS Code 的 reload / zoom 作用在整台窗口不是焦点内容;留账:VS Code 组 ⌥⌘→ 与右架子共键、chord 串平台解释过不跨机器、`gate:a11y` 不扫设置页快捷键屏)。** 改绑今天是「一格一格录」;用户要的是**成组切换**
(VS Code 组、JetBrains 组)与**从文件导入**。模型加一层:`KeymapProfile { id, name, bindings:
Partial<Record<CommandId, Combo | null>> }`,有效键 = 用户逐格覆盖 ▷ 当前键位组 ▷ 出厂表(三层,
缺席往下落,显式 `null` = 解绑)。内置三组:`default`(本文 §3「应当」列)、`vscode`、`jetbrains`——
只映射**有对应物**的命令,没有的留空往下落到出厂表,组文件里逐条写「来自哪条 VS Code 命令」以便核对:

| 命令 | default | vscode | jetbrains |
| --- | --- | --- | --- |
| `view.find` | ⌘F | ⌘F | ⌘F |
| `toggle:search`(跨会话检索) | ⌘⇧F | ⌘⇧F(Search) | ⌘⇧F(Find in Path) |
| `workspace.palette` | ⌘⇧W | ⌘⇧P(Command Palette) | —(⇧⇧ 双击表达不出,落到出厂) |
| `tab.close` | ⌘W | ⌘W | ⌘W |
| `tab.next` / `tab.prev` | ⌘⇧] / ⌘⇧[ | ⌥⌘→ / ⌥⌘←(另 ⌘⇧] [ 也是) | ⌃→ / ⌃←(Select Next/Previous Tab) |
| `tab.reopen` | ⌘⇧T | ⌘⇧T | — |
| `tab.select:n` | ⌘n | ⌘n(编辑器组序号,义近) | — |
| `viewer.gotoLine` | ⌘L | ⌃G | ⌘L |
| `toggle:terminal` | ⌃\` | ⌃\` | ⌥F12 |
| `toggle:sessions` | ⌘E | — | ⌘E(Recent Files,义近) |
| `toggle:settings` | ⌘, | ⌘, | ⌘, |

文件格式 = 同一个 `KeymapProfile` 的 JSON(`{ "name", "bindings": { "tab.close": "cmd+w", … } }`,
键写成 `chordOf` 那一份规范串,与下沉表同一套写法),**导入即多一组用户组**,不覆盖内置组;导出把
当前有效表整张写出去。**VS Code 的 `keybindings.json` 不直接吃**:它的 `command` 名与 `when` 子句
是 VS Code 的世界,硬映射只会得到一堆「没有对应命令」的行;做一个**转换器**(`command` → 我们的
`CommandId` 一张对照表,认不出的行原样列给用户看)作为导入的第二种入口,对照表就是上表那一列。
设置页:顶部一个「键位组」选择器 + 导入 / 导出两钮;逐格改绑照旧,改绑落在覆盖层,换组不丢。
门:三组文件全部通过冲突规则(单测);导入一份含未知命令的文件 → 列出未知行、已知行生效。

**K6 · 收口(零行为改动)。** 三件:①**法文改口** —— 壳 `CLAUDE.md` 的「快捷键三层」整节按 K0–K5 的终态
重写(命令表两轴 / `answers` 与 `claims` / `routeKey` 五问 / 冲突规则一条 / 有效键三层 / 保留表判据 /
应用菜单与 `registerAccelerator: false` / 出厂键一览与四条裁定 / 陌生能力演练),「响应链」那条 I5 与
「原生视图②」里 `FOCUS_SCOPES.browser.keys` 那个已退役的名字一并改口;②**删无用 i18n 键** ——
`keymap.conflict` / `keymap.scopedConflict` / `keymap.scopedNote`(K0 的 `conflictApp` / `conflictOverlap` /
`scopedNote2` 取代了它们)与 `session.new`(那条命令 K2 退役)四条,零读者,zh / en 成对删;
③**跑 `gate:packaged`** —— 这条线从 K1 起一直留账没跑的那道门。不动任何 `src/` 行为代码。

K0 是骨架,K1 独立(可先于 K0),K2 / K3 是「加行 + 加响应者」,K4 / K5 是投影与配置层,K6 收口。派工按用户的分工:
Fable 拆分审查、opus 执行、haiku 提交;每单交卷 Fable 亲自读 diff。

## 6. 拍板记录(09-12,用户口述,三条推荐全部被否)

1. **⌘N 不是全局键。** 用户:「我正在看浏览器,点了 ⌘N,后面新建了一条会话,怎么个事」。裁定:⌘N 跟焦点走,
   新建**这一种内容**;焦点不在内容里就不响。`session.new` 这条全局命令退役。
2. **⌘1–9 不给工作区槽位。** 用户:「非常讨厌这个设计」。裁定:推翻 08-31 那条,`workspace.slot:*` 出厂解绑
   (命令仍在,想要的人自己绑),⌘1–9 归焦点叶的第 n 标签,与浏览器 / 终端惯例一致。
3. **⌘P 不给检索面。** 裁定:检索面出厂键改 ⌘⇧F(VS Code / JetBrains 的全局搜索同键),⌘P 出厂不绑,
   在网页里自然回到页面(打印)。
4. **新增需求:键位组与导入。** VS Code 组、JetBrains 组可整组切换;可从文件导入。落在 K5。

其余取舍(菜单栏减法清单、⌃Tab 两行同命令、关闭栈深度、⌘T 与 ⌘N 的摆法差异)按 §4 / §5 所写直接做。

## 7. 留账

- P2 的「⌘R 重载整台壳」按 Electron 文档推断,K1 开工先真机量;若量出来默认菜单不在场,K1 只剩
  「补 Edit 角色」一件。
- `formatCombo` 在 mac 上把 Ctrl 画成 ⌘、`toggle:terminal` 出厂键读作「主修饰键 + 反引号」
  (T1 留账)未在本方案范围;K0 顺手不动。**K2 已结清两条**:`Combo.offHand` 让声明侧说得出
  「就是另一枚」而 `formatCombo` 据此在 mac 上画 ⌃ / 别处画 Win,`toggle:terminal` 走出厂表
  `byPlatform` 分档(两档写出来是同一个手势)。
- `⌘,` 绑 `toggle:settings` 只是出厂表加一格,归 K2 顺带。
- ⌘⇧F 是替 ⌘P 选的键,理由是两家 IDE 的「全局搜索」都是它;用户不喜欢换一格即可,一行的事。
- 浏览器关闭的 tab 没有历史(B3-b 留账)——K2 的 `snapshot` 就是给它补的那一格,不另起机制。
- 「焦点在 Dock / 设置里按 ⌘T ⌘N 不响」是裁定的直接推论;若真机用下来觉得空,补一条**响应者**(Dock 答「新会话」)而不是加回全局兜底。
- Esc 与结构键三层立法不动;本方案只改带修饰的组合键这一层。
