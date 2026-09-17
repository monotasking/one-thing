import { ButtonBase } from '@onething/desktop-react'

/*
 * **无样式按钮基座**:只清 UA(appearance / padding / border / font / text-align),
 * 一个像素都不画。它是裸钮三类判法里的 ③ —— **结构性交互件**(瓦 / 卡 / 行 /
 * 琴键 / 选项),视觉本该定制,所以皮肤整份归消费方。
 * 下面四格演的就是「消费方皮肤」的四种真形;基座保证的是清 UA 与焦点环不被清掉。
 */
const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, 84px)', gap: 'var(--sp-3)' } as const
const tile = {
  display: 'grid',
  justifyItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-3) var(--sp-2)',
  borderRadius: 'var(--r-2)',
  background: 'var(--surface-1)',
  border: 'var(--bw-1) solid var(--line-1)',
  font: 'var(--fs-meta) var(--font-ui)',
  color: 'var(--text-2)',
} as const
const tileOn = {
  ...tile,
  background: 'var(--st-sel)',
  borderColor: 'var(--accent)',
  color: 'var(--text-1)',
} as const
// 禁用是**消费方皮肤**的一格:基座只清 UA(它连 opacity 都不画)。
const tileOff = { ...tile, opacity: 'var(--btn-disabled-o)' } as const
const glyph = { fontSize: 'var(--fs-title)', lineHeight: 1 } as const

// ① 启动瓦:整张可点的那一形。Card 不是控件 —— 它归这件。
export const Tiles = () => (
  <div style={grid}>
    <ButtonBase style={tile}>
      <span style={glyph} aria-hidden>▤</span>
      Sessions
    </ButtonBase>
    <ButtonBase style={tileOn} aria-pressed>
      <span style={glyph} aria-hidden>❯_</span>
      Terminal
    </ButtonBase>
    <ButtonBase style={tileOff} disabled>
      <span style={glyph} aria-hidden>◷</span>
      Scheduler
    </ButtonBase>
  </div>
)

const listBox = { width: 300, display: 'grid', gap: 'var(--sp-1)' } as const
const rowSkin = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  width: '100%',
  padding: 'var(--sp-2) var(--sp-2)',
  borderRadius: 'var(--r-1)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
} as const
const rowSel = { ...rowSkin, background: 'var(--st-sel)' } as const
const rowMeta = { marginLeft: 'auto', color: 'var(--text-3)', fontSize: 'var(--fs-meta)' } as const
const dot = { color: 'var(--text-4)' } as const

// ② 列表行:整行是一颗钮,左起笔线由图标列送回,次要读数靠右。
export const Rows = () => (
  <div style={listBox}>
    <ButtonBase style={rowSkin}>
      <span style={dot} aria-hidden>▸</span>
      Traffic-light alignment
      <span style={rowMeta}>2h ago</span>
    </ButtonBase>
    <ButtonBase style={rowSel}>
      <span style={dot} aria-hidden>▾</span>
      Terminal key courtesy table
      <span style={rowMeta}>now</span>
    </ButtonBase>
    <ButtonBase style={rowSkin}>
      <span style={dot} aria-hidden>▸</span>
      Search index rebuild
      <span style={rowMeta}>yesterday</span>
    </ButtonBase>
  </div>
)

const chipRow = { display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' } as const
const chip = {
  padding: 'var(--sp-1) var(--sp-3)',
  borderRadius: 'var(--r-full)',
  border: 'var(--bw-1) solid var(--line-1)',
  background: 'var(--surface-1)',
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-2)',
} as const
const chipOn = {
  ...chip,
  background: 'var(--accent-soft)',
  borderColor: 'var(--accent)',
  color: 'var(--accent-deep)',
} as const

// ③ 选项琴键:一组互斥的丸,选中那一格自己说话(底 + 描边 + 字色)。
export const Options = () => (
  <div style={chipRow}>
    <ButtonBase style={chipOn} aria-pressed>All files</ButtonBase>
    <ButtonBase style={chip} aria-pressed={false}>Modified</ButtonBase>
    <ButtonBase style={chip} aria-pressed={false}>Untracked</ButtonBase>
    <ButtonBase style={chip} aria-pressed={false}>Staged</ButtonBase>
  </div>
)

const pathRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  width: 340,
  padding: 'var(--sp-2) var(--sp-3)',
  borderRadius: 'var(--r-2)',
  background: 'var(--surface-1)',
  border: 'var(--bw-1) solid var(--line-1)',
} as const
const pathText = {
  font: 'var(--fs-meta) var(--font-mono)',
  color: 'var(--text-3)',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const
const inlineAction = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  flex: 'none',
  font: 'var(--fs-micro) var(--font-ui)',
  color: 'var(--text-3)',
} as const
const inlineDone = { ...inlineAction, color: 'var(--ok)' } as const

// ④ 行内微型文字动作(判例:复制路径就地变「已复制」)。
// 它带文字却仍是 ③ —— 无边无底、与正文同行,套一颗 ghost 钮会把这一行撑高一档。
export const InlineActions = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-2)' }}>
    <div style={pathRow}>
      <span style={pathText}>~/data/code/start-electron/apps/desktop-react/src/ui/ButtonBase.tsx</span>
      <ButtonBase style={inlineAction}>⧉ Copy path</ButtonBase>
    </div>
    <div style={pathRow}>
      <span style={pathText}>~/data/code/start-electron/packages/core/toolkit/effects.ts</span>
      <ButtonBase style={inlineDone}>✓ Copied</ButtonBase>
    </div>
  </div>
)
