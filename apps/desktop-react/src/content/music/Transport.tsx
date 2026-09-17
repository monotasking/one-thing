import { useState } from 'react'
import { Heart, Pause, Play, SkipBack, SkipForward } from '../../components/icons'
import { IconButton } from '../../ui/IconButton'
import { Slider } from '../../ui/Slider'
import { useMutation, useQuery } from '../../data/kernel'
import { musicBriefQuery, musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import { firstError, progressOf } from './turntable'
import s from '../MusicPanel.module.css'

/**
 * **控制条**(唱机音乐面 M1):进度条、四颗钮、音量。
 *
 * ── 去歧义 ──────────────────────────────────────────────────────────────
 *  · 暂停**只有这一颗钮**。唱臂不会「抬起」,电台条上的「关台」是另一件事。
 *  · ⏮ / ⏭ 图标不变,**名字跟着电台变**:电台开着时后端把 `prev` 做成重播这首、
 *    `next` 做成跳过并记作不想听(分档在后端端口里,面板只发 `do`),所以提示也要说
 *    实话 —— 「重播这首」「跳过(以后少排这类)」。
 *  · ♥ 是**一次性**动作:后端只有「喜欢」没有取消,也读不回来。按下后就地变实心并停用,
 *    名字换成「已收藏到网易云」。记在本地、按歌名分格(换一首歌就是新的一格)。
 *
 * 进度条与唱臂发的是同一条 `seek`;进度条是键盘与读屏的入口。
 *
 * 三张状态表:① 本地只有「这几首已收藏」一格,跟组件实例走;② 没有总长 → 进度条停用
 * (`ui/Slider` 的 `undefined` 形);没有音量读数 → 音量条停用;③ 每颗钮各自 pending
 * (律③),错误就地一行 `music-player-error`。
 */
export function Transport({
  title,
  playing,
  position,
  duration,
  playRef,
}: {
  title: string | undefined
  playing: boolean
  position: number | undefined
  duration: number | undefined
  playRef: { current: HTMLButtonElement | null }
}) {
  const t = useT()
  const brief = useQuery(musicBriefQuery)
  const prev = useMutation(musicOps.prev)
  const pause = useMutation(musicOps.pause)
  const resume = useMutation(musicOps.resume)
  const next = useMutation(musicOps.next)
  const like = useMutation(musicOps.like)
  const seek = useMutation(musicOps.seek)
  const volume = useMutation(musicOps.volume)
  const error = firstError(prev, pause, resume, next, like, seek, volume)
  const [liked, setLiked] = useState<ReadonlySet<string>>(() => new Set())

  const radio = brief.data?.active ?? false
  const isLiked = title !== undefined && liked.has(title)

  return (
    <div className={s.transport}>
      <div className={s.seekRow}>
        <Slider
          value={duration !== undefined && position !== undefined ? Math.min(position, duration) : undefined}
          min={0}
          max={duration ?? 0}
          label={t('music.seekLabel')}
          format={(value) => progressOf(value, duration)}
          testId="music-seek"
          onCommit={(value) => void musicOps.seek.run({ position: Math.round(value) })}
        />
        {position !== undefined && <span className={s.clock}>{progressOf(position, duration)}</span>}
      </div>
      <div className={s.controls}>
        <IconButton
          icon={SkipBack}
          label={t(radio ? 'music.replay' : 'music.prev')}
          testId="music-prev"
          disabled={prev.pending}
          aria-busy={prev.pending || undefined}
          onClick={() => void musicOps.prev.run({})}
        />
        <IconButton
          ref={playRef}
          icon={playing ? Pause : Play}
          label={t(playing ? 'music.pause' : 'music.resume')}
          size="md"
          testId="music-play"
          disabled={pause.pending || resume.pending}
          aria-busy={pause.pending || resume.pending || undefined}
          onClick={() => void (playing ? musicOps.pause : musicOps.resume).run({})}
        />
        <IconButton
          icon={SkipForward}
          label={t(radio ? 'music.skip' : 'music.next')}
          testId="music-next"
          disabled={next.pending}
          aria-busy={next.pending || undefined}
          onClick={() => void musicOps.next.run({})}
        />
        <IconButton
          icon={Heart}
          label={t(isLiked ? 'music.liked' : 'music.like')}
          testId="music-like"
          pressed={isLiked}
          disabled={like.pending || isLiked || !title}
          aria-busy={like.pending || undefined}
          onClick={() => {
            if (!title) return
            void musicOps.like.run({}).then(() => {
              if (musicOps.like.get().error) return
              setLiked((prevSet) => new Set(prevSet).add(title))
            })
          }}
        />
        <div className={s.volume}>
          <Slider
            value={brief.data?.volume}
            label={t('music.volumeLabel')}
            format={(value) => String(Math.round(value))}
            testId="music-volume"
            disabled={volume.pending}
            onCommit={(value) => void musicOps.volume.run({ level: Math.round(value) })}
          />
        </div>
      </div>
      {error && (
        <p className={s.bad} data-testid="music-player-error">
          {error}
        </p>
      )}
    </div>
  )
}
