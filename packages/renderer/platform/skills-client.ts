/**
 * skills(技能管理)域的渲染侧客户端 —— 结构债 P4c 第二批。
 *
 * 形状照 `spaces-client.ts` / `project-dirs-client.ts` 的判例:壳外一个模块 +
 * 通用 `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的
 * 十二个壳方法多是位置参数的(`readSkillFile(skillId, fileName)`、
 * `toggleSkillEnabled(skillId, enabled)`),这里一律是信封:
 * `skillsApi.readFile({ skillId, fileName })`、`skillsApi.toggleEnabled({ skillId, enabled })`。
 *
 * 无参的两条(`refresh` / `listDirectories`)按本仓惯例递 `{}`。
 */
import { skillsRouter } from '@shared/ipc/skills.js'
import { clientApi } from './client'

export const skillsApi = clientApi(skillsRouter)
