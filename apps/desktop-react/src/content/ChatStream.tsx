import { useEffect, type RefObject } from 'react'
import { useChatSource } from '../data/chat-source'
import type { OverlayEntry, ProjectedMessage } from '../data/chat-fold'
import { useExposeStore } from '../expose/store'
import { useT, type MessageKey, type TFn } from '../i18n'
import { resolveIcon } from '../components/icons'
import s from './ChatStream.module.css'

const ToolIcon = resolveIcon('FolderTree')
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
 * ── 富渲染不在这一批 ──────────────────────────────────────────────────
 * 正文按**纯文本**画(`white-space: pre-wrap` 保留换行),工具调用折成一行摘要
 * (工具名 + 状态)。markdown / 代码高亮 / diff 视图 / 图片是后批(streamdown +
 * shiki)。这不是"暂时凑合",是这一批只负责把数据链路换成真的。
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

/**
 * 工具状态:**后端枚举 → 字典键**的一张明表。
 *
 * 不用 `` `chat.tool.${status}` as MessageKey `` 拼键 —— 那个断言会骗过类型检查,
 * 后端哪天加一档新状态就在运行时炸(`format` 拿到 undefined)。列成表之后,
 * 认不出来的状态**原样显示那个英文枚举**:那是事实,而编一句中文是猜。
 */
const TOOL_STATUS_KEYS: Record<string, MessageKey> = {
  pending: 'chat.tool.pending',
  queued: 'chat.tool.queued',
  received: 'chat.tool.received',
  executing: 'chat.tool.executing',
  completed: 'chat.tool.completed',
  failed: 'chat.tool.failed',
  cancelled: 'chat.tool.cancelled',
  'input-streaming': 'chat.tool.inputStreaming',
}

function toolStatusLabel(t: TFn, status: string): string {
  const key = TOOL_STATUS_KEYS[status]
  return key ? t(key) : status
}

interface RowProps {
  t: TFn
  message: ProjectedMessage
  streaming: boolean
  flash: boolean
}

function MessageRow({ t, message, streaming, flash }: RowProps) {
  const role = message.role
  const toolCalls = message.toolCalls ?? []
  const className = [s.row, flash && s.flash].filter(Boolean).join(' ')

  return (
    <article className={className} data-message-id={message.id} data-role={role}>
      {role === 'user' && <div className={s.user}>{message.content}</div>}

      {role === 'error' && (
        <div className={s.errorCard} role="alert">
          <span className={s.errorTitle}>{t('chat.errorCard')}</span>
          {/* 后端说的那句话原样显示 —— 不改写、不总结。 */}
          <span className={s.errorBody}>{message.errorDetails || message.content}</span>
        </div>
      )}

      {(role === 'assistant' || role === 'system') && (
        <>
          {/* 顶部推理落在 `message.reasoning`(不是 part)—— 折叠器与活尾巴同一个落点。 */}
          {message.reasoning && (
            <div className={s.thought}>
              <span className={s.thoughtLabel}>{t('chat.thought')}</span>
              <p className={s.thoughtBody}>{message.reasoning}</p>
            </div>
          )}
          {message.content && <p className={s.body}>{message.content}</p>}
          {toolCalls.map((call) => (
            <div key={call.id} className={s.toolCard} data-tool-status={call.status}>
              <ToolIcon className={s.toolIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.toolName}>{call.toolName || call.toolId}</span>
              <span className={s.toolStatus}>{toolStatusLabel(t, call.status)}</span>
            </div>
          ))}
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
