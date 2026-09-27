/**
 * **一片原生视图的「遮挡」与「快照」—— 寿命是那片视图,不是那一次挂载**
 * (2026-09-15,用户报障「浏览器拖拽后不能自适应」「搜索时会闪烁」的根治)。
 *
 * ── 病 ────────────────────────────────────────────────────────────────────
 * `NativeViewSlot` 从前把「我对主进程说过 `occlude` 还没说 `unocclude`」记在
 * effect 闭包的一格 `let lastOccluded` 里,出厂 `false`。而**换宿主是一次重挂**:
 * 把浏览器 tab 拖到架子上 / 拖进别的叶 / 右键「移到架子」,内容层随着叶走,
 * `NativeViewSlot` 卸载再挂载。真机记录(隔离实例,CDP 注入拖拽):
 *
 *   起拖 → 旧实例发 `occlude`(拼贴树 `dragging`,遮挡三判据第③支)→ 主进程
 *   `occluded: true`、视图藏起、按 1Hz 重拍快照;
 *   松手 → `setDragging(false)` 与落定同一拍 → 旧实例卸载(只发一帧「看不见」,
 *   **没人发 `unocclude`**)→ 新实例出厂 `lastOccluded = false`,量到「没被遮」,
 *   与出厂值相同 → **一个字都不发**;
 *   → 主进程那边 `occluded` 永远是 true:视图矩形照着新宿主更新(`applyFrame`
 *   照收)但 `getVisible()` 恒 false;1Hz 重拍照跑,新占位格先空一秒、随后每秒
 *   换一张截图。人看见的就是「拖过去之后页面不跟着新尺寸走」与「打字 / 搜索时
 *   一秒一跳地闪」—— 两句报障,一个根。
 *
 * ── 治 ────────────────────────────────────────────────────────────────────
 * 判据只有一句:**「主进程此刻被告知的遮挡状态」与「最后一张快照」是那片视图的
 * 事实,不是某一次挂载的事实**(与 `data/browser-find.ts` 把查找状态按 tabId 放在
 * 模块里逐字同一条判词)。所以它们住在这张按 `viewId` 的表里:
 *
 *  · 实例挂载 → `adoptViewClaim`:接过上一任留下的账(遮着 / 那张图),从**那个**
 *    起点量,于是新宿主第一次量到「没被遮」就会补上那一句 `unocclude`;
 *  · 实例卸载 → `releaseViewClaim`:**不当场撤,也不当场藏**。换宿主那一拍新实例在
 *    同一次提交里接手,账本原样交接,连快照都不丢(新占位格上第一帧就是旧图,不是
 *    一块底色);
 *  · **一帧之内没人接手** = 这片地真的没了(不是换宿主)。那就替上一任把话收回
 *    (`onGone` → 一帧「看不见」,遮着的话再补一句 `unocclude`),然后把账销掉 ——
 *    主进程那边停表、视图回到壳说的显隐,而不是一片藏着的视图配一只永远在跑的
 *    1Hz 重拍。
 *
 * ── 「看不见」那一帧为什么也走这一帧的规则(2026-09-26)──────────────────────
 * 用户报障「浮窗里搜完,把它拖进主面板,页面变白;切走再切回才恢复」。从前占位格
 * 卸载**当场**发一帧 `{0×0, visible:false}`,新占位格再发一帧「新矩形、可见」——
 * 于是主进程在同一拍里收到的是:一片(拖拽期间因遮挡)**已经藏着**的视图先被缩成
 * 0×0、再改回新尺寸、最后由 `unocclude` 显出来。普通切 tab 从不让藏着的视图经过
 * 0×0(藏与缩在同一帧里、显与放在同一帧里),而切 tab 恰好是能恢复的那一下。所以
 * 换宿主时那一帧「看不见」**根本不该发**:视图在原地换一个矩形就是全部,不掉一帧
 * (这才是叶头上「换宿主视图不重载」那句话的兑现)。真的走了才藏 —— 与 `unocclude`
 * 的收回同一条线、同一只回调。代价是一片真的被摘掉的地多显一帧(≈16ms)。
 *
 * 「一帧」这条线与 `focus/registry` 的 `unregister` 同一个形:摘掉与真的走了是两件事,
 * 中间留一拍让重挂认领。rAF 而不是微任务,理由是 React 在同一次提交里先跑卸载
 * 清理再跑新挂载的 effect —— 那两步之间**不隔微任务**,隔的是零;而 StrictMode
 * 的模拟卸载→再挂载也在同一个任务里。一帧两边都盖得住。
 *
 * ── 只有**最后接手的那一任**能开口(2026-09-26,录屏坐实)───────────────────────
 * 用户录屏:把浮窗里的浏览器拖进主面板标签条,原生视图**留在浮窗的旧矩形上**,切走
 * 再切回才铺满。真因在 `components/FloatWindow.tsx` 的 `shownTree`:关掉的浮窗要
 * **用上一棵树再画 120ms 出场动画**,于是旧占位格在那 120ms 里还活着;而 `floatOrder`
 * 已经没有这扇窗,它量到的 z 从 1 变 0,帧「变了」,rAF 里把旧浮窗矩形又发了一遍 ——
 * 盖掉新宿主刚在挂载 effect 里发出去的中央区矩形。从前它卸载时再补一帧「看不见」,
 * 那就是最初报障的「变白」;藏帧改走一帧交接之后,留下的就是录屏里的「旧矩形」。
 *
 * 所以持有者不是一个计数,是**一叠**:后接手的在上面,只有最上面那一任对主进程说话
 * (`isCurrentViewHolder`);下面的一任量到什么都不发、账也不写。它若又回到最上面
 * (上面那一任先走了),占位格那一侧把「上一次发过什么」清零、重发一帧 —— 主进程
 * 手上的是别人说的最后一句,不是它的。
 *
 * ── 这只文件里没有 bridge ────────────────────────────────────────────────
 * 收回那一句要经通道发,而通道是占位格的事;这里只收一口 `retract` 回调。于是这
 * 张表是纯的:vitest 里不必装通道就量得到「接手 / 没人接手」两条路。
 */

export interface NativeViewClaim {
  /** 这一侧最后一次对主进程说的话:`true` = 发过 `occlude`、还没发 `unocclude`。 */
  occluded: boolean
  /** 主进程推来的最后一张快照(被遮期间才有);`null` = 手上没图。 */
  snapshot: string | null
}

/** 一任持有者的身份。占位格每挂一次造一个,只用来认「是不是最上面那一任」。 */
export type ViewHolder = symbol

interface ClaimEntry extends NativeViewClaim {
  /** 此刻拿着这份账的那几任,**后接手的在末尾**(换宿主那一拍会短暂为空)。 */
  holders: ViewHolder[]
  /** 「没人接手就收回」那一帧的排期;0 = 没排。 */
  settle: number
}

const entries = new Map<string, ClaimEntry>()

/** 读一眼(不接手)。没有 = 出厂:没被遮、没图。 */
export function viewClaimOf(viewId: string): Readonly<NativeViewClaim> | undefined {
  return entries.get(viewId)
}

/**
 * 接手这片视图的账。答的是**那个对象本身**(不是快照):实例在 `measure` /
 * 收图时直接写它,下一任接的就是最新的。接手的这一任从此站在最上面。
 */
export function adoptViewClaim(viewId: string, holder: ViewHolder): NativeViewClaim {
  let entry = entries.get(viewId)
  if (!entry) {
    entry = { occluded: false, snapshot: null, holders: [], settle: 0 }
    entries.set(viewId, entry)
  }
  if (entry.settle) {
    cancelAnimationFrame(entry.settle)
    entry.settle = 0
  }
  entry.holders = [...entry.holders.filter((h) => h !== holder), holder]
  return entry
}

/** 这一任是不是此刻最上面的那一任 —— 只有它能对主进程说话。 */
export function isCurrentViewHolder(viewId: string, holder: ViewHolder): boolean {
  const entry = entries.get(viewId)
  return entry !== undefined && entry.holders[entry.holders.length - 1] === holder
}

/**
 * 交出这份账。一帧之内没人接手 → 这片地真的没了:`onGone(claim)` 跑一次(占位格
 * 在里面发那帧「看不见」,遮着的话再补一句 `unocclude`),然后销账。
 * 幂等:同一任多交一次不会把别人挤出去。
 */
export function releaseViewClaim(
  viewId: string,
  holder: ViewHolder,
  onGone: (claim: Readonly<NativeViewClaim>) => void,
): void {
  const entry = entries.get(viewId)
  if (!entry || !entry.holders.includes(holder)) return
  entry.holders = entry.holders.filter((h) => h !== holder)
  if (entry.holders.length > 0 || entry.settle) return
  entry.settle = requestAnimationFrame(() => {
    entry.settle = 0
    if (entry.holders.length > 0 || entries.get(viewId) !== entry) return
    entries.delete(viewId)
    onGone(entry)
  })
}

/**
 * 记下主进程推来的那张图(`null` = 撤了)。**没人持有就不记**:一条在这片地已经
 * 没了之后才到的 `snapshot` 推送不该把一份销了的账又立起来。
 */
export function recordViewSnapshot(viewId: string, snapshot: string | null): void {
  const entry = entries.get(viewId)
  if (entry) entry.snapshot = snapshot
}

/** 回到出厂。测试与 HMR 用;幂等。排着的收回一并取消(那一任已经不存在了)。 */
export function resetViewClaims(): void {
  for (const entry of entries.values()) if (entry.settle) cancelAnimationFrame(entry.settle)
  entries.clear()
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法)。复用已有的那一口拆卸,
 * 不写第二套。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetViewClaims)
}
