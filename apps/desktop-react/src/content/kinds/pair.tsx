import { useCallback, useRef } from 'react'
import type { CSSProperties } from 'react'
import { Unlink } from '../../components/icons'
import { useT } from '../../i18n'
import { IconButton } from '../../ui/IconButton'
import { Splitter } from '../../ui/Splitter'
import { Tooltip } from '../../ui/Tooltip'
import { ContentSlot } from '../../workbench/PaneLeaf'
import { contentKindOf, refId, registerContentKind } from '../../workbench/kinds'
import {
  PAIR_RATIO_DEFAULT,
  PAIR_RATIO_MAX,
  PAIR_RATIO_MIN,
  useWorkbenchStore,
} from '../../workbench/store'
import { leavesOf } from '../../workbench/tree'
import { useLiveTitleStore } from '../../stage/live-title'
import { PAIR_KIND, pairPartsOf, pairRefOf } from './pair-ref'
import type { LiveTitle } from '../../stage/live-title'
import type { ContentKind, ContentRef } from '../../workbench/kinds'
import type { PaneNode } from '../../workbench/tree'
import s from './pair.module.css'

/**
 * **两格并排这一种内容**(W6-a,设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §2.1 / §6)。
 *
 * ── 它为什么是「一种内容」而不是树上的一种节点 ────────────────────────────
 * 用户原话:「拖拽 session 的 tab 本就是个伪需求,我最多就是一个分屏,往一个 tab
 * 有两个(二合一)的方向设计」。把「两格」做成树上的一种切分,顶栏就得按叶分组
 * 画多条标签条、每片叶各有一组动作、落点要判五个方向 —— 那正是 v2 被推翻的三条
 * 代价。做成**一种普通内容**之后,`workbench/*` 里一个字都不用出现「两格」这个
 * 概念:树上它就是一格 tab,标签条画它的标题,关它就是关它。
 *
 * 「二合一」= 把两格普通 tab 换成一格这一种;「拆开」= 反过来。两个动作都是
 * `store.pairRefs` / `store.unpairAt`,而它们调的是**种类自述**
 * (`ContentKind.composite` 的 `compose` / `parts`)—— 核心层因此照旧不认识
 * `pair` 这四个字母(判词在 `workbench/kinds.ts` 的 `ContentComposite` 上)。
 *
 * ── 六条自述,每一条各替掉一处本来要写死的判据 ────────────────────────────
 *  · `composite` —— 上面那两个动作的全部实现,外加「关一格要问两格」「引用账
 *    要看进去」「常驻还剩几格要数进去」三处摊开;
 *  · `title` —— `A ⫽ B`,两半各自**活的盖静的**(与叶檐读 `live-title` 同一条);
 *  · `icon` —— 左格那一枚(标签上只画得下一枚,而左格是这一格的主);
 *  · `beforeClose` —— 两格各问一次,**任一格说别关就不关**;
 *  · `dispose` —— 两格各清各的(关闭 = 丢实例,与 `file` / `session` 同一条);
 *  · `fullable: false` —— 与会话那一种同一条理由(路线 B:输入框仍在树外),
 *    而且两格里随时可能有一格是会话。W5-c 路线 A 落地后一起撤。
 *  · **`regions` 缺席** = 哪个区域都行(中央区 / 架子 / 浮窗)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 二合一那一下(树上多了这一格 ref);**两格的身子一格都不
 *    重挂** —— 它们由 `workbench/content-slots` 按 refId 挂进来,前后是同一个
 *    DOM 节点(判词在那只文件头,断言在 `pair.test.tsx` 与 `gate:files`);
 *    换宿主(搬进架子 / 撕成浮窗)由拼贴树的结构共享保证不重挂;
 *    卸载 = 拆开 / 关掉 / 藏起来。无模块级副作用 → 这一层不需要 HMR dispose
 *    (注册那一份由 `registerContentKind` 收,与别的种类逐字同一体例)。
 * ② UI 生命状态:这一层**自己没有载入 / 空 / 错误态** —— 两格各自的那些由它们
 *    自己说(查看器的「正在读取…」、聊天区的空态)。它唯一自己的一格是
 *    **拆不出两格**(手改过的档案里那个 key 拆不出合法的 ref):画一句注,
 *    而不是一块空白 —— 空白说不出任何事实。
 * ③ UI 交互状态:格头上那颗「拆开」随 `ui/IconButton`(rest/hover/focus/active
 *    全套);分隔杆随 `ui/Splitter`(含它的键盘档:←/→ 一步、Home/End、↵ 回默认);
 *    两格的身子各自的交互状态归各自。
 */

/** 两格标题中间那个记号(设计 §6:`A ⫽ B`)。 */
const JOIN = ' ⫽ '

/** 一格的身份两半合一 —— 与 `workbench/LeafStrip.tabSpecOf` 逐字同一条:活的盖静的。 */
function titleOfPart(part: ContentRef, titles: Record<string, LiveTitle>): LiveTitle {
  const live = titles[refId(part)]
  const still = contentKindOf(part.kind)?.title(part)
  return {
    text: live?.text ?? still?.text ?? part.key,
    dirty: live?.dirty ?? still?.dirty ?? false,
    tip: live?.tip ?? still?.tip,
  }
}

/** 非组件上下文里读活标题那一张表(`ContentKind.title` 不是 hook)。 */
function liveTitles(): Record<string, LiveTitle> {
  return useLiveTitleStore.getState().titles
}

/**
 * 这一格 tab 此刻坐在哪(叶 + 叶内下标)。格头上那颗「拆开」要它 ——
 * 而它是**动作发起时**的一次查询,不是要渲染的值,所以走 `getState()`。
 */
function seatOfPair(regions: Readonly<Record<string, PaneNode>>, id: string):
  | { leafId: string; index: number }
  | null {
  for (const tree of Object.values(regions)) {
    for (const leaf of leavesOf(tree)) {
      const at = leaf.tabs.findIndex((tab) => refId(tab) === id)
      if (at >= 0) return { leafId: leaf.id, index: at }
    }
  }
  return null
}

function PairPane({ contentRef }: { contentRef: ContentRef }) {
  const tr = useT()
  const id = refId(contentRef)
  const parts = pairPartsOf(contentRef)
  const titles = useLiveTitleStore((st) => st.titles)
  const ratio = useWorkbenchStore((st) => st.pairRatios[id] ?? PAIR_RATIO_DEFAULT)
  const setPairRatio = useWorkbenchStore((st) => st.setPairRatio)
  const boxRef = useRef<HTMLDivElement>(null)

  /**
   * 拆开。**它在这里是一次动作**(不是渲染要读的值),所以现查一次坐标 ——
   * 判据本体是 `store.unpairAt`(右格拆成紧邻其后的新标签,焦点留原位)。
   */
  const unpair = useCallback(() => {
    const store = useWorkbenchStore.getState()
    const seat = seatOfPair(store.regions, id)
    if (seat) store.unpairAt(seat.leafId, seat.index)
  }, [id])

  if (!parts) {
    // 拆不出两格合法的 ref —— 画一句注,不画一块空白(见组件头状态表 ②)。
    return <p className={s.head}>{tr('workbench.pairBroken')}</p>
  }

  return (
    <div
      ref={boxRef}
      className={s.pair}
      data-testid={`pair:${id}`}
      /* 比例进一格**无单位**自定义属性,列宽由样式表按它算(判词在样式表头)。 */
      style={{ '--pair-split': `${ratio}` } as CSSProperties}
    >
      <PairSide part={parts[0]} titles={titles} side="left" onUnpair={unpair} />
      <div className={s.seam}>
        <Splitter
          containerRef={boxRef}
          value={ratio}
          min={PAIR_RATIO_MIN}
          max={PAIR_RATIO_MAX}
          defaultValue={PAIR_RATIO_DEFAULT}
          label={tr('workbench.pairSplitter')}
          liveVar="--pair-split"
          liveTarget={boxRef}
          testId={`pair-splitter:${id}`}
          onCommit={(next) => setPairRatio(id, next)}
        />
      </div>
      <PairSide part={parts[1]} titles={titles} side="right" onUnpair={unpair} />
    </div>
  )
}

/**
 * 一格。格头(名 + 拆开)+ 身(一格槽)。
 *
 * **它是一格有名字的 region**(a11y 规范:格头那条不是 tablist,所以这一格要
 * 自己说得出「这块地是什么」)—— 名字就是这一格内容的名字,读屏软件因此念得出
 * 「文件 engine.ts,区域」。
 */
function PairSide({
  part,
  titles,
  side,
  onUnpair,
}: {
  part: ContentRef
  titles: Record<string, LiveTitle>
  side: 'left' | 'right'
  onUnpair: () => void
}) {
  const tr = useT()
  const title = titleOfPart(part, titles)
  const id = refId(part)
  return (
    <section className={s.pane} aria-label={title.text} data-pair-side={side}>
      <div className={s.head} data-pair-head={id}>
        {/* 截断的名字必须说得出全名(禁令区那条)。 */}
        <Tooltip content={title.tip ?? title.text}>
          <span className={s.name}>{title.text}</span>
        </Tooltip>
        <IconButton
          icon={Unlink}
          size="xs"
          label={tr('workbench.unpair')}
          testId={`pair-unpair:${id}`}
          onClick={onUnpair}
        />
      </div>
      {/* 身 = 一格槽。这一格内容的身子由 `workbench/content-slots` 挂进来。 */}
      <div className={s.body}>
        <ContentSlot id={id} />
      </div>
    </section>
  )
}

/**
 * 这一种的**自述本体**。导出它只为一件事:用例要能在 `resetContentKinds()` 之后
 * 把它装回去(注册是模块级副作用,只跑一次)。产品代码一律经注册表读它。
 */
export const pairContentKind: ContentKind = {
  id: PAIR_KIND,
  // 同一对内容只该有一格(它的 key 就是那两格的名字),但**不是单例种类**:
  // 两组不同的两格标签当然可以同时开着。
  singleton: false,
  composite: {
    parts: (ref) => pairPartsOf(ref) ?? [],
    /**
     * 并得起来吗。**两条拒绝**,都是设计 §2.3 / §6 的字面落地:
     *  · 任一格自己就是两格的(「两格的标签不能再并」);
     *  · 两格是同一格(「两格标签里两格不同」)。
     */
    compose: (a, b) => {
      if (a.kind === PAIR_KIND || b.kind === PAIR_KIND) return null
      if (a.kind === b.kind && a.key === b.key) return null
      return pairRefOf(a, b)
    },
  },
  /**
   * `A ⫽ B`。两半各自**活的盖静的**(与叶檐同一条)—— 于是一格未保存的文件
   * 与一条改了名的会话并排时,标签上两个名字各自跟着动。
   *
   * `dirty` 取**两格的或**:标签上只画得下一枚丸,而「这一格里有没保存的东西」
   * 正是它要说的话。
   */
  title: (ref) => {
    const parts = pairPartsOf(ref)
    if (!parts) return { text: ref.key }
    const titles = liveTitles()
    const a = titleOfPart(parts[0], titles)
    const b = titleOfPart(parts[1], titles)
    return {
      text: `${a.text}${JOIN}${b.text}`,
      dirty: a.dirty === true || b.dirty === true,
      // 提示给两条全名(标签上那格窄,而 260px 装不下两个长名字)。
      tip: `${a.tip ?? a.text}${JOIN}${b.tip ?? b.text}`,
    }
  },
  /** 左格那一枚(标签上只画得下一枚,而左格是这一格的主)。 */
  icon: (ref) => {
    const parts = pairPartsOf(ref)
    const left = parts?.[0]
    return (left && contentKindOf(left.kind)?.icon(left)) ?? 'Columns2'
  },
  render: (ref) => <PairPane contentRef={ref} />,
  /** 两格各问一次,**任一格说别关就不关**(设计 §6)。 */
  beforeClose: async (ref) => {
    for (const part of pairPartsOf(ref) ?? []) {
      const answer = await contentKindOf(part.kind)?.beforeClose?.(part)
      if (answer === 'cancel') return 'cancel'
    }
    return 'close'
  },
  /** 关闭 = 丢实例。两格各清各的。 */
  dispose: (ref) => {
    for (const part of pairPartsOf(ref) ?? []) contentKindOf(part.kind)?.dispose?.(part)
  },
  /*
   * 路线 B 之下输入框仍在树外,而两格里随时可能有一格是会话 —— 与
   * `session` 那一种同一条理由(判词在 `ContentKind.fullable` 上)。
   */
  fullable: false,
}

registerContentKind(pairContentKind, import.meta.hot)
