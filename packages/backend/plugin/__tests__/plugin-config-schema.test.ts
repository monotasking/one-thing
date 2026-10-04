/**
 * R3 验收(产品层部分):JSON Schema 子集归约与取值归一化。
 *
 * **支持的子集 = 设置 UI 能渲染的控件集** —— 这两件事必须是同一份清单:
 * 能校验但渲染不出来 = 用户改不了;能渲染但校验不了 = 脏值进盘。
 */
import { describe, expect, it } from 'vitest'
import { PLUGIN_FILE_PICK_EXTENSIONS, PLUGIN_FILE_PICK_MAX_BYTES } from '@onething/backend/plugin-contract'
import {
  coercePluginConfig,
  deepFreezePluginConfig,
  describePluginConfigSchema,
  stripPluginConfigDefaults,
} from '../plugin-config-schema.js'
import {
  ONETHING_LOG_MONITOR_MANIFEST,
  resolveOnethingLogMonitorConfig,
} from '../plugin-log-monitor.js'

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

describe('R3 schema subset — the supported set is the renderable set', () => {
  it('reduces every supported type to a control', () => {
    const described = describePluginConfigSchema(DEMO_SCHEMA, { title: 'Demo' })
    expect(described.supported).toBe(true)
    if (!described.supported) return

    expect(described.fields.map(field => [field.key, field.control])).toEqual([
      ['enabled', 'switch'],
      ['label', 'text'],
      ['retention', 'number'],
      ['mode', 'select'],
      ['tags', 'string-list'],
    ])
    expect(described.fields[1]).toMatchObject({ label: 'Label', required: true })
    expect(described.fields[2]).toMatchObject({ integer: true, minimum: 1, maximum: 30 })
    expect(described.fields[3]).toMatchObject({ options: ['fast', 'slow'], defaultValue: 'fast' })
  })

  it('derives a humane label when neither ui nor title says otherwise', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { flushIntervalMs: { type: 'integer', default: 1 } },
    })
    expect(described.supported && described.fields[0].label).toBe('Flush Interval Ms')
  })

  it('honors ui hints over schema-derived presentation', () => {
    const described = describePluginConfigSchema(DEMO_SCHEMA, {
      ui: { label: { label: 'Display name', hint: 'shown in the header' } },
    })
    expect(described.supported && described.fields[1]).toMatchObject({
      label: 'Display name',
      hint: 'shown in the header',
    })
  })

  it('reports every reason at once when the schema leaves the subset', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: {
        nested: { type: 'object' },
        mixed: { enum: ['a', 2] },
        numbers: { type: 'array', items: { type: 'number' } },
      },
    })
    expect(described.supported).toBe(false)
    if (described.supported) return
    expect(described.reasons).toHaveLength(3)
    expect(described.reasons.join(' ')).toContain('unsupported type "object"')
    expect(described.reasons.join(' ')).toContain('only string enums')
    expect(described.reasons.join(' ')).toContain('arrays of strings')
  })

  it('rejects a top-level schema that is not an object', () => {
    expect(describePluginConfigSchema({ type: 'array' }).supported).toBe(false)
    expect(describePluginConfigSchema('nope').supported).toBe(false)
  })
})

describe('R3 review fixes — snapshot / control / default contracts', () => {
  it('never hands out the manifest default array itself', () => {
    const schema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, default: ['seed'] } },
    }
    const described = describePluginConfigSchema(schema)
    expect(described.supported).toBe(true)
    if (!described.supported) return

    const first = coercePluginConfig(described.fields, {}).config
    ;(first.tags as string[]).push('mutated')

    // 第二次读必须还是 ['seed'] —— 否则第一次读的人就写穿了 manifest 常量,
    // 污染此后所有读取方直到重启。
    const second = coercePluginConfig(described.fields, {}).config
    expect(second.tags).toEqual(['seed'])
    expect((schema.properties.tags.default as string[])).toEqual(['seed'])
  })

  it('deep-freezes a snapshot so nested members are immutable too', () => {
    const snapshot = deepFreezePluginConfig({ tags: ['a'], nested: { list: [1] } })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.tags)).toBe(true)
    expect(Object.isFrozen(snapshot.nested.list)).toBe(true)
  })

  it('validates by schema type, not by the presentation control', () => {
    // ui.control 只管长相:它不能把一个 string 字段变成能存 boolean 的字段。
    const described = describePluginConfigSchema(
      { type: 'object', properties: { mode: { type: 'string', default: 'a' } } },
      { ui: { mode: { control: 'switch' } } },
    )
    expect(described.supported).toBe(false)
    if (described.supported) return
    expect(described.reasons[0]).toContain('not compatible with type "string"')
  })

  it('refuses a select override on a plain string (an empty dropdown can never be saved)', () => {
    const described = describePluginConfigSchema(
      { type: 'object', properties: { name: { type: 'string' } } },
      { ui: { name: { control: 'select' } } },
    )
    expect(described.supported).toBe(false)
    if (described.supported) return
    expect(described.reasons[0]).toContain('allowed: text')
  })

  it('allows the compatible overrides', () => {
    const described = describePluginConfigSchema(
      { type: 'object', properties: { mode: { enum: ['a', 'b'] } } },
      { ui: { mode: { control: 'text' } } },
    )
    expect(described.supported && described.fields[0]).toMatchObject({
      type: 'string-enum',
      control: 'text',
    })
  })

  it('rejects a schema whose own default violates the schema', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { retention: { type: 'integer', minimum: 1, default: 0 } },
    })
    expect(described.supported).toBe(false)
    if (described.supported) return
    // 不拦的话:坏值回退会回退到这个非法默认,然后被写路径原样落盘 —— 永远循环。
    expect(described.reasons[0]).toContain('schema default is invalid')
  })

  it('rejects prototype-polluting property names', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const described = describePluginConfigSchema({
        type: 'object',
        properties: { [key]: { type: 'string' } },
      })
      expect(described.supported).toBe(false)
      if (described.supported) continue
      expect(described.reasons[0]).toContain('reserved')
    }
  })

  it('ignores inherited keys when filling defaults', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { label: { type: 'string', default: 'fallback' } },
    })
    if (!described.supported) throw new Error('expected supported')
    const stored = Object.create({ label: 'from-prototype' }) as Record<string, unknown>
    // `key in obj` 会把原型链上的东西当成"用户存过的值"。
    expect(coercePluginConfig(described.fields, stored).config.label).toBe('fallback')
  })

  it('stores only the keys that deviate from the defaults', () => {
    const described = describePluginConfigSchema(DEMO_SCHEMA)
    if (!described.supported) throw new Error('expected supported')
    const effective = coercePluginConfig(described.fields, { label: 'custom' }).config

    // 物化全字段的话,用户保存过一次之后 manifest 改 default 对他永远不再生效。
    expect(stripPluginConfigDefaults(described.fields, effective)).toEqual({ label: 'custom' })
    expect(stripPluginConfigDefaults(described.fields, { ...effective, tags: [] })).toEqual({ label: 'custom' })
    expect(stripPluginConfigDefaults(described.fields, { ...effective, tags: ['x'] })).toEqual({
      label: 'custom',
      tags: ['x'],
    })
  })

  it('follows a changed manifest default for keys the user never deviated on', () => {
    const v1 = describePluginConfigSchema({
      type: 'object',
      properties: { retention: { type: 'integer', default: 7 }, label: { type: 'string', default: 'a' } },
    })
    if (!v1.supported) throw new Error('expected supported')
    const stored = stripPluginConfigDefaults(v1.fields, coercePluginConfig(v1.fields, { label: 'mine' }).config)
    expect(stored).toEqual({ label: 'mine' })

    // manifest 把默认从 7 改成 30:用户没动过这个键,应当跟着走。
    const v2 = describePluginConfigSchema({
      type: 'object',
      properties: { retention: { type: 'integer', default: 30 }, label: { type: 'string', default: 'a' } },
    })
    if (!v2.supported) throw new Error('expected supported')
    expect(coercePluginConfig(v2.fields, stored).config).toEqual({ retention: 30, label: 'mine' })
  })
})

describe('R3 coercion — defaults in, junk out', () => {
  const described = describePluginConfigSchema(DEMO_SCHEMA)
  const fields = described.supported ? described.fields : []

  it('fills defaults for missing keys', () => {
    expect(coercePluginConfig(fields, {}).config).toEqual({
      enabled: true,
      label: 'hi',
      retention: 7,
      mode: 'fast',
      tags: [],
    })
  })

  it('falls back to the default for stored junk and says so', () => {
    const result = coercePluginConfig(fields, { retention: 'seven', mode: 'sideways' })
    expect(result.config.retention).toBe(7)
    expect(result.config.mode).toBe('fast')
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('falling back to the default')
  })

  it('enforces the numeric bounds and integer-ness declared by the schema', () => {
    expect(coercePluginConfig(fields, { retention: 0 }).errors[0]).toMatchObject({
      key: 'retention',
      message: expect.stringContaining('>= 1'),
    })
    expect(coercePluginConfig(fields, { retention: 99 }).errors[0].message).toContain('<= 30')
    expect(coercePluginConfig(fields, { retention: 1.5 }).errors[0].message).toContain('integer')
  })

  it('strips keys the schema never declared', () => {
    const result = coercePluginConfig(fields, { label: 'x', legacyKey: 'gone' })
    expect(result.strippedKeys).toEqual(['legacyKey'])
    expect(result.config).not.toHaveProperty('legacyKey')
  })
})

describe('R3 acceptance — log-monitor moved a hardcoded constant into schema', () => {
  it('declares the constants as manifest settings, not code', () => {
    const schema = ONETHING_LOG_MONITOR_MANIFEST.contributes?.settings?.schema
    expect(schema).toBeTruthy()
    const described = describePluginConfigSchema(schema, {})
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields.map(field => field.key)).toEqual([
      'retentionDays',
      'flushIntervalMs',
      'notifyOnErrors',
    ])
    // 设置页据此自动出现三个控件 —— 没有一行专门为 log-monitor 写的 UI 代码。
    expect(described.fields.map(field => field.control)).toEqual(['number', 'number', 'switch'])
  })

  it('resolves an effective config that keeps the old constants as defaults', () => {
    expect(resolveOnethingLogMonitorConfig(undefined)).toEqual({
      retentionDays: 7,
      flushIntervalMs: 1000,
      notifyOnErrors: true,
    })
    expect(resolveOnethingLogMonitorConfig({ retentionDays: 2 })).toMatchObject({
      retentionDays: 2,
      flushIntervalMs: 1000,
    })
  })
})

/**
 * 文件导入控件(`format: 'file-import'`)。
 *
 * **判例**:选文件是配置,配置的家是设置页;面板留给活内容。此前这个子集里
 * 没有文件控件,于是"选图"只能借 file-pick 节点落进工作台面板 —— 能力缺口
 * 把 UX 拽错了位置。语义与 file-pick 节点逐字相同,判据也是**同一份**(core)。
 */
describe('file-import — 配置类的"选文件"住设置页', () => {
  it('归约成 file-import 控件,accept / maxBytes 是**裁决后**的值', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: {
        wallpaper: {
          type: 'string',
          format: 'file-import',
          accept: ['png', 'WEBP'],
          maxBytes: 5_000_000,
          title: 'Wallpaper',
        },
      },
    })
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields[0]).toMatchObject({
      key: 'wallpaper',
      // 值的类型契约没有变:存的是一个字符串(`storage:` 地址)。
      type: 'string',
      control: 'file-import',
      label: 'Wallpaper',
      accept: ['png', 'webp'],
      maxBytes: 5_000_000,
      defaultValue: '',
    })
  })

  it('accept 只能收窄宿主白名单 —— 越界是拒,不是悄悄过滤', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: {
        wallpaper: { type: 'string', format: 'file-import', accept: ['png', 'exe'] },
      },
    })
    expect(described.supported).toBe(false)
    if (described.supported) return
    expect(described.reasons.join(' ')).toContain('outside the host whitelist')
  })

  it('未声明 accept = 全白名单(不是空表)', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { wallpaper: { type: 'string', format: 'file-import' } },
    })
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields[0].accept).toEqual([...PLUGIN_FILE_PICK_EXTENSIONS])
    expect(described.fields[0].maxBytes).toBe(PLUGIN_FILE_PICK_MAX_BYTES)
  })

  it('maxBytes 声明得更大 = **钳**到硬顶(作者想要更大,拒掉只换来一个用不了的字段)', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: {
        wallpaper: { type: 'string', format: 'file-import', maxBytes: 999_000_000 },
      },
    })
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields[0].maxBytes).toBe(PLUGIN_FILE_PICK_MAX_BYTES)
  })

  it('maxBytes 不是正数 = 拒(那是笔误,不是"想要更大")', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { wallpaper: { type: 'string', format: 'file-import', maxBytes: 0 } },
    })
    expect(described.supported).toBe(false)
    if (described.supported) return
    expect(described.reasons.join(' ')).toContain('positive finite number')
  })

  it('挂在非 string / enum 上 = 拒,而不是掉进 string 分支变成一个自由文本框', () => {
    const onNumber = describePluginConfigSchema({
      type: 'object',
      properties: { size: { type: 'number', format: 'file-import' } },
    })
    expect(onNumber.supported).toBe(false)
    if (!onNumber.supported) expect(onNumber.reasons.join(' ')).toContain('only supported on string properties')

    const onEnum = describePluginConfigSchema({
      type: 'object',
      properties: { pick: { enum: ['a', 'b'], format: 'file-import' } },
    })
    expect(onEnum.supported).toBe(false)
    if (!onEnum.supported) expect(onEnum.reasons.join(' ')).toContain('cannot be combined with enum')
  })

  it('默认值必须是字符串 —— 与"manifest 自己的 default 也要过校验"同规', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { wallpaper: { type: 'string', format: 'file-import', default: 42 } },
    })
    expect(described.supported).toBe(false)
    if (described.supported) return
    expect(described.reasons.join(' ')).toContain('schema default is invalid')
  })

  it('宿主不认识的 format 一律**忽略**(JSON Schema 的规矩),退化成普通文本框', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { home: { type: 'string', format: 'uri', default: 'https://x' } },
    })
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields[0]).toMatchObject({ control: 'text', defaultValue: 'https://x' })
  })

  it('存的值仍按 string 校验;侧门 ui.control 也补齐宿主缺省裁决', () => {
    const described = describePluginConfigSchema(
      { type: 'object', properties: { wallpaper: { type: 'string' } } },
      { ui: { wallpaper: { control: 'file-import' } } },
    )
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields[0]).toMatchObject({
      control: 'file-import',
      accept: [...PLUGIN_FILE_PICK_EXTENSIONS],
      maxBytes: PLUGIN_FILE_PICK_MAX_BYTES,
    })

    const coerced = coercePluginConfig(described.fields, { wallpaper: 7 })
    expect(coerced.config.wallpaper).toBe('')
    expect(coerced.errors[0]).toMatchObject({ key: 'wallpaper', message: expect.stringContaining('must be a string') })
  })
})

/**
 * 目录选择控件(`format: 'directory-pick'`,M1 / F1 第二根)。
 *
 * **判例**:wiki 要放用户指定的目录且他会亲手编辑,所以那个目录必须由用户选 ——
 * 而"选一个目录"同样是**配置**,配置的家是设置页(与 file-import 同一条判例)。
 *
 * 校验分三层,这里钉的是前两层:声明(core 纯函数)与值的形状(本层纯函数)。
 * 第三层"目录到底存不存在"在 core 的 files 面用到的那一刻判 —— 用户可能在选完
 * 之后把它删了,那不是"配置非法",是"现在够不着"。
 */
describe('directory-pick — 用户指定根的入口', () => {
  it('归约成 directory-pick 控件,值语义标记随之带上', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: {
        wikiRoot: {
          type: 'string',
          format: 'directory-pick',
          title: 'Wiki folder',
          description: '你的笔记目录',
        },
      },
    })
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields[0]).toMatchObject({
      key: 'wikiRoot',
      // 值的类型契约没有变:存的就是一个字符串(一条绝对路径)。
      type: 'string',
      control: 'directory-pick',
      directoryPick: true,
      label: 'Wiki folder',
      hint: '你的笔记目录',
      defaultValue: '',
    })
  })

  it('manifest 不许预填目录 —— 这条权限的全部意义就是"目录由用户选"', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: {
        wikiRoot: { type: 'string', format: 'directory-pick', default: '/Users/x/notes' },
      },
    })
    expect(described.supported).toBe(false)
    if (described.supported) return
    expect(described.reasons[0]).toContain('cannot declare a default')
  })

  it('配 enum / 非 string 一律判不支持,而且说得出理由', () => {
    const withEnum = describePluginConfigSchema({
      type: 'object',
      properties: { wikiRoot: { type: 'string', format: 'directory-pick', enum: ['a'] } },
    })
    expect(withEnum.supported).toBe(false)
    if (!withEnum.supported) expect(withEnum.reasons[0]).toContain('cannot be combined with enum')

    const wrongType = describePluginConfigSchema({
      type: 'object',
      properties: { wikiRoot: { type: 'number', format: 'directory-pick' } },
    })
    expect(wrongType.supported).toBe(false)
    if (!wrongType.supported) expect(wrongType.reasons[0]).toContain('only supported on string properties')
  })

  it('值必须是绝对路径或空串;相对路径回退默认并报错', () => {
    const described = describePluginConfigSchema({
      type: 'object',
      properties: { wikiRoot: { type: 'string', format: 'directory-pick' } },
    })
    expect(described.supported).toBe(true)
    if (!described.supported) return

    // 空 = 还没选,合法(等待状态,不是错误状态)。
    expect(coercePluginConfig(described.fields, { wikiRoot: '' }).errors).toEqual([])
    // posix 与 Windows 两种绝对形态都收 —— 同一份配置不该在主进程合法、设置页报错。
    expect(coercePluginConfig(described.fields, { wikiRoot: '/Users/x/notes' }).config.wikiRoot)
      .toBe('/Users/x/notes')
    expect(coercePluginConfig(described.fields, { wikiRoot: 'C:\\Users\\x\\notes' }).config.wikiRoot)
      .toBe('C:\\Users\\x\\notes')

    const relative = coercePluginConfig(described.fields, { wikiRoot: 'notes' })
    expect(relative.config.wikiRoot).toBe('')
    expect(relative.errors[0]).toMatchObject({
      key: 'wikiRoot',
      message: expect.stringContaining('absolute folder path'),
    })
  })

  it('侧门 ui.control 也必须把值语义带上,否则长得像选目录、校验起来是自由文本', () => {
    const described = describePluginConfigSchema(
      { type: 'object', properties: { wikiRoot: { type: 'string' } } },
      { ui: { wikiRoot: { control: 'directory-pick' } } },
    )
    expect(described.supported).toBe(true)
    if (!described.supported) return
    expect(described.fields[0]).toMatchObject({ control: 'directory-pick', directoryPick: true })

    const relative = coercePluginConfig(described.fields, { wikiRoot: './notes' })
    expect(relative.errors[0]?.message).toContain('absolute folder path')
  })
})
