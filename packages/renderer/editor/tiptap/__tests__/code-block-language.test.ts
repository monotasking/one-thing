// @vitest-environment happy-dom
/**
 * 代码块的语言角标。
 *
 * 断言看的是 `pre` 上那个属性,不是画出来的字:角标本身是 CSS 的 `::after`
 * (`content: attr(data-language)`),测不到也不该测 —— 这里要钉的是**属性有没有
 * 挂到对的元素上**,以及"没有语言就不挂"(CSS 那条规则靠属性存在与否决定画不画,
 * 挂个空串会让空角标占住右上角)。
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
    props: { modelValue: markdown },
    global: { stubs: STUBS },
  })
  await nextTick()
  await nextTick()
  return wrapper
}

describe('代码块语言角标', () => {
  it('围栏上写了语言,pre 就带 data-language', async () => {
    const pad = await mountEditor('```ts\nconst a = 1\n```')

    const pre = pad.find('.tiptap-note-surface pre')
    expect(pre.attributes('data-language')).toBe('ts')
  })

  it('没写语言就不挂属性 —— 空角标比没有角标更糟', async () => {
    const pad = await mountEditor('```\nplain\n```')

    const pre = pad.find('.tiptap-note-surface pre')
    expect(pre.attributes('data-language')).toBeUndefined()
  })

  it('一篇里多个代码块各挂各的', async () => {
    const pad = await mountEditor('```ts\na\n```\n\n```python\nb\n```\n\n```\nc\n```')

    const languages = pad.findAll('.tiptap-note-surface pre')
      .map(pre => pre.attributes('data-language'))
    expect(languages).toEqual(['ts', 'python', undefined])
  })

  it('角标不进 markdown —— 它是装饰,不是内容', async () => {
    const pad = await mountEditor('```ts\nconst a = 1\n```')

    expect((pad.vm as unknown as { getValue: () => string }).getValue())
      .toBe('```ts\nconst a = 1\n```')
  })
})
