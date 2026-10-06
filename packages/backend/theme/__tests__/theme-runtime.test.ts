import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getOnethingStorePath } from '../../storage/storage.js'
import { OnethingThemeRuntime } from '../theme-runtime.js'

describe('OnethingThemeRuntime', () => {
  it('wraps theme list, lookup, and application responses', async () => {
    const runtime = new OnethingThemeRuntime()

    await expect(runtime.listThemes()).resolves.toMatchObject({
      success: true,
      themes: expect.arrayContaining([
        expect.objectContaining({ id: 'flexoki', source: 'builtin' }),
      ]),
    })

    await expect(runtime.getTheme('missing-theme')).resolves.toEqual({
      success: false,
      error: 'Theme not found: missing-theme',
    })

    const applied = await runtime.applyTheme('flexoki', 'dark')
    expect(applied.success).toBe(true)
    expect(applied.cssVariables).toEqual(expect.objectContaining({
      '--bg-app': expect.any(String),
    }))
  })

  it('answers the themes folder path (第④步批 1:打开是客户端自己的事)', () => {
    const runtime = new OnethingThemeRuntime()

    // §16.22 改判:从前这里断言路径含 `.onething` —— 那是在给"直拼 home"背书
    // (而且顺手在真机库里 mkdir 了一个 themes/)。落点收编进 store 口之后,
    // 该断言的是"它在**当前 store** 底下、名字叫 themes",而不是 store 叫什么。
    expect(runtime.themesFolderPath()).toEqual({ success: true, path: path.join(getOnethingStorePath(), 'themes') })
  })
})
