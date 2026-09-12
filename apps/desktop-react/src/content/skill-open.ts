import { openDirectoryPanel, sessionDirOf } from './dir-open'
import { skillsPort } from '../data/skills-port'
import { useSkillsSource } from '../data/skills-source'
import type { SkillEntry } from '../data/skills-source'

/**
 * **「打开这条技能所在的目录」这个动作**(2026-09-12)。
 *
 * ── 它为什么住在 content 而不是 data(这只文件存在的全部理由)────────────────
 * 这个动作要两样东西:技能表上那一格 `directoryPath`(数据,`data/skills-source`
 * 的 `byId`)与「把一份目录摆上舞台」(动作,`content/dir-open`)。第一版把它写在
 * `data/skills-source.ts` 里,于是那只 store 反过来 import 了 `content/dir-open`
 * —— **方向反了**:壳的依赖是 content → data(面消费数据),data 不认识面。
 * 一条反向边不会当场出事,但它把 stage / workbench 两片 store 拖进了每一个
 * import 过 `skills-source` 的世界(`composer/usePickDrawer` 就是一个),
 * 而那正是 `dir-open.ts` 自己文件头上记的那桩事故的同一种形。
 *
 * 所以动作搬到这一层:**content 这边同时看得见两样东西**,一行反向边都不需要。
 *
 * ── 纪律与 `dir-open.ts` 逐字同一条:零模块级副作用 ──────────────────────────
 * 没有 `register*`、没有订阅、没有定时器、没有跨渲染留存的可变状态。所以它也
 * 不需要 HMR dispose(「这东西的寿命是不是这个模块实例」答否)。
 *
 * ── 三条路,次序即偏好 ──────────────────────────────────────────────────────
 *  ① 表里有 `directoryPath` → `openDirectoryPanel`,**与 `@目录` chip 同一条路**
 *    (在应用里打开,不弹 Finder)。用户那句原话要的就是这个:「点了直接看到那个东西」。
 *  ② 表里没有(抽屉从没开过 / 换了 cwd)→ 先 `ensureSkills(sessionDirOf())` 再查。
 *    cwd 的判据与 `usePickDrawer` 逐字同一条 —— 那边是 `useSessionCwd()`,
 *    这里是它的非 hook 孪生 `sessionDirOf()`(同一个 `envSessionId` + `sessionCwdOf`)。
 *  ③ 还是没有(这条技能已经不在这台机器的表里了)→ RPC 回落
 *    `skills.openDirectory({skillId})`,宿主那头是 `shell.openPath` = 在 Finder 里打开。
 *    它是**另一种打开法**,所以排在最后而不是并列。
 *
 * ── 返回值是「开成了没有」,不是 void ──────────────────────────────────────
 * 调用方要据此决定要不要 notify 一条 warn(异步反馈纪律:失败得有人说话)。
 * 三条路全落空、端口不在场、RPC 抛了 —— 一律 `false`,一个异常都不往外扔:
 * 点一枚 chip 不该炸掉整条消息列表。
 */
export async function openSkillDirectory(skillId: string): Promise<boolean> {
  if (!skillId) return false
  const lookup = (): SkillEntry | undefined => useSkillsSource.getState().byId.get(skillId)

  let entry = lookup()
  if (!entry) {
    // ② 表还没有 / 换了 cwd。`ensureSkills` 自己按 cwd 判要不要真发(拉过就是恒等),
    // 所以这一句在「表已是最新、只是没有这一条」时是白跑一趟 —— 便宜,而且它是
    // 唯一能把「从没开过抽屉」那一形救回来的动作。
    await useSkillsSource.getState().ensureSkills(sessionDirOf())
    entry = lookup()
  }
  if (entry?.directoryPath) {
    openDirectoryPanel(entry.directoryPath)
    return true
  }

  // ③ 回落。
  try {
    const port = await skillsPort()
    if (!port.openDirectory) return false
    const response = await port.openDirectory(skillId)
    return response.success === true
  } catch {
    return false
  }
}
