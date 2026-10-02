/**
 * 深冻结 —— 快照语义的执行面(通用版)。
 *
 * `Object.freeze` 只冻顶层:一份 `{ tags: ['a'] }` 冻完之后 `snapshot.tags.push('x')`
 * 照样成功,而那个数组很可能是本体 —— 一次 push 就污染了此后所有读取方,直到重启。
 *
 * 住在 core 根上是因为三边都要用:
 *   - 插件 api-builder 交出 `api.settings.get()` 的快照;
 *   - app 层的插件配置存储交出有效值快照;
 *   - 会话命令面(`session/commands.ts` + `app/session/reads.ts`)在开发/测试期
 *     把交出去的 `ChatMessage` 冻住,让"就地改消息"当场炸出来而不是静默生效。
 *
 * 原来它叫 `deepFreezeCorePluginValue` 住在 `plugins/freeze.ts`;那个名字仍然从
 * 原位置导出(零改调用点),但实现只有这一份。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    value.forEach(item => deepFreeze(item, seen))
    return Object.freeze(value)
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    Object.values(value).forEach(item => deepFreeze(item, seen))
    return Object.freeze(value) as T
  }
  return value
}
