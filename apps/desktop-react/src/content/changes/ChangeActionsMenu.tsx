import { Menu, MenuItem, MenuSection, MenuSeparator, Submenu } from '../../ui/Menu'
import { useT } from '../../i18n'
import { revealKey, revealMutation } from '../../data/files-source'
import {
  FILE_OPEN_MODES,
  FILE_OPEN_MODE_LABELS,
  useFileOpenMode,
} from '../../data/file-open-mode'
import { openFileInCurrentTarget } from '../viewer/open-target'
import { splitPath } from './ChangeList'
import type { GitChangedFile } from '../../data/changes-source'

/**
 * **改动列一行的全部动作 —— 唯一一张表**(批⑤;09-01 立的「动作单产地 = 右键上下
 * 文菜单」在这块面上的落地)。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 批⑤ 之前这一列只有两条路:单击落位、双击打开。双击是壳的**禁令**(macOS 触控板
 * 双指点按以双击形态到达,与右键语义打架),而拆开列与正文之后一行能做的事多了
 * 起来:开改动、开文件本身、换打开方式、去 Finder 里看。四件散在行上就是四个各自
 * 长出来的入口 —— 所以它们收进这一张表,与目录面板 `FileActionsMenu` 同一条判例。
 *
 * ── 它为什么不是 `FileActionsMenu` 的第二个宿主 ──────────────────────────
 * 那张表说的是「一个**文件**能做什么」:编辑、隐藏、关闭、两向分屏、视图、详情、
 * 复制路径 —— 每一条问的都是查看器那一族的事实(`viewer-source` 的实例、
 * `openStateOf(fileRef)`、那一型自述的 `viewModes`)。这一行的身份是**一个文件的
 * 改动**(`change:<root>|<path>`),两者只有两条重合(打开方式、Finder)。把这四条
 * 塞进那张表意味着它要多收一格「我此刻是被谁弹出来的」—— 那是把两张表的差别藏进
 * 一个参数里。**两张表,共用的是那格偏好与那只 mutation,不是组件。**
 *
 * ── 「打开方式」为什么是真的子菜单 ──────────────────────────────────────
 * `FileActionsMenu` 那一处写着「`ui/Menu` 今天没有二级菜单能力,所以给一个带小标题
 * 的分组」—— 那句话 W7-c 之后**过时了**:`ui/Submenu` 已经入库(菜单族第四件)。
 * 这里因此用它;那张表要不要跟着折成子菜单是它自己那一批的事(等价替换要逐态对照,
 * 不搭这一单的车)。
 *
 * ── 选一档**只写偏好,不搬东西** ────────────────────────────────────────
 * 文件那一路的 `setFileOpenMode` 会把**手上开着的那一份文件**当场搬过去(09-01
 * 报障「调整后也没有生效」的正面兑现)。这里只 `setMode`:搬的那一半是文件那一路
 * 的语义(它那格「手上开着的」有唯一答案 —— 焦点叶里那一格 / 分栏里那一份),而
 * 改动这一族同时可以开着五格,「把哪一格搬过去」没有唯一答案。**下一次打开生效**
 * ——这与七档偏好本来的意思一致。
 *
 * ══ 三张状态表 ═══════════════════════════════════════════════════════════
 *  ① 生命周期:它是一件浮层,开 = 面板记下「在哪一行、哪一点」,关 = 两格一起清;
 *     无异步、无订阅(那格偏好是 zustand 的一格读)、无模块级副作用 → 不需要 HMR
 *     dispose;
 *  ② UI 生命状态:只有一态(它画的是一张已经算好的表);**没有 empty** —— 四条里
 *     至少两条永远在;
 *  ③ UI 交互状态:每一项随 `ui/MenuItem`(rest / hover / active / **disabled**:
 *     已删除的文件那一行「在查看器里打开」按不动,因为盘上没有它了)。
 */

export interface ChangeActionsTarget {
  file: GitChangedFile
  /**
   * 盘上那个文件的绝对路径(`<仓库根>/<相对路径>`)。仓库根还没读到 = `null`,
   * 那时「打开文件」与「在文件管理器里显示」两条**按不动** —— 拼一条半截路径去开
   * 一个不存在的文件,比什么都不做糟(判词与 `ChangesPanel.openFile` 逐字同源)。
   */
  absPath: string | null
}

export function ChangeActionsMenu({
  target,
  x,
  y,
  onClose,
  onOpenChange,
}: {
  target: ChangeActionsTarget
  x: number
  y: number
  onClose: () => void
  /** 「打开改动」交回面板做 —— 落点那一句(七档 + 面板内)是它的知识。 */
  onOpenChange: () => void
}) {
  const t = useT()
  const mode = useFileOpenMode((st) => st.mode)
  const setMode = useFileOpenMode((st) => st.setMode)
  /** 盘上那个文件还在不在。删掉的文件开不出来,也没什么可在 Finder 里指的。 */
  const onDisk = target.absPath !== null && target.file.status !== 'deleted'

  return (
    <Menu x={x} y={y} onClose={onClose} label={t('diff.rowMenu')} minWidth="var(--files-menu-w)">
      <MenuSection>{splitPath(target.file.path).name}</MenuSection>
      {/*
        * **每一项就是一行字**:不铺「主 + 右缘注」那两格(目录面板那张表的
        * `.menuLine / .menuMain / .menuTrail`)。那三格是**那块面样式表里的词汇**,
        * 抄一份过来就是同一句话有了两个产地(`ui:consume` 的 `shared-vocab-css`
        * 盯的正是它);而这里也不需要 —— 「当下是哪一档」由下面那张子表里那一枚勾
        * 说,说两遍不会更清楚。
        */}
      <MenuItem
        onClick={() => {
          onOpenChange()
          onClose()
        }}
      >
        {t('diff.menuOpenChange')}
      </MenuItem>
      <MenuItem
        disabled={!onDisk}
        onClick={() => {
          onClose()
          if (target.absPath) openFileInCurrentTarget(target.absPath)
        }}
      >
        {t('diff.menuOpenFile')}
      </MenuItem>

      <MenuSeparator />
      <Submenu label={t('files.openWith')}>
        {FILE_OPEN_MODES.map((option) => (
          <MenuItem
            key={option}
            checked={option === mode}
            onClick={() => {
              setMode(option)
              onClose()
            }}
          >
            {t(FILE_OPEN_MODE_LABELS[option])}
          </MenuItem>
        ))}
      </Submenu>

      <MenuSeparator />
      {/*
        * reveal 走 `revealMutation`(与目录面板那一条逐字相同,含那道二次闸:
        * 同一条路径的上一发还没回来就不再发)。**这一条上没有 aria-busy**:点完菜单
        * 当场关掉,那颗控件下一帧就不在了 —— 律③要的「反馈长在发起它的那个控件上」
        * 在这里没有落点。
        */}
      <MenuItem
        disabled={!onDisk}
        onClick={() => {
          onClose()
          const at = target.absPath
          if (!at || revealMutation.isPending(revealKey(at))) return
          void revealMutation.run(at)
        }}
      >
        {t('files.reveal')}
      </MenuItem>
    </Menu>
  )
}
