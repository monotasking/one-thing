import { isItemVisible, occluderOf, placementOf } from './transitions'
import type { FocusScopeId } from '../focus/types'
import type { Placement, ShelfSide, StageState } from './types'

/**
 * **召唤三态**(S1,设计 `docs/design/react-shell-focus-2026-09.md` §14;
 * 09-03 用户提出并拍定第四格 = (a) 回去)。
 *
 * 键盘的 `toggle:<面>` 命令从「开 / 关」改成业界的**召唤**语义(VS Code ⌘⇧E 那一族):
 * 同一个键按下去,先把这块面弄到眼前,再把键盘交给它,已经在它里面了就把键盘还回去。
 * **关面是 Esc 的活,不是聚焦键的** —— 这条是本批与旧 `toggleItem` 唯一的语义分歧。
 *
 * ── 状态表(判据顺序就是下面这四行的顺序,不许换)──────────────────────────
 *
 * | 面此刻的状态 | 动作 | 交给谁 |
 * | --- | --- | --- |
 * | **未打开**(在 Dock 里) | `open` | `openFromMemory(记忆)` + `requestFocusOnOpen` —— R2 已有的键盘开面路,零新增 |
 * | **打开了但看不见**:架子上非当前 tab / 架子收成细梁 / 浮窗被压在下面 | `reveal` | 露出来,**位置不变**;跟焦由 `focus-follow` 既有判据接 |
 * | **打开了但被盖 / 舞台压着** | `blocked` | **什么都不做**(下面单列一段说明) |
 * | **看得见、焦点不在它里面** | `focus` | `focusTree.activateScope(层, { owner })`,形态零变化 |
 * | **看得见、焦点在它里面** | `return` | `focusTree.returnFrom(层, { owner })` —— 用该层节点的 `returnTo` 一格(§4.5),面留在原位 |
 *
 * ── 被盖住那一形为什么是 `blocked` 而不是第二格或第三格 ───────────────────────
 * 设计 §14 把「被盖层盖住」列在「打开了但看不见」那一行里,同时写死了这一形的
 * 裁定:**不越过盖层**(盖是「看一眼就走」的整屏内容,舞台是 scrim + 画布,
 * 两者都是「此刻请只看我」的语义)。于是这一形两条路都走不通:
 *  · 走 `reveal` 就得**把盖 / 舞台收掉**才能露出下面那块面 —— 那是「关掉别人」,
 *    正是 §14 明令不做的;
 *  · 走 `focus` 就是把键盘送进一块**用户此刻看不见**的面里 —— 焦点环画在盖底下,
 *    敲键盘不知道字去了哪儿,比按了没反应坏得多(I1 治的是孤儿焦点,这一形是
 *    「有主但看不见」,同样坏)。
 * 所以它是**第五种动作**:一个诚实的空动作,带着「谁压着」这格读数。想用那块面
 * 的人先按 Esc 退掉最上面那一层(退层链本来就是干这个的),再召唤。
 * 这一格是**我的读法**,不是用户的原话 —— §14 只写了「不动盖层」,没写那时该干什么。
 *
 * ── 判据顺序为什么不许换 ────────────────────────────────────────────────────
 * 「在 Dock 里」与「看不见」在数据上会同时成立(`isItemVisible` 对 dock 也答 false),
 * 「看不见」与「焦点不在它里面」同理(看不见的架子后台层是 `inert`,焦点不可能在
 * 里面)。所以这四行是**有序的判据链**,不是四个互斥的谓词;换了顺序,收在架子
 * 后台的那块面会被当成「未打开」重开一遍。
 */

/** 形态 → 装着它的那一层作用域。收回 Dock 没有层可言。**全壳唯一一张**。 */
export const LAYER_SCOPE_OF: Record<Placement['kind'], FocusScopeId | null> = {
  dock: null,
  stage: 'stage-layer',
  float: 'float-layer',
  edge: 'shelf-layer',
  cover: 'cover-layer',
}

/**
 * **「这一次打开是键盘点的名」**(§3.5 规则 2)。
 *
 * 一次性的:被 `focus-follow` 的判据读掉就作废。它存在的理由是**手势在 store
 * 那一层看不出来** —— 指针点瓦与按 ⌘ 数字写进 `placements` 的是同一格事实,而
 * 两者的答案不一样。让键盘那条路自己点名,比让形态机去猜「这一下是谁按的」诚实。
 *
 * 为什么点名而不是当场 `activate`:落定那一刻宿主层还没挂上来(理由写在
 * `focus-follow` 那只 hook 的文件头)。键盘那条路第一版就是当场叫,单测当场证伪。
 *
 * ── 它为什么住在**这只**文件里(09-04 S1)────────────────────────────────
 * 从前它在 `focus-follow.ts`,而点名的人是 store(`summonItem`)—— 于是
 * `store → focus-follow → store` 成了一个环。这一格是**键盘那条路**的东西,
 * 而键盘那条路整件就是召唤;搬进来之后 store 与 focus-follow 都只朝这里读,
 * 环解掉,一句逻辑都没动。
 */
let openRequest: string | null = null

export function requestFocusOnOpen(itemId: string): void {
  openRequest = itemId
}

/** 读一次就作废。只有 `focus-follow` 那只 hook 该问它。 */
export function takeOpenRequest(): string | null {
  const at = openRequest
  openRequest = null
  return at
}

/** 露出一块面的三条路。每一条对应一个既有的形态动作,召唤自己不新写落点。 */
export type SummonRevealHow =
  /** 架子展开着,但当前露脸的是别的 tab —— 点名它。 */
  | 'shelf-tab'
  /** 整条架子收成了细梁 —— 展开(顺带点名,`activateShelfTab` 对已活动的是恒等)。 */
  | 'shelf-expand'
  /** 浮窗被压在别的窗下面 —— 翻到最上面。 */
  | 'float-front'

/**
 * 召唤这一下该做什么。**可辨识联合**:每一格自带它那条路要的参数,
 * 落点(store)据此分流,不必再问一遍状态。
 */
export type SummonAction =
  | { kind: 'open' }
  | { kind: 'reveal'; how: SummonRevealHow; side: ShelfSide | null }
  | { kind: 'focus'; scope: FocusScopeId }
  | { kind: 'return'; scope: FocusScopeId }
  | { kind: 'blocked'; by: 'stage' | 'cover' }

/** 召唤时树那一头的读数。只要一句话:**焦点此刻在谁的层里**(没有就是 null)。 */
export interface SummonFocus {
  /**
   * 活动路径上那一格 `owner`(宿主层报的住户 = `stage/items` 的 item id)。
   * 调用方由 `focusTree.isOwnerActive(id)` 算出来 —— 纯函数不认识那棵树。
   */
  focusedOwner: string | null
}

/**
 * 召唤一块面时该做什么。**纯函数**,所以四态逐条钉得住(见文件头那张表)。
 */
export function summonTransition(
  state: StageState,
  itemId: string,
  focus: SummonFocus,
): SummonAction {
  const placement = placementOf(state, itemId)

  // ① 未打开 —— 在 Dock 里就按它的记忆开出来。
  if (placement.kind === 'dock') return { kind: 'open' }

  // ② 打开了但看不见。先问「是不是被压着」——压着就到此为止(不越过盖层)。
  if (!isItemVisible(state, itemId)) {
    const by = occluderOf(state, itemId)
    if (by) return { kind: 'blocked', by }
    if (placement.kind === 'float') {
      return { kind: 'reveal', how: 'float-front', side: null }
    }
    if (placement.kind === 'edge') {
      const shelf = state.shelves[placement.side]
      /*
       * 收着的架子先展开(顺带点名):细梁上一个 tab 的内容都不画,所以「换 tab」
       * 在那一档里根本不成立。展开着但露的是别人 —— 那才是纯粹的换 tab。
       */
      const how: SummonRevealHow = shelf.collapsed ? 'shelf-expand' : 'shelf-tab'
      return { kind: 'reveal', how, side: placement.side }
    }
    /*
     * `stage` / `cover` 看不见只可能是被压着,而那一支上面已经答完了。
     * 走到这里说明 `isItemVisible` 与 `occluderOf` 对不上口径 —— 那是自相矛盾,
     * 不是一种状态,所以这里当「没人压着但也露不出来」处理:什么都不做。
     */
    return { kind: 'blocked', by: 'stage' }
  }

  const scope = LAYER_SCOPE_OF[placement.kind]
  // 非 dock 的四种形态都有层,所以这一句恒不触发;留着是为了不把 null 咽下去。
  if (!scope) return { kind: 'blocked', by: 'stage' }

  // ③ / ④ 看得见:焦点在它里面就还回去,不在就送进去。
  return focus.focusedOwner === itemId ? { kind: 'return', scope } : { kind: 'focus', scope }
}


/*
 * 模块级可变状态 = 这个模块实例的寿命,所以配一段 HMR 退役(CLAUDE.md 那条法)。
 * 热更时把没人读走的那格点名丢掉:留着它会让热更后第一次形态变化白送一次焦点。
 * 幂等;生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    openRequest = null
  })
}
