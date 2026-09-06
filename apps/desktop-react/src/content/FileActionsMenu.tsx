import { useEffect, useRef, useState } from 'react'
import { Kbd } from '../ui/Kbd'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { announce } from '../ui/a11y/live-region'
import { COPY_FEEDBACK_MS } from '../components/motion'
import { formatCombo, platformOf } from '../keymap/transitions'
import { copyText } from '../services/clipboard'
import { useT } from '../i18n'
import type { TFn } from '../i18n'
import { revealKey, revealMutation, useFilesSource } from '../data/files-source'
import { viewerKindOfPath } from '../data/viewer-kinds'
import { resolveViewerByKind } from './viewer/registry'
import { useViewerInstance, useViewerSource } from '../data/viewer-source'
import {
  FILE_OPEN_MODES,
  FILE_OPEN_MODE_LABELS,
  useFileOpenMode,
} from '../data/file-open-mode'
import {
  closeFileEverywhere,
  fileRef,
  openFileInCurrentTarget,
  setFileOpenMode,
} from './viewer/open-target'
import { refId } from '../workbench/kinds'
import { CENTER_REGION } from '../workbench/regions'
import { openStateOf, useWorkbenchStore } from '../workbench/store'
import { leavesOf } from '../workbench/tree'
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
  const editingThis = useViewerSource((st) => st.instances[target.path]?.edit.editing === true)
  /*
   * 这一份此刻的三态(设计 §2.3)。菜单据此决定「隐藏 / 关闭」两行画不画:
   * 没开的文件谈不上隐藏与关闭。判据整件是纯函数 `openStateOf` —— 与树行那颗
   * 点读的是同一句话。(「保留」那一行随预览 tab 一起退役,W6-a。)
   */
  const regions = useWorkbenchStore((st) => st.regions)
  const hiddenTabs = useWorkbenchStore((st) => st.hidden)
  const panelPath = useWorkbenchStore((st) => st.panelPath)
  const openState = file
    ? openStateOf({ regions, hidden: hiddenTabs, panelPath }, fileRef(target.path))
    : null
  /** 这一份在树里的坐标(叶 + 下标)。答不出 = 它不在树里(没开 / 在分栏里 / 藏着)。 */
  const seat = file ? seatOf(regions, target.path) : null
  /*
   * **这一型自述的那几档看法**(W7-c)。判据只问**型**,不问这份文件读进来没有
   * ——树行上右键那一路手上一个字节都没有,而「markdown 有两档看法」在那时就成立
   * (判词写在 `resolveViewerByKind` 上)。没有 `viewModes` 的型整节不画。
   */
  const viewModes = (() => {
    if (!file) return null
    const handler = resolveViewerByKind(viewerKindOfPath(target.path))
    if (!handler?.viewModes || !handler.viewModesLabelKey) return null
    return { modes: handler.viewModes, labelKey: handler.viewModesLabelKey }
  })()
  /*
   * 那一格勾读的是**这一份实例此刻的 view**。它是订阅(勾要跟着切换动),
   * 而 `setView` 那一下走 `getState()`(动作,不是要渲染的值)。
   */
  const viewNow = useViewerInstance(target.path).view
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
              useViewerSource.getState().setEditing(target.path, false)
            } else {
              openFileInCurrentTarget(target.path)
              useViewerSource.getState().setEditing(target.path, true)
            }
            onClose()
          }}
        >
          <span className={s.menuLine}>
            <span className={s.menuMain}>{t(editingThis ? 'viewer.editDone' : 'viewer.edit')}</span>
          </span>
        </MenuItem>
      )}

      {/*
        * ── 标签的一生:隐藏 / 关闭 + 两向分屏(W1,设计 §2.3 / §2.4)────────────
        * 四行都落在这一张表里,不散在叶檐上 —— **动作单产地 = 右键上下文菜单**
        * (09-01 判例)。叶檐上只有「✕ = 关闭」那一颗顺手路与「⋯ = 隐藏的标签」
        * 那一格收纳处,它们是同一批动作的快捷入口,不是第二张表。
        *
        * 「保留」那一行**W6-a 随预览 tab 一起退役**:单击开的就是一格正式标签,
        * 「留下来」这句话没有对象了。
        *
        * 两行的在场判据各不相同,写在各自的条件里:
        *  · 隐藏 / 关闭 —— 它得先在树里(没开的文件谈不上);
        *  · 两向分屏 —— 打开一份**新的**到旁边,所以任何文件都可以。
        */}
      {file && seat && (
        <MenuItem
          onClick={() => {
            useWorkbenchStore.getState().hideTab(seat.leafId, seat.index)
            onClose()
          }}
        >
          <span className={s.menuLine}>
            <span className={s.menuMain}>{t('files.menuHide')}</span>
          </span>
        </MenuItem>
      )}
      {file && openState !== null && (
        <MenuItem
          onClick={() => {
            onClose()
            // 关掉 = 从所有落点摘掉 + 丢实例。脏文件那一问由种类自己发起
            // (`ContentKind.beforeClose`),菜单不重复问一遍。
            closeFileEverywhere(target.path)
          }}
        >
          <span className={s.menuLine}>
            <span className={s.menuMain}>{t('files.menuClose')}</span>
          </span>
        </MenuItem>
      )}
      {file && (
        <>
          <MenuItem
            onClick={() => {
              openBeside(target.path, 'row')
              onClose()
            }}
          >
            <span className={s.menuLine}>
              <span className={s.menuMain}>{t('files.menuOpenRight')}</span>
            </span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              openBeside(target.path, 'col')
              onClose()
            }}
          >
            <span className={s.menuLine}>
              <span className={s.menuMain}>{t('files.menuOpenBelow')}</span>
            </span>
          </MenuItem>
        </>
      )}

      {/*
        * ── 「视图」:这一型自己那组互斥的看法(W7-c 裁定 2)────────────────
        * markdown 的「渲染 / 源码」从前是叶檐动作组上一件 `Segmented`
        * (`ContentKind.toolbar` → `FileViewerToolbar`)。用户 09-05 说「按钮太多」,
        * 顶栏的内容工具条槽位整格删掉,这一组跟着搬进**这张表** —— 一个文件能做
        * 什么全仓只有一张表(09-01 判例),看法也是这个文件能做的事之一。
        *
        * 这里**一个型名都不出现**:有哪几档由那一型自述(`ViewerHandler.viewModes`),
        * 没有 `viewModes` 的型整节不画。第二种型要加两档看法,只改它自己那一行。
        */}
      {file && viewModes && (
        <>
          <MenuSeparator />
          <MenuSection>{t(viewModes.labelKey)}</MenuSection>
          {viewModes.modes.map((mode2) => (
            <MenuItem
              key={mode2.id}
              checked={mode2.on(viewNow)}
              onClick={() => {
                useViewerSource.getState().setView(target.path, mode2.patch)
                onClose()
              }}
            >
              <span className={s.menuLine}>
                <span className={s.menuMain}>{t(mode2.labelKey)}</span>
              </span>
            </MenuItem>
          ))}
        </>
      )}

      {file && (
        <>
          <MenuSeparator />
          <MenuSection>{t('files.openWith')}</MenuSection>
          {FILE_OPEN_MODES.map((option) => (
            <MenuItem
              key={option}
              checked={option === mode}
              /*
               * **七档全通**(W4):架子与浮窗的身子换成拼贴树之后,插一个文件进
               * 架子与插进中央区走的是同一句 `openRef(ref, { region })`。
               * W1-a 那格 `disabled={!isWiredFileOpenMode(option)}` 与它旁边那句
               * 「下一批」的注脚随之整段退役。
               */
              onClick={() => {
                // **选档即生效**:手上那一份当场搬过去(编排在 open-target)。
                setFileOpenMode(option)
                onClose()
              }}
            >
              <span className={s.menuLine}>
                <span className={s.menuMain}>{t(FILE_OPEN_MODE_LABELS[option])}</span>
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
      {/*
        * reveal 走 `revealMutation`(7d)。**这一条上没有 aria-busy**:点完菜单
        * 当场关掉,那颗控件下一帧就不在了 —— 律③要的「反馈长在发起它的那个控件上」
        * 在这里没有落点(反馈只能是失败时那条通知)。留下的只有那道二次闸,
        * 它挡的是「同一条路径的上一发还没回来」。
        */}
      <MenuItem
        onClick={() => {
          onClose()
          if (revealMutation.isPending(revealKey(target.path))) return
          void revealMutation.run(target.path)
        }}
      >
        <span className={s.menuLine}>
          <span className={s.menuMain}>{t('files.reveal')}</span>
        </span>
      </MenuItem>
    </Menu>
  )
}

/** 这一份在树里的坐标。答不出 = 它不在任何一棵树上。 */
function seatOf(
  regions: Record<string, import('../workbench/tree').PaneNode>,
  path: string,
): { region: string; leafId: string; index: number } | null {
  const id = refId(fileRef(path))
  for (const [region, tree] of Object.entries(regions)) {
    for (const leaf of leavesOf(tree)) {
      const at = leaf.tabs.findIndex((tab) => refId(tab) === id)
      if (at >= 0) return { region, leafId: leaf.id, index: at }
    }
  }
  return null
}

/**
 * 「在右侧 / 在下方打开」。**先切叶再插**:切出来的新叶带走原叶的活动 tab,
 * 然后把这一份插进那片新叶 —— 于是「在旁边打开这个文件」是两步既有的树操作,
 * 不是一条新路径。原叶只有一格时切不动(切出去它就空了),那时退成「就地打开」。
 */
function openBeside(path: string, dir: 'row' | 'col'): void {
  const state = useWorkbenchStore.getState()
  const tree = state.regions[CENTER_REGION]
  const leaves = tree ? leavesOf(tree) : []
  const leaf = leaves.find((l) => l.id === state.focusLeafId) ?? leaves[0]
  if (leaf && leaf.tabs.length > 1) state.splitLeaf(leaf.id, dir)
  openFileInCurrentTarget(path)
}
