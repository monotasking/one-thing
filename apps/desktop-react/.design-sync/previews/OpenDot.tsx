import { OpenDot } from '@onething/desktop-react'

// 行尾那颗「这一份此刻开着没有」的点。三态:实心 = 开着并显示(纯装饰的 span)/
// 空心 = 开着但藏起来(可点,把它请回来)/ null = 不画。单渲一颗点看不出话,
// 所以每格都摆进真正的行里 —— 它只在**行尾**出现,与选中态是两件事。
const list = {
  display: 'grid',
  width: 260,
  border: '1px solid var(--line-1)',
  borderRadius: 'var(--r-2)',
  background: 'var(--surface-1)',
  padding: 'var(--sp-1)',
  font: 'var(--fs-label) var(--font-ui)',
} as const

const row = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  height: 26,
  padding: '0 var(--sp-2)',
  borderRadius: 'var(--r-1)',
  color: 'var(--text-1)',
  minWidth: 0,
} as const

const selected = { ...row, background: 'var(--st-sel)' } as const
const name = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const
const tail = { marginLeft: 'auto', display: 'flex', alignItems: 'center' } as const

// 目录树:开着并显示 / 开着但藏起来 / 没开,同一列里三态并排看得出差别。
export const FileRows = () => (
  <div style={list}>
    <div style={row}>
      <span style={name}>Composer.tsx</span>
      <span style={tail}><OpenDot state="shown" label="Opened" /></span>
    </div>
    <div style={selected}>
      <span style={name}>ChatStream.tsx</span>
      <span style={tail}><OpenDot state="hidden" label="Opened but hidden — click to bring it back" /></span>
    </div>
    <div style={row}>
      <span style={name}>tail-snap.ts</span>
      <span style={tail}><OpenDot state={null} label="Not open" /></span>
    </div>
    <div style={row}>
      <span style={name}>FilterChip.module.css</span>
      <span style={tail}><OpenDot state="shown" label="Opened" /></span>
    </div>
    <div style={row}>
      <span style={{ ...name, color: 'var(--text-3)' }}>useRowWindow.ts</span>
      <span style={tail}><OpenDot state={null} label="Not open" /></span>
    </div>
  </div>
)

// 同一句话的第二个消费面:会话行。判据是同一个纯函数,这只件只负责画。
const meta = { marginLeft: 'auto', color: 'var(--text-4)', fontSize: 'var(--fs-meta)' } as const

export const SessionRows = () => (
  <div style={{ ...list, width: 300 }}>
    <div style={selected}>
      <span style={name}>检索面分页四条不变量</span>
      <span style={meta}>12:41</span>
      <span style={{ display: 'flex', alignItems: 'center', marginLeft: 'var(--sp-2)' }}>
        <OpenDot state="shown" label="Opened" />
      </span>
    </div>
    <div style={row}>
      <span style={name}>Dock 让位量跟着大小档走</span>
      <span style={meta}>Tue</span>
      <span style={{ display: 'flex', alignItems: 'center', marginLeft: 'var(--sp-2)' }}>
        <OpenDot state="hidden" label="Opened but hidden — click to bring it back" />
      </span>
    </div>
    <div style={row}>
      <span style={name}>终端喷流期间零长帧</span>
      <span style={meta}>Mon</span>
      <span style={{ display: 'flex', alignItems: 'center', marginLeft: 'var(--sp-2)' }}>
        <OpenDot state={null} label="Not open" />
      </span>
    </div>
  </div>
)

// 三态并排:实心 / 空心 / 不画。空心那一档是真钮(焦点环走全局),实心那一档
// 是纯装饰 —— 「显示中的东西再点一下」没有语义。
const legend = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  color: 'var(--text-2)',
  font: 'var(--fs-meta) var(--font-ui)',
} as const

export const ThreeStates = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
    <div style={legend}><OpenDot state="shown" label="Opened" /> shown — 开着并显示</div>
    <div style={legend}><OpenDot state="hidden" label="Opened but hidden" /> hidden — 开着但藏起来(可点)</div>
    <div style={legend}>
      <span style={{ width: 5, height: 5 }}><OpenDot state={null} label="Not open" /></span>
      null — 没开,一个像素都不画
    </div>
  </div>
)
