/**
 * 批 B10:**provider 专属旋钮 per-space**。
 *
 * 用户 08-18:「不同的空间,provider 选择、开关、模型选择,都要独立。」
 * B3 把 apiMode / baseUrl 归进了「凭证」那一类(设计文档 §3 归属拆分表),但当年
 * 只做了「entry 有就盖」—— entry 没有那一格时,全局 settings 里的档位原样留在
 * config 上。于是空间 2 的 Kimi 悄悄跟着全局走了海外版,而界面上**既设不了也
 * 看不见**。地区那一格连 schema 都没有。
 *
 * 这份测试钉三件事:
 *  1. `region` 进了 schema,并且和 apiMode 一样落到 provider 自己那一格;
 *  2. 三个非密钥字段是 **patch**(缺席 = 沿用旧值)—— 换一次 key 不该顺手把端点抹掉;
 *  3. **有档位的 provider,端点完全由本空间那条 entry 决定** —— 缺席不是「跟全局」,
 *     缺席是「这家 provider 自己的缺省」。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addSpaceProviderCredentialEntry,
  buildImportedSpaceCredentials,
  getSpaceProviderCredentials,
  parseSpaceCredentialEntry,
  resetSpaceCredentialsCacheForTests,
  upsertSpaceProviderApiKey,
} from '../credentials.js'
import { setRootDirForTests } from '../persistence.js'
import {
  applySpaceProviderCredential,
  resolveSpaceProviderCredential,
} from '../provider-credentials.js'
import { withResolvedProviderBaseUrl } from '../../providers/provider-config.js'
import {
  ONETHING_ZHIPU_CODING_PLAN_BASE_URL,
  ONETHING_ZHIPU_STANDARD_BASE_URL,
} from '../../providers/zhipu.js'
import { ONETHING_KIMI_STANDARD_INTL_BASE_URL } from '../../providers/kimi.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-spaces-dials-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const isOAuthProvider = (id: string): boolean => id === 'codex' || id === 'kimi-code'

function resolveFor(spaceId: string, providerId: string) {
  return resolveSpaceProviderCredential({ spaceId, providerId, isOAuthProvider })
}

describe('entry schema:region', () => {
  it('parses and persists the region alongside the api mode', () => {
    const entry = parseSpaceCredentialEntry({
      id: 'a',
      authType: 'apiKey',
      source: 'user',
      apiKey: 'sk',
      apiMode: 'standard',
      region: 'intl',
    })
    expect(entry?.region).toBe('intl')

    upsertSpaceProviderApiKey('work', 'kimi', {
      apiKey: 'sk-work',
      apiMode: 'standard',
      region: 'intl',
    })
    const stored = getSpaceProviderCredentials('work', 'kimi')?.entries[0]
    expect(stored).toMatchObject({ apiMode: 'standard', region: 'intl' })
  })

  it('drops a blank region rather than storing an empty string', () => {
    upsertSpaceProviderApiKey('work', 'kimi', { apiKey: 'sk', region: '   ' })
    expect(getSpaceProviderCredentials('work', 'kimi')?.entries[0].region).toBeUndefined()
  })

  it('每条 entry 各有一套档位 —— 两把 key 指向两个地区是合法的', () => {
    upsertSpaceProviderApiKey('work', 'kimi', { apiKey: 'sk-cn', region: 'cn' })
    addSpaceProviderCredentialEntry('work', 'kimi', { apiKey: 'sk-intl', region: 'intl' })
    const entries = getSpaceProviderCredentials('work', 'kimi')?.entries ?? []
    expect(entries.map(entry => entry.region)).toEqual(['cn', 'intl'])
  })
})

describe('patch 语义:缺席 = 沿用旧值', () => {
  it('换密钥不会顺手把端点、档位、地区抹掉', () => {
    upsertSpaceProviderApiKey('work', 'kimi', {
      apiKey: 'sk-old',
      baseUrl: 'https://proxy.test/v1',
      apiMode: 'coding-plan',
      region: 'intl',
    })
    const entryId = getSpaceProviderCredentials('work', 'kimi')!.entries[0].id

    // 「换密钥」的表单里只有一格 key —— 旧写法(缺席即清空)会把另外三格清掉。
    upsertSpaceProviderApiKey('work', 'kimi', { apiKey: 'sk-new', entryId })

    expect(getSpaceProviderCredentials('work', 'kimi')?.entries[0]).toMatchObject({
      id: entryId,
      apiKey: 'sk-new',
      baseUrl: 'https://proxy.test/v1',
      apiMode: 'coding-plan',
      region: 'intl',
    })
  })

  it('只改档位:不带 key 也能落盘,密钥原样留着', () => {
    upsertSpaceProviderApiKey('work', 'kimi', { apiKey: 'sk-keep', region: 'cn' })
    const entryId = getSpaceProviderCredentials('work', 'kimi')!.entries[0].id

    upsertSpaceProviderApiKey('work', 'kimi', { entryId, region: 'intl' })

    expect(getSpaceProviderCredentials('work', 'kimi')?.entries[0]).toMatchObject({
      apiKey: 'sk-keep',
      region: 'intl',
    })
  })

  it('空串是「清空」,与「不表达」分得开', () => {
    upsertSpaceProviderApiKey('work', 'kimi', { apiKey: 'sk', baseUrl: 'https://x/v1' })
    const entryId = getSpaceProviderCredentials('work', 'kimi')!.entries[0].id
    upsertSpaceProviderApiKey('work', 'kimi', { entryId, baseUrl: '' })
    expect(getSpaceProviderCredentials('work', 'kimi')?.entries[0].baseUrl).toBeUndefined()
  })
})

describe('覆盖注入 → baseUrl 派生', () => {
  it('zhipu coding-plan:空间那条 entry 的档位派生出 coding 端点', () => {
    upsertSpaceProviderApiKey('work', 'zhipu', { apiKey: 'sk-work', apiMode: 'coding-plan' })
    const scoped = applySpaceProviderCredential(
      // 全局是 standard —— 空间那条说了算。
      { model: 'glm-5', apiKey: 'sk-global', zhipuApiMode: 'standard' as const },
      resolveFor('work', 'zhipu'),
      'zhipu',
    )
    expect(scoped).toMatchObject({ apiKey: 'sk-work', zhipuApiMode: 'coding-plan' })
    // 派生发生在覆盖**之后**(provider-runtime 的顺序),所以端点跟着空间走。
    expect(withResolvedProviderBaseUrl('zhipu', scoped)?.baseUrl)
      .toBe(ONETHING_ZHIPU_CODING_PLAN_BASE_URL)
  })

  it('kimi intl:地区那一格同样贯通到端点', () => {
    upsertSpaceProviderApiKey('work', 'kimi', {
      apiKey: 'sk-work',
      apiMode: 'standard',
      region: 'intl',
    })
    const scoped = applySpaceProviderCredential(
      { model: 'k2', apiKey: 'sk-global', kimiApiMode: 'standard' as const, kimiRegion: 'cn' as const },
      resolveFor('work', 'kimi'),
      'kimi',
    )
    expect(scoped).toMatchObject({ kimiApiMode: 'standard', kimiRegion: 'intl' })
    expect(withResolvedProviderBaseUrl('kimi', scoped)?.baseUrl)
      .toBe(ONETHING_KIMI_STANDARD_INTL_BASE_URL)
    // 不透明包也得跟上 —— provider 工厂读的是它,不是那两个平铺字段。
    expect(withResolvedProviderBaseUrl('kimi', scoped)?.providerOptions)
      .toMatchObject({ kimiApiMode: 'standard', kimiRegion: 'intl' })
  })

  it('**缺席不是「跟全局」**:entry 没表达档位就退回这家 provider 自己的缺省', () => {
    upsertSpaceProviderApiKey('work', 'zhipu', { apiKey: 'sk-work' })
    const scoped = applySpaceProviderCredential(
      // 全局配的是 coding-plan,连 baseUrl 都写死成 coding 地址 ——
      // 两格必须一起清,只清档位的话它会顺着 baseUrl 原路漏回来。
      {
        model: 'glm-5',
        apiKey: 'sk-global',
        zhipuApiMode: 'coding-plan' as const,
        baseUrl: ONETHING_ZHIPU_CODING_PLAN_BASE_URL,
      },
      resolveFor('work', 'zhipu'),
      'zhipu',
    )
    expect((scoped as { zhipuApiMode?: string }).zhipuApiMode).toBeUndefined()
    expect(withResolvedProviderBaseUrl('zhipu', scoped)?.baseUrl)
      .toBe(ONETHING_ZHIPU_STANDARD_BASE_URL)
  })

  it('没有档位的 provider 不在名单里:全局自建代理仍然管用', () => {
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-work' })
    const scoped = applySpaceProviderCredential(
      { model: 'v3', apiKey: 'sk-global', baseUrl: 'https://my-proxy.test/v1' },
      resolveFor('work', 'deepseek'),
      'deepseek',
    )
    expect(scoped).toMatchObject({ apiKey: 'sk-work', baseUrl: 'https://my-proxy.test/v1' })
  })

  it('C1 起 default 也走同一条路:池里那条 entry 的档位说了算', () => {
    upsertSpaceProviderApiKey('default', 'zhipu', { apiKey: 'sk-default', apiMode: 'standard' })
    const config = {
      model: 'glm-5',
      apiKey: 'sk-global',
      zhipuApiMode: 'coding-plan' as const,
      baseUrl: ONETHING_ZHIPU_CODING_PLAN_BASE_URL,
    }
    const scoped = applySpaceProviderCredential(
      config,
      resolveFor('default', 'zhipu'),
      'zhipu',
    ) as Record<string, unknown>
    // 批 B10 的「缺席不是跟全局」对 default 一视同仁:两格一起被 entry 接管。
    expect(scoped.apiKey).toBe('sk-default')
    expect(scoped.zhipuApiMode).toBe('standard')
  })
})

describe('导入快照带上档位', () => {
  it('carries apiMode/region so an imported Kimi does not silently fall back to pay-as-you-go', () => {
    const result = buildImportedSpaceCredentials([
      { providerId: 'kimi', apiKey: 'sk-k', apiMode: 'coding-plan', region: 'intl' },
    ])
    expect(result.file.providers.kimi.entries[0]).toMatchObject({
      apiMode: 'coding-plan',
      region: 'intl',
    })
  })
})
