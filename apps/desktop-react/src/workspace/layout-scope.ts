import { STAGE_PER_SPACE, useStageStore } from '../stage/store'
import { SPLIT_PER_SPACE, useSplitPrefs } from '../data/split-prefs'
import { OPEN_MODE_PER_SPACE, useFileOpenMode } from '../data/file-open-mode'
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
 * ── 六个消费者,两种接法 ─────────────────────────────────────────────────
 * 前五个是干净的「换一份家具」,直接吃原语 `bindPerSpace`。
 * 文件树是最后一个,它多一件事:除了换展开态还要把根与各级缓存清掉(那些路径
 * 属于上一个空间),所以它自己出一口 `swapFilesForSpace`,在这里一并订上。
 */

/** 已经接上了没有。幂等靠它 —— 这是「这一个进程接过一次没有」,不是可渲染状态。 */
let stops: Array<() => void> = []

/**
 * 接上六个面。**幂等**:重复调用先把上一次退役掉,不会攒出两条订阅。
 * 返回退役函数(HMR dispose 与测试各用它一次)。
 */
export function startPerSpaceLayout(): () => void {
  stopPerSpaceLayout()
  stops = [
    bindPerSpace(useStageStore, STAGE_PER_SPACE),
    bindPerSpace(useSplitPrefs, SPLIT_PER_SPACE),
    bindPerSpace(useFileOpenMode, OPEN_MODE_PER_SPACE),
    bindPerSpace(useExposeStore, EXPOSE_PER_SPACE),
    /*
     * 拼贴树(W1,T0 拍点 3「树按 Workspace 记」)。它是第六条 —— 与前四条同型:
     * 一棵树、一张隐藏表,都是「用户在这个空间里摆好的东西」。
     * 瞬态那三格(焦点叶 / 分栏路径 / 舞台)不进 `pick`,与 stage 摘掉舞台那条
     * placement 同一条判据。
     */
    bindPerSpace(useWorkbenchStore, WORKBENCH_PER_SPACE),
    subscribeCurrentSpace(swapFilesForSpace),
  ]
  return stopPerSpaceLayout
}

/** 全部退役。幂等 —— 调两次不会抛,也不会漏掉哪一条。 */
export function stopPerSpaceLayout(): void {
  for (const stop of stops) stop()
  stops = []
}
