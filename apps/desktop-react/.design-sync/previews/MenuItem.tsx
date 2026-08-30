import { Menu, MenuItem, MenuSection, MenuSeparator } from '@onething/desktop-react'

// MenuItem 是 Menu 的叶子,单独渲没有面 —— 所以整组放进 <Menu> 里看。
// 三形都在这一格:checked 打勾的单选项 / checked={false} 的未选项(勾位占着不重排)/
// 不给 checked 的普通项(没有勾位,role=menuitem)。
export const ItemStates = () => (
  <Menu x={16} y={16} onClose={() => {}} label="Sort files">
    <MenuSection>Sort by</MenuSection>
    <MenuItem checked onClick={() => {}}>
      Last modified
    </MenuItem>
    <MenuItem checked={false} onClick={() => {}}>
      Name
    </MenuItem>
    <MenuItem checked={false} onClick={() => {}}>
      File size
    </MenuItem>
    <MenuSeparator />
    <MenuItem onClick={() => {}}>Reveal in Finder</MenuItem>
    <MenuItem onClick={() => {}}>Copy path</MenuItem>
  </Menu>
)
