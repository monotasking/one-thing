import { useEffect, useRef, type RefObject } from 'react'
import { TriangleAlert } from '../../components/icons'
import { useT } from '../../i18n'
import { useSessionsList, useSessionsSource } from '../../data/sessions-source'
import { useFocusScope } from '../../focus/useFocusScope'
import { SESSIONS_ITEM_ID } from '../../stage/items'
import { useStageStore } from '../../stage/store'
import { formOf } from '../../stage/transitions'
import { useExposeLive } from './use-live'
import { Rail } from './Rail'
import { SessionTree } from './SessionTree'
import { Toolbar } from './Toolbar'
import s from './Overview.module.css'

/**
 * 会话总览的**装配** —— 三块面,从左到右:侧栏(Rail)/ 工具栏(Toolbar)/
 * 列表(SessionTree)。设计 `docs/design/react-shell-sessions-list-2026-09.md` §1。
 *
 * 这只组件自己**不画任何内容**:它只摆位置、开容器查询,以及画那一行
 * 「错误与列表并存」的读数(它必须在滚动容器**外面**,所以留在这一层)。
 * 卡片时代的一切 —— 分组、哨兵、IntersectionObserver、列数换算 —— 随
 * `SessionCard` / `buildGroups` 一起退役。
 */

/**
 * 摆出来的那一刻,键盘归这块面 —— 焦点落进搜索条。
 * 在此之前它归 Dock 上那块瓦(点开面板的那个按钮),于是「刚开完面板按一下空格」
 * 会再次触发那颗按钮、把面板关掉:那是 08-30 用户报的键盘死区的另一半。
 *
 * 判据是**这块面自己被摆出来了**(`placed` 由假翻真,且此刻 live),而不是挂载,
 * 也不是 live 升起 —— 后两者各错各的,理由逐条写在下面那只 effect 上头:
 * 挂载那一刻会被出场动画与搬家骗到;live 那一半会因为隔壁的事翻真。
 * 舞台 ⇄ 浮窗 ⇄ 架子搬家时 `placed` 不变,不会重复抢焦点;架子后台 keep-alive 层
 * interactive 恒为假 —— 看不见的一份不该把光标从别处夺走。
 *
 * 装在渲染 null 的叶子里而不是长在 Overview 身上,是因为 live 随切 tab 翻转:
 * 谁的渲染输出消费它,谁就跟着整棵重渲(08-30 真机画像里的 ~300ms 主项)。
 */
function AutoFocusSearch() {
  const live = useExposeLive()
  const placed = useStageStore((st) => formOf(st, SESSIONS_ITEM_ID) !== 'dock')
  const { activate } = useFocusScope()
  /*
   * **判据是「它自己被摆出来了」,不是「它此刻算数了」**(09-04 S4)。
   *
   * `live = placed × interactive`,而 `interactive` 那一半会因为**隔壁**的事翻真:
   * 右架子上钉着 files 与本面,把 files 撕成浮窗之后本面顺位成了活动 tab —— 那一刻
   * live 升起,但这块面自己一步没动。旧判据在那一形里会把键盘从刚撕出去的那扇窗里
   * 抢回本面的搜索条(真机读数:`activateScope(float-layer, owner=files)` 成功之后
   * **+0.2ms** 就被这一句 `activate('placement')` 顶掉,gate:focus 场景 10 第三步红)。
   *
   * 病根是**两个产地**:「形态落定 → 键盘归谁」全壳只该有一处判(`stage/focus-follow.ts`
   * 那只纯函数,它连「架子切 tab」那一格都算了),这里再算一遍就是重复实现,
   * 而重复的两份在同一次提交里谁赢只看 effect 次序。所以这里只留**它管不着**的那一半:
   * 「这块面被摆出来了」(`placed` 由假翻真 —— 指针从 Dock 点开它的那条路,
   * focus-follow 按设计不跟)。`interactive` 那一半交回 focus-follow 的架子分支。
   *
   * 初值取 `false`:壳一起来时若这块面就是摆出来的,那仍然算一次「被摆出来」,
   * 与改判之前逐字相同。
   */
  const wasPlaced = useRef(false)
  useEffect(() => {
    const justPlaced = placed && !wasPlaced.current
    wasPlaced.current = placed
    // 落焦是 `activate()`,**焦点具体落在哪儿**由这一格作用域的 `restingTarget` 答
    // (还没交接给树就是搜索条 —— 见 ExposeView)。
    if (live && justPlaced) activate('placement')
  }, [live, placed, activate])
  return null
}

export function Overview({ treeRef }: { treeRef: RefObject<HTMLDivElement | null> }) {
  const t = useT()
  const { error } = useSessionsList()
  const sessions = useSessionsSource((st) => st.sessions)

  return (
    <div className={s.overview}>
      <AutoFocusSearch />
      <Rail />
      <div className={s.main}>
        <Toolbar />
        {/*
          ── 错误与列表并存(律②的另一半)────────────────────────────────
          手上还有列表时,这一行只说「这次没拿到,原话是这句」;它不负责把列表
          清掉、也不负责替代列表(手上**一条都没有**的那一档是树里的整块空态)。

          判据用过滤前的 `sessions` 而不是屏幕上那一份:搜不到词的那一屏手上照样
          有列表,那句错该照说。危险色只上图标与字,不铺底、不描边(状态色纪律)。
        */}
        {error && sessions.length > 0 && (
          <p className={s.error} role="status">
            <TriangleAlert className={s.errorIcon} aria-hidden="true" />
            <span>
              {t('expose.disconnectedTitle')}
              {' · '}
              {t('expose.disconnectedHint', { error })}
            </span>
          </p>
        )}
        <SessionTree treeRef={treeRef} />
      </div>
    </div>
  )
}
