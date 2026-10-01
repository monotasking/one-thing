export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonObjectProperty = JsonValue | undefined

export interface JsonObject {
  [key: string]: JsonObjectProperty
}

export type JsonArray = JsonValue[]

export interface JsonSchemaObject extends JsonObject {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaObject>
  items?: JsonSchemaObject
  required?: string[]
  enum?: JsonArray
}

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseJsonObject(value: string): JsonObject {
  if (!value.trim()) return {}
  const parsed = JSON.parse(value) as unknown
  if (!isJsonObject(parsed)) {
    throw new Error('Expected JSON object')
  }
  return parsed
}

export function toJsonValue<T>(value: T): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value as JsonPrimitive
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined

  if (Array.isArray(value)) {
    const result: JsonArray = []
    for (const item of value) {
      const jsonItem = toJsonValue(item)
      if (jsonItem !== undefined) result.push(jsonItem)
    }
    return result
  }

  if (value && typeof value === 'object') {
    const result: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      const jsonItem = toJsonValue(item)
      if (jsonItem !== undefined) result[key] = jsonItem
    }
    return result
  }

  return undefined
}

export function toJsonObject<T>(value: T): JsonObject {
  const json = toJsonValue(value)
  return json && typeof json === 'object' && !Array.isArray(json) ? json : {}
}

export function toJsonSchemaObject<T>(value: T): JsonSchemaObject {
  return toJsonObject(value) as JsonSchemaObject
}
