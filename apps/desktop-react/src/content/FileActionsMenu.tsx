import { useEffect, useRef, useState } from 'react'
import { Kbd } from '../ui/Kbd'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { announce } from '../ui/a11y/live-region'
import { COPY_FEEDBACK_MS } from '../components/motion'
import { formatCombo, platformOf } from '../keymap/transitions'
import { copyText } from '../services/clipboard'
import { useT } from '../i18n'
import type { TFn } from '../i18n'
import { useFilesSource } from '../data/files-source'
import { viewerKindOfPath } from '../data/viewer-kinds'
import { useViewerSource } from '../data/viewer-source'
import {
  FILE_OPEN_MODES,
  FILE_OPEN_MODE_LABELS,
  isWiredFileOpenMode,
  useFileOpenMode,
} from '../data/file-open-mode'
import { openFileInCurrentTarget, setFileOpenMode } from './viewer/open-target'
import s from './FilesPanel.module.css'

/**
 * **一个文件的全部动作 —— 唯一一张表**(09-01 用户裁定,CLAUDE.md 禁令区立法)。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 真机走查报障:查看器的头上挤着「复制路径 / 铅笔 / 在 Finder 显示 / 打开方式 ∨」
 * 四件,文件名被挤成 `kimi-sli…`;而同样这几件事在树行菜单里**又有一份**。
 * 用户的裁定是把动作全收进右键菜单,树行与查看区**同一张表**,头上只留身份。
 *
 * 于是这个文件是那张表的唯一产地:两个宿主(FilesPanel 的行、FileViewer 的身)
 * 各自决定「在哪儿弹」,弹出来的**内容与次序一个字不差**——不靠自觉,靠只有一份。
 *
 * ── 为什么「打开方式」是一组平铺项而不是二级子菜单 ────────────────────────
 * 裁定里写的是「七档子菜单」。`ui/Menu` 今天**没有**二级菜单能力(没有展开态、
 * 没有跨层的 roving 焦点、没有 APG 那套 `aria-haspopup`/悬停延迟)。在这一批里
 * 现造一套二级菜单,等于在一个交互修复批里顺手加一件浮层原语 —— 那是拍板件。
 * 所以这里照既有先例给一个**带小标题的分组**(MenuSection + 七行 + 一句注脚),
 * 与它从前在行菜单里长的样子逐字相同。**记档:二级菜单属 ui/Menu 的独立一批。**
 *
 * ── 「复制路径」按下之后菜单不关 ─────────────────────────────────────────
 * 反馈要落在被按的那一条上(就地变「已复制」),关掉就没地方落了(复制反馈
 * 零 Toast,是禁令区那条)。
 */

/** 菜单认得的一个目标。目录与文件走同一张表,差别只在头两行。 */
export interface FileActionTarget {
  path: string
  name: string
  type: 'file' | 'directory'
  /** 目录才有:此刻展着没有(第一行说「展开」还是「收起」)。缺席按未展算。 */
  expanded?: boolean
}

/**
 * 复制一条路径 + 说给读屏听。**两处调用方(菜单、详情浮层)共用这一口**,
 * 免得「复制成功了没有」在两处各判一次。它不产生通知(禁令区:复制走就地反馈)。
 */
export async function copyPathAnnouncing(text: string, t: TFn): Promise<boolean> {
  // 写那一下归 services/clipboard;说给读屏听那一句归这里 ——
  // 「怎么反馈」是各处现场自己的事。
  const ok = await copyText(text)
  announce(t(ok ? 'common.copied' : 'common.copyFailed'))
  return ok
}

/**
 * 这条路径**打开之后编辑得动吗**。判据问的是分型表那张纯表的预判那一半
 * (`viewerKindOfPath`,不用读盘就知道)——菜单在文件还没被打开时就得说得出
 * 「编辑」这一行画不画,那时手上没有任何字节。
 *
 * 预判可能被读完之后改判(`.txt` 里塞着一个 ELF),那时铅笔按下去查看器自己
 * 会说「这是二进制」。**多画一行 vs 少画一行**:少画的那种用户永远找不到,
 * 多画的那种最坏是一句如实的拒绝。
 */
function looksEditable(path: string): boolean {
  const kind = viewerKindOfPath(path)
  return kind === 'code' || kind === 'markdown'
}

export function FileActionsMenu({
  target,
  x,
  y,
  onClose,
  onDetail,
}: {
  target: FileActionTarget
  x: number
  y: number
  onClose: () => void
  /** 详情由**宿主**开(浮层要贴着宿主自己那个锚点长)。 */
  onDetail: () => void
}) {
  const t = useT()
  const mode = useFileOpenMode((st) => st.mode)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const platform = platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const detailKeys = formatCombo({ meta: true, key: 'i' }, platform)

  const file = target.type === 'file'
  /**
   * 铅笔从查看器檐上撤下来之后,**进 / 出编辑都只剩这一条路**。所以它是一档开关:
   * 正在编辑的就是这个文件时说「完成编辑」,否则说「编辑」。
   * 判据是「查看器手上那份 + 它在编辑态」两条同时成立 —— 光看 editing 会让
   * 树上另一个文件的菜单也说「完成编辑」,那是在替别人说话。
   */
  const editingThis = useViewerSource(
    (st) => st.edit.editing && st.file?.path === target.path,
  )
  const openLabel = file
    ? t('files.menuOpen')
    : t(target.expanded ? 'files.menuCollapse' : 'files.menuExpand')

  /** 打开(或展开)。**取动作而不是订阅** —— 这是事件里的一次动作,不是要渲染的值。 */
  const activate = () => {
    if (file) openFileInCurrentTarget(target.path)
    else void useFilesSource.getState().toggleDir(target.path)
  }

  return (
    <Menu
      x={x}
      y={y}
      onClose={onClose}
      label={t('files.rowMenu')}
      minWidth="var(--files-menu-w)"
    >
      <MenuSection>{target.name}</MenuSection>
      <MenuItem
        onClick={() => {
          activate()
          onClose()
        }}
      >
        <span className={s.menuLine}>
          <span className={s.menuMain}>{openLabel}</span>
          {/* 右缘那一格说的是**当下的打开方式**(文件才有意义 —— 目录没有查看器)。 */}
          {file && <span className={s.menuTrail}>{t(FILE_OPEN_MODE_LABELS[mode])}</span>}
        </span>
      </MenuItem>
      {/*
       * 「编辑」= 打开它并把铅笔按下去。它从查看器头上搬来的(裁定:头只留身份),
       * 而搬过来之后顺带多了一件本事:**在树上就能直接进编辑**,不必先打开再找钮。
       */}
      {file && looksEditable(target.path) && (
        <MenuItem
          onClick={() => {
            if (editingThis) {
              useViewerSource.getState().setEditing(false)
            } else {
              openFileInCurrentTarget(target.path)
              useViewerSource.getState().setEditing(true)
            }
            onClose()
          }}
        >
          <span className={s.menuLine}>
            <span className={s.menuMain}>{t(editingThis ? 'viewer.editDone' : 'viewer.edit')}</span>
          </span>
        </MenuItem>
      )}

      {file && (
        <>
          <MenuSeparator />
          <MenuSection>{t('files.openWith')}</MenuSection>
          {FILE_OPEN_MODES.map((option) => (
            <MenuItem
              key={option}
              checked={option === mode}
              onClick={() => {
                // **选档即生效**:开着的那份查看器当场搬过去(编排在 open-target)。
                setFileOpenMode(option)
                onClose()
              }}
            >
              <span className={s.menuLine}>
                <span className={s.menuMain}>{t(FILE_OPEN_MODE_LABELS[option])}</span>
                {!isWiredFileOpenMode(option) && (
                  <span className={s.menuTrail}>{t('files.openModeSoon')}</span>
                )}
              </span>
            </MenuItem>
          ))}
        </>
      )}

      <MenuSeparator />
      <MenuItem
        onClick={() => {
          onClose()
          onDetail()
        }}
      >
        <span className={s.menuLine}>
          <span className={s.menuMain}>{t('files.detailAction')}</span>
          <span className={s.menuKeys}>
            {detailKeys.map((cap) => (
              <Kbd key={cap}>{cap}</Kbd>
            ))}
          </span>
        </span>
      </MenuItem>
      <MenuItem
        onClick={() => {
          void copyPathAnnouncing(target.path, t).then((ok) => {
            setCopied(ok)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
          })
        }}
      >
        <span className={s.menuLine}>
          <span className={copied ? `${s.menuMain} ${s.menuDone}` : s.menuMain}>
            {t(copied ? 'files.copiedPath' : 'files.copyPath')}
          </span>
        </span>
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose()
          void useFilesSource.getState().reveal(target.path)
        }}
      >
        <span className={s.menuLine}>
          <span className={s.menuMain}>{t('files.reveal')}</span>
        </span>
      </MenuItem>
    </Menu>
  )
}
