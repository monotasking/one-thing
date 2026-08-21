/**
 * R3a —— 自进化三件套的**共享状态与纯助手**。
 *
 * 旧实现(`app/features/builtin/self-evolution.ts` 的 `mountSelfEvolution`)把三个
 * `Tool.define` 建在同一个闭包里,共享 `dynamic` 挂载表、`generations` 计数与
 * `sealed` 闩。新树里三个工具是三个类,所以那份闭包状态提成一个显式对象 ——
 * **生命周期不变**:表的寿命 = 这一组工具的寿命,表若是模块级的,一次卸载再挂载
 * 就会捡到上一轮的残留记录(而那些记录指向的 unmount 早已失效)。
 *
 * 这三个工具住在**装配层**而不是产品层:它们依赖 features 注册表与 store 路径,
 * 两样都是装配层的东西。
 *
 * 路径夹紧、教学文本、模块契约检查全部逐字沿用旧实现。
 */

import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isPathInside } from '../../../rpc/sandbox.js'
import {
  getOnethingStorePath,
} from '@onething/runtime/storage'
import type { FeatureDefinition, FeatureUnmount } from '../../../features/index.js'

/** 模型能挂东西的唯一目录,相对 store 根。 */
export const FEATURES_DEV_DIR_NAME = 'features-dev'

/** 不给 `entryPath` 时的默认入口文件名。 */
export const DEFAULT_ENTRY_FILENAME = 'feature.mjs'

/**
 * feature id 的字面量判据。它同时是**目录名**,所以这道正则就是路径夹紧的第一层。
 * 第二层(`isPathInside`)照样跑 —— 第一层是「长得对不对」,第二层是「解析完落在
 * 哪」,后者才是护栏。
 */
export const FEATURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** `<store>/features-dev`。 */
export function featuresDevRoot(): string {
  return join(getOnethingStorePath(), FEATURES_DEV_DIR_NAME)
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 教学文本里那份最小 feature 模板。内联,免得模型再去查文档。 */
export function minimalTemplate(featureId: string): string {
  return [
    `// ${join(featuresDevRoot(), featureId, DEFAULT_ENTRY_FILENAME)}`,
    'export default {',
    `  id: '${featureId}',`,
    '  mount(ctx) {',
    '    // 任何副作用都要配一个注销:',
    '    const timer = setInterval(() => {}, 60_000)',
    '    ctx.registerDisposer(() => clearInterval(timer))',
    '',
    '    // 也可以注册一个 RPC 域(router 是纯数据,不用 import 任何东西):',
    '    // ctx.registerRpcDomain(',
    "    //   { domain: 'demo', channels: { ping: 'demo:ping' }, methods: ['ping'] },",
    '    //   { async ping(input) { return { pong: input.value } } },',
    '    // )',
    '  },',
    '}',
  ].join('\n')
}

/** 目录不存在时的统一教学段落。**不 mkdir** —— 只教怎么建。 */
export function bootstrapGuidance(featureId: string): string {
  const dir = join(featuresDevRoot(), featureId)
  return [
    `下一步(工具不会替你建目录 —— 目录不在,说明这个宿主还没开过这件事,这条信息不该被凭空抹掉):`,
    `  1. bash: mkdir -p ${JSON.stringify(dir)}`,
    `  2. write: ${join(dir, DEFAULT_ENTRY_FILENAME)},内容形如`,
    '',
    minimalTemplate(featureId),
    '',
    `  3. 再调 feature_mount({ id: ${JSON.stringify(featureId)} })。`,
  ].join('\n')
}

/** 入口解析的结果:要么拿到一个夹紧过的绝对路径,要么拿到一段教学文本。 */
export type EntryResolution =
  | { ok: true; dir: string; entry: string }
  | { ok: false; message: string }

/**
 * `{id, entryPath?}` → 夹紧后的入口绝对路径。两条护栏,顺序不能换:先判 id 的
 * 字面量(挡住 `..` 与分隔符),再把解析完的路径与 feature **自己的目录**比。
 */
export function resolveEntry(featureId: string, entryPath?: string): EntryResolution {
  const root = featuresDevRoot()
  if (!FEATURE_ID_PATTERN.test(featureId)) {
    return {
      ok: false,
      message: [
        `feature id ${JSON.stringify(featureId)} 不合法:它同时是 ${root} 下的目录名,`,
        '所以只接受字母/数字开头、其余为字母数字与 . _ - 的单段名字(不能含 / 或 ..)。',
        '下一步:换一个合法 id 再调 feature_mount,例如 "demo-echo"。',
      ].join('\n'),
    }
  }

  const dir = join(root, featureId)
  if (entryPath !== undefined && (typeof entryPath !== 'string' || entryPath.trim() === '')) {
    return {
      ok: false,
      message: [
        'entryPath 给了但是空的。',
        `下一步:要么省略 entryPath(默认取 ${DEFAULT_ENTRY_FILENAME}),要么给一个相对 ${dir} 的文件名。`,
      ].join('\n'),
    }
  }

  const requested = entryPath?.trim() ?? DEFAULT_ENTRY_FILENAME
  const entry = resolve(isAbsolute(requested) ? requested : join(dir, requested))
  if (!isPathInside(entry, dir)) {
    return {
      ok: false,
      message: [
        `entryPath 落在 ${dir} 之外(解析结果 ${entry}),拒绝加载。`,
        'feature_mount 只从这个 feature 自己的目录里取代码 —— 挂载等于执行任意代码,',
        '所以加载面是一个白名单目录,不是任意绝对路径。',
        `下一步:把入口文件放进 ${dir},再用相对文件名调用,例如 entryPath: "index.mjs"。`,
      ].join('\n'),
    }
  }
  return { ok: true, dir, entry }
}

/** 一个模块的默认导出长得像 FeatureDefinition 吗。 */
export function asFeatureDefinition(value: unknown): FeatureDefinition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<FeatureDefinition>
  if (typeof candidate.id !== 'string' || candidate.id === '') return undefined
  if (typeof candidate.mount !== 'function') return undefined
  return candidate as FeatureDefinition
}

/** 模块形状不对时的教学文本 —— 直接给出期望的导出签名。 */
export function contractGuidance(featureId: string, entry: string, sawDefault: unknown): string {
  const saw = sawDefault === undefined
    ? '模块没有默认导出'
    : `默认导出是 ${typeof sawDefault === 'object' ? 'object(但缺 id 或 mount)' : typeof sawDefault}`
  return [
    `${entry} 不符合 feature 模块契约:${saw}。`,
    '',
    '期望的形状(默认导出一个 FeatureDefinition):',
    '',
    '  export default {',
    `    id: '${featureId}',                  // string,必须与 feature_mount 的 id 一致`,
    '    mount(ctx) { /* … */ },          // (ctx: FeatureContext) => void | Promise<void>',
    '  }',
    '',
    'ctx 上现在只有两个注册面(C2 的判据:差距清单驱动,不预雕):',
    '  ctx.registerRpcDomain(router, handlers) -> disposer',
    '  ctx.registerDisposer(() => { /* 撤销一项副作用 */ }) -> disposer',
    '',
    `下一步:改完 ${entry} 之后直接重调 feature_mount({ id: ${JSON.stringify(featureId)} }) ——`,
    '每次挂载都会绕过模块缓存重新读盘,不需要重启。',
  ].join('\n')
}

/** features-dev 目录里「有入口文件、但当前没挂」的候选。 */
export function listCandidates(mountedIds: Set<string>): { root: string; exists: boolean; candidates: string[] } {
  const root = featuresDevRoot()
  if (!isDirectory(root)) return { root, exists: false, candidates: [] }
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return { root, exists: true, candidates: [] }
  }
  const candidates = entries
    .filter(name => FEATURE_ID_PATTERN.test(name))
    .filter(name => isDirectory(join(root, name)))
    .filter(name => isFile(join(root, name, DEFAULT_ENTRY_FILENAME)))
    .filter(name => !mountedIds.has(name))
    .sort()
  return { root, exists: true, candidates }
}

/** 一条动态挂载记录。 */
export interface DynamicRecord {
  unmount: FeatureUnmount
  entry: string
  mountedAt: number
  /** 第几次挂这个 id。教学文本里用来说明「拿到的是新代码」。 */
  generation: number
}

/**
 * 三个工具共享的那份状态。旧实现里它是 `mountSelfEvolution` 的闭包变量。
 */
export class FeatureToolRuntime {
  readonly dynamic = new Map<string, DynamicRecord>()
  /** 这个 id 历史上被挂过几次(卸载后不清零)。 */
  readonly generations = new Map<string, number>()
  /** 地雷 3 的闩:清扫一开始就封死挂载面。 */
  sealed = false

  describeDynamic(): string {
    return this.dynamic.size === 0
      ? '(当前没有动态挂载的 feature)'
      : [...this.dynamic.keys()].sort().map(id => `  - ${id}`).join('\n')
  }

  /**
   * 全部动态 feature 的清扫。顺序:后挂的先卸;一项抛错不阻断其余(半清扫比全
   * 清扫危险),错误聚合后抛给上层 —— 与旧实现的那个 disposer 逐字同义。
   */
  async sweep(): Promise<void> {
    this.sealed = true
    const ids = [...this.dynamic.keys()].reverse()
    const errors: unknown[] = []
    for (const id of ids) {
      const record = this.dynamic.get(id)
      this.dynamic.delete(id)
      try {
        await record?.unmount()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `[self-evolution] 清扫动态 feature 时有 ${errors.length} 项失败`)
    }
  }
}
