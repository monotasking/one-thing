import { useEffect, useState } from 'react'
import { Heart, ListMusic, MessageSquare, Pause, Play, SkipForward } from '../../components/icons'
import { useMutation, useQuery } from '../../data/kernel'
import { musicBriefQuery, musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { Slider } from '../../ui/Slider'
import type { HostTalk } from './useHostTalk'
import { clockOf, firstError, progressOf } from './turntable'
import s from './DeckRow.module.css'

/**
 * **唱片下面那一行**(音乐面 v8,样例「黑豆电台」v7)。
 *
 * 进度条一条,下面三组:左边 ♥,中间 ⏯ ⏭,右边「说话」与播放列表。按「说话」,这一行
 * **就地**换成输入框(同一高度),回车发出去就回到按钮,Esc / 取消也回来 —— 所以
 * 「说话」这件事不在屏上多占一行,开没开它面板都不变形。
 *
 * ── 每颗钮一个意思 ─────────────────────────────────────────────────────
 *  · ⏯:有歌就只听播放器的 —— 在放 = 暂停、停着 = 继续;没歌才轮到电台:开着 = 从节目单续上
 *    (`radio-resume`,冷启动唯一实测可用的那条路),关着 = **开台**。名字跟着说。
 *  · ⏭:电台开着 = 跳过并记成不想听(后端分档,名字说实话);关着停用。
 *  · ♥:一次性,按歌名分格记在这里;成功后黑豆冒爱心(`onLiked`)。
 *  · 说话:关着时说的是「今晚想听点什么」→ 以这句话开台;开着时递给主持人(`tell`)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:本地两格 —— 「这几首已收藏」、此刻是不是在说话;都跟组件实例走,不落盘。
 *    说话中换歌 / 关台:框留着(话还没说完);关台后回车 = 开台。
 * ② UI 生命状态:没歌 → 进度条停用、两头 `--:--`;关着 → ♥ ⏭ 播放列表照常可点
 *    (播放列表里能看放过的);错误 → 父级那一行(这一行高度不变)。
 * ③ UI 交互状态:全随库件;每颗钮各自 pending(律③);说话框的发送是 form submit,
 *    这块面一个 keydown 都不写。
 */
export function DeckRow({
  title,
  playing,
  position,
  duration,
  talk,
  talking,
  onTalking,
  playRef,
  talkRef,
  playlistRef,
  playlistOpen,
  onTogglePlaylist,
  onLiked,
  onError,
}: {
  title: string | undefined
  playing: boolean
  position: number | undefined
  duration: number | undefined
  talk: HostTalk
  /** 这一行此刻是输入框。开合的主人是面板(Esc 由面板那一格认领)。 */
  talking: boolean
  onTalking: (next: boolean) => void
  playRef: { current: HTMLButtonElement | null }
  /** 说话框。焦点由面板那一格的落点交进来(响应链:这里一句 `focus()` 都不写)。 */
  talkRef: { current: HTMLInputElement | null }
  playlistRef: { current: HTMLButtonElement | null }
  playlistOpen: boolean
  onTogglePlaylist: () => void
  onLiked?: () => void
  /** 这一行各颗钮的错话,交给面板画在唱片上方那一行。 */
  onError: (message: string | undefined) => void
}) {
  const t = useT()
  const brief = useQuery(musicBriefQuery)
  const open = useMutation(musicOps.open)
  const radioResume = useMutation(musicOps.radioResume)
  const pause = useMutation(musicOps.pause)
  const resume = useMutation(musicOps.resume)
  const next = useMutation(musicOps.next)
  const like = useMutation(musicOps.like)
  const seek = useMutation(musicOps.seek)
  const [liked, setLiked] = useState<ReadonlySet<string>>(() => new Set())

  const radio = brief.data?.active ?? false
  const present = Boolean(title)
  const isLiked = title !== undefined && liked.has(title)
  // 说话发送失败的那句话也在这里:发出去那一下这一行已经回到按钮了,错话不能跟着框一起消失。
  const error = firstError(open, radioResume, pause, resume, next, like, seek) ?? talk.error
  useEffect(() => onError(error), [error, onError])

  // 有歌就只听播放器的(放 / 停);没歌才轮到电台:开着 = 从节目单续上,关着 = 开台。
  const play = present
    ? playing
      ? { label: t('music.pause'), run: () => void musicOps.pause.run({}), busy: pause.pending }
      : { label: t('music.resume'), run: () => void musicOps.resume.run({}), busy: resume.pending }
    : radio
      ? { label: t('music.resume'), run: () => void musicOps.radioResume.run({}), busy: radioResume.pending }
      : { label: t('music.deckOpen'), run: () => void musicOps.open.run({ intent: '' }), busy: open.pending }

  const sendTalk = () => {
    const words = talk.text.trim()
    if (!words) return
    if (radio) talk.send()
    else {
      talk.setText('')
      void musicOps.open.run({ intent: words })
    }
    onTalking(false)
  }

  return (
    <div className={s.row} data-talking={talking ? 'true' : undefined} data-testid="music-row">
      <div className={s.seek}>
        <span className={s.clock}>{present && position !== undefined ? clockOf(position) : t('music.deckNoClock')}</span>
        <Slider
          value={present && duration !== undefined && position !== undefined ? Math.min(position, duration) : undefined}
          min={0}
          max={duration ?? 0}
          label={t('music.seekLabel')}
          format={(value) => progressOf(value, duration)}
          testId="music-seek"
          onCommit={(value) => void musicOps.seek.run({ position: Math.round(value) })}
        />
        <span className={s.clock}>{present && duration !== undefined ? clockOf(duration) : t('music.deckNoClock')}</span>
      </div>

      {talking ? (
        <form
          className={s.talk}
          onSubmit={(e) => {
            e.preventDefault()
            sendTalk()
          }}
        >
          <Input
            ref={talkRef}
            value={talk.text}
            onValueChange={talk.setText}
            placeholder={t(radio ? 'music.deckTalkOn' : 'music.deckTalkOff')}
            aria-label={t('music.deckTalk')}
            data-testid="music-talk-input"
          />
          <Button type="button" onClick={() => onTalking(false)} data-testid="music-talk-cancel">
            {t('common.cancel')}
          </Button>
        </form>
      ) : (
        <div className={s.keys}>
          <span className={s.start}>
            <IconButton
              icon={Heart}
              label={t(isLiked ? 'music.liked' : 'music.like')}
              testId="music-like"
              pressed={isLiked}
              disabled={like.pending || isLiked || !present}
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
              disabled={play.busy}
              aria-busy={play.busy || undefined}
              onClick={play.run}
            />
            <IconButton
              icon={SkipForward}
              label={t(radio ? 'music.skip' : 'music.next')}
              testId="music-next"
              disabled={next.pending || !present}
              aria-busy={next.pending || undefined}
              onClick={() => void musicOps.next.run({})}
            />
          </span>
          <span className={s.end}>
            <IconButton icon={MessageSquare} label={t('music.deckTalk')} testId="music-talk" onClick={() => onTalking(true)} />
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
      )}
    </div>
  )
}
