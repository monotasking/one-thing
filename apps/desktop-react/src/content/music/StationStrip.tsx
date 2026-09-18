import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MusicRuntimeState } from '@shared/ipc/music'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Input } from '../../ui/Input'
import { Menu } from '../../ui/Menu'
import { Popover } from '../../ui/Popover'
import { Spinner } from '../../ui/Spinner'
import { useMutation, useQuery } from '../../data/kernel'
import { runWithMusicEnabled } from '../../data/music-enabled'
import { musicBriefQuery, musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { AccountMenu, AccountMenuItems } from './AccountMenu'
import { firstError } from './turntable'
import s from '../MusicPanel.module.css'

/** 预设心情。**只填进输入框**,不当场换台 —— 换台要重排节目单,必须人按下去才算。 */
const PRESET_KEYS = ['music.preset.rain', 'music.preset.focus', 'music.preset.friday', 'music.preset.drive'] as const

/**
 * **四枚心情色块**(2026-09-18,正本 §8.6)。只出现在**开台卡**上 —— 台还关着,
 * 点一下就开,没有「重排一张已经排好的节目单」这件事要先讲清楚,所以它与浮层里那排
 * 预设的判据正相反(那一排照旧只填框,见 `PRESET_KEYS` 那一行)。
 *
 * 一行三格:块上印的那两个字、按下去发出去的整句意图、这个心情自己的一对颜色。
 * **色是内容不是界面**(与唱机场景、宠物形象同一条例外),所以住在 tokens.css 的
 * `--music-mood-*` 里,这里只写它叫什么名字 —— 加一个心情 = 这张表一行 + tokens 一格 +
 * 字典一句,`StationStrip` 的其余部分一个字不动。
 */
const MOODS = [
  { id: 'rain', label: 'music.mood.rain', intent: 'music.preset.rain', tint: 'var(--music-mood-rain)' },
  { id: 'focus', label: 'music.mood.focus', intent: 'music.preset.focus', tint: 'var(--music-mood-focus)' },
  { id: 'friday', label: 'music.mood.friday', intent: 'music.preset.friday', tint: 'var(--music-mood-friday)' },
  { id: 'drive', label: 'music.mood.drive', intent: 'music.preset.drive', tint: 'var(--music-mood-drive)' },
] as const

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
 *
 * ── 账号那颗钮(2026-09-18,§6.4)────────────────────────────────────────
 * 条的右端。它要的那份 `state` 由**父级递进来**而不是这里再订一次 —— 音乐面已经
 * 有那一格读数了,同一份真相订两遍迟早会在某一帧不一致。`state` 缺席(向导那几步,
 * 或者后端整个读不到)= 不画:还没登上的时候「退出登录」是一句没有意义的话。
 * 右键整条 = 同一张表(动作单产地),不是第二份菜单。
 */
export function StationStrip({ state }: { state?: MusicRuntimeState }) {
  const t = useT()
  const brief = useQuery(musicBriefQuery)
  const open = useMutation(musicOps.open)
  const retune = useMutation(musicOps.retune)
  const radioResume = useMutation(musicOps.radioResume)
  const radioStop = useMutation(musicOps.radioStop)
  const error = firstError(open, retune, radioResume, radioStop)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  if (!brief.data) return null
  const { active, intent, canResume, programmeLength, starting } = brief.data

  return (
    <section
      className={s.station}
      data-testid="music-radio"
      data-active={active ? 'true' : undefined}
      onContextMenu={
        state
          ? (event) => {
              event.preventDefault()
              setMenuAt({ x: event.clientX, y: event.clientY })
            }
          : undefined
      }
    >
      {active ? (
        <OnAir t={t} intent={intent} speaking={Boolean(starting)} account={state} />
      ) : (
        <OffAir
          t={t}
          intent={intent}
          canResume={canResume}
          left={programmeLength}
          account={state}
          opening={open.pending}
        />
      )}
      {state && menuAt && (
        <Menu
          x={menuAt.x}
          y={menuAt.y}
          label={t('music.account.menu')}
          onClose={() => setMenuAt(null)}
        >
          <AccountMenuItems state={state} onDone={() => setMenuAt(null)} />
        </Menu>
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

function OnAir({
  t,
  intent,
  speaking,
  account,
}: {
  t: TFn
  intent: string
  speaking: boolean
  account?: MusicRuntimeState
}) {
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
      {account && <AccountMenu state={account} />}
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

function OffAir({
  t,
  intent,
  canResume,
  left,
  account,
  opening,
}: {
  t: TFn
  intent: string
  canResume: boolean
  left: number
  account?: MusicRuntimeState
  /** 有一台正在开 —— 四枚色块一起停用(开台是排他的,见 `Moods`)。 */
  opening: boolean
}) {
  const [draft, setDraft] = useState('')
  return (
    <div className={s.offAir}>
      <div className={s.offAirHead}>
        {account && <AccountMenu state={account} />}
      </div>
      <form
        className={s.formRow}
        onSubmit={(e) => {
          e.preventDefault()
          void runWithMusicEnabled(
            () => musicOps.open.run({ intent: draft.trim() }),
            () => Boolean(musicOps.open.get().error),
          )
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
      {/* §8.6:开台卡上那一排文字预设换成四枚心情色块 —— 点一下**直接开台**。
        * 自己打字那条路(上面那格输入 + 「开台」)一个字没改。 */}
      <Moods t={t} pending={opening} />
      {canResume && (
        <div className={s.row}>
          <AsyncButton
            action={musicOps.radioResume}
            pendingLabel={t('common.working')}
            size="sm"
            data-testid="music-radio-resume"
            onClick={() =>
              void runWithMusicEnabled(
                () => musicOps.radioResume.run({}),
                () => Boolean(musicOps.radioResume.get().error),
              )
            }
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

/**
 * 四枚色块(§8.6)。每一枚是**真按钮**(`ui/ButtonBase` —— 视觉本该定制的结构件),
 * 名字是那句完整意图:屏上只印两个字,说给读屏软件听的得是整句,不然「下雨」是一句
 * 没有动作的话。**开台是排他的**:一台正在开的时候其余三枚停用 —— 两句意图同时飞出去,
 * 最后放的是哪一台没有答案。
 */
function Moods({ t, pending }: { t: TFn; pending: boolean }) {
  const [firing, setFiring] = useState<string | null>(null)
  return (
    <div className={s.moods} data-testid="music-moods">
      {MOODS.map((mood) => (
        <ButtonBase
          key={mood.id}
          className={s.mood}
          style={{ '--music-mood': mood.tint } as CSSProperties}
          aria-label={t(mood.intent)}
          data-testid={`music-mood:${mood.id}`}
          disabled={pending}
          onClick={() => {
            setFiring(mood.id)
            void runWithMusicEnabled(
              () => musicOps.open.run({ intent: t(mood.intent) }),
              () => Boolean(musicOps.open.get().error),
            ).finally(() => setFiring(null))
          }}
        >
          <span className={s.moodInk}>{t(mood.label)}</span>
          {/* ui-consume-allow: spinner-placement — 它在这枚色块(一颗 `ButtonBase`)**里面**,
            * 就是这颗钮的 loading 位;规则认的是字面 `<button>`,看不见这一层。 */}
          {firing === mood.id && <Spinner className={s.moodSpin} />}
        </ButtonBase>
      ))}
    </div>
  )
}
