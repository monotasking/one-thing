/**
 * 自进化 feature —— C4 第一档(`docs/design/cordis-adoption-2026-08.md` §7)。
 *
 * 它把 C0 立起来的可逆注册基座**交到模型手里**:`feature_mount` /
 * `feature_unmount` / `feature_inspect` 三个会话工具,让模型在一次对话里现场挂
 * 载、卸载、自省一件功能,免重启。对标 dsh 的 cordis_define/run/stop/inspect
 * 四件套 —— 我们少一个 `define`,是因为「写文件」这件事本仓已经有 write/edit
 * 两个工具在干,再造第三个入口只会分叉。
 *
 * ── 自己也是 feature(吃自己狗粮)────────────────────────────────────────
 *
 * 这三个工具**不是**加在 `tools/builtin/index.ts` 那张表里的第 25 个内置工具,
 * 而是一个 feature 的注册项。理由是 D1 那句质问的直接推论:自进化能力如果自己
 * 走特权路进内核,那它证明的就不是「feature 基座够用」,而是「基座之外还有一
 * 条更方便的路」。它挂在名册里、`feature_inspect` 看得见自己、卸载自己也能把
 * 三个工具一起摘干净 —— 这是本期唯一有说服力的自证。
 *
 * ── C0 三条 cordis 语义地雷,逐条对照(§5.5.3)────────────────────────────
 *
 * 1. **并行 + 吞错的 `_unload`**。本 feature **有真实的顺序契约**(轨迹那个
 *    被试品没有):卸载时必须**先**把模型挂进来的那批动态 feature 全部收掉,
 *    **再**注销三个工具。反过来会留下一批没人管得着的动态 feature —— 控制面
 *    没了,东西还在跑。按 §5.5.3 第一条的处方,整趟清扫收进**同一个**
 *    `registerDisposer`(cordis 只在单个 effect 内部保证逆序 + 串行);而它在
 *    注册顺序上排**最后**,于是适配层的逆序解绕让它**第一个**跑。
 *    C2 的 G8 给 C3 的建议,在这里第一次被真正执行。
 * 2. **`apply` 抛错 = fiber FAILED**。本 feature 的 `mount` 继续用适配层接住的
 *    默认(首错原样抛给装配方)。但**动态 feature 的 mount 失败不走这条**:那
 *    是模型写的代码出错,不是接线 bug,所以由 `feature_mount` 接住并翻译成教学
 *    文本 —— 一个模型写错的插件绝不该让宿主装配失败。
 * 3. **`ctx.effect()` 在 UNLOADING 期抛 `INACTIVE_EFFECT`**。本 feature 的
 *    dispose 路径**不注册任何东西**,并且用 `sealed` 闩住:清扫一开始就把
 *    `feature_mount` 封死,免得一次在飞的工具调用在 UNLOADING 期间往回挂。
 *    (三个工具的注销发生在清扫之后,那之间有一条窄缝,闩住的就是它。)
 *
 * ── 安全:D1 授信纪律在工具档的映射 ──────────────────────────────────────
 *
 * 「模型现场写的 feature 走同一道授信门」(kernel-shrink §1 D1)。落到工具档
 * 是三条,都不是新机制:
 *
 * - **每挂一次问一次,且永不可记住**。`feature_mount` 声明的 effect kind 是
 *   `capability_change` —— core 的 `NEVER_GRANTABLE_TYPES` 里就它一个,所以
 *   「以后都允许」这个选项在权限卡上根本不出现(`permission-ledger.ts` 已按同
 *   一判据不给授权行)。挑这个 kind 不是凑数:它的定义原文是「Repointing
 *   something the system itself acts on … it changes what the assistant can
 *   reach, so it is never silent and never grantable」,而挂载一个 feature 正是
 *   **改变助手够得着什么**的那件事。**没有新增 effect kind** —— 加一个
 *   `feature_mount` kind 就是 D3 第一条禁止的「功能形状的洞」。
 * - **不入自动放行类**。`autoExecute: false` + `permissionGuard:
 *   'permission-gated'`,与 `edit` 同档(`edit` 是本仓写盘工具里最严的那个)。
 * - **只从一个目录加载**。`<store>/features-dev/<id>/` 之外一律拒绝;`entryPath`
 *   夹进该 feature 自己的目录(不是夹到 features-dev 根就算数)。夹紧用的是
 *   `rpc/sandbox.ts` 的 `isPathInside` —— 与联网宿主的 RPC 沙箱同一份实现,
 *   而不是再抄一遍 `startsWith`(那正是 skills 拒迁时记下的教训)。
 *
 * 另有一道**宿主档门**:三个工具只在「已经有 bash 的宿主」上注册。判据不是
 * 「是不是桌面」(那是宿主探测,装配层不许干),而是一句可证的等价陈述 ——
 * 挂载一个 feature 与跑一条 shell 是同一量级的能力,一个连 bash 都不给的宿主
 * (`readonly` 档,联网 server 的降级形态)当然也不该给这个。full 与 headless
 * 两档有 bash,readonly 档没有,门自然落在正确的位置,且**默认拒绝**:工具注
 * 册表还没起来时 `hasTool('bash')` 为 false,一个字都不注册。
 *
 * ── 教学式报错(dsh 判例)──────────────────────────────────────────────
 *
 * 每一条失败路径的返回文本都必须回答两个问题:**发生了什么** + **下一步调什
 * 么**。报错是写给模型看的操作指南,不是写给日志的墓碑。目录不存在时给出创建
 * 指引与最小模板,但**工具自己不 mkdir** —— 与 E0 事件日志同纪律:凭空造目录
 * 会把「这个宿主没配过这件事」这条信息抹掉。
 *
 * import 零副作用:本模块加载只产出一个常量对象与几个纯函数,工具注册发生在
 * `mountFeature` 真的调用 `mount` 的那一刻
 * (`app/__tests__/import-side-effect-free.test.ts`)。
 */
import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { ToolEffect, ToolPreview } from '@onething/core/tools'
import { isPathInside } from '../../rpc/sandbox.js'
import { getStorePath } from '../../stores/paths.js'
import { Tool } from '../../tools/core/tool.js'
import { hasTool, registerTool, unregisterTool } from '../../tools/registry.js'
import {
  dumpFeatureEffects,
  dumpFeatures,
  hasFeature,
  mountFeature,
  type FeatureContext,
  type FeatureDefinition,
  type FeatureUnmount,
} from '../index.js'

/** 模型能挂东西的唯一目录,相对 store 根。 */
const FEATURES_DEV_DIR_NAME = 'features-dev'

/** 不给 `entryPath` 时的默认入口文件名。 */
const DEFAULT_ENTRY_FILENAME = 'feature.mjs'

/**
 * feature id 的字面量判据。
 *
 * 它同时是**目录名**,所以这道正则就是路径夹紧的第一层:`.` / `..` /
 * `a/b` / 绝对路径全都进不来。第二层(`isPathInside`)照样跑 —— 两层都在,
 * 因为第一层是「长得对不对」,第二层是「解析完落在哪」,后者才是护栏。
 */
const FEATURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** `<store>/features-dev`。 */
function featuresDevRoot(): string {
  return join(getStorePath(), FEATURES_DEV_DIR_NAME)
}

/** 目录存在吗(不存在、或不是目录,都算不存在)。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 文件存在吗。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 教学文本里那份最小 feature 模板。内联,免得模型再去查文档。 */
function minimalTemplate(featureId: string): string {
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
function bootstrapGuidance(featureId: string): string {
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
type EntryResolution =
  | { ok: true; dir: string; entry: string }
  | { ok: false; message: string }

/**
 * `{id, entryPath?}` → 夹紧后的入口绝对路径。
 *
 * 两条护栏,顺序不能换:先判 id 的字面量(挡住 `..` 与分隔符),再把解析完的
 * 路径与 feature 自己的目录比 —— **比的是 feature 目录,不是 features-dev 根**。
 * 夹到根就算数的话,`entryPath: '../other/feature.mjs'` 会横跨到别人的目录里,
 * 那不是「只允许从 features-dev 加载」,是「只允许从 features-dev 的任意角落
 * 加载」。
 */
function resolveEntry(featureId: string, entryPath?: string): EntryResolution {
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
function asFeatureDefinition(value: unknown): FeatureDefinition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<FeatureDefinition>
  if (typeof candidate.id !== 'string' || candidate.id === '') return undefined
  if (typeof candidate.mount !== 'function') return undefined
  return candidate as FeatureDefinition
}

/** 模块形状不对时的教学文本 —— 直接给出期望的导出签名。 */
function contractGuidance(featureId: string, entry: string, sawDefault: unknown): string {
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
function listCandidates(mountedIds: Set<string>): { root: string; exists: boolean; candidates: string[] } {
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

interface MountMetadata extends Record<string, unknown> {
  featureId: string
  entry?: string
  mounted: boolean
}

/** 一条动态挂载记录。 */
interface DynamicRecord {
  unmount: FeatureUnmount
  entry: string
  mountedAt: number
  /** 第几次挂这个 id。教学文本里用来说明「拿到的是新代码」。 */
  generation: number
}

const MountParameters = z.object({
  id: z.string().describe(
    'Feature id. Also the directory name under <store>/features-dev/, and must equal the id declared by the module.',
  ),
  entryPath: z.string().optional().describe(
    'Entry file relative to <store>/features-dev/<id>/. Defaults to feature.mjs. Paths outside that directory are refused.',
  ),
})

const UnmountParameters = z.object({
  id: z.string().describe('Feature id to unmount. Only features mounted via feature_mount can be unmounted.'),
})

const InspectParameters = z.object({})

/**
 * 三个工具 + 它们共享的动态挂载表,全部**建在 `mount` 里**。
 *
 * 表的生命周期 = feature 的生命周期,这不是风格问题:表若是模块级的,一次
 * 卸载再挂载就会捡到上一轮的残留记录(而那些记录指向的 unmount 早已失效)。
 */
function mountSelfEvolution(ctx: FeatureContext): void {
  // 宿主档门:见文件头。默认拒绝 —— 注册表没起来时一个字都不注册。
  if (!hasTool('bash')) return

  const dynamic = new Map<string, DynamicRecord>()
  /** 这个 id 历史上被挂过几次(卸载后不清零 —— 用来说明「重挂拿到的是新代码」)。 */
  const generations = new Map<string, number>()
  /** 地雷 3 的闩:清扫一开始就封死挂载面。 */
  let sealed = false

  const describeDynamic = (): string => (
    dynamic.size === 0
      ? '(当前没有动态挂载的 feature)'
      : [...dynamic.keys()].sort().map(id => `  - ${id}`).join('\n')
  )

  const MountTool = Tool.define<typeof MountParameters, MountMetadata>('feature_mount', {
    name: 'FeatureMount',
    description: [
      'Mount a feature into the running app from <store>/features-dev/<id>/feature.mjs — it takes effect immediately, no restart.',
      'The module must default-export { id, mount(ctx) }. ctx offers registerRpcDomain(router, handlers) and registerDisposer(fn), both returning a disposer.',
      'Mounting executes the code you wrote, so every call asks the user for permission and that answer can never be remembered.',
      'To change a mounted feature: edit the file, then mount again after feature_unmount — the module cache is bypassed, so you always get the code currently on disk.',
    ].join('\n'),
    category: 'builtin',
    enabled: true,
    autoExecute: false,
    // `edit` 同档:执行前必须过 enforcePermissionPolicy,且不入自动放行类。
    permissionGuard: 'permission-gated',
    executionMode: 'sequential',
    renderKind: 'text',
    parameters: MountParameters,

    analyze(args): { effects: ToolEffect[]; preview?: ToolPreview } {
      const resolution = resolveEntry(args.id, args.entryPath)
      // 解析失败时仍然报一个 effect(而不是抛):execute 那边有教学文本,
      // 而 analyze 阶段抛错只会给出一句没有下一步的失败。
      const target = resolution.ok ? resolution.entry : join(featuresDevRoot(), args.id)
      return {
        effects: [{
          // core 的 NEVER_GRANTABLE_TYPES 里唯一的成员 —— 每次都问,永不可记住。
          kind: 'capability_change',
          resources: [target],
          barrier: true,
          metadata: {
            featureId: args.id,
            entry: target,
            // titleForEffect 的 capability_change 分支读这两个字段;preview.title
            // 在前面赢,这里是没有 preview 时的兜底措辞。
            variable: `feature:${args.id}`,
            value: target,
          },
        }],
        preview: {
          title: `挂载 feature「${args.id}」— 执行 ${target} 里的代码`,
          path: target,
        },
      }
    },

    async execute(args) {
      const failure = (output: string): { title: string; output: string; metadata: MountMetadata } => ({
        title: `挂载失败:${args.id}`,
        output,
        metadata: { featureId: args.id, mounted: false },
      })

      if (sealed) {
        return failure([
          '自进化 feature 正在卸载,挂载面已封闭,本次挂载没有发生。',
          '下一步:等宿主重新装配完成后再调 feature_mount —— 在卸载过程中挂进来的东西没有人管得着。',
        ].join('\n'))
      }

      const resolution = resolveEntry(args.id, args.entryPath)
      if (!resolution.ok) return failure(resolution.message)
      const { dir, entry } = resolution

      if (dynamic.has(args.id)) {
        return failure([
          `feature ${JSON.stringify(args.id)} 已经挂载(入口 ${dynamic.get(args.id)!.entry})。`,
          '同一个 id 两份实现同时在线永远是接线 bug,所以挂载表直接拒绝,而不是后来者覆盖。',
          `下一步:先 feature_unmount({ id: ${JSON.stringify(args.id)} }),再 feature_mount —— 重挂会重新读盘,拿到的是你刚改过的代码。`,
        ].join('\n'))
      }

      if (hasFeature(args.id)) {
        return failure([
          `${JSON.stringify(args.id)} 是一个**内置** feature(随应用一起构建),不是你挂进来的。`,
          '内置 feature 不能被顶掉:换个 id 即可。',
          '下一步:feature_inspect() 看全部已挂载的 id,挑一个没被占用的。',
        ].join('\n'))
      }

      if (!isDirectory(dir)) {
        return failure([
          `${dir} 不存在。`,
          '',
          bootstrapGuidance(args.id),
        ].join('\n'))
      }

      if (!isFile(entry)) {
        return failure([
          `目录 ${dir} 在,但入口文件 ${entry} 不在。`,
          '',
          `下一步:write 这个文件,内容形如`,
          '',
          minimalTemplate(args.id),
          '',
          `然后重调 feature_mount({ id: ${JSON.stringify(args.id)} })。`,
        ].join('\n'))
      }

      const generation = (generations.get(args.id) ?? 0) + 1
      let moduleNamespace: { default?: unknown }
      try {
        // cache-bust:Node 的 ESM 模块缓存以 URL 为键,同一个路径第二次 import
        // 会直接给回第一次的对象 —— 那样「改完重挂」就永远拿不到新代码,而症状
        // 是「代码明明改了却没生效」,极难自证。查询串让每次挂载都是一个新键。
        const href = `${pathToFileURL(entry).href}?t=${Date.now()}-${generation}`
        moduleNamespace = (await import(/* @vite-ignore */ href)) as { default?: unknown }
      } catch (error) {
        return failure([
          `加载 ${entry} 失败:${error instanceof Error ? error.message : String(error)}`,
          '',
          '这是模块**求值**阶段的错误(语法错、顶层 throw、import 不到的依赖),挂载还没开始,',
          '所以什么都没有注册进去,不需要清理。',
          `下一步:修好这个文件,再调 feature_mount({ id: ${JSON.stringify(args.id)} })。`,
        ].join('\n'))
      }

      const definition = asFeatureDefinition(moduleNamespace.default)
      if (!definition) {
        return failure(contractGuidance(args.id, entry, moduleNamespace.default))
      }
      if (definition.id !== args.id) {
        return failure([
          `模块声明的 id 是 ${JSON.stringify(definition.id)},但 feature_mount 收到的是 ${JSON.stringify(args.id)}。`,
          '两者必须一致 —— 否则你会「卸载 A 却发现 B 还在」,而挂载表按模块声明的 id 记账。',
          `下一步:改一处让它们对上(把模块里的 id 改成 ${JSON.stringify(args.id)},或用 feature_mount({ id: ${JSON.stringify(definition.id)} }) 调用)。`,
        ].join('\n'))
      }

      let unmount: FeatureUnmount
      try {
        unmount = await mountFeature(definition)
      } catch (error) {
        return failure([
          `${JSON.stringify(args.id)} 的 mount() 抛错:${error instanceof Error ? error.message : String(error)}`,
          '',
          '**已经回滚**:这次挂载里已经落地的注册被逆序解绕干净,挂载表里没有留下半挂载的记录。',
          `下一步:修好 ${entry} 里的 mount(),再调 feature_mount({ id: ${JSON.stringify(args.id)} }) 即可 —— 不需要先 unmount。`,
        ].join('\n'))
      }

      generations.set(args.id, generation)
      dynamic.set(args.id, { unmount, entry, mountedAt: Date.now(), generation })

      const dump = dumpFeatures().find(item => item.id === args.id)
      const registered = dump
        ? `注册项:rpcDomain ${dump.registrations.rpcDomain}${dump.rpcDomains.length ? ` (${dump.rpcDomains.join(', ')})` : ''}、disposer ${dump.registrations.disposer}`
        : '注册项:(挂载表里查不到,请调 feature_inspect 复核)'
      return {
        title: `已挂载:${args.id}`,
        output: [
          `feature ${JSON.stringify(args.id)} 已挂载并立即生效(第 ${generation} 次)。`,
          `入口:${entry}`,
          registered,
          '',
          `改代码后重新生效:feature_unmount({ id: ${JSON.stringify(args.id)} }) → 改文件 → feature_mount({ id: ${JSON.stringify(args.id)} })。`,
        ].join('\n'),
        metadata: { featureId: args.id, entry, mounted: true },
      }
    },
  })

  const UnmountTool = Tool.define<typeof UnmountParameters, MountMetadata>('feature_unmount', {
    name: 'FeatureUnmount',
    description: [
      'Unmount a feature that feature_mount put in place. Every registration it made is unwound in reverse order.',
      'Built-in features (the ones shipped with the app) cannot be unmounted — only what you mounted in this session.',
    ].join('\n'),
    category: 'builtin',
    enabled: true,
    // 卸载只解绕本会话挂进来的东西,不执行任何模型代码 —— 与 mount 不对称是
    // 有意的:危险的是「让代码跑起来」,不是「让它停下来」。
    autoExecute: true,
    permissionGuard: 'safe',
    executionMode: 'sequential',
    renderKind: 'text',
    parameters: UnmountParameters,

    async execute(args) {
      const record = dynamic.get(args.id)
      if (!record) {
        if (hasFeature(args.id)) {
          return {
            title: `不能卸载:${args.id}`,
            output: [
              `${JSON.stringify(args.id)} 是**内置** feature(随应用一起构建、随装配序列挂载),不归 feature_unmount 管。`,
              '内置功能的开关是产品决定,不是一次会话里的临时动作 —— 卸掉它会让别的东西当场少一块。',
              '',
              '可以卸载的(本会话挂进来的):',
              describeDynamic(),
            ].join('\n'),
            metadata: { featureId: args.id, mounted: true },
          }
        }
        return {
          title: `无需卸载:${args.id}`,
          output: [
            `没有名为 ${JSON.stringify(args.id)} 的动态 feature —— 它没挂过,或者已经卸过了(重复卸载不是错误)。`,
            '',
            '当前动态挂载的:',
            describeDynamic(),
            '',
            '下一步:feature_inspect() 看全景(含内置、动态、以及 features-dev 里可挂而未挂的候选)。',
          ].join('\n'),
          metadata: { featureId: args.id, mounted: false },
        }
      }

      const dump = dumpFeatures().find(item => item.id === args.id)
      dynamic.delete(args.id)
      try {
        await record.unmount()
      } catch (error) {
        return {
          title: `卸载时有项失败:${args.id}`,
          output: [
            `${JSON.stringify(args.id)} 已从挂载表移除,但解绕过程中有注册项抛错:`,
            error instanceof Error ? error.message : String(error),
            '',
            '解绕**不会因为一项失败就停下**(半解绕比全解绕危险),所以其余项都跑完了。',
            '下一步:feature_inspect() 复核 —— 若 fiber 的 effect 树里还留着这个 feature 的标签,说明有副作用没撤干净,',
            '那是这个 feature 的 mount() 里少配了 disposer,改完重挂即可。',
          ].join('\n'),
          metadata: { featureId: args.id, mounted: false },
        }
      }

      const released = dump
        ? `释放:rpcDomain ${dump.registrations.rpcDomain}${dump.rpcDomains.length ? ` (${dump.rpcDomains.join(', ')})` : ''}、disposer ${dump.registrations.disposer}`
        : '释放:(挂载前的账本已不可查)'
      return {
        title: `已卸载:${args.id}`,
        output: [
          `feature ${JSON.stringify(args.id)} 已卸载,它的注册项按逆序全部解绕。`,
          released,
          '',
          `下一步:改完代码直接 feature_mount({ id: ${JSON.stringify(args.id)} }) 即可重新挂上 —— 会重新读盘。`,
        ].join('\n'),
        metadata: { featureId: args.id, entry: record.entry, mounted: false },
      }
    },
  })

  const InspectTool = Tool.define<typeof InspectParameters, Record<string, unknown>>('feature_inspect', {
    name: 'FeatureInspect',
    description: [
      'List every mounted feature: its registrations, its live cordis effect labels, and whether it is built-in or was mounted in this session.',
      'Also lists what sits in <store>/features-dev/ that could be mounted but is not.',
    ].join('\n'),
    category: 'builtin',
    enabled: true,
    autoExecute: true,
    permissionGuard: 'safe',
    executionMode: 'parallel',
    renderKind: 'text',
    parameters: InspectParameters,

    async execute() {
      const dumps = dumpFeatures()
      const effects = new Map(dumpFeatureEffects().map(item => [item.id, item.effects]))
      const mountedIds = new Set(dumps.map(item => item.id))
      const { root, exists, candidates } = listCandidates(mountedIds)

      const renderEffects = (labels: { label: string; children: unknown[] }[], indent: string): string[] =>
        labels.flatMap(node => [
          `${indent}· ${node.label}`,
          ...renderEffects(
            (node.children as { label: string; children: unknown[] }[]) ?? [],
            `${indent}  `,
          ),
        ])

      const lines: string[] = []
      lines.push(`已挂载的 feature(${dumps.length} 个,顺序即装配顺序):`)
      for (const dump of dumps) {
        const record = dynamic.get(dump.id)
        const origin = record
          ? `dynamic — ${record.entry}(第 ${record.generation} 次挂载)`
          : 'builtin — 随应用构建,不可卸载'
        lines.push('')
        lines.push(`  ${dump.id}  [${origin}]`)
        lines.push(
          `    注册项:rpcDomain ${dump.registrations.rpcDomain}`
          + `${dump.rpcDomains.length ? ` (${dump.rpcDomains.join(', ')})` : ''}`
          + `、disposer ${dump.registrations.disposer}`,
        )
        const tree = effects.get(dump.id) ?? []
        if (tree.length === 0) {
          lines.push('    cordis effects:(无)')
        } else {
          lines.push('    cordis effects:')
          lines.push(...renderEffects(tree as { label: string; children: unknown[] }[], '      '))
        }
      }

      lines.push('')
      if (!exists) {
        lines.push(`可挂载的候选:${root} 还不存在。`)
        lines.push('  这个目录是模型能挂东西的**唯一**来源,工具不会替你建 —— 见 feature_mount 的报错指引。')
      } else if (candidates.length === 0) {
        lines.push(`可挂载的候选:${root} 下没有「有 ${DEFAULT_ENTRY_FILENAME} 且当前未挂载」的目录。`)
      } else {
        lines.push(`可挂载的候选(${root} 下有 ${DEFAULT_ENTRY_FILENAME} 但当前没挂):`)
        for (const name of candidates) lines.push(`  - ${name}    → feature_mount({ id: ${JSON.stringify(name)} })`)
      }

      // 契约与起步模板恒定附上:inspect 是模型的第一跳,得让它看完就能动手,
      // 而不是先挂一次、靠报错才拿到模板。当前边界(后端 only)也写在这里 ——
      // 一段说不清的能力,模型会拿去做它做不到的事(真机首验:被要求改输入框样式)。
      lines.push('')
      lines.push('契约与起步:')
      lines.push(`  - 新建 feature = 在 ${root}/<id>/ 下写 ${DEFAULT_ENTRY_FILENAME}(目录用文件工具创建,本工具不代建),然后 feature_mount({ id })。`)
      lines.push('  - 模块默认导出 { id, mount(ctx) };ctx.registerRpcDomain(router, handlers) / ctx.registerDisposer(fn) 都返回 disposer。')
      lines.push('  - 当前边界:feature 只能加后端能力(RPC 域、用 disposer 持有的资源);**改 UI(样式/面板/组件)与注册新工具暂不可用**。')
      lines.push('  - 起步模板(把 <id> 换掉即可):')
      for (const line of minimalTemplate('<id>').split('\n')) lines.push(`      ${line}`)

      return {
        title: `feature 全景:${dumps.length} 挂载 / ${dynamic.size} 动态 / ${candidates.length} 候选`,
        output: lines.join('\n'),
        metadata: {
          mounted: dumps.length,
          dynamic: dynamic.size,
          candidates: candidates.length,
        },
      }
    },
  })

  // 注册顺序 = 解绕的**逆**序。三个工具先注册,清扫最后注册,于是卸载时清扫
  // 第一个跑 —— 见文件头地雷 1。
  registerTool(MountTool)
  ctx.registerDisposer(() => { unregisterTool(MountTool.id) })
  registerTool(UnmountTool)
  ctx.registerDisposer(() => { unregisterTool(UnmountTool.id) })
  registerTool(InspectTool)
  ctx.registerDisposer(() => { unregisterTool(InspectTool.id) })

  /**
   * 全部动态 feature 的清扫 —— **一个** disposer 装下整趟工作。
   *
   * 这正是 §5.5.3 第一条的处方:顺序敏感的一组工作收进同一个 effect(cordis
   * 只在单个 effect 内部保证串行)。这里的顺序有两层:
   *  - 相对三个工具:清扫必须在注销之前 → 靠注册顺序(它最后注册)拿到;
   *  - 内部:后挂的先卸,与适配层的逆序惯例同款。
   *
   * 一个动态 feature 卸载抛错不阻断其余 —— 与 `disposeAll` 同判据(半清扫比
   * 全清扫危险),错误聚合后抛给上层。
   */
  ctx.registerDisposer(async () => {
    sealed = true
    const ids = [...dynamic.keys()].reverse()
    const errors: unknown[] = []
    for (const id of ids) {
      const record = dynamic.get(id)
      dynamic.delete(id)
      try {
        await record?.unmount()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `[self-evolution] 清扫动态 feature 时有 ${errors.length} 项失败`)
    }
  })
}

export const selfEvolutionFeature: FeatureDefinition = {
  id: 'self-evolution',
  mount: mountSelfEvolution,
}
