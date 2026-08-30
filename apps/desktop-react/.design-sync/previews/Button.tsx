import { Button, Spinner } from '@onething/desktop-react'

// 规范:primary 实底一屏只该有一个;ghost 描边是其余全部。sm 28 / md 32。
export const Variants = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Button>Cancel</Button>
    <Button variant="primary">Save changes</Button>
  </div>
)

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Button size="sm">Rename</Button>
    <Button size="md">Rename</Button>
    <Button variant="primary" size="sm">Send</Button>
    <Button variant="primary" size="md">Send</Button>
  </div>
)

export const PillAndIcon = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Button pill variant="primary">＋ Project</Button>
    <Button pill>Enter ↵</Button>
    <Button iconOnly aria-label="Add">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </Button>
  </div>
)

export const States = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Button disabled>Disabled</Button>
    <Button variant="primary" disabled>Disabled</Button>
    <Button variant="primary" size="md"><Spinner /> Publishing…</Button>
  </div>
)
