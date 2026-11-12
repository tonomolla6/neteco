import { z } from 'zod'
import { parseCatalogCsvCells } from './catalog-tabular-core'
import { MAX_CART_QUANTITY } from './cart-limits'
import { selectVolumeUnitPrice, splitGross, validateQuantity } from '../server/domain/money'

export const QUICK_ORDER_MAX_ROWS = 10
export const QUICK_ORDER_MAX_BYTES = 8192
/** A pasted or uploaded list; previewed in batches of QUICK_ORDER_MAX_ROWS. */
export const QUICK_ORDER_LIST_MAX_ROWS = 30
const SEARCH_PAGE = 8
const DETAIL_BUDGET = 30
const positive = z.number().int().safe().positive()
const money = z.number().int().safe().nonnegative()
const identifier = z
  .string()
  .min(1)
  .max(160)
  .refine((value) =>
    Array.from(value).every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
  )
const reference = z
  .string()
  .trim()
  .pipe(identifier)
  .refine((value) => value.length >= 2)
const inputSchema = z.object({ reference, quantity: positive.max(MAX_CART_QUANTITY) }).strict()
const inputsSchema = z.array(inputSchema).min(1).max(QUICK_ORDER_MAX_ROWS)
export type QuickOrderInput = z.infer<typeof inputSchema>
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,179}$/)
// Public detail is a larger DTO. Validate the entire consumed projection, without
// pretending to validate unrelated editorial/media fields or duplicating their schemas.
const variantSchema = z.object({
  uuid: z.string().uuid(),
  id: positive,
  sku: identifier,
  ean: identifier.nullable(),
  gtin: identifier.nullable(),
  mpn: identifier.nullable(),
  format: z.string().min(1).max(500),
  unitLabel: z.string().min(1).max(200),
  price: money,
  priceTiers: z.array(z.object({ minimumQuantity: positive, unitGrossCents: money }).strict()).max(100),
  pricingVersion: z.string().min(1).max(200),
  taxRateBasisPoints: money.max(10000),
  minimumQuantity: positive,
  maximumQuantity: positive.nullable(),
  quantityIncrement: positive,
  stock: money,
  backorderAllowed: z.boolean()
})
const detailSchema = z.object({
  slug,
  name: z.string().min(1).max(500),
  variants: z.array(variantSchema).min(1).max(500)
})
const searchSchema = z.object({ items: z.array(z.object({ slug })).max(SEARCH_PAGE) })
export type QuickOrderReady = QuickOrderInput & {
  status: 'ready'
  name: string
  slug: string
  variant: z.infer<typeof variantSchema>
  unitGrossCents: number
  grossCents: number
  netCents: number
  taxCents: number
}
/** Closest reference observed while looking for one that does not exist. Never applied automatically. */
export interface QuickOrderSuggestion {
  reference: string
  name: string
  format: string
}
export type QuickOrderRow =
  QuickOrderReady | (QuickOrderInput & { status: 'error'; message: string; suggestion?: QuickOrderSuggestion })
export type QuickOrderVariant = z.infer<typeof variantSchema>
export type QuickOrderResolution =
  | { status: 'found'; name: string; slug: string; variant: QuickOrderVariant }
  | { status: 'error'; message: string; suggestion?: QuickOrderSuggestion }
export type QuickOrderRead = (
  path: string,
  options: { method: 'GET'; query?: { q: string }; cache: 'no-store'; retry: 0 }
) => Promise<unknown>

export function parseQuickOrderCsv(text: string): QuickOrderInput[] {
  if (new TextEncoder().encode(text).byteLength > QUICK_ORDER_MAX_BYTES)
    throw new Error('Máximo 8 KiB; no se ha recortado el CSV.')
  const cells = parseCatalogCsvCells(text.replace(/^\uFEFF/, ''), {
    maxRows: QUICK_ORDER_MAX_ROWS + 1,
    maxColumns: 2,
    maxCellCharacters: 160
  })
  if (cells[0]?.length !== 2 || cells[0][0] !== 'referencia' || cells[0][1] !== 'cantidad')
    throw new Error('Usa la cabecera referencia,cantidad.')
  const rows = inputsSchema.parse(
    cells.slice(1).map((row) => {
      if (row.length !== 2 || !/^[1-9]\d{0,2}$/.test(row[1]!))
        throw new Error('Cada fila necesita referencia y cantidad entera de 1 a 999.')
      return { reference: row[0], quantity: Number(row[1]) }
    })
  )
  if (new Set(rows.map((row) => row.reference)).size !== rows.length)
    throw new Error('Hay referencias repetidas; revisa las filas sin sumar cantidades automáticamente.')
  return rows
}

/**
 * A list typed, pasted from a spreadsheet or e-mail, or read from a text file: one product
 * per line, "reference quantity" separated by space, tab, comma or semicolon. The quantity
 * is optional (1). Unusable lines are reported and never block the valid ones.
 */
export interface QuickOrderListProblem {
  line: number
  text: string
  message: string
}
export function parseQuickOrderList(text: string): { rows: QuickOrderInput[]; problems: QuickOrderListProblem[] } {
  const rows: QuickOrderInput[] = []
  const problems: QuickOrderListProblem[] = []
  const seen = new Set<string>()
  const lines = text
    .slice(0, QUICK_ORDER_MAX_BYTES * 4)
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    const cells = line
      .split(/[\t;,]|\s+/)
      .map((cell) =>
        cell
          .trim()
          .replace(/^"(.*)"$/, '$1')
          .trim()
      )
      .filter(Boolean)
    const [first = '', second, ...rest] = cells
    if (!rows.length && !problems.length && /^ref(erencia|\.)?$/i.test(first)) return
    const problem = (message: string) => problems.push({ line: index + 1, text: line.slice(0, 80), message })
    if (rows.length >= QUICK_ORDER_LIST_MAX_ROWS) {
      if (!problems.some((entry) => entry.message.startsWith('Máximo')))
        problem(`Máximo ${QUICK_ORDER_LIST_MAX_ROWS} referencias por pedido rápido. Añade estas y repite con el resto.`)
      return
    }
    if (rest.length) return problem('Usa una referencia y una cantidad por línea.')
    if (second !== undefined && !/^[1-9]\d{0,2}$/.test(second))
      return problem('La cantidad debe ser un número entero entre 1 y 999.')
    if (first.length < 2) return problem('La referencia debe tener al menos 2 caracteres.')
    const parsed = inputSchema.safeParse({ reference: first, quantity: second === undefined ? 1 : Number(second) })
    if (!parsed.success) return problem('No reconocemos esta referencia.')
    if (seen.has(parsed.data.reference))
      return problem(`La referencia ${parsed.data.reference} está repetida; deja una sola línea con la cantidad total.`)
    seen.add(parsed.data.reference)
    rows.push(parsed.data)
  })
  return { rows, problems }
}

class QuickOrderProblem extends Error {
  constructor(
    message: string,
    readonly suggestion?: QuickOrderSuggestion
  ) {
    super(message)
  }
}
interface QuickOrderCache {
  searches: Map<string, Promise<z.infer<typeof searchSchema>>>
  details: Map<string, Promise<z.infer<typeof detailSchema>>>
}
const READ_OPTIONS = { method: 'GET', cache: 'no-store', retry: 0 } as const

async function resolveReference(reference: string, read: QuickOrderRead, cache: QuickOrderCache) {
  let search = cache.searches.get(reference)
  if (!search) {
    search = read('/api/search', { ...READ_OPTIONS, query: { q: reference } }).then((value) =>
      searchSchema.parse(value)
    )
    cache.searches.set(reference, search)
  }
  const candidates = [...new Set((await search).items.map((item) => item.slug))]
  // Both catalog backends rank exact identifier matches first. On a full page that ranking is
  // what bounds the read: the first candidate without an exact match ends the match set, and a
  // page where every candidate matches may be truncated, so it is refused.
  const capped = (await search).items.length >= SEARCH_PAGE
  const matches: Array<{ detail: z.infer<typeof detailSchema>; variant: QuickOrderVariant }> = []
  let closest: QuickOrderSuggestion | undefined
  let complete = !capped
  for (const candidate of candidates) {
    let detail = cache.details.get(candidate)
    if (!detail) {
      if (cache.details.size >= DETAIL_BUDGET)
        throw new QuickOrderProblem('Son demasiadas referencias a la vez; añade estas y repite con el resto.')
      detail = read(`/api/products/${encodeURIComponent(candidate)}`, READ_OPTIONS).then((value) => {
        const parsed = detailSchema.parse(value)
        if (parsed.slug !== candidate) throw new QuickOrderProblem('El producto recibido no corresponde a la búsqueda.')
        return parsed
      })
      cache.details.set(candidate, detail)
    }
    const current = await detail
    const exact = current.variants.filter((variant) =>
      [variant.sku, variant.ean, variant.gtin, variant.mpn].includes(reference)
    )
    for (const variant of exact) matches.push({ detail: current, variant })
    if (!exact.length) {
      const near =
        current.variants.find((variant) => variant.sku.startsWith(reference)) ??
        current.variants.find((variant) => variant.sku.includes(reference))
      if (near && !closest) closest = { reference: near.sku, name: current.name, format: near.format }
      if (capped) {
        complete = true
        break
      }
    }
  }
  if (!complete)
    throw new QuickOrderProblem('Hay demasiados productos con esa referencia. Búscala en el catálogo para elegir.')
  if (!matches.length) throw new QuickOrderProblem(`No encontramos «${reference}».`, closest)
  if (matches.length > 1)
    throw new QuickOrderProblem('Hay varios productos con esa referencia. Búscala en el catálogo para elegir.')
  return matches[0]!
}

function problemMessage(error: unknown): { message: string; suggestion?: QuickOrderSuggestion } {
  if (error instanceof z.ZodError) return { message: 'No hemos podido leer este producto del catálogo.' }
  if (error instanceof QuickOrderProblem)
    return { message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) }
  if (error instanceof Error && error.message.startsWith('quantity'))
    return { message: 'Cantidad no admitida: revisa mínimo, incremento, máximo y disponibilidad.' }
  return { message: 'No hemos podido consultar el catálogo. Vuelve a intentarlo.' }
}

/** The quantity limits a line must respect: variant rules, cart limit and sellable stock. */
export function quickOrderQuantityRules(variant: QuickOrderVariant) {
  return {
    minimumQuantity: variant.minimumQuantity,
    quantityIncrement: variant.quantityIncrement,
    maximumQuantity: Math.min(
      MAX_CART_QUANTITY,
      variant.maximumQuantity ?? Infinity,
      variant.backorderAllowed ? Infinity : variant.stock
    )
  }
}

/** Observed amounts for a quantity, with the volume tier it reaches. Throws on an invalid quantity. */
export function priceQuickOrderLine(variant: QuickOrderVariant, quantity: number) {
  validateQuantity(quantity, quickOrderQuantityRules(variant))
  const unitGrossCents = selectVolumeUnitPrice(variant.price, quantity, variant.priceTiers)
  const grossCents = unitGrossCents * quantity
  if (!Number.isSafeInteger(grossCents)) throw new QuickOrderProblem('El importe supera el rango admitido.')
  const amount = splitGross(grossCents, variant.taxRateBasisPoints)
  return { unitGrossCents, grossCents, netCents: amount.netCents, taxCents: amount.taxCents }
}

/** One reference typed in the order table: its exact variant, or why not and what is closest. */
export async function resolveQuickOrderReference(
  value: string,
  read: QuickOrderRead,
  cache: QuickOrderCache = { searches: new Map(), details: new Map() }
): Promise<QuickOrderResolution> {
  try {
    const { detail, variant } = await resolveReference(reference.parse(value), read, cache)
    return { status: 'found', name: detail.name, slug: detail.slug, variant }
  } catch (error) {
    return { status: 'error', ...problemMessage(error) }
  }
}

/** Explicit read-only batch, with deduplicated calls and a hard total detail budget. */
export async function previewQuickOrder(input: QuickOrderInput[], read: QuickOrderRead): Promise<QuickOrderRow[]> {
  const rows = inputsSchema.parse(input)
  const cache: QuickOrderCache = { searches: new Map(), details: new Map() }
  const result: QuickOrderRow[] = []
  for (const row of rows) {
    try {
      const { detail, variant } = await resolveReference(row.reference, read, cache)
      result.push({
        ...row,
        status: 'ready',
        name: detail.name,
        slug: detail.slug,
        variant,
        ...priceQuickOrderLine(variant, row.quantity)
      })
    } catch (error) {
      result.push({ ...row, status: 'error', ...problemMessage(error) })
    }
  }
  const seen = new Map<number, number>()
  for (const row of result) if (row.status === 'ready') seen.set(row.variant.id, (seen.get(row.variant.id) ?? 0) + 1)
  return result.map((row) =>
    row.status === 'ready' && seen.get(row.variant.id)! > 1
      ? {
          reference: row.reference,
          quantity: row.quantity,
          status: 'error',
          message: 'El mismo producto aparece en varias filas; deja una sola con la cantidad total.'
        }
      : row
  )
}
