import type { BlockModel } from '../../model/blocks'
import type { ProjectedToolCall, ToolRowModel } from '../../model/segments'
import { defaultToolPresenter, type ToolPresenter } from '../presenter'
import { toolKind } from '../result'
import { bashPresenter } from './bash'
import { changesDiffBlock, editPresenter } from './edit'
import { readPresenter } from './read'
import { webPresenter } from './web'

/**
 * **工具自报类别 → 画法**(ACP A2-c,正本 `docs/design/acp-integration-2026-09.md` §3.8)。
 *
 * ── 为什么是一张表,而不是给每台 agent 写 presenter ─────────────────────────
 * 外部 agent 的工具名是它自己起的(`edit_file` / `apply_patch` / `Bash` …),按名字认
 * 就是按 agent 枚举:接一台新 agent 就要回来加一行。而协议给每次调用一个**类别**
 * (`kind`),类别才是「这件事长什么样」—— 改文件就画 diff、跑命令就画输出。所以这里
 * 一张表,键是类别,值是**已有的**那几个 presenter;agent id 一个字都不出现。
 *
 * ── 名字仍是 agent 起的那个 ──────────────────────────────────────────────
 * 借来的 presenter 会按自己的习惯把行名换成文件名 / 命令首词(内置工具那样读顺),
 * 但 agent 的工具名本身就是信息(`edit_file` 与 `write_file` 是两件事)。所以行名
 * 盖回工具名,被盖掉的那个说法(文件名)挪进摘要那一格 —— 什么都不丢。
 *
 * ── 表外的类别落兜底 ──────────────────────────────────────────────────
 * 协议哪天多一档,或者 agent 写了个表里没有的词,就是兜底:工具名 + 状态 + 正文。
 * 兜底从 A2-c 起画 `result.output` 的正文(不再是整份 JSON),所以落兜底不等于难看。
 *
 * ── `search` 为什么也落兜底 ────────────────────────────────────────────
 * 壳里今天没有「本地检索工具」的 presenter(web_search 归 web、会话检索没有卡),
 * 硬塞给 web 会把一次本地 grep 画成「N 条结果」的网页检索。等真有检索 presenter 时
 * 改这一格就够了。
 */
const KIND_PRESENTERS: Readonly<Record<string, ToolPresenter>> = {
  read: readPresenter,
  edit: editPresenter,
  delete: editPresenter,
  move: editPresenter,
  execute: bashPresenter,
  search: defaultToolPresenter,
  fetch: webPresenter,
  think: defaultToolPresenter,
  switch_mode: defaultToolPresenter,
  other: defaultToolPresenter,
}

/** 类别 → presenter。表外的一律兜底。导出给测试钉表。 */
export function presenterForKind(kind: string | undefined): ToolPresenter {
  return (kind !== undefined && Object.prototype.hasOwnProperty.call(KIND_PRESENTERS, kind) ? KIND_PRESENTERS[kind] : undefined)
    ?? defaultToolPresenter
}

/**
 * 表的入口:**结局里写了类别**的调用归它。
 *
 * 排在 barrel 的最前面:内置工具的结局里没有 `kind` 这一格,所以它们照旧落到各自按名字
 * 认的 presenter;ACP 工具在参数流 / 执行中那段还没有 `kind`(它只落在结局上,见
 * `result.toolKind`),那段按名字认不到就是兜底 —— 收场那一帧换成类别的画法,行不重挂
 * (同一个 callId、同一个元素,只是字变了)。
 */
export const kindPresenter: ToolPresenter = {
  match: (call) => toolKind(call) !== undefined,

  row: (call) => agentRow(call, presenterForKind(toolKind(call)).row(call)),

  detail: (call) => withChanges(call, presenterForKind(toolKind(call)).detail(call)),
}

/** 借来的那一行,行名盖回 agent 的工具名(判词见文件头第二段)。 */
function agentRow(call: ProjectedToolCall, borrowed: ToolRowModel): ToolRowModel {
  const name = call.toolName || call.toolId
  // 头行也念工具名:bash 那条「首词即动词」的自述在这里不成立(行名已经不是首词了)。
  const rest: ToolRowModel = { ...borrowed }
  delete rest.headLabel
  const moved = borrowed.name !== name ? borrowed.name : undefined
  return {
    ...rest,
    name,
    ...(rest.summary === undefined && moved ? { summary: moved } : {}),
  }
}

/** 调用带着改动而借来的画法没画它(read / bash / web 不认 diff)→ diff 摆在最前面。 */
function withChanges(call: ProjectedToolCall, blocks: BlockModel[]): BlockModel[] {
  // 解析不动的 diff 会落成 `code(lang:'diff')`(`diffBlockOf` 的退路),同样算「已经画了」。
  if (blocks.some((block) => block.kind === 'diff' || (block.kind === 'code' && block.lang === 'diff'))) return blocks
  const diff = changesDiffBlock(call)
  return diff ? [diff, ...blocks] : blocks
}
