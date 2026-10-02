/**
 * Built-in Provider Definitions
 *
 * This file exports all built-in provider definitions — a projection of the builtin
 * manifests (`runtime/providers/builtin-providers.ts`). To add a builtin provider, add its
 * folder under `runtime/providers/vendors/<id>/` and one row in each roster
 * (`vendors/manifests.ts`, `vendors/runtimes.ts`); nothing here changes.
 *
 * Built-in providers are expected to route through agent runtimes by default.
 */

import {
  acpBuiltinProvider,
  onethingPortableBuiltinProviders,
} from '@onething/backend/runtime/providers'

import type { ProviderDefinition } from '@onething/backend/runtime/providers/types.wiring'

// All built-in providers.
//
// 服务商自述试点 P2 第 4 批:这里曾经把 codex 从可移植表里滤掉、再换成本目录 `codex.ts` 那条带
// `prepareCallOptions` 的定义追加回来。那一格全仓没有读者(`prepareCallOptions` 只在类型里声明),
// codex 又本来就排在可移植表的最后一位,所以滤掉再追加与原样照抄同序同值 —— 那一句与 `codex.ts`
// 一起删掉,这里不再点任何一家的名。
export const builtinProviders: ProviderDefinition[] = [
  ...onethingPortableBuiltinProviders as ProviderDefinition[],
  acpBuiltinProvider as ProviderDefinition,
]

export default builtinProviders
