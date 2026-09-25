# 待办编辑器重做方案(2026-09-24)

> 状态:**方案,未动手,待用户拍板 §11**。起因:用户 09-24「好好调研一下,给我一个方案,现在完全用不了,一堆的bug」。
>
> 证据三路(都在本会话 scratchpad,可复跑):真机按键走查 15 条 bug(`todo-hunt/`,无头 Chromium + 真实按键 + CDP 组字)、同步链路审计 7 条全坐实 + 模糊测试(`todo-audit/`,5 个反例 vitest)、业界调研(Obsidian / Logseq / Tasks 插件 / CM6 / ProseMirror / Lexical / Yjs)。证据摘要 `todo-evidence.md`。
>
> 本文取代 `todo-editor-2026-09.md` 的 §1 技术栈与 §3/§5/§6 的实现部分;回车规则表(`todo-app-b-2026-09.md`)与「待办是一个 App」的外形裁定**逐字保留**。
>
> 设计:Fable;审阅(已并入):P0 前移 lineDiff/diff3、后端与壳用同一份 micromark 解析器(§14.2)。

## 0. 一句话

把「谁是文件的真相」收成一个对象,也就是后端的文档权威;把「一段字怎么在屏幕上被编辑」交给 CodeMirror 6 这个成熟的文本内核;把「一份待办 markdown 的结构语义」抽成一份零依赖的纯逻辑,放进 core。三者之间只用「带编号、带版本的字符变更」通信。

现在的 15 条真机 bug 和 7 条同步审计问题,病根只有三个:行没有身份、真相有三份、光标靠手写 contenteditable 拼出来。这三个病根都是骨架级的选择,不是「再修一轮」能治好的。

术语(下文第一次出现时还会就地再解释一句):

- **权威**:唯一有资格写这个文件的对象。
- **变更**:「从第几个字符到第几个字符,换成什么」的一小段。
- **版本**:权威每写一次就加一的整数。
- **diff3**:拿三份文本(共同的旧底、我的、对方的)自动合并,只有同一处两边都改了才报冲突。
- **装饰**:CodeMirror 在不改原文的前提下,给某段字换样式、把它藏起来、或在那里塞进一个小部件的机制。
- **组字**:中文输入法里,候选词还没上屏时的那段状态。

---

## 1. 为什么修补不行

证据里的 22 条问题按病根归堆后只剩三堆。每一堆都对应一个在今天的代码里结构上不存在的对象。

### 1.1 病根甲:真相有三份,行靠字面定位,批没有编号

同一时刻,一份待办有三份内容:

1. 文件本身。AI 用 `write` / `edit` 直接改它。
2. 后端 provider 每次读出来的快照。
3. 壳里 `EditorDocument.current` 那一份。

三份之间只靠两种手段拉齐:「字面对账」(`LineEdit.expect` 全文唯一匹配)和「外部事件触发重读」。审计 1–4、7、8,以及模糊测试 400 轮丢字 379 轮,全部源于这一点:

- **按原文定位**。`packages/core/text/line-edit.ts` 的 `locate` 靠「连续几行原文恰好相等」找位置。可日常文档天然有重复:两个空的 `- [ ] `、「甲、乙、乙」这样的清单,一找就多义(审计 2)。
- **后端锁不住,写也不原子**。`todo-provider.ts:222-233` 的 `edit` 路径是:拿自己的 `this.locks` → 读文件 → `applyBatch` → 整份 `writeFile`。它收到 `baseRevision` 却不看。这把锁和 AI 写工具用的 `withFileMutationQueue`(`packages/onething-runtime/src/tools/file-mutation-queue.ts`)互不认识。写文件的两个函数 `writeFileEnsured` 和 `writeTextFileAsync`(`packages/core/storage/json-file.ts:234`)都是截断后重写(审计 4)。
- **冲突整批丢,重发不幂等**。`editor-document.ts` 的冲突分支执行 `pending = []`,整批改动丢掉,连在飞期间才攒下的也一起丢(审计 1)。发送失败后放回队首重发,但批次没有编号,所以重放插入会重复,重放删除会删掉另一个同名项(审计 3)。
- **不比新旧**。`receive` 不比较版本,旧读数晚到时屏幕会倒退(审计 8)。

这一堆不能修补。修补的每一步,都是在「字面定位」上再加一层启发式:09-17 修过一次「重复行」,换个入口它又复发了(即 B2)。启发式的错法是无穷的。要换的是**协议**:

- 变更带编号,重发不会重复执行(幂等);
- 变更带基版本,新旧可以比较;
- 由一个权威把所有变更排成一条线(单一写者);
- 外部改动被权威折算成一个普通版本。

这样就不再有「对账」这个动作,只剩「映射」:把一个变更平移到新版本上。

### 1.2 病根乙:手写 contenteditable,自己扛浏览器的所有缝

`caret-controller.ts` 有 1284 行。B1、B3、B4、B6、B10、B11,以及「不能跨项选区、没有 ⌘A、没有 ⇧↓」这些缺口,都出自这里。

业界共识可以一句话概括:`beforeinput` 覆盖不全,组字期间不能动 DOM,选区映射的边界情况多,原生撤销一被程序改 DOM 就作废,所以应用团队自己写,bug 是收不完的。

本仓的经历正好印证了这一点。09-17 光标模型改了三版,页内自测 30/30 全绿;可是用真实按键一测,第一天就挖出了 B1–B3。原因是自测用的是合成事件,而合成事件恰好绕过了浏览器最难的三件事:折行处的矩形、组字、失焦后的重画。

### 1.3 病根丙:块切分不按 CommonMark

`units.ts` 用行正则切块,和消息用的 micromark 解析器不是同一套语义。B5、B9、B12、B13、B14 都是同一个病:编辑器里画得对,但写进文件的意思变了。

治法只有一个:把「列表树」当成一个对象来建模,每一次结构编辑都按 CommonMark 的容器规则算出结果。

### 1.4 对照表:每一条问题,由新设计里哪个对象让它在结构上不可能再发生

| 编号 | 现象 | 新对象 | 为什么不可能再发生 |
| --- | --- | --- | --- |
| B1 | 折行项里 ↓ 卡死、↑ 跳行 | CM6 `EditorView`(内核自带的垂直移动) | 按渲染后的视觉行和目标列来移动,不再自己取 `getClientRects()[0]` |
| B2 | 正在编辑的项被 AI 勾掉,变成两行 | `DocAuthority` + `DocSession` | 本地未发出的变更用 `ChangeSet.map` 平移到新版本上,不存在「找不到草稿就插回去」这一步 |
| B3 | 组字中遇到外部写入,组字串被抹掉 | `DocSession` 的组字闸 + CM6 的组字保护 | 远端更新等 `compositionend` 之后才进入状态 |
| B4 | 选区跨过记号边界,删除时吃掉半边 | CM6 原文逐字模型 + `LivePreview` 装饰 | 记号就是原文里的真实字符,删选区就是删这段原文 |
| B5 | 行首退格降为段落后,变成上一项的 lazy continuation(被 markdown 并进上一项的续行) | `structure.demoteToParagraph` | 上一行是列表项时,先垫一个空行 |
| B6 | 在段落或标题里按 Tab,焦点逃到勾选框 | `StructureKeymap` | Tab 永远由编辑器消费 |
| B7 | 外部写入之后撤销栈被清空 | CM6 `history` + 远端事务 `addToHistory:false` | 远端改动不进本地历史,本地历史条目被映射到新位置 |
| B8 | 非编辑态的键盘行为不合正本 | `BlockSelection` 块选区模式 | 「不在编辑」变成编辑器里的一种选区模式,由同一张键表处理 |
| B9 | 有序列表 Tab 只加 2 个空格,编号不重排 | `structure.indent` / `renumber` | 缩进量按父项的内容起点算,操作后同级重新编号 |
| B10 / B11 | 双击不选词 / ↑↓ 进出代码块丢失目标列 | CM6 内建 | 内核自带的行为 |
| B12 / B13 | 缩进不带子项 / 空嵌套项退格时抢走子项 | `markdown-tree` 的子树操作 | 结构命令的操作对象是树节点,不是单独一行 |
| B14 | 空文档点一下就多出空行 | 键表命令 | 鼠标只改选区,不改原文 |
| B15 | 500 项时首次回车 199ms | CM6 只渲染视口 + 按块增量算装饰 | 视口外的内容不渲染 |
| 缺口 | 跨项选区 / ⌘A / ⌥↑↓ / 拖拽 / 粘贴 | CM6 原生选区 + `BlockSelection` + `structure.move` + `ui/list-reorder` | 整篇文档是一个编辑器 |
| 审 1 | 冲突时整批丢弃 | `DocAuthority`(只做映射,从不拒绝)+ 冲突标记 | 变更只会被平移,不会被丢;同一处两边都改了,两边的字都落盘并做标记 |
| 审 2 | 全文唯一匹配有多义 | 变更用「字符偏移 + 基版本」表达 | 不存在「在全文里找位置」这个动作 |
| 审 3 | 重发不幂等 | `DocOp.opId` + 权威维护的已应用表 | 同一个 opId 再次到达时,直接返回第一次的结果 |
| 审 4 | 两把锁、写盘不原子、不看 baseRevision | 权威只经 `withFileMutationQueue` 写 + 原子写 + 每条 op 必带 `base` | 单一写者、同一把路径锁 |
| 审 5 | 撤销在外部改动后失效,或撤掉 AI 写的内容 | CM6 历史 + 远端事务 | 撤销只回滚本地事务 |
| 审 6 | 组字中遇到外部改动,整块 innerHTML 被重画 | 同 B3 | 同 B3 |
| 审 7 | 两个视图各有控制器,互相覆盖 | 一个地址对应一个 `DocSession` | 两个视图的事务都经过同一个会话,彼此以远端事务同步 |
| 审 8 | `\r\n` 被改写 / 旧读数让屏幕倒退 / 重开时用旧缓存 / 关窗时静默丢改动 | 权威保留原有换行符;版本单调递增;会话关闭前先 `drain()` 把队列发完 | 版本单调,且会话的寿命与未确认的变更绑定 |

---

## 2. 架构总图

```
apps/desktop-react(壳,只经 resources RPC / SSE)
  content/editing/            通用 markdown 编辑内核(不知道「待办」)
    DocSession                一个地址一份;持有 CM6 状态、未确认变更、组字闸、身份账本
    MarkdownEditor (React)    一个 EditorView 的宿主;两处视图 = 两个 EditorView 共用一个 DocSession
    LivePreview               装饰:从消息同一份 mdast 算出「藏记号 / 换样式 / 塞部件」
    StructureKeymap           回车规则表、Tab、退格、⌥↑↓、⌘B…;命令只产出变更,不碰 DOM
    BlockSelection            块选区模式(非编辑态、多选、拖拽)
  content/todo/               待办 App(头、切换、偏好、折叠、计划条),大体保留
  data/todo-source.ts         查询格 + DocTransport(pull / push / updates / 事件)

packages/backend/wiring/resource/todo-provider.ts   薄:解析地址、判断会话归属、效果分档 → 交给权威
packages/onething-runtime/src/todo/                 产品:DocAuthority(单一写者)、SemanticOps(AI 的锚点解析)、外部改动折算
packages/core/text/                                 纯逻辑:TextChange、markdown-tree(CommonMark 列表树)、lineDiff/diff3、anchor、ledger
```

依赖方向不变:core ← runtime ← backend ← 壳。新协议全部装在现有 `todo:` 资源的读法、做法和事件里,不开新通道。

---

## 3. 对象与接口

### 3.1 core:`packages/core/text/`(零依赖,壳和后端共用)

**`TextChange`** 是整套协议的原子单位。它就是 CodeMirror `ChangeSpec` 的一个子集,所以壳里不需要任何转换。

```ts
export interface TextChange { readonly from: number; readonly to: number; readonly insert: string }
/** 一批变更:按 from 升序、互不重叠、全部相对于同一份基文本。 */
export type ChangeBatch = readonly TextChange[]
export function applyChanges(text: string, changes: ChangeBatch): string
```

**`lineDiff` / `diff3`** 把两份或三份文本按行比出变更。使用者有两个:权威,用它把外部改动折算成一个版本;`DocSession`,在基版本太旧时用它兜底重放。壳里现有的 `content/code/line-diff.ts`(Myers 算法,两万行 ≤ 50ms)搬进 core。

```ts
export function lineDiff(before: string, after: string): ChangeBatch
export type Diff3Chunk = { kind: 'stable'; text: string } | { kind: 'conflict'; base: string; ours: string; theirs: string }
export function diff3(base: string, ours: string, theirs: string): { chunks: Diff3Chunk[]; clean: boolean }
```

**`MarkdownTree`** 是待办 markdown 的结构模型:小节、列表项树、段落、代码块,每个节点都带字符范围。它从 mdast 建树,壳和后端都用 micromark 解析(见 §14.2)。core 本身不引入依赖:mdast 由调用方解析好了传进来,core 只定义 `MdastLike` 的形状。

```ts
export interface ItemNode {
  readonly id: ItemId
  readonly from: number; readonly to: number          // 整棵子树的字符范围
  readonly marker: '-' | '*' | '+' | { ordered: number; delim: '.' | ')' }
  readonly indent: number
  readonly contentOffset: number                      // 内容起点 = 子项缩进的基准(CommonMark)
  readonly task: boolean | null
  readonly done: boolean
  readonly text: string
  readonly children: readonly ItemNode[]
}
export interface DocTree { readonly sections: readonly SectionNode[]; readonly all: readonly ItemNode[] }
export function buildTree(text: string, mdast: MdastLike, ledger?: ItemLedger): DocTree

export interface StructureResult { readonly changes: ChangeBatch; readonly selection: { anchor: number; head: number } }
export const structure: {
  splitItem(tree: DocTree, at: number): StructureResult               // 回车规则表
  enterOnEmpty(tree: DocTree, at: number): StructureResult
  backspaceAtStart(tree: DocTree, at: number): StructureResult
  deleteAtEnd(tree: DocTree, at: number): StructureResult
  indent(tree: DocTree, ids: readonly ItemId[], delta: -1 | 1): StructureResult   // 带子树;有序项按编号宽度
  move(tree: DocTree, ids: readonly ItemId[], to: { after: ItemId | null; parent: ItemId | null }): StructureResult
  toggle(tree: DocTree, ids: readonly ItemId[], done?: boolean): StructureResult
  demoteToParagraph(tree: DocTree, id: ItemId): StructureResult       // 垫空行,不产生 lazy continuation
  renumber(tree: DocTree, parent: ItemId | null): ChangeBatch
  toggleMark(text: string, sel: { from: number; to: number }, kind: 'strong' | 'em' | 'code'): StructureResult
}
```

**`Anchor`** 是 AI 和脚本指着某一项说「就是它」的方式,由三部分组成:原文、同文序号、版本。

```ts
export interface Anchor { readonly text: string; readonly nth?: number; readonly version?: number }
export type Resolved =
  | { ok: true; item: ItemNode }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'ambiguous'; candidates: readonly { nth: number; line: number; text: string }[] }
  | { ok: false; reason: 'stale'; currentVersion: number }
export function resolveAnchor(tree: DocTree, anchor: Anchor, currentVersion: number): Resolved
```

**`ItemLedger`** 是项的运行时身份账本:每个身份跟着一段原文走,原文被变更挪了位置,身份也跟着挪。它从 `editing/line-ids.ts` 推广而来。

```ts
export type ItemId = string & { readonly __brand: 'ItemId' }
export interface ItemLedger {
  idAt(from: number): ItemId | undefined
  map(changes: ChangeBatch): ItemLedger
  adopt(tree: DocTree): ItemLedger
}
```

### 3.2 runtime:`packages/onething-runtime/src/todo/`

**`DocAuthority`**:一个文件路径对应一个实例,是**唯一**能把这份文档写到磁盘的对象。它由 `AuthorityRegistry` 持有,按路径惰性创建,闲置后回收。它维护一条线性的版本历史;壳里的编辑器、AI 的语义工具、外部改动,所有写入者都被排进这一条线。

```ts
export interface DocOp {
  readonly opId: string          // 客户端生成的 UUID;同一个 opId 重发是幂等的
  readonly base: number          // 这批变更是相对哪个版本算的
  readonly changes: ChangeBatch
  readonly origin: 'ui' | 'ai' | 'plugin'
}
export interface Update { readonly version: number; readonly changes: ChangeBatch; readonly origin: DocOp['origin'] | 'external'; readonly opId?: string }
export type ApplyOutcome =
  | { ok: true; version: number; rebased: boolean; conflicts: readonly ConflictSpan[] }
  | { ok: false; reason: 'stale-base'; currentVersion: number }   // base 比日志还旧:客户端整份重拉后用 diff3 重放
  | { ok: false; reason: 'missing' }

export interface DocAuthority {
  readonly path: string
  snapshot(): { version: number; text: string; eol: '\n' | '\r\n' }
  updatesSince(version: number): readonly Update[] | null
  apply(op: DocOp): Promise<ApplyOutcome>
  absorbExternal(): Promise<Update | null>
  subscribe(listener: (update: Update) => void): () => void
  dispose(): Promise<void>
}
export interface AuthorityPorts {
  readFile(path: string): Promise<{ text: string; mtimeMs: number } | null>
  writeAtomic(path: string, text: string): Promise<void>            // 临时文件 + rename
  withPathLock<T>(path: string, work: () => Promise<T>): Promise<T> // 就是 tools/file-mutation-queue.ts 那一把
  now(): number
}
```

`apply` 的执行顺序是整个同步模型的核心:

1. 按 opId 查已应用表,查到了就原样返回上次的结果。
2. 拿路径锁。
3. 在锁内检查磁盘的 mtime 是否和上次写入时一致。不一致说明有外部改动漏过了监听器,先执行 `absorbExternal`。
4. 用 `@codemirror/state` 的 `ChangeSet.map`,把相对 `op.base` 的变更映射过 base 之后的所有版本,得到相对当前版本的变更。
5. 如果映射后和某条中间变更碰到了同一段,两边的字都保留,把这一段记进 `conflicts`。
6. 原子写盘,版本加一,记下 opId 和结果,释放锁。
7. 发出 `changed { version, origin, opId }` 事件。

**`SemanticOps`** 是给 AI、插件和脚本用的「按项说话」的做法,共五个:`tick`、`add`、`set`、`remove`、`move`,另有一个读法 `outline`。锚点解析失败时拒绝执行,并把候选项原样交回。

**`ExternalChangeFolder`**:把 `OnethingTodoPlanWatcher` 报来的「文件被改了」翻译成 `authority.absorbExternal()`。自己写盘产生的回声,仍然用 `wasSelfWrite` 按内容跳过。

`OnethingTodoPlanStore` / `Watcher` 保留;去掉 `updateDocument` 的整份写,改由权威来写。

### 3.3 backend:`todo-provider.ts` 变薄

保留地址解析、会话归属、效果分档和事件转发。`edit` 改为接收 `DocOp`;新增读法 `pull` / `updates` / `outline` 和做法 `tick` / `add` / `set` / `remove` / `move`,每一条都一行转发给权威或 `SemanticOps`。

### 3.4 壳:`content/editing/`(通用,不认识待办)

**`DocSession`**:一个地址一份,持有规范的 `EditorState`、未确认的 `DocOp` 队列、组字闸、`ItemLedger` 和冲突标记;所有视图的事务都经过它。最后一个视图卸载时,注册表先执行 `drain()` 把队列发完,期间保持会话存活。

```ts
export interface DocTransport {
  pull(ref: string): Promise<{ version: number; text: string }>
  push(ref: string, op: DocOp): Promise<ApplyOutcome>
  updates(ref: string, since: number): Promise<readonly Update[] | null>
  onUpdate(ref: string, listener: (u: { version: number; opId?: string; origin: string }) => void): () => void
}
export class DocSession {
  constructor(ref: string, transport: DocTransport, extensions: readonly Extension[])
  readonly state: EditorState
  readonly version: number
  attach(view: EditorView): () => void
  dispatch(tr: Transaction, from: EditorView): void   // 本地事务 → 规范状态 → 以 remote 广播给其他视图 → 排队发送
  composing(on: boolean): void
  drain(): Promise<void>
  readonly ledger: ItemLedger
  readonly conflicts: ReadonlySet<ItemId>
}
```

发送策略照搬 `@codemirror/collab` 的形状:

- 同一时刻只有一批在飞。
- 确认回来后推进版本号。
- 远端更新到达时,把未确认的本地变更映射到新版本上。
- 发送失败时,用原 opId 重发。
- 收到 `stale-base` 时整份 `pull`,再用 `diff3(旧底, 本地, 新底)` 重放未确认的改动;冲突的段落标进 `conflicts`,不丢。

**`LivePreview`**:一个 CodeMirror 扩展。装饰按**消息那一份解析器**(`content/markdown/parse.ts`)来算:

- 光标不在的块,藏起记号;
- 行内元素套上 `InlineRun.module.css` 和各 kind 的同一批 class;
- 任务前缀换成勾选框部件;
- 保留三档显示策略。

**`StructureKeymap`**:把 09-18 回车规则表(逐字不改)、Tab / ⇧Tab、退格、Delete、⌥↑↓、⌘B / ⌘I / ⌘E 装成一张 CodeMirror 键表。每条命令的流程都是:建树 → `structure.xxx` → `dispatch`。

**`BlockSelection`**:一个 `StateField`,形状是 `{ mode: 'text' | 'block'; items: ItemId[]; anchor: ItemId }`。键位如下:

- Esc 从文本模式退到块模式;
- ↑↓ 在项之间走,⇧↑↓ 扩选;
- Space 勾选,↵ 回到文本模式;
- ⌫ 删掉选中的项(可以撤销),⌥↑↓ 挪项;
- ⌘A 分两段:先选本项,再选整篇。

拖拽排序消费 `ui/list-reorder`。

**`MarkdownEditor`**(React 组件):建视图、`attach` 到会话。勾选框和折叠行用 `createPortal` 渲染成 `ui/Checkbox` / `ButtonBase`。已完成收起、小节折叠用块级 `Decoration.replace` 实现,原文一个字不动。焦点树的 `restingTarget` 就是 CM 的 `contentDOM`。

### 3.5 壳:`content/todo/`(待办 App,大体保留)

逐字保留:`TodoHeader`、`TodoSwitcher`、`TodoMenus`、`panel-state`、`preferences`、`plan-strip`、`plan-model`、`TodoPanel`。

需要改写的三个:

- `todo-view.ts`:输入改成 `DocTree`;
- `TodoDocView`:改成 `MarkdownEditor` + 待办作用域;
- `todo-document.ts`:改成 `DocSession` 注册表。

---

## 4. 编辑内核:CodeMirror 6

### 4.1 理由

1. **它解决的正是我们自己解不完的那一层**:组字、折行时的光标、目标列、跨行选区、双击和三击、字形簇、撤销。
2. **原文逐字**。它存的就是原文字符串,写回时不经过「树 → markdown」的序列化,所以 `*` 还是 `*`,紧凑列表也不会变松散。树模型的编辑器(ProseMirror、Tiptap、Lexical、Milkdown、BlockNote)在 markdown 往返时都有损,而且做不出「编辑态显示淡灰记号」的效果。
3. **远端事务是一等公民**。`Transaction.remote`、`addToHistory.of(false)` 加上历史映射,正是审计 5 和 7 要的能力;`@codemirror/collab` 的形状和本方案的权威一一对应。
4. **只渲染视口**,撑得住几千项。
5. **纯 JS**,不碰「原生模块只许 N-API」那条法。

### 4.2 「和消息一样」怎么保住

> 09-25 用户重申:「我希望他的样式和聊天内容的样式一致」。本节按这条硬要求改写,**样式一致是验收红线,不是目标**。

当初否掉 CM6 的理由是「要用消息的 React 块组件来渲染」。但今天的实现早就不是这样了:`EditableDoc.tsx` 用共享画笔 `paint.ts` 拼 `innerHTML`,直接 import 各 kind 的 CSS Module,还在 `EditableDoc.module.css` 里**抄了一份**消息的节奏表(自己的文件头写着「留账:抽出来」)。也就是说,「两个产地」今天已经存在,而且没有任何门在比对它们。

新设计按块的种类分两条路,让「一致」要么是**同一个组件**,要么是**同一份 CSS 加一道逐像素量的门**:

**第一条路:物件块直接用消息的组件画。** 代码块、表格、公式、mermaid 图、图片、分隔线,在光标不在里面时,用 CM6 的块级替换装饰(`Decoration.replace({ block: true })`)换成一个部件。部件里用 portal 挂的就是消息的 `BlockView`,和聊天里是同一个 React 组件、同一份 props。这些块和消息逐字相同,不需要证明。光标进入这个块时,才换成淡灰记号的原文供编辑,这就是 Obsidian 处理表格和嵌入的方式。

**第二条路:文字块用同一份 CSS。** 段落、标题、列表项、任务项、引用是要在里面打字的,不能是部件,必须是 CM6 自己的文字行。它们这样对齐消息:

- **字体、字号、行高、颜色、字重**:行装饰(`Decoration.line`)直接挂 `Paragraph.module.css`、`Heading.module.css`、`List.module.css`、`Quote.module.css` 导出的 class,不写第二份值。
- **行内格式**(粗体、斜体、行内码、链接、公式):标记装饰(`Decoration.mark`)挂 `InlineRun.module.css` 的 class。
- **行首符号**(圆点、序号、勾选框):部件装饰画,勾选框就是 `ui/Checkbox`,圆点和序号用 `List.module.css` 的 marker class。
- **缩进**:用消息同一组 `--indent-1` token。

**唯一不能原样搬的是块与块之间的间距。** 消息用 `margin-block-start` 按「上一块是什么、下一块是什么」取节奏 token(`ChatStream.module.css` 那张节奏表:`--pr-gap` / `--pr-li` / `--pr-h2-top` / `--pr-obj`…)。CM6 按行测高,行上的外边距不计入它的高度表,会让点击落点和滚动错位,所以编辑器这一侧必须用**内边距**表达同样的距离。处理办法:

- 把节奏表从 CSS 注释和选择器里抽成一份数据 `content/markdown/rhythm.ts`,内容是「(上一块种类,下一块种类)→ token 名」。
- 编辑器的行装饰读这张表,把 token 写成 `padding-top`。
- 消息那一侧不动;另写一条单测,逐对核对 `ChatStream.module.css` 的邻接规则和 `rhythm.ts` 给出同一个 token。
- `EditableDoc.module.css` 里抄的那份随旧编辑器一起删掉。

**用门证明一致(`gate:todo-parity`,进 `verify`)。** 同一份夹具,覆盖每种块、每种行内格式、三层嵌套、中英混排折行:

1. 在聊天消息里渲染一遍,在编辑器静止态渲染一遍,容器同宽。
2. 逐个文字行比较:`getBoundingClientRect` 的 top、left、height 误差 ≤ 0.5px;`getComputedStyle` 的 font-family、font-size、line-height、font-weight、color 逐字相等。
3. 逐个物件块比较盒子尺寸与位置。
4. 两张截图做像素 diff,只允许勾选框可点态这一类列明的差异。
5. dev、prod 两档,亮、暗两套主题都跑。

改了消息的样式而没改编辑器(或者反过来),这道门当场变红。今天的实现连这道门都没有。

**编辑态**(光标所在的那一块)和旧正本 A 方案一样:字形不变,只多出淡灰的 markdown 记号。

**先做样机,再定内核。** CM6 行模型能不能做到上面这些,不靠论证,靠 P3-0 的样机加这道门的读数(§13)。如果样机证明做不到逐像素一致,退路是旧正本留的那条缝:静止的项继续用消息组件画,CM6 只做「正在编辑的那一项」的编辑器。代价是跨项选区做不了,但同步层(P0–P2)照样换,数据问题照样根治。

**这推翻了一条旧裁定,列在 §11 第 1 条,等你拍板。**

### 4.3 新依赖

| 包 | 用途 | 约 min+gz |
| --- | --- | --- |
| `@codemirror/state` | 文档、变更、事务、映射(纯 JS,零依赖,Node 下也能用;权威和壳用同一套映射算法) | 25 KB |
| `@codemirror/view` | 渲染、输入、组字、选区、视口 | 45 KB |
| `@codemirror/commands` | 历史、光标命令 | 8 KB |
| `@codemirror/collab` | 客户端未确认队列 | 2 KB |

合计约 80 KB gz,全是纯 JS。`@codemirror/state` 同时进入 `packages/onething-runtime`;core 仍然零依赖。`MarkdownEditor.tsx` 文件头要写一句 `ui-consume-allow`,说明 CM 的 contentDOM 属于作用域内部。

---

## 5. 项身份:不写进 markdown

任何隐藏 id(`^abc`、HTML 注释)都会被 AI 的 `edit` 复制、被 Obsidian 当成块 id、被用户看见后删掉。Obsidian Tasks 插件多年的做法也是「文件 + 行号 + 原文」定位,改之前先复核原文。

运行时身份分三层:

1. **壳内**用 `ItemLedger`。它用于 React key、块选区、冲突标记和折叠状态。折叠状态今天按标题文字记,一改标题就丢了;改成按身份记。
2. **权威内**用同一套算法,服务于 `outline` 和语义做法。不跨进程,也不落盘。
3. **跨进程**(AI、脚本)用 `Anchor { text, nth, version }`。找不到、有多个候选、版本对不上,都结构化地拒绝,并把候选项交回。

---

## 6. AI 侧:打开结构化 `todo` 工具

`catalog-sync.ts` 的规则是「provider 在注册表里,工具就在目录里」。所以只要把 `resource-spec.ts:56` 的 `exposure.aiTool` 打开,工具就会自动生成。

- **读法**:`outline`,返回带 nth、行号和 version 的结构。
- **做法**:按锚点执行 `tick` / `add` / `set` / `remove` / `move`,另有按字符范围执行的 `edit`。
- **失败语义**:`missing`、`ambiguous(candidates)`、`stale(currentVersion)` 三种结构化拒绝,永远不会静默改错项。
- **提示词**:`prompts/content/todo-rules.md` 改成「改清单用 `todo` 工具;`write` 只在新建计划时用」。
- **旧路不禁止**:AI 仍然可以用 `write` / `edit` 直接改文件。这条路走 `withFileMutationQueue` + 监听器 → `absorbExternal`,和权威共用一把锁、一条版本线。

这是用户能感知到的行为变化,列在 §11 第 2 条。

---

## 7. 结构编辑按 CommonMark

每一条规则都有往返测试:操作后的文本交给 micromark 解析,得到的 AST 必须等于「意图的 AST」。

- **子项缩进量**等于父项的 `contentOffset`:`- ` 是 2,`1) ` 是 3,`10. ` 是 4。
- **缩进和反缩进**作用于整棵子树。
- **有序列表**在拆项、删项、挪项之后,同级重新编号。
- **降为段落**时,如果上一行或下一行是列表项,就垫一个空行,让它不会被并进上一项的续行。
- **回车规则表**(09-18)逐字照做。
- **换行符**:权威记住文件原来的 `eol`,写回时还原;壳内一律用 `\n`。

---

## 8. 块选区、多选、移动、拖拽

- **两种模式**:文本模式就是 CM 原生选区,可以跨项、可以 ⌘A;块模式是一组项身份。
- **⌥↑↓**:在两种模式下都作用于「光标所在项 / 选中项」的整棵子树;跨小节时越过标题。
- **拖拽**:项行左缘有把手,hover 时才出现,消费 `ui/list-reorder` 和 `ui/drag`;放下时执行 `structure.move`。拖到切换弹层里的另一个清单名上,就发两条 op,任一条失败都回滚另一条。
- **右键菜单**仍然是动作的唯一产地:删除、上移、下移、复制文字、转成会话。

---

## 9. 多视图与性能

- **多视图**:计划抽屉和待办窗打开同一个地址时,共用一个 `DocSession`、各有一个 `EditorView`。一边的事务以 `remote` 身份广播给另一边,不进对方的撤销历史。换宿主只是重挂视图,会话和队列都不动。
- **预算**(进 `gate:todo`,dev 和 prod 两档):
  - 3000 项的清单,冷开到上屏:prod ≤ 150ms,dev ≤ 300ms;
  - 任一按键 ≤ 16ms 一帧;
  - 外部改动到屏幕 ≤ 100ms;
  - 滚动时零个 ≥50ms 的长帧。
- **做法**:CM 只渲染视口;装饰按顶层块增量算(复用 `markdown/stable-cut.ts` 的切块思路),视口外的块等空闲时再算;权威的 `updatesSince` 日志最多存 512 条,超出就走 `stale-base` 整份重拉。

---

## 10. 迁移与删除

| 文件 | 处置 |
| --- | --- |
| `editing/caret-controller.ts`、`EditableDoc.tsx`、`units.ts`、`split.ts`、`paint.ts`、`inline-tokens.ts`、`editor-document.ts`、`doc-history.ts` | **删除**。`enter-rules.test.tsx` 的 17 条用例改写成针对 `structure.*` 的纯函数测试,规则不变 |
| `editing/line-ids.ts`、`reveal.ts`、`fold-row.ts` | 搬家:line-ids 变成 core 的 `ItemLedger`,reveal 变成 LivePreview 的三个策略,fold-row 变成折叠部件 |
| `content/code/line-diff.ts` | 搬进 core,壳里 re-export |
| `content/todo/` 的头、切换、菜单、偏好、计划条、面板、`editor-claims.ts` | 保留 |
| `content/todo/todo-view.ts`、`TodoDocView.tsx`、`todo-document.ts` | 改写 |
| `data/todo-source.ts` | 保留,新增 `DocTransport` |
| `dev/TodoLab.tsx` | 保留。页内自测只留纯模型断言,**所有按键类测试搬进真机门** |
| `packages/core/text/line-edit.ts` | P2 之后没有消费者,即删 |
| `todo-provider.ts`、`resource-spec.ts` | 改写成薄转发 + 新的自述 |
| `todo-plan/store.ts`、`watcher.ts` | 保留;store 去掉整份写 |
| 旧 `todo-plan` 域(`shared/ipc/todo-plan.ts`、`rpc/domains/todo-plan.ts`、`todo-plan/ipc-operations.ts`、`wiring/todo-plan/store.ts`、`/api/todo-plan/events`、`todoPlanWindowRouter`) | 退役(即一直没做的 T5)。壳里已经零消费者 |
| `settings.general.todoPlan.{cardHeight,pinned,docked,autonomy}` | Vue 时代的化石,随 T5 删除;保留 `enabled` / `directory` |

---

## 11. 需要你拍板

1. **推翻「不用 CodeMirror」**(旧正本 §1.1),前提是 P3-0 样机通过 `gate:todo-parity`。推荐用。理由:物件块直接用消息的组件画,文字块用同一份 CSS,再加一道逐像素的门,样式一致是能被证明的;今天的手写画笔反而是一份没有门看着的第二套。样机不过门,就走 §4.2 的退路。
2. **AI 改用结构化 `todo` 工具**。推荐开。理由:AI 走通用写工具,正是丢字问题的另一半病根;用结构化工具,「勾一项」永远勾对项,勾不到就明说。
3. **冲突的落地形式**:同一处两边都改了,两边的字都留在文件里(先对方、后我的,相邻放);壳里给这一项标黄,右键提供「保留我的 / 保留对方」;文件里不写任何冲突标记。推荐这样,因为这是「永不丢字」和「文件干净」同时成立的唯一办法。
4. **项身份不写进文件**。推荐不写。
5. **`\r\n` 保留原样**(今天会整份改写成 `\n`)。推荐保留。
6. **旧 `todo-plan` 域和 Vue 时代的设置字段退役**。推荐随 P6 一起做。
7. **AI 写工具改成原子写**(`writeTextFileAsync` 改为临时文件 + rename)。推荐改,全仓受益;副作用是符号链接文件会被替换成普通文件,今天没有这种用法。
8. **块模式下 ⌫ 直接删,还是先确认**。推荐直接删,⌘Z 可以撤回。

---

## 12. 陌生能力演练(根 CLAUDE.md 09-02 法)

**甲:截止日期 + 提醒。** 需要动的是:

- `onething-runtime/src/todo/abilities/due.ts`:能力模块。认出项尾的 `📅 2026-10-01` 尾缀;新增做法 `setDue`;提醒经现有的 `scheduler` 域登记。
- `content/editing/widgets/DueChip.tsx`:渲染件,一个装饰生产者,把尾缀画成小胶囊。
- 两行注册:`resource-spec.ts` 的 `ops` 加一格,`livePreview` 的 decorators 表加一行。

**乙:把一项转成会话 / 派给 AI 去做。** 需要动的是:

- `todo/abilities/handoff.ts`:能力模块。读取这一项的子树,经 `session` 资源建会话,再把会话链接写回原项的尾缀。
- `content/todo/menus/handoff-item.tsx`:渲染件,右键菜单里的一行,加上项尾的链接部件。
- 两行注册。

两个答案都是「能力模块 + 渲染件 + 各一行注册」,内核零改动。反过来检查:`DocAuthority`、`DocSession`、`LivePreview`、`StructureKeymap` 里没有出现「待办」「截止」「会话」任何一个词。

---

## 13. 分期

### 13.1 总览

| 期 | 名字 | 交付 | 规模(估) |
| --- | --- | --- | --- |
| P0 | 止血 | 不换内核,先堵住丢数据 | 3 天,约 600 行 |
| P1 | core 纯件 | TextChange、MarkdownTree + structure、Anchor、ItemLedger(lineDiff/diff3 在 P0 已落地) | 4 天,约 1500 行(含测试) |
| P2 | 后端权威 | DocAuthority、SemanticOps、原子写、共用锁、监听折算、provider 改写、打开 AI 工具 | 5–6 天,约 1600 行 |
| P3-0 | 样式样机 | 实验台夹具在 CM6 里按 §4.2 两条路画出来 + `rhythm.ts` + `gate:todo-parity`;同时量 B1 折行、组字、500 项首屏。读数决定走 CM6 还是退路 | 2 天,样机代码不进产品 |
| P3 | 编辑内核 | DocSession、DocTransport、LivePreview、MarkdownEditor、部件宿主、视觉对照门 | 7–8 天,约 2200 行 |
| P4 | 结构与选区 | StructureKeymap、BlockSelection、⌥↑↓、拖拽、右键菜单 | 5–6 天,约 1400 行 |
| P5 | 待办 App 接线 | 视图接新内核、计划条、折叠和收起、偏好改按身份记、删掉旧 editing/ | 4–5 天,净减约 2500 行 |
| P6 | 门与退役 | 真机按键门、交错模糊门、往返门、性能门进 `verify`;旧域退役 | 4–5 天 |

单人合计约 6–7 周。依赖关系:P1 和 P2 可以并行;P3 依赖 P1;P4 依赖 P1 和 P3;P5 依赖 P2 和 P4。

### 13.2 P0 止血(不换内核)

**性价比先说清楚。** 后端那一半(共用锁、原子写、版本比较、opId 幂等、`lineDiff` / `diff3`)在 P2 里原样保留,不会白做。壳那一半只有几条几行的闸门,会随 P5 一起删掉,白做的部分不到 40 行,可以忽略。所以值得做。做完之后,重写期间至少不会再丢字。但 B1、B4、B8、B9、B12 这些光标和结构问题,止血不治:要治就等于重写 caret-controller,那才是真的白做。

交付:

1. **`lineDiff` / `diff3` 进 core**(原稿排在 P1,审阅时前移,因为第 3 条要用)。
2. **`todo-provider.ts`**:
   - 锁换成 `withFileMutationQueue`;
   - `edit` 接收 `opId`,用一张 LRU(256 条)做幂等;
   - `baseRevision` 和当前版本相同时,直接按 `start` 应用,不同时才走 `locate`;
   - 写盘改用新的 `writeTextFileAtomic`。
3. **`editor-document.ts`**:冲突时不清 `pending`,改为重读之后用 diff3 重放,合不上的段落保留本地文字;`receive` 按单调序号丢弃旧读数。
4. **组字闸**:组字期间收到的 `server` 变化,推迟到 `compositionend` 之后再应用;`caret-controller.ts:1049` 在非列表单元里按 Tab 时 `preventDefault`。
5. **`todo-document.ts`**:`release` 时先 `await drain()`。

验收(代理可以自证):

- 审计的反例测试中,1、3、4、6、8 转绿;2、5、7 仍然红,如实记录。
- 模糊测试「仅 AI 且只插互不干扰的唯一新行」,400 轮里的丢字从 341 降到 0。
- `gate:todo` 现有的十三步不退。

### 13.3 P1 core 纯件

文件:`packages/core/text/{text-change,markdown-tree,structure,anchor,ledger}.ts` 以及测试。

验收:

- **往返属性测试**:随机生成 200 份文档,在随机位置执行每一种结构命令,micromark 解析后的 AST 与意图一致,lazy continuation 零出现。
- `structure` 覆盖回车规则表的每一格。
- `ItemLedger.map` 的身份守恒测试。
- `boundary` 为 0。

### 13.4 P2 后端权威

文件:`onething-runtime/src/todo/{authority,registry,semantic-ops,external}.ts`、`resource-spec.ts`、`store.ts`、`json-file.ts`、`todo-provider.ts`、`backend.ts`(装配一行)、`todo-rules.md`;`onething-runtime/package.json` 新增 `@codemirror/state`、`mdast-util-from-markdown`、`micromark-extension-gfm`、`mdast-util-gfm`,全是纯 JS。

验收:

- 审计的 7 条反例全部转绿。
- **新的交错模糊门 `gate:todo-sync`**:用隔离的 store 和真实后端进程,跑 400 轮 × 40 步,随机混合五种写入:壳 op、AI 语义工具、AI 用 `edit` 直接写文件、外部 `fs.writeFile`、网络故障(丢包、重放、乱序)。要满足的不变量:
  - 每个唯一 token 恰好出现一次;
  - 版本单调递增;
  - 文件永远能被 micromark 解析,没有写到一半的状态。
  - 要求 **0/400 丢字**。
- `gate:native` 不变。

### 13.5 P3 编辑内核

文件:`content/editing/{doc-session,doc-transport,live-preview,reveal-policies,widget-host,MarkdownEditor}` 与 decorators、`todo-source.ts`、`package.json`。

验收:

- **新的真机按键门 `gate:todo-keys`**:离屏运行,只用 CDP 的 `Input.dispatchKeyEvent`,组字用 `Input.imeSetComposition`,禁止 JS 合成事件。每一步对应一条 bug:
  - B1:窄面板里的折行项,按 ↑↑↓↓↓↑ 能回到原位;
  - B3:组字中外部写入,组字串完好;
  - B2:编辑中 AI 勾掉本项,不出现重复行;
  - B4:跨粗体选区删除后,记号仍然成对;
  - B6:Tab 后焦点不动;
  - B7:外部写入后 ⌘Z 仍然撤本地的上一步;
  - B10 / B11 各一步。
- 视觉对照门。
- 500 项和 3000 项两档的性能读数。

### 13.6 P4 结构与选区

`enter-rules` 的 17 条迁成纯函数测试后全绿;`gate:todo-keys` 为 B5、B9、B12、B13、B14 各加一步(落盘文本用 micromark 复核);块模式键表的每一格各一步;拖拽一步。

### 13.7 P5 待办 App 接线

`gate:todo` 现有十三步在新内核上全绿;`gate:a11y` 零违例;`gate:focus` 验证抽屉里编辑时按 Esc 只退出编辑;`ui:consume` 零新增;删除 §10 表里标了「删除」的文件。

### 13.8 P6 门与退役

新门进 `npm run verify`;旧域退役,全仓 grep 零引用,`transport:gate` 的基线收紧。

---

## 14. 风险与未决

1. **装饰与组字**:组字期间不重算光标附近的装饰(用 `EditorView.composing` 判断),否则输入法的候选框会跳。真机门 B3 那一步就是它的守卫。
2. **解析器(审阅后改)**:原稿让后端写一份「行级 CommonMark 子集」解析器,用对照测试钉住。审阅意见:这等于重新造出了今天 `units.ts` 和 micromark 语义不一致的病,也就是 B5 的根子。micromark 和 mdast 都是纯 JS,后端直接依赖同一份就行,于是壳和后端只有一套语义,这条风险消失。代价是 runtime 多几个纯 JS 依赖。
3. **`stale-base` 重放**:客户端离线太久(超过 512 条)时要整份重拉,再做 diff3。这条路走得少,但一旦出错代价高,所以交错模糊门里专门设一档「长离线」。
4. **写盘节流**:停手 400ms 才发一次 op,每个 op 一次原子写。AI 高频勾选时,Obsidian 这类外部编辑器会频繁看到 rename;它的实际行为要真机看。
5. **勾选框用 portal**:`WidgetHost` 要按 key 复用容器;门里要量「勾选前后是同一个 DOM 节点」。
6. **焦点树与 CM**:开工第一步,先真机核一遍 Edit 菜单里的 `undo` 角色会不会抢先吃掉 ⌘Z(旧正本 §6.4 留下的账)。
7. **未决**:
   - 代码块在编辑态要不要语法高亮(第一版不做);
   - 多行粘贴的拆项规则(建议每行一项,空行保留);
   - AI 是否可以改**用户自己的清单**(建议允许,但提示词保持「不删项」)。
