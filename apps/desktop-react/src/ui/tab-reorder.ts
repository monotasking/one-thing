import { FLASH_MS, SETTLE_MS } from '../components/motion'
import { clampLead, reorderFrame } from './reorder-math'
import s from './Tabs.module.css'

/**
 * **一条标签条在一次拖拽里的编舞**(W3-b 裁定 4/5;W6-b 按设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §4 重做)。
 *
 * ── 它为什么住在 `ui/` 而不是 `workbench/` ───────────────────────────────
 * 「抬起一格 tab、邻居让位、把它折起来、在别的条上腾一个空位、松手滑进新槽」
 * 这五件事全部是 **tab 条自己的形**:它们要的是 `.tab` 的圆角、`--tab-joined-h`
 * 的高、`.ph` 的底色 —— 也就是 `Tabs.module.css` 里那一段。放到业务面去写等于
 * 「基础件先行」那条法的第 N 次犯:占位块会长成和 tab 对不齐的一条,而对不齐要
 * 等真机才看得见。所以它与 `Tabs` 同一个文件家族,读同一份样式表;
 * `workbench` 只是**消费者**。
 *
 * 它不是 React:整段是**直接写 DOM**。判据与 `ui/Splitter` 的 liveVar、
 * `TopBarTabs` 的 `hint()` 逐字同一条 —— **不改语义的东西不必经过 React**。
 * 一次换序里指针每一帧都在动,让它经过 setState 就是「拖一格 tab 重渲一整棵树
 * 上百遍」;而这里改的只是几格 `transform` 与几格属性,语义(树)一个字都没变,
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
 * ── 三条硬规矩(设计 v3 §4.5)在这只文件里的落点 ─────────────────────────
 * ① **1:1 跟手**:`track()` 每帧直接写 `transform`,不节流、不缓动;抬起那格的
 *    过渡在 CSS 里被关掉(`[data-lift]`),`will-change: transform` 提前声明。
 * ② **只有该动的在动**:邻居用 `--dur-neighbor` 过渡让位;条上挂 `data-reorder`,
 *    CSS 把整条的 hover 底关掉 —— 换序全程标签条、内容区、其它标签一律不变色。
 *    (这一句不是靠「指针恰好压在被拖那格上」侥幸成立的:抬起那格横扫时指针
 *    一格一格经过邻居的上方,而 pointer capture 不冻结 `:hover` 的命中测试。)
 * ③ **同一个节点在挪**:空位只有一个,落点变了只是 `insertBefore` 到别处。
 *    任何按帧拆掉重建的东西都会被看成闪烁。(从前这句还有后半句「描圈的目标换人
 *    只是把属性从一格挪到另一格」—— 那格描圈随 U2 与「放到标签上」那条带一起
 *    退役了,见 `lifted()` 上的判词。)
 *
 * ── 三张状态表 ①:生命周期 ───────────────────────────────────────────────
 *   造      一次拖拽起手,消费方拿到这条条的 tablist 元素
 *   抬起    `lift(tabId, grabX)`:那一格挂 `data-lift`,**量下这一刻所有格的基准
 *           矩形**(整场只量这一次 —— 见 `track()` 的判词),条上挂 `data-reorder`
 *   换序    `track(x)` 每帧一次:抬起那格写 `transform`(**夹在条的两端之内**),
 *           邻居按「被拖的那条边越过谁的中心」写各自的让位量,答此刻的落点下标
 *   撕下    `tear(id)`:抬起清掉,那一格挂 `data-torn` 折成 0 宽(元素不卸载)
 *   腾位    `gapAt(index, width)`:在**任何**一条条上插一格 `.ph`
 *   收笔    `settle(tabId, fromLeft)`:树已经改完,让那一格从抬起时的位置
 *           FLIP 滑进新槽(`--dur-settle`),到位闪一圈
 *   收       `reset()`:属性、transform、空位一并清干净。**幂等**,每条结束路径
 *           (落定 / Esc / pointercancel / 窗口失焦)都先走它
 *
 * ── ②:UI 生命状态 ───────────────────────────────────────────────────────
 *   闲      什么都没写过(刚造出来 / reset 之后)
 *   抬起中  条内换序:一格浮着、邻居让位、条不变色
 *   折起    已经撕出去:原位是一道 0 宽的缝
 *   有空位  某条条上撑开了一格
 *   收笔中  `data-settle`:一格正在滑向新槽(150ms),随后闪一圈(`data-land`)
 *
 * ── ③:UI 交互状态 ───────────────────────────────────────────────────────
 * 空位 `pointer-events: none`、折起那一格也是 —— 它们都不该接指针(落点判定问的
 * 是「指针底下是什么」,而这两样都是这次拖拽自己造出来的东西)。抬起那一格接不接
 * 指针无所谓:它盖在最上面,而落点判据读的是**起拖时量好的几何**,不问 DOM。
 */

/**
 * **落定闪一圈**(设计 v3 §5:「落定卡片飞入空位 + **新标签闪圈**」)。
 *
 * 换序那一趟的闪圈由编舞自己收笔时放(`settle()` 末尾);这一只是给**别处落进来**
 * 的那一格用的 —— 那一下没有编舞(树刚改完,来源那条会话已经拆干净了),而
 * 「它落到了哪儿」这句话仍旧要说出口。
 *
 * 它满屏找那一格,不问哪条条:落定之后那一格在哪条条上,只有树知道。
 * 排一帧再写,理由与 `settle()` 逐字相同 —— React 的提交排在这一拍之前。
 *
 * ── 为什么是**扫一遍属性**而不是一句选择器 ──────────────────────────────
 * tabId 就是 refId(`kind:key`,key 里还带路径分隔符),塞进属性选择器必须先
 * `CSS.escape`。而 `CSS` 这个全局**不是到处都有** —— jsdom 里它压根不存在,于是
 * 这一句在单测里是一颗延时雷:它排在 rAF 里,文件跑得够久那一帧就到,当场
 * `Cannot read properties of undefined (reading 'escape')`(整个 `src/ui` +
 * `src/workbench` + `src/components` 一趟 13 声,退出码 1,而每一条用例都是绿的
 * —— 最难查的那种红)。`[data-tab-id]` 全屏也就十来个,扫一遍比一句选择器更便宜,
 * 也不必再养一份转义。同一条判词也是 `tabById()` 不用选择器的理由。
 */
export function flashLandedTab(tabId: string): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return
  requestAnimationFrame(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]')).find(
      (node) => node.dataset.tabId === tabId,
    )
    if (!el) return
    el.dataset.land = ''
    const id = setTimeout(() => {
      landTimers.delete(id)
      delete el.dataset.land
    }, FLASH_MS)
    landTimers.add(id)
  })
}

/**
 * 上面那一只留下的计时器。**模块级,所以配 HMR 退役**(CLAUDE.md 那条法):
 * 它的寿命是这个模块实例,热更之后旧的那批还挂着就会在新模块的节点上摘属性。
 */
const landTimers = new Set<ReturnType<typeof setTimeout>>()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const id of landTimers) clearTimeout(id)
    landTimers.clear()
  })
}

/** 一格 tab 此刻在条里的位置(视口坐标)+ 它的 id。 */
interface TabBox {
  el: HTMLElement
  id: string
  left: number
  width: number
}

/**
 * 抬起那一格,以及起手时量下来的那一份几何。**整场只量一次** —— 判词在 `track()`。
 */
interface LiftedState {
  el: HTMLElement
  index: number
  boxes: TabBox[]
  /** 手指按在这一格的哪儿(偏移量,不是坐标 —— 判词在 `lift()`)。 */
  grabDx: number
  /** 条自己的两端(抬起那一刻量的)。夹紧读它,**不是**每帧问 DOM —— 见 `track`。 */
  bounds: { left: number; right: number }
}

export interface TabStripChoreo {
  /** 这条条此刻的矩形(视口坐标)。`DragSession` 的「带」读的就是它。 */
  rect(): DOMRect | null
  /** 抬起某一格。`grabX` = 按下那一刻指针的横坐标(抓在这格的哪儿)。幂等。 */
  lift(tabId: string, grabX: number): void
  /**
   * **换序**那一形的一帧:抬起那格跟手、邻居让位,答**落点下标**。没抬起过答 null。
   *
   * ── 夹在条的两端之内(设计 v3 §4.2)──────────────────────────────────────
   * `left` 钳在 `[条左缘, 条右缘 - 这一格的宽]`。不钳的话把标签往条外一甩,那一格
   * 会飞出条去而槽位早就到头了 —— 屏幕上是「它跑了但什么都没发生」。
   *
   * ── 判据与让位整段住在 `ui/reorder-math.reorderFrame` ─────────────────────
   * 「被拖标签朝运动方向的那条边越过邻居中心」(§4.2,Chrome 的规则)、它的三条
   * 前科、以及「让位与落点是同一句话算出来的」那条纪律,09-18 起是**那一只纯函数**
   * 的判词 —— 因为竖列表的换序(`ui/list-reorder`)要的是逐字同一句话,而抄一份
   * 的代价是两份各自漂。这只文件从此只管**这条条自己的形**:抬起、跟手、把那格
   * 让位量写成 `transform`、空位、撕下、收笔。
   *
   * ── 坐标系:与 `workbench/drop.ts` 的 `stripIndexAt` **同一个** ──────────
   * 答的是「插到第 at 格**之前**」,而且对着**没摘掉任何东西**的那张原始表算。
   * 这不是随便挑的:同叶换序与跨条落进来最终走的是同一只
   * `workbench/drop-commit.reorderTab` / `store.moveRefIntoLeaf`,而它们收的都是
   * 这个坐标系;上面那个「最终排第几位」与它差的那一格只在「往右挪」那一半里
   * 出现 —— 真机门当场量到过:两格 tab 里把第一格拖到末尾,答 1 恰好命中
   * 「原地不动」那道闸,序一格不变(屏幕上让位让得好好的,松手什么都没发生 ——
   * 也就是用户报的那句「换序做不到」的第二种长相)。
   */
  track(x: number): number | null
  /**
   * **此刻抬起的是哪一格**,没抬起过答 null。
   *
   * 它是这条编舞**自己那格状态**的读口,加它是为了取消那条路(U2):Esc /
   * pointercancel / 窗口失焦要分两种收法 —— 还在带里(抬起着)是 150ms 滑回原位,
   * 已经撕下(折着)是原位展回。消费方自己存一格「我此刻在不在带里」就是**第二条
   * 会话**(那正是 `DragBandState` 文件头点名的那条病),而这句话的答案本来就在
   * 这只编舞手上:抬起 / 撕下都只有它写得动。
   *
   * ── `hover()` / `markPair()` 随 U2 退役(2026-09-08)──────────────────────
   * 那两只是「放到标签上」那条带(条底缘下 6–24px)的一帧与它的描圈。真机量出来
   * 的是:**描圈被抬起的那一格盖住 92%** —— 抬起那格 `z-index: 2`、底不透明,
   * 而这一形里它照旧跟手,于是它正压在指针底下那一格上。用户裁定整条带删掉,
   * 二合一只剩内容区左右带那**一种**手势。判词全文在
   * `ui/drag/constants.ts` 的 `ONTO_FROM_PX` 退役段;`[data-pair-hot]` 与
   * `--drop-ring-line` 同批退役。
   */
  lifted(): string | null
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
  /** 那格空位此刻的矩形(卡片飞进去的落点)。没有空位就答 null。 */
  gapRect(): DOMRect | null
  /** 收掉空位(只收空位,不动抬起 / 折起)。幂等。 */
  clearGap(): void
  /**
   * **收笔**:树已经改完,让 `tabId` 那一格从 `fromLeft`(它在手上时的左缘)
   * FLIP 滑进新槽,到位闪一圈。
   *
   * 它排在 `reset()` **之后**叫:reset 摘掉抬起与 transform,React 随后把那一格
   * 挪到新位置 —— 这只函数要量的正是「新位置」。所以它自己等一帧
   * (`requestAnimationFrame`):React 对一次 discrete 事件的提交排在当前任务与
   * 微任务里,而 rAF 回调排在那之后、**在这一帧绘制之前** —— 于是屏幕上不会先
   * 看见它跳到新位置再滑回来。
   */
  settle(tabId: string, fromLeft: number): void
  /** 全部清干净。幂等 —— 每条结束路径都先走它。 */
  reset(): void
}

/** 这条条里此刻画着的那几格(不含空位)。 */
function tabsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
}

function boxesOf(tabs: readonly HTMLElement[]): TabBox[] {
  return tabs.map((el) => {
    const r = el.getBoundingClientRect()
    return { el, id: el.dataset.tabId ?? '', left: r.left, width: r.width }
  })
}

function tabById(list: HTMLElement, tabId: string): HTMLElement | null {
  return tabsOf(list).find((el) => el.dataset.tabId === tabId) ?? null
}

/**
 * 把一条 tablist 变成可编舞的。**每次拖拽造一只**,它不留在别处 ——
 * 一次手势一条会话(裁定 5),编舞是那条会话的一部分,不是这条条的一格属性。
 */
export function tabStripChoreo(list: HTMLElement): TabStripChoreo {
  /** 抬起那一格,以及起手时量下来的那一份几何(条内的格在拖拽期间不增不减)。 */
  let lifted: LiftedState | null = null
  let torn: HTMLElement | null = null
  let ph: HTMLElement | null = null
  let phAt: number | null = null
  /** 收笔那两拍的计时器(滑入跑完摘属性、闪圈跑完摘属性)。`reset()` 收。 */
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const after = (ms: number, run: () => void): void => {
    const id = setTimeout(() => {
      timers.delete(id)
      run()
    }, ms)
    timers.add(id)
  }

  const clearShifts = (): void => {
    for (const el of tabsOf(list)) {
      el.style.transform = ''
      delete el.dataset.shift
    }
  }

  /**
   * **抬起那一格的横向跟手**,答夹紧之后的左缘。U2 之前它由两形共用(换序
   * `track` 与「放到标签上」`hover`);那条带退役之后只剩 `track` 一个调用方,
   * 但它仍旧抽在这里 —— 夹紧那句话该只有一处,而「拖到头那一格的落位差几个像素」
   * 在屏幕上就是抖。
   *
   * ── 1:1 跟手(§4.5 第 1 条)────────────────────────────────────────────
   * 每帧直接写 `transform`,不节流、不缓动;那一格的过渡在 CSS 里被关掉。
   *
   * ── 夹在条的两端之内,两端读**抬起那一刻量的**那一份(§4.2)──────────────
   * 不钳的话把标签往条外一甩,那一格会飞出条去而槽位早就到头了 —— 屏幕上是
   * 「它跑了但什么都没发生」。而两端**不每帧问 DOM**,这一格是真机量出来的:
   * 第一版在这里每帧 `list.getBoundingClientRect()`,那一句紧跟在「刚给几格写完
   * transform」之后,于是**每一发 pointermove 各逼一次排版** —— `gate:perf` 场景
   * ⑤c 的 A/B 当场读出来:一趟 20 次换序,p95 316 → **508ms**、强制排版 4 → **5**。
   * 改读基准之后那一句从热路径上整个消失。
   *
   * 换序期间条本身不重排(格数不变、transform 不影响它自己的盒子);它**会**横滚,
   * 但那一形下 `DragSession` 的「带」判据每帧问的还是活矩形,所以「出没出条」照旧
   * 准 —— 这里夹的只是那一格的落位,差几个像素不改变任何语义。
   */
  const follow = (held: LiftedState, x: number): number => {
    const self = held.boxes[held.index]
    // 夹紧那一句住在 `ui/reorder-math.clampLead`(竖列表用的是同一句)。
    const left = clampLead(x - held.grabDx, held.bounds.left, held.bounds.right - self.width)
    held.el.style.transform = `translateX(${left - self.left}px)`
    return left
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
      const strip = list.getBoundingClientRect()
      lifted = {
        el,
        index,
        boxes,
        grabDx: grabX - boxes[index].left,
        bounds: { left: strip.left, right: strip.right },
      }
      el.dataset.lift = ''
      // 整条进入换序态 —— CSS 据此把 hover 底关掉(§4.5 第 2 条)。
      list.dataset.reorder = ''
    },

    track(x) {
      if (!lifted) return null
      const { index, boxes } = lifted
      const left = follow(lifted, x)

      /*
       * 判据与让位量整段由 `ui/reorder-math` 算(判词、三条前科与「两个下标别弄混」
       * 都在那只文件上)。这里只把答案写成 `transform` —— 那才是这条条自己的形。
       * 喂进去的是抬起那一刻量的基准矩形:读活矩形会让判据自己晃(前科之三)。
       */
      const frame = reorderFrame(
        boxes.map((box) => ({ start: box.left, size: box.width })),
        index,
        left,
      )
      boxes.forEach((box, i) => {
        // 抬起那一格的 transform 是 `follow()` 刚写的跟手位移,不是让位量 ——
        // 它在 `shifts` 里恒为 0,顺手清掉就是把跟手抹掉(这一行拆掉即红)。
        if (i === index) return
        const shift = frame.shifts[i]
        if (shift === 0) {
          box.el.style.transform = ''
          delete box.el.dataset.shift
          return
        }
        box.el.dataset.shift = ''
        box.el.style.transform = `translateX(${shift}px)`
      })
      /*
       * 交出去的是**插到第几格之前**(见 `track` 的坐标系判词)——
       * `workbench` 那一族收的是它,而让位那一段用的是 `settleIndex`。
       */
      return frame.insertIndex
    },

    lifted: () => lifted?.boxes[lifted.index].id ?? null,

    tear(tabId) {
      if (lifted) {
        lifted.el.style.transform = ''
        delete lifted.el.dataset.lift
        clearShifts()
        lifted = null
      }
      delete list.dataset.reorder
      torn ??= tabById(list, tabId)
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
      const tabs = tabsOf(list)
      const before = tabs[index] ?? null
      // 已经在正确的位子上就**一个字都不改** —— 每帧重插会把 CSS 过渡从头再放
      // 一遍(§4.5 第 3 条,也是样例第二版「条上没手感」的病根)。
      if (phAt === index && ph.parentElement === list) return
      const fresh = ph.parentElement !== list
      list.insertBefore(ph, before)
      phAt = index
      if (fresh) {
        /*
         * 头一次插进来时先让它以 0 宽落地、**强制一次回流**,再写真宽度 ——
         * 不这样的话浏览器会把「插入 + 设宽」合成一帧,`width` 的过渡没有起点,
         * 空位是瞬间跳出来的。这一句是那个「宽度动画永远从 0 起」的正解。
         */
        ph.style.width = '0px'
        void ph.getBoundingClientRect()
      }
      ph.style.width = `${Math.max(0, Math.round(width))}px`
    },

    gapRect: () => (ph && ph.isConnected ? ph.getBoundingClientRect() : null),

    clearGap() {
      ph?.remove()
      ph = null
      phAt = null
    },

    settle(tabId, fromLeft) {
      if (typeof requestAnimationFrame !== 'function') return
      requestAnimationFrame(() => {
        const el = tabById(list, tabId)
        if (!el) return
        const to = el.getBoundingClientRect()
        const delta = fromLeft - to.left
        // 一格都没挪:不放这段过渡,直接闪一圈说「到位了」。
        if (Math.abs(delta) < 1) {
          flash(el)
          return
        }
        el.style.transition = 'none'
        el.style.transform = `translateX(${delta}px)`
        // 强制回流,让上面那一句成为过渡的**起点**而不是被合帧吃掉。
        void el.getBoundingClientRect()
        el.style.transition = ''
        el.dataset.settle = ''
        el.style.transform = ''
        after(SETTLE_MS, () => {
          delete el.dataset.settle
          el.style.transform = ''
          flash(el)
        })
      })
    },

    reset() {
      if (lifted) {
        lifted.el.style.transform = ''
        delete lifted.el.dataset.lift
        lifted = null
      }
      if (torn) {
        /*
         * **展回来是瞬时的,不跑那 120ms 的宽度过渡**(09-25)。reset 之后紧跟着的
         * 两个读者都要**停稳之后**的位置:①拖回自己那条条时 `lift()` 当场量每一格
         * 的矩形 —— 量在过渡中途,换序的插入点与被抬起那格的起点都偏一截;②取消时
         * `settle()` 的 FLIP 下一帧量「它回到了哪」—— 量在中途,滑入的终点是错的。
         * 看得见的那一程由上面两者自己的动画负责(跟手 / 滑入),折叠格不必再演一遍。
         */
        const el = torn
        el.style.transition = 'none'
        delete el.dataset.torn
        void el.offsetWidth
        el.style.transition = ''
        torn = null
      }
      delete list.dataset.reorder
      clearShifts()
      choreo.clearGap()
      for (const id of timers) clearTimeout(id)
      timers.clear()
      // 收笔那两格属性也一并摘掉 —— `reset()` 是「回到什么都没发生过」。
      for (const el of tabsOf(list)) {
        delete el.dataset.settle
        delete el.dataset.land
      }
    },
  }

  /**
   * 落定闪一圈。计时读的是 `FLASH_MS`(= `--dur-flash`,那段动画自己的时长),
   * **不是** `LAND_MS` —— 后者是卡片飞行的那一程,两者恰好都在收笔那一刻发生,
   * 但它们是两件事;拿错一个的表现是闪圈被提前掐掉半截。
   */
  function flash(el: HTMLElement): void {
    el.dataset.land = ''
    after(FLASH_MS, () => {
      delete el.dataset.land
    })
  }

  return choreo
}
