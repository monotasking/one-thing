import { Reveal, IconButton } from '@onething/desktop-react'

// 幽灵现身槽:休止态看不见、鼠标或键盘落到这一行上才现出来,而**位置在休止态就占着**
// ——浮现那一刻旁边的东西一个像素都不许动。判据挂在作用域上(data-reveal-scope),
// 不是挂在这一格自己身上;:focus-within 与 hover 同权。
const Pencil = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)
const Dots3 = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...p}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </svg>
)

const list = {
  display: 'grid',
  width: 320,
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
  height: 30,
  padding: '0 var(--sp-2)',
  borderRadius: 'var(--r-1)',
  color: 'var(--text-1)',
  minWidth: 0,
} as const

const key = { font: 'var(--fs-meta) var(--font-mono)', color: 'var(--text-3)', marginLeft: 'auto' } as const
const SCOPE = { 'data-reveal-scope': '' } as const

// 休止态(静态截图能渲的就是这一态):铅笔在位置上占着但透明,⋯ 常驻。
// 浮现的时候 ⋯ 的 x 必须一字不动 —— 那正是「占位常驻,只动 opacity」要的。
export const RestingRows = () => (
  <div style={list}>
    <div style={row} {...SCOPE}>
      <span>Anthropic</span>
      <span style={key}>sk-ant-…4f21</span>
      <Reveal><IconButton size="sm" icon={Pencil} label="Rename this credential" /></Reveal>
      <IconButton size="sm" icon={Dots3} label="More actions" />
    </div>
    <div style={row} {...SCOPE}>
      <span>OpenAI</span>
      <span style={key}>sk-proj-…9ac0</span>
      <Reveal><IconButton size="sm" icon={Pencil} label="Rename this credential" /></Reveal>
      <IconButton size="sm" icon={Dots3} label="More actions" />
    </div>
    <div style={row} {...SCOPE}>
      <span>DeepSeek</span>
      <span style={key}>sk-…1d7e</span>
      <Reveal><IconButton size="sm" icon={Pencil} label="Rename this credential" /></Reveal>
      <IconButton size="sm" icon={Dots3} label="More actions" />
    </div>
  </div>
)

// 塞进来的可以是任何东西(开放集合走 children):一整组动作、或一颗禁掉的钮 ——
// 禁用不归它,一颗禁掉的钮照样占着这个位置,这正是「位置预留」要的。
// 现身态(hover / focus-within)静态截图渲不出来:指针与焦点都不在场,这里画的仍是休止态,
// 判据写在 Reveal 自己的样式里,预览不替它伪造。
export const GroupAndDisabled = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-2)' }}>
    <div style={{ ...list, width: 340 }}>
      <div style={row} {...SCOPE}>
        <span style={{ flex: 1, minWidth: 0 }}>docs/search-panel-2026-09.md</span>
        <Reveal>
          <span style={{ display: 'inline-flex', gap: 'var(--sp-1)' }}>
            <IconButton size="sm" icon={Pencil} label="Rename" />
            <IconButton size="sm" icon={Dots3} label="More actions" />
          </span>
        </Reveal>
      </div>
      <div style={row} {...SCOPE}>
        <span style={{ flex: 1, minWidth: 0, color: 'var(--text-3)' }}>docs/dock-scope-2026-09.md</span>
        <Reveal>
          <IconButton size="sm" icon={Pencil} label="Rename" disabled />
        </Reveal>
      </div>
    </div>
    <div style={{ font: 'var(--fs-meta) var(--font-ui)', color: 'var(--text-3)' }}>
      行尾的动作组在休止态透明但占位;指针或键盘落到这一行上才现身,旁边的东西一个像素不动。
    </div>
  </div>
)
