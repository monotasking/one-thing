<template>
  <div
    ref="hostRef"
    class="tiptap-note-editor"
    :data-surface="surface"
  >
    <EditorContent
      class="tiptap-note-scroll"
      :editor="editor ?? undefined"
    />

    <!-- 块拖拽把手:官方 MIT 扩展(v3 起开源)。它自己 floating-ui 定位到当前
         悬停的块左侧,宿主只出图标与皮肤。 -->
    <DragHandle
      v-if="editor"
      :editor="editor"
      class="tiptap-drag-handle"
    >
      <GripVertical
        :size="14"
        :stroke-width="2"
      />
    </DragHandle>

    <SlashMenu
      :open="slash.open.value"
      :anchor="slash.anchor.value"
      :items="slash.items.value"
      :active-index="slash.activeIndex.value"
      :z-layer="slashZLayer"
      :z-offset="slashZOffset"
      @select="id => slash.commit(slash.items.value.findIndex(item => item.id === id))"
      @update:active-index="index => (slash.activeIndex.value = index)"
    />

    <!-- 斜杠菜单的「图片」走真实的文件选择框 → 与粘贴同一条落盘管线。 -->
    <input
      ref="fileInputRef"
      class="tiptap-file-input"
      type="file"
      accept="image/*"
      multiple
      @change="handleFilePick"
    >
  </div>
</template>

<script setup lang="ts">
/**
 * 草稿纸的编辑器(三档对比之后的终选:Tiptap)。
 *
 * 选它的理由就是它不自研:块交互(斜杠菜单 / 拖拽把手 / 逐块 placeholder)
 * 全部买现成的 —— StarterKit + 官方 DragHandle + Placeholder + tiptap-markdown
 * 原样用,宿主只接四处管线:图片解析、粘贴落盘、⌘⏎ 发送、已读水位线。
 *
 * markdown 是**存取格式**而不是内部表示(与 prose/markdown-io.ts 同一条纪律):
 * 存进纸里的仍然是 `- [ ]` / `![](绝对路径)` —— AI 每回合读的就是这份纯 markdown,
 * 所以编辑器不许往里塞任何只有自己看得懂的东西。
 *
 * 一处诚实的偏差:`getSelection()` 返回的是 **ProseMirror 坐标**而不是 markdown
 * 字符偏移(Tiptap 没有 offset-map 那样的换算表)。唯一的消费者是紧随其后的
 * `replaceRange`,两者成对使用、坐标系自洽;把这对数字当字符偏移用是错的。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { Node as PMNode } from 'prosemirror-model'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Markdown } from 'tiptap-markdown'
import DragHandle from '@tiptap/extension-drag-handle-vue-3'
import { GripVertical } from 'lucide-vue-next'
import { platformApi } from '@/platform'
import type { FloatingZLayer } from '@/composables/floating/useFloatingLayer'
import type { MarkdownAssetResolution } from '@shared/ipc/markdown'
import type { MarkdownDocumentSurface, MarkdownFeatureSet } from '../markdown-document'
import type { EditorSelection as HandleSelection } from '../types'
import { insertMarkdownAttachmentFiles } from '../markdown-attachments'
import SlashMenu from '../slash/SlashMenu.vue'
import { useSlashMenu } from '../slash/useSlashMenu'
import type { SlashCommandId } from '../slash/slash-commands'
import { consumedWatermarkKey, consumedWatermarkPlugin } from './consumed-watermark'
import '../notion/notion-prose.css'
import './tiptap-note-editor.css'

const props = withDefaults(defineProps<{
  modelValue: string
  surface?: MarkdownDocumentSurface
  documentId?: string
  documentPath?: string
  workspaceRoot?: string
  features?: MarkdownFeatureSet
  placeholder?: string
  spellcheck?: boolean
  /**
   * AI 已读末尾的 **markdown 字符偏移**(`null` = 还没有任何一版被消费过)。
   * 编辑器据此在块边界上画一条水位线,见 `consumed-watermark.ts`。
   */
  consumedOffset?: number | null
  /** 宿主所在的 z 档 —— 斜杠菜单要压过它。 */
  slashZLayer?: FloatingZLayer
  slashZOffset?: number
}>(), {
  surface: 'todo-notes',
  documentId: '',
  documentPath: '',
  workspaceRoot: '',
  features: undefined,
  placeholder: '',
  spellcheck: true,
  consumedOffset: null,
  slashZLayer: 'dropdown',
  slashZOffset: 0,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'keydown': [event: KeyboardEvent]
  'paste': [event: ClipboardEvent]
  'openImage': [payload: { src: string, alt: string, asset?: MarkdownAssetResolution | null }]
  'openLink': [payload: { href: string, asset?: MarkdownAssetResolution | null }]
}>()

const hostRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const editor = shallowRef<Editor | null>(null)
let lastEmitted = ''

interface MarkdownStorage {
  getMarkdown: () => string
  /** 与 `getMarkdown()` 同一套语法,但能序列化任意节点 —— 水位线换算要用它。 */
  serializer: { serialize: (content: PMNode) => string }
}

/**
 * `editor.storage` 的类型是各扩展 storage 的并集,而 tiptap-markdown 是运行时
 * 在 `onBeforeCreate` 里塞进去的(它自己的 `addStorage` 故意返回空对象),声明
 * 文件里没有这一格。收在一个函数里断言一次,别让 `as any` 散落四处。
 */
function markdownStorage(instance: { storage: unknown }): MarkdownStorage {
  return (instance.storage as { markdown: MarkdownStorage }).markdown
}

// ---------------------------------------------------------------------------
// 图片:src 留原样(markdown 要靠它往返),显示时才换成 dataUrl。

/** 拖到再窄也还看得出是张图。 */
const IMAGE_MIN_WIDTH = 80

/**
 * hover 才浮出的宽度拖柄。
 *
 * **宽度不持久化,这是实测之后的结论而不是偷懒。** 试过 tiptap-markdown 的 HTML
 * 透传(`Markdown.configure({ html: true })` + image 节点加一个 `width` 属性):
 * 进得去(`<img src width>` 解析出来 width 在节点上),出不来 —— 它的 image
 * 序列化器无条件写成 `![alt](src)`,宽度在往返里被丢掉。而纸的存储格式**必须**
 * 是纯 markdown(AI 每回合读的就是这份文件),所以宽度没有能落脚的地方。要留住
 * 它得先定一个存储格式扩展(`![](src "=480")` 之类),那是一个另开的决定。
 * 这里只做手感:拖得动、松手即生效、重新装载回到原尺寸。
 */
function attachWidthGrip(dom: HTMLElement): void {
  const grip = document.createElement('span')
  grip.className = 'tiptap-image-grip'
  grip.contentEditable = 'false'
  grip.setAttribute('aria-hidden', 'true')
  dom.append(grip)

  grip.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const img = dom.querySelector('img')
    if (!img) return
    const startX = event.clientX
    const startWidth = img.getBoundingClientRect().width
    const move = (moveEvent: MouseEvent) => {
      const next = Math.max(startWidth + (moveEvent.clientX - startX), IMAGE_MIN_WIDTH)
      img.style.width = `${Math.round(next)}px`
      // 高度上限是给"没拖过"的图定的,一旦用户自己定了宽就该让位。
      img.style.maxHeight = 'none'
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
}

async function resolveImageSrc(rawSrc: string): Promise<string | null> {
  if (/^(?:https?:|data:)/i.test(rawSrc)) return rawSrc
  if (!props.documentPath) return null
  const response = await platformApi.resolveMarkdownAsset({
    documentPath: props.documentPath,
    workspaceRoot: props.workspaceRoot,
    rawTarget: rawSrc,
  })
  return response.success ? response.asset?.dataUrl || null : null
}

const ResolvedImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.className = 'tiptap-image is-loading'
      const img = document.createElement('img')
      const rawSrc = String(node.attrs.src || '')
      const alt = String(node.attrs.alt || '')
      img.alt = alt
      img.draggable = false
      img.addEventListener('click', (event) => {
        event.preventDefault()
        emit('openImage', { src: img.src, alt })
      })
      dom.append(img)
      attachWidthGrip(dom)
      void resolveImageSrc(rawSrc).then((resolved) => {
        dom.classList.remove('is-loading')
        if (resolved) img.src = resolved
        // 解析不出来时保留一行可读的字,而不是一个碎图标。
        else dom.replaceChildren(document.createTextNode(alt || rawSrc))
      })
      return { dom, ignoreMutation: () => true }
    }
  },
})

// ---------------------------------------------------------------------------
// 斜杠菜单

const slash = useSlashMenu({
  apply: (id, query) => applySlashCommand(id, query),
})

/** 光标所在块内、光标之前的那一段文字(判 `/` 触发词只需要这一段)。 */
function textBeforeCursor(instance: Editor): string {
  const { $from } = instance.state.selection
  return instance.state.doc.textBetween($from.start(), $from.pos, '\n', '\n')
}

function cursorPoint(instance: Editor): { x: number, y: number } {
  const coords = instance.view.coordsAtPos(instance.state.selection.from)
  return { x: coords.left, y: coords.bottom }
}

function syncSlash(): void {
  const instance = editor.value
  if (!instance || instance.isDestroyed) return
  slash.sync(textBeforeCursor(instance), cursorPoint(instance))
}

function applySlashCommand(id: SlashCommandId, query: string): void {
  const instance = editor.value
  if (!instance) return
  // `/` 加过滤词那几个字先删掉,再落块 —— 否则块里会留一段 "/引用"。
  const to = instance.state.selection.from
  const from = Math.max(to - query.length - 1, 0)
  const chain = instance.chain().focus().deleteRange({ from, to })

  if (id === 'heading-1') chain.setNode('heading', { level: 1 }).run()
  else if (id === 'heading-2') chain.setNode('heading', { level: 2 }).run()
  else if (id === 'heading-3') chain.setNode('heading', { level: 3 }).run()
  else if (id === 'bullet-list') chain.toggleBulletList().run()
  else if (id === 'ordered-list') chain.toggleOrderedList().run()
  else if (id === 'task-list') chain.toggleTaskList().run()
  else if (id === 'blockquote') chain.toggleBlockquote().run()
  else if (id === 'code-block') chain.toggleCodeBlock().run()
  else if (id === 'horizontal-rule') chain.setHorizontalRule().run()
  else if (id === 'image') {
    chain.run()
    fileInputRef.value?.click()
  }
}

async function handleFilePick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  await insertMarkdownAttachmentFiles({
    files,
    editor: handle,
    documentPath: props.documentPath,
    workspaceRoot: props.workspaceRoot,
  })
}

// ---------------------------------------------------------------------------

function buildEditor(): Editor {
  const features = props.features
  return new Editor({
    content: props.modelValue,
    extensions: [
      StarterKit.configure({
        codeBlock: features?.codeBlocks === false ? false : undefined,
        // 纸上的换行就是换行 —— markdown 的"两个空格才换行"在草稿里是反直觉的。
        hardBreak: { keepMarks: false },
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: '-',
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      TaskList,
      // `- [ ]` 的往返靠它 —— tiptap-markdown 的 markdown-it 侧装了 task-lists 插件。
      TaskItem.configure({ nested: true }),
      ResolvedImage.configure({ inline: true, allowBase64: false }),
      Placeholder.configure({
        showOnlyCurrent: false,
        placeholder: ({ pos, hasAnchor }) => {
          if (pos === 0) return props.placeholder || '随手写,AI 会看见'
          return hasAnchor ? '输入 / 唤出块菜单' : ''
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-note-surface notion-prose',
        spellcheck: props.spellcheck ? 'true' : 'false',
      },
      /**
       * 斜杠菜单**和宿主**都必须比 PM 自己的 keymap 先看到按键:方向键/回车会
       * 先被菜单以外的 `splitListItem` 切块,而 **⌘⏎ 会先被 HardBreak 吃成一个
       * 软换行**(`@tiptap/extension-hard-break` 绑了 `Mod-Enter`)—— 宿主的
       * "正式发出"就再也等不到它了。`EditorView.someProp` 先查 view 自己的
       * props、再查插件,所以这两个钩子只能挂在这里,不能走 DOM 事件(那是
       * keymap 之后)。
       *
       * 宿主吃掉了(`preventDefault()`)就返回 true,PM 与其后的 keymap 都不再看。
       */
      handleKeyDown: (_view, event) => {
        if (slash.handleKeydown(event)) return true
        emit('keydown', event)
        return event.defaultPrevented
      },
    },
    onUpdate: ({ editor: instance }) => {
      const markdown = markdownStorage(instance).getMarkdown()
      if (markdown !== lastEmitted) {
        lastEmitted = markdown
        emit('update:modelValue', markdown)
      }
      syncSlash()
    },
    onSelectionUpdate: syncSlash,
    onBlur: () => slash.close(),
  })
}

/**
 * 已读水位线挂在编辑器建好**之后** —— 它要的序列化器是 tiptap-markdown 在
 * `onBeforeCreate` 里塞进 storage 的,建构期的扩展列表里够不着。
 */
function installWatermark(instance: Editor): void {
  instance.registerPlugin(consumedWatermarkPlugin({
    getOffset: () => props.consumedOffset ?? null,
    serialize: doc => markdownStorage(instance).serializer.serialize(doc),
  }))
}

/**
 * 让水位线重算一次。空事务(不改文档)—— Tiptap 只在 `docChanged` 时发 update,
 * 所以这一发不会被误当成"用户改了纸"。
 */
function refreshWatermark(): void {
  const instance = editor.value
  if (!instance || instance.isDestroyed) return
  instance.view.dispatch(instance.state.tr.setMeta(consumedWatermarkKey, true))
}

watch(() => props.consumedOffset, refreshWatermark)

function handleDomPaste(event: ClipboardEvent): void {
  emit('paste', event)
}

onMounted(() => {
  lastEmitted = props.modelValue
  const instance = buildEditor()
  editor.value = instance
  instance.view.dom.addEventListener('paste', handleDomPaste)
  installWatermark(instance)
})

onBeforeUnmount(() => {
  const instance = editor.value
  if (!instance) return
  instance.view.dom.removeEventListener('paste', handleDomPaste)
  instance.destroy()
  editor.value = null
})

// 换会话 = 换一张纸:整份重置(含撤销历史),undo 不许走回上一张纸。
watch(() => props.documentId, () => {
  const instance = editor.value
  if (!instance) return
  lastEmitted = props.modelValue
  instance.commands.setContent(props.modelValue)
})

// 同一张纸的外部变更(AI 用文件工具改了它 / 别的窗口写了它)。
watch(() => props.modelValue, (value) => {
  const instance = editor.value
  if (!instance || value === lastEmitted) return
  if (markdownStorage(instance).getMarkdown() === value) {
    lastEmitted = value
    return
  }
  lastEmitted = value
  instance.commands.setContent(value)
})

// ---------------------------------------------------------------------------
// EditorHandle(够 markdown-attachments 与悬浮垫用的那一面)

function scroller(): HTMLElement | null {
  return hostRef.value?.querySelector('.tiptap-note-scroll') ?? null
}

const handle = {
  focus: () => editor.value?.commands.focus(),
  blur: () => editor.value?.commands.blur(),
  getValue: () => (editor.value ? markdownStorage(editor.value).getMarkdown() : props.modelValue),
  setValue: (value: string) => {
    lastEmitted = value
    editor.value?.commands.setContent(value)
  },
  getSelectedText: (): string => {
    const instance = editor.value
    if (!instance) return ''
    const { from, to } = instance.state.selection
    return instance.state.doc.textBetween(from, to, '\n')
  },
  getSelection: (): HandleSelection => {
    const instance = editor.value
    if (!instance) return { from: 0, to: 0 }
    return { from: instance.state.selection.from, to: instance.state.selection.to }
  },
  setSelection: (from: number, to?: number) => {
    editor.value?.commands.setTextSelection({ from, to: to ?? from })
  },
  replaceRange: (from: number, to: number, text: string) => {
    editor.value?.chain().focus().insertContentAt({ from, to }, text).run()
  },
  scrollToTop: () => scroller()?.scrollTo({ top: 0 }),
  getScrollTop: () => scroller()?.scrollTop ?? 0,
  setScrollTop: (scrollTop: number) => {
    const element = scroller()
    if (element) element.scrollTop = scrollTop
  },
  getCursorLineInfo: () => {
    const instance = editor.value
    if (!instance) return { lineNumber: 1, totalLines: 1, from: 0, to: 0, text: '' }
    const { $from } = instance.state.selection
    return {
      lineNumber: $from.index(0) + 1,
      totalLines: Math.max(instance.state.doc.childCount, 1),
      from: $from.start(),
      to: $from.end(),
      text: $from.parent.textContent,
    }
  },
}

defineExpose(handle)
</script>

<style scoped>
.tiptap-note-editor {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tiptap-note-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* 文件选择框永远不该被看见 —— 它只是 `/图片` 的一个触发器。 */
.tiptap-file-input {
  display: none;
}
</style>
