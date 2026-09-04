import { useEffect, useState } from 'react'
import { focusTree } from '../focus/registry'
import { LAYER_SCOPE_OF, takeOpenRequest } from './summon'
import { useStageStore } from './store'
import type { FocusScopeId } from '../focus/types'
import type { Placement, ShelfSide, StageState } from './types'

/**
 * **「挪到哪,焦点跟到哪」的唯一接线处**(09-03 R2,设计 §3.5 规则 3 与 §11 拍点 2)。
 *
 * ── 为什么是一处,不是六处 ──────────────────────────────────────────────────
 * 「形态落定」在 store 上有六七个动作各能促成一次(`openAs` / `clickDockIcon` /
 * `summonItem` / `stageToFloat` / `stageToEdge` / `floatToEdge` / `edgeToFloat`),
 * 而它们最后都汇进**同一个纯函数**(`transitions.openAs`)、写**同一格事实**
 * (`placements[id]`)。焦点该不该跟过去,判据只与那格事实的**前后差**有关,
 * 与「是哪一句 action 促成的」无关 —— 所以这件事只该有一处判,而且判的是差值。
 *
 * 于是这只文件是两半:上半是那只**纯函数**(前后两份状态 → 焦点该跟去哪一格),
 * 下半是那只 hook(订阅 + 在提交之后落焦)。`AppShell` 挂它一次,别处一个字不写。
 *
 * ── 三档,判据逐条写死 ──────────────────────────────────────────────────────
 *
 * | 前 | 后 | 跟不跟 | 理由 |
 * | --- | --- | --- | --- |
 * | dock | 任何形态 | **看有没有人点名** | 这是「打开」不是「挪动」,而两条打开路的答案不一样:指针点 Dock 瓦之后焦点留在瓦上(今天的行为,连着按两下同一块瓦仍然是开 / 关),**键盘**那条路要送(§3.5 规则 2)。手势本身在这一层看不出来,所以由键盘那条路自己**点名**(`requestFocusOnOpen`),这里只认那个名字。 |
 * | 某形态 A | 另一形态 B(含换边) | **跟** | §3.5 规则 3 的原话:「把面拼到舞台 / 钉到边 / 撕成浮窗,焦点跟着那块面走」。这一档不分指针 / 键盘 —— 拖拽落定本来就是指针,规则仍然要它跟。 |
 * | 任何形态 | dock(收起 / 关掉) | **不跟** | 那块面没了,没有可跟的东西;焦点该回哪儿是**结构归还**的事(树自己算,§4.5)。 |
 *
 * 外加一档与 `placements` 无关的:**架子切 tab**(§11 拍点 2 —— 用户已拍「进」)。
 * 它不改 `placements`(两块面都还钉在同一条边上),改的是 `shelves[side].activeId`,
 * 所以单独看那一格。
 *
 * ── 为什么要 `owner` ────────────────────────────────────────────────────────
 * 落定之后要激活的不是「某个 float-layer」,而是**装着这块面的那一扇**。同一种
 * layer 同时可能有好几份(四条边的架子 / 几扇浮窗),MRU 会选到「最近用过的那一份」
 * ——而它恰恰不是刚落定的这一份(刚落定的那一份还没被用过)。所以宿主层报出自己
 * 此刻的住户(`<FocusScope owner>`),这里按 `owner` 精确取。
 *
 * ── 落焦必须排在**提交之后**(真机证伪过一版)───────────────────────────────
 * 见下半那只 hook 的文件头:第一版把这件事包在 store 的 `set` 上,而落定那一刻
 * 宿主层还没挂上来 / 旧层的 `inert` 还没翻,`activateScope` 一律答 false。
 */

/** 两个落点算不算「同一个位置」。换边(左 → 右)算挪动,所以 side 也要比。 */
function samePlace(a: Placement | undefined, b: Placement | undefined): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'edge' && b.kind === 'edge' ? a.side === b.side : true
}

const SIDES: ShelfSide[] = ['left', 'right', 'top', 'bottom']

/** 一次落定要激活的那一格(答不出就是「这一次不必跟」)。 */
export interface FocusFollowTarget {
  scope: FocusScopeId
  owner: string
}

/**
 * 前后两份状态之间,焦点该跟去哪一格。**纯函数**,所以三档判据逐条钉得住。
 * 回 null = 这一次不跟(表里那三档的后两档,或者根本没变过)。
 */
export function focusFollowTarget(
  before: StageState,
  after: StageState,
  /** 键盘那条路点的名(见 `requestFocusOnOpen`)。指针那条路不点名。 */
  openedByKeyboard: string | null = null,
): FocusFollowTarget | null {
  for (const [id, next] of Object.entries(after.placements)) {
    const prev = before.placements[id]
    // 从 dock 出来 = 打开,不是挪动(表里第一档):只有键盘点了名才跟。
    if (!prev && id !== openedByKeyboard) continue
    if (prev && samePlace(prev, next)) continue
    const scope = LAYER_SCOPE_OF[next.kind]
    if (scope) return { scope, owner: id }
  }
  /*
   * **程序置顶一扇已经开着的浮窗**(设计 §5 最后一行:「`FloatWindow.focusFloat`
   * 的 z 序纯函数不动,宿主在程序置顶时补 `activate`;指针置顶不加动作」)。
   *
   * 它在这张表上**什么都没改**:同一块面、同一种形态,变的只有 `floatOrder`。
   * 所以判据不是差值,而是「谁点的名」—— 今天 `focusFloat` 唯一的非指针调用方
   * 就是键盘那条 toggle 路(`summonItem` 的 `reveal / float-front` 那一支,
   * 按 ⌘ 键把压在下面的那扇窗提到最上面)。指针置顶不点名,所以走不到这儿
   * (点击本身落焦)。
   */
  if (openedByKeyboard) {
    const now = after.placements[openedByKeyboard]
    const was = before.placements[openedByKeyboard]
    if (now?.kind === 'float' && was?.kind === 'float') {
      return { scope: 'float-layer', owner: openedByKeyboard }
    }
    /*
     * **架子从细梁展开**(S1 召唤三态那一档补的缺口,设计 §14 第二行)。
     *
     * 与上面那条浮窗置顶同型:这张表上**什么都没改**(还钉在同一条边、还是同一个
     * 活动 tab),变的只有 `shelves[side].collapsed`。所以判据同样不是差值而是
     * 「谁点的名」—— 指针点那颗收展钮不点名,于是走不到这儿(点击自己落焦,
     * 而且「我顺手展开看一眼」不该把键盘从输入框里拽走)。
     *
     * 下面那条通用的「切 tab」只看 `activeId` 变没变,收着的架子展开时它一个字
     * 都答不出 —— 「细梁 → 展开」正是它漏掉的那一格。
     */
    if (now?.kind === 'edge') {
      const nextShelf = after.shelves[now.side]
      const prevShelf = before.shelves[now.side]
      if (
        nextShelf.activeId === openedByKeyboard
        && prevShelf?.collapsed === true
        && nextShelf.collapsed === false
      ) {
        return { scope: 'shelf-layer', owner: openedByKeyboard }
      }
    }
  }
  // 架子切 tab(§11 拍点 2)。四条边各看一格 —— 只有活动 tab 那一层是可交互的。
  for (const side of SIDES) {
    const nextId = after.shelves[side]?.activeId
    if (!nextId || nextId === before.shelves[side]?.activeId) continue
    return { scope: 'shelf-layer', owner: nextId }
  }
  return null
}

/**
 * **落定之后盯着那块面的那扇窄口**(09-04,起因见下)。单位毫秒。
 *
 * 一次落定只送一遍焦点,在**这块面刚挂上来就又被重挂一次**时不够 —— 送进去的那
 * 一格作用域当场卸载,树的结构归还(§4.5)把焦点送回按键之前的输入框,而点名已经
 * 被消费掉了,新挂上来的那一份没有人再叫它。真机读数(09-04,dev 壳 + React
 * StrictMode 的模拟重挂):12 块面里 10 块开出来之后焦点又回到 `composer-input`,
 * 只有自己声明 `activateOnMount` 的检索面与总览幸免。
 *
 * 所以这扇窄口的语义是:**这一下落定的焦点,在它真的落进去之前不算送完**。
 * 窄到 250ms 是为了不与人打架 —— 键盘召唤之后的四分之一秒里,除了「那一层重挂」
 * 没有别的东西会让一个 scope+owner 相符的实例重新登记(人手挪焦点不登记实例)。
 */
export const FOCUS_FOLLOW_SETTLE_MS = 250

/** 一次落定的目标 + 一个序号 —— 序号让「同一个目标连来两次」也能重跑那只 effect。 */
interface PendingFollow {
  target: FocusFollowTarget
  seq: number
}

/**
 * 形态落定 → 焦点跟过去。**全壳唯一那一处接线**,挂在 `AppShell` 上一次。
 *
 * ── 为什么是一只 hook,而不是包在 store 的 `set` 上 ─────────────────────────
 * 第一版就是包 `set`:一句话拦住所有动作,读起来最省。真机当场证伪 —— 落定那一刻
 * **那一层还不在**:store 的 set 是同步的,而装着这块面的宿主层要等 React 下一次
 * 提交才挂上来(架子切 tab 更刁:两层都挂着,但旧层的 `inert` 也要等那次提交才翻)。
 * 于是 `activateScope` 在一个「还没到位 / 还是 inert」的树上问,一律答 false,
 * 焦点一步都没跟。读数是 gate 场景 9 的三条全红。
 *
 * 所以判据留在纯函数里(上面那只),**执行挪到提交之后**:订阅拿前后两份状态
 * 算出目标 → 进一格 state → effect 在提交后落焦。接线仍然只有这一处,
 * 加一个新的形态动作不必记得接一遍(那才是「六路各接一遍」要治的病)。
 *
 * ── 落定之后还要**盯一小会儿**(09-04)─────────────────────────────────────
 * 「送一次就完」在那块面刚挂上来又被重挂一次时不成立(判词与读数写在
 * `FOCUS_FOLLOW_SETTLE_MS` 头上)。所以这只 effect 送完不撒手:窄口内树一变就
 * 回头看一眼焦点在不在它里面,不在就补一次。
 */
export function useStageFocusFollow(): void {
  const [pending, setPending] = useState<PendingFollow | null>(null)

  useEffect(
    () =>
      useStageStore.subscribe((after, before) => {
        const target = focusFollowTarget(before, after, takeOpenRequest())
        if (target) setPending((prev) => ({ target, seq: (prev?.seq ?? 0) + 1 }))
      }),
    [],
  )

  useEffect(() => {
    if (!pending) return
    const { scope, owner } = pending.target
    /*
     * 送不进去(那一层正 inert / 那一档根本没有层)不追到天涯海角:窄口一过就
     * 放手。真要「等它到位再送」的那一种(文件树 ↵ 开文件)由那块面自己立旗等 ——
     * 那是**它**的手势,不是形态机的事。
     */
    focusTree.activateScope(scope, { owner, reason: 'placement' })

    /*
     * 窄口内补送:树一变(实例注销 / 新实例登记 / 根到位 / 焦点被结构归还搬走)
     * 就回头看一眼焦点在不在它里面,不在就再送一次;**送进去了就收手**
     * (`settled`)—— 此后这四分之一秒里谁把焦点挪走都不再抢回来。
     *
     * 两条闸,各治一种死循环:
     *  · `inside` 治**重入** —— 送成功那一下 `activateScope` 自己会 `notify()`,
     *    不拦这一句就是「送 → 通知 → 再送」;
     *  · `settled` 治**次数** —— 送不进去时 `activateScope` 在挑不到实例那一步就
     *    返回 false,**它自己不 notify**,所以失败不会自己喂自己;真正把重试喂饱的
     *    只有别人发的通知,而那是有限的几下(09-04 读数:重挂那一轮先来三下
     *    「注销 / setRoot(null)」再来一下「重新登记」——所以这里**不能**按次数封顶,
     *    第一版封 3 次当场被那三下吃光,补送永远轮不到真正该送的那一下)。
     */
    let settled = false
    let inside = false
    const stop = focusTree.subscribe(() => {
      if (inside || settled) return
      if (focusTree.isOwnerActive(owner)) {
        settled = true
        return
      }
      inside = true
      try {
        if (focusTree.activateScope(scope, { owner, reason: 'placement' })) settled = true
      } finally {
        inside = false
      }
    })
    const timer = window.setTimeout(stop, FOCUS_FOLLOW_SETTLE_MS)
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [pending])
}
