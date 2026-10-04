/**
 * 资源的**线上形状**:一份自述、一次「做」的结局、一次「读」的结局 → 可序列化投影。
 *
 * 三个出口共用这一份(界面的 `resources` 域 `resource-client-api.ts`、CLI daemon 的 `resource.*`
 * 四支 `headless/headless-backend.ts`、以及将来的别的出口)。它们从前住在 RPC 域文件里、由 CLI 深层 import;
 * 包根归位(2026-10-04)把它们拆到这里、经资源入口交出 —— 开给界面的那只文件(第二入口,D26)
 * 只给 HTTP 服务器用,CLI 不该去引它。函数逐字未改。
 */
import type {
  ResourceOutcomeView,
  ResourceReadView,
  SerializedEventSpec,
  SerializedOpSpec,
  SerializedReadSpec,
  SerializedResourceSpec,
} from '@shared/ipc/resources.js'
import type { ReadOutcome, ResourceSpec } from './resource-api.js'
import type { Outcome, Result } from '@onething/backend/toolkit/toolkit-tool-protocol'
import { resultToText } from '@onething/backend/toolkit/toolkit-tool-protocol'

/**
 * 一份自述 → 可序列化投影。函数(`when` / `describe`)在这里被丢掉,只留一格
 * `whenGated` —— 理由在 `@shared/ipc/resources.ts` 的头注释。
 *
 * **住在资源功能本身、经资源入口交出**(K4-b;2026-10-04 包根归位从 RPC 域文件里拆出来):
 * CLI 那条出口(daemon 的四支 `resource.*`)投的是同一份形状。§4 那张表要求每个出口都是**同一份自述的投影**,而两份手抄的投影
 * 早晚会在某一格上分岔 —— 到那天壳看得见 `keymap` 而 CLI 看不见,而没有任何一道
 * 门会红。所以这三只是三个出口共用的一份,不是 RPC 域私有的。
 *
 * 键按字典序遍历,与 `schema.ts` 生成 AI 工具契约时同一个理由:同一份自述换个
 * 书写顺序不该换一份投影(那会让命令面板的排序取决于谁先敲了哪一行)。
 */
export function serializeSpec(spec: ResourceSpec): SerializedResourceSpec {
  const reads: Record<string, SerializedReadSpec> = {}
  for (const name of Object.keys(spec.reads).sort()) {
    const read = spec.reads[name]
    reads[name] = { title: read.title, query: read.query, result: read.result }
  }

  const ops: Record<string, SerializedOpSpec> = {}
  for (const name of Object.keys(spec.ops).sort()) {
    const op = spec.ops[name]
    ops[name] = {
      title: op.title,
      params: op.params,
      effects: [...op.effects],
      home: op.home,
      ...(op.when ? { whenGated: true } : {}),
      ...(op.entity !== undefined ? { entity: op.entity } : {}),
      ...(op.keymap !== undefined ? { keymap: op.keymap } : {}),
    }
  }

  const events: Record<string, SerializedEventSpec> = {}
  for (const name of Object.keys(spec.events).sort()) {
    const event = spec.events[name]
    events[name] = {
      title: event.title,
      payload: event.payload,
      ...(event.moment ? { moment: { weight: event.moment.weight, gist: event.moment.gist } } : {}),
    }
  }

  const projected: SerializedResourceSpec = { scheme: spec.scheme, title: spec.title, reads, ops, events }
  if (!spec.state) return projected

  const state: NonNullable<SerializedResourceSpec['state']> = {}
  for (const name of Object.keys(spec.state).sort()) {
    const entry = spec.state[name]
    state[name] = { title: entry.title, schema: entry.schema, volatility: entry.volatility }
  }
  return { ...projected, state }
}

/**
 * `Outcome` → 可序列化投影。五支一一对应。
 *
 * `ok` 那一支走 `resultToText` —— 与模型看到的**逐字相同**的那段文本(`toModelText`
 * 对 `ok` 就是这一句)。不另写一个「给界面的格式」:同一次调用在 AI 眼里和在界面
 * 眼里说的是两句话,就是「一条管线」这句话开始漏气的地方(要结构化载荷是 K2b 的
 * 事,那时加的是 `details` 一格,不是第二种文本)。
 *
 * `failed` 只留错误的名字与一句话:类名给判定读,消息给人读,堆栈一个字不过网络。
 */
function textOf(result: Result): string {
  return resultToText(result)
}

export function serializeOutcome(outcome: Outcome): ResourceOutcomeView {
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'ok', text: textOf(outcome.result) }
    case 'invalid':
      return { kind: 'invalid', message: outcome.message }
    case 'denied':
      return { kind: 'denied', reason: outcome.reason }
    case 'aborted':
      return {
        kind: 'aborted',
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.partial ? { partial: textOf(outcome.partial) } : {}),
      }
    case 'failed':
      return { kind: 'failed', error: { name: outcome.error.name, message: outcome.message } }
  }
}

/** `ReadOutcome` → 可序列化投影(K2c-2)。四支,`ok` 直接带值。 */
export function serializeReadOutcome(outcome: ReadOutcome): ResourceReadView {
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'ok', value: outcome.value }
    case 'invalid':
      return { kind: 'invalid', message: outcome.message }
    case 'denied':
      return { kind: 'denied', reason: outcome.reason }
    case 'failed':
      return { kind: 'failed', error: { name: outcome.error.name, message: outcome.message } }
  }
}
