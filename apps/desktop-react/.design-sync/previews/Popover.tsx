import { Popover, ButtonBase, StatusDot } from '@onething/desktop-react'

/*
 * **附属浮层**:贴着某一行长出来,回答「这一项是什么」,而背后那棵树照旧
 * 能看、能滚、能点。与 Dialog 的差别是**语义**不是尺寸 —— 没有遮罩、
 * `role="dialog"` 但不给 `aria-modal`、点外面就散。
 * portal 到 body、fixed 定位,所以预览给一对视口坐标把它定格在卡内。
 * 壳只画底 / 边 / 圆角 / 投影,内容的内边距整份归消费方。
 */
const body = { width: 320, padding: 'var(--sp-3)', display: 'grid', gap: 'var(--sp-3)' } as const
const head = { display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' } as const
const mark = {
  width: 'var(--sp-7)',
  height: 'var(--sp-7)',
  display: 'grid',
  placeItems: 'center',
  borderRadius: 'var(--r-1)',
  background: 'var(--accent-soft)',
  color: 'var(--accent-deep)',
  font: 'var(--fs-meta) var(--font-mono)',
} as const
const name = { font: 'var(--fs-label) var(--font-ui)', color: 'var(--text-1)' } as const
// 网格子项的 min-width 是 auto:不写这一格,长路径的 min-content 会把整行撑出浮层。
const pathRow = { display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 } as const
const path = {
  font: 'var(--fs-micro) var(--font-mono)',
  color: 'var(--text-3)',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const
const copy = {
  marginLeft: 'auto',
  flex: 'none',
  font: 'var(--fs-micro) var(--font-ui)',
  color: 'var(--text-3)',
} as const
const meta = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: 'var(--sp-1) var(--sp-3)',
  font: 'var(--fs-meta) var(--font-ui)',
} as const
const key = { color: 'var(--text-4)' } as const
const val = { color: 'var(--text-2)' } as const

// 文件详情:定稿把它从 Dialog 改成浮层,正因为一层遮罩把「瞄一眼」变成了「答一道题」。
export const FileDetail = () => (
  <Popover x={16} y={16} onClose={() => {}} label="Popover.tsx" testId="files-detail">
    <div style={body}>
      <div style={head}>
        <span style={mark} aria-hidden>TS</span>
        <span style={name}>Popover.tsx</span>
      </div>
      <div style={pathRow}>
        <span style={path}>~/start-electron/apps/desktop-react/src/ui/Popover.tsx</span>
        <ButtonBase style={copy}>⧉ Copy path</ButtonBase>
      </div>
      <div style={meta}>
        <span style={key}>Size</span><span style={val}>4.2 KB</span>
        <span style={key}>Modified</span><span style={val}>May 15, 2024 at 12:00</span>
        <span style={key}>Kind</span><span style={val}>TypeScript React source</span>
        <span style={key}>Tracked</span><span style={val}>git · 3 commits</span>
      </div>
    </div>
  </Popover>
)

const listBody = { width: 300, padding: 'var(--sp-2)', display: 'grid', gap: 'var(--sp-1)' } as const
const sectionHead = {
  padding: 'var(--sp-1) var(--sp-2)',
  font: 'var(--fs-micro) var(--font-ui)',
  color: 'var(--text-4)',
  letterSpacing: '0.04em',
} as const
const optionRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  width: '100%',
  padding: 'var(--sp-2)',
  borderRadius: 'var(--r-1)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
} as const
const optionOn = { ...optionRow, background: 'var(--st-sel)' } as const
const optionMeta = { marginLeft: 'auto', color: 'var(--text-3)', fontSize: 'var(--fs-meta)' } as const

// 第二形:贴着一行尾巴上的钮开出去的小面(锚点自己靠右时给 anchorPlace="below-end")。
export const ModelOverride = () => (
  <Popover x={16} y={16} onClose={() => {}} label="Model for this session">
    <div style={listBody}>
      <div style={sectionHead}>MODEL FOR THIS SESSION</div>
      <ButtonBase style={optionOn}>
        <StatusDot tone="ok" />
        claude-fable-5
        <span style={optionMeta}>200k</span>
      </ButtonBase>
      <ButtonBase style={optionRow}>
        <StatusDot tone="ok" />
        gpt-5.5
        <span style={optionMeta}>400k</span>
      </ButtonBase>
      <ButtonBase style={optionRow}>
        <StatusDot tone="warn" />
        deepseek-chat
        <span style={optionMeta}>rate limited</span>
      </ButtonBase>
      <ButtonBase style={optionRow}>
        <StatusDot tone="idle" />
        kimi-k2
        <span style={optionMeta}>not configured</span>
      </ButtonBase>
    </div>
  </Popover>
)
