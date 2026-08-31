import { useRef, useState } from 'react'
import { Copy, RotateCcw } from '../../components/icons'
import { COPY_FEEDBACK_MS } from '../../components/motion'
import { useChatSource } from '../../data/chat-source'
import { useT } from '../../i18n'
import { announce } from '../../ui/a11y/live-region'
import s from './MessageChrome.module.css'

/**
 * 幽灵动作行 —— 台一「安静编辑器」的第三件。
 *
 * ── 何时出现 ──────────────────────────────────────────────────────────────
 * **生成完才谈动作**:流式期间这一行整个不在(那时候在的是读数行)。出现之后
 * 也不是常显 —— 悬停这条消息、或者焦点走进来,它才浮现。零底、零框、**零位移**
 * (占位常驻,只动 opacity;判据与写法见 MessageChrome.module.css 的第二节)。
 *
 * ── 词表 ──────────────────────────────────────────────────────────────────
 * 「复制」「重试」两个词,与 overlay 车道那条重试条用的是**同一个词**
 * (`chat.retry`)—— 同一件事在同一台上不该有两种叫法。首版没有第三颗「⋯」:
 * 拍板给它的首项是「复制为 Markdown」,而这条消息的正文本来就是 markdown 原文
 * (复制复制的就是它),两者逐字同实现 —— 那会是一个把同一件事说两遍的菜单。
 * 空菜单不许,只好先不画这颗钮;真有了第二件事再补。记在留账里。
 *
 * ── 用户消息为什么没有动作行 ─────────────────────────────────────────────
 * 用户消息的动作是「编辑重发」(EDIT_AND_RESEND),那是一件要**改内容**的事,
 * 需要一个就地编辑面 —— 不是给这一行加第三颗钮就完了。本批不做,留账。
 */

/**
 * 复制这条回复的**正文**。
 *
 * 取的是折叠产物上的 `content` —— 也就是这条 run 全部 text part 的 fold,
 * 代码块在里面就是围栏原文(它本来就是 markdown 文本,不是渲染出来的 HTML)。
 * 屏幕上那份富渲染是它的**投影**,反过来从 DOM 里抠字才是造事实。
 *
 * 剪贴板在渲染进程里是 `navigator.clipboard`,但它**不保证存在**(非安全上下文、
 * jsdom)。拿不到 / 写失败如实返回 false,反馈由按钮就地说(08-31 拍板:复制
 * 不走通知)—— 与块级动作那条路从此同一个形:成败都有回音,回音长在钮上。
 */
export async function copyMessageText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(() => true, () => false)
}

export function MessageActions({ messageId, text }: { messageId: string; text: string }) {
  const t = useT()
  const regenerate = useChatSource((st) => st.regenerate)
  /**
   * 复制的就地反馈(08-31 拍板:复制不走通知 —— 高频小动作,每按一下飞一条
   * toast 是噪音)。按下的这颗钮换字说「已复制 / 没能复制」一拍,同时进播报口
   * (读屏的回音);COPY_FEEDBACK_MS 后换回。
   */
  const [copied, setCopied] = useState<boolean | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  return (
    <div
      className={s.actions}
      data-testid="chat-actions"
      role="group"
      aria-label={t('chat.messageActions')}
    >
      <button
        type="button"
        className={s.ghost}
        data-testid="chat-action-copy"
        onClick={() => {
          void copyMessageText(text).then((ok) => {
            announce(t(ok ? 'common.copied' : 'common.copyFailed'))
            setCopied(ok)
            clearTimeout(copiedTimer.current)
            copiedTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
          })
        }}
      >
        <Copy className={s.ghostIcon} strokeWidth={1.9} aria-hidden="true" />
        {copied === null ? t('chat.copy') : t(copied ? 'common.copied' : 'common.copyFailed')}
      </button>
      {/*
        重试 = core 的 `command:retry-message`(端口那一口照 abort 惯例:同一条
        命令总线,一个字段都不多给)。**壳不动屏幕** —— 重跑会在账本上开一条新
        run,屏幕跟着折叠产物走。
      */}
      <button
        type="button"
        className={s.ghost}
        data-testid="chat-action-retry"
        onClick={() => regenerate(messageId)}
      >
        <RotateCcw className={s.ghostIcon} strokeWidth={1.9} aria-hidden="true" />
        {t('chat.retry')}
      </button>
    </div>
  )
}
