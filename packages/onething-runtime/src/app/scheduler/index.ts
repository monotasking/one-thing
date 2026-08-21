import path from 'node:path'
import type { Scheduler } from '@onething/runtime/scheduler'
import {
  configureOnethingScheduler,
  getOnethingScheduler,
} from '@onething/runtime/scheduler'
import {
  getOnethingStorePath,
} from '@onething/runtime/storage'
import { consolePort, getLogger } from '../logging/index.js'

const log = getLogger('scheduler')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


let schedulerConfigured = false

/** Explicit assembly step. Guarded: reconfiguring disposes a live scheduler. */
export function configureAppScheduler(): void {
  if (schedulerConfigured) return
  schedulerConfigured = true
  configureOnethingScheduler({
    stateFilePath: () => path.join(getOnethingStorePath(), 'scheduler', 'state.json'),
    logger: consoleLog,
  })
}

/** Self-ensuring: a pre-assembly caller must never build a default-path scheduler. */
export function getAppScheduler(): Scheduler {
  configureAppScheduler()
  return getOnethingScheduler()
}

export {
  configureOnethingScheduler,
  getOnethingScheduler,
  Scheduler,
} from '@onething/runtime/scheduler'
export type {
  SchedulerOptions,
  SchedulerRunOptions,
  SchedulerRunReason,
  SchedulerRunRecord,
  SchedulerSchedule,
  SchedulerTaskContext,
  SchedulerTaskHandle,
  SchedulerTaskRegistration,
  SchedulerTaskSnapshot,
} from '@onething/runtime/scheduler'
export {
  cronRunKey,
  currentCronRunAt,
  isValidTimezone,
  nextCronRunAt,
  parseCronExpression,
} from '@onething/runtime/scheduler'

export function getScheduler(): Scheduler {
  return getOnethingScheduler()
}
