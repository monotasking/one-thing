import { Menu, MenuItem, MenuSection, MenuSeparator } from '@onething/desktop-react'

// 上下文菜单(portal 到 body,fixed 定位)。静态渲染在卡内固定坐标展开。
// checked 打勾表示当前选中项;MenuSection 是小写大写化的组头,MenuSeparator 分隔逻辑段。
export const OpenWith = () => (
  <Menu x={16} y={16} onClose={() => {}} label="Open with">
    <MenuSection>Open with</MenuSection>
    <MenuItem checked onClick={() => {}}>Stage</MenuItem>
    <MenuItem checked={false} onClick={() => {}}>Pinned right</MenuItem>
    <MenuItem checked={false} onClick={() => {}}>Floating window</MenuItem>
    <MenuSeparator />
    <MenuItem onClick={() => {}}>Settings…</MenuItem>
  </Menu>
)
