import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, X, resolveIcon } from '../../components/icons'
import { COPY_FEEDBACK_MS } from '../../components/motion'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Menu, MenuItem, MenuSection } from '../../ui/Menu'
import { Spinner } from '../../ui/Spinner'
import { announce } from '../../ui/a11y/live-region'
import { copyText } from '../../services/clipboard'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { baseNameOf, formatBytes } from '../../data/files-source'
import { glyphOf } from '../../data/file-icons'
import {
  FILE_OPEN_MODES,
  FILE_OPEN_MODE_LABELS,
  isWiredFileOpenMode,
  useFileOpenMode,
} from '../../data/file-open-mode'
import { isDirty, isEditableFile, useViewerSource } from '../../data/viewer-source'
import type { ViewerFile, ViewerView } from '../../data/viewer-source'
import { FileGlyphMark } from '../FileGlyph'
import { commandFor, keymapById, listKeymaps, resolveViewer } from './registry'
import type { ViewerBodyProps } from './registry'
import { JumpBar } from './JumpBar'
// 三张注册表的注册 barrel:import 它们**就是**「这台上认得哪些型 / 哪些跳法 /
// 哪些键位档」。放在这里而不是应用入口 —— 谁要查表,谁负责保证表是装好的
// (与 blocks/BlockView 的同款判例)。
import './kinds'
import './navigators'
import './keymaps'
import s from './FileViewer.module.css'

const PencilIcon = resolveIcon('Pencil')

/**
 * **文件查看器 = 壳**(08-31 claude design 定稿)。
 *
 * 它自己只做**公共**的那几件:头(身份与去向)、脚(状态栏)、⌘L 跳转条、
 * 轻编辑与关闭确认、键位派发。「这种文件长什么样」「能跳到哪儿」「哪个键做哪件事」
 * 分别由 `registry.ts` 那三张表回答 —— 所以加一种型 / 一种跳法 / 一个键位档,
 * **这个文件一行都不用改**。
 *
 * ── 它是一块内容,不是文件面板的一部分 ─────────────────────────────────────
 * 状态全在 `data/viewer-source`(文件的事实 + 看的姿势 + 没存的改动),画法全在
 * 这个目录里 —— 它对「自己被摆在哪儿」几乎一无所知:`placement` 只决定外框那
 * 一层几何类名。F1 唯一的落点是文件面板里那条分栏,F2 点亮主区域 / 四边钉 /
 * 浮窗时,**内核零改动**(状态在 store 上,换落点只换外框)。
 *
 * 唯一从宿主收的东西是 `onReveal`:「在文件管理器里定位」不是一份文件内容的
 * 事实,它是宿主那一侧的能力(桌面做得到,联网面结构化降级)。
 *
 * ── 三层 + 一条(§ 定稿的形)───────────────────────────────────────────────
 *   头 40:类型字标 · 名(截断)· 路径(点即复制)· 未保存丸 · 铅笔 · Finder ·
 *          打开方式 · 关闭。**大小与时间不在这里** —— 那是双击详情面的事。
 *   工具条:这一型自己的那一格(markdown 的渲染⇄源码 …),处理器给。
 *   身:处理器的 Body(或编辑态的等宽文本域)。
 *   脚 26:左 Vim 模式标 · 语言/编码/换行符;中 载入进度;右 Vim 开关 · 折行 ·
 *          「行 n:1 ⌘L」。
 *
 * ── UI 状态纪律(四律,逐条落在这里)──────────────────────────────────────
 *  ① **切文件 / 载入中,旧内容留着**:`file` 与 `pending` 是两格(判据在 store),
 *     檐上那格读数说出「正在读取…」,屏幕上没有任何一帧是空的;
 *  ② **骨架只首载**:第一次打开(手上什么都没有)才画转圈,之后一律不画;
 *  ③ **所有异步钮有 pending 态**:存盘那颗在 `edit.saving` 时禁用并换字;
 *  ④ **跳转滚动不闪**:落点用 `scrollIntoView({block:'center'})`,不重挂 body。
 */
export function FileViewer({
  onReveal,
  placement = 'panel',
  allowEdit = true,
}: {
  onReveal?: (path: string) => void
  /**
   * 落点。**只决定外框几何**(F2 的七格:panel / stage / edge-* / float)。
   * F1 只有 panel 一格真接上,其余的骨架在这里,内容与状态一个字都不看它。
   */
  placement?: string
  /**
   * 铅笔露不露出来。定稿:「铅笔是可开关的一枚:纯只读配置下整枚不渲染,
   * 其余形态不变」—— 关掉它不影响别的任何一格。
   */
  allowEdit?: boolean
}) {
  const t = useT()
  const file = useViewerSource((st) => st.file)
  const pending = useViewerSource((st) => st.pending)
  const view = useViewerSource((st) => st.view)
  const edit = useViewerSource((st) => st.edit)
  const close = useViewerSource((st) => st.close)
  const loadMore = useViewerSource((st) => st.loadMore)
  const setView = useViewerSource((st) => st.setView)
  const setEditing = useViewerSource((st) => st.setEditing)
  const setDraft = useViewerSource((st) => st.setDraft)
  const save = useViewerSource((st) => st.save)

  const rootRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const path = file?.path ?? pending ?? ''
  const name = file?.name ?? (pending ? baseNameOf(pending) : '')
  const glyph = useMemo(() => glyphOf(name || '?', 'file'), [name])
  const dirty = isDirty(file, edit)

  const handler = file ? resolveViewer(file) : undefined
  const bodyProps: ViewerBodyProps | undefined = file
    ? {
        file,
        view,
        onView: setView,
        onReveal: onReveal ? () => onReveal(file.path) : undefined,
      }
    : undefined
  const lineCount =
    handler?.lineCount && bodyProps ? handler.lineCount(bodyProps) : undefined

  /* ── ④ 跳转滚动不闪:落点之后把那一行滚到视野中间 ───────────────────── */
  useEffect(() => {
    if (!view.currentLine) return
    const el = bodyRef.current?.querySelector(`[data-line="${view.currentLine}"]`)
    // 不重挂 body、不改高度 —— 只是滚过去。行跳渲(content-visibility)下同样成立:
    // 浏览器会为滚动目标先把那一行排出来。
    el?.scrollIntoView({ block: 'center' })
  }, [view.currentLine, file?.path])

  /* ── 关闭:有未保存的改动就先问 ─────────────────────────────────────── */
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true)
      return
    }
    close()
  }, [dirty, close])

  /* ── ③ 存盘:异步钮的 pending 态 ────────────────────────────────────── */
  const runSave = useCallback(async () => {
    const outcome = await save()
    announce(t(outcome.ok ? 'viewer.saved' : 'viewer.saveFailed'))
    return outcome
  }, [save, t])

  /**
   * 键位派发。档由 store 说了算,映射由注册表说了算 —— 这里只负责执行。
   *
   * 它挂在**根元素上、用 addEventListener**,不是 JSX 的 `onKeyDown`:一个
   * `<section>` 不是控件,给它挂键盘监听会被 jsx-a11y 抓(那条规则拦得对 ——
   * 它防的是「把 div 当按钮使」)。这里要的是**捕获这块面里发生的按键**,
   * 语义上是容器级快捷键,不是这个元素自己的交互,所以走 DOM 这一路。
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onKey = (event: KeyboardEvent) => {
      const command = commandFor(keymapById(view.keymap), event)
      if (!command) return
      // 只有真的接住了才 preventDefault:**消费掉的键才有资格挡住别人**。
      switch (command) {
        case 'save':
          if (!edit.editing) return
          event.preventDefault()
          void runSave()
          return
        case 'jump':
          if (lineCount === undefined) return
          event.preventDefault()
          setJumpOpen(true)
          return
        case 'toggleWrap':
          event.preventDefault()
          setView({ wrap: !view.wrap })
          return
        case 'toggleEdit':
          if (!allowEdit || !handler?.editable) return
          event.preventDefault()
          setEditing(!edit.editing)
          return
        case 'close':
          event.preventDefault()
          requestClose()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [
    view.keymap,
    view.wrap,
    edit.editing,
    lineCount,
    allowEdit,
    handler?.editable,
    runSave,
    setView,
    setEditing,
    requestClose,
  ])

  return (
    <section
      ref={rootRef}
      className={`${s.viewer} ${s[`frame-${placement}`] ?? ''}`}
      data-testid="file-viewer"
      data-placement={placement}
      data-viewer-kind={handler?.id}
      aria-label={t('viewer.label')}
    >
      {/*
       * 这一条是 `<div>` 而不是 `<header>`:`<header>` 在无障碍树里会变成一枚
       * **banner 地标**,而一块面板内部的檐不是「整份文档的页眉」—— 真机 axe
       * 当场报 landmark-no-duplicate-banner(外壳自己已经有一枚)。同理下面那条脚
       * 不是 `<footer>`(那会变成 contentinfo)。语义靠 aria-label 与角色说,
       * 不靠一个会顺手宣布地标的标签名。
       */}
      <div className={s.chrome}>
        <FileGlyphMark glyph={glyph} className={s.chromeGlyph} />
        <span className={s.name} data-testid="viewer-name" data-viewer-path={path}>
          {name}
        </span>
        <CopyPathAction path={path} t={t} />
        {dirty && (
          <span className={s.dirty} data-testid="viewer-dirty">
            <span className={s.dirtyDot} aria-hidden="true" />
            {t('viewer.unsaved')}
          </span>
        )}
        {pending && (
          <span className={s.inflight} data-testid="viewer-inflight">
            <Spinner label={t('viewer.reading')} />
            <span className={s.inflightText}>{t('viewer.reading')}</span>
          </span>
        )}
        <span className={s.actions}>
          {allowEdit && handler?.editable && (
            <button
              type="button"
              className={edit.editing ? `${s.action} ${s.actionOn}` : s.action}
              aria-pressed={edit.editing}
              aria-label={t('viewer.edit')}
              data-testid="viewer-edit-toggle"
              onClick={() => setEditing(!edit.editing)}
            >
              <PencilIcon className={s.actionIcon} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {onReveal && path && (
            <button type="button" className={s.action} onClick={() => onReveal(path)}>
              {t('files.reveal')}
            </button>
          )}
          <OpenModeAction t={t} />
          <button
            type="button"
            className={s.action}
            aria-label={t('viewer.close')}
            data-testid="viewer-close"
            onClick={requestClose}
          >
            <X className={s.actionIcon} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </span>
      </div>

      {/* 工具条:这一型自己的那一格。没有就整条不画(不留一条空带子)。 */}
      {handler?.Toolbar && bodyProps && !edit.editing && (
        <div className={s.toolbar} data-testid="viewer-toolbar">
          <handler.Toolbar {...bodyProps} />
        </div>
      )}

      <div className={s.body} ref={bodyRef} data-testid="viewer-body">
        {jumpOpen && lineCount !== undefined && file && (
          <JumpBar
            file={file}
            lineCount={lineCount}
            onClose={() => setJumpOpen(false)}
            onJump={(line) => {
              setView({ currentLine: line })
              setJumpOpen(false)
            }}
          />
        )}
        {file && bodyProps && handler ? (
          edit.editing ? (
            <EditArea
              key={file.path}
              file={file}
              draft={edit.draft ?? ''}
              onDraft={setDraft}
              t={t}
            />
          ) : (
            /*
             * **按 path 作 key**:换文件时本体整个换掉(滚动位、缩放、图的失败态
             * 都不该从上一个文件继承),而头、脚、宿主、乃至左边那棵树一动不动。
             */
            <handler.Body key={file.path} {...bodyProps} />
          )
        ) : (
          /*
           * ② 骨架**只首载**:走到这里必然是「手上什么都没有」的第一帧。
           * 之后再切文件,上面那一支永远成立(旧内容还在),这里不会再出现。
           */
          <p className={s.note} data-testid="viewer-first-load">
            <Spinner label={t('viewer.reading')} />
            <span className={s.noteDetail}>{t('viewer.reading')}</span>
          </p>
        )}
      </div>

      <StatusBar
        t={t}
        file={file}
        view={view}
        lineCount={lineCount}
        status={handler?.status && bodyProps ? handler.status(bodyProps) : undefined}
        statusItems={handler?.statusItems && bodyProps ? handler.statusItems(bodyProps) : []}
        saving={edit.saving}
        savedAt={edit.savedAt}
        saveError={edit.error}
        conflict={edit.conflict}
        editing={edit.editing}
        onSave={() => void runSave()}
        onJump={() => setJumpOpen(true)}
        onKeymap={(id) => setView({ keymap: id })}
        onLoadMore={() => void loadMore()}
      />

      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title={t('viewer.confirmTitle')}
        footer={
          <>
            <Button onClick={() => setConfirmClose(false)}>{t('common.cancel')}</Button>
            <Button
              className={s.dangerBtn}
              onClick={() => {
                setConfirmClose(false)
                close()
              }}
            >
              {t('viewer.discard')}
            </Button>
            <Button
              variant="primary"
              disabled={edit.saving}
              onClick={() => {
                void runSave().then((outcome) => {
                  if (!outcome.ok) return
                  setConfirmClose(false)
                  close()
                })
              }}
            >
              {t(edit.saving ? 'viewer.saving' : 'viewer.saveAndClose')}
            </Button>
          </>
        }
      >
        <p className={s.confirmText}>{t('viewer.confirmBody', { name })}</p>
      </Dialog>
    </section>
  )
}

/* ── 头上那几格 ────────────────────────────────────────────────────────── */

/**
 * 路径 = **一颗钮**:点它就复制,就地变「已复制」(定稿)。它不是一行可读的字,
 * 所以它可以被截断 —— 要看全整条路径的场合是双击详情面,那里的路径行允许折行。
 * 反馈不弹通知(08-31 拍板:复制走就地反馈)。
 */
function CopyPathAction({ path, t }: { path: string; t: TFn }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!path) return null

  return (
    <button
      type="button"
      className={copied ? `${s.pathBtn} ${s.pathBtnDone}` : s.pathBtn}
      data-testid="viewer-copy-path"
      onClick={() => {
        void copyText(path).then((ok) => {
          announce(t(ok ? 'common.copied' : 'common.copyFailed'))
          setCopied(ok)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
        })
      }}
    >
      {copied ? (
        <Check className={s.pathIcon} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Copy className={s.pathIcon} strokeWidth={1.75} aria-hidden="true" />
      )}
      <span className={s.pathText}>{copied ? t('common.copied') : path}</span>
    </button>
  )
}

/**
 * 「打开方式」—— 与树行菜单里那一组**同一张表、同一份记忆**
 * (`data/file-open-mode.ts`)。今天只有「面板内」真兑现,其余六档记住选择 +
 * 一句「还没接上」:那是既有的诚实降级,这里一个字都不改口径。
 */
function OpenModeAction({ t }: { t: TFn }) {
  const mode = useFileOpenMode((st) => st.mode)
  const setMode = useFileOpenMode((st) => st.setMode)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  return (
    <>
      <button
        type="button"
        className={s.action}
        data-testid="viewer-open-mode"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setAt({ x: rect.left, y: rect.bottom })
        }}
      >
        {t(FILE_OPEN_MODE_LABELS[mode])}
        <ChevronDown className={s.actionIcon} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {at && (
        <Menu
          x={at.x}
          y={at.y}
          onClose={() => setAt(null)}
          label={t('files.openWith')}
          minWidth="var(--files-menu-w)"
        >
          <MenuSection>{t('files.openWith')}</MenuSection>
          {FILE_OPEN_MODES.map((option) => (
            <MenuItem key={option} checked={option === mode} onClick={() => setMode(option)}>
              <span className={s.menuLine}>
                <span className={s.menuMain}>{t(FILE_OPEN_MODE_LABELS[option])}</span>
                {!isWiredFileOpenMode(option) && (
                  <span className={s.menuTrail}>{t('files.openModeSoon')}</span>
                )}
              </span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  )
}

/* ── 编辑区 ────────────────────────────────────────────────────────────── */

/**
 * 轻编辑(定稿确认案)。**等宽、无高亮、无补全的一块可写文本** —— 它诚实地
 * 定位成「改配置、改几行」,不是一台编辑器。高亮编辑将来若真需要再议,
 * 那时才轮到「要不要一台真编辑器」这个问题。
 *
 * 行号在编辑态**不画**:一块 textarea 里的行号要么跟着内容重排(要一台影子渲染
 * 层),要么就是错的 —— 画一列错的数字比不画糟得多。
 */
function EditArea({
  file,
  draft,
  onDraft,
  t,
}: {
  file: ViewerFile
  draft: string
  onDraft: (text: string) => void
  t: TFn
}) {
  return (
    <textarea
      className={s.editor}
      data-testid="viewer-editor"
      value={draft}
      spellCheck={false}
      aria-label={t('viewer.editing', { name: file.name })}
      onChange={(e) => onDraft(e.target.value)}
    />
  )
}

/* ── 脚:26 的状态栏 ───────────────────────────────────────────────────── */

function StatusBar({
  t,
  file,
  view,
  lineCount,
  status,
  statusItems,
  saving,
  savedAt,
  saveError,
  conflict,
  editing,
  onSave,
  onJump,
  onKeymap,
  onLoadMore,
}: {
  t: TFn
  file: ViewerFile | null
  view: ViewerView
  lineCount: number | undefined
  status: string | undefined
  statusItems: { id: string; labelKey: Parameters<TFn>[0]; on?: boolean; onToggle(): void }[]
  saving: boolean
  savedAt: number | undefined
  saveError: string | undefined
  conflict: boolean
  editing: boolean
  onSave: () => void
  onJump: () => void
  onKeymap: (id: string) => void
  onLoadMore: () => void
}) {
  const vim = view.keymap === 'vim'
  const keymaps = listKeymaps()
  const truncated = file && 'truncated' in file && file.truncated ? file : null
  const percent = truncated ? Math.min(99, Math.round((truncated.loaded / truncated.size) * 100)) : 0

  return (
    <div className={s.status} data-testid="viewer-status">
      {vim && (
        <span
          className={`${s.vimMode} ${view.vimMode === 'insert' ? s.vimInsert : s.vimNormal}`}
          data-testid="viewer-vim-mode"
        >
          {view.vimMode === 'insert' ? 'INSERT' : 'NORMAL'}
        </span>
      )}
      {status && <span className={s.statusFact}>{status}</span>}

      {/* 中段:载入进度 / 存盘读数。它是这一行里唯一的弯腰件。 */}
      <span className={s.statusMid}>
        {truncated ? (
          <>
            <span className={s.statusNote}>
              {t('viewer.loadedPercent', { percent: `${percent}`, size: formatBytes(truncated.size) })}
            </span>
            <button type="button" className={s.statusLink} onClick={onLoadMore}>
              {t('viewer.loadMore')}
            </button>
          </>
        ) : conflict ? (
          <span className={s.statusWarn}>{t('viewer.conflict')}</span>
        ) : saveError ? (
          <span className={s.statusWarn}>{saveError}</span>
        ) : savedAt ? (
          <span className={s.statusNote} data-testid="viewer-saved">
            {t('viewer.saved')}
          </span>
        ) : null}
      </span>

      {editing && (
        /* ③ 异步钮的 pending 态:存盘在飞时禁用并换字,不给第二次机会。 */
        <button
          type="button"
          className={s.statusLink}
          disabled={saving}
          data-testid="viewer-save"
          onClick={onSave}
        >
          {t(saving ? 'viewer.saving' : 'viewer.save')}
        </button>
      )}

      {/* Vim 开关。档只是一张表,换档即时生效且不重挂查看器。 */}
      {keymaps.length > 1 && (
        <button
          type="button"
          className={vim ? `${s.statusLink} ${s.statusLinkOn}` : s.statusLink}
          aria-pressed={vim}
          data-testid="viewer-vim-toggle"
          onClick={() => onKeymap(vim ? 'default' : 'vim')}
        >
          {t('viewer.keymapVim')}
        </button>
      )}

      {statusItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.on ? `${s.statusLink} ${s.statusLinkOn}` : s.statusLink}
          aria-pressed={item.on}
          onClick={item.onToggle}
        >
          {t(item.labelKey)}
        </button>
      ))}

      {lineCount !== undefined && (
        <button type="button" className={s.statusLink} data-testid="viewer-jump" onClick={onJump}>
          {t('viewer.lineReadout', { line: `${view.currentLine || 1}` })}
        </button>
      )}
    </div>
  )
}

export { isEditableFile }
