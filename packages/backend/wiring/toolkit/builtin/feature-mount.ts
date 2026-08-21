/**
 * R3a 移植 —— `feature_mount`。§4 的 `CapabilityTool` 一族。
 *
 * 描述、参数、每一条教学式报错、成功回执逐字沿用旧
 * `app/features/builtin/self-evolution.ts`。
 *
 * 效果:一条 `capability_change`(core `NEVER_GRANTABLE_TYPES` 里唯一的成员 ——
 * 每挂一次问一次,答案永不可记住)。**没有新增 effect kind**:加一个
 * `feature_mount` kind 就是 D3 第一条禁止的「功能形状的洞」。
 *
 * 派生 guard 是 `permission-gated`,与旧值逐字相同 —— R3a 复盘裁定把
 * `capability_change` 那一格从"为 variable 写死的 safe"改回真相之后,这只工具
 * 不再有偏差(见 `guard-projection.ts` 的注释)。
 *
 * 场景门:挂在内置 skill `onething-self-evolution` 上(默认关闭,设置 → Skills
 * 打开即进场景)。
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { makeEffect } from '@onething/core/toolkit'
import type { Effect, Preview, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { JsonObject } from '@onething/core'
import { CapabilityTool, defineInput, SELF_EVOLUTION_SKILL_NAME } from '@onething/runtime/toolkit'
import { dumpFeatures, hasFeature, mountFeature } from '../../../features/index.js'
import {
  asFeatureDefinition,
  bootstrapGuidance,
  contractGuidance,
  featuresDevRoot,
  isDirectory,
  isFile,
  minimalTemplate,
  resolveEntry,
  type FeatureToolRuntime,
} from './feature-runtime.js'

export const FeatureMountInputSchema = z.object({
  id: z.string().describe(
    'Feature id. Also the directory name under <store>/features-dev/, and must equal the id declared by the module.',
  ),
  entryPath: z.string().optional().describe(
    'Entry file relative to <store>/features-dev/<id>/. Defaults to feature.mjs. Paths outside that directory are refused.',
  ),
})

export const FEATURE_MOUNT_DESCRIPTION = [
  'Mount a feature into the running app from <store>/features-dev/<id>/feature.mjs — it takes effect immediately, no restart.',
  'The module must default-export { id, mount(ctx) }. ctx offers registerRpcDomain(router, handlers) and registerDisposer(fn), both returning a disposer.',
  'Mounting executes the code you wrote, so every call asks the user for permission and that answer can never be remembered.',
  'To change a mounted feature: edit the file, then mount again after feature_unmount — the module cache is bypassed, so you always get the code currently on disk.',
].join('\n')

const FeatureMountContract = defineInput(FeatureMountInputSchema)

export type FeatureMountInput = z.infer<typeof FeatureMountInputSchema>

export class FeatureMountTool extends CapabilityTool<FeatureMountInput> {
  protected readonly requiredSkill = SELF_EVOLUTION_SKILL_NAME
  private readonly runtime: FeatureToolRuntime

  readonly spec: ToolSpec = {
    id: 'feature_mount',
    title: 'FeatureMount',
    description: FEATURE_MOUNT_DESCRIPTION,
    input: FeatureMountContract.schema,
    effects: ['capability_change'],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(runtime: FeatureToolRuntime) {
    super()
    this.runtime = runtime
  }

  protected effectsFor(input: FeatureMountInput): Effect[] {
    const resolution = resolveEntry(input.id, input.entryPath)
    // 解析失败时仍然报一个 effect(而不是抛):apply 那边有教学文本,而 plan 阶段
    // 抛错只会给出一句没有下一步的失败。
    const target = resolution.ok ? resolution.entry : join(featuresDevRoot(), input.id)
    return [makeEffect('capability_change', [target], {
      barrier: true,
      metadata: {
        featureId: input.id,
        entry: target,
        // titleForEffect 的 capability_change 分支读这两个字段。
        variable: `feature:${input.id}`,
        value: target,
      },
    })]
  }

  protected previewFor(input: FeatureMountInput): Preview {
    const resolution = resolveEntry(input.id, input.entryPath)
    const target = resolution.ok ? resolution.entry : join(featuresDevRoot(), input.id)
    return {
      title: `挂载 feature「${input.id}」— 执行 ${target} 里的代码`,
      path: target,
    }
  }

  protected async perform(input: FeatureMountInput, ctx: RunContext): Promise<Result> {
    const failure = (output: string): Result =>
      this.done(ctx, `挂载失败:${input.id}`, output, { featureId: input.id, mounted: false })

    if (this.runtime.sealed) {
      return failure([
        '自进化 feature 正在卸载,挂载面已封闭,本次挂载没有发生。',
        '下一步:等宿主重新装配完成后再调 feature_mount —— 在卸载过程中挂进来的东西没有人管得着。',
      ].join('\n'))
    }

    const resolution = resolveEntry(input.id, input.entryPath)
    if (!resolution.ok) return failure(resolution.message)
    const { dir, entry } = resolution

    if (this.runtime.dynamic.has(input.id)) {
      return failure([
        `feature ${JSON.stringify(input.id)} 已经挂载(入口 ${this.runtime.dynamic.get(input.id)!.entry})。`,
        '同一个 id 两份实现同时在线永远是接线 bug,所以挂载表直接拒绝,而不是后来者覆盖。',
        `下一步:先 feature_unmount({ id: ${JSON.stringify(input.id)} }),再 feature_mount —— 重挂会重新读盘,拿到的是你刚改过的代码。`,
      ].join('\n'))
    }

    if (hasFeature(input.id)) {
      return failure([
        `${JSON.stringify(input.id)} 是一个**内置** feature(随应用一起构建),不是你挂进来的。`,
        '内置 feature 不能被顶掉:换个 id 即可。',
        '下一步:feature_inspect() 看全部已挂载的 id,挑一个没被占用的。',
      ].join('\n'))
    }

    if (!isDirectory(dir)) {
      return failure([`${dir} 不存在。`, '', bootstrapGuidance(input.id)].join('\n'))
    }

    if (!isFile(entry)) {
      return failure([
        `目录 ${dir} 在,但入口文件 ${entry} 不在。`,
        '',
        `下一步:write 这个文件,内容形如`,
        '',
        minimalTemplate(input.id),
        '',
        `然后重调 feature_mount({ id: ${JSON.stringify(input.id)} })。`,
      ].join('\n'))
    }

    const generation = (this.runtime.generations.get(input.id) ?? 0) + 1
    let moduleNamespace: { default?: unknown }
    try {
      // cache-bust:Node 的 ESM 模块缓存以 URL 为键,查询串让每次挂载都是新键。
      const href = `${pathToFileURL(entry).href}?t=${Date.now()}-${generation}`
      moduleNamespace = (await import(/* @vite-ignore */ href)) as { default?: unknown }
    } catch (error) {
      return failure([
        `加载 ${entry} 失败:${error instanceof Error ? error.message : String(error)}`,
        '',
        '这是模块**求值**阶段的错误(语法错、顶层 throw、import 不到的依赖),挂载还没开始,',
        '所以什么都没有注册进去,不需要清理。',
        `下一步:修好这个文件,再调 feature_mount({ id: ${JSON.stringify(input.id)} })。`,
      ].join('\n'))
    }

    const definition = asFeatureDefinition(moduleNamespace.default)
    if (!definition) {
      return failure(contractGuidance(input.id, entry, moduleNamespace.default))
    }
    if (definition.id !== input.id) {
      return failure([
        `模块声明的 id 是 ${JSON.stringify(definition.id)},但 feature_mount 收到的是 ${JSON.stringify(input.id)}。`,
        '两者必须一致 —— 否则你会「卸载 A 却发现 B 还在」,而挂载表按模块声明的 id 记账。',
        `下一步:改一处让它们对上(把模块里的 id 改成 ${JSON.stringify(input.id)},或用 feature_mount({ id: ${JSON.stringify(definition.id)} }) 调用)。`,
      ].join('\n'))
    }

    let unmount
    try {
      unmount = await mountFeature(definition)
    } catch (error) {
      return failure([
        `${JSON.stringify(input.id)} 的 mount() 抛错:${error instanceof Error ? error.message : String(error)}`,
        '',
        '**已经回滚**:这次挂载里已经落地的注册被逆序解绕干净,挂载表里没有留下半挂载的记录。',
        `下一步:修好 ${entry} 里的 mount(),再调 feature_mount({ id: ${JSON.stringify(input.id)} }) 即可 —— 不需要先 unmount。`,
      ].join('\n'))
    }

    this.runtime.generations.set(input.id, generation)
    this.runtime.dynamic.set(input.id, { unmount, entry, mountedAt: Date.now(), generation })

    const dump = dumpFeatures().find(item => item.id === input.id)
    const registered = dump
      ? `注册项:rpcDomain ${dump.registrations.rpcDomain}${dump.rpcDomains.length ? ` (${dump.rpcDomains.join(', ')})` : ''}、disposer ${dump.registrations.disposer}`
      : '注册项:(挂载表里查不到,请调 feature_inspect 复核)'
    return this.done(
      ctx,
      `已挂载:${input.id}`,
      [
        `feature ${JSON.stringify(input.id)} 已挂载并立即生效(第 ${generation} 次)。`,
        `入口:${entry}`,
        registered,
        '',
        `改代码后重新生效:feature_unmount({ id: ${JSON.stringify(input.id)} }) → 改文件 → feature_mount({ id: ${JSON.stringify(input.id)} })。`,
      ].join('\n'),
      { featureId: input.id, entry, mounted: true },
    )
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createFeatureMountTool(runtime: FeatureToolRuntime): FeatureMountTool {
  return new FeatureMountTool(runtime)
}
