<template>
  <div
    ref="hostRef"
    class="tiptap-note-editor"
    :class="surfaceClass"
    :data-surface="surface"
    :data-source-mode="sourceMode ? 'source' : 'preview'"
  >
    <!-- 源码态是**只读**的一屏 markdown,不是第二个编辑器。理由见 script 里
         `sourceMode` 的注释:纸的存储格式就是 markdown,这里要的是"让我看一眼
         真正落盘的是什么",不是再开一条会与文档打架的编辑路径。 -->
    <Tooltip
      v-if="sourceToggle"
      :text="sourceMode ? '回到编辑' : '查看 Markdown 源码(只读)'"
      position="left"
    >
      <Button
        text
        class="tiptap-source-toggle"
        native-type="button"
        :aria-label="sourceMode ? 'Back to editing' : 'View markdown source'"
        :aria-pressed="sourceMode ? 'true' : 'false'"
        @mousedown.prevent
        @click.stop="toggleSourceMode"
      >
        <component
          :is="sourceMode ? Eye : Code2"
          :size="14"
        />
      </Button>
    </Tooltip>

    <pre
      v-if="sourceMode"
      class="tiptap-note-scroll tiptap-source-view"
    >{{ sourceText }}</pre>

    <EditorContent
      v-show="!sourceMode"
      class="tiptap-note-scroll"
      :editor="editor ?? undefined"
    />

    <!-- 块拖拽把手:官方 MIT 扩展(v3 起开源)。它自己 floating-ui 定位到当前
         悬停的块左侧,宿主只出图标与皮肤。 -->
    <DragHandle
      v-if="editor && !sourceMode"
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
 * 一处诚实的偏差:`getSelection()` / `findTextMatches()` 返回的是 **ProseMirror
 * 坐标**而不是 markdown 字符偏移(Tiptap 没有 offset-map 那样的换算表)。它们
 * 的消费者只有同一套坐标系里的 `replaceRange` / `setSelection`,成对使用自洽;
 * 把这些数字当字符偏移用是错的 —— 宿主要按 markdown 位置找东西,得让编辑器
 * 自己找(`findTextMatches`),不能自己 `indexOf`。
 *
 * 唯一跨坐标系的入口是 `consumedOffset`(markdown 字符偏移),换算在
 * `consumed-watermark.ts` 里显式做,精度只到块边界。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { Node as PMNode } from 'prosemirror-model'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Markdown } from 'tiptap-markdown'
import DragHandle from '@tiptap/extension-drag-handle-vue-3'
import { Code2, Eye, GripVertical } from 'lucide-vue-next'
import Button from '@/components/common/Button.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { markdownApi } from '@/platform/markdown-client'
import type { FloatingZLayer } from '@/composables/floating/useFloatingLayer'
import type { MarkdownAssetResolution } from '@shared/ipc/markdown'
import type { MarkdownCommand, MarkdownDocumentSurface, MarkdownFeatureSet } from '../markdown-document'
import type { EditorSelection as HandleSelection } from '../types'
import { insertMarkdownAttachmentFiles } from '../markdown-attachments'
import SlashMenu from '../slash/SlashMenu.vue'
import { useSlashMenu } from '../slash/useSlashMenu'
import type { SlashCommandId } from '../slash/slash-commands'
import { applyTiptapMarkdownCommand } from './apply-command'
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
  /**
   * 出不出「查看源码」那枚钮。缺省**不出** —— 草稿纸上没人要看源码,那是
   * 代码工作台里打开一个 `.md` 时才成立的需求。
   */
  sourceToggle?: boolean
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
  sourceToggle: false,
  slashZLayer: 'dropdown',
  slashZOffset: 0,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'keydown': [event: KeyboardEvent]
  'paste': [event: ClipboardEvent]
  /**
   * 光标动了。`line` 是**顶层块的序号**而不是 markdown 行号 —— 所见即所得的面
   * 上没有"源码行"这回事,一个块就是用户看到的一行/一段。状态栏拿它显示位置,
   * 语义上比硬换算出一个对不上的行号诚实。
   */
  'selectionUpdate': [info: { line: number, column: number }]
  'openImage': [payload: { src: string, alt: string, asset?: MarkdownAssetResolution | null }]
  'openLink': [payload: { href: string, asset?: MarkdownAssetResolution | null }]
}>()

const hostRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const editor = shallowRef<Editor | null>(null)
let lastEmitted = ''

/**
 * 源码态 —— **只读的一屏 markdown**,不是第二个可编辑面。
 *
 * 这是从 `MarkdownDocumentEditor`(CodeMirror 档)接过来的口子里,唯一一件
 * Tiptap 天生做不到的事:那一档的"源码模式"是把同一个 CodeMirror 的实时预览
 * 关掉,底下本来就是一份可编辑的源码;Tiptap 底下是文档树,markdown 只是
 * **存取格式**,并不存在一份可以直接编辑的源码缓冲。
 *
 * 硬造一个(textarea ↔ 文档双向同步)会立刻多出一条与文档打架的写路径 ——
 * 光标、撤销栈、外部变更三处都要各自对齐,而它服务的需求只是"让我看一眼真正
 * 落盘的是什么"。所以这里诚实地只做只读:看得见,改不了;要改就回编辑态。
 */
const sourceMode = ref(false)
const sourceText = ref('')
const surfaceClass = computed(() => (props.sourceToggle ? 'has-source-toggle' : ''))

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
  const response = await markdownApi.resolveAsset({
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

/**
 * 顶层块序号 + 块内偏移。见 `selectionUpdate` 的注释:这不是源码行列。
 *
 * 参数按**结构**收而不是收一个 `Editor`:生命周期回调递进来的是
 * `@tiptap/core` 的 Editor,而 `editor.value` 是 `@tiptap/vue-3` 的 —— 两者
 * 在类型上不互相赋值(vue 那个多几个响应式字段)。这里只用到一个 ResolvedPos。
 */
function cursorInfoAt(
  $from: { index: (depth: number) => number, parentOffset: number },
): { line: number, column: number } {
  return { line: $from.index(0) + 1, column: $from.parentOffset + 1 }
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
      emit('selectionUpdate', cursorInfoAt(instance.state.selection.$from))
    },
    onSelectionUpdate: ({ editor: instance }) => {
      syncSlash()
      emit('selectionUpdate', cursorInfoAt(instance.state.selection.$from))
    },
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
// MarkdownDocumentEditorHandle

function scroller(): HTMLElement | null {
  return hostRef.value?.querySelector('.tiptap-note-scroll') ?? null
}

function setSourceMode(enabled: boolean): void {
  const instance = editor.value
  if (enabled && instance) sourceText.value = markdownStorage(instance).getMarkdown()
  sourceMode.value = enabled
  if (!enabled) void nextTick(() => instance?.commands.focus())
}

function toggleSourceMode(): void {
  setSourceMode(!sourceMode.value)
}

const handle = {
  /**
   * 命令面板 / 格式条的唯一入口。映射表在 `apply-command.ts`;词表里没有对应
   * 实现的那几条(table)在那里静静降级 —— 点了不动,不炸。
   *
   * `image` 由这里接住:它不是编辑器命令,是"先落盘再插引用"的那条管线,
   * 与斜杠菜单的 `/图片` 走同一个文件选择框。
   */
  applyCommand: (command: MarkdownCommand) => {
    const instance = editor.value
    // 源码态是只读的:命令改不了一份看得见改不动的文本,静静吞掉比假装生效好。
    if (!instance || sourceMode.value) return
    if (applyTiptapMarkdownCommand(instance, command) === 'delegated') {
      fileInputRef.value?.click()
    }
  },
  setSourceMode,
  toggleSourceMode,
  getSourceMode: () => sourceMode.value,
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
  /**
   * 查找 —— 返回的是 **ProseMirror 位置**,与 `setSelection` 成对使用。
   *
   * 必须由编辑器自己来找,不能让宿主拿 markdown 原文去 `indexOf`:那串偏移
   * 与文档坐标不是同一套(`#` / `- [ ]` / `**` 在 markdown 里占位、在文档里
   * 不占),照着它选就会选到别处。搜的是**用户看得见的文字**,这也正是"查找"
   * 该有的语义。
   *
   * 一处诚实的边界:跨文本节点(一半在 `**粗**` 里、一半在外面)的匹配找不到。
   * 要覆盖它得把整篇拍平再反查位置,对一个查找框不值当。
   */
  findTextMatches: (query: string): HandleSelection[] => {
    const instance = editor.value
    const needle = query.trim().toLowerCase()
    if (!instance || !needle) return []
    const matches: HandleSelection[] = []
    instance.state.doc.descendants((node, pos) => {
      if (!node.isText) return true
      const text = (node.text ?? '').toLowerCase()
      let index = text.indexOf(needle)
      while (index !== -1) {
        const from = pos + index
        matches.push({ from, to: from + needle.length })
        index = text.indexOf(needle, index + Math.max(needle.length, 1))
      }
      return true
    })
    return matches
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

/* 源码钮浮在右上角:它是一个偶尔用一次的开关,不值得占一整条工具条。
   本地堆叠(个位数,不进层级表)—— 它只需要压过同一张纸上的正文。 */
.tiptap-source-toggle {
  position: absolute;
  top: 4px;
  right: 8px;
  z-index: 1;
}

/* 有钮时给正文让出右上角那一块,否则第一行标题会钻到钮底下。 */
.tiptap-note-editor.has-source-toggle .tiptap-note-scroll {
  padding-top: 4px;
}

.tiptap-source-view {
  margin: 0;
  padding: 12px 16px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--ui-text-muted-fg);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
</style>
