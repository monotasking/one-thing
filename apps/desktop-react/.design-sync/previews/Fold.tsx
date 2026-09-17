import { Fold, FoldBody, FoldFoot, FoldTrigger } from '@onething/desktop-react'

// 折叠基座:只管行为与 a11y(role=button / aria-expanded / ↵ / Space),一个像素都不画。
// 皮肤整份归消费方 —— 下面的行样式就是「消费方皮肤」的一个样例。
const head = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-1) var(--sp-2)',
  borderRadius: 'var(--r-1)',
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-2)',
  cursor: 'pointer',
  userSelect: 'none',
} as const
const body = {
  padding: 'var(--sp-2) var(--sp-3)',
  marginLeft: 'var(--sp-2)',
  borderLeft: '2px solid var(--line-1)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
  lineHeight: 1.6,
} as const
const foot = { ...head, color: 'var(--text-3)', fontSize: 'var(--fs-meta)' } as const
const box = { width: 360, display: 'grid', gap: 'var(--sp-1)' } as const

// 给了 FoldBody = 关起来就看不见(hidden 属性,不卸载)。
export const OpenWithBody = () => (
  <div style={box}>
    <Fold defaultOpen>
      <FoldTrigger style={head}>
        <span aria-hidden>▾</span> Thought for 4s
      </FoldTrigger>
      <FoldBody style={body}>
        The user wants the traffic-light center as the alignment line, not the box edge.
        Compute the icon column so its center lands on x=22, then derive the text start from it.
      </FoldBody>
      <FoldFoot style={foot}>
        <span aria-hidden>▴</span> Collapse
      </FoldFoot>
    </Fold>
  </div>
)

export const Closed = () => (
  <div style={box}>
    <Fold>
      <FoldTrigger style={head}>
        <span aria-hidden>▸</span> Context update · 3 blocks
      </FoldTrigger>
      <FoldBody style={body}>datetime · workdir · skills</FoldBody>
    </Fold>
  </div>
)

// 不给 FoldBody = 整块就是开关、正文两态都在(思考段:收起是钳成一行,展开是原位继续读)。
export const TriggerOnly = () => (
  <div style={box}>
    <Fold>
      <FoldTrigger
        style={{ ...body, borderLeft: 'none', color: 'var(--text-3)', cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
      >
        Considering whether the sidebar row icon should align by center or by left edge; the user's screenshot draws the line through the traffic light…
      </FoldTrigger>
    </Fold>
  </div>
)
