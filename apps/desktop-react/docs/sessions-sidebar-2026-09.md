# 会话侧栏(方向 A · 导航行)· 2026-09-12

正本。比稿页 `docs/sessions-sidebar-proposal-2026-09-12.html`(方向 A / B / C,用户 09-12 拍 **A**);代码在 `src/expose/`。

## 1. 起因与根因(09-12,四条报障全部离屏真机复现)

| 报障 | 根因 | 读数 |
| --- | --- | --- |
| 悬停的眼睛 / 图钉点不到 | `SessionRow.module.css` 悬停时 `.time { opacity: 0 }`,opacity < 1 让它成为独立层叠上下文,DOM 顺序在 `.actions` 之后 → 画在钮**上面**,透明但接鼠标;≥480 的 `.project` chip 同病 | 指针停在眼睛正中 `elementFromPoint` 答 `SPAN._time`;点眼睛进了会话,点图钉没置顶 |
| 标题只剩一点 | 页边距 16 + `scrollbar-gutter: stable both-edges` 两侧各 10 + 空的形态列 16 + 定宽时间 56 + 行内边距 / 间距 32 | 240 宽架子里标题 **83px(35%)** |
| 搜索区比列表宽 | both-edges 那 10px 两侧,工具栏没有 | 列表 x=26,工具栏 x=16 |
| 关不掉、改不了名 | 行菜单只有 打开 / 在右侧 / 在下方;后端 `sessions.rename` / `delete` / `updateArchived` 都在,壳没接 | — |

第一稿样例(同一设计换零件、搜索框仍是整条常驻输入框 + 下拉 + 加号)被用户否决;第二稿按随机长度标题出三个方向,用户拍 A。

## 2. 拍板

1. **方向 A 导航行**:顶部不是工具栏,是三行导航(新会话 / 搜索 / 项目),与会话行同形同左缘,没有常驻输入框。
2. **图标列的中心 = 左侧红灯的中心**(09-13 用户两次拿真机截图画线改正:第一版盒边对线、字再进 8;第二版墨的左缘对线;用户原话「红灯的中间跟图标的中间是对齐的」—— 中心对中心):`trafficLightPosition.x`(16)+ 半径 6 = **22px**。图标列宽 16 以线为中心(14–30);节名与没有图标的标题从图标列左缘 14 起;有图标的行文字在 38;盒子从 6 起(悬停薄膜探到图标列左边一格)。用户原话:「所有元素从这个位置开始,不要超过它」—— 「元素」指的是看得见的墨。
3. 悬停只出一颗 **⋯**,与右键弹同一张表;眼睛不再单独占一颗(Quick Look 进菜单,Space 照旧)。
4. 「在下方打开」名不副实(两格模型没有竖排,它做的是「开成一格新标签」),改名为它真做的事,不删。
5. 菜单补齐:打开 / 在右侧打开 / 在新标签页打开 / Quick Look / 关闭(开着才有)/ 置顶·取消置顶 / 重命名 / 删除(危险色,一次确认)。关闭 = 把这条从所有开着它的格子里摘掉,不删数据。

## 3. 形

两种形由**容器宽**决定(`@container expose`,阈值仍是 760 / `--expose-rail-bp`):

### 3.1 侧栏形(容器 < 760)

```
[红灯中心 x=22:图标列 14–30 的中心 ─────────────]
   ＋  新会话                          32px 导航行,图标 14–30,文字 x=38
   ⌕  搜索                     ⌘?     点它 = 原地变输入框,Esc 还原
   ▤  全部                      ▾     点它 = 范围表(与今天 Select 同一张表)
   置顶                                节头 26px,文字 x=14(图标列左缘),11px/600/.04em
   标题标题标题标题标题……        ●     行 32px,文字 x=14(盒 x=6),单行省略,不画时间、不画项目 chip
   ⚡ 标题……                          形态图标**只在有图标的行**上画(14px + 6 间距),普通聊天不预留
   标题标题标题标题标   [⋯]           悬停:⋯ 从右盖上来,渐变 26px 收掉标题尾巴
```

- 页边距:左 `calc(--content-lead-left − --expose-glyph-w/2 − --sp-2)`(6;行内边距 8 把图标列送到 14–30,中心 22),右 8;`scrollbar-gutter: stable`(只右侧)。
- 行:高 32、内边距 0 8、间距 6、圆角 `--r-1`;当前会话 `--st-sel`,悬停 `--st-hover`,叠加 `--st-sel-hover`;键盘活动行照旧 outline 环。
- 打开状态点 `ui/OpenDot` 照旧,在标题右、动作左。
- 节头:高 26、上边距 10(第一节 4)、文字 x=14;折叠箭头在**行尾**,悬停或已折叠才显。
- 子行(派工 / 执行)缩进 `--expose-indent` 照旧。
- 动作层 `.actions`:`position:absolute; z-index: 1`,**立在时间 / chip 之上**(§1 那条 bug 的修法);显形不再靠时间淡出,靠自己那条渐变。

### 3.2 总览形(容器 ≥ 760,浮窗 / 舞台)

维持今天的密度:行 40、页边距 `--expose-pad` 32、侧栏 Rail 在场、时间列与项目 chip 显示。变的只有三件:项目导航行隐藏(Rail 接管);动作 ⋯ 一颗(与侧栏形同一件);节头箭头挪到行尾。

## 4. 三张状态表 + 组件树

### 组件树

```
ExposeView(容器 expose,作用域根)
├─ Overview
│  ├─ Rail(≥760)
│  └─ main
│     ├─ NavRows(新,替代 Toolbar)
│     │  ├─ NewSessionRow      ui/ButtonBase,aria-busy
│     │  ├─ SearchRow          rest = ButtonBase;open = ui/Input(data-expose-search)
│     │  └─ ScopeRow(<760)    ui/ButtonBase,aria-haspopup,点开 ui/Menu
│     └─ SessionTree
│        ├─ SectionHead × n(箭头在行尾)
│        └─ SessionRow × n(⋯ IconButton 一颗;glyph 条件渲染;time / project 仅 ≥760)
├─ QuickLook(mode = quicklook)
└─ SessionActionsMenu(右键 / ⋯,同一张表)
```

### ① 生命周期

| 事件 | 行为 |
| --- | --- |
| 挂载 | 与今天同:`useExposeLive` 订阅、`AutoFocusSearch` 在面被摆出来那一拍 `activate('placement')`;落点见「落点」行 |
| 换宿主(架子 ↔ 浮窗 ↔ 舞台) | 只有容器宽变,形跟着 `@container` 切;树 / 面常驻,零重挂 |
| 架子改厚度 | 同上,连续值;<760 恒侧栏形 |
| 卸载 | 搜索态清空(`query`、`searching` 不落盘) |
| 落点(restingTarget) | 搜索输入框开着 → 它;否则 → 「搜索」导航行 |

### ② UI 生命状态

| 态 | 形 |
| --- | --- |
| empty | 三行导航照旧在,列表区那块空态文案不变 |
| loading(initial) | 同上,列表区「载入中」 |
| ready | 本文 §3 |
| error | 与列表并存的那一行错误照旧(Overview 里),内边距改 22 |
| 搜无结果 | 「没有匹配的会话」一行灰字 |
| 超量(400+ 行) | 冷开走 `gate:perf` 场景①预算(主线程任务 ≤50ms 长帧、端到端 ≤100ms);每行节点比今天少(无时间列、无第二颗钮、无预留 glyph),只许更快 |

### ③ 交互状态

| 件 | rest | hover | focus(键盘) | active / pressed | pending | disabled |
| --- | --- | --- | --- | --- | --- | --- |
| 导航行 | 文字 text-1 | `--st-hover` | 全局 focus-visible 环 | — | 新会话 `aria-busy`,文字不换、不禁灰 | — |
| 搜索行 → 输入框 | 行 | 行 hover | 输入框内焦点,↓/↑ 交树,↵ 进第一条,Esc 关 | — | — | — |
| 范围行 | 显当前范围名 | hover | 环;↵/Space 开菜单 | 菜单开着时 `aria-expanded` | — | — |
| 会话行 | 标题 | `--st-hover` + ⋯ 显形 | `[data-active]` 环 + ⋯ 显形 | 当前 `--st-sel` | — | — |
| ⋯ | 不可见 | IconButton 配方 | 不进 Tab 序(tabIndex -1;键盘走 ⇧F10 / 菜单键 / 右键) | 菜单开着时行保持 `menuOpen` 显形 | — | — |
| 节头 | 灰字 | 薄膜 + 箭头显形 | 环 | 折叠时箭头常显、转 -90° | — | — |

## 5. 分单

| 单 | 内容 | 超量格 |
| --- | --- | --- |
| **A1 侧栏形** | NavRows 替代 Toolbar;SessionRow 去时间列 / 条件 glyph / ⋯ 一颗 / 动作层 z-index;SectionHead 箭头行尾;容器查询两形;token `--content-lead-left: 22px`;菜单加 Quick Look、「在下方打开」改名;i18n;单测;门 `gate:sessions`(新)进 verify;既有门改口 | `gate:perf` 场景① 400 行冷开不退步(数字进交卷报);`gate:sessions` 在 240 / 320 两档量标题占比 ≥ 60% |
| **A2 动作面** | 菜单补 关闭 / 置顶 / 重命名 / 删除;workbench `closeRef`(regions → closeTab,hidden → dropHidden);`sessionMutation` 加 `rename` / `delete` 两种写;行内改名走 `ui/inline-edit`;删除走 `ui/Dialog` 的 `useConfirm`(`ConfirmHost` 今天只在测试里挂着,要挂进壳);`onSessionsDeleted` 那条接缝复用;门补三步 | 同上 |

顺序:A1 → A2(同一批文件)。执行 opus,Fable 亲审 diff,haiku 提交(独立 `GIT_INDEX_FILE`,逐文件 add,避开别批的脏文件)。

## 6. 门(`scripts/gate-sessions.mjs`,起法照 `gate-layout.mjs`:临时 store + 临时 udd + HEADLESS + CDP)

① 会话瓦钉到左架子、厚度拖到 240:导航三行图标与会话行字形列的中心 = 架子 x + 22、最左一笔墨 = 22 − 8、盒子最左 = 22 − 16,且红灯中心 = 同一个数(读 `--titlebar-traffic-w` 那一族与 main.ts 的 16 + 6 同源)。
② 240 / 320 两档:第一行标题 `clientWidth` / 行 `clientWidth` ≥ 0.6。
③ 悬停一行 → ⋯ 显形,`elementFromPoint`(⋯ 中心)=== 那颗钮;CDP 点它 → `[role="menu"]` 在场且首行是「打开」。
④ 点「搜索」行 → `[data-expose-search]` 在场且是 `activeElement`;输入词 → 行数减少并有 `<mark>`;Esc → 输入框消失、行数复原、焦点回搜索行。
⑤ 点「范围」行 → 菜单 → 选一个项目 → 只剩那个项目的行;范围行文字 = 项目名。
⑥ 拖到 ≥760(或撕成 900 宽浮窗):Rail 在场、范围行不在、时间列在。
⑦ A2:⋯ → 关闭 → 那颗点没了、中央区标签少一格;⋯ → 重命名 → 输入 → ↵ → 行文字换、core 侧 `listMeta` 名字换;⋯ → 删除 → 确认框 → 确定 → 行没了、core 侧没了。
⑧ 冷开 400 行:`gate:perf` 场景① 不退步(读数进报告)。

## 7. 留账

- 搜索行的快捷键提示:今天没有「聚焦会话搜索」的全局命令,行上不画提示;要不要加一条全局键是用户拍点。
- `--content-lead-left` 与 `electron/main.ts` 的 `trafficLightPosition` 是同一件事的两半(与 `--titlebar-traffic-w` 同一判例),改一处要改另一处;Windows / Linux / 浏览器壳没有红灯,那一档取 `--sp-4`(16)——由 `AppShell` 的 `[data-host-traffic='none']` 同一处覆写。
- 右架子也吃 22 的左缘(容器查询分不出左右),接受。
- 总览形(≥760)的时间列与 chip 照旧,动作层 z-index 修法对它同样生效。
