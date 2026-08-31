import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronDown, ChevronRight, Copy, Check, Eye, RotateCcw, X, resolveIcon } from '../components/icons'
import { COPY_FEEDBACK_MS } from '../components/motion'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Spinner } from '../ui/Spinner'
import { announce } from '../ui/a11y/live-region'
import { useT, resolveLang } from '../i18n'
import type { Lang, MessageKey, TFn } from '../i18n'
import { useStageStore } from '../stage/store'
import {
  baseNameOf,
  breadcrumbsOf,
  flattenTree,
  formatBytes,
  formatMtime,
  langOfPath,
  useFilesSource,
  useSessionCwd,
  PREVIEW_MAX_BYTES,
} from '../data/files-source'
import type {
  FileDetailState,
  FileFailure,
  PreviewState,
  RootStatus,
  TreeRow,
} from '../data/files-source'
import { iconSpecOf, isHiddenName, toneVar } from '../data/file-icons'
import { BlockView } from './blocks/BlockView'
import s from './FilesPanel.module.css'

/**
 * 文件树 = 一块**普通的 Dock 内容**(id 'files'),所以它能上舞台 / 变浮窗 / 钉到边,
 * 三种形态里长得一模一样 —— 这正是 renderContent 那张表存在的理由。
 * D5 之前这块面是 `FilesMock` 的三行写死假树,现在它说的是真事实。
 *
 * ── 形状(08-31 拍板「IDE 紧凑树」)─────────────────────────────────────
 * 头(**面包屑路径** + 重新读取)/ 身(懒展开的树)/ 底(一句小注,平时没有)。
 *
 * 三处与改版前不同,三条各自的理由:
 *
 * ① **面板内那个「文件」大标题退役**。tab 上已经写着「文件」,面板里再写一遍是
 *    同一句话说两遍;那条最值钱的横向带宽应该给**此刻在哪儿**。所以头上换成
 *    路径本身,而且逐段可点 —— 路径从「一行只能读的字」变成「一排能回跳的门」。
 *    尾段是当前所在,画成不可点的文字:它已经在这儿了,点它没有去处。
 *
 * ② **行上零 meta**。一行永远只有三件东西:展开箭头(目录才有)/ 图标 / 名字。
 *    大小与时间**一律不进树** —— 树是拿来**扫**的,扫的时候没人在读字节数;
 *    每行多两列会把唯一的弯腰件(名字)挤成省略号,而名字正是扫的时候唯一要看的。
 *    真要那两个数的那一刻,是「问一件具体的东西」,那是详情干的活(见 ③)。
 *    行高比通用的 --row-h 再紧一档(26 vs 28):一屏多两行比一行宽两像素值钱。
 *
 * ③ **双击 = 详情**。单击的语义一个字不改(目录展开 / 文件预览),详情走双击这条
 *    从来空着的路。载体选 ui/Dialog 而不是面板内就地卡,理由写在 FileDetailDialog 上。
 *    键盘上的等价物是 ⌘/Ctrl + Enter(macOS 访达的「显示简介」是 ⌘I,这里让位给
 *    壳的快捷键表)—— 双击是鼠标的路,不是唯一的路。
 *
 * ④ **行尾那枚常驻的 reveal 钮跟着 ② 一起退役**:它占掉一整个 --row-h 见方的
 *    布局预留,而它要做的事已经在详情面上有了一颗带文字的钮(比一枚只有悬停才
 *    显形的图标说得清)。这是本批**唯一一处可感知的能力位移**,不是删除:
 *    路径没少,只是从「每行悬停」挪到了「双击进详情」。
 *
 * ── 图标是真的 ────────────────────────────────────────────────────────
 * 目录 = Folder(展开态 FolderOpen);文件按**扩展名映射表**取图标与类型色,
 * 表在 data/file-icons.ts(纯模块,不 import React 也不 import lucide),
 * 色值在 styles/tokens.css 的「文件类型色板」一节。组件这一层既不认识扩展名,
 * 也不认识色值 —— 它只把两个字符串兑成组件与 `var(--ft-*)`。
 * 隐藏文件(`.` 开头)整行降透明:不换色,换色会读成「另一种东西」。
 *
 * 点一个文件 = 打开只读预览。预览**盖住身**而不是切一半:这块面在架子里可以窄到
 * 260px,横着切两栏是律四(每个组件在自己声明的最小宽度下零重叠)当场违规。
 * 预览的正文走的是聊天区那条**同一条**代码块渲染路径(`BlockView` +
 * `kind:'code'`),所以高亮、块内横滚、限高折叠、复制源码四件全是白拿的 ——
 * 这块面自己一行都没写。
 *
 * ── 三态诚实 ──────────────────────────────────────────────────────────
 * 空目录 / 读不到 / 没权限,各说各的话(注行),后端原话原样跟在后面 ——
 * 归类在 data/files-source.ts 的 classifyFileFailure 里定一次,三处(树、预览、
 * 详情)共用。没有一处失败是静默的。
 */

/** 「在文件管理器里定位」的钮(详情面底部动作组)。 */
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

/**
 * 详情面的三档失败**自己一套话**,不借预览那一套:预览说的是「这个文件」,
 * 而详情可能问的是一个目录 —— 借过来会当场说错话。
 */
const DETAIL_FAILURE_LABELS: Record<FileFailure, MessageKey> = {
  denied: 'files.detailDenied',
  missing: 'files.detailMissing',
  failed: 'files.detailFailed',
}

/**
 * 缺席格画的那道破折号。**它是符号不是文案**(与 formatBytes 的单位符号同一条
 * 口径):换一门语言它不该变,所以不进字典。它说的是「这台没给这一格」,
 * 不是 0 B,也不是 1970-01-01。
 */
const ABSENT = '—'

export function FilesPanel() {
  const t = useT()
  const lang = resolveLang(useStageStore((st) => st.locale))
  const cwd = useSessionCwd()
  const root = useFilesSource((st) => st.root)
  const rootStatus = useFilesSource((st) => st.rootStatus)
  const rootOrigin = useFilesSource((st) => st.rootOrigin)
  const rootError = useFilesSource((st) => st.rootError)
  const dirs = useFilesSource((st) => st.dirs)
  const expanded = useFilesSource((st) => st.expanded)
  const preview = useFilesSource((st) => st.preview)
  const detail = useFilesSource((st) => st.detail)
  const setRoot = useFilesSource((st) => st.setRoot)
  const navigateRoot = useFilesSource((st) => st.navigateRoot)
  const toggleDir = useFilesSource((st) => st.toggleDir)
  const refresh = useFilesSource((st) => st.refresh)
  const openPreview = useFilesSource((st) => st.openPreview)
  const closePreview = useFilesSource((st) => st.closePreview)
  const openDetail = useFilesSource((st) => st.openDetail)
  const closeDetail = useFilesSource((st) => st.closeDetail)
  const reveal = useFilesSource((st) => st.reveal)

  // 根跟着活跃会话走。判据不在这里 —— useSessionCwd 是它唯一的产地,
  // 这里只负责把结果交给数据源(setRoot 自己幂等)。
  useEffect(() => {
    void setRoot(cwd)
  }, [cwd, setRoot])

  const rows = flattenTree(root, dirs, expanded)
  const footNote = footNoteOf(rootStatus, rootOrigin, rootError, t)

  return (
    <div className={s.panel} data-testid="files-panel">
      <div className={s.head}>
        {/*
         * `data-testid="files-root"` 留在原地不动:门(scripts/gate-files.mjs)问的是
         * 「这块面此刻说自己在哪儿」,那是**事实**,不该因为它从一行字变成一排钮
         * 就换个名字。分隔斜杠是真的文本节点,所以整条 textContent 仍然逐字等于根路径。
         */}
        <nav className={s.crumbs} aria-label={t('files.breadcrumb')} data-testid="files-root">
          <RootCrumbs root={root} status={rootStatus} t={t} onJump={(at) => void navigateRoot(at)} />
        </nav>
        <Button
          iconOnly
          aria-label={t('files.refresh')}
          disabled={rootStatus !== 'ready'}
          onClick={() => void refresh()}
        >
          <RotateCcw className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
        </Button>
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
              onActivate={() =>
                row.type === 'directory' ? void toggleDir(row.path) : void openPreview(row.path)
              }
              onDetail={() =>
                void openDetail({ path: row.path, name: row.name, type: row.type })
              }
            />
          ),
        )}
      </div>

      {/*
       * 「这不是你以为的那棵树」这句话从头上的根条挪到了底注:它是**一句交代**,
       * 不是一件要一直盯着的事,而头上那条带宽已经给了路径本身。
       */}
      {footNote && <p className={s.foot}>{footNote}</p>}

      {preview && <PreviewLayer preview={preview} t={t} onClose={closePreview} />}
      {detail && (
        <FileDetailDialog
          detail={detail}
          lang={lang}
          t={t}
          onClose={closeDetail}
          onReveal={() => void reveal(detail.path)}
          onPreview={() => {
            closeDetail()
            void openPreview(detail.path)
          }}
        />
      )}
    </div>
  )
}

/** 缩进不写字面 px:深度以无单位数进 CSS 变量,一格多宽由样式表说了算。 */
function depthVar(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

/** 一行两个变量:缩进深度 + 这一行图标的类型色(色值本身仍然只在 tokens.css 里)。 */
function rowVars(depth: number, tone: string): CSSProperties {
  return { '--depth': depth, '--ft': tone } as CSSProperties
}

/**
 * 底注。三档里只有两档有话说 —— 正常态(会话的工作目录)与手动漫游态
 * (用户自己点面包屑走上去的)都不说话:前者是本来就该看到的,后者是用户自己
 * 刚做的事。**手动态尤其不能再说「显示的是主目录」**,那会变成一句假话。
 */
function footNoteOf(
  status: RootStatus,
  origin: 'session' | 'home' | 'manual',
  error: string | undefined,
  t: TFn,
): string | null {
  if (status === 'error') return error ?? t('files.rootFailed')
  if (status === 'ready' && origin === 'home') return t('files.rootFallback')
  return null
}

/**
 * 头上那一排路径。**这是投影**(breadcrumbsOf 是纯函数,判据不在这里)。
 * 三档各说各的,**不拿一个假路径去顶**还没定下来的根。
 */
function RootCrumbs({
  root,
  status,
  t,
  onJump,
}: {
  root: string | null
  status: RootStatus
  t: TFn
  onJump: (path: string) => void
}) {
  if (status === 'loading' || status === 'idle') {
    return <span className={s.crumbNote}>{t('files.rootLoading')}</span>
  }
  if (status === 'error' || !root) {
    return <span className={s.crumbNote}>{t('files.rootFailed')}</span>
  }
  const crumbs = breadcrumbsOf(root)
  // 根就是 `/`:一段可点的都没有,屏幕上只剩那条领头的斜杠。这是事实不是缺陷。
  if (crumbs.length === 0) return <span className={s.crumbSep}>/</span>
  return (
    <>
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1
        return (
          <Fragment key={crumb.path}>
            {/* 分隔斜杠是**真的文本**(不是 CSS ::before):整条 textContent 因此
                逐字等于那条路径,门与读屏两边看到的是同一句话。 */}
            <span className={s.crumbSep}>/</span>
            {last ? (
              <span className={s.crumbCurrent} aria-current="location">
                {crumb.name}
              </span>
            ) : (
              <button type="button" className={s.crumb} onClick={() => onJump(crumb.path)}>
                {crumb.name}
              </button>
            )}
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * 一行 = **一颗按钮**,里面三件东西。
 *
 * 改版前它是「按钮 + 行尾 reveal 按钮」两兄弟裹在一个 div 里;reveal 退役之后
 * 那层 div 就只剩一个用处(挂 data-*),而那些属性挂在按钮自己身上一样稳 ——
 * 少一层 DOM,26px 的行才排得动一屏几十行。
 *
 * 单击 / 双击共存的那一处细节:`e.detail` 是原生的点击计数,双击时第二下的
 * `detail === 2`,直接返回 —— 于是「双击一个目录」只翻一次展开,而不是翻两次
 * (翻两次看着像没反应,那是最难查的一类怪事)。
 */
function TreeEntryRow({
  row,
  onActivate,
  onDetail,
}: {
  row: Extract<TreeRow, { kind: 'entry' }>
  onActivate: () => void
  onDetail: () => void
}) {
  const Caret = row.expanded ? ChevronDown : ChevronRight
  const spec = iconSpecOf(row.name, row.type, row.expanded)
  const Icon = resolveIcon(spec.icon)
  const hidden = isHiddenName(row.name)
  return (
    <button
      type="button"
      className={hidden ? `${s.row} ${s.rowHidden}` : s.row}
      style={rowVars(row.depth, toneVar(spec.tone))}
      aria-expanded={row.type === 'directory' ? row.expanded : undefined}
      /* 门用的稳定选择器(与 EdgeShelf 的 data-shelf / data-panel 同一条判例):
       * 文案会跟着语言变,路径不会。图标与色也各留一格 —— 「这一行画的是哪一枚」
       * 是可断言的事实,而 SVG 里的 path 数据不是。 */
      data-file-path={row.path}
      data-file-type={row.type}
      data-file-depth={row.depth}
      data-file-icon={spec.icon}
      data-file-tone={spec.tone}
      data-file-hidden={hidden ? 'true' : undefined}
      onClick={(e) => {
        if (e.detail > 1) return
        onActivate()
      }}
      onDoubleClick={onDetail}
      onKeyDown={(e) => {
        // 双击的键盘等价物。⌘/Ctrl + Enter,不占用裸 Enter(那是「打开」)。
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onDetail()
        }
      }}
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
  )
}

/**
 * 详情面。**载体是 ui/Dialog,不是面板内的就地卡** —— 三条理由,一条比一条硬:
 *
 * ① **它是一次问话,不是一个可以待着的地方**。预览是「待着的地方」(读一整个
 *    文件),所以预览盖住身;详情是「瞄一眼 + 按一下」就走,浮层的进出成本
 *    正好配这种时长。就地卡会把树顶开,回来时滚动位置已经变了。
 * ② **窄形**。这块面在边架子里可以窄到 260px。就地卡要和树抢同一份横向带宽,
 *    「完整路径」那一行当场没地方站(律四:每个组件在自己声明的最小宽度下零重叠);
 *    浮层不吃面板的宽度。
 * ③ **白拿三件**:焦点圈禁(Tab 出不去)、Esc 关、关掉之后焦点回到刚才那一行。
 *    这三件就地卡得自己写一遍,而 A2 那一批已经在 Dialog 里写过一次了。
 *
 * 「复制路径」这颗钮长在**路径那一行上**而不是底部动作组里:反馈要落在被复制的
 * 那件东西旁边(⧉ 换 ✓ 一拍,COPY_FEEDBACK_MS 后还原,08-31 拍板复制不走通知)。
 * 底部动作组因此是三颗:在文件管理器中显示 / (文件才有)预览打开 / 关闭。
 */
function FileDetailDialog({
  detail,
  lang,
  t,
  onClose,
  onReveal,
  onPreview,
}: {
  detail: FileDetailState
  lang: Lang
  t: TFn
  onClose: () => void
  onReveal: () => void
  onPreview: () => void
}) {
  const spec = iconSpecOf(detail.name, detail.type)
  const Icon = resolveIcon(spec.icon)
  const [copied, setCopied] = useState<boolean | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyPath = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    const write = clipboard?.writeText
      ? clipboard.writeText(detail.path).then(
          () => true,
          () => false,
        )
      : Promise.resolve(false)
    void write.then((ok) => {
      announce(t(ok ? 'common.copied' : 'common.copyFailed'))
      setCopied(ok)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    })
  }

  const ready = detail.status === 'ready'
  const sizeText = ready && detail.size !== undefined ? formatBytes(detail.size) : ABSENT
  const mtimeText = (ready && formatMtime(detail.mtimeMs, lang)) || ABSENT

  return (
    <Dialog
      open
      onClose={onClose}
      /* 可见的大名字长在正文里(它带着那枚大图标一起构成「这是什么」),
       * 所以这里不给 title,改用 label —— 读屏念到的仍然是同一个名字。 */
      label={detail.name}
      footer={
        <>
          <Button onClick={onReveal}>
            <RevealIcon className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
            {t('files.reveal')}
          </Button>
          {detail.type === 'file' && (
            <Button onClick={onPreview}>
              <Eye className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
              {t('files.openPreview')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className={s.detail} data-testid="files-detail" data-file-path={detail.path}>
        <div className={s.detailHead}>
          <Icon
            className={s.detailIcon}
            style={{ color: toneVar(spec.tone) } as CSSProperties}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className={s.detailName}>{detail.name}</span>
        </div>

        {detail.status === 'loading' && (
          <p className={s.note}>
            <Spinner label={t('files.detailLoading')} />
            <span className={s.noteText}>{t('files.detailLoading')}</span>
          </p>
        )}
        {detail.status === 'error' && (
          <p className={s.note}>
            <span className={s.noteText}>
              {t(DETAIL_FAILURE_LABELS[detail.failure ?? 'failed'])}
            </span>
            {detail.error && <span className={s.noteDetail}>{detail.error}</span>}
          </p>
        )}

        <dl className={s.detailList}>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailTypeLabel')}</dt>
            <dd className={s.detailValue}>
              {t(detail.type === 'directory' ? 'files.typeDirectory' : 'files.typeFile')}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailSizeLabel')}</dt>
            <dd className={s.detailValue} data-testid="files-detail-size">
              {sizeText}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailModifiedLabel')}</dt>
            <dd className={s.detailValue} data-testid="files-detail-mtime">
              {mtimeText}
            </dd>
          </div>
          <div className={s.detailRow}>
            <dt className={s.detailLabel}>{t('files.detailPathLabel')}</dt>
            <dd className={s.detailValue}>
              <span className={s.detailPath}>{detail.path}</span>
              <Button iconOnly aria-label={t('files.copyPath')} onClick={copyPath}>
                {copied === true ? (
                  <Check className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Copy className={s.detailBtnIcon} strokeWidth={1.75} aria-hidden="true" />
                )}
              </Button>
            </dd>
          </div>
        </dl>
      </div>
    </Dialog>
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
