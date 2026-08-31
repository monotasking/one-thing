import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import { ModelCatalog } from '../ModelCatalog'
import { CredentialPool } from '../CredentialPool'
import { OAuthCard } from '../OAuthCard'
import { UsageCard } from '../UsageCard'
import { CustomProviderDialog } from '../CustomProviderDialog'
import { ModeCard } from '../ModeCard'
import { IDLE_AUTH_FLOW } from '../../auth'
import type { CatalogRow, ProviderMode } from '../../types'
import type { PoolView } from '../../projection'

/**
 * 批二那几块新组件。它们全是**哑组件**(事实进、画面出),所以这一组直接喂它们
 * 事实,不经 store —— 判据那一半已经在 projection / auth / dials 三组里守过了,
 * 这里守的是**画面有没有兑现那些事实**。
 */

beforeEach(() => {
  // 断言的是中文那一份文案,语言得钉死(jsdom 的 navigator.language 是 en-US)。
  useStageStore.setState({ locale: 'zh' })
})

function row(id: string, over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id,
    name: id,
    selected: false,
    current: false,
    contextLength: 200_000,
    maxOutput: 32_768,
    caps: [],
    price: { input: 3, output: 15 },
    manual: false,
    ...over,
  }
}

function catalog(props: Partial<Parameters<typeof ModelCatalog>[0]> = {}) {
  return (
    <ModelCatalog
      providerId="openrouter"
      rows={[row('a')]}
      status="ready"
      kind="api"
      query=""
      saving={false}
      onQuery={vi.fn()}
      onRefresh={vi.fn()}
      onToggle={vi.fn()}
      onSetCurrent={vi.fn()}
      onAddManual={vi.fn()}
      onRemoveManual={vi.fn()}
      {...props}
    />
  )
}

describe('ModelCatalog · 单价', () => {
  it('每百万的数原样画出来,不再乘一遍 1e6', () => {
    render(catalog({ rows: [row('gpt-5.6', { price: { input: 5, output: 30 } })] }))
    expect(screen.getByText('$5 / $30')).toBeTruthy()
  })

  it('订阅坑写「订阅内」;目录没给价写破折号', () => {
    render(catalog({ kind: 'subscription' }))
    expect(screen.getByText('订阅内')).toBeTruthy()
  })
})

describe('ModelCatalog · 设为当前 / 手填 ID', () => {
  it('当前那一行画读数,别的行画钮', () => {
    render(catalog({ rows: [row('a', { current: true }), row('b')] }))
    expect(screen.getByText('当前模型')).toBeTruthy()
    expect(screen.getByTestId('set-current-b')).toBeTruthy()
    expect(screen.queryByTestId('set-current-a')).toBeNull()
  })

  it('手填的行标出来,并且只有它有删除钮', () => {
    render(catalog({ rows: [row('a'), row('ghost', { manual: true, selected: true })] }))
    expect(screen.getByText('手填')).toBeTruthy()
    expect(screen.getByRole('button', { name: '删除 ghost' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除 a' })).toBeNull()
  })

  it('手填被拒时**当场显示原因且不清空输入框** —— 让人看得见自己刚打的是什么', () => {
    const onAddManual = vi.fn(() => 'a 已经在这一坑的列表里了')
    render(catalog({ onAddManual }))

    fireEvent.click(screen.getByRole('button', { name: '＋ 手填 ID' }))
    const field = screen.getByLabelText('手填模型 ID') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    expect(screen.getByText('a 已经在这一坑的列表里了')).toBeTruthy()
    expect(field.value).toBe('a')
  })

  it('手填成功就清空,好接着填下一个', () => {
    render(catalog({ onAddManual: vi.fn(() => undefined) }))
    fireEvent.click(screen.getByRole('button', { name: '＋ 手填 ID' }))
    const field = screen.getByLabelText('手填模型 ID') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'qwen3-max' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(field.value).toBe('')
  })
})

describe('ModelCatalog · 厂牌折叠', () => {
  /** 70 行、两个厂牌 —— 过了折叠门槛。 */
  const many = [
    ...Array.from({ length: 40 }, (_, i) => row(`anthropic/m${i}`)),
    ...Array.from({ length: 30 }, (_, i) => row(`openai/m${i}`)),
  ]

  it('**收起的组不渲染行** —— 收起还渲染就等于没折叠', () => {
    render(catalog({ rows: many }))
    expect(screen.getByTestId('model-group-anthropic/')).toBeTruthy()
    expect(screen.queryByTestId('model-row-anthropic/m0')).toBeNull()
  })

  it('点组头才展开', () => {
    render(catalog({ rows: many }))
    fireEvent.click(screen.getByTestId('model-group-anthropic/'))
    expect(screen.getByTestId('model-row-anthropic/m0')).toBeTruthy()
    // 另一组仍然收着 —— 展开是逐组的。
    expect(screen.queryByTestId('model-row-openai/m0')).toBeNull()
  })

  it('已选置顶且始终展开,不藏在任何一组后面', () => {
    render(catalog({ rows: [...many, row('meta/picked', { selected: true })] }))
    expect(screen.getByTestId('model-row-meta/picked')).toBeTruthy()
    expect(screen.getByText(/已选 · 1/)).toBeTruthy()
  })

  it('检索时组自动展开,组头那颗钮同时被禁 —— 免得点一下就自相矛盾', () => {
    render(catalog({ rows: many, query: 'm1' }))
    expect(screen.getByTestId('model-row-anthropic/m0')).toBeTruthy()
    expect((screen.getByTestId('model-group-anthropic/') as HTMLButtonElement).disabled).toBe(true)
  })

  it('截断了就如实报剩余,不默默少画', () => {
    const huge = Array.from({ length: 200 }, (_, i) => row(`openai/m${i}`))
    render(catalog({ rows: huge, query: 'm' }))
    expect(screen.getByText(/还有 150 型没画出来/)).toBeTruthy()
  })

  it('行数不够就不折叠 —— 十几行折起来只是多两次点击', () => {
    render(catalog({ rows: [row('anthropic/a'), row('anthropic/b')] }))
    expect(screen.queryByTestId('model-group-anthropic/')).toBeNull()
    expect(screen.getByTestId('model-row-anthropic/a')).toBeTruthy()
  })
})

/* ── 凭证池 ──────────────────────────────────────────────────────────────── */

function pool(over: Partial<PoolView> = {}): PoolView {
  return {
    rows: [
      {
        id: 'e0',
        ordinal: 1,
        label: '个人',
        authType: 'apiKey',
        preview: '…8c1d',
        source: 'user',
        cooling: false,
      },
      {
        id: 'e1',
        ordinal: 2,
        label: '公司报销',
        authType: 'apiKey',
        preview: '…44f0',
        source: 'user',
        cooldownUntil: Date.now() + 4 * 60_000,
        cooling: true,
      },
    ],
    policy: 'priority-failover',
    policyUnavailable: false,
    canDelete: true,
    ...over,
  }
}

function credentialPool(over: Partial<Parameters<typeof CredentialPool>[0]> = {}) {
  return (
    <CredentialPool
      providerId="grok"
      pool={pool()}
      busy={false}
      onAdd={vi.fn()}
      onReplace={vi.fn()}
      onRemove={vi.fn()}
      onMove={vi.fn()}
      onRotation={vi.fn()}
      {...over}
    />
  )
}

describe('CredentialPool', () => {
  it('序号画出来 —— 「第 1 条」和「最先用的那条」是同一件事', () => {
    render(credentialPool())
    expect(screen.getByText('密钥 · 2 条')).toBeTruthy()
    expect(screen.getByLabelText('把第 2 条上移')).toBeTruthy()
    // 第一条不能再上移,最后一条不能再下移。
    expect((screen.getByLabelText('把第 1 条上移') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('把第 2 条下移') as HTMLButtonElement).disabled).toBe(true)
  })

  it('冷却读数写在那一条上', () => {
    render(credentialPool())
    expect(screen.getByText(/冷却中 剩 4 分钟/)).toBeTruthy()
  })

  it('删除是两段就地确认:第一下只是变字,第二下才删', () => {
    const onRemove = vi.fn()
    render(credentialPool({ onRemove }))
    const del = screen.getByLabelText('删除第 1 条')
    fireEvent.click(del)
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.getByText('真删?')).toBeTruthy()
    fireEvent.click(del)
    expect(onRemove).toHaveBeenCalledWith('e0')
  })

  it('最后一条:钮禁掉并说清理由 —— 禁用的钮自己不会解释自己', () => {
    render(
      credentialPool({
        pool: pool({ rows: [pool().rows[0]], canDelete: false }),
      }),
    )
    expect((screen.getByLabelText('删除第 1 条') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/最后一条不能删/)).toBeTruthy()
  })

  it('换密钥打的是**那一条**的 entryId', () => {
    const onReplace = vi.fn()
    render(credentialPool({ onReplace }))
    fireEvent.click(screen.getAllByRole('button', { name: '换密钥' })[1])
    fireEvent.change(screen.getByLabelText('给第 2 条换一把密钥'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onReplace).toHaveBeenCalledWith('e1', 'sk-x')
  })

  it('每一档策略都带一句语义说明 —— 三个名字单看字面分不出来', () => {
    render(credentialPool())
    expect(screen.getByText(/从上往下取第一条可用的/)).toBeTruthy()
  })

  it('插件策略不可用:仍然显示它、并说清正在用什么顶着', () => {
    render(credentialPool({ pool: pool({ policy: 'plugin:x:round', policyUnavailable: true }) }))
    // 选择器里必须有一格能显示它,否则会画成空白、看起来像没设过。
    expect(screen.getByLabelText('轮换策略').textContent).toContain('plugin:x:round(不可用)')
    expect(screen.getByText(/正在用内置的「按序接力」/)).toBeTruthy()
    // 认不出的策略没有语义句可说 —— 不编一句。
    expect(screen.queryByText(/从上往下取第一条可用的/)).toBeNull()
  })

  it('OAuth 那一条没有「换密钥」—— 它的换法是重新授权', () => {
    render(
      credentialPool({
        pool: pool({
          rows: [
            {
              id: 'o0',
              ordinal: 1,
              label: '',
              authType: 'oauth',
              oauthAccount: 'me@example.com',
              source: 'oauth',
              cooling: false,
            },
          ],
          canDelete: false,
        }),
      }),
    )
    expect(screen.getByText('me@example.com')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '换密钥' })).toBeNull()
  })
})

/* ── 登录卡 ──────────────────────────────────────────────────────────────── */

function oauth(over: Partial<Parameters<typeof OAuthCard>[0]> = {}) {
  return (
    <OAuthCard
      status={undefined}
      flow={IDLE_AUTH_FLOW}
      accounts={0}
      onSignIn={vi.fn()}
      onCode={vi.fn()}
      onSubmitCode={vi.fn()}
      onCancel={vi.fn()}
      onSignOut={vi.fn()}
      {...over}
    />
  )
}

describe('OAuthCard', () => {
  it('没登录:一颗真的登录钮 + 说明这是什么', () => {
    render(oauth())
    expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText(/不产生额外 API 费用/)).toBeTruthy()
  })

  it('设备码流:大字码 + 验证网址 + 等待句 + 取消', () => {
    render(
      oauth({
        flow: {
          ...IDLE_AUTH_FLOW,
          kind: 'device',
          device: { userCode: 'XKCD-2048', verificationUri: 'https://x.ai/device' },
        },
      }),
    )
    expect(screen.getByText('XKCD-2048')).toBeTruthy()
    expect(screen.getByText('https://x.ai/device')).toBeTruthy()
    expect(screen.getByText(/本页自动接续/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消登录' })).toBeTruthy()
  })

  it('贴码流:显示**后端原话**的说明,提交走 onSubmitCode', () => {
    const onSubmitCode = vi.fn()
    render(
      oauth({
        flow: {
          ...IDLE_AUTH_FLOW,
          kind: 'paste',
          code: 'abc',
          paste: { state: 's', instructions: '去浏览器里把码抄回来' },
        },
        onSubmitCode,
      }),
    )
    expect(screen.getByText('去浏览器里把码抄回来')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(onSubmitCode).toHaveBeenCalled()
  })

  it('失败显示**服务商原话**,不换成一句「登录失败」', () => {
    render(oauth({ flow: { ...IDLE_AUTH_FLOW, kind: 'browser', error: 'invalid_grant: 码过期了' } }))
    expect(screen.getByText('invalid_grant: 码过期了')).toBeTruthy()
  })

  it('已登录:账号 / 套餐 / 令牌状态 / 有效期 / 退出', () => {
    render(
      oauth({
        status: {
          success: true,
          isLoggedIn: true,
          expiresAt: new Date(2026, 7, 31, 9, 12).getTime(),
          account: { email: 'me@example.com', planType: 'Max' },
        },
        accounts: 1,
      }),
    )
    expect(screen.getByText('me@example.com')).toBeTruthy()
    expect(screen.getByText('套餐 Max')).toBeTruthy()
    expect(screen.getByText(/令牌有效 · 有效期至 08-31 09:12/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '退出 me@example.com' })).toBeTruthy()
    expect(screen.getByText('这一坑支持多账号 · 现有 1 个')).toBeTruthy()
  })

  /** 「登过但过期」说成「未登录」= 让人再走一遍完整登录流。 */
  it('过期:说的是「需要重新授权」,不是「未登录」', () => {
    render(oauth({ status: { success: true, isLoggedIn: true, isExpired: true } }))
    expect(screen.getByText(/令牌已过期,需要重新授权/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新授权' })).toBeTruthy()
  })
})

/* ── 用量卡 ──────────────────────────────────────────────────────────────── */

describe('UsageCard', () => {
  it('套餐 / Credits / 主次窗口 % 与重置时刻', () => {
    render(
      <UsageCard
        status="ready"
        onRefresh={vi.fn()}
        usage={{
          success: true,
          providerId: 'codex',
          usage: {
            planType: 'Plus',
            credits: { hasCredits: true, unlimited: true },
            limits: [
              {
                id: 'codex',
                primary: { usedPercent: 34, windowSeconds: 5 * 3600, resetAt: new Date(2026, 7, 31, 16, 0).getTime() },
                secondary: { usedPercent: 12, windowSeconds: 7 * 86_400 },
              },
            ],
          },
        }}
      />,
    )
    expect(screen.getByText('Plus')).toBeTruthy()
    expect(screen.getByText('Unlimited')).toBeTruthy()
    expect(screen.getByText('Primary · 5h 窗口')).toBeTruthy()
    expect(screen.getByText('34%')).toBeTruthy()
    expect(screen.getByText('08-31 16:00 重置')).toBeTruthy()
    expect(screen.getByText('Secondary · 7d 窗口')).toBeTruthy()
  })

  /** 0% 是「一点没用」,缺席是「不知道」—— 在屏幕上长得像,在事实上差得远。 */
  it('拿不到百分比:说「服务商未给数」,**不画一根 0 宽的条**', () => {
    const { container } = render(
      <UsageCard
        status="ready"
        onRefresh={vi.fn()}
        usage={{
          success: true,
          providerId: 'codex',
          usage: { limits: [{ id: 'codex', primary: { usedPercent: Number.NaN } }] },
        }}
      />,
    )
    expect(screen.getAllByText('服务商未给数').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[class*="meterFill"]')).toHaveLength(0)
  })

  it('刷新那颗钮绕过缓存', () => {
    const onRefresh = vi.fn()
    render(
      <UsageCard
        status="ready"
        onRefresh={onRefresh}
        usage={{ success: true, providerId: 'codex', usage: { limits: [] } }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.getByText('60s 缓存')).toBeTruthy()
  })
})

/* ── 自定义家 ────────────────────────────────────────────────────────────── */

describe('CustomProviderDialog', () => {
  function dialog(over: Partial<Parameters<typeof CustomProviderDialog>[0]> = {}) {
    return (
      <CustomProviderDialog
        open
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        {...over}
      />
    )
  }

  it('必填在**提交时**才拦,不在打字时报红', () => {
    const onSave = vi.fn()
    render(dialog({ onSave }))
    expect(screen.queryByText('名称必填')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('名称必填')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('填齐必填才交出去', () => {
    const onSave = vi.fn()
    render(dialog({ onSave }))
    fireEvent.change(screen.getByLabelText('名称 · 必填'), { target: { value: '我的 vLLM' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('Base URL 必填')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Base URL · 必填'), {
      target: { value: 'http://192.168.1.8:8000/v1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: '我的 vLLM', baseUrl: 'http://192.168.1.8:8000/v1', apiType: 'openai' }),
    )
  })

  it('改一家时才有删除钮,而且是两段确认', () => {
    const onDelete = vi.fn()
    render(
      dialog({
        editingId: 'custom-1',
        initial: {
          name: 'vLLM',
          description: '',
          apiType: 'openai',
          baseUrl: 'http://x/v1',
          apiKey: '',
          model: '',
        },
        onDelete,
      }),
    )
    const del = screen.getByRole('button', { name: '删除这一家' })
    fireEvent.click(del)
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /真删/ }))
    expect(onDelete).toHaveBeenCalled()
  })

  it('新建时没有删除钮 —— 还不存在的东西删不了', () => {
    render(dialog())
    expect(screen.queryByRole('button', { name: '删除这一家' })).toBeNull()
  })
})

/* ── 计费档位 ────────────────────────────────────────────────────────────── */

describe('ModeCard · 计费档位', () => {
  function mode(providerId: string): ProviderMode {
    return {
      providerId,
      kind: 'api',
      name: providerId,
      requiresApiKey: true,
      requiresOAuth: false,
      defaultBaseUrl: 'https://api.test/v1',
    }
  }

  function modeCard(providerId: string, config?: Record<string, unknown>) {
    return (
      <ModeCard
        mode={mode(providerId)}
        config={config as never}
        saving={false}
        pool={pool({ rows: [], canDelete: false })}
        poolBusy={false}
        onAddKey={vi.fn()}
        onReplaceKey={vi.fn()}
        onRemoveKey={vi.fn()}
        onMoveKey={vi.fn()}
        onRotation={vi.fn()}
        onDials={vi.fn()}
        authStatus={undefined}
        authFlow={IDLE_AUTH_FLOW}
        onSignIn={vi.fn()}
        onAuthCode={vi.fn()}
        onSubmitAuthCode={vi.fn()}
        onCancelAuth={vi.fn()}
        onSignOut={vi.fn()}
        usage={undefined}
        usageStatus="idle"
        onRefreshUsage={vi.fn()}
      />
    )
  }

  it('没有旋钮的家一格都不画', () => {
    render(modeCard('claude'))
    expect(screen.queryByLabelText('Qwen API mode')).toBeNull()
  })

  it('千问:计费方式 + 版本 + 风险原话', () => {
    render(modeCard('qwen'))
    expect(screen.getByLabelText('Qwen API mode')).toBeTruthy()
    expect(screen.getByLabelText('Qwen region')).toBeTruthy()
    expect(
      screen.getByText('订阅用户必须选对档位。用通用 Key 和地址调用会走按量计费，在订阅之外额外扣钱。'),
    ).toBeTruthy()
  })

  it('Kimi 选了编程套餐时**版本那一行整行收起**,不留一个拨了不动的选择器', () => {
    render(modeCard('kimi', { kimiApiMode: 'standard' }))
    expect(screen.getByLabelText('Kimi region')).toBeTruthy()

    render(modeCard('kimi', { kimiApiMode: 'coding-plan' }))
    expect(screen.queryAllByLabelText('Kimi region')).toHaveLength(1)
  })

  it('拨一格:档位与 baseUrl 一起交出去', () => {
    const onDials = vi.fn()
    render(
      <ModeCard
        mode={mode('zhipu')}
        config={undefined}
        saving={false}
        pool={pool({ rows: [], canDelete: false })}
        poolBusy={false}
        onAddKey={vi.fn()}
        onReplaceKey={vi.fn()}
        onRemoveKey={vi.fn()}
        onMoveKey={vi.fn()}
        onRotation={vi.fn()}
        onDials={onDials}
        authStatus={undefined}
        authFlow={IDLE_AUTH_FLOW}
        onSignIn={vi.fn()}
        onAuthCode={vi.fn()}
        onSubmitAuthCode={vi.fn()}
        onCancelAuth={vi.fn()}
        onSignOut={vi.fn()}
        usage={undefined}
        usageStatus="idle"
        onRefreshUsage={vi.fn()}
      />,
    )
    // Select 是自绘的 combobox 而不是原生 <select>:先点开触发器,再点那一格。
    fireEvent.click(screen.getByLabelText('Zhipu API mode'))
    fireEvent.click(screen.getByRole('option', { name: 'Coding Plan' }))
    expect(onDials).toHaveBeenCalledWith('coding-plan', '')
  })
})
