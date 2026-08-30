import { Badge } from '@onething/desktop-react'

// 三个 tone 各是一条完整配方(不是「基础样式 + 换底色」):
// danger = Dock 未读计数、ok = 完成打勾、unread = 会话卡未读丸。

export const Tones = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Badge tone="danger">3</Badge>
    <Badge tone="ok">✓</Badge>
    <Badge tone="unread">12</Badge>
  </div>
)

// 位宽:一位数是正圆,两位以上撑成丸 —— 徽自己不裁,由内容决定。
export const Widths = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Badge tone="danger">1</Badge>
    <Badge tone="danger">9</Badge>
    <Badge tone="unread">99</Badge>
    <Badge tone="unread">99+</Badge>
  </div>
)

// 真实落点:徽跟在一行文字后面(定位归调用方,徽只管自己是一颗丸)。
export const InContext = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
      React 壳架子
      <Badge tone="unread">4</Badge>
    </span>
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
      Build failed
      <Badge tone="danger">2</Badge>
    </span>
  </div>
)
