import { asToolResultRef, type PageResultReference } from '../../data/page-results'
import type { ProjectedToolCall } from '../model/segments'

/**
 * 工具结局的**诚实读法**(presenter 共用)。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────
 * `ProjectedToolCall.result` 在账本上有**三种真形态**,不是一种:
 *
 *  1. 规范形 `{ content: [{type:'text', text}], details }` —— core 的
 *     `toolResultToStructured` 的产物(冷加载 / step 那一路);
 *  2. 引擎写进 `ToolCall.result` 的那份 data,形状是工具自己的
 *     `{ output, metadata, title }`(toolkit 的 `Result` 折出来的那一份);
 *  3. 一个**裸字符串** —— 结局本来就是文本时,`resultData` 那一格不写
 *     (`structuredResultForEvent` 明说「两者是同一个东西,不存两遍」)。
 *
 * presenter 若各自 `call.result.details.lineCount` 地摸,三种形态里只有一种能中,
 * 另外两种静默给出 `undefined`,屏幕上就是「成果词有时有、有时没有」 —— 那正是
 * 最难查的一类 UI bug。所以读法收在这一个文件里,三种形态一次认全。
 *
 * ── 一条纪律:读不到就是读不到 ────────────────────────────────────────
 * 这里所有函数都可能返回 `undefined`,而且**不许编一个默认值**。「取不到就空」是
 * 六轮定稿写死的:成果词是事实的复述,不是填空题。
 */

/**
 * **这一格结果此刻只是一枚引用吗**(工单 5 ②)。
 *
 * 首屏那一页里超过内联预算的结果不带正文,消息上挂的是
 * `{'@toolResult': {toolCallId, slot, bytes, hash, preview}}` —— 它是**这台屏幕
 * 此刻的事实**(有多大、是哪一份、开头长这样、正文还没取),不是一种结果形态。
 *
 * 所以它在这个文件里单占一口,而**不是** `toolOutputText` 的第四种形态:那三种
 * 认的是「结果长什么样」,这一格认的是「结果在不在手上」。混进去的话,
 * `preview` 那 200 字会被 read 的 presenter 当成整份文件画成一段代码块 ——
 * 正是文件头那条「不许编一个默认值」在禁的事。
 */
export function toolResultReference(call: ProjectedToolCall): PageResultReference | undefined {
  return asToolResultRef(call.result)
}

/** 结局里那段给人看的正文(bash 的输出、read 的文件内容)。 */
export function toolOutputText(call: ProjectedToolCall): string | undefined {
  const result = call.result
  if (typeof result === 'string') return result
  if (!isRecord(result)) return undefined

  // 形态 1:规范形的 content 数组(只取文本片,附件片由别的块管)。
  const content = result.content
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === 'text')
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }

  // 形态 2:工具自己那份 `{ output }`。
  if (typeof result.output === 'string') return result.output
  return undefined
}

/**
 * 结局里那份结构化 metadata(read 的 lineCount、bash 的 exitCode 都在这)。
 *
 * 规范形叫 `details`,工具自己那份叫 `metadata` —— 同一样东西两个名字,是
 * `toolResultToStructured` 改的名。两个都认。
 */
export function toolDetails(call: ProjectedToolCall): Record<string, unknown> | undefined {
  const result = call.result
  if (!isRecord(result)) return undefined
  if (isRecord(result.details)) return result.details
  if (isRecord(result.metadata)) return result.metadata
  return undefined
}

/** metadata 里的一个数字格。不是数字(包括数字字符串)就当没有 —— 不做转换。 */
export function detailNumber(call: ProjectedToolCall, key: string): number | undefined {
  const value = toolDetails(call)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** metadata 里的一个字符串格。 */
export function detailString(call: ProjectedToolCall, key: string): string | undefined {
  const value = toolDetails(call)?.[key]
  return typeof value === 'string' && value ? value : undefined
}

/**
 * edit / write 的结构化 diff(`CoreToolCallChangesLike`)。
 *
 * 投影把它放在**调用**自己身上(不在 result 里),因为它有独立的产地
 * (`tool/result.changes` 那一格)。`changes` 在类型上是 `unknown` —— core 故意
 * 不把那个形状暴露给消费者,所以这里当场认一遍字段。
 */
export interface ToolChanges {
  filePath?: string
  additions?: number
  deletions?: number
  diff?: string
}

export function toolChanges(call: ProjectedToolCall): ToolChanges | undefined {
  const changes = call.changes
  if (!isRecord(changes)) return undefined
  return {
    ...(typeof changes.filePath === 'string' ? { filePath: changes.filePath } : {}),
    ...(typeof changes.additions === 'number' ? { additions: changes.additions } : {}),
    ...(typeof changes.deletions === 'number' ? { deletions: changes.deletions } : {}),
    ...(typeof changes.diff === 'string' ? { diff: changes.diff } : {}),
  }
}

/** 参数里的一格字符串。工具的参数名由**工具**说了算,所以取哪个键是 presenter 的事。 */
export function argString(call: ProjectedToolCall, ...keys: string[]): string | undefined {
  const args = call.arguments as Record<string, unknown> | undefined
  if (!args) return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

/** 路径的最后一段。分隔符两种都认(账本里 Windows 路径是真会出现的)。 */
export function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || path
}

/** 扩展名 → 代码块的语言。认不出就 `null`(素文本,不是猜一个)。 */
export function langFromPath(path: string | undefined): string | null {
  if (!path) return null
  const match = /\.([a-z0-9]+)$/i.exec(basename(path))
  if (!match) return null
  return EXTENSION_LANG[match[1].toLowerCase()] ?? null
}

/**
 * 扩展名表。**列成明表而不是「拿扩展名当语言」**:`.ts` 的语言是 `typescript`,
 * `.mjs` 的是 `javascript` —— 直接把扩展名当语言的话,高亮器一半查不到,
 * 而且失败得很安静(素文本,没人发现)。
 */
const EXTENSION_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  vue: 'vue',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
