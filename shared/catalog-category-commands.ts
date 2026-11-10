import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'
export const categoryHasControls = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const text = (minimum: number, maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !categoryHasControls(value))
    .transform((value) => value.trim())
    .pipe(z.string().min(minimum).max(maximum))
export const catalogCategoryIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
const reason = text(3, 500)
export const catalogCategoryActionSchema = z.enum(['create_category', 'update_category', 'delete_category'])
export const createCategoryInputSchema = z.preprocess(
  own,
  z
    .object({
      name: text(2, 160),
      parentId: catalogCategoryIdSchema.nullable().optional(),
      expectedVersion: z.literal(0),
      reason
    })
    .strict()
)
export const updateCategoryInputSchema = z.preprocess(
  own,
  z
    .object({
      name: text(2, 160),
      parentId: catalogCategoryIdSchema.nullable().optional(),
      expectedVersion: version,
      reason
    })
    .strict()
)
export const deleteCategoryInputSchema = z.preprocess(own, z.object({ expectedVersion: version, reason }).strict())
export const catalogCategoryStatusSchema = z.enum(['draft', 'review', 'published', 'hidden', 'discontinued'])
// Existing durable IDs are TEXT and imports may predate canonical UUID checks.
// New commands allocate real UUIDs; historical read identity remains exact.
const durableId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !categoryHasControls(value))
export const catalogCategorySnapshotSchema = z.preprocess(
  own,
  z
    .object({
      id: catalogCategoryIdSchema,
      uuid: durableId,
      version: catalogCategoryIdSchema,
      name: z.string().max(10000),
      slug: z.string().min(1).max(1000),
      status: catalogCategoryStatusSchema,
      actualParentUuid: durableId.nullable(),
      actualParentId: catalogCategoryIdSchema.nullable(),
      parentMapped: z.boolean(),
      sort: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      directChildren: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      directProducts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
    })
    .strict()
    .superRefine((value, context) => {
      if (value.actualParentUuid === null && (value.actualParentId !== null || !value.parentMapped))
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid root identity' })
      if (value.actualParentUuid !== null && value.parentMapped !== (value.actualParentId !== null))
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid parent identity' })
    })
)
export const catalogCategoryReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: catalogCategoryActionSchema,
      categoryId: catalogCategoryIdSchema,
      categoryUuid: durableId,
      categoryVersion: catalogCategoryIdSchema,
      slug: z.string().min(1).max(1000),
      status: catalogCategoryStatusSchema,
      updated: z.literal(true)
    })
    .strict()
)
export const catalogCategoryClaimsSchema = z.preprocess(
  own,
  z
    .object({
      identityId: catalogPolicyUuidSchema,
      sessionId: catalogPolicyUuidSchema,
      sessionVersion: catalogCategoryIdSchema
    })
    .strict()
)
export type CatalogCategoryAction = z.infer<typeof catalogCategoryActionSchema>
export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>
export type UpdateCategoryInput = z.infer<typeof updateCategoryInputSchema>
export type DeleteCategoryInput = z.infer<typeof deleteCategoryInputSchema>
export type CatalogCategorySnapshot = z.infer<typeof catalogCategorySnapshotSchema>
export type CatalogCategoryReceipt = z.infer<typeof catalogCategoryReceiptSchema>

const readRowSchema = z
  .object({
    id: catalogCategoryIdSchema,
    name: z.string().max(10000),
    slug: z.string().min(1).max(1000),
    parentId: catalogCategoryIdSchema.nullable(),
    sort: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    status: catalogCategoryStatusSchema,
    directCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    authoring: catalogCategorySnapshotSchema
  })
  .strict()
  .refine(
    (row) =>
      row.id === row.authoring.id &&
      row.name === row.authoring.name &&
      row.slug === row.authoring.slug &&
      row.status === row.authoring.status &&
      row.sort === row.authoring.sort &&
      row.directCount === row.authoring.directProducts
  )
type ReadRow = z.infer<typeof readRowSchema>
export interface CatalogCategoryReadNode extends ReadRow {
  children: CatalogCategoryReadNode[]
}
export interface CatalogCategoryAdminView {
  source: 'cloudflare'
  capabilities: Record<string, boolean>
  flat: ReadRow[]
  roots: CatalogCategoryReadNode[]
  unmappedCategories: number
}
function descriptors(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) return null
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Object.values(fields).some((field) => !field.enumerable || !Object.hasOwn(field, 'value'))) return null
  return fields
}
function arrayItems(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 1000) return null
  const fields = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value)
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        typeof key !== 'string' || (key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
    )
  )
    return null
  const items: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const field = fields[String(index)]
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) return null
    items.push(field.value)
  }
  return items
}
/** Validate the flat own-data DTO first, then its deep tree iteratively. Do not
 * weaken the existing JSON own-data guard or invoke accessors in nested roots.
 * Actual-parent snapshot and legacy projection are deliberately distinct. */
export function parseD1CategoryAdminView(value: unknown): CatalogCategoryAdminView | null {
  try {
    const top = descriptors(value)
    if (
      !top ||
      Object.keys(top).some((key) => !['source', 'capabilities', 'flat', 'roots', 'unmappedCategories'].includes(key))
    )
      return null
    const base = z
      .object({
        source: z.literal('cloudflare'),
        capabilities: z.record(z.string(), z.boolean()),
        flat: z.array(readRowSchema).max(1000),
        unmappedCategories: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
      })
      .strict()
      .safeParse(
        catalogPolicyOwnJson({
          source: top.source?.value,
          capabilities: top.capabilities?.value,
          flat: top.flat?.value,
          unmappedCategories: top.unmappedCategories?.value
        })
      )
    if (
      !base.success ||
      !Object.hasOwn(base.data.capabilities, 'categoriesRead') ||
      base.data.capabilities.categoriesRead !== true ||
      !['categoryCreate', 'categoryUpdate', 'categoryDelete'].every((key) => Object.hasOwn(base.data.capabilities, key))
    )
      return null
    const rows = new Map(base.data.flat.map((row) => [row.id, row])),
      uuids = new Set(base.data.flat.map((row) => row.authoring.uuid))
    if (rows.size !== base.data.flat.length || uuids.size !== rows.size) return null
    for (const row of rows.values()) {
      const seen = new Set([row.id])
      let current = row,
        depth = 0
      while (current.parentId !== null) {
        const parent = rows.get(current.parentId)
        if (!parent || seen.has(parent.id) || ++depth > 128) return null
        seen.add(parent.id)
        current = parent
      }
      if (row.authoring.actualParentUuid !== null && row.authoring.parentMapped) {
        const parent = rows.get(row.authoring.actualParentId!)
        if (!parent || parent.authoring.uuid !== row.authoring.actualParentUuid || row.parentId !== parent.id)
          return null
      }
      if (row.authoring.actualParentUuid === null && row.parentId !== null) return null
    }
    const rootItems = arrayItems(top.roots?.value)
    if (!rootItems) return null
    const roots: CatalogCategoryReadNode[] = [],
      seen = new Set<number>(),
      objects = new Set<object>()
    const stack = rootItems
      .slice()
      .reverse()
      .map((node) => ({ node, parent: null as number | null, depth: 0, output: roots }))
    while (stack.length) {
      const task = stack.pop()!,
        fields = descriptors(task.node)
      if (!fields || task.depth > 128 || objects.has(task.node as object) || seen.size >= 1000) return null
      objects.add(task.node as object)
      const children = arrayItems(fields.children?.value)
      if (!children) return null
      const ownRow: Record<string, unknown> = Object.create(null)
      for (const [key, field] of Object.entries(fields)) if (key !== 'children') ownRow[key] = field.value
      const parsed = readRowSchema.safeParse(catalogPolicyOwnJson(ownRow))
      if (
        !parsed.success ||
        seen.has(parsed.data.id) ||
        parsed.data.parentId !== task.parent ||
        JSON.stringify(parsed.data) !== JSON.stringify(rows.get(parsed.data.id))
      )
        return null
      seen.add(parsed.data.id)
      const node: CatalogCategoryReadNode = { ...parsed.data, children: [] }
      task.output.push(node)
      for (const child of children.slice().reverse())
        stack.push({ node: child, parent: node.id, depth: task.depth + 1, output: node.children })
    }
    if (seen.size !== rows.size) return null
    for (const row of rows.values()) {
      const descendants = base.data.flat.filter((candidate) => candidate.parentId === row.id)
      const minimum = row.directCount + descendants.reduce((total, child) => total + child.count, 0)
      if (!Number.isSafeInteger(minimum) || row.count < minimum) return null
    }
    return { ...base.data, roots }
  } catch {
    return null
  }
}
