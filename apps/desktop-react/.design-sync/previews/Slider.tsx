import { Slider } from '@onething/desktop-react'

// 「调一个数」那一件(role=slider,照 WAI-ARIA APG 写,不引库)。
// 它自己 `flex: 1`,所以永远住在一条有宽度的 flex 行里;`label` 是 aria-label
// (组件里不落字面),要给人看的文案自己排在旁边 —— 下面就是真用法的排法。
// 钮平时 scale(0),悬停 / 聚焦 / 拖拽中才长出来:静态截图里只看得到轨与 fill。
const row = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-3)',
  width: 344,
} as const
const name = {
  flex: 'none',
  width: 78,
  whiteSpace: 'nowrap',
  font: 'var(--fs-label) var(--font-ui)',
  color: 'var(--text-2)',
} as const
const readout = {
  flex: 'none',
  width: 56,
  textAlign: 'right',
  font: 'var(--fs-meta) var(--font-mono)',
  color: 'var(--text-3)',
} as const
const stack = { display: 'grid', gap: 'var(--sp-3)' } as const

// 主变体轴 = 那个数本身。四档扫过去,fill 的长度就是这条杆全部的读数。
export const ValueSteps = () => (
  <div style={stack}>
    <div style={row}>
      <span style={name}>0%</span>
      <Slider value={0} label="Volume" onCommit={() => {}} />
      <span style={readout}>0</span>
    </div>
    <div style={row}>
      <span style={name}>35%</span>
      <Slider value={35} label="Volume" onCommit={() => {}} />
      <span style={readout}>35</span>
    </div>
    <div style={row}>
      <span style={name}>70%</span>
      <Slider value={70} label="Volume" onCommit={() => {}} />
      <span style={readout}>70</span>
    </div>
    <div style={row}>
      <span style={name}>100%</span>
      <Slider value={100} label="Volume" onCommit={() => {}} />
      <span style={readout}>100</span>
    </div>
  </div>
)

// 音乐面那两条真杆:进度(有 format,读屏听见的是「4:01 / 4:58」而不是 241)
// 与音量(整数,step=5 是键盘走一格的大小)。
export const PlayerControls = () => (
  <div style={stack}>
    <div style={row}>
      <span style={name}>Playing</span>
      <Slider
        value={241}
        min={0}
        max={298}
        label="Seek within the track"
        format={(v) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')} / 4:58`}
        onCommit={() => {}}
      />
      <span style={readout}>4:01</span>
    </div>
    <div style={row}>
      <span style={name}>Volume</span>
      <Slider
        value={62}
        step={5}
        label="Playback volume"
        format={(v) => `${v} percent`}
        onCommit={() => {}}
      />
      <span style={readout}>62</span>
    </div>
  </div>
)

// 停用两档,画出来是同一件事:整条降透明、不接指针、不进 Tab 序、悬停也不长钮。
// `value={undefined}` = 读不到位置 —— 画一条能拖的杆是撒谎,所以它跟 disabled 同形。
export const DisabledAndUnknown = () => (
  <div style={stack}>
    <div style={row}>
      <span style={name}>Disabled</span>
      <Slider value={45} label="Volume (muted output)" disabled onCommit={() => {}} />
      <span style={readout}>45</span>
    </div>
    <div style={row}>
      <span style={name}>Unknown</span>
      <Slider value={undefined} label="Seek (stream has no duration)" onCommit={() => {}} />
      <span style={readout}>—</span>
    </div>
  </div>
)

// 自定义两头:不是每条杆都是 0–100。这里是 12–24 的字号档,step=1。
export const CustomRange = () => (
  <div style={stack}>
    <div style={row}>
      <span style={name}>Font size</span>
      <Slider
        value={15}
        min={12}
        max={24}
        step={1}
        label="Chat font size"
        format={(v) => `${v} pixels`}
        onCommit={() => {}}
      />
      <span style={readout}>15px</span>
    </div>
    <div style={row}>
      <span style={name}>Line height</span>
      <Slider
        value={1.6}
        min={1.2}
        max={2}
        step={0.1}
        label="Chat line height"
        format={(v) => v.toFixed(1)}
        onCommit={() => {}}
      />
      <span style={readout}>1.6</span>
    </div>
  </div>
)
