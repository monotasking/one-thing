// @vitest-environment happy-dom
/**
 * 两套编辑器内核的 **markdown 往返**。
 *
 * 纸的存储格式是纯 markdown —— AI 每回合读的就是它,文件工具改的也是它。编辑器
 * 只是它的一种呈现,在往返里改写了语法,用户就会看见自己的字被动过。
 *
 * 两套都钉:草稿纸跑 Tiptap(`editor/tiptap/`),笔记面板 / 工作台跑自研 PM 栈
 * (`editor/prose/`,TodoPlanPanel 与 EditorWorkbench 在用)。
 *
 * 钉的是**草稿纸真正会用到的那几种块**(PAD_FEATURES:标题 / 列表 / 勾选 /
 * 引用 / 代码块 / 分隔线 / 图片 / 行内强调),不是全部 markdown。
 */
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Markdown } from 'tiptap-markdown'
import { parseNoteMarkdown, serializeNoteMarkdown } from '../prose/markdown-io'

const SAMPLE = [
  '# 大标题',
  '',
  '## 次级标题',
  '',
  '随手写的一段,带 **粗体**、*斜体* 和 `行内代码`。',
  '',
  '- 无序一',
  '- 无序二',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '- [ ] 没做的',
  '- [x] 做完的',
  '',
  '> 引一段别人的话',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '---',
  '',
  '![](/store/scratchpads/images/pasted-1.png)',
  '',
].join('\n')

/** 空行数量与行尾空白不是内容 —— 比较前先归一。 */
function normalize(markdown: string): string {
  return markdown
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function tiptapRoundTrip(markdown: string, html = false): string {
  const editor = new Editor({
    content: markdown,
    extensions: [
      StarterKit,
      Markdown.configure({ html, tightLists: true, bulletListMarker: '-', breaks: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ inline: true, allowBase64: false }),
    ],
  })
  // tiptap-markdown 是运行时往 storage 里塞的一格,声明文件里没有它。
  const storage = editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  const result = storage.markdown.getMarkdown()
  editor.destroy()
  return result
}

function proseRoundTrip(markdown: string): string {
  return serializeNoteMarkdown(parseNoteMarkdown(markdown))
}

describe('编辑器 markdown 往返', () => {
  it('自研 PM 栈(笔记面板):逐块无损', () => {
    expect(normalize(proseRoundTrip(SAMPLE))).toBe(normalize(SAMPLE))
  })

  it('Tiptap:标题 / 列表 / 引用 / 代码块 / 分隔线全部原样回来', () => {
    const result = normalize(tiptapRoundTrip(SAMPLE))

    expect(result).toContain('# 大标题')
    expect(result).toContain('## 次级标题')
    expect(result).toContain('**粗体**')
    expect(result).toContain('`行内代码`')
    expect(result).toContain('- 无序一')
    expect(result).toContain('1. 有序一')
    expect(result).toContain('> 引一段别人的话')
    expect(result).toContain('```ts\nconst a = 1\n```')
    expect(result).toMatch(/^(---|\*\*\*|___)$/m)
  })

  it('Tiptap:勾选框保持 `- [ ]` / `- [x]`,而不是退化成普通列表', () => {
    const result = tiptapRoundTrip(SAMPLE)

    expect(result).toContain('[ ] 没做的')
    expect(result).toContain('[x] 做完的')
  })

  it('Tiptap:图片保住绝对路径 —— 显示时才换 dataUrl,存的仍是路径', () => {
    const result = tiptapRoundTrip(SAMPLE)

    expect(result).toContain('](/store/scratchpads/images/pasted-1.png)')
    expect(result).not.toContain('data:image')
  })

  it('Tiptap 连过两趟仍是同一份 —— 反复存取不漂移', () => {
    const once = tiptapRoundTrip(SAMPLE)
    const twice = tiptapRoundTrip(once)

    expect(normalize(twice)).toBe(normalize(once))
  })

  it('Tiptap:`<img width>` 进得去出不来 —— 图片宽度没有落脚的地方', () => {
    // 这条钉的是一个**已实测的否定结论**:图片宽度拖柄之所以不持久化,是因为
    // 就算开着 HTML 透传(生产配置是 html:false,这里特意开成 true 给它最好的
    // 机会),tiptap-markdown 的 image 序列化器也无条件写成 `![alt](src)`,
    // 宽度在往返里被丢掉。哪天它变了,这条会红 —— 那时才轮到重开这个决定。
    const result = tiptapRoundTrip('<img src="/a.png" width="480">', true)

    expect(result).toContain('](/a.png)')
    expect(result).not.toContain('width')
  })
})
