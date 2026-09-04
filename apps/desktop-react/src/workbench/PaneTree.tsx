import { memo, useCallback, useMemo, useRef } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { Splitter } from '../ui/Splitter'
import { useT } from '../i18n'
import { PaneLeaf } from './PaneLeaf'
import { useWorkbenchStore } from './store'
import { layoutTree, ratioVar, ratioVars } from './layout'
import { DEFAULT_SPLIT_RATIO } from './tree'
import type { SeamSlot } from './layout'
import type { PaneNode } from './tree'
import s from './PaneTree.module.css'

/**
 * **一棵拼贴树的渲染**(W1,设计 §1.2)。
 *
 * ── 一层,不是一棵 ──────────────────────────────────────────────────────
 * 每一片叶都是**这个容器的直接孩子**,位置由绝对定位给(几何算式在
 * `workbench/layout.ts`)。为什么不递归画,那只文件的头上写着病历:
 * 递归画时一次分屏会给留下来的那片叶多两层 DOM 祖先,React 按位置认组件,
 * 于是那棵子树整个卸载再挂一遍 —— 中央区第一片叶装的是聊天,**每分一次屏
 * 它就丢一次滚动位**。摊平之后树的形状怎么变,叶在 React 树里的位置都不动。
 *
 * ── 拖拽期间一帧都不经过 React ──────────────────────────────────────────
 * 每一次切分的比例住在根上一格无单位 CSS 变量(`--pr-<splitId>`),叶的四个边是
 * 一串 `calc()`。杆把实时值写进那格变量(`liveVar` + `liveTarget`),浏览器把
 * 依赖它的格子一起重排 —— 与 `FilesPanel` 那条分栏逐字同一手。
 * **比例相对谁算**与**活值谁看得见**是两个问题:前者是这一次切分那块地
 * (`containerRef` 指着它),后者是整棵树的根(`liveTarget`)。
 *
 * ── 比例住在节点里,不在 `data/split-prefs` ──────────────────────────────
 * 设计 §12 记着「浮窗里的分屏比例走既有 split-prefs,键 = 叶 id」。W1-a 没那么做:
 * 树本身**已经按 Workspace 落盘**(`onething.workbench`),把比例再放进另一个槽
 * 等于同一棵树的形状有两个产地 —— 而它们会在「换空间」那一刻分叉。
 * **留账**:W4 若要让浮窗的比例跨树复用,再谈。
 */
export const PaneTree = memo(function PaneTree({ node }: { node: PaneNode }) {
  const rootRef = useRef<HTMLDivElement>(null)
  /*
   * 表达式只在**树的形状**变了之后才需要重算;比例每动一格都变。两件事的寿命
   * 不一样,所以是两只 memo —— 拖完一次杆不该把整棵树的算式重造一遍。
   */
  const layout = useMemo(() => layoutTree(node), [node])
  const vars = useMemo(() => ratioVars(node), [node])

  return (
    <div ref={rootRef} className={s.panes} style={vars as CSSProperties} data-pane-tree="">
      {/* 叶在前、杆在后:杆要盖在缝上接指针,DOM 序就是它的层序(不动 z-index)。 */}
      {layout.leaves.map(({ leaf, box }) => (
        <div key={leaf.id} className={s.slot} style={box} data-pane-slot={leaf.id}>
          <PaneLeaf leaf={leaf} />
        </div>
      ))}
      {layout.seams.map((seam) => (
        <PaneSeam key={seam.id} seam={seam} rootRef={rootRef} />
      ))}
    </div>
  )
})

/**
 * 一条缝 = 两个盒:
 *  · **量的那个**(`.seamBox`)铺在这一次切分自己那块地上,`pointer-events: none`、
 *    什么都不画 —— 它只为 `getBoundingClientRect()` 存在(比例相对它算);
 *  · **画的那个**(`.seam`)是一条细带子,坐在缝上,里面就是 `ui/Splitter`。
 *
 * 分成两个盒不是绕路:一条 6px 宽的杆量不出「这一段一共多宽」,而把杆铺满整块地
 * 会把两边的内容全挡住。
 */
const PaneSeam = memo(function PaneSeam({
  seam,
  rootRef,
}: {
  seam: SeamSlot
  rootRef: RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  const setSplitRatio = useWorkbenchStore((st) => st.setSplitRatio)
  const onCommit = useCallback((next: number) => setSplitRatio(seam.id, next), [setSplitRatio, seam.id])
  const vertical = seam.dir === 'row'
  return (
    <>
      <div ref={boxRef} className={s.seamBox} style={seam.box} aria-hidden="true" />
      <div
        className={vertical ? `${s.seam} ${s.seamV}` : `${s.seam} ${s.seamH}`}
        style={
          vertical
            ? { left: seam.seam.left, top: seam.seam.top, height: seam.seam.length }
            : { left: seam.seam.left, top: seam.seam.top, width: seam.seam.length }
        }
        data-pane-seam={seam.id}
      >
        <Splitter
          containerRef={boxRef}
          orientation={vertical ? 'vertical' : 'horizontal'}
          value={seam.ratio}
          defaultValue={DEFAULT_SPLIT_RATIO}
          label={t('workbench.splitterLabel')}
          liveVar={ratioVar(seam.id)}
          liveTarget={rootRef}
          testId={`pane-splitter:${seam.id}`}
          onCommit={onCommit}
        />
      </div>
    </>
  )
})
