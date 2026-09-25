import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useMutation } from '../../data/kernel'
import { musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Card } from '../../ui/Card'
import { Input } from '../../ui/Input'
import { StatusDot } from '../../ui/StatusDot'
import { MUSIC_MOODS } from './moods'
import type { MusicSectionContext } from './sections'
import { firstError } from './turntable'
import s from './MusicFrame.module.css'

/** 跟主持人说话时那三颗建议词(点一下 = 填进输入框,不直接发;§7.2)。 */
const TALK_SUGGESTIONS = ['music.talk.mood', 'music.talk.request', 'music.talk.what'] as const

/**
 * **「电台」那一格**(音乐面 v9,2026-09-25;正本 `docs/music-panel-2026-09.md` §10.4)。
 *
 * 从前开台 / 换台 / 点歌 / 跟主持人说话这几件事散在唱机的邀请、黑豆的菜单与抽屉的檐上,一个第一次打开
 * 的人找不到。这一格把「电台」这件事的全部动作收在一处,自上而下就是一条操作指引:
 *
 *   ① 这一台现在怎么样(开着 / 关着、在放什么方向、还剩几首)+ 关台 / 接着放;
 *   ② 选个心情(一点就开台 —— 开着时就是换台);
 *   ③ 或者自己说想听什么;
 *   ④ 开着时:点一首歌 / 跟主持人说句话。
 *
 * 每一块上面一句灰字告诉人「按下去会发生什么」(「DJ 大约一分钟后放第一首」)—— 这是指引,不是装饰。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期:两格本地草稿(意图、点歌);跟组件实例走,切到别的分区不丢(分区保挂载,见 MusicPanel),
 *    不落盘。说话那一格的草稿是面板那一份 `talk`(黑豆菜单里打的字这里也看得见)。
 * ② UI 生命状态:
 *    · 关着       —— 状态行「关着」+ 心情 + 意图输入;没有点歌 / 说话两块(没有主持人可说);
 *                    有剩余节目时状态行多一颗「继续这一台」;
 *    · 开台中     —— 心情块与开台钮一起停用,开台钮变「正在开台…」(约一分钟,顶上状态条同时说);
 *    · 开着       —— 状态行「开着 · 还剩 N 首」+ 意图原话 + 「关台」;心情块变换台;多出点歌与说话;
 *    · 出错       —— 那一块下面一行原话(不上 Toast);
 *    · 超量       —— 意图原话单行截断,整句在它自己那一行的 aria 里。
 * ③ UI 交互状态:心情块 rest / hover / focus / disabled 随 `ButtonBase` + 本地皮;其余随库件;
 *    pending 逐格(开台、换台、点歌、说话各是各的 mutation)。
 */
export function RadioSection({ ctx }: { ctx: MusicSectionContext }) {
  const t = useT()
  const { brief, radioOn, talk } = ctx
  const open = useMutation(musicOps.open)
  const retune = useMutation(musicOps.retune)
  const request = useMutation(musicOps.request)
  const radioResume = useMutation(musicOps.radioResume)
  const [intent, setIntent] = useState('')
  const [song, setSong] = useState('')

  const tune = radioOn ? musicOps.retune : musicOps.open
  const tuning = radioOn ? retune.pending : open.pending
  const tuneError = firstError(open, retune)
  const left = brief?.programmeLength ?? 0
  const playingNow = ctx.nowPlaying?.playing === true

  const send = (words: string) => {
    const text = words.trim()
    if (!text) return
    void tune.run({ intent: text }).then(() => {
      if (!tune.get().error) setIntent('')
    })
  }

  return (
    <div className={s.page} data-testid="music-section-radio">
      <Card
        titleAs="h2"
        title={t('music.deckStation')}
        actions={
          radioOn ? (
            <AsyncButton action={musicOps.radioStop} pendingLabel={t('common.working')} data-testid="music-radio-stop" onClick={() => void musicOps.radioStop.run({})}>
              {t('music.deckClose')}
            </AsyncButton>
          ) : brief?.canResume ? (
            <AsyncButton action={musicOps.radioResume} pendingLabel={t('common.working')} data-testid="music-radio-resume" onClick={() => void musicOps.radioResume.run({})}>
              {t('music.radioResume')}
            </AsyncButton>
          ) : undefined
        }
      >
        <p className={s.stationLine} data-testid="music-station-state">
          <StatusDot tone={radioOn ? 'ok' : 'off'} size="sm" />
          <span>{radioOn ? t('music.station.on', { count: left }) : t('music.deckOff')}</span>
        </p>
        {radioOn && brief?.intent ? <p className={s.stationIntent}>{t('music.intentNow', { intent: brief.intent })}</p> : null}
        {radioOn && !playingNow && brief?.canResume ? (
          <p className={s.hint}>
            {t('music.status.stationIdleHint')}{' '}
            <Button size="sm" disabled={radioResume.pending} aria-busy={radioResume.pending || undefined} onClick={() => void musicOps.radioResume.run({})}>
              {t('music.radioResume')}
            </Button>
          </p>
        ) : null}
        {radioResume.error ? <p className={s.bad}>{radioResume.error}</p> : null}
      </Card>

      <Card titleAs="h2" title={t('music.station.moodsTitle')} note={t(radioOn ? 'music.station.moodsHintOn' : 'music.station.moodsHintOff')} notePlacement="below">
        <div className={s.moods}>
          {MUSIC_MOODS.map((mood) => (
            <ButtonBase
              key={mood.id}
              className={s.moodTile}
              style={{ '--mood-bg': `var(--music-mood-${mood.id})` } as CSSProperties}
              disabled={tuning}
              aria-label={t(mood.intent)}
              data-testid={`music-station-mood-${mood.id}`}
              onClick={() => send(t(mood.intent))}
            >
              <span className={s.moodName}>{t(mood.label)}</span>
              <span className={s.moodIntent}>{t(mood.intent)}</span>
            </ButtonBase>
          ))}
        </div>
      </Card>

      <Card titleAs="h2" title={t(radioOn ? 'music.station.retuneTitle' : 'music.station.openTitle')} note={t(radioOn ? 'music.retuneHint' : 'music.station.openHint')} notePlacement="below">
        <form
          className={s.formRow}
          onSubmit={(e) => {
            e.preventDefault()
            send(intent)
          }}
        >
          <Input value={intent} onValueChange={setIntent} placeholder={t('music.intentPlaceholder')} aria-label={t('music.intentPlaceholder')} data-testid="music-station-intent" />
          <AsyncButton type="submit" variant="primary" action={tune} pendingLabel={t(radioOn ? 'common.working' : 'music.station.opening')} disabled={!intent.trim()} data-testid="music-station-tune">
            {t(radioOn ? 'music.retune' : 'music.open')}
          </AsyncButton>
        </form>
        {tuneError ? <p className={s.bad} data-testid="music-station-error">{tuneError}</p> : null}
      </Card>

      {radioOn && (
        <Card titleAs="h2" title={t('music.request')} note={t('music.station.requestHint')} notePlacement="below">
          <form
            className={s.formRow}
            onSubmit={(e) => {
              e.preventDefault()
              const name = song.trim()
              if (!name) return
              void musicOps.request.run({ song: name }).then(() => {
                if (!musicOps.request.get().error) setSong('')
              })
            }}
          >
            <Input value={song} onValueChange={setSong} placeholder={t('music.requestPlaceholder')} aria-label={t('music.requestPlaceholder')} data-testid="music-station-request" />
            <AsyncButton type="submit" action={musicOps.request} pendingLabel={t('common.working')} disabled={!song.trim()} data-testid="music-station-request-send">
              {t('music.request')}
            </AsyncButton>
          </form>
          {request.error ? <p className={s.bad}>{request.error}</p> : null}
        </Card>
      )}

      {radioOn && (
        <Card titleAs="h2" title={t('music.station.talkTitle')} note={t('music.station.talkHint')} notePlacement="below">
          <div className={s.chips}>
            {TALK_SUGGESTIONS.map((key) => (
              <Button key={key} size="sm" pill onClick={() => talk.pick(t(key))}>
                {t(key)}
              </Button>
            ))}
          </div>
          <form
            className={s.formRow}
            onSubmit={(e) => {
              e.preventDefault()
              talk.send()
            }}
          >
            <Input value={talk.text} onValueChange={talk.setText} placeholder={t('music.deckTalkOn')} aria-label={t('music.deckTalkOn')} data-testid="music-station-talk" />
            <Button type="submit" disabled={!talk.text.trim()} data-testid="music-station-talk-send">
              {t('music.petSend')}
            </Button>
          </form>
          {talk.echo ? <p className={s.echo} data-testid="music-station-echo">{talk.echo}</p> : null}
          {talk.waiting ? <p className={s.hint}>{t('music.station.talkWaiting')}</p> : null}
        </Card>
      )}
    </div>
  )
}
