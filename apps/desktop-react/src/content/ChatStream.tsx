import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { useChatSource } from '../data/chat-source'
import type { OverlayEntry, ProjectedMessage } from '../data/chat-fold'
import { useExposeStore } from '../expose/store'
import { useT, type TFn } from '../i18n'
import { resolveIcon } from '../components/icons'
import { assembleMessage, segmentKey } from './assemble'
import type { SegmentModel } from './model/segments'
import { MessageSourceFoot } from './research/SourceFoot'
import { SegmentView } from './SegmentView'
import s from './ChatStream.module.css'

const ClipIcon = resolveIcon('Paperclip')
const RetryIcon = resolveIcon('RotateCcw')

interface Props {
  /** 滚动容器的 ref:TOC 要靠它量坐标、滚过去 */
  scrollRef?: RefObject<HTMLDivElement | null>
  onScroll?: () => void
  /** 正在高亮淡出的那条消息 id;null = 没有 */
  flashMessageId?: string | null
}

/**
 * 聊天区 —— **屏幕上画的就是 core 折叠器的输出**(D3,路线 A)。
 *
 * 这里是「怎么摆」,不是「摆什么」:一条消息长什么样由它自己的字段说了算,
 * 组件不推导任何结构(轮次、段落归属、工具卡挂在谁身上,全在折叠产物里)。
 *
 * ── 锚点约定 ──────────────────────────────────────────────────────────
 * 每条消息外框上挂 `data-message-id`。这是 TOC 与聊天区之间**唯一**的接缝:
 * 钢琴键的键来自 `sessions.getUserMarkers`(用户消息 id),落点就按这个属性找。
 * D1 时键的下标(真锚点列)与页面上的锚点(mock 轮次)并不同源,那条尾巴在
 * 这一批收掉了 —— 两边现在说的是**同一个 id**。
 *
 * ── 内容怎么画,不在这个文件里 ────────────────────────────────────────
 * assistant / system 那一支不再自己拼 JSX:一条消息经**装配管线**
 * (`assemble/`)算成一串段,这里只把段依次摆下去。ChatStream 因此不认识
 * 段落、代码块、工具卡里的任何一个 —— 加一种块 / 换一种工具展示,这个文件不动。
 *
 * 今天画出来的东西与从前逐字相同(纯文本正文 + 思考块 + 一行工具摘要):
 * P0 交付的是结构,markdown / 高亮 / diff / 工具三件套是后批(§9)。
 */
export function ChatStream({ scrollRef, onScroll, flashMessageId }: Props) {
  const t = useT()
  const sessionId = useExposeStore((st) => st.currentSessionId)
  const status = useChatSource((st) => st.status)
  const error = useChatSource((st) => st.error)
  const messages = useChatSource((st) => st.messages)
  const activeMessageId = useChatSource((st) => st.activeMessageId)
  const overlay = useChatSource((st) => st.overlay)
  const open = useChatSource((st) => st.open)

  // 会话是「此刻要看的东西」—— 换一条就重开一次(open 自己幂等)。
  useEffect(() => {
    void open(sessionId)
  }, [sessionId, open])

  /*
   * 进场落底盯的是**数据源自己报的会话**,不是外面那个 currentSessionId。
   * 两者差一拍:换会话时 `open()` 在 effect 里跑,所以「外面已经换了、树还是上一条
   * 会话的」这一帧真实存在 —— 拿外面那个当判据会在这一帧落到旧树上,然后把新树
   * 误判成「账本长出了新东西」而当场收手(结果就是换会话不落底)。
   * 数据源那一格与 `messages` 是**同一次 set** 写的,天然同步。
   */
  const foldedSessionId = useChatSource((st) => st.sessionId)
  const onScrollWithLanding = useEnterAtBottom(scrollRef, foldedSessionId, messages, onScroll)

  return (
    <div ref={scrollRef} className={s.scroll} onScroll={onScrollWithLanding} data-testid="chat-stream">
      <div className={s.column}>
        {/* 三种空态各说各话,一种都不回退到假数据(与 D1 同一条纪律)。 */}
        {!sessionId && <p className={s.empty}>{t('chat.noSession')}</p>}
        {sessionId && status === 'loading' && <p className={s.empty}>{t('chat.loading')}</p>}
        {sessionId && status === 'error' && (
          <p className={s.empty}>
            {t('chat.error')}
            <span className={s.errorText}>{error}</span>
          </p>
        )}
        {sessionId && status === 'ready' && messages.length === 0 && overlay.length === 0 && (
          <p className={s.empty}>{t('chat.empty')}</p>
        )}

        {messages.map((message) => (
          <MessageRow
            key={message.id}
            t={t}
            message={message}
            streaming={message.id === activeMessageId}
            flash={message.id === flashMessageId}
          />
        ))}

        {overlay.map((entry) => (
          <OverlayRow key={entry.id} t={t} entry={entry} />
        ))}
      </div>
    </div>
  )
}

/**
 * 「已经在底了」的容差:一像素级的小数误差(缩放、亚像素行高)不该被当成
 * 「用户往上翻了」。
 */
const AT_BOTTOM_EPS = 2

/**
 * **进会话就落在最新那条**(08-31 真机回访 · 报障二)。
 *
 * 从前一条都没有:整个应用里没有任何一处写过 scrollTop,于是打开 / 切换会话永远
 * 停在第一条消息(真机读数 scrollTop=0,离底 2686px)。人打开一条会话是要接着往下
 * 说,不是从头读一遍。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────────
 * ① **首帧就在底,不许先画顶部再跳**。所以用 `useLayoutEffect` 而不是 `useEffect`:
 *    前者在浏览器绘制**之前**跑完,人看到的第一帧就已经在底部;后者会先绘一帧顶部,
 *    再跳 —— 那一下闪动比停在顶部更难看。也因此是 `scrollTop = …` 直接赋值,
 *    不是 `scrollTo({behavior:'smooth'})`:定位不是动效(与动效档无关,「无」档下
 *    它照样得工作)。
 * ② **落底要熬过内容自己长高**。起底那一刻消息树已经全在 DOM 里了,但代码高亮
 *    (shiki)与图(mermaid)是异步渲染的,落完之后那些块会把页面撑高几百像素,
 *    只落一次就会停在半路。所以本批盯着容器的高度变化,长高一次就重新落一次。
 * ③ **盯到什么时候为止**:两个出口,谁先到算谁 ——
 *      · 用户往上翻(滚动事件读到「不在底」)→ 本次进场结束,交还给人;
 *      · **消息树换了引用**(账本长出新东西 / 活尾巴推进)→ 也结束。
 *    第二个出口是**故意**的:再盯下去就成了「流式跟底」,而跟底是另一件事
 *    (要判「人是不是正在往回看」、要与 TOC 的跳转互不打架),本批不做,记在
 *    汇报的留账里。异步高亮不换消息引用,所以 ② 与这条不冲突。
 */
function useEnterAtBottom(
  scrollRef: RefObject<HTMLDivElement | null> | undefined,
  sessionId: string,
  messages: readonly ProjectedMessage[],
  onScroll: (() => void) | undefined,
): () => void {
  /** 本次进场还在盯底吗。两个出口(见上面 ③)任一到达就翻成 false。 */
  const landingRef = useRef(false)
  /** 落底那一刻的消息树引用 —— 它一换就是「账本长出了新东西」。 */
  const landedOnRef = useRef<readonly ProjectedMessage[] | undefined>(undefined)

  // 换会话 = 一次新的进场。写在 layout 阶段,好让同一次提交里下面那个 effect 看到它。
  useLayoutEffect(() => {
    landingRef.current = true
    landedOnRef.current = undefined
  }, [sessionId])

  useLayoutEffect(() => {
    if (!landingRef.current) return
    const el = scrollRef?.current
    if (!el) return
    // 还没起底(空树)时不落:此刻 scrollHeight 就是视口高,落了等于什么都没做,
    // 而 `landedOnRef` 会被钉在那个空数组上,真内容一到就被判成「账本长出新东西」。
    if (messages.length === 0) return
    if (landedOnRef.current && landedOnRef.current !== messages) {
      // 出口二:账本推进了。进场到此为止。
      landingRef.current = false
      return
    }
    landedOnRef.current = messages
    el.scrollTop = el.scrollHeight
  })

  // 纪律 ② 的落点:内容自己长高(异步高亮 / 图)不经过 React 的提交,所以盯 DOM。
  useLayoutEffect(() => {
    const el = scrollRef?.current
    if (!el || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      if (!landingRef.current) return
      if (!landedOnRef.current) return
      el.scrollTop = el.scrollHeight
    })
    // 盯**内容那一层**:容器自己的高度是外壳给的,不随内容变。
    const column = el.firstElementChild
    if (column) observer.observe(column)
    return () => observer.disconnect()
  }, [scrollRef, sessionId])

  /**
   * 滚动事件是出口一的判据。**我们自己落底也会发滚动事件**,所以不能一见滚动就
   * 收手 —— 判据写成「停的位置不在底」:自己落的那几下正正好在底(误差 < 2px),
   * 人往上翻才会离底。这样就不必维护一个「这一下是我自己滚的」标志位,
   * 而标志位正是这类代码最容易漏掉一条路径的地方。
   */
  return useCallback(() => {
    const el = scrollRef?.current
    if (el && landingRef.current) {
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop
      if (gap > AT_BOTTOM_EPS) landingRef.current = false
    }
    onScroll?.()
  }, [scrollRef, onScroll])
}

/** 不装配的那两种角色共用同一个空数组 —— 每次新造一个会让下游的浅比全部落空。 */
const EMPTY_SEGMENTS: SegmentModel[] = []

interface RowProps {
  t: TFn
  message: ProjectedMessage
  streaming: boolean
  flash: boolean
}

function MessageRow({ t, message, streaming, flash }: RowProps) {
  const role = message.role
  const className = [s.row, flash && s.flash].filter(Boolean).join(' ')

  // 只有模型说的话要装配。用户消息是一个气泡、错误消息是一张卡,它们没有段 ——
  // 给它们也跑一遍管线不只是白跑,还会往 memo 里塞一份永远没人读的段序列。
  //
  // 装配是纯函数 + 按消息引用 memo,所以这一句在非活跃消息上是一次 WeakMap 命中。
  const prose = role === 'assistant' || role === 'system'
  const segments = prose ? assembleMessage(message) : EMPTY_SEGMENTS
  const ctx = useMemo(
    () => ({ messageId: message.id, streaming }),
    [message.id, streaming],
  )

  return (
    <article className={className} data-message-id={message.id} data-role={role}>
      {role === 'user' && <div className={s.user}>{message.content}</div>}

      {/* data-prose:节奏表的钩子 —— 错误卡是一件东西,按物件档留白(节奏表在
          ChatStream.module.css)。 */}
      {role === 'error' && (
        <div className={s.errorCard} role="alert" data-prose="object">
          <span className={s.errorTitle}>{t('chat.errorCard')}</span>
          {/* 后端说的那句话原样显示 —— 不改写、不总结。 */}
          <span className={s.errorBody}>{message.errorDetails || message.content}</span>
        </div>
      )}

      {prose && (
        <>
          {segments.map((segment, index) => {
            const key = segmentKey(message.id, index, segment)
            return <SegmentView key={key} segment={segment} segmentKey={key} ctx={ctx} />
          })}
          {/*
            消息尾来源条(§5.3 四件套之四):这条回复的依据在哪。它是**消息**的
            尾注,不是某个段的一部分 —— 所以由这一层摆,而不是 SegmentView。
            这个文件对检索一无所知:没有检索段时组件自己返回 null。
          */}
          <MessageSourceFoot segments={segments} messageId={message.id} />
          {/*
            光标是**数据源的事实**(activeMessageId),不是这条消息自己的事实,
            而装配管线只拿得到消息 —— 所以它留在这一层画,没有进段序列。
          */}
          {streaming && (
            <span className={s.cursor} data-testid="chat-streaming" aria-label={t('chat.streaming')} />
          )}
        </>
      )}
    </article>
  )
}

function OverlayRow({ t, entry }: { t: TFn; entry: OverlayEntry }) {
  const retry = useChatSource((st) => st.retry)
  const dismiss = useChatSource((st) => st.dismiss)

  // 拒绝也进流:一次没回答**也是一次回答**,不该在记录里消失,只是说得轻一点。
  if (entry.kind === 'notice') {
    return <div className={`${s.user} ${s.declined}`}>{t('ask.rejected')}</div>
  }

  const failed = entry.status === 'failed'
  return (
    <div
      className={[s.user, s.pending, failed && s.pendingFailed].filter(Boolean).join(' ')}
      data-testid={`chat-pending-${entry.status}`}
    >
      {entry.text}
      {entry.attachments > 0 && (
        <span className={s.sentAtt}>
          <ClipIcon className={s.sentAttIcon} strokeWidth={1.8} aria-hidden="true" />
          {entry.attachments}
        </span>
      )}
      {failed && (
        <span className={s.pendingFoot}>
          {/* 失败的理由照抄后端说的 —— 渲染层不替它编一句更好听的。 */}
          <span className={s.pendingError}>{entry.error}</span>
          <button type="button" className={s.pendingAction} onClick={() => retry(entry.id)}>
            <RetryIcon className={s.pendingIcon} strokeWidth={1.9} aria-hidden="true" />
            {t('chat.retry')}
          </button>
          <button type="button" className={s.pendingAction} onClick={() => dismiss(entry.id)}>
            {t('chat.discard')}
          </button>
        </span>
      )}
    </div>
  )
}
