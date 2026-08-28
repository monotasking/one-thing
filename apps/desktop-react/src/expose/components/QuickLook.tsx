import { X } from '../../components/icons'
import { Button } from '../../ui/Button'
import { Kbd } from '../../ui/Kbd'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { findSession, turnTimeAt } from '../data'
import { useExposeStore } from '../store'
import type { SessionKind } from '../types'
import s from './QuickLook.module.css'

/** kind 徽的字面:一个字就够,鼠标不用悬停也认得出这是哪一类会话。 */
const KIND_BADGE: Record<SessionKind, MessageKey> = {
  chat: 'kind.chatBadge',
  room: 'kind.roomBadge',
  dm: 'kind.dmBadge',
}
const KIND_TITLE: Record<SessionKind, MessageKey> = {
  chat: 'kind.chat',
  room: 'kind.room',
  dm: 'kind.dm',
}

interface Props {
  sessionId: string
}

export function QuickLook({ sessionId }: Props) {
  const t = useT()
  const closeQuickLook = useExposeStore((st) => st.closeQuickLook)
  const enterSession = useExposeStore((st) => st.enterSession)
  const session = findSession(sessionId)
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
        <div className={s.body} key={session.id}>
          <div className={s.column}>
            {session.userTurns.map((turn, i) => (
              <div key={i} className={s.turn}>
                <div className={s.user}>{turn}</div>
                <div className={s.replyTime}>{turnTimeAt(i)}</div>
                <p className={s.reply} aria-hidden="true">
                  <span className={s.line} />
                  <span className={`${s.line} ${s.lineShort}`} />
                </p>
              </div>
            ))}
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
