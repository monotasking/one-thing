import { useRef } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronRight, Ellipsis } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { IconButton } from '../../ui/IconButton'
import type { TFn } from '../../i18n'
import { glyphOf, isHiddenName } from '../../data/file-icons'
import type { TreeRow } from '../../data/files-source'
import { FileGlyphMark } from '../FileGlyph'
import type { FloatOrigin } from '../file-floats'
import s from '../FilesPanel.module.css'

/** 树上真正的一行(骨架行 / 注行是另外两形,它们不是条目)。 */
export type EntryRow = Extract<TreeRow, { kind: 'entry' }>

/**
 * 缩进不写字面 px:深度以无单位数进 CSS 变量,一格多宽由样式表说了算。
 *
 * 它住在这里而不是面板里:缩进是**一行**的几何,骨架行与注行照抄的也是
 * 「条目行那一格缩进」——它们同高同缩进正是窗口化算式成立的前提。
 */
export function depthVar(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

/**
 * 一行 = 一颗按钮(箭头 / 标识 / 名字)+ 两件挂在行尾的东西。
 *
 * 为什么行尾那两件是按钮的**兄弟**而不是它的孩子:`<button>` 里不许再套
 * `<button>`(HTML 明令,而且读屏软件会把内层那颗念丢)。所以外面裹一层 div
 * 管悬停底色与右键,`data-file-*` 那一族仍然挂在**按钮本身**上 —— 门与单测
 * `querySelector('[data-file-path=…]').click()` 走的还是同一条路,一个字不用改。
 *
 * ── 09-01 裁定:**没有双击**,动作全在右键菜单里 ────────────────────────
 * 报障原话是「file 的双击,间隔多久了,还能出现?」。查下去发现两件事:
 *  · 这台壳对「隔多久还算双击」**一个判据都没有** —— 挂的是 `onDoubleClick`,
 *    而 Blink 自己不计时,它只看平台递进来的 `clickCount` 是不是 2;那个数在
 *    macOS 上由 AppKit 按**系统偏好里的「双击速度」**算,滑杆调慢就没有上限;
 *  · 更要命的是**触控板双指点按到达时就是双击形态**,与右键语义正面打架 ——
 *    用户想开右键菜单,得到的是详情浮层。
 * 用户的裁定不是「把窗口收紧」,是**整条删掉**:打开 = 单击 / ↵,动作 = 右键菜单,
 * 详情不再设双击入口(它的两个入口是 ⌘I 与右键菜单里的那一行)。
 * CLAUDE.md 禁令区「禁双击作为动作触发」就是这条判例。
 *
 * 于是这一行上只剩两种手势:**单击 = 打开 / 展开**,**右键(或行尾 ⋯)= 动作菜单**。
 *
 * ── 单击与 ↵ 的差别只有一件事:**焦点去哪**(09-03 R2,§11 拍点 1 的 (a) 档)──
 * 两者都打开那份文件;单击**焦点留在树上**(浏览器自己把焦点落在这颗按钮上,
 * 这一行一个字都不用做),↵ 额外把焦点送进查看器 —— 「导航器里浏览不抢焦点,
 * 确认才抢」(VS Code / Finder 惯例)。这一行只负责说清楚「这一下是哪种手势」
 * (`onActivate(viaKeyboard)`),**焦点送到哪儿由面板那一层用 `activateScope`
 * 去问树** —— 查看器此刻可能在面板分栏里、也可能在舞台 / 浮窗 / 架子上,
 * 一行文件树不该知道那件事。
 *
 * ── 键盘:⌘I / ⌘↵ **不在这一行上了**(09-03 R2)────────────────────────────
 * 它们仍然是面域局部键(「看这一项的详情」需要一个目标,所以不属于全局那一族),
 * 但落点从这一行自己的 `keydown` 搬到了**面板那一格作用域**的 `keyHandlers`:
 * 声明在 `focus/scopes.ts` 的 `FOCUS_SCOPES.files.keys`,路由由响应链按活动路径
 * 的深度做(设计 §4.3),裁决仍是「局部先接、没接住放行全局」——只是那个「先」
 * 不再靠冒泡序。
 *
 * 这一行于是只剩**报到**:拿到焦点时把自己交给面板(`onCurrent`),失去时销号。
 * 「哪一行」这个问题必须有人答,而答案不许是 `document.activeElement`
 * (设计 §7「谁都不许」的第三条)——这一行本来就是焦点真的落在上面的那一族,
 * 所以由它逐行报,比全局查一次更准也更便宜。
 *
 * ── 三张状态表(状态先行)────────────────────────────────────────────────
 *  ① 生命周期:纯受控件,零 store 订阅、零副作用(只有一颗量矩用的 `wrapRef`)。
 *     `key` 是 `row.path`(面板那一侧给),所以展开 / 收起 / 开文件都不重挂它 ——
 *     「树不卸载」那三条断言钉的正是这件事。
 *  ② UI 生命状态:无。一行**永远有内容**(它是从已经读回来的目录项摊出来的);
 *     「还没有内容」的三档(骨架 / 空 / 失败)是另外两形的行,不在这件里。
 *  ③ UI 交互状态:
 *     rest      —— 底透明;⋯ `opacity: 0`(不占位地藏着,悬停才露面)
 *     hover     —— `.rowWrap:hover` 换底;⋯ 露面
 *     focus     —— 全局 `:focus-visible` 环(行按钮 / ⋯ 各自一圈,不自绘)
 *     selected  —— `.rowSel` 底色(此刻手指头点在哪一行)
 *     opened    —— 行尾一颗 accent 圆点(**与选中是两件事**:可以选中 A 而开着 B)
 *     hidden    —— `.rowHidden` 整行淡显(判据在 `data/file-icons` 的 isHiddenName)
 *     disabled  —— 无。一行永远可点。
 */
export function TreeEntryRow({
  row,
  t,
  selected,
  opened,
  onActivate,
  onCurrent,
  onMenu,
}: {
  row: EntryRow
  t: TFn
  selected: boolean
  opened: boolean
  /**
   * 打开 / 展开这一项。`viaKeyboard` = 这一下是**↵ 按出来的**,不是鼠标点的 ——
   * 「导航器里浏览不抢焦点,确认才抢」(§3.5 规则 4 / §11 拍点 1 的 (a) 档)
   * 全靠这一格分开两种手势,判据在按下去的那一刻就有,不必事后猜。
   */
  onActivate: (viaKeyboard: boolean) => void
  /**
   * 焦点进 / 出这一行。`el` 是这一行的**外框**(浮层贴的是它的矩,与右键那一路
   * 同一处锚点算式);交出 null = 焦点离开了这一行。
   */
  onCurrent: (row: EntryRow, el: HTMLElement | null) => void
  onMenu: (origin: FloatOrigin) => void
}) {
  const Caret = row.expanded ? ChevronDown : ChevronRight
  const glyph = glyphOf(row.name, row.type, row.expanded)
  const hidden = isHiddenName(row.name)
  const wrapRef = useRef<HTMLDivElement>(null)

  /*
   * 这一行交出去的是**来源**(一块矩 / 一次指针事件),不是算好的坐标。
   *
   * 09-02 批 9d 的真机前后对照当场量出过这条:先在这里 `anchorBelow(rect)` 算一遍、
   * 再交给 `openDetailAt` 又算一遍,详情就多隔了一条缝(右键那一路同样多隔一条)。
   * **锚点算式只有一处产地**(`content/file-floats`),这一行只负责说清楚
   * 「浮层是从哪儿长出来的」——矩锚还是点锚由那件按形状判,不由这里预先拍板。
   */
  const cls = [s.rowWrap, selected && s.rowSel, hidden && s.rowHidden].filter(Boolean).join(' ')

  return (
    <div
      ref={wrapRef}
      className={cls}
      style={depthVar(row.depth)}
      onContextMenu={(e: ReactMouseEvent) => {
        e.preventDefault()
        // 指针事件原样交出去 → 点锚(光标那一点就是落点,不加缝)。
        onMenu(e)
      }}
      /*
       * 焦点进 / 出**这一行**(含行尾那颗 ⋯:它也在这一行里,⌘I 该作用在同一行)。
       * React 的 onFocus / onBlur 底下是 focusin / focusout,会冒泡 —— 所以挂在
       * 外框上一处就够,不必每颗控件各挂一遍。
       */
      onFocus={() => onCurrent(row, wrapRef.current)}
      onBlur={() => onCurrent(row, null)}
    >
      {/*
       * 一行是**结构件**(视觉本该定制:缩进、标识槽、名字),所以它消费
       * `ui/ButtonBase`(只清 UA)而不是 `ui/Button` —— 套一颗 ghost 钮上来,
       * 27 高的紧凑树当场变成一列按钮。
       */}
      <ButtonBase
        className={s.row}
        aria-expanded={row.type === 'directory' ? row.expanded : undefined}
        /* 门用的稳定选择器(与 EdgeShelf 的 data-shelf / data-panel 同一条判例):
         * 文案会跟着语言变,路径不会。标识也留两格 —— 「这一行画的是哪一枚」
         * 是可断言的事实,而 SVG 里的 path 数据不是。 */
        data-file-path={row.path}
        data-file-type={row.type}
        data-file-depth={row.depth}
        data-file-form={glyph.kind}
        data-file-icon={glyph.kind === 'icon' ? glyph.icon : undefined}
        data-file-tone={glyph.kind === 'icon' ? glyph.tone : undefined}
        data-file-brand={glyph.kind === 'brand' ? glyph.brand : undefined}
        data-file-hidden={hidden ? 'true' : undefined}
        data-file-open={opened ? 'true' : undefined}
        data-file-selected={selected ? 'true' : undefined}
        onClick={() => onActivate(false)}
        /*
         * ── ↵:开文件**并且**把焦点送进查看器(§11 拍点 1)────────────────
         * 一颗 `<button>` 上的 ↵ 本来就会合成一次 click,所以这里必须
         * `preventDefault()` 把那一次挡掉 —— 不挡就开两遍(目录那一行更明显:
         * 展开又收起,等于按了个寂寞)。挡掉之后由这一句自己叫,并且告诉面板
         * 「这是键盘那条路」。
         *
         * **带修饰键的 ↵ 不算**:⌘↵ 是面域局部键(详情),归那唯一的派发器;
         * 它已经 `preventDefault` 过了,这里再接一次就会**同时**开详情和开文件。
         */
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
          e.preventDefault()
          onActivate(true)
        }}
      >
        {row.type === 'directory' ? (
          <Caret className={s.caret} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          // 文件没有箭头,但**位子留着** —— 不留,同一层的文件名就会比目录名靠左一截。
          <span className={s.caret} aria-hidden="true" />
        )}
        <FileGlyphMark glyph={glyph} className={s.glyph} />
        <span className={s.rowName}>{row.name}</span>
      </ButtonBase>
      {/*
       * 「这个文件正开着」。它与选中态是两件事,所以是两处画法(圆点 vs 底色)。
       * **不迁 `ui/StatusDot`**(9b 记的判,9d 复核后维持):那件画的是三档
       * 语义状态色(ok / warn / danger),而这一颗画的是 `--accent`,说的是
       * 「正开着」——它是一处**指认**,不是一格状态。
       */}
      {opened && <span className={s.openDot} data-testid="files-open-dot" aria-hidden="true" />}
      {/*
       * 行尾的 ⋯。**消费 ui/IconButton**(09-01 立法:图标钮必须用库件)——
       * 从前它是一颗自绘的 `.more`,hover 配方与别处各写各的,正是那条法的判例。
       * `tip` 关掉:菜单本身就叫「更多操作」,悬停再弹一句同样的话是噪音,
       * 而且它盖在紧挨着的下一行上。
       */}
      <IconButton
        icon={Ellipsis}
        size="xs"
        label={t('files.rowMenu')}
        tip={false}
        className={s.more}
        /* 稳定取件口。从前是 `data-file-more={path}`(自绘钮上的一个自定义属性);
         * 换库件之后走库件那一格 `testId`,值仍然带着路径 —— 门与单测要的是
         * 「按这一行取它的 ⋯」,那一格叫什么名字不是它们关心的事。 */
        testId={`files-more:${row.path}`}
        onClick={() => onMenu(wrapRef.current?.getBoundingClientRect())}
      />
    </div>
  )
}
