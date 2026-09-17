import { InlineEditStrip, Input } from '@onething/desktop-react'

// 行内输入条:[前缀?][控件槽 grow][主钮][取消] 一行排完 —— 某一行里此刻临时长出来的一条。
// 手势(↵ / Esc / 进来选中全文)不在这件里,它管的是**形**;这件一个 hook 都没有。
const listRow = {
  maxWidth: 620,
  display: 'grid',
  gap: 'var(--sp-1)',
  padding: 'var(--sp-2) var(--sp-3)',
  borderRadius: 'var(--r-2)',
  border: 'var(--bw-1) solid var(--line-1)',
  background: 'var(--surface-2)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
} as const

const caption = { fontSize: 'var(--fs-nano)', color: 'var(--text-3)' } as const
const old = { fontSize: 'var(--fs-meta)', color: 'var(--text-2)', font: 'var(--fs-meta) var(--font-mono)' } as const

// 改密钥那一形:左端是旧尾号,中间是控件槽(唯一的弯腰件),右端两颗钮。
export const EditKey = () => (
  <div style={listRow}>
    <span style={caption}>Default key</span>
    <InlineEditStrip
      prefix={<span style={old}>sk-f44••••a477 →</span>}
      saveLabel="Save"
      savingLabel="Saving…"
      cancelLabel="Cancel"
      onCommit={() => {}}
      onCancel={() => {}}
    >
      <Input aria-label="New key" value="sk-live-9f2c7a10b4" onValueChange={() => {}} size="sm" />
    </InlineEditStrip>
  </div>
)

// 空值:主钮禁点,取消恒可点 —— canSave 只管主钮。
export const CannotSave = () => (
  <div style={listRow}>
    <span style={caption}>Default key</span>
    <InlineEditStrip
      prefix={<span style={old}>sk-f44••••a477 →</span>}
      saveLabel="Save"
      savingLabel="Saving…"
      cancelLabel="Cancel"
      canSave={false}
      onCommit={() => {}}
      onCancel={() => {}}
    >
      <Input aria-label="New key" value="" onValueChange={() => {}} size="sm" placeholder="sk-…" />
    </InlineEditStrip>
  </div>
)

// 删除确认也是它:同一个槽位,差别只有两格 —— 前缀装一句后果,主钮 danger,控件槽空着。
// 那一格空着时前缀自己接管整条宽度并换行(.noControl)。
export const DeleteConfirm = () => (
  <div style={listRow}>
    <span style={caption}>sk-f44••••a477</span>
    <InlineEditStrip
      prefix={<span>Delete this key? Usage already attributed to it stays in the ledger.</span>}
      tone="danger"
      saveLabel="Delete"
      savingLabel="Deleting…"
      cancelLabel="Cancel"
      onCommit={() => {}}
      onCancel={() => {}}
    />
  </div>
)

// 忙态:整条禁灰,主钮换 savingLabel + aria-busy + 一枚 Spinner(按钮内是 Spinner 仅有的合法位之一),
// 取消一并禁 —— 一次写已经发出去了,「取消」取消不掉它。
export const Busy = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
    <div style={listRow}>
      <span style={caption}>Default key</span>
      <InlineEditStrip
        prefix={<span style={old}>sk-f44••••a477 →</span>}
        saveLabel="Save"
        savingLabel="Saving…"
        cancelLabel="Cancel"
        busy
        onCommit={() => {}}
        onCancel={() => {}}
      >
        <Input aria-label="New key" value="sk-live-9f2c7a10b4" onValueChange={() => {}} size="sm" disabled />
      </InlineEditStrip>
    </div>
    <div style={listRow}>
      <span style={caption}>sk-f44••••a477</span>
      <InlineEditStrip
        prefix={<span>Delete this key? Usage already attributed to it stays in the ledger.</span>}
        tone="danger"
        saveLabel="Delete"
        savingLabel="Deleting…"
        cancelLabel="Cancel"
        busy
        onCommit={() => {}}
        onCancel={() => {}}
      />
    </div>
  </div>
)
