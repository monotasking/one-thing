// @vitest-environment happy-dom
/**
 * Music 面板套上共享骨架之后的那一层(P4b,计划 agile-watching-abelson.md P4)。
 *
 * 盯四件事:
 *  1. 控制条那只搜索框**就是**点歌入口(回车搜 → 点结果插队);
 *  2. 播放队列是 44px 账线行:首列槽平时是序号,正在放的那行换成均衡器动条;
 *  3. 状态条那一格换成 44px 播放条(顶部进度带 + 26px 圆播放钮),三个键都走
 *     `musicStore.sendCommand`;
 *  4. 没有当前曲目时播放条退化成一行状态文案 —— 不画一条按不动的播放条。
 *
 * musicStore 整个被 mock 掉:真 store 背后是 platformApi → ncm-cli 守护进程,
 * 测试里碰它等于往 `~/.onething` 写真东西(2026-07-17 电台事故的教训)。
 */
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MusicPanelContent from '../MusicPanelContent.vue'

const mocks = vi.hoisted(() => ({
  musicStore: null as any,
  sessionsStore: null as any,
}))

vi.mock('@/stores/music', () => ({ useMusicStore: () => mocks.musicStore }))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => mocks.sessionsStore }))

function entry(overrides: Record<string, unknown> = {}) {
  return { encryptedId: 'a', title: '晴天', ...overrides }
}

const releaseClock = vi.fn()

function seed(overrides: Record<string, any> = {}) {
  mocks.musicStore = reactive({
    radio: { active: true, intent: '写代码的时候听', programmeLength: 3, canResume: false, upNext: '' },
    programme: [
      entry({ encryptedId: 'a', title: '晴天', say: '周杰伦的老歌' }),
      entry({ encryptedId: 'b', title: '夜空中最亮的星', note: '点歌' }),
      entry({ encryptedId: 'c', title: '版权歌', playFlag: false }),
    ],
    programmeOnDeck: undefined,
    nowPlaying: null,
    livePosition: 0,
    progressRatio: 0,
    refreshProgramme: vi.fn().mockResolvedValue(undefined),
    programmeAction: vi.fn().mockResolvedValue(undefined),
    searchSongs: vi.fn().mockResolvedValue({ success: true, records: [] }),
    requestSongNext: vi.fn().mockResolvedValue({ success: true, title: '晴天' }),
    sendCommand: vi.fn().mockResolvedValue({ success: true }),
    useClock: vi.fn(() => releaseClock),
    ...overrides,
  })
  mocks.sessionsStore = reactive({
    radioSessions: [{ id: 'radio-1', name: '电台', updatedAt: Date.UTC(2026, 7, 9, 10, 30) }],
    currentSessionId: 'radio-1',
    switchSession: vi.fn(),
  })
}

function mountPanel() {
  return mount(MusicPanelContent)
}

beforeEach(() => {
  seed()
})

afterEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('MusicPanelContent — 共享骨架外壳', () => {
  it('控制条那只 compact 搜索框就是点歌入口', async () => {
    const wrapper = mountPanel()
    mocks.musicStore.searchSongs.mockResolvedValue({
      success: true,
      records: [{ title: '稻香', artist: '周杰伦' }],
    })

    const input = wrapper.find('.panel-shell-controls .filter-search.is-compact input')
    expect(input.exists()).toBe(true)

    await input.setValue('稻香')
    await input.trigger('keydown.enter')
    await vi.waitFor(() => expect(mocks.musicStore.searchSongs).toHaveBeenCalledWith('稻香'))
    await nextTick()

    const result = wrapper.find('.request-result')
    expect(result.text()).toContain('稻香')
    await result.trigger('click')
    await vi.waitFor(() => expect(mocks.musicStore.requestSongNext).toHaveBeenCalledWith('稻香 周杰伦'))
  })

  it('队列走共享分组头 + 44px 行,首列平时是 mono 序号', async () => {
    const wrapper = mountPanel()

    const header = wrapper.findAll('.ledger-group-header')
      .find((item: any) => item.find('.lgh-label').text() === '播放队列')!
    expect(header.find('.lgh-count').text()).toBe('3')

    const rows = wrapper.findAll('.queue-row')
    expect(rows).toHaveLength(3)
    expect(rows.map((row: any) => row.find('.queue-index').text())).toEqual(['1', '2', '3'])
    expect(rows[0].find('.queue-title').text()).toContain('晴天')
    expect(rows[0].find('.queue-sub').text()).toContain('周杰伦的老歌')
    expect(rows[2].classes()).toContain('is-grey')
  })

  it('正在放的那一行:序号换成均衡器动条,整行抬起', async () => {
    seed({ nowPlaying: { status: 'playing', title: '夜空中最亮的星', position: 46, duration: 200, queueLength: 3, currentIndex: 0 } })
    const wrapper = mountPanel()

    const rows = wrapper.findAll('.queue-row')
    expect(rows[1].find('.eq-bars').exists()).toBe(true)
    expect(rows[1].find('.queue-index').exists()).toBe(false)
    expect(rows[1].classes()).toContain('is-current')
    expect(rows[0].find('.eq-bars').exists()).toBe(false)
  })

  it('暂停时动条留下但不动', async () => {
    seed({ nowPlaying: { status: 'paused', title: '晴天', position: 10, duration: 200, queueLength: 3, currentIndex: 0 } })
    const wrapper = mountPanel()
    expect(wrapper.find('.queue-row .eq-bars').classes()).toContain('is-still')
  })

  it('状态条那一格是 44px 播放条:进度带 + 时间 + 三个键走 sendCommand', async () => {
    seed({
      nowPlaying: { status: 'playing', title: '晴天', position: 166, duration: 489, queueLength: 3, currentIndex: 0 },
      livePosition: 166,
      progressRatio: 0.34,
    })
    const wrapper = mountPanel()

    const status = wrapper.find('.panel-shell-status')
    expect(status.classes()).toContain('is-flush')

    const bar = status.find('.music-player-bar')
    expect(bar.exists()).toBe(true)
    expect(bar.find('.mpb-title').text()).toBe('晴天')
    expect(bar.find('.mpb-time').text()).toBe('2:46 / 8:09')
    expect(bar.find('.mpb-progress-fill').attributes('style')).toContain('width: 34%')

    await bar.find('.mpb-toggle').trigger('click')
    expect(mocks.musicStore.sendCommand).toHaveBeenCalledWith('pause')

    await bar.findAll('.mpb-icon')[1].trigger('click')
    await vi.waitFor(() => expect(mocks.musicStore.sendCommand).toHaveBeenCalledWith('next'))
  })

  it('暂停时圆盘变回播放键', async () => {
    seed({ nowPlaying: { status: 'paused', title: '晴天', position: 0, duration: 100, queueLength: 1, currentIndex: 0 } })
    const wrapper = mountPanel()

    const toggle = wrapper.find('.mpb-toggle')
    expect(toggle.attributes('aria-label')).toBe('播放')
    await toggle.trigger('click')
    expect(mocks.musicStore.sendCommand).toHaveBeenCalledWith('resume')
  })

  it('没有当前曲目时退化成一行状态文案,不画播放条', async () => {
    const wrapper = mountPanel()
    expect(wrapper.find('.music-player-bar').exists()).toBe(false)
    expect(wrapper.find('.idle-status').text()).toContain('电台待命')
    expect(wrapper.find('.panel-shell-status').classes()).not.toContain('is-flush')

    seed({ radio: { active: false, intent: '', programmeLength: 0, canResume: false } })
    const closed = mountPanel()
    expect(closed.find('.idle-status').text()).toBe('电台未开')
  })

  it('挂载时点亮 store 的插值时钟,卸载时还回去', async () => {
    const wrapper = mountPanel()
    expect(mocks.musicStore.useClock).toHaveBeenCalled()
    wrapper.unmount()
    expect(releaseClock).toHaveBeenCalled()
  })

  it('队列的三件事原样保留:提到下一首 / 移出 / 拖着重排', async () => {
    const wrapper = mountPanel()
    const rows = wrapper.findAll('.queue-row')

    await rows[1].findAll('.queue-btn')[0].trigger('click')
    expect(mocks.musicStore.programmeAction).toHaveBeenCalledWith({ kind: 'promote', encryptedId: 'b' })

    await rows[1].findAll('.queue-btn')[1].trigger('click')
    expect(mocks.musicStore.programmeAction).toHaveBeenCalledWith({ kind: 'remove', encryptedId: 'b' })

    await rows[2].trigger('dragstart', { dataTransfer: { setData: vi.fn() } })
    await rows[0].trigger('drop')
    expect(mocks.musicStore.programmeAction).toHaveBeenCalledWith({ kind: 'move', encryptedId: 'c', toIndex: 0 })
  })

  it('电台与编排记录收进分组,点会话仍旧切过去', async () => {
    const wrapper = mountPanel()
    expect(wrapper.findAll('.ledger-group-header').map((item: any) => item.find('.lgh-label').text()))
      .toEqual(['播放队列', '电台', '编排记录'])
    expect(wrapper.text()).toContain('写代码的时候听')

    await wrapper.find('.session-row').trigger('click')
    expect(mocks.sessionsStore.switchSession).toHaveBeenCalledWith('radio-1')
  })
})
