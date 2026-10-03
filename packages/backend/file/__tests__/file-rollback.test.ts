import { describe, expect, it, vi } from 'vitest'
import { rollbackOnethingFile } from '../file-rollback.js'

describe('file rollback runtime operation', () => {
  it('uses audit undo when an audit path is supplied', async () => {
    const applyAuditUndo = vi.fn(async () => ({
      auditId: 'audit-1',
      filePath: '/repo/file.txt',
      restoredExists: true,
    }))

    await expect(rollbackOnethingFile({
      auditPath: '/audits/audit-1.json',
      applyAuditUndo,
      deleteFile: vi.fn(),
      writeFile: vi.fn(),
    })).resolves.toEqual({
      success: true,
      auditId: 'audit-1',
      filePath: '/repo/file.txt',
      restoredExists: true,
    })
    expect(applyAuditUndo).toHaveBeenCalledWith('/audits/audit-1.json')
  })

  it('keeps legacy rollback behavior for deleted and restored files', async () => {
    const deleteFile = vi.fn()
    const writeFile = vi.fn()

    await expect(rollbackOnethingFile({
      filePath: '/repo/new.txt',
      isNew: true,
      applyAuditUndo: vi.fn(),
      deleteFile,
      writeFile,
    })).resolves.toEqual({
      success: true,
      filePath: '/repo/new.txt',
      restoredExists: false,
    })
    expect(deleteFile).toHaveBeenCalledWith('/repo/new.txt')

    await expect(rollbackOnethingFile({
      filePath: '/repo/existing.txt',
      originalContent: 'before',
      applyAuditUndo: vi.fn(),
      deleteFile,
      writeFile,
    })).resolves.toEqual({
      success: true,
      filePath: '/repo/existing.txt',
      restoredExists: true,
    })
    expect(writeFile).toHaveBeenCalledWith('/repo/existing.txt', 'before')
  })

  it('projects validation and adapter errors', async () => {
    await expect(rollbackOnethingFile({
      applyAuditUndo: vi.fn(),
      deleteFile: vi.fn(),
      writeFile: vi.fn(),
    })).resolves.toEqual({
      success: false,
      error: 'File path or audit path is required',
    })

    await expect(rollbackOnethingFile({
      auditPath: '/audits/audit-1.json',
      applyAuditUndo: async () => {
        throw new Error('changed since audit')
      },
      deleteFile: vi.fn(),
      writeFile: vi.fn(),
    })).resolves.toEqual({
      success: false,
      error: 'changed since audit',
    })
  })
})
