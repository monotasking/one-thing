import type { SkillDefinition } from '@shared/ipc.js'
import { DEFAULT_ONETHING_AGENT_ID } from '@onething/runtime/agents'
import { createOnethingSessionSkillsRuntime } from '@onething/runtime/skills'
import { getSettings } from '../../stores/settings.js'
import {
  ensureSkillsDirectories,
  loadAllSkills,
  loadProjectSkillsForDirectory,
} from './index.js'
import { consolePort, getLogger } from '../logging/index.js'
import type { OnethingSessionSkillsRuntimeAdapters } from '@onething/runtime/skills/session-skills'

const log = getLogger('skills')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


const sessionSkillsRuntimeAdapters: OnethingSessionSkillsRuntimeAdapters<SkillDefinition> = {
  ensureSkillsDirectories,
  loadAllSkills,
  loadProjectSkillsForDirectory,
  getSkillSettings: () => getSettings().skills,
  logger: consoleLog,
};
const sessionSkillsRuntime = createOnethingSessionSkillsRuntime<SkillDefinition>(sessionSkillsRuntimeAdapters)

export async function initializeSessionSkills(): Promise<void> {
  await sessionSkillsRuntime.initialize()
}

let sessionSkillsInitialized = false

/**
 * 幂等启动闩。P4c 第二批从 `@main/ipc/skills.ts` 搬来 —— 宿主启动序列(插件根注册完
 * 之后那一发)与 skills RPC 域的每一次 `getAll` 共用同一把闩,所以谁先到都只初始化一次。
 */
export async function initializeSkills(): Promise<void> {
  if (sessionSkillsInitialized) return
  await initializeSessionSkills()
  sessionSkillsInitialized = true
  log.info('session skills initialized')
}

export function getSkillsForSession(workingDirectory?: string, agentId?: string): SkillDefinition[] {
  // Sessions without an explicit agent run on the default agent, so skills
  // bound to it must still load for them.
  return sessionSkillsRuntime.getForSession(workingDirectory, agentId || DEFAULT_ONETHING_AGENT_ID)
}

export function getAllSkillsForDisplay(options: {
  workingDirectory?: string
  enabledOnly?: boolean
  agentId?: string
} = {}): SkillDefinition[] {
  return sessionSkillsRuntime.getAll(options)
}

export function invalidateSessionSkillsCache(workingDirectory?: string): void {
  sessionSkillsRuntime.invalidateCache(workingDirectory)
}

/** 带一行日志的失效入口(P4c 第二批从 `@main/ipc/skills.ts` 搬来)。 */
export function invalidateSkillsCache(workingDirectory?: string): void {
  invalidateSessionSkillsCache(workingDirectory)
  log.debug('skills cache invalidated', { workingDirectory: workingDirectory ?? null })
}
