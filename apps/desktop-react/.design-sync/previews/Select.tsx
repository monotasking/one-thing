import { Select } from '@onething/desktop-react'

// 自绘下拉:面板是 Menu portal,靠触发器点击才展开 —— 静态渲染只能给 closed 态。
// 触发器 composes 自 Input 的那条配方,所以三档高度与输入框逐像素同源。
const MODELS = [
  { value: 'claude-fable-5', label: 'claude-fable-5' },
  { value: 'deepseek-chat', label: 'deepseek-chat' },
  { value: 'gpt-5.5', label: 'gpt-5.5' },
]

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Select options={MODELS} value="claude-fable-5" onChange={() => {}} size="sm" label="Model" />
    <Select options={MODELS} value="deepseek-chat" onChange={() => {}} size="md" label="Model" />
    <Select options={MODELS} value="gpt-5.5" onChange={() => {}} size="lg" label="Model" />
  </div>
)

export const Disabled = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Select options={MODELS} value="deepseek-chat" onChange={() => {}} disabled label="Model" />
  </div>
)
