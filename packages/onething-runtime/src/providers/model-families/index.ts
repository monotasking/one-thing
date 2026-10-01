/**
 * 型号家族的公共表:每个家族一行(`docs/design/architecture-direction-2026-10.md` §4 P2「模型家族 ≠ 服务商」)。
 *
 * 通用代码(目录、展示)读这里汇总好的表,不点家族的名;家族自己的知识住 `<family>.ts`。
 * 纯模块。
 */
import { ONETHING_GEMINI_MODEL_DISPLAY_NAMES } from './gemini.js'

/** 型号 id → 展示名别称(任何一家卖这个型号都这么显示)。 */
export const ONETHING_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ...ONETHING_GEMINI_MODEL_DISPLAY_NAMES,
}
