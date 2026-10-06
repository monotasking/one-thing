/**
 * 决策 D14:不带界面的后端进程的桌面档(`ONETHING_BACKEND_LAUNCHER=desktop`)与桌面今天进程内装配的那一份,
 * 装配开关必须逐格相同 —— 批 2b 起桌面拉起那台进程顶替自己,开关差一格就是一项能力悄悄没了
 * (不开 `collab` 协作会话发不出话,不开 `pets` 栖位读不到 `pet:`)。
 *
 * 两边各读各的产地:桌面这边是 `main.ts` 的 `assembleOwnCore` 摊开的 `OWN_CORE_ASSEMBLY_SWITCHES`,后端那边是
 * `backend-launcher.ts` 的桌面档案。另外钉一条「`main.ts` 真的摊开了它」:那只文件 import 就要 electron,测试加载
 * 不了,所以读源文本 —— 少了这一条,有人把字面量抄回 `main.ts` 再改一格,这里照样绿。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { backendLaunchProfile } from '@onething/backend/backend-launcher.js'
import { OWN_CORE_ASSEMBLY_SWITCHES } from '../own-core-options.js'

describe('desktop assembly switches (D14)', () => {
  it('the backend process desktop launcher assembles with exactly the switches the desktop uses today', () => {
    expect(backendLaunchProfile('desktop', {}).assembly).toEqual(OWN_CORE_ASSEMBLY_SWITCHES)
  })

  it('ignores ONETHING_SERVER_TOOLS=readonly on the desktop launcher (the desktop is always full)', () => {
    expect(backendLaunchProfile('desktop', { ONETHING_SERVER_TOOLS: 'readonly' }).assembly).toEqual(OWN_CORE_ASSEMBLY_SWITCHES)
  })

  it('main.ts assembles its own core by spreading these switches, not by a second copy of the literals', () => {
    const source = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8')
    // 剥掉注释再判:注释里提到 `sessionSkills: true` 这类话不算一格开关。
    const body = source
      .slice(source.indexOf('async function assembleOwnCore'), source.indexOf('function startPostWindowServices'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(body).toContain('...OWN_CORE_ASSEMBLY_SWITCHES')
    for (const key of Object.keys(OWN_CORE_ASSEMBLY_SWITCHES)) {
      expect(body, `assembleOwnCore 里不许再写 ${key}:(会盖掉摊开的那一格)`).not.toMatch(new RegExp(`\\b${key}\\s*:`))
    }
  })
})
