import { Button, Card, IconButton, StatusDot } from '@onething/desktop-react'

// 区块卡骨架:一行标题 + 一格弱色注 + 檐右一撮动作,卡身是开放的 children。
// 卡不是控件 —— 没有 hover / focus / disabled,动作都是消费方塞进来的库件。
const Refresh = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...p}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)
const Pencil = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)
const Close = (p: any) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

const stack = { display: 'grid', gap: 'var(--sp-3)', maxWidth: 520, font: 'var(--fs-body) var(--font-ui)', color: 'var(--text-1)' } as const
const body = { fontSize: 'var(--fs-micro)', color: 'var(--text-2)', lineHeight: 1.6 } as const
const readRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--fs-meta)', color: 'var(--text-2)' } as const
const readValue = { color: 'var(--text-1)', font: 'var(--fs-meta) var(--font-mono)' } as const

// 典型用法:详情栏里的一张读数卡 —— 标题 / 读数 / 刷新钮 / 卡身几行数字。
export const UsageCard = () => (
  <div style={stack}>
    <Card title="Usage" note="cached 3m ago" actions={<Button size="sm">Refresh</Button>}>
      <div style={readRow}>
        <span>Input tokens</span>
        <span style={readValue}>1,284,910</span>
      </div>
      <div style={readRow}>
        <span>Output tokens</span>
        <span style={readValue}>318,442</span>
      </div>
      <div style={readRow}>
        <span>Spend this month</span>
        <span style={readValue}>$42.17</span>
      </div>
    </Card>
  </div>
)

// 檐的在场判据是三格的并:三格全缺 → 整条檐一个 DOM 都不渲染;任一格在场,檐就在。
export const HeadSlots = () => (
  <div style={stack}>
    <Card>
      <span style={body}>Body only — no head row is rendered at all.</span>
    </Card>
    <Card title="Anthropic">
      <span style={body}>Title only — the note and actions slots stay empty.</span>
    </Card>
    <Card title="Anthropic" note="connected">
      <span style={body}>Title + inline note.</span>
    </Card>
    <Card actions={<IconButton icon={Close} label="Dismiss" size="xs" />}>
      <span style={body}>No title, no note — the head row still renders because actions are there.</span>
    </Card>
  </div>
)

// notePlacement 两档:inline 的注贴着标题走;below 的注掉到檐外自成一段。
// 动作两档下都在檐右 —— 它的落点由「它是动作」决定,不由注站在哪儿决定。
export const NotePlacement = () => (
  <div style={stack}>
    <Card
      title="Usage"
      note="cached 3m ago"
      actions={<IconButton icon={Refresh} label="Refresh usage" size="sm" />}
    >
      <span style={body}>inline — the note sits beside the title, actions stay at the far right.</span>
    </Card>
    <Card
      title="Mode"
      note="Subscription mode does not use an API key, so the credential pool below is read-only."
      notePlacement="below"
      actions={<IconButton icon={Pencil} label="Edit mode" size="sm" />}
    >
      <span style={body}>below — the note drops out of the head row, actions do not.</span>
    </Card>
  </div>
)

// pad md(--sp-3,详情栏五处的值)/ lg(--sp-4,错误卡那一档);bordered 缺省 true。
// titleAs 不写死 h3 —— 卡不知道自己挂在文档的第几层,跳级是读屏软件真会迷路的那类问题。
export const PaddingAndBorder = () => (
  <div style={stack}>
    <Card title="Credential pool" note="2 keys">
      <span style={body}>pad md (default) · bordered · h3</span>
    </Card>
    <Card title="Something went wrong" pad="lg" bordered={false} titleAs="h4">
      <span style={body}>pad lg · borderless · h4 — the shape the crash card uses.</span>
    </Card>
    <Card
      title="DeepSeek"
      note={<StatusDot tone="warn" label="Rate limited" />}
      actions={<Button size="sm">Retry</Button>}
    >
      <span style={body}>The note slot takes any node — here a status dot rather than a reading.</span>
    </Card>
  </div>
)
