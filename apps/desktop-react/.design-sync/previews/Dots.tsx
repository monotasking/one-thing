import { Dots } from '@onething/desktop-react'

// 三颗点说的是一句很窄的话:**在流了,只是第一个字还没到**。没有进度、不带颜色语义
// ——走 currentColor,跟着落点的字色。单渲一颗点看不出话,所以每格都摆进真语境行里。
const col = { display: 'grid', gap: 'var(--sp-3)', font: 'var(--fs-body) var(--font-ui)' } as const
const row = { display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' } as const
const who = { color: 'var(--text-1)', fontSize: 'var(--fs-label)', fontWeight: 600 } as const
const body = { color: 'var(--text-3)', fontSize: 'var(--fs-body)' } as const
const meta = { color: 'var(--text-4)', fontSize: 'var(--fs-meta)', marginLeft: 'auto' } as const

// 消费点一:助手回复的槽位已经开出来了,第一个 delta 还没到 —— 最淡的一档墨。
export const AwaitingFirstDelta = () => (
  <div style={col}>
    <div style={{ ...row, alignItems: 'flex-start' }}>
      <span style={who}>You</span>
      <span style={{ ...body, color: 'var(--text-1)' }}>把检索面的分页改成同一把键累加</span>
    </div>
    <div style={row}>
      <span style={who}>Claude</span>
      <span style={body}><Dots /></span>
      <span style={meta}>claude-opus-5</span>
    </div>
    <div style={row}>
      <span style={who}>Codex</span>
      <span style={body}><Dots /></span>
      <span style={meta}>gpt-5.5</span>
    </div>
    <div style={row}>
      <span style={who}>DeepSeek</span>
      <span style={{ ...body, color: 'var(--text-1)' }}>先读 search/filters.ts 再动手。</span>
      <span style={meta}>12:41</span>
    </div>
  </div>
)

// 消费点二:跟随丸的「生成中」那张脸 —— 点跟着钮的字色走,不是自己挑一个颜色。
const pill = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  height: 28,
  padding: '0 var(--sp-3)',
  borderRadius: 'var(--r-full)',
  border: '1px solid var(--line-2)',
  background: 'var(--surface-2)',
  color: 'var(--text-2)',
  font: 'var(--fs-micro) var(--font-ui)',
} as const

export const InFollowPill = () => (
  <div style={{ ...col, gap: 'var(--sp-2)', justifyItems: 'start' }}>
    <span style={pill}>Generating <Dots /></span>
    <span style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)' }}>
      Running bash <Dots />
    </span>
    <span style={{ ...pill, color: 'var(--text-4)' }}>Queued <Dots /></span>
  </div>
)

// 缺省是装饰(aria-hidden)。只有当这三颗点是**唯一**的信息载体时才给 label
// —— 它于是变成 role="img" + 名字;外面那格已经在说同一句话时给它就是念两遍。
export const LabelledWhenAlone = () => (
  <div style={{ ...col, gap: 'var(--sp-4)' }}>
    <div style={{ ...row, color: 'var(--text-2)' }}>
      <Dots label="Streaming the reply" />
      <span style={{ ...body, fontSize: 'var(--fs-meta)' }}>role=img + aria-label</span>
    </div>
    <div style={{ ...row, color: 'var(--text-4)' }}>
      <Dots label="Indexing sessions" />
      <span style={{ ...body, fontSize: 'var(--fs-meta)' }}>同一件,只换落点的字色</span>
    </div>
  </div>
)
