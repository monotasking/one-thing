/**
 * 线上引用类型表(`docs/design/reference-tag-2026-09.md` §2.2)。
 *
 * 这只 barrel 顺手把内置的那几种登记进 `refTypes` —— `types/reference-types.ts` 是那张
 * 登记表,import 它就是登记。
 */

import './types/reference-types.js'

export { RefTypeRegistry, refTypes } from './reference-registry.js'
export type { RefTypeAttrSpec, RefTypeSpec } from './reference-spec.js'
export { renderReferenceGuide } from './reference-prompt.js'
