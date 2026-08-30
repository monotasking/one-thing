import { Radio, RadioGroup } from '@onething/desktop-react'

// RadioGroup 管一组的事(name / value / onChange / 无障碍名),Radio 只表达一颗。
// 单渲叶子不真实,所以两个文件都写成完整组合。

export const OpenBehaviour = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <RadioGroup value="stage" onChange={() => {}} label="Open behaviour">
      <Radio value="stage">Stage</Radio>
      <Radio value="pinned">Pinned right</Radio>
      <Radio value="floating">Floating window</Radio>
    </RadioGroup>
  </div>
)

// 单颗禁用:整组仍可用,只有那一行降透明。
export const WithDisabledOption = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <RadioGroup value="jsonl" onChange={() => {}} label="Session format">
      <Radio value="jsonl">Per-session JSONL</Radio>
      <Radio value="legacy">Legacy single JSON</Radio>
      <Radio value="sqlite" disabled>
        SQLite (unavailable)
      </Radio>
    </RadioGroup>
  </div>
)

// 整组禁用。
export const GroupDisabled = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <RadioGroup value="full" onChange={() => {}} label="Tool registry" disabled>
      <Radio value="full">Full</Radio>
      <Radio value="headless">Headless</Radio>
      <Radio value="readonly">Read-only</Radio>
    </RadioGroup>
  </div>
)
