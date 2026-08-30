import { Menu, MenuItem, MenuSection, MenuSeparator } from '@onething/desktop-react'

// MenuSection 是组头:10px 宽字距的弱色分组名,自身不可交互。
// 它只在 Menu 的面里成立,所以整组渲进 <Menu>;这一格看的是两个组头把项分成两段。
export const GroupHeaders = () => (
  <Menu x={16} y={16} onClose={() => {}} label="Panel actions">
    <MenuSection>This panel</MenuSection>
    <MenuItem onClick={() => {}}>Duplicate</MenuItem>
    <MenuItem onClick={() => {}}>Rename…</MenuItem>
    <MenuSeparator />
    <MenuSection>Workspace</MenuSection>
    <MenuItem onClick={() => {}}>New panel</MenuItem>
    <MenuItem onClick={() => {}}>Reset layout</MenuItem>
  </Menu>
)
