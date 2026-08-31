import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AsyncButton } from '../AsyncButton'
import { createMutation } from '../../data/kernel'
import { SKELETON_DELAY_MS } from '../../components/motion'

/**
 * 第 17 件基础件。守的是律③那句话的两半:
 *  ① 反馈**必有**(而且是读来的,不是调用方记的一份);
 *  ② 反馈**只加在被点的那一个上**(逐格,不是整面)。
 * 外加一条从真机报障来的:极快回来的请求不许闪一记「在办了」。
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AsyncButton', () => {
  it('点下去:**立刻** disabled + aria-busy;换字要等过了防闪闸', async () => {
    const gate = deferred<void>()
    const m = createMutation<void, void>('t.async', { run: () => gate.promise })
    render(
      <AsyncButton action={m} pendingLabel="Saving…" onClick={() => void m.run(undefined)}>
        Save
      </AsyncButton>,
    )

    const button = screen.getByRole('button')
    await act(async () => {
      button.click()
    })

    // 防误点的那一半:立刻。
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    // 防误读的那一半:还没到 150ms,字没换 —— 缓存命中的请求就在这一段里回来。
    expect(button.textContent).toBe('Save')

    await act(async () => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS + 1)
    })
    expect(button.textContent).toBe('Saving…')

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(button.textContent).toBe('Save')
  })

  it('反证:极快回来的那一发,自始至终没换过字', async () => {
    const m = createMutation<void, void>('t.async-fast', { run: async () => undefined })
    render(
      <AsyncButton action={m} pendingLabel="Saving…" onClick={() => void m.run(undefined)}>
        Save
      </AsyncButton>,
    )
    const button = screen.getByRole('button')
    await act(async () => {
      button.click()
    })
    await act(async () => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS + 1)
    })
    expect(button.textContent).toBe('Save')
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('忙态逐格:点 a 不该把 b 禁掉(律③的后半句)', async () => {
    const gate = deferred<void>()
    const m = createMutation<string, void>('t.async-key', {
      key: (id) => id,
      run: () => gate.promise,
    })
    render(
      <>
        <AsyncButton action={m} pendingKey="a" pendingLabel="…" onClick={() => void m.run('a')}>
          A
        </AsyncButton>
        <AsyncButton action={m} pendingKey="b" pendingLabel="…" onClick={() => void m.run('b')}>
          B
        </AsyncButton>
      </>,
    )
    const [a, b] = screen.getAllByRole('button')
    await act(async () => {
      a.click()
    })
    expect((a as HTMLButtonElement).disabled).toBe(true)
    expect((b as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect((a as HTMLButtonElement).disabled).toBe(false)
  })

  it('反证:同一件 mutation 不给 pendingKey 时,两颗一起禁 —— 那正是要治的病', async () => {
    const gate = deferred<void>()
    const m = createMutation<string, void>('t.async-nokey', { run: () => gate.promise })
    render(
      <>
        <AsyncButton action={m} pendingLabel="…" onClick={() => void m.run('a')}>
          A
        </AsyncButton>
        <AsyncButton action={m} pendingLabel="…" onClick={() => void m.run('b')}>
          B
        </AsyncButton>
      </>,
    )
    const [a, b] = screen.getAllByRole('button')
    await act(async () => {
      a.click()
    })
    expect((b as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
  })

  it('action 缺席:就是一颗普通钮,不炸', () => {
    render(
      <AsyncButton action={undefined} pendingLabel="…">
        Plain
      </AsyncButton>,
    )
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
  })
})
