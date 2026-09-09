import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Fold, FoldBody, FoldFoot, FoldTrigger } from '../Fold'

/**
 * 折叠基座的规格。画皮肤的那一半不在这里(这件一个像素都不画),
 * 这里钉的是**行为与 a11y**:两档状态源、键鼠两路、aria 对得上、
 * 关闭态是 `hidden` 而不是卸载、以及那条圈选守卫。
 */

beforeEach(() => {
  // 选区是 window 上的东西:上一条用例伪造过就会漏给下一条,而「点了收不收」
  // 恰恰全靠它。
  vi.restoreAllMocks()
})

/** 拨选区:jsdom 的 getSelection 默认给一个空选区,圈选态要手动伪造。 */
function selectSomething(): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection)
}

const trigger = () => screen.getByRole('button')

function Sample({ withBody = true }: { withBody?: boolean }) {
  return (
    <Fold>
      <FoldTrigger>头</FoldTrigger>
      {withBody ? <FoldBody data-testid="body">正文</FoldBody> : null}
    </Fold>
  )
}

function WithFoot() {
  return (
    <Fold>
      <FoldTrigger data-testid="head">头</FoldTrigger>
      <FoldBody data-testid="body">正文</FoldBody>
      <FoldFoot data-testid="foot">收起</FoldFoot>
    </Fold>
  )
}

describe('ui/Fold:底把手 FoldFoot', () => {
  it('合着时不在场;展开后出场,按下合上、焦点交回头把手、头把手滚回视野', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 1
    })
    render(<WithFoot />)
    expect(screen.queryByTestId('foot')).toBeNull()
    fireEvent.click(screen.getByTestId('head'))
    const foot = screen.getByTestId('foot')
    expect(foot.getAttribute('aria-controls')).toBe(screen.getByTestId('body').id)
    // 底把手不报开合状态 —— 一个折叠只有头把手说 aria-expanded。
    expect(foot.hasAttribute('aria-expanded')).toBe(false)
    fireEvent.click(foot)
    expect(screen.getByTestId('head').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('body').style.display).toBe('none')
    expect(screen.queryByTestId('foot')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('head'))
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('Enter / Space 同样收起;圈着字也收(底把手不是正文,按它不可能是在圈字)', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    render(<WithFoot />)
    fireEvent.click(screen.getByTestId('head'))
    selectSomething()
    const swallowed = fireEvent.keyDown(screen.getByTestId('foot'), { key: ' ' })
    expect(swallowed).toBe(false)
    expect(screen.getByTestId('head').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('ui/Fold:自持档', () => {
  it('缺省是合的,点一下开、再点一下合', () => {
    render(<Sample />)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('defaultOpen 只决定初值', () => {
    render(
      <Fold defaultOpen>
        <FoldTrigger>头</FoldTrigger>
      </Fold>,
    )
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('Enter 与 Space 都开合,且都吞掉默认行为(Space 不许滚一屏)', () => {
    render(<Sample />)
    const enter = fireEvent.keyDown(trigger(), { key: 'Enter' })
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(enter).toBe(false) // fireEvent 返回 !defaultPrevented
    fireEvent.keyDown(trigger(), { key: ' ' })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('别的键一个字都不动它(也不吞默认行为)', () => {
    render(<Sample />)
    const passed = fireEvent.keyDown(trigger(), { key: 'a' })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(passed).toBe(true)
  })
})

describe('ui/Fold:受控档', () => {
  it('传了 open 就由消费方说了算:onOpenChange 报意图,自己不偷偷改', () => {
    const onOpenChange = vi.fn()
    render(
      <Fold open={false} onOpenChange={onOpenChange}>
        <FoldTrigger>头</FoldTrigger>
      </Fold>,
    )
    fireEvent.click(trigger())
    expect(onOpenChange).toHaveBeenCalledWith(true)
    // 消费方没写回,屏幕上就还是合的 —— 受控件不许自作主张。
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('消费方把状态接回去就正常开合', () => {
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <Fold open={open} onOpenChange={setOpen}>
          <FoldTrigger>头</FoldTrigger>
        </Fold>
      )
    }
    render(<Controlled />)
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })
})

describe('ui/Fold:aria 与正文', () => {
  it('aria-controls 指着正文那一格的 id', () => {
    render(<Sample />)
    const id = trigger().getAttribute('aria-controls')
    expect(id).toBeTruthy()
    expect(screen.getByTestId('body').getAttribute('id')).toBe(id)
  })

  it('没有 FoldBody 就不吐 aria-controls(指向不存在的 id 比不写更糟)', () => {
    render(<Sample withBody={false} />)
    expect(trigger().hasAttribute('aria-controls')).toBe(false)
  })

  it('关闭态是 hidden 属性 + 内联 display:none,不是卸载 —— 里面的东西一直在场', () => {
    render(<Sample />)
    const body = screen.getByTestId('body')
    expect(body.hasAttribute('hidden')).toBe(true)
    // 09-09 真机报障:消费方皮肤一句 `display: flex` 就盖掉 UA 的 `[hidden]`,
    // 所以关闭态必须有一句任何皮肤都盖不过的内联 display。
    expect(body.style.display).toBe('none')
    fireEvent.click(trigger())
    // 同一个 DOM 节点,不是重挂的新节点;展开态不留内联 display,皮肤说了算。
    expect(screen.getByTestId('body')).toBe(body)
    expect(body.hasAttribute('hidden')).toBe(false)
    expect(body.style.display).toBe('')
  })
})

describe('ui/Fold:圈选守卫', () => {
  it('展开态圈着字点一下 —— 不收(否则复制到一半这块就自己关了)', () => {
    render(<Sample />)
    fireEvent.click(trigger())
    selectSomething()
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('同样圈着字,Enter 照收 —— 按键不可能是在圈字', () => {
    render(<Sample />)
    fireEvent.click(trigger())
    selectSomething()
    fireEvent.keyDown(trigger(), { key: 'Enter' })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('守卫只挡收起:合着的时候有选区照样点得开', () => {
    render(<Sample />)
    selectSomething()
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })
})
