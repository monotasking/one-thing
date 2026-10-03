import { AdmissionGate, QuiescibleScopes } from '@onething/backend/runtime/lifecycle'
import type { OnethingUsageLedger } from '@onething/backend/runtime/usage'
import { getCurrentBackendInstance } from '@onething/backend/current.js'

/**
 * 「取用量账本」的那个函数。插件凭证策略要按「每把钥匙最近用了多少」挑钥匙,账本住在 usage 里;
 * 从前这里直接 import usage 的记账模块,于是凭证与用量两个功能互相引用成环(D24 断边 ①,2026-10-04)。
 * 现在由装配(`backend.ts`)在构造 `CredentialStrategyService` 时把这个函数递进来,凭证这一侧对 usage 只剩类型引用。
 */
export type CredentialUsageLedgerReader = () => OnethingUsageLedger

/** Backend admission owns every strategy scope, including timed-out selects. */
export class CredentialStrategyService {
  /* 「闸 + 一群档」那一段与插件模型调用逐字相同,收进了 core(工单 5 §1)。 */
  private readonly scopes = new QuiescibleScopes<CredentialStrategyScope>()

  constructor(private readonly readLedger: CredentialUsageLedgerReader) {}

  createScope(): CredentialStrategyScope {
    if (this.scopes.closed) throw new Error('Credential strategies are shutting down')
    const scope = new CredentialStrategyScope(() => this.scopes.release(scope), this.readLedger)
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
  private ledger?: OnethingUsageLedger

  /**
   * `readLedger` 缺席 = 这一档不是装配出来的那台服务建的(进程里还没有 backend 时的兜底档)。
   * 那时账本本来也没绑上(从前 `getUsageLedger()` 在这种时候抛「没绑到 backend」),所以照样抛,
   * 由调用方(`credentials-strategy.ts` 的 `loadUsage`)当成「没有用量数据」处理。
   */
  constructor(
    private readonly release: () => void = () => {},
    private readonly readLedger?: CredentialUsageLedgerReader,
  ) {}
  get closed(): boolean { return this.gate.closed }
  /** 组合信号的调用方读它(`credential-strategy.ts` 的 `AbortSignal.any`)。 */
  get signal(): AbortSignal { return this.gate.signal }

  captureLedger(): OnethingUsageLedger {
    this.gate.assertAccepting()
    if (!this.readLedger) throw new Error('Usage ledger is not bound to a backend')
    return this.ledger ??= this.readLedger()
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
