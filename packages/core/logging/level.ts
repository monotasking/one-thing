import { isLogLevel, LOG_LEVEL_VALUE, type LogLevel } from './types.js'

/**
 * `ONETHING_LOG='<default>[,<ns-glob>=<level>]*'` 的解析与匹配(§2.3)。
 *
 * 例:`ONETHING_LOG=info,engine.*=debug,providers.deepseek=trace`。
 * 匹配规则:**最长(最具体)的 glob 赢**;都不匹配则用默认级。
 */

export interface LevelRule {
  /** 原样的 glob,`engine.*` / `server.http` / `*`。 */
  pattern: string
  level: LogLevel
  /** 用于"谁更具体"的比较:去掉通配符后的字面量长度。 */
  specificity: number
  test(ns: string): boolean
}

const DEFAULT_LEVEL: LogLevel = 'info'

function globToTester(pattern: string): (ns: string) => boolean {
  if (pattern === '*' || pattern === '') return () => true
  // `engine.*` 既要匹配 `engine.stream`,也要匹配 `engine` 本身 —— 命名空间是
  // 前缀树,一个前缀开了 debug 意味着"这棵子树"都开,包含树根那一层。
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return ns => ns === prefix || ns.startsWith(`${prefix}.`)
  }
  if (pattern.includes('*')) {
    const source = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`
    const re = new RegExp(source)
    return ns => re.test(ns)
  }
  return ns => ns === pattern || ns.startsWith(`${pattern}.`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function specificityOf(pattern: string): number {
  if (pattern === '*' || pattern === '') return 0
  return pattern.replace(/\*/g, '').length
}

export interface ParsedLevelSpec {
  spec: string
  defaultLevel: LogLevel
  rules: LevelRule[]
  /** 无法识别的片段,原样留着让宿主可以报一句(不抛错:日志开关不该拦启动)。 */
  invalid: string[]
}

export function parseLogLevelSpec(spec: string | undefined | null, fallback: LogLevel = DEFAULT_LEVEL): ParsedLevelSpec {
  const text = (spec ?? '').trim()
  const rules: LevelRule[] = []
  const invalid: string[] = []
  let defaultLevel = fallback

  for (const rawEntry of text.split(/[,\s]+/)) {
    const entry = rawEntry.trim()
    if (!entry) continue
    const eq = entry.lastIndexOf('=')
    if (eq === -1) {
      if (isLogLevel(entry)) {
        defaultLevel = entry
      } else if (entry === 'off' || entry === 'silent') {
        defaultLevel = 'fatal'
      } else {
        invalid.push(entry)
      }
      continue
    }
    const pattern = entry.slice(0, eq).trim()
    const level = entry.slice(eq + 1).trim()
    if (!pattern || !isLogLevel(level)) {
      invalid.push(entry)
      continue
    }
    rules.push({
      pattern,
      level,
      specificity: specificityOf(pattern),
      test: globToTester(pattern),
    })
  }

  // 更具体的排前面,匹配时第一条命中即结果。
  rules.sort((left, right) => right.specificity - left.specificity)
  return { spec: text, defaultLevel, rules, invalid }
}

/** 一个 spec 的可查询形式,带命名空间→级别的记忆化。 */
export class LevelFilter {
  private parsed: ParsedLevelSpec
  private cache = new Map<string, LogLevel>()

  constructor(spec?: string | null, fallback: LogLevel = DEFAULT_LEVEL) {
    this.parsed = parseLogLevelSpec(spec, fallback)
  }

  get spec(): string {
    return this.parsed.spec
  }

  get defaultLevel(): LogLevel {
    return this.parsed.defaultLevel
  }

  get invalidEntries(): string[] {
    return [...this.parsed.invalid]
  }

  setSpec(spec: string | null | undefined, fallback: LogLevel = DEFAULT_LEVEL): void {
    this.parsed = parseLogLevelSpec(spec, fallback)
    this.cache.clear()
  }

  levelFor(ns: string): LogLevel {
    const cached = this.cache.get(ns)
    if (cached) return cached
    let level = this.parsed.defaultLevel
    for (const rule of this.parsed.rules) {
      if (rule.test(ns)) {
        level = rule.level
        break
      }
    }
    this.cache.set(ns, level)
    return level
  }

  isEnabled(ns: string, level: LogLevel): boolean {
    return LOG_LEVEL_VALUE[level] >= LOG_LEVEL_VALUE[this.levelFor(ns)]
  }
}
