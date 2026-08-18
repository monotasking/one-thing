/**
 * R3a —— 三档目录的**等价测试**(设计文档 §8 R3 的退出判据之一)。
 *
 * 新目录(`app/toolkit/catalog.ts`)与旧三个 barrel
 * (`app/tools/builtin/{index,headless,readonly}.ts`)的 id 集合逐一相等。旧那边把
 * `registerTool` mock 掉收集 id —— 与 `app/tools/builtin/__tests__/tier-registration.test.ts`
 * 同一种做法(那是这张清单今天唯一的护栏)。
 *
 * `feature_*` 不在任何一档里:它们在旧树里也不在那三个 barrel 里(由
 * self-evolution feature 自己注册)。它们的门单独测。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Catalog } from '@onething/core/toolkit'
import {
  createDesktopCatalog,
  createHeadlessCatalog,
  createReadonlyCatalog,
  FeatureToolRuntime,
  registerFeatureTools,
} from '../catalog.js'

const registered = vi.hoisted(() => ({ ids: [] as string[] }))

vi.mock('../../tools/registry.js', () => ({
  registerTool: (tool: { id: string }) => {
    registered.ids.push(tool.id)
  },
  toolPromptSource: { name: 'tools', collect: () => [] },
}))

function idsFrom(register: () => void): string[] {
  registered.ids = []
  register()
  return [...registered.ids].sort()
}

let legacy: { full: () => void; headless: () => void; readonly: () => void }

// 载入旧三档要把整棵旧工具图拖进来(store、collab、web-search…),开销记在这里。
beforeAll(async () => {
  const [full, headless, readonly] = await Promise.all([
    import('../../tools/builtin/index.js'),
    import('../../tools/builtin/headless.js'),
    import('../../tools/builtin/readonly.js'),
  ])
  legacy = {
    full: full.registerBuiltinTools,
    headless: headless.registerHeadlessBuiltinTools,
    readonly: readonly.registerReadonlyBuiltinTools,
  }
}, 60_000)

describe('三档目录与旧 barrel 逐一相等', () => {
  beforeEach(() => {
    registered.ids = []
  })

  it('full', () => {
    expect(createDesktopCatalog().all().map(tool => tool.spec.id).sort()).toEqual(idsFrom(legacy.full))
  })

  it('headless', () => {
    expect(createHeadlessCatalog().all().map(tool => tool.spec.id).sort()).toEqual(idsFrom(legacy.headless))
  })

  it('readonly', () => {
    expect(createReadonlyCatalog().all().map(tool => tool.spec.id).sort()).toEqual(idsFrom(legacy.readonly))
  })

  it('三档之间的包含关系与旧路一致(readonly ⊂ headless ⊂ full)', () => {
    const full = new Set(createDesktopCatalog().all().map(tool => tool.spec.id))
    const headless = createHeadlessCatalog().all().map(tool => tool.spec.id)
    const readonly = createReadonlyCatalog().all().map(tool => tool.spec.id)
    for (const id of headless) expect(full.has(id)).toBe(true)
    for (const id of readonly) expect(headless).toContain(id)
  })
})

describe('registerFeatureTools 的宿主档门', () => {
  it('目录里有 bash 就装三只,并且能整组摘掉', () => {
    const catalog = createDesktopCatalog()
    const before = catalog.size
    const handle = registerFeatureTools(catalog)
    expect(handle.registered).toBe(true)
    expect(catalog.size).toBe(before + 3)
    expect(catalog.has('feature_mount')).toBe(true)
    handle.unregister()
    expect(catalog.size).toBe(before)
    expect(catalog.has('feature_mount')).toBe(false)
  })

  it('headless 档有 bash —— 同样装得上(判据是 bash,不是"是不是桌面")', () => {
    const catalog = createHeadlessCatalog()
    expect(registerFeatureTools(catalog).registered).toBe(true)
  })

  it('readonly 档没有 bash —— 一个字都不注册(默认拒绝)', () => {
    const catalog = createReadonlyCatalog()
    const handle = registerFeatureTools(catalog)
    expect(handle.registered).toBe(false)
    expect(catalog.has('feature_mount')).toBe(false)
    expect(catalog.has('feature_unmount')).toBe(false)
    expect(catalog.has('feature_inspect')).toBe(false)
  })

  it('空目录也拒绝 —— 注册表还没起来时 hasTool("bash") 为 false 的那一格', () => {
    expect(registerFeatureTools(new Catalog(), new FeatureToolRuntime()).registered).toBe(false)
  })
})
