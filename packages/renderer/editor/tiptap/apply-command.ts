/**
 * `MarkdownCommand` → Tiptap 链式命令的映射。
 *
 * ## 为什么是一张表而不是一个 if 树
 * 宿主(TodoPlanPanel 的命令面板与格式条、EditorWorkbench)只认识
 * `MarkdownDocumentEditorHandle.applyCommand(MarkdownCommand)` 这一个口子 ——
 * 那套词表是从「在 markdown 源码上做文本变换」的年代来的(`markdown-document.ts`
 * 的 `applyMarkdownCommand`)。Tiptap 这边不改字符串,改的是文档,所以两边只能
 * 在**命令名**上对齐,一条一条列出来。
 *
 * ## 缺席的命令一律优雅降级,不抛
 * 词表里有几条在当前扩展集里根本没有对应实现:`table`(没装
 * `@tiptap/extension-table`)、`image`(由宿主的文件选择框走落盘管线,不是一条
 * 编辑器命令)。链上调一个不存在的方法在 Tiptap 里是 `TypeError`,所以整条
 * 执行包在 try/catch 里 —— **命令不支持是一种正常结果,不是错误**:按钮点下去
 * 什么都不发生,而不是把宿主整棵树打崩。
 *
 * 返回值三态是给宿主看的,不是给用户看的:`delegated` 意味着"这条我不做,你做"
 * (目前只有 image),宿主据此打开文件选择框。
 */
import type { Editor } from '@tiptap/vue-3'
import type { MarkdownCommand } from '../markdown-document'

export type TiptapCommandOutcome = 'applied' | 'delegated' | 'unsupported'

type CommandRunner = (editor: Editor) => boolean

/**
 * 每条都写成"取链 → 聚焦 → 落命令 → run"。聚焦是必需的:命令面板/格式条按下去
 * 时焦点在按钮上,不先把选区还给编辑器,命令会作用在一个空选区上。
 */
const RUNNERS: Partial<Record<MarkdownCommand, CommandRunner>> = {
  'bold': editor => editor.chain().focus().toggleBold().run(),
  'italic': editor => editor.chain().focus().toggleItalic().run(),
  'strikethrough': editor => editor.chain().focus().toggleStrike().run(),
  'underline': editor => editor.chain().focus().toggleUnderline().run(),
  'inline-code': editor => editor.chain().focus().toggleCode().run(),
  'link': editor => editor.chain().focus().toggleLink({ href: 'https://' }).run(),
  'heading-1': editor => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  'heading-2': editor => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  'heading-3': editor => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  'bullet-list': editor => editor.chain().focus().toggleBulletList().run(),
  'ordered-list': editor => editor.chain().focus().toggleOrderedList().run(),
  'task-list': editor => editor.chain().focus().toggleTaskList().run(),
  'blockquote': editor => editor.chain().focus().toggleBlockquote().run(),
  'code-block': editor => editor.chain().focus().toggleCodeBlock().run(),
  'horizontal-rule': editor => editor.chain().focus().setHorizontalRule().run(),
}

export function applyTiptapMarkdownCommand(
  editor: Editor,
  command: MarkdownCommand,
): TiptapCommandOutcome {
  // 图片不是编辑器命令:它得先把文件落到纸旁边再插引用,那条管线在宿主手里。
  if (command === 'image') return 'delegated'
  const runner = RUNNERS[command]
  if (!runner) return 'unsupported'
  try {
    return runner(editor) ? 'applied' : 'unsupported'
  } catch {
    // 扩展没装 = 链上没有这个方法。这是配置事实,不是运行故障。
    return 'unsupported'
  }
}
