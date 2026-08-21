/**
 * 「生效 AI 设置」的换源(C2)—— 合成 / 拆分 / 按会话取空间。
 *
 * 这一片是整条改造的**接缝测试**:`settings.ai` 不再是全局一份,而是
 * 「当前空间的 `providers.json` + 全局目录缓存」合成出来的。整棵消费者树
 * (引擎解析链、设置页、模型选择器)一个字没改就变成 per-space,靠的就是这里。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeRoot: '',
  sessions: new Map<string, { workspaceId?: string }>(),
}))

// 只覆盖两条取路径的口子,其余原样透传 —— `space-credentials` 那条链上还有
// 别的路径函数(会话目录等),整份替换会在动态 import 时炸成「没有这个导出」。
vi.mock('@onething/runtime/storage', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOnethingStorePath: () => mocks.storeRoot,
  getOnethingSettingsPath: () => path.join(mocks.storeRoot, 'settings.json'),
}))

vi.mock('../../stores/sessions.js', async () => {
  const { DEFAULT_SPACE_ID, isValidSpaceId } = await import('@onething/runtime/spaces/types')
  return {
    resolveSessionSpaceId: (id: string | undefined | null) => {
      const workspaceId = id ? mocks.sessions.get(id)?.workspaceId : undefined
      return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_SPACE_ID
    },
  }
})

import {
  composeEffectiveAISettings,
  splitEffectiveAISettings,
} from '@shared/defaults/ai-settings.js'
import { setRootDirForTests } from '@onething/runtime/spaces/persistence'
import {
  readSpaceProviderSettings,
  resetSpaceProviderSettingsCacheForTests,
  writeSpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import {
  getPersistedSettings,
  getSpaceSettings,
  initializeSettings,
  invalidateSettingsCache,
  saveSettings,
} from '../../stores/settings.js'
import { getSessionSettings } from '../space-ai-settings.js'

let tmpDir: string
let previousStorePath: string | undefined

function writeSettingsFile(value: unknown): void {
  fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(value, null, 2), 'utf-8')
  invalidateSettingsCache()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-space-ai-'))
  previousStorePath = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = tmpDir
  mocks.storeRoot = tmpDir
  mocks.sessions.clear()
  setRootDirForTests(path.join(tmpDir, 'workspaces'))
  resetSpaceProviderSettingsCacheForTests()
  writeSettingsFile({
    ai: {
      temperature: 0.5,
      modelCatalog: {
        deepseek: { models: { 'deepseek-chat': { id: 'deepseek-chat' } }, modelsLastFetched: 7 },
      },
    },
    storage: { spaceProviderSettingsMigratedAt: 1000 },
  })
  await initializeSettings()
})

afterEach(() => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  setRootDirForTests(null)
  resetSpaceProviderSettingsCacheForTests()
  invalidateSettingsCache()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('合成', () => {
  it('空间设置 + 全局目录缓存 → 生效形状', () => {
    const ai = composeEffectiveAISettings(
      { temperature: 0.5, modelCatalog: { deepseek: { models: { m: { id: 'm' } as never } } } },
      {
        provider: 'deepseek',
        providers: { deepseek: { model: 'm', selectedModels: ['m'], enabled: true } },
        customProviders: [],
      } as never,
    )
    expect(ai.provider).toBe('deepseek')
    expect(ai.temperature).toBe(0.5)
    expect(ai.providers.deepseek).toMatchObject({
      model: 'm',
      selectedModels: ['m'],
      enabled: true,
      models: { m: { id: 'm' } },
    })
  })

  it('目录里认识但空间没配过的 provider 补的是**全灭壳** —— 空白空间不该全亮', () => {
    const ai = composeEffectiveAISettings(
      { modelCatalog: { zhipu: { models: { 'glm-5': { id: 'glm-5' } as never } } } },
      { provider: '', providers: {}, customProviders: [] } as never,
    )
    expect(ai.providers.zhipu).toMatchObject({ enabled: false, model: '', selectedModels: [] })
    // 目录缓存仍然拿得到 —— 否则新配一个 provider 时模型列表是空的。
    expect(ai.providers.zhipu.models).toEqual({ 'glm-5': { id: 'glm-5' } })
  })
})

describe('拆分', () => {
  it('目录缓存归全局、其余归空间;全灭壳被摘掉(「没表达过」≠「表达成关」)', () => {
    const { global, space } = splitEffectiveAISettings({
      provider: 'deepseek',
      temperature: 0.3,
      modelCatalog: {},
      providers: {
        deepseek: {
          model: 'm',
          selectedModels: ['m'],
          apiKey: 'sk-secret',
          models: { m: { id: 'm' } },
          modelsLastFetched: 9,
        },
        // 目录里认识、空间没表达过的那条壳。
        zhipu: { model: '', selectedModels: [], enabled: false },
      },
      customProviders: [{ id: 'custom-a', name: 'A', apiKey: 'sk-a' } as never],
    } as never)

    expect(global.temperature).toBe(0.3)
    expect(global.modelCatalog).toEqual({
      deepseek: { models: { m: { id: 'm' } }, modelsLastFetched: 9 },
    })
    expect(space.providers.zhipu).toBeUndefined()
    expect(space.providers.deepseek).toEqual({ model: 'm', selectedModels: ['m'] })
    expect(space.customProviders).toEqual([{ id: 'custom-a', name: 'A' }])
  })
})

describe('getSpaceSettings / getSessionSettings', () => {
  beforeEach(() => {
    writeSpaceProviderSettings('default', {
      provider: 'deepseek',
      providers: { deepseek: { model: 'deepseek-chat', selectedModels: ['deepseek-chat'], enabled: true } },
      customProviders: [],
    })
    writeSpaceProviderSettings('work', {
      provider: 'custom-a',
      providers: { 'custom-a': { model: 'a-pro', selectedModels: ['a-pro'], enabled: true } },
      customProviders: [{ id: 'custom-a', name: 'A 家', apiType: 'openai' }],
    })
  })

  it('两个空间读出两套完整设置,互不牵动', () => {
    const defaults = getSpaceSettings('default')
    const work = getSpaceSettings('work')

    expect(defaults.ai.provider).toBe('deepseek')
    expect(defaults.ai.providers['custom-a']).toBeUndefined()
    expect(defaults.ai.customProviders).toEqual([])

    expect(work.ai.provider).toBe('custom-a')
    expect(work.ai.providers.deepseek).toMatchObject({ enabled: false })
    expect(work.ai.customProviders).toEqual([{ id: 'custom-a', name: 'A 家', apiType: 'openai' }])
  })

  it('目录缓存全空间共享(缓存不是设置)', () => {
    expect(getSpaceSettings('default').ai.providers.deepseek.models).toBeTruthy()
    expect(getSpaceSettings('work').ai.providers.deepseek.models).toBeTruthy()
  })

  it('引擎侧:会话 → 归属空间 → 那个空间的整套设置;缺 workspaceId 落 default', () => {
    mocks.sessions.set('s-work', { workspaceId: 'work' })
    mocks.sessions.set('s-legacy', {})
    expect(getSessionSettings('s-work').ai.provider).toBe('custom-a')
    expect(getSessionSettings('s-legacy').ai.provider).toBe('deepseek')
    expect(getSessionSettings(undefined).ai.provider).toBe('deepseek')
  })

  it('迁移之后的空白空间就是空的(**不回落**)', () => {
    expect(getSpaceSettings('blank').ai.provider).toBe('')
    // 目录里认识的那些只有全灭壳,一个都没开。
    for (const config of Object.values(getSpaceSettings('blank').ai.providers)) {
      expect(config.enabled).toBe(false)
    }
  })
})

describe('saveSettings 的拆分落盘', () => {
  beforeEach(() => {
    writeSpaceProviderSettings('default', {
      provider: 'deepseek',
      providers: { deepseek: { model: 'deepseek-chat', selectedModels: ['deepseek-chat'], enabled: true } },
      customProviders: [],
    })
    writeSpaceProviderSettings('work', {
      provider: 'custom-a',
      providers: { 'custom-a': { model: 'a-pro', selectedModels: ['a-pro'], enabled: true } },
      customProviders: [{ id: 'custom-a', name: 'A 家', apiType: 'openai' }],
    })
  })

  it('per-space 那一半写进指定空间,settings.json 只留目录缓存', () => {
    const next = getSpaceSettings('work')
    next.ai.provider = 'zhipu'
    next.ai.providers.zhipu = { model: 'glm-5', selectedModels: ['glm-5'], enabled: true }
    saveSettings(next, { spaceId: 'work' })
    resetSpaceProviderSettingsCacheForTests()

    expect(readSpaceProviderSettings('work')?.provider).toBe('zhipu')
    // default 空间一个字节都没动。
    expect(readSpaceProviderSettings('default')?.provider).toBe('deepseek')

    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf-8'))
    expect(persisted.ai.providers).toBeUndefined()
    expect(persisted.ai.provider).toBeUndefined()
    expect(persisted.ai.modelCatalog.deepseek.modelsLastFetched).toBe(7)
  })

  it('只给全局那一半(`ai.providers` 缺席)时不碰空间文件', () => {
    const persisted = getPersistedSettings()
    saveSettings({
      ...persisted,
      ai: { temperature: 0.9, modelCatalog: persisted.ai.modelCatalog },
    } as never)
    resetSpaceProviderSettingsCacheForTests()
    // 少了这条守卫,一次「只保存全局」的写会把 default 空间整份清空。
    expect(readSpaceProviderSettings('default')?.provider).toBe('deepseek')
  })

  it('迁移标记不在 = 不拆(旧字段还等着被搬走)', () => {
    writeSettingsFile({
      ai: { provider: 'deepseek', temperature: 0.7, providers: { deepseek: { apiKey: 'sk-x' } } },
    })
    const persisted = getPersistedSettings()
    saveSettings(persisted)
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf-8'))
    expect(raw.ai.providers.deepseek.apiKey).toBe('sk-x')
  })
})

describe('未迁移的机器', () => {
  it('标记不在且空间没有 providers.json → 原样返回旧形状(那不是回落,是还没迁)', () => {
    writeSettingsFile({
      ai: { provider: 'zhipu', temperature: 0.7, providers: { zhipu: { model: 'glm-5' } } },
    })
    resetSpaceProviderSettingsCacheForTests()
    expect(getSpaceSettings('default').ai.provider).toBe('zhipu')
  })
})

describe('空白空间加第一把 key', () => {
  it('预填首装默认模型表,并顺手钉上默认 provider', async () => {
    const { seedSpaceSelectedModels } = await import('../space-credentials.js')
    // 千问那几家 models.dev 目录里没有(或滞后),首装种子表是唯一来源。
    seedSpaceSelectedModels('blank', 'qwen')
    resetSpaceProviderSettingsCacheForTests()

    const seeded = readSpaceProviderSettings('blank')
    expect(seeded?.provider).toBe('qwen')
    expect(seeded?.providers.qwen.enabled).toBe(true)
    expect((seeded?.providers.qwen.selectedModels as string[]).length).toBeGreaterThan(0)
  })

  it('种子表里没有模型的 provider:照样开着、照样钉默认,只是没得可填', async () => {
    const { seedSpaceSelectedModels } = await import('../space-credentials.js')
    seedSpaceSelectedModels('blank', 'deepseek')
    resetSpaceProviderSettingsCacheForTests()

    const seeded = readSpaceProviderSettings('blank')
    expect(seeded?.provider).toBe('deepseek')
    expect(seeded?.providers.deepseek.enabled).toBe(true)
    expect(seeded?.providers.deepseek.model).toBe('deepseek-chat')
    // 没表达过就是没表达过 —— 不写一个空数组去冒充「用户清空了」。
    expect(seeded?.providers.deepseek.selectedModels).toBeUndefined()
  })

  it('表达成空数组是用户自己清的 —— 一次加 key 不能悄悄填回来', () => {
    writeSpaceProviderSettings('blank', {
      provider: 'zhipu',
      providers: { deepseek: { selectedModels: [] } },
      customProviders: [],
    })
    return import('../space-credentials.js').then(({ seedSpaceSelectedModels }) => {
      seedSpaceSelectedModels('blank', 'deepseek')
      resetSpaceProviderSettingsCacheForTests()
      expect(readSpaceProviderSettings('blank')?.providers.deepseek.selectedModels).toEqual([])
    })
  })
})
