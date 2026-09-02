/**
 * `OnethingHostPorts` 的**类型门**(A1)。
 *
 * 这张表的全部价值在一句话上:**漏写一项是编译错误,不是运行期某个能力静默变成
 * 降级路。** 那句话是 `tsc` 保证的,不是 vitest —— 所以这份文件的断言写在类型层,
 * 由 `bun run typecheck`(`tsconfig.node.json` 的 include 覆盖
 * `packages/backend/**`)执行:`@ts-expect-error` 那几行**必须**报错,否则 tsc
 * 自己会红("Unused '@ts-expect-error' directive")。
 *
 * 文件名以 `.test.ts` 结尾,于是 vitest 也收它;里面那条 `it` 只是让这份文件在
 * 测试报告里留个名,真正的判据在它上面的类型层。
 */
import { describe, expect, it } from 'vitest'
import { applyHostPorts, type OnethingHostPorts } from '../host-ports.js'

/** 十四项写全 = 合法。这也是四个宿主(与冒烟探针)交出来的那张表的形状。 */
const complete: OnethingHostPorts = {
  storePath: {},
  sandbox: {},
  auth: null,
  logging: null,
  shell: null,
  voice: null,
  skillsEnvironment: null,
  todoPlan: null,
  scratchpad: null,
  plugins: null,
  gateway: null,
  settings: null,
  evals: null,
  mcp: null,
}

// 缺 `voice` 一项 → 不能赋给 `OnethingHostPorts`。这就是方案要的那道门:
// "这个宿主没有语音"必须写成 `voice: null`,不能靠不写。
// @ts-expect-error 缺少必填的 `voice` 键
const missingVoice: OnethingHostPorts = {
  storePath: {},
  sandbox: {},
  auth: null,
  logging: null,
  shell: null,
  skillsEnvironment: null,
  todoPlan: null,
  scratchpad: null,
  plugins: null,
  gateway: null,
  settings: null,
  evals: null,
  mcp: null,
}

// `storePath` / `sandbox` 是**不可 null** 的两项(没有它们连 store 与工具沙箱的
// 边界都没法回答);"无话可说"写成 `{}`,不是 `null`。
// @ts-expect-error `storePath` 不接受 null
const nullStorePath: OnethingHostPorts = { ...complete, storePath: null }
// @ts-expect-error `sandbox` 不接受 null
const nullSandbox: OnethingHostPorts = { ...complete, sandbox: null }

describe('OnethingHostPorts 的类型门(A1)', () => {
  it('全表可赋值,applyHostPorts 收的就是它', () => {
    expect(typeof applyHostPorts).toBe('function')
    // 三个 @ts-expect-error 的目标值在运行期只需要"被用到",判据在 tsc 那边。
    expect(complete.storePath).toBeDefined()
    expect(missingVoice).toBeDefined()
    expect(nullStorePath).toBeDefined()
    expect(nullSandbox).toBeDefined()
  })
})
