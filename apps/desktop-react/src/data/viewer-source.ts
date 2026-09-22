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
 * **文件查看器的数据源**(F1;W1 改成多实例)。与 `data/files-source.ts` **分家**。
 *
 * 分家不是分文件,是分事实:
 *  · files-source 说的是**目录的事实** —— 根在哪、这一层有哪些项、哪些展着;
 *  · viewer-source 说的是**一个文件的事实**,外加**看它的姿势**与**没存的改动**。
 * 两者谁都不认识对方的内部。它买到的是 §0 铁律 3 的结构保证:
 * **打开 / 切换一个文件是 viewer 的状态变化,永远不是文件树的重建。**
 *
 * ── W1:从「全应用一份」改成「按路径各持一份」──────────────────────────
 * 查看器从 Dock 上一块瓦降格为 `file` 这**一种内容**(`workbench/kinds.ts`),
 * 而一种内容可以有很多实例:一个文件一个 tab、几开几个。于是从前那三块顶层
 * 字段(`file` / `pending` / `view` / `edit`)整体搬进 `instances[path]`,
 * `FileViewer` 收 `path` 而不是读全局。
 *
 * 两件事因此变了,各有各的产地:
 *  · **「我习惯怎么看」那两格**(折行 / 键位档)从前靠 `viewForNextFile` 在换文件
 *    那一次 set 里抄过去;实例分家之后「换文件」不再是一次 set,所以它们进了
 *    `prefs`(跨实例的偏好),新实例出生时读它。
 *  · **隐藏的 tab 实例留着,关闭的 `dispose`**(设计 §2.3 那张表的数据侧)。
 *
 * ── 三块,各说各的 ───────────────────────────────────────────────────────
 *  ① `file` / `pending` —— **文件的事实**(读回来的是什么、手上有没有在飞的读);
 *  ② `view`             —— **看它的姿势**(折行 / 缩放 / 当前行 / 键位档);
 *  ③ `edit`             —— **没存的改动**(草稿、脏没脏、正在存没有)。
 *
 * ── ② 与 ③ 为什么在 store 里而不是在组件的 useState 里 ─────────────────────
 * 定稿的硬约束:「查看器状态住实例上,**切落点只换外框**」——同一份内容能被摆进
 * 好几种宿主(面板内 / 中央叶 / 将来的架子与浮窗),换宿主时滚动位、折行、当前行、
 * 草稿都不许丢。宿主一换,外框那棵组件树必然重建;状态若长在组件里,它就跟着没了。
 *
 * ── ④ 滚动位:自己一张表 ────────────────────────────────────────────────
 * 它**故意不在 `ViewerInstance` 里**:实例是被整块订阅的
 * (`useViewerInstance(path)`),把一个每帧都在变的数塞进去,等于让滚动重渲整块
 * 查看器。单独一张 `scrolls` 表,而且没有任何组件订阅它 —— 写它不引起重渲,
 * 换宿主后由新的那一份在 `useLayoutEffect` 里 `getState()` 取一次贴回去。
 *
 * ── 竞速 ────────────────────────────────────────────────────────────────
 * **一条路径一个令牌**(从前是全局一个)。同时开着两个文件时,A 的晚到回执
 * 不该被 B 的读作废,也不该盖掉 A 自己后来的那一发。
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
  /** markdown / svg 的「源码 ⇄ 渲染」。每一份实例自己一格(它说的是这个文件怎么看)。 */
  showSource: boolean
  /** 图的两档。 */
  zoomMode: 'fit' | 'actual'
  /** 自由缩放倍数(滚轮)。 */
  scale: number
  /** 当前行(1 基;0 = 还没落过点)。⌘L 跳转与状态栏那格读数共用它。 */
  currentLine: number
  /** 键位档 —— registerKeymap 那张表的键。**跨文件保留**。 */
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
   * 留在这里的三格(error / savedAt / conflict)是**结论**不是忙态。
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

/**
 * **一份文件的实例**(W1)。三块与从前逐字相同,变的只有「一份」→「一路径一份」。
 * 滚动位不在这里(见文件头 ④)。
 */
export interface ViewerInstance {
  file: ViewerFile | null
  pending: string | null
  view: ViewerView
  edit: ViewerEdit
}

/**
 * 「我习惯怎么看」那两格 —— **跟着人走,不跟着文件走**。新实例出生时读它,
 * `setView` 改到这两格时同步写回(单产地:两处都读这一格,不会分叉)。
 */
export interface ViewerPrefs {
  wrap: boolean
  keymap: string
}

export interface ViewerSourceState {
  /**
   * 按路径各持一份。**隐藏的 tab 实例留着**(草稿、滚动位、视图设置全在),
   * 关闭的实例由 `dispose(path)` 丢掉 —— 设计 §2.3 那张「隐藏 vs 关闭」表的
   * 数据侧就是这一句。
   */
  instances: Record<string, ViewerInstance>
  /** 每一份滚到哪儿了(像素)。没有订阅者,写它不重渲(见文件头 ④)。 */
  scrolls: Record<string, number>
  prefs: ViewerPrefs

  /**
   * 打开一个文件。已经有实例、而且没有在飞的读 = 什么都不做
   * (再点一下同一行不该让屏幕闪一次)。要强制重读走 `reload`。
   */
  openFile(path: string): Promise<void>
  /**
   * **确保这一份有内容**(09-22)。手上已经有内容、或者已经有一发在飞 = 什么都不做。
   *
   * ── 它治的是什么 ──────────────────────────────────────────────────────
   * 「把一份文件摆到某处」与「把它的字节读回来」本来是两件事,而从前只有**一条**
   * 路把两件接起来(`content/viewer/open-target.openFileAt`:树上点一行)。于是
   * 每一条只摆位置的路 —— 从文件树拖一行到别人的标签条上、重启之后按落盘的树把
   * 标签恢复回来 —— 摆出来的都是一格**空查看器**,屏幕上写着「还没有打开的文件」。
   *
   * 修法不是去那几条路上各补一句读(那是「按入口枚举」,下一条路照样会漏),
   * 而是让**内容自己把自己读回来**:查看器一挂上来就问这一口。摆位置的那些路
   * 从此一个字都不必知道「读」这回事。
   */
  ensureFile(path: string): Promise<void>
  /**
   * 重读这一份(内容可能在盘上变了)——「刷新」那颗钮唯一的写口。没有实例就什么都不做。
   *
   * **它不碰草稿、不碰滚动位**:刷新说的是「把盘上最新的拿过来」,而用户正编着的
   * 那份草稿是他自己的东西,屏幕停在哪儿也是。草稿与新内容不一样时它照旧算「脏」
   * —— 那正是实话(你手上这份与盘上那份不同了)。
   */
  reload(path: string): Promise<void>
  /** 再要一段(只有截断了的 code / markdown 有意义)。 */
  loadMore(path: string): Promise<void>
  /**
   * **丢掉这一份实例**(关闭,不是隐藏)。它不问「存了没有」——
   * 那是界面那一层的确认(`ContentKind.beforeClose`),不是数据的判断。
   */
  dispose(path: string): void

  /** 改一格看的姿势。`wrap` / `keymap` 顺带写进 `prefs`(它们跟着人走)。 */
  setView(path: string, patch: Partial<ViewerView>): void
  /** 记一下滚到哪儿了。没有订阅者,所以每帧调都不重渲。 */
  setScrollTop(path: string, top: number): void
  /** 进 / 出编辑。进去时把手上这份内容抄成草稿;出来时丢掉草稿。 */
  setEditing(path: string, on: boolean): void
  /** 编辑区打字。 */
  setDraft(path: string, text: string): void
  /** ⌘S。走端口那条唯一的写口(它自带审计与回滚)。 */
  save(path: string): Promise<SaveOutcome>

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
 * 「还没有这一份」时交出去的那一份。**模块级常量**(不是现造的对象):
 * `useViewerInstance` 是一只 zustand 选择器,每次现造一个新对象会让
 * `useSyncExternalStore` 认为「值变了」而无限重渲。
 */
export const EMPTY_VIEWER_INSTANCE: ViewerInstance = Object.freeze({
  file: null,
  pending: null,
  view: EMPTY_VIEW,
  edit: EMPTY_EDIT,
})

/** 一份新实例的出厂形:两格偏好跟着人走,其余归零。 */
function freshInstance(prefs: ViewerPrefs): ViewerInstance {
  return {
    file: null,
    pending: null,
    view: { ...EMPTY_VIEW, wrap: prefs.wrap, keymap: prefs.keymap },
    edit: { ...EMPTY_EDIT },
  }
}

/* ── ③' 存盘那一发:走 data/kernel 的写数原语 ───────────────────────────── */

/**
 * 这一发打在**哪一格**上。一个文件一格 —— 律③要的逐格 pending 就是这个键:
 * 同时开着两份查看器各存各的文件时,一颗钮忙不该把另一颗也按住。
 */
export const viewerSaveKey = (path: string): string => `save:${path}`

export interface ViewerSaveInput {
  path: string
  draft: string
  /** 乐观锁:手上这份内容读进来时盘上的时刻。 */
  mtimeMs: number | undefined
  /**
   * 这一发的**回执格**。`Mutation.run` 刻意不抛,它失败只回一个 `undefined` ——
   * 而 `save()` 的调用方要区分「撞车」与「没写成」这两句话。所以由 onError
   * 往这一格里写一次,`save()` 读它。
   *
   * 为什么不读 store 上那两格(edit.conflict / edit.error):**存盘期间那一份实例
   * 可能已经被关掉了**,那一支按老规矩一个字都不往 store 上写,于是从 store
   * 读回来的会是「没失败」——一句假话。
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
 * 那两件事在状态栏里长得不一样。撞车那一格同理原样带着。
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
 *  · 撞车(conflict)与普通失败是两句话;
 *  · 失败原话照抄后端,渲染层不编一句更好听的;
 *  · 存成了就地把手上这份内容换成草稿并记下 `savedAt`,**不重读一遍盘**。
 *
 * ── W1 改的只有那两句守卫 ────────────────────────────────────────────────
 * 从前问的是「屏幕上那一份还是不是这个文件」(`file?.path !== input.path`)——
 * 全应用只有一份查看器时那句话成立。多实例之后正确的问法是**「这一份实例还在不在」**
 * (`instances[path]`):用户完全可能在存盘飞行途中切到隔壁那个 tab,
 * 而那一份的存盘结果照样该落回它自己那一格。
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
    // 那一份实例已经被关掉了 —— 什么都不做,不去凭空造回一份。
    const now = useViewerSource.getState().instances[input.path]
    if (!now) return
    useViewerSource.setState((st) => {
      const live = st.instances[input.path]
      if (!live) return st
      return {
        instances: {
          ...st.instances,
          [input.path]: {
            ...live,
            file:
              live.file && isEditableFile(live.file)
                ? { ...live.file, content: input.draft, mtimeMs: result.mtimeMs ?? live.file.mtimeMs }
                : live.file,
            edit: { ...live.edit, error: undefined, conflict: false, savedAt: Date.now() },
          },
        },
      }
    })
  },
  onError: (error, input) => {
    const failure = error instanceof ViewerSaveError ? error : undefined
    // 回执格**无条件**填:实例关掉了也得让 save() 说得出这一发是撞车还是没写成。
    input.outcome.conflict = failure?.conflict ?? false
    input.outcome.error = failure ? failure.detail : error.message
    // 屏幕上那两格只在这一份实例还在时才动 —— 与 settle 同一条判据。
    if (!useViewerSource.getState().instances[input.path]) return
    useViewerSource.setState((st) => {
      const live = st.instances[input.path]
      if (!live) return st
      return {
        instances: {
          ...st.instances,
          [input.path]: {
            ...live,
            edit: { ...live.edit, conflict: input.outcome.conflict, error: input.outcome.error },
          },
        },
      }
    })
  },
})

export const useViewerSource = create<ViewerSourceState>()((set, get) => {
  /**
   * **一条路径一个令牌**(W1;从前是全局一个)。同时开着两个文件时,A 的晚到回执
   * 不该被 B 的读作废 —— 一个全局令牌会让「点开 B」把 A 还在飞的那一发判死。
   */
  const tokens = new Map<string, number>()
  const bump = (path: string): number => {
    const next = (tokens.get(path) ?? 0) + 1
    tokens.set(path, next)
    return next
  }

  /**
   * **这条路径重读过几次**。它只为 direct 那两型(图 / 播放条)存在:那两型的
   * 字节归浏览器自己取,同一条 `file://` 再挂一次拿回来的是缓存里那一张 ——
   * 换一条 URL(`?v=n`)才是真的重取(判词在 `viewer-kinds.fileUrlOf`)。
   * 跟着 `tokens` 一起住在闭包里,`dispose` 一并清掉。
   */
  const revs = new Map<string, number>()

  /** 就地改一份实例。实例不在 = 什么都不做(不凭空造回一份被关掉的)。 */
  function patch(path: string, fn: (live: ViewerInstance) => ViewerInstance): void {
    set((st) => {
      const live = st.instances[path]
      if (!live) return st
      const next = fn(live)
      if (next === live) return st
      return { instances: { ...st.instances, [path]: next } }
    })
  }

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
     * 不必回来改这个 switch。
     */
    return resolveViewerSpec({ path, size, isBinary: response.isBinary, content }).build({
      path,
      name,
      content,
      size,
      want,
      rev: revs.get(path),
      mtimeMs: response.mtimeMs,
    })
  }

  /** 一次打开 / 重读 / 续读共用的那条路:立令牌 → 读 → 令牌还在才换屏。 */
  async function run(path: string, want: number, keepEdit: boolean): Promise<void> {
    const mine = bump(path)
    patch(path, (live) => ({ ...live, pending: path }))
    const next = await read(path, want)
    if (tokens.get(path) !== mine) return
    patch(path, (live) => ({
      ...live,
      file: next,
      pending: null,
      // 续读(keepEdit)不碰编辑态:那是同一个文件的同一次编辑。
      edit: keepEdit ? live.edit : { ...EMPTY_EDIT },
    }))
    // 续读也不碰滚动位 —— 「继续加载」之后屏幕该停在原地,不是弹回顶上。
    if (!keepEdit) set((st) => ({ scrolls: { ...st.scrolls, [path]: 0 } }))
  }

  return {
    instances: {},
    scrolls: {},
    prefs: { wrap: EMPTY_VIEW.wrap, keymap: EMPTY_VIEW.keymap },

    openFile: async (path) => {
      if (!path) return
      const { instances, prefs } = get()
      const live = instances[path]
      /*
       * **手上真有内容、而且没有在飞的读** = 什么都不做(再点一下同一行不该让屏幕
       * 闪一次)。09-22 收窄:从前这句只问「没有在飞的读」,于是一份**有实例、却
       * 一个字节都没读回来**的空壳会被当成「已经开好了」直接返回 —— 而那正是
       * `ensureFile` 要救的那一种。「有没有开」的判据是有没有内容,不是有没有在读。
       *
       * 在飞时**照旧往下走**再读一发:`openFileAt` 要靠这一口的 promise 落在
       * 「内容已经上屏」那一拍上跳行(判词在 `open-target.openFileAt`),
       * 提前 resolve 会变成「开了,但没跳」。要省掉那一发的是 `ensureFile`。
       */
      if (live && live.file !== null && live.pending === null) return
      if (!live) {
        set((st) => ({
          instances: { ...st.instances, [path]: freshInstance(st.prefs) },
          scrolls: { ...st.scrolls, [path]: 0 },
        }))
      }
      /*
       * 图与播放条不读字节:浏览器自己去取那条 file:// —— 把一张 8MB 的 png 按
       * utf-8 解码搬进渲染进程,得到的是一串必然乱码的字符,一点用都没有。
       * 于是这条路**同步就位**:没有 pending 那一帧,屏幕上直接换成它。
       */
      const direct = directFileOf(path, revs.get(path))
      if (direct) {
        // 令牌照样往前走一格:上一次还在飞的那次读回来时必须被判过期。
        bump(path)
        set((st) => ({
          instances: {
            ...st.instances,
            [path]: { ...freshInstance(prefs), file: direct },
          },
          scrolls: { ...st.scrolls, [path]: 0 },
        }))
        return
      }
      await run(path, VIEWER_CHUNK_BYTES, false)
    },

    ensureFile: async (path) => {
      if (!path) return
      const live = get().instances[path]
      // 有内容、或者已经有一发在飞 —— 两种都不必再读。
      if (live && (live.file !== null || live.pending !== null)) return
      await get().openFile(path)
    },

    reload: async (path) => {
      const live = get().instances[path]
      if (!live?.file) return
      /*
       * 图 / 播放条:一个字节都不读,所以「重读」对它们是**换一条 src**
       * (`?v=n`)—— 同一条 URL 再挂一次,浏览器交回来的是缓存里那一张。
       * 那句「那是缓存的把戏,F1 不做」的留账到此结清:刷新这颗钮要是对图不成立,
       * 它就是一颗骗人的钮。
       */
      const nextRev = (revs.get(path) ?? 0) + 1
      const direct = directFileOf(path, nextRev)
      if (direct) {
        revs.set(path, nextRev)
        bump(path)
        patch(path, (now) => ({ ...now, file: direct, pending: null }))
        return
      }
      revs.set(path, nextRev)
      const want = 'loaded' in live.file ? live.file.loaded : VIEWER_CHUNK_BYTES
      // `keepEdit` = 刷新不吃掉草稿、也不把屏幕弹回顶上(判词在接口那一格上)。
      await run(path, want, true)
    },

    loadMore: async (path) => {
      const file = get().instances[path]?.file
      if (!file || !('loaded' in file) || !file.truncated) return
      // 续读是**同一个文件的同一次阅读**,所以看的姿势与编辑态原样留着。
      await run(path, file.loaded + VIEWER_CHUNK_BYTES, true)
    },

    dispose: (path) => {
      bump(path)
      tokens.delete(path)
      revs.delete(path)
      set((st) => {
        if (!(path in st.instances) && !(path in st.scrolls)) return st
        const instances = { ...st.instances }
        const scrolls = { ...st.scrolls }
        delete instances[path]
        delete scrolls[path]
        return { instances, scrolls }
      })
    },

    setView: (path, patchView) => {
      patch(path, (live) => ({ ...live, view: { ...live.view, ...patchView } }))
      // 两格跟着人走的偏好在这里同步一次 —— 单产地,不会与实例上那一格分叉。
      if (patchView.wrap === undefined && patchView.keymap === undefined) return
      set((st) => ({
        prefs: {
          wrap: patchView.wrap ?? st.prefs.wrap,
          keymap: patchView.keymap ?? st.prefs.keymap,
        },
      }))
    },

    setScrollTop: (path, top) => set((st) => ({ scrolls: { ...st.scrolls, [path]: top } })),

    setEditing: (path, on) =>
      patch(path, (live) => ({
        ...live,
        edit: on
          ? {
              ...EMPTY_EDIT,
              editing: true,
              // 进编辑 = 把手上这份内容抄一份当草稿。抄不到(不是文本)就不进。
              draft: isEditableFile(live.file) ? live.file.content : null,
            }
          : { ...EMPTY_EDIT },
      })),

    setDraft: (path, text) =>
      patch(path, (live) => ({ ...live, edit: { ...live.edit, draft: text } })),

    save: async (path) => {
      const live = get().instances[path]
      const file = live?.file ?? null
      if (!live || !isEditableFile(file) || live.edit.draft === null) {
        return { ok: false, reason: 'not-editable' }
      }
      /*
       * 开一发之前先把**上一次的结论**清掉。清的时机一格没变:就在这一发出发之前。
       */
      patch(path, (now) => ({ ...now, edit: { ...now.edit, error: undefined, conflict: false } }))
      const outcome: ViewerSaveInput['outcome'] = { conflict: false }
      const done = await viewerSaveMutation.run({
        path: file.path,
        draft: live.edit.draft,
        mtimeMs: file.mtimeMs,
        outcome,
      })
      if (done) return { ok: true }
      // 失败:mutation 不抛,结论从这一发自己的回执格里读(理由见 outcome 的注释)。
      return { ok: false, reason: outcome.conflict ? 'conflict' : 'failed', error: outcome.error }
    },

    reset: () => {
      tokens.clear()
      revs.clear()
      set({
        instances: {},
        scrolls: {},
        prefs: { wrap: EMPTY_VIEW.wrap, keymap: EMPTY_VIEW.keymap },
      })
    },
  }
})

/**
 * 一份实例的读口。**没有那一份时交回同一个冻结常量**(不是现造的空对象)——
 * 理由写在 `EMPTY_VIEWER_INSTANCE` 上。
 */
export function useViewerInstance(path: string): ViewerInstance {
  return useViewerSource((st) => st.instances[path] ?? EMPTY_VIEWER_INSTANCE)
}

/** 这条路径此刻有没有一份实例(隐藏的也算 —— 它的状态还在)。 */
export function hasViewerInstance(path: string): boolean {
  return useViewerSource.getState().instances[path] !== undefined
}

/**
 * 「一个字节都不读」的那些:分型表里带 `direct` 标的行(今天是图与播放条)。
 * 回 null = 这条路径得走真读那一条。
 *
 * **判据不在这里** —— 它就是表上那一格 `direct`。svg 是个例外中的例外:它带
 * `direct` 标(位图那一行),但它同时要一份源码,所以它走真读那条路。
 */
function directFileOf(path: string, rev?: number): ViewerFile | null {
  const spec = specOfPath(path)
  if (!spec.direct) return null
  if (spec.kind === 'image' && isSvgPath(path)) return null
  return spec.build({ path, name: baseNameOf(path), content: '', size: 0, want: 0, rev })
}
