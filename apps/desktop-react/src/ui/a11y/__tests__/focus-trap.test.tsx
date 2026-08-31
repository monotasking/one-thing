import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { focusablesIn, useFocusTrap } from '../focus-trap'

/**
 * 三件事,对应 focus-trap 的三条职责:Tab 圈禁、Shift+Tab 反向圈禁、关闭还锚点。
 *
 * jsdom 不排版,所以这里**不**验「环画出来没有」(那归真机门 gate:a11y),
 * 只验焦点落在哪个元素上 —— 那是纯 DOM 事实,jsdom 说得准。
 */
function Trapped({ open }: { open: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, open)
  if (!open) return null
  return (
    <div ref={panel} tabIndex={-1} data-testid="panel">
      <button type="button">一</button>
      <button type="button">二</button>
      <button type="button">三</button>
    </div>
  )
}

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" data-testid="anchor" onClick={() => setOpen(true)}>
        开
      </button>
      <button type="button" data-testid="outside">
        外面
      </button>
      <Trapped open={open} />
      {open && (
        <button type="button" data-testid="close" onClick={() => setOpen(false)}>
          关
        </button>
      )}
    </>
  )
}

describe('focusablesIn', () => {
  it('按文档序收可聚焦元素;disabled / aria-hidden 的不算', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <button id="a"></button>
      <button id="b" disabled></button>
      <span aria-hidden="true"><button id="c"></button></span>
      <a id="d" href="#x"></a>
      <div id="e" tabindex="-1"></div>
      <div id="f" tabindex="0"></div>
    `
    document.body.appendChild(host)
    expect(focusablesIn(host).map((el) => el.id)).toEqual(['a', 'd', 'f'])
    host.remove()
  })
})

describe('useFocusTrap', () => {
  it('开启时焦点进容器,Tab 到末尾回开头,Shift+Tab 从开头回末尾', () => {
    render(<Harness />)
    const anchor = screen.getByTestId('anchor')
    anchor.focus()
    fireEvent.click(anchor)

    const panel = screen.getByTestId('panel')
    expect(document.activeElement).toBe(panel)

    const [one, two, three] = ['一', '二', '三'].map((label) => screen.getByText(label))

    // 焦点在容器上(不在任何一项里):下一下 Tab 落到第一项。
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(one)

    // 中间那几下是浏览器的原生行为,jsdom 不模拟 —— 直接摆到末项再按 Tab,
    // 验的正是「末项之后回到首项」那一条(圈禁的闭合处)。
    three.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(one)

    // 反向:首项之前回末项。
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(three)

    // 焦点被别处抢走(浮层外面)之后,下一下 Tab 把它拽回圈里。
    two.focus()
    screen.getByTestId('outside').focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(one)
  })

  it('关闭时焦点还给开它的那个元素', () => {
    render(<Harness />)
    const anchor = screen.getByTestId('anchor')
    anchor.focus()
    fireEvent.click(anchor)
    expect(document.activeElement).toBe(screen.getByTestId('panel'))

    fireEvent.click(screen.getByTestId('close'))
    expect(document.activeElement).toBe(anchor)
  })

  it('active 为 false 时不抢焦点、不吃 Tab', () => {
    render(<Harness />)
    const outside = screen.getByTestId('outside')
    outside.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(outside)
  })
})
