import { useEffect, useState } from 'react'
import { Heart, ListMusic, Pause, Play, SkipForward, Volume2 } from '../../components/icons'
import { useMutation, useQuery } from '../../data/kernel'
import { musicBriefQuery, musicOps, musicPlaybackOp, setMusicPlaying, useMusicPlaybackNotice } from '../../data/music-source'
import { useT } from '../../i18n'
import { IconButton } from '../../ui/IconButton'
import { Slider } from '../../ui/Slider'
import { clockOf, firstError, progressOf } from './turntable'
import s from './DeckRow.module.css'

/**
 * **唱片下面那一行**(音乐面 v8,样例「黑豆电台」v7;09-19 改版)。
 *
 * 进度条一条,下面三组:左边 ♥,中间 ⏯ ⏭,右边音量与播放列表。**跟黑豆说话不在这一行** ——
 * 09-19 用户:「跟黑豆的聊天应该不是下面的输入框说,而是点击它,弹出来一个聊天的输入框」,
 * 所以那颗「说话」钮与就地换出来的输入框都搬到黑豆身上去了(`PetStage` 的 `menu`)。
 *
 * ── 每颗钮一个意思 ─────────────────────────────────────────────────────
 *  · ⏯:有歌就只听播放器的 —— 在放 = 暂停、停着 = 继续(09-25 起走 `setMusicPlaying`:这一帧就换、永不按住,
 *    连点只追最后一下,后端确认后的第一份读数说了算;没照做就说一句 `music.playerDisagrees`);播放器说不出在放什么、但记得上次放到哪
 *    (`restored`)= 「接着放」;没歌才轮到电台:开着 = 从节目单续上,关着 = 开台;从没放过 = 停用。
 *  · ⏭:电台开着 = 跳过并记成不想听(后端分档,名字说实话);关着 / 没歌 / 画的是上次 = 停用。节目单空了
 *    (DJ 在补)也照样发:后端记下这一下、答「还没排好」,黑豆接一句「别催,在翻」—— 不出错话。
 *  · ♥:一次性,按歌名分格记在这里;成功后黑豆冒爱心(`onLiked`)。
 *  · 音量:任何时候都能拖(从没放过也能先调好)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:本地一格 —— 「这几首已收藏」;跟组件实例走,不落盘。
 * ② UI 生命状态:从没放过 → 两头 0:00,⏯ ⏭ ♥ 进度条停用,音量与播放列表照常;上次放到一半 → 那一秒、
 *    ⏯ 可按其余停用;错误 → 父级那一行(这一行高度不变)。
 * ③ UI 交互状态:全随库件;每颗钮各自 pending(律③);这块面一个 keydown 都不写。
 */
export function DeckRow({
  title,
  playing,
  restored = false,
  everPlayed = true,
  volume,
  position,
  duration,
  playRef,
  playlistRef,
  playlistOpen,
  onTogglePlaylist,
  onLiked,
  refilling = false,
  onWaitForDj,
  onError,
}: {
  title: string | undefined
  playing: boolean
  /** 这一行画的是「上次放到哪」(播放器此刻说不出在放什么):⏯ = 从那儿接着放,其余只看不按。 */
  restored?: boolean
  /** 放过没有。从没放过 = 除了音量与播放列表,这一行什么都按不了(09-19)。 */
  everPlayed?: boolean
  /** 播放器记着的音量(0–100);读不到 = 杆子空着但照样能拖。 */
  volume?: number
  position: number | undefined
  duration: number | undefined
  playRef: { current: HTMLButtonElement | null }
  playlistRef: { current: HTMLButtonElement | null }
  playlistOpen: boolean
  onTogglePlaylist: () => void
  onLiked?: () => void
  /** 电台开着、节目单空了:DJ 在补。此刻按 ⏭ 是「催他」,由黑豆接话(`onWaitForDj`)。 */
  refilling?: boolean
  onWaitForDj?: () => void
  /** 这一行各颗钮的错话,交给面板画在唱片上方那一行。 */
  onError: (message: string | undefined) => void
}) {
  const t = useT()
  const brief = useQuery(musicBriefQuery)
  const open = useMutation(musicOps.open)
  const radioResume = useMutation(musicOps.radioResume)
  const playback = useMutation(musicPlaybackOp)
  const playbackNotice = useMusicPlaybackNotice()
  const next = useMutation(musicOps.next)
  const like = useMutation(musicOps.like)
  const seek = useMutation(musicOps.seek)
  const [liked, setLiked] = useState<ReadonlySet<string>>(() => new Set())

  const radio = brief.data?.active ?? false
  const present = Boolean(title)
  const isLiked = title !== undefined && liked.has(title)
  // 说话发送失败的那句话也在这里:发出去那一下这一行已经回到按钮了,错话不能跟着框一起消失。
  const error =
    firstError(open, radioResume, playback, next, like, seek) ??
    (playbackNotice === 'disagreed' ? t('music.playerDisagrees') : undefined)
  useEffect(() => onError(error), [error, onError])

  // 有歌就只听播放器的(放 / 停);没歌才轮到电台:开着 = 从节目单续上,关着 = 开台。
  const play = restored
    ? { label: t('music.deckContinue'), run: () => void musicOps.radioResume.run({}), busy: radioResume.pending }
    : present
    ? // 在放 / 停着:**永不按住**。屏幕这一帧就换,发送的序与连点归 `setMusicPlaying`(09-25「点击及时响应」)。
      { label: t(playing ? 'music.pause' : 'music.resume'), run: () => setMusicPlaying(!playing), busy: false }
    : radio
      ? { label: t('music.resume'), run: () => void musicOps.radioResume.run({}), busy: radioResume.pending }
      : { label: t('music.deckOpen'), run: () => void musicOps.open.run({ intent: '' }), busy: open.pending }

  return (
    <div className={s.row} data-testid="music-row">
      <div className={s.seek}>
        <span className={s.clock}>{clockOf(present && position !== undefined ? position : 0)}</span>
        <Slider
          value={present && duration !== undefined && position !== undefined ? Math.min(position, duration) : 0}
          disabled={!present || restored}
          min={0}
          max={duration ?? 0}
          label={t('music.seekLabel')}
          format={(value) => progressOf(value, duration)}
          testId="music-seek"
          onCommit={(value) => void musicOps.seek.run({ position: Math.round(value) })}
        />
        <span className={s.clock}>{clockOf(present && duration !== undefined ? duration : 0)}</span>
      </div>

      <div className={s.keys}>
        <span className={s.start}>
          <IconButton
            icon={Heart}
            label={t(isLiked ? 'music.liked' : 'music.like')}
            testId="music-like"
            pressed={isLiked}
            disabled={like.pending || isLiked || !present || restored}
            aria-busy={like.pending || undefined}
            onClick={() => {
              if (!title) return
              void musicOps.like.run({}).then(() => {
                if (musicOps.like.get().error) return
                setLiked((prev) => new Set(prev).add(title))
                onLiked?.()
              })
            }}
          />
        </span>
        <span className={s.middle}>
          <IconButton
            ref={playRef}
            icon={present && playing ? Pause : Play}
            label={play.label}
            size="lg"
            solid
            testId="music-play"
            disabled={play.busy || !everPlayed}
            aria-busy={play.busy || undefined}
            onClick={play.run}
          />
          <IconButton
            icon={SkipForward}
            label={t(radio ? 'music.skip' : 'music.next')}
            testId="music-next"
            disabled={next.pending || !present || restored}
            aria-busy={next.pending || undefined}
            onClick={() => {
              // 照样发出去:后端把这一下记成「不想听这首」(口味信号),回执是「还没排好」,不是错。
              if (refilling) onWaitForDj?.()
              void musicOps.next.run({})
            }}
          />
        </span>
        <span className={s.end}>
          <span className={s.volume}>
            <Volume2 className={s.volumeIcon} aria-hidden="true" />
            <Slider
              value={volume ?? 0}
              min={0}
              max={100}
              label={t('music.volumeLabel')}
              testId="music-volume"
              onCommit={(level) => void musicOps.volume.run({ level: Math.round(level) })}
            />
          </span>
          <IconButton
            ref={playlistRef}
            icon={ListMusic}
            label={t('music.playlist')}
            testId="music-playlist-toggle"
            aria-haspopup="dialog"
            aria-expanded={playlistOpen}
            onClick={onTogglePlaylist}
          />
        </span>
      </div>
    </div>
  )
}
