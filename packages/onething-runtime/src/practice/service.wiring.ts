/**
 * 练习域的接线:单槽绑定 + 宿主口(工单 5 §5)。
 *
 * `PracticeService` 本体已归位到 `./service.ts`(纯产品层);这里原样再导出它,
 * 于是既有 import 一个字不用改,而产品层的新调用方可以直接吃 `./service.js`。
 */
import type {
  OnethingPracticeConfig, OnethingPracticeEngineSnapshot,
  OnethingPracticeLedgerRecord, OnethingPracticeSummaryResult,
  OnethingPracticeLedger,
} from './index.js'
import { PracticeService, PracticeServiceClosedError, type PracticeEventBroadcaster } from './service.js'
import type {
  PracticeLogRequest, PracticeSetConfigRequest,
  PracticeStartRequest, PracticeSummaryRequest,
} from '@shared/ipc.js'

export { PracticeService, PracticeServiceClosedError }
export type { PracticeEventBroadcaster }

let currentService: PracticeService | null = null
let pendingBroadcaster: PracticeEventBroadcaster | null = null

/** Host injection remains compatible; each engine captures its own broadcaster. */
export function configurePracticeEventBroadcaster(broadcaster: PracticeEventBroadcaster | null): void {
  if (currentService) currentService.setBroadcaster(broadcaster)
  else pendingBroadcaster = broadcaster
}

export function configurePracticeService(service: PracticeService): () => void {
  if (currentService) throw new Error('Practice service has already been assembled')
  service.setBroadcaster(pendingBroadcaster)
  pendingBroadcaster = null
  currentService = service
  return () => { if (currentService === service) currentService = null }
}

export function getPracticeServiceSafe(): PracticeService | null { return currentService }
export function getPracticeService(): PracticeService {
  if (!currentService) throw new PracticeServiceClosedError()
  return currentService
}

export function getPracticeLedger(): OnethingPracticeLedger { return getPracticeService().getPracticeLedger() }
export async function readPracticeConfig(): Promise<OnethingPracticeConfig> { return getPracticeService().readPracticeConfig() }
export async function writePracticeConfig(request: PracticeSetConfigRequest): Promise<OnethingPracticeConfig> { return getPracticeService().writePracticeConfig(request) }
export async function startPractice(request: PracticeStartRequest): Promise<OnethingPracticeEngineSnapshot> { return getPracticeService().startPractice(request) }
export function pausePractice(): OnethingPracticeEngineSnapshot { return getPracticeService().pausePractice() }
export function resumePractice(): OnethingPracticeEngineSnapshot { return getPracticeService().resumePractice() }
export function stopPractice(discard = false): OnethingPracticeEngineSnapshot { return getPracticeService().stopPractice(discard) }
export function getPracticeState(): OnethingPracticeEngineSnapshot { return getPracticeService().getPracticeState() }
export function logPractice(request: PracticeLogRequest): OnethingPracticeLedgerRecord { return getPracticeService().logPractice(request) }
export async function getPracticeSummary(request: PracticeSummaryRequest): Promise<OnethingPracticeSummaryResult> { return getPracticeService().getPracticeSummary(request) }
export async function getRecentPracticeRecords(days = 7, limit = 50): Promise<OnethingPracticeLedgerRecord[]> { return getPracticeService().getRecentPracticeRecords(days, limit) }

/** Test compatibility; callers must await real cleanup before removing their store. */
export async function __resetPracticeServiceForTests(): Promise<void> {
  const service = currentService
  currentService = null
  pendingBroadcaster = null
  await service?.drain()
}
