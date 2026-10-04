import {
  dumpOnethingProviderRequest,
  type OnethingProviderRequestDumpLogger,
  type OnethingProviderRequestDumpPayload,
} from '@onething/backend/logging'
import type { OnethingProviderRequestDumpMode } from './provider-agent-turn.js'
import {
  getOnethingLogDir,
} from '@onething/backend/storage'
import { consolePort, getLogger } from '@onething/backend/logging/logging-configure'
import type { ConsoleLikePort } from '@onething/backend/logging'

const log = getLogger('providers.dump')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingProviderRequestDumpLogger = consolePort(log)


export type ProviderRequestDumpMode = OnethingProviderRequestDumpMode
export type ProviderRequestDumpPayload = OnethingProviderRequestDumpPayload

export async function dumpProviderRequest(payload: ProviderRequestDumpPayload): Promise<string | undefined> {
  // Under vitest getOnethingLogDir() resolves to the developer's real ~/.onething, and
  // every provider now dumps — a suite run would otherwise spray full prompt
  // bodies into their live log directory.
  if (process.env.VITEST) return undefined

  return dumpOnethingProviderRequest(payload, {
    getLogDir: getOnethingLogDir,
    env: process.env,
    logger: consoleLog,
  })
}
