/**
 * Built-in Tools Registration — 桌面全量档(`toolRegistry: 'full'`)。
 *
 * All tools use the Tool.define() pattern.
 * 1. Create a new file using Tool.define()
 * 2. Export the tool (e.g., `export const MyTool = Tool.define(...)`)
 * 3. Import and add to the matching **scene group** below
 *
 * ── 注册 ≠ 呈现(2026-08-18 工具梳理)────────────────────────────────────
 *
 * 注册表是**目录**,不是模型每一回合看到的清单。同一个进程里同时跑着普通对话、
 * 群房回合、派工出去的工作会话,它们要的工具面不同,而注册表只有一份 —— 所以
 * 「进哪个场景才给哪些工具」不在这里决定,在回合入口按场景算:
 * `@onething/runtime/tools` 的 `resolveSceneHiddenToolIds`(scene-surface.ts)。
 *
 * 这张表按场景分组只是为了让人一眼看出「普通聊天到底带几个工具」;分组本身不
 * 改变注册行为,注册永远是全量的。分组与 scene-surface 的表**一一对应**:改一边
 * 记得改另一边(有测试钉着:scene-surface.test.ts)。
 */

import { registerTool } from '../registry.js'

// ── 普通对话(chat)—— 每一回合都在的地板 ──────────────────────────────
import { BashTool } from './bash.js'
import { EditTool } from './edit.js'
import { ReadTool } from './read.js'
import { WriteTool } from './write.js'
import { VariableTool } from './variable.js'
import { RadioTool } from './radio.js'
import { PracticeTool } from './practice.js'
import { TaskTool } from './task.js'
import { AskUserTool } from './ask-user.js'
import { TimeTool } from '@onething/runtime/tools'
import { WebSearchTool } from './web-search/index.js'
import { WebOpenTool } from './web-search/open.js'

// ── 目标(goal)—— 只在会话有 active goal 的回合出现 ─────────────────────
import { GoalTool } from './goal.js'

// ── 协作场子(room / agent / work)—— 普通聊天看不到 ─────────────────────
import { BoardTool } from '../../collab/board-tool.js'
import { HistoryTool } from '../../collab/history-tool.js'
import { NotebookTool } from '../../collab/actors/notebook-tool.js'
import { SayTool, registerCollabSendMessageLegacyAlias } from '../../collab/say-tool.js'

/**
 * 普通对话的地板。找文件名 / 找内容不再是独立工具(find / grep / glob 于
 * 2026-08-18 摘掉):`bash` 里的 rg / fd 就是同一件事,少三个入口少三份描述。
 * 后台任务(bash `run_in_background`)的读取与停止同样并回 bash:启动结果里带
 * 日志路径与进程组 id,`bash tail` / `kill` 就够了 —— bash_output / kill_bash 同日摘掉。
 */
const chatTools = [
  BashTool,
  EditTool,
  ReadTool,
  WriteTool,
  VariableTool,
  RadioTool,
  PracticeTool,
  // 派工(自举差距审计 P0-3)。只在桌面全量档:它开真会话、真花 token、
  // 真在本机跑工具 —— headless 与 readonly 两档都不该有。
  TaskTool,
  // 提问(E1/E2 交互协议的原生消费者)。同样只在桌面全量档:headless 与 readonly
  // 两档没有人在屏幕前,注册一个没人能答的提问工具就是在清单里写谎话。
  AskUserTool,
  TimeTool,
  WebSearchTool,
  WebOpenTool,
]

const goalTools = [GoalTool]

/**
 * 协作工具。注册是全局的,可见性不是:场子门在 `collab/tool-surface.ts`
 * (执行期的闸),回合工具面在 scene-surface(给模型看的清单)。
 * Collab v3 D2 的 notebook 同理 —— 只挂到 agent / work 两个场子。
 */
const collabTools = [BoardTool, HistoryTool, NotebookTool, SayTool]

// All built-in tools (Tool.define() format)
// Note: some tools are async and need separate initialization
const builtinTools = [...chatTools, ...goalTools, ...collabTools]

/**
 * Register all built-in tools with the registry
 */
export function registerBuiltinTools(): void {
  for (const tool of builtinTools) {
    registerTool(tool)
  }
  registerCollabSendMessageLegacyAlias()

  console.log(`[BuiltinTools] Registered ${builtinTools.length} built-in tools`)
}
