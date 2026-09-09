/**
 * `onething resource` —— 原子的 CLI 出口(K4-b,`docs/design/atom-2026-09.md`
 * §4 那张表的「deeplink / CLI」一行:`onething do music:track/123 play`)。
 *
 * ## 一个子命令,零个 scheme 名
 *
 * 四支(`list` / `describe` / `read` / `do`)对会话、目录、音乐、将来的邮件说的是
 * **同一句话**。接一种资源之后 `onething resource do mail:inbox/1 archive` 当场就
 * 能用,这个文件一个字都不改 —— 那正是 §8 陌生能力演练要的答案。
 *
 * 反面写法是给每种资源开一个子命令(`onething music play` / `onething mail send`),
 * 那就是 `session` / `provider` / `tools` / `collab` 今天的形状:每加一种能力抄一段
 * switch,而漏抄不会有任何东西红。
 *
 * ## 两种输出,一份事实
 *
 * `--json` 打的是**与 RPC 逐字相同**的那份投影(`@shared/ipc/resources.ts` 的
 * `SerializedResourceSpec` / `ResourceReadView` / `ResourceOutcomeView`),因为
 * daemon 那一侧调的就是 `rpc/domains/resources.ts` 导出的同三只 `serialize*`。
 * 缺省是给人看的表 —— 它是同一份投影的**排版**,不是第二份事实:凡是表里印出来
 * 的字,`--json` 里都找得到同一格。
 *
 * ## 人话表的口径(取舍写在这里,免得下一个人重新拍一次)
 *
 * · `list` —— 两列 `scheme` / `title`,与 `session list` / `provider list` 同一只
 *   `printRows`。命名空间少(今天四五个),不分页、不排序:注册表已经按字典序给了。
 * · `describe` —— **按动词分节**(READS / OPS / EVENTS / STATE),不是一张宽表:
 *   四种成员的列根本不一样(读法有 query、做法有 effects 与 home、事件只有 payload),
 *   硬塞进一张表会有一半格子是空的。每节一行一个成员:`名字  标题  (补充)`。
 *   **不打 JSON Schema 正文** —— 一份 schema 是给机器读的,人要的是「有哪些、
 *   带什么闸」;要正文就 `--json`。
 * · `read` —— 值是**任意形状**,所以人话形态就是缩进两格的 JSON。这不是偷懒:
 *   一次读的答案可能是一条元数据、也可能是一页消息,没有一种表能同时排好它们,
 *   而硬编一套「按字段猜列」的排版会在第一个新 scheme 上说谎。
 * · `do` —— 一行结局。`ok` 打管线交给模型的那段文本(与 AI 看到的逐字相同),
 *   其余四支打 `<kind>: <一句话>`。**拒绝与失败要让退出码看得见**:非 `ok` 一律
 *   `process.exitCode = 1`,不然 `onething resource do … && 下一条` 在被拒之后
 *   仍然往下走。
 *
 * ## 输出走 `stdout()`
 *
 * CLAUDE.md 那条:给人 / 管道看的 = `stdout()`,给排障看的 = `getLogger(ns)`。
 * 这只文件一个 `console.*` 都没有。
 */

import type {
  ListResourcesResponse,
  ResourceOutcomeView,
  ResourceReadView,
  SerializedResourceSpec,
} from '@shared/ipc/resources.js'
import { stdout } from './stdout.js'

/** 这个文件用得到的那一格 daemon 客户端。窄到只剩 `request`,好让测试喂替身。 */
export interface ResourceCommandClient {
  request<TData = unknown>(method: never, params?: unknown): Promise<TData>
}

export interface ResourceCommandOptions {
  json?: boolean
  /** `--query '<json>'`(read)/ `--params '<json>'`(do)的原文。 */
  query?: string
  params?: string
  /** `--session <id>`:这次是**替哪条会话**做的(发起坐标,不是操作对象)。 */
  session?: string
}

/**
 * `--query` / `--params` 的原文 → 对象。
 *
 * 三条:空 = `{}`;不是合法 JSON = **抛**(一次打错的引号不该被当成空参数悄悄跑掉,
 * 那正是 `do` 最坏的一种失手);顶层不是对象 = 抛(`params` 在契约上就是一张表)。
 */
export function parseJsonArgument(raw: string | undefined, flag: string): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`--${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--${flag} must be a JSON object, e.g. --${flag} '{"limit":20}'`)
  }
  return parsed as Record<string, unknown>
}

/* ── 排版(纯函数,测试直接吃它们)────────────────────────────────────────── */

export function formatResourceList(response: ListResourcesResponse): string {
  const schemes = response?.schemes ?? []
  if (schemes.length === 0) return '(no resources registered)'
  const width = Math.max(...schemes.map(entry => entry.scheme.length))
  return schemes.map(entry => `${entry.scheme.padEnd(width)}  ${entry.title}`).join('\n')
}

/** 一条做法的补充说明:效果、家、场子闸。空的就不印括号。 */
function opAnnotations(op: SerializedResourceSpec['ops'][string]): string {
  const notes: string[] = []
  if (op.effects.length > 0) notes.push(op.effects.join(','))
  // `home` 印出来是因为它回答的是「这条做法在没有界面的宿主上还成不成立」——
  // CLI 正是那种宿主,`shell` 那几条在这里会得到「这个宿主没有界面」。
  if (op.home === 'shell') notes.push('needs a window')
  if (op.whenGated) notes.push('scene-gated')
  return notes.length > 0 ? ` (${notes.join('; ')})` : ''
}

export function formatResourceSpec(spec: SerializedResourceSpec): string {
  const lines: string[] = [`${spec.scheme} — ${spec.title}`]
  const section = (
    title: string,
    entries: Array<[string, string, string]>,
  ): void => {
    lines.push('', title)
    if (entries.length === 0) {
      lines.push('  (none)')
      return
    }
    const width = Math.max(...entries.map(([name]) => name.length))
    for (const [name, label, extra] of entries) {
      lines.push(`  ${name.padEnd(width)}  ${label}${extra}`)
    }
  }

  section('READS', Object.entries(spec.reads).map(([name, read]) => [name, read.title, '']))
  section('OPS', Object.entries(spec.ops).map(([name, op]) => [name, op.title, opAnnotations(op)]))
  section('EVENTS', Object.entries(spec.events).map(([name, event]) => [name, event.title, '']))
  if (spec.state) {
    section(
      'STATE',
      Object.entries(spec.state).map(([name, entry]) => [name, entry.title, ` (${entry.volatility})`]),
    )
  }
  return lines.join('\n')
}

export function formatReadView(view: ResourceReadView): string {
  switch (view.kind) {
    case 'ok':
      return JSON.stringify(view.value, null, 2)
    case 'invalid':
      return `invalid: ${view.message}`
    case 'denied':
      return `denied: ${view.reason}`
    case 'failed':
      return `failed: ${view.error.name}: ${view.error.message}`
  }
}

export function formatOutcomeView(view: ResourceOutcomeView): string {
  switch (view.kind) {
    case 'ok':
      return view.text
    case 'invalid':
      return `invalid: ${view.message}`
    case 'denied':
      return `denied: ${view.reason}`
    case 'aborted':
      // partial 在这里是**排障信息**而不是结果:一次被掐断的做法写了一半,
      // 那一半是什么比「它被掐了」更要紧。
      return [
        `aborted${view.reason ? `: ${view.reason}` : ''}`,
        ...(view.partial ? [view.partial] : []),
      ].join('\n')
    case 'failed':
      return `failed: ${view.error.name}: ${view.error.message}`
  }
}

/* ── 子命令 ───────────────────────────────────────────────────────────────── */

export const RESOURCE_COMMAND_USAGE =
  'Usage: onething resource list | describe <scheme> | read <ref> <name> [--query \'<json>\'] '
  + '| do <ref> <op> [--params \'<json>\'] [--session <id>]'

/**
 * 跑一条 `resource` 子命令。
 *
 * `client` 由调用方给(`index.ts` 传的是 `ensureDaemon` 的连接),所以这只函数
 * 自己不认识 daemon —— 它只认识四支方法与两种排版。
 *
 * 返回值是**退出码**:非 `ok` 的结局要让 `&&` 看得见(见文件头)。
 */
export async function resourceCommand(
  command: string | undefined,
  rest: string[],
  options: ResourceCommandOptions,
  client: ResourceCommandClient,
): Promise<number> {
  const request = <T>(method: string, params?: unknown): Promise<T> =>
    client.request<T>(method as never, params)

  switch (command) {
    case undefined:
    case 'list': {
      const response = await request<ListResourcesResponse>('resource.list')
      stdout(options.json ? JSON.stringify(response, null, 2) : formatResourceList(response))
      return 0
    }
    case 'describe': {
      const scheme = required(rest[0], 'scheme')
      const spec = await request<SerializedResourceSpec>('resource.describe', { scheme })
      stdout(options.json ? JSON.stringify(spec, null, 2) : formatResourceSpec(spec))
      return 0
    }
    case 'read': {
      const view = await request<ResourceReadView>('resource.read', {
        ref: required(rest[0], 'ref'),
        name: required(rest[1], 'name'),
        query: parseJsonArgument(options.query, 'query'),
        ...(options.session ? { sessionId: options.session } : {}),
      })
      stdout(options.json ? JSON.stringify(view, null, 2) : formatReadView(view))
      return view.kind === 'ok' ? 0 : 1
    }
    case 'do': {
      const view = await request<ResourceOutcomeView>('resource.do', {
        ref: required(rest[0], 'ref'),
        op: required(rest[1], 'op'),
        params: parseJsonArgument(options.params, 'params'),
        ...(options.session ? { sessionId: options.session } : {}),
      })
      stdout(options.json ? JSON.stringify(view, null, 2) : formatOutcomeView(view))
      return view.kind === 'ok' ? 0 : 1
    }
    default:
      throw new Error(`Unknown resource command: ${command}\n${RESOURCE_COMMAND_USAGE}`)
  }
}

function required(value: string | undefined, label: string): string {
  if (!value || !value.trim()) throw new Error(`${label} is required\n${RESOURCE_COMMAND_USAGE}`)
  return value
}
