import type { CSSProperties } from 'react'
import { resolveIcon } from '../components/icons'
import { brandVars, toneVar } from '../data/file-icons'
import type { FileGlyph } from '../data/file-icons'
import s from './FileGlyph.module.css'

/**
 * 类型标识的**唯一画法** —— 一处判别联合,两种形(字标 | lucide 图标)。
 *
 * 判据与两张表在 `data/file-icons.ts`(纯模块);这里只把它交出来的名字兑成
 * 组件与 CSS 变量引用。**色值一个字面量都不在这里**:字标那一对由 `brandVars`
 * 给(值在 tokens.css 的数据节),图标那一枚由 `toneVar` 给。
 *
 * ── 为什么它从 FilesPanel 里搬出来 ─────────────────────────────────────────
 * F1 之前它只有一个消费方(树行 + 详情浮层),所以长在面板里没毛病。查看器
 * 檐上那枚类型徽是第二个消费方,而两个消费方各画一遍必然分叉(同一枚 `.ts`
 * 在树上是品牌字标、在檐上却是一张纸,那不是设计,那是漏改)。
 * 搬出来的是**画法**,判据一个字没动。
 *
 * `size` 只影响**图标那一形**:详情浮层与查看器檐上那枚图标当主体用,要大一档;
 * 字标两处一样大 —— 它是几个字母,放大反而读成一块色斑。这条差别是从前
 * FilesPanel.module.css 里那句 `.detailGlyph .rowIcon` 的逐字搬家。
 */
export function FileGlyphMark({
  glyph,
  className,
  size = 'sm',
}: {
  glyph: FileGlyph
  /** 槽位类名(宽高由消费方的排版说了算 —— 它是那一行 / 那一条檐的一格)。 */
  className?: string
  size?: 'sm' | 'lg'
}) {
  if (glyph.kind === 'brand') {
    const { bg, fg } = brandVars(glyph.brand)
    return (
      <span
        className={className ? `${className} ${s.ext}` : s.ext}
        style={{ background: bg, color: fg } as CSSProperties}
        aria-hidden="true"
      >
        {glyph.label}
      </span>
    )
  }
  const Icon = resolveIcon(glyph.icon)
  return (
    <span className={className} aria-hidden="true">
      <Icon
        className={size === 'lg' ? `${s.icon} ${s.iconLg}` : s.icon}
        style={{ color: toneVar(glyph.tone) } as CSSProperties}
        strokeWidth={1.75}
      />
    </span>
  )
}
