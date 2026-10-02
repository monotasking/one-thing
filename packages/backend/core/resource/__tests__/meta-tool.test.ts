/**
 * K3-a —— 元工具 `resources`(`docs/design/atom-2026-09.md` §4「AI 工具」那一行的
 * 第二半句)。
 *
 * 它要证的三句话:
 *   ① `list` 交出去的是**注册表当下的样子**,而且跟着注册表变 —— 摘掉一种资源之后
 *      它立刻不再列(§10.5 给 K2a 的那条要求,在元工具这一侧的同一句话);
 *   ② `describe` 是那份自述的人话投影:每条做法一行,带效果与参数摘要;
 *   ③ 它零效果 —— `plan` 恒 `Intent.none`,所以永远不会为「问一句有什么」弹卡。
 *
 * 断言一律经 `ToolRunner.run` 观察,理由与 `tool.test.ts` 逐字相同:元工具是一只
 * 普通工具,只有把结局读成 `Outcome` 才算证明了这一点。
 *
 * 词边界那道门(`stranger.test.ts`)扫的是**非测试文件**,所以这只文件里可以出现
 * `demo` 这种名字;`meta-tool.ts` 里一个都不许有。
 */

import { describe, expect, it } from 'vitest'
import { ToolRunner } from '../../toolkit/runner.js'
import { allowAuthorizer, makeInvocation, passthroughValidator, RecordingObserver } from '../../toolkit/__tests__/fakes.js'
import { RESOURCE_META_TOOL_ID, ResourceMetaCallShapeError, ResourceMetaTool } from '../meta-tool.js'
import { ResourceRegistry } from '../registry.js'
import { DEMO_SCHEME, demoSpec } from './fakes.js'

function runner(): ToolRunner {
  return new ToolRunner({
    authorizer: allowAuthorizer,
    observer: new RecordingObserver(),
    validator: passthroughValidator,
  })
}

/** 一次成功调用的文本。不是 `ok` 就把结局的判别键报出来 —— 好让红色说得出所以然。 */
async function call(tool: ResourceMetaTool, input: unknown): Promise<string> {
  const outcome = await runner().run(tool, makeInvocation({ toolId: RESOURCE_META_TOOL_ID, input }))
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`)
  return outcome.result.content[0]?.text ?? ''
}

describe('元工具 resources', () => {
  it('list:一行一个命名空间,带做法 / 读法条数', async () => {
    const registry = new ResourceRegistry()
    const tool = new ResourceMetaTool(registry)
    expect(await call(tool, { list: true })).toBe('No namespaces are available right now.')

    registry.register(demoSpec())
    expect(await call(tool, { list: true })).toBe(`${DEMO_SCHEME} — Demo things — 4 ops / 2 reads`)
  })

  it('list 跟着注册表变:摘掉之后立刻不再列它', async () => {
    const registry = new ResourceRegistry()
    const tool = new ResourceMetaTool(registry)
    const dispose = registry.register(demoSpec())
    expect(await call(tool, { list: true })).toContain(DEMO_SCHEME)
    dispose()
    expect(await call(tool, { list: true })).toBe('No namespaces are available right now.')
  })

  it('describe:地址语法 + 每条做法一行(效果与参数摘要都在)', async () => {
    const registry = new ResourceRegistry()
    registry.register(demoSpec())
    const tool = new ResourceMetaTool(registry)

    const text = await call(tool, { describe: DEMO_SCHEME })
    expect(text).toContain(`${DEMO_SCHEME} — Demo things`)
    expect(text).toContain(`Address: ${DEMO_SCHEME}:<path>`)
    // 必填参数打星号,效果如实列(空的说 none),没有参数的说破折号。
    expect(text).toContain('- rename — Rename one thing [effects: none] (title*: string)')
    expect(text).toContain('- wipe — Wipe one thing [effects: file_write] (—)')
    expect(text).toContain('- list — List things (limit: number)')
    expect(text).toContain('- renamed — It was renamed')
  })

  it('describe 一个不存在的命名空间:一句「没有这个」,不是一次失败', async () => {
    const tool = new ResourceMetaTool(new ResourceRegistry())
    const text = await call(tool, { describe: 'nope' })
    expect(text).toContain('There is no namespace named "nope"')
    expect(text).toContain('{"list": true}')
  })

  it('形状不对:结局是失败,而且是它自己那句话', async () => {
    const tool = new ResourceMetaTool(new ResourceRegistry())
    for (const input of [{}, { list: false }, 'nope']) {
      const outcome = await runner().run(tool, makeInvocation({ toolId: RESOURCE_META_TOOL_ID, input }))
      expect(outcome.kind).toBe('failed')
      if (outcome.kind !== 'failed') continue
      expect(outcome.error).toBeInstanceOf(ResourceMetaCallShapeError)
    }
  })

  it('零效果:plan 恒 Intent.none,所以它永远不打扰人', async () => {
    const registry = new ResourceRegistry()
    registry.register(demoSpec())
    const tool = new ResourceMetaTool(registry)
    expect(tool.spec.effects).toEqual([])
    for (const input of [{ list: true }, { describe: DEMO_SCHEME }]) {
      const intent = await tool.plan(input)
      expect(intent.effects).toEqual([])
    }
  })

  it('它与资源工具同族:不进「工具清单」那个出口', () => {
    expect(new ResourceMetaTool(new ResourceRegistry()).spec.projection).toBe('resource')
  })
})
