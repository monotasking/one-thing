import { STAGE_PER_SPACE, syncStageResidency, useStageStore } from '../stage/store'
import { SPLIT_PER_SPACE, useSplitPrefs } from '../data/split-prefs'
import { OPEN_MODE_PER_SPACE, useFileOpenMode } from '../data/file-open-mode'
import { SESSION_OPEN_MODE_PER_SPACE, useSessionOpenMode } from '../data/session-open-mode'
import { EXPOSE_PER_SPACE, useExposeStore } from '../expose/store'
import { WORKBENCH_PER_SPACE, useWorkbenchStore } from '../workbench/store'
import { swapFilesForSpace } from '../data/files-source'
import { bindPerSpace } from './per-space'
import { subscribeCurrentSpace } from './current'

/**
 * 「**家具跟着工作区走**」的唯一开工点(T-W1)。
 *
 * ── 为什么是一个 start,而不是四个模块级副作用 ────────────────────────────
 * 第一版把 `bindPerSpace(...)` 直接写在四个 store 文件的模块作用域里,真机上
 * **当场炸**:`Cannot access '__vite_ssr_import_0__' before initialization`。
 * 病根不是订阅本身,是这台壳里早就存在的一条 import 环 ——
 *
 *     stage/store → stage/items → stage/types → i18n/index → stage/store
 *
 * 环本身一直无害(谁都没在模块作用域里**执行**跨模块的东西);而
 * `bindPerSpace(useStageStore, …)` 恰恰是在模块作用域里去够另一个模块的导出,
 * 于是从 i18n 那一侧进来时,`workspace/current` 还停在 TDZ 里。
 *
 * 修法不是给环松绑(那要动 i18n 与 stage 两棵树,与本批无关),而是**把执行
 * 挪出模块作用域**:模块只导出规格(纯数据),接线由这里在 `main.tsx` 里显式做
 * 一次 —— 与 `startReadingAxes()` / `startWorkspaceApply()` 逐字同一个体例。
 *
 * 顺带收了两件:四条 dispose 变成一条(HMR 立法要求的那口拆卸只此一处),
 * 以及「哪些面跟着空间走」终于**在一个文件里数得清**,而不是散在四个 store 末尾。
 *
 * ── 七个消费者,两种接法 ─────────────────────────────────────────────────
 * 前六个是干净的「换一份家具」,直接吃原语 `bindPerSpace`。
 * 文件树是最后一个,它多一件事:除了换展开态还要把根与各级缓存清掉(那些路径
 * 属于上一个空间),所以它自己出一口 `swapFilesForSpace`,在这里一并订上。
 */

/** 已经接上了没有。幂等靠它 —— 这是「这一个进程接过一次没有」,不是可渲染状态。 */
let stops: Array<() => void> = []

/**
 * 接上七个面。**幂等**:重复调用先把上一次退役掉,不会攒出两条订阅。
 * 返回退役函数(HMR dispose 与测试各用它一次)。
 */
export function startPerSpaceLayout(): () => void {
  stopPerSpaceLayout()
  stops = [
    bindPerSpace(useStageStore, STAGE_PER_SPACE),
    bindPerSpace(useSplitPrefs, SPLIT_PER_SPACE),
    bindPerSpace(useFileOpenMode, OPEN_MODE_PER_SPACE),
    /*
     * 「点会话列表一行是什么意思」(C2)。它与上一条是同一族的两件事:一件说文件、
     * 一件说会话,同一条判据(`per-space.ts` 那句「是不是用户在这个空间里摆好的
     * 东西」)、同一只原语。判词整段在 `data/session-open-mode.ts` 的文件头上。
     */
    bindPerSpace(useSessionOpenMode, SESSION_OPEN_MODE_PER_SPACE),
    bindPerSpace(useExposeStore, EXPOSE_PER_SPACE),
    /*
     * **换空间时全屏那一格清零**(W2)。它是瞬态,不在 `pick` 里,所以换装那一句
     * 不会碰它 —— 而不清零的下场是:在 A 空间把一个文件铺满,切到 B,全屏层还在,
     * 里面装的却是一格 B 空间根本没有的内容(那棵树刚被整个换掉了)。
     *
     * 它单独一条订阅而不是塞进 `bindPerSpace`:那只原语管的是**家具的换装**
     * (收进账、摊开新的),而这一句说的是「此刻在看什么」——两件事,两条判据。
     *
     * **它排在拼贴树换装之前**(S1,dock-scope §2.5「全屏」:「app 级格全屏着
     * 换空间 → 先 `exitFull` 再携带,它落回原叶」)。次序在今天的终态上无差
     * (全屏不动树,所以携带找得到那一格),差的是**中间那一帧**:排在后面的话,
     * 屏幕上会有一拍是「新空间的树 + 旧空间那一格全屏」——`FullLayer` 那一拍
     * 投影的可能是一格已经不在任何树上的内容。先退再换,那一帧不存在。
     */
    subscribeCurrentSpace(() => useWorkbenchStore.getState().exitFull()),
    /*
     * 拼贴树(W1,T0 拍点 3「树按 Workspace 记」)。它是最后一条 `bindPerSpace` —— 与前几条同型:
     * 一棵树、一张隐藏表,都是「用户在这个空间里摆好的东西」。
     * 瞬态那几格(焦点叶 / 分栏路径 / 全屏)不进 `pick`,与 stage 摘掉舞台那条
     * placement 同一条判据。
     *
     * S1 起它多一件事:`WORKBENCH_PER_SPACE.carry` 把 app 级的格从离场的活树里
     * 捡出来放进进场的树(判词整段在那儿)。**接线一个字没加** —— 携带是规格里
     * 的一格,不是这里的一条新订阅。
     */
    bindPerSpace(useWorkbenchStore, WORKBENCH_PER_SPACE),
    subscribeCurrentSpace(swapFilesForSpace),
    /*
     * **换完两份家具之后把投影重算一遍**(W4)。`placements` /
     * `shelves[side].tabs` 是树的投影(产地 `stage/residency.ts`),而换空间
     * 那一拍两台 store 各换各的:stage 先摊开新空间的**几何**(那一份里没有
     * tabs —— v9 起它不落盘),workbench 随后摊开新空间的**树**。
     *
     * 那条订阅本来就会响(它订的是 workbench),这一句是**次序的保险**:
     * 它排在最后,所以无论上面两条怎么重排,投影都在两份家具都换完之后再跑
     * 一次。重复跑是恒等变换(`sameProjection` 一样就不 set)。
     */
    subscribeCurrentSpace(syncStageResidency),
  ]
  return stopPerSpaceLayout
}

/** 全部退役。幂等 —— 调两次不会抛,也不会漏掉哪一条。 */
export function stopPerSpaceLayout(): void {
  for (const stop of stops) stop()
  stops = []
}
