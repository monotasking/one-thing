import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent, Ref, MouseEvent as ReactMouseEvent } from 'react'
import { FocusScope } from '../focus/FocusScope'
import type { ActivateReason } from '../focus/types'
import { useT } from '../i18n'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { PointerTrack } from '../ui/drag'
import { FrameCoalescer } from '../ui/frame-coalescer'
import { placeBubble } from './bubble'
import type { PetManifest } from './manifest'
import { beatSecondsOf, resolvePose } from './pose'
import { rigFor } from './rigs'
import { PetStageController } from './stage-controller'
import type { PerchSize, PetActivity, PetGesture, PetUtterance } from './types'
import s from './PetStage.module.css'

/**
 * **栖位**(宠物 P0,正本 `docs/design/pet-system-2026-09.md` §2.5 / §7)。
 *
 * 某块界面留给宠物的一个位置。它按 manifest 查表画形象,自己管气泡、戳 / 撸手势、
 * 焦点与键盘;活动与话语由宿主喂(P0 是 lab,P1 起是唱机,P2 起是 `pet:` 资源)。
 * **这里不出现任何一只宠物的名字、也不出现任何一个应用的名字。**
 *
 * 瞬时状态机与全部计时器在 `stage-controller.ts`;这一层只做三件事:把 props 递进去、
 * 把快照画出来、把指针 / 点击 / Esc 转成控制器的动词。
 *
 * ── ① 生命周期(§7.1)────────────────────────────────────────────────────
 *  · 挂载:按当前活动直接摆姿势,不播 wake;气泡为空。挂载那一刻带着的 `utterance`
 *    **不算新话语**(新对象身份才算)。
 *  · 活动变化:姿势过渡 450ms(CSS);off → 任何播 wake;still 满 9s 进 dozing;
 *    从 dozing 被叫醒播 startle 并嘀咕 woke(正在显示的气泡不打断)。
 *  · 新话语:替换当前气泡;撸时来的开口结束撸。
 *  · 栖位尺寸变化:形象按栖位档位 / 宽度换身量(CSS);气泡经 ResizeObserver 重定位,
 *    回调只读、定位写在下一帧(`FrameCoalescer`)。气泡内容与剩余停留时间不动。
 *  · 隐藏(架子收起 = 祖先 `inert`):暂停全部动画,计时器照走(CSS)。
 *  · 卸载:`controller.dispose()` 清全部计时器;在飞的指针跟踪 `dispose()` 还 capture。
 *  · 换宿主(架子 ↔ 浮窗 ↔ 舞台)= 一次卸载 + 挂载:气泡与姿势从头算,不带过去
 *    (P2 起话语是 `pet:` 资源里的事实,换宿主由数据源续上)。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · 没有 loading / error:形象是本地资产,台词是本地字典。
 *  · manifest 的 rig 查不到 → 只画那颗宠物按钮(可点、有名字),不画形象,不抛。
 *  · 空 = 没有气泡;气泡四种:开口(逐字 + 声波)/ 嘀咕 / 带选项 / 常驻(可带动作)。
 *  · 超量:一句很长的话 —— 气泡最大宽钳在栖位内(`--pet-bubble-max-w` 与栖位宽取小),
 *    高度随字长,放不下时贴栖位顶、盖住宠物(§7.4),不出栖位。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · 宠物按钮:rest / hover(指针手形)/ focus(全局环)/ active(撸 = `petted` 姿势)。
 *    没有 disabled / pending:戳和撸永远可用,也永远不改变任何应用。
 *  · 选项 / 动作按钮:随 `ui/Button`;选项亮出时第一颗拿焦点,Esc = 不选,
 *    选完焦点回宠物按钮(宿主在 `onChoice` 里另搬焦点则以宿主为准)。
 */

export interface PetStageHandle {
  /** 宿主说「用户喜欢了这个」:冒爱心 + 嘀咕 `liked`。 */
  love(): void
}

export interface PetStageProps {
  manifest: PetManifest
  activity: PetActivity
  /** 新对象身份 = 新话语;`null` = 宿主清掉当前气泡。 */
  utterance?: PetUtterance | null
  /**
   * 当前这句开口的**声音**已经说完(宠物 P3,§10.5)。变成 `true` 那一刻:字没出完就一次出齐,
   * 1.5s 后气泡收起。随着新话语一起换(宿主按话语 id 判),不是一个持久开关。
   */
  hushed?: boolean
  /** 你在打字。 */
  listening?: boolean
  size: PerchSize
  /** 开口中(字还在出)变化时通知 —— 宿主据此点亮 ON AIR。 */
  onSpeakingChange?: (speaking: boolean) => void
  onChoice?: (value: string | null) => void
  onGesture?: (gesture: PetGesture) => void
  ref?: Ref<PetStageHandle>
}

export function PetStage({
  manifest,
  activity,
  utterance = null,
  hushed = false,
  listening = false,
  size,
  onSpeakingChange,
  onChoice,
  onGesture,
  ref,
}: PetStageProps) {
  const t = useT()
  const [controller] = useState(() => new PetStageController({ activity }))
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  // 回调与台词每渲染同步一次(身份不稳定的就地闭包不进任何依赖表)。
  controller.hooks = {
    onSpeakingChange,
    onChoice,
    onGesture,
    line: (group) => {
      const lines = manifest.mutters[group]
      if (!lines?.length) return undefined
      const pick = lines[Math.floor(Math.random() * lines.length)] ?? lines[0]
      return { text: t(pick.key), holdMs: pick.holdMs }
    },
  }

  useImperativeHandle(ref, () => ({ love: () => controller.love() }), [controller])

  const trackRef = useRef<PointerTrack | null>(null)
  useEffect(() => {
    controller.start()
    return () => {
      trackRef.current?.dispose()
      trackRef.current = null
      controller.dispose()
    }
  }, [controller])

  // ── 活动:按「种类 + 拍速」认变化(同一个 rhythm 对象每渲染新造一份不算变化)──
  const activityKey = typeof activity === 'object' ? `${activity.kind}:${activity.bpm}` : activity
  const activityRef = useRef(activity)
  activityRef.current = activity
  useEffect(() => {
    controller.setActivity(activityRef.current)
  }, [controller, activityKey])

  // ── 话语:新对象身份才算新话语;挂载时带着的那一句不算(§7.1 第一行)──
  const seenUtterance = useRef<PetUtterance | null>(utterance)
  useEffect(() => {
    if (seenUtterance.current === utterance) return
    seenUtterance.current = utterance
    controller.say(utterance)
  }, [controller, utterance])

  // ── 声音说完:排在话语那一格之后,同一次提交里「新话语 + 已经说完」先说再收(§10.6 最后一行)──
  useEffect(() => {
    if (hushed) controller.hush()
  }, [controller, hushed, utterance])

  // ── 手势 ──────────────────────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return
      trackRef.current?.dispose()
      let lastX = e.clientX
      controller.pressStart()
      trackRef.current = PointerTrack.open(e.currentTarget, e.pointerId, {
        move: (ev) => {
          controller.pressMove(ev.clientX - lastX)
          lastX = ev.clientX
        },
        end: () => {
          trackRef.current = null
          controller.pressEnd('up')
        },
        cancel: () => {
          trackRef.current = null
          controller.pressEnd('cancel')
        },
      })
    },
    [controller],
  )

  /**
   * 键盘 Enter / Space 在真 `<button>` 上合成一次 `click`,`detail === 0`。
   * 指针那一路的点已经由 `pressEnd` 判过了,它随后带出的 `click`(`detail ≥ 1`)不再算一次。
   * 不挂 keydown(不变量 I2):按钮自己就把键盘翻译成了 click。
   */
  const onClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) controller.poke()
    },
    [controller],
  )

  // ── 焦点:选项亮出时落点换到第一颗;选完 / Esc 回到宠物按钮 ────────────────
  const petButtonRef = useRef<HTMLButtonElement | null>(null)
  const firstChoiceRef = useRef<HTMLButtonElement | null>(null)
  const wantChoiceFocus = useRef(false)
  const activateRef = useRef<((reason?: ActivateReason) => void) | null>(null)
  const bubble = snap.bubble
  const choicesOpen = Boolean(bubble?.done && bubble.choices?.length)

  useEffect(() => {
    if (!choicesOpen) return
    wantChoiceFocus.current = true
    activateRef.current?.('open')
    return () => {
      wantChoiceFocus.current = false
    }
  }, [choicesOpen, bubble?.id])

  /** 焦点先回宠物按钮(选项马上要卸载),再交给控制器 —— 宿主在回调里另搬焦点就以宿主为准。 */
  const returnFocus = useCallback(() => {
    wantChoiceFocus.current = false
    activateRef.current?.('restore')
  }, [])

  const onEscape = useCallback(() => {
    const open = controller.getSnapshot().bubble
    if (!open?.done || !open.choices?.length) return false
    returnFocus()
    return controller.escape()
  }, [controller, returnFocus])

  // ── 气泡定位(§7.4 定位列)──────────────────────────────────────────────
  const perchRef = useRef<HTMLElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const place = useCallback(() => {
    const perch = perchRef.current
    const el = bubbleRef.current
    const hit = petButtonRef.current
    if (!perch || !el || !hit) return
    const perchBox = perch.getBoundingClientRect()
    const hitBox = hit.getBoundingClientRect()
    const geo = placeBubble({
      perchW: perchBox.width,
      anchorX: hitBox.left + hitBox.width / 2 - perchBox.left,
      anchorY: hitBox.top - perchBox.top,
      bubbleW: el.offsetWidth,
      bubbleH: el.offsetHeight,
    })
    el.style.left = `${geo.left}px`
    el.style.top = `${geo.top}px`
    el.style.setProperty('--pet-tail-x', `${geo.tailX}px`)
  }, [])

  useLayoutEffect(() => {
    place()
  }, [place, bubble?.id, bubble?.typed, bubble?.done, size])

  useEffect(() => {
    const perch = perchRef.current
    const el = bubbleRef.current
    if (typeof ResizeObserver !== 'function' || !perch || !el) return
    // RO 回调只读不写:量到变化只排一帧,定位在下一帧里读完再写。
    const frame = new FrameCoalescer(place)
    const ro = new ResizeObserver(() => frame.schedule())
    ro.observe(perch)
    ro.observe(el)
    return () => {
      ro.disconnect()
      frame.cancel()
    }
  }, [place])

  // 淡出那一段还要看得见刚才那句话:气泡没了之后留着上一句的字(选项与动作不留)。
  const lastBubble = useRef(bubble)
  if (bubble) lastBubble.current = bubble
  const shown = bubble ?? lastBubble.current

  const Rig = rigFor(manifest.rig)
  const pose = resolvePose({
    activity: snap.activity,
    stillSince: snap.stillSince,
    now: snap.now,
    speaking: snap.speaking,
    listening,
    petted: snap.petted,
  })
  const petName = t(manifest.name)

  return (
    <FocusScope
      scope="pet"
      rootRef={perchRef}
      restingTarget={() => (wantChoiceFocus.current ? firstChoiceRef.current : null) ?? petButtonRef.current}
      onEscape={onEscape}
    >
      {({ scopeProps, activate }) => {
        activateRef.current = activate
        return (
          <div {...scopeProps} className={s.perch} data-size={size} data-testid="pet-stage">
            <div
              ref={bubbleRef}
              className={s.bubble}
              data-mode={shown?.mode}
              data-show={bubble ? 'true' : undefined}
              data-done={shown?.done ? 'true' : undefined}
              role="status"
              aria-live="polite"
              data-testid="pet-bubble"
            >
              {bubble && <span className="visually-hidden">{bubble.glyphs.join('')}</span>}
              {shown?.mode === 'speak' && (
                <span className={s.wave} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {shown && (
                <span className={s.text} aria-hidden="true" data-testid="pet-bubble-text">
                  {shown.glyphs.slice(0, shown.typed).join('')}
                </span>
              )}
              {bubble && choicesOpen && (
                <span className={s.acts}>
                  {bubble.choices?.map((choice, i) => (
                    <Button
                      key={choice.value}
                      ref={i === 0 ? firstChoiceRef : undefined}
                      pill
                      className={s.act}
                      onClick={() => {
                        returnFocus()
                        controller.choose(choice.value)
                      }}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </span>
              )}
              {bubble?.done && bubble.actions?.length ? (
                <span className={s.acts}>
                  {bubble.actions.map((action, i) => (
                    <Button
                      key={action.label}
                      pill
                      className={s.act}
                      onClick={() => {
                        returnFocus()
                        controller.act(i)
                      }}
                    >
                      {action.label}
                    </Button>
                  ))}
                </span>
              ) : null}
            </div>
            <div className={s.pet}>
              {Rig && (
                <Rig
                  pose={pose}
                  beat={pose === 'grooving' ? beatSecondsOf(snap.activity) : undefined}
                  mouth={snap.speaking && !snap.petted ? 'talking' : 'closed'}
                  oneShot={snap.oneShot}
                />
              )}
              <ButtonBase
                ref={petButtonRef}
                className={s.hit}
                aria-label={petName}
                onPointerDown={onPointerDown}
                onClick={onClick}
                data-pose={pose}
                data-testid="pet-button"
              />
            </div>
          </div>
        )
      }}
    </FocusScope>
  )
}
