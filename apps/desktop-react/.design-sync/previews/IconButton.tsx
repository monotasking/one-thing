import { IconButton } from '@onething/desktop-react'

/*
 * 第 18 件:**檐上那种钮** —— 无边框、无变体、三档尺寸,贴着标题与状态栏站。
 * 与 `Button iconOnly` 的分工:那件是动作钮(有边框、primary/ghost、进表单)。
 * 三条硬规矩:`label` 必填(同时是 aria-label 与 Tooltip 的内容)、提示走
 * ui/Tooltip 禁 native title、焦点环不自绘。
 * 图标是 `LucideIcon` 形 —— 收 className / strokeWidth,尺寸由库件的 .icon 类给。
 */
const svg = (d: string) => (p: any) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {d.split('|').map((seg) => <path key={seg} d={seg} />)}
  </svg>
)

const Close = svg('M18 6 6 18|M6 6l12 12')
const Pencil = svg('M12 20h9|M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z')
const Copy = svg('M9 9h10v10H9z|M5 15V5h10')
const Search = svg('M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12|m20 20-4.5-4.5')
const Trash = svg('M3 6h18|M8 6V4h8v2|M6 6l1 14h10l1-14')
const Star = svg('m12 3 2.9 5.9 6.1.9-4.5 4.4 1.1 6.3L12 17.5 6.4 20.5l1.1-6.3L3 9.8l6.1-.9Z')

const row = { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' } as const
const label = { font: 'var(--fs-meta) var(--font-ui)', color: 'var(--text-3)' } as const
const cell = { display: 'grid', justifyItems: 'center', gap: 'var(--sp-2)' } as const

// xs 18 = 行内挂件(树行尾的 ⋯);sm 22 = 檐上(缺省);md 28 = 与 Button 同高的场合。
// 右列同时开着(pressed):**命中区**是三档真正在变的那一维 —— 静止态底透明,
// 只有底亮起来才看得见 18 / 22 / 28 这三个方框。
export const Sizes = () => (
  <div style={{ ...row, gap: 'var(--sp-5)' }}>
    <div style={cell}>
      <span style={row}>
        <IconButton icon={Close} label="Close tab" size="xs" />
        <IconButton icon={Pencil} label="Edit mode" size="xs" pressed />
      </span>
      <span style={label}>xs · 18</span>
    </div>
    <div style={cell}>
      <span style={row}>
        <IconButton icon={Close} label="Close tab" size="sm" />
        <IconButton icon={Pencil} label="Edit mode" size="sm" pressed />
      </span>
      <span style={label}>sm · 22 (default)</span>
    </div>
    <div style={cell}>
      <span style={row}>
        <IconButton icon={Close} label="Close tab" size="md" />
        <IconButton icon={Pencil} label="Edit mode" size="md" pressed />
      </span>
      <span style={label}>md · 28</span>
    </div>
  </div>
)

// pressed 是**开着**(aria-pressed),不是按住:accent 晕底 + accent 字色。
// danger 只换字色不换底(四轴:状态色永不换底)。disabled 不挂提示。
export const States = () => (
  <div style={{ ...row, gap: 'var(--sp-5)' }}>
    <div style={cell}><IconButton icon={Pencil} label="Edit" /><span style={label}>rest</span></div>
    <div style={cell}><IconButton icon={Pencil} label="Edit mode" pressed /><span style={label}>pressed</span></div>
    <div style={cell}><IconButton icon={Trash} label="Delete file" tone="danger" /><span style={label}>danger</span></div>
    <div style={cell}><IconButton icon={Copy} label="Copy path" disabled /><span style={label}>disabled</span></div>
  </div>
)

const eave = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  width: 380,
  padding: 'var(--sp-2) var(--sp-3)',
  borderRadius: 'var(--r-2)',
  background: 'var(--surface-2)',
  border: 'var(--bw-1) solid var(--line-1)',
} as const
const title = {
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-1)',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const
const spacer = { marginLeft: 'auto', display: 'flex', gap: 'var(--sp-1)' } as const

// 真用法:查看器的檐 —— 身份在左(名字),动作在右,关闭永远最后一颗。
export const ViewerEave = () => (
  <div style={eave}>
    <span style={title}>keymap-responder-2026-09.md</span>
    <span style={spacer}>
      <IconButton icon={Star} label="Pin to shelf" size="xs" />
      <IconButton icon={Search} label="Find in this file" size="xs" />
      <IconButton icon={Pencil} label="Edit mode" size="xs" pressed />
      <IconButton icon={Close} label="Close" size="xs" />
    </span>
  </div>
)

// 行尾挂件:xs 一族贴着一行文字站,不把行撑高。
export const RowAffordances = () => (
  <div style={{ width: 320, display: 'grid', gap: 'var(--sp-1)' }}>
    {['ButtonBase.tsx', 'IconButton.module.css', 'Popover.tsx'].map((name) => (
      <div
        key={name}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          padding: 'var(--sp-1) var(--sp-2)',
          borderRadius: 'var(--r-1)',
          font: 'var(--fs-body) var(--font-ui)',
          color: 'var(--text-1)',
        }}
      >
        <span style={{ color: 'var(--text-4)' }} aria-hidden>▸</span>
        {name}
        <span style={spacer}>
          <IconButton icon={Copy} label="Copy path" size="xs" />
          <IconButton icon={Trash} label="Delete" size="xs" tone="danger" />
        </span>
      </div>
    ))}
  </div>
)
