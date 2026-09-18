import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation } from '../../data/kernel'
import { musicTellOp } from '../../data/music-source'
import { useHostReply } from '../../data/music-talk'

/**
 * **跟主持人说话的状态机**(正本 `apps/desktop-react/docs/music-panel-2026-09.md` §7.3)。
 *
 * 它是一只 hook 而不是说话那一行(`DeckRow`)里的几格 `useState`,理由只有一个:**这台状态机有两个
 * 消费者**。输入那一条自己要 echo 与错话,而唱机那一边的黑豆要 `listening`(你在打字)
 * 与 `busy`(他在想)—— 两块面读同一份真相,所以真相住在它们的父级(音乐面),由这只
 * hook 交出来。摆在 `DeckRow` 里再往上抬事件,就是让「他回没回话」有两个产地。
 *
 * ── 三条计时,三个理由 ──────────────────────────────────────────────────
 *  · **你的气泡停 6s**(`ECHO_HOLD_MS`)—— 它是回执不是记录:说完了看一眼「发出去了」,
 *    然后该让位给屏上真正的内容。不落盘、不进任何列表(§7.2 原话)。
 *  · **等他回话最多 60s**(`REPLY_GIVE_UP_MS`)—— 与后端那一侧**同一个数**,但两边各
 *    计各的:后端到点不发事件,壳到点把黑豆放回该在的姿势。壳这一侧不能只靠后端 ——
 *    那一发要是路上丢了(壳重连、面板刚挂上),黑豆会一直忙着。
 *  · 两条都是**读认窗口**不是动画(壳 CLAUDE.md 动效那条的原话),所以是这里的常量,
 *    不进 `components/motion.ts`,动效档调到「无」也照旧计时。
 *
 * ── 失败把字还回来,而且不覆盖人新打的 ──────────────────────────────────
 * §7.3 那一行只说「输入里的字还回来,别让人重打」。真机上还有一格:发出去到失败之间
 * 人可以接着打(那一格从来没禁用过),这时把旧话塞回去就是把他正在打的字吃掉。所以还
 * 那一下问一句「此刻空着吗」—— 空着才还。
 */

/** 你说的那句话在屏上停多久。 */
export const ECHO_HOLD_MS = 6_000

/** 等他回话等多久。与后端 `HOST_REPLY_TIMEOUT_MS` 同一个数。 */
export const REPLY_GIVE_UP_MS = 60_000

export interface HostTalk {
  /** 输入框里此刻的字。 */
  text: string
  setText: (next: string) => void
  /** 你刚说的那句(右对齐那枚气泡)。`null` = 没有或者已经散了。 */
  echo: string | null
  /** 发出去了还没等到他回话 —— 黑豆 `busy`。 */
  waiting: boolean
  /** 你在打字 —— 黑豆 `listening`。 */
  typing: boolean
  /** 这一发在飞。 */
  sending: boolean
  /** 后端那句错话(不发明文案)。 */
  error: string | undefined
  /** 回车发。空话什么都不做。 */
  send: () => void
  /** 点一颗建议词:**只填进输入框**,不直接发(§7.2)。 */
  pick: (words: string) => void
}

export function useHostTalk(): HostTalk {
  const [text, setText] = useState('')
  const [echo, setEcho] = useState<{ id: number; text: string } | null>(null)
  const [waiting, setWaiting] = useState<{ id: number; at: number } | null>(null)
  const seq = useRef(0)
  const tell = useMutation(musicTellOp)
  const repliedAt = useHostReply((state) => state.repliedAt)

  // 他回话了:从这一刻起黑豆不必再忙着。比的是时刻 —— 早于这一发的那些回话
  // (上一句话的回声、面板刚挂上时账上留着的那一格)不该把这一发收走。
  useEffect(() => {
    if (waiting && repliedAt > waiting.at) setWaiting(null)
  }, [repliedAt, waiting])

  // 等够了就放手,不提示 —— 他可能只是干了活没说话(§7.3 最后一行)。
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setWaiting((cur) => (cur?.id === waiting.id ? null : cur)), REPLY_GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [waiting])

  useEffect(() => {
    if (!echo) return
    const timer = setTimeout(() => setEcho((cur) => (cur?.id === echo.id ? null : cur)), ECHO_HOLD_MS)
    return () => clearTimeout(timer)
  }, [echo])

  const send = useCallback(() => {
    const words = text.trim()
    if (!words) return
    const id = ++seq.current
    // 先清框、先冒气泡:这一下的反馈不等往返(律①)。
    setText('')
    setEcho({ id, text: words })
    setWaiting({ id, at: Date.now() })
    void musicTellOp.run({ text: words }).then((sent) => {
      if (sent) return
      // 没发出去:气泡撤掉、别再等他,字还回来(空着才还,见文件头)。
      setEcho((cur) => (cur?.id === id ? null : cur))
      setWaiting((cur) => (cur?.id === id ? null : cur))
      setText((cur) => (cur.trim() ? cur : words))
    })
  }, [text])

  const pick = useCallback((words: string) => setText(words), [])

  return {
    text,
    setText,
    echo: echo?.text ?? null,
    waiting: waiting !== null,
    typing: text.trim().length > 0,
    sending: tell.pending,
    error: tell.error,
    send,
    pick,
  }
}
