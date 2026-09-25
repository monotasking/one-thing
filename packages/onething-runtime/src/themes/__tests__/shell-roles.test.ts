import { describe, expect, it } from 'vitest'
import type { Base46Theme } from '../types.js'
import { convertBase46ToTheme } from '../base46-parser.js'
import { generateShellRoleVariables } from '../shell-roles.js'

// NvChad base46 v3.0 `themes/one_light.lua` 的 base_30(节选,原值照抄)。
const ONE_LIGHT: Base46Theme = {
  type: 'light',
  base_30: {
    white: '#54555b',
    darker_black: '#efeff0',
    black: '#fafafa',
    black2: '#EAEAEB',
    one_bg: '#dadadb',
    one_bg2: '#d4d4d5',
    one_bg3: '#cccccd',
    grey: '#b7b7b8',
    grey_fg: '#b0b0b1',
    light_grey: '#a2a2a3',
    line: '#e2e2e2',
    blue: '#4078f2',
  },
  base_16: { base00: '#fafafa', base05: '#383a42' },
} as Base46Theme

describe('壳的角色表(base46 → shellRoles)', () => {
  it('照 NvChad 的用法原样取值:画布/卡片 black、内嵌 darker_black、标签条/浮起 black2、分隔 line、墨 base05/white/light_grey', () => {
    const roles = convertBase46ToTheme(ONE_LIGHT, 'one_light').shellRoles
    expect(roles).toEqual({
      canvas: '#fafafa',
      inset: '#efeff0',
      card: '#fafafa',
      raised: '#EAEAEB',
      strip: '#EAEAEB',
      tabHover: 'transparent',
      line: '#e2e2e2',
      ink: '#383a42',
      ink2: '#54555b',
      inkWeak: '#a2a2a3',
    })
  })

  it('每一格都是 lua 里原有的颜色(悬停底是「不画」),没有算出来的值', () => {
    const roles = convertBase46ToTheme(ONE_LIGHT, 'one_light').shellRoles!
    const palette = new Set([...Object.values(ONE_LIGHT.base_30), ...Object.values(ONE_LIGHT.base_16)]
      .map(value => String(value).toLowerCase()))
    for (const [role, value] of Object.entries(roles)) {
      if (role === 'tabHover') continue
      expect(palette.has(value.toLowerCase())).toBe(true)
    }
  })

  it('缺 base_30 字段时落到 base16 同义位,再缺就沿角色兜底', () => {
    const roles = convertBase46ToTheme({ type: 'dark', base_30: {}, base_16: { base00: '#111111', base01: '#222222' } } as Base46Theme, 'x').shellRoles
    expect(roles).toMatchObject({ canvas: '#111111', inset: '#222222', strip: '#222222', line: '#222222' })
  })

  it('输出 --role-* 变量,只放行颜色字面量', () => {
    expect(generateShellRoleVariables({ canvas: '#fafafa', strip: 'red; } body { x', line: 'rgba(0, 0, 0, 0.1)' })).toEqual({
      '--role-canvas': '#fafafa',
      '--role-line': 'rgba(0, 0, 0, 0.1)',
    })
    expect(generateShellRoleVariables(undefined)).toEqual({})
  })
})
