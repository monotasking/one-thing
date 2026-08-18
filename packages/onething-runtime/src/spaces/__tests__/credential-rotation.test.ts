import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addSpaceProviderCredentialEntry,
  getSpaceProviderCredentials,
  markSpaceCredentialCooldown,
  normalizeSpaceCredentialPolicy,
  readSpaceCredentials,
  resetSpaceCredentialRotationForTests,
  resetSpaceCredentialsCacheForTests,
  selectSpaceCredentialEntry,
  selectSpaceCredentialEntryDetailed,
  setSpaceProviderCredentialPool,
  spaceCredentialCursorKey,
  upsertSpaceProviderApiKey,
  writeSpaceCredentials,
  type SpaceCredentialEntry,
  type SpaceProviderCredentials,
} from '../credentials.js'
import { setRootDirForTests } from '../persistence.js'
import { resolveSpaceProviderCredential } from '../provider-credentials.js'

const NOW = 1_700_000_000_000

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-cred-rotation-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  resetSpaceCredentialRotationForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  resetSpaceCredentialRotationForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function entry(id: string, over: Partial<SpaceCredentialEntry> = {}): SpaceCredentialEntry {
  return {
    id,
    label: id,
    authType: 'apiKey',
    apiKey: `sk-${id}`,
    source: 'user',
    ...over,
  }
}

function pool(
  policy: string,
  entries: SpaceCredentialEntry[],
): SpaceProviderCredentials {
  return { entries, policy }
}

describe('策略解析', () => {
  it('三种内置策略与合法的插件策略原样通过,形状不认识的一律按 single', () => {
    expect(normalizeSpaceCredentialPolicy('single')).toBe('single')
    expect(normalizeSpaceCredentialPolicy('priority-failover')).toBe('priority-failover')
    expect(normalizeSpaceCredentialPolicy('round-robin')).toBe('round-robin')
    /*
     * **批 E 改了这一条**:批 D 时 `plugin:x:y` 被压成 `'single'`,而那意味着
     * 整池写会把用户刚选的插件策略当场抹掉 —— 插件策略根本存不进去。
     * 现在形状合法就原样落盘;「此刻能不能用」在读侧现问(插件停用时不该
     * 替用户撤销他的选择)。
     */
    expect(normalizeSpaceCredentialPolicy('plugin:x:y')).toBe('plugin:x:y')
    expect(normalizeSpaceCredentialPolicy('plugin:x:Bad Name')).toBe('single')
    expect(normalizeSpaceCredentialPolicy('whatever')).toBe('single')
    expect(normalizeSpaceCredentialPolicy(undefined)).toBe('single')
  })
})

describe('single —— B3 的原语义,一字未改', () => {
  it('取头一条', () => {
    const selected = selectSpaceCredentialEntry(pool('single', [entry('a'), entry('b')]), NOW)
    expect(selected?.id).toBe('a')
  })

  it('头一条在冷却里就往后取', () => {
    const selected = selectSpaceCredentialEntry(
      pool('single', [entry('a', { cooldownUntil: NOW + 60_000 }), entry('b')]),
      NOW,
    )
    expect(selected?.id).toBe('b')
  })

  it('**不跳过用不了的 entry** —— 那是 failover 才有的行为', () => {
    const selected = selectSpaceCredentialEntry(
      pool('single', [entry('oauth', { authType: 'oauth', apiKey: undefined }), entry('b')]),
      NOW,
    )
    expect(selected?.id).toBe('oauth')
  })
})

describe('priority-failover —— 顺序即优先级', () => {
  it('取第一条可用且不在冷却里的', () => {
    const selected = selectSpaceCredentialEntry(
      pool('priority-failover', [
        entry('a', { cooldownUntil: NOW + 60_000 }),
        entry('b'),
        entry('c'),
      ]),
      NOW,
    )
    expect(selected?.id).toBe('b')
  })

  it('跳过 OAuth 型与空 key 的 entry —— 那正是「接力」这个词的意思', () => {
    const selected = selectSpaceCredentialEntry(
      pool('priority-failover', [
        entry('oauth', { authType: 'oauth', apiKey: undefined }),
        entry('blank', { apiKey: '   ' }),
        entry('real'),
      ]),
      NOW,
    )
    expect(selected?.id).toBe('real')
  })

  it('冷却过期后自动回到队首', () => {
    const credentials = pool('priority-failover', [
      entry('a', { cooldownUntil: NOW + 60_000 }),
      entry('b'),
    ])
    expect(selectSpaceCredentialEntry(credentials, NOW)?.id).toBe('b')
    expect(selectSpaceCredentialEntry(credentials, NOW + 61_000)?.id).toBe('a')
  })
})

describe('round-robin —— 在可用集上轮转', () => {
  it('依次轮到每一条,再绕回来', () => {
    const credentials = pool('round-robin', [entry('a'), entry('b'), entry('c')])
    const key = 'work:deepseek'
    const picked = [0, 1, 2, 3].map(
      () => selectSpaceCredentialEntryDetailed(credentials, { now: NOW, cursorKey: key }).entry?.id,
    )
    expect(picked).toEqual(['a', 'b', 'c', 'a'])
  })

  it('冷却中的条目不占轮次 —— 否则整池会空转', () => {
    const credentials = pool('round-robin', [
      entry('a'),
      entry('b', { cooldownUntil: NOW + 60_000 }),
      entry('c'),
    ])
    const key = 'work:deepseek'
    const picked = [0, 1, 2].map(
      () => selectSpaceCredentialEntryDetailed(credentials, { now: NOW, cursorKey: key }).entry?.id,
    )
    expect(picked).toEqual(['a', 'c', 'a'])
  })

  it('游标按 (spaceId, providerId) 分开 —— 两个 provider 不会互相拨表', () => {
    const credentials = pool('round-robin', [entry('a'), entry('b')])
    const one = spaceCredentialCursorKey('work', 'deepseek')
    const two = spaceCredentialCursorKey('work', 'zhipu')
    expect(one).not.toBe(two)
    expect(selectSpaceCredentialEntryDetailed(credentials, { now: NOW, cursorKey: one }).entry?.id).toBe('a')
    expect(selectSpaceCredentialEntryDetailed(credentials, { now: NOW, cursorKey: two }).entry?.id).toBe('a')
    expect(selectSpaceCredentialEntryDetailed(credentials, { now: NOW, cursorKey: one }).entry?.id).toBe('b')
  })

  it('没有游标键时退化成 failover,而不是编一个共享游标', () => {
    const credentials = pool('round-robin', [entry('a'), entry('b')])
    expect(selectSpaceCredentialEntryDetailed(credentials, { now: NOW }).entry?.id).toBe('a')
    expect(selectSpaceCredentialEntryDetailed(credentials, { now: NOW }).entry?.id).toBe('a')
  })

  it('游标不持久化 —— 重启(= 清空进程状态)从头轮', () => {
    const credentials = pool('round-robin', [entry('a'), entry('b')])
    const key = 'work:deepseek'
    expect(selectSpaceCredentialEntryDetailed(credentials, { now: NOW, cursorKey: key }).entry?.id).toBe('a')
    resetSpaceCredentialRotationForTests()
    expect(selectSpaceCredentialEntryDetailed(credentials, { now: NOW, cursorKey: key }).entry?.id).toBe('a')
  })
})

describe('全池耗尽 —— 与「没配」分开的第三态', () => {
  it('候选非空但全在冷却里 = exhausted,并报出最早恢复时刻', () => {
    const selection = selectSpaceCredentialEntryDetailed(
      pool('priority-failover', [
        entry('a', { cooldownUntil: NOW + 300_000 }),
        entry('b', { cooldownUntil: NOW + 60_000 }),
      ]),
      { now: NOW },
    )
    expect(selection.entry).toBeUndefined()
    expect(selection.exhausted?.earliestRecoveryAt).toBe(NOW + 60_000)
  })

  it('空池不是 exhausted —— 那是「没配」', () => {
    expect(selectSpaceCredentialEntryDetailed(pool('single', []), { now: NOW })).toEqual({})
    expect(selectSpaceCredentialEntryDetailed(undefined, { now: NOW })).toEqual({})
  })

  it('只有用不了的 entry(全是 OAuth)也不是 exhausted', () => {
    const selection = selectSpaceCredentialEntryDetailed(
      pool('priority-failover', [entry('o', { authType: 'oauth', apiKey: undefined })]),
      { now: NOW },
    )
    expect(selection).toEqual({})
  })

  it('解析层把它翻成 reason=exhausted,文案说的是「等」不是「去配」', () => {
    writeSpaceCredentials('work', {
      providers: {
        deepseek: pool('priority-failover', [entry('a', { cooldownUntil: NOW + 120_000 })]),
      },
    })
    const resolution = resolveSpaceProviderCredential({
      spaceId: 'work',
      providerId: 'deepseek',
      providerLabel: 'DeepSeek',
      spaceLabel: '工作',
      now: NOW,
    })
    expect(resolution.kind).toBe('unavailable')
    if (resolution.kind !== 'unavailable') throw new Error('unreachable')
    expect(resolution.reason).toBe('exhausted')
    expect(resolution.message).toContain('全部冷却中')
    expect(resolution.message).toContain('2 分钟')
    // 「去添加密钥」是补充建议,主句必须是「等」——两句话说反了用户会去再配一把
    // 同样耗尽的 key。
    expect(resolution.message).not.toContain('未配置')
  })
})

describe('cooldownUntil 写盘 —— 重启不忘', () => {
  beforeEach(() => {
    writeSpaceCredentials('work', {
      providers: { deepseek: pool('priority-failover', [entry('a'), entry('b')]) },
    })
  })

  it('写进去,并且新进程(清缓存 = 重新读盘)读得回来', () => {
    markSpaceCredentialCooldown('work', 'deepseek', 'a', NOW + 300_000)
    resetSpaceCredentialsCacheForTests()
    const reread = getSpaceProviderCredentials('work', 'deepseek')
    expect(reread?.entries[0].cooldownUntil).toBe(NOW + 300_000)
    // 重启之后选择器照样跳过它。
    expect(selectSpaceCredentialEntry(reread, NOW)?.id).toBe('b')
  })

  it('**只延长不缩短** —— 并发回来的短冷却不能把已知耗尽的 key 提前放回池子', () => {
    markSpaceCredentialCooldown('work', 'deepseek', 'a', NOW + 300_000)
    markSpaceCredentialCooldown('work', 'deepseek', 'a', NOW + 60_000)
    expect(getSpaceProviderCredentials('work', 'deepseek')?.entries[0].cooldownUntil)
      .toBe(NOW + 300_000)
  })

  it('认不出的 entry id 不写任何东西', () => {
    const before = JSON.stringify(readSpaceCredentials('work'))
    markSpaceCredentialCooldown('work', 'deepseek', 'nope', NOW + 300_000)
    expect(JSON.stringify(readSpaceCredentials('work'))).toBe(before)
  })

  it('换一把新 key 会把旧 key 的冷却一并抹掉(整条覆盖写)', () => {
    markSpaceCredentialCooldown('work', 'deepseek', 'a', NOW + 300_000)
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-fresh', entryId: 'a' })
    const after = getSpaceProviderCredentials('work', 'deepseek')?.entries[0]
    expect(after?.id).toBe('a')
    expect(after?.cooldownUntil).toBeUndefined()
  })
})

describe('多条目写入', () => {
  it('追加不动已有条目(含 plugin 来源的)', () => {
    writeSpaceCredentials('work', {
      providers: {
        deepseek: pool('single', [entry('plugged', { source: 'plugin:acme' })]),
      },
    })
    addSpaceProviderCredentialEntry('work', 'deepseek', { apiKey: 'sk-new', label: '备用' })
    const entries = getSpaceProviderCredentials('work', 'deepseek')?.entries ?? []
    expect(entries.map(e => e.id)).toHaveLength(2)
    expect(entries[0].source).toBe('plugin:acme')
    expect(entries[1].label).toBe('备用')
  })

  it('整池写:排序 + 删除 + 策略一次落盘', () => {
    writeSpaceCredentials('work', {
      providers: { deepseek: pool('single', [entry('a'), entry('b'), entry('c')]) },
    })
    setSpaceProviderCredentialPool('work', 'deepseek', {
      entryIds: ['c', 'a'],
      policy: 'round-robin',
    })
    const section = getSpaceProviderCredentials('work', 'deepseek')
    expect(section?.entries.map(e => e.id)).toEqual(['c', 'a'])
    expect(section?.policy).toBe('round-robin')
  })

  it('陈旧的 id 被忽略而不是让整次写盘失败', () => {
    writeSpaceCredentials('work', {
      providers: { deepseek: pool('single', [entry('a'), entry('b')]) },
    })
    setSpaceProviderCredentialPool('work', 'deepseek', { entryIds: ['b', 'ghost'] })
    expect(getSpaceProviderCredentials('work', 'deepseek')?.entries.map(e => e.id)).toEqual(['b'])
  })

  it('删光最后一条 = 整段消失(= 未配置),不留空壳', () => {
    writeSpaceCredentials('work', {
      providers: { deepseek: pool('single', [entry('a')]) },
    })
    setSpaceProviderCredentialPool('work', 'deepseek', { entryIds: [] })
    expect(getSpaceProviderCredentials('work', 'deepseek')).toBeUndefined()
  })

  it('未知策略落盘时被归一成 single', () => {
    writeSpaceCredentials('work', {
      providers: { deepseek: pool('single', [entry('a')]) },
    })
    setSpaceProviderCredentialPool('work', 'deepseek', { entryIds: ['a'], policy: 'nonsense' })
    expect(getSpaceProviderCredentials('work', 'deepseek')?.policy).toBe('single')
  })
})
