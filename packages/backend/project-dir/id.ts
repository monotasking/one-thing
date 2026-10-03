import { createHash } from 'node:crypto'

const ID_LENGTH = 16

export function projectIdFromPath(path: string): string {
  return createHash('sha256')
    .update(canonicalize(path))
    .digest('hex')
    .slice(0, ID_LENGTH)
}

function canonicalize(path: string): string {
  return path.replace(/\/+$/, '')
}
