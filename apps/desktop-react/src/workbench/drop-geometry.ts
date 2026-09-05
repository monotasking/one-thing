import type { DropGeometry, LeafBox, Rect, StripBox, TabBox } from './drop'
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
 * ── 取件口:既有的 data 属性,一个新的都不加 ────────────────────────────
 *   `[data-pane-region]`  一棵树的容器(中央区 / 每条架子 / 每扇浮窗各一格,
 *                         三处产地都是 W1/W4 就有的)
 *   `[data-pane-slot]`    一片叶的格子(`PaneTree` 画的)
 *   `[data-pane-chrome]`  一片叶的檐(`LeafStrip` 画的,值 = 叶 id;W1 就有)
 *   `[data-tab-id]`       檐里那几格各自的 id(W3-b 给 `ui/Tabs` 加的取件口)
 *   `[data-tab-slots]`    那一格里装了几份(W6-b;只在 > 1 时写)
 *   `[aria-selected]`     哪一格是活动的(`ui/Tabs` 本来就有的 ARIA 语义)
 *   `[data-nodrop]`       **这块地方一律不收**(W6-b:红绿灯 / 顶栏尾格 / Dock
 *                         各自在自己身上写一格 —— 判据因此不认识这三样东西)
 * 于是「有哪些区域」这件事仍旧只有一个产地,拖拽不必再开一份名册。
 *
 * ── 条**不在**叶的子树里,所以它单独量一遍(W3-b)────────────────────────
 * 中央区那几组标签住在**窗口顶栏**(设计 §2.2 的 D 稿),DOM 上根本不在
 * `[data-pane-slot]` 底下;架子与浮窗那两处才在。所以条这一头从
 * **整份文档**扫 `[data-pane-chrome]`,不从叶里往下找 —— 后者会漏掉最常用的
 * 那一组(中央顶栏),而漏掉的表现是「拖到顶栏没反应」。
 *
 * ── DOM 序 = 层序 ───────────────────────────────────────────────────────
 * `querySelectorAll` 交回的是**文档序**,而浮窗层(`FloatLayer`)排在主区之后
 * —— 于是「靠后 = 盖在上面」这句话由 DOM 自己保证,判据那一头从后往前找就对了。
 * 这不是巧合:壳里那几层的先后本来就是按层序摆的(`AppShell` 里逐格写着理由)。
 */
export function measureDropGeometry(): DropGeometry {
  const leaves: LeafBox[] = []
  const strips: StripBox[] = []
  const nodrop: Rect[] = []
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
    for (const chrome of Array.from(document.querySelectorAll('[data-pane-chrome]'))) {
      const leafId = chrome.getAttribute('data-pane-chrome')
      if (!leafId) continue
      /*
       * 量的是 **tablist 那一格**,不是整条檐:檐右端还挂着型工具条与动作组,
       * 把它们算进条里等于「拖到某颗钮上 = 插一格 tab」。
       */
      const list = chrome.querySelector('[role="tablist"]')
      if (!list) continue
      const rect = rectOf(list)
      if (rect.width <= 0 || rect.height <= 0) continue
      const cells = Array.from(list.querySelectorAll('[data-tab-id]'))
      strips.push({
        /*
         * 条的**区域**从它往上最近的那格 `[data-pane-region]` 读。中央区那几组
         * 标签住在窗口顶栏,而顶栏在 DOM 上不在任何一棵树里 —— 所以查不到时
         * 拿同名那片叶的区域兜底(条与叶按 leafId 一一对应,这是四个宿主共有的
         * 唯一一条身份线)。
         */
        region: (chrome.closest('[data-pane-region]')?.getAttribute('data-pane-region')
          ?? leaves.find((leaf) => leaf.leafId === leafId)?.region
          ?? '') as RegionId,
        leafId,
        rect,
        tabs: cells.map(tabBoxOf),
        activeAt: cells.findIndex((el) => el.getAttribute('aria-selected') === 'true'),
      })
    }
    for (const el of Array.from(document.querySelectorAll('[data-nodrop]'))) {
      const rect = rectOf(el)
      if (rect.width <= 0 || rect.height <= 0) continue
      nodrop.push(rect)
    }
  }
  return { window: windowRect(), leaves, strips, nodrop }
}

/**
 * 一格标签的矩形 + 它的 id + 它装了几份。
 *
 * `slots` 缺席 = 1(`ui/Tabs` 只在 > 1 时写那格属性,所以一格标签的 DOM 与
 * W6-b 之前逐字相同)。判据要的是个**数**,不是种类名 —— 判词在 `drop.TabBox`。
 */
function tabBoxOf(el: Element): TabBox {
  return {
    ...rectOf(el),
    id: el.getAttribute('data-tab-id') ?? '',
    slots: Number.parseInt(el.getAttribute('data-tab-slots') ?? '1', 10) || 1,
  }
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
