import { useEffect, useState, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import s from './SegmentView.module.css'

/**
 * 思考段 —— **定稿形**(六轮比稿的 S2)。
 *
 * ── 一句话:它是同一段字的两个读法,不是两块内容 ────────────────────────
 * 收起时是**原文钳成一行**(斜体、灰、不可选中);点开时**原位继续往下读**(可圈选)。
 * 没有秒数、没有圆点、没有左竖线 —— 三样都被六轮比稿否掉了:秒数是在给一件不确定
 * 的事编一个精确读数,圆点和竖线是在给一段「顺带看看」的字加仪式感。
 * 左竖线还额外撞上全域禁令(引线全仓禁用),所以它连作为装饰都不成立。
 *
 * ── 三条行为,各有各的理由 ────────────────────────────────────────────
 * ① **流式中自动展开,收尾自动折**:正在想的时候,那段字是此刻唯一在动的东西,
 *    人要看;想完了,它就退回成一行索引。这两下都是**跟着事实走**(live 是折叠器
 *    给的),不是替用户记偏好。
 * ② **圈选不收**:展开之后正文可圈选,而「选中一段字」的收尾动作恰好是一次
 *    mouseup/click —— 不判一下选区,用户每次复制到一半这段就自己关了。判据是
 *    `getSelection().isCollapsed`:选区是空的才当作「点了一下」。
 * ③ **原地再点收起**:收起钮不另设一个热区。整块就是它自己的开关 —— 一件东西一个
 *    交互面,少一个要找的小三角。
 */
export function ThinkingSegment({ text, live }: { text: string; live: boolean }) {
  const t = useT()
  const [expanded, setExpanded] = useState(live)

  // 跟着 live 走:开始想就展开,想完就折回去。用户在**非流式**时手动展开的那一份
  // 不会被这里推翻(live 没变,effect 不跑)。
  useEffect(() => {
    setExpanded(live)
  }, [live])

  const toggle = () => {
    // 展开态下,选区非空 = 用户在圈字,不是在点这块 —— 什么都不做。
    if (expanded && !selectionIsEmpty()) return
    setExpanded((open) => !open)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setExpanded((open) => !open)
  }

  return (
    <div
      className={expanded ? `${s.thought} ${s.thoughtOpen}` : s.thought}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={t('chat.thought')}
      /*
       * 节奏表的钩子(表在 content/ChatStream.module.css)。思考段从前不报身份,
       * 吃默认档「它是字」—— 对「思考 → 正文」那一侧是对的,对「思考 → 思考」
       * 那一侧不对:同一股思考流被流切成的两截,按段距排等于宣布中间发生过别的事。
       * 报了身份,表才说得出「同类相接要紧」这句话(那里的 ④)。
       */
      data-prose="thought"
      data-testid="chat-thought"
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      <p className={s.thoughtBody}>{text}</p>
    </div>
  )
}

/**
 * 选区是不是空的。
 *
 * 拿不到 selection(非浏览器环境)按「空」算:这条判据只用来**否决**收起,
 * 拿不到时的正确行为是让点击照常生效,而不是让这块再也关不上。
 */
function selectionIsEmpty(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return true
  return window.getSelection()?.isCollapsed !== false
}
