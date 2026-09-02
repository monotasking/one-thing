import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { Button } from '../Button'

/**
 * **Button 的档位规格测试**(09-01 批 3.5 随 `danger` 档补口一起立)。
 *
 * 这一份守的是「三个开关各只管一件事、不互相耦合」那条文件头承诺:
 * variant 换配方、size 换高度、pill 换圆角、iconOnly 换成正方 —— 每一格
 * 各挂各的类。耦合一旦发生(比如有人让 danger 顺手换掉 size),
 * 下面某一条会当场红。
 *
 * 颜色本身由 `.module.css` 保证,jsdom 不解析 CSS Modules 的真值,
 * 所以这里测的是**哪一档挂上了**——这正是「配方产地单一」在 JS 侧唯一能测的那一面。
 */
describe('Button:变体档位', () => {
  it('缺省是 ghost —— 一屏只该有一颗 primary,所以 primary 必须显式要', () => {
    render(<Button>a</Button>)
    const cls = screen.getByRole('button').className
    expect(cls).toMatch(/ghost/)
    expect(cls).not.toMatch(/primary/)
    expect(cls).not.toMatch(/danger/)
  })

  it('primary 挂 primary 档', () => {
    render(<Button variant="primary">a</Button>)
    const cls = screen.getByRole('button').className
    expect(cls).toMatch(/primary/)
    expect(cls).not.toMatch(/ghost/)
  })

  it('**danger 挂 danger 档,且不是第二个 primary**(补口的那一档)', () => {
    render(<Button variant="danger">拒绝</Button>)
    const cls = screen.getByRole('button').className
    expect(cls).toMatch(/danger/)
    expect(cls).not.toMatch(/primary/)
    expect(cls).not.toMatch(/ghost/)
  })

  it('danger 与别的开关不耦合 —— 尺寸 / 丸 / 图标档照旧各挂各的', () => {
    render(
      <Button variant="danger" size="md" pill>
        删除
      </Button>,
    )
    const cls = screen.getByRole('button').className
    expect(cls).toMatch(/danger/)
    expect(cls).toMatch(/md/)
    expect(cls).toMatch(/pill/)
  })
})

describe('Button:尺寸与形状', () => {
  it('sm 是缺省,只有 md 挂档(高度是唯一差别)', () => {
    const { rerender } = render(<Button>a</Button>)
    expect(screen.getByRole('button').className).not.toMatch(/md/)
    rerender(<Button size="md">a</Button>)
    expect(screen.getByRole('button').className).toMatch(/md/)
  })

  it('pill 只换圆角,iconOnly 只换成正方 —— 两个开关可以同时开', () => {
    render(
      <Button pill iconOnly aria-label="搜索">
        x
      </Button>,
    )
    const cls = screen.getByRole('button').className
    expect(cls).toMatch(/pill/)
    expect(cls).toMatch(/iconOnly/)
  })
})

describe('Button:透传与默认 type', () => {
  it("默认 `type='button'` —— 表单里的 <button> 默认是 submit,那条坑由默认值挡住", () => {
    render(<Button>a</Button>)
    expect(screen.getByRole('button').getAttribute('type')).toBe('button')
  })

  it('显式 type 覆盖默认档', () => {
    render(<Button type="submit">a</Button>)
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit')
  })

  it('`className` 合并,且盖不掉库件那一串', () => {
    render(
      <Button variant="danger" className="local-skin">
        a
      </Button>,
    )
    const cls = screen.getByRole('button').className
    expect(cls).toMatch(/local-skin/)
    expect(cls).toMatch(/danger/)
    expect(cls).toMatch(/btn/)
  })

  it('`data-*` / `aria-*` / onClick 原样透传', () => {
    const onClick = vi.fn()
    render(
      <Button data-testid="k" aria-expanded onClick={onClick}>
        a
      </Button>,
    )
    const btn = screen.getByTestId('k')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('禁用的钮点不响,而且 disabled 不换色只降透明度(档位仍在)', () => {
    const onClick = vi.fn()
    render(
      <Button variant="danger" disabled onClick={onClick}>
        a
      </Button>,
    )
    const btn = screen.getByRole('button')
    expect(btn).toHaveProperty('disabled', true)
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
    expect(btn.className).toMatch(/danger/)
  })

  /**
   * 守卫:**`ref` 落在那颗 `<button>` 上**(09-02 批 8a,与 `ui/IconButton` 同批)。
   * 这件的根就是那个真 `<button>`,ref 只穿一层;拆掉这条,量矩形 / 手动聚焦
   * 的落点又要退回「在外面包一格贴身 span」。
   */
  it('ref 落到那颗 <button> 上,且档位皮肤照旧', () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <Button ref={ref} variant="primary" pill data-testid="r">
        a
      </Button>,
    )
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    expect(ref.current).toBe(screen.getByTestId('r'))
    expect(ref.current?.className).toMatch(/primary/)
    expect(ref.current?.className).toMatch(/pill/)
  })
})
