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
 *
 * ── 09-12 第三批:`insert` 的**签名**换了,断言一条没动 ────────────────────
 * 从前是 `insert('files' | 'commands', label, opts)` —— 两个种类名写死在联合里。
 * 今天是 `insert(kindId, chip, opts)`:第一个参数是注册表上的 id(它落在 chip 的
 * `data-kind` 上,草稿出口据此查那一种的 `expand`),第二个参数是那一种自述交出来
 * 的 chip(写什么 + 画成哪一形)。所以下面每一处调用的**形**变了,而每一条
 * `expect` 逐字照旧 —— 这正是「迁移 = 等价替换」要的那种差异。
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
    api().insert('command', { label: '/cd', tone: 'token' })

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

    api().insert('command', { label: '/cd', tone: 'token' })
    expect(api().text()).toBe('/cd  之后的话')
  })
})

describe('参数幽灵占位:画在屏幕上,不进草稿,打第一个字就散', () => {
  it('给了 argHint 就挂一枚 —— 屏幕上看得见,`text()` 里一个字都没有', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('command', { label: '/cd', tone: 'token' }, { argHint: '<path>' })

    expect(box.querySelector('[data-arg-ghost]')?.textContent).toBe('<path>')
    expect(box.textContent).toBe('/cd <path>')
    // 草稿里没有它 —— 发出去的那句话是 `/cd `,不是 `/cd <path>`。
    expect(api().text()).toBe('/cd ')
  })

  it('没给 argHint 就一枚都不挂(不收参数的命令)', () => {
    const { api, box } = setup()
    put(box, '/compact')
    api().insert('command', { label: '/compact', tone: 'token' })
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/compact ')
  })

  it('打第一个字它就散', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('command', { label: '/cd', tone: 'token' }, { argHint: '<path>' })

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
    api().insert('command', { label: '/cd', tone: 'token' }, { argHint: '<path>' })

    const gap = box.querySelector('[data-arg-ghost]')?.previousSibling as Text
    gap.textContent = ''
    fireEvent.input(box)

    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd')
  })

  it('光标挪到别处去了(它前面那一节点不再是光标所在),也散', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('command', { label: '/cd', tone: 'token' }, { argHint: '<path>' })

    window.getSelection()?.removeAllRanges()
    fireEvent.input(box)
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd ')
  })

  it('铺回一份存下来的稿:幽灵占位不跟着回来(那句提示已经过期)', () => {
    const { api, box } = setup()
    put(box, '/cd')
    api().insert('command', { label: '/cd', tone: 'token' }, { argHint: '<path>' })
    const saved = api().html()
    expect(saved).toContain('data-arg-ghost')

    api().restore(saved)
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd ')
  })
})

describe('文件 chip 的展开就在草稿出口', () => {
  /**
   * **病 ① 的那条反证**(09-12 真机:@ 一个文件发出去,屏幕上出现两条用户气泡,
   * 其中一条是裸的 `{{file:/Users/…}}` 而且永不消失)。
   *
   * 病根是壳里有**两句话**:发送那一刻 `chat-source` 记下的乐观 overlay 是草稿
   * 原文(token 句),而账本回来的是端口展开后的 `@<路径>` —— 认领判据「正文
   * 逐字相同」于是永远不成立。修法是把展开挪到这里,让**交出去的那一刻就已经是
   * 账本上的那串字节**。
   *
   * **反证**:把 `readDraft` 里那句 `expandFileTokens` 拆掉 → 这一条当场读到
   * `{{file:…}}`,也就是用户报的那条裸文本。
   */
  it('`text()` 交出的是 `@<绝对路径>`,一个 `{{file:` 都不许漏出去', () => {
    const { api, box } = setup()
    put(box, '看看 @a')
    api().insert('file', { label: '@src/a.ts', tone: 'reference' }, { token: '{{file:/repo/src/a.ts}}' })

    // 屏幕上写的是 `@src/a.ts`(呈现),交出去的是那条绝对路径(位置)。
    expect(box.textContent).toContain('@src/a.ts')
    expect(api().text()).toBe('看看 @/repo/src/a.ts ')
    expect(api().text()).not.toContain('{{file:')
  })

  /**
   * 存草稿存的是 `html()` —— chip 是真节点,token 原样挂在它身上。展开只发生在
   * 「交出去」这条路上,所以换一格会话回来它仍旧是一枚 chip。
   */
  it('存下来的稿里 token 一个字没变(展开只在交出去那条路上)', () => {
    const { api, box } = setup()
    put(box, '看看 @a')
    api().insert('file', { label: '@src/a.ts', tone: 'reference' }, { token: '{{file:/repo/src/a.ts}}' })
    expect(api().html()).toContain('{{file:/repo/src/a.ts}}')
    expect(box.querySelectorAll('[data-token]')).toHaveLength(1)
  })

  /**
   * 页面引用(浏览器叶那一枚)**不**在这里展开:那一页此刻长什么样只有发送的
   * 那一刻知道,物化仍归 `chat-port`。展开只认 `{{file:`。
   */
  it('`{{page:…}}` 原样交出去 —— 展开只认文件那一种', () => {
    const { api } = setup()
    api().appendReference('example.test', { token: '{{page:t1}}' })
    expect(api().text()).toBe('{{page:t1}} ')
  })
})

describe('回车与发送键读同一口草稿', () => {
  it('回车交出去的是 `text()`,不是 `textContent` —— chip 的位置不许在这条路上丢', () => {
    const { api, box, sent } = setup()
    put(box, '看看 @a')
    api().insert('file', { label: '@src/a.ts', tone: 'reference' }, { token: '{{file:/repo/src/a.ts}}' })

    // 屏幕上写的是 `@src/a.ts`(呈现),交出去的是那条绝对路径(位置)。
    expect(box.textContent).toContain('@src/a.ts')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['看看 @/repo/src/a.ts '])
  })

  it('幽灵占位也不走回车那条路出去', () => {
    const { api, box, sent } = setup()
    put(box, '/cd')
    api().insert('command', { label: '/cd', tone: 'token' }, { argHint: '<path>' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['/cd '])
  })
})
