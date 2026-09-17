import { Splitter } from '@onething/desktop-react'

// 两块面之间那条可拖的界(role=separator,照 APG 的 window splitter 写)。
// 它自己 `align-self: stretch` + 一条 1px 的线 + 一块比线宽的抓手,
// 所以**必须**放进一格有高度的 flex 容器、两侧各有一块真的面才看得见。
// `containerRef` 是量比例用的那块地(杆自己不知道自己有多宽);静态预览里
// 不发生拖拽,所以给一格空 ref 就够,值由 `value` 说了算。
const frame = {
  display: 'flex',
  height: 132,
  width: 420,
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-2)',
  overflow: 'hidden',
} as const
const frameColumn = { ...frame, flexDirection: 'column', height: 200 } as const
const pane = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--surface-1)',
  font: 'var(--fs-meta) var(--font-ui)',
  color: 'var(--text-3)',
} as const
const paneAlt = { ...pane, background: 'var(--surface-2)', color: 'var(--text-2)' } as const
const stack = { display: 'grid', gap: 'var(--sp-3)' } as const
const caption = { font: 'var(--fs-meta) var(--font-ui)', color: 'var(--text-3)' } as const

// 竖杆 = 左右分栏(文件面那条):value 是**前一栏**占的百分比。
export const VerticalBetweenPanes = () => (
  <div style={stack}>
    <div style={frame}>
      <div style={{ ...pane, width: '38%' }} id="preview-split-tree">
        File tree
      </div>
      <Splitter
        containerRef={{ current: null }}
        value={38}
        defaultValue={45}
        label="Resize the file tree"
        controls="preview-split-tree"
        onCommit={() => {}}
      />
      <div style={{ ...paneAlt, flex: 1 }}>Viewer</div>
    </div>
    <span style={caption}>拖 / ←→ 走 5% 一格 / Home · End 到两头 / ↵ 与双击回默认 45%</span>
  </div>
)

// 主变体轴 = 方向。横杆 = 上下分栏,键盘换成 ↑/↓,容器要 column。
export const HorizontalBetweenPanes = () => (
  <div style={stack}>
    <div style={frameColumn}>
      <div style={{ ...pane, height: '55%' }} id="preview-split-editor">
        Editor
      </div>
      <Splitter
        containerRef={{ current: null }}
        orientation="horizontal"
        value={55}
        defaultValue={60}
        label="Resize the editor"
        controls="preview-split-editor"
        onCommit={() => {}}
      />
      <div style={{ ...paneAlt, flex: 1 }}>Terminal</div>
    </div>
    <span style={caption}>横杆报 aria-orientation=&quot;horizontal&quot;,↑/↓ 调、光标是 row-resize</span>
  </div>
)

// 同一条杆在两个比例上:线永远在(分栏本来就该有一道界),
// 位置就是那格活值,拖拽期间由 JS 直接写容器上的 CSS 变量,零 React 重渲。
export const RatioRange = () => (
  <div style={stack}>
    <div style={{ ...frame, height: 72 }}>
      <div style={{ ...pane, width: '18%' }} id="preview-split-narrow">
        18%
      </div>
      <Splitter
        containerRef={{ current: null }}
        value={18}
        min={15}
        max={85}
        label="Resize the left pane (narrow)"
        controls="preview-split-narrow"
        onCommit={() => {}}
      />
      <div style={{ ...paneAlt, flex: 1 }}>Sessions</div>
    </div>
    <div style={{ ...frame, height: 72 }}>
      <div style={{ ...pane, width: '72%' }} id="preview-split-wide">
        72%
      </div>
      <Splitter
        containerRef={{ current: null }}
        value={72}
        min={15}
        max={85}
        label="Resize the left pane (wide)"
        controls="preview-split-wide"
        onCommit={() => {}}
      />
      <div style={{ ...paneAlt, flex: 1 }}>Detail</div>
    </div>
  </div>
)
