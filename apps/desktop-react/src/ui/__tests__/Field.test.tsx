import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Field, useFieldControlProps } from '../Field'
import { Segmented } from '../Segmented'

/** 规格页与真实消费面的用法:摊上去,不做别的。 */
function Control() {
  const field = useFieldControlProps()
  return <input {...field} readOnly value="" />
}

/**
 * 装一件**标不动的控件**(09-02 批 8a):写法与上面那件逐字相同 ——
 * 一句 `{...field}`,消费方不必知道自己装的是可标注元素还是 radiogroup。
 */
const DENSITY = [
  { value: 'cozy' as const, label: 'Cozy' },
  { value: 'compact' as const, label: 'Compact' },
]

function FieldSegmented() {
  const field = useFieldControlProps()
  return <Segmented {...field} options={DENSITY} value="cozy" onChange={() => {}} />
}

describe('Field:表单行', () => {
  it('生命状态:挂载画一行,卸载零残留;id 由 useId 给,重渲不换', () => {
    const { container, rerender, unmount } = render(
      <Field label="API key">
        <Control />
      </Field>,
    )
    const first = (container.querySelector('input') as HTMLInputElement).id
    expect(first).toBeTruthy()

    rerender(
      <Field label="API key" hint="Stored on this machine only.">
        <Control />
      </Field>,
    )
    expect((container.querySelector('input') as HTMLInputElement).id).toBe(first)

    unmount()
    expect(container.innerHTML).toBe('')
  })

  /**
   * 守卫:**空槽不渲染 DOM**。空壳会在 column flex 里多吃一个 gap,
   * 一列表单行的行距就参差 —— 所以断言的是节点不在,不是内容为空。
   */
  it('生命状态:不给 hint / error 时那两格连节点都不在', () => {
    const { container } = render(
      <Field label="API key">
        <Control />
      </Field>,
    )
    expect(container.querySelector('[class*="hint"]')).toBeNull()
    expect(container.querySelector('[class*="error"]')).toBeNull()
  })

  /**
   * 守卫:label 与控件真的连上了 —— `<label htmlFor>` 指的就是 hook 摊出去的 id。
   * 断掉这条,点标签不聚焦、读屏软件读不出控件的名。
   */
  it('生命状态:label 经 useId 与控件关联(getByLabelText 拿得到那个 input)', () => {
    render(
      <Field label="API key">
        <Control />
      </Field>,
    )
    const el = screen.getByLabelText('API key')
    expect(el.tagName).toBe('INPUT')
  })

  it('生命状态:在 Field 外调用 hook 拿到空对象 —— 摊上去什么都不发生,不抛', () => {
    render(<Control />)
    const el = screen.getByRole('textbox')
    expect(el.hasAttribute('id')).toBe(false)
    expect(el.hasAttribute('aria-describedby')).toBe(false)
    expect(el.hasAttribute('aria-invalid')).toBe(false)
  })

  /**
   * 交互状态:error 来去时,控件身上的 aria 必须**跟着**走。
   * 这是这件唯一的「交互」—— 它自己不是控件,它管的是关联。
   */
  it('交互状态:error 切换时 aria-invalid 与 aria-describedby 跟着上下', () => {
    const { rerender } = render(
      <Field label="API key">
        <Control />
      </Field>,
    )
    const input = () => screen.getByLabelText('API key')
    expect(input().hasAttribute('aria-invalid')).toBe(false)

    rerender(
      <Field label="API key" error="That key was rejected.">
        <Control />
      </Field>,
    )
    expect(input().getAttribute('aria-invalid')).toBe('true')
    const describedBy = input().getAttribute('aria-describedby') as string
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy)?.textContent).toBe('That key was rejected.')

    // 回到无错:两格都收回去,不留残迹。
    rerender(
      <Field label="API key">
        <Control />
      </Field>,
    )
    expect(input().hasAttribute('aria-invalid')).toBe(false)
    expect(input().hasAttribute('aria-describedby')).toBe(false)
  })

  it('数据状态:只有 hint 时 describedby 指 hint 那一格', () => {
    render(
      <Field label="Base URL" hint="Ends with /v1">
        <Control />
      </Field>,
    )
    const ids = (screen.getByLabelText('Base URL').getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids.length).toBe(1)
    expect(document.getElementById(ids[0])?.textContent).toBe('Ends with /v1')
  })

  /**
   * 数据状态:hint 与 error **并存**是真实的一格 —— 说明还该看得见,
   * 错误只是加了一句。次序是守卫:**错误排在前面**,读屏软件按 describedby
   * 的顺序念,先说「错在哪」再说「该怎么填」。
   */
  it('数据状态:hint 与 error 并存 —— 两格都在,describedby 里错误排在前', () => {
    const { container } = render(
      <Field label="Base URL" hint="Ends with /v1" error="Not a valid URL.">
        <Control />
      </Field>,
    )
    expect(container.querySelector('[class*="hint"]')?.textContent).toBe('Ends with /v1')
    expect(container.querySelector('[class*="error"]')?.textContent).toBe('Not a valid URL.')

    const ids = (screen.getByLabelText('Base URL').getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids.length).toBe(2)
    expect(document.getElementById(ids[0])?.textContent).toBe('Not a valid URL.')
    expect(document.getElementById(ids[1])?.textContent).toBe('Ends with /v1')
  })

  it('数据状态:两格 Field 同屏,id 各不相同(useId 给的是本实例的号)', () => {
    render(
      <>
        <Field label="API key">
          <Control />
        </Field>
        <Field label="Base URL">
          <Control />
        </Field>
      </>,
    )
    expect(screen.getByLabelText('API key').id).not.toBe(screen.getByLabelText('Base URL').id)
  })

  /**
   * 不可标注的控件那一格(09-02 批 8a)。`<label htmlFor>` 只认可标注元素,
   * radiogroup 的根是个 `<div>` —— 从前那条 label 指了个空:点标签不聚焦、
   * 读屏软件念不出这一组叫什么。修法是 Field 多交一格 `aria-labelledby`。
   *
   * 这一条断的是**可访问名**,不是「属性挂上了没有」:
   * `getByRole('radiogroup', { name })` 走的正是浏览器那套名字计算。
   * 拆掉 Field 那一格(或拆掉 Segmented 的透传),这里当场红。
   */
  it('无障碍:radiogroup 这类标不动的控件靠 aria-labelledby 关联,可访问名 = label 文字', () => {
    render(
      <Field label="Density" hint="Applies to lists.">
        <FieldSegmented />
      </Field>,
    )
    const group = screen.getByRole('radiogroup', { name: 'Density' })
    // 名字真的来自那条 <label>(不是控件自己写了一句同样的话)。
    const labelId = group.getAttribute('aria-labelledby') as string
    expect(document.getElementById(labelId)?.tagName).toBe('LABEL')
    expect(document.getElementById(labelId)?.textContent).toBe('Density')
    // hint 那一格照旧跟着走:两条关联互不干扰。
    const describedBy = group.getAttribute('aria-describedby') as string
    expect(document.getElementById(describedBy)?.textContent).toBe('Applies to lists.')
  })

  /* ── 横排档(09-02 批 10)──────────────────────────────────────────────── */

  /**
   * 生命状态:形由 `layout` 定,而且**两形共用同一套关联**。断的是「换了形
   * 之后 id / label / describedby 一格不少」—— 横排从前是三处业务面各写一份
   * CSS 加一份 `aria-label`,收编的价值正在这里。
   */
  it('横排:layout="inline" 换的是形,关联一格不少', () => {
    const { container } = render(
      <Field layout="inline" label="Working directory" error="No such directory.">
        <Control />
      </Field>,
    )
    const row = container.firstElementChild as HTMLElement
    // 形是这件自己给的一格类,不是消费方从外面掰 flex-direction(特异性赌局)。
    expect(row.className).toMatch(/_inline_/)
    expect(row.className).not.toMatch(/_stack_/)

    const input = screen.getByLabelText('Working directory')
    const describedBy = input.getAttribute('aria-describedby') as string
    expect(document.getElementById(describedBy)?.textContent).toBe('No such directory.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('生命状态:不给 layout 时是竖排(缺省不变 —— 既有消费面一个字都不用改)', () => {
    const { container } = render(
      <Field label="API key">
        <Control />
      </Field>,
    )
    expect((container.firstElementChild as HTMLElement).className).toMatch(/_stack_/)
  })

  /**
   * 数据状态:`size` 是一个旋钮同时定间距与附注字号(理由见 module.css)。
   * 这里断的是**档真的落到根上**了 —— 值本身归 CSS,jsdom 不算样式。
   */
  it('数据状态:size 落在根上,缺省是 md', () => {
    const { container, rerender } = render(
      <Field layout="inline" label="Name">
        <Control />
      </Field>,
    )
    expect((container.firstElementChild as HTMLElement).className).toMatch(/_md_/)

    rerender(
      <Field layout="inline" size="sm" label="Name">
        <Control />
      </Field>,
    )
    const cls = (container.firstElementChild as HTMLElement).className
    expect(cls).toMatch(/_sm_/)
    expect(cls).not.toMatch(/_md_/)
  })

  /**
   * 无障碍:**标签只念不看**。断的是可访问名照旧算得出来 —— 断掉 `labelHidden`
   * 那一格(比如改成不渲染 label),`getByLabelText` / `getByRole(name)` 当场红。
   * 这正是三处产地从 `aria-label` 迁过来时不能丢的那一格。
   */
  it('无障碍:labelHidden 只藏眼睛不藏读屏 —— 名字算得出来,label 仍在 DOM 里', () => {
    const { container } = render(
      <Field layout="inline" labelHidden label="Working directory">
        <Control />
      </Field>,
    )
    const label = container.querySelector('label') as HTMLLabelElement
    // 用的是仓里既有的那条全局类,不是 display:none(那会连读屏一起藏)。
    expect(label.className).toBe('visually-hidden')
    const input = screen.getByLabelText('Working directory') as HTMLInputElement
    expect(label.getAttribute('for')).toBe(input.id)
    expect(screen.getByRole('textbox', { name: 'Working directory' })).toBe(input)
  })

  /**
   * 透传口子(照 ui/GroupHead / ui/Segmented 的先例):落点自己的身份摊到根上。
   * `content/files` 那条绑定行的 `data-testid="files-bind-row"` 是八条既有测试
   * 找人的名牌 —— 收编时它必须还在。
   */
  it('横排:落点自己的 data-testid / role 透传到根上,className 仍并皮肤', () => {
    const { container } = render(
      <Field layout="inline" labelHidden label="Working directory" data-testid="bind-row">
        <Control />
      </Field>,
    )
    const row = container.firstElementChild as HTMLElement
    expect(screen.getByTestId('bind-row')).toBe(row)
    expect(row.className).toMatch(/_inline_/)
  })

  /**
   * 加性守卫:可标注控件**一个字都不用改**。多出来的 `aria-labelledby` 指的是
   * 同一条 label,可访问名算出来逐字相同 —— 这条钉住「这一格不是破坏性变更」。
   */
  it('无障碍:可标注控件同时拿到 htmlFor 与 aria-labelledby,名字仍是同一句', () => {
    render(
      <Field label="API key">
        <Control />
      </Field>,
    )
    const input = screen.getByLabelText('API key') as HTMLInputElement
    const labelId = input.getAttribute('aria-labelledby') as string
    expect(document.getElementById(labelId)?.getAttribute('for')).toBe(input.id)
    expect(screen.getByRole('textbox', { name: 'API key' })).toBe(input)
  })
})
