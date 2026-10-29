import { z } from 'zod'
import { parseCatalogCsvCells } from './catalog-tabular-core'
import { MAX_CART_QUANTITY } from './cart-limits'
import { selectVolumeUnitPrice, splitGross, validateQuantity } from '../server/domain/money'

export const QUICK_ORDER_MAX_ROWS = 10
export const QUICK_ORDER_MAX_BYTES = 8192
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
const searchSchema = z.object({ items: z.array(z.object({ slug })).max(8) })
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
export type QuickOrderRow = QuickOrderReady | (QuickOrderInput & { status: 'error'; message: string })
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

/** Explicit read-only batch, with deduplicated calls and a hard total detail budget. */
class QuickOrderProblem extends Error {}
export async function previewQuickOrder(input: QuickOrderInput[], read: QuickOrderRead): Promise<QuickOrderRow[]> {
  const rows = inputsSchema.parse(input)
  const searches = new Map<string, Promise<z.infer<typeof searchSchema>>>()
  const details = new Map<string, Promise<z.infer<typeof detailSchema>>>()
  const options = { method: 'GET', cache: 'no-store', retry: 0 } as const
  const result: QuickOrderRow[] = []
  for (const row of rows) {
    try {
      let search = searches.get(row.reference)
      if (!search) {
        search = read('/api/search', { ...options, query: { q: row.reference } }).then((value) =>
          searchSchema.parse(value)
        )
        searches.set(row.reference, search)
      }
      const candidates = await search
      if (candidates.items.length >= 8)
        throw new QuickOrderProblem(
          'La búsqueda alcanza su límite; no acredita todos los candidatos. Usa una referencia más específica.'
        )
      const matches: Array<{ detail: z.infer<typeof detailSchema>; variant: z.infer<typeof variantSchema> }> = []
      for (const candidate of new Set(candidates.items.map((item) => item.slug))) {
        let detail = details.get(candidate)
        if (!detail) {
          if (details.size >= 20)
            throw new QuickOrderProblem('Se alcanzó el límite de 20 productos consultados; divide el lote.')
          detail = read(`/api/products/${encodeURIComponent(candidate)}`, options).then((value) => {
            const parsed = detailSchema.parse(value)
            if (parsed.slug !== candidate)
              throw new QuickOrderProblem('El producto recibido no corresponde a la búsqueda.')
            return parsed
          })
          details.set(candidate, detail)
        }
        const current = await detail
        for (const variant of current.variants) {
          if ([variant.sku, variant.ean, variant.gtin, variant.mpn].includes(row.reference))
            matches.push({ detail: current, variant })
        }
      }
      if (matches.length !== 1)
        throw new QuickOrderProblem(
          matches.length
            ? 'Varias variantes coinciden exactamente; no se elegirá una automáticamente.'
            : 'No se ha observado ninguna variante con ese identificador exacto.'
        )
      const { detail, variant } = matches[0]!
      validateQuantity(row.quantity, {
        ...variant,
        maximumQuantity: Math.min(
          MAX_CART_QUANTITY,
          variant.maximumQuantity ?? Infinity,
          variant.backorderAllowed ? Infinity : variant.stock
        )
      })
      const unitGrossCents = selectVolumeUnitPrice(variant.price, row.quantity, variant.priceTiers)
      const grossCents = unitGrossCents * row.quantity
      if (!Number.isSafeInteger(grossCents)) throw new QuickOrderProblem('El importe supera el rango admitido.')
      const amount = splitGross(grossCents, variant.taxRateBasisPoints)
      result.push({
        ...row,
        status: 'ready',
        name: detail.name,
        slug: detail.slug,
        variant,
        unitGrossCents,
        grossCents,
        netCents: amount.netCents,
        taxCents: amount.taxCents
      })
    } catch (error) {
      result.push({
        ...row,
        status: 'error',
        message:
          error instanceof z.ZodError
            ? 'Respuesta de catálogo no válida; no se ha validado esta fila.'
            : error instanceof Error && error.message.startsWith('quantity')
              ? 'Cantidad no admitida: revisa mínimo, incremento, máximo y disponibilidad.'
              : error instanceof QuickOrderProblem
                ? error.message
                : 'No se pudo consultar el catálogo; vuelve a previsualizar.'
      })
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
          message: 'La misma variante aparece en varias filas; revisa el lote sin sumar cantidades automáticamente.'
        }
      : row
  )
}
