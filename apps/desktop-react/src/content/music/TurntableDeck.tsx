import { useCallback, useRef } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { PointerTrack } from '../../ui/drag'
import { useT } from '../../i18n'
import { ARM_REST_DEG, angleAtPointer, armAngleFor, clockOf, progressForAngle, splitTitle } from './turntable'
import s from '../MusicPanel.module.css'

/**
 * **唱盘与唱臂**(唱机音乐面 M1)。
 *
 * ── 一个手势一个意思 ────────────────────────────────────────────────────
 * 唱片**只是显示**:播放时转、暂停时停,不接指针(搓碟播放器做不到,画成能搓
 * 的样子就是撒谎)。唱臂只有一个含义 —— **跳到这里**:按住唱头拖,气泡报目标
 * 时间,松手才 `onSeek` 一次;Esc / 切走应用 / 指针被系统收走 = 这一下不算,
 * 唱臂回到按下前(`ui/drag` 的 `PointerTrack` 三条结束路径)。没有「抬臂」这一态:
 * 暂停是播放钮的事。
 *
 * 唱臂对读屏与键盘**藏起来**(`aria-hidden`):同一件事的可达入口是进度条
 * (`ui/Slider`,role=slider),两处发的是同一条 `seek`。
 *
 * ── 跟手 ────────────────────────────────────────────────────────────────
 * 拖动期间零 React 重渲:角度直接写进 `--arm-deg`、时间直接写进气泡(与
 * `ui/Slider` 同一条跟手定律)。松手之后由父级的乐观补丁把位置交回来。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:纯受控,位置由 props 给;拖到一半卸载 / 换宿主,`PointerTrack`
 *    的 window 监听先走到结束路径,不悬挂。
 * ② UI 生命状态:没歌 → 空唱盘、唱臂靠在支架上、标签空白;有歌不知道总长 →
 *    唱片照转、唱臂不可拖(没有总长就算不出「这一圈是几秒」);有歌 → 完整。
 * ③ UI 交互状态:唱头 rest / hover(唱头变亮)/ dragging(`data-dragging`,
 *    气泡出现)/ disabled(没有总长,不接指针)。无 pending:松手之后的反馈是唱臂
 *    停在目标处,读数回来再对齐。
 */
export function TurntableDeck({
  title,
  playing,
  position,
  duration,
  onSeek,
}: {
  title: string | undefined
  playing: boolean
  position: number | undefined
  duration: number | undefined
  onSeek: (seconds: number) => void
}) {
  const t = useT()
  const platRef = useRef<HTMLDivElement | null>(null)
  const armRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const { name, artist } = splitTitle(title)
  const hasSong = Boolean(title)
  const seekable = hasSong && duration !== undefined && duration > 0 && position !== undefined
  const angle = seekable ? armAngleFor((position ?? 0) / (duration ?? 1)) : ARM_REST_DEG

  const onGrab = useCallback(
    (e: ReactPointerEvent<HTMLSpanElement>) => {
      const plat = platRef.current
      const arm = armRef.current
      const tip = tipRef.current
      if (e.button !== 0 || !seekable || !plat || !arm || !tip || duration === undefined) return
      e.preventDefault()
      const box = plat.getBoundingClientRect()
      let progress = progressForAngle(angle)
      const paint = (clientX: number, clientY: number) => {
        progress = progressForAngle(angleAtPointer(box, clientX, clientY))
        arm.style.setProperty('--arm-deg', `${armAngleFor(progress)}deg`)
        tip.textContent = t('music.armTo', { time: clockOf(progress * duration) })
      }
      arm.dataset.dragging = 'true'
      tip.hidden = false
      paint(e.clientX, e.clientY)
      const finish = () => {
        delete arm.dataset.dragging
        tip.hidden = true
        arm.style.removeProperty('--arm-deg')
      }
      PointerTrack.open(e.currentTarget, e.pointerId, {
        move: (ev) => paint(ev.clientX, ev.clientY),
        end: () => {
          // 先交位置(乐观补丁当场把 --arm-rest-deg 换成目标),再撤活值 —— 反过来会闪回一帧。
          onSeek(Math.round(progress * duration))
          finish()
        },
        cancel: finish,
      })
    },
    [angle, duration, onSeek, seekable, t],
  )

  return (
    <div
      ref={platRef}
      className={s.plat}
      data-playing={playing && hasSong ? 'true' : undefined}
      data-testid="music-turntable"
    >
      <span className={s.platter} aria-hidden="true" />
      {hasSong && (
        <span className={s.vinyl} aria-hidden="true">
          <span className={s.label}>
            <span className={s.labelName}>{name}</span>
            {artist && <span className={s.labelArtist}>{artist}</span>}
          </span>
        </span>
      )}
      <span className={s.sheen} aria-hidden="true" />
      <div
        ref={armRef}
        className={s.arm}
        style={{ '--arm-rest-deg': `${angle}deg` } as CSSProperties}
        data-seekable={seekable ? 'true' : undefined}
        aria-hidden="true"
      >
        <span className={s.armBar} />
        <span className={s.armWeight} />
        <span className={s.armHead} />
        <span className={s.armGrab} onPointerDown={onGrab} data-testid="music-arm" />
      </div>
      <span className={s.pivot} aria-hidden="true" />
      <span ref={tipRef} className={s.armTip} hidden aria-hidden="true" />
    </div>
  )
}
