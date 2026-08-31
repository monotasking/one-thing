import { create } from 'zustand'
import { baseNameOf, classifyFileFailure } from './files-source'
import type { FileFailure } from './files-source'
import { filesPort } from './files-port'
import {
  VIEWER_CHUNK_BYTES,
  VIEWER_OVERSIZE_BYTES,
  fileUrlOf,
  isMediaPath,
  isSvgPath,
  resolveViewerKind,
  viewerLangOf,
} from './viewer-kinds'

/**
 * **文件查看器的数据源**(F1)。全应用一个,与 `data/files-source.ts` **分家**。
 *
 * 分家不是分文件,是分事实:
 *  · files-source 说的是**目录的事实** —— 根在哪、这一层有哪些项、哪些展着;
 *  · viewer-source 说的是**一个文件的事实**,外加**看它的姿势**与**没存的改动**。
 * 两者谁都不认识对方的内部。它买到的是 §0 铁律 3 的结构保证:
 * **打开 / 切换一个文件是 viewer 的状态变化,永远不是文件树的重建。**
 *
 * ── 三块,各说各的 ───────────────────────────────────────────────────────
 *  ① `file` / `pending` —— **文件的事实**(读回来的是什么、手上有没有在飞的读);
 *  ② `view`             —— **看它的姿势**(折行 / 缩放 / 当前行 / 键位档);
 *  ③ `edit`             —— **没存的改动**(草稿、脏没脏、正在存没有)。
 *
 * ── ② 与 ③ 为什么在 store 里而不是在组件的 useState 里 ─────────────────────
 * 定稿的硬约束:「查看器状态住实例上,**切落点只换外框**」——同一份内容将来能被
 * 摆进七种落点(面板内 / 主区域 / 四边钉 / 浮窗),换落点时滚动位、折行、当前行、
 * 草稿都不许丢。落点一换,外框那棵组件树必然重建;状态若长在组件里,它就跟着没了。
 * 放进 store,落点就真的只是外框 —— F1 只接「面板内」一格,但骨架已经按七格建好,
 * F2 点亮别的落点时内核零改动。
 * (留账:**滚动位**今天还在 DOM 上,它跨落点的留存要等 F2 那个真会换宿主的场合
 *  才有产地 —— 现在存一个没人读的数字是假实现。)
 *
 * ── 竞速 ────────────────────────────────────────────────────────────────
 * 一个令牌管一条:连点三个文件,前两次的回执到达时令牌已经过期,直接丢弃 ——
 * 不许一份晚到的旧内容把新文件盖掉。
 */

/* ── ① 文件的事实 ──────────────────────────────────────────────────────── */

/**
 * 查看器手上这一份文件。**判别联合,不是一个带一堆空字段的结构**:消费方
 * `switch (file.kind)`,不会有「binary 却去读 content」这种半空对象
 * (同 file-icons 的 FileGlyph 判例)。
 *
 * `error` 是**第七种**,与六种查看形平级:读不到也是一种如实的呈现,
 * 不是别的型的一个失败标志位。
 */
export type ViewerFile =
  | {
      kind: 'code'
      path: string
      name: string
      /** 高亮语言;null = 这台不认识它,画素文本(不是错误)。 */
      lang: string | null
      content: string
      /** 文件真实字节数。 */
      size: number
      /** 这一次问后端要了多少字节 —— 「继续加载」的下一段从它算起。 */
      loaded: number
      /** 真实字节数 > 已要到的量 —— 屏幕上只是开头一段。 */
      truncated: boolean
      /** 盘上的时间戳。写回时当乐观锁用(缺席 = 后端没给,那就不加锁)。 */
      mtimeMs?: number
    }
  | {
      kind: 'markdown'
      path: string
      name: string
      content: string
      size: number
      loaded: number
      truncated: boolean
      mtimeMs?: number
    }
  | {
      kind: 'image'
      path: string
      name: string
      /** `<img>` 的 src(file:// —— 唯一产地是 fileUrlOf)。 */
      src: string
      /** svg 才有:它的那份源码,好让「源码 ⇄ 渲染」切得动。 */
      svgSource?: string
    }
  | {
      /** 播放条(**示例档**):视频与音频同一型,它们要的是同一件东西。 */
      kind: 'media'
      path: string
      name: string
      src: string
      /** 画 `<video>` 还是 `<audio>` —— 判据在这里定一次。 */
      audio: boolean
    }
  | {
      kind: 'binary'
      path: string
      name: string
      /** 后端给了就给,没给就缺席 —— **不拿 0 B 顶**。 */
      size?: number
    }
  | {
      kind: 'oversize'
      path: string
      name: string
      size: number
      /** 闸值,好让界面说得出「超过多少」。 */
      limit: number
    }
  | {
      kind: 'error'
      path: string
      name: string
      failure: FileFailure
      /** 后端原话。归类归类,原话原样。 */
      error?: string
    }

/** 能被写回去的那两种(编辑只对文本成立)。 */
export type EditableViewerFile = Extract<ViewerFile, { kind: 'code' | 'markdown' }>

export function isEditableFile(file: ViewerFile | null): file is EditableViewerFile {
  return file?.kind === 'code' || file?.kind === 'markdown'
}

/* ── ② 看它的姿势 ──────────────────────────────────────────────────────── */

export interface ViewerView {
  /** 代码折行。**跨文件保留** —— 「我习惯折着看」是一种手势偏好,不是这个文件的属性。 */
  wrap: boolean
  /** markdown / svg 的「源码 ⇄ 渲染」。换文件归零(它说的是上一个文件怎么看)。 */
  showSource: boolean
  /** 图的两档。换文件归零。 */
  zoomMode: 'fit' | 'actual'
  /** 自由缩放倍数(滚轮)。换文件归零。 */
  scale: number
  /** 当前行(1 基;0 = 还没落过点)。⌘L 跳转与状态栏那格读数共用它。 */
  currentLine: number
  /** 键位档 —— registerKeymap 那张表的键。 */
  keymap: string
  /** Vim 档的模式标(只在 keymap='vim' 时有意义)。 */
  vimMode: 'normal' | 'insert'
}

/* ── ③ 没存的改动 ──────────────────────────────────────────────────────── */

export interface ViewerEdit {
  /** 铅笔按下去了没有。 */
  editing: boolean
  /** 编辑区里此刻这份文本;null = 没进过编辑。 */
  draft: string | null
  /** 存盘在飞(所有异步钮要 pending 态,四律之一)。 */
  saving: boolean
  /** 上一次存盘的失败原话;成功后清空。 */
  error?: string
  /** 上一次存盘成功的时刻 —— 状态栏那一闪「已保存」读它。 */
  savedAt?: number
  /** 盘上被别人改过(乐观锁没对上)。它与普通失败是两句话。 */
  conflict: boolean
}

/** 有没有没存的改动。**判据只有一条**:草稿与手上这份内容不逐字相同。 */
export function isDirty(file: ViewerFile | null, edit: ViewerEdit): boolean {
  if (!isEditableFile(file) || edit.draft === null) return false
  return edit.draft !== file.content
}

export type SaveOutcome =
  | { ok: true }
  | { ok: false; reason: 'conflict' | 'failed' | 'not-editable'; error?: string }

export interface ViewerSourceState {
  /** 屏幕上此刻这一份;null = 查看器没开。 */
  file: ViewerFile | null
  /** 正在读的那条路径;null = 手上没有在飞的读。 */
  pending: string | null
  view: ViewerView
  edit: ViewerEdit

  /**
   * 打开一个文件。已经开着同一个、而且没有在飞的读 = 什么都不做
   * (再点一下同一行不该让屏幕闪一次)。要强制重读走 `reload`。
   */
  openFile(path: string): Promise<void>
  /** 重读当下这一份(内容可能在盘上变了)。没开就什么都不做。 */
  reload(): Promise<void>
  /** 再要一段(只有截断了的 code / markdown 有意义)。 */
  loadMore(): Promise<void>
  /** 关掉查看器。**它不问「存了没有」** —— 那是界面那一层的确认,不是数据的判断。 */
  close(): void

  /** 改一格看的姿势。 */
  setView(patch: Partial<ViewerView>): void
  /** 进 / 出编辑。进去时把手上这份内容抄成草稿;出来时丢掉草稿。 */
  setEditing(on: boolean): void
  /** 编辑区打字。 */
  setDraft(text: string): void
  /** ⌘S。走端口那条唯一的写口(它自带审计与回滚)。 */
  save(): Promise<SaveOutcome>

  /** 只给测试用:模块级 store 要能在用例之间归零。 */
  reset(): void
}

const EMPTY_VIEW: ViewerView = {
  wrap: false,
  showSource: false,
  zoomMode: 'fit',
  scale: 1,
  currentLine: 0,
  keymap: 'default',
  vimMode: 'normal',
}

const EMPTY_EDIT: ViewerEdit = {
  editing: false,
  draft: null,
  saving: false,
  error: undefined,
  savedAt: undefined,
  conflict: false,
}

/**
 * 换文件时**留下**哪几格。折行与键位档是「我习惯怎么看」,跟着人走;
 * 缩放 / 源码开关 / 当前行是「上一个文件怎么看」,跟着文件走 —— 所以它们归零。
 */
function viewForNextFile(view: ViewerView): ViewerView {
  return { ...EMPTY_VIEW, wrap: view.wrap, keymap: view.keymap }
}

export const useViewerSource = create<ViewerSourceState>()((set, get) => {
  let token = 0

  /**
   * 读一段并定型。`want` = 这一次要多少字节。
   *
   * 图与播放条在**调用它之前**就被岔开了:那两条路一个字节都不读。
   */
  async function read(path: string, want: number): Promise<ViewerFile> {
    const name = baseNameOf(path)
    const port = await filesPort()
    const response = await port.readContent(path, want)
    if (!response.success) {
      return {
        kind: 'error',
        path,
        name,
        failure: classifyFileFailure(response.error),
        error: response.error,
      }
    }
    const content = response.content ?? ''
    const size = response.size ?? content.length
    const kind = resolveViewerKind({
      path,
      size,
      isBinary: response.isBinary,
      content,
    })
    switch (kind) {
      case 'image':
        // 走到这里的只有 svg(位图在上游岔开了):它同时是图和一段源码。
        return { kind: 'image', path, name, src: fileUrlOf(path), svgSource: content }
      case 'media':
        return { kind: 'media', path, name, src: fileUrlOf(path), audio: isAudioPath(path) }
      case 'oversize':
        return { kind: 'oversize', path, name, size, limit: VIEWER_OVERSIZE_BYTES }
      case 'binary':
        return { kind: 'binary', path, name, size: response.size }
      case 'markdown':
        return {
          kind: 'markdown',
          path,
          name,
          content,
          size,
          loaded: want,
          truncated: size > want,
          mtimeMs: response.mtimeMs,
        }
      case 'code':
        return {
          kind: 'code',
          path,
          name,
          lang: viewerLangOf(path),
          content,
          size,
          loaded: want,
          truncated: size > want,
          mtimeMs: response.mtimeMs,
        }
    }
  }

  /** 一次打开 / 重读 / 续读共用的那条路:立令牌 → 读 → 令牌还在才换屏。 */
  async function run(path: string, want: number, keepView: boolean): Promise<void> {
    const mine = ++token
    set({ pending: path })
    const next = await read(path, want)
    if (token !== mine) return
    set((st) => ({
      file: next,
      pending: null,
      view: keepView ? st.view : viewForNextFile(st.view),
      // 续读(keepView)不碰编辑态:那是同一个文件的同一次编辑。
      edit: keepView ? st.edit : { ...EMPTY_EDIT },
    }))
  }

  return {
    file: null,
    pending: null,
    view: { ...EMPTY_VIEW },
    edit: { ...EMPTY_EDIT },

    openFile: async (path) => {
      if (!path) return
      const { file, pending } = get()
      if (pending === null && file?.path === path) return
      /*
       * 图与播放条不读字节:浏览器自己去取那条 file:// —— 把一张 8MB 的 png 按
       * utf-8 解码搬进渲染进程,得到的是一串必然乱码的字符,一点用都没有。
       * 于是这条路**同步就位**:没有 pending 那一帧,屏幕上直接换成它。
       */
      const direct = directFileOf(path)
      if (direct) {
        // 令牌照样往前走一格:上一次还在飞的那次读回来时必须被判过期,
        // 否则它会把这一份盖掉。
        token += 1
        set((st) => ({
          file: direct,
          pending: null,
          view: viewForNextFile(st.view),
          edit: { ...EMPTY_EDIT },
        }))
        return
      }
      await run(path, VIEWER_CHUNK_BYTES, false)
    },

    reload: async () => {
      const file = get().file
      if (!file) return
      if (directFileOf(file.path)) {
        // 图 / 播放条没有「读了多少」这回事;重取由浏览器自己管(留账:
        // 真要强制重取得给 src 挂一个查询串,那是缓存的把戏,F1 不做)。
        return
      }
      const want = 'loaded' in file ? file.loaded : VIEWER_CHUNK_BYTES
      await run(file.path, want, false)
    },

    loadMore: async () => {
      const file = get().file
      if (!file || !('loaded' in file) || !file.truncated) return
      // 续读是**同一个文件的同一次阅读**,所以看的姿势与编辑态原样留着。
      await run(file.path, file.loaded + VIEWER_CHUNK_BYTES, true)
    },

    close: () => {
      token += 1
      set((st) => ({
        file: null,
        pending: null,
        // 折行与键位档跟着人走,关一次窗不该把它们忘了。
        view: viewForNextFile(st.view),
        edit: { ...EMPTY_EDIT },
      }))
    },

    setView: (patch) => set((st) => ({ view: { ...st.view, ...patch } })),

    setEditing: (on) =>
      set((st) => ({
        edit: on
          ? {
              ...EMPTY_EDIT,
              editing: true,
              // 进编辑 = 把手上这份内容抄一份当草稿。抄不到(不是文本)就不进。
              draft: isEditableFile(st.file) ? st.file.content : null,
            }
          : { ...EMPTY_EDIT },
      })),

    setDraft: (text) => set((st) => ({ edit: { ...st.edit, draft: text } })),

    save: async () => {
      const { file, edit } = get()
      if (!isEditableFile(file) || edit.draft === null) {
        return { ok: false, reason: 'not-editable' }
      }
      const draft = edit.draft
      set((st) => ({ edit: { ...st.edit, saving: true, error: undefined, conflict: false } }))
      const port = await filesPort()
      const response = await port.saveContent(file.path, draft, file.mtimeMs)
      // 存盘期间用户可能已经切走了 —— 那就只收起 saving,不去改一份别人的内容。
      if (get().file?.path !== file.path) {
        set((st) => ({ edit: { ...st.edit, saving: false } }))
        return response.success ? { ok: true } : { ok: false, reason: 'failed', error: response.error }
      }
      if (!response.success) {
        const conflict = response.conflict === true
        set((st) => ({
          edit: { ...st.edit, saving: false, conflict, error: response.error },
        }))
        return { ok: false, reason: conflict ? 'conflict' : 'failed', error: response.error }
      }
      /*
       * 存成了:**手上这份内容就地换成草稿**,时间戳跟着后端给的走。
       * 不重读一遍盘 —— 刚写下去的就是这份字节,再读一次只是多一次往返,
       * 而且中间那一帧会让编辑区闪一下。
       */
      set((st) => ({
        file: st.file && isEditableFile(st.file)
          ? { ...st.file, content: draft, mtimeMs: response.mtimeMs ?? st.file.mtimeMs }
          : st.file,
        edit: { ...st.edit, saving: false, error: undefined, conflict: false, savedAt: Date.now() },
      }))
      return { ok: true }
    },

    reset: () => {
      token += 1
      set({ file: null, pending: null, view: { ...EMPTY_VIEW }, edit: { ...EMPTY_EDIT } })
    },
  }
})

/**
 * 「一个字节都不读」的那两种:位图与播放条。svg 不在其中 —— 它要读源码。
 * 回 null = 这条路径得走真读那一条。
 */
function directFileOf(path: string): ViewerFile | null {
  const name = baseNameOf(path)
  if (isMediaPath(path)) {
    return { kind: 'media', path, name, src: fileUrlOf(path), audio: isAudioPath(path) }
  }
  if (resolveViewerKind({ path }) === 'image' && !isSvgPath(path)) {
    return { kind: 'image', path, name, src: fileUrlOf(path) }
  }
  return null
}

/** 播放条那一型里,画 `<audio>` 的那一半。 */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'])

function isAudioPath(path: string): boolean {
  const name = baseNameOf(path)
  const at = name.lastIndexOf('.')
  return at > 0 && AUDIO_EXTS.has(name.slice(at + 1).toLowerCase())
}
