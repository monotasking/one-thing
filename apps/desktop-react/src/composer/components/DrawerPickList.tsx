import { Fragment } from 'react'
import type { MouseEvent } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import type { PickView } from '../../references/drawer'
import s from './Composer.module.css'

/**
 * 抽屉里那一列候选。**一种行,不是几种控件** —— 一行最多三格(名 · 说明 · 用法),
 * 哪一格在场由那一条候选自己那份 `RowSpec` 说(`references/kind.ts`)。
 * 行上用 mousedown + preventDefault 而不是 click:点下去的那一瞬间输入框会失焦,
 * 而插入 chip 要靠那个还没散的光标(demo 同一判例)。
 *
 * ── 列表封顶之后多出来的一件事:把选中项滚进视野 ──────────────────────────
 * 限高之前,「选中的那条在不在屏幕上」不是个问题 —— 抽屉有多长就长多长。限高之后,
 * ↑↓ 走到第 12 条时它就在视野外面了:键盘还在动,屏幕上却什么都没变,那是**比不
 * 限高更糟**的手感。所以限高与滚入视野是**同一件事的两半**,不许只做前一半。
 * 滚这件事已经收进 `ui/a11y/list-selection` 的 `rowRef`(`block:'nearest'`)。
 * 焦点仍然留在输入框里(行是 mousedown 拾取的,从不落焦),所以滚的是**元素**,
 * 不是焦点 —— roving 那一套没有被碰。
 *
 * ── 09-01 修:mouseenter 不再写选中位 ────────────────────────────────────
 * 从前每一行挂着 `onMouseEnter={() => onHover(i)}`,把键盘位直接交给鼠标。
 * 两个后果:①鼠标停在列表上时按 ↑↓,↵ 落在鼠标那一行而不是键盘那一行;
 * ②滚入视野把列表滚一段,**鼠标一动没动**却换了脚下的行,浏览器补一发
 * mouseenter,键盘位当场被拽走(二次污染)。现在 hover 纯由 CSS 的
 * `.pickRow:hover` / `.pickSel:hover` 画,一个 JS 状态都不占;改选中位的只剩
 * 键盘与**点击**。法条见 CLAUDE.md 禁令区。
 *
 * ══ 09-12 第三批:这只文件**一个种类名都不认得** ═══════════════════════════
 * 从前它按 `kind === 'files'` 分了六处岔:组头画不画、一行哪几格、空态说什么、
 * 错误行在哪。今天它收的是一份**已经装配好的 `PickView`** —— 组、扁平序、
 * 那一行说什么全在里面(判据在 `references/drawer.buildPickView`),这里只摆元素。
 *
 * **四态**(用户报障「command / file 出现的动画很突兀」的病根之一):
 *
 *   | 候选 | status        | 画什么                                   |
 *   | 有   | ready         | 候选行                                   |
 *   | 有   | loading       | 候选行(**旧的留屏**,不闪、不清)         |
 *   | 有   | error         | 候选行 + 一行弱色错误文字(不换底)       |
 *   | 无   | idle/loading  | 一行「正在找…」(**纯文字**:Spinner 只许 |
 *   |      |               | 在按钮内 / 状态栏,禁令区)               |
 *   | 无   | error         | 一行弱色错误文字                          |
 *   | 无   | ready         | 「无匹配」—— 只有这一格才说这句话         |
 *
 * 那一行说哪句话的判据在 `buildPickView`,这里只认 `note` / `errorNote` 两格。
 * 从前它按**长度**判,于是刚敲下 `@` 的那 120ms 里屏幕上写着「无匹配」——
 * 突兀的不是曲线,是**先说了一句不成立的话再改口**。
 *
 * **分组**:组就是**种类**,一种恰好产出一组(空组根本到不了这儿,它自己滤掉了),
 * 所以「分组只许一次」在这里连表达的形状都没有。键盘走位仍旧是**一条扁平序**:
 * `index` 与 `onPick(i)` 的下标按各组 `entries` 顺次相连算 —— `offset` 就是它。
 *
 * ══ 09-12 第二批:高度这件事整个不归这里了 ════════════════════════════════
 * 同日早些时候这块滚动区自己走一次高度 FLIP,让「一行『正在找…』→ 整列」那一下
 * 有得看。用户当天报回来的正是它:「它太慢了,我能看到它先很短、再慢慢长出来;
 * 能不能直接看到一个固定长度、固定宽度的最终结果」。所以 FLIP **删了**
 * (原语留着,工具卡还在用),抽屉改成**固定高的框**(`.drawerFixed`),
 * 这一列在框里铺满自己滚 —— 四态之间换的只是框里第一行写什么,
 * **一个像素的几何都不动**。这个文件里因此再没有任何一处量高、记高、改高。
 * ──────────────────────────────────────────────────────────────────────
 */
interface Props {
  /** 已经装配好的那一列(组 / 扁平序 / 那一行说什么)。 */
  view: PickView
  index: number
  /** 下标 → 行 ref。由 `useListSelection` 交下来,滚入视野靠它认行。 */
  rowRef: (i: number) => (el: HTMLElement | null) => void
  onPick: (i: number) => void
}

export function DrawerPickList({ view, index, rowRef, onPick }: Props) {
  const t = useT()
  const hold = (i: number) => (e: MouseEvent) => {
    e.preventDefault()
    onPick(i)
  }

  return (
    <div className={s.pickScroll}>
      {view.groups.map((group) => (
        <Fragment key={group.kindId}>
          {group.headKey && <div className={s.pickHead}>{t(group.headKey)}</div>}
          {group.entries.map(({ row }, at) => {
            // 扁平序的下标:一条列表不许有两种序,所以这里只是接着数,不重算。
            const i = group.offset + at
            return (
              <ButtonBase
                key={`${group.kindId}:${row.primary}`}
                ref={rowRef(i)}
                className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
                onMouseDown={hold(i)}
              >
                {/* 名字那一格在**有说明时**要定宽(`.pickName`):三格并排时它是
                  * 两件不弯腰的其中一件。只有一格的那一族(文件候选)不加 ——
                  * `.pickMono` 同时长在模型行上,给它 `flex: none` 是替另外两种
                  * 住户做了一次没人要过的裁定(判词在那条 CSS 上)。 */}
                <span
                  className={
                    row.secondary === undefined ? s.pickMono : `${s.pickMono} ${s.pickName}`
                  }
                >
                  {row.primary}
                </span>
                {row.secondary !== undefined && <span className={s.pickDesc}>{row.secondary}</span>}
                {row.meta && <span className={s.pickUsage}>{row.meta}</span>}
                <span className={s.pickHint}>
                  {i === index && group.hintKey ? t(group.hintKey) : ''}
                </span>
              </ButtonBase>
            )
          })}
        </Fragment>
      ))}

      {view.note && <div className={s.pickEmpty}>{t(view.note)}</div>}

      {/* 候选还在屏上但这一发失败了:错误与它**并陈**,不抹掉旧答案(律②)。 */}
      {view.errorNote && <div className={s.pickEmpty}>{t(view.errorNote)}</div>}
    </div>
  )
}
