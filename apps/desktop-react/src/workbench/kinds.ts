import type { ReactNode } from 'react'
import type { PanelVisibility } from '../content/visibility'
import type { FocusScopeId } from '../focus/types'
import type { LiveTitle } from '../stage/live-title'
import type { RegionId } from './regions'

/**
 * **内容模型**(设计 `apps/desktop-react/docs/workbench-2026-09.md` §1.1)。
 *
 * 一句话:**屏幕上任何一块能看的东西都是一个「内容引用」**;引用住在某棵拼贴树的
 * 叶子里;每棵树归一个区域持有(`./regions.ts`)。
 *
 * ── 这只文件里为什么一个种类名都没有 ──────────────────────────────────────
 * 「加功能不许改骨架」那条法在这里的字面落地:核心层只认 `{kind, key}` 两个
 * 字符串,**每一种内容在自己的模块里 register 一次**,核心层只读表。于是
 * 「终端实例按 cwd 各一个当 tab」这种设计时没想过的能力,要改的文件是
 * `content/kinds/terminal.tsx`(它自己)+ `content/kinds/index.ts` 一行登记 ——
 * 树、区域、隐藏、文件树标记、持久化一个字不动。演练全文在设计 §7。
 *
 * 判据:**凡「按种类枚举」的地方改成「种类自述、别人读表」**。这只文件是那张表。
 *
 * ── 与 `stage/items.ts` 的关系 ────────────────────────────────────────────
 * `STAGE_ITEMS` 是 Dock 上那 12 块瓦的**静态声明**,它整体登记成 `panel` 这一种
 * (`content/kinds/panel.tsx`,`key` = 瓦 id,`singleton: true`)。查看器从「一块瓦」
 * 降格为 `file` 这一种(`key` = 绝对路径,不是单例:两个文件两份实例),
 * 聊天区登记成 `session`(W5-b:`key` = 会话 id,**不是单例** —— 两条会话可以
 * 并排各占一片叶)。三种各在自己的模块里,谁都不认识谁。
 */

/**
 * 一块内容的身份。`kind` 是种类名,`key` 是这一种里的哪一个。
 * 核心层只认这两个字符串 —— 它不知道 `key` 是路径、瓦 id 还是会话 id。
 */
export interface ContentRef {
  readonly kind: string
  readonly key: string
}

/** `refId` 是这块内容在全应用的唯一名字:memo 的 key、live-title 的键、树里的定位都用它。 */
export type ContentRefId = string

export const refId = (ref: ContentRef): ContentRefId => `${ref.kind}:${ref.key}`

/**
 * `refId` 的逆。**在第一个冒号处切**(`key` 里允许有冒号 —— Windows 的
 * `C:\…` 与将来的 `web:https://…` 都会带),切不出来就回 null。
 */
export function parseRefId(id: string): ContentRef | null {
  const at = id.indexOf(':')
  if (at <= 0 || at === id.length - 1) return null
  return { kind: id.slice(0, at), key: id.slice(at + 1) }
}

export function sameRef(a: ContentRef, b: ContentRef): boolean {
  return a.kind === b.kind && a.key === b.key
}

/**
 * **一种内容由别的内容拼起来**(W6-a,设计 `workbench-tabs-2026-09.md` §2.1)。
 *
 * 「一个标签装两格」在核心层里**不是一种特例**,而是一种普通内容的自述:树上它
 * 仍旧是一格 tab,标签条画它的标题,关它就是关它。核心层因此照旧不认识 `pair`
 * 这四个字母 —— 它问的是这张表:
 *  · `parts(ref)`   这一格由哪几格组成(拆开、逐格问 `beforeClose`、引用账要
 *                   看进去、`countKind` 要数进去,靠的都是它);
 *  · `compose(a,b)` 这两格并得起来吗、并出来是哪一格。答 `null` = 并不了
 *                   (今天唯一的实现拒绝两条:任一格自己就是复合的、两格是同一格)。
 *
 * 判据与 `resident` / `fullable` / `singleton` 同族:**能力自述、别人读表**。
 * `workbench/store.ts` 里因此一个 `'pair'` 都没有 —— 它只会问
 * `composeContent(a, b)` 与 `partsOfContent(ref)`。
 */
export interface ContentComposite {
  /** 这一格由哪几格组成。**顺序即左右**(两格时 `[左, 右]`)。 */
  parts(ref: ContentRef): readonly ContentRef[]
  /** 把两格并成这一种。并不了(规则不允许)答 `null`。 */
  compose(a: ContentRef, b: ContentRef): ContentRef | null
}

/**
 * 一种内容的**自述**。每一种在自己的模块里 register 一次,核心层只读表。
 */
export interface ContentKind {
  id: string
  /**
   * 单例种类(今天的 12 块瓦):同一个 `key` 全应用只许一个实例,再打开一次 =
   * 激活既有的那一份。`file` 与 `session` 都**不是**单例 —— 同一份文件可以在两片
   * 叶里各开一个(W3「拖一份到旁边对照着看」),两条会话可以并排各占一片叶
   * (W5-b「会话多开」)。
   */
  singleton: boolean
  /**
   * **常驻**:出厂就在这个区域里有一格,而且**至少要留一格**(关不掉、藏不掉)。
   *
   * 一格声明担两份工,而两份工问的是同一句话「这一种在这个区域里必须在场」:
   *  · 出厂布局:`workbench/store` 播种时按这一格摆(核心层于是不必知道
   *    「中央区第一片叶里装的是聊天」——它只是照着表摆);
   *  · T0 拍点 2「最后一片 chat 叶不可关」:核心层问的是**「关掉之后这个区域里
   *    还剩不剩同种的」**,而不是「它是不是 chat」。**W5-b 兑现了这句话**:
   *    `chat` 改名 `session`、`singleton` 翻成 false、`key` 换成会话 id,
   *    而 `canDetachTab` 一个字都没改 —— 关到只剩一条时它自己就变回「不可关」。
   */
  resident?: {
    region: RegionId
    /**
     * **播种时摆哪一个**(W5-b 裁定 2)。W1 这里是一格死的 `key: string`,
     * 因为那时常驻那一种是单例(`chat:main`,全应用一份)。会话多开之后
     * `key` 是**会话 id**,而「出厂那一片摆哪条会话」这件事只有这一种内容
     * 自己答得出(它要问当前那条会话在不在、还活着没有)。
     *
     * 于是这一格从**值**变成**问句**:核心层照旧不知道 key 是什么
     * (它只是把答案原样放进树),而「延迟到播种那一刻才铸」这件事
     * 让 merge / seed / 换装三处入口各自拿到当下正确的那一格。
     */
    seed(): string
  }
  /**
   * 身份由内容自答。这是**静态那一半**(文件名、瓦名);会跟着内容变的那一半
   * (未保存丸、正在读取)由内容自己发布到 `stage/live-title`(键 = `refId`),
   * 叶檐读表时活的盖静的。两半分开是因为这只表不是 React —— 它不能订阅。
   */
  title(ref: ContentRef): LiveTitle
  /** lucide 图标名(与 `StageItemSpec.icon` / `TabSpec.icon` 同一套字符串)。 */
  icon(ref: ContentRef): string
  render(ref: ContentRef, visibility: PanelVisibility): ReactNode
  /*
   * **`toolbar?(ref)` 整格退役**(W7-c 裁定 2)。W1 起这一格让内容把一件工具条挂
   * 进叶檐的动作组;用户 09-05 说「按钮太多」,顶栏右端从此只剩 ⋯ 与 AgentChip。
   * 它唯一的住户(markdown 的「渲染 ⇄ 源码」)搬进了**内容区自己的右键菜单**
   * ——「一个文件能做什么」全仓只有那一张表(09-01 判例),看法也是它能做的事。
   * 今天那一组由查看器型自述(`ViewerHandler.viewModes`,纯数据),不再是一个
   * 会自己读 store 的 React 元素。
   */
  /**
   * 关闭前的一问(脏文件确认)。缺席 = 直接关。
   * 回 `'cancel'` = 这一次关闭作废,树一个字不动。
   */
  beforeClose?(ref: ContentRef): Promise<'close' | 'cancel'>
  /** 实例被真正丢弃(**关闭**,不是隐藏)时清它自己的状态。 */
  dispose?(ref: ContentRef): void
  /** 这一种可以开在哪些区域。缺席 = 都可以。 */
  regions?: readonly RegionId[]
  /**
   * 这一种**进不进得了全屏**(W2)。缺席 = 进得了。
   *
   * 判据照旧是**种类自述**,不是核心层按名字点人:`workbench/store` 的
   * `toggleFull` 只问这一格,`full.*` 那条拒绝提示也只说「这一种不支持」。
   *
   * ── 今天唯一说 false 的是 `session`,而且它**还是临时的**(W5-c 撤)──────
   * 输入框(`.composerDock`)此刻挂在外壳的 `.center` 上、**不在树里**
   * (判词写在 `AppShell` 那一段上):会话叶进全屏会把它盖掉,人就没法打字了。
   * W5-b 走的是**路线 B**(裁定 4:composer 留在 `.center`,只把目标换成投影值),
   * 所以这一格照旧说 false;要撤它得等路线 A(composer 真的进叶,W5-c 可选加期)。
   */
  fullable?: boolean
  /**
   * **这一种是由别的内容拼起来的**(W6-a)。缺席 = 它是一格原子内容。
   * 判词与两只口的分工写在 `ContentComposite` 上。
   */
  composite?: ContentComposite
  /**
   * **这一格被激活时,焦点落进哪一格作用域**(W7-t / B3)。缺席 = 落进它自己的
   * 内容层(`leaf` 那一格 passThrough 下去,也就是从前唯一那条路)。
   *
   * ── 它为什么是一格自述,而不是 `focus-into` 里的一条 if ──────────────────
   * 报障是「切到会话标签,焦点落在消息流上,直接打字进不去」。修法有两种写法:
   * 在 `focus-into` 里写一句「如果这一格是会话就送去输入面板」——那就是**核心层
   * 点名一种内容**,而下一种有「激活时该落在别处」需求的内容(终端?表单?)
   * 会在同一处再长一条 if;或者让**内容自己说**它想把焦点交给哪块面,壳只读表。
   * 这一格是后者,与 `resident` / `fullable` / `composite` 同族。
   *
   * 值是**声明 id**(`focus/scopes.ts` 那张封闭表里的一格),不是实例 ——
   * 挑哪一份实例是注册表的事(MRU + owner,判词在 `FocusTree.activateScope` 上)。
   * 送不进去(那块面此刻一份可交互的实例都没有)一律回落到内容层,
   * 与「送不进去不追」同一条纪律。
   */
  focusInto?: FocusScopeId
  /**
   * **这一种在标签条上要更宽的上限**(W7-t / B6,设计 v3 §6:「最大宽度 260px」)。
   * 缺席 = 常规上限。它经 `LeafStrip.tabSpecOf` 变成 `TabSpec.wide` 那一格事实;
   * `ui/Tabs` 与样式表照旧认不得任何一种内容(判词在 `TabSpec.wide` 上)。
   */
  tabWide?: boolean
}

/** Vite 的 `import.meta.hot` 里这一批只用得到 `dispose` 一口(照 `content/blocks/registry` 的形)。 */
export interface ImportMetaHot {
  dispose(cb: () => void): void
}

/*
 * ── 模块级单例注册表 + HMR 退役(09-01 立法)──────────────────────────────
 * 这张 Map 的寿命是「这个模块实例」,所以每一次 `registerContentKind` 都要有一口
 * 退役。做法与 `content/blocks/registry.ts` 逐字相同:**把调用模块自己的
 * `import.meta.hot` 递进来**(注册表拿不到调用方那一份),退役那一段只写一遍。
 */
const REGISTRY = new Map<string, ContentKind>()

/**
 * 登记一种内容。返回**注销口**(测试与运行时插件用);给了 `hot` 就自动配好热更退役。
 *
 * 重名**抛**而不是替换:两处抢同一个种类名是真冲突,把它放宽成替换等于为了治
 * 热更把真冲突一起放过(病历与理由在 `content/blocks/registry.ts` 的
 * `registerBlock` 上,一字不改地适用)。热更那一路由 `hot.dispose` 先摘干净。
 */
export function registerContentKind(kind: ContentKind, hot?: ImportMetaHot): () => void {
  const now = REGISTRY.get(kind.id)
  if (now && now !== kind) throw new Error(`content kind 重复注册:${kind.id}`)
  REGISTRY.set(kind.id, kind)
  const off = () => {
    // 只摘「确实是我登记的那一格」—— 别人已经换上去了就不动它。
    if (REGISTRY.get(kind.id) === kind) REGISTRY.delete(kind.id)
  }
  hot?.dispose(off)
  return off
}

export function contentKindOf(id: string): ContentKind | undefined {
  return REGISTRY.get(id)
}

/**
 * **关一格之前问种类那一句**(脏文件确认)。回 `true` = 可以关。
 *
 * 判据住在这里而不是在檐里,是因为它有**两个**发起方:中央叶那条檐
 * (`PaneLeaf`)与面板内那条身份带(`LeafStrip` 的 `SoloLeafStrip`)。
 * 两处各写一遍 `?.beforeClose?.(ref) !== 'cancel'` 的下场是它们迟早分叉,
 * 而分叉的第一处必然是「种类没登记 / 没声明 beforeClose 时怎么办」这一格
 * (答案:直接放行 —— 缺席就是「不必问」)。
 */
export async function mayCloseContent(ref: ContentRef): Promise<boolean> {
  const answer = await REGISTRY.get(ref.kind)?.beforeClose?.(ref)
  return answer !== 'cancel'
}

/* ── 复合那三只读法(W6-a)。核心层只经这三只说话,一个种类名都不出现。 ──── */

/**
 * 这一格由哪几格组成。**不是复合的答 `null`**(「它是一格原子内容」)——
 * 与「是复合但恰好零格」在调用方那里从来不是一件事。
 */
export function partsOfContent(ref: ContentRef): readonly ContentRef[] | null {
  const parts = REGISTRY.get(ref.kind)?.composite?.parts(ref)
  return parts ?? null
}

/** 这一格是不是复合的。 */
export function isCompositeContent(ref: ContentRef): boolean {
  return REGISTRY.get(ref.kind)?.composite !== undefined
}

/**
 * **把两格并成一格**(二合一)。
 *
 * 核心层不知道并出来的是哪一种,所以它**问整张表**:哪一种自述得出
 * `composite.compose` 且对这两格答得出东西,就是它。今天只有一种自述了
 * (`content/kinds/pair.tsx`),而「将来有第二种(三格?自定义拼版?)」这件事
 * 因此不必惊动这只文件 —— 那正是「能力自述、别人读表」的意思。
 *
 * 按**登记序**取第一个答得出的。谁都答不出 = 这两格并不了。
 */
export function composeContent(a: ContentRef, b: ContentRef): ContentRef | null {
  for (const kind of REGISTRY.values()) {
    const made = kind.composite?.compose(a, b)
    if (made) return made
  }
  return null
}

/**
 * **把一格摊成它真正装着的那几格**(复合的摊开,原子的就是它自己)。
 *
 * 「这个区域里这一种还剩几个」「全壳摆着哪些会话」这类问句问的都是**内容**,
 * 不是**标签** —— 一格 `pair` 标签里装着的那条会话当然算在场。递归展开,
 * 深度封顶只是防一份手改档案里自己指着自己的复合(今天并不出这种形)。
 */
export function flattenContent(ref: ContentRef, depth = 4): ContentRef[] {
  const parts = depth > 0 ? partsOfContent(ref) : null
  if (!parts || parts.length === 0) return [ref]
  return parts.flatMap((part) => flattenContent(part, depth - 1))
}

/** 认不认得这个种类名。`tree.sanitize` 拿它剔存量档案里的未知种类。 */
export function isKnownContentKind(id: string): boolean {
  return REGISTRY.has(id)
}

/**
 * **这一格被激活时焦点该落进哪一格作用域**(W7-t / B3;缺席 = 内容层)。
 * `workbench/focus-into` 只经这一只问 —— 于是它里面一个种类名都不出现。
 */
export function focusIntoScopeOf(ref: ContentRef): FocusScopeId | undefined {
  return REGISTRY.get(ref.kind)?.focusInto
}

/** 这个种类是不是单例。`tree.sanitize` 拿它去重。 */
export function isSingletonContentKind(id: string): boolean {
  return REGISTRY.get(id)?.singleton === true
}

/** 按登记序。 */
export function contentKindList(): readonly ContentKind[] {
  return [...REGISTRY.values()]
}

/** 只给测试:用例之间归零。 */
export function resetContentKinds(): void {
  REGISTRY.clear()
}
