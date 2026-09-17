import { FilterChip } from '@onething/desktop-react'

// 过滤片:一颗扁的、描边的、可按的小药丸,说的是「我此刻按这个条件在筛」。
// 与 Badge 是两件事 —— Badge 是读数(不可按),片是控件(可按、有开关态)。
// 选项是封闭集合、行形态统一,所以走 options 数组(与 Select / Segmented 同一档)。
const bar = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--sp-2)',
  font: 'var(--fs-micro) var(--font-ui)',
} as const

const SPACE = [
  { value: 'current', label: 'Current' },
  { value: 'all', label: 'All' },
] as const

const ROLE = [
  { value: 'any', label: 'Any' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
] as const

const TIME = [
  { value: 'any', label: 'Any' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
] as const

const YESNO = [
  { value: 'with', label: 'With' },
  { value: 'without', label: 'Without' },
] as const

// 检索面真正的那一条片条:范围片(带 ×)在前,五颗过滤片跟在后面,次序固定。
export const SearchFilterBar = () => (
  <div style={bar}>
    <FilterChip name="scope" label="packages/backend" on onRemove={() => {}} removeLabel="Drop this scope" />
    <FilterChip name="space" label="Space" value="current" options={SPACE} on onSelect={() => {}} />
    <FilterChip name="role" label="Role" value="assistant" options={ROLE} on onSelect={() => {}} />
    <FilterChip name="time" label="Time" value="week" options={TIME} on onSelect={() => {}} />
    <FilterChip name="archived" label="Archived" options={YESNO} onSelect={() => {}} />
    <FilterChip name="reasoning" label="Reasoning" value="with" options={YESNO} on onSelect={() => {}} />
  </div>
)

// 主变体轴:挑过了没有。on = 描边加重 + 一层极淡的选中膜,**不换底色**
// (状态色只上图标 / 点)。disabled = 这一档摆不出对应的 facet 键,禁灰而不消失。
export const OnOffDisabled = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-3)', justifyItems: 'start' }}>
    <div style={bar}>
      <FilterChip name="time" label="Time" value="any" options={TIME} onSelect={() => {}} />
      <span style={{ color: 'var(--text-3)', fontSize: 'var(--fs-meta)' }}>rest — 还没挑</span>
    </div>
    <div style={bar}>
      <FilterChip name="time" label="Time" value="today" options={TIME} on onSelect={() => {}} />
      <span style={{ color: 'var(--text-3)', fontSize: 'var(--fs-meta)' }}>on — 挑过了</span>
    </div>
    <div style={bar}>
      <FilterChip name="time" label="Time" value="month" options={TIME} on disabled onSelect={() => {}} />
      <span style={{ color: 'var(--text-3)', fontSize: 'var(--fs-meta)' }}>disabled — 这一档没有这个 facet</span>
    </div>
  </div>
)

// 两态片:不给 options,给 onToggle —— 按下去就翻,aria-pressed 只在这一形上报。
// 多值片没有「按下去了没有」这回事,它有的是「此刻选的是哪一格」。
export const TwoStateChips = () => (
  <div style={bar}>
    <FilterChip name="archived" label="Archived" onToggle={() => {}} />
    <FilterChip name="reasoning" label="Reasoning" on onToggle={() => {}} />
    <FilterChip name="attachments" label="Attachments" onToggle={() => {}} />
    <FilterChip name="starred" label="Starred" on onToggle={() => {}} />
  </div>
)

// 范围片那一形:尾巴上多一颗 ×。它是**另一颗按钮**(嵌套 button 非法),所以片身
// 与 × 是兄弟,外面那层 .wrap 才是视觉上的一颗药丸。值是唯一会弯腰的那一段。
export const RemovableAndSqueezed = () => (
  <div style={{ display: 'grid', gap: 'var(--sp-3)', justifyItems: 'start', width: 260 }}>
    <FilterChip name="scope" label="apps/desktop-react" on onRemove={() => {}} removeLabel="Drop this scope" />
    {/* 挤压:片名永不弯腰,弯的是值那一段(min-width:0 + 省略号)。 */}
    <div style={{ display: 'flex', minWidth: 0, maxWidth: 240 }}>
      <FilterChip
        name="path"
        label="Path"
        value="worker"
        options={[{ value: 'worker', label: 'packages/onething-runtime/src/search/index/worker.ts' }]}
        on
        onSelect={() => {}}
        onRemove={() => {}}
        removeLabel="Drop this path filter"
      />
    </div>
    <FilterChip name="space" label="Space" value="current" options={SPACE} on onSelect={() => {}} onRemove={() => {}} removeLabel="Drop this filter" />
  </div>
)
