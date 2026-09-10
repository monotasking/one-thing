import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PermissionCard } from '../PermissionCard'
import type { PermissionAsk } from '../../../data/permission-ask'
import { t } from '../../../i18n'

/**
 * **权限卡**(应用级许可 · 壳半边,2026-09-10)。
 *
 * 钉住的是那张「交互状态表」的第三列:**哪几个键在场**。它由三格事实决定,
 * 一格一条判据:
 *   · `permissionQueued`  → 一个键都没有(排队中,轮不到这一面答);
 *   · 这一类效果记不记得住 → 「本会话」「本工作目录」两键在不在
 *     (`capability_change` 是 `never-grantable`,而核里 `respond('session')`
 *     那一支直接落到会抛的 `addGrant`);
 *   · `alwaysScope`       → 第四键在不在,以及它的文案带不带 scheme。
 *
 * 反证 ①(派工令):拆掉第四键的 `alwaysScope` 条件 → 「无 alwaysScope 四键」红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))

const ASK: PermissionAsk = {
  toolCallId: 'call-1',
  permissionId: 'req-1',
  title: 'Remove session content: session:s1',
  type: 'session_destructive',
  pattern: 'session:s1',
  alwaysScope: { scheme: 'session' },
  permissionQueued: false,
  canRespond: true,
}

function mount(over: Partial<PermissionAsk> = {}) {
  const onRespond = vi.fn()
  const view = render(<PermissionCard ask={{ ...ASK, ...over }} onRespond={onRespond} />)
  return { onRespond, view }
}

const keyNames = () => screen.queryAllByRole('button').map((el) => el.textContent)

describe('权限卡:五个键与它们各自的出现条件', () => {
  it('可授权 + alwaysScope 在场 = 五个键,第四键文案带 scheme', () => {
    mount()
    expect(keyNames()).toEqual([
      t('permission.allowOnce'),
      t('permission.allowSession'),
      t('permission.allowWorkdir'),
      t('permission.allowAlways', { app: 'session' }),
      t('permission.reject'),
    ])
    // 文案带 scheme 不是靠字符串包含碰运气 —— 那颗键身上有它自己的地址。
    expect(
      screen
        .getByRole('button', { name: t('permission.allowAlways', { app: 'session' }) })
        .getAttribute('data-permission-always'),
    ).toBe('session')
  })

  it('**反证 ①**:`alwaysScope` 缺席 = 四个键,第四键整个不画', () => {
    mount({ alwaysScope: undefined })
    expect(keyNames()).toEqual([
      t('permission.allowOnce'),
      t('permission.allowSession'),
      t('permission.allowWorkdir'),
      t('permission.reject'),
    ])
    expect(screen.queryByTestId('permission-always')).toBeNull()
    expect(document.querySelector('[data-permission-always]')).toBeNull()
  })

  it('`capability_change`(核里永不可授)只剩「允许一次」与「拒绝」', () => {
    // alwaysScope 也一并缺席 —— 后端的 `alwaysScopeOf` 第一句就是可授权判据,
    // 所以真机上这两件事同进同出;这里照那个事实摆夹具。
    mount({ type: 'capability_change', alwaysScope: undefined })
    expect(keyNames()).toEqual([t('permission.allowOnce'), t('permission.reject')])
  })

  it('排队中:一个键都没有,只有一句实话', () => {
    mount({ permissionQueued: true, canRespond: false })
    expect(keyNames()).toEqual([])
    expect(screen.getByText(t('permission.queued'))).toBeTruthy()
  })

  it('已答:键全部收起,换成「等核心确认」那一句(允许 / 拒绝两句分得开)', () => {
    const { view } = mount({ canRespond: false, answered: 'always' })
    expect(keyNames()).toEqual([])
    expect(screen.getByText(t('permission.answeredAllow'))).toBeTruthy()
    view.rerender(
      <PermissionCard ask={{ ...ASK, canRespond: false, answered: 'reject' }} onRespond={vi.fn()} />,
    )
    expect(screen.getByText(t('permission.answeredReject'))).toBeTruthy()
  })

  it('点一下 = 一次应答,带的是这张卡的 toolCallId 与那一档', () => {
    const { onRespond } = mount()
    screen
      .getByRole('button', { name: t('permission.allowAlways', { app: 'session' }) })
      .click()
    expect(onRespond).toHaveBeenCalledWith('call-1', 'always')
  })
})

describe('权限卡:无障碍', () => {
  it('是一个说得出「在等什么」的 group', () => {
    mount()
    const group = screen.getByRole('group', {
      name: t('permission.waiting', { title: ASK.title }),
    })
    expect(group.getAttribute('data-permission-card')).toBe('call-1')
  })

  it('排队中说的是另一句(它不是在等这个人答)', () => {
    mount({ permissionQueued: true, canRespond: false })
    expect(
      screen.getByRole('group', { name: t('permission.queuedLabel', { title: ASK.title }) }),
    ).toBeTruthy()
  })

  it('接了响应链:根上带 `data-focus-scope="permission"`,owner = 这次调用', () => {
    mount()
    const root = document.querySelector('[data-focus-scope="permission"]')
    expect(root).toBeTruthy()
    expect(root?.getAttribute('data-permission-card')).toBe('call-1')
  })

  it('**一行焦点代码都没有**:零 keydown、零 `.focus()`(响应链 I2 / I3)', () => {
    const source = readFileSync(path.join(here, '..', 'PermissionCard.tsx'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(source).not.toMatch(/addEventListener|onKeyDown|\.focus\(\)/)
  })
})

describe('权限卡:真机门那一屏**声明在册**', () => {
  /*
   * 这条不跑门,它守的是**声明还在不在**(与 `ui/__tests__/tabs-preview.test.tsx`
   * 那条逐字同判例)。权限卡在 jsdom 里能证的只有「名字说得对」;「一张真的卡
   * 在真的排版下 axe 干净」只有真机说得出来,而那一句今天挂在 `gate:a11y` 的
   * 权限卡那一屏上 —— 断言被顺手删掉的话,这件事就没有真机那一半在守了。
   */
  it('`gate:a11y` 里有权限卡那一屏', () => {
    const gate = readFileSync(
      path.join(here, '..', '..', '..', '..', 'scripts', 'gate-a11y.mjs'),
      'utf8',
    )
    expect(gate).toContain('[data-permission-card]')
    expect(gate).toContain('权限卡')
  })
})
