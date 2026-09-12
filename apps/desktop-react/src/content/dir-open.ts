import { findItem } from '../stage/items'
import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import { CENTER_REGION, edgeRegion, floatRegion } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { regionOfRefIn, useWorkbenchStore } from '../workbench/store'
import { dirRef } from './kinds/dir-ref'
import type { PlacementMemory } from '../stage/types'
import type { ContentRef } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'

/**
 * **「打开一份目录面板」这个动作**,与「files 那块瓦」分了家(2026-09-12)。
 *
 * ── 这只文件不许出现 `register*`(它存在的全部理由)────────────────────────
 * 它从 `files-launcher.tsx` 里抽出来,因为那只文件在**模块作用域**里跑
 * `registerStageLauncher(FILES_ITEM_ID, …)` —— 一句「files 瓦是启动瓦」的登记。
 * 只要有人 import 它,那句登记就发生。
 *
 * 真事故(09-12 review 打回):用户消息气泡里的 `@目录` chip 要调 `openDirectoryPanel`,
 * 于是 `ChatStream` → `user-message` → `files-launcher` 这条边长了出来,而
 * `ChatStream` 在**每一个渲染聊天的测试**的 import 闭包里 ——
 * `stage/__tests__/summon-entries.test.ts` 当场 5 红(`expected undefined to be 'float'`):
 * 那张表原本没有 files 这一行,测试量的是「没有启动瓦时按老三条路走」。
 * 病根不是测试脆,是**一个动作被关在一句登记后面**。
 *
 * 所以这只文件的纪律只有一条:**零模块级副作用** —— 没有 `register*`、没有订阅、
 * 没有定时器、没有跨渲染留存的可变状态。它因此也不需要 HMR dispose
 * (「这东西的寿命是不是这个模块实例」答否)。
 * `files-launcher.tsx` 原样 re-export 这里的两口,它的老调用方一行不用改。
 */

/** 「目录」那块启动瓦的 id(它就是从前那块「文件」瓦 —— id 不改,名字改了)。 */
export const FILES_ITEM_ID = 'files'

/**
 * 这块瓦此刻该把内容开到哪个区域。**记忆 > 天生**。
 *
 * `stage` / `full` 两档都落中央区:全屏不是一个住处(判词在 `stage/types.ts`),
 * 而一块目录面板铺满整扇窗不是任何人要的东西。
 */
function regionForLauncher(ref: ContentRef): RegionId {
  const stage = useStageStore.getState()
  const memory: PlacementMemory | undefined = stage.memory[FILES_ITEM_ID]
  const wanted = memory ?? findItem(FILES_ITEM_ID)?.defaultPlacement
  if (wanted?.kind === 'edge') return edgeRegion(wanted.side)
  if (wanted?.kind === 'float') {
    // 这份内容已经有一扇自己的窗就交回那一扇(同一档连点两次不该开出两扇装着
    // 同一个目录的窗)—— 与 `content/viewer/open-target.regionForMode` 同一句。
    const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
    if (already?.startsWith('float:')) return already
    const winId = nextFloatId()
    // 身量归形态机补(默认档 + 视口钳制两件事的产地都在那儿)。
    useStageStore.getState().ensureFloatRect(winId)
    return floatRegion(winId)
  }
  return CENTER_REGION
}

/**
 * **打开一份目录面板**(启动瓦、右键最近项、「打开目录…」、消息气泡里的目录 chip
 * 四处共用的唯一一只)。
 *
 * 三件事,次序即语义:记一笔最近目录 → 算落点 → 摆过去。摆那一句走
 * `stage.placeRef`(它同时改树与形态机,而且经 `orchestrate` 那格缓冲 ——
 * 判词写在 `stage/store.placeRef` 上)。
 */
export function openDirectoryPanel(path: string): void {
  if (!path) return
  const ref = dirRef(path)
  useWorkbenchStore.getState().rememberRoot(path)
  useStageStore.getState().placeRef(ref, regionForLauncher(ref))
}
