import { Kbd } from '@onething/desktop-react'

// 一个键帽:mono 11、1px 描边、r-1。组合由调用方拼(⌘ + K 是两个键帽还是一个,它不管)。
export const Shortcuts = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <Kbd>⌘</Kbd>
    <Kbd>K</Kbd>
    <Kbd>Esc</Kbd>
  </div>
)

// 真实用法:一行提示里嵌键帽 —— 快捷键条 / 空态里的「按哪个键」。
export const InAHintLine = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      font: '12.5px/1.5 system-ui',
      color: 'var(--text-2)',
    }}
  >
    Press <Kbd>⌘</Kbd>
    <Kbd>P</Kbd> to jump to a file, <Kbd>Esc</Kbd> to close
  </div>
)
