/**
 * Public entry for the project-dirs subsystem.
 *
 *   - bootstrapProjectDirs() : warms the store cache. Idempotent.
 *   - getProjectsStore()     : read/write access (re-exported)
 *   - buildProjectDirsPromptVars : prompt rendering helpers
 *   - IPC wiring lives in ./ipc.js to keep this public module headless-safe
 *
 * The module owns its own storage (default space: `~/.onething/project-dirs/`;
 * other spaces: `~/.onething/workspaces/<id>/project-dirs/`) and
 * has no dependency on the variables subsystem. Cross-module wiring
 * (workdir auto-touch) is implemented at the variables side via an
 * explicit import — see src/main/variables/gateways.ts.
 */

import { getProjectsStore } from '@onething/runtime/project-dirs/store'
import {
  buildProjectDirsPromptVars as buildProjectDirsPromptVarsForSpace,
  type ProjectDirsPromptVars,
} from '@onething/runtime/project-dirs/prompt'
import { resolveSessionSpaceId } from '../../stores/sessions.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('project-dirs')


let bootstrapped = false

/**
 * A3(方案 §2.5,(b) 类闩):返回 disposer,由 `assembleSteps` 的 `own()` 接住。
 *
 * 这一件本身只是**暖缓存**(`getProjectsStore().initialize()` 读一次盘),没有
 * 订阅、没有定时器,所以 disposer 只把闩放回去 —— 让第二份装配真的再暖一次,
 * 而不是靠"上一份进程里读过了"这个偶然。store 自己是进程级单例,不在这里关。
 */
export function bootstrapProjectDirs(): () => void {
  if (bootstrapped) return () => {}
  bootstrapped = true
  getProjectsStore().initialize()
  log.info('project-dirs subsystem bootstrapped')
  return () => {
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
export function buildProjectDirsPromptVars(
  workingDirectory?: string,
  options: { sessionId?: string; knownLimit?: number; collapseHome?: boolean } = {},
): ProjectDirsPromptVars {
  const { sessionId, ...rest } = options
  return buildProjectDirsPromptVarsForSpace(workingDirectory, {
    ...rest,
    spaceId: resolveSessionSpaceId(sessionId),
  })
}

export { getProjectsStore } from '@onething/runtime/project-dirs/store'
export type {
  ProjectDirsPromptVars,
  ActiveProjectVars,
  KnownProjectsVars,
} from '@onething/runtime/project-dirs/prompt'
export type { Project, ProjectIndexEntry, ProjectId } from '@onething/runtime/project-dirs'
