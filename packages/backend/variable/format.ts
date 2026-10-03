import * as os from 'node:os'
import type { ContextVariable } from './types.js'

export interface FormatOptions {
  collapseHome?: boolean
  maxValueLength?: number
  /** Reference clock for staleness marking (tests). Defaults to Date.now(). */
  now?: number
}

const DEFAULT_OPTIONS = {
  collapseHome: true,
  maxValueLength: 512,
} as const

type RenderOptions = { collapseHome: boolean; maxValueLength: number; now: number }

/**
 * state 变量老到这个岁数就带一句常量提醒。它每回合都在模型眼前,一个很久没动过
 * 的值未必还成立,标出来是为了让模型别把它当既成事实用——**不是**叫模型去维护
 * 这块板(板上的值归系统与用户,模型不替他们代管)。标记文本里**不放实时年龄**:
 * 跨过阈值时字节只变一次(一次 `<context-update>` 重发),而不是每天变一次。
 */
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
const STALE_MARKER = 'unchanged for 14+ days — may be out of date'

function collapse(value: string, home: string): string {
  if (!home || !value.startsWith(home)) return value
  return '~' + value.slice(home.length)
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/**
 * One XML element per variable:
 *   <var name="deploy" type="number" scope="agent" desc="…">1.5</var>
 * Attributes are structured metadata for the model — type/scope/desc omitted
 * when they carry no information (string type, session scope, no
 * description), so simple variables stay one short line.
 *
 * **条数与总长都不设闸**(§R.5):这是一块状态板,不是数据仓库,要一直知道就
 * 得全给 —— 一个可被截断的状态层等于给"agent 看不见自己在飞的卡"那个事故留了
 * 后门。单值仍然截断(首行 + 512 字符),那是防单个变量炸场,与预算是两回事。
 */
function renderLines(variables: ContextVariable[], opts: RenderOptions): string {
  const home = opts.collapseHome ? os.homedir() : ''
  const lines: string[] = []

  /**
   * ⚠️ 按 `name` 字典序,**绝不能**按 updatedAt。
   *
   * `<context-update>` 的去重判定是逐字相等:顺序随每次写抖动,等于每回合都
   * 重新注入一整块。同一组变量必须永远渲染成同样的字节。
   */
  const ordered = [...variables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const v of ordered) {
    // `workdir` used to be skipped here because the prompt builder had a
    // dedicated `# Work Directory` section. That section is gone
    // (prompt-channels 2026-08-18): the board is the single place the working
    // directory (and its extra roots, which are part of the value) is stated.
    if (!v.value) continue

    const firstLine = v.value.split('\n')[0]
    const restLines = v.value.split('\n').length - 1
    const displayValue = restLines > 0
      ? `${firstLine} (+${restLines} more line${restLines === 1 ? '' : 's'})`
      : firstLine

    const collapsed = home ? collapse(displayValue, home) : displayValue
    const trimmed = truncate(collapsed, opts.maxValueLength)

    // `state` 显式标出来,不靠"有没有值"让模型自己推(用户反馈):
    //  - 隐式编码要模型走一条推理链(自闭合 → 非 state → 值存在但没给);
    //  - 而且自闭合的 `<var name="x"/>` 本来就有歧义 —— "值没显示" 和 "值是空的"
    //    今天长得一模一样;
    //  - 顺带:模型写变量时要填 `state`,看得见既有的标法就学得会该怎么填。
    // 成本是每条 ~14 字符,而且全在尾部块里,不碰缓存前缀。
    const attrs = [`name="${escapeAttr(v.name)}"`, 'state="true"']
    if (v.type && v.type !== 'string') attrs.push(`type="${v.type}"`)
    if (v.scope && v.scope !== 'session') attrs.push(`scope="${v.scope}"`)
    if (v.description) attrs.push(`desc="${escapeAttr(v.description)}"`)
    if (v.updatedAt !== undefined && opts.now - v.updatedAt > STALE_AFTER_MS) {
      attrs.push(`stale="${STALE_MARKER}"`)
    }

    lines.push(`<var ${attrs.join(' ')}>${escapeText(trimmed)}</var>`)
  }

  return lines.join('\n')
}

/**
 * 名录行:`<var name="deploy_target" scope="agent" desc="…"/>` —— **有名有介绍,
 * 没有值**(agent-self-state-variables.md §R.4 修订)。
 *
 * 非 state 变量此前是"一个字节都不渲染",代价是模型**不知道板上还有什么**:
 * 发现一个变量要先花一次 `variable(keys)` 工具调用,而它没有理由知道该去调。
 * 自闭合的一行把这件事变成常识 —— 名字和介绍足够它判断"这个我现在需不需要",
 * 需要时再 `get` 把值取回来。值不进,所以一屋子大变量也撑不爆上下文。
 *
 * `state="false"` 显式写出来:光靠自闭合,"值没显示"和"值是空的"长得一模一样。
 */
function renderCatalogLines(variables: ContextVariable[]): string {
  const ordered = [...variables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const lines: string[] = []
  for (const v of ordered) {
    const attrs = [`name="${escapeAttr(v.name)}"`, 'state="false"']
    if (v.type && v.type !== 'string') attrs.push(`type="${v.type}"`)
    if (v.scope && v.scope !== 'session') attrs.push(`scope="${v.scope}"`)
    if (v.description) attrs.push(`desc="${escapeAttr(v.description)}"`)
    lines.push(`<var ${attrs.join(' ')}/>`)
  }
  return lines.join('\n')
}

/**
 * 变量 → `<context-update>` 尾部块的正文(agent-self-state-variables.md §R.4)。
 *
 * 两种形状,一块里:
 *  - **state**:`<var name desc>值</var>` —— 一直要知道的当前状况,全量给,不设闸;
 *  - **非 state**:`<var name desc/>` —— 只报名字与介绍,值要自己 `get`。
 *
 * 两者都走尾部而不是 system prompt:尾部块永不进缓存前缀,所以变量的任何写入
 * (包括新建/删除一个变量)都不会打穿 `system + tools` 那一段。前缀里只剩一句
 * 常量指路,这是 §R 最大的一笔收益,名录进来也不能把它赔掉。
 *
 * 全空时返回空串,调用方据此整块不发。
 */
export function formatStateVariablesForPrompt(
  variables: ContextVariable[],
  options: FormatOptions = {},
): string {
  const opts: RenderOptions = {
    collapseHome: options.collapseHome ?? DEFAULT_OPTIONS.collapseHome,
    maxValueLength: options.maxValueLength ?? DEFAULT_OPTIONS.maxValueLength,
    now: options.now ?? Date.now(),
  }
  // state 在前、名录在后:一屏之内先看见"现在怎么样",再看见"还有什么可查"。
  return [
    renderLines(variables.filter(v => v.state === true), opts),
    renderCatalogLines(variables.filter(v => v.state !== true)),
  ]
    .filter(part => part.length > 0)
    .join('\n')
}
