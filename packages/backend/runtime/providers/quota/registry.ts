/**
 * 配额源注册表(§8.2)—— **能力自述,别人读表**。
 *
 * 每个源一个文件,自带 id;manifest 的 `quotaSource` 指向它。搬回家的服务商的源住在
 * `vendors/<id>/quota.ts`,经 `VendorRuntime.quotaSources` 登记(惰性读,见下)。`fetchProviderQuota`、装配层的
 * `QuotaService`、RPC 都只读这张表:加一家(「SiliconFlow `/v1/user/info`」)=
 * `vendors/<家>/quota.ts` 一个文件 + 这家 `VendorRuntime.quotaSources` 一格 + manifest 一格,别处零改。
 *
 * 进程级 const Map,`register` 返回卸载函数(带身份守卫:同 id 后来又登记了别的,旧的卸载函数
 * 不会把新的抹掉)。同 id 重复登记是明确错误,与 `ProviderManifestRegistry` 同一口径。
 */
import type { QuotaSource } from './source.js'
import { VENDOR_RUNTIMES } from '../vendors/runtimes.js'

/**
 * 内置源全表 = 名册里各家自带的(服务商自述试点 P2 第 4 批起过渡期的旧名单清空、删除)。
 * **是函数不是常量**:读名册必须惰性 ——
 * `vendors/runtimes.ts` 会拉起整个 agent-loop,而 agent-loop 经 manifest 注册表又会走回
 * 这里;模块加载时就读,会在那条环上读到还没初始化完的名册。
 */
export function builtinQuotaSources(): readonly QuotaSource[] {
  return VENDOR_RUNTIMES.flatMap((vendor) => vendor.quotaSources ?? [])
}

const sources = new Map<string, QuotaSource>()
let seeded = false

function seedBuiltins(): void {
  sources.clear()
  for (const source of builtinQuotaSources()) sources.set(source.id, source)
  seeded = true
}

/** 第一次被问到时才播种(见 `builtinQuotaSources` 的说明)。 */
function ensureSeeded(): void {
  if (!seeded) seedBuiltins()
}

export function registerQuotaSource(id: string, source: QuotaSource): () => void {
  ensureSeeded()
  if (sources.has(id)) throw new Error(`Quota source already registered: ${id}`)
  sources.set(id, source)
  return () => {
    if (sources.get(id) === source) sources.delete(id)
  }
}

export function getQuotaSource(id: string | undefined | null): QuotaSource | undefined {
  ensureSeeded()
  return id ? sources.get(id) : undefined
}

export function listQuotaSourceIds(): string[] {
  ensureSeeded()
  return [...sources.keys()]
}

/** 测试用:清掉一切,重登全部内置源。 */
export function resetQuotaSourcesForTests(): void {
  seedBuiltins()
}
