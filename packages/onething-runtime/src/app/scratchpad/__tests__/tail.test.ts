/**
 * 装配层的**尾块正文**:自描述块头、超长截断、空纸不挂。
 *
 * 块的形状是与模型之间的合同 —— 哨兵(`<scratchpad `)、路径、版本号三样缺一
 * 不可:哨兵决定 core 能不能把上一块摘掉,路径决定模型能不能自己去读全文,
 * 版本号决定水位线画在哪。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string

vi.mock('../../stores/paths.js', () => ({
  getStorePath: () => root,
}))

const { buildScratchpadTail, updateScratchpad } = await import('../index.js')

describe('buildScratchpadTail', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'onething-scratchpad-tail-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('空纸 / 没有这张纸 → 不挂任何东西', async () => {
    expect(await buildScratchpadTail('never-written')).toBeUndefined()

    await updateScratchpad('blank', '   \n\n  ')
    expect(await buildScratchpadTail('blank')).toBeUndefined()
  })

  it('没有 sessionId 时不挂', async () => {
    expect(await buildScratchpadTail('')).toBeUndefined()
  })

  it('块头带哨兵、绝对路径与版本号,块尾闭合', async () => {
    const document = await updateScratchpad('session-a', '先查 A,再问 B')

    const tail = await buildScratchpadTail('session-a')

    expect(tail?.version).toBe(document.version)
    expect(tail?.text.startsWith('<scratchpad ')).toBe(true)
    expect(tail?.text).toContain(`path="${document.filePath}"`)
    expect(tail?.text).toContain(`version="${document.version}"`)
    expect(tail?.text).toContain('先查 A,再问 B')
    expect(tail?.text.endsWith('</scratchpad>')).toBe(true)
  })

  it('块内自带说明 —— 告诉模型这是背景参考,不是要它逐条回复的消息', async () => {
    await updateScratchpad('session-a', 'x')

    const tail = await buildScratchpadTail('session-a')

    expect(tail?.text).toContain('草稿纸')
    expect(tail?.text).toContain('不要逐条直接回复')
  })

  it('超长的纸从**头部**截断,并留一句话说明去哪找全文', async () => {
    // 纸是往下写的:最近写的那几行才是"用户此刻在想什么"。
    const head = 'HEAD-MARKER\n'
    const long = head + 'x'.repeat(20_000) + '\nTAIL-MARKER'
    await updateScratchpad('session-long', long)

    const tail = await buildScratchpadTail('session-long')

    expect(tail?.text).toContain('TAIL-MARKER')
    expect(tail?.text).not.toContain('HEAD-MARKER')
    expect(tail?.text).toContain('[前文已截断,完整内容读文件]')
  })

  it('版本随内容改变而改变 —— 水位线才有得对', async () => {
    await updateScratchpad('session-a', 'one')
    const first = await buildScratchpadTail('session-a')
    await new Promise(resolve => setTimeout(resolve, 5))
    await updateScratchpad('session-a', 'one\ntwo')
    const second = await buildScratchpadTail('session-a')

    expect(second?.text).not.toBe(first?.text)
    expect(second?.version).toBeGreaterThanOrEqual(first!.version)
  })
})
