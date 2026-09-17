import { Button, Field, Input, Segmented, useFieldControlProps } from '@onething/desktop-react'

// 表单格:label 恒为必填(没有名字读屏软件念不出来),看不看得见另说(labelHidden)。
// 关联契约是**消费方自己**把 useFieldControlProps() 摊到控件上 —— Field 不 cloneElement 硬塞。
const FieldInput = (p: any) => {
  const field = useFieldControlProps()
  return <Input {...field} onValueChange={() => {}} {...p} />
}

const DENSITY = [
  { value: 'cozy', label: 'Cozy' },
  { value: 'compact', label: 'Compact' },
]

// radiogroup 的根是个 <div>,<label htmlFor> 指不动它 —— 关联靠 Field 多交出来的
// aria-labelledby,消费方照旧一句 {...field}。
const FieldSegmented = () => {
  const field = useFieldControlProps()
  return <Segmented {...field} options={DENSITY} value="cozy" onChange={() => {}} />
}

const stack = { display: 'grid', gap: 'var(--sp-4)', maxWidth: 420, font: 'var(--fs-body) var(--font-ui)', color: 'var(--text-1)' } as const
const wide = { ...stack, maxWidth: 560 } as const

// 竖排(缺省):标签在上、控件在下、附注跟在最后。
export const Stack = () => (
  <div style={stack}>
    <Field label="API key">
      <FieldInput value="" placeholder="sk-…" />
    </Field>
    <Field label="Base URL" hint="Ends with /v1">
      <FieldInput value="https://api.deepseek.com/v1" />
    </Field>
  </div>
)

// 错误:危险色只上字不上底;在场时控件同时拿到 aria-invalid,
// describedby 里错误排在 hint 前面(读屏软件按那个顺序念)。
export const Validation = () => (
  <div style={stack}>
    <Field label="Base URL" error="Not a valid URL.">
      <FieldInput value="htp:/api.deepseek" invalid />
    </Field>
    <Field label="Base URL" hint="Ends with /v1" error="Not a valid URL.">
      <FieldInput value="htp:/api.deepseek" invalid />
    </Field>
  </div>
)

// 横排:标签与控件同一行,hint / error 折到第二行占满宽。
// 控件那一格是 children,所以并肩的钮跟着进去就行。
export const Inline = () => (
  <div style={wide}>
    <Field layout="inline" size="sm" label="Name">
      <FieldInput value="Fable" size="sm" />
      <Button size="sm">Save</Button>
    </Field>
    <Field layout="inline" label="Working directory" labelHidden>
      <FieldInput value="~/code/onething" />
      <Button variant="primary">Bind</Button>
    </Field>
    <Field layout="inline" label="Model id" labelHidden error="That id is not in the catalog.">
      <FieldInput value="deepseek-chat-v9" invalid />
      <Button variant="primary">Add</Button>
    </Field>
  </div>
)

// 档:md(缺省)常规 / sm 紧凑 —— 一个旋钮同时定间距与附注字号。
export const Sizes = () => (
  <div style={stack}>
    <Field label="Request timeout — md (default)" size="md" hint="Seconds before the request is dropped.">
      <FieldInput value="60" />
    </Field>
    <Field label="Request timeout — sm" size="sm" hint="Seconds before the request is dropped.">
      <FieldInput value="60" size="sm" />
    </Field>
    <Field layout="inline" size="md" label="Retries — md (default)">
      <FieldInput value="3" />
    </Field>
    <Field layout="inline" size="sm" label="Retries — sm">
      <FieldInput value="3" size="sm" />
    </Field>
  </div>
)

// 装一件「标不动」的控件:写法与装 Input 逐字相同(一句 {...field}),
// 这正是关联走 context + 透传而不是让控件去吃 Field 的 context 的理由。
export const NonLabelableControl = () => (
  <div style={stack}>
    <Field label="Density" hint="Applies to lists and cards.">
      <FieldSegmented />
    </Field>
  </div>
)
