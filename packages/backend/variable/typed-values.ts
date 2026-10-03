import { VariableError, type VariableType } from './types.js'

/**
 * Typed value handling for the custom-variable stores.
 *
 * `ContextVariable.value` stays a string everywhere (persistence, IPC,
 * prompt rendering); the type only decides how that string is validated and
 * normalized on write, and gives list/set/map element-level append/remove.
 * Canonical forms: scalars as plain text ("1.5", "true"), collections as
 * compact JSON — writes normalize so identical logical values always
 * serialize to identical bytes.
 */

export const VARIABLE_TYPES: readonly VariableType[] = Object.freeze([
  'string',
  'number',
  'bool',
  'list',
  'map',
  'set',
])

export function isVariableType(value: unknown): value is VariableType {
  return typeof value === 'string' && (VARIABLE_TYPES as string[]).includes(value)
}

/** Collection types supporting element-level append/remove. */
const COLLECTION_TYPES = new Set<VariableType>(['list', 'set', 'map'])

export function isCollectionType(type: VariableType | undefined): boolean {
  return type !== undefined && COLLECTION_TYPES.has(type)
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function invalid(message: string): never {
  throw new VariableError('INVALID_VALUE', message)
}

function parseJson(raw: string, expectation: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    invalid(`Value is not valid JSON (expected ${expectation}): ${truncateForError(raw)}`)
  }
}

function truncateForError(raw: string): string {
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * An element passed to append/remove: JSON when it parses ("5" → 5,
 * '{"a":1}' → object), the raw string otherwise ("alice" → "alice") — so
 * plain words work without quoting while structured elements stay typed.
 */
function parseElement(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return raw
  }
}

function elementKey(element: JsonValue): string {
  return JSON.stringify(element)
}

function dedupe(elements: JsonValue[]): JsonValue[] {
  const seen = new Set<string>()
  const output: JsonValue[] = []
  for (const element of elements) {
    const key = elementKey(element)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(element)
  }
  return output
}

/** Validate `raw` against `type` and return the canonical serialization. */
export function normalizeTypedValue(type: VariableType, raw: string): string {
  switch (type) {
    case 'string':
      return raw
    case 'number': {
      const trimmed = raw.trim()
      if (!trimmed) invalid('Number value must not be empty')
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) invalid(`Not a finite number: ${truncateForError(raw)}`)
      return String(parsed)
    }
    case 'bool': {
      const lowered = raw.trim().toLowerCase()
      if (lowered !== 'true' && lowered !== 'false') {
        invalid(`Bool value must be "true" or "false", got: ${truncateForError(raw)}`)
      }
      return lowered
    }
    case 'list': {
      const parsed = parseJson(raw, 'a JSON array')
      if (!Array.isArray(parsed)) invalid('List value must be a JSON array')
      return JSON.stringify(parsed)
    }
    case 'set': {
      const parsed = parseJson(raw, 'a JSON array')
      if (!Array.isArray(parsed)) invalid('Set value must be a JSON array')
      return JSON.stringify(dedupe(parsed))
    }
    case 'map': {
      const parsed = parseJson(raw, 'a JSON object')
      if (!isPlainObject(parsed)) invalid('Map value must be a JSON object')
      return JSON.stringify(parsed)
    }
  }
}

/**
 * Append to a collection variable: push (list), add-if-absent (set), or
 * shallow-merge a JSON object (map). Returns the new canonical value.
 */
export function appendTypedValue(type: VariableType, currentValue: string, raw: string): string {
  if (type === 'list' || type === 'set') {
    const current = JSON.parse(normalizeTypedValue(type, currentValue)) as JsonValue[]
    const element = parseElement(raw)
    if (type === 'set') {
      const key = elementKey(element)
      if (current.some(existing => elementKey(existing) === key)) {
        return JSON.stringify(current)
      }
    }
    return JSON.stringify([...current, element])
  }
  if (type === 'map') {
    const current = JSON.parse(normalizeTypedValue(type, currentValue)) as { [key: string]: JsonValue }
    const patch = parseElement(raw)
    if (!isPlainObject(patch)) {
      invalid('Appending to a map takes a JSON object to merge, e.g. {"key": "value"}')
    }
    return JSON.stringify({ ...current, ...patch })
  }
  invalid(`append works on list, set and map variables; this variable is ${type}. Use set to replace the value.`)
}

// ── Store-level helpers ─────────────────────────────
// Shared by the session/global/keyed store providers so typed semantics
// cannot drift between scopes.

export interface TypedValueState {
  type?: VariableType
  value: string
}

/**
 * Resolve the effective (type, canonical value) for a set. The declared type
 * wins, else the variable keeps its existing type, else 'string'. Plain
 * strings store no type marker — legacy variables stay byte-identical.
 */
export function typedValueForSet(
  input: { value: string; type?: VariableType },
  existing: { type?: VariableType } | undefined,
): TypedValueState {
  const type = input.type ?? existing?.type ?? 'string'
  return {
    type: type === 'string' ? undefined : type,
    value: normalizeTypedValue(type, input.value),
  }
}

/**
 * Append semantics for a store provider. A missing variable is created as a
 * fresh collection (input.type, default 'list') holding the element — the
 * accumulate-from-nothing pattern needs no priming set call.
 */
export function typedValueForAppend(
  existing: TypedValueState | undefined,
  input: { value: string; type?: VariableType },
): TypedValueState {
  if (!existing) {
    const type = input.type ?? 'list'
    if (!isCollectionType(type)) {
      invalid(`append creates list, set or map variables; got type "${type}". Use set for scalar values.`)
    }
    const empty = type === 'map' ? '{}' : '[]'
    return { type, value: appendTypedValue(type, empty, input.value) }
  }
  const type = existing.type ?? 'string'
  if (input.type && input.type !== type) {
    invalid(`Variable is ${type}; append cannot change it to ${input.type}. Use set to replace the value.`)
  }
  return { type: existing.type, value: appendTypedValue(type, existing.value, input.value) }
}

/** Remove semantics for a store provider; the variable must exist. */
export function typedValueForRemove(
  existing: TypedValueState | undefined,
  name: string,
  input: { value: string },
): TypedValueState {
  if (!existing) {
    throw new VariableError('NOT_FOUND', `No variable named "${name}"`)
  }
  const type = existing.type ?? 'string'
  return { type: existing.type, value: removeTypedValue(type, existing.value, input.value) }
}

/**
 * Remove from a collection variable: drop equal elements (list/set) or
 * delete a key (map). Throws NOT_FOUND when nothing matched.
 */
export function removeTypedValue(type: VariableType, currentValue: string, raw: string): string {
  if (type === 'list' || type === 'set') {
    const current = JSON.parse(normalizeTypedValue(type, currentValue)) as JsonValue[]
    const key = elementKey(parseElement(raw))
    const next = current.filter(element => elementKey(element) !== key)
    if (next.length === current.length) {
      throw new VariableError('NOT_FOUND', `Element not found in ${type}: ${truncateForError(raw)}`)
    }
    return JSON.stringify(next)
  }
  if (type === 'map') {
    const current = JSON.parse(normalizeTypedValue(type, currentValue)) as { [key: string]: JsonValue }
    const parsed = parseElement(raw)
    const mapKey = typeof parsed === 'string' ? parsed : raw.trim()
    if (!(mapKey in current)) {
      throw new VariableError('NOT_FOUND', `Key not found in map: ${truncateForError(mapKey)}`)
    }
    const { [mapKey]: _removed, ...rest } = current
    return JSON.stringify(rest)
  }
  invalid(`remove works on list, set and map variables; this variable is ${type}. Use delete to drop the variable.`)
}
