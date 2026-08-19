import {
  OnethingSchedulerRunHistory,
  getSchedulerRunHistoryPath,
  safeSchedulerRunTaskFileName,
} from '@onething/runtime/scheduler'
import { getSchedulerRunsDir } from '../stores/paths.js'
import type { SchedulerRunDetailDTO } from '@shared/ipc.js'
import { consolePort, getLogger } from '../logging/index.js'

const log = getLogger('scheduler')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


const runHistory = new OnethingSchedulerRunHistory<SchedulerRunDetailDTO>({
  runsDir: getSchedulerRunsDir,
  logger: consoleLog,
})

export {
  getSchedulerRunHistoryPath,
  safeSchedulerRunTaskFileName,
}

export function saveSchedulerRunDetail(detail: SchedulerRunDetailDTO): SchedulerRunDetailDTO {
  return runHistory.save(detail)
}

export function listSchedulerRunDetails(taskId: string, limit = 50): SchedulerRunDetailDTO[] {
  return runHistory.list(taskId, limit)
}

export function getSchedulerRunDetail(taskId: string, runId: string): SchedulerRunDetailDTO | undefined {
  return runHistory.get(taskId, runId)
}
