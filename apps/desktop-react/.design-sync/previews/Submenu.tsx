import { Menu, MenuItem, MenuSection, MenuSeparator, Submenu } from '@onething/desktop-react'

// 一项带 ▸ 的子菜单(菜单族第四件)。它是 Menu 的叶子 —— 单独渲没有面,
// 所以整组放进 <Menu> 里,旁边配几条 MenuItem,才看得出「它就是一行菜单项,
// 只是右边多一枚 ▸」。
//
// 子表**只靠交互才挂载**(按下这一行、或在它上面按 →),没有受控 open prop,
// 所以静态预览给的是闭态:▸ 永远占着位,开合切换不动一个像素的布局。
// 子表不 portal —— 它是父菜单 DOM 的真孩子,只是 position:fixed 自己摆位置。

const Corner = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
  </svg>
)
const Columns = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 3v18" />
  </svg>
)
const Palette = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="9" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
  </svg>
)

// 标签动作表的真用法(W7-c):八行平铺折成两行 + 两张子表。
export const InTabActionMenu = () => (
  <Menu x={16} y={16} onClose={() => {}} label="Tab actions">
    <MenuItem onClick={() => {}}>Close tab</MenuItem>
    <MenuItem onClick={() => {}}>Close others</MenuItem>
    <MenuSeparator />
    <Submenu label="Move to shelf" icon={Corner}>
      <MenuItem onClick={() => {}}>Left</MenuItem>
      <MenuItem onClick={() => {}}>Right</MenuItem>
      <MenuItem onClick={() => {}}>Top</MenuItem>
      <MenuItem onClick={() => {}}>Bottom</MenuItem>
    </Submenu>
    <Submenu label="Split" icon={Columns}>
      <MenuItem onClick={() => {}}>Split left</MenuItem>
      <MenuItem onClick={() => {}}>Split right</MenuItem>
      <MenuItem onClick={() => {}}>Split up</MenuItem>
      <MenuItem onClick={() => {}}>Split down</MenuItem>
    </Submenu>
    <MenuSeparator />
    <MenuItem onClick={() => {}}>Copy path</MenuItem>
  </Menu>
)

// 三形并排:带图标的、不带图标的(标签自己顶到行首)、以及停用的那一行 ——
// 停用时 ▸ 跟着一起降透明,它不是一张「打不开的表」而是一行不能按的项。
export const RowVariants = () => (
  <Menu x={16} y={16} onClose={() => {}} label="Session actions">
    <MenuSection>Appearance</MenuSection>
    <Submenu label="Theme" icon={Palette}>
      <MenuItem checked onClick={() => {}}>
        Follow system
      </MenuItem>
      <MenuItem checked={false} onClick={() => {}}>
        Warm paper
      </MenuItem>
      <MenuItem checked={false} onClick={() => {}}>
        Midnight
      </MenuItem>
    </Submenu>
    <Submenu label="Open with">
      <MenuItem onClick={() => {}}>Viewer</MenuItem>
      <MenuItem onClick={() => {}}>External editor</MenuItem>
    </Submenu>
    <MenuSeparator />
    <Submenu label="Export transcript" disabled>
      <MenuItem onClick={() => {}}>Markdown</MenuItem>
      <MenuItem onClick={() => {}}>JSON</MenuItem>
    </Submenu>
    <MenuItem onClick={() => {}}>Rename session</MenuItem>
  </Menu>
)
