import { create } from 'zustand'
import { DEFAULT_MODEL } from './data'
import { composerSink } from './sink'
import * as T from './transitions'
import type {
  AskSpec,
  Attachment,
  ComposerState,
  DrawerKind,
  StatusSpec,
} from './types'

/**
 * 和 stage/ expose/ 一样:store 只是 transitions 的一层壳,每个 action 尽量是
 * set(纯函数)。**不 persist** —— 输入框里没写完的话、开着的抽屉、挂着的问卷
 * 都是「此刻」的东西,重启该干净,不该被上次的残留污染。
 *
 * 三条纪律钉在这里:
 * 1. 抽屉是**一个槽**:任何 open* 都直接改写 drawerKind,后来者顶替先来者;
 * 2. ask 形态由 openAsk / submitAsk / rejectAsk 三口进出,没有第四条路;
 * 3. 对象 URL 谁造谁销:附件的 revoke 落在删除与清空两处,别处不许造 URL。
 */

const initialState: ComposerState = {
  drawerKind: null,
  pickQuery: '',
  pickIndex: 0,
  modelQuery: '',
  model: DEFAULT_MODEL,
  mode: 'write',
  askSpec: null,
  askAnswers: [],
  askIdx: 0,
  attachments: [],
  attOpen: false,
  status: null,
}

/** 附件 id:自增就够(单进程、单窗口),不引 uuid。 */
let seq = 0
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`

/** jsdom 与非浏览器宿主没有 createObjectURL —— 缺席时退化成「无缩略的文件卡」。 */
function objectUrl(file: File): string | undefined {
  if (!file.type.startsWith('image/')) return undefined
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
  return URL.createObjectURL(file)
}

function revoke(atts: readonly Attachment[]): void {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  for (const a of atts) if (a.url) URL.revokeObjectURL(a.url)
}

interface ComposerStore extends ComposerState {
  /* 抽屉(单一槽) */
  showPick: (kind: 'files' | 'commands', query: string) => void
  movePick: (delta: number, len: number) => void
  setPickIndex: (i: number) => void
  toggleModelDrawer: () => void
  setModelQuery: (q: string) => void
  chooseModel: (model: string) => void
  toggleStatusDrawer: () => void
  closeDrawer: () => void

  /* 状态条:结构做全,没有引擎 —— 这三口就是将来引擎的接线柱 */
  beginStatus: (spec: StatusSpec) => void
  tickStatus: () => void
  endStatus: () => void

  /* 附件 */
  addFiles: (files: readonly File[]) => void
  removeAttachment: (id: string) => void
  setAttOpen: (open: boolean) => void

  /* ask 形态 */
  openAsk: (spec: AskSpec) => void
  answerAsk: (optIndex: number) => void
  setAskCustom: (text: string) => void
  moveAsk: (delta: number) => void
  submitAsk: (lines: { tag: string; answer: string }[]) => void
  rejectAsk: () => void

  /* 发送 */
  send: (text: string) => boolean
}

export const useComposerStore = create<ComposerStore>()((set, get) => ({
  ...initialState,

  showPick: (kind, query) => set({ drawerKind: kind, pickQuery: query, pickIndex: 0 }),
  movePick: (delta, len) => set((s) => ({ pickIndex: T.movePickIndex(s.pickIndex, delta, len) })),
  setPickIndex: (i) => set({ pickIndex: i }),

  // 模型抽屉是**瞬态**的:每次开都从空搜索开始,不记上次搜了什么。
  toggleModelDrawer: () =>
    set((s) =>
      s.drawerKind === 'model'
        ? { drawerKind: null as DrawerKind }
        : { drawerKind: 'model' as DrawerKind, modelQuery: '' },
    ),
  setModelQuery: (q) => set({ modelQuery: q }),
  chooseModel: (model) => set({ model, drawerKind: null }),

  toggleStatusDrawer: () =>
    set((s) => ({ drawerKind: s.drawerKind === 'status' ? null : ('status' as DrawerKind) })),
  closeDrawer: () => set({ drawerKind: null }),

  beginStatus: (spec) =>
    set({ status: { ...spec, stepIdx: 0, running: true }, drawerKind: 'status' }),

  /**
   * 走一步。到最后一步就自己落定成「完成」—— 没有「跑到第 5 步」这种状态,
   * 步数是说明书给的事实,不是计数器自己长的。
   */
  tickStatus: () =>
    set((s) => {
      const st = s.status
      if (!st || !st.running) return {}
      if (st.stepIdx >= st.steps.length - 1) return { status: { ...st, running: false } }
      return { status: { ...st, stepIdx: st.stepIdx + 1 } }
    }),

  // 收尾不收状态条:执行完了那条绿点行还在,随时能再展开看流水(设计稿明写)。
  endStatus: () =>
    set((s) => (s.status ? { status: { ...s.status, running: false } } : {})),

  addFiles: (files) =>
    set((s) => ({
      attachments: [
        ...s.attachments,
        ...files.map<Attachment>((f) => ({ id: nextId('att'), name: f.name, url: objectUrl(f) })),
      ],
    })),

  removeAttachment: (id) =>
    set((s) => {
      const gone = s.attachments.filter((a) => a.id === id)
      revoke(gone)
      const rest = s.attachments.filter((a) => a.id !== id)
      // 删到空就没有摞了,展开态跟着归位;还剩卡则**保持展开**(不塌摞)。
      return { attachments: rest, attOpen: rest.length > 0 && s.attOpen }
    }),

  setAttOpen: (open) => set({ attOpen: open }),

  openAsk: (spec) =>
    set({
      mode: 'ask',
      askSpec: spec,
      askAnswers: T.initAskAnswers(spec),
      askIdx: 0,
      // 变形即收抽屉:本体都换了样,原来那个抽屉说的是上一形态的事。
      drawerKind: null,
    }),

  answerAsk: (optIndex) =>
    set((s) =>
      s.askSpec
        ? { askAnswers: T.toggleAskOption(s.askSpec, s.askAnswers, s.askIdx, optIndex) }
        : {},
    ),

  setAskCustom: (text) =>
    set((s) => ({ askAnswers: T.setAskCustomAnswer(s.askAnswers, s.askIdx, text) })),

  moveAsk: (delta) =>
    set((s) => ({
      askIdx: T.moveAskIndex(s.askIdx, delta, s.askSpec?.questions.length ?? 0),
    })),

  /**
   * 交卷 = **一条真消息**:答完一组问题就是用户说了一段话,没有第三种东西。
   * 这里只负责把它拼成一句(`标签: 答案`,一行一题),交给 sink;账本认下之后
   * 屏幕上那一条由折叠器画。
   */
  submitAsk: (lines) => {
    composerSink().send(lines.map((line) => `${line.tag}: ${line.answer}`).join('\n'), 0)
    set({ mode: 'write', askSpec: null, askAnswers: [], askIdx: 0 })
  },

  /**
   * 拒绝也进流:一次没回答**也是一次回答**,不该在记录里消失 —— 但它进不了
   * 账本(引擎那边什么都没发生),所以走的是本地提示那条车道,不是发送。
   */
  rejectAsk: () => {
    composerSink().notice('ask-rejected')
    set({ mode: 'write', askSpec: null, askAnswers: [], askIdx: 0 })
  },

  /**
   * 发送。空话不发(照设计稿);附件是这条消息的一部分,所以**随消息一起离开**,
   * 留在框里等下一条会是谎话。返回值告诉调用方「到底发没发」——
   * 输入框要不要清空由它决定,store 不去碰 DOM。
   *
   * D3 起真正的收件人是会话命令总线(经 `sink`)。**sink 说没交出去就当没发**:
   * 还没有当前会话时输入框不该被清空,那句话还在人手里。附件计数照实带过去 ——
   * 载荷本身不在 D3(纯文本 content),但「这条消息本来带着几个附件」是事实。
   */
  send: (text) => {
    const body = text.trim()
    if (!body) return false
    const atts = get().attachments
    if (!composerSink().send(body, atts.length)) return false
    revoke(atts)
    set({ attachments: [], attOpen: false, drawerKind: null })
    return true
  },
}))

/**
 * 卸载时收工:对象 URL 是**这个 store 造的**,所以也由它销 ——
 * 「谁造谁销」比「谁看见谁销」可靠,组件可以有好几个,造它的地方只有一个。
 */
export function revokeAllAttachments(): void {
  revoke(useComposerStore.getState().attachments)
}

/** 测试与「新会话」用:把这块面板恢复成刚打开的样子。 */
export function resetComposerStore(): void {
  revoke(useComposerStore.getState().attachments)
  useComposerStore.setState({ ...initialState })
}
