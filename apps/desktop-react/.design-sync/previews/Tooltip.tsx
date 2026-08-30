import { Button, Tooltip } from '@onething/desktop-react'

// hover / focus 才出现(默认延迟 = --dur-tooltip-delay),鼠标一走就直接消失 ——
// 所以静态截图里看到的只有锚点,浮层本身(反色墨底 r-1、锚点上方居中、顶不下时翻下方)
// 是 portal 到 body 的,截不到。这里画一条真实工具条:每个控件各带一句提示。
export const AnchoredControls = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <Tooltip content="⌘K opens quick search">
      <Button>Quick search</Button>
    </Tooltip>
    <Tooltip content="Pin this panel to the right edge">
      <Button>Pin panel</Button>
    </Tooltip>
    <Tooltip content="Re-run the last tool call">
      <Button variant="primary">Re-run</Button>
    </Tooltip>
  </div>
)
