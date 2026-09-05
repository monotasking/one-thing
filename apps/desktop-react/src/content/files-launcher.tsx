import { MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { t } from '../i18n'
import { baseNameOf, sessionCwdOf, useFilesSource } from '../data/files-source'
import { useSessionsSource } from '../data/sessions-source'
import { useExposeStore } from '../expose/store'
import { findItem } from '../stage/items'
import { registerStageLauncher } from '../stage/launchers'
import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import { CENTER_REGION, edgeRegion, floatRegion } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { regionOfRefIn, useWorkbenchStore } from '../workbench/store'
import { filesRootRef } from './kinds/files-root-ref'
import { useOpenDirDialog } from './files/open-dir-hub'
import type { PlacementMemory } from '../stage/types'
import type { ContentRef } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'

/**
 * **Dock 上那块瓦从「文件」变成「目录」**(W6-a,设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §3)。
 *
 * 用户原话:「files 本身应该是一个可以打开多个的存在,例如 note、例如 workdir,
 * 名字应该和 viewer 差不多,设置为目录名」。于是 `panel:files` 那一块面退役,
 * 那块瓦降格成**启动瓦**:
 *  · 点它    = 打开**当前会话的工作目录**那份面板;
 *  · 右键    = 最近打开过的那几个目录 + 「打开目录…」;
 *  · 拖它    = 拖出来的是 `files-root:<当前会话的工作目录>`,不再是 `panel:files`。
 *
 * ── 它为什么不是 Dock 里的一句 `if` ──────────────────────────────────────
 * 「加功能不许改骨架」:Dock 若为这块瓦写一句 if,下一块特殊的瓦就会写第二句。
 * 所以这三件事登记在 `stage/launchers.ts` 那张表上,Dock **读表**(表上没有这块瓦
 * 就照旧三条老路)。判词整段写在那只文件头上。
 *
 * ── 落点听记忆的,出厂听表的 ────────────────────────────────────────────
 * 「用户自己摆过的算数」:这块瓦若有位置记忆(`stage.memory['files']` —— 他把
 * 文件面板钉去过右边 / 弹成过浮窗),就按那一格开;没有记忆才听 `STAGE_ITEMS`
 * 上那一行 `defaultPlacement`(W6-a 起 = 左架子)。这与瓦那条老路
 * (`transitions.resolveOpen` 的 记忆 > 天生 > 全局默认档)是**同一个次序**,
 * 只是那一只答的是 `Placement`,这里要的是一个 `RegionId` —— 中间隔着
 * 「哪个区域装得下一格内容」这句翻译,所以不能直接借它。
 */

/** 「目录」那块启动瓦的 id(它就是从前那块「文件」瓦 —— id 不改,名字改了)。 */
export const FILES_ITEM_ID = 'files'

/** 当前会话的工作目录。答不出(会话没绑目录 / 名册还没到)= null。 */
export function sessionDirOf(): string | null {
  const sessionId = useExposeStore.getState().envSessionId
  return sessionCwdOf(useSessionsSource.getState().sessions, sessionId)
}

/**
 * 这块瓦此刻该把内容开到哪个区域。**记忆 > 天生**(见文件头)。
 *
 * `stage` / `full` 两档都落中央区:全屏不是一个住处(判词在 `stage/types.ts`),
 * 而一块目录面板铺满整扇窗不是任何人要的东西。
 */
function regionForLauncher(ref: ContentRef): RegionId {
  const stage = useStageStore.getState()
  const memory: PlacementMemory | undefined = stage.memory[FILES_ITEM_ID]
  const wanted = memory ?? findItem(FILES_ITEM_ID)?.defaultPlacement
  if (wanted?.kind === 'edge') return edgeRegion(wanted.side)
  if (wanted?.kind === 'float') {
    // 这份内容已经有一扇自己的窗就交回那一扇(同一档连点两次不该开出两扇装着
    // 同一个目录的窗)—— 与 `content/viewer/open-target.regionForMode` 同一句。
    const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
    if (already?.startsWith('float:')) return already
    const winId = nextFloatId()
    // 身量归形态机补(默认档 + 视口钳制两件事的产地都在那儿)。
    useStageStore.getState().ensureFloatRect(winId)
    return floatRegion(winId)
  }
  return CENTER_REGION
}

/**
 * **打开一份目录面板**(启动瓦、右键最近项、「打开目录…」三处共用的唯一一只)。
 *
 * 三件事,次序即语义:记一笔最近目录 → 算落点 → 摆过去。摆那一句走
 * `stage.placeRef`(它同时改树与形态机,而且经 `orchestrate` 那格缓冲 ——
 * 判词写在 `stage/store.placeRef` 上)。
 */
export function openDirectoryPanel(path: string): void {
  if (!path) return
  const ref = filesRootRef(path)
  useWorkbenchStore.getState().rememberRoot(path)
  useStageStore.getState().placeRef(ref, regionForLauncher(ref))
}

/**
 * 点那块瓦:开**当前会话的工作目录**。会话没绑目录时退到主目录(`~`)——
 * 那一格只有后端展得开,所以这条路是异步的(`files-source.setRoot` 是它唯一的
 * 产地,连同「根是从哪来的」那三档一起)。
 */
export async function openSessionDirectory(): Promise<void> {
  const cwd = sessionDirOf()
  const files = useFilesSource.getState()
  await files.setRoot(cwd)
  const root = useFilesSource.getState().root
  if (root) openDirectoryPanel(root)
}

/** 最近目录那几行 + 「打开目录…」。 */
function FilesLauncherMenuRows({ onDone }: { onDone: () => void }) {
  const recent = useWorkbenchStore((st) => st.recentRoots)
  const setOpenDir = useOpenDirDialog((st) => st.setOpen)
  return (
    <>
      {recent.length > 0 && (
        <>
          <MenuSection>{t('files.recentDirs')}</MenuSection>
          {recent.map((path) => (
            <MenuItem
              key={path}
              onClick={() => {
                openDirectoryPanel(path)
                onDone()
              }}
            >
              {/* 屏幕上写目录名,全路径由这一行自己的 title 说不出来 ——
                * 菜单行没有 Tooltip 的位置,所以名字后面跟一段父目录。 */}
              {baseNameOf(path) || path}
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuItem
        onClick={() => {
          setOpenDir(true)
          onDone()
        }}
      >
        {t('files.openDirTitle')}
      </MenuItem>
    </>
  )
}

registerStageLauncher(
  FILES_ITEM_ID,
  {
    open: () => void openSessionDirectory(),
    /*
     * 拖它拖出去的是**当前会话那个目录**。会话没绑目录时答 `null` = 此刻拖不出来
     * (`~` 要一次后端往返才展得开,而起拖是同步的一下)—— 拒绝比拖出一格
     * 画不出东西的假 tab 诚实。点一下那条路照旧会把它展开。
     */
    dragRef: () => {
      const cwd = sessionDirOf()
      return cwd ? filesRootRef(cwd) : null
    },
    MenuRows: FilesLauncherMenuRows,
  },
  import.meta.hot,
)
