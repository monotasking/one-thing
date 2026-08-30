import { Radio, RadioGroup } from '@onething/desktop-react'

// Radio 只能活在 RadioGroup 里(没有 context 会直接抛),所以这里渲染的是完整组合。
// 选中态板上写得很死:「用环不用点」—— accent 边把中心挤成白芯,不是塞一个圆点。

export const Selected = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <RadioGroup value="claude-fable-5" onChange={() => {}} label="Model">
      <Radio value="claude-fable-5">claude-fable-5</Radio>
      <Radio value="deepseek-chat">deepseek-chat</Radio>
      <Radio value="gpt-5.5">gpt-5.5</Radio>
    </RadioGroup>
  </div>
)

export const DisabledLeaf = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <RadioGroup value="cozy" onChange={() => {}} label="Density">
      <Radio value="cozy">Cozy</Radio>
      <Radio value="compact" disabled>
        Compact
      </Radio>
    </RadioGroup>
  </div>
)
