/**
 * per-space 整套 provider 设置的落盘层(C2)—— `workspaces/<id>/providers.json`。
 *
 * 这一片钉三件事:
 *  1. **凭证与目录缓存永远不进这份文件**(剥在唯一的写入口,不靠调用方自觉);
 *  2. 坏文件的收法(结构不认 = 判废 → 空设置,**不是**退回旧形状);
 *  3. 两个空间彻底互不牵动 —— 那正是用户 08-18 要的「完整、独立的两套」。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setRootDirForTests } from '../persistence.js'
import {
  resetSpaceDataListenersForTests,
  subscribeSpaceDataChanged,
  type SpaceDataChangedEvent,
} from '../notifications.js'
import {
  createEmptySpaceProviderSettings,
  hasSpaceProviderSettings,
  normalizeSpaceProviderSettings,
  parseSpaceProviderSettingsFile,
  readSpaceProviderSettings,
  resetSpaceProviderSettingsCacheForTests,
  spaceProviderSettingsPath,
  stripSpaceProviderConfig,
  writeSpaceProviderSettings,
} from '../provider-settings.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-space-provider-settings-'))
  setRootDirForTests(tmpDir)
  resetSpaceProviderSettingsCacheForTests()
  resetSpaceDataListenersForTests()
})

afterEach(() => {
  setRootDirForTests(null)
  resetSpaceProviderSettingsCacheForTests()
  resetSpaceDataListenersForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('归一', () => {
  it('剥掉凭证与目录缓存 —— 它们各有自己的住址', () => {
    expect(
      stripSpaceProviderConfig({
        model: 'm',
        apiKey: 'sk-x',
        oauthToken: { accessToken: 'a' },
        authType: 'apiKey',
        models: { m: {} },
        modelsLastFetched: 1,
        localAddress: '127.0.0.1',
        contextLengthByModel: { m: 1 },
      }),
    ).toEqual({ model: 'm', contextLengthByModel: { m: 1 } })
  })

  it('字段级脏值丢弃:provider 键 trim、非对象配置丢、customProviders 无 id 丢', () => {
    const normalized = normalizeSpaceProviderSettings({
      provider: '  deepseek  ',
      temperature: 0.4,
      providers: {
        ' zhipu ': { model: 'glm-5' },
        '': { model: 'x' },
        broken: 'not-an-object',
      },
      customProviders: [
        { id: ' custom-a ', name: 'A', apiKey: 'sk-a' },
        { name: '没有 id' },
        { id: 'custom-a', name: '重复的' },
      ],
    })
    expect(normalized.provider).toBe('deepseek')
    expect(normalized.temperature).toBe(0.4)
    expect(Object.keys(normalized.providers)).toEqual(['zhipu'])
    expect(normalized.customProviders).toEqual([{ id: 'custom-a', name: 'A' }])
  })

  it('空白空间的初值:没有默认、没有 provider、没有自定义', () => {
    expect(createEmptySpaceProviderSettings()).toEqual({
      provider: '',
      providers: {},
      customProviders: [],
    })
  })
})

describe('解析与判废', () => {
  it('缺 `ai` 段 = 空设置(留位的一级键还没写过)', () => {
    expect(parseSpaceProviderSettingsFile({})).toEqual({ ai: createEmptySpaceProviderSettings() })
  })

  it('结构不认就整份判废(半份比空的更难排查)', () => {
    expect(parseSpaceProviderSettingsFile(null)).toBeNull()
    expect(parseSpaceProviderSettingsFile({ ai: 'nope' })).toBeNull()
    expect(parseSpaceProviderSettingsFile({ ai: { providers: ['a'] } })).toBeNull()
    expect(parseSpaceProviderSettingsFile({ ai: { customProviders: {} } })).toBeNull()
  })

  it('坏文件按**空设置**收下,不按「这个空间还没有文件」', () => {
    const filePath = spaceProviderSettingsPath('work')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{ not json', 'utf-8')
    // 文件在 = 这个空间已经在新形状里。退回「缺席」会让一个坏字节把整台机器
    // 拖回迁移前的语义(那才是真正危险的降级)。
    expect(readSpaceProviderSettings('work')).toEqual(createEmptySpaceProviderSettings())
    expect(hasSpaceProviderSettings('work')).toBe(true)
  })

  it('文件不在 = `null`(与「空设置」是两件事)', () => {
    expect(readSpaceProviderSettings('work')).toBeNull()
    expect(hasSpaceProviderSettings('work')).toBe(false)
  })
})

describe('落盘', () => {
  it('写 → 读回同形;凭证与目录缓存不落盘', async () => {
    writeSpaceProviderSettings('work', {
      provider: 'deepseek',
      providers: {
        deepseek: {
          model: 'deepseek-chat',
          selectedModels: ['deepseek-chat'],
          enabled: true,
          apiKey: 'sk-secret',
          models: { 'deepseek-chat': {} },
          thinkingByModel: { 'deepseek-chat': true },
        },
      },
      customProviders: [{ id: 'custom-a', name: 'A', apiKey: 'sk-a' }],
    })
    resetSpaceProviderSettingsCacheForTests()

    const raw = fs.readFileSync(spaceProviderSettingsPath('work'), 'utf-8')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain('sk-a')
    expect(JSON.parse(raw)).toEqual({
      ai: {
        provider: 'deepseek',
        providers: {
          deepseek: {
            model: 'deepseek-chat',
            selectedModels: ['deepseek-chat'],
            enabled: true,
            thinkingByModel: { 'deepseek-chat': true },
          },
        },
        customProviders: [{ id: 'custom-a', name: 'A' }],
      },
    })
    expect(readSpaceProviderSettings('work')?.provider).toBe('deepseek')
  })

  it('整层写:漏传 = 清空(与 overlay 同一条口径)', () => {
    writeSpaceProviderSettings('work', {
      provider: 'deepseek',
      providers: { deepseek: { model: 'm' } },
      customProviders: [],
    })
    writeSpaceProviderSettings('work', createEmptySpaceProviderSettings())
    expect(readSpaceProviderSettings('work')).toEqual(createEmptySpaceProviderSettings())
  })

  it('两个空间完整独立 —— A 的自定义 provider / 逐模型覆盖 / 默认在 B 不可见', () => {
    writeSpaceProviderSettings('work', {
      provider: 'custom-a',
      providers: {
        'custom-a': { model: 'a-pro', contextLengthByModel: { 'a-pro': 200000 } },
      },
      customProviders: [{ id: 'custom-a', name: 'A 家', apiType: 'openai' }],
    })
    writeSpaceProviderSettings('study', {
      provider: 'zhipu',
      providers: { zhipu: { model: 'glm-5' } },
      customProviders: [],
    })
    resetSpaceProviderSettingsCacheForTests()

    const study = readSpaceProviderSettings('study')
    expect(study?.provider).toBe('zhipu')
    expect(study?.providers['custom-a']).toBeUndefined()
    expect(study?.customProviders).toEqual([])
    expect(readSpaceProviderSettings('work')?.providers['custom-a'].contextLengthByModel)
      .toEqual({ 'a-pro': 200000 })
  })

  it("落盘之后广播 kind:'providers'(跨窗口缓存过期,批 B9-0 的第三格)", () => {
    const events: SpaceDataChangedEvent[] = []
    subscribeSpaceDataChanged(event => events.push(event))
    writeSpaceProviderSettings('work', createEmptySpaceProviderSettings())
    expect(events).toEqual([{ spaceId: 'work', kind: 'providers' }])
  })

  it('非法 id 一律当 default —— id 是路径片段,不放行任意写入', () => {
    writeSpaceProviderSettings('../escape', createEmptySpaceProviderSettings())
    expect(fs.existsSync(spaceProviderSettingsPath('default'))).toBe(true)
  })
})
