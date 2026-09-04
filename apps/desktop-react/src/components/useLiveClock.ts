import { useEffect, useState } from 'react'

/**
 * **一只按需起停的读数时钟**。
 *
 * 流中态的读数(耗时在走、静默了多少秒)需要一个「此刻」,而「此刻」不是任何一份
 * 数据的字段 —— 数据停了它照样在变,那正是活性读数要说的事(§6.6)。
 *
 * 三条纪律,每条都是 §6.5 那九条里的一句:
 *
 *  1. **一个消费者一只钟**:一张工具卡起一只,不是每行一只。十行工具十只
 *     `setInterval` 各自 setState,一帧里就有十次渲染 —— 那是节拍那条(第 3 条)
 *     要禁的东西。
 *  2. **没有活事就停**:`active` 为假时定时器**不存在**(不是空转)。一条会话里
 *     九成的工具卡是收场了的,它们不该有任何一个定时器。
 *  3. **停下来时读数不回退**:返回的是上一次的值,不是 `0` 也不是新的 `Date.now()`
 *     —— 一格读数在事情做完那一瞬跳一下,是最没必要的那种抖。
 *
 * 它读 `Date.now()` 而不是 `performance.now()`:要与之相减的那些时刻(账本的
 * `startTime`、活尾巴写的 `liveAt`)全是**纪元毫秒**,两个时钟相减是 bug 的产地。
 *
 * 节拍不是动画时长,动效档一格都不动它(与 `StreamReadout` 的 `READOUT_TICK_MS`
 * 同一条判);留账:那一份与这一份是两处 `useNow`,归并要等 C1 的消息尾读数落地。
 */
export function useLiveClock(tickMs: number, active: boolean): number {
  // 停下来时这一格**原样留着**上一次的值 —— 定时器没了,状态不动,读数就不跳。
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs, active])

  return now
}
