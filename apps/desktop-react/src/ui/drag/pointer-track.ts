import { focusTree } from '../../focus/registry'

/**
 * **一次「按下即拖」的指针跟踪**(U5,2026-09-08;设计:拖拽 v4)。
 *
 * ── 它是什么、不是什么 ──────────────────────────────────────────────────
 * 壳里有两族指针手势,这一件管的是**第二族**:
 *
 *   ① 搬运一样东西     `ui/drag/DragSession` —— 有阈值(走过 `DRAG_START_PX`
 *                      才算「这一下是拖」)、有浮影、有落点反馈、有落定动作
 *   ② 调一个数         **这一件** —— 按下那一刻就已经在拖(杆本身没有第二种
 *                      意思),没有阈值、没有浮影、没有落点:分隔杆的比例、
 *                      架子的厚度、浮窗的位置与身量
 *
 * 分工一句话:**这一件管「指针在不在、这一下要不要作废」,`DragSession` 管
 * 「算不算一次拖、浮影画什么、松手落到哪」。**
 *
 * ── 为什么它必须存在(病历)────────────────────────────────────────────
 * 第二族从前是三处各自手写的,三处**都只有两条结束路径**(pointerup /
 * pointercancel),而且监听挂在**元素上**、不在 window 上。后果:拖到一半
 * Cmd-Tab 切走应用、或系统弹框抢走指针 —— capture 一丢,那三条元素级监听就
 * 再也收不到事件,于是 `data-splitting` / 活厚度 / 活窗位一直挂着,直到用户
 * 下一次**恰好在同一个元素上**松手;Esc 也取消不了(整个第二族没有一处认它)。
 * 三处一个病,所以修法是**一件基础件**而不是三处各补两条监听(CLAUDE.md
 * 「基础件先行」:先立件入库再消费,禁止在业务面就地手写)。
 *
 * ── 三条结束路径(与 `DragSession` 同一张表)──────────────────────────
 *   `end(ev)`      pointerup —— 消费方在这里**落定**(写 store)
 *   `cancel('escape')`        Esc,经 `focusTree.registerTransient` 收到
 *   `cancel('pointercancel')` 指针被系统收走
 *   `cancel('blur')`          窗口失焦(切了应用、点了系统弹框)
 * 三条 cancel 是**同一句话**「这一下不算数」,所以消费方只写一只回调:
 * **还原到按下那一刻**,一个字都不落定。理由带在参数里只为排障说得清是哪一条。
 *
 * ── 为什么监听挂在 window 而不是元素上 ────────────────────────────────
 * `blur` 只在 window 上发得出来(元素级的 `blur` 是焦点事件,与「这扇窗不在
 * 前台了」不是一回事);而 pointer 事件本来就冒泡到 window,抢到 capture 之后
 * 也照旧冒泡。所以 window 一份监听把「指针还在元素里」与「已经甩出去了」两种
 * 情形一并收下,没有第二条分支 —— 与 `DragSession` 那段判词同源。
 *
 * ── Esc 走响应链的瞬态口,禁 window listener(不变量 I2)──────────────
 * `keydown` 监听全仓只许住在 `src/focus/`。这一件因此与 `DragSession` /
 * `ui/Tooltip` / `ui/inline-edit` 走**同一口** `focusTree.registerTransient`:
 * 开场登记、每条结束路径注销,由那唯一的派发器在问活动路径之前先问到它。
 * 它答 **true**(与 `DragSession` 同一句判词:拖拽中的 Esc 是明确的
 * 「取消这一下」,该吃掉;tooltip 那一族答 false)。
 *
 * ── 为什么 `DragSession` 今天**不**吃这一件 ──────────────────────────
 * 试过了,套不上,理由是三条**语义**上的分叉,不是几行代码的重复:
 *  ① **登记时机不同**:这一件按下即登记 Esc 与 capture;`DragSession` 两样都
 *     要等**过了阈值**才做 —— 没起拖时按 Esc 该归别人(比如关掉一层浮层),
 *     而在 pointerdown 里抢 capture 会把兼容鼠标事件一并重定向、让一次纯点击
 *     的 `click` 目标换人(那是 09-05 `gate:focus` 场景 12 当场抓到的真 bug,
 *     读数写在 `DragSession` 的 `move()` 里)。
 *  ② **cancel 的含义不同**:这一件的 cancel = **整个拆干净**(pointerup 那条
 *     监听一起摘),所以取消之后再来一发 pointerup 什么都不会发生;
 *     `DragSession` 的 Esc 取消**必须留着 pointerup**,因为手指还按着,那一发
 *     松手带出来的 `click` 要由它吃掉(`swallowNextClick`,同样是真机门抓到的
 *     一条真 bug)。两者是相反的契约。
 *  ③ **pointerup 有两种意思**:`DragSession` 的松手在「还没过阈值」时是一次
 *     普通点击、在「正在拖」时才是落定;这一件的松手只有一种意思。
 * 要让一件基础件同时长出「延迟登记」「取消但继续听」「松手两种意思」三格,
 * 等于把 `DragSession` 的判据搬进来再加三个开关 —— 那是硬套,不是收敛。
 * 两者今天真正共享的是**同一口 Esc**(`focusTree.registerTransient`)与
 * 同一条 window 监听纪律,而那两件事已经各自只有一个产地了。
 *
 * ── 模块级瞬态:一格都没有,所以不配 HMR dispose ──────────────────────
 * 每次按下**现造一只**,它的寿命是这一次手势;模块作用域里不存任何东西
 * (对照 `DragSession`:那一件有 `current` / `subscribers` / `landingTimer`
 * 三格模块级瞬态,所以它文件末尾有一段 `import.meta.hot.dispose`)。
 * CLAUDE.md 那条法的判据是「这东西的寿命是不是**这个模块实例**」—— 这里答不是。
 */

/** 这一下为什么不算数。只为排障说得清 —— 消费方的还原动作三条路一模一样。 */
export type PointerTrackCancelReason = 'escape' | 'pointercancel' | 'blur'

/**
 * 一次按下开出来的那几只回调。**按下那一刻由消费方现造** —— 起点、容器矩形、
 * 按下那一刻的值,全都闭包在里面,所以这一件不必认识它们中的任何一个。
 */
export interface PointerTrackRun {
  /** 每一发 pointermove。 */
  move?(ev: PointerEvent): void
  /** 松手落定。**在会话已经拆干净之后**才叫(次序即语义,见 `settle`)。 */
  end?(ev: PointerEvent): void
  /** 作废:还原到按下那一刻。同样在拆干净之后叫。 */
  cancel?(reason: PointerTrackCancelReason): void
}

/**
 * 一次跟踪会话。**造出来就已经在跟**(`open` 里装监听),所以没有 `start()`：
 * 一件「造好了但还没生效」的东西必然有人忘记生效。
 */
export class PointerTrack {
  private readonly run: PointerTrackRun
  private readonly source: HTMLElement
  private readonly pointerId: number
  /** 拆过没有。三条结束路径 + 外部 `dispose()` 共用它,所以拆卸天然幂等。 */
  private closed = false
  private offEscape: (() => void) | null = null

  private constructor(source: HTMLElement, pointerId: number, run: PointerTrackRun) {
    this.source = source
    this.pointerId = pointerId
    this.run = run
  }

  /**
   * 开一次跟踪。`source` 是按下的那个元素(capture 抢在它身上),`pointerId`
   * 是这一根手指。
   *
   * **主键判据与 `preventDefault` 都不在这里** —— 它们是消费方自己那一下按下的
   * 事(右键要留给上下文菜单、缺省动作是拉选区),而且消费方在开跟踪之前还要
   * 量容器、写 `data-splitting` 之类:那些活儿必须在同一条 `if` 后面,拆成两处
   * 判就是两份判据。这一件只接手「从现在起跟着这根手指」。
   */
  static open(source: HTMLElement, pointerId: number, run: PointerTrackRun): PointerTrack {
    const track = new PointerTrack(source, pointerId, run)
    // 抢不到不阻断:capture 只是锦上添花,监听在 window 上,最多丢「指针滑出
    // 这扇窗」的那几帧(与 `DragSession` 逐字同一句判)。
    try {
      source.setPointerCapture(pointerId)
    } catch {
      /* 不阻断 */
    }
    window.addEventListener('pointermove', track.onMove)
    window.addEventListener('pointerup', track.onUp)
    window.addEventListener('pointercancel', track.onPointerCancel)
    // 窗口失焦 = 这一下作废(切了应用、系统弹框抢走了指针)。它不是 keydown,
    // 与不变量 I2 无关。
    window.addEventListener('blur', track.onBlur)
    track.offEscape = focusTree.registerTransient(() => {
      track.cancel('escape')
      return true
    })
    return track
  }

  /** 从外面作废这一下(消费方的宿主卸载了之类)。已经结束过就什么都不做。 */
  cancel(reason: PointerTrackCancelReason): void {
    this.settle(() => this.run.cancel?.(reason))
  }

  /**
   * **只拆不叫**:摘监听、注销 Esc、还 capture。幂等 —— 三条结束路径与外部
   * 调用共用它,重复调用是空动作。
   */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onPointerCancel)
    window.removeEventListener('blur', this.onBlur)
    this.offEscape?.()
    this.offEscape = null
    try {
      this.source.releasePointerCapture(this.pointerId)
    } catch {
      /* 已经丢了就算了 —— 拆卸不该因为一次无害的失败中断 */
    }
  }

  /**
   * **次序即语义**:先把这一格跟踪拆干净,再叫回调 —— 回调会写 store(落定)
   * 或还原(取消),那一刻不该还有一条活着的监听在收事件。与 `DragSession`
   * 的 `up()` 那段判词同源。
   */
  private settle(notify: () => void): void {
    if (this.closed) return
    this.dispose()
    notify()
  }

  private readonly onMove = (ev: PointerEvent): void => {
    if (this.closed) return
    this.run.move?.(ev)
  }

  private readonly onUp = (ev: PointerEvent): void => {
    this.settle(() => this.run.end?.(ev))
  }

  private readonly onPointerCancel = (): void => {
    this.cancel('pointercancel')
  }

  private readonly onBlur = (): void => {
    this.cancel('blur')
  }
}
