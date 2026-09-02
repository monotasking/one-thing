import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { ChevronDown, ChevronRight, Plus, Search, TriangleAlert } from '../../components/icons'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import { useAsyncPending } from '../../data/kernel'
import { CREATE_KEY, sessionMutation, useSessionsList, useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../store'
import { useFocusScope } from '../../focus/useFocusScope'
import { useExposeLive } from './use-live'
import { columnsFromTemplate, filterGroups, isCollapsed } from '../transitions'
import { Highlight } from './Highlight'
import { SessionCard } from './SessionCard'
import s from './Overview.module.css'

/**
 * ── F 批:搜索是过滤器,不是第四层视图 ────────────────────────────────────
 * 输入搜索词之后屏幕**仍是这一套**:项目头 + 会话卡网格,和默认打开时逐像素相同。
 * 变的只有内容 —— 不命中的卡消失、变空的组消失、命中词在卡与组头上高亮。
 *
 * 所以这个组件里**一次 filter 都没有**:过滤是 `expose/transitions.ts` 的
 * `filterGroups`(纯函数,可单测),这里只是把它的结果画出来。同一个纯函数也被
 * `visibleCardIds` 用着,于是「屏幕上有哪些卡」与「方向键 / Quick Look 走哪些卡」
 * 天生是同一份事实,不会漂移。
 *
 * 退役的是 `SearchResults`(三层缩进的命中列表)—— 它是「搜索换一种呈现」那条路
 * 的全部实现,连同它的 CSS 与 `SearchHit` 形状一起删了。
 */
/**
 * 摆出来的那一刻,键盘归这块面 —— 焦点落进搜索条。
 * 在此之前它归 Dock 上那块瓦(点开面板的那个按钮),于是「刚开完面板按一下空格」
 * 会再次触发那颗按钮、把面板关掉:那是 08-30 用户报的键盘死区的另一半。
 *
 * 判据是 live(placed × interactive,见 use-live.ts)升起,而不是挂载:
 * 舞台 ⇄ 浮窗 ⇄ 架子搬家时它不变,不会重复抢焦点;架子后台 keep-alive 层
 * interactive 恒为假 —— 看不见的一份不该把光标从别处夺走。
 *
 * 装在渲染 null 的叶子里而不是长在 Overview 身上,是因为 live 随切 tab 翻转:
 * 谁的渲染输出消费它,谁就跟着整棵重渲 —— Overview 消费它的话,439 张卡每次
 * 切换全量重造(08-30 真机画像里的 ~300ms 主项)。叶子翻转,卡树不动。
 */
function AutoFocusSearch() {
  const live = useExposeLive()
  const { activate } = useFocusScope()
  useEffect(() => {
    // 摆出来那一刻把键盘交给这块面:落焦是 `activate()`,**焦点具体落在哪儿**
    // 由这一格作用域的 `restingTarget` 答(还没交接给网格就是搜索条)。
    if (live) activate('placement')
  }, [live, activate])
  return null
}

/**
 * 「一行几张」的产地:**读 CSS 的计算值**,不在 JS 里重算一遍 auto-fill 的公式。
 * 两份公式就是两份真相,迟早对不上;这里只做「量一眼再报进状态机」。
 *
 * 量的时机 = 容器尺寸变了(ResizeObserver)+ 组数变了(网格可能刚出现 / 刚消失)。
 * jsdom 没有 ResizeObserver、getComputedStyle 也算不出网格轨道,
 * 所以两处都是「量不到就不动状态」—— 单测里列数保持出厂值,不会被环境噪声改写。
 */
function useGridColumns(
  hostRef: RefObject<HTMLElement | null>,
  report: (columns: number) => void,
  groupCount: number,
) {
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => {
      const grid = host.querySelector<HTMLElement>('[data-grid]')
      if (!grid) return
      const columns = columnsFromTemplate(getComputedStyle(grid).gridTemplateColumns)
      if (columns !== null) report(columns)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [hostRef, report, groupCount])
}

/**
 * ── 08-30 方向 A「隐形组头」的 JS 那一半 ─────────────────────────────────────
 * 组头默认全透明(与容器无缝一色),**粘住了才显影**成一层毛玻璃 + 下缘细线。
 * 麻烦在于 CSS 至今没有 `:stuck` —— `position: sticky` 生效与否,样式表问不出来。
 *
 * 通行的补法就是这枚 1px 哨兵:把它摆在每个组的最顶(组头原本待的位置),
 * 用 IntersectionObserver 以滚动容器为 root 看着它。哨兵还在视口里 = 组顶还没到
 * 容器上缘 = 组头是普通流内元素;哨兵滚出去了 = 组头正粘在上缘挡着卡。
 * threshold 1 而不是 0:要的是「完整露着」这一刻翻,不是「露出一丝」。
 *
 * 判出来的结果**不进 React state**,直接落在组头的 data-stuck 上。理由与本文件
 * 上面那几条同源:滚动中每一次粘 / 脱粘都 setState 的话,439 张卡跟着重渲一遍,
 * 而这件事从头到尾只是一个属性。React 不拥有这个属性,也就不会在重渲时把它抹掉;
 * 组列表变了(过滤 / 增删 / 重分组)effect 重跑,IO 重新观察时会为每个目标补发一次
 * 初始回调,状态自己对回来。
 *
 * jsdom 没有 IntersectionObserver —— 这里的 typeof 判据不是防御性编程,是那条门:
 * 量不到就一格不动(与本文件 useGridColumns 的 ResizeObserver 同一口径),
 * 单测里组头保持出厂的「不粘」态,不会被环境噪声改写。要验的用例自己摆一份假的。
 */
function useStuckHeads(scrollRef: RefObject<HTMLElement | null>, groupKey: string) {
  useEffect(() => {
    const root = scrollRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // 哨兵是组的第一个孩子(绝对定位,不占位),组头就是它的下一个兄弟。
          const head = entry.target.nextElementSibling as HTMLElement | null
          if (!head) continue
          if (entry.isIntersecting) head.removeAttribute('data-stuck')
          else head.setAttribute('data-stuck', '')
        }
      },
      { root, threshold: 1 },
    )
    for (const sentinel of root.querySelectorAll('[data-sentinel]')) observer.observe(sentinel)
    return () => observer.disconnect()
  }, [scrollRef, groupKey])
}

export function Overview({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }) {
  const t = useT()
  /**
   * 只订阅画面真正消费的五个字段,**不整仓订阅**(08-30 真机画像的第二记):
   * `useExposeStore()` 不带 selector 时,store 每 notify 一次这里就整棵重渲一次 ——
   * 而切回这个 tab 时 open() 归位必然 notify(它总是造新 state 对象),即使
   * 归位后每个值都没变,439 张卡也要全量重造(dev ~260ms)。按字段选,
   * Object.is 相等就地短路:值没变的归位一格不重画;真变了(比如清了搜索词)
   * 才付一次该付的重渲染。动作一律走 `useExposeStore.getState()`(引用稳定,
   * 事件处理器里取用,与 ExposeView 的键盘处理同一口径)。
   */
  const query = useExposeStore((st) => st.query)
  const collapsedGroups = useExposeStore((st) => st.collapsedGroups)
  const currentSessionId = useExposeStore((st) => st.currentSessionId)
  const focusId = useExposeStore((st) => st.focusId)
  const focusVisible = useExposeStore((st) => st.focusVisible)
  const setColumns = useExposeStore((st) => st.setColumns)
  const allGroups = useSessionsSource((st) => st.groups)
  /*
   * 「读到哪一步了」读的是列表那一格 query 的快照,不再是 store 上一个压扁的
   * `status`(7e)。两个读数**正交**,各画各的:
   *  · `phase === 'initial'` = 从来没有过列表 → 只有这时候画「正在读」;
   *    一旦有过就永远是 ready,重拉时屏幕上那份留着(律②),不退回等待态;
   *  · `error` = 最近一次没拿到的原话,**与列表并存**(见下面那行 errorLine)。
   */
  const list = useSessionsList()
  const { phase, error } = list
  /*
   * 建会话正在飞吗 —— 逐格读数(键 = `CREATE_KEY`),不是整面的忙布尔。
   * 组头那颗 `+` 据它上 `aria-busy` 并挡住第二发(律③)。
   */
  const creating = useAsyncPending(sessionMutation, CREATE_KEY)
  /*
   * 搜索条那一格 ref **由 `ExposeView` 持有**(R2):它是这块面那一格作用域的
   * **落点**,而落点是作用域的声明,不是某个子组件的私产。这里只负责把它铺上去。
   */
  const inputRef = searchRef
  const innerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searching = query.trim().length > 0

  const groups = useMemo(() => filterGroups(allGroups, query), [allGroups, query])
  /** 这块面住在总览那一格作用域里(`ExposeView` 铺的根),所以拿到的是它的句柄。 */
  const { activate } = useFocusScope()

  useGridColumns(innerRef, setColumns, groups.length)
  /* 依赖是**组的身份表**而不是 groups.length:过滤把「三组」换成另外「三组」时
   * 长度没变、哨兵却全换了一批,只盯长度的话新哨兵一个都没被观察。 */
  useStuckHeads(scrollRef, groups.map((g) => g.id).join('|'))

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    /*
     * ↑↓ = 把键盘交给卡网格(词留着、输入框失焦),之后方向键 / 空格 / 回车
     * 就都是总览那一套了。这是命令面板的通行手势(搜索条在上、结果在下)。
     *
     * ←→ **故意不接**:它们在一个还在编辑的输入框里是移光标,是文本编辑的基本盘;
     * 为了「网格是二维的」把它抢走,代价是搜索条里没法改词。所以口径定成:
     * 纵向交接、横向留给光标 —— 交接之后焦点在网格上,四个方向才一起归导航。
     */
    /*
     * ui-consume-allow: kbd-select-handwritten —— 这里**没有一份走行**可迁。
     * 规则的判据是「文件里出现 'ArrowDown' 字面量却没 import a11y 原语」,
     * 而这块面里那两个字面量的全部工作是 `focusGrid() + blur()`:把键盘交给网格,
     * 一格下标都不动(用例逐字钉着 ——「交接那一下只点亮锚点,不顺手再走一步」)。
     * 真正的走行在 ExposeView 上,那是**二维网格**(←→↑↓ 四向 + 按列宽换行),
     * 与 useListSelection 管的一维候选列表不是同一种形,迁法要单独设计,
     * 它自己也仍在别批的避让区里 —— 所以本批不硬迁,如实记一笔。
     */
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      /*
       * 把键盘交给卡网格。**两句话是一件事**:`focusGrid()` 让键盘位显形
       * (`focusVisible`),`activate()` 把焦点从搜索条挪到这块面的根上 ——
       * 因为落点那一格正是按 `focusVisible` 分档的(见 ExposeView)。
       *
       * 从前这里是 `inputRef.current?.blur()`:焦点掉到 body。R1 之后孤儿焦点
       * 会被收回落点,那一手会让焦点**弹回搜索条**,于是接着按 ↓ 又被「输入面里
       * 的无修饰单键」那条规则让给输入框,网格纹丝不动。
       */
      useExposeStore.getState().focusGrid()
      activate('programmatic')
      return
    }
    if (e.key !== 'Enter') return
    // 回车 = 进入**屏幕上第一张卡**。它就是过滤后的阅读次序的头一个,
    // 不再有第二套「命中排序」—— 看到什么,回车就进什么。
    const st = useExposeStore.getState()
    const first = groups.find((g) => !isCollapsed(st, g.id))?.sessions[0]
    if (first) {
      e.preventDefault()
      st.enterSession(first.id)
    }
  }

  /**
   * 分组区的四种「没有卡」。它们不是同一件事,所以不共用一句文案:
   * 搜不到 / 还在读 / 读失败(浏览器直开或 core 没起来)/ 真的一条会话都没有。
   * **一律不回退到 mock** —— 假数据比空更糟。
   */
  function renderGroups() {
    if (groups.length > 0) {
      return groups.map((group) => {
        // 同一份事实:isCollapsed 的判据就是 collapsedGroups,这里读的是订阅到的那份切片。
        const collapsed = collapsedGroups.includes(group.id)
        // 组名 / 副名两种来源:合成组给 key(界面文案),项目组给数据。
        const name = group.nameKey ? t(group.nameKey) : group.name
        const path = group.pathKey ? t(group.pathKey) : group.path
        const Caret = collapsed ? ChevronRight : ChevronDown

        /*
         * 折叠 / 展开是**原地形变**:组头这一行(以及它里面的开关按钮)在两态里
         * 是同一个 DOM 节点、同一个位置、同一个高度,只有下面的卡片区在条件渲染。
         * 组的次序永远只由数据源决定,不因为谁被折叠而重排 ——
         * 这两条合起来才保证「鼠标不动连点 N 次 = 精确切换 N 次」。
         */
        return (
          <section key={group.id} className={s.group}>
            {/*
             * 「组头粘住了没有」的哨兵。每组一枚,永远是组的第一个孩子 ——
             * useStuckHeads 靠 nextElementSibling 从它找到组头,这条相邻关系是契约。
             * aria-hidden + 绝对定位:读屏读不到它,布局也一格不占。
             */}
            <div className={s.sentinel} data-sentinel={group.id} aria-hidden="true" />
            <header className={s.groupHead} data-testid={`group-head-${group.id}`}>
              {/* 组头开关是**通栏的一行**(caret + 组名 + 路径),视觉本该定制 ——
                * 裸钮三类判第③类,消费 `ui/ButtonBase` 只清 UA,皮肤一个像素不动。 */}
              <ButtonBase
                className={s.groupToggle}
                data-testid={`group-toggle-${group.id}`}
                aria-expanded={!collapsed}
                onClick={() => useExposeStore.getState().toggleGroupCollapsed(group.id)}
              >
                <Caret className={s.caret} strokeWidth={1.75} aria-hidden="true" />
                {/* 组名也高亮:项目名命中时整组保留,不高亮就看不出这一组为什么还在。 */}
                <span className={s.groupName}>
                  <Highlight text={name ?? group.id} query={query} />
                </span>
                <span className={s.groupPath}>{path}</span>
              </ButtonBase>
              {/*
               * 进组入口。**数字没了** —— 08-30 用户拍板的计数禁令:tab / 列表 / 分组头
               * 一律不带个数。原来这里是一颗写着「N sessions」的按钮,既是入口也是徽记;
               * 拿掉数字之后入口还得在,于是换成组头右端的幽灵「›」:常驻占位(不动布局)、
               * hover / 键盘聚焦才显形,与卡片右上角那只 QuickLook 眼睛是同一条判例。
               *
               * aria-label 用**组名本身**:本批禁改 i18n(另一批在同仓施工),
               * 字典里没有一句「进入某组」够用的话。留账:i18n 批应补
               * `expose.enterGroup`,补上之后把这里换成 t('expose.enterGroup', { name })。
               */}
              <Button
                variant="ghost"
                pill
                iconOnly
                className={s.enter}
                data-testid={`group-enter-${group.id}`}
                aria-label={name ?? group.id}
                onClick={() => useExposeStore.getState().enterList(group.id)}
              >
                <ChevronRight className={s.enterIcon} strokeWidth={1.75} aria-hidden="true" />
              </Button>
              {/*
               * 在这一组下新建会话。D1 开工批之前它是个空壳(有按钮、没有 onClick)。
               *
               * 「这一组」→「哪个项目」的映射就是 `group.projectId`
               * (expose/projection.ts 里唯一那份分组判据):项目组给出目录,
               * 协作组与独立会话组是 null。
               *
               * **留账(协作组)**:协作组的 + 建出来的是一条普通会话,它会落进
               * 「独立会话」组而不是协作组 —— 建房要 `kind:'room'` 加一份成员名册
               * (`@shared/ipc/chat.ts` 的 `CreateSessionOptions.room`),那是一次
               * 独立的入口设计,不在本批。要么后续给协作组换一个建房入口,
               * 要么把它的 + 收掉;**在拍板之前不擅自隐藏**(见 08-18 判例)。
               */}
              <Button
                variant="ghost"
                pill
                iconOnly
                className={s.plus}
                data-testid={`group-plus-${group.id}`}
                aria-label={t('expose.newSessionIn', { name: name ?? group.id })}
                /*
                 * 律③:反馈长在**发起它的那个控件**上。这一格今天只上无障碍语义
                 * (`aria-busy`)—— **零新像素**:这颗钮的几何与配色一个字不动。
                 * 不用 `disabled`,因为「在飞」不是「不可用」:禁灰会把它从焦点序
                 * 里摘掉,键盘走到一半的人当场丢焦点。
                 */
                aria-busy={creating || undefined}
                onClick={() => {
                  // 二次闸:飞着的时候再按几下都当没按(⌘N 长按的自动重复同理,
                  // 那条路的闸在 `expose/store.newSession` 里,判的是整段编排)。
                  if (creating) return
                  void useExposeStore.getState().newSession(group.projectId)
                }}
              >
                <Plus className={s.plusIcon} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </header>

            {/*
              折叠 = 高度过渡而非瞬跳(用户 08-28 实机反馈:卡区瞬间消失、下方组咣当上移,变化不连续)。
              grid-template-rows 1fr→0fr 技法:卡区保持挂载,收合时下方内容连续滑上来;
              inert 把折叠态的卡从焦点序/命中区里摘掉(视觉隐藏 ≠ 可交互)。
            */}
            <div className={collapsed ? `${s.body} ${s.bodyClosed}` : s.body} inert={collapsed || undefined}>
              <div className={s.bodyInner}>
                <div className={s.grid} data-grid>
                  {group.sessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      query={query}
                      current={session.id === currentSessionId}
                      focused={focusVisible && session.id === focusId}
                      onEnter={() => useExposeStore.getState().enterSession(session.id)}
                      onQuickLook={() => useExposeStore.getState().openQuickLook(session.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>
        )
      })
    }

    /*
     * 搜不到 ≠ 没有会话:这里有会话,只是没有一条配得上这个词。
     * 一行灰字就够 —— 插画会把「我打错了一个字」演成一场事故。
     */
    if (searching) {
      return <p className={s.noMatch}>{t('expose.noMatchingSessions')}</p>
    }

    /*
     * 手上**一条列表都没有**时,那句错就是这块面的全部内容 —— 整块空态说全话
     * (标题 + 原文)。手上有列表的那一档不走这里:它是表头下面那一行
     * `errorLine`,与列表并存(7e 规范修正,见 render 里那段)。
     */
    if (error) {
      return (
        <div className={s.state}>
          <span className={s.stateTitle}>{t('expose.disconnectedTitle')}</span>
          <span className={s.stateHint}>
            {t('expose.disconnectedHint', { error })}
          </span>
        </div>
      )
    }
    // 骨架 / 等待只看 `phase`(律①):从来没有过列表才算「还在读」。
    if (phase === 'initial') {
      return (
        <div className={s.state}>
          <span className={s.stateHint}>{t('expose.loading')}</span>
        </div>
      )
    }
    return (
      <div className={s.state}>
        <span className={s.stateTitle}>{t('expose.emptyTitle')}</span>
        <span className={s.stateHint}>{t('expose.emptyHint')}</span>
      </div>
    )
  }

  return (
    <div className={s.overview}>
      <AutoFocusSearch />
      <header className={s.top}>
        <div className={s.searchWrap}>
          <Search className={s.searchIcon} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            className={s.search}
            value={query}
            onChange={(e) => useExposeStore.getState().setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t('expose.searchPlaceholder')}
            aria-label={t('expose.searchLabel')}
          />
        </div>
        <Button variant="ghost" pill className={s.newProject}>
          <Plus className={s.newIcon} strokeWidth={1.75} aria-hidden="true" />
          {t('expose.newProject')}
        </Button>
      </header>

      {/*
        ── 7e 规范修正(勘察偏离 5 结掉)──────────────────────────────────
        **错误与列表并存**(律②的另一半):手上还有列表时,这一行只说
        「这次没拿到,原话是这句」,它不负责把列表清掉、也不负责替代列表。

        从前这块面只有一种画法 —— 整块「没连上 core」空态,而它排在
        `renderGroups()` 的「有卡就画卡」后面,于是**有列表时那句错永远画不出来**
        (分支顺序把它遮住了)。形照 `providers/ModelCatalog` 表头下面那一行:
        危险色只上图标与字,不铺底、不描边(规范画布状态色纪律)。

        判据用 `allGroups`(过滤前)而不是 `groups`:搜不到词的那一屏手上照样
        有列表,那句错该照说。文案复用这块面既有的两个键,零新键。
      */}
      {error && allGroups.length > 0 && (
        <p className={s.error} role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            {t('expose.disconnectedTitle')}
            {' · '}
            {t('expose.disconnectedHint', { error })}
          </span>
        </p>
      )}

      {/*
       * data-testid 是给真机门的**稳定选择器**(同 ListView 那一枚):CSS Modules
       * 的类名构建后是哈希,门不能按它找人。挂在滚动容器上而不是某张卡上,
       * 是因为工作区门要问的是「换世界有没有把这棵树掀了」—— 卡会换、组会换,
       * 而这个容器**必须**是同一个节点(四律第 4 条:禁整树重挂)。
       */}
      <div className={s.scroll} ref={scrollRef} data-testid="expose-overview-scroll">
        <div className={s.inner} ref={innerRef}>{renderGroups()}</div>
      </div>
    </div>
  )
}
