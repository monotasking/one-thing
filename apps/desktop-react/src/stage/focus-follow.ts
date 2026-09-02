import { useEffect, useState } from 'react'
import { focusTree } from '../focus/registry'
import { useStageStore } from './store'
import type { FocusScopeId } from '../focus/types'
import type { Placement, ShelfSide, StageState } from './types'

/**
 * **「挪到哪,焦点跟到哪」的唯一接线处**(09-03 R2,设计 §3.5 规则 3 与 §11 拍点 2)。
 *
 * ── 为什么是一处,不是六处 ──────────────────────────────────────────────────
 * 「形态落定」在 store 上有六七个动作各能促成一次(`openAs` / `clickDockIcon` /
 * `toggleItem` / `stageToFloat` / `stageToEdge` / `floatToEdge` / `edgeToFloat`),
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

/** 形态 → 装着它的那一层作用域。收回 Dock 没有层可言。 */
const LAYER_OF: Record<Placement['kind'], FocusScopeId | null> = {
  dock: null,
  stage: 'stage-layer',
  float: 'float-layer',
  edge: 'shelf-layer',
  cover: 'cover-layer',
}

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
 * **「这一次打开是键盘点的名」**(§3.5 规则 2)。
 *
 * 一次性的:被下面那只纯函数读掉就作废。它存在的理由是**手势在 store 那一层
 * 看不出来** —— 指针点瓦与按 ⌘ 数字写进 `placements` 的是同一格事实,而两者的
 * 答案不一样。让键盘那条路自己点名,比让形态机去猜「这一下是谁按的」诚实。
 *
 * 为什么点名而不是当场 `activate`:落定那一刻宿主层还没挂上来(见下面那只 hook
 * 的文件头)。键盘那条路第一版就是当场叫,单测当场证伪 —— 焦点留在原处。
 */
let openRequest: string | null = null

export function requestFocusOnOpen(itemId: string): void {
  openRequest = itemId
}

/** 读一次就作废。给下面那只 hook 用 —— 别处不该问它。 */
function takeOpenRequest(): string | null {
  const at = openRequest
  openRequest = null
  return at
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
    const scope = LAYER_OF[next.kind]
    if (scope) return { scope, owner: id }
  }
  /*
   * **程序置顶一扇已经开着的浮窗**(设计 §5 最后一行:「`FloatWindow.focusFloat`
   * 的 z 序纯函数不动,宿主在程序置顶时补 `activate`;指针置顶不加动作」)。
   *
   * 它在这张表上**什么都没改**:同一块面、同一种形态,变的只有 `floatOrder`。
   * 所以判据不是差值,而是「谁点的名」—— 今天 `focusFloat` 唯一的非指针调用方
   * 就是键盘那条 toggle 路(`togglePlacement` 对一扇开着的浮窗走 focusFloat 那一支,
   * 按 ⌘ 键把它提到最上面)。指针置顶不点名,所以走不到这儿(点击本身落焦)。
   */
  if (openedByKeyboard) {
    const now = after.placements[openedByKeyboard]
    const was = before.placements[openedByKeyboard]
    if (now?.kind === 'float' && was?.kind === 'float') {
      return { scope: 'float-layer', owner: openedByKeyboard }
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
 */
export function useStageFocusFollow(): void {
  const [pending, setPending] = useState<FocusFollowTarget | null>(null)

  useEffect(
    () =>
      useStageStore.subscribe((after, before) => {
        const target = focusFollowTarget(before, after, takeOpenRequest())
        if (target) setPending(target)
      }),
    [],
  )

  useEffect(() => {
    if (!pending) return
    /*
     * 送不进去(那一层正 inert / 那一档根本没有层)就算了,不重试:留一个跨帧的
     * 悬念比少送一次更难排查。真要「等它到位再送」的那一种(文件树 ↵ 开文件)
     * 由那块面自己立旗等 —— 那是**它**的手势,不是形态机的事。
     */
    focusTree.activateScope(pending.scope, { owner: pending.owner, reason: 'placement' })
    setPending(null)
  }, [pending])
}
