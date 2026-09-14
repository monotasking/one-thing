import type { ComponentPropsWithRef, CSSProperties } from 'react'
import { initialOf } from '../projection'
import { providerIconOf } from '../provider-icons'
import s from './ProviderGlyph.module.css'

/**
 * 一家供应商的方图标(09-14,用户报障「供应商只有字母」)。
 *
 * 从前「方框里一个首字母」在两处各写了一遍(名册行 / 详情头),于是真图标要加
 * 两遍、改一处就漂。这里把它收成一件:**外形(方框)与内容(图标或首字母)
 * 都由这一件说了算**,两处消费只递事实(哪一家、叫什么、是不是自定义、多大)。
 *
 * ── 为什么是 CSS mask,不是 `<img>` 也不是 `?raw` 内联 ──────────────────────
 * 素材是单色档 svg(`fill="currentColor"`),而 `<img>` 拿不到宿主的 `currentColor`
 * —— 它是一份独立文档,主题从亮换到暗它一动不动。`?raw` 内联倒是能跟色,但那是
 * 把一段外来标记塞进 DOM(九只 svg 的 `<title>`、id、style 全进树)。所以走 mask:
 * 图标只当形状用,颜色由 `background: currentColor` 从 `color`(--text-2)取 ——
 * 与壳里 lucide 那一族同一条纪律,主题换色它跟着换,一行 JS 都不必知道。
 *
 * **没有图标是正常态,不是错**:自定义家、还没画图标的家一律回落首字母
 * (`initialOf`),自定义家照旧虚线边 —— 「这是你自己建的」在扫列表时一眼看得出。
 *
 * `aria-hidden`:名字就写在旁边(名册宽档 / 详情头),收起档里 Tooltip 正念着
 * 同一句 —— 图标再念一遍就是念两遍。
 *
 * 剩下的 props 原样递给那枚方框(Tooltip 用 cloneElement 往孩子身上接 ref 与四个
 * 指针手,所以这一件必须是**透明**的:不转发就等于把提示悄悄掐掉)。
 */
export function ProviderGlyph({
  familyId,
  label,
  custom = false,
  size = 'sm',
  className,
  ...rest
}: {
  /** 家族 id —— 查图标表用的键。 */
  familyId: string
  /** 这一家的显示名。只在没有图标时用,取它的首字母。 */
  label: string
  custom?: boolean
  /** sm = 名册行那枚 22 方;md = 详情头那枚 36 方。 */
  size?: 'sm' | 'md'
} & Omit<ComponentPropsWithRef<'span'>, 'children'>) {
  const icon = providerIconOf(familyId)
  return (
    <span
      {...rest}
      className={[s.glyph, size === 'md' ? s.md : s.sm, custom ? s.custom : null, className]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
      // 「这一枚此刻画的是图标还是首字母」—— 给门与单测的稳定判据
      // (CSS Modules 的类名构建后是哈希,而这是一格事实,不是一层皮)。
      data-glyph={icon ? 'icon' : 'initial'}
    >
      {icon ? (
        <span
          className={s.mark}
          // 资源 URL 走自定义属性进 CSS(mask 的产地在样式表里,这里只递地址)。
          style={{ '--pv-glyph-icon': `url("${icon}")` } as CSSProperties}
        />
      ) : (
        initialOf(label)
      )}
    </span>
  )
}
