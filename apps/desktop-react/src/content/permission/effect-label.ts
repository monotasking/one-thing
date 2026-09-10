import type { MessageKey, TFn } from '../../i18n'

/**
 * 效果类:**后端枚举 → 字典键**的一张明表。
 *
 * 与 `content/tools/status.ts` 的 `TOOL_STATUS_KEYS` 逐字同判例:不用
 * `` `permission.effect.${type}` as MessageKey `` 拼键 —— 那个断言会骗过类型检查,
 * 后端哪天加一档新效果类就在运行时炸(`format` 拿到 undefined)。列成表之后,
 * 认不出来的类**原样显示那个英文枚举**:那是事实,而编一句中文是猜。
 *
 * 表里这 17 行与 `packages/core/toolkit/effects.ts` 的 `EffectClass` 今天一一对应。
 * 它不是那张表的第二个产地 —— 它是那张表的**读法**:核回答「有哪些类、各自怎么
 * 处理」,这里只回答「这一类在屏幕上念作什么」。加一类效果 = 核加一行 + 这里加一行,
 * 忘了加这里的后果是屏幕上出现那个英文枚举,不是屏幕出错。
 */
const EFFECT_KEYS: Record<string, MessageKey> = {
  read: 'permission.effect.read',
  file_edit: 'permission.effect.file_edit',
  file_write: 'permission.effect.file_write',
  file_destructive_edit: 'permission.effect.file_destructive_edit',
  bash: 'permission.effect.bash',
  mcp: 'permission.effect.mcp',
  external_directory: 'permission.effect.external_directory',
  sensitive_file_read: 'permission.effect.sensitive_file_read',
  capability_change: 'permission.effect.capability_change',
  net_fetch: 'permission.effect.net_fetch',
  user_ask: 'permission.effect.user_ask',
  session_message: 'permission.effect.session_message',
  session_spawn: 'permission.effect.session_spawn',
  session_destructive: 'permission.effect.session_destructive',
  plugin_exec: 'permission.effect.plugin_exec',
  'external-agent': 'permission.effect.external-agent',
  ui_change: 'permission.effect.ui_change',
}

export function effectLabel(t: TFn, type: string): string {
  const key = EFFECT_KEYS[type]
  return key ? t(key) : type
}

/**
 * 这次要动的**东西**,一行人话。
 *
 * `pattern` 后端给的是一条或几条;几条时用 `·` 连起来 —— 不做「前 2 条 + 还有 N 条」
 * 的省略:省略要一个「几条算多」的阈值,而卡上这一行本来就单行截断
 * (`PermissionCard.module.css` 的几何锁),截断由 CSS 说,不由这里编。
 * 缺席就是**没有**:交空串,画的那一层整格不画,而不是编一句「未知资源」。
 */
export function resourceLine(pattern: string | string[] | undefined): string {
  if (pattern === undefined) return ''
  return Array.isArray(pattern) ? pattern.join(' · ') : pattern
}
