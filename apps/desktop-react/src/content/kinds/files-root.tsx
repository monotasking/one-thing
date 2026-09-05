import { useCallback, useMemo, useRef, useState } from 'react'
import { registerContentKind } from '../../workbench/kinds'
import { useContentDrag } from '../../workbench/useContentDrag'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import { baseNameOf, dirsQuery, flattenTree, useDirStates } from '../../data/files-source'
import { openFileInCurrentTarget, fileRef } from '../viewer/open-target'
import { TreeEntryRow, depthVar } from '../files/TreeEntryRow'
import { FILES_ROOT_KIND, filesRootRef } from './files-root-ref'
import type { EntryRow } from '../files/TreeEntryRow'
import type { FileFailure } from '../../data/files-source'
import type { MessageKey } from '../../i18n'
import type { ContentRef } from '../../workbench/kinds'
import s from '../FilesPanel.module.css'

/**
 * **「以某个目录为根的一棵文件树」这一种内容**(W3;设计 §3.1 的
 * `files-root:<path>`)。
 *
 * ── 它为什么在 W3 出现 ──────────────────────────────────────────────────
 * 派工令裁定 6 把**项目行**列进五种拖拽来源,而设计表第三行写着「项目一行 →
 * `files-root:<path>`(以项目目录为根的文件树)」。一种拖得出来却没有登记的
 * `kind` 是**假的**:`renderRef` 会答 null(空白 tab),下一次 `sanitize` 会把
 * 它整格剔掉(重启即消失)。所以这一批要么不做项目行,要么把这一种登记成真的
 * —— 派工令点名了它,于是登记。
 *
 * ── 与「文件」面板的分工:它不是第二块 FilesPanel ────────────────────────
 * `FilesPanel` 是那块**瓦**(`panel:files`):根跟着活跃会话走、带面包屑 /
 * 检索 / 详情 / 分栏查看器 / 行菜单,而且它的状态住在**单例** `useFilesSource`
 * 里(一个 root、一份 expanded)。把那一整块做成多实例是 files-source 的一次
 * 大改,不是 W3 拖拽这一批的事。
 *
 * 这一种因此是**一棵树,仅此而已**:根由 ref 给定(不跟会话走),展开状态是
 * 这一格实例自己的 `useState`,目录内容走**同一族**键控查询(`dirsQuery`,键就是
 * 路径 —— 所以两处看同一个目录时读的是同一格缓存,不会各拉一遍)。
 * 摊平、行的画法、行的拖拽全部复用既有件(`flattenTree` / `TreeEntryRow` /
 * `useContentDrag`),这只文件里没有第二套树。
 *
 * **它没有的东西,逐条是有意的**:面包屑(根是固定的,没有「我在哪」这个问题)、
 * 检索(那是 `panel:search` 的事)、行菜单与详情(动作单产地是那块面板的右键
 * 菜单;这里挂一张半张的菜单比不挂更糟 —— 与 `expose/SessionRow` 的同一条留账)、
 * 窗口化(那块面板要扛几千行,这里是一块次要落点,一棵普通的 overflow 列表)。
 * 这四条随「项目树要不要长成完整的一块面」一起,记在交卷报告的留账里。
 *
 * ── 三张状态表 ①:生命周期 ──────────────────────────────────────────────
 *   挂载    这一格 tab 出现在某片叶里(拖一行项目进来 / 从隐藏表请回来)
 *   首载    根目录那一格查询还没回来 —— 画骨架行(与那块面板同一份画法)
 *   换宿主  整棵树随区域搬(center → edge → float):**内容不重挂**,只换外框
 *           (拼贴树的结构共享保证的;跨区域是另一回事,见 W4 留账 3)
 *   卸载    这一格关掉。**没有 `dispose`** —— 它一格实例状态都不留在全局:
 *           展开状态随组件走,目录内容住在键控查询里(那是缓存,不是这一格的)
 *
 * ── ②:UI 生命状态 ───────────────────────────────────────────────────────
 *   loading  骨架行(每一层各自 loading,不是整棵树一块骨架)
 *   ready    行
 *   empty    「这个目录是空的」一句注行
 *   error    「没权限 / 不存在 / 读失败」三句 + 一颗重试
 *   超量     一层几千项时**整棵树只有一条纵向滚动**,行永不换行(挤压纪律)
 *
 * ── ③:UI 交互状态 ───────────────────────────────────────────────────────
 * 行的 rest / hover / focus / selected / hidden 全部随 `TreeEntryRow`(同一件、
 * 同一份样式表);这一层自己只加一格:**选中**(此刻点在哪一行,组件内 state)。
 */

/** 注行的两档失败 + 一档非失败,各一句人话(与 `FilesPanel` 同一张表)。 */
const NOTE_LABELS: Record<'empty' | FileFailure, MessageKey> = {
  empty: 'files.dirEmpty',
  denied: 'files.dirDenied',
  missing: 'files.dirMissing',
  failed: 'files.dirFailed',
}

function FilesRootTree({ root }: { root: string }) {
  const t = useT()
  const [expanded, setExpanded] = useState<Readonly<Record<string, true>>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const dirPaths = useMemo(() => [root, ...Object.keys(expanded)], [root, expanded])
  const dirs = useDirStates(dirPaths)
  const rows = useMemo(() => flattenTree(root, dirs, expanded), [root, dirs, expanded])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      if (prev[path]) {
        const next = { ...prev }
        delete next[path]
        return next
      }
      return { ...prev, [path]: true as const }
    })
  }, [])

  /*
   * 行拖拽:与 `FilesPanel` 逐字同一条(按下记一格、起拖读它;目录 → files-root)。
   * 于是这棵树里的一行也拖得进别的叶 —— 「拖一份文件到旁边对照着看」在项目树上
   * 与在文件面板上是同一件事。
   */
  const dragRow = useRef<EntryRow | null>(null)
  const startRowDrag = useContentDrag({
    ref: () => {
      const row = dragRow.current
      if (!row) return null
      return row.type === 'directory' ? filesRootRef(row.path) : fileRef(row.path)
    },
  })

  return (
    <div className={s.body} data-testid={`files-root-tree:${root}`} aria-label={t('files.treeLabel')}>
      {rows.map((row) =>
        row.kind === 'skeleton' ? (
          <div
            key={row.id}
            className={s.skelRow}
            style={depthVar(row.depth)}
            role={row.bar === 1 ? 'status' : undefined}
            aria-label={row.bar === 1 ? t('files.dirLoading') : undefined}
          >
            <span
              className={row.bar === 1 ? `${s.skelBar} ${s.skelBar1}` : `${s.skelBar} ${s.skelBar2}`}
              aria-hidden="true"
            />
          </div>
        ) : row.kind === 'note' ? (
          <div key={row.id} className={s.note} style={depthVar(row.depth)}>
            <span className={row.note === 'empty' ? s.noteEmpty : s.noteFail}>
              {t(NOTE_LABELS[row.note])}
            </span>
            {row.error && <span className={s.noteDetail}>{row.error}</span>}
            {row.note !== 'empty' && (
              <ButtonBase
                className={s.noteRetry}
                onClick={() => void dirsQuery.get(row.dir).refetch()}
              >
                {t('files.retry')}
              </ButtonBase>
            )}
          </div>
        ) : (
          <TreeEntryRow
            key={row.path}
            row={row}
            t={t}
            selected={selected === row.path}
            /*
             * 打开点那一列**这里不画**:它说的是「这个文件在拼贴台里开着没有」,
             * 而那句话的产地是 `store.openStateOf` —— 订它要订整张 `regions`,
             * 一棵几千行的树就是几千次重渲。那一列是**文件面板**那块面的职责
             * (它本来就订着那三格事实),这里交 null 是诚实的「不说」。
             */
            openState={null}
            onActivate={(viaKeyboard) => {
              setSelected(row.path)
              if (row.type === 'directory') {
                toggle(row.path)
                return
              }
              // 单击 = 预览,↵ = 固定(§2.1 拍点 ①,与文件面板同一句)。
              openFileInCurrentTarget(row.path, { preview: !viaKeyboard })
            }}
            onCurrent={() => {
              /* 详情那条面域局部键(⌘I / ⌘↵)住在**文件面板**那格作用域上,
               * 这棵树不是它 —— 所以这里没有「哪一行」要记。 */
            }}
            onMenu={() => {
              /* 行菜单是文件面板那块面的动作单产地(见组件头「它没有的东西」)。 */
            }}
            onDragPointerDown={(e) => {
              dragRow.current = row
              startRowDrag(e)
            }}
          />
        ),
      )}
    </div>
  )
}

registerContentKind(
  {
    id: FILES_ROOT_KIND,
    // 同一个目录可以在两片叶里各开一棵(与 `file` 同一条:它不是单例)。
    singleton: false,
    title: (ref: ContentRef) => ({ text: baseNameOf(ref.key) || ref.key, tip: ref.key }),
    // 目录就是目录那一枚。名字取的是 `components/icons` 的注册表键(大写开头),
    // 拼错了 `resolveIcon` 会静默退回 FolderTree —— 所以照表写。
    icon: () => 'Folder',
    render: (ref) => <FilesRootTree root={ref.key} />,
  },
  import.meta.hot,
)
