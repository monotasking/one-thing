import { Fold, FoldBody, FoldTrigger } from '@onething/desktop-react'

// FoldTrigger 单独渲会抛错(必须放在 <Fold> 里)—— 所以整组放进 <Fold> 里看。
// 缺省 div;`as="span"` 给行内那一族。皮肤归消费方。
const head = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-1) var(--sp-2)',
  borderRadius: 'var(--r-1)',
  background: 'var(--st-hover)',
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-2)',
  cursor: 'pointer',
} as const
const body = { padding: 'var(--sp-2)', font: 'var(--fs-body) var(--font-ui)', color: 'var(--text-1)' } as const

export const AsDivAndSpan = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-3)', width: 360 }}>
    <Fold defaultOpen>
      <FoldTrigger style={head}>
        <span aria-hidden>▾</span> Show 12 tool calls
      </FoldTrigger>
      <FoldBody style={body}>read · edit · bash · web_search …</FoldBody>
    </Fold>
    <p style={{ margin: 0, font: 'var(--fs-body) var(--font-ui)', color: 'var(--text-1)' }}>
      Compacted 48 messages{' '}
      <Fold>
        <FoldTrigger as="span" style={head}>
          <span aria-hidden>▸</span> summary
        </FoldTrigger>
        <FoldBody as="span" style={body}>Kept the last two turns verbatim.</FoldBody>
      </Fold>
    </p>
  </div>
)
