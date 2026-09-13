# 输入框进会话叶（W5-c，路线 A）

2026-09-13。接 `workbench-2026-09.md` W5-b（路线 B）留的账。用户报障：「composer 在其他 tab 页也存在，导致会遮挡内容」。用户拍：路线 A。

## 1. 根因

输入框不属于会话叶。它是外壳挂在整个中央区（`.center`）底部的一块绝对定位浮层（`AppShell.tsx` 的 `.composerDock`），显不显示、盖住谁，与拼贴树里当前那一格是什么内容无关。「当前会话」又是一条永远找得到值的梯子（`session-ref.currentSessionOf`：焦点叶没会话就退到阅读序第一片会话叶），所以焦点在终端 / 浏览器 / 改动面 / 设置页上时，输入框照样有收件人、照样浮着、照样盖住那一格的底部。

这是 W5-b 那次「路线 B」自己写下的账（`kinds.ts` 的 `fullable` 判词、`session.tsx` 文件头、`drafts.ts` 第 17 行、`CenterRegion.tsx` 第 30 行、`sink.ts` 的 `targetSession`）：输入框留在外壳上，只把发送目标换成投影值，「要撤得等路线 A」。

## 2. 裁定

**输入框由 `session` 这一种内容自己渲染，外壳从此不认识输入框。** 「哪里有会话叶，哪里才有输入框」是结构上的事实，不需要任何判断。陌生能力演练：以后终端要一条自己的底栏，改的是终端自己的模块（`content/kinds/terminal.tsx`），外壳零改动；两条会话并成 `pair` 复合格时，每半格自带一个输入框，`pair` 模块零改动。

不走路线 B 补丁（外壳按「焦点叶是否装着会话」给落位带挂 hidden）的理由：那是外壳按状态点名一种内容；分屏「会话 | 终端」时输入框仍横跨整个中央区盖住终端；焦点落到架子面板上输入框会消失；`fullable: false` 撤不掉。

## 3. 组件树（改后）

```
AppShell
└─ main
   └─ .center                         ← 不再有 .composerDock，不再有 centerRef / useComposerGeometry
      └─ CenterRegion → PaneLeaf … → content holder (FocusScope leaf, owner = refId)
         └─ SessionLeaf                (content/kinds/session.tsx)
            └─ .chatArea               position: relative；写 --composer-h / --center-h 的落点
               ├─ SessionIdentity
               ├─ ErrorBoundary chat → ChatStream（底部内衬读 --composer-h；内含 FollowPill）
               ├─ TocPanel（读 --composer-h）
               └─ .composerDock  [data-composer-dock] [data-testid=composer-dock]   ← 新
                  └─ ErrorBoundary composer
                     └─ Composer sessionId={sessionId} owner={refId}
                        └─ FocusScope composer owner={refId}
                           └─ .wrap … .panel（玻璃）
```

三个几何消费者（消息流内衬、跟随丸、目录面板）都在 `.chatArea` 之内，变量改写在 `.chatArea` 上后靠继承一字不改。`--center-h` 的语义从「中央区多高」变成「这片叶多高」，抽屉上限「正文永远露出上半截」在叶内成立，正是它该有的意思。

## 4. 三张状态表

### 4.1 输入框实例的生命周期

| 事件 | 输入框实例 | 说明 |
| --- | --- | --- |
| 会话叶挂载（出厂 / 拖会话行进树 / 分屏 / ⌘N） | 随 `SessionLeaf` 一起挂 | 一片会话叶恰好一个实例 |
| 换宿主（搬进架子 / 撕成浮窗） | 不重挂 | 结构共享，与叶同命 |
| 换会话（`replaceRef`） | 这一格重挂 | 内容层按 refId 分格，兄弟叶不动 |
| 叶被藏起来（隐藏层 `content-visibility: hidden` + inert） | 留着，不可交互 | 与「隐藏的会话叶实例留着」同一条 |
| 停靠池（组件级停靠） | 留着 | 同上 |
| 叶关闭 / 整区收掉 | 卸载 | `ContentKind.dispose` 时释放这条会话的输入框 store（草稿照旧由 `dropComposerDraft` 处理） |

### 4.2 每种落位下输入框在哪、盖谁

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 中央区单叶 = 会话 | `.center` 底部，宽 = 中央区 | `.chatArea` 底部，宽 = 叶 = 中央区。**像素相同** |
| 中央区单叶 = 终端 / 浏览器 / 改动 / 设置 / 文件 | 照样浮着，盖住底部 | **没有输入框** |
| 分屏「会话 \| 终端」 | 横跨两格，盖住终端底部 | 只在会话那半格下面 |
| 分屏「会话 A \| 会话 B」 | 一个输入框跟焦点跑 | 两个输入框，各自草稿 / 抽屉 / 附件 |
| 会话叶在架子 / 浮窗 | 架子旁没有输入框；中央区那格浮着 | 架子里那片叶自带输入框（窄，但诚实） |
| 会话叶进真全屏 | 禁止（`fullable: false`） | 允许，输入框随叶进全屏 |
| Dock 贴底 | `.center` 那一格让位 + 落位带自己再让一次（它是 `.center` 的绝对定位子元素，`bottom` 量 padding box，父级内衬推不动它） | **落位带一条自己的让位都没有**：它住在已经缩好的内容盒里（09-13 起让位是打在 `.main` 上的平移形），`bottom` 恒 `0px`，按构造继承；再写一条就是让两遍（W5-c-3 真机改判，读数在 §5） |

### 4.3 焦点、投递、忙态归哪一个实例

| 事项 | 改前（单实例） | 改后（多实例） |
| --- | --- | --- |
| `focusInto: 'composer'`（切标签 / 拖落定 → 焦点进输入面板） | `activateScope('composer')` 挑 MRU | `activateScope('composer', { owner: refId })`：Composer 的 `FocusScope` 带 `owner={refId}`，`focus-into.ts` 把 `owner: id` 传进去。挑不到（叶 inert）照旧回落到 `leaf` |
| 输入框读哪条会话 | `expose.currentSessionId` 投影 | 叶传下来的 `sessionId` prop（`Composer` / `DrawerModelPicker` / `useComposerBusy`） |
| `composerSink().send / notice / abort` | `targetSession()` 读投影 | sink 动作带 `sessionId` 参数，由调用它的实例传自己的 |
| `startSession()`（首开草稿态惰性建会话） | 同上 | 不变：保留键那片叶的输入框调它，没有会话可言 |
| 外部往输入框投引用（`composer/references.ts` 的 sink） | 单槽 | 按 `sessionId` 登记的表；投递目标 = `currentSessionId` 投影（焦点叶那条），语义不变 |
| `useComposerStore`（抽屉 / 搜索词 / ask / 附件 / 状态条） | 全应用一份 | 按 `sessionId` 取的 store 工厂（`composerStoreFor(sessionId)`），`dispose` 释放；保留键读作空串那份也各自一份 |
| 草稿 | 已按 `sessionId` 分家（W5-a） | 不变 |

## 5. 改动清单

**W5-c-1 结构搬家**

- `content/kinds/session.tsx`：`SessionLeaf` 在 `.chatArea` 末尾渲染 `.composerDock`（属性 `data-composer-dock` + `data-testid="composer-dock"`）→ `ErrorBoundary where="composer"` → `<Composer sessionId owner={refId}>`；`useComposerGeometry` 搬到这里（参数改成 `chatAreaRef` + `dockRef`，变量写在 `.chatArea` 上）；删 `fullable: false` 与它的判词，改写文件头那段路线 B 叙述。
- `components/AppShell.tsx`：删 `composerDock` div、`composerDockRef`、`centerRef`、`useComposerGeometry` 整只 hook 与 `Composer` import。`.center` 上关于输入框的注释改写。
- `components/AppShell.module.css`：`.composerDock` / `.composerDock > *` 两条搬到 `content/kinds/ChatLeaf.module.css`；`.shell[data-dock-reserve='bottom'] .composerDock` 改成 `.shell[data-dock-reserve='bottom'] [data-composer-dock]`（跨 CSS module 的类名会被哈希，同文件 `[data-panel-layer]` 是先例）。`.center` 的 `position: relative` 判词改写（消费者只剩它自己）。
- `composer/components/Composer.tsx`：props `{ sessionId: string; owner: string }`；`useExposeStore(currentSessionId)` 那一读改成 prop；`FocusScope` 加 `owner={owner}`。
- `workbench/focus-into.ts`：第 49 行 `activateScope(into, { owner: id, reason })`。判词：内容自述的作用域里，取**这一格自己**登记的那份实例，与下一行 `leaf` 那句同一个 owner。
- `workbench/kinds.ts`：`fullable` 判词里那段「今天唯一说 false 的是 session」删掉。`CenterRegion.tsx` 第 30 行、`composer/drafts.ts` 第 17 行的判词改写。
- 测试：`content/__tests__/floating-composer-css.test.ts` 改扫 `ChatLeaf.module.css` 的两条 + `AppShell.module.css` 的属性选择器那条；`composer/components/Composer.test.tsx` 补两个必填 prop；`session.tsx` 相关用例（`content/kinds/__tests__`）加一条「非会话叶 DOM 里没有 `composer-dock`」与一条「两片会话叶各一个」。

**W5-c-2 状态分家**

- `composer/store.ts`：`create` 改成工厂 `composerStoreFor(sessionId)`（Map + 惰性建），导出 `useComposerStoreOf(sessionId, selector)` 与 `disposeComposerStore(sessionId)`；`configureDraftRevoke` 那一次登记不变。所有 `useComposerStore(` 调用点（`rg -n 'useComposerStore' src/composer`）改成带 `sessionId` 的读法，`sessionId` 从 Composer 经 props 或一格 `ComposerSessionContext` 下发（挑 context：`DrawerModelPicker` / `AttachmentStack` / `MeterCard` 等子件不该各自多一个 prop）。
- `composer/sink.ts`：`send / notice / abort` 加 `sessionId` 参数，`targetSession()` 删；`useComposerBusy(sessionId)`。
- `composer/references.ts`：单槽 `sink` 改成 `Map<sessionId, ComposerReferenceSink>`，投递入口按 `currentSessionId` 投影取。
- `composer/components/DrawerModelPicker.tsx`：`currentSessionId` 读改成 context。
- `content/kinds/session.tsx`：`dispose` 里加 `disposeComposerStore(sessionId)`。
- `data/meter-source.ts`（W5-c-3 补）：那一格「开着哪一条 + 一条订阅」改成**按 `sessionId` 键的
  引用账** —— 每块面板挂载时 `open` 自己那条、卸载时 `close`；同一条会话两块面板只订一次、
  先下场那一块不掐掉另一块；整台一份都不剩才退订。`useMeterView(sessionId)` /
  `useCompacting(sessionId)` 收参数，`MeterCard` / `ContextRing` 从 context 拿。
  不改这一格的下场：两块面板并排时后挂的那一块把「开着哪一条」顶掉，**一侧的圆环画的是
  另一条会话的用量**（取数那一半早就按会话键好了，差的只是这一格）。
- `composer/useComposerSend.ts`（W5-c-3 补）：首开草稿态那一路 `send(text, created)` ——
  这块面板自己的收件人是空串，而这一句的去处是刚建出来那条。少这个参数 = 首开第一句话
  发给空串（`chatSources.get('')` 查无此人），**静默发不出去**。
- 测试：`store` 的用例改走工厂；补一条「两个 sessionId 的 store 互不影响（A 开抽屉 B 不开）」；
  meter 补「两条会话各读各的，引用账各记各的」与「同一条会话两块面板：引用计数」。

**W5-c-3 门与正本**

- `scripts/lib/composer-dock.mjs`（新）：`window.__composerDock()` —— 「焦点叶里的那一块输入框」
  的唯一产地。`page.evaluate(fn)` 把函数**序列化**送进浏览器，node 这一侧的闭包一个都带不过去，
  所以「共用一份」只能是「在页面里装一次、大家都调那一个全局」：`installComposerDockProbe(page)`
  用 `addInitScript`（管后面每一次导航）+ `evaluate`（管此刻这一份文档）两件一起做。
  `gate-layout.mjs` / `gate-chat-follow.mjs` / `gate-composer-drawer.mjs` 三处查询改调它。
- `scripts/gate-focus.mjs` 两处（W5-c-3 跑门时逮到）：场景 19 的「打完字读一读」从
  `querySelector('[data-testid="composer-input"]')`（文档序第一块）改成 `document.activeElement`；
  场景 10 在重载之前先把中央区活动格点回**会话**（规则 1 的原话是「有会话则是它的输入面板」，
  而路线 A 之后活动格是文件查看器时屏幕上根本没有一块可交互的输入面板）。
- `components/AppShell.tsx`（同上）：启动那条三级回落**发两拍** —— 输入框在叶里，可能晚一拍才
  铺根，第一拍落空之后由 `runAfterCommit` 再发一遍（只在第一拍没落到 `composer` 上时发）。
- `scripts/gate-composer-leaf.mjs`（新，进 `npm run verify`）：本批自己的真机门，五问 —— ①会话那
  一格恰好一块且长在这一格里；②非会话那一格零块、底缘中点不命中输入框、「有框的那几格 = 装着
  会话的那几格」；③开一格别的内容不会把它带走；④两条会话并排 = 两块，各自草稿互不串；
  ⑤每一块落位带自己的 `bottom` 恒是 `0px` 且下缘在 Dock 之上。
- 跑：壳 `typecheck` / `lint` / `vitest`；`ui:consume`、`squeeze-gate`、`motion-gate`；真机门
  `gate:chat-follow`、`gate:composer-drawer`、`gate:composer-send`、`gate:composer-leaf`、
  `gate:continuity`、`gate:a11y`、`gate:squeeze`、`gate:focus`、`gate:layout`、`gate:companions`。
- 正本：本文；`workbench-2026-09.md` W5 节补一行指向本文；壳 `CLAUDE.md` 「具体禁令与拍板」补一条「输入框属于会话叶，外壳不认识它」。

## 6. 用户可感知的行为变化（09-13 用户拍「好的」）

1. 非会话标签页上不再有输入框。
2. 分屏「会话 | 终端」时输入框只在会话那半格下面。
3. 两条会话并排时是两个输入框，各自草稿 / 抽屉独立。
4. 架子或浮窗里的会话叶自带输入框。
5. 会话叶可以进真全屏 —— **`pair`（两条会话并排那一格）也一起解禁**（W5-c-3）。
6. Dock 贴底时每个输入框都让位。

## 7. 留账

- ~~上下分屏的上半格 Dock 让位多几像素~~ —— **不成立了**（W5-c-3，真机门逮到）：
  落位带的包含块从 `.center`（绝对定位不吃它的 padding）换成了叶自己的 `.chatArea`
  （一个住在已经缩好的内容盒里的普通流后代），所以外壳那条
  `[data-composer-dock] { bottom: var(--dock-reserve-h) }` 从「必要的第二次让位」变成
  **让两遍**：`gate:chat-follow` ② 量到气口里压着一条消息，差 44px。那条规则整条删掉，
  让位只在「谁画到窗底」那一层写一次；判词与真机读数在 `AppShell.module.css` 那一段上，
  守卫是 `gate:composer-leaf` ⑤（每一块落位带自己的 `bottom` 恒是 `0px`）。
- 架子里的会话叶输入框很窄：`.wrap` 的 `max-width: --pr-col` 在窄容器下自然塌到容器宽，没有额外处理；要不要给架子里的会话叶换一种紧凑输入框，另单。
- **`focusIntoRef` 的 `owner` 今天只有两格作用域答得上**（`composer` / `browser`）：
  `files` / `diff` / `terminal` 还没在自己的 `FocusScope` 上报 owner，所以那一句是**两步**
  （点名 → 点不到再不点名）。等那三格也报上来，第二问自然再也命中不到第二份实例，
  `focus-into.ts` 那一行不必再改。
- **`keymap/run-command.ts` 的全屏拒绝文案**改成了不点名种类的一句实话（`full.refused`，
  旧键 `full.refuseChat` 连同 zh/en 两行一起删）；今天还走得到那一档的只剩「认不得的种类」。
  将来第二种真要拒绝时按种类取话（`full.refuse.<kind>`），不是再加一条 if。
- **读数那条线的引用账没有「谁在看」的可见性维度**：藏起来的会话叶（后台 tab）照样
  `open` 着，于是它那一格照旧订着、照旧会在账本响时补拉。这与改前逐字相同（改前
  切走的那条也留在缓存里），记一笔是因为「引用 ≠ 在看」这件事以后要分的话，分在这里。
- **两条与本批无关的存量红**（W5-c-3 跑门时撞到，各有出处，都不是这一批造成的）：
  `gate:layout` 场景 ① 与 `gate:focus` 场景 4 —— 两处都拿 Dock 的 `diff` 瓦去点「钉到右边」，
  而 `diff` 从 `1d1a16165`（2026-09-13）起是**启动瓦**，它的右键菜单里没有落点单选那一排
  （`gate-layout.mjs` 文件头早就把这条病写在 terminal / browser 身上了）。
  `gate:companions` 四条红是 C3 交卷时自己写下的「**只写没跑**」。
