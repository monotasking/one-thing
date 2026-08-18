// @vitest-environment happy-dom
/**
 * `MarkdownCommand` → Tiptap 的映射。
 *
 * 断言看的是**落盘的 markdown**,不是编辑器内部状态:纸的存储格式就是 markdown,
 * 命令生效与否唯一诚实的证据是那串字符变了没有。
 *
 * 另一半同样重要:词表里可能有条目在当前扩展集里没有实现。链上调一个不存在的方法
 * 在 Tiptap 里是 TypeError,所以那条链路要"点了不动、但不炸"(`table` 曾是这一档的
 * 样板,装了表格扩展之后转正 —— 它现在真的插一张表)。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TiptapNoteEditor from '../TiptapNoteEditor.vue'
import type { MarkdownCommand } from '../../markdown-document'

vi.mock('@/platform', () => ({
  platformApi: { resolveMarkdownAsset: vi.fn().mockResolvedValue({ success: false }) },
}))

const STUBS = { DragHandle: true, SlashMenu: true, Tooltip: true, Button: true }

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

interface NoteHandle {
  getValue: () => string
  applyCommand: (command: MarkdownCommand) => void
  setSelection: (from: number, to?: number) => void
  findTextMatches: (query: string) => Array<{ from: number, to: number }>
  getSourceMode: () => boolean
  toggleSourceMode: () => void
}

async function mountEditor(markdown: string) {
  wrapper = mount(TiptapNoteEditor, {
    props: { modelValue: markdown },
    global: { stubs: STUBS },
  })
  await nextTick()
  await nextTick()
  return wrapper.vm as unknown as NoteHandle
}

describe('applyCommand', () => {
  it('块命令改的是块本身', async () => {
    const handle = await mountEditor('随手记一句')

    handle.applyCommand('heading-2')
    expect(handle.getValue()).toBe('## 随手记一句')

    handle.applyCommand('heading-2')
    expect(handle.getValue()).toBe('随手记一句')

    handle.applyCommand('task-list')
    expect(handle.getValue()).toContain('- [ ] 随手记一句')
  })

  it('列表与引用都通到同一条链上', async () => {
    const handle = await mountEditor('一行字')

    handle.applyCommand('bullet-list')
    expect(handle.getValue()).toContain('- 一行字')

    handle.applyCommand('bullet-list')
    handle.applyCommand('blockquote')
    expect(handle.getValue()).toContain('> 一行字')
  })

  it('表格是真插一张(3×2 带表头),不再是静默降级', async () => {
    const handle = await mountEditor('原样')

    expect(() => handle.applyCommand('table')).not.toThrow()

    const markdown = handle.getValue()
    expect(markdown).toContain('| --- | --- |')
    expect(markdown).toContain('原样')
  })

  it('图片交给宿主的文件选择框,不是一条编辑器命令', async () => {
    const handle = await mountEditor('原样')
    const input = wrapper!.find('.tiptap-file-input').element as HTMLInputElement
    const click = vi.spyOn(input, 'click')

    handle.applyCommand('image')

    expect(click).toHaveBeenCalled()
    expect(handle.getValue()).toBe('原样')
  })

  it('源码态是只读的:命令进不去,内容不变', async () => {
    const handle = await mountEditor('原样')
    handle.toggleSourceMode()
    expect(handle.getSourceMode()).toBe(true)

    handle.applyCommand('heading-1')

    expect(handle.getValue()).toBe('原样')
  })
})

describe('findTextMatches', () => {
  /**
   * 查找必须由编辑器做:markdown 里的 `#` / `- [ ]` 占位、文档里不占,拿源码
   * 偏移去选会稳定地选到别处。这条测试就是钉这个差。
   */
  it('返回的是文档位置,不是 markdown 字符偏移', async () => {
    const handle = await mountEditor('# 标题\n\n找我')

    const matches = handle.findTextMatches('找我')

    expect(matches).toHaveLength(1)
    // markdown 里 '找我' 从第 7 个字符起(`# 标题\n\n`);文档里前面只有一个
    // 标题块,位置小得多。两者不同 —— 这正是不能用 indexOf 的理由。
    expect(matches[0].from).toBeLessThan('# 标题\n\n'.length)
  })

  it('中文照样命中,一段里出现两次就是两条', async () => {
    const handle = await mountEditor('今天修复中文输入,然后验证中文搜索。')

    expect(handle.findTextMatches('中文')).toHaveLength(2)
  })

  it('大小写不敏感', async () => {
    const handle = await mountEditor('Scratchpad 与 scratchpad')

    expect(handle.findTextMatches('SCRATCHPAD')).toHaveLength(2)
  })

  it('空查询没有匹配', async () => {
    const handle = await mountEditor('随便写点')

    expect(handle.findTextMatches('   ')).toEqual([])
  })
})
