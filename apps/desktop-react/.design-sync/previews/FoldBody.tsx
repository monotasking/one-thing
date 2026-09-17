import { Fold, FoldBody, FoldTrigger } from '@onething/desktop-react'

// FoldBody 必须放在 <Fold> 里。关闭态 hidden + 内联 display:none,不卸载(里面的东西一直在场)。
const head = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-1) var(--sp-2)',
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-2)',
  cursor: 'pointer',
} as const
const list = {
  margin: 0,
  padding: 'var(--sp-1) 0 var(--sp-1) var(--sp-5)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
  lineHeight: 1.6,
} as const

export const OpenAsList = () => (
  <div style={{ width: 360 }}>
    <Fold defaultOpen>
      <FoldTrigger style={head}>
        <span aria-hidden>▾</span> Context update · 3 blocks
      </FoldTrigger>
      <FoldBody as="ul" style={list}>
        <li>datetime — 2026-09-16 16:48 (Asia/Shanghai)</li>
        <li>workdir — ~/data/code/start-electron</li>
        <li>skills — onething-ui-style, design-sync</li>
      </FoldBody>
    </Fold>
  </div>
)

export const ClosedKeepsMounted = () => (
  <div style={{ width: 360 }}>
    <Fold>
      <FoldTrigger style={head}>
        <span aria-hidden>▸</span> Context update · 3 blocks
      </FoldTrigger>
      <FoldBody as="ul" style={list}>
        <li>datetime</li>
        <li>workdir</li>
        <li>skills</li>
      </FoldBody>
    </Fold>
  </div>
)
