import crypto from 'node:crypto'
import fs from 'node:fs/promises'

function hasErrorCode(error: Error | object | string | number | boolean | null | undefined, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

export interface TextFileSnapshot {
  exists: boolean
  content: string
  hash: string
}

export async function readTextFileSnapshot(filePath: string): Promise<TextFileSnapshot> {
  try {
    const stats = await fs.stat(filePath)
    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`)
    }
    const content = await fs.readFile(filePath, 'utf-8')
    return {
      exists: true,
      content,
      hash: hashTextFileSnapshot(true, content),
    }
  } catch (error) {
    const caught = error instanceof Error || (error && typeof error === 'object') ? error : String(error)
    if (!hasErrorCode(caught, 'ENOENT')) {
      throw error
    }
    return {
      exists: false,
      content: '',
      hash: hashTextFileSnapshot(false, ''),
    }
  }
}

export function hashTextFileSnapshot(exists: boolean, content: string): string {
  return crypto
    .createHash('sha256')
    .update(exists ? 'file\0' : 'missing\0')
    .update(content)
    .digest('hex')
}

function splitDiffLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  const previous = new Array(right.length + 1).fill(0)
  const current = new Array(right.length + 1).fill(0)

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1])
    }
    previous.splice(0, previous.length, ...current)
    current.fill(0)
  }

  return previous[right.length]
}

export function countLineChanges(oldContent: string, newContent: string): {
  additions: number
  deletions: number
} {
  const oldLines = splitDiffLines(oldContent)
  const newLines = splitDiffLines(newContent)
  const unchanged = longestCommonSubsequenceLength(oldLines, newLines)
  return {
    additions: newLines.length - unchanged,
    deletions: oldLines.length - unchanged,
  }
}
