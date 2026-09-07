import fs from 'node:fs'
import path from 'node:path'

const ignoredDirectories = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'dist-web', 'dist-strict',
  'out', 'release', 'ds-bundle', '.ds-sync', 'coverage',
])
const textExtension = /\.(ts|tsx|js|mjs|cjs|json|vue|css|md)$/

/** Scan source and test text, excluding generated output rather than hiding offending source. */
export function findSourceControlCharacters(root, roots = ['packages', 'apps', 'scripts']) {
  const offenders = []
  function visit(directory) {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(file)
        continue
      }
      if (!textExtension.test(entry.name)) continue
      const bytes = fs.readFileSync(file)
      for (let offset = 0; offset < bytes.length; offset += 1) {
        const byte = bytes[offset]
        if (!(byte < 0x09 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f))) continue
        offenders.push({
          file: path.relative(root, file).split(path.sep).join('/'),
          line: bytes.subarray(0, offset).toString('utf8').split('\n').length,
          byte,
        })
        break
      }
    }
  }
  for (const directory of roots) visit(path.join(root, directory))
  return offenders
}
