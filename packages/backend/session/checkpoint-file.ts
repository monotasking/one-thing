/**
 * **投影检查点的落盘面**(工单 4 B)—— 写在哪、什么时候作数、什么时候扔掉。
 *
 * 编解码在 core(`core/session/projection/checkpoint.ts`,它连"文件"两个字都不
 * 认识);**判据在这里**,因为判据问的全是账本这个文件此刻长什么样。
 *
 * ## 一句话
 *
 * `<store>/sessions/<id>/projection.checkpoint` 记的是:「`events.jsonl` 的**前
 * `ledgerBytes` 个字节**折出来的投影长这样,折到第 `lastSeq` 条」。冷载时把
 * `[ledgerBytes, EOF)` 那一段折上去就得到此刻的投影 —— 55MB 的账本因此只读了
 * 尾巴那一小段。
 *
 * ## 什么叫「对得上」——四道门,全过才算数
 *
 *  1. **版本**:`file.version` 与 `SESSION_PROJECTION_CHECKPOINT_VERSION` 相同。
 *     折法变了就把那个数 +1,所有旧检查点当场全部作废。
 *  2. **会话 id**:文件里那一格与要读的这条相同(拷贝会话目录、手工挪文件都能
 *     制造出一份指着别人历史的检查点)。
 *  3. **字节数**:`0 < ledgerBytes <= 账本此刻的大小`。账本是**纯追加**的,
 *     所以"比现在还大"只意味着一件事:这份账本被换过 / 截过 —— 与它有关的一切
 *     派生物立刻作废。
 *  4. **末行指纹**:账本第 `ledgerBytes` 个字节**之前**那一整行,它的 sha256 与
 *     `lastLineSha256` 相同,且它自己解出来的 `seq` 等于 `lastSeq`。
 *
 * 第 4 道是这四道里唯一真正贵一点的(读几百字节),也是唯一挡得住「长度碰巧
 * 一样、内容不一样」的。前三道单独用起来都有一个明显的漏洞:一份被**重写**成
 * 同样长度的账本会全部骗过 —— 而账本被重写正是 G12 外写者那一类事故的形状。
 *
 * 任何一道不过 = **丢掉检查点,从头折**。不修、不猜、不写回。这只文件里没有
 * 任何一个改 `events.jsonl` 的口子,一个都没有。
 *
 * ## 写的时候为什么要求账本以 `\n` 收尾
 *
 * `ledgerBytes` 必须落在**行首**,否则冷载会从半行开始解析。账本的写入口一律
 * `行 + '\n'`,所以"末字节不是 `\n`"只有一种可能:有一行正写到一半(或崩溃截断
 * 在那儿)。那一刻**不写检查点**就是了 —— 检查点是备忘,少写一次没有任何代价。
 *
 * ## 与 refold 的关系
 *
 * 写检查点有两个挂点,但**写入口只有一个**(下面那只 `writeSessionProjectionCheckpoint`):
 *
 *  · `refold.ts` 对上账之后 —— 那一份 state 是**刚从文件字节重折出来的**,而且
 *    刚刚被证明与内存活投影逐字相同。白捡的一份、还带证明,不写白不写;
 *  · run 收尾的兜底(`scheduleSessionProjectionCheckpoint`)—— refold 是抽样的
 *    (每 5 个 run 一次),`ONETHING_SESSION_SHADOW=0` / `ONETHING_SESSION_REFOLD=0`
 *    时更是一次都不跑。检查点是**性能设施**,不该跟着一道**对账门**的开关一起没。
 *    这条路用的是内存活投影 —— 它同样是账本折出来的,只是没有第二条路给它作证。
 *
 * 两条路都不多折一遍账本:前者复用重折的结果,后者复用内存里那一份。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import {
  decodeSessionLogEventLine,
  decodeSessionProjectionCheckpoint,
  encodeSessionProjectionCheckpoint,
  SESSION_PROJECTION_CHECKPOINT_VERSION,
  type SessionAccountState,
  type SessionProjectionCheckpointPayload,
  type SessionProjectionState,
} from '@onething/core/session'
import {
  getSessionEventsLogPath,
  getSessionProjectionCheckpointPath,
} from './event-log.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.checkpoint')

const NEWLINE_BYTE = 0x0a

/**
 * 找末行时一次读多少、最多退让到多少。
 *
 * 事件行绝大多数在 1KB 以内(大正文早换成 blob 引用了),64KB 一把够。
 * 上限 4MB 是给"某一行真的很长"留的余地;再长就放弃这一次 —— 为了写一份备忘
 * 把几 MB 读进内存不值当。
 */
const TAIL_PROBE_BYTES = 64 * 1024
const TAIL_PROBE_MAX_BYTES = 4 * 1024 * 1024

/** 检查点文件里那一层信封(载荷之外的、只有装配层认得的几格)。 */
interface SessionProjectionCheckpointFile {
  sessionId: string
  /** 折到第几条(= 载荷里那份 state 的 `lastSeq`,冗余一格好在解码前就判掉)。 */
  lastSeq: number
  /** 这份投影是账本前多少个字节折出来的。**必须落在行首**。 */
  ledgerBytes: number
  /** 第 `ledgerBytes` 字节之前那一整行(不含结尾 `\n`)的 sha256。 */
  lastLineSha256: string
  writtenAt: number
  payload: SessionProjectionCheckpointPayload
}

/** 账本末尾那一整行的字节 + 它的行首偏移。找不到完整的一行 → undefined。 */
function readLastLine(logPath: string, upTo: number): { bytes: Buffer; start: number } | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(logPath, 'r')
    let window = TAIL_PROBE_BYTES
    while (window <= TAIL_PROBE_MAX_BYTES) {
      const start = Math.max(0, upTo - window)
      const buffer = Buffer.allocUnsafe(upTo - start)
      const read = fs.readSync(fd, buffer, 0, buffer.length, start)
      const chunk = buffer.subarray(0, read)
      // `upTo` 指向末行之后那个 `\n` 的下一格,所以末行是 `[前一个 \n + 1, upTo - 1)`。
      if (chunk.length === 0) return undefined
      if (chunk[chunk.length - 1] !== NEWLINE_BYTE) return undefined
      const lineEnd = chunk.length - 1
      const lineStart = chunk.lastIndexOf(NEWLINE_BYTE, lineEnd - 1)
      if (lineStart === -1) {
        // 这一窗里没有第二个 `\n`:要么整份账本只有一行(start === 0,那就是行首),
        // 要么窗口太小,退让一次再看。
        if (start === 0) return { bytes: chunk.subarray(0, lineEnd), start: 0 }
        window *= 4
        continue
      }
      return { bytes: chunk.subarray(lineStart + 1, lineEnd), start: start + lineStart + 1 }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 关不上也不该再制造第二条错误路径 */ }
    }
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export interface RestoredSessionProjection {
  state: SessionProjectionState
  account: SessionAccountState
  lastSeq: number
  /** 从账本的这个字节(行首)接着折。 */
  fromByte: number
}

/**
 * 读检查点。四道门(见文件头)任何一道不过 → `undefined` = **从头折**。
 *
 * 一个字都不 warn 的两种情形:文件不在(绝大多数会话)、账本不在。其余的
 * 对不上记一句 debug —— 它是正常的自愈,不是故障;真要查的时候按 ns 打开。
 */
export function loadSessionProjectionCheckpoint(sessionId: string): RestoredSessionProjection | undefined {
  const checkpointPath = getSessionProjectionCheckpointPath(sessionId)
  let raw: string
  try {
    raw = fs.readFileSync(checkpointPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const file = JSON.parse(raw) as SessionProjectionCheckpointFile
    // ① 版本 ② 会话 id
    if (file?.payload?.version !== SESSION_PROJECTION_CHECKPOINT_VERSION) {
      return discard(sessionId, 'version', checkpointPath)
    }
    if (file.sessionId !== sessionId) return discard(sessionId, 'session', checkpointPath)
    if (!Number.isInteger(file.ledgerBytes) || file.ledgerBytes <= 0) {
      return discard(sessionId, 'bytes', checkpointPath)
    }
    // ③ 字节数:账本纯追加,所以只可能"现在 >= 当时"。
    const logPath = getSessionEventsLogPath(sessionId)
    const size = fs.statSync(logPath).size
    if (size < file.ledgerBytes) return discard(sessionId, 'bytes', checkpointPath)
    // ④ 末行指纹 + 它自己的 seq。
    const lastLine = readLastLine(logPath, file.ledgerBytes)
    if (!lastLine) return discard(sessionId, 'line', checkpointPath)
    if (sha256(lastLine.bytes) !== file.lastLineSha256) return discard(sessionId, 'fingerprint', checkpointPath)
    const record = decodeSessionLogEventLine(lastLine.bytes.toString('utf8'))
    if (!record || record.seq !== file.lastSeq) return discard(sessionId, 'seq', checkpointPath)

    const { state, account } = decodeSessionProjectionCheckpoint(file.payload)
    if (state.lastSeq !== file.lastSeq) return discard(sessionId, 'seq', checkpointPath)
    return { state, account, lastSeq: file.lastSeq, fromByte: file.ledgerBytes }
  } catch (error) {
    // 坏文件(解不开 / 形状不对)与对不上是同一个结局:丢掉从头折。
    log.debug('projection checkpoint unusable', { sessionId, reason: 'corrupt' }, error)
    removeSessionProjectionCheckpoint(sessionId)
    return undefined
  }
}

function discard(sessionId: string, reason: string, _path: string): undefined {
  log.debug('projection checkpoint discarded', { sessionId, reason })
  removeSessionProjectionCheckpoint(sessionId)
  return undefined
}

/** 删掉这条会话的检查点(对不上、会话删除、测试)。删不掉不算错。 */
export function removeSessionProjectionCheckpoint(sessionId: string): void {
  try {
    fs.rmSync(getSessionProjectionCheckpointPath(sessionId), { force: true })
  } catch {
    // 派生物删不掉不该制造第二条错误路径:下一次读它照样过不了那四道门。
  }
}

export type SessionCheckpointWriteOutcome =
  | 'written'
  /** 账本此刻末行的 seq 与要写的这份投影对不上(采样撞上写),下次再说。 */
  | 'behind'
  /** 账本没写完(末字节不是 `\n`)/ 读不出末行 / 编不出来。 */
  | 'skipped'

/**
 * 写一份检查点。**唯一写入口**,两个挂点都走它。
 *
 * `expectedLastSeq` 是调用方手里那份投影折到的 seq —— 它必须与账本此刻的末行
 * 逐字对上,否则这份投影与这个字节数**不是同一时刻的事实**,写下去就是一份
 * 会让冷载少折 / 多折一段的假备忘。对不上就 `'behind'`,什么都不写。
 *
 * 落盘走临时文件 + `rename`:一份写到一半的检查点在崩溃后会被第四道门挡下来,
 * 但那要等到下一次冷载才发现;原子替换让它连出现的机会都没有。
 */
export function writeSessionProjectionCheckpoint(
  sessionId: string,
  state: SessionProjectionState,
  account: SessionAccountState,
  expectedLastSeq: number,
): SessionCheckpointWriteOutcome {
  try {
    const logPath = getSessionEventsLogPath(sessionId)
    const size = fs.statSync(logPath).size
    if (size <= 0) return 'skipped'
    const lastLine = readLastLine(logPath, size)
    // 末行读不出来 = 账本末字节不是 `\n` = 有一行正写到一半(见文件头)。
    if (!lastLine) return 'skipped'
    const record = decodeSessionLogEventLine(lastLine.bytes.toString('utf8'))
    if (!record) return 'skipped'
    if (record.seq !== expectedLastSeq || state.lastSeq !== expectedLastSeq) return 'behind'

    const file: SessionProjectionCheckpointFile = {
      sessionId,
      lastSeq: expectedLastSeq,
      ledgerBytes: size,
      lastLineSha256: sha256(lastLine.bytes),
      writtenAt: Date.now(),
      payload: encodeSessionProjectionCheckpoint(state, account),
    }
    const target = getSessionProjectionCheckpointPath(sessionId)
    const temporary = `${target}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(file), 'utf8')
    fs.renameSync(temporary, target)
    return 'written'
  } catch (error) {
    // 检查点是备忘:写不成只是下一次冷载慢一点,绝不能变成一条错误路径。
    log.debug('projection checkpoint not written', { sessionId }, error)
    return 'skipped'
  }
}

/**
 * 这条会话的检查点覆盖到哪(节流判据 / 度量 / 测试)。没有或读不开 → `undefined`。
 *
 * **只读信封那两格,不解码载荷** —— 判"要不要再写一份"不需要把整份投影解回来,
 * 而那正是这只函数会被每个 run 收尾调一次的原因。
 */
export function peekSessionProjectionCheckpointMeta(
  sessionId: string,
): { lastSeq: number; ledgerBytes: number } | undefined {
  try {
    const file = JSON.parse(
      fs.readFileSync(getSessionProjectionCheckpointPath(sessionId), 'utf8'),
    ) as SessionProjectionCheckpointFile
    if (typeof file?.lastSeq !== 'number' || typeof file?.ledgerBytes !== 'number') return undefined
    return { lastSeq: file.lastSeq, ledgerBytes: file.ledgerBytes }
  } catch {
    return undefined
  }
}
