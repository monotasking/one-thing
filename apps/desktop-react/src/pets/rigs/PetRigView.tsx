import type { PetRigProps, PetRigSource } from '../types'
import { DeclarativeRig } from './DeclarativeRig'
import { rigFor } from './index'

/**
 * **画一只宠物的形象** —— 形象来源的唯一分叉点(宠物 P5,§12.3 / §12.5)。
 *
 *   · 字符串 = 手画形象的 id → 查 `rigs/index.ts` 那张表(黑豆);
 *   · 对象   = 一份声明式形象 → 交给 `DeclarativeRig` 解释(阿绿);
 *   · 缺席 / 查不到 → 不画(栖位上那颗宠物按钮照样在,§7 ②)。
 *
 * 舞台、设置页的卡片与 lab 都经这一处,于是「这只宠物是手画的还是数据画的」只有这里知道。
 */
export function PetRigView({ rig, ...props }: PetRigProps & { rig: PetRigSource | undefined }) {
  if (rig === undefined) return null
  if (typeof rig === 'string') {
    const Rig = rigFor(rig)
    return Rig ? <Rig {...props} /> : null
  }
  return <DeclarativeRig spec={rig} {...props} />
}
