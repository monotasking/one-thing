import type { ComponentType } from 'react'
import { getLogger } from '../../services/log'

/**
 * **预览渲染注册表**(设计 `docs/design/search-index-2026-09.md` §4.5 ②:
 * 「`kind` 由壳侧预览渲染注册表解析(`registerPreviewRenderer(kind, Component)`)」)。
 *
 * 与目标渲染注册表(`../targets/registry.ts`)、查看器注册表、块注册表**逐条同款**
 * —— 四张表同一个体例是有意的,壳里「按开放 kind 取组件」只该有一种写法:
 *
 *  1. **重复注册 = 抛错**,不静默覆盖;
 *  2. **注册只发生在一个 barrel**(`./index.ts`),import 它就是「这台上画得出
 *     哪几种预览」,一眼看全;
 *  3. **查不到不是错误**:缺渲染器的 kind 画成「Row 放大版」(§4.5 ④原话
 *     「没有的画 Row 放大版」)并在 dev 下 warn 一次。
 *
 * ── 为什么 payload 是 `unknown` ──────────────────────────────────────────
 * 载荷的形由**产它的能力**定义(`runtime/src/search/capabilities/preview.ts` 那几个
 * 接口),契约层与骨架都不解释它。渲染器与能力是一对:`message-context` 那个组件
 * 认识 `MessageContextPreview`,别人不认识也不需要认识。所以这张表的值类型只能是
 * `unknown` + 渲染器自己那一道校验(**验而不信**,与目标渲染器的 `payloadOf` 同款:
 * 插件能力也在同一张注册表上,一条手搓的载荷不许把整块面拖白)。
 */

/**
 * 一个预览渲染器手上有什么。**两格,一格都不多。**
 *
 * ── 为什么没有 `title` ──────────────────────────────────────────────────
 * `PreviewPayload` 上确实有一格 `title`(能力自己写的那句字),但**画它的不是
 * 渲染器**:单窗那一形由预览窗的檐画(`SearchPreview` 的 `.previewTitle`),
 * composite 那一形由格子的头画。把它同时递给渲染器,等于给「标题画在哪儿」
 * 开第二个产地 —— 而第一个已经在了。真有哪一类要把标题揉进正文里(代码片段的
 * 文件名那种),它自己的 `payload` 里就该带着。
 *
 * (顺带躲掉一处误伤:一个叫 `title` 的 JSX prop 会被 `ui:consume` 的
 * `tooltip-native-title` 当成原生 `title=` 属性判违例 —— 那条禁令是对的,
 * 只是这一格本来就不该在。)
 */
export interface SearchPreviewProps {
  /** 载荷。形由产它的能力定义,渲染器自己校验(验而不信)。 */
  payload: unknown
  /** 此刻的词。用来在预览里把命中那几段标出来;空 = 不标。 */
  query: string
}

export interface SearchPreviewRenderer {
  /** 表里的键 = `PreviewPayload.kind`,也是 `data-preview-kind` 的值。 */
  kind: string
  Body: ComponentType<SearchPreviewProps>
}

const renderers = new Map<string, SearchPreviewRenderer>()

/** 重复注册 = 抛错。返回注销 —— 插件能力的预览渲染器随插件禁用一起走。 */
export function registerPreviewRenderer(renderer: SearchPreviewRenderer): () => void {
  if (renderers.has(renderer.kind)) {
    throw new Error(`search preview renderer already registered: ${renderer.kind}`)
  }
  renderers.set(renderer.kind, renderer)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // 只删自己那一条(注销晚到时不许顺手删掉后来注册的同名渲染器)。
    if (renderers.get(renderer.kind) === renderer) renderers.delete(renderer.kind)
  }
}

const warned = new Set<string>()

/** 查不到**不是错误**:答 `undefined`,调用方画 Row 放大版。dev 下每种 kind 只 warn 一次。 */
export function resolvePreviewRenderer(kind: string): SearchPreviewRenderer | undefined {
  const renderer = renderers.get(kind)
  if (renderer === undefined && !warned.has(kind)) {
    warned.add(kind)
    getLogger('search.preview').warn('no renderer for this preview kind; falling back to an enlarged row', { kind })
  }
  return renderer
}

/** 表里现在有哪些 kind(测试与门读它)。 */
export function previewRendererKinds(): string[] {
  return [...renderers.keys()]
}

/** 测试用:清表重来。产品代码一处都不该调它。 */
export function resetPreviewRenderers(): void {
  renderers.clear()
  warned.clear()
}
