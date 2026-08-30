import { Input } from '@onething/desktop-react'

// 三档高度:sm 28 / md 32 / lg 38 —— 前两档与按钮族共用 token,并排时基线一致。
export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Input size="sm" value="claude-fable-5" onValueChange={() => {}} />
    <Input size="md" value="claude-fable-5" onValueChange={() => {}} />
    <Input size="lg" value="claude-fable-5" onValueChange={() => {}} />
  </div>
)

// 左槽图标 + 空值占位文案:搜索会话的典型用法。
export const PrefixAndPlaceholder = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Input
      value="React 壳架子"
      onValueChange={() => {}}
      prefix={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      }
    />
    <Input value="" onValueChange={() => {}} placeholder="Search sessions" />
  </div>
)

// invalid 只换边色(说明文字归调用方);disabled 整体降透明。
export const States = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Input value="sk-" onValueChange={() => {}} invalid />
    <Input value="deepseek-chat" onValueChange={() => {}} disabled />
  </div>
)
