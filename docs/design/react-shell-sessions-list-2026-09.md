# React 壳 · Sessions 列表重建(方向 A「档案」)

日期:2026-09-04。用户 09-03 报障「Sessions 列表难看、找会话困难、不同宽度下展示奇怪」,
09-04 在三方向比稿中拍定 **A · 档案**(画布
https://claude.ai/code/artifact/3c01d7c7-9a59-4cea-978c-f86315947154),并要求实施前
把「组件交互、基础组件、无障碍、焦点」四件事先立清楚。本文是施工契约:形状、对象模型、
键盘与无障碍规格、必须保住的门与契约、分期与验收。

## 0. 已拍定的裁决(不再讨论)

| # | 裁决 | 来源 |
| --- | --- | --- |
| 1 | 时间做主轴,项目做筛选(侧栏);列表里**只分一次组**(时间) | 09-03 方案 §二、§四-1 |
| 2 | 行高 40px(`--list-row-h`),单行 | §四-2 |
| 3 | 窄档侧栏收成顶栏的项目选择器 | §四-3 |
| 4 | **置顶做**:最上一节「置顶」,只在这一节出现不重复 | 用户 09-03 |
| 5 | **协作**:房间(群房 / 私聊 / agent 私聊)与聊天走同一条时间轴;`[任务]`(work)与 `[执行]`(agent)不占顶层行,挂在父房间下可展开;孤儿子会话回顶层不静默丢 | 用户 09-03「协作按你的想法」 |
| 6 | 行首形态图标列**全行预留**,普通聊天留空;标题永远从同一条竖线起笔 | 检索面板判例同源 |
| 7 | 无计数徽;组头无背景、粘顶;不引用旧壳作正当性 | 08-29/08-30 判例 |
| 8 | 行上不放预览 / 摘要 / 模型;这些进 Quick Look | §二-3(真店 preview 仅 9% 有) |
| 9 | 运行中实况点(SSE)**不在本批** | §二 留账 |

真店读数(09-03):469 条会话,57% 无项目,40 个工作目录,标题中位 10 字,
`previewText` 仅 9% 非空 —— 这些数字是裁决 1 / 2 / 8 的物理理由。

## 1. 形状

```
┌ Sessions ─────────────────────────────────────────────── ⊹ ⤢ ✕ ┐
│ ┌ 侧栏 196 ┐ ┌ 工具栏 ──────────────────────────────────────┐ │
│ │ 全部     │ │ [🔍 搜索会话、章节、消息          ] [+ 新会话] │ │
│ │ 协作     │ ├ 置顶 ──────────────────────────────────────── ┤ │
│ │ 无项目   │ │   9月新需求                    lenovo-scripts 14:32 │ │
│ │ ──────   │ ├ 今天 ──────────────────────────────────────── ┤ │
│ │ 📁 lenovo│ │   FAC流程与号码梳理及交接清单   lenovo-scripts 16:05 │ │
│ │ 📁 aikefu│ │ Ⓛ Life coach                              15:48 │ │
│ │ …        │ │ 👥 官网改版组                          ▾   13:10 │ │
│ │          │ │     ☑ V2-3:全链路验收                    13:10 │ │
│ │          │ │     ⚡ 小李                               13:08 │ │
│ └──────────┘ └────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

三块面,从左到右:**侧栏(Rail)**、**工具栏(Toolbar)**、**列表(SessionTree)**。
Quick Look 原样保留(叠层)。旧的 `ListView`(点组头钻进去的那层)与卡片总览**合并成这
一张列表**,`view.mode = 'list'` 退役。

### 1.1 行(SessionRow)

`[形态图标 16 · 固定列] [标题 · flex 1 · 省略] [展开箭头 · 仅房间] [悬停动作 · 眼睛 / 图钉]
[项目 chip · 仅「全部」视图] [时间 · 56px · 右对齐 · 等宽数字]`

- 形态图标表 `ROW_KIND_SPECS`(能力自述,别处读表):`chat` 空、`dm` 单头像首字、`room`
  双人图标、`swap`(agent⇄agent 私聊,`room.dm && memberAgentIds.length === 2`)⇄、
  `work` ☑、`agent` ⚡。
- 子行缩进 26px,其余同形。
- 时间列沿用 `relativeTime` 四档(同日时刻 / 昨天 / 星期 / 日期)。
- 态:静息 / 悬停(前景 6% 薄膜)/ **当前会话**(`aria-selected` + accent 10% 晕)/
  **键盘活动行**(柔光环,由 `aria-activedescendant` 指着)。悬停动作在**悬停或活动行**上
  显形(常驻 DOM,只动 opacity —— 同旧卡的眼睛判例)。

### 1.2 分节(Section)

一次分组,按 `updatedAt` 落桶,顺序即阅读顺序:
`pinned`(有置顶才出现)→ `today` → `yesterday` → `thisWeek`(近 7 天内、且不是今天昨天)
→ `month:<yyyy-mm>`(逐月,最近的月在前)。
桶表 `SECTION_BUCKETS` 是一张有序表 `{ id, labelKey | label(now), test(updatedAt, now) }`,
月桶是最后一格的兜底生成器。**分节头不带计数、不画背景、`position: sticky`**,不可折叠。

### 1.3 侧栏(Rail)与范围(Scope)

范围是一张表 `SCOPE_SPECS`,行 = `{ kind, labelKey, icon, predicate(session) }`:
`all`(恒真)、`collab`(`room | dm | swap`)、`loose`(无项目且非协作)、
`project`(`session.projectId === scope.projectId`)。侧栏 = 固定三项 + 分隔线 + 项目
(`buildProjects` 的顺序:按组内最新活动倒序)。`collab` / `loose` 两项**只在非空时出现**,
`all` 恒在。**侧栏项不带数字**。

「新建项目…」**本批不做**:今天 `+ Project` 按钮没有任何处理器(Overview.tsx:404 是死按钮),
目录选择流在 React 壳没有产地;死按钮不搬进新壳,留账。

### 1.4 工具栏

`[ui/Input(size sm,prefix 🔍)· flex 1] [ui/Button「新会话」· ghost]`。
窄档(容器 < 760)在最左加 `[ui/Select 项目选择器]`(选项 = 与侧栏同一张表)。
「新会话」在 `project` 范围里建到该项目,其余范围建无项目会话(`newSession(projectId|null)`,
沿用 store 唯一入口与单飞闸)。搜索仍是**过滤器**:输入后形状不变,不命中的行消失、
空掉的节消失、命中词高亮(`Highlight`);子行命中时父房间行**自动展开**(派生态,不落库)。

### 1.5 宽度

只看容器宽(`container-name: expose` 已在)。三档,行形永不变:

| 容器宽 | 侧栏 | 项目 chip | 工具栏 |
| --- | --- | --- | --- |
| ≥ 760 | 显示 | `all` 下显示 | 搜索 + 新会话 |
| 480–760 | 隐藏,顶栏出项目选择器 | 显示 | 选择器 + 搜索 + 新会话 |
| < 480 | 同上 | 隐藏 | 搜索独占一行,新会话缩成图标钮 |

阈值 `--expose-rail-bp: 760px` / `--expose-chip-bp: 480px` 进 tokens.css;`@container` 里
不能用 var,字面量与 token 并排写并互相点名(同 420 的旧做法)。卡片时代的
`--card-*` / `--expose-search-w` / `--expose-max-w` / `--card-min-h-narrow` /
`--model-max-w-narrow` / `--expose-gap*` / `--card-*-fluid` / `--r-card` 全部退役。

## 2. 对象模型(纯函数层,`src/expose/`)

面向对象的原则:**能力自述、别人读表**;渲染层不出现任何形态名 / 范围名 / 桶名的分支。

```ts
// types.ts
type SessionKind = 'chat' | 'room' | 'dm' | 'swap' | 'work' | 'agent'
interface SessionSummary { …现有 12 格; isPinned: boolean; roomId: string | null /* collab.roomSessionId */ }
type ProjectScope = { kind: 'all' } | { kind: 'collab' } | { kind: 'loose' } | { kind: 'project'; projectId: string }

// list-model.ts(新)
interface ListRow { id: string; session: SessionSummary; depth: 0 | 1; parentId: string | null; expandable: boolean; expanded: boolean }
interface ListSection { id: string; label: { key: MessageKey } | { text: string }; rows: ListRow[] }
interface ListModel { sections: ListSection[]; rowIds: string[] /* 平铺、按屏幕顺序、只含可见行 */ }
function buildListModel(input: { sessions, scope, query, expandedRooms, now }): ListModel
```

`buildListModel` 的步骤(每一步一只纯函数,各自有单测):
1. `scopeOf(scope).predicate` 过滤(子会话按**父房间**的归属判,不看自己)。
2. `attachChildren`:`work | agent` 按 `roomId` 挂到父;父不在集合里 → 孤儿回顶层。
3. `bucketize`:顶层行按 `SECTION_BUCKETS` 落桶;`isPinned` 先于时间落 `pinned`。
4. `applyQuery`:`sessionMatchesQuery` 判父与子;子命中则父强制 `expanded`。
5. `flatten`:节内按 `updatedAt` 倒序,展开的父后面紧跟子行;`rowIds` 由此一次产出。

**`rowIds` 是唯一的焦点序列产地**:`moveFocus` / `quickLookPrev|Next` / `quickLookNeighbors`
全吃它(接替今天的 `visibleCardIds`)。

`ExposeState` 变更:
- `view`:去掉 `{ mode: 'list' }`;`enterList` / `backToOverview` 删除。
- 去 `columns`(与 `setColumns` / `columnsFromTemplate` / `CARD_COLS`);`moveFocus` 只剩
  上下;左右改为**树语义**(见 §3.2)。
- 加 `scope: ProjectScope`(缺省 all)、`expandedRooms: string[]`;`collapsedGroups` 删除。
- 持久化 `onething.expose` **version 2**,`partialize` 存 `scope` + `expandedRooms`
  (仍按工作区分格 `EXPOSE_PER_SPACE`);`migrate(1 → 2)` 丢 `collapsedGroups`。
- 新动作:`setScope(scope)`、`toggleRoom(sessionId)`、`expandRoom` / `collapseRoom`、
  `togglePin(sessionId)`(走数据源 mutation)。

投影(`projection.ts`):`toSessionSummary` 补 `isPinned`(缺席=false)、`roomId`
(`meta.collab?.roomSessionId ?? null`);`kindOf` 补 `swap`;`HIDDEN_SESSION_KINDS` 与
`COLLAB_KINDS` / `COLLAB_GROUP_ID` / `LOOSE_GROUP_ID` / `buildGroups` 退役(分组不再是投影
的事,`buildProjects` 保留给侧栏)。`sameSession` **必须补 `isPinned` / `roomId`** 两格,
否则置顶不会重渲。

数据(`data/`):`SessionsPort` 加 `updatePin(sessionId, isPinned)`(真实现 =
`sessionsApi.updatePin`,RPC 已存在:`packages/shared/ipc/sessions.ts:126`);
`SessionWrite` 加 `{ kind: 'pin' }`,键 `pinKey(sessionId)`,settle 后 `refetch`(后端
pin 不推事件,靠对账;后端加固另批留账:`updateOnethingSessionPinForIpc` 不看返回值、
`updateSessionPin` 不 `notifySessionIndexChanged`)。测试假端口(`src/test/setup.ts`)同步。

## 3. 键盘、焦点、无障碍

### 3.1 角色(APG,原生优先,宁可不报不许错报)

| 面 | 角色 | 说明 |
| --- | --- | --- |
| 侧栏 | `role="listbox" aria-label=t('expose.scopeLabel')`,项 `role="option" aria-selected` | **一个 Tab 位**,`ui/a11y/roving`(`data-roving-item`,axis vertical,loop);项用 `ui/ButtonBase`(结构档,不是裸 button) |
| 搜索 | `ui/Input`(`aria-label` 沿用 `expose.searchLabel`) | 今天是裸 `<input>`,本批改吃基础件 |
| 新会话 | `ui/Button`;窄档 `ui/IconButton`(`label` 必填) | |
| 项目选择器(窄档) | `ui/Select` | combobox + listbox 现成 |
| 列表 | `role="tree" aria-label=t('item.sessions')`,`tabIndex=0`,`aria-activedescendant` | **一个 Tab 位**;焦点在容器上,活动行由 `focusId` 派生 |
| 分节 | `role="group" aria-labelledby=<节头 id>`;节头 `<h3>` 文本 | |
| 行 | `role="treeitem" id="expose-row-<id>" aria-level={1|2} aria-selected={current} aria-expanded`(仅房间) | 行是 `<div>`,不是 `<button>`:tree 的项由容器接键,不各占 Tab 位(三律一推论) |
| 悬停动作 | `ui/IconButton`(眼睛 `card.preview`、图钉 `expose.pin` / `expose.unpin`),`tabIndex=-1` | 不进 Tab 序;键盘等价:Space / ⌘⇧P |

`Kbd` 在本壳不带 aria;`Badge` 不用(无计数)。

### 3.2 键盘(挂在作用域根 `onKeyDown`,事件委托;首句 `isTypingTarget` 让位)

| 键 | 焦点在搜索框 | 焦点在树 |
| --- | --- | --- |
| ↓ / ↑ | ↓ = `focusGrid()` + `activate('programmatic')`:**只点亮锚点不走步**(现有用例逐字钉着) | 活动行上下移,到头不回绕 |
| → | 不接(留给光标) | 房间未展开 → 展开;已展开 → 进第一个子行;非房间 → 无动作 |
| ← | 不接 | 子行 → 回父;展开的房间 → 收起;其余 → 无动作 |
| Home / End | 不接 | 首行 / 末行 |
| ↵ | 进「第一节第一行」 | 进活动行的会话 |
| Space | (输入空格) | Quick Look 活动行(**与 APG tree 的 Space=选择有偏离,理由:选择即 aria-selected 由当前会话决定,不是键盘态**) |
| ⌘⇧P | 置顶 / 取消置顶活动行(`FOCUS_SCOPES.expose.keys` 加 `pin.toggle`,今天 ⌘⇧P 空着) | 同左 |
| Esc | 有词清词(返 true);无词让位宿主(返 false) | 同左;quicklook 退一层 |

`restingTarget` 两档不变:`focusVisible ? treeRef.current : searchRef.current`(从「作用域根」
改为「树容器」,树容器 `tabIndex=0` 是真 Tab 位)。侧栏 Tab 序在搜索框之前
(DOM 顺序),树在新会话之后。`mouseenter` **不改锚点**(现有用例)。
禁令(ui-consume 全 src 生效):不写 `window/document.addEventListener('keydown')`、不
`.focus()`、不读 `document.activeElement`;方向键在文件里出现必须 import
`a11y/roving` 或 `a11y/list-selection`(侧栏用 roving;树的活动行走 store,文件里不写
`'ArrowDown'` 字面 —— 键名判据放 `expose/keys.ts` 一处并 import roving 的
`nextRovingIndex` 复用步进)。

### 3.3 焦点可见与返还

- 树容器 `:focus-visible` **不画环**(容器例外,同 `focus-scope.css` 判例);活动行画柔光环
  (`--accent-ring`),只在 `focusVisible` 为真时(键盘导航才点亮)。
- 进会话:`enterSession` 仍是唯一编排点(规则 2),焦点交给 composer(gate-focus 场景 8)。
- 置顶后行会搬家(进「置顶」节):`focusId` 不变,活动行跟着搬;`scrollIntoView({block:'nearest'})`。
- 行被删除(`sessionsRemoved`):`focusId` 按 `rowIds` 就近落位(现有夹持逻辑改吃 `rowIds`)。
- 播报:置顶 / 取消置顶经 `a11y/live-region.announce`(polite)说一句(`expose.pinnedAnnounce`)。

### 3.4 契约(测试与门钉着的,必须保住或成对改)

| 契约 | 处置 |
| --- | --- |
| `[data-focus-scope="expose"]` 根 | 保住 |
| `[data-session-id]`,且**第一个 `<span>` 是完整标题**(gate-data.mjs 按它读) | 保住(行的第一个 span = 标题,`Highlight` 不许切碎) |
| `card-<id>` / `card-preview-<id>` testid | **改名** `session-row-<id>` / `session-row-peek-<id>`,新增 `session-row-pin-<id>`;同步改 gate-data / gate-perf / gate-squeeze / gate-focus(`ensureOverviewCard`)与所有引用 |
| `group-head/toggle/enter/plus-<id>`、`[data-sentinel]`、`useStuckHeads`、`expose-list` | 随项目组退役;gate-squeeze 里对应场景改写为新契约:`expose-rail`、`expose-toolbar`、`expose-tree`、`expose-section-<id>`、`expose-scope-<kind>[-<projectId>]` |
| `expose-overview-scroll` | 保住(工作区门:换空间不掀树) |
| Esc 三档、搜索框 ↓ 只点亮不走步、mouseenter 不改锚点 | 保住 |
| `+` 的 `aria-busy` 与单飞闸、不用 disabled | 保住(搬到工具栏「新会话」) |
| Quick Look 全部 testid 与行为 | 不动 |

## 4. 浮窗几何(壳侧,同批修)

病根(盘点 09-04):`stage/transitions.ts:471-480` 的钳制只钳位置不钳宽高;`FloatWindow`
只在拖拽开始量一次视口;`onething.stage` 的 `merge` 一格 rect 都不钳;全壳没有 resize 重钳。

修法:
1. `clampFloatRect(rect, viewport)`:`w = clamp(w, FLOAT_MIN_W, viewport.w - 2*FLOAT_MARGIN)`、
   `h` 同理,再钳位置(先尺寸后位置,否则右边缘算错)。`FLOAT_MARGIN = 16`。
2. stage store 加 `reclampFloats(viewport)`(纯函数 `reclampAll(state, viewport)` 对 `floats` 与
   `memory` 里的 float rect 逐条钳);`merge`(rehydrate)时对当前空间钳一遍。
3. `AppShell`(或 FloatWindow 宿主)挂**一个** `window resize` 监听(`useViewportReclamp`,
   不是 keydown,不触犯 I2),`requestAnimationFrame` 合并,调 `reclampFloats`。
4. 单测:`stage/transitions.test.ts` 加「880 宽的 rect 落进 1100 视口后 `x + w ≤ vp.w - 16`」
   与「rehydrate 钳」;gate-squeeze 加一格「窗 1100 打开 Sessions 浮窗,面板右缘 ≤ 视口」。

## 5. 分期

三期串行,每期:opus 施工 → Fable 审查 → haiku 提交(**只 `git add` 本批文件**,工作树上另有
31 处用户未提交改动,含 Overview.tsx / SessionCard.tsx 的 memo 改动 —— 在其之上改,不还原)。

### P0 · 模型与数据(不动 UI)
- `types.ts` / `projection.ts` / `list-model.ts`(新)/ `scopes.ts`(新,`SCOPE_SPECS`)/
  `sections.ts`(新,`SECTION_BUCKETS`)/ `row-kinds.ts`(新,`ROW_KIND_SPECS`)/
  `transitions.ts`(去 columns、moveFocus 一维、树的 ←→、`rowIds` 接替 `visibleCardIds`、
  `expandedRooms`、`scope`)/ `store.ts`(v2 持久化 + 新动作)。
- `data/sessions-port.ts` + `sessions-source.ts` + 假端口:pin mutation。
- i18n:新增 `expose.scopeLabel / scopeAll / scopeCollab / scopeLoose / newSession /
  sectionPinned / sectionToday / sectionYesterday / sectionThisWeek / sectionMonth({month}) /
  sectionMonthYear({year},{month}) / pin / unpin / pinnedAnnounce / unpinnedAnnounce /
  expandRoom / collapseRoom / kindSwap`;删 `list.*`、`expose.group*`、`expose.sessionCount*`、
  `expose.newProject`(zh 定义、en 成对)。
- 测试:`list-model.test.ts`(五步各自 + 端到端:置顶节、月桶顺序、孤儿回顶层、子命中父
  展开、`rowIds` 顺序)、`projection.test.ts`(补 isPinned / roomId / swap;删分组用例)、
  `transitions.test.ts`(改一维 + 树键)、`store.test.ts`(v2 migrate、scope 按空间分格)、
  `data/sessions-source.test.ts`(pin mutation settle 重拉)。
- 验收:`tsc` 零、`eslint` 零、vitest 该目录绿;UI 仍用旧组件跑得起来(旧组件暂时吃
  `buildListModel` 之前的 `groups`?**不**——P0 允许旧 Overview/ListView 的测试暂红,
  P1 整批替换;但 `ExposeView.test` 的 Esc 链用例必须绿)。

### P1 · 组件
- 新件:`components/Rail.tsx`、`Toolbar.tsx`、`SectionHead.tsx`、`SessionRow.tsx`、
  `SessionTree.tsx`(tree 容器 + activedescendant + 节),`Overview.tsx` 重写为三块面的装配,
  `ExposeView.tsx` 去 list 分支、键表按 §3.2、`restingTarget` 指树。
- 删:`ListView.*`、`SessionCard.*`(含测试)。`Highlight` 保留。
- CSS:每件一份 `.module.css`;容器查询两档;tokens 退役表(§1.5);`--expose-rail-w: 196px`。
- ui-consume:新增零违例;`shared-vocab-css` 债不新增(选择器别叫 `.card/.chip/.groupHead`)。
- 测试:`Rail.test`(单 Tab 位、roving、aria-selected、collab/loose 非空才出、无数字)、
  `SessionRow.test`(第一个 span 是完整标题、高亮不切碎、图标列全行预留、动作常驻只动
  opacity、子行缩进、`aria-*`)、`SessionTree.test`(tree/treeitem/level/expanded/
  activedescendant、Space=Quick Look、←→ 树语义、Home/End、置顶后活动行跟搬)、
  `Overview.test` 重写(三种空态、错误并存、搜索是过滤器、搜索框交接四条、窄档选择器
  出现、`aria-busy` 单飞闸)、`ExposeView.test`(list 分支删、Esc 链不变、⌘⇧P 走 keys)。
- 验收:tsc / eslint / vitest 全绿、`npm run ui:consume` 基线不增、`gate:a11y` 加一屏
  「打开 Sessions」axe 零违例、`gate:focus` 场景 8 绿。

### P2 · 壳与门
- §4 浮窗钳制 + resize 重钳 + 单测。
- 门改写:gate-data(testid)、gate-perf(testid)、gate-squeeze(旧组头场景 → 新契约 +
  三档宽度断言 + 浮窗右缘)、gate-focus(`ensureOverviewCard` → 行)、gate-a11y(加屏)。
- 真机:隔离 store 起 dist-electron,1400 / 1100 / 760 三档截图入 `dist/gate-shots/`,
  自审后呈现。
- 验收:`npm run verify`(壳)全绿;仓根 `bun run typecheck`、`boundary:gate`。

## 6. 陌生能力演练(骨架自检)

- 「加一档范围:归档」= `SCOPE_SPECS` 加一行(labelKey / icon / predicate)+ i18n 一对。侧栏、
  选择器、过滤全读表,零分支改动。
- 「加一种行形态:practice」= `SessionKind` 加一档 + `ROW_KIND_SPECS` 一行 + `kindOf` 一句。
- 「换分节轴:按 agent」= 换一张 `SECTION_BUCKETS` 表(桶表是策略对象),`flatten` 不动。
- 「子会话再多一层」= `depth` 放宽 + `attachChildren` 递归;行、键、`rowIds` 不动。

## 7. 留账

- 「新建项目…」入口(目录选择流)无产地,不做。
- 后端 pin:`updateOnethingSessionPinForIpc` 不看返回值;不推事件;Web 的
  `sessions.update` 白名单不含 `isPinned`。
- 房间实况点 / 未读:下一批。
- 协作范围里「新会话」建的是普通会话(建房要 `kind:'room'` + 成员名册),行为按旧例不动。
- 469 行全量渲染不虚拟化;> 2000 行再议。
