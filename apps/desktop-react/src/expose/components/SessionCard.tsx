import { useEffect, useRef } from 'react'
import { Eye } from '../../components/icons'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { useT } from '../../i18n'
import type { SessionMock } from '../types'
import s from './SessionCard.module.css'

interface Props {
  session: SessionMock
  current: boolean
  focused: boolean
  onEnter: () => void
  /** Quick Look 的**鼠标**入口(键盘入口是 Space,在 ExposeView 里) */
  onQuickLook: () => void
}

/** 头像底色按序号轮换,不带语义 —— 只是让三个人看起来是三个人。 */
const TINTS = [s.tintAccent, s.tintOk, s.tintDanger]

/**
 * 卡是一个 <button>,而预览入口是**它的兄弟**而不是它的孩子 ——
 * button 里嵌 button 是非法 HTML,浏览器会当场把内层拆出去。
 * 所以外面包一层 .wrap:卡铺满它,幽灵按钮浮在它的右上角。
 * 两者互不嵌套 ⇒ 点预览不会顺带触发「进入」,一行 stopPropagation 都不用写。
 */
export function SessionCard({ session, current, focused, onEnter, onQuickLook }: Props) {
  const t = useT()
  const ref = useRef<HTMLButtonElement>(null)

  // 键盘走到视口外的卡时把它带回来。滚动是渲染层的事,状态机不该知道。
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const cls = [s.card, current ? s.current : '', focused ? s.focused : ''].filter(Boolean).join(' ')

  return (
    <div className={s.wrap}>
      <button
        ref={ref}
        type="button"
        className={cls}
        onClick={onEnter}
        aria-current={current ? 'true' : undefined}
      >
        <div className={s.head}>
          <span className={s.title}>{session.title}</span>
          {session.members && (
            <span className={s.avatars}>
              {session.members.map((m, i) => (
                <span key={m} className={`${s.avatar} ${TINTS[i % TINTS.length]}`}>
                  {m}
                </span>
              ))}
            </span>
          )}
          {session.unread !== undefined && <Badge tone="unread">{session.unread}</Badge>}
        </div>

        <p className={s.summary}>{session.summary}</p>

        {session.live && (
          <div className={s.live}>
            <i className={s.liveDot} aria-hidden="true" />
            <span className={s.liveText}>{session.live}</span>
          </div>
        )}

        <div className={s.meta}>
          {session.badges?.diff !== undefined && (
            <span className={s.stat}>
              <i className={s.diffDot} aria-hidden="true" />
              {session.badges.diff}
            </span>
          )}
          {session.badges?.testOk && (
            <span className={s.stat}>
              <i className={s.okDot} aria-hidden="true" />
              {t('card.passed')}
            </span>
          )}
          <span className={s.time}>{session.time}</span>
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
