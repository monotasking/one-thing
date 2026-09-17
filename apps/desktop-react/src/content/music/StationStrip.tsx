import { useRef, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Popover } from '../../ui/Popover'
import { useMutation, useQuery } from '../../data/kernel'
import { musicBriefQuery, musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { firstError } from './turntable'
import s from '../MusicPanel.module.css'

/** 预设心情。**只填进输入框**,不当场换台 —— 换台要重排节目单,必须人按下去才算。 */
const PRESET_KEYS = ['music.preset.rain', 'music.preset.focus', 'music.preset.friday', 'music.preset.drive'] as const

/**
 * **电台条**(唱机音乐面 M1)。电台开着与关着是两种形,不是一颗会改名的钮:
 *
 *  · 开着:灯 + 意图 + 「换台…」(开一块浮层,里面填意图、按「换台」才生效)+ 「关台」。
 *    「关台」走 `radioStop` —— 它与 `close` 在后端是同一件事的两个回执(自述原话),
 *    面上只留一颗。
 *  · 关着:一张开台卡 —— 一句话说清电台是什么、意图输入、开台、预设;有剩余节目时
 *    多一颗「继续这一台」(`radioResume`)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:两个本地草稿(开台意图、换台意图)跟着组件实例走;换宿主不重挂,
 *    草稿还在。浮层是这一块的附属:电台被别处关掉时浮层跟着消失(开着的形不在了)。
 * ② UI 生命状态:简报没读到 → 整条不画(首载);开着 / 关着两形;`starting` 时灯闪;
 *    做法失败 → 条下一行原话(`music-radio-error`),零 Toast。
 * ③ UI 交互状态:每颗钮各自 pending(AsyncButton);开台 / 换台在意图为空时仍可按
 *    (留空 = 让主持人看着办,后端原有语义),换台钮只在浮层里;浮层 Esc / 点外关。
 */
export function StationStrip() {
  const t = useT()
  const brief = useQuery(musicBriefQuery)
  const open = useMutation(musicOps.open)
  const retune = useMutation(musicOps.retune)
  const radioResume = useMutation(musicOps.radioResume)
  const radioStop = useMutation(musicOps.radioStop)
  const error = firstError(open, retune, radioResume, radioStop)

  if (!brief.data) return null
  const { active, intent, canResume, programmeLength, starting } = brief.data

  return (
    <section className={s.station} data-testid="music-radio" data-active={active ? 'true' : undefined}>
      {active ? (
        <OnAir t={t} intent={intent} speaking={Boolean(starting)} />
      ) : (
        <OffAir t={t} intent={intent} canResume={canResume} left={programmeLength} />
      )}
      {brief.error && <p className={s.bad}>{brief.error}</p>}
      {error && (
        <p className={s.bad} data-testid="music-radio-error">
          {error}
        </p>
      )}
    </section>
  )
}

function OnAir({ t, intent, speaking }: { t: TFn; intent: string; speaking: boolean }) {
  const [tuning, setTuning] = useState(false)
  const [draft, setDraft] = useState('')
  const anchor = useRef<HTMLButtonElement | null>(null)

  return (
    <div className={s.stationRow}>
      <span className={s.lamp} data-speaking={speaking ? 'true' : undefined} aria-hidden="true" />
      <span className={s.stationName}>
        <span className={s.head}>{t('music.radio')}</span>
        {intent && <span className={s.intent}>{t('music.intentNow', { intent })}</span>}
      </span>
      <Button
        ref={anchor}
        size="sm"
        variant="ghost"
        aria-expanded={tuning}
        data-testid="music-retune-open"
        onClick={() => setTuning((v) => !v)}
      >
        {t('music.retuneOpen')}
      </Button>
      <AsyncButton
        action={musicOps.radioStop}
        pendingLabel={t('common.working')}
        size="sm"
        data-testid="music-radio-stop"
        onClick={() => void musicOps.radioStop.run({})}
      >
        {t('music.radioStop')}
      </AsyncButton>
      {tuning && (
        <Popover
          x={0}
          y={0}
          anchor={() => anchor.current?.getBoundingClientRect() ?? null}
          anchorPlace="below-end"
          label={t('music.retune')}
          onClose={() => setTuning(false)}
          testId="music-retune-popover"
        >
          <form
            className={s.tuner}
            onSubmit={(e) => {
              e.preventDefault()
              const next = draft.trim()
              void musicOps.retune.run({ intent: next }).then(() => {
                // `run` 不抛、做法也不交值 —— 成败只看这只 mutation 此刻的那格错。
                // 失败时浮层留着、草稿留着,错话落在电台条下那一行。
                if (musicOps.retune.get().error) return
                setDraft('')
                setTuning(false)
              })
            }}
          >
            <Input
              value={draft}
              onValueChange={setDraft}
              placeholder={t('music.intentPlaceholder')}
              aria-label={t('music.intentPlaceholder')}
              data-testid="music-intent"
            />
            <Presets t={t} onPick={setDraft} />
            <p className={s.meta}>{t('music.retuneHint')}</p>
            <div className={s.tunerActions}>
              <Button size="sm" variant="ghost" type="button" onClick={() => setTuning(false)}>
                {t('common.cancel')}
              </Button>
              <AsyncButton
                action={musicOps.retune}
                pendingLabel={t('common.working')}
                size="sm"
                variant="primary"
                type="submit"
                disabled={draft.trim() === ''}
                data-testid="music-retune"
              >
                {t('music.retune')}
              </AsyncButton>
            </div>
          </form>
        </Popover>
      )}
    </div>
  )
}

function OffAir({ t, intent, canResume, left }: { t: TFn; intent: string; canResume: boolean; left: number }) {
  const [draft, setDraft] = useState('')
  return (
    <div className={s.offAir}>
      <p className={s.none}>{t('music.radioOff')}</p>
      <form
        className={s.formRow}
        onSubmit={(e) => {
          e.preventDefault()
          void musicOps.open.run({ intent: draft.trim() })
        }}
      >
        <Input
          value={draft}
          onValueChange={setDraft}
          placeholder={t('music.intentPlaceholder')}
          aria-label={t('music.intentPlaceholder')}
          data-testid="music-intent"
        />
        <AsyncButton
          action={musicOps.open}
          pendingLabel={t('common.working')}
          variant="primary"
          type="submit"
          data-testid="music-open"
        >
          {t('music.open')}
        </AsyncButton>
      </form>
      <Presets t={t} onPick={setDraft} />
      {canResume && (
        <div className={s.row}>
          <AsyncButton
            action={musicOps.radioResume}
            pendingLabel={t('common.working')}
            size="sm"
            data-testid="music-radio-resume"
            onClick={() => void musicOps.radioResume.run({})}
          >
            {t('music.radioResume')}
          </AsyncButton>
          <span className={s.meta}>
            {intent ? `${t('music.intentNow', { intent })} · ` : ''}
            {t('music.radioLeft', { count: left })}
          </span>
        </div>
      )}
    </div>
  )
}

function Presets({ t, onPick }: { t: TFn; onPick: (text: string) => void }) {
  return (
    <div className={s.presets}>
      {PRESET_KEYS.map((key) => (
        <Button key={key} size="sm" variant="ghost" pill type="button" onClick={() => onPick(t(key))}>
          {t(key)}
        </Button>
      ))}
    </div>
  )
}
