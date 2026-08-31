import type { ReactNode } from 'react'
import s from './Badge.module.css'

/**
 * 规范画布「徽」的唯一实现:一颗丸,里面一个短字符串(数字 / ✓ / 未读数)。
 * 三个 tone 各是一条完整配方,不是「基础样式 + 换个底色」——
 * Dock 徽标(16、11、600)和会话卡未读丸(18、10、常规字重)本来就不是一个尺寸,
 * 硬合成一个基类会逼出 override,那才是真的不一致。
 *
 * 定位归调用方:Badge 自己永远是 inline-flex,谁要把它钉在瓷砖右上角,
 * 谁传 className 去 position: absolute —— 徽不该知道自己贴在什么上面。
 *
 * ── 无障碍(A11y 线 · A2)───────────────────────────────────────────────
 * 不进 Tab 序、没有键盘表:它是一段**文字**,不是控件。所以它就是一个 <span>,
 * 不加 role、不加 aria-label —— 里面那个 `3` / `✓` 本身就是要念出来的内容。
 * 数字的含义(「3 条未读」)归**它贴着的那件东西**说:钉在 Dock 瓦上的徽,
 * 由瓦自己的 aria-label 把「未读 3」这句完整的话说出来。徽只管画那颗丸。
 * ──────────────────────────────────────────────────────────────────────
 */
export type BadgeTone = 'danger' | 'ok' | 'unread'

export function Badge({
  tone,
  className,
  children,
}: {
  tone: BadgeTone
  className?: string
  children: ReactNode
}) {
  return <span className={`${s.badge} ${s[tone]}${className ? ` ${className}` : ''}`}>{children}</span>
}
