/**
 * 配额源注册表(§8.2)—— **能力自述,别人读表**。
 *
 * 每个源一个文件,自带 id;manifest 的 `quotaSource` 指向它。`fetchProviderQuota`、装配层的
 * `QuotaService`、RPC 都只读这张表:加一家(「SiliconFlow `/v1/user/info`」)= `quota/<家>.ts`
 * 一个文件 + 这里一行 + manifest 一格,别处零改。
 *
 * 进程级 const Map,`register` 返回卸载函数(带身份守卫:同 id 后来又登记了别的,旧的卸载函数
 * 不会把新的抹掉)。同 id 重复登记是明确错误,与 `ProviderManifestRegistry` 同一口径。
 */
import type { QuotaSource } from './source.js'
import { codexQuotaSource } from './codex.js'
import { claudeCodeQuotaSource } from './claude-code.js'
import { deepseekQuotaSource } from './deepseek.js'
import { kimiQuotaSource } from './kimi.js'
import { openrouterQuotaSource } from './openrouter.js'

/** 内置五源。**加一家 = 这里一行**。 */
export const BUILTIN_QUOTA_SOURCES: readonly QuotaSource[] = [
  codexQuotaSource,
  claudeCodeQuotaSource,
  deepseekQuotaSource,
  kimiQuotaSource,
  openrouterQuotaSource,
]

const sources = new Map<string, QuotaSource>()

function seedBuiltins(): void {
  sources.clear()
  for (const source of BUILTIN_QUOTA_SOURCES) sources.set(source.id, source)
}
seedBuiltins()

export function registerQuotaSource(id: string, source: QuotaSource): () => void {
  if (sources.has(id)) throw new Error(`Quota source already registered: ${id}`)
  sources.set(id, source)
  return () => {
    if (sources.get(id) === source) sources.delete(id)
  }
}

export function getQuotaSource(id: string | undefined | null): QuotaSource | undefined {
  return id ? sources.get(id) : undefined
}

export function listQuotaSourceIds(): string[] {
  return [...sources.keys()]
}

/** 测试用:清掉一切,重登内置五源。 */
export function resetQuotaSourcesForTests(): void {
  seedBuiltins()
}
