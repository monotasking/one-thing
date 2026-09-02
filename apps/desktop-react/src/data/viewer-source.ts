import { create } from 'zustand'
import { baseNameOf, classifyFileFailure } from './files-source'
import { filesPort } from './files-port'
import { createMutation } from './kernel/mutation'
import type { Mutation } from './kernel/mutation'
import { VIEWER_CHUNK_BYTES, isSvgPath, resolveViewerSpec, specOf, specOfPath } from './viewer-kinds'
import type { ViewerFile } from './viewer-kinds'

/**
 * 型的**形状**与**判据**都住 `data/viewer-kinds.ts`(09-01 搬家,理由写在那里:
 * 「加一型只动三处」)。这里只做四件与型无关的事:读、竞速、看的姿势、没存的改动。
 * 于是这个文件里**一个具体的型名都不出现** —— 加一型不必碰它。
 */
export type { ViewerFile } from './viewer-kinds'

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
 *
 * ── ④ 滚动位:F2 兑现了 F1 那条留账 ──────────────────────────────────────
 * F1 说「滚动位今天还在 DOM 上,它跨落点的留存要等 F2 那个真会换宿主的场合才有
 * 产地」。F2 就是那个场合:换落点会真的重挂那棵组件树,不存就真的丢。
 *
 * 它**故意不在 `view` 里**,而是自己一格顶层字段:`view` 是被整块订阅的
 * (`useViewerSource(st => st.view)`),把一个每帧都在变的数塞进去,等于让滚动
 * 重渲整块查看器。单独一格,而且没有任何组件订阅它 —— 写它不引起重渲,
 * 换落点后由新的那份在 `useLayoutEffect` 里 `getState()` 取一次贴回去。
 *
 * ── 竞速 ────────────────────────────────────────────────────────────────
 * 一个令牌管一条:连点三个文件,前两次的回执到达时令牌已经过期,直接丢弃 ——
 * 不许一份晚到的旧内容把新文件盖掉。
 */

/* ── ① 文件的事实 ──────────────────────────────────────────────────────── */

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
  /*
   * 从前这里有一格 `saving: boolean`。它**搬去了 `viewerSaveMutation`**(09-02 批 6):
   * 忙态是写路的事,而写路的产地是 `data/kernel` 的 createMutation ——
   * 「谁在写、写的是哪一格」由它按 `save:<path>` 逐格记(律③),界面读
   * `useAsyncPending(viewerSaveMutation, viewerSaveKey(path))`。
   * 留在这里的三格(error / savedAt / conflict)是**结论**不是忙态:它们在写完
   * 之后还要继续说话(状态栏那一闪「已保存」、撞车那一句警告),所以它们仍然
   * 是这个文件的可渲染状态。
   */
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
   * 身那块滚到哪儿了(像素)。**跨落点留存**的那一格 —— 理由与「为什么不在 view
   * 里」写在文件头 ④。换文件归零(那是上一个文件滚到哪儿)。
   */
  scrollTop: number

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
  /**
   * 记一下滚到哪儿了。**没有组件订阅 `scrollTop`**,所以这一口每帧调都不重渲 ——
   * 它只是把 DOM 上那个数抄进 store,好让换落点之后的新宿主贴得回去。
   */
  setScrollTop(top: number): void
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

/* ── ③' 存盘那一发:走 data/kernel 的写数原语 ───────────────────────────── */

/**
 * 这一发打在**哪一格**上。一个文件一格 —— 律③要的逐格 pending 就是这个键:
 * 同时开着两个查看器落点各存各的文件时,一颗钮忙不该把另一颗也按住。
 * 键的形照 `workspace/store.ts` 的 `workspaceKey`:一个函数,不是散在调用点的字符串。
 */
export const viewerSaveKey = (path: string): string => `save:${path}`

export interface ViewerSaveInput {
  path: string
  draft: string
  /** 乐观锁:手上这份内容读进来时盘上的时刻。 */
  mtimeMs: number | undefined
  /**
   * 这一发的**回执格**。`Mutation.run` 刻意不抛(失败已经在 onError 里处理完了,
   * 再抛一遍只会逼每个调用点写空 catch),它失败只回一个 `undefined` ——
   * 而 `save()` 的调用方要区分「撞车」与「没写成」这两句话。所以由 onError
   * 往这一格里写一次,`save()` 读它。
   *
   * 为什么不读 store 上那两格(edit.conflict / edit.error):**存盘期间用户可能
   * 已经切走了**,那一支按老规矩一个字都不往 store 上写(不去改一份别人的内容),
   * 于是从 store 读回来的会是「没失败」——一句假话。每发一格,顺带也不会有
   * 两个文件同时在存时互相读串的问题。
   */
  outcome: { conflict: boolean; error?: string }
}

export interface ViewerSaveDone {
  /** 后端写完之后盘上的新时刻;没给就沿用手上那一个。 */
  mtimeMs: number | undefined
}

/**
 * 「后端说没成」抛出来的那一发。照 `workspace/store.ts` 的 `WorkspaceWriteError`:
 * 后端原话**可能没有**,而 `Error.message` 会把「没有原话」变成空字符串 ——
 * 那两件事在状态栏里长得不一样(一条没有详情 vs 一条详情是空)。撞车那一格
 * 同理原样带着:它决定状态栏说「盘上被别人改过」还是照抄一句后端原话。
 */
class ViewerSaveError extends Error {
  readonly detail: string | undefined
  readonly conflict: boolean

  constructor(detail: string | undefined, conflict: boolean) {
    super(detail ?? 'save failed')
    this.name = 'ViewerSaveError'
    this.detail = detail
    this.conflict = conflict
  }
}

/**
 * 存盘的**唯一写口**。三格语义与从前那只手写状态机逐字相同:
 *  · 撞车(conflict)与普通失败是两句话 —— 前者说「盘上被别人改过」;
 *  · 失败原话照抄后端,渲染层不编一句更好听的;
 *  · 存成了就地把手上这份内容换成草稿并记下 `savedAt`(状态栏那一闪「已保存」),
 *    **不重读一遍盘** —— 刚写下去的就是这份字节,再读只是多一次往返,
 *    而且中间那一帧会让编辑区闪一下。
 *
 * 变的只有一件:忙态从 store 上一颗共享布尔换成了这只 mutation 按 key 记的账。
 */
export const viewerSaveMutation: Mutation<ViewerSaveInput, ViewerSaveDone> = createMutation<
  ViewerSaveInput,
  ViewerSaveDone
>('viewer.save', {
  key: (input) => viewerSaveKey(input.path),
  run: async (input) => {
    const port = await filesPort()
    const response = await port.saveContent(input.path, input.draft, input.mtimeMs)
    // 「后端说没成」与「这一发抛了」在这条原语里是同一件事:都得走 onError。
    if (!response.success) throw new ViewerSaveError(response.error, response.conflict === true)
    return { mtimeMs: response.mtimeMs }
  },
  settle: (result, input) => {
    // 存盘期间用户可能已经切走了 —— 那就什么都不做,不去改一份别人的内容。
    if (useViewerSource.getState().file?.path !== input.path) return
    useViewerSource.setState((st) => ({
      file:
        st.file && isEditableFile(st.file)
          ? { ...st.file, content: input.draft, mtimeMs: result.mtimeMs ?? st.file.mtimeMs }
          : st.file,
      edit: { ...st.edit, error: undefined, conflict: false, savedAt: Date.now() },
    }))
  },
  onError: (error, input) => {
    const failure = error instanceof ViewerSaveError ? error : undefined
    // 回执格**无条件**填:切走了也得让 save() 说得出这一发是撞车还是没写成。
    input.outcome.conflict = failure?.conflict ?? false
    input.outcome.error = failure ? failure.detail : error.message
    // 屏幕上那两格只在还停在这个文件上时才动 —— 与 settle 同一条判据。
    if (useViewerSource.getState().file?.path !== input.path) return
    useViewerSource.setState((st) => ({
      edit: { ...st.edit, conflict: input.outcome.conflict, error: input.outcome.error },
    }))
  },
})

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
      return specOf('error').build({
        path,
        name,
        content: '',
        size: 0,
        want,
        failure: classifyFileFailure(response.error),
        error: response.error,
      })
    }
    const content = response.content ?? ''
    const size = response.size ?? content.length
    /*
     * **定型与造型都归分型表**:这里一个 `case 'markdown'` 都没有,所以加一种型
     * 不必回来改这个 switch(从前有一个七支的 switch,那正是「加一型要动九处」
     * 里最容易漏的一处)。
     */
    return resolveViewerSpec({ path, size, isBinary: response.isBinary, content }).build({
      path,
      name,
      content,
      size,
      want,
      mtimeMs: response.mtimeMs,
    })
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
      // 续读也不碰滚动位 —— 「继续加载」之后屏幕该停在原地,不是弹回顶上。
      scrollTop: keepView ? st.scrollTop : 0,
    }))
  }

  return {
    file: null,
    pending: null,
    view: { ...EMPTY_VIEW },
    edit: { ...EMPTY_EDIT },
    scrollTop: 0,

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
          scrollTop: 0,
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
        scrollTop: 0,
      }))
    },

    setView: (patch) => set((st) => ({ view: { ...st.view, ...patch } })),

    setScrollTop: (top) => set({ scrollTop: top }),

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
      /*
       * 开一发之前先把**上一次的结论**清掉。这两格从前是跟着 `saving: true` 一起
       * 写的(同一句 set),忙态搬走之后它们留在这里 —— 清的时机一格没变:
       * 就在这一发出发之前,而不是等回执回来。
       */
      set((st) => ({ edit: { ...st.edit, error: undefined, conflict: false } }))
      const outcome: ViewerSaveInput['outcome'] = { conflict: false }
      const done = await viewerSaveMutation.run({
        path: file.path,
        draft: edit.draft,
        mtimeMs: file.mtimeMs,
        outcome,
      })
      if (done) return { ok: true }
      // 失败:mutation 不抛,结论从这一发自己的回执格里读(理由见 outcome 的注释)。
      return { ok: false, reason: outcome.conflict ? 'conflict' : 'failed', error: outcome.error }
    },

    reset: () => {
      token += 1
      set({ file: null, pending: null, view: { ...EMPTY_VIEW }, edit: { ...EMPTY_EDIT }, scrollTop: 0 })
    },
  }
})

/**
 * 「一个字节都不读」的那些:分型表里带 `direct` 标的行(今天是图与播放条)。
 * 回 null = 这条路径得走真读那一条。
 *
 * **判据不在这里** —— 它就是表上那一格 `direct`。svg 是个例外中的例外:它带
 * `direct` 标(位图那一行),但它同时要一份源码,所以它走真读那条路;
 * 那条岔口也在表上(`svgSource` 只在 content 非空时才有),不在这里。
 */
function directFileOf(path: string): ViewerFile | null {
  const spec = specOfPath(path)
  if (!spec.direct) return null
  if (spec.kind === 'image' && isSvgPath(path)) return null
  return spec.build({ path, name: baseNameOf(path), content: '', size: 0, want: 0 })
}
