/**
 * Public entry for the project-dirs subsystem.
 *
 *   - bootstrapProjectDirs() : warms the store cache. Idempotent.
 *   - getProjectsStore()     : read/write access (re-exported)
 *   - buildProjectDirsPromptVarsForSession : prompt rendering helpers (by session; the by-space
 *     variant `buildProjectDirsPromptVarsForSpace` lives in project-dir-prompt.ts)
 *   - IPC wiring lives in ./ipc.js to keep this public module headless-safe
 *
 * The module owns its own storage (default space: `~/.onething/project-dirs/`;
 * other spaces: `~/.onething/workspaces/<id>/project-dirs/`) and
 * has no dependency on the variables subsystem. Cross-module wiring
 * (workdir auto-touch) is implemented at the variables side via an
 * explicit import — see src/main/variables/gateways.ts.
 */

import { forgetProjectsStore, getProjectsStore } from '@onething/backend/project-dir/project-dir-store'
import { onSpaceRemoved } from '@onething/backend/space'
import {
  buildProjectDirsPromptVarsForSpace,
  type ProjectDirsPromptVars,
} from './project-dir-prompt.js'
import { resolveSessionSpaceId } from '@onething/backend/session'
import { getLogger } from '@onething/backend/logging'

const log = getLogger('project-dirs')


let bootstrapped = false

/**
 * A3(方案 §2.5,(b) 类闩):返回 disposer,由 `assembleSteps` 的 `own()` 接住。
 *
 * 这一件是**暖缓存**(`getProjectsStore().initialize()` 读一次盘)外加一只删空间钩子的订阅,
 * 没有定时器,所以 disposer 退订钩子、把闩放回去 —— 让第二份装配真的再暖一次、再订一次,
 * 而不是靠"上一份进程里读过了"这个偶然。store 自己是进程级单例,不在这里关。
 */
export function bootstrapProjectDirs(): () => void {
  if (bootstrapped) return () => {}
  bootstrapped = true
  getProjectsStore().initialize()
  // 删空间时丢掉该空间的名册内存实例(留着它会把索引写回刚删掉的目录)。越层清零 C3(2026-10-04)
  // 之前是空间那一侧直接调 `forgetProjectsStore`;现在名册自己订空间的删房钩子,退订跟着这个 disposer 走。
  const stopForgetting = onSpaceRemoved(forgetProjectsStore)
  log.info('project-dirs subsystem bootstrapped')
  return () => {
    stopForgetting()
    bootstrapped = false
  }
}

/**
 * 提示词侧的名册变量 —— **按会话归属的 space 取**(批 B4)。
 *
 * 装配层是唯一知道「会话 → 空间」的地方(`resolveSessionSpaceId`),所以这条
 * 解析住在这里,而不是产品层的 `prompt.ts`(它只认 spaceId)。没有 sessionId
 * (快照的合成调用、测试)就落 default 空间 —— 与所有读取端同一句缺省。
 */
export function buildProjectDirsPromptVarsForSession(
  workingDirectory?: string,
  options: { sessionId?: string; knownLimit?: number; collapseHome?: boolean } = {},
): ProjectDirsPromptVars {
  const { sessionId, ...rest } = options
  return buildProjectDirsPromptVarsForSpace(workingDirectory, {
    ...rest,
    spaceId: resolveSessionSpaceId(sessionId),
  })
}

export { getProjectsStore } from '@onething/backend/project-dir/project-dir-store'
export type {
  ProjectDirsPromptVars,
  ActiveProjectVars,
  KnownProjectsVars,
} from '@onething/backend/project-dir/project-dir-prompt'
export type { Project, ProjectIndexEntry, ProjectId } from './project-dir-types.js'
