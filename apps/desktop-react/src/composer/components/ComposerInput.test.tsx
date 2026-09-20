import { createRef } from 'react'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import '../../references'
import { ComposerInput } from './ComposerInput'
import type { ComposerInputHandle } from './ComposerInput'
import { projectSegmentsToText } from '../../references/segment'
import type { ResolvedSegment } from '../../references/segment'

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
 * 今天是 `insert(kindId, ref, opts)`:第一个参数是注册表上的 id,第二个参数是
 * 那一种自述交出来的**那一枚引用本身**(`draft.toRef(hit)`)。
 *
 * ── 09-14 所见即所发:签名再换一次,断言**仍然**一条没动 ────────────────────
 * chip 不再由这只文件画(它是一枚空的宿主节点 + 一格 `createPortal`),记号也
 * 不再由调用方递进来 —— 由 `draft.token(ref)` 现算。所以:
 *  · `insert('command', {kind:'command', token:'/cd'})` 取代了从前那个
 *    `insert('command', {label:'/cd', tone:'token'}, {token})`;
 *  · 每一处调用包一层 `act()` —— 落一枚 chip 现在会改一格 React 状态(宿主节点表);
 *  · 每一条 `expect(api().text())` 逐字照旧。
 * 多出来的是**段那一半**:`segments()` 与 `text()` 互为投影(新增一节)。
 */

function setup() {
  const apiRef = createRef<ComposerInputHandle>()
  const sent: string[] = []
  const sentSegments: ResolvedSegment[][] = []
  const view = render(
    <ComposerInput
      apiRef={apiRef}
      placeholder="说点什么"
      picking={false}
      onToken={() => undefined}
      onMove={() => undefined}
      onPick={() => undefined}
      onEscape={() => undefined}
      onSend={(text, segments) => {
        sent.push(text)
        sentSegments.push(segments)
      }}
    />,
  )
  const box = view.getByTestId('composer-input')
  const api = () => apiRef.current as ComposerInputHandle
  /* 落一枚 chip 会改一格 React 状态(宿主节点表 → portal),所以包 act。 */
  const insert = (kindId: string, ref: unknown, opts?: { argHint?: string }) =>
    act(() => api().insert(kindId, ref, opts))
  return { api, insert, box, sent, sentSegments }
}

/** 一枚文件引用的 Ref(与 `references/kinds/file.ts` 的 `draft.toRef` 同形)。 */
const fileRef = (path: string) => ({ kind: 'fileRef', path })
/** 一条命令的 Ref(同 `kinds/command.ts`)。 */
const commandRef = (token: string) => ({ kind: 'command', token })

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
    const { api, insert, box } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'))

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
    const { api, insert, box } = setup()
    put(box, '/cd')
    // 光标放在 `/cd` 与后半截之间(模拟「打了一半又回头补全」)。
    const node = box.firstChild as Text
    node.textContent = '/cd 之后的话'
    const range = document.createRange()
    range.setStart(node, 3)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    insert('command', commandRef('/cd'))
    expect(api().text()).toBe('/cd  之后的话')
  })
})

describe('参数幽灵占位:画在屏幕上,不进草稿,打第一个字就散', () => {
  it('给了 argHint 就挂一枚 —— 屏幕上看得见,`text()` 里一个字都没有', () => {
    const { api, insert, box } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'), { argHint: '<path>' })

    expect(box.querySelector('[data-arg-ghost]')?.textContent).toBe('<path>')
    expect(box.textContent).toBe('/cd <path>')
    // 草稿里没有它 —— 发出去的那句话是 `/cd `,不是 `/cd <path>`。
    expect(api().text()).toBe('/cd ')
  })

  it('没给 argHint 就一枚都不挂(不收参数的命令)', () => {
    const { api, insert, box } = setup()
    put(box, '/compact')
    insert('command', commandRef('/compact'))
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/compact ')
  })

  it('打第一个字它就散', () => {
    const { api, insert, box } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'), { argHint: '<path>' })

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
    const { api, insert, box } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'), { argHint: '<path>' })

    const gap = box.querySelector('[data-arg-ghost]')?.previousSibling as Text
    gap.textContent = ''
    fireEvent.input(box)

    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd')
  })

  it('光标挪到别处去了(它前面那一节点不再是光标所在),也散', () => {
    const { api, insert, box } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'), { argHint: '<path>' })

    window.getSelection()?.removeAllRanges()
    fireEvent.input(box)
    expect(box.querySelector('[data-arg-ghost]')).toBeNull()
    expect(api().text()).toBe('/cd ')
  })

  it('铺回一份存下来的稿:幽灵占位不跟着回来(那句提示已经过期)', () => {
    const { api, insert, box } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'), { argHint: '<path>' })
    const saved = api().html()
    expect(saved).toContain('data-arg-ghost')

    act(() => api().restore(saved))
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
  /*
   * ── B2:线上那一形从 `@<绝对路径>` 换成了 `<ref type="file" …/>` ────────────
   * 判据换的是**出站**那一格(`kinds/file.ts` 的 `tag`),这只文件一个字都不认识
   * 它 —— 它量的仍旧是「交出去的是线上形、`{{file:` 一个都不漏」。旧那条 `@/abs`
   * 的**认出**半边照旧留着(旧账本要照画),所以这不是一次换语法,是出站换了写法。
   */
  it('`text()` 交出的是线上那条 `<ref/>`,一个 `{{file:` 都不许漏出去', () => {
    const { api, insert, box } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))

    /*
     * **屏幕上写的是 basename**(09-14 皮 B:chip 由 `render(ref)` 画,三个宿主
     * 同一形)。从前这里是 `@src/a.ts` —— 那是草稿自己那一份写法,而气泡里画的
     * 是 basename,同一枚引用两种形。这是本单**唯一**一处可感知的形变。
     */
    expect(box.textContent).toContain('a.ts')
    expect(box.textContent).not.toContain('@src/a.ts')
    expect(api().text()).toBe('看看 <ref type="file" path="/repo/src/a.ts"/> ')
    expect(api().text()).not.toContain('{{file:')
  })

  /**
   * 存草稿存的是 `html()` —— chip 是真节点,token 原样挂在它身上。展开只发生在
   * 「交出去」这条路上,所以换一格会话回来它仍旧是一枚 chip。
   */
  it('存下来的稿里 token 一个字没变(展开只在交出去那条路上)', () => {
    const { api, insert, box } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))
    expect(api().html()).toContain('{{file:/repo/src/a.ts}}')
    expect(box.querySelectorAll('[data-token]')).toHaveLength(1)
  })

  /**
   * 页面引用(浏览器叶那一枚)**不**在这里展开:那一页此刻长什么样只有发送的
   * 那一刻知道,物化仍归 `chat-port`。展开只认 `{{file:`。
   */
  it('`{{page:…}}` 原样交出去 —— 展开只认文件那一种', () => {
    const { api } = setup()
    act(() => api().appendReference('page', { kind: 'pageRef', tabId: 't1' }))
    expect(api().text()).toBe('{{page:t1}} ')
  })
})

describe('回车与发送键读同一口草稿', () => {
  it('回车交出去的是 `text()`,不是 `textContent` —— chip 的位置不许在这条路上丢', () => {
    const { insert, box, sent } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))

    // 屏幕上写的是 basename(呈现),交出去的是那条绝对路径(位置)。
    expect(box.textContent).toContain('a.ts')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['看看 <ref type="file" path="/repo/src/a.ts"/> '])
  })

  it('幽灵占位也不走回车那条路出去', () => {
    const { insert, box, sent } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'), { argHint: '<path>' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['/cd '])
  })
})

/* ── 段那一半(09-14,所见即所发;正本 §6.5)──────────────────────────────── */

describe('段是真相,文本是投影', () => {
  it('`text()` 逐字等于 `projectSegmentsToText(segments())`', () => {
    const { api, insert, box } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))
    /*
     * **反证锚点**:把 `text()` 改回自己走一遍 DOM(不经段),这一条就成了
     * 「两条路恰好同意」—— 那正是 09-14 之前草稿与气泡各算各的那个形。
     */
    expect(api().text()).toBe(projectSegmentsToText(api().segments()))
  })

  it('段里那一枚是**引用**不是几个字(文字 / 引用 / 文字 三段)', () => {
    const { api, insert, box } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))
    const segs = api().segments()
    expect(segs.map((seg) => seg.kindId)).toEqual([null, 'file', null])
    expect(segs[1].value).toEqual({ kind: 'fileRef', path: '/repo/src/a.ts' })
    // 文字段一个字不吃:前面那句话与 chip 后面那个空格都在。
    expect(segs[0].value).toEqual({ kind: 'text', text: '看看 ' })
    expect(segs[2].value).toEqual({ kind: 'text', text: ' ' })
  })

  it('幽灵占位不进段(它是画出来的一句提示,不是人写的字)', () => {
    const { api, insert, box } = setup()
    put(box, '/cd')
    insert('command', commandRef('/cd'), { argHint: '<path>' })
    expect(box.textContent).toBe('/cd <path>')
    expect(api().segments().map((seg) => seg.kindId)).toEqual(['command', null])
    expect(api().text()).toBe('/cd ')
  })

  it('`restore(html())` 往返:段一格不变,chip 仍是一枚 chip', () => {
    const { api, insert, box } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))
    const before = api().segments()
    const saved = api().html()

    act(() => api().clear())
    expect(api().segments()).toEqual([])

    act(() => api().restore(saved))
    expect(api().segments()).toEqual(before)
    expect(api().text()).toBe('看看 <ref type="file" path="/repo/src/a.ts"/> ')
    // 铺回来那一枚照样是宿主节点 + portal —— 屏幕上仍是 basename,不是几个字。
    expect(box.querySelectorAll('[data-ref]')).toHaveLength(1)
    expect(box.textContent).toContain('a.ts')
  })

  it('退格整枚删:宿主表当场同步,portal 不留在一个已经没了的节点上', () => {
    const { api, insert, box } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))
    expect(box.querySelectorAll('[data-ref]')).toHaveLength(1)
    expect(box.querySelector('[data-ref]')?.childNodes.length).toBeGreaterThan(0)

    // 浏览器把那枚 `contenteditable=false` 的节点整个删掉,然后发一发 input。
    box.querySelector('[data-ref]')?.remove()
    fireEvent.input(box)

    expect(box.querySelectorAll('[data-ref]')).toHaveLength(0)
    expect(api().segments().map((seg) => seg.kindId)).toEqual([null])
    expect(api().text()).toBe('看看  ')
  })

  it('`insert` 之后宿主节点里画的是 `ReferenceChip`(不是这只文件自己写的几个字)', () => {
    const { insert, box } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))
    const host = box.querySelector('[data-ref]') as HTMLElement
    // 宿主自己是空壳(`data-kind` / `data-ref` / `data-token` 三格),里面那一枚
    // 才是 chip —— 它报 `data-ref-kind`,那是 `render(ref)` 那张表上的一格。
    expect(host.dataset.kind).toBe('file')
    expect(host.querySelector('[data-ref-kind="fileRef"]')).toBeTruthy()
    // 可点 = 一枚真按钮(与气泡里那一枚逐字同一条判据)。
    expect(host.querySelector('button')).toBeTruthy()
  })

  it('onSend 交出去的是**同一次读取**的段与句子', () => {
    const { insert, box, sent, sentSegments } = setup()
    put(box, '看看 @a')
    insert('file', fileRef('/repo/src/a.ts'))
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['看看 <ref type="file" path="/repo/src/a.ts"/> '])
    expect(sentSegments[0].map((seg) => seg.kindId)).toEqual([null, 'file', null])
    expect(projectSegmentsToText(sentSegments[0])).toBe(sent[0])
  })
})
