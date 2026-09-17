/**
 * 宠物账本与「当前是哪一只」的落盘(宠物 P2,正本 `docs/design/pet-system-2026-09.md` §9.1)。
 *
 *   · `<store>/pets/<id>/ledger.jsonl` —— 追加写,一行一件事(行形在
 *     `@onething/runtime/pets/ledger`)。启动与换宠物时读**尾部** N 行;
 *   · `<store>/pets/current.json`     —— `{ "id": "<petId>" }`,记当前领养的那一只。
 *
 * ── 坏的就跳过,不抛 ────────────────────────────────────────────────────────
 * 这两个文件是用户机器上的普通文件:进程被杀留下的半行、手改坏的 JSON、以后版本多出来的
 * 行形,都会在这里读到。**一行坏账跳过那一行,一个坏的 `current.json` 当它不存在** ——
 * 宠物失忆一格或者回到缺省那一只,远好过整个宿主起不来。跳过的行数记一条 warn,
 * 便于排障,不上屏。
 *
 * ── 写为什么串行、失败为什么不抛 ─────────────────────────────────────────
 * 追加走一条 promise 链,保证行序就是事实发生的顺序(并发 `appendFile` 在同一个文件上
 * 不保证先来先写)。写失败只记 error:账本是记忆,不是事实的唯一真相 —— 话语已经作为
 * `pet:` 事件发出去了,为一次落盘失败让那条事件的调用方收到异常是本末倒置。
 * `flush()` 等链跑完,`dispose` 用它。
 *
 * ── 读尾部为什么不整个读 ─────────────────────────────────────────────────
 * 账本只增不减(P2 不做轮转),一年下来可能几十 MB,而启动只要最后 50 行。从文件尾往前
 * 读一块(`TAIL_BYTES`),丢掉块首那半行,够用了;一行比这一块还长的账是异常数据,丢掉。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { parsePetLedgerLine, PET_MEMORY_LINES, type PetLedgerLine } from '@onething/runtime/pets'
import { getLogger } from '../logging/index.js'

const log = getLogger('pets.ledger')

/** 从文件尾往前读多少字节找最后 N 行。 */
const TAIL_BYTES = 256 * 1024

export const PET_LEDGER_FILE = 'ledger.jsonl'
export const PET_CURRENT_FILE = 'current.json'

export class PetLedgerStore {
  private chain: Promise<void> = Promise.resolve()

  /** `dir` = `<store>/pets`(`getOnethingPetsDir`)。 */
  constructor(private readonly dir: string, private readonly assertOwned: () => void = () => {}) {}

  ledgerPath(petId: string): string {
    return path.join(this.dir, petId, PET_LEDGER_FILE)
  }

  /** 这只宠物账本的最后 `limit` 行(旧的在前)。文件不存在 = 空。 */
  async readTail(petId: string, limit = PET_MEMORY_LINES): Promise<PetLedgerLine[]> {
    // 先等在飞的追加落地:换宠物再换回来时,读的不该是少了最后几行的账。
    await this.flush()
    const file = this.ledgerPath(petId)
    let handle: fs.FileHandle
    try {
      handle = await fs.open(file, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('pet ledger unreadable', { petId }, error)
      return []
    }
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const buffer = Buffer.alloc(size - start)
      await handle.read(buffer, 0, buffer.length, start)
      const rows = buffer.toString('utf8').split('\n')
      // 从中间开始读的那一块,第一行多半是半截。
      if (start > 0) rows.shift()
      const lines: PetLedgerLine[] = []
      let skipped = 0
      for (const row of rows) {
        if (!row.trim()) continue
        const line = parsePetLedgerLine(row)
        if (line && line.petId === petId) lines.push(line)
        else skipped += 1
      }
      if (skipped > 0) log.warn('skipped unreadable pet ledger lines', { petId, skipped })
      return lines.slice(-limit)
    } catch (error) {
      log.warn('pet ledger unreadable', { petId }, error)
      return []
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** 追加若干行(按顺序)。串行、不抛,见文件头。 */
  append(petId: string, lines: readonly PetLedgerLine[]): Promise<void> {
    if (lines.length === 0) return this.chain
    const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
    const file = this.ledgerPath(petId)
    this.chain = this.chain.then(async () => {
      try {
        this.assertOwned()
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, text, 'utf8')
      } catch (error) {
        log.error('pet ledger append failed', { petId, lines: lines.length }, error)
      }
    })
    return this.chain
  }

  /** 当前领养的宠物 id。文件不存在或坏了 = `null`(调用方回到缺省那一只)。 */
  async readCurrent(): Promise<string | null> {
    let text: string
    try {
      text = await fs.readFile(path.join(this.dir, PET_CURRENT_FILE), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('pet current.json unreadable', undefined, error)
      return null
    }
    try {
      const value = JSON.parse(text) as unknown
      if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
        return (value as { id: string }).id
      }
    } catch {
      // 落到下面那一句
    }
    log.warn('pet current.json is malformed; falling back to the default pet')
    return null
  }

  /** 写 `current.json`(先写临时文件再改名,不留半个文件)。排进同一条链。 */
  writeCurrent(petId: string): Promise<void> {
    const target = path.join(this.dir, PET_CURRENT_FILE)
    this.chain = this.chain.then(async () => {
      try {
        this.assertOwned()
        await fs.mkdir(this.dir, { recursive: true })
        const temp = `${target}.${process.pid}.tmp`
        await fs.writeFile(temp, `${JSON.stringify({ id: petId })}\n`, 'utf8')
        await fs.rename(temp, target)
      } catch (error) {
        log.error('pet current.json write failed', { petId }, error)
      }
    })
    return this.chain
  }

  /** 等所有排着的写落地。 */
  flush(): Promise<void> {
    return this.chain
  }
}
