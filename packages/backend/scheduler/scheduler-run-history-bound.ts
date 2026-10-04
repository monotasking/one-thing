/**
 * 调度器运行历史的绑定单例(`<store>/scheduler/runs/`)。
 *
 * P3'a-3 从 `src/app/scheduler/run-history.ts` 归位。它吃 `@shared/ipc` 的
 * `SchedulerRunDetailDTO`。纯的那一半(`OnethingSchedulerRunHistory`)在
 * `./scheduler-run-history.js`,本文件只负责把它绑到 store 路径与 DTO 上。
 */
import {
  OnethingSchedulerRunHistory,
  getSchedulerRunHistoryPath,
  safeSchedulerRunTaskFileName,
} from './scheduler-run-history.js'
import {
  getOnethingSchedulerRunsDir,
} from '../storage/storage.js'
import type { SchedulerRunDetailDTO } from '@shared/ipc.js'
import { consolePort, getLogger } from '../logging/logging.js'
import type { ConsoleLikePort } from '@onething/backend/logging'
import type { SchedulerRunHistoryLogger } from '@onething/backend/scheduler/scheduler-run-history'

const log = getLogger('scheduler')
/** 注入式鸭子 logger 端口的过渡替身(logging/logging-console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & SchedulerRunHistoryLogger = consolePort(log)


const runHistory = new OnethingSchedulerRunHistory<SchedulerRunDetailDTO>({
  runsDir: getOnethingSchedulerRunsDir,
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
