import { ButtonBase } from '../../ui/ButtonBase'
import { OpenDot } from '../../ui/OpenDot'
import { useRowWindow } from '../files/useRowWindow'
import type { GitChangedFile, GitFileStatus } from '../../data/changes-source'
import type { MessageKey } from '../../i18n'
import s from './ChangesPanel.module.css'

/**
 * **改动文件列**(「改动」面,正本 §3.4)。
 *
 * 一行三件:状态字母 · 路径(目录淡、文件名实)· ±数字。
 *
 * ── 状态色只上字母,不上底 ──────────────────────────────────────────────
 * 一列全是带底色的行会读成「每一行都出事了」,而这一列里每一行**本来就都变了**
 * —— 底色在这儿说不出任何区别。所以配方与 `Diff.module.css` 同源:底色留给
 * diff 体里那一行行的增删(那里它区分的是 add 与 del),这里只有那一枚字母吃
 * `--ok` / `--danger` / `--warn` 三枚**满饱和**状态色。
 *
 * ── 窗口化 ──────────────────────────────────────────────────────────────
 * 复用 `files/useRowWindow`(量视口 + 跟卷轴那一半,与文件无关的纯量测)。前提
 * 与文件树逐字相同:**行高恒定**。所以这一列里没有任何一行会因为内容长而变高
 * —— 长路径省略号、长的 ± 数字也只是字更宽。
 *
 * ── 为什么行是 `<button>` 而不是 `role="option"` ────────────────────────
 * 与 `files/TreeEntryRow` 同一条:一行**就是**一颗「打开这个文件的改动」的钮
 * (单击 / ↵ 都是它),而 roving 的当前项(`ui/a11y/list-selection`)说的是「键盘位」。
 * 两者同屏:键盘位画 `--st-sel`,鼠标经过画 `--st-hover` —— 那正是那只原语头上
 * 「hover 只是 hover,不许影响 select」立的形。
 *
 * ── 批⑤:单击就是打开;**双击退役**;右键出菜单;行尾多一颗开态点 ────────────
 * 从前单击只落位、双击才打开 —— 而壳的禁令区写着「禁双击作为动作触发」(macOS
 * 触控板双指点按以双击形态到达,与右键语义打架)。批⑤ 把打开这件事收进**单击
 * 与 ↵ 同一条路**(与目录面板 `TreeEntryRow.onActivate(viaKeyboard)` 逐字同形),
 * 双击那一格整只删掉。
 *
 * 打开之后「选中」与「打开」就成了两件事(目录面板早有的那一条判例):选中 =
 * 键盘位(底色),打开 = 行尾一颗点(`ui/OpenDot`,实心 = 显示中 / 空心 = 已隐藏)。
 * 判据整件是纯函数 `workbench/store.openStateOf` —— 这一列与文件树那一列读的是
 * 同一句话,只是问的 ref 从 `file:` 换成了 `change:`。
 */

/** 八种状态各一枚字母 + 一枚语义色。**表,不是 switch** —— 后端多一种就加一行。 */
const STATUS_LETTER: Readonly<Record<GitFileStatus, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflicted: '!',
  typechange: 'T',
}

/** 字母吃哪一枚色。缺席 = 中性(`--text-3`),不给每一种都发一枚色。 */
const STATUS_TONE: Readonly<Partial<Record<GitFileStatus, string>>> = {
  added: s.toneAdd,
  untracked: s.toneAdd,
  deleted: s.toneDel,
  conflicted: s.toneWarn,
}

/** 每一种状态的无障碍名。**读屏软件不该念一个孤零零的「M」**。 */
export const STATUS_LABEL: Readonly<Record<GitFileStatus, MessageKey>> = {
  modified: 'diff.statusM',
  added: 'diff.statusA',
  deleted: 'diff.statusD',
  renamed: 'diff.statusR',
  copied: 'diff.statusC',
  untracked: 'diff.statusU',
  conflicted: 'diff.statusX',
  typechange: 'diff.statusT',
}

/** 一条路径切成「目录段 + 文件名」。目录段淡、文件名实 —— 扫一列时眼睛找的是后者。 */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/')
  if (at < 0) return { dir: '', name: path }
  return { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

export interface ChangeListProps {
  files: readonly GitChangedFile[]
  /** 键盘位(roving 的当前项)。 */
  active: number
  /** 点一行:落位。打开由 `onOpen` 说 —— 单击两件事一起发(批⑤)。 */
  onSelect: (index: number) => void
  /** 单击 / ↵:开这个文件的改动。`viaKeyboard` 只决定焦点送不送进那一格。 */
  onOpen: (file: GitChangedFile, viaKeyboard: boolean) => void
  /**
   * 这一行的改动此刻开着没有(`'shown'` / `'hidden'` / `null`)。判据整件是纯函数
   * `workbench/store.openStateOf`,由面板那一层答 —— 这一列只负责画。
   */
  openStateOf: (file: GitChangedFile) => 'shown' | 'hidden' | null
  /** 点那颗空心点:把藏起来的那一格请回来。 */
  onRestore: (file: GitChangedFile) => void
  /** 右键:开那张动作表(**动作单产地**)。交出去的是那一次指针事件(点锚)。 */
  onMenu: (file: GitChangedFile, origin: { clientX: number; clientY: number }) => void
  /** roving 的行 ref 收集器(滚入视野靠它认行)。 */
  rowRef: (index: number) => (el: HTMLElement | null) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
  /** 可滚的那块身 —— 由面板递下来(`restingTarget` 要在它的子树里找第一行)。 */
  bodyRef: (el: HTMLDivElement | null) => void
}

export function ChangeList({
  files,
  active,
  onSelect,
  onOpen,
  openStateOf,
  onRestore,
  onMenu,
  rowRef,
  t,
  bodyRef,
}: ChangeListProps) {
  const win = useRowWindow(files)
  /*
   * **这一窗的第一行在整表里是第几行**。算一次,不是逐行 `indexOf` ——
   * 后者在两千行的仓上是每帧几万次比较(而这一列的第五轴预算是首帧 ≤16ms)。
   * 窗口是一段**连续**切片(`rowWindow` 的 `slice(start, end)`),所以下标就是
   * 首行下标 + 这一行在窗里的位置。
   */
  const start = win.shown.length > 0 ? files.indexOf(win.shown[0]) : 0
  /*
   * 两格 ref 合成一只:窗口化那一半要它量视口,面板那一半要它找第一行。
   * **不挂第二个 ref** —— 两只 ref 指着同一个元素时,谁先谁后是 React 的事,
   * 而「量到的那块」与「找行的那块」必须是同一块。
   */
  const attach = (el: HTMLDivElement | null) => {
    win.bodyRef.current = el
    bodyRef(el)
  }

  return (
    /*
     * `role="group"` **不是装饰**(2026-09-13 `gate:a11y` 那一屏抓到的):一个裸
     * `<div>` 不许带 `aria-label`(axe 的 `aria-prohibited-attr` —— 没有角色的元素
     * 没有「无障碍名」这回事,那一格会被读屏软件整个忽略,而这块面就此少了一句
     * 「下面这一列是什么」)。
     *
     * 为什么是 `group` 而不是 `list` / `listbox` / `region`:行是**真按钮**(↵ 就是
     * 打开那个文件),`listbox`/`option` 会对读屏软件谎称这是一组单选项;`region`
     * 是地标,一块收在 Dock 里的面不该往地标表里塞一格;`list` 要求孩子是
     * `listitem`,而那会把「每一行是一颗钮」这件真事包一层。`group` 说的正好是这
     * 一句:**这几件是一组,组的名字叫「改动的文件」**。
     */
    <div
      className={s.list}
      ref={attach}
      id="changes-list-column"
      role="group"
      aria-label={t('diff.filesSection')}
      data-testid="changes-list"
      onScroll={win.onScroll}
    >
      {/* 窗口前后的两块空撑子:它们不是内容,只是让卷轴与「全画出来」一样长。 */}
      {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
      {win.shown.map((file, offset) => {
        /*
         * **下标是整表的下标,不是这一窗的**:roving 的键盘位按整表记,而这一帧
         * 只画得出中间一段。直接用 `map` 的下标会让「按 ↓ 到第 300 行」这件事在
         * 滚过一屏之后开始错位。
         */
        const index = start + offset
        const at = splitPath(file.path)
        const letter = STATUS_LETTER[file.status] ?? '·'
        const openState = openStateOf(file)
        return (
          /*
           * **一行两层**(批⑤,与 `files/TreeEntryRow` 逐字同形):外面一格 `div` 收
           * 底色、右键与那颗开态点,里面一颗 `ButtonBase` 是「打开这个文件的改动」。
           * 两层不是装饰 —— 空心那一档的开态点**自己就是一颗钮**(点它把藏起来的
           * 那一格请回来),而一颗 `<button>` 套在另一颗里是非法 DOM(axe 当场报)。
           */
          <div
            key={file.path}
            className={`${s.rowWrap} ${index === active ? s.rowSel : ''}`}
            onContextMenu={(e) => {
              e.preventDefault()
              onSelect(index)
              // 指针事件原样交出去 → 点锚(光标那一点就是落点,不加缝)。
              onMenu(file, e)
            }}
          >
            <ButtonBase
              ref={rowRef(index) as (el: HTMLButtonElement | null) => void}
              className={s.row}
              data-change-path={file.path}
              data-change-status={file.status}
              data-change-selected={index === active ? 'true' : undefined}
              data-change-open={openState ?? undefined}
              /*
               * **单击 = 落位 + 打开**(批⑤;与目录面板那一行逐字同形)。焦点留在列里
               * —— 「导航器里浏览不抢焦点」是响应链规则 4。
               */
              onClick={() => {
                onSelect(index)
                onOpen(file, false)
              }}
              /*
               * ↵ 同一条路,只多一件:焦点送进开出来的那一格。一颗 `<button>` 上的 ↵
               * 本来就会合成一次 click,所以这里必须 `preventDefault()` 把那一次挡掉
               * ——不挡就开两遍。带修饰键的 ↵ 不算(那是别人的键,归派发器)。
               */
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
                e.preventDefault()
                onSelect(index)
                onOpen(file, true)
              }}
            >
              <span className={`${s.letter} ${STATUS_TONE[file.status] ?? ''}`} aria-hidden="true">
                {letter}
              </span>
              {/* 读屏软件念的是整句:「已修改 · src/a.ts · 加 3 减 1」。 */}
              <span className="visually-hidden">{t(STATUS_LABEL[file.status])}</span>
              <span className={s.path}>
                {/*
                 * 唯一的弯腰件是这一整段(律一:一行恰有一个)。目录段在前、文件名在后,
                 * 省略号因此吃掉的是**目录的尾巴**而不是文件名 —— 那正是
                 * `direction: rtl` 那一手在这里的用处(判词在样式表上)。
                 */}
                {at.dir && <span className={s.pathDir}>{at.dir}</span>}
                <span className={s.pathName}>{at.name}</span>
                {/* 改名:两段路径 `old → new`。旧那一段淡,它已经不在了。 */}
                {file.oldPath && <span className={s.pathOld}>{t('diff.renamedFrom', { from: file.oldPath })}</span>}
              </span>
              {file.binary ? (
                <span className={s.statBinary}>{t('diff.binaryShort')}</span>
              ) : (
                <span className={s.stat}>
                  {file.add ? <span className={s.statAdd}>{`+${file.add}`}</span> : null}
                  {file.del ? <span className={s.statDel}>{`−${file.del}`}</span> : null}
                </span>
              )}
            </ButtonBase>
            {/*
              * 「这个文件的改动正开着」。它与选中态是两件事,所以是两处画法
              * (圆点 vs 底色)—— 与文件树那一行同一件 `ui/OpenDot`、同一句判据。
              * `null` 时**整格不在场**:那一格 `margin-left` 是位置,没有点就不该占位。
              */}
            {openState !== null && (
              <span className={s.openDot}>
                <OpenDot
                  state={openState}
                  label={t('files.openStateHidden')}
                  testId={`changes-open-dot:${file.path}`}
                  onRestore={() => onRestore(file)}
                />
              </span>
            )}
          </div>
        )
      })}
      {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
    </div>
  )
}
