import { Fold, FoldBody, FoldFoot, FoldTrigger } from '@onething/desktop-react'

// 底把手:只在展开态出场;按下 = 合上 + 头把手滚回视野 + 焦点交给头把手。合上就卸载。
const head = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-1) var(--sp-2)',
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-2)',
  cursor: 'pointer',
} as const
const body = {
  padding: 'var(--sp-2) var(--sp-3)',
  marginLeft: 'var(--sp-2)',
  borderLeft: '2px solid var(--line-1)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
  lineHeight: 1.6,
} as const
const foot = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  marginTop: 'var(--sp-1)',
  padding: 'var(--sp-1) var(--sp-2)',
  borderRadius: 'var(--r-full)',
  border: '1px solid var(--line-1)',
  font: 'var(--fs-meta) var(--font-ui)',
  color: 'var(--text-3)',
  cursor: 'pointer',
} as const

export const OpenWithFoot = () => (
  <div style={{ width: 360, display: 'grid', gap: 'var(--sp-1)' }}>
    <Fold defaultOpen>
      <FoldTrigger style={head}>
        <span aria-hidden>▾</span> Thought for 12s
      </FoldTrigger>
      <FoldBody style={body}>
        First check whether the component already exists under src/ui. It does — Fold landed on
        09-09 for exactly this shape. Reuse it, keep the skin in the consumer, and pass the trigger
        node up for the height transition.
      </FoldBody>
      <FoldFoot style={foot}>
        <span aria-hidden>▴</span> Collapse
      </FoldFoot>
    </Fold>
  </div>
)
