import { useEffect, useMemo, type RefObject } from 'react'
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

  return (
    <div ref={scrollRef} className={s.scroll} onScroll={onScroll} data-testid="chat-stream">
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
