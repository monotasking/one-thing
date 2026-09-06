import { useCallback, useEffect, useRef } from 'react'
import { refId, registerContentKind } from '../../workbench/kinds'
import { CENTER_REGION } from '../../workbench/regions'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { ChatStream } from '../ChatStream'
import { TocPanel } from '../../toc/TocPanel'
import { useChatToc } from '../../toc/useChatToc'
import { currentSessions, useSessionsSource } from '../../data/sessions-source'
import { findSession } from '../../expose/projection'
import { useLiveTitleStore } from '../../stage/live-title'
import { t, useT } from '../../i18n'
import { useExposeStore } from '../../expose/store'
import { NEW_SESSION_KEY, SESSION_KIND, sessionIdOfRef } from '../session-ref'
import { dropComposerDraft } from '../../composer/drafts'
import type { ContentRef } from '../../workbench/kinds'
import s from './ChatLeaf.module.css'

/**
 * **会话这一种内容**(W5-b,设计 §1.1 / §2.3 / §8 W5;裁定 1)。
 *
 * W1 它叫 `chat`,是一格单例 `chat:main`;本批它改名 `session`,`key` 换成
 * **会话 id**,`singleton` 翻成 false —— 于是「两条会话并排各占一片叶」是树自己
 * 就成立的事,树、隐藏、标签、拖拽、持久化一个字都没改(那正是 W1 那三条自述
 * 上写的预言)。存量档案里那一格 `chat:main` 由 persist v2 翻成 `session:new`
 * (翻译表在 `content/legacy-refs.ts`)。
 *
 * ── 四条自述,每一条都替代了一处从前写死的判据 ──────────────────────────
 *  · `singleton: false` —— 会话多开的全部实现就是这一格;
 *  · `resident: { region: 'center', seed }` —— 出厂时中央区第一片叶里就是它
 *    (核心层因此不必知道「中央区装的是会话」),而且**这个区域里最后一格会话
 *    关不掉**(T0 拍点 2)。`seed()` 是裁定 2 那一格「延迟铸 key」:摆哪条会话
 *    只有这一种自己答得出;
 *  · **`regions` 缺席** —— 裁定 8:会话可以开到任何区域(架子 / 浮窗 / 分屏),
 *    于是 W3 那句「会话行落别处 = 结构化拒绝」自然解禁。拒绝那一句话现在由
 *    `ContentKind.regions` 生成(`workbench/useContentDrag.ts` 的缺省 accepts),
 *    没人再手写;
 *  · `fullable: false` —— **照旧**。W5-b 走的是路线 B(裁定 4:composer 留在
 *    `.center`,只把目标换成投影值),输入框仍然不在树里,所以会话叶进全屏
 *    还是会把它盖掉。要撤它得等路线 A(W5-c 可选加期)。
 *
 * ── 这片叶看哪条会话:`ref.key`,不是 expose 那一格 ──────────────────────
 * W5-a 时这一层读的是 `expose.currentSessionId`(全应用一份);本批换成
 * **这一格自己的 key** —— 叶就是「哪条会话」的产地,两片叶各说各的。反过来,
 * 「当前会话」变成了**投影**:焦点叶的会话是哪条,那一格就是哪条
 * (`content/session-projection.ts`)。方向反了过来,而底下三件(消息流 /
 * 目录接缝 / 目录 rail)一个字都没改 —— 它们从 W5-a 起就只认收到的那个 id。
 */

/**
 * 会话叶的身体。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:挂载 = 某棵树里出现这一格(出厂那一片、或者从会话列表拖一行
 *     进来、或者分屏);**换宿主**(搬进架子 / 撕成浮窗)由结构共享保证不重挂;
 *     **换会话**(`replaceRef`)换的是这一格的 refId,内容层按 refId 分格,
 *     所以那是一次**这一格**的重挂,兄弟叶一动不动(零重挂断言守的正是后半句);
 *     卸载 = 这一格被关掉 / 藏起来 / 整区收掉。数据机器的寿命**不跟着挂载走**
 *     —— 它由「树里 ∪ 隐藏表里还有没有这条会话」决定(判词在
 *     `content/session-projection.ts` 的那本引用账上),所以藏起来的会话叶
 *     照样收流。无模块级副作用 → 组件这一层不需要 HMR dispose。
 *  ② UI 生命状态:空 / 载入中 / 就绪 / 错误全部由 `ChatStream` 自己说;
 *     目录 rail 在没有锚点时整条不在场。
 *  ③ UI 交互状态:这一层不画任何控件,交互状态全在它包着的两件上。
 */
function SessionLeaf({ contentRef }: { contentRef: ContentRef }) {
  /*
   * **这一片叶看哪条会话 = 这一格自己的 key**(W5-b)。保留键读作空串
   * ——「还没绑会话」那一态,与从前 `currentSessionId === ''` 逐字同义。
   */
  const sessionId = sessionIdOfRef(contentRef) ?? ''
  // 聊天滚动容器只有一个 ref,两个消费者:TOC 当前键 与 目录跳转。
  const chatRef = useRef<HTMLDivElement>(null)
  const { currentIndex, flashMessageId, syncFromScroll, pickTurn } = useChatToc(sessionId, chatRef)
  /*
   * 09-01 用户裁定退役了「滚动降淡」之后,这条监听只剩这一件事。
   * 它仍然套一层 `useCallback`:`ChatStream` 把它挂在滚动容器上,身份一变就重挂一次监听。
   */
  const onScroll = useCallback(() => {
    syncFromScroll()
  }, [syncFromScroll])

  return (
    <div className={s.chatArea}>
      <SessionIdentity contentRef={contentRef} sessionId={sessionId} />
      {/* 聊天区与输入框**各一界**:消息流炸了还能打字,输入框炸了还能读历史。
        * (输入框不在这片叶里 —— 它是 `.center` 上那一格落位带,路线 B 照旧。) */}
      <ErrorBoundary where="chat">
        <ChatStream
          sessionId={sessionId}
          scrollRef={chatRef}
          onScroll={onScroll}
          flashMessageId={flashMessageId}
        />
      </ErrorBoundary>
      <TocPanel sessionId={sessionId} currentIndex={currentIndex} onPick={pickTurn} />
    </div>
  )
}

/**
 * **这一格此刻在显示哪条会话**(W1-b;W5-b 起它按 `ref.key` 各说各的)。
 * 一个**零 DOM 的叶子组件**。
 *
 * 设计 §2.2 的 D 稿:「只有一片会话叶时,顶栏画的就是那一个标签 = 今天的会话
 * 标题」。会话多开之后这句话推广成:**每一格会话标签画的是它自己那条会话的名字**
 * —— 而那正是「身份由内容自答」这条契约的字面兑现(键 = refId,一格一份)。
 *
 * 为什么单独占一个零 DOM 的组件,而不是几行写进 `SessionLeaf`:那样 `SessionLeaf`
 * 就订上了整张会话表,**会话列表一动整条聊天流重渲一遍**(09-03 流式卡死那一批
 * 的同型病:订阅按「谁真的读那个值」算,不按「谁方便挂」算)。这样一来重渲的
 * 只有它自己,而它渲染 `null`。
 *
 * 生命周期:随这片叶挂载 / 卸载;卸载时**收回**那格活标题(留着等于让下一次挂载
 * 先读到一份陈旧的名字)。组件级,不是模块级 —— 不需要 HMR dispose。
 */
function SessionIdentity({
  contentRef,
  sessionId,
}: {
  contentRef: ContentRef
  sessionId: string
}): null {
  const tr = useT()
  const sessions = useSessionsSource((st) => st.sessions)
  // 会话标题是**数据**(用户或后端给这条会话起的名),不翻译;
  // 只有「这一格还没绑会话」时的兜底名才是界面文案。
  const text = findSession(sessions, sessionId)?.title ?? tr('topbar.newSession')
  const id = refId(contentRef)
  useEffect(() => {
    useLiveTitleStore.getState().setLiveTitle(id, { text })
    return () => useLiveTitleStore.getState().setLiveTitle(id, null)
  }, [id, text])
  return null
}

/**
 * **播种时摆哪条会话**(`ContentKind.resident.seed` 的落点,裁定 2)。
 *
 * 「此刻的当前会话」——但它得**真的还在名册上**:死会话清洗那一拍会调到这里
 * (`sweepRefs` 把最后一格常驻原位换成新播的那一格),而那时投影里那条恰恰是
 * 刚被删掉的。名册里没有 = 答保留键,也就是「一片还没绑会话的会话叶」。
 *
 * 名册还没到(冷启动头几帧)时**也答保留键**:那时 `currentSessions()` 是空表,
 * 而「猜一条会话」比「诚实地画一片空会话叶」糟得多 —— 投影随后会把它换掉。
 *
 * 它长在这只文件里而不是投影那只,是因为 `seed()` 是**这一种内容的自述**:
 * 「出厂那一片摆哪条会话」只有会话自己答得出。核心层照旧不认识这个字符串。
 */
export function seedSessionKey(): string {
  const id = useExposeStore.getState().currentSessionId
  if (!id) return NEW_SESSION_KEY
  return currentSessions().some((session) => session.id === id) ? id : NEW_SESSION_KEY
}

registerContentKind(
  {
    id: SESSION_KIND,
    /*
     * **不是单例**(裁定 1):两条会话可以并排各占一片叶,同一条会话也可以在
     * 两处各开一格(拖一份到旁边对照着看 —— 与 `file` 同一条理由)。
     */
    singleton: false,
    /*
     * 常驻中央区。`seed()` 每次播种现问一次「此刻该摆哪条会话」——
     * 判据本体在 `content/session-projection.ts`(它认得投影与名册),
     * 这一行只是把那句话挂在自己的自述上。
     */
    resident: { region: CENTER_REGION, seed: seedSessionKey },
    /*
     * **`regions` 缺席 = 哪个区域都行**(裁定 8)。W1 这里写着 `[CENTER_REGION]`,
     * 那时的注脚是「撕进浮窗 / 钉到边由 W5 解禁,解禁 = 改这一行」——
     * 兑现的方式正是**删掉**这一行。
     */
    /*
     * 路线 B 之下输入框仍在树外,所以会话叶照旧进不了全屏(判词在
     * `ContentKind.fullable` 上)。
     */
    fullable: false,
    /**
     * **静态那一半**。会话名是数据,所以能问到名册就问名册(两片叶的标签因此
     * 各画各的名字,不必等活标题那一半到);问不到(还没绑 / 名册还没到)才落回
     * 界面文案。活的那一半由 `SessionIdentity` 发布进 `stage/live-title`,
     * 活的盖静的。
     *
     * 读的是当下语言 —— 檐自己 `useT()` 订着 locale,切语言会重渲 tab 条,
     * 这一句于是重跑一次(非组件上下文的 `t()` 用法)。
     */
    title: (ref) => {
      const id = sessionIdOfRef(ref) ?? ''
      const named = id ? findSession(currentSessions(), id)?.title : undefined
      return { text: named ?? t('topbar.newSession') }
    },
    icon: () => 'MessagesSquare',
    render: (ref) => <SessionLeaf contentRef={ref} />,
    /*
     * **激活这一格 = 焦点进它的输入面板**(W7-t / B3,`ContentKind.focusInto`)。
     *
     * 报障:点一格会话标签,焦点落在消息流上,直接打字进不去。而 §3.5 规则 1/2
     * 的原话就是「应用启动时是主内容(有会话则是它的输入面板)」「开会话 → 它的
     * 输入面板」—— 切一格会话标签与开一条会话是同一件事的两种手势,该落在同一处。
     *
     * 它是**这一种的自述**,不是 `focus-into` 里的一条 if:壳只读表,于是那只
     * 文件里一个种类名都没有(判词在 `ContentKind.focusInto` 上)。
     */
    focusInto: 'composer',
    /**
     * **关掉 = 丢实例**(与 `file` / `pair` 同一条)。这一种要清的是**这条会话
     * 那一份草稿**(W7-t / B2):输入框里没发出去的话、挂着的附件都跟着会话走,
     * 会话被关掉之后留着它等于让下一次开同一条会话读到一份陈年的草稿。
     *
     * 数据机器(`chat-source`)的寿命**不在这里** —— 它由引用账管(判词在
     * `content/session-projection.ts`:六条路会让一格会话离开树,`dispose` 只是
     * 其中一条,各写一遍迟早漏)。草稿相反:它只有「这条会话被真的关掉」这一个
     * 丢弃时机,藏起来的会话叶照样该留着稿。
     */
    dispose: (ref) => {
      /*
       * **空串是一格键,不是缺席**(09-06 审查逮到的账):`sessionIdOfRef` 对
       * 「新会话」那格保留键答的是 `''`(「是会话叶,但还没绑」),对「根本不是
       * 会话」才答 `null` —— 两者在调用方这里从来不是一件事(判词在
       * `content/session-ref.ts` 与 `composer/drafts.ts` 上,后者明写「不拿空串
       * 当缺席」)。修前这一句写的是 `if (id)`,于是**关掉「新会话」那一格永远
       * 丢不掉它的稿**(连同挂着的附件 URL),与「关掉 = 唯一的丢弃时机」相悖。
       */
      const id = sessionIdOfRef(ref)
      if (id !== null) dropComposerDraft(id)
    },
  },
  import.meta.hot,
)
