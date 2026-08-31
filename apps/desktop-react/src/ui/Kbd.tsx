import type { ReactNode } from 'react'
import s from './Kbd.module.css'

/**
 * 规范画布「键帽」的唯一实现:mono 11、1px --line-2 描边、r-1、底 --surface-0。
 * 凡是「这里要按哪个键」都用它 —— 搜索条的 ⌘P 角标、Quick Look 底部的快捷键条。
 * 它只画一个键帽,不认识快捷键的含义,也不负责组合(⌘ + P 是两个键帽还是一个,
 * 由调用方决定)。键面字符本身也走字典(shortcut.*),组件里不落字面。
 *
 * ── 无障碍(A11y 线 · A2)───────────────────────────────────────────────
 * 不进 Tab 序、没有键盘表:它是**在说**一个键,不是那个键。用的是原生 `<kbd>`,
 * 语义白拿,一个 aria-* 都不加。⌘ 这类符号的读法归读屏软件与用户的口音表,
 * 不是我们该替它翻译的东西(替它写 aria-label="Command" 只会两句一起念)。
 * ──────────────────────────────────────────────────────────────────────
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className ? `${s.kbd} ${className}` : s.kbd}>{children}</kbd>
}
