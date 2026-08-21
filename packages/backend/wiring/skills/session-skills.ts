import type { SkillDefinition } from '@shared/ipc.js'
import { DEFAULT_ONETHING_AGENT_ID } from '@onething/runtime/agents'
import { createOnethingSessionSkillsRuntime } from '@onething/runtime/skills'
import { getSettings } from '../../stores/settings.js'
import {
  ensureSkillsDirectories,
  loadAllSkills,
  loadProjectSkillsForDirectory,
} from './index.js'
import { consolePort, getLogger } from '../../logging/index.js'

const log = getLogger('skills')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


const sessionSkillsRuntime = createOnethingSessionSkillsRuntime<SkillDefinition>({
  ensureSkillsDirectories,
  loadAllSkills,
  loadProjectSkillsForDirectory,
  getSkillSettings: () => getSettings().skills,
  logger: consoleLog,
})

export async function initializeSessionSkills(): Promise<void> {
  await sessionSkillsRuntime.initialize()
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
