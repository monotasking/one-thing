/**
 * R3a 对拍 —— `feature_mount` / `feature_unmount` / `feature_inspect`。
 *
 * 旧实现建在 `app/features/builtin/self-evolution.ts` 的 `mountSelfEvolution` 闭包
 * 里(三个 `Tool.define` 共享一张挂载表),所以对拍要先把那个 feature 真的挂起来、
 * 把三个旧 Tool 对象收下来 —— `registerTool` 被 mock 成收集器。
 *
 * 成功路径两边各挂一个**不同 id** 的真 feature(同一个 id 挂两次在挂载表里本来就
 * 是被拒绝的),文本比较时把 id 归一化;失败路径五组逐字比。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'onething-feature-tools-'))
process.env.ONETHING_STORE_PATH = STORE

const collected = vi.hoisted(() => ({ tools: new Map<string, { id: string; description: string; execute: (args: unknown, ctx: unknown) => Promise<{ title: string; output: string; metadata: unknown }> }>() }))

vi.mock('../../tools/registry.js', () => ({
  hasTool: () => true,
  registerTool: (tool: { id: string }) => { collected.tools.set(tool.id, tool as never) },
  unregisterTool: () => {},
  toolPromptSource: { name: 'tools', collect: () => [] },
}))

import { FeatureToolRuntime } from '../catalog.js'
import { createFeatureInspectTool } from '../builtin/feature-inspect.js'
import { createFeatureMountTool } from '../builtin/feature-mount.js'
import { createFeatureUnmountTool } from '../builtin/feature-unmount.js'
import { SELF_EVOLUTION_SKILL_NAME } from '@onething/runtime/toolkit'
import { annotationsOf, legacyContext, modelTextOf, runNewTool } from '../../../toolkit/__tests__/support.js'

const FEATURES_DEV = join(STORE, 'features-dev')

function writeFeature(id: string): void {
  const dir = join(FEATURES_DEV, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'feature.mjs'), `export default { id: '${id}', mount(ctx) { ctx.registerDisposer(() => {}) } }\n`, 'utf-8')
}

let legacyTools: typeof collected.tools
let unmountSelfEvolution: (() => Promise<void>) | undefined
const runtime = new FeatureToolRuntime()

beforeAll(async () => {
  const { mountFeature } = await import('../../features/index.js')
  const { selfEvolutionFeature } = await import('../../features/builtin/self-evolution.js')
  unmountSelfEvolution = await mountFeature(selfEvolutionFeature)
  legacyTools = collected.tools
  expect([...legacyTools.keys()].sort()).toEqual(['feature_inspect', 'feature_mount', 'feature_unmount'])
}, 60_000)

afterAll(async () => {
  await unmountSelfEvolution?.()
})

describe('parity: feature_mount', () => {
  it('spec 与旧工具逐字对齐', () => {
    const legacy = legacyTools.get('feature_mount')!
    const tool = createFeatureMountTool(runtime)
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.concurrency).toBe('sequential')
    // 旧 permissionGuard 'permission-gated' 的等价物 —— 一条 never-grantable 的效果。
    expect(tool.spec.effects).toEqual(['capability_change'])
  })

  it('场景门:挂在内置 skill onething-self-evolution 上', () => {
    const tool = createFeatureMountTool(runtime)
    expect(tool.visibleIn({ skills: [SELF_EVOLUTION_SKILL_NAME] })).toBe(true)
    expect(tool.visibleIn({ skills: [] })).toBe(false)
    expect(tool.visibleIn({})).toBe(false)
  })

  const FAILURES: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: '边界:非法 id(含分隔符)', args: { id: 'a/b' } },
    { name: '边界:entryPath 给了但是空的', args: { id: 'demo', entryPath: '   ' } },
    { name: '边界:entryPath 越界', args: { id: 'demo', entryPath: '../other/feature.mjs' } },
    { name: '错误:目录不存在', args: { id: 'never-created' } },
    { name: '错误:内置 id 被占用', args: { id: 'self-evolution' } },
  ]

  for (const fixture of FAILURES) {
    it(`模型文本与渲染信息一致:${fixture.name}`, async () => {
      const legacy = await legacyTools.get('feature_mount')!.execute(fixture.args, legacyContext().ctx)
      const run = await runNewTool(createFeatureMountTool(runtime), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toBe(legacy.output)
      expect(annotationsOf(run).at(-1)?.title).toBe(legacy.title)
    })
  }

  it('边界:目录在但入口文件不在', async () => {
    mkdirSync(join(FEATURES_DEV, 'empty-dir'), { recursive: true })
    const args = { id: 'empty-dir' }
    const legacy = await legacyTools.get('feature_mount')!.execute(args, legacyContext().ctx)
    const run = await runNewTool(createFeatureMountTool(runtime), args)
    expect(modelTextOf(run.outcome)).toBe(legacy.output)
  })

  it('错误:模块声明的 id 与调用的 id 对不上', async () => {
    const dir = join(FEATURES_DEV, 'id-mismatch')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'feature.mjs'), "export default { id: 'other', mount() {} }\n", 'utf-8')
    const args = { id: 'id-mismatch' }
    const legacy = await legacyTools.get('feature_mount')!.execute(args, legacyContext().ctx)
    const run = await runNewTool(createFeatureMountTool(runtime), args)
    expect(modelTextOf(run.outcome)).toBe(legacy.output)
  })

  it('权限输入:一条 capability_change + 一份预览(资源是要执行的那个文件)', async () => {
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-x' })
    expect(run.intent.effects.map(effect => effect.kind)).toEqual(['capability_change'])
    expect(run.intent.effects[0]?.barrier).toBe(true)
    expect(run.intent.effects[0]?.resources[0]).toBe(join(FEATURES_DEV, 'demo-x', 'feature.mjs'))
    expect(run.intent.preview?.title).toContain('挂载 feature「demo-x」')
  })

  it('正常:真的挂上(两边各挂一个 id,文本归一化后逐字相同)', async () => {
    writeFeature('demo-legacy')
    writeFeature('demo-new')
    const legacy = await legacyTools.get('feature_mount')!.execute({ id: 'demo-legacy' }, legacyContext().ctx)
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-new' })
    const normalize = (text: string) => text.replaceAll('demo-legacy', '<id>').replaceAll('demo-new', '<id>')
    expect(normalize(modelTextOf(run.outcome))).toBe(normalize(legacy.output))
  })

  it('边界:同一个 id 挂两次被拒绝(挂载表不做后来者覆盖)', async () => {
    const legacy = await legacyTools.get('feature_mount')!.execute({ id: 'demo-legacy' }, legacyContext().ctx)
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-new' })
    const normalize = (text: string) => text.replaceAll('demo-legacy', '<id>').replaceAll('demo-new', '<id>')
    expect(normalize(modelTextOf(run.outcome))).toBe(normalize(legacy.output))
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-x' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

describe('parity: feature_unmount', () => {
  it('spec 与旧工具逐字对齐,且无效果(卸载不跑模型的代码)', () => {
    const legacy = legacyTools.get('feature_unmount')!
    const tool = createFeatureUnmountTool(runtime)
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.effects).toEqual([])
  })

  it('边界:没挂过的 id(重复卸载不是错误)', async () => {
    const args = { id: 'never-mounted' }
    const legacy = await legacyTools.get('feature_unmount')!.execute(args, legacyContext().ctx)
    const run = await runNewTool(createFeatureUnmountTool(runtime), args)
    const normalize = (text: string) => text.replace(/ {2}- demo-\S+/g, '  - <id>')
    expect(normalize(modelTextOf(run.outcome))).toBe(normalize(legacy.output))
  })

  it('边界:内置 feature 不归它管', async () => {
    const args = { id: 'self-evolution' }
    const legacy = await legacyTools.get('feature_unmount')!.execute(args, legacyContext().ctx)
    const run = await runNewTool(createFeatureUnmountTool(runtime), args)
    const normalize = (text: string) => text.replace(/ {2}- demo-\S+/g, '  - <id>')
    expect(normalize(modelTextOf(run.outcome))).toBe(normalize(legacy.output))
  })

  it('正常:卸载掉刚挂上的那个', async () => {
    const legacy = await legacyTools.get('feature_unmount')!.execute({ id: 'demo-legacy' }, legacyContext().ctx)
    const run = await runNewTool(createFeatureUnmountTool(runtime), { id: 'demo-new' })
    const normalize = (text: string) => text.replaceAll('demo-legacy', '<id>').replaceAll('demo-new', '<id>')
    expect(normalize(modelTextOf(run.outcome))).toBe(normalize(legacy.output))
    expect(runtime.dynamic.size).toBe(0)
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createFeatureUnmountTool(runtime), { id: 'x' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

describe('parity: feature_inspect', () => {
  it('spec 与旧工具逐字对齐,且无效果(纯读)', () => {
    const legacy = legacyTools.get('feature_inspect')!
    const tool = createFeatureInspectTool(runtime)
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.effects).toEqual([])
    expect(tool.spec.concurrency).toBe('parallel')
  })

  it('正常:全景文本逐字相同(两边都已卸干净,动态计数同为 0)', async () => {
    const legacy = await legacyTools.get('feature_inspect')!.execute({}, legacyContext().ctx)
    const run = await runNewTool(createFeatureInspectTool(runtime), {})
    expect(modelTextOf(run.outcome)).toBe(legacy.output)
    expect(annotationsOf(run).at(-1)?.title).toBe(legacy.title)
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createFeatureInspectTool(runtime), {}, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})
