import { useEffect, useRef } from 'react'
import { Eye } from '../../components/icons'
import { Button } from '../../ui/Button'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { SessionKind, SessionSummary } from '../types'
import { useSessionTime } from './session-time'
import s from './SessionCard.module.css'

interface Props {
  session: SessionSummary
  current: boolean
  focused: boolean
  onEnter: () => void
  /** Quick Look 的**鼠标**入口(键盘入口是 Space,在 ExposeView 里) */
  onQuickLook: () => void
}

/** kind 徽的字面:一个字就够。'chat' 不出徽 —— 绝大多数会话都是它,满屏一个字没有信息。 */
const KIND_BADGE: Record<Exclude<SessionKind, 'chat'>, MessageKey> = {
  room: 'kind.roomBadge',
  dm: 'kind.dmBadge',
  work: 'kind.workBadge',
  agent: 'kind.agentBadge',
}
const KIND_TITLE: Record<Exclude<SessionKind, 'chat'>, MessageKey> = {
  room: 'kind.room',
  dm: 'kind.dm',
  work: 'kind.work',
  agent: 'kind.agent',
}

/**
 * 卡是一个 <button>,而预览入口是**它的兄弟**而不是它的孩子 ——
 * button 里嵌 button 是非法 HTML,浏览器会当场把内层拆出去。
 * 所以外面包一层 .wrap:卡铺满它,幽灵按钮浮在它的右上角。
 * 两者互不嵌套 ⇒ 点预览不会顺带触发「进入」,一行 stopPropagation 都不用写。
 *
 * D1(接真数据)之后卡面少了三样东西:改动数 / 测试通过 / 未读数 / 房间头像。
 * 它们在 `SessionMeta` 上没有产地 —— 一张永远显示「2 处改动」的卡是在说谎。
 */
export function SessionCard({ session, current, focused, onEnter, onQuickLook }: Props) {
  const t = useT()
  const timeOf = useSessionTime()
  const ref = useRef<HTMLButtonElement>(null)

  // 键盘走到视口外的卡时把它带回来。滚动是渲染层的事,状态机不该知道。
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const cls = [s.card, current ? s.current : '', focused ? s.focused : ''].filter(Boolean).join(' ')
  const kind = session.kind === 'chat' ? undefined : session.kind

  return (
    <div className={s.wrap}>
      <button
        ref={ref}
        type="button"
        className={cls}
        data-testid={`card-${session.id}`}
        data-session-id={session.id}
        onClick={onEnter}
        aria-current={current ? 'true' : undefined}
      >
        <div className={s.head}>
          <span className={s.title}>{session.title}</span>
          {kind && (
            <span className={s.kind} title={t(KIND_TITLE[kind])}>
              {t(KIND_BADGE[kind])}
            </span>
          )}
        </div>

        <p className={s.summary}>{session.preview}</p>

        <div className={s.meta}>
          <span className={s.time}>{timeOf(session.updatedAt)}</span>
        </div>
      </button>

      {/*
       * 幽灵入口:**占位常驻**(永远在 DOM 里、永远占同一块地方),只动 opacity。
       * 条件渲染会让它出现时把别的东西挤一下,而这里连一像素的位移都不该有。
       */}
      <Button
        variant="ghost"
        pill
        iconOnly
        className={s.peek}
        aria-label={t('card.preview')}
        data-testid={`card-preview-${session.id}`}
        onClick={onQuickLook}
      >
        <Eye className={s.peekIcon} strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </div>
  )
}
