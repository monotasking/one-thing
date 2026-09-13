import { useEffect, useState } from 'react'
import { composerSink } from '../../composer/sink'
import { STALL_HARD_MS, STALL_SOFT_MS } from '../../components/motion'
import { formatDuration } from '../../format/quantity'
import { useT } from '../../i18n'
import { ButtonBase } from '../../ui/ButtonBase'
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

/**
 * 从起点到此刻**过了多少毫秒**。倒着走(时钟回拨 / 未来时刻)按 0 算。
 *
 * 09-05:它从前直接吐字符串(`(ms/1000).toFixed(1)`)—— 那是**第四个**写时间的地方。
 * 进位收进 `format/quantity.formatDuration` 之后,这里只剩「量出多少毫秒」这一件事,
 * 怎么写出来由那一个产地说(分钟档的 `1m 05s` 因此白送)。
 */
export function elapsedMs(startedAt: number, now: number): number {
  const ms = Number.isFinite(startedAt) ? now - startedAt : 0
  return Math.max(0, ms)
}

/**
 * **活性读数**(§6.6,拍点 ⑩ 用户补的真需求:「不展开也行,反正我要分得清它是在
 * 接收流式还是卡住了」)—— 一句话由静默时长说了算。
 *
 * 判据是**静默**(上一次**有东西到达**到此刻),不是总耗时:一轮跑十分钟但一直在
 * 动是正常的,跑三十秒什么都没来才是异常。「有东西到达」四类来源(产地在
 * `data/chat-source.ts` 的 `markActivity`,四个调用点各写了为什么):三种裸 delta、
 * 工具进度快照、活 run 的工具账本行(`tool/*`、`assistant/first-token`、
 * `assistant/part-end`)、`tool:input-start`。
 *
 * **2026-09-09 从「上一次收到 delta」放宽到这里**:真店 fe5261d9 那一轮模型不到
 * 1 秒就发了工具调用,bash 跑了 7 秒、卡片一直在刷输出,而读数行说「已 7.0s 没有
 * 新内容」—— 屏幕上明明在动。用户裁定:工具进度计入活性。放宽的是**这一行的**判据,
 * 跟随状态机那格 `lastDeltaAt` 语义一个字没动(工具跑着不是模型又说了话)。
 *
 * `lastActivityAt` 缺席(这一轮什么都还没到)时退到 `startedAt` —— 从开张那一刻
 * 起算,而不是当成「刚刚收到过」。
 *
 * 纯函数,不碰 DOM 也不碰 i18n:它只答「此刻该说哪一句、静默了多久」,
 * 句子长什么样归字典。
 */
export type ReadoutTone = 'live' | 'stalled' | 'stuck'

export function readoutTone(silentMs: number): ReadoutTone {
  if (silentMs > STALL_HARD_MS) return 'stuck'
  if (silentMs > STALL_SOFT_MS) return 'stalled'
  return 'live'
}

function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs])
  return now
}

export function StreamReadout({
  sessionId,
  startedAt,
  lastActivityAt,
}: { sessionId: string; startedAt: number; lastActivityAt?: number }) {
  const t = useT()
  const now = useNow(READOUT_TICK_MS)

  const elapsed = formatDuration(elapsedMs(startedAt, now))
  const silentMs = elapsedMs(lastActivityAt ?? startedAt, now)
  const tone = readoutTone(silentMs)
  /*
   * 三句话共一行:活着时只说耗时;软阈值起**改说静默**(陈述事实,不下结论);
   * 硬阈值再补一句判断。「可能」两个字不许去掉 —— 壳这一侧没有任何证据能说明
   * 它真的卡死了,它只知道「这么久没收到东西」。
   */
  const line =
    tone === 'live'
      ? t('chat.streamReadout', { d: elapsed })
      : t('chat.streamStalled', { silent: formatDuration(silentMs), d: elapsed })

  return (
    <div className={s.readout} data-testid="chat-readout" data-tone={tone}>
      <span>{line}</span>
      {tone === 'stuck' && <span className={s.stuck}>{t('chat.streamStuck')}</span>}
      {/*
        停止走 composer 那条 sink —— **同一条通道**,不新开。发送键在忙态下翻成的
        那颗停止键按的也是它,于是"停"这件事在这台上只有一个实现、一个失败处理
        (`chat-source.abort`:没在跑就是恒等,发不出去是 error 档通知)。
        停哪一条**由这一行自己说**(W5-c-2):它长在某一条会话的消息流里,
        那就是收件人 —— 从前那一口读「当前会话」投影,分屏下能停到隔壁去。
      */}
      {/* 与动作行那两颗同判(见 MessageActions):幽灵皮肤留本地,清 UA 归基座。
        * 这一颗还比它们再小一档(`.readout .ghost`)—— 它是读数的一部分。 */}
      <ButtonBase
        className={s.ghost}
        data-testid="chat-stop"
        onClick={() => composerSink().abort(sessionId)}
      >
        {t('chat.stop')}
      </ButtonBase>
    </div>
  )
}
