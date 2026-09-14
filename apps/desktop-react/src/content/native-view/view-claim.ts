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
 *  · 实例卸载 → `releaseViewClaim`:**不当场撤**。换宿主那一拍新实例在同一次提交
 *    里接手,账本原样交接,连快照都不丢(新占位格上第一帧就是旧图,不是一块底色);
 *  · **一帧之内没人接手** = 这片地真的没了(不是换宿主)。那就替上一任把话收回
 *    (`retract` → `unocclude`),然后把账销掉 —— 主进程那边停表、视图回到壳说的
 *    显隐,而不是一片藏着的视图配一只永远在跑的 1Hz 重拍。
 *
 * 「一帧」这条线与 `focus/registry` 的 `unregister` 同一个形:摘掉与真的走了是两件事,
 * 中间留一拍让重挂认领。rAF 而不是微任务,理由是 React 在同一次提交里先跑卸载
 * 清理再跑新挂载的 effect —— 那两步之间**不隔微任务**,隔的是零;而 StrictMode
 * 的模拟卸载→再挂载也在同一个任务里。一帧两边都盖得住。
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

interface ClaimEntry extends NativeViewClaim {
  /** 此刻拿着这份账的实例数(换宿主那一拍会短暂为 0)。 */
  holders: number
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
 * 收图时直接写它,下一任接的就是最新的。
 */
export function adoptViewClaim(viewId: string): NativeViewClaim {
  let entry = entries.get(viewId)
  if (!entry) {
    entry = { occluded: false, snapshot: null, holders: 0, settle: 0 }
    entries.set(viewId, entry)
  }
  if (entry.settle) {
    cancelAnimationFrame(entry.settle)
    entry.settle = 0
  }
  entry.holders += 1
  return entry
}

/**
 * 交出这份账。一帧之内没人接手 → 遮着的话替上一任收回(`retract`),然后销账。
 * 幂等:同一份账多交一次不会把别人的持有数减成负数。
 */
export function releaseViewClaim(viewId: string, retract: () => void): void {
  const entry = entries.get(viewId)
  if (!entry || entry.holders === 0) return
  entry.holders -= 1
  if (entry.holders > 0 || entry.settle) return
  entry.settle = requestAnimationFrame(() => {
    entry.settle = 0
    if (entry.holders > 0 || entries.get(viewId) !== entry) return
    entries.delete(viewId)
    if (entry.occluded) retract()
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
