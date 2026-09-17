import { SecretInput } from '@onething/desktop-react'

// 密钥输入框 = ui/Input 的密码形 + 一颗切明暗的眼睛钮(走 Input 的 action 槽,
// 所以它在无障碍树里是有名字的钮,不是 aria-hidden 的装饰)。
// `revealLabel` / `hideLabel` 是必填文案:那颗钮的名字随明暗两态换,走 i18n。
// 挂载时 `revealed` 恒为 false —— 一格刚长出来的密钥框不该是明文的,
// 所以静态截图里永远是圆点 + 「睁眼」图标。
const row = {
  display: 'grid',
  gridTemplateColumns: 'max-content max-content',
  alignItems: 'center',
  gap: 'var(--sp-3)',
} as const
const label = {
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-2)',
} as const
const stack = { display: 'grid', gap: 'var(--sp-3)' } as const
const hint = {
  font: 'var(--fs-meta) var(--font-ui)',
  color: 'var(--text-3)',
} as const

// 凭证池「改密钥」那一格的真用法:左文字右控件,名字给 aria-label。
export const ApiKeyField = () => (
  <div style={stack}>
    <div style={row}>
      <span style={label}>API key</span>
      <SecretInput
        aria-label="DeepSeek API key"
        value="sk-live-4f8a29c1d7b3"
        onValueChange={() => {}}
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
    <span style={hint}>密钥是粘贴进来的,「让我核对一眼」是这一格唯一的纠错手段。</span>
  </div>
)

// 空值走 placeholder(与 ui/Input 逐字相同);有值时圆点数 = 字符数。
export const EmptyAndFilled = () => (
  <div style={stack}>
    <div style={row}>
      <span style={label}>New key</span>
      <SecretInput
        aria-label="New provider key"
        value=""
        onValueChange={() => {}}
        placeholder="sk-…"
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
    <div style={row}>
      <span style={label}>Current</span>
      <SecretInput
        aria-label="Current provider key"
        value="sk-ant-api03-9Qz7"
        onValueChange={() => {}}
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
  </div>
)

// 三档高度与按钮族共用 token,并排时基线一致(眼睛钮恒是 IconButton size="xs")。
export const Sizes = () => (
  <div style={stack}>
    <div style={row}>
      <span style={label}>sm</span>
      <SecretInput
        aria-label="Key sm"
        size="sm"
        value="sk-live-4f8a29c1"
        onValueChange={() => {}}
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
    <div style={row}>
      <span style={label}>md</span>
      <SecretInput
        aria-label="Key md"
        size="md"
        value="sk-live-4f8a29c1"
        onValueChange={() => {}}
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
    <div style={row}>
      <span style={label}>lg</span>
      <SecretInput
        aria-label="Key lg"
        size="lg"
        value="sk-live-4f8a29c1"
        onValueChange={() => {}}
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
  </div>
)

// invalid 只换边色;disabled 时眼睛钮跟着一起禁 ——
// 一格禁掉的密码框还能被看一眼是说不通的。
export const InvalidAndDisabled = () => (
  <div style={stack}>
    <div style={row}>
      <span style={label}>Invalid</span>
      <SecretInput
        aria-label="Malformed key"
        value="sk-"
        onValueChange={() => {}}
        invalid
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
    <div style={row}>
      <span style={label}>Disabled</span>
      <SecretInput
        aria-label="Key managed by the workspace"
        value="sk-live-4f8a29c1d7b3"
        onValueChange={() => {}}
        disabled
        revealLabel="Show the key"
        hideLabel="Hide the key"
      />
    </div>
  </div>
)
