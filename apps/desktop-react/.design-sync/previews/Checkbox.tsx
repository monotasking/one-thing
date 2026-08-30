import { Checkbox } from '@onething/desktop-react'

// Checkbox 的 label 是无障碍名(不可见),可见文字由调用方画在旁边 —— 照做。
const row = { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 } as const
const wrap = { display: 'flex', gap: 12, alignItems: 'center' } as const

export const Checked = () => (
  <div style={wrap}>
    <span style={row}>
      <Checkbox checked onChange={() => {}} label="Auto-approve read tools" />
      Auto-approve read tools
    </span>
    <span style={row}>
      <Checkbox checked={false} onChange={() => {}} label="Stream reasoning" />
      Stream reasoning
    </span>
  </div>
)

// indeterminate:一横不是一勾 —— 「部分选中」与「已选中」同为 accent 实底。
export const Indeterminate = () => (
  <div style={wrap}>
    <span style={row}>
      <Checkbox checked={false} indeterminate onChange={() => {}} label="Selected tools" />
      Selected tools (3 of 9)
    </span>
  </div>
)

export const Disabled = () => (
  <div style={wrap}>
    <span style={row}>
      <Checkbox checked disabled onChange={() => {}} label="Diagnostics" />
      Diagnostics
    </span>
    <span style={row}>
      <Checkbox checked={false} disabled onChange={() => {}} label="Legacy session format" />
      Legacy session format
    </span>
  </div>
)
