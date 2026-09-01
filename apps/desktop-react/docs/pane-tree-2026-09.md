# 拼贴树:多文件查看 + 区域分屏 + 会话多开(2026-09 设计,T0 待拍)

用户需求(09-01 原话归纳):①查看器不该是 Dock 上一块叫「Viewer」的瓦——名字应是**文件名**,且可同时打开多个文件;②文件可以放进**聊天区域**;③要**拖拽与分屏**(聊天区里上下左右分、架子里上下左右分);④后续聊天区自身要分屏(不同 session 并排)。

## 一、核心抽象:内容 / 树 / 落点,三层正交

**1. 内容实例(PaneContent)——「显示的是什么」**
```ts
type PaneContent =
  | { kind: 'panel'; panelId: string }          // 既有瓦面(sessions/files/notifications…)
  | { kind: 'file'; path: string }              // 文件查看器实例,按 path 各一个
  | { kind: 'session'; sessionId: string }      // T4:聊天叶
```
身份(标题/未保存丸)由内容自答——复用 09-01 刚立的 `stage/live-title` 机制,file 实例的名字天然是文件名。**查看器从「一块瓦」降格为「一种内容」**:Dock 上不再有「Viewer」瓦;文件实例活在某棵树的叶里,几开几个。

**2. 容器树(PaneTree)——「区域内部怎么摆」**
```ts
type PaneNode =
  | { kind: 'leaf'; tabs: PaneContent[]; active: number }
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode }
```
一块**区域**持有一棵树:中央区一棵、每条架子的 body 一棵、(可选后续)浮窗身一棵。叶=Tab 组(单 tab 不画 tab 条=今天的形,零视觉回退);分隔杆消费既有 `ui/Splitter`(键盘可调/比例持久/双击回默认全部继承)。树操作词汇封闭:`splitLeaf(dir, content)` / `moveTab` / `closeTab` / 空叶自动剪枝(split 只剩一支时提升)。

**3. 落点(Placement)一字不动**——形态机继续管「区域级」(dock/stage/float/cover/edge);树管「区域内部」。两层正交:换宿主仍是一次生命周期事件(状态先行三表照答),树是宿主里的家具摆法。查看器五宿主檐/滚动的判据(35109629)原样适用于每个 file 叶。

## 二、与现状的接线

- **chat 中央区**:今天=「chat 固定内容」;改造后=一棵树,chat 是第一片叶。文件「放进聊天区域」=对中央树 `splitLeaf('row'|'col', {kind:'file',path})`。
- **架子**:今天 `ShelfState.tabs: string[]` 平面 tab;迁移=一棵「单叶多 tab」的树,行为零变化起步,分屏能力顺带解锁。
- **chat-source 多实例化(T4 前置)**:今天模块级单折叠器(fold/tail 各一份);会话多开要求按 sessionId 各持一份(P0 的按节点缓存天然按 state 隔离,不冲突)。composer 归属跟当前聚焦的 chat 叶。
- **拖拽**:pointer 自绘(非 HTML5 DnD——与 Dock 手势同源纪律、CDP 可测):拖 tab/拖檐起浮影,悬停目标叶出五落区高亮(中心=并 tab;上下左右=按向切分)。

## 三、分期(每期独立可交付,状态先行三表随批)

| 期 | 内容 | 依赖 |
|---|---|---|
| **T0** | 本设计拍板(三拍点见下) | — |
| **T1** | 树内核(纯函数+测试)+ 查看器多实例:中央区成树、chat 固定叶、文件叶经右键菜单「在右/下打开」等入树;树持久化;file 内容多开、Dock 撤「Viewer」瓦 | Splitter/live-title(已有) |
| **T2** | 拖拽:tab/檐拖动+五落区,含拖出成浮窗/拖入架子 | T1 |
| **T3** | 架子 body 换树(单叶起步零行为变化),架子内分屏解锁 | T1 |
| **T4** | 会话多开:session 内容类型+chat-source 多实例化+composer 归属 | T1(大工程,单列) |

门与纪律:squeeze/a11y 扩采样面(每叶檐/分隔杆);零重挂断言(分屏/并 tab/关叶不重挂兄弟叶——树常驻铁律的树版);ui:consume(tab 条/落区遮罩消费库件,缺件先立)。

## 四、拍点(T0,09-01 用户已拍)

1. **文件的回访入口:甲**——撤 Viewer 瓦后,打开/关闭全靠**文件树**(打开中的文件树行带标记,点=聚焦,关=树行/叶内关闭)。
2. **chat 叶:可关,但最后一片不可关**——「如果只有一个的话就不关」,中央树永远至少剩一片 chat 叶。
3. **树的持久化粒度:按 Workspace 记**——「Workspace 毕竟是一个切换」,家具随空间走(并入 §五 布局整套隔离)。
4. **架子快捷键:用户放权**——默认 ⌘⌥← / → / ↓ / ↑,可改绑,实施前全表冲突检查。

## 五、Workspace 布局整套隔离 + 切换动画(09-01 用户追加,T-W 线)

用户原话归纳:切换 Workspace 时,**架子、文件树……整套都是新的一套**——之前的留在原空间,切换=去另一个空间;并做一个**切换空间的动画**(动画交 claude design 出稿,壳按稿实现)。

- **T-W1 布局隔离**:stage 状态(placements/floats/shelves/memory)、拼贴树、文件树展开态、检索面状态等「家具层」全部按 workspaceId 各持一份;切换=整套换装(persist 键带空间 id;首次进入某空间=出厂布局)。数据层(会话/凭证)已由 e389473b 隔离,本期隔的是**家具**。
- **T-W2 切换动画**:等 claude design 稿(handoff 已出);实现时旧空间整套退场/新空间进场走同一场转场,动效档 none 一格降级为直切。

### T-W1 落地记录(09-01)

**家具 / 偏好的分界**(这一批唯一一处需要拍板的判断,分界线画在这里):

| 跟着空间走(家具) | 跨空间共享(偏好) |
| --- | --- |
| stage 的 `placements` / `floats` / `floatOrder` / `shelves` / `memory` | stage 的 `dockDisplay` / `dockEdge` / `dockAlign` / `dockSize` / `hiddenItems` / `defaultOpen` / `locale` |
| 分栏比 `onething.split` 的 `ratios` | 键位 `onething.keymap` |
| 打开方式 `onething.files.openMode` 的 `mode` | 阅读轴 `onething.reading`(字号 / 密度 / 列宽 / 动效) |
| 总览折叠态 `onething.expose` 的 `collapsedGroups`(组 id 就是本空间的项目目录) | 通知环 `onething.notify`(它是事件记录,不是家具) |
| 文件树展开态(内存,不落盘) | 主题 / 当前空间本身 |

判据一句话:**它是不是「用户在这个空间里摆好的东西」**。Dock 贴哪条边、界面语言、
键位、字号都是**这台机器的偏好** —— 换个工作区不该跟着变。

**形**:一本账 + 一份活状态(`workspace/per-space.ts`)。落盘的是
`byWorkspace: Record<workspaceId, Furniture>`,store 顶层那几个字段只是当前空间
那一格的展开。换装 = 收旧的 → 摊新的,**同步完成、零请求**,所以「新世界一帧就位」
是结构保证而不是调快一点。选它而不是「persist 键带空间 id + `rehydrate()`」,
正是因为后者回的是 Promise,换装就有一帧出厂布局 —— 那看起来就是闪一下。

**接线**:`workspace/layout-scope.ts` 的 `startPerSpaceLayout()`,在 `main.tsx` 里
显式调一次(同 `startReadingAxes` / `startWorkspaceApply` 的体例)。**不在各 store
的模块作用域里接** —— 那会撞上既有的 import 环
(`stage/store → stage/items → stage/types → i18n → stage/store`),真机上表现为
启动即 TDZ 崩溃;病历写在那个文件头。

**迁移**:五个持久化槽各加一版(stage v5→v6、split v1→v2、openMode v1→v2、
expose 无版本→v1),存量那一份扁平档案**原样折进默认空间那一格**,零丢失、幂等。

**四条架子的快捷键**:⌘⌥← / → / ↓ / ↑,方向即语义;语义是**收 / 展**(可逆),
不是关整栏。施工前跑过全表冲突检查(9 条出厂全局键 + 5 条面域局部键),零冲突,
且这一族是出厂表里唯一带 ⌥ 的 —— 没挤掉任何既有键位。

**T-W2(切换动画)不在本批** —— 等 claude design 出稿。
