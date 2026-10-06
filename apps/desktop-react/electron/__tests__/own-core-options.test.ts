/**
 * 决策 D14:桌面拉起的后端(不带界面的后端进程的桌面档,`ONETHING_BACKEND_LAUNCHER=desktop`)与桌面从前进程内
 * 装配的那一份,装配开关必须逐格相同 —— 开关差一格就是一项能力悄悄没了。
 *
 * 第④步批 2b 起 `main.ts` 不再装配,从前那条「`main.ts` 真的摊开了它」的源文本用例随 `assembleOwnCore` 一起删了;
 * 「桌面拉起的确实是桌面档」那一半钉在 `backend-process.test.ts`(子进程环境里的 `ONETHING_BACKEND_LAUNCHER`)。
 */
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
})
