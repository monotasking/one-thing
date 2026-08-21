/**
 * R3a 移植 —— `feature_unmount`。§4 的 `CapabilityTool` 一族。
 *
 * 描述与三条输出文案逐字沿用旧 `app/features/builtin/self-evolution.ts`。
 *
 * **无效果**(`Intent.none`):卸载只解绕本会话挂进来的东西,不执行任何模型代码
 * —— 与 mount 不对称是有意的:危险的是「让代码跑起来」,不是「让它停下来」。
 * 旧值同样是 `permissionGuard: 'safe'` + `autoExecute: true`。
 */

import { z } from 'zod'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { JsonObject } from '@onething/core'
import { CapabilityTool, defineInput, SELF_EVOLUTION_SKILL_NAME } from '@onething/runtime/toolkit'
import { dumpFeatures, hasFeature } from '../../features/index.js'
import type { FeatureToolRuntime } from './feature-runtime.js'

export const FeatureUnmountInputSchema = z.object({
  id: z.string().describe('Feature id to unmount. Only features mounted via feature_mount can be unmounted.'),
})

export const FEATURE_UNMOUNT_DESCRIPTION = [
  'Unmount a feature that feature_mount put in place. Every registration it made is unwound in reverse order.',
  'Built-in features (the ones shipped with the app) cannot be unmounted — only what you mounted in this session.',
].join('\n')

const FeatureUnmountContract = defineInput(FeatureUnmountInputSchema)

export type FeatureUnmountInput = z.infer<typeof FeatureUnmountInputSchema>

export class FeatureUnmountTool extends CapabilityTool<FeatureUnmountInput> {
  protected readonly requiredSkill = SELF_EVOLUTION_SKILL_NAME
  private readonly runtime: FeatureToolRuntime

  readonly spec: ToolSpec = {
    id: 'feature_unmount',
    title: 'FeatureUnmount',
    description: FEATURE_UNMOUNT_DESCRIPTION,
    input: FeatureUnmountContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(runtime: FeatureToolRuntime) {
    super()
    this.runtime = runtime
  }

  protected async perform(input: FeatureUnmountInput, ctx: RunContext): Promise<Result> {
    const record = this.runtime.dynamic.get(input.id)
    if (!record) {
      if (hasFeature(input.id)) {
        return this.done(
          ctx,
          `不能卸载:${input.id}`,
          [
            `${JSON.stringify(input.id)} 是**内置** feature(随应用一起构建、随装配序列挂载),不归 feature_unmount 管。`,
            '内置功能的开关是产品决定,不是一次会话里的临时动作 —— 卸掉它会让别的东西当场少一块。',
            '',
            '可以卸载的(本会话挂进来的):',
            this.runtime.describeDynamic(),
          ].join('\n'),
          { featureId: input.id, mounted: true },
        )
      }
      return this.done(
        ctx,
        `无需卸载:${input.id}`,
        [
          `没有名为 ${JSON.stringify(input.id)} 的动态 feature —— 它没挂过,或者已经卸过了(重复卸载不是错误)。`,
          '',
          '当前动态挂载的:',
          this.runtime.describeDynamic(),
          '',
          '下一步:feature_inspect() 看全景(含内置、动态、以及 features-dev 里可挂而未挂的候选)。',
        ].join('\n'),
        { featureId: input.id, mounted: false },
      )
    }

    const dump = dumpFeatures().find(item => item.id === input.id)
    this.runtime.dynamic.delete(input.id)
    try {
      await record.unmount()
    } catch (error) {
      return this.done(
        ctx,
        `卸载时有项失败:${input.id}`,
        [
          `${JSON.stringify(input.id)} 已从挂载表移除,但解绕过程中有注册项抛错:`,
          error instanceof Error ? error.message : String(error),
          '',
          '解绕**不会因为一项失败就停下**(半解绕比全解绕危险),所以其余项都跑完了。',
          '下一步:feature_inspect() 复核 —— 若 fiber 的 effect 树里还留着这个 feature 的标签,说明有副作用没撤干净,',
          '那是这个 feature 的 mount() 里少配了 disposer,改完重挂即可。',
        ].join('\n'),
        { featureId: input.id, mounted: false },
      )
    }

    const released = dump
      ? `释放:rpcDomain ${dump.registrations.rpcDomain}${dump.rpcDomains.length ? ` (${dump.rpcDomains.join(', ')})` : ''}、disposer ${dump.registrations.disposer}`
      : '释放:(挂载前的账本已不可查)'
    return this.done(
      ctx,
      `已卸载:${input.id}`,
      [
        `feature ${JSON.stringify(input.id)} 已卸载,它的注册项按逆序全部解绕。`,
        released,
        '',
        `下一步:改完代码直接 feature_mount({ id: ${JSON.stringify(input.id)} }) 即可重新挂上 —— 会重新读盘。`,
      ].join('\n'),
      { featureId: input.id, entry: record.entry, mounted: false },
    )
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createFeatureUnmountTool(runtime: FeatureToolRuntime): FeatureUnmountTool {
  return new FeatureUnmountTool(runtime)
}
