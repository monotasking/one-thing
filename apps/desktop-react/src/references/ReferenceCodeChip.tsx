import { memo } from 'react'
/* 引用种类的注册 barrel。**谁要查表,谁负责保证表是装好的**(与
 * `ReferenceTagChip.tsx` 那一行逐字同判例)。 */
import '.'
import { ReferenceChip } from './ReferenceChip'
import { resolveReferenceCode } from './registry'

/**
 * **一格行内码画出来的样子**(09-20)。
 *
 * 整格是一枚引用就画成 chip,不是就原样画成 `<code>` —— 两形都由这一只件出,
 * 所以「一格行内码长什么样」仍旧只有一个产地。
 *
 * ── 为什么解析发生在**画的这一拍**,不在 `to-inline` 翻译那一拍 ──────────────
 * 行内树保持**纯 markdown 词汇**:一格行内码就是 `{ type:'code', text }`,一个字
 * 都不多。于是深比、块身份、`table/serialize.ts`、复制源码这几位既有读者一行都
 * 不用改 —— 它们读的还是那几个字。把解析结果折进树里会让同一段正文有两种树形,
 * 而那几位读者里没有一位需要知道这件事。
 *
 * ── 为什么 `<code>` 的皮由调用方递进来 ────────────────────────────────────
 * 行内码的样子归行内那一层的样式表(`InlineRun.module.css`),它与别的行内元素
 * 是一套;这只件只决定**画哪一形**,不决定行内码长什么样。递一个类名进来比在
 * 这里再引一份行内样式表诚实。
 *
 * ── 线上写法一个字没加 ────────────────────────────────────────────────────
 * 这是一条**只读的识别器**(判词在 `references/kind.ts` 的 `ReferenceCodeParse`)。
 * 没有人会写出这一形:出站永远是 `<ref/>` 或那截记号。
 *
 * ── memo 比的是那几个字 ───────────────────────────────────────────────────
 * `text` 与 `className` 都是字符串,浅比就是逐字比 —— 父重渲时这一枚连
 * `resolveReferenceCode` 都不再跑一次。超量格量的就是它。
 */
function ReferenceCodeChipView({ text, className }: { text: string; className?: string }) {
  const hit = resolveReferenceCode(text)
  if (hit) return <ReferenceChip kindId={hit.kindId} value={hit.value} />
  return <code className={className}>{text}</code>
}

export const ReferenceCodeChip = memo(ReferenceCodeChipView)
