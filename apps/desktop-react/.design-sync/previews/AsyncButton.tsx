import { AsyncButton } from '@onething/desktop-react'

/*
 * 第 17 件:**会自己说「在办了」的按钮**。忙态是从 `action`(一件 AsyncSource)
 * **读来的**,不是调用方自己 useState 记的一份 —— 这正是它存在的理由。
 * 三态:idle → pending(立刻 disabled + aria-busy,150ms 之后才换字)→ settled。
 * 规格页接的是真 mutation;预览接两件静态的假 source,好把三态各自定格。
 */
const idle = { subscribe: () => () => undefined, isPending: () => false }
const busy = { subscribe: () => () => undefined, isPending: () => true }
// 律③「一次勾选不该把整表禁掉」:mutation 打在具体一行上,按 key 分格问忙。
const busyRow = {
  subscribe: () => () => undefined,
  isPending: (key?: string) => key === 'deepseek',
}

const row = { display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' } as const
const list = { display: 'grid', gap: 'var(--sp-3)', width: 320 } as const
const line = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--sp-3)',
  padding: 'var(--sp-2) var(--sp-3)',
  borderRadius: 'var(--r-2)',
  background: 'var(--surface-1)',
  border: 'var(--bw-1) solid var(--line-1)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
} as const

// idle:与 ui/Button 逐字同一副形 —— 没在办事时它就是一颗普通钮。
export const Idle = () => (
  <div style={row}>
    <AsyncButton action={idle} pendingLabel="Saving…" variant="primary">
      Save changes
    </AsyncButton>
    <AsyncButton action={idle} pendingLabel="Refreshing…">
      Refresh catalog
    </AsyncButton>
  </div>
)

// pending:disabled + aria-busy 立刻,文案换成 pendingLabel。宽度随文案变是有意的。
export const Pending = () => (
  <div style={row}>
    <AsyncButton action={busy} pendingLabel="Saving…" variant="primary">
      Save changes
    </AsyncButton>
    <AsyncButton action={busy} pendingLabel="Refreshing…">
      Refresh catalog
    </AsyncButton>
  </div>
)

// 忙态逐格:只有 deepseek 那一行在飞,另外两行照常可点。
export const PerRowPending = () => (
  <div style={list}>
    <div style={line}>
      <span>Anthropic</span>
      <AsyncButton action={busyRow} pendingKey="anthropic" pendingLabel="Testing…" size="sm">
        Test
      </AsyncButton>
    </div>
    <div style={line}>
      <span>DeepSeek</span>
      <AsyncButton action={busyRow} pendingKey="deepseek" pendingLabel="Testing…" size="sm">
        Test
      </AsyncButton>
    </div>
    <div style={line}>
      <span>Kimi</span>
      <AsyncButton action={busyRow} pendingKey="kimi" pendingLabel="Testing…" size="sm">
        Test
      </AsyncButton>
    </div>
  </div>
)

// 尺寸与丸形照 ui/Button 的两档;disabled 是调用方自己按不动,与忙态无关。
export const SizesAndDisabled = () => (
  <div style={row}>
    <AsyncButton action={idle} pendingLabel="Sending…" size="sm" pill variant="primary">
      Send
    </AsyncButton>
    <AsyncButton action={idle} pendingLabel="Sending…" size="md" pill>
      Send later
    </AsyncButton>
    <AsyncButton action={idle} pendingLabel="Saving…" disabled>
      Nothing to save
    </AsyncButton>
  </div>
)
