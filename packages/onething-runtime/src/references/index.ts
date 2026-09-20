/**
 * 线上引用类型表(`docs/design/reference-tag-2026-09.md` §2.2)。
 *
 * 这只 barrel 顺手把内置的那几种登记进 `refTypes` —— `types/index.ts` 是那张
 * 登记表,import 它就是登记。
 */

import './types/index.js'

export { RefTypeRegistry, refTypes } from './registry.js'
export type { RefTypeAttrSpec, RefTypeSpec } from './spec.js'
export { renderReferenceGuide } from './prompt.js'
