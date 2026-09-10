/**
 * 权限应答那个联合有**三份**:核那份是产地
 * (`packages/core/permission/index.ts` 的 `Permission.Response`),另外两份是它
 * 跨进程的镜像 —— `@shared/ipc/permissions.ts` 的 `PermissionResponse`(RPC 形状)
 * 与 `@shared/events/session-commands.ts` 里 `PermissionRespondCommand.decision`
 * (命令总线上真正走的那一格)。
 *
 * 三份手抄的字面量联合,漂移是必然的:2026-09-10 加 `'always'` 那一次就要同时改
 * 三处,而漏改任何一处的症状是「壳发得出去、内核认不出来」这种只在真机上才现形的
 * 病。这只文件把它变成一次编译期红。
 *
 * 判据是**双向**赋值(`Exact`),不是单向 `extends`:单向只挡得住少一支,挡不住
 * 多一支 —— 而镜像多出一支同样是谎(壳会画一个内核答不了的键)。
 */
import { describe, expect, it } from 'vitest'
import type { Permission } from '@onething/core/permission'
import type { PermissionResponse } from '../permissions.js'
import type { PermissionRespondCommand } from '../../events/session-commands.js'

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// 两句都是编译期断言:任何一份联合漂了,`tsc` 当场红,不必等这个文件跑起来。
const rpcMirrorMatchesCore: Exact<PermissionResponse, Permission.Response> = true
const commandMirrorMatchesCore: Exact<PermissionRespondCommand['decision'], Permission.Response> = true

/**
 * 运行期只留一句:把那两个常量读一下,免得「未使用」被摇掉之后编译期断言跟着
 * 消失(那会是一道看着还在、其实已经不判任何事的门)。
 */
describe('权限应答联合的三份契约', () => {
  it('两份镜像与核逐字相同', () => {
    expect([rpcMirrorMatchesCore, commandMirrorMatchesCore]).toEqual([true, true])
  })
})
