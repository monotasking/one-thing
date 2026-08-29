import { useEffect } from 'react'
import { ChevronLeft, ChevronRight, X } from '../../components/icons'
import { SKELETON_DELAY_MS } from '../../components/motion'
import { useDelayedFlag } from '../../components/useDelayedFlag'
import { Button } from '../../ui/Button'
import { Kbd } from '../../ui/Kbd'
import { plural, useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { useSessionsSource } from '../../data/sessions-source'
import { findSession } from '../projection'
import { useExposeStore } from '../store'
import { quickLookNeighbors } from '../transitions'
import type { SessionKind, SessionPreviewMessage } from '../types'
import { useSessionTime } from './session-time'
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
  const timeOf = useSessionTime()
  const closeQuickLook = useExposeStore((st) => st.closeQuickLook)
  const enterSession = useExposeStore((st) => st.enterSession)
  const quickLookPrev = useExposeStore((st) => st.quickLookPrev)
  const quickLookNext = useExposeStore((st) => st.quickLookNext)
  const sessions = useSessionsSource((st) => st.sessions)
  const groups = useSessionsSource((st) => st.groups)
  const messages = useSessionsSource((st) => st.messages[sessionId])
  const ensureMessages = useSessionsSource((st) => st.ensureMessages)
  const session = findSession(sessions, sessionId)

  /*
   * ‹ › 的可用性和键盘的 ← → 共用**同一个判据**(quickLookNeighbors 读的正是
   * quickLookStep 那条 visibleCardIds),所以不会出现「按钮灰着但方向键还能走」。
   * 序列是**搜索过滤之后**的那一条:搜着词开预览,左右就在命中的几张卡之间走。
   * 两个选择器各取一个 id 而不是一次取回 {prev,next} —— 后者每次渲染都是新对象,
   * zustand 的 Object.is 会判成「变了」,当场变成无限重渲染。
   */
  const prevId = useExposeStore((st) => quickLookNeighbors(st, groups).prev)
  const nextId = useExposeStore((st) => quickLookNeighbors(st, groups).next)

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
/* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 遮罩点击关闭是**鼠标的顺手路**,不是唯一出口:Esc 已经能关(键盘监听见本文件 /
     * ExposeView 的 escape 分支),关闭按钮也在。规则看不见那条键盘路径,所以它在这里
     * 是误报。刻意不给它 role="button":遮罩不是按钮,报成按钮会让读屏软件念出一个
     * 不存在的控件。 */
    <div
      className={s.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeQuickLook()
      }}
    >
      <section className={s.panel} role="dialog" aria-label={session.title}>
        <header className={s.header}>
          <div className={s.headText}>
            <div className={s.titleLine}>
              <span className={s.title}>{session.title}</span>
              <span className={s.kind} title={t(KIND_TITLE[session.kind])}>
                {t(KIND_BADGE[session.kind])}
              </span>
            </div>

            {/*
             * meta 行:模型 / agent / 消息数 / 时间。四格都有产地(SessionMeta 的
             * lastModel / agentId / messageCount / updatedAt),缺席的格不画。
             *
             * 消息数(H 批接上 E 批的 `messageCount`)排在时间之前:时间是这一行的
             * 落款,读到它就该到头了,所以新来的格长在它左边。它不是徽而是一句话,
             * 所以走 `.count`(纯文字)而不是 `.chip`(空心描边)。
             * `null` 才是缺席 —— **0 会照常画**,一条真的空会话就该说自己是 0 条
             * (判据在 projection.sessionMessageCountOf,组件不再判一次)。
             */}
            <div className={s.metaLine} data-testid="quicklook-meta">
              {session.model && (
                <span className={s.chip} title={t('quicklook.modelTitle', { model: session.model })}>
                  {session.model}
                </span>
              )}
              {session.agentId && (
                <span
                  className={s.chip}
                  title={t('quicklook.agentTitle', { agent: session.agentId })}
                >
                  {session.agentId}
                </span>
              )}
              {session.messageCount !== null && (
                <span className={s.count} data-testid="quicklook-message-count">
                  {t(
                    plural(
                      session.messageCount,
                      'quicklook.messageCountOne',
                      'quicklook.messageCount',
                    ),
                    { count: session.messageCount },
                  )}
                </span>
              )}
              <span className={s.time}>{timeOf(session.updatedAt)}</span>
            </div>
          </div>

          {/*
           * 鼠标党的那条路。键盘党走 ← →(ExposeView 的按键表),两条路同一对
           * store action、同一个禁用判据 —— 到头就停,不回卷(与检索面板走行同判例)。
           */}
          <div className={s.nav}>
            <Button
              iconOnly
              disabled={prevId === null}
              aria-label={t('quicklook.prev')}
              data-testid="quicklook-prev"
              onClick={quickLookPrev}
            >
              <ChevronLeft className={s.navIcon} strokeWidth={1.75} aria-hidden="true" />
            </Button>
            <Button
              iconOnly
              disabled={nextId === null}
              aria-label={t('quicklook.next')}
              data-testid="quicklook-next"
              onClick={quickLookNext}
            >
              <ChevronRight className={s.navIcon} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </div>

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
