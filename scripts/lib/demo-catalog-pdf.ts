import sharp from 'sharp'
import { z } from 'zod'
import { slugify } from '../../server/utils/slug'
import { stableUuid } from './d1-category-seed'
import { INVENTORY_SEED_LOCATION_ID } from './d1-inventory-seed'
import { createMediaPublication, decideMediaRights } from '../../workers/media/governance'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

/** Offline operator loader for the isolated preproduction D1 (never mounted in a Worker route).
 * Imports the paper-catalogue (PDF) products as published "Consultar precio" items (price 0, no stock,
 * not purchasable), with brand, category, MPN, a reviewed product-type policy and the main image's scan
 * receipt, rights decision and media publication. It also renews the publication authority of the demo
 * seed. Every write is additive: existing rows are never updated or deleted; renewals append new versions.
 */

export const CATALOG_PDF_SOURCE_VERSION = 'catalog-pdf-2026-11-12'
export const CATALOG_PDF_PRODUCT_TYPE = 'menaje_no_peligroso'
export const CATALOG_PDF_PARENT_CATEGORY_ID = stableUuid('category:100') // Menaje y hostelería
const EXISTING_KITCHENWARE_CATEGORY_ID = stableUuid('category:103') // Menaje de cocina
const TAX_CLASS_ID = stableUuid('tax:es-general-21')
const SHIPPING_PROFILE_ID = stableUuid('shipping:parcel')
const SOURCE_ID = stableUuid('source:catalog-pdf-2026')
export const CATALOG_LOADER_ACTOR = {
  identityId: 'd3100000-0000-4000-8000-000000000010',
  email: 'catalogo-preproduccion@demo.invalid'
} as const
const BOOTSTRAP_ROLE = 'demo_bootstrap'
const BOOTSTRAP_PERMISSIONS = ['catalog.write', 'catalog.publish', 'administration.manage'] as const
const UNUSABLE_PASSWORD = 'DEMO-OFFLINE-IDENTITY-NOT-A-PASSWORD-HASH'
const SCANNER = 'SYNTHETIC-PREPROD-JPEG-DECODE-NOT-ANTIVIRUS'
/** Renew whatever would expire within this margin, so a run always leaves at least this much validity. */
const RENEWAL_MARGIN_MS = 30 * 86400_000
const LICENSE =
  'Imagen del Catálogo General 2026 (PDF facilitado por el cliente); uso en preproducción, derechos pendientes de confirmar'

/** Families of the PDF grouped as in the preview (scripts/catalog-pdf/import/common.mjs). */
export const CATALOG_PDF_GROUPS: Record<string, readonly string[]> = {
  'Cocción y cacerolas': [
    'Ollas y cazos',
    'Ollas a presión',
    'Calderos',
    'Sartenes',
    'Creperas',
    'Tapas',
    'Hornos',
    'Quemadores',
    'Placas de inducción'
  ],
  'Mesa y servicio': [
    'Cubiertos',
    'Servicio de mesa',
    'Melamina',
    'Portamenús',
    'Soportes para copas',
    'Fruteros',
    'Cestillos de presentación',
    'Chafing dish',
    'Teteras',
    'Cafetería'
  ],
  'Corte y preparación': [
    'Corte y preparación',
    'Cuchillos',
    'Cuchillos y tablas',
    'Tablas de corte',
    'Mandolinas',
    'Picadoras de hielo',
    'Exprimidores',
    'Prensas de cocina',
    'Básculas'
  ],
  'Repostería y moldes': ['Repostería', 'Aros de repostería', 'Moldes de repostería', 'Moldes de cocina', 'Batidores'],
  'Termos, botellas y sifones': ['Termos', 'Botellas biberón', 'Sifones'],
  'Menaje de cocina': [
    'Utensilios profesionales',
    'Utensilios de servicio',
    'Coladores y escurridores',
    'Utensilios de barbacoa',
    'Textil de cocina'
  ]
}
export const CATALOG_PDF_BRANDS = ['Lacor', 'Garinox'] as const

const text = (max: number) => z.string().trim().min(1).max(max)
const sourceSchema = z.object({
  productos: z
    .array(
      z.object({
        nombre: text(160),
        familia: text(120),
        marca: z.enum(CATALOG_PDF_BRANDS),
        descripcion: text(2000),
        atributos_tecnicos: z
          .record(z.string(), z.union([z.string(), z.array(z.string()).transform((values) => values.join(', '))]))
          .default({}),
        pagina_pdf: z.number().int().positive(),
        pagina_impresa: z.number().int().positive().nullable().optional(),
        referencia_imagen: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
        variantes: z
          .array(
            z.object({
              referencia: z.string().regex(/^[A-Za-z0-9./-]{1,60}$/),
              atributos: z.record(z.string(), z.string()).default({}),
              precio: z.number().nonnegative().nullable()
            })
          )
          .min(1)
          .max(100)
      })
    )
    .min(1)
})
export type CatalogPdfSource = z.input<typeof sourceSchema>

const UNITS = new Set(['cm', 'mm', 'l', 'ml', 'w', 'kg', 'g', 'rpm', 'c', 'h'])
const LABELS: Record<string, string> = {
  diametro: 'Diámetro',
  coleccion: 'Colección',
  capacidad: 'Capacidad',
  potencia: 'Potencia',
  longitud: 'Longitud',
  espesor: 'Espesor',
  temperatura: 'Temperatura',
  cuchillas: 'Cuchillas',
  peso: 'Peso',
  division: 'División',
  niveles: 'Niveles',
  medidas: 'Medidas',
  dimensiones: 'Dimensiones',
  superficie: 'Superficie',
  velocidad: 'Velocidad',
  produccion: 'Producción',
  flujo: 'Flujo',
  rodaja: 'Rodaja',
  juliana: 'Juliana',
  unidad: 'Unidad',
  botellas: 'Botellas',
  fundas: 'Fundas',
  piezas: 'Piezas',
  numeros: 'Números',
  tiempo: 'Tiempo',
  modelo: 'Modelo',
  altura: 'Altura',
  largo: 'Largo',
  serie: 'Serie',
  material: 'Material',
  compatibilidad: 'Compatibilidad',
  recubrimiento: 'Recubrimiento',
  maxima: 'máxima',
  horno: 'horno'
}
function label(key: string) {
  const parts = key.split('_')
  let unit = ''
  if (parts.length > 1 && UNITS.has(parts.at(-1)!)) unit = parts.pop()!.replace(/^c$/, '°C')
  const name = parts
    .map((part, index) =>
      index === 0 ? (LABELS[part] ?? part[0]!.toUpperCase() + part.slice(1)) : (LABELS[part]?.toLowerCase() ?? part)
    )
    .join(' ')
  return { name, unit }
}
function formatOf(reference: string, attributes: Record<string, string>) {
  const segments: string[] = []
  let color = ''
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'unidad_venta') continue
    if (key === 'color') {
      color = value
      continue
    }
    const { name, unit } = label(key)
    segments.push(`${name} ${value}${unit ? ` ${unit}` : ''}`)
  }
  if (color) segments.push(`Color ${color}`)
  return segments.join(' · ') || `Ref. ${reference}`
}

export interface PlannedVariant {
  id: string
  legacyId: number
  sku: string
  mpn: string
  format: string
  unitsPerCase: number
}
export interface PlannedProduct {
  id: string
  legacyId: number
  name: string
  slug: string
  categoryId: string
  brandId: string
  brand: string
  shortDescription: string
  description: string
  attributes: string
  imageReference: string
  page: number
  uploadId: string
  variants: PlannedVariant[]
}
export interface CatalogPdfPlan {
  brands: Array<{ id: string; name: string; slug: string }>
  categories: Array<{ id: string; name: string; slug: string; legacyId: number; existing: boolean }>
  products: PlannedProduct[]
}

export function categoryIdFor(group: string) {
  return group === 'Menaje de cocina' ? EXISTING_KITCHENWARE_CATEGORY_ID : stableUuid(`catalog-pdf:category:${group}`)
}

/** Pure, deterministic plan. Identifiers are stable across runs, so re-running never duplicates rows. */
export function planCatalogPdf(input: unknown): CatalogPdfPlan {
  const source = sourceSchema.parse(input)
  const groupOf = new Map(
    Object.entries(CATALOG_PDF_GROUPS).flatMap(([group, families]) => families.map((f) => [f, group]))
  )
  const slugs = new Set<string>()
  let productLegacy = 1000
  let variantLegacy = 2000
  const products = source.productos.map((product) => {
    const group = groupOf.get(product.familia)
    if (!group) throw new Error(`catalog_pdf_family_unmapped:${product.familia}`)
    let slug = slugify(product.nombre)
    if (slugs.has(slug)) slug = `${slug}-${slugify(product.referencia_imagen)}`
    slugs.add(slug)
    const formats = new Set<string>()
    const variants = product.variantes.map((variant) => {
      let format = formatOf(variant.referencia, variant.atributos).slice(0, 160)
      if (formats.has(format)) format = `${format.slice(0, 140)} · Ref. ${variant.referencia}`
      formats.add(format)
      const units = Number.parseInt(variant.atributos.unidad_venta ?? '1', 10)
      return {
        id: stableUuid(`catalog-pdf:variant:${variant.referencia}`),
        legacyId: variantLegacy++,
        sku: variant.referencia,
        mpn: variant.referencia,
        format,
        unitsPerCase: Number.isSafeInteger(units) && units > 0 ? units : 1
      }
    })
    const attrs = [
      { k: 'Familia del catálogo', v: product.familia },
      ...Object.entries(product.atributos_tecnicos).map(([key, value]) => {
        const { name, unit } = label(key)
        return { k: unit ? `${name} (${unit})` : name, v: value }
      }),
      { k: 'Página del catálogo', v: String(product.pagina_impresa ?? product.pagina_pdf) }
    ]
    return {
      id: stableUuid(`catalog-pdf:product:${product.referencia_imagen}`),
      legacyId: productLegacy++,
      name: product.nombre,
      slug,
      categoryId: categoryIdFor(group),
      brandId: stableUuid(`catalog-pdf:brand:${product.marca}`),
      brand: product.marca,
      shortDescription: product.descripcion.slice(0, 200),
      description: product.descripcion,
      attributes: JSON.stringify({ attrs, badges: [], visual: { type: 'caja', color: '#64748b' } }),
      imageReference: product.referencia_imagen,
      page: product.pagina_pdf,
      uploadId: stableUuid(`catalog-pdf:upload:${product.referencia_imagen}`),
      variants
    }
  })
  const used = new Set(products.map((product) => product.brand))
  return {
    brands: CATALOG_PDF_BRANDS.filter((brand) => used.has(brand)).map((name) => ({
      id: stableUuid(`catalog-pdf:brand:${name}`),
      name,
      slug: slugify(name)
    })),
    categories: Object.keys(CATALOG_PDF_GROUPS).map((name, index) => ({
      id: categoryIdFor(name),
      name,
      slug: slugify(name),
      legacyId: 1001 + index,
      existing: name === 'Menaje de cocina'
    })),
    products
  }
}

const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
const rowCount = z.object({ n: z.number().int().nonnegative() })

function assertBatch(value: unknown, length: number) {
  z.array(z.object({ success: z.literal(true) }).passthrough())
    .length(length)
    .parse(value)
}

/** A short-lived, MFA-flagged internal session for the governed media commands; always revoked afterwards. */
async function withLoaderSession<T>(
  database: D1Database,
  now: string,
  work: (actor: VerifiedSessionClaims) => Promise<T>
) {
  const expiry = utc(Date.parse(now) + 2 * 3600_000)
  const actor: VerifiedSessionClaims = {
    identityId: CATALOG_LOADER_ACTOR.identityId,
    sessionId: crypto.randomUUID(),
    sessionVersion: 1
  }
  const grants = await database.batch([
    database
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES(?,?,?,?,'active',?,?) ON CONFLICT(id) DO NOTHING`
      )
      .bind(actor.identityId, CATALOG_LOADER_ACTOR.email, UNUSABLE_PASSWORD, now, now, now),
    database
      .prepare('INSERT INTO roles(code,name,description) VALUES(?,?,?) ON CONFLICT(code) DO NOTHING')
      .bind(BOOTSTRAP_ROLE, 'Bootstrap offline DEMO', 'Actor interno sintético, acceso temporal revocado al terminar'),
    ...BOOTSTRAP_PERMISSIONS.flatMap((permission) => {
      const [resource, action] = permission.split('.')
      return [
        database
          .prepare(
            'INSERT INTO permissions(code,resource,action,description) VALUES(?,?,?,?) ON CONFLICT(code) DO NOTHING'
          )
          .bind(permission, resource!, action!, 'Permiso existente aplicado a identidad sintética de carga'),
        database
          .prepare(
            'INSERT INTO role_permissions(role_code,permission_code) VALUES(?,?) ON CONFLICT(role_code,permission_code) DO NOTHING'
          )
          .bind(BOOTSTRAP_ROLE, permission)
      ]
    }),
    database
      .prepare(
        `INSERT INTO identity_roles(identity_id,role_code,granted_at,expires_at) VALUES(?,?,?,?)
        ON CONFLICT(identity_id,role_code) DO UPDATE SET granted_at=excluded.granted_at,expires_at=excluded.expires_at`
      )
      .bind(actor.identityId, BOOTSTRAP_ROLE, now, expiry),
    database
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .bind(actor.sessionId, actor.identityId, now, expiry)
  ])
  assertBatch(grants, 4 + BOOTSTRAP_PERMISSIONS.length * 2)
  try {
    return await work(actor)
  } finally {
    // Revoke the session and remove only this run's temporary grants (same contract as demo-dataset).
    const revoked = await database.batch([
      database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(now, actor.sessionId),
      database
        .prepare('DELETE FROM identity_roles WHERE identity_id=? AND role_code=?')
        .bind(actor.identityId, BOOTSTRAP_ROLE),
      database.prepare('DELETE FROM role_permissions WHERE role_code=?').bind(BOOTSTRAP_ROLE)
    ])
    assertBatch(revoked, 3)
  }
}

/** Current, non-withdrawn policy version for a product type valid beyond the margin, or a new appended version. */
async function currentPolicy(
  database: D1Database,
  options: { code: string; name: string; reason: string; now: string; validUntil: string; actorId: string }
) {
  const margin = utc(Date.parse(options.now) + RENEWAL_MARGIN_MS)
  const existing = await database
    .prepare(
      `SELECT id FROM catalog_publication_policies policy WHERE code=? AND valid_from<=? AND valid_until IS NOT NULL
      AND valid_until>? AND json_array_length(required_fields)=0 AND json_array_length(required_media_roles)=0
      AND NOT EXISTS(SELECT 1 FROM catalog_publication_policy_withdrawals WHERE policy_id=policy.id)
      ORDER BY version DESC LIMIT 1`
    )
    .bind(options.code, options.now, margin)
    .first<{ id: string }>()
  if (existing) return { id: existing.id, created: false }
  const id = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO catalog_publication_policies(id,code,version,name,required_fields,required_media_roles,
      identifier_exceptions_allowed,actor_id,reason,valid_from,valid_until,created_at)
      SELECT ?,?,COALESCE(MAX(version),0)+1,?,'[]','[]',0,?,?,?,?,? FROM catalog_publication_policies WHERE code=?`
    )
    .bind(
      id,
      options.code,
      options.name,
      options.actorId,
      options.reason,
      options.now,
      options.validUntil,
      options.now,
      options.code
    )
    .run()
  return { id, created: true }
}

interface MediaSubject {
  productId: string
  uploadId: string
  title: string
  alt: string
}

/** Appends policy assignments, scan receipts and main-image publications that would lapse within the margin. */
async function renewAuthority(
  database: D1Database,
  actor: VerifiedSessionClaims,
  subjects: MediaSubject[],
  policy: { code: string; name: string; reason: string },
  now: string,
  validUntil: string
) {
  const margin = utc(Date.parse(now) + RENEWAL_MARGIN_MS)
  const governing = await currentPolicy(database, { ...policy, now, validUntil, actorId: actor.identityId })
  let assignments = 0
  let receipts = 0
  let publications = 0
  const renewedUploads = new Map<string, string>()
  for (const subject of subjects) {
    const assigned = await database
      .prepare(
        'SELECT policy_id FROM catalog_product_publication_policies WHERE product_id=? ORDER BY seq DESC LIMIT 1'
      )
      .bind(subject.productId)
      .first<{ policy_id: string }>()
    if (assigned?.policy_id !== governing.id) {
      await database
        .prepare(
          `INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
          VALUES(?,?,?,?,?,?)`
        )
        .bind(crypto.randomUUID(), subject.productId, governing.id, actor.identityId, policy.reason, now)
        .run()
      assignments++
    }
    let receiptId = renewedUploads.get(subject.uploadId)
    if (!receiptId) {
      const latest = await database
        .prepare('SELECT id,expires_at FROM media_scan_receipts WHERE upload_id=? ORDER BY seq DESC LIMIT 1')
        .bind(subject.uploadId)
        .first<{ id: string; expires_at: string }>()
      if (latest && latest.expires_at > margin) receiptId = latest.id
      else {
        receiptId = crypto.randomUUID()
        const upload = await database
          .prepare('SELECT checksum,object_key,byte_size FROM media_uploads WHERE id=?')
          .bind(subject.uploadId)
          .first<{ checksum: string; object_key: string; byte_size: number }>()
        if (!upload) throw new Error('catalog_media_upload_missing')
        // Synthetic preproduction receipt (no antivirus here): the bytes were decoded as a real image before upload.
        await database
          .prepare(
            `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,
            scanned_at,expires_at,received_at,payload_hash) VALUES(?,?,?,?,?,'clean',?,?,?,?,?)`
          )
          .bind(
            receiptId,
            subject.uploadId,
            upload.checksum,
            upload.object_key,
            upload.byte_size,
            SCANNER,
            now,
            validUntil,
            now,
            await sha256(new TextEncoder().encode(`${receiptId}:${upload.checksum}:${now}:${validUntil}`))
          )
          .run()
        receipts++
      }
      renewedUploads.set(subject.uploadId, receiptId)
    }
    const live = await database
      .prepare(
        `SELECT 1 FROM product_media_publications publication WHERE product_id=? AND variant_id IS NULL AND role='main'
        AND upload_id=? AND scan_receipt_id=? AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)
        AND NOT EXISTS(SELECT 1 FROM product_media_publication_events WHERE publication_id=publication.id)`
      )
      .bind(subject.productId, subject.uploadId, receiptId, now, margin)
      .first()
    if (live) continue
    await createMediaPublication(
      database,
      actor,
      subject.uploadId,
      {
        productId: subject.productId,
        variantId: null,
        role: 'main',
        title: subject.title.slice(0, 200),
        altText: subject.alt.slice(0, 500),
        language: 'es',
        version: `preprod-${now.slice(0, 10)}`,
        validFrom: now,
        validUntil
      },
      { idempotencyKey: `preprod-main:${subject.productId}:${receiptId}`, now }
    )
    publications++
  }
  return { policyId: governing.id, policyCreated: governing.created, assignments, receipts, publications }
}

export interface CatalogPdfLoadSummary {
  sourceVersion: string
  products: { planned: number; inserted: number }
  variants: { planned: number; inserted: number }
  brands: number
  categories: number
  images: { uploaded: number; reused: number }
  authority: Awaited<ReturnType<typeof renewAuthority>>
  validUntil: string
}

async function requireReferenceRows(database: D1Database) {
  const present = rowCount.parse(
    await database
      .prepare(
        `SELECT (SELECT count(*) FROM categories WHERE id=?1 AND status='published')
        +(SELECT count(*) FROM categories WHERE id=?2 AND parent_id=?1)
        +(SELECT count(*) FROM tax_classes WHERE id=?3)+(SELECT count(*) FROM shipping_profiles WHERE id=?4) AS n`
      )
      .bind(CATALOG_PDF_PARENT_CATEGORY_ID, EXISTING_KITCHENWARE_CATEGORY_ID, TAX_CLASS_ID, SHIPPING_PROFILE_ID)
      .first()
  ).n
  if (present !== 4) throw new Error('catalog_pdf_reference_rows_missing')
}

/** Refuses to continue if a planned unique key already belongs to a different row (never overwrites). */
async function assertNoForeignCollisions(database: D1Database, plan: CatalogPdfPlan) {
  const checks: Array<[string, string, string | number]> = []
  for (const product of plan.products) {
    checks.push(['products', 'slug', product.slug], ['products', 'legacy_id', product.legacyId])
    for (const variant of product.variants)
      checks.push(['variants', 'sku', variant.sku], ['variants', 'legacy_id', variant.legacyId])
  }
  for (const category of plan.categories.filter((item) => !item.existing))
    checks.push(['categories', 'slug', category.slug], ['categories', 'legacy_id', category.legacyId])
  for (const brand of plan.brands) checks.push(['brands', 'slug', brand.slug])
  const expected = new Map<string, string>()
  for (const product of plan.products) {
    expected.set(`products:slug:${product.slug}`, product.id).set(`products:legacy_id:${product.legacyId}`, product.id)
    for (const variant of product.variants)
      expected.set(`variants:sku:${variant.sku}`, variant.id).set(`variants:legacy_id:${variant.legacyId}`, variant.id)
  }
  for (const category of plan.categories)
    expected
      .set(`categories:slug:${category.slug}`, category.id)
      .set(`categories:legacy_id:${category.legacyId}`, category.id)
  for (const brand of plan.brands) expected.set(`brands:slug:${brand.slug}`, brand.id)
  for (let index = 0; index < checks.length; index += 50) {
    const chunk = checks.slice(index, index + 50)
    const results = await database.batch(
      chunk.map(([table, column, value]) =>
        database.prepare(`SELECT id FROM ${table} WHERE ${column}=? LIMIT 1`).bind(value)
      )
    )
    results.forEach((result, offset) => {
      const [table, column, value] = chunk[offset]!
      const row = (result.results as Array<{ id: string }>)[0]
      if (row && row.id !== expected.get(`${table}:${column}:${value}`))
        throw new Error(`catalog_pdf_collision:${table}.${column}=${value}`)
    })
  }
}

/** The PDF crops are small; the media gate requires 600-12000 px per side. Fit (never distort or crop) on a
 * white 800x800 square, as product photos are presented, and re-encode as JPEG. */
export async function normalizedProductImage(bytes: Uint8Array) {
  return new Uint8Array(
    await sharp(bytes)
      .flatten({ background: '#ffffff' })
      .resize({ width: 800, height: 800, fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer()
  )
}

export interface ImageStore {
  head(key: string): Promise<{ size: number } | null>
  put(key: string, value: Uint8Array, options: R2PutOptions): Promise<R2Object | null>
}

export async function loadCatalogPdf(
  database: D1Database,
  bucket: ImageStore,
  options: {
    source: unknown
    readImage: (reference: string) => Promise<Uint8Array>
    now: string
    validDays?: number
  }
): Promise<CatalogPdfLoadSummary> {
  const now = options.now
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now)) throw new Error('catalog_pdf_now_invalid')
  const validUntil = utc(Date.parse(now) + (options.validDays ?? 90) * 86400_000)
  const plan = planCatalogPdf(options.source)
  await requireReferenceRows(database)
  await assertNoForeignCollisions(database, plan)

  const productsBefore = rowCount.parse(
    await database.prepare('SELECT count(*) AS n FROM products WHERE source_id=?').bind(SOURCE_ID).first()
  ).n
  const variantsBefore = rowCount.parse(
    await database
      .prepare('SELECT count(*) AS n FROM variants WHERE product_id IN (SELECT id FROM products WHERE source_id=?)')
      .bind(SOURCE_ID)
      .first()
  ).n
  const sortBase = rowCount.parse(
    await database.prepare('SELECT COALESCE(MAX(sort_order),0) AS n FROM categories').first()
  ).n
  const reference = await database.batch([
    database
      .prepare(
        `INSERT INTO catalog_sources(id,code,name,owner,kind,is_master)
        VALUES(?,'catalog-pdf-2026','Catálogo General 2026 (PDF, sin precios)','Producto','supplier',0)
        ON CONFLICT(id) DO NOTHING`
      )
      .bind(SOURCE_ID),
    ...plan.brands.map((brand) =>
      database
        .prepare(
          `INSERT INTO brands(id,name,slug,manufacturer_name,status,created_at,updated_at)
          VALUES(?,?,?,?,'published',?,?) ON CONFLICT(id) DO NOTHING`
        )
        .bind(brand.id, brand.name, brand.slug, brand.name, now, now)
    ),
    ...plan.categories
      .filter((category) => !category.existing)
      .map((category, index) =>
        database
          .prepare(
            `INSERT INTO categories(id,legacy_id,parent_id,name,slug,status,sort_order,source_id,source_version,created_at,updated_at)
            VALUES(?,?,?,?,?,'published',?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
          )
          .bind(
            category.id,
            category.legacyId,
            CATALOG_PDF_PARENT_CATEGORY_ID,
            category.name,
            category.slug,
            sortBase + index + 1,
            SOURCE_ID,
            CATALOG_PDF_SOURCE_VERSION,
            now,
            now
          )
      )
  ])
  assertBatch(reference, 1 + plan.brands.length + plan.categories.filter((category) => !category.existing).length)

  const regulatory = JSON.stringify({ productType: CATALOG_PDF_PRODUCT_TYPE, requiresSds: false })
  const location = await database
    .prepare('SELECT id FROM inventory_locations WHERE id=?')
    .bind(INVENTORY_SEED_LOCATION_ID)
    .first<{ id: string }>()
  let uploaded = 0
  let reused = 0
  for (const product of plan.products) {
    const statements = [
      database
        .prepare(
          `INSERT INTO products(id,legacy_id,category_id,brand_id,source_id,name,slug,short_description,description,
          status,featured,attributes,regulatory,source_version,published_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'published',0,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
        )
        .bind(
          product.id,
          product.legacyId,
          product.categoryId,
          product.brandId,
          SOURCE_ID,
          product.name,
          product.slug,
          product.shortDescription,
          product.description,
          product.attributes,
          regulatory,
          CATALOG_PDF_SOURCE_VERSION,
          now,
          now,
          now
        ),
      ...product.variants.flatMap((variant) => [
        // Price 0 and no stock/backorder: published as "Consultar precio", never purchasable (cart refuses it).
        database
          .prepare(
            `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,mpn,format,status,
            unit_base,unit_label,content_quantity,units_per_case,price_gross_cents,currency,backorder_allowed,
            source_version,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'published','unit','ud',1,?,0,'EUR',0,?,?,?) ON CONFLICT(id) DO NOTHING`
          )
          .bind(
            variant.id,
            variant.legacyId,
            product.id,
            TAX_CLASS_ID,
            SHIPPING_PROFILE_ID,
            variant.sku,
            variant.mpn,
            variant.format,
            variant.unitsPerCase,
            CATALOG_PDF_SOURCE_VERSION,
            now,
            now
          ),
        ...(location
          ? [
              database
                .prepare(
                  `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
                  VALUES(?,?,0,0,1,?,?) ON CONFLICT(variant_id,location_id) DO NOTHING`
                )
                .bind(variant.id, location.id, now, now)
            ]
          : [])
      ])
    ]
    assertBatch(await database.batch(statements), statements.length)

    // Main image: verified JPEG, stored once in R2 under the quarantine key the media gate expects.
    const existingUpload = await database
      .prepare('SELECT id FROM media_uploads WHERE id=?')
      .bind(product.uploadId)
      .first<{ id: string }>()
    if (existingUpload) {
      reused++
      continue
    }
    const original = await options.readImage(product.imageReference)
    const source = await sharp(original).metadata()
    if (source.format !== 'jpeg' || !source.width || !source.height)
      throw new Error(`catalog_pdf_image_invalid:${product.imageReference}`)
    const bytes = await normalizedProductImage(original)
    const metadata = await sharp(bytes).metadata()
    if (bytes.byteLength > 10_485_760 || !metadata.width || !metadata.height)
      throw new Error(`catalog_pdf_image_invalid:${product.imageReference}`)
    const checksum = await sha256(bytes)
    const objectKey = `quarantine/${product.uploadId}/${checksum}`
    const head = await bucket.head(objectKey)
    let etag: string
    if (head) {
      if (head.size !== bytes.byteLength) throw new Error(`catalog_pdf_object_mismatch:${product.imageReference}`)
      etag = (head as { etag?: string }).etag ?? checksum
    } else {
      const stored = await bucket.put(objectKey, bytes, {
        sha256: checksum,
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: {
          contentType: 'application/octet-stream',
          contentDisposition: 'attachment',
          cacheControl: 'no-store'
        }
      })
      if (!stored || stored.size !== bytes.byteLength || !stored.etag)
        throw new Error(`catalog_pdf_media_storage_unconfirmed:${product.imageReference}`)
      etag = stored.etag
    }
    await database
      .prepare(
        `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,
        byte_size,width,height,alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
        VALUES(?,?,?,?,?,?,?,'image/jpeg',?,?,?,?,?,?,?,'quarantined',?,?,?) ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        product.uploadId,
        CATALOG_LOADER_ACTOR.identityId,
        `catalog-pdf:${product.imageReference}`,
        checksum,
        checksum,
        objectKey,
        `${product.imageReference}.jpg`,
        bytes.byteLength,
        metadata.width,
        metadata.height,
        `${product.name} (${product.brand})`,
        product.brand,
        LICENSE,
        JSON.stringify({
          kind: 'uploader_declaration',
          authorizedAt: now.slice(0, 10),
          reference: `Catalogo_General_2026_sin precios_ Low.pdf, página ${product.page}`
        }),
        etag,
        now,
        now
      )
      .run()
    uploaded++
  }

  const authority = await withLoaderSession(database, now, async (actor) => {
    for (const product of plan.products) {
      const rights = await database
        .prepare('SELECT decision FROM media_rights_decisions WHERE upload_id=? ORDER BY seq DESC LIMIT 1')
        .bind(product.uploadId)
        .first<{ decision: string }>()
      if (rights?.decision === 'approved') continue
      await decideMediaRights(
        database,
        actor,
        product.uploadId,
        {
          decision: 'approve',
          reason: 'Imagen del catálogo del fabricante facilitado por el cliente para la preproducción de NETECO'
        },
        { idempotencyKey: `catalog-pdf-rights:${product.uploadId}`, now }
      )
    }
    // The seed (actor) may not exist before the first session; assign the loader as the policy actor.
    return renewAuthority(
      database,
      actor,
      plan.products.map((product) => ({
        productId: product.id,
        uploadId: product.uploadId,
        title: product.name,
        alt: `${product.name} (${product.brand})`
      })),
      {
        code: CATALOG_PDF_PRODUCT_TYPE,
        name: 'Menaje de hostelería no peligroso',
        reason: 'Menaje y utensilios sin pictogramas de peligro ni ficha de seguridad; preproducción NETECO'
      },
      now,
      validUntil
    )
  })

  const productsAfter = rowCount.parse(
    await database.prepare('SELECT count(*) AS n FROM products WHERE source_id=?').bind(SOURCE_ID).first()
  ).n
  const variantsAfter = rowCount.parse(
    await database
      .prepare('SELECT count(*) AS n FROM variants WHERE product_id IN (SELECT id FROM products WHERE source_id=?)')
      .bind(SOURCE_ID)
      .first()
  ).n
  return {
    sourceVersion: CATALOG_PDF_SOURCE_VERSION,
    products: { planned: plan.products.length, inserted: productsAfter - productsBefore },
    variants: {
      planned: plan.products.reduce((sum, item) => sum + item.variants.length, 0),
      inserted: variantsAfter - variantsBefore
    },
    brands: plan.brands.length,
    categories: plan.categories.length,
    images: { uploaded, reused },
    authority,
    validUntil
  }
}

/** Renews the expired publication authority of the original synthetic demo seed (append-only). */
export async function renewDemoSeedAuthority(database: D1Database, options: { now: string; validDays?: number }) {
  const now = options.now
  const validUntil = utc(Date.parse(now) + (options.validDays ?? 90) * 86400_000)
  const uploadId = stableUuid('demo:owned-illustration:v1')
  const products = z.array(z.object({ id: z.string(), name: z.string() })).parse(
    (
      await database
        .prepare(
          `SELECT product.id,product.name FROM products product JOIN catalog_sources source ON source.id=product.source_id
          WHERE source.code='neteco-demo' AND product.status='published'
          AND json_extract(product.regulatory,'$.productType')='local_fixture' ORDER BY product.legacy_id`
        )
        .all()
    ).results
  )
  if (!products.length) return { products: 0, renewed: null }
  const upload = await database.prepare('SELECT id FROM media_uploads WHERE id=?').bind(uploadId).first()
  if (!upload) throw new Error('demo_seed_media_missing')
  const renewed = await withLoaderSession(database, now, (actor) =>
    renewAuthority(
      database,
      actor,
      products.map((product) => ({
        productId: product.id,
        uploadId,
        title: 'Ilustración original DEMO NETECO',
        alt: 'Ilustración propia DEMO NETECO, sin venta real'
      })),
      {
        code: 'local_fixture',
        name: 'Política DEMO sintética renovada',
        reason: 'Renovación de la autoridad de publicación del catálogo DEMO sintético; sin venta real'
      },
      now,
      validUntil
    )
  )
  return { products: products.length, renewed, validUntil }
}
