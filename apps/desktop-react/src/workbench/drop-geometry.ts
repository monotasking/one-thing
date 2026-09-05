import type { DropGeometry, LeafBox, Rect } from './drop'
import type { RegionId } from './regions'

/**
 * **屏幕上此刻有哪几块矩形**(W3)—— `workbench/drop.ts` 那只纯函数的输入。
 *
 * 判据与量法分成两只文件,理由是它们的可测性完全不同:判据要能脱开浏览器
 * 表驱动地测(五区 / 边带 / 撕出 / 拒绝各一行),量法要的是真 DOM。混在一起
 * 会让「25% 那条线上归谁」这种问题只能靠真机门回答。
 *
 * ── 起拖时量一次(裁定 4)────────────────────────────────────────────────
 * 拖拽期间树不变(`store.dragging` 那道闸),所以这些矩形是常数。逐帧量一次
 * 拖拽就是上百次强制排版,而它们答的是同一个数。`resize` 时重量 —— 那是唯一
 * 会在拖拽中改变几何的事(窗口被系统缩放 / 外接屏拔掉)。
 *
 * ── 取件口:两格既有的 data 属性,一个新的都不加 ────────────────────────
 *   `[data-pane-region]`  一棵树的容器(中央区 / 每条架子 / 每扇浮窗各一格,
 *                         三处产地都是 W1/W4 就有的)
 *   `[data-pane-slot]`    一片叶的格子(`PaneTree` 画的)
 * 于是「有哪些区域」这件事仍旧只有一个产地,拖拽不必再开一份名册。
 *
 * ── DOM 序 = 层序 ───────────────────────────────────────────────────────
 * `querySelectorAll` 交回的是**文档序**,而浮窗层(`FloatLayer`)排在主区之后
 * —— 于是「靠后 = 盖在上面」这句话由 DOM 自己保证,判据那一头从后往前找就对了。
 * 这不是巧合:壳里那几层的先后本来就是按层序摆的(`AppShell` 里逐格写着理由)。
 */
export function measureDropGeometry(): DropGeometry {
  const leaves: LeafBox[] = []
  if (typeof document !== 'undefined') {
    for (const host of Array.from(document.querySelectorAll('[data-pane-region]'))) {
      const region = host.getAttribute('data-pane-region')
      if (!region) continue
      for (const slot of Array.from(host.querySelectorAll('[data-pane-slot]'))) {
        const leafId = slot.getAttribute('data-pane-slot')
        if (!leafId) continue
        const rect = rectOf(slot)
        // 零身量 = 这一格此刻不在屏幕上(架子收起、浮窗还没铺好)。落不进去。
        if (rect.width <= 0 || rect.height <= 0) continue
        leaves.push({ region: region as RegionId, leafId, rect })
      }
    }
  }
  return { window: windowRect(), leaves }
}

function rectOf(el: Element): Rect {
  const box = el.getBoundingClientRect()
  return { left: box.left, top: box.top, width: box.width, height: box.height }
}

/**
 * 窗口矩形。**从 0 起、按 `innerWidth/innerHeight`** —— 边带判的是「离这扇窗的
 * 边多近」,而形态机全套(`snapSideAt` / `clampFloatRect` / Dock 唤醒带)读的
 * 都是同一个视口口径。换一种量法(比如壳根元素的矩形)会让吸边与撕出在
 * 全屏 / 让位这些形下悄悄错开几个像素。
 */
function windowRect(): Rect {
  if (typeof window === 'undefined') return { left: 0, top: 0, width: 0, height: 0 }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}
