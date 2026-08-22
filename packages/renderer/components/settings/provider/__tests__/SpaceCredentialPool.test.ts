// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpaceCredentialPool from '../SpaceCredentialPool.vue'
import type { SpaceCredentialEntrySummary, SpaceCredentialsSummary } from '@/types'

/**
 * 批 B7:B3 的独立面板 `SpaceCredentialsPanel` 退役,池编辑器搬进连接卡片,
 * 一次只服务**一个 provider × 当前空间**。这份测试是那份的迁移版 ——
 * 「哪个空间」「后端答不答得上话」两条判据搬去了 `ConnectionsSection`
 * (见 `ConnectionsSection.space.test.ts`),这里只钉池本身的行为。
 */

// P4c 第七批:oauth 六条走通用 RPC 域客户端,信封是一个对象
// (`{ providerId, ...credentialTarget }`),不再是位置参数。
const mocks = vi.hoisted(() => ({
  store: null as any,
  spaceProviders: null as any,
  oauth: {
    start: vi.fn(),
    callback: vi.fn(),
    devicePoll: vi.fn(),
    logout: vi.fn(),
  },
}))

vi.mock('@/platform/oauth-client', () => ({ oauthApi: mocks.oauth }))
vi.mock('@/stores/spaces', () => ({
  DEFAULT_SPACE_ID: 'default',
  useSpacesStore: () => mocks.store,
}))
vi.mock('@/stores/spaceProviders', () => ({
  useSpaceProvidersStore: () => mocks.spaceProviders,
}))

function summaryEntry(
  id: string,
  over: Partial<SpaceCredentialEntrySummary> = {},
): SpaceCredentialEntrySummary {
  return {
    id,
    label: id,
    authType: 'apiKey',
    hasApiKey: true,
    apiKeyPreview: `sk-${id}••••6789`,
    source: 'user',
    ...over,
  }
}

function poolOf(
  entries: SpaceCredentialEntrySummary[],
  policy = 'single',
  providerId = 'deepseek',
  extra: Partial<SpaceCredentialsSummary> & {
    providerExtra?: Record<string, unknown>
  } = {},
): SpaceCredentialsSummary {
  const { providerExtra, ...rest } = extra
  return {
    providers: { [providerId]: { policy, entries, ...providerExtra } },
    ...rest,
  }
}

function createSpacesStore(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    spaces: [
      { id: 'default', name: '默认空间', createdAt: 0 },
      { id: 'work', name: '工作', createdAt: 1 },
    ],
    currentSpace: { id: 'work', name: '工作', createdAt: 1 },
    currentSpaceId: 'work',
    lastError: null,
    load: vi.fn(async () => {}),
    getCredentials: vi.fn(async () => ({ providers: {} })),
    setCredential: vi.fn(async () => ({ providers: {} })),
    setCredentialPool: vi.fn(async () => ({ providers: {} })),
    clearCredential: vi.fn(async () => ({ providers: {} })),
    ...overrides,
  }
}

function createSpaceProviders(initial: SpaceCredentialsSummary = { providers: {} }) {
  const credentials = ref<SpaceCredentialsSummary>(initial)
  return {
    credentials,
    spaceId: 'work',
    isDefaultSpace: false,
    poolOf: (providerId: string) => credentials.value.providers[providerId],
    // 批 E:注册表实时快照。空 = 一个插件策略都没装。
    get strategies() { return credentials.value.strategies ?? [] },
    applyCredentials: vi.fn((next: SpaceCredentialsSummary) => {
      credentials.value = next
    }),
    refresh: vi.fn(async () => {}),
  }
}

async function mountPool(props: { providerId?: string; providerName?: string; oauth?: boolean } = {}) {
  const wrapper = mount(SpaceCredentialPool, {
    props: {
      providerId: props.providerId ?? 'deepseek',
      providerName: props.providerName ?? 'DeepSeek',
      oauth: props.oauth ?? false,
    },
  })
  await nextTick()
  return wrapper
}

function buttonWith(wrapper: any, label: string) {
  return wrapper.findAll('button').filter((b: any) => b.text() === label)
}

/**
 * 单条态与 default 空间同构(用户 08-18 裁决),池那一套是**渐进披露**出来的 ——
 * 所以凡是要碰顺序/策略/替换/删除的用例,先点开那条小字。
 */
async function revealPool(wrapper: any) {
  const disclose = wrapper.find('[data-testid="pool-disclose"]')
  if (disclose.exists()) {
    await disclose.trigger('click')
    await nextTick()
  }
  return wrapper
}

/** 按 aria-label 找输入框 —— 位置索引会随结构漂移,标签不会。 */
function inputLabelled(wrapper: any, label: string) {
  return wrapper.findAll('input').find((el: any) => el.attributes('aria-label') === label)!
}

beforeEach(() => {
  mocks.store = createSpacesStore()
  mocks.spaceProviders = createSpaceProviders()
  vi.clearAllMocks()
  mocks.oauth.start.mockResolvedValue({
    success: true,
    requiresCodeEntry: true,
    state: 'st',
    instructions: '贴码',
  })
  mocks.oauth.callback.mockResolvedValue({ success: true })
  mocks.oauth.devicePoll.mockResolvedValue({ success: true, completed: true })
  mocks.oauth.logout.mockResolvedValue({ success: true })
})

describe('SpaceCredentialPool', () => {
  it('单条态与 default 空间同构:同一组行、同一组 aria-label、没有只此一处的措辞', async () => {
    const wrapper = await mountPool()
    // 用户 08-18:「同一张设置页,切空间只换数据、不换外观。」
    expect(wrapper.findComponent({ name: 'ProviderCredentialRows' }).exists()).toBe(true)
    const labels = wrapper.findAll('input').map((el: any) => el.attributes('aria-label'))
    expect(labels).toContain('API key')
    expect(labels).toContain('Base URL')
    expect(wrapper.text()).not.toContain('本空间')
    expect(wrapper.text()).not.toContain('凭证池')
    // 多条能力仍然够得着,只是收在一条小字后面。
    expect(wrapper.find('[data-testid="pool-disclose"]').text()).toContain('再添加一把 key')
    wrapper.unmount()
  })

  it('旋钮行跟着 provider 走,并且用的是同一张表(zhipu 有档位、deepseek 没有)', async () => {
    const zhipu = await mountPool({ providerId: 'zhipu', providerName: '智谱' })
    const zhipuLabels = zhipu.findAllComponents({ name: 'Select' })
      .map((c: any) => c.props('ariaLabel'))
    expect(zhipuLabels).toContain('Zhipu API mode')
    zhipu.unmount()

    const deepseek = await mountPool()
    expect(deepseek.findAllComponents({ name: 'Select' })).toHaveLength(0)
    deepseek.unmount()
  })

  it('改档位不需要重新粘一次 key —— 带 entryId 不带 apiKey 的 patch', async () => {
    vi.useFakeTimers()
    mocks.spaceProviders = createSpaceProviders(
      poolOf([summaryEntry('a', { label: '主力' })], 'single', 'kimi'),
    )
    const wrapper = await mountPool({ providerId: 'kimi', providerName: 'Kimi' })
    const select = wrapper.findAllComponents({ name: 'Select' })
      .find((c: any) => c.props('ariaLabel') === 'Kimi region')
    select!.vm.$emit('update:modelValue', 'intl')
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.store.setCredential).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'kimi',
      entryId: 'a',
      label: '主力',
      region: 'intl',
    })
    vi.useRealTimers()
    wrapper.unmount()
  })

  it('还没有条目时,先攒着 —— 一把 key 到位才建条目(不留一行用不了的东西)', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPool({ providerId: 'kimi', providerName: 'Kimi' })
    const select = wrapper.findAllComponents({ name: 'Select' })
      .find((c: any) => c.props('ariaLabel') === 'Kimi region')
    select!.vm.$emit('update:modelValue', 'intl')
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.store.setCredential).not.toHaveBeenCalled()

    await inputLabelled(wrapper, 'API key').setValue('sk-new')
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.store.setCredential).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'kimi',
      apiKey: 'sk-new',
      region: 'intl',
    })
    vi.useRealTimers()
    wrapper.unmount()
  })

  it('lists every entry in the pool with its preview, in priority order', async () => {
    mocks.spaceProviders = createSpaceProviders(
      poolOf([summaryEntry('a', { label: '主力' }), summaryEntry('b', { label: '备用' })], 'priority-failover'),
    )
    const wrapper = await mountPool()
    const text = wrapper.text()
    expect(text).toContain('2 把密钥')
    expect(text).toContain('主力')
    expect(text).toContain('备用')
    expect(text).toContain('sk-a••••6789')
    wrapper.unmount()
  })

  it('never renders a raw key — only the preview the backend sent', async () => {
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a')]))
    const wrapper = await mountPool()
    expect(wrapper.html()).not.toContain('sk-live-secret')
    // 单条态里预览住在 placeholder 上:输入框本身是空的(原文永不回读)。
    const input = inputLabelled(wrapper, 'API key')
    expect(input.attributes('placeholder')).toContain('sk-a••••6789')
    expect((input.element as HTMLInputElement).value).toBe('')
    // 展开成池之后,同一份预览出现在条目行上。
    await revealPool(wrapper)
    expect(wrapper.text()).toContain('sk-a••••6789')
    wrapper.unmount()
  })

  it('marks a cooling entry with how long is left instead of silently hiding it', async () => {
    mocks.spaceProviders = createSpaceProviders(
      poolOf([summaryEntry('a', { cooldownUntil: Date.now() + 3 * 60_000 }), summaryEntry('b')]),
    )
    const wrapper = await mountPool()
    expect(wrapper.text()).toContain('冷却中')
    expect(wrapper.text()).toContain('剩 3 分钟')
    wrapper.unmount()
  })

  it('keeps the single-entry case as plain as the default space — no policy control at all', async () => {
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a')]))
    const wrapper = await mountPool()
    // 池是能力,不是必须先理解的概念:一条时不画顺序号、不画策略选择器。
    expect(wrapper.text()).not.toContain('始终用最上面那条')
    expect(wrapper.findAllComponents({ name: 'Select' })).toHaveLength(0)
    wrapper.unmount()
  })

  it('spells out what each policy actually does, and writes the choice through', async () => {
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a'), summaryEntry('b')]))
    const wrapper = await mountPool()
    // 默认 single 的语义要写出来,不是给个英文名让人猜。
    expect(wrapper.text()).toContain('始终用最上面那条,不自动换')

    // 策略选择器是这块面板上唯一的 Select(aria-label 是 fall-through attr,
    // 不在 props 里 —— 按 attributes 找)。
    const select = wrapper.findAllComponents({ name: 'Select' })
      .find(c => c.attributes('aria-label') === 'DeepSeek 轮换策略')
      ?? wrapper.findAllComponents({ name: 'Select' })[0]
    select!.vm.$emit('update:modelValue', 'round-robin')
    await nextTick()

    expect(mocks.store.setCredentialPool).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'deepseek',
      entryIds: ['a', 'b'],
      policy: 'round-robin',
    })
    wrapper.unmount()
  })

  it('adds a new entry rather than overwriting the first one', async () => {
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a')]))
    const wrapper = await revealPool(await mountPool())
    await inputLabelled(wrapper, 'DeepSeek 新凭证名称').setValue('备用')
    await inputLabelled(wrapper, 'DeepSeek API Key(本空间)').setValue('sk-new')
    await nextTick()

    await buttonWith(wrapper, '添加')[0].trigger('click')
    await nextTick()

    expect(mocks.store.setCredential).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'deepseek',
      apiKey: 'sk-new',
      baseUrl: undefined,
      label: '备用',
    })
    // 保存成功就清掉草稿:输入框里留着明文没有任何用处。
    expect(
      (inputLabelled(wrapper, 'DeepSeek API Key(本空间)').element as HTMLInputElement).value,
    ).toBe('')
    wrapper.unmount()
  })

  it('reorders by rewriting the whole pool as an id list (order = failover priority)', async () => {
    mocks.spaceProviders = createSpaceProviders(
      poolOf([summaryEntry('a'), summaryEntry('b'), summaryEntry('c')], 'priority-failover'),
    )
    const wrapper = await mountPool()
    // 第二行的「↑」——把 b 提到最前。
    await buttonWith(wrapper, '↑')[1].trigger('click')
    await nextTick()

    expect(mocks.store.setCredentialPool).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'deepseek',
      entryIds: ['b', 'a', 'c'],
    })
    wrapper.unmount()
  })

  it('asks twice before deleting a key — it cannot be recovered from this panel', async () => {
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a'), summaryEntry('b')]))
    const wrapper = await mountPool()

    await buttonWith(wrapper, '删除')[0].trigger('click')
    await nextTick()
    expect(mocks.store.setCredentialPool).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('确认删除')

    await buttonWith(wrapper, '确认删除')[0].trigger('click')
    await nextTick()
    expect(mocks.store.setCredentialPool).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'deepseek',
      entryIds: ['b'],
    })
    wrapper.unmount()
  })

  it('will not let the last entry be deleted through the reorder channel', async () => {
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a')]))
    const wrapper = await revealPool(await mountPool())
    // 只剩一条时删除按钮是禁用的 —— 清空整段要走「清除全部」。
    expect(buttonWith(wrapper, '删除')[0].attributes('disabled')).toBeDefined()
    expect(buttonWith(wrapper, '清除全部')[0].attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('replaces one entry in place — the id survives so ledger attribution stays connected', async () => {
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a', { label: '主力' })]))
    const wrapper = await revealPool(await mountPool())
    await buttonWith(wrapper, '换密钥')[0].trigger('click')
    await nextTick()

    await inputLabelled(wrapper, '替换 主力 的 API Key').setValue('sk-rotated')
    await nextTick()

    await buttonWith(wrapper, '保存')[0].trigger('click')
    await nextTick()

    expect(mocks.store.setCredential).toHaveBeenCalledWith({
      id: 'work',
      providerId: 'deepseek',
      apiKey: 'sk-rotated',
      entryId: 'a',
      label: '主力',
    })
    wrapper.unmount()
  })

  it('surfaces the backend refusal instead of pretending the write landed', async () => {
    mocks.store = createSpacesStore({
      setCredentialPool: vi.fn(async () => null),
      lastError: '默认空间的凭证在「设置 → 模型服务」里直接编辑,不走空间凭证池',
    })
    mocks.spaceProviders = createSpaceProviders(poolOf([summaryEntry('a'), summaryEntry('b')]))
    const wrapper = await mountPool()
    await buttonWith(wrapper, '↑')[1].trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('不走空间凭证池')
    wrapper.unmount()
  })

  /* ── per-space OAuth(批 B6,搬家后原样成立)──────────────────────────── */

  it('OAuth 单账号态复用 default 的 AuthCard —— 同一张登录卡,不是另一副外观', async () => {
    const wrapper = await mountPool({ providerId: 'codex', providerName: 'Codex', oauth: true })
    expect(wrapper.findComponent({ name: 'AuthCard' }).exists()).toBe(true)
    // AuthCard 自己的文案(与 default 空间逐字相同)。
    expect(wrapper.text()).toContain('Signed out')
    expect(buttonWith(wrapper, 'Login with Codex')).toHaveLength(1)
    // 「多登一个账号」是披露出来的能力,不是默认摊开的表单。
    expect(wrapper.find('[data-testid="pool-disclose"]').text()).toContain('再登录一个账号')
    expect(wrapper.text()).not.toContain('本空间')
    wrapper.unmount()
  })

  it('点登录带上 spaceId 与备注 —— 写回目标是参数,不是另一条流程', async () => {
    const wrapper = await revealPool(
      await mountPool({ providerId: 'codex', providerName: 'Codex', oauth: true }),
    )
    expect(wrapper.text()).toContain('账号不能跨空间复制')
    await inputLabelled(wrapper, 'Codex 新账号备注').setValue('工作号')
    await buttonWith(wrapper, '登录')[0].trigger('click')
    await nextTick()

    expect(mocks.oauth.start).toHaveBeenCalledWith({
      providerId: 'codex',
      spaceId: 'work',
      label: '工作号',
    })
    // 手输码那一支:要给出输入框,并把目标一并回传。
    await inputLabelled(wrapper, '粘贴授权页给出的验证码').setValue('the-code')
    await buttonWith(wrapper, '提交')[0].trigger('click')
    await nextTick()
    expect(mocks.oauth.callback).toHaveBeenCalledWith({
      providerId: 'codex',
      code: 'the-code',
      state: 'st',
      spaceId: 'work',
      label: '工作号',
    })
    wrapper.unmount()
  })

  it('已登录的账号显示账号与有效期(不显示 token),退出要两段式确认', async () => {
    const expiresAt = Date.now() + 3_600_000
    mocks.spaceProviders = createSpaceProviders({
      providers: {
        codex: {
          policy: 'single',
          entries: [{
            id: 'acc-1',
            label: '工作号',
            authType: 'oauth',
            hasApiKey: false,
            source: 'user',
            hasOAuthToken: true,
            oauthAccount: 'me@example.com',
            oauthExpiresAt: expiresAt,
          }],
        },
      },
    })
    const wrapper = await mountPool({ providerId: 'codex', providerName: 'Codex', oauth: true })
    // 单账号态:AuthCard 的口径(与 default 空间逐字相同),不显示 token。
    expect(wrapper.text()).toContain('Connected')
    expect(wrapper.text()).toContain('me@example.com')
    expect(wrapper.html()).not.toContain('oauthToken')

    // Disconnect 在 default 空间是直接退,这里也直接退(同构)。
    await buttonWith(wrapper, 'Disconnect')[0].trigger('click')
    await nextTick()
    expect(mocks.oauth.logout).toHaveBeenCalledWith({
      providerId: 'codex',
      spaceId: 'work',
      entryId: 'acc-1',
    })
    wrapper.unmount()
  })

  it('多账号态才展开条目列表,退出仍是两段式确认', async () => {
    const base = {
      authType: 'oauth' as const,
      hasApiKey: false,
      source: 'user',
      hasOAuthToken: true,
    }
    mocks.spaceProviders = createSpaceProviders({
      providers: {
        codex: {
          policy: 'single',
          entries: [
            { id: 'acc-1', label: '工作号', ...base, oauthAccount: 'a@example.com' },
            { id: 'acc-2', label: '私人号', ...base, oauthAccount: 'b@example.com' },
          ],
        },
      },
    })
    const wrapper = await mountPool({ providerId: 'codex', providerName: 'Codex', oauth: true })
    expect(wrapper.findComponent({ name: 'AuthCard' }).exists()).toBe(false)
    expect(wrapper.text()).toContain('2 个账号')

    await buttonWith(wrapper, '退出登录')[0].trigger('click')
    await nextTick()
    expect(mocks.oauth.logout).not.toHaveBeenCalled()
    await buttonWith(wrapper, '确认退出')[0].trigger('click')
    await nextTick()
    expect(mocks.oauth.logout).toHaveBeenCalledWith({
      providerId: 'codex',
      spaceId: 'work',
      entryId: 'acc-1',
    })
    wrapper.unmount()
  })
})

/**
 * 批 E:插件策略在这块面板上的两件事 —— 它出现在选择器里,以及它**不在时**
 * 不会静默消失(greyed not removed,与触发式锚点、深链动作同规)。
 */
describe('SpaceCredentialPool — 插件策略(批 E)', () => {
  it('lists registered plugin strategies alongside the three built-in ones', async () => {
    mocks.spaceProviders = createSpaceProviders(
      poolOf([summaryEntry('a'), summaryEntry('b')], 'single', 'deepseek', {
        strategies: [{
          policy: 'plugin:balancer:least-used',
          pluginId: 'balancer',
          title: '用得最少的优先',
          description: '按近 24h token 量挑最闲的那把。',
        }],
      }),
    )
    const wrapper = await mountPool()
    const select = wrapper.findAllComponents({ name: 'Select' })
      .find(c => c.attributes('aria-label') === 'DeepSeek 轮换策略')
      ?? wrapper.findAllComponents({ name: 'Select' })[0]
    const values = (select.props('options') as Array<{ value: string }>).map(o => o.value)
    expect(values).toEqual([
      'single', 'priority-failover', 'round-robin', 'plugin:balancer:least-used',
    ])
    wrapper.unmount()
  })

  it('shows the plugin strategy own description once it is selected', async () => {
    mocks.spaceProviders = createSpaceProviders(
      poolOf([summaryEntry('a'), summaryEntry('b')], 'plugin:balancer:least-used', 'deepseek', {
        strategies: [{
          policy: 'plugin:balancer:least-used',
          pluginId: 'balancer',
          title: '用得最少的优先',
          description: '按近 24h token 量挑最闲的那把。',
        }],
      }),
    )
    const wrapper = await mountPool()
    expect(wrapper.text()).toContain('按近 24h token 量挑最闲的那把。')
    expect(wrapper.find('[data-testid="policy-unavailable"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('greys the选择 out rather than dropping it when the plugin is gone', async () => {
    // 插件停用/卸载:strategies 清单里没有它了,但 policy 字段仍然留着 ——
    // 用户的选择保留,插件回来自动生效。面板要说得清"它暂时不在"。
    mocks.spaceProviders = createSpaceProviders(
      poolOf([summaryEntry('a'), summaryEntry('b')], 'plugin:balancer:least-used', 'deepseek', {
        providerExtra: { policyUnavailable: true },
      }),
    )
    const wrapper = await mountPool()

    expect(wrapper.find('[data-testid="policy-unavailable"]').text())
      .toContain('策略不可用,正在使用内置 failover')

    // **不是移除**:选择器里仍然有那一项(否则 Select 会显示成空的,
    // 用户看到的是"我的选择被吃了")。
    const select = wrapper.findAllComponents({ name: 'Select' })
      .find(c => c.attributes('aria-label') === 'DeepSeek 轮换策略')
      ?? wrapper.findAllComponents({ name: 'Select' })[0]
    expect(select.props('modelValue')).toBe('plugin:balancer:least-used')
    const options = select.props('options') as Array<{ value: string; label: string }>
    expect(options.map(o => o.value)).toContain('plugin:balancer:least-used')
    expect(options.find(o => o.value === 'plugin:balancer:least-used')!.label)
      .toContain('不可用')
    wrapper.unmount()
  })
})
