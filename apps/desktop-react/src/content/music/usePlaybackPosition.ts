import { useEffect, useMemo, useState } from 'react'
import type { MusicNowPlayingView } from '../../data/music-source'
import { positionAt } from './turntable'

/** 播放中多久重算一次位置。唱臂、进度条、歌词高亮都吃这一个数;4 次/秒够跟手又不费。 */
const TICK_MS = 250

/**
 * **读数之上的播放钟**。`nowPlaying` 只在换歌 / 做完一件事之后重读(见
 * `music-source` 的事件表),读回来的 `position` 是读的那一刻;这只钩子按墙钟
 * 往前推。**只在播放中起定时器**,暂停 / 没歌时零开销。
 *
 * 每拿到一份新读数(对象身份变了 —— 重读或乐观补丁)就以那一刻为起点重新推,
 * 所以 seek 的乐观补丁一落,唱臂当场就在新位置上。
 */
export function usePlaybackPosition(now: MusicNowPlayingView | undefined): number | undefined {
  const sample = useMemo(
    () =>
      now && now.position !== undefined
        ? { position: now.position, duration: now.duration, playing: now.playing, sampledAt: Date.now() }
        : undefined,
    [now],
  )
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    if (!sample?.playing) return
    setClock(Date.now())
    const id = window.setInterval(() => setClock(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [sample])

  if (!sample) return undefined
  return positionAt(sample, Math.max(clock, sample.sampledAt))
}
