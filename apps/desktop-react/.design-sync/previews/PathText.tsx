import { PathText } from '@onething/desktop-react'

// 纯展示件:一条绝对路径在 320px 的提示体里怎么读得出来。每个 / 后面一枚 <wbr>,
// 常态按目录段折行;home 给了就把家目录画成 ~(只缩画出来的那一份)。
const tip = {
  width: 320,
  padding: 'var(--sp-2) var(--sp-3)',
  background: 'var(--surface-2)',
  border: '1px solid var(--line-1)',
  borderRadius: 'var(--r-2)',
  font: 'var(--fs-meta) var(--font-mono)',
  color: 'var(--text-1)',
  lineHeight: 1.5,
} as const

const HOME = '/Users/yitiansong'

export const Inline = () => (
  <div style={tip}>
    <PathText path="/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/composer/components/Composer.tsx" home={HOME} />
  </div>
)

export const Stacked = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
    <div style={tip}>
      <PathText layout="stacked" path="/Users/yitiansong/data/code/start-electron/apps/desktop-react/src/composer/components/Composer.tsx" home={HOME} />
    </div>
    <div style={tip}>
      <PathText layout="stacked" dir path="/Users/yitiansong/data/code/start-electron/packages/backend/wiring/search/" home={HOME} />
    </div>
  </div>
)

// 不给 home = 全路径照画;单个超长文件名才落到任意字符处断的兜底。
export const NoHomeAndLongName = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
    <div style={tip}>
      <PathText path="/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js" />
    </div>
    <div style={tip}>
      <PathText layout="stacked" path="/Users/yitiansong/Desktop/Screenshot 2026-09-15 at 22.41.07 — sessions sidebar traffic-light alignment.png" home={HOME} />
    </div>
  </div>
)
