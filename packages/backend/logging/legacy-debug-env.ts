/**
 * 旧 `ONETHING_DEBUG_*` 开关 → `ONETHING_LOG` spec 的**别名层**(§8.1 最后一行)。
 *
 * L4 把所有门控在这些开关后面的输出改成了 `log.trace` / `log.debug`,等级过滤
 * 取代了开关本身。为了不让还在用老开关的人一升级就哑掉,这里把它们翻译成等价的
 * spec 片段,拼进 `ONETHING_LOG` 一起解析。
 *
 * **这些别名已废弃,L5 删除。** 新的写法只有一个:
 * `ONETHING_LOG=info,engine.stream=trace,providers.*=trace`。
 *
 * 强弱关系:显式 `ONETHING_LOG` 永远赢。
 * - 别名给的**默认级**(`DEBUG`)排在 base 前面 —— base 自己的默认级后写后赢;
 * - 别名给的**命名空间规则**排在 base 后面 —— 同特异性时解析器保持插入序,base 先命中。
 */

export interface LegacyDebugAliasSpec {
  /** 裸等级片段(改默认级),排在 base 之前。 */
  defaults: string[]
  /** `ns=level` 片段,排在 base 之后。 */
  rules: string[]
  /** 命中的旧开关名,供一次性弃用提示。 */
  matched: string[]
}

type Env = Record<string, string | undefined>

function isOn(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off'
}

/**
 * 别名表。一行一个旧开关 —— L5 删除时整表一起删。
 *
 * | 旧开关 | 等价 spec |
 * |---|---|
 * | `ONETHING_DEBUG_STREAM=1` | `engine.stream=trace,providers.*=trace,renderer.chat-store=trace,renderer.ipc-hub=trace` |
 * | `ONETHING_DEBUG_CODEX_STREAM=1` | 同上 |
 * | `ONETHING_DEBUG_DEEPSEEK_STREAM=1` | 同上 |
 * | `ONETHING_DEBUG_HISTORY_SHAPE=1` | `engine.history=trace` |
 * | `ONETHING_DEBUG_SKILLS=1` | `skills=debug` |
 * | `DEBUG=<任意非空>` | `debug`(默认级) |
 */
export function resolveLegacyDebugAliases(env: Env = process.env): LegacyDebugAliasSpec {
  const defaults: string[] = []
  const rules: string[] = []
  const matched: string[] = []

  const streamSwitches = ['ONETHING_DEBUG_STREAM', 'ONETHING_DEBUG_CODEX_STREAM', 'ONETHING_DEBUG_DEEPSEEK_STREAM']
  const streamHits = streamSwitches.filter(name => isOn(env[name]))
  if (streamHits.length > 0) {
    matched.push(...streamHits)
    // 渲染侧的两条热路径(区 ③b)也归这把旧开关管:它们的逐 chunk 追踪现在门控在
    // `renderer.chat-store` / `renderer.ipc-hub` 的 trace 上。
    rules.push(
      'engine.stream=trace',
      'providers.*=trace',
      'renderer.chat-store=trace',
      'renderer.ipc-hub=trace',
    )
  }

  if (isOn(env.ONETHING_DEBUG_HISTORY_SHAPE)) {
    matched.push('ONETHING_DEBUG_HISTORY_SHAPE')
    // trace 而不是 debug:摘要在 debug、逐行铺开在 trace(chat-logger.ts),
    // 旧开关开的是"逐行铺开"那一档。
    rules.push('engine.history=trace')
  }

  if (isOn(env.ONETHING_DEBUG_SKILLS)) {
    matched.push('ONETHING_DEBUG_SKILLS')
    rules.push('skills=debug')
  }

  // 通用 `DEBUG`:历史上 skills 读的是 `DEBUG.includes('skills')`,但它同时是全生态
  // 的惯例开关。这里按最宽松的读法翻译成"默认级 debug",显式 `ONETHING_LOG` 的
  // 默认级仍然压过它。
  if (isOn(env.DEBUG)) {
    matched.push('DEBUG')
    defaults.push('debug')
  }

  return { defaults, rules, matched }
}

/**
 * 把 base spec 与别名拼成最终 spec。base 为空时,别名的默认级取代兜底 `info`。
 */
export function composeLevelSpecWithLegacyAliases(
  base: string | undefined,
  fallback: string,
  alias: LegacyDebugAliasSpec,
): string {
  const parts: string[] = []
  if (base && base.trim()) {
    parts.push(...alias.defaults, base.trim())
  } else {
    parts.push(alias.defaults.length > 0 ? alias.defaults.join(',') : fallback)
  }
  parts.push(...alias.rules)
  return parts.filter(Boolean).join(',')
}
