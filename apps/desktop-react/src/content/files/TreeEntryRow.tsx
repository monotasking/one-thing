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
 * ── 键盘:⌘I / ⌘↵ 是**面域局部键**(快捷键三层的第二层)──────────────────
 * 它们长在这一行自己的 `keydown` 上 —— 因为「看这一项的详情」需要一个**目标**,
 * 焦点不在某一行上时它无事可做,所以它不属于全局命令那一族。声明在
 * `keymap/scopes.ts` 的 `SCOPED_KEYS`(scope `files.row`),两处会不会分叉由
 * `keymap/__tests__/keymap-scopes.test.ts` 钉着 —— **那条守卫按源文本读这个文件**
 * (9d 把行搬出 FilesPanel 时同批改了它读的路径;两条正则一个字没动)。
 * 裁决靠一条机制:行上接住了就 `preventDefault()`,全局派发器开头一句
 * `if (e.defaultPrevented) return` 让开。
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
  onDetail,
  onMenu,
}: {
  row: EntryRow
  t: TFn
  selected: boolean
  opened: boolean
  onActivate: () => void
  onDetail: (origin: FloatOrigin) => void
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
        onClick={onActivate}
        onKeyDown={(e) => {
          // ⌘I / Ctrl+I = 详情(裁定与留账写在文件头)。⌘↵ 是它从上一版继承下来
          // 的第二个键面,留着不动:删一个已经好使的键位是可感知的能力损失。
          if ((e.key === 'i' || e.key === 'I' || e.key === 'Enter') && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            // 这一行的矩交出去 → 矩锚(贴着左下角隔一条缝)。
            onDetail(wrapRef.current?.getBoundingClientRect())
          }
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
