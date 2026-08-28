import type { ReactNode } from 'react'
import s from './Kbd.module.css'

/**
 * 规范画布「键帽」的唯一实现:mono 11、1px --line-2 描边、r-1、底 --surface-0。
 * 凡是「这里要按哪个键」都用它 —— 搜索条的 ⌘P 角标、Quick Look 底部的快捷键条。
 * 它只画一个键帽,不认识快捷键的含义,也不负责组合(⌘ + P 是两个键帽还是一个,
 * 由调用方决定)。键面字符本身也走字典(shortcut.*),组件里不落字面。
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className ? `${s.kbd} ${className}` : s.kbd}>{children}</kbd>
}
