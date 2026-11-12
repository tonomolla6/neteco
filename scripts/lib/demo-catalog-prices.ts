import { z } from 'zod'
import { stableUuid } from './d1-category-seed'
import { INVENTORY_SEED_LOCATION_ID } from './d1-inventory-seed'
import { catalogPdfSourceSchema, withLoaderSession, type CatalogPdfSource } from './demo-catalog-pdf'
import { scheduleD1VariantPrice } from '../../workers/catalog/admin-price-commands'
import { executeD1AdminInventoryCommand } from '../../workers/catalog/admin-inventory'

/** Offline operator loader for the isolated preproduction D1: invented-but-plausible DEMO prices and stock for the
 * PDF catalogue, written only through the governed price and inventory commands (price versions, audit, movements).
 * Prices are gross (VAT 21 % included), as `variant_price_versions.gross_cents` is. Idempotent by construction:
 * a variant already carrying the planned price or at least the planned stock is skipped.
 */

export const DEMO_PRICE_REASON = 'Precio de demostración inventado para preproducción'
export const DEMO_STOCK_REASON = 'Stock de demostración inventado para preproducción'
/** [min, max] gross euros per sale unit ("ud"), by catalogue family. */
export const DEMO_FAMILY_PRICE_RANGES: Record<string, readonly [number, number]> = {
  'Ollas y cazos': [25, 180],
  'Ollas a presión': [60, 190],
  Calderos: [35, 220],
  Sartenes: [12, 90],
  Creperas: [40, 300],
  Tapas: [4, 25],
  Hornos: [150, 900],
  Quemadores: [18, 90],
  'Placas de inducción': [60, 450],
  Cubiertos: [1, 6],
  'Servicio de mesa': [3, 25],
  Melamina: [3, 20],
  Portamenús: [3, 18],
  'Soportes para copas': [8, 45],
  Fruteros: [8, 60],
  'Cestillos de presentación': [2, 12],
  'Chafing dish': [40, 260],
  Teteras: [12, 60],
  Cafetería: [10, 90],
  'Corte y preparación': [8, 60],
  Cuchillos: [8, 60],
  'Cuchillos y tablas': [15, 70],
  'Tablas de corte': [8, 45],
  Mandolinas: [25, 120],
  'Picadoras de hielo': [120, 650],
  Exprimidores: [20, 350],
  'Prensas de cocina': [12, 70],
  Básculas: [20, 180],
  Repostería: [4, 40],
  'Aros de repostería': [5, 25],
  'Moldes de repostería': [5, 40],
  'Moldes de cocina': [5, 35],
  Batidores: [5, 35],
  Termos: [15, 60],
  'Botellas biberón': [3, 12],
  Sifones: [30, 70],
  'Utensilios profesionales': [6, 50],
  'Utensilios de servicio': [3, 30],
  'Coladores y escurridores': [6, 35],
  'Utensilios de barbacoa': [6, 45],
  'Textil de cocina': [3, 20]
}
const STOCK_MIN = 10
const STOCK_MAX = 120

export interface CatalogPriceRow {
  sku: string
  family: string
  grossCents: number
  stock: number
  unitsPerCase: number
}

/** FNV-1a: tiny, dependency-free and stable across runtimes. */
function hash(value: string) {
  let h = 0x811c9dc5
  for (const character of value) {
    h ^= character.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
const unit = (value: string) => hash(value) / 0x1_0000_0000
const numbers = (value: string) =>
  (value.match(/\d+(?:,\d+)?/g) ?? []).map((part) => Number(part.replace(',', '.'))).filter(Number.isFinite)
/** A size proxy for the variant (capacity, diameter, length, power, area...), or null when it has none. */
function sizeOf(attributes: Record<string, string>) {
  const single: Array<[string, number]> = [
    ['capacidad_l', 1],
    ['capacidad_ml', 0.001],
    ['capacidad_copas', 0.1],
    ['diametro_cm', 1],
    ['diametro_base_cm', 1],
    ['largo_cm', 1],
    ['longitud_mm', 0.1],
    ['potencia_w', 0.1],
    ['peso_kg', 10],
    ['peso_g', 0.01],
    ['altura_cm', 1],
    ['espesor_mm', 1]
  ]
  for (const [key, factor] of single) {
    const value = attributes[key] === undefined ? undefined : numbers(attributes[key])[0]
    if (value !== undefined) return value * factor
  }
  for (const key of ['medidas_cm', 'dimensiones_cm', 'dimensiones', 'medidas']) {
    const parts = attributes[key] === undefined ? [] : numbers(attributes[key])
    if (parts.length) return parts.reduce((product, part) => product * part, 1) ** (1 / parts.length)
  }
  return null
}
/** Commercial rounding to the nearest ,00 / ,50 / ,95 price point. */
function commercial(euros: number) {
  const whole = Math.floor(euros)
  const candidates = [whole, whole + 0.5, whole + 0.95, whole + 1, whole + 1.5]
  return Math.round(
    candidates.reduce((best, item) => (Math.abs(item - euros) < Math.abs(best - euros) ? item : best)) * 100
  )
}

/** Pure and deterministic: the same catalogue always yields the same price and stock table. */
export function planCatalogPrices(input: unknown): CatalogPriceRow[] {
  const source = catalogPdfSourceSchema.parse(input)
  return source.productos.flatMap((product) => {
    const range = DEMO_FAMILY_PRICE_RANGES[product.familia]
    if (!range) throw new Error(`catalog_prices_family_unranged:${product.familia}`)
    const [familyMin, familyMax] = range
    // Each product sits on its own sub-range of the family, so products differ and variants grow within it.
    const low = familyMin + (familyMax - familyMin) * 0.35 * unit(`low:${product.referencia_imagen}`)
    const high = low + (familyMax - low) * (0.35 + 0.65 * unit(`high:${product.referencia_imagen}`))
    const sizes = product.variantes.map((variant) => sizeOf(variant.atributos))
    const known = sizes.filter((size): size is number => size !== null)
    const smallest = Math.min(...known)
    const largest = Math.max(...known)
    return product.variantes.map((variant, index) => {
      const count = product.variantes.length
      const size = sizes[index]
      const position =
        size !== null && known.length === count && largest > smallest
          ? (size! - smallest) / (largest - smallest)
          : count > 1
            ? index / (count - 1)
            : unit(`single:${variant.referencia}`)
      const jitter = 1 + (unit(`price:${variant.referencia}`) - 0.5) * 0.08
      const euros = Math.min(familyMax, Math.max(familyMin, (low + (high - low) * position) * jitter))
      const parsed = Number.parseInt(variant.atributos.unidad_venta ?? '1', 10)
      const unitsPerCase = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
      const first = Math.ceil(STOCK_MIN / unitsPerCase)
      const last = Math.floor(STOCK_MAX / unitsPerCase)
      const cases = first + Math.floor(unit(`stock:${variant.referencia}`) * (last - first + 1))
      return {
        sku: variant.referencia,
        family: product.familia,
        grossCents: commercial(euros),
        stock: cases * unitsPerCase,
        unitsPerCase
      }
    })
  })
}

export interface CatalogPriceSummary {
  variants: number
  priced: number
  alreadyPriced: number
  stocked: number
  alreadyStocked: number
}
const variantState = z.object({
  id: z.string(),
  legacy_id: z.number().int(),
  catalog_version: z.number().int(),
  head_id: z.string().nullable(),
  head_gross: z.number().int().nullable(),
  physical: z.number().int().nullable(),
  version: z.number().int().nullable()
})

export async function applyCatalogPrices(
  database: D1Database,
  options: { source: CatalogPdfSource | unknown; now: string }
): Promise<CatalogPriceSummary> {
  const now = options.now
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now)) throw new Error('catalog_prices_now_invalid')
  const rows = planCatalogPrices(options.source)
  const summary: CatalogPriceSummary = {
    variants: rows.length,
    priced: 0,
    alreadyPriced: 0,
    stocked: 0,
    alreadyStocked: 0
  }
  await withLoaderSession(
    database,
    now,
    async (actor) => {
      for (const row of rows) {
        const id = stableUuid(`catalog-pdf:variant:${row.sku}`)
        const raw = await database
          .prepare(
            `SELECT v.id,v.legacy_id,p.catalog_version,
              (SELECT x.id FROM variant_price_versions x WHERE x.variant_id=v.id AND x.status='approved'
                ORDER BY x.valid_from DESC,x.created_at DESC,x.id DESC LIMIT 1) AS head_id,
              (SELECT x.gross_cents FROM variant_price_versions x WHERE x.variant_id=v.id AND x.status='approved'
                ORDER BY x.valid_from DESC,x.created_at DESC,x.id DESC LIMIT 1) AS head_gross,
              b.physical_quantity AS physical,b.version
            FROM variants v JOIN products p ON p.id=v.product_id
            LEFT JOIN inventory_balances b ON b.variant_id=v.id AND b.location_id=?2
            WHERE v.id=?1`
          )
          .bind(id, INVENTORY_SEED_LOCATION_ID)
          .first<unknown>()
        if (raw === null) throw new Error(`catalog_prices_variant_missing:${row.sku}`)
        const state = variantState.parse(raw)
        if (state.head_gross === row.grossCents) summary.alreadyPriced++
        else {
          await scheduleD1VariantPrice(
            database,
            actor,
            {
              variantId: id,
              grossCents: row.grossCents,
              compareAtGrossCents: null,
              volumeTiers: [],
              validFrom: now,
              expectedCatalogVersion: state.catalog_version,
              expectedLatestApprovedId: state.head_id,
              reason: DEMO_PRICE_REASON
            },
            { idempotencyKey: `demo-price:${id}:${row.grossCents}:${state.head_id ?? 'none'}`, now }
          )
          summary.priced++
        }
        if (state.physical === null || state.version === null)
          throw new Error(`catalog_prices_balance_missing:${row.sku}`)
        if (state.physical >= row.stock) summary.alreadyStocked++
        else {
          await executeD1AdminInventoryCommand(
            database,
            actor,
            'receipt',
            { variantId: String(state.legacy_id) },
            {
              expectedBalanceVersion: state.version,
              quantity: row.stock - state.physical,
              reason: DEMO_STOCK_REASON,
              reference: `demo-stock:${row.sku}`
            },
            { idempotencyKey: `demo-stock:${id}:${row.stock}:${state.version}`, now }
          )
          summary.stocked++
        }
      }
    },
    ['administration.manage', 'inventory.write']
  )
  return summary
}
