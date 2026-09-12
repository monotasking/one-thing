import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { ComposerInput } from './ComposerInput'
import type { ComposerInputHandle } from './ComposerInput'

/**
 * 本体行输入面的**草稿口**(09-12)。
 *
 * 这一层钉的是「屏幕上有什么」与「交出去的是什么」之间那条缝 —— 两者从来不
 * 逐字相同(chip 是呈现、token 才是位置),而 09-12 又多了一枚**根本不进草稿**的
 * 幽灵占位。缝越多,越要有一处把它们逐条钉住。
 *
 * 编排(什么时候开抽屉、选中哪一条)在 `Composer.test.tsx`,这里一格都不碰。
 */

function setup() {
  const apiRef = createRef<ComposerInputHandle>()
  const sent: string[] = []
  const view = render(
    <ComposerInput
      apiRef={apiRef}
      placeholder="说点什么"
      picking={false}
      onToken={() => undefined}
      onMove={() => undefined}
      onPick={() => undefined}
      onEscape={() => undefined}
      onSend={(text) => void sent.push(text)}
    />,
  )
  const box = view.getByTestId('composer-input')
  return { api: () => apiRef.current as ComposerInputHandle, box, sent }
}

/** 在那块可编辑区里「打」一段话:落文本 + 把光标放到末尾(不发 input)。 */
function put(box: HTMLElement, text: string) {
  box.textContent = text
  const node = box.firstChild
  if (!node) return
  const range = document.createRange()
  range.setStart(node, text.length)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

describe('insert:命令徽之后恒有一个空格,光标落在它后面', () => {
  it('`/cd` 插完,草稿是 `/cd `(空格在里面),光标停在那个空格之后', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('commands', '/cd')

    // 交出去的那句话:命令徽 + 一个空格。**结尾那个空格是内容的一部分** ——
    // 09-12 报障「补全命令后没有空格」病的不是它不在,是 `.input` 把它折叠没了
    // (修在 Composer.module.css 的 `white-space: pre-wrap`,那条由 css 门钉)。
    expect(api().text()).toBe('/cd ')
    expect(api().text().endsWith(' ')).toBe(true)

    const sel = window.getSelection()
    expect(sel?.anchorNode?.nodeType).toBe(Node.TEXT_NODE)
    expect(sel?.anchorNode?.textContent).toBe(' ')
    expect(sel?.anchorOffset).toBe(1)
  })

  it('句中补全:后半截原样跟在空格后面,一个字不丢', () => {
    const { api, box } = setup()
    put(box, '/cd')
    // 光标放在 `/cd` 与后半截之间(模拟「打了一半又回头补全」)。
    const node = box.firstChild as Text
    node.textContent = '/cd 之后的话'
    const range = document.createRange()
    range.setStart(node, 3)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    api().insert('commands', '/cd')
    expect(api().text()).toBe('/cd  之后的话')
  })
})

describe('参数幽灵占位:画在屏幕上,不进草稿,打第一个字就散', () => {
  it('给了 argHint 就挂一枚 —— 屏幕上看得见,`text()` 里一个字都没有', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('commands', '/cd', { argHint: '<path>' })

    expect(box.querySelector('[data-arg-ghost]')?.textContent).toBe('<path>')
    expect(box.textContent).toBe('/cd <path>')
    // 草稿里没有它 —— 发出去的那句话是 `/cd `,不是 `/cd <path>`。
    expect(api().text()).toBe('/cd ')
  })

  it('没给 argHint 就一枚都不挂(不收参数的命令)', () => {
    const { api, box } = setup()
    put(box, '/compact')
    api().insert('commands', '/compact')
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/compact ')
  })

  it('打第一个字它就散', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('commands', '/cd', { argHint: '<path>' })

    // 人在那个空格后面打了一个字:空格那一节点变成 ' ~',提示当场退场。
    const gap = box.querySelector('[data-arg-ghost]')?.previousSibling as Text
    gap.textContent = ' ~'
    const range = document.createRange()
    range.setStart(gap, 2)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    fireEvent.input(box)

    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd ~')
  })

  it('退格把那个空格吃掉,同样散', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('commands', '/cd', { argHint: '<path>' })

    const gap = box.querySelector('[data-arg-ghost]')?.previousSibling as Text
    gap.textContent = ''
    fireEvent.input(box)

    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd')
  })

  it('光标挪到别处去了(它前面那一节点不再是光标所在),也散', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('commands', '/cd', { argHint: '<path>' })

    window.getSelection()?.removeAllRanges()
    fireEvent.input(box)
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd ')
  })

  it('铺回一份存下来的稿:幽灵占位不跟着回来(那句提示已经过期)', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('commands', '/cd', { argHint: '<path>' })
    const saved = api().html()
    expect(saved).toContain('data-arg-ghost')

    api().restore(saved)
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd ')
  })
})

describe('回车与发送键读同一口草稿', () => {
  it('回车交出去的是 `text()`,不是 `textContent` —— chip 的 token 不许在这条路上丢', () => {
    const { api, box, sent } = setup()
    put(box, '看看 @a')
    api().insert('files', 'src/a.ts', { token: '{{file:/repo/src/a.ts}}' })

    // 屏幕上写的是 `@src/a.ts`(呈现),草稿里代表的是那截 token(位置)。
    expect(box.textContent).toContain('@src/a.ts')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['看看 {{file:/repo/src/a.ts}} '])
  })

  it('幽灵占位也不走回车那条路出去', () => {
    const { api, box, sent } = setup()
    put(box, '/cd')
    api().insert('commands', '/cd', { argHint: '<path>' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['/cd '])
  })
})
