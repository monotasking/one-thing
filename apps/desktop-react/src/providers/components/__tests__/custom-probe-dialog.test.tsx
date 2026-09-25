import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ProbeCustomProviderResponse } from '@shared/ipc/providers'
import { useStageStore } from '../../../stage/store'
import { CustomProviderDialog } from '../CustomProviderDialog'
import type { CustomProviderForm } from '../../store'

/**
 * 批 4 §7.3 ⑤:对话框的「自动识别」。钮在接口地址填了之后才可按;跑时忙态;结果一句话 +
 * [应用];失败一句「识别失败」;**应用才把适配表放进表单**,保存才交出去;手改接口类型会清掉它。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

const SPEC = {
  version: 1 as const,
  wire: 'openai-chat' as const,
  response: { reasoningDeltaPath: 'choices[0].delta.reasoning' },
}
const OK: ProbeCustomProviderResponse = {
  ok: true,
  analyzed: true,
  spec: SPEC,
  summary: {
    wireLabelKey: 'providers.dialect.custom-openai',
    dialect: 'custom-openai',
    reasoningPath: 'choices[0].delta.reasoning',
    modelCount: 12,
  },
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('CustomProviderDialog · 自动识别', () => {
  it('地址空着钮不可按;填了可按,跑时忙态,回来一句话', async () => {
    let release: (value: ProbeCustomProviderResponse) => void = () => {}
    const onProbe = vi.fn(() => new Promise<ProbeCustomProviderResponse>((resolve) => { release = resolve }))
    render(<CustomProviderDialog open onClose={vi.fn()} onSave={vi.fn(() => true)} onProbe={onProbe} />)
    const run = () => screen.getByTestId('custom-provider-probe-run') as HTMLButtonElement
    expect(run().disabled).toBe(true)

    fill('Base URL · 必填', 'http://relay/v1')
    fill('API 密钥 · 可空', 'sk-x')
    expect(run().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(run())
    })
    expect(onProbe).toHaveBeenCalledWith({ baseUrl: 'http://relay/v1', apiKey: 'sk-x' })
    expect(run().getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      release(OK)
    })
    expect(screen.getByTestId('custom-provider-probe-result').textContent).toBe(
      '识别为 OpenAI 兼容;思考内容在 choices[0].delta.reasoning;模型列表 12 个。',
    )
  })

  it('不点应用 = 不交出适配表;点了应用、保存才带上', async () => {
    const onSave = vi.fn((_form: CustomProviderForm) => true)
    render(<CustomProviderDialog open onClose={vi.fn()} onSave={onSave} onProbe={vi.fn(async () => OK)} />)
    fill('名称 · 必填', '转发站')
    fill('Base URL · 必填', 'http://relay/v1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-provider-probe-run'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-provider-submit'))
    })
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('adapter')

    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-provider-probe-apply'))
    })
    expect(screen.getByTestId('custom-provider-probe-apply').textContent).toBe('已应用')
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-provider-submit'))
    })
    expect(onSave.mock.calls[1]![0]).toMatchObject({ adapter: SPEC, dialect: 'custom-openai' })
  })

  it('失败:一句「识别失败」,原话进 Tooltip,没有应用钮', async () => {
    render(
      <CustomProviderDialog
        open
        onClose={vi.fn()}
        onSave={vi.fn(() => true)}
        onProbe={vi.fn(async () => ({ ok: false, reasonKind: 'verify-failed' as const, error: 'no-text: replay produced no text delta' }))}
      />,
    )
    fill('Base URL · 必填', 'http://relay/v1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-provider-probe-run'))
    })
    expect(screen.getByTestId('custom-provider-probe-result').textContent).toBe('识别失败')
    expect(screen.queryByTestId('custom-provider-probe-apply')).toBeNull()
  })

  it('没有 onProbe 就不画那一行', () => {
    render(<CustomProviderDialog open onClose={vi.fn()} onSave={vi.fn(() => true)} />)
    expect(screen.queryByTestId('custom-provider-probe')).toBeNull()
  })
})
