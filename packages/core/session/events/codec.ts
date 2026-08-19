/**
 * 会话事件日志的行编解码(§9.1 / 铁律 4)。
 *
 * 与 E0 的编解码**逐字节兼容**:同一条七类记录 encode 出的行与从前一致,
 * decode 认得盘上每一份既有文件。v2 只是把认得的 type 集合放大,并让
 * `surfaceOp` / `sourceEventSeqs` 两个顶层字段透传。
 *
 * 容错口径(不改):
 *  - 空行 / JSON 解不开的半行 → 跳过(崩溃截断只可能出现在最后一行);
 *  - 不认识的 type → 跳过(未来版本追加的新类型,老版本照常读前面的);
 *  - seq/time/data 形状不对 → 跳过。
 *
 * **绝不回写"清理"文件** —— 读侧只跳过。
 */

import type { SessionLogEventRecord, SessionLogEventType, SessionSurfaceOp } from './types.js'
import { SESSION_LOG_EVENT_TYPES } from './types.js'

/** 一行一条,永远以 \n 结尾 —— 半行只可能出现在崩溃截断处。 */
export function encodeSessionLogEventLine(record: SessionLogEventRecord): string {
  return `${JSON.stringify(record)}\n`
}

export function isSessionLogEventType(value: unknown): value is SessionLogEventType {
  return typeof value === 'string' && (SESSION_LOG_EVENT_TYPES as readonly string[]).includes(value)
}

function isValidSurfaceOp(value: unknown): value is SessionSurfaceOp {
  if (value === 'append') return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const op = value as { op?: unknown; start?: unknown; end?: unknown }
  if (op.op !== 'replace') return false
  return Number.isFinite(op.start) && Number.isFinite(op.end)
}

/**
 * 解析一行。返回 null = "这一行不是我认识的事件"(半行 / 未来类型 / 形状不对)。
 *
 * `surfaceOp` 形状不对时**不丢整条**,只丢那个字段:一条 data 完好的事件比
 * 一条被整行扔掉的事件有用得多,而 surface 的自洽由 `SurfaceIndex` 的校验兜底。
 */
export function decodeSessionLogEventLine(line: string): SessionLogEventRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return null
  if (typeof record.time !== 'number' || !Number.isFinite(record.time)) return null
  if (!isSessionLogEventType(record.type)) return null
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return null
  if (record.surfaceOp !== undefined && !isValidSurfaceOp(record.surfaceOp)) {
    delete record.surfaceOp
  }
  if (record.sourceEventSeqs !== undefined) {
    const seqs = record.sourceEventSeqs
    if (!Array.isArray(seqs) || seqs.some(value => typeof value !== 'number')) {
      delete record.sourceEventSeqs
    }
  }
  return record as unknown as SessionLogEventRecord
}

/**
 * 解析整份日志。容忍尾部半行,容忍未知类型。
 * 结果按 seq 升序 —— 追加顺序即 seq 顺序,这里只做兜底排序(**稳定**:
 * 同 seq 的重复行保持文件里的先后,不给"第二写者写重了 seq"再加一层错乱)。
 */
export function parseSessionLogEventLog(text: string): SessionLogEventRecord[] {
  const records: Array<{ record: SessionLogEventRecord; order: number }> = []
  let order = 0
  for (const line of text.split('\n')) {
    const record = decodeSessionLogEventLine(line)
    if (record) records.push({ record, order: order++ })
  }
  records.sort((a, b) => (a.record.seq - b.record.seq) || (a.order - b.order))
  return records.map(entry => entry.record)
}
