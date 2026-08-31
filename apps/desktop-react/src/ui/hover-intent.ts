import { useEffect, useRef, useState } from 'react'

/**
 * 悬停意图(hover intent)—— 「一次只有一个主角」的浮层由谁占着,由这里说了算。
 *
 * 三件事收在一处,业务面不许再各写一份(09-01「基础件先行」立法):
 *  ① **延迟出**:悬停够 `delayMs` 才算「他要看这个」,擦过去的不算;
 *  ② **宽限收**:离开之后缓 `graceMs` 才收,再进即取消 —— 目标与触发件之间
 *     那条缝(Dock 是 --preview-lift 的 12px)谁都不属于,没有宽限就过不去;
 *  ③ **瞄准区**:已经开着的浮层,用户朝它走过去的路上**途经任何旁人都不换人、
 *     也不排收拢**(menu-aim / macOS 子菜单的老配方)。
 *
 * 这里只管**什么时候**,不管**在哪里**:瞄准区的几何由消费方注入
 * (`HoverAimProbe`),所以这只件既伺候得了 Dock 的预览泡(泡在条内侧,判据在
 * stage/transitions 的四边表里),也伺候得了将来的菜单二级面 —— 换的只是探针。
 *
 * ── 病历(09-01,Dock 预览泡)──────────────────────────────────────────
 * 修前每块瓦各管各的悬停,于是「一次只有一个泡」根本没有人负责。真机探针
 * (慢·平路径 12 步、140ms/步,从 browser 走向泡的左下角):
 *   ①…④ 泡=browser → ⑤ **泡=null**(旧瓦 320ms 宽限到期,泡凭空消失)
 *   → ⑥…⑫ 泡=terminal,左缘从 388 横跳到 320。
 * 用户瞄着 A 的泡走过去,半路先看它消失,再看它变成 B 的并且挪了位置。
 * 病根是**所有权散在各件里**:两块瓦可以同时以为泡是自己的(录屏第 130 帧
 * 抓到过这一态),没有人能说「他正冲着我来,你们都别动」。
 */

/** 指针位置。刻意不复用 stage 的 Point:ui/ 是组件库,不认识形态机的词汇。 */
export interface HoverPoint {
  x: number
  y: number
}

/**
 * 瞄准区探针 —— 消费方注入的那块几何。
 *
 * `A` 是探针自己的账(Dock 记的是「离开点 + 泡矩形」),这只件从不拆开看它。
 */
export interface HoverAimProbe<A> {
  /**
   * 指针刚离开当前主角:要不要武装瞄准区。
   * `from → to` 是最后一步位移(`to` 就是离开点 = 三角形的顶点),
   * 返回 null = 这一下不该武装(例如根本不是朝目标去的)。
   */
  arm(from: HoverPoint, to: HoverPoint, openId: string): A | null
  /** 每一步:还在瞄准区里吗?这一步朝目标推进了吗? */
  track(aim: A, from: HoverPoint, to: HoverPoint): { inside: boolean; progressed: boolean }
}

export interface HoverIntentOptions<A> {
  delayMs: number
  graceMs: number
  /**
   * 瞄准区的**停顿**窗口,不是飞行总时长:每一步只要还在朝目标推进就续期,
   * 所以慢慢瞄不会被切断;停在瞄准区里不动超过这么久才解除。
   * (写成总时长的话,一条慢而平的真手路径要走一秒多,窗口必然中途到期。)
   */
  aimWindowMs: number
  aim?: HoverAimProbe<A>
  onChange(openId: string | null): void
  /** 注入时钟,给测试用。 */
  now?: () => number
}

export interface HoverIntentController {
  /** 指针进了某个触发件。`canOpen: false` = 这件东西没有浮层可开(但它照样是别人的「离开」)。 */
  enter(id: string, canOpen?: boolean): void
  leave(id: string): void
  /** 指针每一步。瞄准区全靠它推进。 */
  move(p: HoverPoint): void
  /** 指针整个离开了这一片(例如走出整条 Dock)。 */
  cancel(): void
  dispose(): void
  /** 此刻是否武装着瞄准区 —— 只读,给测试与调试看。 */
  isAiming(): boolean
}

export function createHoverIntent<A>(options: HoverIntentOptions<A>): HoverIntentController {
  const now = options.now ?? (() => Date.now())
  let openId: string | null = null
  let hoverId: string | null = null
  let armTimer: ReturnType<typeof setTimeout> | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let aim: { data: A; expires: number } | null = null
  let prev: HoverPoint | null = null
  let last: HoverPoint | null = null

  const clearArm = () => {
    if (armTimer) clearTimeout(armTimer)
    armTimer = null
  }
  const clearGrace = () => {
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = null
  }
  const open = (id: string) => {
    clearArm()
    clearGrace()
    aim = null
    if (openId === id) return
    openId = id
    options.onChange(id)
  }
  const scheduleClose = () => {
    if (openId === null || graceTimer) return
    graceTimer = setTimeout(() => {
      graceTimer = null
      openId = null
      options.onChange(null)
    }, options.graceMs)
  }
  const armOpen = (id: string) => {
    clearArm()
    armTimer = setTimeout(() => {
      armTimer = null
      open(id)
    }, options.delayMs)
  }
  /**
   * 主角**留到有人接手**,指针不压着任何触发件时才排收拢。
   *
   * 这是 09-01 与「泡先消失再换人」一并结清的第二半:修前旁人接手要等它自己的
   * `delayMs`(600),而旧主角在 `graceMs`(320)就自己没了 —— 中间那 280ms 是一段
   * **谁都不在**的空窗。空窗不是「干净」,是闪。所以收拢只在真的没人可交接时排。
   */
  const handOver = () => {
    if (hoverId !== null && hoverId !== openId) {
      armOpen(hoverId)
      return
    }
    if (hoverId === null) scheduleClose()
  }

  return {
    enter(id, canOpen = true) {
      hoverId = id
      clearGrace()
      // 回到主角自己身上(含**进浮层**:浮层是触发件的后代,所以这里收到的是同一个 id)。
      if (openId === id) {
        aim = null
        clearArm()
        return
      }
      // 瞄准中:旁人一律不接手 —— 这一行就是「途经旁瓦不重定目标」。
      if (aim) return
      clearArm()
      if (canOpen) armOpen(id)
    },
    leave(id) {
      if (hoverId === id) hoverId = null
      clearArm()
      if (openId !== id) return
      const armed =
        options.aim && prev && last ? options.aim.arm(prev, last, id) : null
      if (armed !== null && armed !== undefined) {
        // 武装成功就**不排收拢**:半路那段空窗(修前的「泡先消失」)由此消除。
        aim = { data: armed, expires: now() + options.aimWindowMs }
        return
      }
      handOver()
    },
    move(p) {
      prev = last
      last = p
      if (!aim || !prev || !options.aim) return
      const { inside, progressed } = options.aim.track(aim.data, prev, p)
      if (inside) {
        if (progressed) {
          aim.expires = now() + options.aimWindowMs
          return
        }
        if (now() < aim.expires) return
      }
      // 瞄丢了(出了三角区,或者停在里面不动超过窗口):恢复常态。
      aim = null
      handOver()
    },
    cancel() {
      hoverId = null
      clearArm()
      aim = null
      prev = null
      last = null
      scheduleClose()
    },
    dispose() {
      clearArm()
      clearGrace()
      aim = null
    },
    isAiming: () => aim !== null,
  }
}

/**
 * React 侧的门面:把控制器的「谁是主角」接到一格 state 上。
 * 选项存在 ref 里,所以控制器只造一次 —— 每次渲染重造会把在飞的两个计时器扔掉。
 */
export function useHoverIntent<A>(options: HoverIntentOptions<A>): {
  openId: string | null
  controller: HoverIntentController
} {
  const [openId, setOpenId] = useState<string | null>(null)
  const latest = useRef(options)
  latest.current = options
  const ref = useRef<HoverIntentController | null>(null)
  if (ref.current === null) {
    ref.current = createHoverIntent<A>({
      get delayMs() {
        return latest.current.delayMs
      },
      get graceMs() {
        return latest.current.graceMs
      },
      get aimWindowMs() {
        return latest.current.aimWindowMs
      },
      get aim() {
        return latest.current.aim
      },
      now: () => (latest.current.now ?? Date.now)(),
      onChange: (id) => {
        setOpenId(id)
        latest.current.onChange(id)
      },
    })
  }
  const controller = ref.current
  useEffect(() => () => controller.dispose(), [controller])
  return { openId, controller }
}
