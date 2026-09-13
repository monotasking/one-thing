import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { configureHomeDirPort, useHomeDir } from '../home-dir'

/**
 * 家目录那一格宿主事实。钉的是**拿到之前是 `null`**(= 不缩,不闪)以及
 * 「问一次就够」—— 它是一个进程一生不变的常量,不是一格会被标脏的 query。
 */
function Probe() {
  const home = useHomeDir()
  return <span data-testid="home">{home ?? '(none)'}</span>
}

afterEach(() => {
  // 回到 `src/test/setup.ts` 装的那一份(答 null)。
  configureHomeDirPort({ get: async () => null })
})

describe('useHomeDir', () => {
  it('拿到之前是 null,拿到之后是那条路径', async () => {
    let settle: ((value: string | null) => void) | undefined
    configureHomeDirPort({
      get: () =>
        new Promise<string | null>((resolve) => {
          settle = resolve
        }),
    })

    render(<Probe />)
    // 还在飞:不缩。**不闪**的那一半 —— 屏上先是全路径,不是先猜一个 `~`。
    expect(screen.getByTestId('home').textContent).toBe('(none)')

    await act(async () => {
      settle?.('/Users/me')
    })
    expect(screen.getByTestId('home').textContent).toBe('/Users/me')
  })

  it('答不出来(宿主不可信 / 拿不到)就一直是 null', async () => {
    configureHomeDirPort({ get: async () => null })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('home').textContent).toBe('(none)'))
  })

  /** 端口**抛**了也只是「不缩」—— 一句提示里少两个字不值得炸一条路。 */
  it('端口抛了不炸,落回 null', async () => {
    configureHomeDirPort({
      get: async () => {
        throw new Error('no core')
      },
    })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('home').textContent).toBe('(none)'))
  })

  it('多个消费者只问一次 —— 它是常量,不是 query', async () => {
    let asked = 0
    configureHomeDirPort({
      get: async () => {
        asked += 1
        return '/Users/me'
      },
    })
    render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>,
    )
    await waitFor(() => expect(screen.getAllByTestId('home')[0]?.textContent).toBe('/Users/me'))
    expect(asked).toBe(1)
  })
})
