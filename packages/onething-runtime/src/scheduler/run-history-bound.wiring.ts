/**
 * 调度器运行历史的绑定单例(`<store>/scheduler/runs/`)。
 *
 * P3'a-3 从 `src/app/scheduler/run-history.ts` 归位。带 `.wiring` 后缀是因为它吃
 * `@shared/ipc` 的 `SchedulerRunDetailDTO` —— I3 的规矩:产品层里说跨进程词汇的
 * 文件把角色写进文件名(同 `agents/store-bound.wiring.ts` 的判例),而不是靠"住在
 * `src/app` 那棵树"来表达。纯的那一半(`OnethingSchedulerRunHistory`)在
 * `./run-history.js`,本文件只负责把它绑到 store 路径与 DTO 上。
 */
import {
  OnethingSchedulerRunHistory,
  getSchedulerRunHistoryPath,
  safeSchedulerRunTaskFileName,
} from './run-history.js'
import {
  getOnethingSchedulerRunsDir,
} from '../storage/index.js'
import type { SchedulerRunDetailDTO } from '@shared/ipc.js'
import { consolePort, getLogger } from '../logging/index.js'

const log = getLogger('scheduler')
/** 注入式鸭子 logger 端口的过渡替身(logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


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
