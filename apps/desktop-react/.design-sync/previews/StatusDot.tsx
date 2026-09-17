import { StatusDot } from '@onething/desktop-react'

// 规范:状态色只上点,永不换底、不上文字 —— 点旁边的文字是调用方的,颜色不跟着变。
// 六档 tone 各一条配方;旁边已有文字时不给 label(装饰,aria-hidden)。
const row = { display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', font: 'var(--fs-body) var(--font-ui)', color: 'var(--text-1)' } as const
const list = { display: 'grid', gap: 'var(--sp-2)' } as const
const meta = { color: 'var(--text-3)', fontSize: 'var(--fs-meta)' } as const

export const Tones = () => (
  <div style={list}>
    <div style={row}><StatusDot tone="ok" /> Anthropic <span style={meta}>connected</span></div>
    <div style={row}><StatusDot tone="info" /> OpenAI <span style={meta}>catalog refreshed 3m ago</span></div>
    <div style={row}><StatusDot tone="warn" /> DeepSeek <span style={meta}>rate limited, retrying</span></div>
    <div style={row}><StatusDot tone="bad" /> Gemini <span style={meta}>auth failed</span></div>
    <div style={row}><StatusDot tone="idle" /> Kimi <span style={meta}>not configured</span></div>
    <div style={row}><StatusDot tone="off" /> Ollama <span style={meta}>disabled</span></div>
  </div>
)

// md 6px 是缺省(列表 / 详情栏);sm 5px 给檐上贴着标题的那一颗。
export const Sizes = () => (
  <div style={{ ...row, gap: 'var(--sp-4)' }}>
    <span style={row}><StatusDot tone="warn" size="md" /> md (default)</span>
    <span style={row}><StatusDot tone="warn" size="sm" /> sm</span>
  </div>
)

// 点是唯一信息载体时才给 label:role=img + aria-label,读屏软件念它。
export const LabelOnly = () => (
  <div style={{ ...row, gap: 'var(--sp-4)' }}>
    <StatusDot tone="bad" label="Auth failed" />
    <StatusDot tone="ok" label="Connected" />
    <StatusDot tone="warn" label="Unsaved changes" size="sm" />
  </div>
)
