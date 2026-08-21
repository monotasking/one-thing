/**
 * Wildcard pattern matching utilities
 *
 * Provides simple glob-style pattern matching with * and ? wildcards.
 * Used for skill permission matching in Agent definitions.
 */

/**
 * Match a string against a wildcard pattern
 *
 * Supports:
 * - `*` matches zero or more characters
 * - `?` matches exactly one character
 *
 * @param str - The string to match
 * @param pattern - The wildcard pattern
 * @returns true if the string matches the pattern
 *
 * @example
 * ```typescript
 * Wildcard.match('code-review', 'code-*')     // true
 * Wildcard.match('code-review', '*-review')   // true
 * Wildcard.match('test', 'tes?')              // true
 * Wildcard.match('test', '*')                 // true
 * Wildcard.match('abc', 'ab')                 // false
 * ```
 */
export function match(str: string, pattern: string): boolean {
  // Convert wildcard pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars (except * and ?)
    .replace(/\*/g, '.*') // * matches zero or more chars
    .replace(/\?/g, '.') // ? matches exactly one char

  const regex = new RegExp(`^${regexPattern}$`, 'i')
  return regex.test(str)
}

/**
 * Match a string against multiple patterns and return the last matched value
 *
 * Patterns are evaluated in order. Later patterns override earlier ones.
 * This allows for patterns like:
 * - { "*": "allow", "dangerous-*": "deny" }
 *   -> All skills allowed except those starting with "dangerous-"
 *
 * @param input - The string to match
 * @param patterns - Object mapping patterns to values
 * @returns The value of the last matching pattern, or undefined if none match
 *
 * @example
 * ```typescript
 * Wildcard.all('code-review', {
 *   '*': 'allow',
 *   'dangerous-*': 'deny'
 * })
 * // Returns 'allow' (matches '*', doesn't match 'dangerous-*')
 *
 * Wildcard.all('dangerous-delete', {
 *   '*': 'allow',
 *   'dangerous-*': 'deny'
 * })
 * // Returns 'deny' (matches both, 'dangerous-*' is last)
 * ```
 */
export function all<T>(input: string, patterns: Record<string, T>): T | undefined {
  let result: T | undefined

  for (const [pattern, value] of Object.entries(patterns)) {
    if (match(input, pattern)) {
      result = value
    }
  }

  return result
}

/**
 * Wildcard namespace for convenient access
 */
export const Wildcard = {
  match,
  all,
}

export default Wildcard
