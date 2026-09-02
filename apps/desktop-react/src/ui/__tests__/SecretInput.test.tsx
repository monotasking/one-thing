import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SecretInput } from '../SecretInput'

/**
 * `ui/SecretInput` 的门。五条性质,每条对着文件头里的一句规格:
 *   · 挂载恒是**暗**的(它常常长在别人能看见的屏幕上);
 *   · 眼睛钮切明暗,`aria-pressed` 报的就是明暗;
 *   · 那颗钮**不藏在 `aria-hidden` 里**(axe 的 aria-hidden-focus 那一条);
 *   · 禁用跟着输入框一起禁;
 *   · 值与透传的 aria 一格不少地落到真 `<input>` 上。
 */
function Harness({ disabled }: { disabled?: boolean } = {}) {
  const [value, setValue] = useState('sk-secret')
  return (
    <SecretInput
      aria-label="密钥"
      value={value}
      onValueChange={setValue}
      disabled={disabled}
      revealLabel="显示密钥"
      hideLabel="隐藏密钥"
    />
  )
}

describe('SecretInput', () => {
  it('挂载恒是暗的 —— 一格刚长出来的密钥框不该是明文', () => {
    render(<Harness />)
    expect((screen.getByLabelText('密钥') as HTMLInputElement).type).toBe('password')
    expect(screen.getByRole('button', { name: '显示密钥' })).toBeTruthy()
  })

  it('眼睛钮切明暗,aria-pressed 报的就是明暗', () => {
    render(<Harness />)
    const eye = screen.getByRole('button', { name: '显示密钥' })
    expect(eye.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(eye)
    expect((screen.getByLabelText('密钥') as HTMLInputElement).type).toBe('text')
    const hide = screen.getByRole('button', { name: '隐藏密钥' })
    expect(hide.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(hide)
    expect((screen.getByLabelText('密钥') as HTMLInputElement).type).toBe('password')
  })

  it('那颗钮不藏在 aria-hidden 的壳里 —— 藏着的可聚焦元素正是 axe 判红的那一条', () => {
    const { container } = render(<Harness />)
    const eye = screen.getByRole('button', { name: '显示密钥' })
    for (let node = eye.parentElement; node && node !== container; node = node.parentElement) {
      expect(node.getAttribute('aria-hidden')).not.toBe('true')
    }
  })

  it('禁用跟着输入框一起禁 —— 一格禁掉的密码框还能被看一眼是说不通的', () => {
    render(<Harness disabled />)
    expect((screen.getByLabelText('密钥') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '显示密钥' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('值与透传的 aria 落在真 <input> 上', () => {
    render(<Harness />)
    const box = screen.getByLabelText('密钥') as HTMLInputElement
    expect(box.value).toBe('sk-secret')
    fireEvent.change(box, { target: { value: 'sk-next' } })
    expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('sk-next')
  })
})
