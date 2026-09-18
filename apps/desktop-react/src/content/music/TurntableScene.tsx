import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
} from 'react'
import type { MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import { currentMotionTier } from '../../components/motion'
import type { MusicNowPlayingView, MusicProgrammeView } from '../../data/music-source'
import {
  petOps,
  useCurrentPetId,
  usePetHushedId,
  usePetLive,
  usePetOnAir,
  usePetRosterRig,
  usePetUtterance,
} from '../../data/pet-source'
import { useT } from '../../i18n'
import { findBuiltinPet } from '../../pets/builtin'
import { PetStage } from '../../pets/PetStage'
import type { PetStageHandle } from '../../pets/PetStage'
import type { PetGesture } from '../../pets/types'
import { PointerTrack } from '../../ui/drag'
import { FrameCoalescer } from '../../ui/frame-coalescer'
import { usePanelVisibility } from '../visibility'
import { musicPetActivity } from './pet-activity'
import { browserFrames, DeckController, SpinLoop } from './scene-controller'
import type { FrameSource } from './scene-controller'
import {
  ARM_GRAB,
  ARM_PIVOT,
  ARM_REST_DEG,
  ARM_START_DEG,
  ARM_SVG,
  angleAtScenePoint,
  angleForProgress,
  arcLabelText,
  clientToScene,
  LABEL_FONT,
  LABEL_TRACKING,
  progressForAngle,
  rectStyle,
  SCENE_LAYOUT,
  sceneToContainer,
  sceneViewport,
  sleeveColorsFor,
  tipScenePoint,
} from './scene-geometry'
import { clockOf, progressOf, splitTitle } from './turntable'
import s from './TurntableScene.module.css'

/**
 * 这块栖位缺省演的宠物。P2 起 `pet:` 资源的 `current` 读得到就按它交来的 id 查壳侧台词表、
 * 按名册取形象(P5:手画的查表,声明式的交给 `DeclarativeRig`);读不到(宿主没有宠物子系统)
 * 就是这一只,与 P1 一样。
 */
const DEFAULT_PET = findBuiltinPet('heidou')

/** 手势 → `pet:` 的做法(§9.5)。发完不等、失败不提示。 */
function reportGesture(gesture: PetGesture): void {
  petOps[gesture.kind]()
}
/** 唱头 ←/→ 一下跳多少秒(§8.3)。 */
const KEY_SEEK_S = 10

/**
 * **唱机场景**(宠物 P1,正本 `docs/design/pet-system-2026-09.md` §8;样例「黑豆电台」)。
 *
 * 一间夜里的屋子:墙与台灯、窗外的雨、左边斜靠的封套、木底座、带频闪点的转盘、印着
 * 弧形歌名的黑胶与不随转的反光、唱臂、右边那摞唱片、右下角的黑豆(`PetStage`
 * 栖位 `music.turntable`)。画面上**没有一句说明**:放没放、在挑歌、关没关台,全由
 * 转盘、唱臂、灯和黑豆演出来。屏上的字只有封套与标签上印的歌名,以及拖唱头时那枚时间。
 * 底座上那盏 **ON AIR 灯**(宠物 P3,§10.5)是一件物件:黑豆的一句开口出声的那一段亮着,
 * `hushed` 到了就灭 —— 灯上印的两个词与底座上的「33⅓ RPM」同一类,是物件上的字,不是说明。
 *
 * ── 一个手势一个意思(§8.3)─────────────────────────────────────────────
 *  · 唱头 = 「跳到这里」:按住拖,松手发**一次** `seek`;Esc / 切走 / 指针被收走 = 不算,
 *    唱臂回到按下前。聚焦后 ←/→ 各 10 秒。换歌那一串跑着时不接手。
 *  · 唱片、封套、墙:什么都不发生(不做搓碟,不做点唱片进歌词)。
 *  · 黑豆:点 / 撸只嘀咕,永远不改变播放。♥ 成功时宿主调 `love()`。
 *
 * ── 谁动、怎么动 ─────────────────────────────────────────────────────────
 *  · 转盘角度只在 rAF 里写 `transform`(`SpinLoop`),不进 React 状态;
 *  · 唱片 / 封套 / 唱臂此刻摆成什么样由 `DeckController` 说,CSS 过渡演中间那一段;
 *  · 唱臂角度 = 播放位置的纯函数(`usePlaybackPosition` 那一个数,与进度条、歌词高亮
 *    同一个);拖动期间零重渲,角度写进 `--arm-drag-deg`。
 *  · 画布 640×420 等比缩放到容器宽:RO 回调只排帧,下一帧读宽、写缩放(RO 律)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张状态表
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期(§8.2)────────────────────────────────────────────────────
 * | 事件 | 唱机 | 黑豆 |
 * | 挂载(第一份读数到) | 直接摆:在放 → 满速 + 唱臂落在当前位置;暂停 → 唱臂抬在当前位置、不转;没歌 → 唱片收在封套里、唱臂归位 | 读数到了才挂栖位,直接摆姿势,不播 wake |
 * | 开始放(同一首) | 先起转(0.9s 到满速),450ms 后唱臂抬着移到当前位置(900ms)再落下 | rhythm |
 * | 暂停 | 唱臂原地抬起,转盘靠惯性 1.6s 停 | still,9s 后打盹 |
 * | 换歌(歌名 A → B,都非空) | 归位(900)+ 减速 → 收片(680)→ 封套换歌(600)→ 放片(680)→ 在放就起转 + 落针到此刻位置;期间唱臂不可拖;跑着时又换歌,跑完直接换到最新那首 | 不变 |
 * | 后端 `pet:` 发来一句话语(P2) | 开口:ON AIR 灯亮(P3) | 演它(P3 删了 P1 本地 `startingSay` 那一路:电台口播由宠物宿主认领后发来) |
 * | 后端 `pet:` 发来 `hushed`(P3) | 那句开口的灯灭 | 字没出完就一次出齐,1.5s 后气泡收 |
 * | 戳 / 撸(P2) | — | P0 的本地嘀咕照旧;另发 `pet:` 的 poke / stroke,发完不等、失败零提示 |
 * | `pet:current` 读不到(宿主没有宠物) | 灯不亮 | 不出气泡(P3 删了本地那一路),姿势照 P1 跑,零提示 |
 * | 播放器停了(有歌 → 无歌) | 归位 → 收片 → 封套变素面 | 按 §8.1 |
 * | 电台关台 | 同上,墙面灯暗一半 | 睡 |
 * | 进度被别处 seek | 唱臂 300ms 过渡到新位置 | 不变 |
 * | 隐藏(面板不可见 = 架子收起)/ `document.hidden` | 停 rAF;在飞的那一串作废直接摆;恢复时不补播 | PetStage 自己暂停动画 |
 * | 容器宽变化 | 下一帧重算缩放、高度、黑豆的锚点;< 520 裁掉窗与半张封套 | 气泡跟着宠物按钮重定位 |
 * | 卸载 | 取消 rAF、那一串的计时器、唱臂指针跟踪 | PetStage 自己清 |
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 * | 状态 | 画面 |
 * | 首载(还没读数) | 空屋子:转盘空、唱臂归位、封套素面,不画黑豆 |
 * | 没歌 | 同上,黑豆按活动(关台睡 / 挑歌翻唱片堆 / 其余坐着) |
 * | 在放 / 暂停 | 见 ① |
 * | 挑歌(busy) | 右边那摞唱片翘起来,黑豆扭头去翻 |
 * | 出错(fault) | 黑豆蚊香眼;唱机照读数摆(错误那句话在面板里就地一行) |
 * | 有歌不知道总长 | 唱片照转,唱臂停在外圈,不接拖也不接键盘 |
 * | 超量:歌名很长 | 标签那一圈收成省略号(不首尾叠字);封套两行截断 |
 * | 减弱动态效果 | 雨停、唱片堆不翘;换歌那一串变成 150ms 淡出淡入;转盘照转(转不转是信息) |
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * | 件 | rest | hover | focus | active | disabled | pending |
 * | 唱头 | 落着 / 抬着 | 手形 grab | 全局焦点环;←/→ 跳 10s | 拖:抬起、`data-dragging`、时间提示跟手 | 没总长 / 换歌中:不接指针、tabIndex -1、aria-disabled | 无:松手后唱臂停在目标,读数回来再对齐 |
 * | 黑豆 | 见 P0 §7.3 | 手形 | 全局焦点环 | 撸 | 无 | 无 |
 * | 唱片 / 封套 / 墙 | 只显示 | — | — | — | — | — |
 */

export interface TurntableSceneProps {
  runtime?: MusicRuntimeState
  brief?: MusicRadioState
  nowPlaying?: MusicNowPlayingView
  nowError?: string
  programme?: MusicProgrammeView
  /** 此刻的播放位置(秒,`usePlaybackPosition`)。 */
  position: number | undefined
  /** 跳到这里。每次松手 / 每次按键只调一次。 */
  onSeek: (seconds: number) => void
  /** 宿主拿它调 `love()`(♥ 成功)。 */
  petRef?: Ref<PetStageHandle>
  /**
   * 跟主持人说话那两格(§7.2 / §7.3):你在打字 → `listening`(歪头、耳朵抖);
   * 发出去还没等到他回话 → `busy`(他在翻唱片 / 在想)。
   *
   * 两格都由**父级**(音乐面)给,而不是这里自己去订 —— 说话那一条输入在这块场景
   * 外面,同一份真相订两遍迟早会在某一帧不一致。
   */
  listening?: boolean
  awaitingHost?: boolean
  /** 帧源。缺省用浏览器的 rAF;测试可以喂一台手摇的或 `null`(只摆不转)。 */
  frames?: FrameSource | null
}

const reducedMotion = () => currentMotionTier() === 'none'

export function TurntableScene({
  runtime,
  brief,
  nowPlaying,
  nowError,
  programme,
  position,
  onSeek,
  petRef,
  listening = false,
  awaitingHost = false,
  frames,
}: TurntableSceneProps) {
  const t = useT()
  const labelId = useId()
  const { visible } = usePanelVisibility()

  const title = nowPlaying?.title ?? ''
  const playing = nowPlaying?.playing === true
  const present = Boolean(title) || playing
  const duration = nowPlaying?.duration
  const ready = nowPlaying !== undefined || nowError !== undefined
  const activity = musicPetActivity({ runtime, brief, nowPlaying, nowError, programme, awaitingHost })

  // ── 唱片、封套、唱臂 ─────────────────────────────────────────────────────
  const [deck] = useState(() => new DeckController({ reducedMotion }))
  const snap = useSyncExternalStore(deck.subscribe, deck.getSnapshot, deck.getSnapshot)
  useEffect(() => {
    if (ready) deck.sync({ title, present, playing })
  }, [deck, ready, title, present, playing])
  useEffect(() => () => deck.dispose(), [deck])

  // ── 转盘 ────────────────────────────────────────────────────────────────
  const [spin] = useState(() => new SpinLoop(frames === undefined ? browserFrames() : frames))
  const discRef = useRef<HTMLDivElement | null>(null)
  const strobeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    spin.attach([discRef.current, strobeRef.current])
    return () => spin.dispose()
  }, [spin])
  const placedSeq = useRef(-1)
  useEffect(() => {
    const instant = placedSeq.current !== snap.placedSeq
    placedSeq.current = snap.placedSeq
    spin.set(snap.spinning, instant)
  }, [spin, snap.spinning, snap.placedSeq])

  // ── 隐藏:面板不可见(架子收起)或整扇窗转后台 ──────────────────────────
  const [docHidden, setDocHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const onChange = () => setDocHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  const suspended = !visible || docHidden
  useLayoutEffect(() => {
    deck.setSuspended(suspended)
    spin.setSuspended(suspended)
  }, [deck, spin, suspended])

  // ── 画布缩放 ────────────────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<HTMLDivElement | null>(null)
  const perchRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef(sceneViewport(0))
  const layout = useCallback(() => {
    const stage = stageRef.current
    const scene = sceneRef.current
    const perch = perchRef.current
    if (!stage || !scene || !perch) return
    const view = sceneViewport(stage.clientWidth)
    viewRef.current = view
    if (stage.clientWidth <= 0) return
    scene.style.transform = `translateX(${view.offsetX - view.viewX * view.scale}px) scale(${view.scale})`
    stage.style.height = `${view.height}px`
    const foot = sceneToContainer(
      view,
      SCENE_LAYOUT.perch.x + SCENE_LAYOUT.perch.w / 2,
      SCENE_LAYOUT.perch.y + SCENE_LAYOUT.perch.h,
    )
    perch.style.setProperty('--pet-anchor-x', `${foot.x}px`)
    perch.style.setProperty('--pet-anchor-bottom', `${view.height - foot.y}px`)
    perch.style.setProperty('--pet-scale', String(view.scale))
  }, [])
  useLayoutEffect(() => {
    layout()
  }, [layout])
  useEffect(() => {
    const stage = stageRef.current
    if (typeof ResizeObserver !== 'function' || !stage) return
    // RO 回调只读不写:量到变化只排一帧,缩放在下一帧里读完再写。
    const frame = new FrameCoalescer(layout)
    const ro = new ResizeObserver(() => frame.schedule())
    ro.observe(stage)
    return () => {
      ro.disconnect()
      frame.cancel()
    }
  }, [layout])

  // ── 唱臂:拖 = 跳到这里 ─────────────────────────────────────────────────
  const seekable =
    present && duration !== undefined && duration > 0 && position !== undefined && snap.disc === 'on' && !snap.busy
  const trackAngle =
    duration !== undefined && duration > 0 && position !== undefined ? angleForProgress(position / duration) : ARM_START_DEG
  const armAngle = snap.arm === 'rest' ? ARM_REST_DEG : trackAngle

  const armRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const trackRef = useRef<PointerTrack | null>(null)
  useEffect(
    () => () => {
      trackRef.current?.dispose()
      trackRef.current = null
    },
    [],
  )

  const onGrab = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const stage = stageRef.current
      const arm = armRef.current
      const tip = tipRef.current
      if (e.button !== 0 || !seekable || !stage || !arm || !tip || duration === undefined) return
      e.preventDefault()
      const box = stage.getBoundingClientRect()
      const view = viewRef.current
      let deg = armAngle
      const paint = (next: number) => {
        deg = next
        arm.style.setProperty('--arm-drag-deg', `${deg}deg`)
        const at = tipScenePoint(deg)
        const shown = sceneToContainer(view, at.x, at.y)
        tip.style.left = `${shown.x}px`
        tip.style.top = `${shown.y}px`
        tip.textContent = clockOf(progressForAngle(deg) * duration)
      }
      arm.dataset.dragging = 'true'
      tip.hidden = false
      paint(deg)
      const finish = () => {
        trackRef.current = null
        delete arm.dataset.dragging
        tip.hidden = true
        arm.style.removeProperty('--arm-drag-deg')
      }
      trackRef.current?.dispose()
      trackRef.current = PointerTrack.open(e.currentTarget, e.pointerId, {
        move: (ev) => {
          const at = clientToScene(view, box, ev.clientX, ev.clientY)
          paint(angleAtScenePoint(at.x, at.y))
        },
        end: () => {
          // 先交位置(乐观补丁把 --arm-deg 换成目标),再撤活值 —— 反过来会闪回一帧。
          onSeek(Math.round(progressForAngle(deg) * duration))
          finish()
        },
        cancel: finish,
      })
    },
    [armAngle, duration, onSeek, seekable],
  )

  const onArmKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.key === 'ArrowRight' ? KEY_SEEK_S : e.key === 'ArrowLeft' ? -KEY_SEEK_S : 0
      if (!step || !seekable || duration === undefined || position === undefined) return
      e.preventDefault()
      onSeek(Math.round(Math.min(duration, Math.max(0, position + step))))
    },
    [duration, onSeek, position, seekable],
  )

  // ── 黑豆:是哪一只、后端说的话 ───────────────────────────────────────────
  usePetLive()
  const petId = useCurrentPetId()
  const pet = (petId !== undefined ? findBuiltinPet(petId) : undefined) ?? DEFAULT_PET
  // P5 §12.3:形象按 id 从名册取(声明式形象只在名册里);名册没读到就退回手画表(`pet.rig`)。
  const rosterRig = usePetRosterRig(pet?.id)
  const backendSaid = usePetUtterance()
  // P3(§10.5):话语只有后端这一路。电台口播由宠物宿主认领、发 `utterance`;说完发 `hushed`。
  const utterance = backendSaid?.utterance ?? null
  const hushedId = usePetHushedId()
  const hushed = backendSaid !== null && backendSaid.id === hushedId
  const onAir = usePetOnAir()

  // ── 画面 ────────────────────────────────────────────────────────────────
  const shown = splitTitle(snap.title)
  const colors = snap.title ? sleeveColorsFor(snap.title) : undefined
  const sleeveStyle = {
    ...rectStyle(SCENE_LAYOUT.sleeve),
    ...(colors ? { '--sleeve-dark': colors.dark, '--sleeve-light': colors.light } : {}),
  } as CSSProperties
  const arcText = arcLabelText(shown.name, shown.artist)
  const busyFan = activity === 'busy'

  return (
    <div
      ref={stageRef}
      className={s.stage}
      data-room={activity === 'off' ? 'dim' : undefined}
      data-testid="music-turntable"
    >
      <div
        ref={sceneRef}
        className={s.scene}
        data-disc={snap.disc}
        data-sleeve={snap.sleeve}
        data-fading={snap.fading ? 'true' : undefined}
        data-spinning={snap.spinning ? 'true' : undefined}
        data-busy={snap.busy ? 'true' : undefined}
      >
        <div className={s.wall} aria-hidden="true" />
        <div className={s.window} style={rectStyle(SCENE_LAYOUT.window)} aria-hidden="true" />
        <div
          className={s.sleeve}
          style={sleeveStyle}
          data-blank={colors ? undefined : 'true'}
          aria-hidden="true"
          data-testid="music-scene-sleeve"
          data-title={snap.title}
        >
          {colors && (
            <>
              <span className={s.sleeveWho}>{shown.artist}</span>
              <span className={s.sleeveTitle}>{shown.name}</span>
            </>
          )}
        </div>
        <div className={s.plinth} style={rectStyle(SCENE_LAYOUT.plinth)} aria-hidden="true" />
        <span className={s.brand} style={rectStyle(SCENE_LAYOUT.brand)} aria-hidden="true">
          33⅓ RPM
        </span>
        <span
          className={s.onAir}
          style={rectStyle(SCENE_LAYOUT.onAir)}
          data-lit={onAir ? 'true' : undefined}
          aria-hidden="true"
          data-testid="music-onair"
        >
          ON AIR
        </span>
        <div className={s.platter} style={rectStyle(SCENE_LAYOUT.platter)} aria-hidden="true" />
        <div ref={strobeRef} className={s.strobe} style={rectStyle(SCENE_LAYOUT.platter)} aria-hidden="true" />
        <div className={s.record} style={rectStyle(SCENE_LAYOUT.record)} aria-hidden="true">
          <div ref={discRef} className={s.disc}>
            {colors && (
              <svg className={s.label} viewBox="0 0 236 236">
                <defs>
                  <path id={`${labelId}-arc`} d="M118 118 m-30 0 a30 30 0 1 1 60 0 a30 30 0 1 1 -60 0" />
                  <radialGradient id={`${labelId}-paper`}>
                    <stop offset="0%" style={{ stopColor: colors.light }} />
                    <stop offset="100%" style={{ stopColor: colors.dark }} />
                  </radialGradient>
                </defs>
                <circle cx="118" cy="118" r="41" fill={`url(#${labelId}-paper)`} />
                <circle className={s.labelRim} cx="118" cy="118" r="41" />
                <circle className={s.labelRing} cx="118" cy="118" r="23" strokeWidth="0.6" />
                <text className={s.labelText} fontSize={LABEL_FONT} letterSpacing={LABEL_TRACKING} style={{ fill: colors.dark }}>
                  <textPath href={`#${labelId}-arc`}>{arcText}</textPath>
                </text>
                <circle className={s.spindle} cx="118" cy="118" r="3.2" />
              </svg>
            )}
          </div>
          <div className={s.sheen} />
        </div>
        <div className={s.armBase} style={rectStyle(SCENE_LAYOUT.armBase)} aria-hidden="true" />
        <div className={s.cue} style={rectStyle(SCENE_LAYOUT.cue)} aria-hidden="true" />
        <div
          ref={armRef}
          className={s.arm}
          style={{ left: `${ARM_PIVOT.x}px`, top: `${ARM_PIVOT.y}px`, '--arm-deg': `${armAngle}deg` } as CSSProperties}
          data-lifted={snap.lifted ? 'true' : undefined}
          data-motion={snap.armMotion}
          data-seekable={seekable ? 'true' : undefined}
        >
          <svg className={s.armSvg} style={rectStyle(ARM_SVG)} viewBox="0 0 60 250" aria-hidden="true">
            <rect className={s.armWeight} x="21" y="16" width="18" height="26" rx="4" />
            <rect className={s.armWeightCap} x="21" y="16" width="18" height="6" rx="3" />
            <path className={s.armTube} d="M30 42 L30 196 Q30 206 26 214" strokeWidth="4.5" />
            <path className={s.armGlint} d="M30 42 L30 196 Q30 206 26 214" strokeWidth="1.2" transform="translate(-1 0)" />
            <g transform="rotate(18 26 222)">
              <rect className={s.armHead} x="17" y="210" width="18" height="24" rx="2.5" />
              <rect className={s.armLiftTab} x="33" y="214" width="9" height="3" rx="1.5" />
              <rect className={s.armStylus} x="24" y="229" width="4" height="4" />
            </g>
          </svg>
          <div
            className={s.grab}
            style={rectStyle(ARM_GRAB)}
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
        <div className={s.fan} style={rectStyle(SCENE_LAYOUT.fan)} data-show={busyFan ? 'true' : undefined} aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
      <div ref={perchRef} className={s.perch}>
        {ready && pet && (
          <PetStage
            // P5 §12.5:换宠物 = 栖位重挂(气泡清空、姿势按当前活动直接摆,不播 wake)。
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
