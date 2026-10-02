/**
 * A music CLI's stdout is JSON with company: ncm-cli prints stray non-JSON
 * lines before its envelope (`[orpheus] orpheus://...`, and since 0.1.7 was
 * published, a `│ 有新版本: 0.1.6 → 0.1.7` banner on EVERY command). So every
 * reader scans for the first balanced top-level object instead of
 * JSON.parse-ing the whole stream. 2026-09-18: `state` / `search` / `lyric`
 * each parsed the whole stream, and the day the banner appeared every
 * `state` read came back null — the radio judged every start a failure while
 * the songs played, and the panel said nothing was playing.
 */
export function extractFirstJsonObject<T = unknown>(stdout: string): T | null {
  const start = stdout.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < stdout.length; index += 1) {
    const char = stdout[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(start, index + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}
