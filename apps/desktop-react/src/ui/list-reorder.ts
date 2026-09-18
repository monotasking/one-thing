import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { SETTLE_MS } from '../components/motion'
import { announce } from './a11y/live-region'
import { DRAG_START_PX, PointerTrack } from './drag'
import { clampLead, passedReorderThreshold, reorderFrame } from './reorder-math'
// 普通 `.css`,不是 `.module.css` —— 理由(零本地类名 + 「只为副作用」的 module
// import 会被 vite build 摇掉)整段写在那份文件的头上。
import './list-reorder.css'

/**
 * **一列行的换序**(09-18 立件。起因:节目单从 M1 起文件头就写着「拖拽排序等
 * `ui/` 有了列表换序的基础件再接」,而壳的法是「基础件先行」——
 * 第二个消费者出现之前先立件,禁止在业务面就地手写拖拽编舞)。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────
 * 一件**与业务无关**的纵向列表换序:指针从把手起拖、邻居让位、松手交一次
 * `onMove`;键盘在把手上按 ↑ ↓ Home End 也交一次 `onMove`。
 * 它不认识歌、不认识文件、不认识会话 —— 进来的是一串 id 和一条回调,
 * 出去的是三组 props(整条列表一组、每一行一组、每一个把手一组)。
 *
 * ── 三件事它**不**做,各有判词 ──────────────────────────────────────────
 *  · **不从整行起拖**。只认把手:一行里通常还有点击、右键菜单、行内的钮,
 *    整行可拖就要靠「按下之后手指动没动」去和它们抢,而抢输的那一次是用户看
 *    得见的(菜单开不出来 / 点击变成了拖)。把手是一格**没有第二种意思**的地方。
 *  · **不自己改那串 id**。落定只发一次 `onMove(id, toIndex)`,列表长什么样仍旧
 *    由消费方那份数据说了算(乐观补丁 / 回滚 / 失败留在原地,全是它的事)。
 *    这一件连一格 `useState` 都没有。
 *  · **不自动滚**。拖到列表边缘不会把列表卷起来 —— 那是另一件事(它要一条
 *    自己的速度曲线与一条结束路径),等真有人要再立。今天跟手被**夹在列表
 *    可见矩形之内**(`clampLead`),所以「它跑了但什么都没发生」不会出现。
 *
 * ── 每帧直接写 DOM,不经过 React(与 `ui/tab-reorder` 同一条判词)──────────
 * 一次换序里指针每一帧都在动,让它经过 `setState` 就是「拖一行重渲一整棵树
 * 上百遍」;而这里改的只是几格 `transform` 与几格 `data-*`,**语义(那串 id)
 * 一个字都没变**,松手那一刻才有一次真的 `onMove`。
 * 推论是这一件对消费方的渲染**免疫**:`data-lift` / `data-shift` 是命令式写上去的,
 * React 不管它没声明过的属性,所以拖拽期间消费方重渲一次也不会把它们抹掉。
 * (反过来说:拖拽期间那串 id 若真的被别人改了,基准矩形就旧了 —— 那一帧的落点
 * 会不准,但松手只发一次 `onMove`,树不会坏。列表数据在人手底下换人本来就是
 * 交互稳定性四律 C 型要治的病,不该由这一件兜。)
 *
 * ── 三条结束路径,一条拆卸(`ui/drag/PointerTrack`)──────────────────────
 *   松手      过了阈值 → 量、发 `onMove`、FLIP 滑进新槽;没过 → **一个字都不发**
 *   Esc       `focusTree.registerTransient`,由那唯一的派发器问到(不变量 I2:
 *             keydown 监听只许住在 `src/focus/`)
 *   指针被收走 / 窗口失焦
 * 后三条是**同一句话**「这一下不算数」:150ms 滑回原位,那串 id 一个字不变。
 * 三条路都先走幂等的 `reset()`。
 *
 * ── 为什么吃 `PointerTrack` 而不是 `DragSession` ────────────────────────
 * `DragSession` 管的是「搬一样东西到别处」:浮影、落区高亮、跨宿主的落点表。
 * 这里一样都没有 —— 被拖的那一行自己就是浮影,落点只有「这一列的第几位」。
 * `PointerTrack` 恰好是剩下那一半:指针在不在、这一下要不要作废。它在按下那一刻
 * 就登记 Esc 与 capture(它文件头里说那是与 `DragSession` 的一处语义分叉),
 * 在这里**恰好是对的**:把手没有第二种意思,按住它的时候 Esc 本来就该归这一下;
 * 而阈值这一格由这只文件自己守 —— 没过阈值就没造编舞,松手时无事发生。
 *
 * ── 无障碍 ──────────────────────────────────────────────────────────────
 * 把手是**真 `<button>`**(消费方拿 `handleProps` 摊到 `ui/IconButton` 上),名字由
 * 消费方给(它才知道这一行叫什么);换序落定播一句,走全应用唯一那口
 * `ui/a11y/live-region.announce`,句子同样由消费方给 —— 这一件里一个中文字都没有。
 * **焦点跟着那一行走是结构性的**:把手是那一行的孩子,消费方用稳定 key 渲染,
 * React 换序时 `insertBefore` 挪的是**同一个 DOM 节点**,焦点跟着节点走。
 * 所以这里一句 `.focus()` 都没有(不变量 I3:跨作用域搬焦点才走 `activate()`)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:编舞**每次拖拽现造一只**(一次手势一条会话),三条结束路径共用
 *    `reset()`;hook 自己的瞬态只有三格 ref(那串 id / 列表元素 / 这一场),
 *    模块作用域里一个 `let` 都没有 —— 那会是第二条会话,而且会活过一次热更。
 * ② UI 生命状态:闲(什么都没写过)→ 抬起中(一行浮着、邻居让位、整条不选中
 *    文字)→ 收笔中(`data-settle`,150ms 滑向新槽)→ 闲。
 * ③ UI 交互状态:把手 rest / hover / focus 随 `ui/IconButton`;光标 grab →
 *    grabbing(整条 `data-reordering` 那一格);`disabled` 时指针与键盘两条路
 *    都当场返回,把手由消费方自己置灰。
 */

/** 消费方给的两句话。这一件里一个中文字都没有 —— i18n 住在消费面。 */
export interface ListReorderLabels {
  /** 把手叫什么(`aria-label`,同时是 `ui/IconButton` 的 Tooltip)。 */
  handle(index: number, id: string): string
  /** 换序落定播报什么。`from` / `to` 都是**最终位置**的下标(0 起)。 */
  moved(from: number, to: number, id: string): string
}

export interface ListReorderOptions {
  /** 此刻这一列的次序。**id 必须与 `itemProps` / `handleProps` 收的那一个相同。** */
  ids: readonly string[]
  /**
   * 落定:把 `id` 挪到第 `toIndex` 位。
   *
   * `toIndex` 是**最终位置** —— 「把自己摘出去之后插在第几位」,人话里的那个数
   * (0 = 排到头,`ids.length - 1` = 排到尾)。它**不是** `workbench` 那一族用的
   * 「插到原表第几格之前」,两者的分别写在 `ui/reorder-math` 的文件头上。
   */
  onMove(id: string, toIndex: number): void
  labels: ListReorderLabels
  /** 关掉换序(指针与键盘两条路一起)。消费方还要自己把把手置灰。 */
  disabled?: boolean
}

export interface ListReorderHandleProps {
  /**
   * 把手叫什么。**同一句话摊成两格**,因为它有两种落法:
   *  · `label` —— 壳的法是「图标钮必须消费 `ui/IconButton`」,而那件收名字的那格
   *    就叫 `label`(它同时是 aria-label 与 Tooltip);
   *  · `aria-label` —— 落在一颗裸 `ui/ButtonBase` 上时,名字只能走这一格。
   * 两格恒等,谁在上面都不会打架(`ui/IconButton` 自己那句 `aria-label={label}`
   * 排在透传之后,盖上去的是同一个字符串)。
   */
  label: string
  'aria-label': string
  'data-list-reorder-handle': string
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void
}

export interface ListReorder {
  /**
   * 摊到那条 `<ol>` / `<ul>` 上。
   *
   * `ref` 是**回调 ref 而不是 ref 对象**:后者的类型是 `RefObject<HTMLElement>`,
   * 摊到一条 `<ol>` 上时 tsc 要的是 `RefObject<HTMLOListElement>`,两者不兼容 ——
   * 于是这一件要么长一个泛型参数(每个消费方都得写出自己那个元素类型),要么
   * 收一颗回调 ref(函数参数在 React 的 `RefCallback` 上是双变的,任何元素都收得下)。
   * 这一件只需要「那条列表的 DOM 节点」,不需要知道它是 ol 还是 ul。
   */
  listProps: {
    ref: (node: HTMLElement | null) => void
    'data-list-reorder': string
  }
  /** 摊到每一行(`<li>`)上。 */
  itemProps(id: string): { 'data-list-reorder-item': string }
  /** 摊到那一行的把手(一颗 `ui/IconButton`)上。 */
  handleProps(id: string, index: number): ListReorderHandleProps
}

const ITEM_ATTR = 'data-list-reorder-item'

/** 那一行此刻在这一列里的位置(视口坐标)+ 它的 id。 */
interface ItemBox {
  el: HTMLElement
  id: string
  top: number
  height: number
}

/** 抬起那一行,以及起手时量下来的那一份几何。**整场只量一次**。 */
interface LiftedState {
  el: HTMLElement
  index: number
  boxes: ItemBox[]
  /** 手指按在这一行的哪儿(偏移量,不是坐标 —— 列表会滚、会挪)。 */
  grabDy: number
  /** 这一列自己的上下缘(抬起那一刻量的)。夹紧读它,不每帧问 DOM。 */
  bounds: { top: number; bottom: number }
}

export interface ListReorderChoreo {
  /** 抬起某一行。`grabY` = 按下那一刻指针的纵坐标。幂等。 */
  lift(id: string, grabY: number): void
  /** 换序的一帧:抬起那行跟手、邻居让位,答**最终位置**下标。没抬起过答 null。 */
  track(y: number): number | null
  /** 此刻抬起的是哪一行,没抬起过答 null。 */
  lifted(): string | null
  /** 那一行此刻的上缘(收笔那一程的起点)。摘不到答 null。 */
  topOf(id: string): number | null
  /** **收笔**:树已经改完,让那一行从 `fromTop` FLIP 滑进新槽。 */
  settle(id: string, fromTop: number): void
  /** 全部清干净。幂等 —— 每条结束路径都先走它。 */
  reset(): void
}

/** 这一列里此刻画着的那几行。 */
function itemsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`))
}

/**
 * 按 id 找那一行。**扫一遍属性而不是一句属性选择器**:id 是消费方给的任意字符串
 * (歌的 encryptedId、文件路径……),塞进选择器必须先 `CSS.escape`,而 `CSS` 这个
 * 全局在 jsdom 里压根不存在 —— 同一条判词(与那颗延时雷的病历)写在
 * `ui/tab-reorder.flashLandedTab` 上。一列行也就几十个,扫一遍比一句选择器更便宜。
 */
function itemById(list: HTMLElement, id: string): HTMLElement | null {
  return itemsOf(list).find((el) => el.getAttribute(ITEM_ATTR) === id) ?? null
}

/**
 * 把一条列表变成可编舞的。**每次拖拽造一只** —— 一次手势一条会话,
 * 编舞是那条会话的一部分,不是这条列表的一格属性。
 */
export function listReorderChoreo(list: HTMLElement): ListReorderChoreo {
  let held: LiftedState | null = null
  /** 收笔那一拍的计时器。`reset()` 收。 */
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const clearShifts = (): void => {
    for (const el of itemsOf(list)) {
      el.style.transform = ''
      delete el.dataset.shift
    }
  }

  const choreo: ListReorderChoreo = {
    lift(id, grabY) {
      if (held) return
      const items = itemsOf(list)
      const index = items.findIndex((el) => el.getAttribute(ITEM_ATTR) === id)
      if (index < 0) return
      const boxes = items.map((el) => {
        const r = el.getBoundingClientRect()
        return { el, id: el.getAttribute(ITEM_ATTR) ?? '', top: r.top, height: r.height }
      })
      const rect = list.getBoundingClientRect()
      held = {
        el: items[index],
        index,
        boxes,
        /*
         * 抓点记的是**偏移量**而不是坐标:列表会滚、会因为窗口变化而挪,
         * 而「手指按在这一行的哪儿」是这次手势里唯一不变的那个数。
         */
        grabDy: grabY - boxes[index].top,
        bounds: { top: rect.top, bottom: rect.bottom },
      }
      held.el.dataset.lift = ''
      list.dataset.reordering = ''
    },

    track(y) {
      if (!held) return null
      const { index, boxes } = held
      const self = boxes[index]
      // 夹在这一列的上下缘之内,两端读**抬起那一刻量的**那一份
      // (每帧问 DOM 会在紧跟着一串 transform 写入之后逼出一次强制排版)。
      const top = clampLead(y - held.grabDy, held.bounds.top, held.bounds.bottom - self.height)
      held.el.style.transform = `translateY(${top - self.top}px)`

      const frame = reorderFrame(
        boxes.map((box) => ({ start: box.top, size: box.height })),
        index,
        top,
      )
      boxes.forEach((box, i) => {
        // 抬起那一行的 transform 是上面那句跟手位移,不是让位量 —— 它在 `shifts`
        // 里恒为 0,顺手清掉就是把跟手抹掉。
        if (i === index) return
        const shift = frame.shifts[i]
        if (shift === 0) {
          box.el.style.transform = ''
          delete box.el.dataset.shift
          return
        }
        box.el.dataset.shift = ''
        box.el.style.transform = `translateY(${shift}px)`
      })
      /*
       * 交出去的是**最终排第几位**:消费方的 `onMove(id, toIndex)` 说的是人话里
       * 那个数。`insertIndex` 那一格是 `workbench` 的坐标系,这一族用不着。
       */
      return frame.settleIndex
    },

    lifted: () => (held ? held.boxes[held.index].id : null),

    topOf: (id) => itemById(list, id)?.getBoundingClientRect().top ?? null,

    /**
     * **收笔**:排在 `reset()` **之后**叫 —— reset 摘掉抬起与 transform,React 随后
     * 把那一行挪到新位置,而这只函数要量的正是「新位置」。所以它自己等一帧
     * (`requestAnimationFrame`):React 对一次 discrete 事件的提交排在当前任务与
     * 微任务里,rAF 回调排在那之后、**在这一帧绘制之前** —— 于是屏幕上不会先看见
     * 它跳到新位置再滑回来。
     */
    settle(id, fromTop) {
      if (typeof requestAnimationFrame !== 'function') return
      requestAnimationFrame(() => {
        const el = itemById(list, id)
        if (!el) return
        const delta = fromTop - el.getBoundingClientRect().top
        // 一格都没挪:不放这段过渡(FLIP 的位移是 0,挂上属性只是空跑一遍)。
        if (Math.abs(delta) < 1) return
        el.style.transition = 'none'
        el.style.transform = `translateY(${delta}px)`
        // 强制回流,让上面那一句成为过渡的**起点**而不是被合帧吃掉。
        void el.getBoundingClientRect()
        el.style.transition = ''
        el.dataset.settle = ''
        el.style.transform = ''
        const timer = setTimeout(() => {
          timers.delete(timer)
          delete el.dataset.settle
          el.style.transform = ''
        }, SETTLE_MS)
        timers.add(timer)
      })
    },

    reset() {
      if (held) {
        held.el.style.transform = ''
        delete held.el.dataset.lift
        held = null
      }
      delete list.dataset.reordering
      clearShifts()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      // 收笔那格属性也一并摘掉 —— `reset()` 是「回到什么都没发生过」。
      for (const el of itemsOf(list)) delete el.dataset.settle
    },
  }

  return choreo
}

/** 这一场手势留下的东西。松手 / 作废两条路共用一份拆卸。 */
interface Gesture {
  id: string
  track: PointerTrack
  startY: number
  choreo: ListReorderChoreo | null
  /** 每帧由 `track()` 交回来的落点(最终位置)。没起拖就是 null。 */
  at: number | null
}

/**
 * 换序那一件的 React 口。用法:
 *
 * ```tsx
 * const reorder = useListReorder({ ids, onMove, labels })
 * <ol {...reorder.listProps}>
 *   {rows.map((row, i) => (
 *     <li key={row.id} {...reorder.itemProps(row.id)}>
 *       …
 *       <IconButton icon={GripVertical} {...reorder.handleProps(row.id, i)} />
 *     </li>
 *   ))}
 * </ol>
 * ```
 */
export function useListReorder(options: ListReorderOptions): ListReorder {
  const listRef = useRef<HTMLElement | null>(null)
  /** 最新的那份选项。逐帧读它 —— 手势活在事件里,不活在某一次渲染的闭包里。 */
  const latest = useRef(options)
  latest.current = options
  const gesture = useRef<Gesture | null>(null)

  /** 落定一次(指针与键盘两条路共用)。播报是**落定的一部分**,不是调用方的礼貌。 */
  const commit = useCallback((id: string, from: number, to: number) => {
    const { onMove, labels } = latest.current
    onMove(id, to)
    announce(labels.moved(from, to, id))
  }, [])

  /**
   * **这一场留下的一切**。幂等,三条结束路径都走它。
   *   `drop`    松手:`onPointerUp` 已经先量后改、把滑入排好了,这里只清属性。
   *   `cancel`  Esc / pointercancel / 窗口失焦:**还抬着**就 150ms 滑回原位,
   *             那串 id 一个字不变。
   */
  const endGesture = useCallback((reason: 'drop' | 'cancel') => {
    const own = gesture.current
    gesture.current = null
    const choreo = own?.choreo
    if (!choreo) return
    const lifted = choreo.lifted()
    if (reason === 'cancel' && lifted !== null) {
      // 次序不能反 —— reset 之后再量,量到的是它已经回到原位的样子,位移是 0,
      // 屏幕上还是瞬移(与 `useTabDrag.slideBack` 同一条判词)。
      const from = choreo.topOf(lifted)
      choreo.reset()
      if (from !== null) choreo.settle(lifted, from)
      return
    }
    choreo.reset()
  }, [])

  const onPointerDown = useCallback(
    (id: string, event: ReactPointerEvent<HTMLElement>) => {
      if (latest.current.disabled) return
      // 只认主键:右键要留给上下文菜单(节目单那一行的动作单产地就是它)。
      if (event.button !== 0) return
      const list = listRef.current
      if (!list) return
      if (!itemById(list, id)) return
      // 上一场没收干净就先收 —— 幂等,而且这一句是「一次手势一条会话」的保险丝。
      gesture.current?.track.dispose()
      endGesture('cancel')

      const startY = event.clientY
      const own: Gesture = {
        id,
        startY,
        choreo: null,
        at: null,
        track: PointerTrack.open(event.currentTarget, event.pointerId, {
          move(ev) {
            const live = gesture.current
            if (!live) return
            if (!live.choreo) {
              // **过阈值才算拖**:量的是换序那一轴上的位移。没过就一个字都不写 ——
              // 屏幕上这一下和「按了一下把手」没有区别。
              if (!passedReorderThreshold(ev.clientY - live.startY, DRAG_START_PX)) return
              live.choreo = listReorderChoreo(list)
              live.choreo.lift(live.id, live.startY)
            }
            live.at = live.choreo.track(ev.clientY)
          },
          end() {
            const live = gesture.current
            // 没过阈值 = 这一下是一次点击,**一个字都不发**。
            if (!live?.choreo) {
              endGesture('drop')
              return
            }
            const to = live.at
            const from = latest.current.ids.indexOf(live.id)
            /*
             * **收笔先量后改**:滑入那一程要的是「它此刻在手上的位置」,而
             * `onMove` 一改数据 React 就把那一行挪走了。所以先量,再发,再交给
             * 编舞去 FLIP(它自己等一帧,判词在 `settle` 上)。
             */
            const liveTop = live.choreo.topOf(live.id)
            if (to !== null && from >= 0 && to !== from) commit(live.id, from, to)
            const choreo = live.choreo
            endGesture('drop')
            if (liveTop !== null) choreo.settle(live.id, liveTop)
          },
          cancel() {
            endGesture('cancel')
          },
        }),
      }
      gesture.current = own
    },
    [commit, endGesture],
  )

  /**
   * 键盘那条路。四个键在这颗钮上**全部**归换序,所以按到头也 `preventDefault`
   * —— 否则「已经在第一位了还按 ↑」会变成把整页滚一下,人看到的是「换序把页面
   * 弄跑了」。带任何修饰键的一律放行:那是快捷键那张表的事,不是这一行的事。
   */
  const onKeyDown = useCallback((id: string, event: ReactKeyboardEvent<HTMLElement>) => {
    if (latest.current.disabled) return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const ids = latest.current.ids
    const from = ids.indexOf(id)
    if (from < 0) return
    const last = ids.length - 1
    const to =
      event.key === 'ArrowUp'
        ? from - 1
        : event.key === 'ArrowDown'
          ? from + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (to === null) return
    event.preventDefault()
    if (to === from || to < 0 || to > last) return
    commit(id, from, to)
  }, [commit])

  /**
   * **第四条结束路径:宿主没了**(抽屉在拖到一半时被关掉、那块面被卸载)。
   *
   * 走的是 `dispose()`(**只拆不叫**)而不是 `cancel()`:那三条 window 监听与那格
   * Esc 瞬态登记必须收掉 —— 不收的话「关掉抽屉之后按 Esc 还有人吃掉它」会一直挂着,
   * 而这条路上**没有什么可以还原**:那几行 DOM 已经离树,滑回原位是滑给谁看。
   */
  useEffect(
    () => () => {
      gesture.current?.track.dispose()
      gesture.current = null
    },
    [],
  )

  const listProps = useRef({
    ref: (node: HTMLElement | null) => {
      listRef.current = node
    },
    'data-list-reorder': '',
  }).current

  return {
    listProps,
    itemProps: useCallback((id: string) => ({ 'data-list-reorder-item': id }), []),
    handleProps: useCallback(
      (id: string, index: number): ListReorderHandleProps => ({
        label: latest.current.labels.handle(index, id),
        'aria-label': latest.current.labels.handle(index, id),
        'data-list-reorder-handle': '',
        onPointerDown: (event) => onPointerDown(id, event),
        onKeyDown: (event) => onKeyDown(id, event),
      }),
      [onKeyDown, onPointerDown],
    ),
  }
}
