import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NoWorkdirNotice } from '../NoWorkdirNotice'
import { t } from '../../../i18n'
import { useSessionsSource } from '../../../data/sessions-source'

/**
 * 绑定行收编 `ui/Field` 的横排档(09-02 批 10,结掉 9d 留的那笔账)。
 *
 * 这个文件只判**收编换来的那几格**,行为那一半照旧由 `content/__tests__/files-panel`
 * 与 `files-splits` 两处的既有用例钉着(它们按 `files-bind-row` 这块名牌找人 ——
 * 名牌能留在根上,靠的正是 Field 那个透传口子,所以这里也顺手断一条)。
 */

const SESSION = 'sess-1'

describe('NoWorkdirNotice · 绑定行的 Field 横排档', () => {
  beforeEach(() => {
    useSessionsSource.setState({ setWorkingDirectory: vi.fn(async () => ({ ok: true as const })) })
  })

  function openBindRow() {
    render(<NoWorkdirNotice sessionId={SESSION} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: t('files.bind') }))
  }

  /**
   * ① 名字。从前这一行走的是 `aria-label`(一句只存在于属性里的字符串);
   * 现在是一条真 `<label htmlFor>`,只念不看。
   * 反证:摘掉 `labelHidden` 红在类名那条;摘掉 `{...field}` 红在 `for` 那条。
   */
  it('名字走一条只念不看的真 label —— 点标签也能聚焦,读屏软件照旧念得出', () => {
    openBindRow()
    const input = screen.getByRole('textbox', {
      name: t('files.bindPlaceholder'),
    }) as HTMLInputElement
    const label = document.querySelector(`label[for="${input.id}"]`) as HTMLLabelElement
    expect(label.className).toBe('visually-hidden')
    expect(label.textContent).toBe(t('files.bindPlaceholder'))
  })

  /** ② 形由库件给。反证:摘掉 `layout="inline"` 当场红。 */
  it('形由 Field 的横排档给,名牌 data-testid 仍落在同一个根上', () => {
    openBindRow()
    const row = screen.getByTestId('files-bind-row')
    expect(row.className).toMatch(/_inline_/)
    expect(row.querySelector('label')).toBeTruthy()
  })

  /** ③ 焦点:一出现就把光标放进去(从前是壳上的回调 ref,现在按 Field 给的 id 找)。 */
  it('一出现就把光标放进那个输入框', () => {
    openBindRow()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  /**
   * ④ 9d 留的那笔账:错误那一句从前**没有**跟输入框关联,读屏软件读得到边线转红
   * 却读不到原因。断的是关联,不是文字在不在 —— 「文字在不在」既有用例已经绿了,
   * 对手写 `<span>` 也绿,而这一条不会。
   * 反证:把 `error={…}` 从 `<Field>` 上摘掉、改回自己画一个 span,当场红。
   */
  it('绑不上:错误经 error 槽关联到输入框(aria-describedby + aria-invalid)', async () => {
    useSessionsSource.setState({
      setWorkingDirectory: vi.fn(async () => ({ ok: false as const, error: 'sandbox root' })),
    })
    openBindRow()
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/nope' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.confirm') }))

    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'))
    const describedBy = input.getAttribute('aria-describedby') as string
    const errorNode = document.getElementById(describedBy) as HTMLElement
    // 一句话在前、后端原话跟在后面 —— 两段仍在同一格里。
    expect(errorNode.textContent).toBe(`${t('files.bindFailed')}sandbox root`)
  })
})
