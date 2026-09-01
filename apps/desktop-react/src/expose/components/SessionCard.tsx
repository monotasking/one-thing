import { useEffect, useRef } from 'react'
import { Eye } from '../../components/icons'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Tooltip } from '../../ui/Tooltip'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { SessionKind, SessionSummary } from '../types'
import { Highlight } from './Highlight'
import { useSessionTime } from './session-time'
import s from './SessionCard.module.css'

interface Props {
  session: SessionSummary
  /**
   * 当前搜索词。空串 = 没在搜,`Highlight` 原样返回一片文本(零 <mark>)。
   * 卡不认识「搜索」这件事,它只知道「这几个字要标出来」—— 命不命中由
   * `filterGroups` 在纯函数层判完了,能画到屏幕上的卡都是已经命中的。
   */
  query: string
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
export function SessionCard({ session, query, current, focused, onEnter, onQuickLook }: Props) {
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
      {/* 整张卡是一颗按钮 = 裸钮三类判第③类(结构性交互件)→ `ui/ButtonBase`
        * 只清 UA;卡面那一整套(描边 / 圆角 / 抗挤压内边距 / 当前 / 焦点)不动。 */}
      <ButtonBase
        ref={ref}
        className={cls}
        data-testid={`card-${session.id}`}
        data-session-id={session.id}
        onClick={onEnter}
        aria-current={current ? 'true' : undefined}
      >
        <div className={s.head}>
          <span className={s.title}>
            <Highlight text={session.title} query={query} />
          </span>
          {/* kind 徽只写一个字,全名靠提示补:native `title=` 换 `ui/Tooltip`
            * (禁令的字面执法),文案仍是同一个 KIND_TITLE 键。 */}
          {kind && (
            <Tooltip content={t(KIND_TITLE[kind])}>
              <span className={s.kind}>{t(KIND_BADGE[kind])}</span>
            </Tooltip>
          )}
        </div>

        <p className={s.summary}>
          <Highlight text={session.preview} query={query} />
        </p>

        {/*
         * ── 摘要行(H 批接上 E 批的 `lastMessagePreview`) ─────────────────
         * 产地 `SessionMeta.lastMessagePreview` —— **最后一条消息**的一行预览,
         * 与上面那行 `preview`(**第一条**用户消息)是并列的两格:
         * 一句说「从哪儿开的」,一句说「最近说到哪儿」。
         *
         * 缺席(投影给 null:老会话在写侧那一批上线前没有这一格)时**一个节点
         * 都不画** —— 无产地的格不占高,所以摘要来了卡才长高一行,而不是每张卡
         * 先空着一行等它。它也在搜索判据里(sessionMatchesQuery),
         * 「卡上看得见的才搜得到」两头对齐。
         */}
        {session.digest && (
          <p className={s.digest} data-testid={`card-digest-${session.id}`}>
            <Highlight text={session.digest} query={query} />
          </p>
        )}

        <div className={s.meta}>
          {/*
           * 模型徽:产地 `SessionMeta.lastModel`(上一轮实际跑的模型)。
           * 空心小 chip、单行截断 —— 模型名可以很长(`claude-opus-5[1m]`),
           * 它不该把时间挤出卡外。没跑过的会话没有这一格(projection 给的是 null)。
           */}
          {/* 模型徽单行截断,全名靠提示补。它是**数据**(模型名),不进字典 ——
            * 提示内容与徽面是同一个字符串,与从前那个 native `title=` 逐字相同。 */}
          {session.model && (
            <Tooltip content={session.model}>
              <span className={s.model}>{session.model}</span>
            </Tooltip>
          )}
          <span className={s.time}>{timeOf(session.updatedAt)}</span>
        </div>
      </ButtonBase>

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
