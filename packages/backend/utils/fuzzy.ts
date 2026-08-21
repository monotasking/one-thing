export interface FuzzyMatchTarget<T> {
  item: T
  text: string
}

export interface FuzzyMatchResult<T> {
  item: T
  score: number
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\-/.:]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function acronym(value: string): string {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .map(part => part[0])
    .join('')
}

function sequentialScore(query: string, text: string): number {
  let score = 0
  let cursor = 0
  let lastIndex = -1

  for (const char of query) {
    const index = text.indexOf(char, cursor)
    if (index === -1) return 0
    score += lastIndex === index - 1 ? 2 : 1
    cursor = index + 1
    lastIndex = index
  }

  return score / Math.max(text.length, 1)
}

export function fuzzyScore(query: string | undefined, text: string): number {
  const q = normalize(query || '')
  if (!q) return 1

  const t = normalize(text)
  if (!t) return 0
  if (t === q) return 100
  if (t.startsWith(q)) return 80 - Math.min(t.length - q.length, 40)
  if (t.includes(q)) return 60 - Math.min(t.indexOf(q), 30)

  const initials = acronym(t)
  if (initials && initials.startsWith(q)) return 45

  const compactQuery = q.replace(/\s+/g, '')
  const compactText = t.replace(/\s+/g, '')
  const seq = sequentialScore(compactQuery, compactText)
  return seq > 0 ? 20 + seq * 20 : 0
}

export function fuzzyFilter<T>(
  items: Array<FuzzyMatchTarget<T>>,
  query?: string,
  limit = 50,
): Array<FuzzyMatchResult<T>> {
  const q = query?.trim()
  return items
    .map(target => ({
      item: target.item,
      score: fuzzyScore(q, target.text),
    }))
    .filter(result => !q || result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
