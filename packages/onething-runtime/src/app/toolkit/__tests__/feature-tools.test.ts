/**
 * `feature_mount` / `feature_unmount` / `feature_inspect` 的行为金标。
 *
 * R3a 时这里是对拍:旧实现建在 `app/features/builtin/self-evolution.ts` 的
 * `mountSelfEvolution` 闭包里(三个 `Tool.define` 共享一张挂载表),测试先把那个
 * feature 挂起来、把三个旧 Tool 对象收下来再逐条比。R4b 把那半边删了,于是每一条
 * 换成快照 —— 快照里记的就是当时那份旧行为(删除前对拍是绿的)。
 *
 * 文本里的 feature id 与 store 根都会被归一化,否则快照签不下来。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'onething-feature-tools-'))
process.env.ONETHING_STORE_PATH = STORE

import { FeatureToolRuntime } from '../catalog.js'
import { createFeatureInspectTool } from '../builtin/feature-inspect.js'
import { createFeatureMountTool } from '../builtin/feature-mount.js'
import { createFeatureUnmountTool } from '../builtin/feature-unmount.js'
import { SELF_EVOLUTION_SKILL_NAME } from '@onething/runtime/toolkit'
import { annotationsOf, modelTextOf, redactText, runNewTool } from '../../../toolkit/__tests__/support.js'

const FEATURES_DEV = join(STORE, 'features-dev')

function writeFeature(id: string): void {
  const dir = join(FEATURES_DEV, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'feature.mjs'), `export default { id: '${id}', mount(ctx) { ctx.registerDisposer(() => {}) } }\n`, 'utf-8')
}

const runtime = new FeatureToolRuntime()

/** 快照归一:store 根 + feature id 都会变。 */
const norm = (text: string) =>
  redactText(text, STORE).replaceAll('demo-new', '<id>').replace(/ {2}- demo-\S+/g, '  - <id>')

describe('golden: feature_mount', () => {
  it('spec 钉住', () => {
    const tool = createFeatureMountTool(runtime)
    expect(tool.spec.description).toMatchSnapshot('description')
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
    it(`模型文本与渲染信息钉住:${fixture.name}`, async () => {
      const run = await runNewTool(createFeatureMountTool(runtime), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
      expect(norm(annotationsOf(run).at(-1)?.title ?? '')).toMatchSnapshot('title')
    })
  }

  it('边界:目录在但入口文件不在', async () => {
    mkdirSync(join(FEATURES_DEV, 'empty-dir'), { recursive: true })
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'empty-dir' })
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
  })

  it('错误:模块声明的 id 与调用的 id 对不上', async () => {
    const dir = join(FEATURES_DEV, 'id-mismatch')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'feature.mjs'), "export default { id: 'other', mount() {} }\n", 'utf-8')
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'id-mismatch' })
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
  })

  it('权限输入:一条 capability_change + 一份预览(资源是要执行的那个文件)', async () => {
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-x' })
    expect(run.intent.effects.map(effect => effect.kind)).toEqual(['capability_change'])
    expect(run.intent.effects[0]?.barrier).toBe(true)
    expect(run.intent.effects[0]?.resources[0]).toBe(join(FEATURES_DEV, 'demo-x', 'feature.mjs'))
    expect(run.intent.preview?.title).toContain('挂载 feature「demo-x」')
  })

  it('正常:真的挂上', async () => {
    writeFeature('demo-new')
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-new' })
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
  })

  it('边界:同一个 id 挂两次被拒绝(挂载表不做后来者覆盖)', async () => {
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-new' })
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createFeatureMountTool(runtime), { id: 'demo-x' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

describe('golden: feature_unmount', () => {
  it('spec 钉住,且无效果(卸载不跑模型的代码)', () => {
    const tool = createFeatureUnmountTool(runtime)
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.effects).toEqual([])
  })

  it('边界:没挂过的 id(重复卸载不是错误)', async () => {
    const run = await runNewTool(createFeatureUnmountTool(runtime), { id: 'never-mounted' })
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
  })

  it('边界:内置 feature 不归它管', async () => {
    const run = await runNewTool(createFeatureUnmountTool(runtime), { id: 'self-evolution' })
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
  })

  it('正常:卸载掉刚挂上的那个', async () => {
    const run = await runNewTool(createFeatureUnmountTool(runtime), { id: 'demo-new' })
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
    expect(runtime.dynamic.size).toBe(0)
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createFeatureUnmountTool(runtime), { id: 'x' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

describe('golden: feature_inspect', () => {
  it('spec 钉住,且无效果(纯读)', () => {
    const tool = createFeatureInspectTool(runtime)
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.effects).toEqual([])
    expect(tool.spec.concurrency).toBe('parallel')
  })

  it('正常:全景文本钉住(已卸干净,动态计数为 0)', async () => {
    const run = await runNewTool(createFeatureInspectTool(runtime), {})
    expect(norm(modelTextOf(run.outcome))).toMatchSnapshot('model text')
    expect(norm(annotationsOf(run).at(-1)?.title ?? '')).toMatchSnapshot('title')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createFeatureInspectTool(runtime), {}, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})
