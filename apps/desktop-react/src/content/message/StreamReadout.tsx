import { useEffect, useState } from 'react'
import { composerSink } from '../../composer/sink'
import { useT } from '../../i18n'
import s from './MessageChrome.module.css'

/**
 * 流式读数行 —— 台一「安静编辑器」的第二件(第一件是尾部那枚呼吸光标,
 * 它在 ChatStream 里,本批一个字没动)。
 *
 * 一行话回答两个问题:**还活着吗**(数字在跳)、**跑了多久**;外加一个出口:停止。
 *
 * ── 耗时的产地 ────────────────────────────────────────────────────────────
 * `startedAt` = 这条助手消息的 `timestamp`,而它是账本上 `run/start` 自己带的
 * 时刻(core 的 `materializeAssistantNode`:`time: event.data.timestamp ?? event.time`)。
 * 所以这不是"壳收到推送的那一刻"—— 断线重连、整份重折之后它一个数都不变,
 * 而本地起的表会在每一次重折时归零。**没有第二个产地**:壳这边一格都不记。
 *
 * ── tokens 那一格为什么不在这行字里 ───────────────────────────────────────
 * 流分片(`session:stream` 的 chunk)**不带用量**(`packages/core/events` 的
 * chunk 词汇里没有 usage 这一格),而消息级 `usage` 在投影里是被
 * `outcome === 'completed'` 闸住的 —— 这一轮跑完才有。也就是说流式期间壳手上
 * **没有**一个诚实的 token 读数。用字符数或 delta 条数冒充是造事实,所以这行字
 * 只说耗时。真产地(逐轮结算的 `steps[].usage`)要不要显示是一次拍板,记在留账里。
 *
 * ── 动效档 ────────────────────────────────────────────────────────────────
 * 这一行属动效三分类的 ③「寿命 / 进度读数」(见 styles/motion.css 文件头):
 * 它说的是"这件事本身花了多久",不是"一次形变花多久"。所以它**不吃档位** ——
 * 动效选「无」时光标停住,而这行数字照跳。归错类的后果是:关掉动效之后屏幕上
 * 再没有任何东西说明这一轮还在跑。
 */

/**
 * 读数的刷新节拍。
 *
 * 100ms 是"读数"该有的节拍:比它慢,秒的小数位会一顿一顿;比它快,除了多烧几次
 * 渲染什么都不多。它**不是动效时长** —— 动效档一格都不动它(见上面那一节),
 * 所以它没有对应的 CSS token,也不该被塞进 `--dur` 族。
 *
 * 留账:同类的 JS 侧数(`ESC_STOP_WINDOW_MS` 等)住在 `components/motion.ts`,
 * 这一个按本批的改动边界留在产地旁边;要归并是另一批的事。
 */
export const READOUT_TICK_MS = 100

/** 从起点到此刻,一位小数的秒。倒着走(时钟回拨 / 未来时刻)按 0 算,不显示负数。 */
export function elapsedSeconds(startedAt: number, now: number): string {
  const ms = Number.isFinite(startedAt) ? now - startedAt : 0
  return (Math.max(0, ms) / 1000).toFixed(1)
}

function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs])
  return now
}

export function StreamReadout({ startedAt }: { startedAt: number }) {
  const t = useT()
  const now = useNow(READOUT_TICK_MS)

  return (
    <div className={s.readout} data-testid="chat-readout">
      <span>{t('chat.streamReadout', { s: elapsedSeconds(startedAt, now) })}</span>
      {/*
        停止走 composer 那条 sink —— **同一条通道**,不新开。发送键在忙态下翻成的
        那颗停止键按的也是它,于是"停"这件事在这台上只有一个实现、一个失败处理
        (`chat-source.abort`:没在跑就是恒等,发不出去是 error 档通知)。
      */}
      <button
        type="button"
        className={s.ghost}
        data-testid="chat-stop"
        onClick={() => composerSink().abort()}
      >
        {t('chat.stop')}
      </button>
    </div>
  )
}
