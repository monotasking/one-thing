import { useEffect } from 'react'
import { X } from '../../components/icons'
import { SKELETON_DELAY_MS } from '../../components/motion'
import { useDelayedFlag } from '../../components/useDelayedFlag'
import { Button } from '../../ui/Button'
import { Kbd } from '../../ui/Kbd'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { useSessionsSource } from '../../data/sessions-source'
import { findSession } from '../projection'
import { useExposeStore } from '../store'
import type { SessionKind, SessionPreviewMessage } from '../types'
import s from './QuickLook.module.css'

/** kind 徽的字面:一个字就够,鼠标不用悬停也认得出这是哪一类会话。 */
const KIND_BADGE: Record<SessionKind, MessageKey> = {
  chat: 'kind.chatBadge',
  room: 'kind.roomBadge',
  dm: 'kind.dmBadge',
  work: 'kind.workBadge',
  agent: 'kind.agentBadge',
}
const KIND_TITLE: Record<SessionKind, MessageKey> = {
  chat: 'kind.chat',
  room: 'kind.room',
  dm: 'kind.dm',
  work: 'kind.work',
  agent: 'kind.agent',
}

const ROLE_KEY: Record<SessionPreviewMessage['role'], MessageKey> = {
  user: 'quicklook.roleUser',
  assistant: 'quicklook.roleAssistant',
  system: 'quicklook.roleSystem',
  error: 'quicklook.roleError',
}

/**
 * 一条消息在这里最多显示多少字。Quick Look 是「瞥一眼」,不是阅读器 ——
 * 超了就截,省略号是标点不是文案。
 */
const TEXT_MAX = 400

interface Props {
  sessionId: string
}

export function QuickLook({ sessionId }: Props) {
  const t = useT()
  const closeQuickLook = useExposeStore((st) => st.closeQuickLook)
  const enterSession = useExposeStore((st) => st.enterSession)
  const sessions = useSessionsSource((st) => st.sessions)
  const messages = useSessionsSource((st) => st.messages[sessionId])
  const ensureMessages = useSessionsSource((st) => st.ensureMessages)
  const session = findSession(sessions, sessionId)

  /*
   * 取数的触发点有两个,这里是**兜底**的那一个:store 壳在 openQuickLook /
   * quickLookPrev-Next 里已经叫过 ensureMessages,但缓存可能被 SSE 作废
   * (那条会话又说话了),那时就得在这里补一次。ensureMessages 自己幂等。
   */
  useEffect(() => {
    void ensureMessages(sessionId)
  }, [sessionId, ensureMessages])

  // 骨架延迟 150ms 才出:比这更快到手的页面不该闪一下。
  const showSkeleton = useDelayedFlag(messages === undefined, SKELETON_DELAY_MS)

  if (!session) return null

  return (
    <div
      className={s.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeQuickLook()
      }}
    >
      <section className={s.panel} role="dialog" aria-label={session.title}>
        <header className={s.header}>
          <span className={s.title}>{session.title}</span>
          <span className={s.kind} title={t(KIND_TITLE[session.kind])}>
            {t(KIND_BADGE[session.kind])}
          </span>
          <Button
            variant="primary"
            pill
            className={s.enter}
            onClick={() => enterSession(session.id)}
          >
            {t('quicklook.enter')}
          </Button>
          <button
            type="button"
            className={s.close}
            onClick={closeQuickLook}
            aria-label={t('quicklook.dismiss')}
          >
            <X className={s.closeIcon} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        {/* key 换了就重放一次淡入 —— 左右换会话时的 120ms 淡切靠这一行。 */}
        <div className={s.body} key={session.id} data-testid="quicklook-body">
          <div className={s.column}>
            {messages === undefined ? (
              showSkeleton ? (
                <div className={s.message} aria-label={t('quicklook.loading')}>
                  <span className={s.line} />
                  <span className={`${s.line} ${s.lineShort}`} />
                  <span className={s.line} />
                </div>
              ) : null
            ) : messages.length === 0 ? (
              <p className={s.empty}>{t('quicklook.empty')}</p>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={message.role === 'user' ? `${s.message} ${s.user}` : s.message}
                >
                  <span className={s.role}>{t(ROLE_KEY[message.role])}</span>
                  <p className={s.text}>
                    {message.text.length > TEXT_MAX
                      ? `${message.text.slice(0, TEXT_MAX)}…`
                      : message.text}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 快捷键条:键面走 ui/Kbd,说明走字典,组件里一个字面都没有。 */}
        <footer className={s.footer}>
          <Kbd>{t('shortcut.left')}</Kbd>
          <Kbd>{t('shortcut.right')}</Kbd>
          <span className={s.hint}>{t('quicklook.hintSwitch')}</span>
          <span className={s.dot}>·</span>
          <Kbd>{t('shortcut.space')}</Kbd>
          <Kbd>{t('shortcut.esc')}</Kbd>
          <span className={s.hint}>{t('quicklook.dismiss')}</span>
          <span className={s.dot}>·</span>
          <Kbd>{t('shortcut.enter')}</Kbd>
          <span className={s.hint}>{t('quicklook.hintEnter')}</span>
        </footer>
      </section>
    </div>
  )
}
