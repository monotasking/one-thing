import { memo } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Eye,
  Pin,
  PinOff,
  SquareCheck,
  Users,
  Zap,
  type LucideIcon,
} from '../../components/icons'
import { IconButton } from '../../ui/IconButton'
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
 *  ② **每一格 prop 都稳得住** —— 全是原始值(id / 标题 / 形态 / 时间串 / 四个布尔),
 *    四只回调都**入参带 id**,于是调用方能用 `useCallback([])` 把它们钉成常量。
 *    就地闭包 `() => onEnter(row.id)` 每渲染一次换一个身份,memo 当场作废;
 *    少了那一步 memo 是**净负担**(每次都比一遍 props 再照样重渲)。
 * 时间串也在父层算好了递进来:同一屏里两行不该因为渲染差了几毫秒而落进不同的日子。
 *
 * ── 09-04 续:memo 挡得住重渲染,挡不住**第一次**挂载 ──────────────────────
 * 上面那两条治的是「翻一格状态,400 行别跟着重造」。冷开是另一件事:那 400 行
 * 一条也没有,得**全画一遍**,memo 一格都省不掉,于是「一行值多少」直接乘 400。
 * 门量到冷开那一段主线程任务 71–74ms(长帧线 50ms)、端到端 109–113ms
 * (预算 100ms),于是这只组件按「每行少一格」清了四笔:
 *  ① 两颗悬停动作钮 `tip={false}` —— 一行少两只 `ui/Tooltip`(说明见下面那处);
 *  ② `useT()` 拿掉,`t` 由父层递进来 —— 它是一次 zustand 订阅,400 行就是
 *    400 个订阅者挂进同一个 Set,而整棵树的语言只有一份(父层订一次就够);
 *  ③ `scrollIntoView` 那条 effect 上移到 `SessionTree`,按 `activeId` 一条 ——
 *    400 条 effect 里恒有 399 条是「我不是活动行,什么都不做」;
 *  ④ 没有搜索词时不进 `Highlight` 那一层(它此刻画出来的与裸文本逐字相同)。
 * `t` 是 `useT()` 的 `useMemo` 产物、身份随 locale 才变,所以它与那四只回调
 * 一样是**稳得住的 prop**,memo 照旧成立。
 */

/*
 * ── 留账:右键上下文菜单不在本批 ─────────────────────────────────────────
 * 「动作单产地 = 右键上下文菜单」(09-01 判例)对这一行同样成立,但本批**没有**
 * 那张表(重命名 / 删除 / 移到项目 …… 在 React 壳都还没有产地)。所以这里只有
 * 悬停动作那两颗,没有 `onContextMenu` —— 挂一个弹空菜单的右键比不挂更糟。
 */

/**
 * 形态字形 → 图标。`RowGlyph` 的产地是 `expose/row-kinds.ts` 的 `ROW_KIND_SPECS`
 * (能力自述),这里是**渲染层读表**的那一半:加一种形态 = 那张表加一行 +
 * 这里加一格图标,行的结构、键盘、`rowIds` 一个字不动(设计 §6 演练第二条)。
 * `none`(普通聊天)与 `initial`(私聊首字)没有图标 —— 前者留空,后者画字。
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
  isPinned: boolean
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
  /** 当前会话(`aria-selected`,accent 晕)。 */
  current: boolean
  /** 键盘活动行(`aria-activedescendant` 指着的那一条,柔光环)。 */
  active: boolean
  /** 「全部」范围才显项目 chip(设计 §1.1);窄档再由容器查询降掉。 */
  showProject: boolean
  /** 父层那一只 `useT()`(身份随 locale 才变)。见文件头病历第 ② 笔。 */
  t: TFn
  onEnter: (sessionId: string) => void
  onPeek: (sessionId: string) => void
  onTogglePin: (sessionId: string) => void
  onToggleRoom: (sessionId: string) => void
  /**
   * **按住这一行 = 拖它**(W3 裁定 6 / 7)。**入参带 id**,与旁边四只回调同一条
   * 纪律(文件头病历:就地闭包每渲染换一个身份,memo 当场作废)。
   *
   * 拖成什么、落到哪儿由树那一层说了算 —— T4/W5 之前会话**只许落中央**
   * (= 切换当前会话),落别处是结构化拒绝(浮影变灰 + 一句「会话多开在下一期」)。
   * 这一行只递事件,行本身一个字都不动(树 / 面常驻铁律)。
   */
  onDragPointerDown: (sessionId: string, e: ReactPointerEvent<HTMLElement>) => void
}

function SessionRowView({
  id,
  title,
  kind,
  isPinned,
  projectName,
  time,
  query,
  depth,
  level,
  expandable,
  expanded,
  current,
  active,
  showProject,
  t,
  onEnter,
  onPeek,
  onTogglePin,
  onToggleRoom,
  onDragPointerDown,
}: Props) {
  // 「键盘走到视口外的行时把它带回来」那条 effect 在 `SessionTree` 上,按
  // `activeId` 一条(文件头病历第 ③ 笔)—— 它本来就只关心**一行**,长在行上
  // 意味着 400 份同样的判断,而屏幕上活动行只有一条。
  const glyph = rowKindOf(kind).glyph
  const GlyphIcon = GLYPH_ICON[glyph]
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
      aria-level={level}
      aria-selected={current}
      aria-expanded={expandable ? expanded : undefined}
      onClick={() => onEnter(id)}
      onPointerDown={(e) => onDragPointerDown(id, e)}
    >
      {/*
       * 形态图标列:**全行预留**(裁决 6),普通聊天留空 —— 标题永远从同一条
       * 竖线起笔。它是 `<div>` 而不是 `<span>`:契约「`[data-session-id]` 里
       * **第一个 `<span>` 是完整标题**」由 gate-data 按 `querySelector('span')`
       * 读,行首插一个 span 就会把它顶掉。
       */}
      <div className={s.glyph} aria-hidden="true">
        {GlyphIcon && <GlyphIcon className={s.glyphIcon} strokeWidth={1.75} />}
        {glyph === 'initial' && <div className={s.initial}>{firstChar(title)}</div>}
      </div>

      {/*
       * 第一个 span = 完整标题。`Highlight` 只在里面切片,不许把 span 切碎。
       * **没在搜的时候不进那一层**(文件头病历第 ④ 笔):`splitHighlight(text, '')`
       * 交出的就是 `[{text, hit:false}]` 一片,画出来与这里的裸文本逐字相同 ——
       * 差别只在冷开时白挂 400 只组件。一有词就照旧走 `Highlight`(切片、`<mark>`
       * 的产地仍然只有那一处)。
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
       * 悬停动作:**常驻 DOM、只动 opacity**(无位移原则,同旧卡那只眼睛的判例)。
       * 条件渲染会让它出现时挤一下别人,而这里连一像素的位移都不该有。
       * 显形的两个判据:行 `:hover`,以及**键盘活动行**(`[data-active="true"]`)——
       * 键盘的人也要看得见自己能按什么。
       * 两颗都 `tabIndex={-1}`:它们不进 Tab 序(树只有一个 Tab 位),
       * 键盘等价是 Space(Quick Look)与 ⌘⇧P(置顶)。
       *
       * ── `tip={false}` 是**冷开预算**买的(09-04 gate:perf)────────────────
       * `IconButton` 缺省会把自己包进一只 `ui/Tooltip`,而那一只在**没悬停时**
       * 就已经是十来格 hook(3 ref + state + useId + `useFloatPosition` 的
       * ref/state/callback/两条 effect)加一次 `cloneElement`。一行两颗 = 400 行
       * 800 只,它们全部在冷开那一段主线程任务里挂载 —— 实测那一段 71–74ms,
       * 越过 50ms 的长帧线,端到端 109–113ms 越过 100ms 的冷开预算。
       * 摘掉提示是**与旧卡对齐**而不是退步:卡片时代那只眼睛也只有 `aria-label`,
       * 从来没有过提示。`label` 一个字没动,所以读屏念到的仍然是「预览」/「置顶」,
       * 键盘等价(Space / ⌘⇧P)也照旧。展开箭头那一颗本来就是 `tip={false}`。
       * 这一格是**列表专属的例外**,不是把禁令放宽:檐上、状态栏上那些一屏只有
       * 几颗的图标钮照旧带提示。
       */}
      <div className={s.actions}>
        <IconButton
          icon={Eye}
          size="xs"
          tip={false}
          tabIndex={-1}
          label={t('card.preview')}
          testId={`session-row-peek-${id}`}
          onClick={(e) => {
            stop(e)
            onPeek(id)
          }}
        />
        <IconButton
          icon={isPinned ? PinOff : Pin}
          size="xs"
          tip={false}
          tabIndex={-1}
          pressed={isPinned}
          label={t(isPinned ? 'expose.unpin' : 'expose.pin')}
          testId={`session-row-pin-${id}`}
          onClick={(e) => {
            stop(e)
            onTogglePin(id)
          }}
        />
      </div>

      {/*
       * 项目名。类名刻意**不叫** `.chip` / `.card` / `.badge` —— `ui:consume` 的
       * `shared-vocab-css` 那条盯的是「同一个视觉词汇有几个产地」,新面不该再往
       * 那张待收编清单上加一行。
       */}
      {showProject && projectName && <span className={s.project}>{projectName}</span>}

      <span className={s.time}>{time}</span>
    </div>
  )
}

export const SessionRow = memo(SessionRowView)
