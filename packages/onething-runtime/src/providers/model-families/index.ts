/**
 * 型号家族的公共表:每个家族一行(`docs/design/architecture-direction-2026-10.md` §4 P2「模型家族 ≠ 服务商」)。
 *
 * 通用代码(目录、展示)读这里汇总好的表,不点家族的名;家族自己的知识住 `<family>.ts`。
 * 纯模块。
 */
import {
  ONETHING_CLAUDE_CONTEXT_LENGTH_HINTS,
  ONETHING_CLAUDE_MODEL_DESCRIPTIONS,
} from './claude.js'
import {
  ONETHING_GEMINI_CONTEXT_LENGTH_HINTS,
  ONETHING_GEMINI_MODEL_DESCRIPTIONS,
  ONETHING_GEMINI_MODEL_DISPLAY_NAMES,
} from './gemini.js'
import {
  ONETHING_OPENAI_GPT_CONTEXT_LENGTH_HINTS,
  ONETHING_OPENAI_MODEL_DESCRIPTIONS,
  ONETHING_OPENAI_O_SERIES_CONTEXT_LENGTH_HINTS,
} from './openai.js'
import type { OnethingModelContextLengthHint } from './types.js'

export type { OnethingModelContextLengthHint } from './types.js'

/** 型号 id → 展示名别称(任何一家卖这个型号都这么显示)。 */
export const ONETHING_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ...ONETHING_GEMINI_MODEL_DISPLAY_NAMES,
}

/** 型号 id → 一句人话说明(列表口没给 description 时用;今天是 Copilot 的列表口在读)。 */
export const ONETHING_MODEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ...ONETHING_OPENAI_MODEL_DESCRIPTIONS,
  ...ONETHING_CLAUDE_MODEL_DESCRIPTIONS,
  ...ONETHING_GEMINI_MODEL_DESCRIPTIONS,
}

/**
 * 按 id 片段认上下文长度,**先到先得**。次序就是搬家前 `detectCopilotModelCapabilities` 那条
 * `if / else if` 链的次序:gpt 那几行 → claude → gemini → o 系列(`o1` / `o3` 片段太短,排最后)。
 */
export const ONETHING_MODEL_CONTEXT_LENGTH_HINTS: readonly OnethingModelContextLengthHint[] = [
  ...ONETHING_OPENAI_GPT_CONTEXT_LENGTH_HINTS,
  ...ONETHING_CLAUDE_CONTEXT_LENGTH_HINTS,
  ...ONETHING_GEMINI_CONTEXT_LENGTH_HINTS,
  ...ONETHING_OPENAI_O_SERIES_CONTEXT_LENGTH_HINTS,
]

/** 第一行命中的长度;一行都不中 = `undefined`(缺省由调用方给)。`modelIdLower` 须已小写。 */
export function onethingModelContextLengthHint(modelIdLower: string): number | undefined {
  return ONETHING_MODEL_CONTEXT_LENGTH_HINTS.find((hint) =>
    hint.includes.some((fragment) => modelIdLower.includes(fragment)),
  )?.contextLength
}
