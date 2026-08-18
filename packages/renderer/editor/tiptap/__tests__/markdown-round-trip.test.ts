// @vitest-environment happy-dom
/**
 * 表格与 `==高亮==` 的 **markdown 往返**。
 *
 * 这是这两件功能的硬门,不是锦上添花的覆盖率:纸的存储格式就是 markdown,AI 每
 * 回合读的就是那份文件。一个只在编辑器里好看、存下去就变形(或者存得下、读回来
 * 少一层 mark)的块,等于在用户的纸上悄悄改字 —— 宁可不做。
 *
 * 所以每条都按"装载 → 序列化 → 再装载"两趟走:第一趟证明进得去出得来,第二趟
 * 证明它**稳定**(往返不是每存一次多一层转义、少一个空行)。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TiptapNoteEditor from '../TiptapNoteEditor.vue'

vi.mock('@/platform', () => ({
  platformApi: { resolveMarkdownAsset: vi.fn().mockResolvedValue({ success: false }) },
}))

const STUBS = { DragHandle: true, SlashMenu: true, Tooltip: true, Button: true }

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

async function mountEditor(markdown: string) {
  wrapper = mount(TiptapNoteEditor, {
    props: { modelValue: markdown, documentId: 'note-a' },
    global: { stubs: STUBS },
  })
  await nextTick()
  await nextTick()
  return wrapper
}

function markdownOf(pad: VueWrapper): string {
  return (pad.vm as unknown as { getValue: () => string }).getValue()
}

function setValue(pad: VueWrapper, markdown: string): void {
  ;(pad.vm as unknown as { setValue: (value: string) => void }).setValue(markdown)
}

/**
 * 一趟往返 + 一趟复读。
 *
 * 序列化器在文档末尾会补一个换行(closeBlock 的正常行为),所以比的是**去掉首尾
 * 空白之后**的正文;真正要钉的是"中间一个字都没变"以及"第二趟与第一趟逐字相同"。
 */
async function expectStableRoundTrip(source: string): Promise<string> {
  const pad = await mountEditor(source)
  const first = markdownOf(pad)
  expect(first.trim()).toBe(source.trim())

  setValue(pad, first)
  await nextTick()
  expect(markdownOf(pad)).toBe(first)
  return first
}

describe('表格 · markdown 往返', () => {
  it('GFM 管道表原样进、原样出,再装载一次也不变形', async () => {
    await expectStableRoundTrip(
      '| 名称 | 说明 |\n| --- | --- |\n| a | 一 |\n| b | 二 |',
    )
  })

  it('与纸上现有内容混排:标题 / 待办 / 代码块夹着表格,顺序与内容都不动', async () => {
    await expectStableRoundTrip([
      '# 本周',
      '',
      '- [ ] 先把表格接上',
      '',
      '| 项 | 状态 |',
      '| --- | --- |',
      '| 往返 | 通 |',
      '',
      '正文一句。',
      '',
      '```ts',
      'const a = 1',
      '```',
    ].join('\n'))
  })

  it('表头行是真的 th —— 序列化器只认这种表,认不出就退成 HTML(而我们 html: false)', async () => {
    const pad = await mountEditor('| 名称 | 说明 |\n| --- | --- |\n| a | 一 |')

    const surface = pad.find('.tiptap-note-surface')
    expect(surface.findAll('th')).toHaveLength(2)
    expect(surface.findAll('td')).toHaveLength(2)
  })

  it('斜杠菜单/命令面板插的那张表,落到纸上就是管道语法', async () => {
    const pad = await mountEditor('开头一句')

    ;(pad.vm as unknown as { applyCommand: (command: 'table') => void }).applyCommand('table')

    const markdown = markdownOf(pad)
    // 3 行 × 2 列带表头 = 表头行 + 分隔行 + 两行正文。
    expect(markdown).toContain('| --- | --- |')
    expect(markdown.split('\n').filter(line => line.startsWith('|'))).toHaveLength(4)
    expect(markdown).toContain('开头一句')
  })
})

describe('==高亮== · markdown 往返', () => {
  it('`==字==` 进得去也出得来,再装载一次也不变形', async () => {
    await expectStableRoundTrip('这里 ==重点== 一下,后面照旧。')
  })

  it('进来的时候真的成了一枚 mark,而不是四个等号的字面量', async () => {
    const pad = await mountEditor('这里 ==重点== 一下')

    const marks = pad.find('.tiptap-note-surface').findAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0].text()).toBe('重点')
  })

  /**
   * `parse.setup` 每次装载都会被调一遍,而给 markdown-it 装插件不是幂等的
   * (ruler 允许重名,只增不减)。反复换纸之后还认得出 `==` —— 钉的是那个记账。
   */
  it('反复装载(每次都会重跑 parse.setup)之后仍然只解析出一枚 mark', async () => {
    const pad = await mountEditor('这里 ==重点== 一下')

    for (let round = 0; round < 5; round += 1) {
      setValue(pad, `第 ${round} 版:==重点== 还在`)
      await nextTick()
    }

    expect(pad.find('.tiptap-note-surface').findAll('mark')).toHaveLength(1)
    expect(markdownOf(pad).trim()).toBe('第 4 版:==重点== 还在')
  })

  it('与别的行内标记混排,各自的语法互不吃掉', async () => {
    await expectStableRoundTrip('**粗** 与 ==高亮== 与 `代码` 与 *斜* 同一行。')
  })

  it('列表项、表格单元格里的高亮同样往返', async () => {
    await expectStableRoundTrip([
      '- 一条 ==要紧的== 事',
      '',
      '| 项 | 备注 |',
      '| --- | --- |',
      '| 往返 | ==通了== |',
    ].join('\n'))
  })
})

describe('换纸不丢内容', () => {
  /**
   * 切会话 = 换一张纸(`documentId` 变 → 整份 setContent + 清撤销栈)。切模式在宿主
   * 那边同样是换 `documentId` + `modelValue`,走的是同一条 watch。这里钉住:来回换
   * 一趟之后,表格与高亮都还是原来那份 markdown。
   */
  it('换到另一张纸再换回来,表格与高亮都还在', async () => {
    const source = '| 项 | 备注 |\n| --- | --- |\n| 往返 | ==通了== |'
    const pad = await mountEditor(source)

    await pad.setProps({ documentId: 'note-b', modelValue: '另一张纸' })
    expect(markdownOf(pad).trim()).toBe('另一张纸')

    await pad.setProps({ documentId: 'note-a', modelValue: source })
    expect(markdownOf(pad).trim()).toBe(source)
  })
})
