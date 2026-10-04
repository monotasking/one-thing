/**
 * 三档目录的清单(设计文档 §13.5)。
 *
 * R3a 时这里是**等价测试**:与旧三个 barrel
 * (`app/tools/builtin/{index,headless,readonly}.ts`)的 id 集合逐一相等。R4b 把
 * 那三个 barrel 删了,于是三档各自的 id 清单**写死在这里** —— 同一份答案,只是
 * 判据从"和旧 barrel 一样"变成"就是这一份"。改一档就必须改这张表,那正是它存在
 * 的理由(旧路那张清单也只有这一道护栏)。
 *
 * `feature_*` 不在任何一档里(由 self-evolution feature 自己注册),门单独测。
 */
import { describe, expect, it } from 'vitest'
import { Catalog } from '@onething/backend/toolkit/toolkit-tool-protocol'
import {
  createDesktopCatalog,
  createHeadlessCatalog,
  createReadonlyCatalog,
  FeatureToolRuntime,
  registerFeatureTools,
} from '../toolkit-tier-catalogs.js'
import { registerCollabTools } from '@onething/backend/collab'
// D191:goal / practice / task 三只工具的适配器由装配递进来,夹具用生产同一套工厂。
import { assemblyToolAdapters } from './assembly-adapters.js'

/**
 * 越层清零 A1:协作四只由 collab 自己的 `registerCollabTools(catalog, tier)` 登记,装配里紧跟在
 * `buildToolkitCatalog` 之后。三个 id 集合**一字不改**,改的只是「先登记再比」。
 */
const fullCatalog = () => { const c = createDesktopCatalog(assemblyToolAdapters()); registerCollabTools(c, 'full'); return c }
const headlessCatalog = () => { const c = createHeadlessCatalog(); registerCollabTools(c, 'headless'); return c }
const readonlyCatalog = () => { const c = createReadonlyCatalog(); registerCollabTools(c, 'readonly'); return c }

/**
 * 桌面档(full)。S6 起多一只 `search`(检索重建 §14.3:三档都给);
 * K3-b 起**少一只 `radio`** —— 音乐退成一个资源 scheme(`music`),它的工具是那份
 * 自述的投影,由 `resource/resource-catalog-sync.ts` 按注册表对账进目录,不在这三档
 * 清单里(这里列的是「这一档手写注册了哪几只」)。
 */
const FULL_IDS = [
  'ask_user', 'bash', 'board', 'edit', 'goal', 'history', 'notebook', 'practice',
  'read', 'search', 'send_message', 'task', 'time', 'variable', 'web_open',
  'web_search', 'write',
].sort()

/** 无头档:去掉要人在场 / 要桌面外设的那几只(协作三件套仍在)。 */
const HEADLESS_IDS = [
  'bash', 'board', 'edit', 'history', 'read', 'search', 'send_message', 'time', 'variable',
  'web_open', 'web_search', 'write',
].sort()

/**
 * 只读档(联网 server 的降级形态):零本地副作用。
 *
 * `search` 在这一档里 —— 判据是「对本机零副作用」(`ReadOnlyTool`,`effects: []`),
 * 不是「不读本机数据」;`read` 也在这一档。
 */
const READONLY_IDS = ['read', 'search', 'time', 'web_open', 'web_search'].sort()

describe('三档目录的清单', () => {
  it('full', () => {
    expect(fullCatalog().all().map(tool => tool.spec.id).sort()).toEqual(FULL_IDS)
  })

  it('headless', () => {
    expect(headlessCatalog().all().map(tool => tool.spec.id).sort()).toEqual(HEADLESS_IDS)
  })

  it('readonly', () => {
    expect(readonlyCatalog().all().map(tool => tool.spec.id).sort()).toEqual(READONLY_IDS)
  })

  it('三档之间的包含关系与旧路一致(readonly ⊂ headless ⊂ full)', () => {
    const full = new Set(fullCatalog().all().map(tool => tool.spec.id))
    const headless = headlessCatalog().all().map(tool => tool.spec.id)
    const readonly = readonlyCatalog().all().map(tool => tool.spec.id)
    for (const id of headless) expect(full.has(id)).toBe(true)
    for (const id of readonly) expect(headless).toContain(id)
  })

  /*
   * 目录的插入顺序就是请求里 `tools[]` 的顺序。full 档协作四只本来就排在最后,逐字不变;
   * headless 档的三只从 variable 与 time 之间移到了末尾(决策 D143)。这里把两档的顺序写死。
   */
  it('插入顺序:full 与从前逐字相同,headless 的协作三只排在末尾', () => {
    expect(fullCatalog().all().map(tool => tool.spec.id)).toEqual([
      'bash', 'edit', 'read', 'write', 'variable', 'practice', 'task', 'ask_user', 'time', 'search',
      'web_search', 'web_open', 'goal', 'board', 'history', 'notebook', 'send_message',
    ])
    expect(headlessCatalog().all().map(tool => tool.spec.id)).toEqual([
      'bash', 'edit', 'read', 'write', 'variable', 'time', 'search', 'web_search', 'web_open',
      'board', 'history', 'send_message',
    ])
  })

  it('registerCollabTools 幂等:同一本目录第二次登记什么都不加', () => {
    const catalog = fullCatalog()
    expect(registerCollabTools(catalog, 'full')).toEqual([])
    expect(catalog.size).toBe(17)
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

  it('空目录也拒绝 —— 目录还没装上时 catalog.has("bash") 为 false 的那一格', () => {
    expect(registerFeatureTools(new Catalog(), new FeatureToolRuntime()).registered).toBe(false)
  })
})
