import type { PetManifest } from '../manifest.js'
import { ALU_RIG } from './alu.rig.js'

/**
 * **阿绿** —— 第二只宠物,一只绿鹦鹉(宠物 P5,正本 §12.3)。
 *
 * 它证明「加一只宠物 = 数据 + 注册一行」:形象是 `alu.rig.ts` 那份声明式数据(不是手画组件),
 * 名册里一行(`registry.ts`),壳侧只多一份嘀咕台词(i18n)。`host.ts` / 装配层一个字不改。
 */
export const ALU: PetManifest = {
  id: 'alu',
  name: '阿绿',
  rig: ALU_RIG,
  voice: { pitch: 'high', timbre: 'bright', rate: 'fast' },
  persona: [
    '你是阿绿,一只住在用户电脑里的绿鹦鹉。',
    '话少,一次只说一句短的。',
    '爱学舌:偶尔把用户刚点的歌名重复一遍。',
    '用「我」称呼自己。',
    '说具体的细节,不说空泛的客套。',
  ].join('\n'),
  sample: '我是阿绿！我是阿绿！',
}
