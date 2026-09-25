import { useEffect } from 'react'
import { MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { t } from '../i18n'
import { useQuery } from '../data/kernel'
import { terminalListQuery } from '../data/terminal-source'
import { sessionDirOf } from './dir-open'
import { findItem } from '../stage/items'
import { registerStageLauncher } from '../stage/launchers'
import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import { CENTER_REGION, edgeRegion, floatRegion } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { findLeaf, firstRefOfKindIn } from '../workbench/tree'
import { regionOfLeafIn, regionOfRefIn, useWorkbenchStore } from '../workbench/store'
import { createTerminal, requestTerminalFocus } from './terminal/registry'
import { TERMINAL_KIND, terminalRef } from './terminal/terminal-ref'
import { requestDirectory } from './files/open-dir-hub'
import type { PlacementMemory } from '../stage/types'
import type { ContentRef } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'

/**
 * **Dock 上那块「终端」瓦降格成启动瓦**(T1,方案 §2.1-6;照 `files-launcher` 的形)。
 *
 * 从前它是「一块面」(`panel:terminal` → 一份写死的假 `<pre>`)。终端不是一块面,
 * 它是**一族**:一格 PTY 一份 `terminal:<id>`。所以那块瓦要做的事变成了
 * 「开哪一格」:
 *  · 点它    = 在**当前会话的工作目录**开一格,落底架;
 *  · 右键    = 活着的那几格各一行(点 = 激活)+「新建终端」+「在目录…新建」;
 *  · 拖它    = 拖出屏幕上那一格终端。
 *
 * 它不是 Dock 里的一句 `if` —— 判词整段在 `stage/launchers.ts` 的文件头上
 * (「瓦自述,Dock 读表」)。
 *
 * ── 落点:记忆 > 天生,天生 = **底架** ───────────────────────────────────
 * 与 `files-launcher.regionForLauncher` 是同一只的两份实例(它读 `files` 那一格
 * 记忆,这只读 `terminal` 那一格)。天生那一档写在 `stage/items.ts` 的
 * `defaultPlacement`:终端出厂落 `edge:bottom` —— 那是三十年来终端在编辑器里待
 * 的地方,而中央区是内容的地。用户自己摆过的算数(记忆压过它)。
 *
 * ── 「拖 = 焦点终端」的口径 ─────────────────────────────────────────────
 * 方案原话是「拖出焦点终端」。实现按两步问:**焦点那片叶的活动 tab 是不是一格
 * 终端**,是就是它;不是(焦点在会话、在文件树……)就退成**读序第一格终端**
 * (`firstRefOfKindIn`,与 `residentKind` 那条退路同一只函数)。两步都答不出 =
 * `null` = 此刻拖不出东西 —— 拒绝比拖出一格画不出东西的假 tab 诚实
 * (`files-launcher` 那条判例逐字适用),而点一下那条路照旧会开一格新的。
 */

/** 「终端」那块启动瓦的 id(它就是从前那块「终端」面板瓦 —— id 不改)。 */
export const TERMINAL_ITEM_ID = 'terminal'

/**
 * 这块瓦此刻该把内容开到哪个区域。**记忆 > 天生**(见文件头)。
 *
 * 2026-09-14 起导出:代码块那颗「运行」新开的终端要落在**同一个地方** ——
 * 「终端开在哪」是这块瓦的记忆说了算,再抄一份判据就是让用户摆过的位置在
 * 某一条路上不算数。
 */
export function terminalLauncherRegion(ref: ContentRef): RegionId {
  const stage = useStageStore.getState()
  const memory: PlacementMemory | undefined = stage.memory[TERMINAL_ITEM_ID]
  const wanted = memory ?? findItem(TERMINAL_ITEM_ID)?.defaultPlacement
  if (wanted?.kind === 'edge') return edgeRegion(wanted.side)
  if (wanted?.kind === 'float') {
    // 同一格内容已经有一扇自己的窗就交回那一扇(与 files-launcher 同一句)。
    const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
    if (already?.startsWith('float:')) return already
    const winId = nextFloatId()
    useStageStore.getState().ensureFloatRect(winId)
    return floatRegion(winId)
  }
  return CENTER_REGION
}

/** 屏幕上此刻那一格终端(焦点叶优先,否则读序第一格)。判词在文件头。 */
export function visibleTerminalRef(): ContentRef | null {
  const workbench = useWorkbenchStore.getState()
  const focusRegion = workbench.focusLeafId
    ? regionOfLeafIn(workbench.regions, workbench.focusLeafId)
    : null
  const tree = focusRegion ? workbench.regions[focusRegion] : undefined
  const leaf = tree && workbench.focusLeafId ? findLeaf(tree, workbench.focusLeafId) : null
  const active = leaf?.tabs[leaf.active]
  if (active && active.kind === TERMINAL_KIND) return active
  return firstRefOfKindIn(workbench.regions, TERMINAL_KIND)
}

/**
 * **创建半段:建一格 PTY,不摆、不点名**(K2 从 `openTerminal` 里拆出来的那一半)。
 *
 * 拆它的理由与 `browser-launcher.createBrowserTab` 逐字相同:同一次创建有**两种**
 * 摆法(启动瓦那条「记忆 > 天生 > 底架」,与叶响应者那条 ⌘T「紧挨着当前标签」),
 * 而把摆法焊在创建里就等于两条键各要一条创建路。
 *
 * `cwd` 缺席 = 当前会话那个工作目录;会话没绑目录 = **不给 cwd**,让后端按它
 * 自己那条 spawn 规矩落地(`buildSpawnProfile`)—— 壳这边编一个 `~` 出来只是
 * 把一条本来就有产地的判据抄第二遍。
 */
export async function createTerminalTab(cwd?: string): Promise<string> {
  const at = cwd ?? sessionDirOf() ?? undefined
  /*
   * **先把叶那个 chunk 拉下来,再去建 PTY**(两件事并发,等的是慢的那一件)。
   *
   * 叶是 `lazy` 进来的(xterm 在 import 的那一刻就探 canvas —— 判词在
   * `content/kinds/terminal.tsx` 上)。不预拉的话随后那句 `focusIntoRef` 会落空:
   * 它排在 React 提交之后,而那一拍提交的是 Suspense 的 `fallback`,作用域实例
   * 还没登记 —— 「送不进去不追」于是当场生效,人点开一格终端却不能打字。
   * 预拉之后 `lazy` 已经 resolved,第一次渲染就是真身,提交与登记在同一拍。
   */
  const [id] = await Promise.all([
    createTerminal(at ? { cwd: at } : {}),
    import('./terminal/TerminalLeaf'),
  ])
  return id
}

/**
 * **开一格终端并摆出来**(点瓦、右键「新建终端」、「在目录…新建」三处共用的唯一一只)。
 * 创建那一半在上面的 `createTerminalTab`,这里只剩点名与摆放。
 */
export async function openTerminal(cwd?: string): Promise<void> {
  const id = await createTerminalTab(cwd)
  const ref = terminalRef(id)
  /*
   * **打开什么,焦点进什么**(响应链规则 2)。次序即语义:**先点名再摆** ——
   * 那一格挂载时自己把条子取走(判词整段在 `registry.requestTerminalFocus` 上,
   * 含真机量到的病历:在外面调 `focusIntoRefAfterCommit` 会落在「叶那一层已经
   * 在了、内容那一格还没登记」的那一拍上,焦点停在叶根上,打字进不去)。
   *
   * 这一句**不能省**:`stage/focus-follow` 那条跟焦链判的是 `placements[瓦 id]`
   * 的前后差,而启动瓦开出来的是一格**内容**(`terminal:<id>`),那张表上一个
   * 字都没动。目录那块瓦今天也有同样的缺口 —— 对一棵目录树来说「焦点留在原处」
   * 还说得过去,对一格终端不行:人开终端就是为了打字。
   */
  requestTerminalFocus(id)
  useStageStore.getState().placeRef(ref, terminalLauncherRegion(ref))
}

/** 活着的那几格 + 新建两条。 */
function TerminalLauncherMenuRows({ onDone }: { onDone: () => void }) {
  const list = useQuery(terminalListQuery)
  // 菜单开着的这一段就是这条读数要新鲜的那一段(判词在 `terminal-source.ts`:
  // 它没有常驻订阅 —— 一张只在右键那一下出现的菜单不值得让全壳挂一条订阅)。
  useEffect(() => {
    void terminalListQuery.ensure()
  }, [])
  const alive = (list.data ?? []).filter((row) => !row.exited)
  return (
    <>
      {alive.length > 0 && (
        <>
          <MenuSection>{t('terminal.aliveSection')}</MenuSection>
          {alive.map((row) => (
            <MenuItem
              key={row.id}
              onClick={() => {
                const ref = terminalRef(row.id)
                // 已经在屏幕上就走四态(展开架子 / 点名 tab / 送焦点),
                // 不在就摆出来 —— 与 `stage/open-item` 那条判例同源。
                if (useStageStore.getState().summonRef(ref) === null) {
                  requestTerminalFocus(row.id)
                  useStageStore.getState().placeRef(ref, terminalLauncherRegion(ref))
                }
                onDone()
              }}
            >
              {row.title || row.cwd}
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuItem
        onClick={() => {
          void openTerminal()
          onDone()
        }}
      >
        {t('terminal.new')}
      </MenuItem>
      <MenuItem
        onClick={() => {
          /*
           * 「在目录…新建」复用**目录面板那只对话框**(`files/open-dir-hub`)——
           * 全壳只有一处「挑一个目录」的原生面。它交回来的那个目录由
           * `files-source.setRoot` 落地,这里读它的结果开一格终端。
           */
          onDone()
          void requestDirectory((dir: string) => void openTerminal(dir))
        }}
      >
        {t('terminal.newInDir')}
      </MenuItem>
    </>
  )
}

registerStageLauncher(
  TERMINAL_ITEM_ID,
  {
    open: () => void openTerminal(),
    dragRef: visibleTerminalRef,
    /*
     * `dragRef()` 答 null 时的退一步(W7-c 裁定 6):屏幕上有没有**同类**的一格
     * 开着。今天这两口的答案在「有终端开着」这一形下是同一格 —— 留着它是因为
     * 将来 `dragRef` 若收窄成「只认焦点叶那一格」,这条退路仍然要在。
     */
    residentKind: TERMINAL_KIND,
    MenuRows: TerminalLauncherMenuRows,
  },
  import.meta.hot,
)
