import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useModelsSource } from '../data/models-source'
import { composerSink } from './sink'
import { t } from '../i18n'
import type { ResolvedSegment } from '../references/segment'
import { configureDraftRevoke, resetComposerDrafts } from './drafts'
import * as T from './transitions'
import { pickDrawer } from './types'
import type { ReferenceTrigger } from '../references/kind'
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
 * 2. ask 由 openAsk 进入,提交/拒绝通过原交互应答口,结算后按请求 id 关闭;
 * 3. 对象 URL 谁造谁销:附件的 revoke 落在删除与清空两处,别处不许造 URL。
 *
 * ── **一条会话一份**(W5-c-2,正本 `composer-in-leaf-2026-09.md` §4.3)───────
 * 路线 A 之后输入框是**会话叶自己渲染的**,屏幕上有几片会话叶就有几块面板。
 * 一格模块级 `create()` 于是从「全应用只有一块面板」的事实退化成一句谎:两片叶
 * 并排时抽屉、搜索词、ask、附件、状态条会互相顶替(与 W5-a 那次「一条会话一台
 * 折叠器」、W7-t/B2 那次「一条会话一份草稿」是同一条病、同一条路)。
 *
 * 所以这里是**一张按 `sessionId` 键的表 + 一只工厂**,形状照抄 `data/chat-source`
 * 的既有判例(`zustand/vanilla` 的 `createStore` + `useStore`):
 *  · `composerStoreFor(id)` —— 惰性建,非组件上下文的读写口;
 *  · `useComposerStoreOf(id, selector)` —— 组件的订阅口;
 *  · `disposeComposerStore(id)` —— 那一格会话被真的关掉时释放
 *    (落点在 `content/kinds/session.tsx` 的 `ContentKind.dispose`)。
 *
 * **保留键那片叶读作空串**,它也是一格真键(与草稿表逐字同一条:空串是「是会话
 * 叶、但还没绑会话」,不是缺席)。
 */

const initialState: ComposerState = {
  drawerKind: null,
  pickQuery: '',
  pickIndex: 0,
  modelQuery: '',
  mode: 'write',
  askSpec: null,
  askSubmitting: false,
  askError: null,
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

/*
 * **「谁造谁销」的第三个销点**(W7-t / B2):一条会话的草稿被丢掉时,挂在它上面
 * 那些附件的对象 URL 也该销。草稿表(`composer/drafts.ts`)不认识 `URL` ——
 * 造 URL 的是这只 store,所以销那一句也留在这里,由它注入过去。
 * 注入是模块级的一次登记,幂等,没有可拆卸的尾巴。
 */
configureDraftRevoke(revoke)

export interface ComposerStore extends ComposerState {
  /* 抽屉(单一槽) */
  showPick: (trigger: ReferenceTrigger, query: string) => void
  /**
   * 选中位只有这一个 setter。「往下走一格」那件事已经不在 store 里 ——
   * 它是 `ui/a11y/list-selection` 的 `move`,与工作区快切、模型抽屉同一份判据
   * (09-01 收敛:三处各写一份走法,是 hover 污染选中位那条病的同一个病根)。
   */
  setPickIndex: (i: number) => void
  toggleModelDrawer: () => void
  setModelQuery: (q: string) => void
  chooseModel: (sessionId: string | null, provider: string, model: string) => void
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
  closeAsk: (interactionId: string) => void
  answerAsk: (optIndex: number) => void
  setAskCustom: (text: string) => void
  moveAsk: (delta: number) => void
  submitAsk: (lines: { tag: string; answer: string }[]) => void
  rejectAsk: () => void

  /* 发送 */
  send: (text: string, toSession?: string, segments?: readonly ResolvedSegment[]) => boolean
}

/** 一块面板的 store 句柄(`zustand/vanilla`,与 `data/chat-source` 同形)。 */
export type ComposerStoreApi = StoreApi<ComposerStore>

/**
 * 造一块面板的 store。`sessionId` 是**这一份的收件人**:三口出站动作
 * (`submitAsk` / `rejectAsk` / `send`)从前读 sink 里那句「当前会话」投影,
 * 多开之后那句话说不清是谁 —— 所以它在造这一份的时候就钉死了。
 */
function createComposerStore(sessionId: string): ComposerStoreApi {
  return createStore<ComposerStore>()((set, get) => ({
    ...initialState,

    /*
     * 开的是**哪个触发字符**,不是「哪一种引用」(09-12 引用种类注册表)。
     * `pickDrawer` 每个字符恒交同一个对象 —— 判词在它自己那儿。
     */
    showPick: (trigger, query) =>
      set({ drawerKind: pickDrawer(trigger), pickQuery: query, pickIndex: 0 }),
    setPickIndex: (i) => set({ pickIndex: i }),

    // 模型抽屉是**瞬态**的:每次开都从空搜索开始,不记上次搜了什么。
    toggleModelDrawer: () =>
      set((s) =>
        s.drawerKind === 'model'
          ? { drawerKind: null as DrawerKind }
          : { drawerKind: 'model' as DrawerKind, modelQuery: '' },
      ),
    setModelQuery: (q) => set({ modelQuery: q }),

    /**
     * 选中一个模型 —— **一件事**:把选择交给 `models-source`(会话上的一格绑定,
     * 归那里)。有会话就 `sessions.updateModel` 上行,没有会话就记成「下一条新会话用谁」。
     *
     * 这里**不 await**:药丸该在手指抬起的那一帧就换字,而不是等一次往返。
     * 上行失败由数据源自己撤牌 + notify(warn) —— 那时药丸会变回原来那个模型,
     * 屏幕上不留一块后端没认下的牌(与 agent 徽逐条同构)。
     *
     * ── 09-17:选中即收起(推翻 09-05 庚「选中不关」)────────────────────────
     * 用户报「选中后不会自己收起来」。庚那一版的理由是右栏卡讲的是「刚选中的这一型」,
     * 可人点一行的意图就是「换成它」,换完还得再点外面 / 按 Esc 才能回去打字,是多一手。
     * 右栏卡与思考阶梯讲的仍是**当前**那一型:要调档,开抽屉先调再走,或选完再开一次。
     * 在飞时被 `commit` 拦下的那一下不走到这里,抽屉也就不关(反馈是「不可再点」)。
     *
     * 收件人由组件递进来(与 `AgentChip` 同一手):输入面板不认识总览 store,
     * 「当前是哪条会话」是调用现场的事实,不是这块面板的状态。参数在这里叫
     * `target` 而不是 `sessionId`,只是为了不遮住外面那一格「这一份 store 是谁的」
     * —— 两者在今天恒等(抽屉读的就是它宿主那块面板的会话)。
     */
    chooseModel: (target, provider, model) => {
      void useModelsSource.getState().selectModel(target, provider, model)
      set({ drawerKind: null })
    },

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
          ...files.map<Attachment>((f) => ({ id: nextId('att'), name: f.name, url: objectUrl(f), file: f })),
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
      set((s) => ({
        mode: 'ask',
        askSpec: spec,
        askAnswers: spec.interaction && spec.interaction.id === s.askSpec?.interaction?.id
          ? s.askAnswers : T.initAskAnswers(spec),
        askIdx: spec.interaction && spec.interaction.id === s.askSpec?.interaction?.id ? s.askIdx : 0,
        askSubmitting: spec.interaction && spec.interaction.id === s.askSpec?.interaction?.id ? s.askSubmitting : false,
        askError: spec.interaction && spec.interaction.id === s.askSpec?.interaction?.id ? s.askError : null,
        // 变形即收抽屉:本体都换了样,原来那个抽屉说的是上一形态的事。
        drawerKind: null,
      })),

    closeAsk: (id) => {
      if (get().askSpec?.interaction?.id !== id) return
      set({ mode: 'write', askSpec: null, askAnswers: [], askIdx: 0, askSubmitting: false, askError: null })
    },

    answerAsk: (optIndex) =>
      set((s) =>
        s.askSpec && !s.askSubmitting
          ? { askAnswers: T.toggleAskOption(s.askSpec, s.askAnswers, s.askIdx, optIndex) }
          : {},
      ),

    setAskCustom: (text) =>
      set((s) => s.askSpec && !s.askSubmitting && s.askSpec.questions[s.askIdx]?.allowFreeText !== false
        ? { askAnswers: T.setAskCustomAnswer(s.askAnswers, s.askIdx, text) } : {}),

    moveAsk: (delta) =>
      set((s) => ({
        askIdx: T.moveAskIndex(s.askIdx, delta, s.askSpec?.questions.length ?? 0),
      })),

    /**
     * 交卷 = **一条真消息**:答完一组问题就是用户说了一段话,没有第三种东西。
     * 这里只负责把它拼成一句(`标签: 答案`,一行一题),交给 sink;账本认下之后
     * 屏幕上那一条由折叠器画。
     */
    submitAsk: async (lines) => {
      const { askSpec, askAnswers, askSubmitting } = get()
      if (askSubmitting) return
      if (askSpec?.interaction) {
        if (!T.askAllAnswered(askSpec, askAnswers)) return
        set({ askSubmitting: true, askError: null })
        try {
          await askSpec.interaction.submit(askAnswers)
          get().closeAsk(askSpec.interaction.id)
        } catch (error) {
          if (get().askSpec?.interaction?.id === askSpec.interaction.id) {
            set({ askSubmitting: false, askError: error instanceof Error ? error.message : t('ask.failed') })
          }
        }
        return
      }
      composerSink().send(
        lines.map((line) => `${line.tag}: ${line.answer}`).join('\n'),
        0,
        sessionId,
      )
      set({ mode: 'write', askSpec: null, askAnswers: [], askIdx: 0 })
    },

    /**
     * 拒绝也进流:一次没回答**也是一次回答**,不该在记录里消失 —— 但它进不了
     * 账本(引擎那边什么都没发生),所以走的是本地提示那条车道,不是发送。
     */
    rejectAsk: async () => {
      const { askSpec, askSubmitting } = get()
      if (askSubmitting) return
      if (askSpec?.interaction) {
        set({ askSubmitting: true, askError: null })
        try {
          await askSpec.interaction.decline()
          get().closeAsk(askSpec.interaction.id)
        } catch (error) {
          if (get().askSpec?.interaction?.id === askSpec.interaction.id) {
            set({ askSubmitting: false, askError: error instanceof Error ? error.message : t('ask.failed') })
          }
        }
        return
      }
      composerSink().notice('ask-rejected', sessionId)
      set({ mode: 'write', askSpec: null, askAnswers: [], askIdx: 0 })
    },

    /**
     * 发送。空话不发(照设计稿);附件是这条消息的一部分,所以**随消息一起离开**,
     * 留在框里等下一条会是谎话。返回值告诉调用方「到底发没发」——
     * 输入框要不要清空由它决定,store 不去碰 DOM。
     *
     * D3 起真正的收件人是会话命令总线(经 `sink`)。**sink 说没交出去就当没发**:
     * 还没有当前会话时输入框不该被清空,那句话还在人手里。附件计数与原文件一起
     * 带过去;端口负责异步读取字节,发送失败的气泡保留原文件供重试。
     *
     * ── `toSession`:这块面板一辈子唯一一次「收件人不是自己」(W5-c-2)───────
     * 保留键那片叶的收件人是空串(「还没绑会话」)。人在它上面打一句话按发送 =
     * 「开始一段对话」:`useComposerSend` 先惰性建一条,**再把这句话发进刚建出来
     * 的那条**。W5-c-2 之前这件事白拿 —— sink 每次调用现问一句「当前会话是谁」,
     * 而那时它已经是新那条了;收件人钉进 store 之后就得说出来,否则这一句会发给
     * 空串(`chatSources.get('')` 查无此人 → 静默不发),那正是首开最常见的一步。
     * 所以它是**一个参数**,不是一格状态:一次性的例外不该变成一格会漂的事实。
     */
    send: (text, toSession, segments) => {
      const body = text.trim()
      const atts = get().attachments
      const files = atts.flatMap((attachment) => attachment.file ? [attachment.file] : [])
      if (!body && files.length === 0) return false
      /*
       * **段跟着这句话一起走**(09-14):乐观气泡画的是段,发出去的是它的投影。
       * 这里一个字都不碰段 —— 输入面读出来什么,交出去的就是什么(`trim` 只作用
       * 在那句话上;段是原样,首尾空白由画的那一层按 `pre-wrap` 处理,与账本
       * 回来之后的那一条逐字同)。
       */
      const handed = files.length > 0
        ? composerSink().send(body, atts.length, toSession ?? sessionId, segments, files)
        : composerSink().send(body, atts.length, toSession ?? sessionId, segments)
      if (!handed) return false
      revoke(atts)
      set({ attachments: [], attOpen: false, drawerKind: null })
      return true
    },
  }))
}

/**
 * **一条会话一份**的那张表。键 = `sessionId`(保留键那片叶是空串)。
 *
 * 寿命 = 这个模块实例,所以配一段 HMR 退役(09-01 立法,与 `composer/drafts.ts`
 * 那张表逐字同一条)。表里没有订阅、没有计时器 —— 唯一的尾巴是附件那些对象 URL,
 * 所以退役就是「销 + 清表」。
 */
const stores = new Map<string, ComposerStoreApi>()

/**
 * **这条会话那块面板的 store**。惰性建 —— 读到就有,与 `chatSources.ensure`
 * 同一条(「读不起底」在这里不成立:这块面板没有任何后台活计,一格空状态而已)。
 *
 * 非组件上下文(编排点的 `getState()` / `setState()`、用例)走这一口。
 */
export function composerStoreFor(sessionId: string): ComposerStoreApi {
  const found = stores.get(sessionId)
  if (found) return found
  const made = createComposerStore(sessionId)
  stores.set(sessionId, made)
  return made
}

/** 组件的订阅口(与 `useChatSourceOf` 同形)。 */
export function useComposerStoreOf<T>(
  sessionId: string,
  selector: (state: ComposerStore) => T,
): T {
  return useStore(composerStoreFor(sessionId), selector)
}

/**
 * 卸载时收工:对象 URL 是**这个 store 造的**,所以也由它销 ——
 * 「谁造谁销」比「谁看见谁销」可靠,组件可以有好几个,造它的地方只有一个。
 *
 * 收的是**这一份**:一块面板下场不该把隔壁那条会话挂着的缩略图一起销掉。
 */
export function revokeAllAttachments(sessionId: string): void {
  const store = stores.get(sessionId)
  if (store) revoke(store.getState().attachments)
}

/**
 * **那条会话被真的关掉了**:销掉它挂着的对象 URL,并把这一份从表上摘掉
 * (落点在 `content/kinds/session.tsx` 的 `ContentKind.dispose`,与那一句
 * `dropComposerDraft` 并排 —— 同一个丢弃时机,同一条「藏起来的叶照样留着」)。
 *
 * 没有这一份就是空动作(那片叶从来没被渲染过)。
 */
export function disposeComposerStore(sessionId: string): void {
  const store = stores.get(sessionId)
  if (!store) return
  revoke(store.getState().attachments)
  stores.delete(sessionId)
}

/**
 * 测试与「新会话」用:把这块面板恢复成刚打开的样子。
 * **连同各条会话那几份草稿**(W7-t / B2)—— 不然重置完屏幕是干净的,
 * 一切回上一条会话稿又冒出来了。
 *
 * W5-c-2 之后「这块面板」是复数:整张表一起清(销 URL + 摘掉),下一次读到的
 * 是崭新的一份 —— 与从前 `setState({...initialState})` 同效,只是多了几份。
 */
export function resetComposerStore(): void {
  for (const store of stores.values()) revoke(store.getState().attachments)
  stores.clear()
  resetComposerDrafts()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const store of stores.values()) revoke(store.getState().attachments)
    stores.clear()
  })
}
