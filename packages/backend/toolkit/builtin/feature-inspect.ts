/**
 * R3a 移植 —— `feature_inspect`。§4 的 `CapabilityTool` 一族。
 *
 * 描述与全部输出行(含恒定附上的契约与起步模板)逐字沿用旧
 * `app/features/builtin/self-evolution.ts`。**无效果**:纯读。
 */

import { z } from 'zod'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { JsonObject } from '@onething/core'
import { CapabilityTool, defineInput, SELF_EVOLUTION_SKILL_NAME } from '@onething/runtime/toolkit'
import { dumpFeatureEffects, dumpFeatures } from '../../features/index.js'
import {
  DEFAULT_ENTRY_FILENAME,
  listCandidates,
  minimalTemplate,
  type FeatureToolRuntime,
} from './feature-runtime.js'

export const FeatureInspectInputSchema = z.object({})

export const FEATURE_INSPECT_DESCRIPTION = [
  'List every mounted feature: its registrations, its live cordis effect labels, and whether it is built-in or was mounted in this session.',
  'Also lists what sits in <store>/features-dev/ that could be mounted but is not.',
].join('\n')

const FeatureInspectContract = defineInput(FeatureInspectInputSchema)

export type FeatureInspectInput = z.infer<typeof FeatureInspectInputSchema>

export class FeatureInspectTool extends CapabilityTool<FeatureInspectInput> {
  protected readonly requiredSkill = SELF_EVOLUTION_SKILL_NAME
  private readonly runtime: FeatureToolRuntime

  readonly spec: ToolSpec = {
    id: 'feature_inspect',
    title: 'FeatureInspect',
    description: FEATURE_INSPECT_DESCRIPTION,
    input: FeatureInspectContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'parallel',
  }

  constructor(runtime: FeatureToolRuntime) {
    super()
    this.runtime = runtime
  }

  protected async perform(_input: FeatureInspectInput, ctx: RunContext): Promise<Result> {
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
      const record = this.runtime.dynamic.get(dump.id)
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

    // 契约与起步模板恒定附上:inspect 是模型的第一跳,得让它看完就能动手。
    lines.push('')
    lines.push('契约与起步:')
    lines.push(`  - 新建 feature = 在 ${root}/<id>/ 下写 ${DEFAULT_ENTRY_FILENAME}(目录用文件工具创建,本工具不代建),然后 feature_mount({ id })。`)
    lines.push('  - 模块默认导出 { id, mount(ctx) };ctx.registerRpcDomain(router, handlers) / ctx.registerDisposer(fn) 都返回 disposer。')
    lines.push('  - 当前边界:feature 只能加后端能力(RPC 域、用 disposer 持有的资源);**改 UI(样式/面板/组件)与注册新工具暂不可用**。')
    lines.push('  - 起步模板(把 <id> 换掉即可):')
    for (const line of minimalTemplate('<id>').split('\n')) lines.push(`      ${line}`)

    const details: JsonObject = {
      mounted: dumps.length,
      dynamic: this.runtime.dynamic.size,
      candidates: candidates.length,
    }
    const title = `feature 全景:${dumps.length} 挂载 / ${this.runtime.dynamic.size} 动态 / ${candidates.length} 候选`
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: lines.join('\n') }], details }
  }
}

export function createFeatureInspectTool(runtime: FeatureToolRuntime): FeatureInspectTool {
  return new FeatureInspectTool(runtime)
}
