/**
 * K3-a —— 资源工具进工具目录的那条对账(`wiring/resource/catalog-sync.ts`;
 * `docs/design/atom-2026-09.md` §4「AI 工具」、§10.4 第三行)。
 *
 * 它跑的是一台**真** `ResourceKernel` + 一档**真** `Catalog`,但不起整只 backend:
 * 这里要证的四句话全都只关乎「注册表 ↔ 目录」这一对,起装配只会把它们淹在别的
 * 噪音里(真装配那一层的门在 `packages/backend/__tests__/resource-kernel.test.ts`)。
 *
 *   ① mount 之后那只工具在目录里,元工具 `resources` 一开局就在;
 *   ② unmount 之后它**不在**目录里 —— 这一条就是反证①:拆掉对账里的 unregister,
 *      这里第一个红;
 *   ③ 关掉对账(装配层的 `own()`)之后,登记过的那一批全摘干净,而**内核已经空了**
 *      也照样摘得干净(K1 踩过的那个坑:关机链上内核先 dispose,再按当下的表摘就
 *      摘了个空);
 *   ④ 「先注销再登记」的重挂(同一个 scheme 换一份自述)在目录里是那份**新**自述。
 *
 * K3-a' 加第五句:⑤ `readonly` 档一只都不给(那一档的契约是零本地副作用工具)。
 *
 * K5-a 加第六句:⑥ 自述里写了 `exposure.aiTool: false` 的那一份**不进目录**,而它
 * 仍然在注册表里 —— 判据读的是表(自述那一格),不是这只文件里的一张名单。
 */

import { describe, expect, it } from 'vitest'
import { Catalog } from '@onething/core/toolkit'
import { ResourceKernel, ResourceRegistry, type ResourceProvider, type ResourceSpec } from '@onething/core/resource'
import { ToolRunner } from '@onething/core/toolkit'
import { Intent } from '@onething/core/toolkit'
import type { Result } from '@onething/core/toolkit'
import { syncResourceToolsIntoCatalog } from '../catalog-sync.js'

/** 一个 core 与装配层都没听说过的命名空间。它只活在这只文件里。 */
const SCHEME = 'gadget'

function gadgetSpec(title = 'Gadgets'): ResourceSpec {
  return {
    scheme: SCHEME,
    title,
    reads: { get: { title: 'Read one', query: { type: 'object' }, result: { type: 'object' } } },
    ops: {
      poke: { title: 'Poke it', params: { type: 'object' }, effects: [], home: 'core' },
    },
    events: {},
  }
}

function gadgetProvider(spec: ResourceSpec = gadgetSpec()): ResourceProvider<undefined> {
  return {
    spec,
    async plan(): Promise<Intent<undefined>> {
      return Intent.none(undefined)
    },
    async apply(): Promise<Result> {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async read(): Promise<unknown> {
      return {}
    },
  }
}

function makeKernel(): ResourceKernel {
  const runner = new ToolRunner({
    authorizer: { async decide() { return { kind: 'allow' as const } } },
    observer: { on: () => {} },
    validator: { parse: <T>(_schema: unknown, input: unknown) => ({ ok: true as const, value: input as T }) },
  })
  return new ResourceKernel(new ResourceRegistry(), runner)
}

function ids(catalog: Catalog): string[] {
  return catalog.all().map(tool => tool.spec.id).sort()
}

describe('资源工具与工具目录的对账(K3-a)', () => {
  it('元工具一开局就在;mount 之后那只工具进目录', async () => {
    const kernel = makeKernel()
    const catalog = new Catalog()
    const stop = syncResourceToolsIntoCatalog(kernel, catalog)
    expect(ids(catalog)).toEqual(['resources'])

    kernel.mount(gadgetProvider())
    // 注册表的通知发生在内核写内部表**之前**,所以对账排在一个微任务上。
    await Promise.resolve()
    expect(ids(catalog)).toEqual(['gadget', 'resources'])
    expect(catalog.get(SCHEME)?.spec.title).toBe('Gadgets')
    stop()
  })

  it('unmount 之后它不在目录里(反证①咬的就是这一句)', async () => {
    const kernel = makeKernel()
    const catalog = new Catalog()
    const stop = syncResourceToolsIntoCatalog(kernel, catalog)

    const dispose = kernel.mount(gadgetProvider())
    await Promise.resolve()
    expect(catalog.has(SCHEME)).toBe(true)

    await dispose()
    await Promise.resolve()
    expect(catalog.has(SCHEME)).toBe(false)
    expect(ids(catalog)).toEqual(['resources'])
    stop()
  })

  it('重挂(先注销再登记)在目录里是那份新自述,而且只对账一次', async () => {
    const kernel = makeKernel()
    const catalog = new Catalog()
    const stop = syncResourceToolsIntoCatalog(kernel, catalog)

    const dispose = kernel.mount(gadgetProvider())
    await Promise.resolve()
    await dispose()
    kernel.mount(gadgetProvider(gadgetSpec('Gadgets v2')))
    await Promise.resolve()

    expect(ids(catalog)).toEqual(['gadget', 'resources'])
    expect(catalog.get(SCHEME)?.spec.title).toBe('Gadgets v2')
    stop()
  })

  /**
   * K3-a' —— `readonly` 档一只都不给(那一档的契约是零本地副作用工具,而资源工具
   * 带写面)。`headless` 照给,同一段代码同一台内核,只差递进去的那一档。
   *
   * 这是反证②的落点:拆掉对账里那句 `tier === 'readonly'`,第一句当场红。
   */
  it("readonly 档一只资源工具都不进目录,headless 档照给", async () => {
    const kernel = makeKernel()

    const readonlyCatalog = new Catalog()
    const stopReadonly = syncResourceToolsIntoCatalog(kernel, readonlyCatalog, { tier: 'readonly' })
    kernel.mount(gadgetProvider())
    await Promise.resolve()
    // 元工具也不给:「资源这一族」在这一档整族缺席,不是缺了带写面的那几只。
    expect(ids(readonlyCatalog)).toEqual([])
    stopReadonly()

    const headlessCatalog = new Catalog()
    const stopHeadless = syncResourceToolsIntoCatalog(kernel, headlessCatalog, { tier: 'headless' })
    await Promise.resolve()
    expect(ids(headlessCatalog)).toEqual(['gadget', 'resources'])
    stopHeadless()
  })

  it('关掉对账:登记过的全摘掉 —— 即使内核已经先一步空了', async () => {
    const kernel = makeKernel()
    const catalog = new Catalog()
    const stop = syncResourceToolsIntoCatalog(kernel, catalog)
    kernel.mount(gadgetProvider())
    await Promise.resolve()
    expect(ids(catalog)).toEqual(['gadget', 'resources'])

    // 关机链上的次序:内核先 dispose(注册表空了),再轮到这条对账被摘。
    await kernel.dispose()
    stop()
    expect(ids(catalog)).toEqual([])

    // 退订之后注册表再动一次,目录不该跟着长回来。
    kernel.registry.register(gadgetSpec())
    await Promise.resolve()
    expect(ids(catalog)).toEqual([])
  })

  /**
   * K5-a —— 一份自述可以说「模型面不要我」。
   *
   * 反证①(拆掉 `exposure.aiTool` 的判据)咬的就是第一条:那一只会出现在目录里。
   */
  describe('exposure.aiTool(K5-a)', () => {
    it('声明 false 的不进目录,但注册表里有它', async () => {
      const kernel = makeKernel()
      const catalog = new Catalog()
      const stop = syncResourceToolsIntoCatalog(kernel, catalog)

      kernel.mount(gadgetProvider({ ...gadgetSpec(), exposure: { aiTool: false } }))
      await Promise.resolve()

      // 目录里只有元工具 —— 模型看不见这一 scheme 的专属工具。
      expect(ids(catalog)).toEqual(['resources'])
      // 但它确实是一种资源:注册表里在,于是 `resources` 元工具的 list 照列它,
      // RPC / CLI / 内核的 do 照旧。
      expect(kernel.registry.list().map(spec => spec.scheme)).toEqual([SCHEME])
      expect(kernel.toolFor(SCHEME)).toBeDefined()

      stop()
    })

    it('缺席与显式 true 都进目录', async () => {
      const kernel = makeKernel()
      const catalog = new Catalog()
      const stop = syncResourceToolsIntoCatalog(kernel, catalog)

      kernel.mount(gadgetProvider({ ...gadgetSpec(), exposure: { aiTool: true } }))
      await Promise.resolve()
      expect(ids(catalog)).toEqual(['gadget', 'resources'])

      stop()
    })

    it('元工具的 list 里有它 —— 不进目录不等于藏起来', async () => {
      const kernel = makeKernel()
      const catalog = new Catalog()
      const stop = syncResourceToolsIntoCatalog(kernel, catalog)
      kernel.mount(gadgetProvider({ ...gadgetSpec(), exposure: { aiTool: false } }))
      await Promise.resolve()

      const meta = catalog.get('resources')!
      const outcome = await meta.apply(
        await meta.plan({ list: true } as never, {} as never),
        { emit: () => {} } as never,
      )
      const text = outcome.content.map(part => part.text ?? '').join('\n')
      expect(text).toContain(SCHEME)

      stop()
    })
  })
})
