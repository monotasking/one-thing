/**
 * R2a —— `permissionGuard` 派生投影的钉子(设计文档 §10.2-③ / §11.2 / §12.3)。
 *
 * 六格逐字钉住:派生值必须等于旧工具身上那个字符串(R4b 之前是从旧工具对象上
 * 现读的,旧树删掉之后那五个值**写死在 CASES 里**)。这是"概念消失但契约不变"
 * 这句话唯一能被验证的地方 —— 一旦某一格漂移,设置页与 provider 注入面就会悄悄
 * 换一副面孔。
 *
 * **R3a 复盘裁定后有一格是有意不同的**:variable。它旧的 `'safe'` 与它自己
 * `analyze` 报的 `capability_change`(never-grantable)自相矛盾,是旧树的一个
 * bug;派生表按真相给 `permission-gated`。这一格因此显式写出**两个**值,
 * 而不是把不一致藏进一个通过的断言里。
 */

import { describe, expect, it } from 'vitest'
import {
  BashTool,
  EditTool,
  ReadTool,
  TimeTool,
  VariableTool,
  WriteTool,
} from '@onething/runtime/toolkit'
import { EFFECT_POLICY } from '@onething/core/toolkit'
import { deriveLegacyPermissionGuard } from '../guard-projection.js'

/** `expected` = 旧工具身上那个 `permissionGuard` 字符串,逐字冻在这里。 */
const CASES = [
  { id: 'read', spec: new ReadTool({}).spec, expected: 'sandboxed' },
  { id: 'write', spec: new WriteTool({ getFileMutationsDir: () => '/tmp' }).spec, expected: 'permission-gated' },
  { id: 'edit', spec: new EditTool({ getFileMutationsDir: () => '/tmp' }).spec, expected: 'permission-gated' },
  {
    id: 'bash',
    spec: new BashTool({ getToolOutputsDir: () => '/tmp', createOperations: () => ({ exec: async () => ({ exitCode: 0 }) }) }).spec,
    expected: 'internal-check',
  },
  { id: 'time', spec: new TimeTool().spec, expected: 'safe' },
] as const

/**
 * 唯一一格**有意与旧值不同**的:variable。分开写而不是塞进 CASES,是为了让
 * "旧值是什么"和"新值是什么"各自有一句话,而不是靠一个通过的断言把不一致藏起来。
 */
const VARIABLE_SPEC = new VariableTool({
  getRegistry: () => ({
    list: () => [],
    set: () => ({ name: 'x', value: '' }),
    append: () => ({ name: 'x', value: '' }),
    remove: () => ({ name: 'x', value: '' }),
    delete: () => {},
  }),
}).spec

describe('deriveLegacyPermissionGuard', () => {
  for (const item of CASES) {
    it(`${item.id}: 派生值等于旧工具的 permissionGuard(${item.expected})`, () => {
      expect(deriveLegacyPermissionGuard(item.spec)).toBe(item.expected)
    })
  }

  it('variable: 旧值 safe 是旧树 bug,派生按真相给 permission-gated(修复,不是回归)', () => {
    // 旧值(已随旧树删除):'safe'。
    expect(VARIABLE_SPEC.effects).toEqual(['capability_change'])
    expect(deriveLegacyPermissionGuard(VARIABLE_SPEC)).toBe('permission-gated')
    // 无行为影响:两个值在这两张表里同权,而 canAutoExecute 今天没有调用方。
    expect(EFFECT_POLICY.capability_change.policy).toBe('never-grantable')
  })

  /**
   * R3a 复盘裁定:按**真相**派生。
   *
   * `capability_change` 是 core `NEVER_GRANTABLE_TYPES` 里唯一的成员(每次都问、
   * 答案永不可记住),它不可能同时是 `safe` —— 那两句话直接互斥。
   *
   * **这是修复,不是回归。** variable 旧的 `permissionGuard: 'safe'` 与它 `analyze`
   * 报的 `capability_change` 本来就自相矛盾,是旧树的一个 bug;而这个字符串的两个
   * 读者(`isInjectablePermissionGuard` / `isAutoExecutePermissionGuard`)对
   * `safe/sandboxed/internal-check/permission-gated` 四个值一视同仁,`canAutoExecute`
   * 今天更是**没有任何调用方** —— 所以改这一格**没有行为影响**,执行期照旧走
   * never-grantable 的权限卡。
   */
  it('capability_change 按真相派生 permission-gated(never-grantable 不可能是 safe)', () => {
    expect(deriveLegacyPermissionGuard({ effects: ['capability_change'] })).toBe('permission-gated')
    // variable 的静态上界就是这一条 —— 它的派生值随之变成 permission-gated。
    expect(deriveLegacyPermissionGuard({ effects: ['capability_change'] })).not.toBe('safe')
  })

  it('更强的一档赢:既跑命令又改文件 → permission-gated', () => {
    expect(deriveLegacyPermissionGuard({ effects: ['bash', 'file_write'] })).toBe('permission-gated')
  })

  it('MCP 与开新会话都归 permission-gated', () => {
    expect(deriveLegacyPermissionGuard({ effects: ['mcp'] })).toBe('permission-gated')
    expect(deriveLegacyPermissionGuard({ effects: ['session_spawn'] })).toBe('permission-gated')
  })

  /**
   * R3a:插件工具那一格。旧 `app/plugins/api.ts` 写死 `permission-gated`(插件填
   * 什么都会被覆盖),新树由 `plugin_exec` 这条效果推出同一个值 —— 目录投影因此
   * 一个字不变。
   */
  it('插件工具(plugin_exec)推出 permission-gated —— 与旧路写死的那一行同值', () => {
    expect(deriveLegacyPermissionGuard({ effects: ['plugin_exec'] })).toBe('permission-gated')
    // 更强的一档赢:插件工具即使还报了别的效果也照旧 permission-gated。
    expect(deriveLegacyPermissionGuard({ effects: ['plugin_exec', 'read'] })).toBe('permission-gated')
  })

  /** R3a 移植的一批各自落在哪一格(六格之外的新增)。 */
  it('R3a 的新工具逐格落位', () => {
    // web_search / web_open —— 旧值 safe
    expect(deriveLegacyPermissionGuard({ effects: ['net_fetch'] })).toBe('safe')
    // ask_user —— 旧值 safe
    expect(deriveLegacyPermissionGuard({ effects: ['user_ask'] })).toBe('safe')
    // send_message —— 旧值 safe
    expect(deriveLegacyPermissionGuard({ effects: ['session_message'] })).toBe('safe')
    // goal / practice / radio / board / history / notebook —— 旧值 safe(零效果)
    expect(deriveLegacyPermissionGuard({ effects: [] })).toBe('safe')
    // feature_mount —— 旧值 permission-gated,新树按真相同样推出 permission-gated
    // (R3a 复盘裁定之后这一格不再有偏差)
    expect(deriveLegacyPermissionGuard({ effects: ['capability_change'] })).toBe('permission-gated')
    // variable —— 同上;旧值 'safe' 是旧树的 bug,见上一条测试的注释
    // task —— 旧值 safe,派生 permission-gated;两者在 CORE_INJECTABLE_* 与
    // CORE_AUTO_EXECUTE_* 两张表里同权,所以标签变了、行为没变
    expect(deriveLegacyPermissionGuard({ effects: ['session_spawn'] })).toBe('permission-gated')
  })

  /**
   * 派生表与策略表**分工不同**,不该互相推。
   *
   * `session_spawn` 在策略表里是 `silent`(派工不弹卡),在派生表里是
   * `permission-gated`(旧目录里的档位)。这两句话同时为真,因为它们回答的是
   * 两个不同的问题:要不要惊动人 vs 这只工具在旧契约里算哪一档。
   */
  it('派生值与策略表可以不同档 —— 它们回答的不是同一个问题', () => {
    expect(deriveLegacyPermissionGuard({ effects: ['session_spawn'] })).toBe('permission-gated')
    expect(EFFECT_POLICY.session_spawn.policy).toBe('silent')
    // 反过来也成立:capability_change 是 never-grantable,派生同样是 permission-gated。
    expect(EFFECT_POLICY.capability_change.policy).toBe('never-grantable')
    expect(deriveLegacyPermissionGuard({ effects: ['capability_change'] })).toBe('permission-gated')
  })

  it('策略表里 silent 的那几类仍是 safe', () => {
    expect(deriveLegacyPermissionGuard({ effects: ['net_fetch'] })).toBe('safe')
    expect(deriveLegacyPermissionGuard({ effects: ['user_ask', 'session_message'] })).toBe('safe')
  })

  it('认不出的 kind 走最保守的可注入档,不被读成"无害"', () => {
    expect(deriveLegacyPermissionGuard({ effects: ['future_thing' as never] })).toBe('permission-gated')
  })

  it('external 推不出来,只能被显式声明(远程执行体不是一种效果)', () => {
    expect(deriveLegacyPermissionGuard({ effects: [] })).toBe('safe')
    expect(deriveLegacyPermissionGuard({ effects: [] }, { external: true })).toBe('external')
  })
})
