// @vitest-environment happy-dom
/**
 * 草稿纸编辑器的**按键出口**。
 *
 * 只钉一件事,但那件事踩过坑:宿主必须在 **PM 自己的 keymap 之前**看到按键。
 * `@tiptap/extension-hard-break` 绑了 `Mod-Enter`,如果宿主走 DOM 事件(keymap
 * 之后)才收到 ⌘⏎,那一下已经变成一个软换行了,"正式发出"永远等不到它。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TiptapNoteEditor from '../TiptapNoteEditor.vue'

vi.mock('@/platform', () => ({
  platformApi: { resolveMarkdownAsset: vi.fn().mockResolvedValue({ success: false }) },
}))

const STUBS = { DragHandle: true, SlashMenu: true }

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

/** 编辑器在 onMounted 里才建,EditorContent 还要一拍才把它的 DOM 挂进来。 */
async function mountEditor(markdown: string, onKeydown?: (event: KeyboardEvent) => void) {
  wrapper = mount(TiptapNoteEditor, {
    props: onKeydown ? { modelValue: markdown, onKeydown } : { modelValue: markdown },
    global: { stubs: STUBS },
  })
  await nextTick()
  await nextTick()
  return wrapper
}

function markdownOf(pad: VueWrapper): string {
  return (pad.vm as unknown as { getValue: () => string }).getValue()
}

/**
 * 打在 contenteditable 面上 —— PM 的 keydown 就挂在那里。
 *
 * 修饰键**用 Ctrl 而不是 ⌘**:prosemirror-keymap 的 `Mod` 是按平台解析的
 * (mac → Meta,其余 → Control),测试环境不是 mac,只有 Ctrl⏎ 才真的能让
 * HardBreak 的 keymap 响应 —— 而这条链路正是要钉的东西。宿主两个都认。
 */
function pressModEnter(pad: VueWrapper, modifier: 'ctrl' | 'meta' = 'ctrl'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: modifier === 'ctrl',
    metaKey: modifier === 'meta',
    bubbles: true,
    cancelable: true,
  })
  pad.find('.tiptap-note-surface').element.dispatchEvent(event)
  return event
}

describe('草稿纸编辑器 · ⌘⏎', () => {
  it('宿主先收到 ⌘⏎ —— 而不是在 HardBreak 把它吃成软换行之后', async () => {
    const pad = await mountEditor('一段话')

    pressModEnter(pad, 'meta')

    const events = pad.emitted('keydown') as [KeyboardEvent][] | undefined
    expect(events?.length).toBe(1)
    expect(events?.[0][0].key).toBe('Enter')
    expect(events?.[0][0].metaKey).toBe(true)
  })

  it('宿主吃掉了这一下(preventDefault),纸上就不该多出一个软换行', async () => {
    // 照悬浮垫的做法:⌘⏎ = 正式发出,当场 preventDefault。
    const pad = await mountEditor('一段话', event => event.preventDefault())

    pressModEnter(pad)

    expect(markdownOf(pad)).toBe('一段话')
  })

  it('宿主没管的话,⌘⏎ 仍然是 Tiptap 缺省的软换行 —— 这里不越权改缺省', async () => {
    const pad = await mountEditor('一段话')

    pressModEnter(pad)

    expect(markdownOf(pad)).not.toBe('一段话')
  })
})
