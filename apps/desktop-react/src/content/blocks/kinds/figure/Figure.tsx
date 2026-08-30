import { useEffect, useState } from 'react'
import { useT, type TFn } from '../../../../i18n'
import type { BlockModel } from '../../../model/blocks'
import { SourceView } from '../../shell/SourceView'
import { SvgCanvas } from '../../shell/SvgCanvas'
import { readFigureEntry, renderFigure, resolveFigureKind, type FigureEntry } from './registry'
import s from './Figure.module.css'

type FigureModel = Extract<BlockModel, { kind: 'figure' }>

/**
 * 图块的本体 —— **F1 净卡**的 body(檐由壳画,见 index.ts 的 chrome 声明)。
 *
 * 定稿只有一件东西:白面上居中的一张图。没有题注行(`model.title` 这一格在词汇表里
 * 立着,但六轮定稿把题注砍了 —— 图说的话在图里,再配一行小字是报纸排版,不是聊天),
 * 没有边框(边是壳的),没有工具条(动作在檐上)。
 *
 * ── 四种状态,三个降级都落到同一处 ────────────────────────────────────
 *  · 图种不认识 → 源码可见(不是错误:这台不认识它)
 *  · 还在渲染   → 源码可见(**不画骨架**:图在渲好之前有一个完全正确的样子,
 *                 就是它自己的源码。骨架盖住它是拿空白换颜色 —— 与 shiki 同判据)
 *  · 渲染失败   → 源码可见 + 一行灰说明(说明是渲染器的原话,不改写)
 *  · 渲好了     → SVG
 * 三条降级路径的落点是同一个 `SourceView`,与块壳的错误边界、「查看源码」逐字相同:
 * 「源码永远可见」在屏幕上只该有一个样子。
 */
export function Figure({ model }: { model: FigureModel }) {
  const t = useT()
  const def = resolveFigureKind(model.figKind)
  const entry = useFigureRender(model.figKind, model.source)

  if (!def || !entry || entry.status === 'rendering') {
    return <SourceView source={model.source} />
  }

  if (entry.status === 'error') {
    return (
      <div className={s.failed}>
        <FailureLine t={t} message={entry.message} />
        <SourceView source={model.source} />
      </div>
    )
  }

  return (
    <div className={s.canvas}>
      <SvgCanvas svg={entry.svg} className={s.figure} />
    </div>
  )
}

/**
 * 一行灰说明。
 *
 * **不是 danger 大字**:一张图没画出来是内容的小意外,不是系统故障 —— 屏幕上已经
 * 有源码顶着,红色警报会把注意力从「这张图想说什么」抢走。与块壳的降级说明同形,
 * 只是那一处的第一句用 danger(那是「这块内容炸了」),这一处用 text-3。
 */
function FailureLine({ t, message }: { t: TFn; message: string }) {
  return (
    <span className={s.failureLine} role="note">
      {t('block.figure.renderFailed')}
      <span className={s.failureReason}>{message}</span>
    </span>
  )
}

/**
 * 渲染闸 —— 与代码块的高亮闸(`useHighlight`)同一手。
 *
 * state 里只放**一个重画信号**,结果每次渲染现问缓存要。把 SVG 塞进 state 会让它
 * 跟着组件走一份副本:同一张图在两处出现(正文里一份、抽屉里一份)时就是两份字节,
 * 而缓存的全部意义是「同源不二渲」。
 */
function useFigureRender(figKind: string, source: string): FigureEntry | undefined {
  const [, bump] = useState(0)

  useEffect(() => {
    const def = resolveFigureKind(figKind)
    if (!def) return
    if (readFigureEntry(figKind, source)?.status === 'done') return
    let alive = true
    void renderFigure(def, source).then(() => {
      if (alive) bump((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [figKind, source])

  return readFigureEntry(figKind, source)
}
