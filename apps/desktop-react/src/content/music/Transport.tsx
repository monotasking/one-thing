import { useState } from 'react'
import { Heart, ListMusic, MicVocal, Pause, Play, SkipBack, SkipForward } from '../../components/icons'
import { IconButton } from '../../ui/IconButton'
import { Slider } from '../../ui/Slider'
import { useMutation, useQuery } from '../../data/kernel'
import { runWithMusicEnabled } from '../../data/music-enabled'
import { musicBriefQuery, musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import { firstError, progressOf } from './turntable'
import s from '../MusicPanel.module.css'

/**
 * **歌条**(音乐面 v7;M1 时叫「控制条」)。
 *
 * ── 一行的次序(正本 `docs/music-panel-2026-09.md` §2)────────────────────
 * ♥ · ⏮ · ⏯ · ⏭ · 歌词(仅 < 900)· 播放列表 · 音量,进度条在**下面一行**。
 * 播放那颗在正中,左右各两件;右边两颗是「打开一块东西」的钮(歌词 / 播放列表),
 * 与左边那几颗「对这一首做点什么」分得开。
 *
 * ── 去歧义(M1 立,一个字没改)──────────────────────────────────────────
 *  · 暂停**只有这一颗钮**。唱臂不会「抬起」,电台条上的「关台」是另一件事。
 *  · ⏮ / ⏭ 图标不变,**名字跟着电台变**:电台开着时后端把 `prev` 做成重播这首、
 *    `next` 做成跳过并记作不想听(分档在后端端口里,面板只发 `do`),所以提示也要说
 *    实话 —— 「重播这首」「跳过(以后少排这类)」。
 *  · ♥ 是**一次性**动作:后端只有「喜欢」没有取消,也读不回来。按下后就地变实心并停用,
 *    名字换成「已收藏到网易云」。记在本地、按歌名分格(换一首歌就是新的一格)。
 *
 * 进度条与唱臂发的是同一条 `seek`;进度条是键盘与读屏的入口。
 *
 * ♥ 成功(做法回来且没有错话)之后调一次 `onLiked` —— 唱机场景里的黑豆据此冒爱心
 * (宠物 P1 §8.3)。失败不调:`mutation.run` 从不抛,判据是跑完之后 `get().error` 空着。
 *
 * 三张状态表:① 本地只有「这几首已收藏」一格,跟组件实例走;抽屉 / 歌词页开没开是
 * **外面那块面**的状态,这里只收两个布尔与两只回调(`aria-expanded` / `aria-pressed`
 * 据此说话);② 没有总长 → 进度条停用(`ui/Slider` 的 `undefined` 形);没有音量读数 →
 * 音量条停用;③ 每颗钮各自 pending(律③),错误就地一行 `music-player-error`。
 */
/**
 * 「播放列表」钮。**单独一件**,因为没歌时整条歌条不画,而歌单照样要够得着 ——
 * 电台开着、节目单里排着歌,只是播放器还没响,这时候人最想看的就是「接下来有什么」。
 */
export function PlaylistButton({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean
  onToggle: () => void
  buttonRef: { current: HTMLButtonElement | null }
}) {
  const t = useT()
  return (
    <IconButton
      ref={buttonRef}
      icon={ListMusic}
      label={t('music.playlist')}
      testId="music-playlist-toggle"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onToggle}
    />
  )
}

/**
 * **没歌时那一行的播放钮**(2026-09-18,用户报障:「我现在没办法控制播放,好像没有播放按钮」)。
 *
 * 病根是 v7 那一单的一条判词写窄了:「没歌 → 歌条整条不画」。可「没歌」有两种,
 * 而它们要的东西正相反 ——
 *   · 电台**关着**:开台卡上本来就有「开台」与「继续这一台」,不缺入口;
 *   · 电台**开着、播放器没在跑**(守护进程掉了 / 刚开台还没起播):屏上一颗能让它
 *     响的钮都没有。人只能看着一台开着的电台发呆。
 *
 * 所以这一颗只在后一种情况下出现,发的是 `radio-resume` 而不是 `resume`:
 * `resume` 是对**活着的播放器**说「接着放」,而这里播放器根本没起 —— 契约文件
 * (`@shared/ipc/music.ts`)上那句话原文:`radio-resume` 才是「从节目单冷启动」
 * 唯一实测可用的那条路。
 *
 * `canResume` 为假 = 节目单空着、也没有上一首可续,那就真没什么可放的:不画这颗钮
 * (画一颗按下去必然失败的钮,比没有钮更糟),人走电台条上的「换台」让 DJ 去排歌。
 */
export function IdlePlayButton() {
  const t = useT()
  const brief = useQuery(musicBriefQuery)
  const resume = useMutation(musicOps.radioResume)
  if (!brief.data?.active || !brief.data.canResume) return null
  return (
    <IconButton
      icon={Play}
      label={t('music.resume')}
      testId="music-idle-play"
      disabled={resume.pending}
      aria-busy={resume.pending || undefined}
      onClick={() =>
        void runWithMusicEnabled(
          () => musicOps.radioResume.run({}),
          () => Boolean(musicOps.radioResume.get().error),
        )
      }
    />
  )
}

export function Transport({
  title,
  playing,
  position,
  duration,
  playRef,
  onLiked,
  lyricsOpen,
  onToggleLyrics,
  playlistOpen,
  onTogglePlaylist,
  playlistRef,
}: {
  title: string | undefined
  playing: boolean
  position: number | undefined
  duration: number | undefined
  playRef: { current: HTMLButtonElement | null }
  /** ♥ 做法成功回来之后调一次。 */
  onLiked?: () => void
  /** 此刻停在歌词页吗。 */
  lyricsOpen: boolean
  /** 不传 = 这块面此刻是两栏,歌词常驻右栏,**没有这颗钮**(§1)。 */
  onToggleLyrics?: () => void
  playlistOpen: boolean
  onTogglePlaylist: () => void
  /** 「播放列表」那颗钮 —— 抽屉关掉时焦点结构性地回到它身上。 */
  playlistRef: { current: HTMLButtonElement | null }
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
      <div className={s.controls}>
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
              onLiked?.()
            })
          }}
        />
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
        {onToggleLyrics && (
          <IconButton
            icon={MicVocal}
            label={t(lyricsOpen ? 'music.backToTurntable' : 'music.lyrics')}
            testId="music-lyrics-toggle"
            pressed={lyricsOpen}
            onClick={onToggleLyrics}
          />
        )}
        <PlaylistButton open={playlistOpen} onToggle={onTogglePlaylist} buttonRef={playlistRef} />
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
      {error && (
        <p className={s.bad} data-testid="music-player-error">
          {error}
        </p>
      )}
    </div>
  )
}
