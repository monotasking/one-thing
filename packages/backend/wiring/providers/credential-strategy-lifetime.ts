import { AdmissionGate, QuiescibleScopes } from '@onething/core/lifecycle'
import { getUsageLedger } from '../usage/index.js'
import { getCurrentBackendInstance } from '../../current.js'

/** Backend admission owns every strategy scope, including timed-out selects. */
export class CredentialStrategyService {
  /* 「闸 + 一群档」那一段与插件模型调用逐字相同,收进了 core(工单 5 §1)。 */
  private readonly scopes = new QuiescibleScopes<CredentialStrategyScope>()

  createScope(): CredentialStrategyScope {
    if (this.scopes.closed) throw new Error('Credential strategies are shutting down')
    const scope = new CredentialStrategyScope(() => this.scopes.release(scope))
    return this.scopes.add(scope)
  }

  quiesce(): void { this.scopes.quiesce() }

  drain(): Promise<void> { return this.scopes.drain() }
}

/** One PluginState owns registrations, raw work and a captured usage reader. */
export class CredentialStrategyScope {
  /* 同一段「闸 + 取消源 + 在途集」,住在 core(工单 5 §1)。 */
  private readonly gate = new AdmissionGate(() => new Error('Credential strategy is closed'))
  private readonly unregister = new Set<() => void>()
  private ledger?: ReturnType<typeof getUsageLedger>

  constructor(private readonly release: () => void = () => {}) {}
  get closed(): boolean { return this.gate.closed }
  /** 组合信号的调用方读它(`credential-strategy.ts` 的 `AbortSignal.any`)。 */
  get signal(): AbortSignal { return this.gate.signal }

  captureLedger(): ReturnType<typeof getUsageLedger> {
    this.gate.assertAccepting()
    return this.ledger ??= getUsageLedger()
  }

  own(unregister: () => void): void {
    if (this.gate.closed) { unregister(); return }
    this.unregister.add(unregister)
  }

  run<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.gate.closed) return Promise.reject(new Error('Credential strategy is closed'))
    return this.gate.track(Promise.resolve().then(() => {
      this.gate.signal.throwIfAborted()
      return work()
    }))
  }

  quiesce(): void {
    if (this.gate.closed) return
    this.gate.quiesce(new Error('Credential strategy is closed'))
    for (const unregister of this.unregister) unregister()
    this.unregister.clear()
  }

  async drain(): Promise<void> {
    await this.gate.drain()
    if (this.gate.closed) this.release()
  }
}

export function captureCredentialStrategyScope(): CredentialStrategyScope {
  return getCurrentBackendInstance()?.credentialStrategies.createScope() ?? new CredentialStrategyScope()
}
