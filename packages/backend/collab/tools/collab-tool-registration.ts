/**
 * 协作四只工具进目录(越层清零 A1,2026-10-04;CLAUDE.md 09-02 立法「能力自述、别人读表」)。
 *
 * 从前 `toolkit/toolkit-tier-catalogs.ts` 在三档目录里逐只写着 board / history / notebook /
 * send_message —— 工具目录认识协作。现在协作自己说「我服务哪几档、按什么顺序」,`backend.ts`
 * 在 `buildToolkitCatalog(tier)` 之后紧接着调一次 `registerCollabTools(catalog, tier)`,toolkit
 * 不再出现协作的名字。
 *
 * 两条要钉住的事实:
 *  - **三档的 id 集合逐字不变**:full 四只都有、headless 三只(没有 notebook)、readonly 一只没有。
 *    `toolkit/__tests__/catalog-tiers.test.ts` 先登记再比那三个集合。
 *  - **登记无条件**,不挂在 `collab: true` / 协调器启动上:server runtime 不开协调器,今天四只工具
 *    照样在它的目录里。
 *
 * 顺序就是目录的插入顺序,也就是模型请求里 `tools[]` 的顺序:full 档这四只本来就排在最后,逐字
 * 相同;headless 档从前排在 variable 与 time 之间,现在排到末尾(决策 D143)。
 *
 * 幂等:进程里第二次装配时 `buildToolkitCatalog` 交回的是同一本目录(按档缓存),已在的就不再登记。
 */
import type { Catalog, Tool } from '@onething/backend/toolkit'
import { createBoardTool } from './collab-tool-board.js'
import { createHistoryTool } from './collab-tool-history.js'
import { createNotebookTool } from './collab-tool-notebook.js'
import { createSendMessageTool } from './collab-tool-send-message.js'
import { boardAdapters, historyAdapters, notebookAdapters, sendMessageAdapters } from './collab-tool-adapters.js'
import { registerHostInjectableTools, type HostInjectableTool } from '@onething/backend/external-agent'
import { COLLAB_TOOL_VENUES, isCollabToolAllowedInVenue, type CollabVenueTool } from './collab-tool-surface.js'
import { sceneVenue } from './collab-tool-family.js'

/** 与 toolkit 的三档同名(`ToolCatalogTier`);这里只按字面认,不引 toolkit 的类型以外的东西。 */
export type CollabToolTier = 'full' | 'headless' | 'readonly'

const FACTORIES: Readonly<Record<CollabVenueTool, () => Tool>> = {
  board: () => createBoardTool(boardAdapters()),
  history: () => createHistoryTool(historyAdapters()),
  notebook: () => createNotebookTool(notebookAdapters()),
  send_message: () => createSendMessageTool(sendMessageAdapters()),
}

/**
 * 每一档登记哪几只、按什么顺序(从前三档目录里的那几行,逐字同序)。
 *
 * headless 没有 notebook:跨房笔记只在 v3 心智回合里有读者,CLI 守护进程那一档从来没给过它。
 * readonly 一只都没有:那一档的判据是「对本机零副作用」,协作工具会写房间。
 */
export const COLLAB_TOOLS_BY_TIER: Readonly<Record<CollabToolTier, readonly CollabVenueTool[]>> = {
  full: ['board', 'history', 'notebook', 'send_message'],
  headless: ['board', 'history', 'send_message'],
  readonly: [],
}

/**
 * 可以注进外部 agent 宿主工具面的协作工具,按场子表的键序(`send_message, board, history, notebook`)
 * —— 从前 `external-agent-host-mcp-tools.ts` 自己 `Object.keys(COLLAB_TOOL_VENUES)`、自己调
 * `isCollabToolAllowedInVenue`,现在由这里登记(越层清零 A5②)。每一项带的 `visibleIn` 与
 * `CollabTool.visibleIn` 逐字同一句。与档无关:readonly 档目录里没有这几只,外部 agent 那一侧取工具
 * 对象时取不到,照旧记一行 warn 再不注。
 */
export const COLLAB_HOST_INJECTABLE_TOOLS: readonly HostInjectableTool[] =
  (Object.keys(COLLAB_TOOL_VENUES) as CollabVenueTool[]).map(id => ({
    id,
    visibleIn: scene => isCollabToolAllowedInVenue(id, sceneVenue(scene)),
  }))

/**
 * 把这一档的协作工具登记进目录,并把可注入外部 agent 的那几只登记给 external-agent。
 * 返回这次真正登记进目录的 id(已在的不算)。
 */
export function registerCollabTools(catalog: Catalog, tier: CollabToolTier): string[] {
  registerHostInjectableTools(COLLAB_HOST_INJECTABLE_TOOLS)
  const registered: string[] = []
  for (const id of COLLAB_TOOLS_BY_TIER[tier] ?? COLLAB_TOOLS_BY_TIER.headless) {
    if (catalog.has(id)) continue
    catalog.register(FACTORIES[id]())
    registered.push(id)
  }
  return registered
}
