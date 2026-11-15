/** Tool parameter schemas for DSH: a zod schema as the JSON Schema subset DSH's tool runtime validates and renders. */
import { z } from 'zod'

const DSH_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function sanitizeDshJsonSchemaNode(rawNode: unknown): Record<string, unknown> {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) return {}
  const node = rawNode as Record<string, unknown>
  const annotations: Record<string, unknown> = {}
  if (typeof node.description === 'string') annotations.description = node.description
  if (typeof node.title === 'string') annotations.title = node.title
  if (Object.hasOwn(node, 'default') && node.default !== undefined) annotations.default = node.default
  if (Array.isArray(node.examples)) annotations.examples = node.examples

  const unionBranches = Array.isArray(node.oneOf) && node.oneOf.length >= 2
    ? node.oneOf
    : Array.isArray(node.anyOf) && node.anyOf.length >= 2
      ? node.anyOf
      : undefined
  if (unionBranches) {
    return {
      ...annotations,
      oneOf: unionBranches.map(branch => sanitizeDshJsonSchemaNode(branch)),
    }
  }

  if (Array.isArray(node.type) && node.type.length >= 2) {
    return {
      ...annotations,
      oneOf: node.type.map(branchType => sanitizeDshJsonSchemaNode({ ...node, type: branchType })),
    }
  }

  const type = typeof node.type === 'string' && DSH_SCHEMA_TYPES.has(node.type) ? node.type : undefined
  if (!type) return annotations

  if (type === 'object') {
    const rawProps = node.properties
    const properties: Record<string, unknown> = {}
    if (rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps)) {
      for (const [key, propSchema] of Object.entries(rawProps as Record<string, unknown>)) {
        properties[key] = sanitizeDshJsonSchemaNode(propSchema)
      }
    }
    const required = Array.isArray(node.required)
      ? node.required.filter((key): key is string => typeof key === 'string' && Object.hasOwn(properties, key))
      : []
    const additionalProperties = typeof node.additionalProperties === 'boolean'
      ? node.additionalProperties
      : Boolean(node.additionalProperties && typeof node.additionalProperties === 'object')
    return {
      ...annotations,
      type: 'object',
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties,
    }
  }

  if (type === 'array') {
    const items = node.items && typeof node.items === 'object' && !Array.isArray(node.items)
      ? sanitizeDshJsonSchemaNode(node.items)
      : undefined
    return {
      ...annotations,
      type: 'array',
      ...(items ? { items } : {}),
    }
  }

  return {
    ...annotations,
    type,
    ...(Array.isArray(node.enum) && node.enum.length > 0 ? { enum: node.enum } : {}),
    ...(Object.hasOwn(node, 'const') && node.const !== undefined ? { const: node.const } : {}),
  }
}

/** Converts a Zod schema into the strict JSON Schema subset enforced by `@deepseek-ai/dsh-tools` (including PTC mode SDK codegen). */
export function toDshParameterSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitizeDshJsonSchemaNode(z.toJSONSchema(schema))
}
