import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from 'react'
import type { MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import { useQuery } from '../../data/kernel'
import { musicLyricsQuery } from '../../data/music-source'
import type { MusicNowPlayingView, MusicProgrammeView } from '../../data/music-source'
import {
  petOps,
  useCurrentPetId,
  usePetHushedId,
  usePetLive,
  usePetRosterRig,
  usePetUtterance,
} from '../../data/pet-source'
import { useT } from '../../i18n'
import { findBuiltinPet } from '../../pets/builtin'
import { PetStage } from '../../pets/PetStage'
import type { PetStageHandle } from '../../pets/PetStage'
import type { PetGesture } from '../../pets/types'
import { ButtonBase } from '../../ui/ButtonBase'
import { PointerTrack } from '../../ui/drag'
import { FrameCoalescer } from '../../ui/frame-coalescer'
import { usePanelVisibility } from '../visibility'
import { currentRowAt, lyricRowsOf } from './lyrics-rows'
import { musicPetActivity } from './pet-activity'
import {
  angleAtPoint,
  angleForSide,
  bandAt,
  deckGeometry,
  labelColorsFor,
  needleAt,
  recordSideOf,
  sideAtAngle,
  sideProgress,
  svgRadiusAt,
} from './record-geometry'
import type { DeckGeometry, RecordSide } from './record-geometry'
import { browserFrames, SpinLoop } from './scene-controller'
import type { FrameSource } from './scene-controller'
import { clockOf, progressOf, splitTitle } from './turntable'
import s from './RecordDeck.module.css'

/** 这块栖位缺省演的宠物(`pet:` 的 `current` 读不到时)。 */
const DEFAULT_PET = findBuiltinPet('heidou')
/** 手势 → `pet:` 的做法。发完不等、失败不提示。 */
function reportGesture(gesture: PetGesture): void {
  petOps[gesture.kind]()
}
/** 唱头 ←/→ 一下跳多少秒。 */
const KEY_SEEK_S = 10

/**
 * **唱片面**(音乐面 v8 · 唱针读歌词,2026-09-18;样例「黑豆电台」v7,用户 09-18「就按照这个去实现,100%」)。
 *
 * 用户否掉了前一版的两件事:「布局很奇怪,歌词和唱机竟然是分开的」「复杂」。所以这块面
 * **只剩一张唱片和它正在读的那几句歌词**:
 *  · **整张唱片,歌名印在标签上**。标签纸跟着唱片转,歌名那两行始终正着(33 转一圈不到
 *    两秒,转着的字没人读得了);「在转」由纹路上一道淡反光表现 —— 它跟着真实转角起伏,
 *    惯性停转时跟着慢慢停,停住就不动(用户 09-18:「最内层有一圈一直在转圈」—— 从前标签
 *    边上那枚小字绕着歌名跑,删了)。
 *  · **唱针读歌词**:唱臂从右上伸过来,唱针落在唱片右半边;歌词从唱针旁边往右流,正在唱的
 *    那句对着唱针的高度(`record-geometry.ts` 的 `anchorY`,测试钉着两者相差不到 0.12R)。
 *  · **唱片就是这一面的节目单**:一面最多五首,放过的 / 正在放的 / 排进这一面的各占一圈
 *    纹带,宽窄按时长;正在放的那一圈微微发亮;黑豆会先开口的那几首,纹带起点有一枚小红点,
 *    就在唱针走到那里时会落下的位置。唱臂的位置是「这一面放到哪了」。
 *  · **黑豆坐在唱片左下角**;挑歌时身边翘起几张封套。
 *
 * ── 一个手势一个意思 ─────────────────────────────────────────────────────
 *  · 唱头 = 「跳到这里」:在这一圈里松手 = `seek` 到那一秒;拖到后面那一圈 = 放那首
 *    (`onPlayEntry`,与播放列表的「立即播放」同一条路);Esc / 指针被收走 = 不算。
 *    聚焦后 ←/→ 各 10 秒。放过的那几圈拖不回去(唱臂夹在这一首的起点)。
 *  · 点歌词里任何一句 = `seek` 到那一句。
 *  · 唱片、标签:只显示。黑豆:点 / 撸只嘀咕,永远不改变播放。
 *
 * ── 布局从不跟着状态变(用户 09-18「开关、打开歌词等操作,会让 ui 布局变化」)──────
 * 开台、关台、暂停、黑豆挑歌,这块面的高度与每一件的位置都不动,变的只是里面的东西:
 * 关着 → 标签写「黑豆电台 · 关着」、歌词那里换成一句提示;没有歌词 → 同一个位置一句话。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张状态表
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 * | 事件 | 唱片 | 唱臂 | 歌词 | 黑豆 |
 * | 挂载 | 量画面(RO → 下一帧) → 写几何;在放 → 满速 | 直接摆到这一面的位置,不演落针 | 当前句直接落位(不滑) | 读数到了才挂栖位 |
 * | 开始放 | 0.9s 起转 | 落下(影子贴近) | 跟着走 | rhythm |
 * | 暂停 | 1.6s 惯性停,反光跟着停 | 原地抬起 | 停在那句 | still → 打盹 |
 * | 同一面里换歌 | 照转;标签淡入换一张 | 走到下一圈起点 | 换一首的歌词,落位不滑 | 不变 |
 * | 翻到下一面(本场第 6、11… 首) | 翻一下(rotateY)再落回 | 同上 | 同上 | 不变 |
 * | 进度被别处 seek | — | 300ms 过渡到新位置 | 滑到那一句 | — |
 * | 关台 | 停;标签「黑豆电台 · 关着」;屋里暗 | 归位 | 一句提示 | 睡 |
 * | 隐藏(架子收起)/ `document.hidden` | 停 rAF;恢复时直接摆,不补播 | — | — | PetStage 自己暂停 |
 * | 画面宽高变 | 下一帧重算几何(纹带、红点、唱臂角、歌词落位全跟着) | ← | ← | 锚点跟着 |
 * | 卸载 | 取消 rAF、唱头指针跟踪 | ← | ← | PetStage 自己清 |
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 * | 状态 | 画面 |
 * | 首载(还没读数) | 唱片空标签、唱臂归位,不画黑豆 |
 * | 电台开着、播放器没歌 | 标签「黑豆电台」;唱臂归位;歌词位置空 |
 * | 在放 / 暂停 | 见 ① |
 * | 挑歌(busy) | 封套翘起,黑豆扭头去翻;歌照放 |
 * | 出错 | 黑豆蚊香眼;唱片照读数摆(错话在面板上就地一行) |
 * | 没有歌词 / 读不到 | 歌词位置一句「这首没有歌词」 |
 * | 不知道总长 | 纹带按默认时长;唱头不接拖也不接键盘 |
 * | 超量:歌名很长 | 标签两行截断;歌手一行省略号 |
 * | 减弱动态效果 | 翻面与标签淡入变为瞬时(动效档归零);唱片照转(转不转是信息) |
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * | 件 | rest | hover | focus | active | disabled |
 * | 唱头 | 落着 / 抬着 | grab 手形 | 全局焦点环;←/→ 10s | 拖:抬起、提示条跟手写「A3 歌名 · 时间」 | 没总长:不接指针、tabIndex −1、aria-disabled |
 * | 歌词一句 | 暗 | 亮一点 | 全局焦点环 | — | 关着:整栏不可点 |
 * | 黑豆 | 见 PetStage | 手形 | 全局焦点环 | 撸 | — |
 */
export interface RecordDeckProps {
  runtime?: MusicRuntimeState
  brief?: MusicRadioState
  nowPlaying?: MusicNowPlayingView
  nowError?: string
  programme?: MusicProgrammeView
  /** 此刻的播放位置(秒,`usePlaybackPosition`)。 */
  position: number | undefined
  /** 宽面板:唱片 + 歌词整块居中、字大一号。由面板自己的宽说。 */
  wide: boolean
  /** 跳到这里(这一首的第几秒)。 */
  onSeek: (seconds: number) => void
  /** 放节目单里的这一首(拖唱臂到后面那一圈)。 */
  onPlayEntry: (encryptedId: string) => void
  petRef?: Ref<PetStageHandle>
  /** 你在打字 / 发出去了还没等到他回话(父级给,同一份真相不订两遍)。 */
  listening?: boolean
  awaitingHost?: boolean
  /** 帧源。缺省浏览器 rAF;测试喂一台手摇的或 `null`(只摆不转)。 */
  frames?: FrameSource | null
}

export function RecordDeck({
  runtime,
  brief,
  nowPlaying,
  nowError,
  programme,
  position,
  wide,
  onSeek,
  onPlayEntry,
  petRef,
  listening = false,
  awaitingHost = false,
  frames,
}: RecordDeckProps) {
  const t = useT()
  const { visible } = usePanelVisibility()
  const title = nowPlaying?.title ?? ''
  const playing = nowPlaying?.playing === true
  const present = Boolean(title)
  const duration = nowPlaying?.duration
  const ready = nowPlaying !== undefined || nowError !== undefined
  const activity = musicPetActivity({ runtime, brief, nowPlaying, nowError, programme, awaitingHost })
  const off = activity === 'off'

  // ── 量画面 → 几何(RO 回调只排帧,下一帧读完再写)──────────────────────────
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [geo, setGeo] = useState<DeckGeometry | null>(null)
  const measure = useCallback(() => {
    const el = surfaceRef.current
    if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return
    const next = deckGeometry(el.clientWidth, el.clientHeight, wide)
    setGeo((prev) => (prev && prev.width === next.width && prev.height === next.height && prev.R === next.R ? prev : next))
  }, [wide])
  useLayoutEffect(() => {
    measure()
  }, [measure])
  useEffect(() => {
    const el = surfaceRef.current
    if (typeof ResizeObserver !== 'function' || !el) return
    const frame = new FrameCoalescer(measure)
    const ro = new ResizeObserver(() => frame.schedule())
    ro.observe(el)
    return () => {
      ro.disconnect()
      frame.cancel()
    }
  }, [measure])

  // ── 这一面 ────────────────────────────────────────────────────────────────
  const side = useMemo(
    () => recordSideOf({ nowTitle: title || undefined, nowDuration: duration, recent: brief?.recent, entries: programme?.entries }),
    [title, duration, brief?.recent, programme?.entries],
  )
  const progress = side ? sideProgress(side, position) : 0
  const armDeg = geo && side ? angleForSide(geo, progress) : 0

  // 翻面 / 换标签:同一只动画两份名字轮流用,换一个名字浏览器就从头再播一次 —— 不用计时器。
  const sideKey = side ? `${side.letter}:${side.bands[0]?.title ?? ''}` : ''
  const flip = useTurn(sideKey, Boolean(side))
  const swap = useTurn(title, present)

  // ── 转盘 + 反光 ──────────────────────────────────────────────────────────
  const discRef = useRef<HTMLDivElement | null>(null)
  const warpRef = useRef<HTMLDivElement | null>(null)
  const [spin] = useState(
    () =>
      new SpinLoop(frames === undefined ? browserFrames() : frames, (deg) => {
        const warp = warpRef.current
        if (!warp) return
        // 反光跟着真实转角起伏:转得快晃得快,惯性停下时它也慢慢停,停住就不动。
        const a = (deg * Math.PI) / 180
        warp.style.setProperty('--warp-deg', `${(Math.sin(a) * 7).toFixed(2)}deg`)
        warp.style.setProperty('--warp-o', (0.62 + 0.3 * Math.sin(a * 2 + 0.8)).toFixed(3))
      }),
  )
  useEffect(() => {
    spin.attach([discRef.current])
    return () => spin.dispose()
  }, [spin])
  const placed = useRef(false)
  useEffect(() => {
    if (!ready) return
    spin.set(playing, !placed.current)
    placed.current = true
  }, [spin, ready, playing])

  const [docHidden, setDocHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const onChange = () => setDocHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  useLayoutEffect(() => {
    spin.setSuspended(!visible || docHidden)
  }, [spin, visible, docHidden])

  // ── 唱臂:拖 = 跳到这里 ─────────────────────────────────────────────────
  const seekable = present && side !== null && duration !== undefined && duration > 0 && position !== undefined
  const armRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const trackRef = useRef<PointerTrack | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(
    () => () => {
      trackRef.current?.dispose()
      trackRef.current = null
    },
    [],
  )

  const onGrab = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const surface = surfaceRef.current
      const arm = armRef.current
      const tip = tipRef.current
      if (e.button !== 0 || !seekable || !geo || !side || !surface || !arm || !tip) return
      e.preventDefault()
      const box = surface.getBoundingClientRect()
      const g = geo
      const min = angleForSide(g, side.bands[side.current].start / side.total)
      const max = angleForSide(g, 1)
      let deg = armDeg
      const paint = (next: number) => {
        deg = Math.min(max, Math.max(min, next))
        arm.style.setProperty('--arm-drag-deg', `${deg}deg`)
        const hit = bandAt(side, sideAtAngle(g, deg))
        const band = side.bands[hit.index]
        const at = needleAt({ ...g, L: g.L + g.R * 0.28 }, deg)
        tip.style.left = `${at.x}px`
        tip.style.top = `${at.y}px`
        tip.textContent = t('music.deckArmTip', {
          side: side.letter,
          n: hit.index + 1,
          name: splitTitle(band.title).name || band.title,
          time: clockOf(hit.index === side.current ? hit.seconds : 0),
        })
      }
      setDragging(true)
      tip.hidden = false
      paint(deg)
      const finish = () => {
        trackRef.current = null
        setDragging(false)
        tip.hidden = true
        arm.style.removeProperty('--arm-drag-deg')
      }
      trackRef.current?.dispose()
      trackRef.current = PointerTrack.open(e.currentTarget, e.pointerId, {
        move: (ev) => paint(angleAtPoint(g, ev.clientX - box.left, ev.clientY - box.top)),
        end: () => {
          const hit = bandAt(side, sideAtAngle(g, deg))
          const band = side.bands[hit.index]
          if (hit.index === side.current) onSeek(Math.round(hit.seconds))
          else if (band.encryptedId) onPlayEntry(band.encryptedId)
          finish()
        },
        cancel: finish,
      })
    },
    [armDeg, geo, onPlayEntry, onSeek, seekable, side, t],
  )

  const onArmKey = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      const step = e.key === 'ArrowRight' ? KEY_SEEK_S : e.key === 'ArrowLeft' ? -KEY_SEEK_S : 0
      if (!step || !seekable || duration === undefined || position === undefined) return
      e.preventDefault()
      onSeek(Math.round(Math.min(duration, Math.max(0, position + step))))
    },
    [duration, onSeek, position, seekable],
  )

  // ── 歌词:正在唱的那句对着唱针的高度 ─────────────────────────────────────
  const lyrics = useQuery(musicLyricsQuery)
  const lines = useMemo(() => lyrics.data?.lines ?? [], [lyrics.data])
  const rows = useMemo(() => (present ? lyricRowsOf(lines, duration) : []), [present, lines, duration])
  const current = currentRowAt(rows, position)
  const lyricsRef = useRef<HTMLOListElement | null>(null)
  const landedFor = useRef<string | null>(null)
  const [jump, setJump] = useState(true)
  useLayoutEffect(() => {
    const list = lyricsRef.current
    if (!list || !geo) return
    const row = list.querySelector<HTMLElement>(`[data-lyric-index='${Math.max(0, current)}']`)
    if (!row) return
    const first = landedFor.current !== title
    landedFor.current = title
    setJump(first)
    list.style.setProperty('--lyrics-y', `${geo.anchorY - (row.offsetTop + row.offsetHeight / 2)}px`)
  }, [current, rows, geo, title])
  const noLyrics = present && lyrics.phase === 'ready' && rows.length === 0

  // ── 黑豆 ────────────────────────────────────────────────────────────────
  usePetLive()
  const petId = useCurrentPetId()
  const pet = (petId !== undefined ? findBuiltinPet(petId) : undefined) ?? DEFAULT_PET
  const rosterRig = usePetRosterRig(pet?.id)
  const backendSaid = usePetUtterance()
  const utterance = backendSaid?.utterance ?? null
  const hushedId = usePetHushedId()
  const hushed = backendSaid !== null && backendSaid.id === hushedId

  // ── 画面 ────────────────────────────────────────────────────────────────
  const { name, artist } = splitTitle(title)
  const colors = present ? labelColorsFor(title) : undefined
  const surfaceStyle = (
    geo
      ? {
          '--deck-r': geo.R,
          '--deck-l': `${geo.L}px`,
          '--deck-d': `${geo.D}px`,
          '--deck-rx': `${geo.rx}px`,
          '--deck-ry': `${geo.ry}px`,
          '--deck-px': `${geo.px}px`,
          '--deck-py': `${geo.py}px`,
          '--deck-lx': `${geo.lyricsLeft}px`,
          '--deck-lr': `${geo.lyricsRight}px`,
          '--deck-ay': `${geo.anchorY}px`,
          '--pet-anchor-x': `${geo.petX}px`,
          '--pet-anchor-bottom': '0px',
          '--pet-scale': String(geo.petScale),
          '--fan-x': `${geo.petX + 30 * geo.petScale}px`,
          '--fan-scale': String(geo.petScale),
        }
      : {}
  ) as CSSProperties
  const recStyle = (
    colors
      ? { '--label-paper': colors.paper, '--label-ink': colors.ink }
      : { '--label-paper': 'var(--music-deck-label-idle-paper)', '--label-ink': 'var(--music-deck-label-idle-ink)' }
  ) as CSSProperties

  return (
    <div
      ref={surfaceRef}
      className={s.surface}
      style={surfaceStyle}
      data-wide={wide ? 'true' : undefined}
      data-off={off ? 'true' : undefined}
      data-testid="music-deck"
    >
      <div className={s.roomLight} aria-hidden="true" />
      <div
        className={s.rec}
        style={recStyle}
        data-flip={flip}
        data-swap={swap}
        data-testid="music-record"
        data-side={side?.letter}
      >
        <div className={s.rim} aria-hidden="true" />
        <div ref={discRef} className={s.disc} aria-hidden="true">
          {geo && side && <Bands side={side} />}
          <div className={s.paper} />
        </div>
        {geo && side && <BandMarks side={side} geo={geo} />}
        <div className={s.sheen} aria-hidden="true" />
        <div ref={warpRef} className={s.warp} aria-hidden="true" />
        <div className={s.labelText} aria-live="polite" data-testid="music-label">
          <div className={s.labelUp}>
            <p className={s.title} data-testid="music-now-title">
              {present ? name || t('music.untitled') : t('music.deckStation')}
            </p>
          </div>
          <div className={s.labelDown}>
            <span className={s.artist}>{present ? artist : off ? t('music.deckOff') : ''}</span>
            {side && brief?.active === true && (
              <span className={s.sideMark} data-testid="music-side">
                {t('music.deckSide', { side: side.letter, n: side.current + 1, total: side.bands.length })}
              </span>
            )}
          </div>
        </div>
        <div className={s.spindle} aria-hidden="true" />
      </div>

      <div className={s.pivot} aria-hidden="true" />
      <div
        ref={armRef}
        className={s.arm}
        style={{ '--arm-deg': `${armDeg}deg` } as CSSProperties}
        data-lifted={!playing || dragging ? 'true' : undefined}
        data-dragging={dragging ? 'true' : undefined}
      >
        <span className={s.weight} aria-hidden="true" />
        <span className={s.hub} aria-hidden="true" />
        <span className={s.tube} aria-hidden="true" />
        <span className={s.head} aria-hidden="true">
          <span className={s.shell} />
          <span className={s.cartridge} />
          <span className={s.lift} />
        </span>
        <ButtonBase
          className={s.grab}
          role="slider"
          tabIndex={seekable ? 0 : -1}
          aria-label={t('music.armLabel')}
          aria-valuemin={0}
          aria-valuemax={duration ?? 0}
          aria-valuenow={position !== undefined ? Math.round(position) : 0}
          aria-valuetext={position !== undefined ? progressOf(position, duration) : undefined}
          aria-disabled={seekable ? undefined : true}
          onPointerDown={onGrab}
          onKeyDown={onArmKey}
          data-testid="music-arm"
        />
      </div>

      <div className={s.lyricsWin} aria-label={t('music.lyrics')} data-testid="music-lyrics">
        <ol ref={lyricsRef} className={s.lyrics} data-jump={jump ? 'true' : undefined}>
          {rows.map((row, index) => {
            const label = row.interlude
              ? t(index === 0 ? 'music.deckIntro' : index === rows.length - 1 ? 'music.deckOutro' : 'music.deckInterlude')
              : row.text
            return (
              <li key={`${row.at}:${index}`}>
                <ButtonBase
                  className={s.line}
                  data-lyric-index={index}
                  data-current={index === current ? 'true' : undefined}
                  data-past={index < current ? 'true' : undefined}
                  data-gap={row.interlude ? 'true' : undefined}
                  tabIndex={off ? -1 : undefined}
                  onClick={() => onSeek(Math.round(row.at))}
                >
                  {label}
                </ButtonBase>
              </li>
            )
          })}
        </ol>
      </div>
      {off && (
        <p className={s.note} data-testid="music-lyrics-off">
          {t('music.deckLyricsOff')}
        </p>
      )}
      {noLyrics && !off && (
        <p className={s.note} data-testid="music-lyrics-empty">
          {t('music.lyricsEmpty')}
        </p>
      )}

      <div className={s.fan} data-show={activity === 'busy' ? 'true' : undefined} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className={s.perch}>
        {ready && pet && (
          <PetStage
            key={pet.id}
            ref={petRef}
            manifest={pet}
            rig={rosterRig}
            activity={activity}
            listening={listening}
            utterance={utterance}
            hushed={hushed}
            size="stage"
            onGesture={reportGesture}
          />
        )}
      </div>
      <span ref={tipRef} className={s.tip} hidden aria-hidden="true" />
    </div>
  )
}

/** 纹带之间的空白:跟着唱片转(同心圆,转与不转看上去一样,转是真的)。 */
function Bands({ side }: { side: RecordSide }) {
  return (
    <svg className={s.discSvg} viewBox="0 0 200 200">
      {side.bands.slice(1).map((band) => {
        const r = svgRadiusAt(band.start / side.total)
        return (
          <g key={`${band.start}:${band.title}`}>
            <circle className={s.gap} cx="100" cy="100" r={r.toFixed(2)} />
            <circle className={s.gapShade} cx="100" cy="100" r={(r + 1.2).toFixed(2)} />
          </g>
        )
      })}
    </svg>
  )
}

/** 不随唱片转的两样:正在放的那一圈的光、黑豆会开口的那几枚红点。 */
function BandMarks({ side, geo }: { side: RecordSide; geo: DeckGeometry }) {
  const band = side.bands[side.current]
  const r0 = svgRadiusAt(band.start / side.total)
  const r1 = svgRadiusAt((band.start + band.seconds) / side.total)
  return (
    <svg className={s.fixedSvg} viewBox="0 0 200 200" aria-hidden="true">
      <circle className={s.glow} cx="100" cy="100" r={((r0 + r1) / 2).toFixed(2)} strokeWidth={Math.max(0, r0 - r1).toFixed(2)} />
      {side.bands.map((b, i) => {
        if (i <= side.current || !b.talk) return null
        const at = needleAt(geo, angleForSide(geo, b.start / side.total))
        return (
          <circle
            key={`${b.start}:${b.title}`}
            className={s.talkDot}
            cx={(((at.x - geo.rx) / geo.D) * 200).toFixed(1)}
            cy={(((at.y - geo.ry) / geo.D) * 200).toFixed(1)}
            r="2.4"
            data-testid="music-talk-dot"
          />
        )
      })}
    </svg>
  )
}

/**
 * 一格值变了就换一个名字('a' ↔ 'b'),让同一只动画从头再播一次。第一次出现不播
 * (挂载直接摆,不演)。`live` 为假 = 此刻没有东西可播,不算一次变化。
 */
function useTurn(key: string, live: boolean): 'a' | 'b' | undefined {
  const [state, setState] = useState<{ key: string; turn: 'a' | 'b' | undefined }>({ key, turn: undefined })
  if (live && key !== state.key) {
    const seen = state.key !== ''
    setState({ key, turn: seen ? (state.turn === 'a' ? 'b' : 'a') : undefined })
  } else if (!live && state.key !== '') {
    setState({ key: '', turn: state.turn })
  }
  return state.turn
}
