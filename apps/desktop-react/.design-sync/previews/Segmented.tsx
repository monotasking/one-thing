import { Segmented } from '@onething/desktop-react'

// 少量互斥选项的就地切换(不是下拉、不是开关):槽底 st-hover,选中段抬起为 surface-2 + sh-1。
const DENSITY = [
  { value: 'cozy', label: 'Cozy' },
  { value: 'compact', label: 'Compact' },
]

const THEME = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export const TwoSegments = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Segmented options={DENSITY} value="cozy" onChange={() => {}} label="Density" />
    <Segmented options={DENSITY} value="compact" onChange={() => {}} label="Density" />
  </div>
)

// 三段:选中段落在中间,可以看清抬起面与两侧非选中段的关系。
export const ThreeSegments = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Segmented options={THEME} value="light" onChange={() => {}} label="Theme" />
  </div>
)
