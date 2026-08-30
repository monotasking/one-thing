import { Menu, MenuItem, MenuSeparator } from '@onething/desktop-react'

// MenuSeparator 是一条 role=separator 的细线,把逻辑段分开(不带标题,与 MenuSection 分工)。
// 只在 Menu 的面里成立,所以整组渲进 <Menu>;这一格看的是两条分隔线切出的三段。
export const DividedGroups = () => (
  <Menu x={16} y={16} onClose={() => {}} label="Session actions">
    <MenuItem onClick={() => {}}>Open in new window</MenuItem>
    <MenuItem onClick={() => {}}>Pin to right edge</MenuItem>
    <MenuSeparator />
    <MenuItem onClick={() => {}}>Export transcript…</MenuItem>
    <MenuItem onClick={() => {}}>Copy session link</MenuItem>
    <MenuSeparator />
    <MenuItem onClick={() => {}}>Archive session</MenuItem>
  </Menu>
)
