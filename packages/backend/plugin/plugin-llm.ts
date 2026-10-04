/**
 * N7-b —— 受管 LLM 调用口的**协议层**(docs/design/pi-benchmark-adoption-2026-08.md)。
 *
 * pi 把整个 `ctx.modelRegistry` 递给插件,让它自己 `.complete()` —— 那等于把
 * apiKey、路由、计费全交出去。我们只给一个**受管**口:`api.llm.complete()`。
 * 与裸 registry 的三个关键差异(受管三要素)都不在这一层,而在装配层的宿主实现:
 *
 *   1. **计费**:每次调用记进 usage 账本,`source = plugin:<id>`,用户在用量页看得见
 *      "哪个插件烧了多少 token";
 *   2. **超时**:硬超时(LLM 调用比 lifecycle 钩子长);
 *   3. **配额**:每插件的调用频率闸,防插件在 compact 钩子里无限调 LLM。
 *
 * 本文件是一个**零依赖叶子**:权限枚举、披露文案、受管常量、请求/结果形状、
 * 结构化错误。插件永远拿不到 apiKey / registry —— 它只交出 messages,拿回 text。
 */

/* ── 声明门(manifest contributes.permissions)───────────────────────────── */

/**
 * 受管 LLM 调用。第一个"插件可自发、直接耗 token"的口(sendMessage 的起轮是
 * 间接的、经由一轮真对话;这一条是插件自己就地发一次模型请求)。
 */
export const PLUGIN_PERMISSION_LLM_COMPLETE = 'llm:complete'

/**
 * 披露文案。**耗钱要显眼**:装前确认页把它念成人话,与 sessions:trigger 同级
 * (那一条也是"spends tokens")。
 */
export const PLUGIN_LLM_COMPLETE_PERMISSION_NOTE =
  'can make AI model calls on your behalf (uses tokens)'

/* ── 受管三要素的常量(装配层消费;放这里是让它们与协议同源、可被测试引用)── */

/**
 * 硬超时。LLM 调用比 lifecycle 钩子(5s)长得多 —— 一次结构化摘要可能要十几秒。
 * 30s 之后一律放弃并抛 `timeout`,插件的调用不会永久挂住压缩路径。
 */
export const PLUGIN_LLM_COMPLETE_TIMEOUT_MS = 30_000

/**
 * 配额闸:每个插件、每个滚动窗口最多这么多次 `llm.complete`。
 *
 * 口径按**插件**(不按会话)—— `api.llm.complete` 不携带会话(它可以从事件
 * handler / 定时任务 / compact 钩子里任何地方调),和 sendMessage 的循环闸同一
 * 条道理:让插件自己传 sessionId 会让闸可被规避。防的是"compact 钩子里 while(true)
 * 调 LLM"那条不收敛的账,按插件计频足以兜住它。超限抛 `quota`。
 */
export const PLUGIN_LLM_RATE_LIMIT = 30
export const PLUGIN_LLM_RATE_WINDOW_MS = 60_000

/** 单次调用的输出上限缺省 + 硬顶。插件给的 maxTokens 会被钳进 (0, 硬顶]。 */
export const PLUGIN_LLM_DEFAULT_MAX_OUTPUT_TOKENS = 2048
export const PLUGIN_LLM_MAX_OUTPUT_TOKENS_CEILING = 8192

/* ── 请求 / 结果形状(全部 JSON-可序列化,过的是将来会变 RPC 的边界)──────── */

export type PluginLlmRole = 'system' | 'user' | 'assistant'

export interface PluginLlmMessage {
  role: PluginLlmRole
  content: string
}

export interface PluginLlmCompleteOptions {
  messages: PluginLlmMessage[]
  /** 钳进 (0, PLUGIN_LLM_MAX_OUTPUT_TOKENS_CEILING];缺省 PLUGIN_LLM_DEFAULT_MAX_OUTPUT_TOKENS。 */
  maxTokens?: number
  temperature?: number
  /** 插件自己的取消信号 —— 与宿主的硬超时**取较早的那个**。 */
  signal?: AbortSignal
}

export interface PluginLlmCompleteResult {
  text: string
}

/* ── 结构化错误(抛给插件;插件自己 catch)──────────────────────────────── */

export type PluginLlmErrorCode =
  /** manifest 没声明 `llm:complete`。 */
  | 'not-declared'
  /** 这个宿主没有受管 LLM 面(headless / server / 测试替身),或没有配好的 provider。 */
  | 'unsupported'
  /** messages 为空 / 形状非法。 */
  | 'invalid-input'
  /** 配额闸(PLUGIN_LLM_RATE_LIMIT / 窗口)。 */
  | 'quota'
  /** 硬超时(PLUGIN_LLM_COMPLETE_TIMEOUT_MS)或被插件自己的 signal 取消。 */
  | 'timeout'
  /** provider 侧错误(鉴权 / 网络 / 模型)。 */
  | 'provider-error'

export class PluginLlmError extends Error {
  readonly code: PluginLlmErrorCode
  constructor(code: PluginLlmErrorCode, message: string) {
    super(message)
    this.name = 'PluginLlmError'
    this.code = code
  }
}

/* ── 纯校验(两侧共用)──────────────────────────────────────────────────── */

const VALID_ROLES: ReadonlySet<string> = new Set<PluginLlmRole>(['system', 'user', 'assistant'])

/**
 * messages 归一 + 校验。非数组 / 空 / 任一条 role 非法或 content 非字符串 = 抛
 * `invalid-input`。抽成纯函数,两侧不各写一遍,测试也能直接打它。
 */
export function normalizePluginLlmMessages(input: unknown): PluginLlmMessage[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new PluginLlmError('invalid-input', 'messages must be a non-empty array')
  }
  return input.map((raw, index) => {
    const role = (raw as { role?: unknown })?.role
    const content = (raw as { content?: unknown })?.content
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      throw new PluginLlmError(
        'invalid-input',
        `messages[${index}].role must be one of system|user|assistant`,
      )
    }
    if (typeof content !== 'string') {
      throw new PluginLlmError('invalid-input', `messages[${index}].content must be a string`)
    }
    return { role: role as PluginLlmRole, content }
  })
}

/** maxTokens 钳制:未给用缺省;越界钳进 (0, 硬顶]。 */
export function clampPluginLlmMaxTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return PLUGIN_LLM_DEFAULT_MAX_OUTPUT_TOKENS
  }
  return Math.min(Math.floor(value), PLUGIN_LLM_MAX_OUTPUT_TOKENS_CEILING)
}
