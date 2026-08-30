import { Tabs } from '@onething/desktop-react'

// 完全受控的 tab 条:活动态只换字色 + 底缘 2px accent 指示条(不占布局)。
// icon 是 lucide 图标名字符串,组件内部解析。给了 onClose 才画 ×(hover 本 tab 才浮出)。
const PANELS = [
  { id: 'files', label: 'Files', icon: 'FolderTree' },
  { id: 'diff', label: 'Diff', icon: 'GitCompare' },
  { id: 'terminal', label: 'Terminal', icon: 'Terminal' },
]

export const PanelTabs = () => (
  <div style={{ width: 360 }}>
    <Tabs
      items={PANELS}
      activeId="files"
      onSelect={() => {}}
      onClose={() => {}}
      label="Panel tabs"
    />
  </div>
)

// 不给 onClose 就没有关闭键 —— 固定的几档视图(不可关)用这一形。
export const Fixed = () => (
  <div style={{ width: 300 }}>
    <Tabs
      items={[
        { id: 'notes', label: 'Notes', icon: 'FileText' },
        { id: 'tools', label: 'Tools', icon: 'Wrench' },
      ]}
      activeId="tools"
      onSelect={() => {}}
      label="Session views"
    />
  </div>
)
