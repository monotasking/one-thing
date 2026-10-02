/**
 * 测试用:把自定义服务商登记进 manifest 注册表(批 M)。
 *
 * 生产里这件事由装配层按设置做(`wiring/providers/custom-manifests.ts`);单测不装配,
 * 所以直接按 id 登记。只给 id = `apiType` 缺席 = OpenAI 兼容(与设置里旧数据的缺省同读法)。
 * 已登记的 id 跳过。返回的函数把本次登记的卸掉。
 */
import {
  getProviderManifestRegistry,
  manifestOfCustomProvider,
  type CustomProviderManifestSource,
} from '../manifest.js'

export function registerCustomProvidersForTest(
  sources: ReadonlyArray<string | CustomProviderManifestSource>,
): () => void {
  const registry = getProviderManifestRegistry()
  const undo: Array<() => void> = []
  for (const source of sources) {
    const custom = typeof source === 'string' ? { id: source } : source
    if (registry.has(custom.id)) continue
    undo.push(registry.register(manifestOfCustomProvider(custom)))
  }
  return () => {
    for (const fn of undo.reverse()) fn()
  }
}
