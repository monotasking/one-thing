import { useEffect, useRef, useState } from 'react'
import { SPEAK_HOLD_MS, TYPE_LEAD_MS, splitGlyphs, typeDelayAfter } from '../../pets/bubble'
import { usePetHushedId, usePetLive, usePetOnAir, usePetUtterance } from '../../data/pet-source'

/**
 * **他此刻在说的那句话**(音乐面 §8.4,正本 `apps/desktop-react/docs/music-panel-2026-09.md`)。
 *
 * 歌词那一屏要知道两件事:主持人开口了没有(开口就让位、压暗、停跟唱),以及那句话
 * 逐字出到第几个字。前者是 `usePetOnAir()` —— **与唱机上那盏 ON AIR 灯同一格读数**,
 * 两处不会各自认定一件事;后者这里自己走一遍,节拍复用宠物气泡那份
 * (`pets/bubble.ts` 的 `TYPE_LEAD_MS` / `typeDelayAfter`),所以歌词上浮起来的那块话
 * 与黑豆头顶那只气泡**是同一个节奏**,不是两个相近的数。
 *
 * ── 为什么不直接读宠物舞台那只气泡 ────────────────────────────────────────
 * 那只气泡是 `PetStage` 实例里的东西,而歌词页在场时唱机场景**根本没挂载**
 * (一栏形下它整块被换掉)。要的是「后端说了什么」这件事实,它住在 `pet-source`
 * 的话语格里,与谁在画气泡无关。
 *
 * ── 停在哪儿(§8.4 结束那一行)──────────────────────────────────────────
 * `hushed` 到了就收 —— 那是后端说「这句真的说完了」。但 `hushed` 会丢(断线重连
 * 那一截),所以还有一道**话语过期**:字出完再停 `SPEAK_HOLD_MS`,与宠物气泡自己
 * 的寿命同一个数。少了它,一次丢掉的 `hushed` 会让歌词永远压着暗。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载即 `usePetLive()`(引用计数,唱机场景同时挂着也只订一条);
 *    每来一句新的 `utterance` 重新起打字(计时器换掉,不叠);卸载清计时器。
 * ② UI 生命状态:没开口 = `null`(调用方据此决定压不压暗);开口中 = `typed` 一个字
 *    一个字长;字出完之后这句话还留在屏上,直到 `hushed` 或过期。
 * ③ UI 交互状态:它不是控件,没有交互态 —— 浮起来那块话不接点击(§8.4 只说「浮」)。
 */
export interface HostSay {
  /** 整句。 */
  text: string
  /** 已经出到屏上的那一截。 */
  typed: string
}

export function useHostSay(): HostSay | null {
  usePetLive()
  const arrival = usePetUtterance()
  const onAir = usePetOnAir()
  const hushedId = usePetHushedId()
  const [typed, setTyped] = useState(0)
  /** 这一句已经「过期」了 —— 字出完 + 停够,而 `hushed` 没来。 */
  const [expired, setExpired] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 开口的那一句才画(嘀咕不点灯,也不该把歌词压暗 —— 它不是在对人说话)。
  const speaking = arrival !== null && arrival.utterance.mode === 'speak'
  const text = speaking ? arrival.utterance.text : ''
  const glyphs = splitGlyphs(text)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    setTyped(0)
    setExpired(false)
    if (!speaking || glyphs.length === 0) return
    let at = 0
    const step = () => {
      at += 1
      setTyped(at)
      if (at < glyphs.length) {
        timer.current = setTimeout(step, typeDelayAfter(glyphs[at - 1]))
        return
      }
      // 字出完了:再停一会儿,`hushed` 没来就自己收(见文件头)。
      timer.current = setTimeout(() => setExpired(true), SPEAK_HOLD_MS)
    }
    timer.current = setTimeout(step, TYPE_LEAD_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // 依赖的是**这一句**(id),不是它的字数 —— 同一句重渲不许把打字重头来过。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrival?.id, speaking])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  if (!speaking || !arrival) return null
  if (hushedId === arrival.id || expired || !onAir) return null
  return { text, typed: glyphs.slice(0, typed).join('') }
}
