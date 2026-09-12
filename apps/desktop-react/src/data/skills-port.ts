import { skillsRouter } from '@shared/ipc/skills'
import type { GetSkillsResponse, OpenSkillDirectoryResponse } from '@shared/ipc/skills'

/**
 * 技能读面与 core 的客户端(`@onething/client`)之间的那一层端口(09-12)——
 * 与 `data/commands-port.ts` / `data/models-port.ts` 同一形状、同一理由。
 *
 * **读面那一条是主角**:`skillsRouter.getAll`。壳里技能出现在 `/` 抽屉里
 * 是为了让人把一条技能**引用**进这一句话(后端 `prompts/resolver.ts` 的
 * `collectReferenceMatches` 认 `/skill:<name>`),不是为了在这里管理技能 ——
 * 开关 / 新建 / 删除那十条写面归设置页,这一层一个都不该有。
 *
 * ── 第二条是**回落**,不是管理口(09-12)────────────────────────────────
 * 气泡里那枚技能 chip 点下去要「打开它所在的目录」,而首选路是壳自己的目录面板
 * (`content/dir-open.openDirectoryPanel`,与 `@目录` chip 同一条)—— 那需要
 * `directoryPath`,它只在 `getAll` 拉回来的表里。表里没有(从没拉过 / 换了 cwd /
 * 这条技能已经不在了)时才走 `openDirectory`:它在宿主那头是 `shell.openPath`,
 * 也就是**在 Finder 里打开**,是另一种打开法,所以只当兜底。
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
  /**
   * 在**文件管理器**里打开这条技能的目录。回落路,见文件头。
   *
   * **可选**:壳里的端口替身(`src/test/setup.ts` 那份缺省、各面自己换上的那些)
   * 装的都只是读那一口;缺席 = 这台没有这条回落能力,`openSkillDirectory` 当场
   * 答「打不开」并 notify 一条 warn —— 与「没有这块能力就结构化降级」逐字同一条,
   * 不是给替身开的后门:真实现里它永远在场。
   */
  openDirectory?(skillId: string): Promise<OpenSkillDirectoryResponse>
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
    openDirectory: (skillId) => skillsApi.openDirectory({ skillId }),
  }
}

let pending: Promise<SkillsPort> | undefined

export function skillsPort(): Promise<SkillsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
