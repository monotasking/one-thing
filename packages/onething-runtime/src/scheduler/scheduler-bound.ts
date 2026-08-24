/**
 * 进程级调度器的绑定接线:把 `Scheduler` 配到 `<store>/scheduler/state.json` 上,
 * 并给出一个自保证的取用口。
 *
 * P3'a-3 从 `src/app/scheduler/index.ts` 归位 —— 它读的是本包的 store 路径、配的是
 * `./scheduler.js`,唯一一条装配层的边是 `consolePort`,而那个已经归位到
 * `../logging/` 了。文件名带 `-bound`:barrel(`./index.js`)只出纯模块,这里出的是
 * **单例**,所以不进 barrel(进了会和 barrel 的 `export *` 撞名)。
 */
import path from 'node:path'
import type { Scheduler } from './scheduler.js'
import {
  configureOnethingScheduler,
  getOnethingScheduler,
} from './scheduler.js'
import {
  getOnethingStorePath,
} from '../storage/index.js'
import { consolePort, getLogger } from '../logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { SchedulerLogger } from '@onething/runtime/scheduler/scheduler'

const log = getLogger('scheduler')
/** 注入式鸭子 logger 端口的过渡替身(logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & SchedulerLogger = consolePort(log)


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
} from './scheduler.js'
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
} from './index.js'
export {
  cronRunKey,
  currentCronRunAt,
  isValidTimezone,
  nextCronRunAt,
  parseCronExpression,
} from './cron.js'

export function getScheduler(): Scheduler {
  return getOnethingScheduler()
}
