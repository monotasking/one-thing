import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MusicPanel } from '../MusicPanel'
import { ProgrammeSheet } from '../music/ProgrammeSheet'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { configureMusicPort } from '../../data/music-port'
import type { MusicPort, MusicResourceEvent } from '../../data/music-port'
import { resetMusicSource, useMusicLive } from '../../data/music-source'
import { configurePetPort, resetPetSource } from '../../data/pet-source'
import type { ResourceEventFact, ResourcePort } from '../../data/resource-port'
import { useStageStore } from '../../stage/store'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

/**
 * **样例剩下的六条**(2026-09-18,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §8)。
 * 判的是那六条各自的**判据**,不是屏幕好不好看:
 *
 *  ① 「正在播放」段有歌才画、没歌整段不画(不留空段头),那一行没有把手也没有「⋯」;
 *  ② 悬停即放发出去的是 `promote` + `next` 两条,**只发一次**,而且走的是现成的
 *     `programmeAction` / `next`(不是一条新做法);第一条没成就停在那儿;
 *  ③ 失败那句话留在**那一行**下面,三角回到可按;
 *  ④ 小话筒只在 `entry.say` 有值时画;
 *  (⑤–⑦ 歌词让位 / 歌词骨架 / 心情色块随音乐面 v8 退役,见下方那段说明)
 *  ⑧ 均衡器在动效档「无」/ 系统偏好下停住 —— 这一条判的是**样式表源文本**
 *     (jsdom 不排版,算不出 animation;而这两条规则是写法层面的事实)。
 */

/* ── 假端口 ──────────────────────────────────────────────────────────────── */

type ReadTable = Record<string, unknown>

interface FakeMusic {
  port: MusicPort
  dos: Array<{ ref: string; op: string; params: Record<string, unknown> | undefined }>
  listeners: Array<(event: MusicResourceEvent) => void>
  table: ReadTable
  /** 下一次 `do` 的答案(按 op 分档;缺省 ok)。 */
  outcomes: Record<string, ResourceOutcomeView>
  /** 这几条读数挂着不回 —— 「还在读」那一档。 */
  held: Set<string>
}

function makeFake(table: ReadTable): FakeMusic {
  const fake: FakeMusic = {
    dos: [],
    listeners: [],
    table,
    outcomes: {},
    held: new Set(),
    port: undefined as unknown as MusicPort,
  }
  fake.port = {
    ready: async () => undefined,
    read: async (ref, name): Promise<ResourceReadView> => {
      const key = `${ref}#${name}`
      if (fake.held.has(key)) return new Promise<ResourceReadView>(() => undefined)
      if (!(key in fake.table)) return { kind: 'denied', reason: `no ${key}` }
      return { kind: 'ok', value: fake.table[key] }
    },
    do: async (ref, op, params): Promise<ResourceOutcomeView> => {
      fake.dos.push({ ref, op, params })
      return fake.outcomes[op] ?? { kind: 'ok', text: 'done' }
    },
    onResourceEvent: (_prefix, callback) => {
      fake.listeners.push(callback)
      return () => {
        const at = fake.listeners.indexOf(callback)
        if (at >= 0) fake.listeners.splice(at, 1)
      }
    },
  }
  return fake
}

/** 一只假宠物端口:只为了推 `utterance` / `hushed` 两条事实。 */
class FakePet implements ResourcePort {
  private listeners = new Set<(event: ResourceEventFact) => void>()
  ready = async (): Promise<void> => undefined
  read = async (_ref: string, name: string): Promise<ResourceReadView> =>
    name === 'current'
      ? { kind: 'ok', value: { pet: { id: 'heidou', name: '黑豆', rig: 'heidou-svg' }, speaking: false, utterances: [] } }
      : { kind: 'ok', value: { pets: [] } }
  do = async (): Promise<ResourceOutcomeView> => ({ kind: 'ok', text: 'done' })
  onResourceEvent = (_prefix: string, callback: (event: ResourceEventFact) => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
  push(event: string, payload: unknown): void {
    for (const listener of this.listeners) listener({ ref: 'pet:current', event, payload })
  }
}

const NOW_PLAYING = {
  playing: true,
  status: 'playing' as const,
  title: '雨棚下 - 旧电扇',
  position: 61,
  duration: 200,
  queueLength: 3,
  currentIndex: 0,
}

const PROGRAMME = {
  entries: [
    { encryptedId: 'a', title: '凌晨便利店 - 霜降乐队', say: '接下来这一首,是他半夜写的。' },
    { encryptedId: 'b', title: '潮汐表 - 北岸电台' },
  ],
  onDeck: NOW_PLAYING.title,
}

const LYRICS = {
  title: NOW_PLAYING.title,
  lines: [
    { at: 0, text: '雨落在铁皮雨棚上' },
    { at: 20, text: '我们挤在同一块屋檐' },
    { at: 40, text: '公交车晚了十分钟' },
  ],
}

function fullTable(): ReadTable {
  return {
    'music:radio#brief': { active: true, intent: '下雨天', programmeLength: 2, canResume: true, volume: 40 },
    'music:radio#programme': PROGRAMME,
    'music:player#nowPlaying': NOW_PLAYING,
    'music:player#lyrics': LYRICS,
    'music:provider#state': { setupStage: 'ready', configured: true, loggedIn: true, playerBackend: 'mpv', source: 'daily' },
  }
}

let fake: FakeMusic
let pet: FakePet

/**
 * 五条读数是 `useMusicLive()` 拉的(音乐面挂载时那一下),不是 `useQuery` 自己拉的。
 * 单独渲染一件时要把那一口补上 —— 这不是夹具绕路,那正是产品里那块面做的事。
 */
function Live({ children }: { children: ReactNode }) {
  useMusicLive()
  return <>{children}</>
}

/** 一个宏任务把微任务排干 —— 读数落地与随之而来的重渲都在 act 里面。 */
async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function mountSheet(table: ReadTable = fullTable(), props: Parameters<typeof ProgrammeSheet>[0] = {}) {
  fake = makeFake(table)
  configureMusicPort(fake.port)
  const view = render(
    <Live>
      <ProgrammeSheet {...props} />
    </Live>,
  )
  await settle()
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetMusicSource()
  resetPetSource()
  pet = new FakePet()
  configurePetPort(pet)
})

afterEach(() => {
  // 先卸载再归零:`reset*` 会 emit,不显式 cleanup 那一声会打在还挂着的组件上。
  cleanup()
  resetMusicSource()
  resetPetSource()
  configureMusicPort(undefined)
  configurePetPort(undefined)
})

/* ── §8.1 正在播放 ───────────────────────────────────────────────────────── */

describe('§8.1 播放列表头上那一段', () => {
  it('有歌:画一行 —— 段头 +「正在播放」那一行', async () => {
    await mountSheet(fullTable(), { nowPlaying: NOW_PLAYING, position: 100 })
    const row = await screen.findByTestId('music-now-row')
    expect(row.textContent).toContain('雨棚下')
    expect(screen.getByText('正在播放')).toBeTruthy()
  })

  it('没歌:整段不画,连段头都没有(不留空段头)', async () => {
    await mountSheet(fullTable(), { nowPlaying: { ...NOW_PLAYING, title: undefined, playing: false } })
    expect(screen.queryByTestId('music-now-row')).toBeNull()
    expect(screen.queryByText('正在播放')).toBeNull()
  })

  it('那一行不可点:没有把手、没有 ⋯、也没有立即播放的三角', async () => {
    await mountSheet(fullTable(), { nowPlaying: NOW_PLAYING, position: 100 })
    const row = await screen.findByTestId('music-now-row')
    expect(row.querySelectorAll('button')).toHaveLength(0)
  })

  it('进度吃的是递进来的那个数(一半的时候占一半)', async () => {
    await mountSheet(fullTable(), { nowPlaying: NOW_PLAYING, position: 100 })
    const row = await screen.findByTestId('music-now-row')
    expect(screen.getByTestId('music-now-progress').style.width).toBe('50%')
    expect(row.contains(screen.getByTestId('music-now-progress'))).toBe(true)
  })

  it('抽屉里真的拿得到那一行 —— 音乐面把读数递到了节目单', async () => {
    fake = makeFake(fullTable())
    configureMusicPort(fake.port)
    render(
      <>
        <FocusDispatchHarness />
        <MusicPanel initialPlaylistOpen />
      </>,
    )
    await settle()
    expect(await screen.findByTestId('music-now-row')).toBeTruthy()
  })
})

/* ── §8.2 悬停即放 ───────────────────────────────────────────────────────── */

describe('§8.2 色块上那颗三角', () => {
  it('发的是 promote + next 两条,走的是现成那两只做法', async () => {
    await mountSheet()
    const play = await screen.findByTestId('music-entry-play:a')
    await act(async () => {
      fireEvent.click(play)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos.map((d) => `${d.ref}:${d.op}`)).toEqual(['music:radio:programmeAction', 'music:player:next'])
    expect(fake.dos[0].params).toEqual({ action: { kind: 'promote', encryptedId: 'a' } })
  })

  it('连点两下只发一轮(在飞的时候第二下不算数)', async () => {
    await mountSheet()
    const play = await screen.findByTestId('music-entry-play:a')
    await act(async () => {
      fireEvent.click(play)
      fireEvent.click(play)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos.filter((d) => d.op === 'programmeAction')).toHaveLength(1)
    expect(fake.dos.filter((d) => d.op === 'next')).toHaveLength(1)
  })

  it('提到第一位没成就停在那儿 —— 不硬推 next(那会放到别的歌上去)', async () => {
    await mountSheet()
    fake.outcomes.programmeAction = { kind: 'failed', error: { name: 'MusicCommandFailedError', message: '排不动' } }
    const play = await screen.findByTestId('music-entry-play:a')
    await act(async () => {
      fireEvent.click(play)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos.map((d) => d.op)).toEqual(['programmeAction'])
  })

  it('失败那句话留在那一行下面,三角回到可按', async () => {
    await mountSheet()
    fake.outcomes.programmeAction = { kind: 'failed', error: { name: 'MusicCommandFailedError', message: '排不动' } }
    const play = await screen.findByTestId('music-entry-play:a')
    await act(async () => {
      fireEvent.click(play)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const bad = await screen.findByTestId('music-entry-error')
    expect(bad.textContent).toContain('排不动')
    expect(bad.closest('li')?.getAttribute('data-music-entry')).toBe('a')
    expect((screen.getByTestId('music-entry-play:a') as HTMLButtonElement).disabled).toBe(false)
  })

  it('右键菜单里「提到下一首」照旧在(两条路不冲突)', async () => {
    await mountSheet()
    const row = document.querySelector('[data-music-entry="a"]') as HTMLElement
    fireEvent.contextMenu(row)
    expect(await screen.findByText('下一首播放')).toBeTruthy()
  })
})

/* ── §8.3 小话筒 ─────────────────────────────────────────────────────────── */

describe('§8.3 主持人要先说话的那一首', () => {
  it('有 say 的那一行画记号,没有的那一行不画', async () => {
    await mountSheet()
    expect(await screen.findByTestId('music-entry-say:a')).toBeTruthy()
    expect(screen.queryByTestId('music-entry-say:b')).toBeNull()
  })

  it('记号说得出那句话,而且 Tab 到得了(提示只在悬停 / 聚焦时出现)', async () => {
    await mountSheet()
    const mark = await screen.findByTestId('music-entry-say:a')
    expect(mark.getAttribute('aria-label')).toContain('他半夜写的')
    expect(mark.getAttribute('tabindex')).toBe('0')
  })
})

/*
 * §8.4 他开口时歌词让位 / §8.5 歌词加载骨架 / §8.6 心情色块 —— 随音乐面 v8(唱针读歌词,
 * 2026-09-18)一起退役:歌词住到了唱针旁边、没有骨架那一屏;电台条连同心情色块并掉,
 * 开台改成 ⏯ 或「说话」说一句想听什么(判据在 music-panel / music-talk 两份用例里)。
 */

/* ── §8.8 动效档「无」/ 系统偏好下不动 ───────────────────────────────────── */

describe('§8.8 均衡器在动效档「无」下停住', () => {
  /** 读样式表源文本的门先剥注释 —— 病历文本里有「animation」这个词。 */
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'MusicPanel.module.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')

  it('两个来源一个结论:系统偏好与动效档「无」各有一条,都是 animation: none', () => {
    for (const selector of ['.eq[data-playing] i']) {
      const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? []
      expect(reduced.some((block) => block.includes(selector) && block.includes('animation: none'))).toBe(true)
      const tier = new RegExp(`:root\\[data-motion-tier='none'\\] ${selector.replace(/[.[\]]/g, '\\$&')} \\{[^}]*animation: none`)
      expect(tier.test(css)).toBe(true)
    }
  })

  it('时长与关键帧都是 token,不写字面量', () => {
    expect(css).toContain('animation: var(--kf-music-eq) var(--dur-music-eq)')
  })

  it('停住之后是三根**不等高**的条(等高会读成三个点)', () => {
    const tierBlock = css.slice(css.indexOf(":root[data-motion-tier='none'] .eq[data-playing] i"))
    expect(tierBlock).toContain('--music-eq-still-b')
    expect(tierBlock).toContain('--music-eq-still-c')
  })
})
