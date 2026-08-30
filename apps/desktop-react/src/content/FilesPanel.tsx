import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import { ChevronDown, ChevronRight, RotateCcw, X, resolveIcon } from '../components/icons'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { useT } from '../i18n'
import type { MessageKey, TFn } from '../i18n'
import {
  baseNameOf,
  flattenTree,
  formatBytes,
  langOfPath,
  useFilesSource,
  useSessionCwd,
  PREVIEW_MAX_BYTES,
} from '../data/files-source'
import type { FileFailure, PreviewState, TreeRow } from '../data/files-source'
import { BlockView } from './blocks/BlockView'
import s from './FilesPanel.module.css'

/**
 * 文件树 = 一块**普通的 Dock 内容**(id 'files'),所以它能上舞台 / 变浮窗 / 钉到边,
 * 三种形态里长得一模一样 —— 这正是 renderContent 那张表存在的理由。
 * D5 之前这块面是 `FilesMock` 的三行写死假树,现在它说的是真事实。
 *
 * ── 形状 ──────────────────────────────────────────────────────────────
 * 头(标题 + 重新读取)/ 根条(当前根,如实显示)/ 身(懒展开的树)。
 * 一行永远是三件东西:展开箭头(目录才有)/ 图标 / 名字,行尾一枚常驻的
 * 「在访达中显示」(**常驻在布局里**,只有透明度随悬停变 —— 抗挤压律三:
 * 覆盖内容必须有布局预留,不许出现时把名字挤走)。
 *
 * 点一个文件 = 打开只读预览。预览**盖住身**而不是切一半:这块面在架子里可以窄到
 * 260px,横着切两栏是律四(每个组件在自己声明的最小宽度下零重叠)当场违规。
 * 预览的正文走的是聊天区那条**同一条**代码块渲染路径(`BlockView` +
 * `kind:'code'`),所以高亮、块内横滚、限高折叠、复制源码四件全是白拿的 ——
 * 这块面自己一行都没写。
 *
 * ── 三态诚实 ──────────────────────────────────────────────────────────
 * 空目录 / 读不到 / 没权限,各说各的话(注行),后端原话原样跟在后面 ——
 * 归类在 data/files-source.ts 的 classifyFileFailure 里定一次,两处(树、预览)
 * 共用。没有一处失败是静默的:reveal 失败会弹通知。
 */

/** 目录行没有图标位?有 —— 文件与目录各一枚,位子一样宽,树才对得齐。 */
const FolderIcon = resolveIcon('FolderTree')
const FileIcon = resolveIcon('FileText')
/** 「在文件管理器里定位」的行尾小钮。 */
const RevealIcon = resolveIcon('FolderOpen')

/** 注行的三档失败 + 两档非失败,各一句人话。 */
const NOTE_LABELS: Record<'loading' | 'empty' | FileFailure, MessageKey> = {
  loading: 'files.dirLoading',
  empty: 'files.dirEmpty',
  denied: 'files.dirDenied',
  missing: 'files.dirMissing',
  failed: 'files.dirFailed',
}

const PREVIEW_FAILURE_LABELS: Record<FileFailure, MessageKey> = {
  denied: 'files.previewDenied',
  missing: 'files.previewMissing',
  failed: 'files.previewFailed',
}

export function FilesPanel() {
  const t = useT()
  const cwd = useSessionCwd()
  const root = useFilesSource((st) => st.root)
  const rootStatus = useFilesSource((st) => st.rootStatus)
  const rootOrigin = useFilesSource((st) => st.rootOrigin)
  const rootError = useFilesSource((st) => st.rootError)
  const dirs = useFilesSource((st) => st.dirs)
  const expanded = useFilesSource((st) => st.expanded)
  const preview = useFilesSource((st) => st.preview)
  const setRoot = useFilesSource((st) => st.setRoot)
  const toggleDir = useFilesSource((st) => st.toggleDir)
  const refresh = useFilesSource((st) => st.refresh)
  const openPreview = useFilesSource((st) => st.openPreview)
  const closePreview = useFilesSource((st) => st.closePreview)
  const reveal = useFilesSource((st) => st.reveal)

  // 根跟着活跃会话走。判据不在这里 —— useSessionCwd 是它唯一的产地,
  // 这里只负责把结果交给数据源(setRoot 自己幂等)。
  useEffect(() => {
    void setRoot(cwd)
  }, [cwd, setRoot])

  const rows = flattenTree(root, dirs, expanded)

  return (
    <div className={s.panel} data-testid="files-panel">
      <div className={s.head}>
        <h2 className={s.title}>{t('item.files')}</h2>
        <span className={s.spacer} />
        <Button
          iconOnly
          aria-label={t('files.refresh')}
          disabled={rootStatus !== 'ready'}
          onClick={() => void refresh()}
        >
          <RotateCcw className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>

      <div className={s.rootBar}>
        <p className={s.rootPath} data-testid="files-root">{rootText(root, rootStatus, t)}</p>
        {/* 退到主目录了就说出来 —— 「看的不是这条会话的工作目录」是用户必须知道的事。 */}
        {rootStatus === 'ready' && rootOrigin === 'home' && (
          <p className={s.rootNote}>{t('files.rootFallback')}</p>
        )}
        {rootStatus === 'error' && <p className={s.rootNote}>{rootError}</p>}
      </div>

      <div className={s.body} aria-label={t('files.treeLabel')} data-testid="files-tree">
        {rows.map((row) =>
          row.kind === 'note' ? (
            <p key={row.id} className={s.note} style={depthVar(row.depth)}>
              <span className={s.noteText}>{t(NOTE_LABELS[row.note])}</span>
              {row.error && <span className={s.noteDetail}>{row.error}</span>}
            </p>
          ) : (
            <TreeEntryRow
              key={row.path}
              row={row}
              t={t}
              onActivate={() =>
                row.type === 'directory' ? void toggleDir(row.path) : void openPreview(row.path)
              }
              onReveal={() => void reveal(row.path)}
            />
          ),
        )}
      </div>

      {preview && <PreviewLayer preview={preview} t={t} onClose={closePreview} />}
    </div>
  )
}

/** 缩进不写字面 px:深度以无单位数进 CSS 变量,一格多宽由样式表说了算。 */
function depthVar(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

/**
 * 根条上那句话。三档各说各的,**不拿一个假路径去顶**还没定下来的根。
 * 路径本身是数据(原样),只有「正在定 / 定不下来」是文案。
 */
function rootText(root: string | null, status: string, t: TFn): string {
  if (status === 'loading' || status === 'idle') return t('files.rootLoading')
  if (status === 'error') return t('files.rootFailed')
  return root ?? t('files.rootFailed')
}

/**
 * 一行。行本体与行尾动作是**兄弟**而不是父子 —— 嵌套 button 既是禁令也确实点不动
 * (与设置页那条「恢复默认」同一条判例)。
 */
function TreeEntryRow({
  row,
  t,
  onActivate,
  onReveal,
}: {
  row: Extract<TreeRow, { kind: 'entry' }>
  t: TFn
  onActivate: () => void
  onReveal: () => void
}) {
  const Caret = row.expanded ? ChevronDown : ChevronRight
  const Icon = row.type === 'directory' ? FolderIcon : FileIcon
  return (
    <div
      className={s.rowWrap}
      style={depthVar(row.depth)}
      /* 门用的稳定选择器(与 EdgeShelf 的 data-shelf / data-panel 同一条判例):
       * 文案会跟着语言变,路径不会。 */
      data-file-path={row.path}
      data-file-type={row.type}
      data-file-depth={row.depth}
    >
      <button
        type="button"
        className={s.row}
        aria-expanded={row.type === 'directory' ? row.expanded : undefined}
        onClick={onActivate}
      >
        {row.type === 'directory' ? (
          <Caret className={s.caret} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          // 文件没有箭头,但**位子留着** —— 不留,同一层的文件名就会比目录名靠左一截。
          <span className={s.caret} aria-hidden="true" />
        )}
        <Icon className={s.rowIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.rowName}>{row.name}</span>
      </button>
      <button
        type="button"
        className={s.revealBtn}
        aria-label={t('files.reveal')}
        onClick={onReveal}
      >
        <RevealIcon className={s.revealIcon} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * 预览层。四种状态各画各的,**没有一种回退到别的那一种**:
 * 还在读 = 转圈;二进制 = 明说读不成文本;读不到 = 三档失败各一句话 + 后端原话;
 * 读到了 = 代码块(空文件另说一句 —— 一块空白不该被当成「渲染坏了」)。
 */
function PreviewLayer({
  preview,
  t,
  onClose,
}: {
  preview: PreviewState
  t: TFn
  onClose: () => void
}) {
  return (
    <div className={s.preview} data-testid="files-preview">
      <div className={s.previewHead}>
        <span className={s.previewName}>{baseNameOf(preview.path)}</span>
        <span className={s.previewPath}>{preview.path}</span>
        <Button iconOnly aria-label={t('files.previewClose')} onClick={onClose}>
          <X className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>
      <div className={s.previewBody}>
        {preview.status === 'loading' && (
          <p className={s.note}>
            <Spinner label={t('files.previewLoading')} />
            <span className={s.noteText}>{t('files.previewLoading')}</span>
          </p>
        )}
        {preview.status === 'binary' && (
          <p className={s.note}>
            <span className={s.noteText}>{t('files.previewBinary')}</span>
            {preview.size !== undefined && (
              <span className={s.noteDetail}>{formatBytes(preview.size)}</span>
            )}
          </p>
        )}
        {preview.status === 'error' && (
          <p className={s.note}>
            <span className={s.noteText}>
              {t(PREVIEW_FAILURE_LABELS[preview.failure ?? 'failed'])}
            </span>
            {preview.error && <span className={s.noteDetail}>{preview.error}</span>}
          </p>
        )}
        {preview.status === 'ready' && (
          <>
            {preview.truncated && (
              <p className={s.note}>
                <span className={s.noteText}>
                  {t('files.previewTruncated', {
                    size: formatBytes(preview.size ?? 0),
                    shown: formatBytes(PREVIEW_MAX_BYTES),
                  })}
                </span>
              </p>
            )}
            {preview.content ? (
              <BlockView
                block={{
                  kind: 'code',
                  lang: langOfPath(preview.path),
                  source: preview.content,
                  file: baseNameOf(preview.path),
                  closed: true,
                }}
                // 这块内容不属于任何一条消息。`messageId` 是错误现场的名字,
                // 所以给它一个说得清产地的名字,而不是一个空串。
                ctx={{ messageId: `files:${preview.path}`, streaming: false }}
              />
            ) : (
              <p className={s.note}>
                <span className={s.noteText}>{t('files.previewEmpty')}</span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
