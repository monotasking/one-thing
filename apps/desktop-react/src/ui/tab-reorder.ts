import s from './Tabs.module.css'

/**
 * **一条标签条在一次拖拽里的编舞**(W3-b 裁定 4/5)。
 *
 * ── 它为什么住在 `ui/` 而不是 `workbench/` ───────────────────────────────
 * 「抬起一格 tab、邻居让位、把它折起来、在别的条上腾一个空位」这四件事全部是
 * **tab 条自己的形**:它们要的是 `.tab` 的圆角、`--tab-joined-h` 的高、`.ph` 的
 * 底色 —— 也就是 `Tabs.module.css` 里那一段。放到业务面去写等于「基础件先行」
 * 那条法的第 N 次犯:占位块会长成和 tab 对不齐的一条,而对不齐要等真机才看得见。
 * 所以它与 `Tabs` 同一个文件家族,读同一份样式表;`workbench` 只是**消费者**。
 *
 * 它不是 React:整段是**直接写 DOM**。判据与 `ui/Splitter` 的 liveVar、
 * `TopBarTabs` 的 `hint()` 逐字同一条 —— **不改语义的东西不必经过 React**。
 * 一次换序里指针每一帧都在动,让它经过 setState 就是「拖一格 tab 重渲一整棵树
 * 上百遍」;而这里改的只是几格 `transform` 与两格属性,语义(树)一个字都没变,
 * 落定那一刻才有一次真的 `moveTab`。
 *
 * ── 为什么可以往 React 管着的容器里插一个 DOM 节点(那格 `.ph`)────────────
 * 因为**拖拽期间树是冻住的**(`workbench/store.dragging` 那道闸,判词写在
 * `WorkbenchState.dragging` 上):这条条里有哪几格、次序是什么,在整场拖拽里
 * 是常数,React 不会在这期间对这些子节点做任何插入 / 删除 / 移位。空位又在
 * 松手 / 取消那一刻**由造它的人自己摘掉**,所以 React 的下一次协调看到的子节点
 * 集合与它自己记得的逐字相同。这不是「React 允许」,是**这一段时间里没有第二个
 * 写者**;闸一旦没了,这条就不再成立 —— 所以两者写在一起。
 *
 * ── 三张状态表 ①:生命周期 ───────────────────────────────────────────────
 *   造      一次拖拽起手,消费方拿到这条条的 tablist 元素
 *   抬起    `lift(tabId, grabX)`:那一格挂 `data-lift`,记下它此刻的矩形与抓点
 *   跟随    `track(x)` 每帧一次:抬起那格写 `transform`,邻居写各自的让位量,
 *           **答此刻的落点下标**
 *   撕下    `tear(id)`:抬起清掉,那一格挂 `data-torn` 折成 0 宽(元素不卸载)
 *   腾位    `gapAt(index, width)`:在**别的**一条条上插一格 `.ph`
 *   收       `reset()`:属性、transform、空位一并清干净。**幂等**,每条结束路径
 *           (落定 / Esc / pointercancel / 窗口失焦)都先走它
 *
 * ── ②:UI 生命状态 ───────────────────────────────────────────────────────
 *   闲      什么都没写过(刚造出来 / reset 之后)
 *   抬起中  条内换序:一格浮着、邻居让位
 *   折起    已经撕出去:原位是一道 0 宽的缝
 *   有空位  别的条上撑开了一格
 *
 * ── ③:UI 交互状态 ───────────────────────────────────────────────────────
 * 空位 `pointer-events: none`、折起那一格也是 —— 它们都不该接指针(落点判定问的
 * 是「指针底下是什么」,而这两样都是这次拖拽自己造出来的东西)。
 */

/** 一格 tab 此刻在条里的位置(视口坐标)。 */
interface TabBox {
  el: HTMLElement
  left: number
  width: number
}

export interface TabStripChoreo {
  /** 这条条此刻的矩形(视口坐标)。`DragSession` 的「带」读的就是它。 */
  rect(): DOMRect | null
  /** 抬起某一格。`grabX` = 按下那一刻指针的横坐标(抓在这格的哪儿)。幂等。 */
  lift(tabId: string, grabX: number): void
  /**
   * 跟随一帧,答**落点下标**(松手插到第几格)。没抬起过就答 null。
   *
   * ── 坐标系:与 `workbench/drop.ts` 的 `stripIndexAt` **同一个** ──────────
   * 答的是「插到第 at 格**之前**」,而且对着**没摘掉任何东西**的那张原始表算。
   * 这不是随便挑的:同叶换序与跨条落进来最终走的是同一只
   * `workbench/drop-commit.reorderTab` / `store.moveRefIntoLeaf`,而它们收的都是
   * 这个坐标系;编舞里另用一套「最终排第几位」的说法,差的那一格只在「往右挪」
   * 那一半里出现 —— 真机门当场量到过:两格 tab 里把第一格拖到末尾,答 1 恰好命中
   * 「原地不动」那道闸,序一格不变(屏幕上让位让得好好的,松手什么都没发生 ——
   * 也就是用户报的那句「换序做不到」的第二种长相)。
   *
   * 让位的算法与它是同一句话算出来的,不是两处:落点由抬起那格的**中线**越过了
   * 几个邻居的中线决定,而每个邻居的让位量就是「它在落点之后就挪一格宽,否则
   * 不挪」。两处分开算 = 屏幕上的空档与松手的结果对不上。
   */
  track(x: number): number | null
  /**
   * 撕下:抬起清掉,**那一格折成 0 宽**。幂等。
   *
   * 收一格 `tabId` 而不是「上一次抬起的那个」:一次手势**不一定抬起过** ——
   * 把 tab 往下猛地一甩,过阈值那一帧指针已经在条外了,`lift` 从没发生过
   * (真机门当场量到:「拖出条之后源那一格折成了 0 宽」红,读数是三格全 false)。
   * 折起来这件事只跟「这一场拖的是谁」有关,与它有没有先被抬起来无关。
   */
  tear(tabId: string): void
  /**
   * 在这条条的第 `index` 格之前腾一个空位(`width` = 空位多宽)。
   *
   * **收下标而不是收坐标**:「插到第几格」这件事的产地只有一处 ——
   * `workbench/drop.ts` 的 `stripIndexAt`,它是落点判据的一部分。在这里再按中线
   * 算一遍就是第二份判据,而屏幕上的空位与松手的结果一旦对不上,用户看到的正是
   * 「高亮说的和松手做的不是一件事」。
   */
  gapAt(index: number, width: number): void
  /** 收掉空位(只收空位,不动抬起 / 折起)。幂等。 */
  clearGap(): void
  /** 全部清干净。幂等 —— 每条结束路径都先走它。 */
  reset(): void
}

/** 这条条里此刻画着的那几格(不含空位与折起的那一格)。 */
function tabsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
}

function boxesOf(tabs: readonly HTMLElement[]): TabBox[] {
  return tabs.map((el) => {
    const r = el.getBoundingClientRect()
    return { el, left: r.left, width: r.width }
  })
}

/**
 * 把一条 tablist 变成可编舞的。**每次拖拽造一只**,它不留在别处 ——
 * 一次手势一条会话(裁定 5),编舞是那条会话的一部分,不是这条条的一格属性。
 */
export function tabStripChoreo(list: HTMLElement): TabStripChoreo {
  /** 抬起那一格,以及起手时量下来的那一份几何(条内的格在拖拽期间不增不减)。 */
  let lifted: { el: HTMLElement; index: number; boxes: TabBox[]; grabDx: number } | null = null
  let torn: HTMLElement | null = null
  let ph: HTMLElement | null = null

  const clearShifts = (): void => {
    for (const el of tabsOf(list)) {
      el.style.transform = ''
      delete el.dataset.shift
    }
  }

  const choreo: TabStripChoreo = {
    rect: () => (list.isConnected ? list.getBoundingClientRect() : null),

    lift(tabId, grabX) {
      if (lifted) return
      const tabs = tabsOf(list)
      const index = tabs.findIndex((el) => el.dataset.tabId === tabId)
      if (index < 0) return
      const boxes = boxesOf(tabs)
      const el = tabs[index]
      /*
       * 抓点记的是**偏移量**而不是坐标:整条条会横滚、会因为窗口变化而挪,
       * 而「手指按在这一格的哪儿」是这次手势里唯一不变的那个数。
       */
      lifted = { el, index, boxes, grabDx: grabX - boxes[index].left }
      el.dataset.lift = ''
    },

    track(x) {
      if (!lifted) return null
      const { el, index, boxes, grabDx } = lifted
      const self = boxes[index]
      const left = x - grabDx
      el.style.transform = `translateX(${left - self.left}px)`
      /*
       * 落点 = 抬起那格的中线越过了几个**别人**的中线。用起手时量的那份几何算,
       * 不用邻居此刻(已经让过位)的矩形 —— 后者会让判据自己晃:让一次位 → 中线
       * 变了 → 落点变了 → 让位反向,一帧一次来回,屏幕上是抖动。
       */
      const mid = left + self.width / 2
      let next = 0
      boxes.forEach((box, i) => {
        if (i === index) return
        if (mid > box.left + box.width / 2) next += 1
      })
      /*
       * 让位:把每个邻居在「摘掉抬起那格之后」的下标 `j` 算出来,`j >= next` 的
       * 往抬起那格原本的方向挪一格宽。抬起那格左边的往右挪、右边的往左挪 ——
       * 两句合成一句:`i < index` 的挪 +w 当且仅当它排到了落点之后,`i > index`
       * 的挪 -w 当且仅当它没排到落点之后。
       */
      const w = self.width
      boxes.forEach((box, i) => {
        if (i === index) return
        const j = i < index ? i : i - 1
        const shift = i < index ? (j >= next ? w : 0) : (j >= next ? 0 : -w)
        if (shift === 0) {
          box.el.style.transform = ''
          delete box.el.dataset.shift
          return
        }
        box.el.dataset.shift = ''
        box.el.style.transform = `translateX(${shift}px)`
      })
      /*
       * `next` 是**最终排第几位**(让位那一段要的就是它);交出去的是**插到第几格
       * 之前**(见 `track` 的坐标系判词)。往左挪时两者相同,往右挪时差一格 ——
       * 因为「插到第 k 格之前」这句话是对着还没摘掉自己的那张表说的。
       */
      return next <= index ? next : next + 1
    },

    tear(tabId) {
      if (lifted) {
        lifted.el.style.transform = ''
        delete lifted.el.dataset.lift
        clearShifts()
        lifted = null
      }
      torn ??= tabsOf(list).find((el) => el.dataset.tabId === tabId) ?? null
      if (torn) torn.dataset.torn = ''
    },

    gapAt(index, width) {
      if (!ph) {
        ph = document.createElement('div')
        ph.className = s.ph
        /*
         * 它不是内容也不是控件:辅助树里不该有它(读屏软件念不出「一个空位」),
         * 命中测试里也不该有它(落点问的是指针底下的**真东西**)。
         */
        ph.setAttribute('aria-hidden', 'true')
        ph.dataset.tabPlaceholder = ''
      }
      ph.style.width = `${Math.max(0, Math.round(width))}px`
      const tabs = tabsOf(list)
      const before = tabs[index] ?? null
      // 已经在正确的位子上就不动它 —— 每帧重插会把 CSS 过渡从头再放一遍。
      if (ph.parentElement !== list || ph.nextElementSibling !== before) {
        list.insertBefore(ph, before)
      }
    },

    clearGap() {
      ph?.remove()
      ph = null
    },

    reset() {
      if (lifted) {
        lifted.el.style.transform = ''
        delete lifted.el.dataset.lift
        lifted = null
      }
      if (torn) {
        delete torn.dataset.torn
        torn = null
      }
      clearShifts()
      choreo.clearGap()
    },
  }
  return choreo
}
