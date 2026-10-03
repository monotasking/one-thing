import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { applyFileMutationUndo, hashAuditContent, recordFileMutationAudit } from '../file-mutation-audit.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-audit-'))
  dirs.push(dir)
  return dir
}

describe('runtime file-mutation-audit', () => {
  it('records before/after content and hashes atomically', async () => {
    const auditDir = await tempDir()
    const result = await recordFileMutationAudit({
      auditDir,
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      operation: 'edit',
      path: '/tmp/a.ts',
      beforeExists: true,
      beforeContent: 'old\n',
      afterContent: 'new\n',
      diff: '-old\n+new\n',
      metadata: { additions: 1, deletions: 1 },
    })

    const raw = await fs.readFile(result.path, 'utf-8')
    const record = JSON.parse(raw)

    expect(record).toMatchObject({
      id: result.id,
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'tc1',
      operation: 'edit',
      filePath: '/tmp/a.ts',
      beforeExists: true,
      afterExists: true,
      beforeContent: 'old\n',
      afterContent: 'new\n',
      diff: '-old\n+new\n',
      metadata: { additions: 1, deletions: 1 },
    })
    expect(record.beforeHash).toBe(hashAuditContent(true, 'old\n'))
    expect(record.afterHash).toBe(hashAuditContent(true, 'new\n'))
  })

  it('distinguishes missing files from empty files in hashes', () => {
    expect(hashAuditContent(false, '')).not.toBe(hashAuditContent(true, ''))
  })

  it('undoes an edit/overwrite when the current file still matches afterHash', async () => {
    const auditDir = await tempDir()
    const workspace = await tempDir()
    const filePath = path.join(workspace, 'target.txt')
    await fs.writeFile(filePath, 'new\n', 'utf-8')

    const audit = await recordFileMutationAudit({
      auditDir,
      sessionId: 's1',
      messageId: 'm1',
      operation: 'edit',
      path: filePath,
      beforeExists: true,
      beforeContent: 'old\n',
      afterContent: 'new\n',
      diff: '-old\n+new\n',
    })

    await expect(applyFileMutationUndo(audit.path)).resolves.toMatchObject({
      auditId: audit.id,
      filePath,
      restoredExists: true,
      beforeHash: hashAuditContent(true, 'old\n'),
      previousCurrentHash: hashAuditContent(true, 'new\n'),
    })
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('old\n')
  })

  it('undoes a create by deleting the created file', async () => {
    const auditDir = await tempDir()
    const workspace = await tempDir()
    const filePath = path.join(workspace, 'created.txt')
    await fs.writeFile(filePath, 'created\n', 'utf-8')

    const audit = await recordFileMutationAudit({
      auditDir,
      sessionId: 's1',
      messageId: 'm1',
      operation: 'write_create',
      path: filePath,
      beforeExists: false,
      beforeContent: '',
      afterContent: 'created\n',
      diff: '+created\n',
    })

    await expect(applyFileMutationUndo(audit.path)).resolves.toMatchObject({
      auditId: audit.id,
      restoredExists: false,
    })
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses undo when the file changed after the audited mutation', async () => {
    const auditDir = await tempDir()
    const workspace = await tempDir()
    const filePath = path.join(workspace, 'target.txt')
    await fs.writeFile(filePath, 'new\n', 'utf-8')

    const audit = await recordFileMutationAudit({
      auditDir,
      sessionId: 's1',
      messageId: 'm1',
      operation: 'write_overwrite',
      path: filePath,
      beforeExists: true,
      beforeContent: 'old\n',
      afterContent: 'new\n',
      diff: '-old\n+new\n',
    })

    await fs.writeFile(filePath, 'changed again\n', 'utf-8')

    await expect(applyFileMutationUndo(audit.path)).rejects.toThrow('has changed since the recorded mutation')
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('changed again\n')
  })
})
