import { Button, Spinner } from '@onething/desktop-react'

// 控件级 loading:700ms linear 的小圆环。sm 13 / md 16 两档,没有第三档;
// 区域级等待用骨架,整屏转圈不在系统里。prefers-reduced-motion 下降为静止半透明整环。
export const Sizes = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
    <Spinner size="sm" />
    <Spinner size="md" />
  </div>
)

// 它的正当去处之一:按钮的 loading 位(与文字同行,不改按钮尺寸)。
export const InAButton = () => (
  <Button variant="primary" size="md">
    <Spinner label="Indexing" /> Indexing 1,204 files
  </Button>
)
