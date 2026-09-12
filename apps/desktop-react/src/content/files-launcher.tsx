import { MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { t } from '../i18n'
import { baseNameOf, useFilesSource } from '../data/files-source'
import { registerStageLauncher } from '../stage/launchers'
import { useWorkbenchStore } from '../workbench/store'
import { FILES_ITEM_ID, openDirectoryPanel, sessionDirOf } from './dir-open'
import { DIR_KIND, dirRef } from './kinds/dir-ref'
import { useOpenDirDialog } from './files/open-dir-hub'

/**
 * **「打开一份目录」那个动作已经不在这只文件里**(2026-09-12 review 打回)。
 * 它连同 `FILES_ITEM_ID` 与落点算法搬去了 `content/dir-open.ts`,理由整段写在
 * 那只文件头上:这里最后一句 `registerStageLauncher(...)` 是**模块级副作用**,
 * 谁 import 这只文件谁就顺手把「files 瓦是启动瓦」这条登记装进了自己的世界 ——
 * 消息气泡里的目录 chip 只想调一个函数,不该为此改变 Dock 的行为
 * (真事故:`stage/__tests__/summon-entries.test.ts` 5 红)。
 * 这里原样 re-export 那两口,老调用方一行不改。
 */
export { FILES_ITEM_ID, openDirectoryPanel, sessionDirOf } from './dir-open'

/**
 * **Dock 上那块瓦从「文件」变成「目录」**(W6-a,设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §3)。
 *
 * 用户原话:「files 本身应该是一个可以打开多个的存在,例如 note、例如 workdir,
 * 名字应该和 viewer 差不多,设置为目录名」。于是 `panel:files` 那一块面退役,
 * 那块瓦降格成**启动瓦**:
 *  · 点它    = 打开**当前会话的工作目录**那份面板;
 *  · 右键    = 最近打开过的那几个目录 + 「打开目录…」;
 *  · 拖它    = 拖出来的是 `dir:<当前会话的工作目录>`,不再是 `panel:files`。
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
      return cwd ? dirRef(cwd) : null
    },
    /*
     * **答不出 `dragRef` 时的退一步**(W7-c 裁定 6)。会话没绑目录时上面那一口
     * 答 null,而屏幕上可能正开着**别的**目录树 —— 点这块瓦要的是「让我看见目录」。
     * 交出去的是一个**种类名**,查找归 `workbench/tree.firstRefOfKindIn`(判词在
     * `stage/open-item.residentRefOf`):这块瓦只自述自己开的是哪一种。
     */
    residentKind: DIR_KIND,
    MenuRows: FilesLauncherMenuRows,
  },
  import.meta.hot,
)
