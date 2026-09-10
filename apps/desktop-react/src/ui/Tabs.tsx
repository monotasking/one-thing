import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { resolveIcon, X } from '../components/icons'
import { FrameCoalescer } from './frame-coalescer'
import { StatusDot } from './StatusDot'
import { Tooltip } from './Tooltip'
import { useRoving } from './a11y/roving'
import s from './Tabs.module.css'

/**
 * 规范画布「Tabs 族」的唯一实现:高 36、tab 左右内边距 10。
 * 活动态只换字色 + 底缘 2px accent 指示条(inset box-shadow,不占布局,
 * 所以切换 tab 一像素都不动);非活动 --text-3,hover --st-hover。
 *
 * 完全受控:它不存 activeId,也不认识 item 里装的是什么内容。
 * onClose 给了才画 ×,× 平时透明、hover 本 tab 时浮出(只动 opacity,位子一直占着)。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   ← / →             在 tab 之间移动焦点(循环),整条只占**一个** Tab 位;
 *                     **只移焦点不切页**(APG 的手动激活档)——「移到就切」会让
 *                     键盘用户路过一条 tab 就把它的内容装一遍,这台上每张页都要拉数据
 *   Home / End        到首 / 末
 *   Enter / Space     激活当前 tab
 *   Delete / Backspace 关掉当前 tab(给了 onClose 才有)—— 屏幕上那颗 × 是**鼠标**
 *                     的顺手路,它不进 Tab 序,理由写在下面那颗按钮上
 *   Tab               走出 tab 条(整条只占一个位子)
 * 语义:role=tablist / tab + aria-selected。**没有 aria-controls** —— 内容面板
 * 由宿主画在别处,Tabs 不认识它;指一个自己不知道在不在的 id 比不指更糟。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface TabSpec {
  id: string
  label: string
  /** lucide 图标名,与 items 表同一套字符串 */
  icon?: string
  /**
   * **有没存的改动**(W1)。画一枚 `ui/StatusDot`(warn 档,`size="sm"`)——
   * 与查看器檐上从前那一颗**逐像素相同**(值就取自那一颗)。
   * 它**不是控件**:不进 Tab 序、没有 hover/active,只是一枚状态点,
   * 而且**不给 label** —— tab 自己的名字已经在旁边,再给一个无障碍名会念两遍。
   */
  dirty?: boolean
  /**
   * 悬停时说的**全名**。给了就把名字那一段包进 `ui/Tooltip`(截断的标题必须配
   * Tooltip 全名 —— 禁令区那条:`--tab-max-w` 是 160,`engine.ts` 与另一个目录里
   * 的 `engine.ts` 在屏幕上长得一模一样)。
   *
   * **缺席就一件都不挂**:没有 `tip` 的那些 tab(架子、别处的分段条)渲染出来
   * 的 DOM 与从前逐字相同 —— 这一格是加法,不是给所有消费方换一套行为。
   * 锚在名字那一段而不是整条 tab:说的是「这句被截断的话的全文」,
   * 而 ✕ 与未保存丸各有各的说法。
   */
  tip?: string
  /**
   * 关不关得掉。缺省 `true`(给了 `onClose` 就画 ✕)。
   *
   * **为什么 TabSpec 多这一格**(裁定原文只说加 `dirty` 一个布尔):
   * 「最后一片 chat 叶不可关」(T0 拍点 2)是**逐 tab** 的事实,而 `onClose`
   * 是整条 tab 条一个。判据若留在宿主里就得写成「点了才发现关不掉」——
   * 那时 ✕ 已经画出来了,而用户报的正是「按了没反应」这一族。所以它与
   * `dirty` 同族:**数据表驱动的一格事实**,不是混进来的 children。
   */
  closable?: boolean
  /**
   * **这一组的「家」**(W1-b,设计 §2.2:「会话标签的图标用主题色,它是这一组的家」)。
   * 只换**图标**的颜色 —— 底与字色是「活动 / 悬停」那两件事的语汇,与「谁是家」正交
   * (一条 tab 可以同时是家、是活动的、是被悬停的)。
   *
   * 它与 `dirty` / `closable` 同族:**数据表驱动的一格事实**。判据由宿主
   * 从内容种类的自述里取(`ContentKind.resident`),`ui/Tabs` 不认识任何一种内容。
   */
  home?: boolean
  /**
   * **这一格装了几份内容**(W6-b)。1 = 普通标签,2 = 两格并排的那一种。
   *
   * 它是**一个数**,不是「是不是 pair」—— `ui/Tabs` 认识的只有「这一格里有几份」,
   * 认不得任何一种内容(全目录 grep `pair` 在 `ui/` 下零命中)。落点判据要它:
   * 「两格的标签不能再并」(设计 v3 §6「不允许」)与「内容区左带仅 host 单格」
   * 两条各要读一次,而它们读的是 DOM 上这一格属性 —— 判据因此不必再开一份名册。
   * 缺省 1;与 `dirty` / `home` 同族:**数据表驱动的一格事实**。
   */
  slots?: number
  /**
   * **这一格要不要更宽的上限**(W7-t / B6,设计 v3 §6:「最大宽度 260px」)。
   *
   * 与 `dirty` / `home` / `slots` 同族:**数据表驱动的一格事实**。缺省 = 常规
   * 上限(`--tab-max-w` 160);`true` = 这一格天生装着两个名字,给它 `--tab-wide-max`。
   *
   * 判据由宿主从**内容种类的自述**里取(`ContentKind.tabWide`),`ui/Tabs` 照旧
   * 认不得任何一种内容 —— 它读的只是「这一格宽不宽」。CSS 那一头也不按种类开
   * 分支:`.tab[data-tab-wide]` 说的是这一格的档,不是它装着谁。
   */
  wide?: boolean
  /**
   * **这一格是预览格吗**(C2,拍点 5:视觉 = 斜体标题,与 VS Code 同一约定;
   * 不用计数徽、不换底色)。
   *
   * 它是**一个字符串而不是一个布尔**,而那个字符串就是**念给读屏软件听的状态词**
   * (「预览」/「Preview」)。一格顶两件事,理由是这件库件的一条纪律:
   * `ui/` 里不落任何界面文案(全仓只有 `ui/Dialog` 的 `ConfirmHost` 那种**宿主级**
   * 组件才读 i18n)。收一个布尔就得再收一个 `previewLabel`,而两格分开的下场是
   * 某个宿主给了布尔忘了给词 —— 屏幕上一格斜体,读屏软件一声不吭。
   * 与 `tip` 同族:**在场即成立,而它的值就是那句话**。
   *
   * 斜体是**这一格的档**(`data-tab-preview`),不是「它装着谁」—— `ui/Tabs`
   * 照旧认不得任何一种内容。
   */
  preview?: string
}

/**
 * **条上此刻有哪几格没完全露出来**(W7-t / B1)。
 *
 * 溢出是**标签条自己的形**(它是那个横滚容器,谁在视野里只有它量得出),
 * 所以产地在这里;而「拿这份名单画一张表」是宿主的语法(拼贴台把它并进叶动作组
 * 那一颗 ⋯)。两件事分开的判据与 `onTabPointerDown` / `onTabMenu` 逐字
 * 同源:`ui/Tabs` 只交出事实,不认识菜单。
 */
export interface TabsOverflow {
  /** 不完全可见的那几格(按条上次序;整颗裁在外面的与只露一半的都算)。 */
  ids: readonly string[]
  /** 把一格滚进视野。滚这件事归条自己 —— 同一个 id 可能在两条条上各有一格。 */
  reveal: (id: string) => void
}

/** 一格 tab 的取件口(id 里的引号 / 反斜杠要转义 —— key 允许带路径)。 */
function tabElementIn(bar: HTMLElement | null, id: string): HTMLElement | null {
  const el = bar?.querySelector(`[data-tab-id="${id.replace(/["\\]/g, '\\$&')}"]`)
  return el instanceof HTMLElement ? el : null
}

/**
 * **「完全落在条里」的亚像素容差**(px)。它不是一格设计尺寸,是量子:
 * `getBoundingClientRect` 交出来的是小数,一格正贴着边缘的 tab 会读到零点几
 * 像素的越界 —— 不留这一格容差,右端那颗 ⋯ 会永远挂着一个假名单。
 *
 * `scripts/gate-squeeze.mjs`(B1 那一档「选中的那一格完全可见」)按名字**从这只
 * 文件里读它**,不再自己抄一个 1 —— 两处同源,改这里门跟着改。改名要连门一起改。
 */
export const TAB_CLIP_EPSILON_PX = 1

/**
 * 量一遍:哪几格没完全落在条的可视矩形里。
 *
 * 用 `getBoundingClientRect` 而不是 `offsetLeft`:`.bar` 自己不是定位元素,
 * 而 `.tab` 是(`position: relative`),于是 `offsetLeft` 量的是别人家的原点 ——
 * 拿它跟 `scrollLeft` 比会得到一份看起来很像的错读数。
 *
 * **条还没排出盒就答空**(jsdom 里所有矩形恒 0):那时「谁在视野里」不成立,
 * 答「全都不在」会让宿主画出一颗永远按不动的 ⋯。
 */
function clippedTabIds(bar: HTMLElement): string[] {
  if (bar.clientWidth <= 0) return []
  const box = bar.getBoundingClientRect()
  if (box.width <= 0) return []
  const out: string[] = []
  for (const el of Array.from(bar.querySelectorAll<HTMLElement>('[data-tab-id]'))) {
    const r = el.getBoundingClientRect()
    if (r.left < box.left - TAB_CLIP_EPSILON_PX || r.right > box.right + TAB_CLIP_EPSILON_PX) {
      const id = el.dataset.tabId
      if (id) out.push(id)
    }
  }
  return out
}

/**
 * **这条 tab 条长什么样**(W3-b 裁定 1;09-05 用户看真机后选甲「浏览器式」)。
 *
 *   `line`    规范画布那一档:扁平,活动态只换字色 + 底缘 2px accent 指示条。
 *             **缺省** —— 别处的分段条(设置页、面板内的小 tab)一个像素都不变。
 *   `joined`  浏览器式:活动 tab 顶两角圆、无描边、底色 = 那片叶的脸,底部两侧
 *             各长一只反向圆角的「肩」把它和条底接成一整块;非活动透明底,
 *             相邻两条非活动之间一根细线。**拼贴台四个区域一律这一档**
 *             (顶栏组 / 架子叶 / 浮窗叶 / 分屏叶),用户报的「两套标签语言」
 *             就是这一句话治的。
 *
 * 它是**外观**,不是第二个组件:同一份数据表、同一套键盘行为、同一个 DOM 形状,
 * 换的只是一格 `data-look`。两个组件会在「预览斜体」「未保存丸」「✕ 什么时候浮出」
 * 这些地方各自漂一遍 —— 那正是这台壳里 tab 曾经有两套画法的病根。
 */
export type TabsLook = 'line' | 'joined'

interface TabsProps {
  items: TabSpec[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  /** 外观档。缺省 `line`(见 `TabsLook`)。 */
  look?: TabsLook
  /**
   * 谁摆 Tabs 谁决定「按住一个 tab 意味着什么」。Tabs 自己不认识拖拽 ——
   * 它只把按下这件事连同 id 递出去,拖不拖得动、拖出去变成什么,是宿主的语法。
   * 不接就是不接:没给这个 prop 时 tab 的行为与从前逐字相同(按下 → 松开 → onSelect)。
   */
  onTabPointerDown?: (id: string, e: ReactPointerEvent<HTMLElement>) => void
  /**
   * **「给这一格开上下文菜单」这一句请求**(W6-c 立;W7-c 收成一格「点」)。
   *
   * 与 `onTabPointerDown` 逐字同一条纪律:Tabs 自己不认识「动作菜单」这回事,
   * 它只把请求连同 id 与**开在哪一点**递出去,开什么表是宿主的语法。不接就是
   * 不接 —— 没给这个 prop 时右键落到浏览器 / 宿主的缺省上下文菜单上。
   *
   * **两个来源,一口出去**(W7-c):右键那一下(点 = 光标)与键盘 `Shift+F10` /
   * 上下文菜单键(点 = 这一格的左下角)。「点从哪儿来」只有条自己答得出 ——
   * 它手上有那一格的矩形 —— 所以量点的活留在这里,交出去的是**结果**。
   * 递事件的话键盘那条路就得伪造一发 MouseEvent,那是把「谁该量」答错了。
   *
   * 键盘那一路是**删掉那颗钮之后唯一的键盘入口**(W7-c 裁定 3):动作表从此只有
   * 右键与这两个键两个开口,而 `Shift+F10` 是 Windows / GTK / macOS 读屏软件通行
   * 的「开上下文菜单」键,不是这台壳自造的。
   *
   * 它与 `useDragSource` 那句 `if (e.button !== 0) return`「右键要留给上下文菜单」
   * 是同一条判例的两半:那边让开,这边接住。
   */
  onTabMenu?: (id: string, at: { x: number; y: number }) => void
  /**
   * **条上此刻有几格没露全**(W7-t / B1)。给了就在名单**真的变了**的时候叫一次
   * (滚动 / 改尺寸 / 换了几格都会重量);不接就是不接 —— 不给这个 prop 时这只
   * 组件一次都不量,DOM 与从前逐字相同。
   *
   * 只在名单变化时叫,是为了不造一条「宿主重渲 → 回调换身份 → 重量 → 再报」的
   * 环:交回去的 `ids` 内容一样就一声不吭。
   */
  onOverflow?: (state: TabsOverflow) => void
  label?: string
}

export function Tabs({
  items,
  activeId,
  onSelect,
  onClose,
  onTabPointerDown,
  onTabMenu,
  onOverflow,
  look = 'line',
  label,
}: TabsProps) {
  const bar = useRef<HTMLDivElement>(null)
  useRoving(bar, { axis: 'horizontal' })
  /*
   * **竖着的滚轮在这条条上算横滚**(W7-t / B1;真机读数:13 格时 4 格整颗看不见,
   * 竖滚轮 120 → `scrollLeft` 一格不动 —— 鼠标用户够不着那几格)。
   *
   * 三件事写在这一段里,缺一条都不成立:
   *  · **只映射 `deltaY`**:`deltaX` 那条是触控板自己的横滚,浏览器已经做对了,
   *    再加一遍会走双倍;
   *  · **原生监听 + `{ passive: false }`**:React 把 `wheel` 注册成被动的,
   *    合成事件里 `preventDefault()` 是一句空话 —— 不拦的话这一下会继续冒泡给
   *    外面那个竖滚容器,屏幕上就是「条没动、页面滚了」;
   *  · **滚不动就让开**(`max <= 0`):没溢出的条(设置页那些分段器)一个字
   *    都不该改,竖滚轮该原样交给外面。
   */
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0 || e.deltaY === 0) return
      if (el.scrollWidth - el.clientWidth <= 0) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  /** 把一格滚进视野。交给宿主的那一口(见 `TabsOverflow.reveal`)。 */
  const reveal = useCallback((id: string) => {
    tabElementIn(bar.current, id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [])
  /*
   * **谁没露全**(B1)。重量的三个由头:条滚了、条的盒变了、格数 / 格宽变了。
   * `seen` 挡住「内容一样但数组换了身份」那一发 —— 宿主多半把它写进一格 store,
   * 而那会让它重渲、回调换身份、这条 effect 重跑:不挡就是一条自激的环。
   */
  const seen = useRef('')
  useEffect(() => {
    const el = bar.current
    if (!el || !onOverflow) return
    const measure = () => {
      const ids = clippedTabIds(el)
      const key = ids.join('\u0000')
      if (key === seen.current) return
      seen.current = key
      onOverflow({ ids, reveal })
    }
    /*
     * **观察器回调只读不写;量到的东西在下一帧交出去**(09-10 立法,见
     * `ui/frame-coalescer.ts` 文件头的完整病历)。`measure()` 交出去那一下会让宿主
     * 挂上 / 卸下 ⋯ 钮(标签条随之变宽 18px),React 的同步冲刷还会把别处排着的
     * 布局写(拖架子那一发 `setLiveThickness`)一并提交 —— 直接在 RO 回调里跑就是
     * 在**派发循环内改布局**,Chrome 当场判「同深度未派送」,屏幕上是闪 + 一句
     * `ResizeObserver loop completed with undelivered notifications`。
     * 微任务不行(仍在那一趟里),所以是 rAF。
     *
     * **挂载那一次仍同步**:它不在任何派发循环里,而「条还没排出盒 → 一格都不报」
     * 那条用例读的正是这一发。
     */
    const coalescer = new FrameCoalescer(measure)
    const schedule = () => coalescer.schedule()
    measure()
    el.addEventListener('scroll', schedule, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    ro?.observe(el)
    return () => {
      coalescer.cancel()
      el.removeEventListener('scroll', schedule)
      ro?.disconnect()
    }
  }, [items, onOverflow, reveal])
  /*
   * **活动的那一格必须在视野里**(W3-b 真机读数:顶栏非焦点组被尾格夹到 216px,
   * 三格 tab 总宽 337,活动格排第三 —— `scrollLeft` 停在 0,活动格整颗裁在视野外,
   * 屏幕上那一组像「没有活动格」,连体当场失效)。条是横滚容器(超量纪律:永不换行、
   * 先收窄再横滚),所以活动格换人 / 条挂载时把它滚进来。`inline:'nearest'` 只在
   * 它真的在外面时才动,滚过的距离最短;`block:'nearest'` 不许它顺手把页面竖着滚。
   * 只滚不搬焦点(I3:`.focus()` 不在这里)。jsdom 没有 scrollIntoView,可选调用。
   */
  useEffect(() => {
    if (activeId === null) return
    tabElementIn(bar.current, activeId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])
  return (
    <div ref={bar} className={s.bar} data-look={look} role="tablist" aria-label={label}>
      {items.map((tab) => {
        const Icon = tab.icon ? resolveIcon(tab.icon) : null
        const on = tab.id === activeId
        // 关不掉的那一条**不画 ✕**(不是画出来再禁灰:一颗按不动的 ✕ 与
        // 「按了没反应」在屏幕上是同一件事)。
        const closable = onClose && tab.closable !== false
        return (
          /*
           * **tab 就是这一层**,不是里面那个按钮(A11y 线 · A2 的一处结构改动)。
           *
           * 理由是 ARIA 的一条硬约束:tablist 的合法子成员**只有** tab。从前的写法是
           * 「壳 div > [tab 按钮, × 按钮]」,那个 × 在无障碍树里是 tablist 的直接
           * 子成员(壳无论有没有 role,都会被穿过),于是 tablist 里坐着一个不是 tab
           * 的东西 —— axe 的 aria-required-children 判 critical,而它判得对:
           * 读屏软件按「第几个 tab」数下去会数错。
           *
           * 所以把 role="tab" 提到壳上,× 变成 tab **内部**的一个按钮。代价是这一层
           * 不再是原生 <button>,Enter / Space 要自己接一下 —— 这是**唯一**自造的
           * 一格键盘行为,写在下面那个 onKeyDown 里,别处一行都没有。
           */
          <div
            key={tab.id}
            className={[s.tab, on && s.tabOn, tab.home && s.tabHome]
              .filter(Boolean)
              .join(' ')}
            role="tab"
            aria-selected={on}
            /*
             * **取件口**(W3-b):条内换序那一件(`ui/tab-reorder.ts`)要按 id 认得出
             * 每一格,而 `role="tab"` 只说得出「第几个」。门与用例也读它。
             * 它是一格事实的投影,不是一件新功能 —— `id` 本来就在 props 里。
             */
            data-tab-id={tab.id}
            /*
             * **这一格装了几份**(W6-b,见 `TabSpec.slots`)。落点判据从 DOM 上读它,
             * 于是「两格的标签不能再并」这条规矩不必在判据那一头再开一份名册。
             * 只在 > 1 时写:一格标签的 DOM 与从前逐字相同。
             */
            data-tab-slots={tab.slots && tab.slots > 1 ? String(tab.slots) : undefined}
            /*
             * **这一格用哪一档宽度上限**(W7-t / B6,见 `TabSpec.wide`)。
             * 只在 `true` 时写:常规那一格的 DOM 与从前逐字相同。
             */
            data-tab-wide={tab.wide ? '' : undefined}
            /*
             * **预览格那一档**(C2,见 `TabSpec.preview`)。只在场时写:普通那一格
             * 的 DOM 与从前逐字相同。皮肤(斜体)整件在 CSS 那一头,这里只声明档。
             */
            data-tab-preview={tab.preview ? '' : undefined}
            // roving 入组标记 + 初值。选中的那一条由 useRoving 改回 0 ——
            // 不给初值的话,一条八页的 tab 条要按八下 Tab 才走得出去。
            data-roving-item
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => {
              // 原生按钮白送的那一格,这里补上。
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab.id)
                return
              }
              // 关这条 tab 的**键盘路**(APG 可删除 tab 的做法)。× 是鼠标的顺手路,
              // 它不进 Tab 序(理由见下面那颗按钮上的注释),所以键盘要有自己这一下。
              if (closable && (e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault()
                onClose(tab.id)
                return
              }
              /*
               * **键盘开上下文菜单**(W7-c)。`ContextMenu` 是那颗菜单键自己的
               * `KeyboardEvent.key`;`Shift+F10` 是没有那颗键的键盘上的通行等价。
               * 点取**这一格的左下角** —— 与右键开在光标处是同一句话的两种量法,
               * 而键盘没有光标,菜单只能贴着它作用的那个东西开。
               */
              if (onTabMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
                e.preventDefault()
                const box = e.currentTarget.getBoundingClientRect()
                onTabMenu(tab.id, { x: Math.round(box.left), y: Math.round(box.bottom) })
              }
            }}
            onPointerDown={onTabPointerDown ? (e) => onTabPointerDown(tab.id, e) : undefined}
            onContextMenu={
              onTabMenu
                ? (e) => {
                    // 挡掉宿主自己的上下文菜单 —— 两张菜单同时开是这类接管的经典漏法。
                    e.preventDefault()
                    onTabMenu(tab.id, { x: e.clientX, y: e.clientY })
                  }
                : undefined
            }
          >
            <span className={s.main}>
              {Icon && <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
              {tab.tip ? (
                <Tooltip content={tab.tip}>
                  <span className={s.label}>{tab.label}</span>
                </Tooltip>
              ) : (
                <span className={s.label}>{tab.label}</span>
              )}
              {/*
               * 未保存丸**消费 `ui/StatusDot`**(与查看器檐上从前那一颗同一件、
               * 同一档)。不给 `label`:tab 的名字就在左边,读屏软件念两遍是噪音。
               */}
              {tab.dirty && (
                <span className={s.dirty} data-tab-dirty="" aria-hidden="true">
                  <StatusDot tone="warn" size="sm" />
                </span>
              )}
              {/*
                **状态词只念不看**(C2)。斜体是给眼睛的,读屏软件看不见字形 ——
                所以那一格档位在这里还要有一句话。它进的是这一格 tab 的**可访问名**
                (「会话标题 预览」),而不是 `aria-description`:后者是 ARIA 1.3 的
                新格,今天的读屏软件支持面不齐,而这台壳里已经有一件现成的
                「只念不看」(全局 `.visually-hidden`,`ui/Field` 的隐藏标签、
                `AppShell` 的 h1 走的都是它)。
                文案由宿主给(见 `TabSpec.preview`),这只组件一个字都不落。
              */}
              {tab.preview && <span className="visually-hidden">{tab.preview}</span>}
            </span>
            {closable && (
              /*
               * × 是**鼠标的顺手路**,不是键盘的路 —— 所以它 `aria-hidden` 且不进
               * Tab 序,键盘那一路是上面 onKeyDown 里的 Delete / Backspace。
               *
               * 这不是省事,是 ARIA 逼出来的唯一出口,两边都撞过墙才落到这里:
               *  · × 摆在 tab **外面**(从前的写法)→ tablist 里坐着一个不是 tab 的
               *    成员,aria-required-children 判 critical;
               *  · × 摆在 tab **里面**且可聚焦 → tab 是「子元素呈现性」的角色,
               *    nested-interactive 判 serious(两条都是真机 axe 实测出来的,
               *    不是纸上推的)。
               * 第三条路才两边都过:× 退成纯装饰,关闭这件事由 tab 自己用一个键表达。
               * 连 `<button>` 都不能留 —— axe 的原话是「元素上加负 tabindex(哪怕再
               * 加 aria-hidden)也挡不住辅助技术聚焦到它」,所以它必须**从一开始就不是
               * 一个控件**:一个 aria-hidden 的 <span>,只接鼠标。
               * 代价记档:读屏软件不再念得到那颗 ×(它本来也只念得出「关闭 files」
               * 这句我们编的话),键盘用户少按一下 Tab、多知道一个 Delete。
               */
              /* 刻意不给 role / tabIndex:一给就又变回「tab 里嵌了个控件」,也就是
               * 上面那两堵墙里的第二堵。键盘那一路在外层 tab 的 onKeyDown 上。
               * (jsx-a11y 的 click-events-have-key-events 不在这里报 —— 它认
               * aria-hidden:一个不在无障碍树里的节点,规则不要求它自带键盘路。) */
              <span
                className={s.close}
                aria-hidden="true"
                /* 一格**门用的把手**(U3):`data-tab-close`,与旁边那颗未保存丸的
                 * `data-tab-dirty` 同一体例。`gate:drag` 要问「这一格画不画 ✕、
                 * 按下去关不关得掉」,而那颗 ✕ 刻意不是控件、也没有名字 ——
                 * 按 CSS Module 的哈希类名去认它是把门钉在样式上。 */
                data-tab-close=""
                // 两处都要拦:click 不拦会顺手把这条 tab 选中(它现在在 tab 里面),
                // pointerdown 不拦会被宿主的拖拽处理器当成「按住这条 tab 要拖」。
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <X className={s.closeIcon} strokeWidth={2} aria-hidden="true" />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
