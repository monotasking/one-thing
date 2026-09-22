import { useT, type TFn } from '../../../../i18n'
import type { BlockModel } from '../../../model/blocks'
import { MathHtml } from '../../math/MathHtml'
import { useRenderedMath } from '../../math/useRenderedMath'
import { SourceView } from '../../shell/SourceView'
import s from './MathBlock.module.css'

type MathModel = Extract<BlockModel, { kind: 'math' }>

/**
 * 块公式 —— 纸上居中的一行。
 *
 * **不套卡片、无檐、无动作**(注册那一行的 `presentation: 'flow'`):一条公式是这页
 * 纸上的一句话,把它装进带檐带边的白卡里,读起来就成了「一件被引用的东西」。这与
 * 图卡的取舍是反的,理由写在 `model/blocks.ts` 的 math 那一格上。
 *
 * ── 三态,两条降级落同一处 ────────────────────────────────────────────────
 *  · 还没收尾(`closed:false`,正在流)/ 库还没到 → 那段 TeX 源码;
 *  · 排不出来 → 源码 + 一行灰说明(说明是 KaTeX 的原话,不改写);
 *  · 排好了 → KaTeX 的 display 产出,居中。
 * 源码那一份走 `SourceView` —— 它是全仓「源码怎么画」的唯一答案(兜底块的本体、
 * 错误边界的降级、檐上的「查看源码」都是它),三条路不该长得不一样。
 *
 * ── 为什么没有骨架 ────────────────────────────────────────────────────────
 * 公式在排版之前有一个**完全正确**的样子:它自己的源码。拿骨架盖住一份已经正确的
 * 东西,是用一段空白换一点颜色 —— 与 shiki 未到时的素文本、mermaid 未到时的图源码
 * 同一条判据(所以注册那一行也不声明 `loader`:声明了就会挂起 Suspense 画骨架)。
 */
export function MathBlock({ model }: { model: MathModel }) {
  const t = useT()
  // 还在流的那一段:源码逐行长出来。此刻问 KaTeX 要排版没有意义(半条公式排不出),
  // 而且排不出的结果也进缓存 —— 所以「值不值得排」这一格递进钩子里(09-20 审查:
  // 从前这一判写在钩子**之后**,于是每一帧半截 TeX 都白排一次、还把缓存塞满)。
  // 库照拉不误:它早一点到,闭合那一刻才能同步换装。
  const rendered = useRenderedMath(model.source, true, model.closed)

  /*
   * ── 三态**同一个外壳**,因为契约上写着 `settled: 'same'`(R 线 F1,2026-09-22)──
   *
   * 病历(真机读数在正本 §8):从前「还没排好」那一支返回的是
   * `<MathSource …/>` —— 一个**组件元素**,而排好那一支返回的是 `<div>` —— 一个
   * **宿主元素**。React 比的是这个位置上的元素**型**,两者不同型,于是闭合那一拍
   * 整块卸载重挂:`DIV(life 65) → DIV(life 66)`,`padding 0 → 4px 0`,高 45 → 26.98,
   * 下文整体上跳 18.02px。注册那一行自述的 `settled: 'same'`(「同一个组件、同一个
   * 身份号、不重挂」)因此是一句**假话** —— 身份号确实没变(`${偏移}:math` 两拍逐字
   * 相同),被换掉的是它下面那个 DOM 节点。
   *
   * 所以三支的根**都是 `div`、都带 `.block`**:型一样 React 就只打补丁,类名与孩子
   * 随便换。`.block` 那一格 `padding-block` 因此三态恒定 —— 18.02px 里的 8px 是它
   * 贡献的,而那是**两个外壳**造成的差,不是排版的事实。
   */
  if (rendered.status === 'pending') {
    return (
      <div className={`${s.block} ${s.source}`} data-prose="text">
        <SourceView source={model.source} />
      </div>
    )
  }

  if (rendered.status === 'error') {
    return (
      <div className={`${s.block} ${s.failed}`} data-prose="text">
        <FailureLine t={t} message={rendered.message} />
        <SourceView source={model.source} />
      </div>
    )
  }

  /*
   * 横滚归自己:`flow` 块不进块壳,壳那一层的 `overflow-x` 与限高折叠都不在。
   * 一条排出来比消息列宽的公式必须在**它自己这一格**里横滚,绝不许把消息列撑宽
   * (那一下会让整条聊天流出现横滚条)。
   */
  return (
    <div className={s.block} data-prose="text">
      <MathHtml html={rendered.html} display className={s.rendered} />
    </div>
  )
}

/**
 * 一行灰说明 —— 与图块的降级那一行同形(`kinds/figure/Figure.tsx` 的 `FailureLine`)。
 *
 * **不是 danger 大字**:一条公式没排出来是内容的小意外,不是系统故障 —— 屏幕上已经
 * 有源码顶着,红色警报会把注意力从「这条公式想说什么」抢走。
 */
function FailureLine({ t, message }: { t: TFn; message: string }) {
  return (
    <span className={s.failureLine} role="note">
      {t('block.math.failed')}
      <span className={s.failureReason}>{message}</span>
    </span>
  )
}
