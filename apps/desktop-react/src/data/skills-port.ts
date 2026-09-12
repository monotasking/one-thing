import { skillsRouter } from '@shared/ipc/skills'
import type { GetSkillsResponse } from '@shared/ipc/skills'

/**
 * 技能读面与 core 的客户端(`@onething/client`)之间的那一层端口(09-12)——
 * 与 `data/commands-port.ts` / `data/models-port.ts` 同一形状、同一理由。
 *
 * **只有一条**,而且是读面:`skillsRouter.getAll`。壳里技能出现在 `/` 抽屉里
 * 是为了让人把一条技能**引用**进这一句话(后端 `prompts/resolver.ts` 的
 * `collectReferenceMatches` 认 `/skill:<name>`),不是为了在这里管理技能 ——
 * 开关 / 新建 / 删除 / 目录那十一条写面归设置页,这一层一个都不该有。
 *
 * ── `workingDirectory` 是判据不是修饰 ────────────────────────────────────
 * 契约上那一格的注释写着「项目根下的技能按它发现」:同一台机器上,
 * 不同工作目录看得见的技能表本来就不同。所以这条口**按 cwd 取数**,
 * 拿不到工作目录就不带 —— 那是「按宿主自己的根找」,与
 * `data/file-mentions-source.ts` 对 `cwd` 的既有裁定逐字同一条(不在渲染层
 * 拼一个 `~` 去顶)。
 */
export interface SkillsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 这条会话看得见的技能。拉不到 = 抽屉里没有技能那一组(静默降级,见 source)。 */
  getAll(workingDirectory: string | null): Promise<GetSkillsResponse>
}

let port: SkillsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureSkillsPort(next: SkillsPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 commands-port 逐字相同:它要的是那个连通之后
 * 才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<SkillsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const skillsApi = client.api(skillsRouter)
  return {
    ready: () => whenConnected(),
    getAll: (workingDirectory) =>
      skillsApi.getAll(workingDirectory ? { workingDirectory } : {}),
  }
}

let pending: Promise<SkillsPort> | undefined

export function skillsPort(): Promise<SkillsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
