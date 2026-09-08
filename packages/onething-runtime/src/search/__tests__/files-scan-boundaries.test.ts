/**
 * 文件那一路的**三条边界**(09-07 真机事故:搜「all」之后两条 `rg` 挂在 462% CPU /
 * 415GB 虚拟内存上,整发没有任何结果)。
 *
 * 一路对着事故的四条根因写:
 *
 *  ① **扫盘根 ≠ 授权全集**:492 条会话时,扫的是当前语境那几个目录,不是每一条
 *     可见会话的 workingDirectory(那一次是 31 个根,其中一个 18GB);
 *  ② **`all` 不等扫盘型**:`kind: 'scan'` 的能力在不挑那一档里当场答「这次没问」,
 *     别的组照常出;单类档照常真跑;
 *  ③ **rg 有边界**:`context.signal` 递进 `listFiles`、拿够 limit 就 `break`、
 *     预算到点交已扫到的那些并标 `partial`。
 *
 * 第四条(壳查询带 signal)是壳与 HTTP 面的事,由 `gate:search-scan` 在真机上证。
 */
import { describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITIES } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters, OnethingSearchListFilesOptions } from '../providers.js'
import { createFilesSearchCapability, filesSearchManifest } from '../capabilities/index.js'
import { searchFiles } from '../capabilities/files.js'
import { OnethingSearchService } from '../service.js'

/** 一台**真库规模**的宿主:492 条会话,每条都有自己的工作目录。 */
const SESSION_COUNT = 492

interface Recorded {
  calls: OnethingSearchListFilesOptions[]
  adapters: OnethingSearchProvidersAdapters
}

function makeAdapters(options: {
  files?: (cwd: string) => string[]
  /** 这一发交完手上那几行之后挂住,直到 signal 被拉 —— 用来演「预算到点」。 */
  hangAfterFirst?: boolean
  /** 交完那几行、挂住之前跑一下(测试用它在**确定的时刻**喊停)。 */
  afterFirst?: () => void
} = {}): Recorded {
  const calls: OnethingSearchListFilesOptions[] = []
  const sessions = Array.from({ length: SESSION_COUNT }, (_, at) => ({
    id: `s${at}`,
    name: `会话 ${at}`,
    updatedAt: at,
    workingDirectory: `/repos/session-${at}`,
  }))
  const adapters: OnethingSearchProvidersAdapters = {
    getSessionsList: () => sessions,
    iterateSessionMessages: () => [],
    // 「当前会话」是 s7 —— 它的工作目录才是这一档该扫的那个根。
    getSession: id => sessions.find(one => one.id === id),
    getCurrentSessionId: () => 's7',
    getSettings: () => ({ general: { dailyNotes: { enabled: false } } }),
    getVariablesStore: () => ({
      getUserNoteDir: () => '/notes/user',
      getWorkNoteDir: () => '/notes/work',
    }),
    getConnectedDirectories: () => ['/connected/alpha'],
    listFiles: (listOptions) => {
      calls.push(listOptions)
      const produced = options.files?.(listOptions.cwd) ?? [`${path(listOptions.cwd)}-alpha.ts`]
      return {
        async *[Symbol.asyncIterator]() {
          for (const name of produced) yield name
          options.afterFirst?.()
          if (options.hangAfterFirst !== true) return
          // 挂住,直到上游喊停 —— 这正是慢盘那一路在真机上的样子。
          await new Promise<void>((resolve) => {
            const signal = listOptions.signal
            if (signal === undefined || signal.aborted) return resolve()
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      }
    },
    listPrompts: () => [],
  }
  return { calls, adapters }
}

function path(cwd: string): string {
  return cwd.split('/').filter(Boolean).join('-')
}

describe('① 扫盘根 = 当前语境那几个,不是授权全集', () => {
  it(`${SESSION_COUNT} 条会话时,扫盘列表里没有别的会话的 cwd`, async () => {
    const { calls, adapters } = makeAdapters()
    await searchFiles('alpha', 50, adapters)
    const roots = calls.map(call => call.cwd)
    /*
     * 四个根:当前会话的工作目录 + 用户笔记 + 工作笔记 + 接入目录。
     * 反证:把 `backend/wiring/search/index.ts` 那一行
     * `adapters.getSearchDirectories = access.fileRoots` 加回来(它接的是授权全集),
     * 这里就会变成 494 个根 —— 那正是真机上 31 条 `rg` 的成因。
     */
    expect(roots).toEqual([
      '/repos/session-7',
      '/notes/user',
      '/notes/work',
      '/connected/alpha',
    ])
    expect(roots.filter(root => root.startsWith('/repos/'))).toHaveLength(1)
    expect(roots.some(root => root === '/repos/session-0')).toBe(false)
  })

  it('`filters.dir` 递进来时**只扫那一个**(壳把活跃会话 cwd 结构地递回来的那条路)', async () => {
    const { calls, adapters } = makeAdapters()
    await searchFiles('alpha', 50, adapters, '/explicit/root')
    expect(calls.map(call => call.cwd)).toEqual(['/explicit/root'])
  })
})

describe('③ rg 有边界', () => {
  it('`context.signal` 递进 `listFiles` —— 没有它就杀不掉那条 rg', async () => {
    const { calls, adapters } = makeAdapters()
    const controller = new AbortController()
    await searchFiles('alpha', 50, adapters, undefined, {
      principal: { kind: 'user', id: 'u' },
      surface: 'palette',
      spaceId: '',
      signal: controller.signal,
      now: 0,
    })
    expect(calls).not.toHaveLength(0)
    for (const call of calls) expect(call.signal).toBe(controller.signal)
  })

  it('`--no-ignore` 不再从这一路发出去(尊重 .gitignore 是最便宜的那条边界)', async () => {
    const { calls, adapters } = makeAdapters()
    await searchFiles('alpha', 50, adapters)
    for (const call of calls) expect(call.noIgnore).toBe(false)
  })

  it('拿够 limit 就停:不再往下一个根走', async () => {
    const { calls, adapters } = makeAdapters({
      files: () => ['alpha-1.ts', 'alpha-2.ts', 'alpha-3.ts'],
    })
    const outcome = await searchFiles('alpha', 2, adapters)
    expect(outcome.items).toHaveLength(2)
    // 第一个根就够了 —— 后面三个根一次都没问。
    expect(calls).toHaveLength(1)
    expect(outcome.partial).toBeUndefined()
  })

  it('上游喊停 = 交已扫到的那些 + `partial: true`(不是抛,也不是空)', async () => {
    const controller = new AbortController()
    const { adapters } = makeAdapters({
      files: () => ['alpha-1.ts'],
      hangAfterFirst: true,
      // 第一行已经进结果表之后才喊停 —— 演的是「扫了一半,时间到了」。
      afterFirst: () => controller.abort(),
    })
    const outcome = await searchFiles('alpha', 50, adapters, undefined, {
      principal: { kind: 'user', id: 'u' },
      surface: 'palette',
      spaceId: '',
      signal: controller.signal,
      now: 0,
    })
    /*
     * 反证:把 `searchFiles` 末尾那句 `aborted() ? { items, partial: true } : …`
     * 改回 `return results` → `partial` 变 undefined,`fanout` 把这一组判成
     * `error: 'timeout'`,屏上是「文件没搜成」而不是「已扫描的部分」。
     */
    expect(outcome.items.map(item => item.title)).toEqual(['alpha-1.ts'])
    expect(outcome.partial).toBe(true)
  })
})

describe('② 不挑那一档不等扫盘型', () => {
  function service(adapters: OnethingSearchProvidersAdapters): OnethingSearchService {
    const one = new OnethingSearchService()
    one.register(createFilesSearchCapability(adapters))
    return one
  }

  it('`all` 档:files 那一组答 `deferred`,不去碰一个目录', async () => {
    const { calls, adapters } = makeAdapters()
    const response = await service(adapters).query({
      query: 'alpha',
      category: ALL_CAPABILITIES,
      limit: 10,
    })
    const group = response.groups?.find(one => one.capability === filesSearchManifest.id)
    expect(group).toBeDefined()
    expect(group?.deferred).toBe(true)
    expect(group?.results).toEqual([])
    expect(group?.total).toBe(0)
    /*
     * 判据是「一个目录都没扫」,不是「结果为空」—— 后者一次真扫也可能给出。
     * 反证:把 `fanout` 里 `deferInAll` 那一支拆掉 → `calls` 立刻非空,
     * 这一条与下面那条「别的组不等它」一起红。
     */
    expect(calls).toHaveLength(0)
  })

  it('单类档照常真跑(用户明确挑了这一档,等它是应该的)', async () => {
    const { calls, adapters } = makeAdapters()
    const response = await service(adapters).query({
      query: 'alpha',
      category: filesSearchManifest.id,
      limit: 10,
    })
    expect(calls).not.toHaveLength(0)
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.groups).toBeUndefined()
  })

  it('`all` 里那一路挂死也不拖住别的组 —— 整发照样回', async () => {
    const { adapters } = makeAdapters({ files: () => ['alpha-1.ts'], hangAfterFirst: true })
    const one = new OnethingSearchService()
    one.register(createFilesSearchCapability(adapters))
    // 真机那一次整发不回,就是因为这一步会等 files 落地。加了 deferred 之后它不等。
    const response = await vi.waitFor(
      () => one.query({ query: 'alpha', category: ALL_CAPABILITIES, limit: 10 }),
      { timeout: 2000 },
    )
    expect(response.success).toBe(true)
  })
})
