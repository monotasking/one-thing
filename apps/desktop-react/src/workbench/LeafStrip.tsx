import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Tabs } from '../ui/Tabs'
import { useLiveTitleStore } from '../stage/live-title'
import { useT } from '../i18n'
import { contentKindOf, mayCloseContent, refId } from './kinds'
import type { LiveTitle } from '../stage/live-title'
import type { TabSpec } from '../ui/Tabs'
import type { ContentRef } from './kinds'
import s from './LeafStrip.module.css'

/**
 * **一条檐**(W1,设计 §2.2「一格一檐」)。
 *
 * 规则一句话:**一片叶只有一条檐,那条檐就是 tab 条;单 tab 时它退化成一条
 * 身份带(图标 + 名 + 未保存丸),右端是这一格的动作组。**
 *
 * ── 它为什么从 `PaneLeaf` 里出来(W1-a 修批)────────────────────────────
 * 因为这条檐有**第二个宿主**了。「打开方式」的出厂缺省档是「面板内」,那一档的
 * 查看器不在拼贴树里(设计 §2.1 明写保留:它是 `FilesPanel` 自己那条分栏),
 * 于是 W1-a 交卷时它一条檐都没有 —— 关一个文件只剩右键与 Esc,而多数用户第一眼
 * 看到的正是这一档。修法不是「给分栏再画一条」:**面板内也是一「格」,它该有
 * 同一条身份带**。所以这条檐成了一件基础件,两处消费同一件、同一份样式表。
 *
 * ── 分工 ────────────────────────────────────────────────────────────────
 *   `tabSpecOf`     一格 tab 的**数据表**:身份两半合一(种类自述的静态半 +
 *                   `stage/live-title` 的活半,活的盖静的)。两个宿主同一张表。
 *   `LeafStrip`     纯呈现:收一组 `TabSpec` + 型工具条 + 动作组,消费 `ui/Tabs`。
 *                   它**不认识树**,所以面板内那一档不必假装自己是一片叶。
 *   `SoloLeafStrip` 「恰一格」的那一形:收一个 `ContentRef` + 一口 `onClose`,
 *                   自己去表里取名字、取型工具条、按种类问 `beforeClose`。
 *                   给的正是**不在树里**的那些宿主(今天只有面板内分栏)。
 *
 * ── 状态表 ①:生命周期 ──────────────────────────────────────────────────
 *   挂载    宿主里出现这条檐(一片叶 / 面板内那条分栏长出来)
 *   首载    **不画载入态**:它说的是「这儿有哪几格」,那件事是同步已知的
 *   换宿主  中央叶 → 架子 / 浮窗(W4):檐不重挂,只换外框
 *   卸载    最后一格关掉 / 藏起来(叶被 `prune` 剪掉;面板内那条分栏收起来)
 *
 * ── 状态表 ②:UI 生命状态 ───────────────────────────────────────────────
 *   单 tab    退化成身份带(`data-single` 一格属性,CSS 收掉指示条与 hover 底)
 *             —— **同一条 tab 条,不是第二个组件**
 *   多 tab    正常 tab 条 + 溢出横滚(`ui/Tabs` 自带 `overflow-x:auto`)
 *   有预览    那一条斜体(`TabSpec.preview`)
 *   有动作组  宿主给了才画(中央叶:⋯ / 分屏;**面板内:不画** —— 它不是树,
 *             既没有「隐藏的标签」也分不了屏)
 *   超量      `--tab-max-w` 160 封顶 + 横滚,**永不换行**(挤压纪律)
 *
 * ── 状态表 ③:UI 交互状态 ───────────────────────────────────────────────
 *   tab            rest / hover(`--st-hover`)/ focus(全局环)/ active(键盘位由
 *                  `ui/a11y/roving` 管)/ selected(`aria-selected` + 底缘指示条);
 *                  **单 tab 那一形只剩 rest 与 focus**(上面 CSS 收掉了另两样)
 *   tab · ✕        随 `ui/Tabs`(平时透明,hover 本 tab 或键盘走到时浮出)
 *   tab · 名       截断配 Tooltip 全名(`TabSpec.tip`,禁令区那条;文件那一种给的
 *                  是整条路径 —— 两个目录里的同名文件在屏幕上长得一模一样)
 *   tab · 未保存丸  **不是控件**(不进 Tab 序、无 hover/active),一枚 `ui/StatusDot`
 *   动作组各件      随宿主交进来的那些件(中央叶交的是两颗 `ui/IconButton`)
 */

/** 宿主给这条檐的那几格。`single` 由格数自己判 —— 两个宿主不各判一遍。 */
interface LeafStripProps {
  tabs: readonly TabSpec[]
  activeId: string | null
  /** tablist 的无障碍名(宿主经 i18n 给,组件里不落字面)。 */
  label: string
  /** 这一型自己那一格工具条(`ContentKind.toolbar`)。没有就整格不画。 */
  tool?: ReactNode
  /** 檐右端那组钮(中央叶:⋯ / 分屏)。没有就整格不画 —— 空 span 会多出一段 gap。 */
  actions?: ReactNode
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** 中央叶用它给自己那条檐留取件口(`data-pane-chrome`);别的宿主不给。 */
  chromeId?: string
  /** 门与用例的取件口。 */
  testId?: string
}

export function LeafStrip({
  tabs,
  activeId,
  label,
  tool,
  actions,
  onSelect,
  onClose,
  chromeId,
  testId,
}: LeafStripProps) {
  return (
    <div
      className={s.chrome}
      data-pane-chrome={chromeId}
      data-testid={testId}
      data-single={tabs.length <= 1 || undefined}
    >
      <div className={s.tabs}>
        <Tabs
          items={tabs as TabSpec[]}
          activeId={activeId}
          label={label}
          onSelect={onSelect}
          onClose={onClose}
        />
      </div>
      {/* 型工具条由**种类自述**(`ContentKind.toolbar`),檐只负责挂。
        * 没有就整格不画 —— 一格空 span 会在 flex 里多出一段 gap。 */}
      {tool && <span className={s.tool}>{tool}</span>}
      {actions && <span className={s.actions}>{actions}</span>}
    </div>
  )
}

/**
 * 一格 tab 的**数据表**。身份两半合在这里:静态那一半问种类(`kind.title`),
 * 活的那一半读 `live-title`(键 = refId,由内容自己发布)—— **活的盖静的**。
 *
 * 纯函数而不是 hook:中央叶要对**一组** ref 各算一格(hook 不能在循环里调),
 * 而 `titles` 那张表整份订一次就够。
 */
export function tabSpecOf(
  ref: ContentRef,
  titles: Record<string, LiveTitle>,
  opts: { preview?: boolean; closable?: boolean } = {},
): TabSpec {
  const id = refId(ref)
  const kind = contentKindOf(ref.kind)
  const live = titles[id]
  const still = kind?.title(ref)
  return {
    id,
    label: live?.text ?? still?.text ?? ref.key,
    icon: kind?.icon(ref),
    dirty: live?.dirty ?? still?.dirty ?? false,
    // 截断的名字必须说得出全名(禁令区那条)。文件那一种给的是整条路径。
    tip: live?.tip ?? still?.tip,
    preview: opts.preview ?? false,
    closable: opts.closable ?? true,
  }
}

/**
 * **恰一格的那一形**:给「不在拼贴树里」的宿主(今天只有 `FilesPanel` 那条分栏)。
 *
 * 它与中央叶单 tab 时那条身份带是**同一件**(同组件、同样式表、同数据表),
 * 所以两处逐像素相同 —— 这正是修批要的:面板内那一档不是「没有檐」,
 * 而是「同一条檐,只是恰好只有一格」。
 *
 * **关闭语义与中央叶逐字相同**:先问种类(`beforeClose` —— 脏文件那一问),
 * 答 `'close'` 才把 `onClose` 交出去。那一问必须在**檐**这一侧发起:
 * 被关掉的那棵树自己问不了自己(判据整件在 `kinds.mayCloseContent`,单产地)。
 */
export function SoloLeafStrip({
  contentRef,
  onClose,
  testId,
}: {
  contentRef: ContentRef
  onClose: () => void
  testId?: string
}) {
  const t = useT()
  const titles = useLiveTitleStore((st) => st.titles)
  const id = refId(contentRef)
  const tabs = useMemo(() => [tabSpecOf(contentRef, titles)], [contentRef, titles])
  // 型工具条走种类自述那条唯一的口 —— 檐不认识「markdown 有个渲染⇄源码开关」。
  const tool = contentKindOf(contentRef.kind)?.toolbar?.(contentRef) ?? null
  const close = useCallback(() => {
    void (async () => {
      if (await mayCloseContent(contentRef)) onClose()
    })()
  }, [contentRef, onClose])
  return (
    <LeafStrip
      tabs={tabs}
      activeId={id}
      label={t('workbench.leafTabs')}
      tool={tool}
      onSelect={() => {
        /* 只有一格,切给谁?这一口是 `ui/Tabs` 的受控约定要的,不是一件功能。 */
      }}
      onClose={close}
      testId={testId}
    />
  )
}
