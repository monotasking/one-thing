import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Field, useFieldControlProps } from '../Field'

/** 规格页与真实消费面的用法:摊上去,不做别的。 */
function Control() {
  const field = useFieldControlProps()
  return <input {...field} readOnly value="" />
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
})
