import { memo } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  SquareCheck,
  Users,
  Zap,
  type LucideIcon,
} from '../../components/icons'
import { IconButton } from '../../ui/IconButton'
import { OpenDot } from '../../ui/OpenDot'
import type { TFn } from '../../i18n'
import { rowKindOf, type RowGlyph } from '../row-kinds'
import type { SessionKind } from '../types'
import { Highlight } from './Highlight'
import s from './SessionRow.module.css'

/*
 * ── 病历:卡片时代那一记 47.9ms(09-03 probe-hotspots)────────────────────
 * 进一条会话 = `enterSession` 写 `currentSessionId`,列表按窄 selector 订着它,
 * 于是那一格必然翻面 —— 该翻的只有「原来那一行」与「新的那一行」两条,可当时
 * 400 张卡跟着整棵重造,dev profile 里 `SessionCard` total **47.9ms**,是那次
 * 提交里 `/src/` 组件的头一名(比整条消息树的 `MessageRow2` 还重)。
 *
 * 治法两半,缺一不可,原样承继到这一行上:
 *  ① 这只组件是 `memo` 的;
 *  ② **每一格 prop 都稳得住** —— 全是原始值(id / 标题 / 形态 / 时间串 / 布尔),
 *    回调都**入参带 id**,于是调用方能用 `useCallback([])` 把它们钉成常量。
 *    就地闭包 `() => onEnter(row.id)` 每渲染一次换一个身份,memo 当场作废;
 *    少了那一步 memo 是**净负担**(每次都比一遍 props 再照样重渲)。
 * 时间串也在父层算好了递进来:同一屏里两行不该因为渲染差了几毫秒而落进不同的日子。
 *
 * ── 09-04 续:memo 挡得住重渲染,挡不住**第一次**挂载 ──────────────────────
 * 上面那两条治的是「翻一格状态,400 行别跟着重造」。冷开是另一件事:那 400 行
 * 一条也没有,得**全画一遍**,memo 一格都省不掉,于是「一行值多少」直接乘 400。
 * 门量到冷开那一段主线程任务 71–74ms(长帧线 50ms)、端到端 109–113ms
 * (预算 100ms),于是这只组件按「每行少一格」清了四笔:
 *  ① 悬停动作钮 `tip={false}` —— 一行少一只 `ui/Tooltip`(说明见下面那处);
 *  ② `useT()` 拿掉,`t` 由父层递进来 —— 它是一次 zustand 订阅,400 行就是
 *    400 个订阅者挂进同一个 Set,而整棵树的语言只有一份(父层订一次就够);
 *  ③ `scrollIntoView` 那条 effect 上移到 `SessionTree`,按 `activeId` 一条 ——
 *    400 条 effect 里恒有 399 条是「我不是活动行,什么都不做」;
 *  ④ 没有搜索词时不进 `Highlight` 那一层(它此刻画出来的与裸文本逐字相同)。
 * `t` 是 `useT()` 的 `useMemo` 产物、身份随 locale 才变,所以它与那几只回调
 * 一样是**稳得住的 prop**,memo 照旧成立。
 *
 * ── 09-12 方向 A 续:这一行的三笔减法(正本 §3.1)──────────────────────────
 * 用户 09-12 真机报「标题只剩一点」:240px 的架子里标题的净宽只有 **83px(35%)**。
 * 那 157px 是这么花掉的 —— 页边距 16 + `scrollbar-gutter: stable both-edges`
 * 两侧各 10 + **空的形态列 16** + **定宽时间 56** + 行内边距 / 间距 32。
 * 三笔都落在这只组件上,而且三笔都不是「把字变小」:
 *  ① **形态字形只在有字形的行上画**。裁决 6 那条「标题永远从同一条竖线起笔」
 *    在 240px 里是一笔 16px 的空税,而屏幕上大多数行是普通聊天 —— 起笔对齐
 *    换成了「有图标的那几行多让 20px」,这是用户拍的(方向 A 那一台样例就是它);
 *  ② **时间列与项目签只在总览形(≥760)出现**。侧栏形里它们让位给标题 ——
 *    「这条会话什么时候动的」在一张按时间分节的列表里已经由节头说了;
 *  ③ **悬停动作只剩一颗 ⋯**(拍板 3)。眼睛与图钉退役成菜单里的两行,
 *    右键与 ⋯ 弹**同一张表**(09-01「动作单产地 = 右键上下文菜单」)。
 *
 * ── W5-b:右键上下文菜单;09-12:⋯ 与它是同一张表 ─────────────────────────
 * W1 时这里记着一格留账:「本批没有那张表(重命名 / 删除 / 移到项目在 React 壳
 * 都还没有产地),挂一个弹空菜单的右键比不挂更糟」。会话多开把它填上了第一批
 * 真动作,09-12 又把 Quick Look 折了进去。这一行只负责把「哪一条 + 在哪儿」
 * 交出去,菜单由面板那一层弹 —— 一屏至多一张菜单,长在行上就是 400 份。
 */

/**
 * 形态字形 → 图标。`RowGlyph` 的产地是 `expose/row-kinds.ts` 的 `ROW_KIND_SPECS`
 * (能力自述),这里是**渲染层读表**的那一半:加一种形态 = 那张表加一行 +
 * 这里加一格图标,行的结构、键盘、`rowIds` 一个字不动(设计 §6 演练第二条)。
 * `none`(普通聊天)与 `initial`(私聊首字)没有图标 —— 前者**整格不在场**
 * (09-12:不再留那 16px),后者画字。
 */
const GLYPH_ICON: Partial<Record<RowGlyph, LucideIcon>> = {
  room: Users,
  swap: ArrowLeftRight,
  work: SquareCheck,
  agent: Zap,
}

function firstChar(title: string): string {
  // 按码点取而不是 `slice(0, 1)`:emoji / 汉字扩展区是代理对,切一半会画出乱码。
  return Array.from(title.trim())[0] ?? '·'
}

interface Props {
  id: string
  title: string
  kind: SessionKind
  /** 项目名(已由 `projectNameOf` 归一);`null` = 无项目。 */
  projectName: string | null
  /** 相对时间的成品句子(父层一次算好,见文件头病历)。 */
  time: string
  /** 当前搜索词。空串 = 没在搜,`Highlight` 原样返回一片文本(零 `<mark>`)。 */
  query: string
  depth: 0 | 1
  /**
   * `aria-level` —— **由模型给**(`list-model.ListSessionRow.level`),不是这里
   * 拿 `depth + 1` 现算的。09-04 节头成了树的第一级,会话整体下沉一级:
   * 那一格 +1 若留在这只组件里,「树深几层」就有了两个产地。
   */
  level: number
  expandable: boolean
  expanded: boolean
  /** 当前会话(`aria-selected`,accent 晕)= **焦点那片会话叶在看的那条**。 */
  current: boolean
  /**
   * **这一条此刻开着没有**(W5-b 裁定 7:一套判据两处消费)。
   *   `'shown'`  开在某片叶里并显示中 —— 实心点;
   *   `'hidden'` 打开着但被藏起来了 —— 空心点,点它请回来;
   *   `null`     没开 —— 不画。
   *
   * 判据整件是纯函数 `workbench/store.openStateOf`,与文件树行那颗点**同一句话**;
   * 画法整件是库件 `ui/OpenDot`,与那颗点**同一件**。
   *
   * 它与 `current` 是两件事:`current` 说的是「输入框此刻对着谁」(至多一条),
   * 这一格说的是「它在不在屏幕上摆着」(可以有好几条)。
   */
  openState: 'shown' | 'hidden' | null
  /** 键盘活动行(`aria-activedescendant` 指着的那一条,柔光环)。 */
  active: boolean
  /**
   * **这一行的动作菜单此刻开着**(09-12 ③ 交互状态表)。菜单开着时 ⋯ 保持显形
   * —— 否则鼠标一移进菜单、行就不再 `:hover`,那颗刚被点开的钮当场消失,
   * 屏幕上剩一张不知道从哪儿弹出来的菜单。
   */
  menuOpen: boolean
  /** 「全部」范围才显项目签(设计 §1.1);侧栏形再由容器查询整格降掉。 */
  showProject: boolean
  /** 父层那一只 `useT()`(身份随 locale 才变)。见文件头病历第 ② 笔。 */
  t: TFn
  onEnter: (sessionId: string) => void
  onToggleRoom: (sessionId: string) => void
  /**
   * **按住这一行 = 拖它**(W3 裁定 6 / 7)。**入参带 id**,与旁边几只回调同一条
   * 纪律(文件头病历:就地闭包每渲染换一个身份,memo 当场作废)。
   *
   * 拖成什么、落到哪儿由树那一层说了算。这一行只递事件,行本身一个字都不动
   * (树 / 面常驻铁律)。
   */
  onDragPointerDown: (sessionId: string, e: ReactPointerEvent<HTMLElement>) => void
  /** 点空心那颗点 = 把这一份请回它藏起来时那个位置。 */
  onRestore: (sessionId: string) => void
  /**
   * 「这一条的动作表,在这儿弹」。**右键与 ⋯ 走同一口**(09-01 动作单产地):
   * 右键递光标坐标,⋯ 递那颗钮的左下角 —— 两者都是**点锚**(不跟滚),
   * 所以这一格的形状是一个点而不是一个活矩形。
   */
  onMenu: (sessionId: string, point: { x: number; y: number }) => void
}

function SessionRowView({
  id,
  title,
  kind,
  projectName,
  time,
  query,
  depth,
  level,
  expandable,
  expanded,
  current,
  openState,
  active,
  menuOpen,
  showProject,
  t,
  onEnter,
  onToggleRoom,
  onDragPointerDown,
  onRestore,
  onMenu,
}: Props) {
  // 「键盘走到视口外的行时把它带回来」那条 effect 在 `SessionTree` 上,按
  // `activeId` 一条(文件头病历第 ③ 笔)—— 它本来就只关心**一行**,长在行上
  // 意味着 400 份同样的判断,而屏幕上活动行只有一条。
  const glyph = rowKindOf(kind).glyph
  const GlyphIcon = GLYPH_ICON[glyph]
  const hasGlyph = Boolean(GlyphIcon) || glyph === 'initial'
  const stop = (e: ReactMouseEvent) => e.stopPropagation()

  return (
    /*
     * 行是 `<div role="treeitem">` **而不是 `<button>`**(设计 §3.1):树的项由
     * 容器接键,不各占一个 Tab 位 —— 469 条会话就是 469 个 Tab 位,那是「键盘可达」
     * 的反面。所以裸钮三类判在这里不适用(它压根不是 button),而点击语义由
     * `role="treeitem"` 自己承担。
     */
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus --
     * 两条都为 **APG 的 activedescendant 形**让路(设计 §3.1,不是抄近路):
     *  · `click-events-have-key-events` —— 键盘等价物不在这一行上:↵ / Space / ←→
     *    由树容器接(事件委托,见 ExposeView),给每一行再挂一份 onKeyDown 就是
     *    第二个产地,那正是响应链立法要消掉的东西;
     *  · `interactive-supports-focus` —— 树的项**故意不可聚焦**:焦点停在
     *    `role="tree"` 那一个 Tab 位上,由 `aria-activedescendant` 指人。
     *    469 条会话不该是 469 个 Tab 位;规则不认识 activedescendant 这一形。 */
    <div
      role="treeitem"
      id={`expose-row-${id}`}
      className={s.row}
      data-testid={`session-row-${id}`}
      data-session-id={id}
      data-depth={depth}
      data-active={active ? 'true' : undefined}
      data-menu-open={menuOpen ? 'true' : undefined}
      aria-level={level}
      aria-selected={current}
      aria-expanded={expandable ? expanded : undefined}
      onClick={() => onEnter(id)}
      onPointerDown={(e) => onDragPointerDown(id, e)}
      onContextMenu={(e) => {
        e.preventDefault()
        // 点锚(光标坐标)——「点锚不跟滚」那一档,与文件树行的右键同一条裁定。
        onMenu(id, { x: e.clientX, y: e.clientY })
      }}
    >
      {/*
       * 形态字形。**只在真有字形的行上在场**(09-12 拍板,见文件头第 ① 笔)——
       * 普通聊天连这一格都不画,标题直接从盒子的左内缘起笔。
       * 它是 `<div>` 而不是 `<span>`:契约「`[data-session-id]` 里**第一个
       * `<span>` 是完整标题**」由 gate-data 按 `querySelector('span')` 读,
       * 行首插一个 span 就会把它顶掉 —— 条件渲染没有改变这一条,因为它现在
       * 要么不在场、要么仍是一个 `<div>`。
       */}
      {hasGlyph && (
        <div className={s.glyph} aria-hidden="true">
          {GlyphIcon && <GlyphIcon className={s.glyphIcon} strokeWidth={1.75} />}
          {glyph === 'initial' && <div className={s.initial}>{firstChar(title)}</div>}
        </div>
      )}

      {/*
       * 第一个 span = 完整标题。`Highlight` 只在里面切片,不许把 span 切碎。
       * **没在搜的时候不进那一层**(文件头病历第 ④ 笔):`splitHighlight(text, '')`
       * 交出的就是 `[{text, hit:false}]` 一片,画出来与这里的裸文本逐字相同 ——
       * 差别只在冷开时白挂 400 只组件。一有词就照旧走 `Highlight`(切片、`<mark>`
       * 的产地仍然只有那一处)。
       *
       * **不挂 `ui/Tooltip` 报全名**(09-12 拍板,交卷报留账):400 行 400 只
       * Tooltip 是冷开预算否决过的(见文件头第 ① 笔的读数);全名靠 Quick Look
       * 与总览形那一档的宽度。native `title=` 更不行 —— 那是明令禁止的。
       */}
      <span className={s.title}>
        {query ? <Highlight text={title} query={query} /> : title}
      </span>

      {expandable && (
        <IconButton
          icon={expanded ? ChevronDown : ChevronRight}
          size="xs"
          tip={false}
          tabIndex={-1}
          className={s.caret}
          label={t(expanded ? 'expose.collapseRoom' : 'expose.expandRoom', { name: title })}
          testId={`session-row-caret-${id}`}
          onClick={(e) => {
            // 展开不是「进这条会话」:这一下必须在行的 onClick 之前截住。
            stop(e)
            onToggleRoom(id)
          }}
        />
      )}

      {/*
       * **这一条开着没有**(W5-b 裁定 7)。它坐在标题之后、悬停动作之前 ——
       * 与文件树行那颗点同一个相对位置(名字右边、行尾动作左边),一套判据两处消费。
       * 没开时整格不在场:那一格 `margin-left` 是位置,没有点就不该占位。
       */}
      {openState !== null && (
        <span className={s.openDot}>
          <OpenDot
            state={openState}
            label={t('expose.openStateHidden')}
            testId={`session-row-open-${id}`}
            onRestore={() => onRestore(id)}
          />
        </span>
      )}

      {showProject && projectName && <span className={s.project}>{projectName}</span>}

      <span className={s.time}>{time}</span>

      {/*
       * 悬停动作:**一颗 ⋯,常驻 DOM、只动 opacity**(无位移原则,同旧卡那只
       * 眼睛的判例)。条件渲染会让它出现时挤一下别人,而这里连一像素的位移都不该有。
       * 显形的三个判据:行 `:hover`、**键盘活动行**(`[data-active]` —— 键盘的人
       * 也要看得见自己能按什么)、以及**它的菜单正开着**(`[data-menu-open]`)。
       *
       * 它排在时间 / 项目签**之后**是刻意的:动作层绝对定位并带 `z-index`,
       * DOM 顺序在后 + 层级在上 = 它稳稳画在那两格之上(09-12 报障「悬停的
       * 眼睛点不到」的病根正是反过来:`.time { opacity: 0 }` 让时间成了独立
       * 层叠上下文,而它的 DOM 顺序在动作之后 → 透明地盖在钮上面接鼠标)。
       *
       * `tabIndex={-1}`:它不进 Tab 序(树只有一个 Tab 位);键盘走的是
       * ⇧F10 / 菜单键 / 右键那条路。
       *
       * ── `tip={false}` 是**冷开预算**买的(09-04 gate:perf)────────────────
       * `IconButton` 缺省会把自己包进一只 `ui/Tooltip`,而那一只在**没悬停时**
       * 就已经是十来格 hook 加一次 `cloneElement`。它们全部在冷开那一段主线程
       * 任务里挂载 —— 实测那一段 71–74ms,越过 50ms 的长帧线。
       * 而这一颗尤其不该有提示:菜单本身就叫「更多操作」,悬停再弹一句同样的话
       * 是噪音,还会盖在紧挨着的下一行上(与文件树行那颗 ⋯ 逐字同一条判词)。
       * `label` 一个字没省,所以读屏念到的仍然是「更多操作」。
       */}
      <div className={s.actions}>
        <IconButton
          icon={Ellipsis}
          size="xs"
          tip={false}
          tabIndex={-1}
          label={t('expose.rowMenu')}
          testId={`session-row-menu-${id}`}
          onClick={(e) => {
            stop(e)
            const r = e.currentTarget.getBoundingClientRect()
            // 钮的左下角。点锚(不跟滚)—— 与右键那一口同一格形状,
            // 越出视口那一下由 `ui/float` 的 clamp 收回来。
            onMenu(id, { x: Math.round(r.left), y: Math.round(r.bottom) })
          }}
        />
      </div>
    </div>
  )
}

export const SessionRow = memo(SessionRowView)
