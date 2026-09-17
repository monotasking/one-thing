import { GroupHead } from '@onething/desktop-react'

// 列表分组头。两形一件,判据是「给不给 onToggle」:
// 不给 → 静态组头(一个 <div>,不进 Tab 序);给了 → 可折叠组头(▾▸ + aria-expanded)。
// note 是**右侧弱色文字读数**,不是计数徽 —— 本仓禁令:tab / 列表 / 组头不挂计数徽。
const panel = {
  width: 300,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 2,
  padding: 'var(--sp-2) 0',
  borderRadius: 'var(--r-2)',
  border: 'var(--bw-1) solid var(--line-1)',
  background: 'var(--surface-1)',
  font: 'var(--fs-body) var(--font-ui)',
  color: 'var(--text-1)',
} as const

const row = {
  padding: 'var(--sp-1) var(--sp-3) var(--sp-1) var(--sp-5)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--text-2)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const

const Row = ({ children }: any) => <div style={row}>{children}</div>

// 同一条列表里两形交替出现 —— 这正是它们合成一件的理由。
export const ModelList = () => (
  <div style={panel}>
    <GroupHead label="SELECTED" />
    <Row>anthropic/claude-opus-5</Row>
    <Row>deepseek/deepseek-chat</Row>
    <GroupHead label="anthropic/" note="12 models" collapsed={false} onToggle={() => {}} />
    <Row>claude-opus-5</Row>
    <Row>claude-sonnet-4-5</Row>
    <Row>claude-haiku-4-5</Row>
    <GroupHead label="openai/" note="9 models" collapsed onToggle={() => {}} />
    <GroupHead label="google/" note="6 models" collapsed onToggle={() => {}} />
  </div>
)

// 四形并排:静态 / 展开 / 收起 / 禁用。
// 禁用**不淡化**,只换指针 —— 组名照旧看得见(检索时组由判据打开,那一刻点它不该关上)。
export const States = () => (
  <div style={panel}>
    <GroupHead label="CLOUD" />
    <GroupHead label="anthropic/" note="12 models" collapsed={false} onToggle={() => {}} />
    <GroupHead label="openai/" note="9 models" collapsed onToggle={() => {}} />
    <GroupHead label="ollama/" note="filtered open while searching" collapsed={false} disabled onToggle={() => {}} />
  </div>
)

// 挤压纪律:结构行只截断不换行。组名先让,读数吃掉剩下的宽度再自己截断。
export const Truncation = () => (
  <div style={{ ...panel, width: 220 }}>
    <GroupHead label="LOCAL PROVIDERS" />
    <GroupHead
      label="openrouter/anthropic-passthrough/"
      note="catalog refreshed 3 minutes ago"
      collapsed={false}
      onToggle={() => {}}
    />
    <GroupHead label="lmstudio/" note="2 models" collapsed onToggle={() => {}} />
  </div>
)
