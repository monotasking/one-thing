import { useT } from '../../../i18n'
import { Tooltip } from '../../../ui/Tooltip'
import type { InlineNode } from '../../model/inline'
import { MathHtml } from '../math/MathHtml'
import { useRenderedMath } from '../math/useRenderedMath'
import s from './InlineRun.module.css'

/**
 * 夹在字里的公式。三态,两种降级都落到**同一个样子:作者写的那几个字符**。
 *
 *  · 排好了 → KaTeX 的行内产物;
 *  · 库还没到 → `$tex$` 当普通文字(公式在排版之前有一个完全正确的样子,就是它自己);
 *  · 排不出来 → 同样是 `$tex$`,外加一只 `ui/Tooltip` 挂着 KaTeX 的原话。
 *
 * ── 失败态为什么是 Tooltip 而不是一行红字 ────────────────────────────────
 * 这里是**一句话中间**,长不出「一行说明」那种东西(块公式那一档才有地方画,见
 * `kinds/math/MathBlock.tsx`)。而原话不该被吞:写错的 TeX 是常事,人要看得到是哪里
 * 错了。Tooltip 是 cloneElement 注入,**不多包一层 DOM** —— 行内多一个元素会把
 * `pre-wrap` 的空白折叠规则在边界上改掉(与链接、行内图那两支同一条判词);
 * native `title=` 是禁令区。
 *
 * ── 行内不破行 ────────────────────────────────────────────────────────────
 * `.katex` 自带 `white-space: nowrap`,而段落是 `pre-wrap` —— 一条长公式因此不会被
 * 从中间折断,它整条换行到下一行。这是对的:半条公式没有意义。超长到一行装不下
 * 的那种本来就该写成独占一段(块那一档有自己的横滚)。
 */
export function InlineMath({ node }: { node: Extract<InlineNode, { type: 'math' }> }) {
  const t = useT()
  const rendered = useRenderedMath(node.tex, false)

  if (rendered.status === 'done') {
    return <MathHtml html={rendered.html} display={false} className={s.math} />
  }

  const source = `$${node.tex}$`
  if (rendered.status === 'pending') return <span className={s.mathSource}>{source}</span>

  return (
    <Tooltip content={t('block.math.renderFailed', { message: rendered.message })}>
      <span className={s.mathSource} data-failed="">
        {source}
      </span>
    </Tooltip>
  )
}
