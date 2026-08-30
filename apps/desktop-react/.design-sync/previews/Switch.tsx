import { Switch } from '@onething/desktop-react'

// 轨 36×20,关态 line-2 / 开态 accent;钮永远白圆。label 是无障碍名,
// 可见文字由调用方自己排 —— 设置行的真实排法就是「文字在左、开关在右」。
const row = { display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 } as const
const wrap = { display: 'flex', gap: 12, alignItems: 'center' } as const

export const OnOff = () => (
  <div style={wrap}>
    <span style={row}>
      Diagnostics
      <Switch checked onChange={() => {}} label="Diagnostics" />
    </span>
    <span style={row}>
      Auto-compact context
      <Switch checked={false} onChange={() => {}} label="Auto-compact context" />
    </span>
  </div>
)

export const Disabled = () => (
  <div style={wrap}>
    <span style={row}>
      Plugin market
      <Switch checked disabled onChange={() => {}} label="Plugin market" />
    </span>
    <span style={row}>
      Remote approval
      <Switch checked={false} disabled onChange={() => {}} label="Remote approval" />
    </span>
  </div>
)
