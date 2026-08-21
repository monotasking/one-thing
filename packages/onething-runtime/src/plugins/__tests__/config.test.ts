/**
 * R3 验收(产品层部分):配置存储、写入校验、onChange 软隔离。
 *
 * 裁决要点在这里被钉住:schema 的唯一事实源是 manifest,存储与校验全在宿主 ——
 * 于是**未启用的插件也能配**,整条路径不执行一行插件代码。
 *
 * 纯 schema 归约与取值归一化的用例在隔壁
 * (`config-schema.test.ts`)—— 那半是 manifest → 可渲染控件的归约,这半是存储与生效。
 *
 * P3'c(2026-08-21):存储侧从装配层搬进产品层(`config.ts` / `config-access.ts` /
 * `health.ts` 的闭包除 `getLogger` 外零脊柱边),测试随之过来;日志见证也从装配层的
 * `collectLogRecordsForTests` 换成产品层的 `captureRuntimeLogs`(同一套记录形状,
 * 只是根 logger 换了一本 —— 本测试不跑 `configureLogging()`,两本没有被接到一起)。
 */
import { describe, expect, it, vi } from 'vitest'
import { captureRuntimeLogs } from '../../logging/index.js'
import {
  configurePluginConfigHost,
  describePluginConfig,
  getEffectivePluginConfig,
  getPluginExternalRoot,
  notifyPluginConfigChange,
  pluginDeclaresExternalRootField,
  resetPluginConfigListenersForTests,
  setPluginConfig,
  subscribePluginConfigChange,
} from '../config.js'
import { createPluginConfigAccess } from '../config-access.js'
import {
  configurePluginHealthHost,
  getPluginRuntimeHealth,
  resetPluginRuntimeHealthForTests,
} from '../health.js'

const DEMO_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: true },
    label: { type: 'string', default: 'hi', title: 'Label' },
    retention: { type: 'integer', default: 7, minimum: 1, maximum: 30 },
    mode: { enum: ['fast', 'slow'], default: 'fast' },
    tags: { type: 'array', items: { type: 'string' }, default: [] },
  },
  required: ['label'],
}

function installHost(options: {
  schema?: Record<string, unknown> | undefined
  ui?: Record<string, { label?: string; hint?: string; control?: string }>
  stored?: Record<string, unknown>
} = {}) {
  const disk: Record<string, Record<string, unknown>> = {
    demo: options.stored ?? {},
  }
  configurePluginConfigHost({
    getSettingsContribution: pluginId => (pluginId === 'demo'
      ? { title: 'Demo', schema: options.schema ?? DEMO_SCHEMA, ui: options.ui }
      : undefined),
    readConfig: pluginId => disk[pluginId] ?? {},
    writeConfig: (pluginId, config) => {
      if (config) disk[pluginId] = config
      else delete disk[pluginId]
    },
  })
  return disk
}

describe('R3 store — the host owns storage, not the plugin', () => {
  it('reads an effective config for a plugin that was never loaded', () => {
    installHost({ stored: { label: 'stored' } })
    // 关键红利:没有任何插件代码跑过,配置照样有效 —— 未启用的插件也能配。
    expect(getEffectivePluginConfig('demo')).toEqual({
      enabled: true,
      label: 'stored',
      retention: 7,
      mode: 'fast',
      tags: [],
    })
  })

  it('warns once about stored junk instead of failing the read', () => {
    // P3'c:配置存储搬进产品层(`@onething/runtime/plugins/config`),它的 `getLogger`
    // 走 runtime 的那本 root —— 装配层的 `collectLogRecordsForTests` 收不到,
    // 因为本测试没有 `configureLogging()` 去把两边接到同一套 sink 上。
    const logs = captureRuntimeLogs()
    installHost({ stored: { retention: 'seven' } })
    try {
      expect(getEffectivePluginConfig('demo').retention).toBe(7)
      expect(getEffectivePluginConfig('demo').retention).toBe(7)
      expect(logs.ofLevel('warn')).toHaveLength(1)
    } finally {
      logs.restore()
    }
  })

  it('persists a validated config and strips unknown keys on write', () => {
    const disk = installHost()
    const result = setPluginConfig('demo', { label: 'saved', retention: 3, legacyKey: 'gone' })
    expect(result.success).toBe(true)
    // 盘上只留**偏离默认**的键;等于默认的那些跟随 manifest 演进(见第 22 条)。
    expect(disk.demo).toEqual({ label: 'saved', retention: 3 })
    expect(disk.demo).not.toHaveProperty('legacyKey')
    // 有效配置仍然是全字段(读路径填默认)。
    expect(result.config).toEqual({
      enabled: true,
      label: 'saved',
      retention: 3,
      mode: 'fast',
      tags: [],
    })
  })

  it('refuses an invalid write and leaves the stored value alone', () => {
    const disk = installHost({ stored: { retention: 5 } })
    const result = setPluginConfig('demo', { retention: 999 })
    expect(result.success).toBe(false)
    expect(result.errors?.[0]).toMatchObject({ key: 'retention', message: expect.stringContaining('<= 30') })
    expect(disk.demo).toEqual({ retention: 5 })
  })

  it('refuses to write for a plugin with an unsupported schema, with the reasons', () => {
    installHost({ schema: { type: 'object', properties: { nested: { type: 'object' } } } })
    const result = setPluginConfig('demo', { nested: {} })
    expect(result.success).toBe(false)
    expect(result.errors?.[0].message).toContain('unsupported type "object"')
    // 但读取路径不崩:schema 不受支持就原样返回盘上的东西。
    expect(() => getEffectivePluginConfig('demo')).not.toThrow()
  })

  it('describes an undeclared plugin as "no schema" rather than erroring', () => {
    installHost()
    expect(describePluginConfig('nobody')).toBeNull()
    expect(createPluginConfigAccess().describe('nobody')).toMatchObject({
      declared: false,
      supported: false,
    })
  })
})

describe('R3 review fixes — snapshot immutability and notification ordering', () => {
  it('hands out a deep-frozen snapshot that cannot be written through', () => {
    installHost({
      schema: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' }, default: ['seed'] } },
      },
    })
    const snapshot = getEffectivePluginConfig('demo') as { tags: string[] }
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.tags)).toBe(true)
    expect(() => snapshot.tags.push('x')).toThrow()
    // 再读一次仍是原值 —— 没有人能通过快照写穿共享状态。
    expect((getEffectivePluginConfig('demo') as { tags: string[] }).tags).toEqual(['seed'])
  })

  it('delivers the newest config last when two saves land back to back', async () => {
    installHost()
    resetPluginConfigListenersForTests()
    const seen: string[] = []
    subscribePluginConfigChange('demo', async config => {
      // 第一次故意慢:fire-and-forget 的话它会在第二次之后才落地,
      // 插件的最终认知就停在旧配置,而盘上是新配置。
      const label = String(config.label)
      if (label === 'first') await new Promise(resolve => setTimeout(resolve, 30))
      seen.push(label)
    })

    setPluginConfig('demo', { label: 'first' })
    setPluginConfig('demo', { label: 'second' })

    await vi.waitFor(() => expect(seen.at(-1)).toBe('second'), { timeout: 2000 })
    expect(seen.at(-1)).toBe('second')
  })

  it('coalesces a burst into the latest config instead of replaying every step', async () => {
    installHost()
    resetPluginConfigListenersForTests()
    const seen: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    subscribePluginConfigChange('demo', async config => {
      seen.push(String(config.label))
      if (seen.length === 1) await gate
    })

    setPluginConfig('demo', { label: 'a' })
    // 等第一轮真的开始投递(它会卡在 gate 上),之后的保存才算"排队期间到达"。
    await vi.waitFor(() => expect(seen).toEqual(['a']))

    setPluginConfig('demo', { label: 'b' })
    setPluginConfig('demo', { label: 'c' })
    release?.()

    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2))
    // 中间态('b')没人需要看见:排队期间只留最新那份。
    expect(seen).toEqual(['a', 'c'])
  })
})

describe('R3 onChange — plugin code, therefore soft-isolated', () => {
  it('pushes a frozen snapshot to subscribers after a save', async () => {
    installHost()
    resetPluginConfigListenersForTests()
    const seen: Array<Record<string, unknown>> = []
    subscribePluginConfigChange('demo', config => {
      seen.push(config)
    })

    setPluginConfig('demo', { label: 'pushed' })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ label: 'pushed' })
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it('does not let a hanging onChange block the save itself', async () => {
    const disk = installHost()
    resetPluginConfigListenersForTests()
    resetPluginRuntimeHealthForTests()
    configurePluginHealthHost({ disablePlugin: () => {}, notify: () => {} })
    subscribePluginConfigChange('demo', () => new Promise(() => {}) as unknown as void)

    // 保存是同步返回的:通知在它之后,挂起的回调影响不到已经通过校验的写入。
    const result = setPluginConfig('demo', { label: 'saved anyway' })
    expect(result.success).toBe(true)
    expect(disk.demo.label).toBe('saved anyway')

    configurePluginHealthHost(null)
  })

  it('books a failing onChange into the R1 breaker ledger', async () => {
    installHost()
    resetPluginConfigListenersForTests()
    resetPluginRuntimeHealthForTests()
    configurePluginHealthHost({ disablePlugin: () => {}, notify: () => {} })
    const logs = captureRuntimeLogs()

    try {
      subscribePluginConfigChange('demo', () => {
        throw new Error('onChange exploded')
      })
      await notifyPluginConfigChange('demo', { label: 'x' })

      expect(getPluginRuntimeHealth('demo')).toMatchObject({
        status: 'degraded',
        lastErrorScope: 'settings:onChange',
        lastError: 'onChange exploded',
      })
    } finally {
      logs.restore()
      configurePluginHealthHost(null)
      resetPluginRuntimeHealthForTests()
    }
  })

  it('stops pushing after unsubscribe', async () => {
    installHost()
    resetPluginConfigListenersForTests()
    let calls = 0
    const unsubscribe = subscribePluginConfigChange('demo', () => {
      calls += 1
    })
    await notifyPluginConfigChange('demo', {})
    unsubscribe()
    await notifyPluginConfigChange('demo', {})
    expect(calls).toBe(1)
  })
})


/**
 * M1 / F1 第二根 —— 宿主怎么定位插件的外部根。
 *
 * **寻址靠 schema,不靠一个约定的键名**:魔法键会逼每个插件去猜那个名字,
 * 猜错就静默没有外部根;而 `format: 'directory-pick'` 本来就是这条声明的唯一
 * 正门,顺着它找是零约定的。
 */
describe('F1 external root — the host locates it through the schema, not a magic key', () => {
  const WIKI_SCHEMA = {
    type: 'object',
    properties: {
      wikiRoot: { type: 'string', format: 'directory-pick', title: 'Wiki folder' },
      verbose: { type: 'boolean', default: false },
    },
  }

  it('resolves the picked folder from whatever key the plugin named it', () => {
    installHost({ schema: WIKI_SCHEMA, stored: { wikiRoot: '/Users/x/data/note' } })
    expect(pluginDeclaresExternalRootField('demo')).toBe(true)
    expect(getPluginExternalRoot('demo')).toBe('/Users/x/data/note')
  })

  it('is undefined until the user picks one (an empty value is a waiting state)', () => {
    installHost({ schema: WIKI_SCHEMA, stored: {} })
    expect(pluginDeclaresExternalRootField('demo')).toBe(true)
    expect(getPluginExternalRoot('demo')).toBeUndefined()
  })

  it('is undefined for a plugin that never declared the control', () => {
    installHost({})
    expect(pluginDeclaresExternalRootField('demo')).toBe(false)
    expect(getPluginExternalRoot('demo')).toBeUndefined()
  })

  it('follows the user changing it — the host never caches a path of its own', () => {
    const disk = installHost({ schema: WIKI_SCHEMA, stored: { wikiRoot: '/Users/x/first' } })
    expect(getPluginExternalRoot('demo')).toBe('/Users/x/first')

    setPluginConfig('demo', { wikiRoot: '/Users/x/second', verbose: false })

    expect(disk.demo.wikiRoot).toBe('/Users/x/second')
    expect(getPluginExternalRoot('demo')).toBe('/Users/x/second')
  })

  it('drops a stored relative path (the coercion layer refuses it) rather than resolving it against the CWD', () => {
    const logs = captureRuntimeLogs()
    try {
      installHost({ schema: WIKI_SCHEMA, stored: { wikiRoot: 'notes' } })
      expect(getPluginExternalRoot('demo')).toBeUndefined()
    } finally {
      logs.restore()
    }
  })
})
