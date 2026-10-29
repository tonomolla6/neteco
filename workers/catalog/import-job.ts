import {
  CATALOG_IMPORT_JOB_MAX_BYTES,
  catalogImportJobCreateInputSchema,
  catalogImportJobPageInputSchema,
  catalogImportJobFinalizeInputSchema,
  catalogImportJobSchema,
  type CatalogImportJob
} from '../../shared/catalog-import-job'
import { CATALOG_NATIVE_IMPORT_MAX_BYTES, type NativeImportInvalid } from '../../shared/catalog-native-import'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { validateCatalogRecords } from '../../shared/catalog-tabular-core'
import { validateQuantity } from '../../server/domain/money'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import type { VerifiedSessionClaims } from './authorization'
import { z } from 'zod'
import {
  projectCatalogImportJobReviewEntry,
  type CatalogImportJobReviewEntry
} from '../../shared/catalog-import-job-review'
import {
  NativeCatalogImportError,
  authorizeNativeCatalogImport as authorize,
  nativeImportActorSql as actorSql,
  nativeImportParameters as parameters,
  nativeImportSha256 as sha256,
  nativeImportInvalidResult as invalid,
  nativeImportTypedValidityCte,
  nativeImportTypedGuardSql
} from './native-import'

type Options = { now?: string; idempotencyKey?: string }
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const at = (value: string) => `strftime('%Y-%m-%dT%H:%M:%fZ',${value})`
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength
function stagingConstraint(failure: unknown) {
  if (isD1CheckConstraintFailure(failure)) return true
  if (!(failure instanceof Error)) return false
  const value: unknown = Object.getOwnPropertyDescriptor(failure, 'message')?.value
  if (typeof value !== 'string') return false
  const message = value.startsWith('D1_ERROR: ')
    ? value
        .slice(10)
        .replace(/: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY|TRIGGER)\))?$/, '')
    : value
  return (
    message === 'import_job_immutable' ||
    /^UNIQUE constraint failed: catalog_import_job_(?:rows|entries|identifiers)\.[a-z_]+(?:, catalog_import_job_(?:rows|entries|identifiers)\.[a-z_]+)*$/.test(
      message
    )
  )
}
// JSON-wrapped normalized entries can be larger than the source page because
// quotes and backslashes are escaped twice. Split bindings, not the transaction
// or source records, so valid page budgets never imply partial staging.
function entryBindings(entries: unknown[]) {
  const parts: string[] = []
  let items: string[] = [],
    size = 2
  for (const entry of entries) {
    const serialized = JSON.stringify(entry),
      bytes = byteLength(serialized)
    if (bytes + 2 > CATALOG_NATIVE_IMPORT_MAX_BYTES) throw new NativeCatalogImportError('invalid_input')
    if (size + bytes + (items.length ? 1 : 0) > CATALOG_NATIVE_IMPORT_MAX_BYTES) {
      parts.push(`[${items.join(',')}]`)
      items = []
      size = 2
    }
    size += bytes + (items.length ? 1 : 0)
    items.push(serialized)
  }
  if (items.length) parts.push(`[${items.join(',')}]`)
  return parts
}
function validId(id: string) {
  if (!catalogPolicyUuidSchema.safeParse(id).success) throw new NativeCatalogImportError('invalid_input')
}
interface JobRow {
  id: string
  actor_id: string
  warehouse_id: string
  payload_hash: string
  total_pages: number
  record_count: number
  created_at: string
  expires_at: string
  received_pages: number
  received_records: number
  received_bytes: number
  hash: string | null
  seal_reason: string | null
  seal_expires: string | null
  seal_counts: string | null
  counts: string
  command_status: 'applied' | 'reverted' | null
}
function jobCounts(id: string) {
  return `json_object('products',(SELECT count(*) FROM catalog_import_job_entries WHERE job_id=${id} AND kind='products'),
    'variants',(SELECT count(*) FROM catalog_import_job_entries WHERE job_id=${id} AND kind='variants'),
    'assets',(SELECT count(*) FROM catalog_import_job_entries WHERE job_id=${id} AND kind='assets'),
    'mappings',(SELECT count(*) FROM catalog_import_job_entries WHERE job_id=${id} AND kind='media'))`
}
async function ownedJob(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  options: Options
): Promise<JobRow> {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT j.*,
    (SELECT count(*) FROM catalog_import_job_pages WHERE job_id=j.id) AS received_pages,
    (SELECT COALESCE(sum(record_count),0) FROM catalog_import_job_pages WHERE job_id=j.id) AS received_records,
    (SELECT COALESCE(sum(byte_length),0) FROM catalog_import_job_pages WHERE job_id=j.id) AS received_bytes,
    s.hash,s.reason AS seal_reason,s.expires_at AS seal_expires,s.counts AS seal_counts,
    CASE WHEN EXISTS(SELECT 1 FROM catalog_import_job_commands WHERE job_id=j.id AND action='revert') THEN 'reverted'
     WHEN EXISTS(SELECT 1 FROM catalog_import_job_commands WHERE job_id=j.id AND action='apply') THEN 'applied' END AS command_status,
    ${jobCounts('j.id')} AS counts
    FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id LEFT JOIN catalog_import_job_seals s ON s.job_id=j.id WHERE j.id=?5`
    )
    .bind(...parameters(claims, options), id)
    .first<JobRow>()
  await authorize(database, claims, options)
  if (!row) throw new NativeCatalogImportError('not_found')
  if (
    row.hash !== null &&
    (row.seal_counts !== row.counts ||
      row.received_pages !== row.total_pages ||
      row.received_records !== row.record_count)
  )
    throw new Error('catalog_import_job_seal_integrity')
  return row
}
function projection(row: JobRow): CatalogImportJob {
  return catalogImportJobSchema.parse({
    source: 'cloudflare',
    outcome: 'job',
    id: row.id,
    status: row.command_status ?? (row.hash === null ? 'uploading' : 'ready'),
    createdAt: row.created_at,
    expiresAt: row.seal_expires ?? row.expires_at,
    totalPages: row.total_pages,
    receivedPages: row.received_pages,
    recordCount: row.record_count,
    hash: row.hash,
    counts: JSON.parse(row.counts),
    policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
  })
}
export async function readCatalogImportJob(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  options: Options = {}
): Promise<CatalogImportJob> {
  validId(id)
  const claims = await authorize(database, input, options)
  return projection(await ownedJob(database, claims, id, options))
}
const reviewInputSchema = z
  .object({ offset: z.number().int().min(0).max(100000), limit: z.number().int().min(1).max(50) })
  .strict()
export interface CatalogImportJobReview {
  source: 'cloudflare'
  outcome: 'review'
  jobId: string
  jobHash: string
  offset: number
  nextOffset: number | null
  totalEntries: number
  entries: CatalogImportJobReviewEntry[]
  policy: CatalogImportJob['policy']
}
/** Read one bounded slice of the immutable, sealed create-only diff. The
 * cumulative raw-byte cap is inside SQL, before any large payload is returned.
 * Smaller pages are explicit through nextOffset; no row disappears silently. */
export async function readCatalogImportJobReview(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: Options = {}
): Promise<CatalogImportJobReview> {
  validId(id)
  const claims = await authorize(database, input, options)
  let data: unknown
  try {
    data = catalogPolicyOwnJson(raw)
  } catch {
    throw new NativeCatalogImportError('invalid_input')
  }
  const parsed = reviewInputSchema.safeParse(data)
  if (!parsed.success) throw new NativeCatalogImportError('invalid_input')
  const row = await ownedJob(database, claims, id, options)
  if (row.hash === null) throw new NativeCatalogImportError('version_conflict')
  const totalEntries = Object.values(JSON.parse(row.counts) as CatalogImportJob['counts']).reduce(
    (sum, count) => sum + count,
    0
  )
  if (parsed.data.offset > totalEntries) throw new NativeCatalogImportError('invalid_input')
  const result = await database
    .prepare(
      `WITH actor AS (${actorSql}),candidate AS(
   SELECT e.kind,e.item_id,e.payload,e.payload_hash FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id
   JOIN catalog_import_job_seals s ON s.job_id=j.id JOIN catalog_import_job_entries e ON e.job_id=j.id
   WHERE j.id=?5 AND s.hash=?6 ORDER BY e.kind,e.item_id LIMIT ?7 OFFSET ?8),
   bounded AS(SELECT *,row_number() OVER(ORDER BY kind,item_id) AS position,
    sum(length(CAST(payload AS BLOB))) OVER(ORDER BY kind,item_id ROWS UNBOUNDED PRECEDING) AS running_bytes FROM candidate)
   SELECT kind,item_id,payload,payload_hash FROM bounded WHERE running_bytes<=300000 OR position=1 ORDER BY kind,item_id`
    )
    .bind(...parameters(claims, options), id, row.hash, parsed.data.limit, parsed.data.offset)
    .all<{ kind: string; item_id: string; payload: string; payload_hash: string }>()
  await authorize(database, claims, options)
  if (!result.success || !Array.isArray(result.results)) throw new Error('catalog_import_review_unavailable')
  const entries: CatalogImportJobReviewEntry[] = []
  for (const entry of result.results) {
    if ((await sha256(entry.payload)) !== entry.payload_hash) throw new Error('catalog_import_review_integrity')
    entries.push(
      projectCatalogImportJobReviewEntry(
        { kind: entry.kind, itemId: entry.item_id, payload: entry.payload },
        { warehouseId: row.warehouse_id }
      )
    )
  }
  await authorize(database, claims, options)
  if (!entries.length && parsed.data.offset < totalEntries) throw new Error('catalog_import_review_unavailable')
  return {
    source: 'cloudflare',
    outcome: 'review',
    jobId: id,
    jobHash: row.hash,
    offset: parsed.data.offset,
    nextOffset: parsed.data.offset + entries.length < totalEntries ? parsed.data.offset + entries.length : null,
    totalEntries,
    entries,
    policy: projection(row).policy
  }
}
export async function createCatalogImportJob(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  raw: unknown,
  options: Options = {}
): Promise<CatalogImportJob> {
  const claims = await authorize(database, input, options),
    parsed = catalogImportJobCreateInputSchema.safeParse(raw)
  if (!parsed.success) throw new NativeCatalogImportError('invalid_input')
  const key = options.idempotencyKey ?? crypto.randomUUID()
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key))
    throw new NativeCatalogImportError('invalid_input')
  const payloadHash = await sha256(JSON.stringify(['native-import-job.v1', parsed.data]))
  const replay = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT j.id,j.payload_hash FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id WHERE j.idempotency_key=?5`
    )
    .bind(...parameters(claims, options), key)
    .first<{ id: string; payload_hash: string }>()
  await authorize(database, claims, options)
  if (replay) {
    if (replay.payload_hash !== payloadHash) throw new NativeCatalogImportError('idempotency_conflict')
    return readCatalogImportJob(database, claims, replay.id, options)
  }
  const id = crypto.randomUUID()
  try {
    await database.batch([
      database
        .prepare(
          `WITH actor AS (${actorSql}) INSERT INTO catalog_import_jobs(id,actor_id,warehouse_id,idempotency_key,payload_hash,total_pages,record_count,created_at,expires_at)
      SELECT ?5,actor.id,location.id,?6,?7,?8,?9,${clock},strftime('%Y-%m-%dT%H:%M:%SZ',${clock},'+24 hours')
      FROM actor JOIN inventory_locations location WHERE location.active=1 AND location.kind='warehouse'
      AND (SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse')=1
      AND NOT EXISTS(SELECT 1 FROM catalog_import_jobs WHERE actor_id=actor.id AND idempotency_key=?6)`
        )
        .bind(...parameters(claims, options), id, key, payloadHash, parsed.data.totalPages, parsed.data.recordCount),
      database
        .prepare(
          `WITH actor AS (${actorSql}) INSERT INTO catalog_import_job_guards(id,satisfied) SELECT ?5,CASE WHEN EXISTS(
       SELECT 1 FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id WHERE j.id=?5 AND j.idempotency_key=?6 AND j.payload_hash=?7) THEN 1 ELSE 0 END`
        )
        .bind(...parameters(claims, options), id, key, payloadHash),
      database.prepare('DELETE FROM catalog_import_job_guards WHERE id=?').bind(id)
    ])
  } catch (failure) {
    if (!isD1CheckConstraintFailure(failure)) throw failure
    await authorize(database, claims, options)
    const raced = await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT j.id,j.payload_hash FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id WHERE j.idempotency_key=?5`
      )
      .bind(...parameters(claims, options), key)
      .first<{ id: string; payload_hash: string }>()
    if (raced?.payload_hash === payloadHash) return readCatalogImportJob(database, claims, raced.id, options)
    throw new NativeCatalogImportError(raced ? 'idempotency_conflict' : 'version_conflict')
  }
  return readCatalogImportJob(database, claims, id, options)
}

export { jobCounts as catalogImportJobCountsSql }
async function deterministicId(jobId: string, kind: string, id: string) {
  const hash = await sha256(JSON.stringify([jobId, kind, id]))
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
const liveWorkspace = `WITH actor AS (${actorSql}),owned AS(SELECT j.* FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id
 WHERE j.id=?5 AND j.expires_at>${clock} AND NOT EXISTS(SELECT 1 FROM catalog_import_job_seals WHERE job_id=j.id))`
export async function uploadCatalogImportJobPage(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: Options = {}
): Promise<CatalogImportJob | NativeImportInvalid> {
  validId(id)
  const claims = await authorize(database, input, options),
    parsed = catalogImportJobPageInputSchema.safeParse(raw)
  if (!parsed.success) return invalid('invalid_catalog_records')
  const body = parsed.data,
    payload = JSON.stringify({ records: body.records }),
    bytes = byteLength(payload)
  if (bytes > CATALOG_NATIVE_IMPORT_MAX_BYTES) return invalid('catalog_record_too_large')
  const row = await ownedJob(database, claims, id, options),
    payloadHash = await sha256(payload)
  const prior = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT page.payload_hash FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id
    JOIN catalog_import_job_pages page ON page.job_id=j.id WHERE j.id=?5 AND page.page_index=?6`
    )
    .bind(...parameters(claims, options), id, body.index)
    .first<{ payload_hash: string }>()
  await authorize(database, claims, options)
  if (prior) {
    if (prior.payload_hash !== payloadHash) throw new NativeCatalogImportError('idempotency_conflict')
    return readCatalogImportJob(database, claims, id, options)
  }
  if (row.hash !== null || body.index !== row.received_pages || body.index >= row.total_pages)
    throw new NativeCatalogImportError('version_conflict')
  if (row.expires_at <= (options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')))
    throw new NativeCatalogImportError('preview_expired')
  if (
    row.received_records + body.records.length > row.record_count ||
    row.received_bytes + bytes > CATALOG_IMPORT_JOB_MAX_BYTES
  )
    return invalid('catalog_job_too_large')
  // Source publication declarations are not authority. Cross-page relations
  // are checked globally at seal; this path creates only immutable staging.
  const validation = validateCatalogRecords(body.records, { deferCompleteness: true, deferRelationships: true })
  if (!validation.valid) return invalid('invalid_catalog_records', validation.issues)
  for (const variant of validation.dataset.variants) {
    try {
      validateQuantity(variant.minimumQuantity, variant)
    } catch {
      return invalid('quantity_rules_invalid')
    }
    if (
      variant.priceGrossCents <= 0 ||
      (variant.compareAtGrossCents !== null && variant.compareAtGrossCents <= variant.priceGrossCents)
    )
      return invalid('initial_price_required')
    if (
      variant.inventory.length > 1 ||
      variant.inventory.some((balance) => balance.locationId !== row.warehouse_id || balance.version !== 1)
    )
      return invalid('single_warehouse_required')
  }
  const variants = await Promise.all(
    validation.dataset.variants.map(async (variant) => ({
      ...variant,
      initialPriceId: await deterministicId(id, 'price', variant.id),
      initialMovementId: await deterministicId(id, 'initial', variant.id),
      compensationMovementId: await deterministicId(id, 'compensation', variant.id)
    }))
  )
  const dataset = { ...validation.dataset, variants }
  const entries = await Promise.all(
    Object.entries(dataset).flatMap(([kind, items]) =>
      items.map(async (item) => {
        const value = item as unknown as Record<string, unknown>,
          itemId =
            kind === 'media'
              ? JSON.stringify([value.productId, value.variantId, value.assetId, value.role, value.version])
              : String(value.id)
        const serialized = JSON.stringify(catalogPolicyOwnJson(value))
        return { kind, id: itemId, payload: serialized, hash: await sha256(serialized) }
      })
    )
  )
  const rows = await Promise.all(
    body.records.map(async (record, index) => ({
      index: row.received_records + index,
      hash: await sha256(JSON.stringify(record))
    }))
  )
  const identifiers = [
    ...new Map(
      variants.flatMap((variant) =>
        [variant.ean, variant.gtin]
          .filter((value): value is string => value !== null)
          .map((value) => [`${value}:${variant.id}`, { value, variantId: variant.id }] as const)
      )
    ).values()
  ]
  const serializedEntries = entryBindings(entries),
    serializedRows = JSON.stringify(rows),
    serializedIdentifiers = JSON.stringify(identifiers)
  // Keep each bounded JSON page outside the indexed entry/identifier lookup.
  // An ordinary JOIN lets SQLite scan all prior job entries and reparse the
  // entire page for each one, making later uploads quadratic in job size.
  const observed = await database.batch([
    ...serializedEntries.map((part) =>
      database
        .prepare(
          `WITH actor AS (${actorSql})
     SELECT count(*) AS n FROM actor JOIN json_each(?6) item
     CROSS JOIN catalog_import_job_entries e ON e.job_id=?5
      AND e.kind=json_extract(item.value,'$.kind') AND e.item_id=json_extract(item.value,'$.id')
     WHERE e.job_id IN(SELECT id FROM catalog_import_jobs WHERE actor_id=actor.id)`
        )
        .bind(...parameters(claims, options), id, part)
    ),
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT
     (SELECT count(*) FROM catalog_import_job_identifiers e WHERE e.job_id=j.id) AS n,
     (SELECT count(*) FROM json_each(?6) item CROSS JOIN catalog_import_job_identifiers e
      ON e.job_id=j.id AND e.identifier=json_extract(item.value,'$.value')) AS matching
     FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id WHERE j.id=?5`
      )
      .bind(...parameters(claims, options), id, serializedIdentifiers)
  ])
  await authorize(database, claims, options)
  const counts = observed.map((result) => result.results?.[0] as { n?: number; matching?: number } | undefined)
  if (
    observed.some((result) => result.success !== true) ||
    counts.some((result) => !Number.isSafeInteger(result?.n) || result!.n! < 0)
  )
    throw new Error('catalog_import_job_storage_unavailable')
  const previousIdentifiers = counts.at(-1)!
  if (!Number.isSafeInteger(previousIdentifiers.matching) || previousIdentifiers.matching! < 0)
    throw new Error('catalog_import_job_storage_unavailable')
  const expectedEntries =
    Object.values(JSON.parse(row.counts) as CatalogImportJob['counts']).reduce((sum, count) => sum + count, 0) +
    entries.length -
    counts.slice(0, -1).reduce((sum, result) => sum + result!.n!, 0)
  const expectedIdentifiers = previousIdentifiers.n! + identifiers.length - previousIdentifiers.matching!
  const binds = [
    ...parameters(claims, options),
    id,
    body.index,
    payloadHash,
    payload,
    bytes,
    body.records.length,
    row.received_records
  ]
  const claimed = `WITH claimed AS(SELECT page.* FROM catalog_import_job_pages page WHERE page.job_id=?1 AND page.page_index=?2 AND page.payload_hash=?3)`
  try {
    await database.batch([
      database
        .prepare(
          `${liveWorkspace} INSERT INTO catalog_import_job_pages(job_id,page_index,payload_hash,payload,byte_length,record_count,created_at)
       SELECT j.id,?6,?7,?8,?9,?10,${clock} FROM owned j WHERE ?6=(SELECT count(*) FROM catalog_import_job_pages WHERE job_id=j.id)
       AND ?6<j.total_pages AND (SELECT COALESCE(sum(record_count),0) FROM catalog_import_job_pages WHERE job_id=j.id)=?11
       AND ?11+?10<=j.record_count AND ?9+(SELECT COALESCE(sum(byte_length),0) FROM catalog_import_job_pages WHERE job_id=j.id)<=${CATALOG_IMPORT_JOB_MAX_BYTES}`
        )
        .bind(...binds),
      database
        .prepare(
          `${claimed} INSERT INTO catalog_import_job_rows(job_id,row_index,page_index,payload_hash)
       SELECT page.job_id,json_extract(item.value,'$.index'),page.page_index,json_extract(item.value,'$.hash') FROM claimed page,json_each(?4) item`
        )
        .bind(id, body.index, payloadHash, serializedRows),
      ...serializedEntries.map((part) =>
        database
          .prepare(
            `${claimed} INSERT INTO catalog_import_job_entries(job_id,kind,item_id,payload,payload_hash,first_page)
       SELECT page.job_id,json_extract(item.value,'$.kind'),json_extract(item.value,'$.id'),json_extract(item.value,'$.payload'),json_extract(item.value,'$.hash'),page.page_index
       FROM claimed page,json_each(?4) item WHERE NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e WHERE e.job_id=page.job_id
        AND e.kind=json_extract(item.value,'$.kind') AND e.item_id=json_extract(item.value,'$.id'))`
          )
          .bind(id, body.index, payloadHash, part)
      ),
      database
        .prepare(
          `${claimed} INSERT INTO catalog_import_job_identifiers(job_id,identifier,variant_id,first_page)
       SELECT page.job_id,json_extract(item.value,'$.value'),json_extract(item.value,'$.variantId'),page.page_index FROM claimed page,json_each(?4) item
       WHERE NOT EXISTS(SELECT 1 FROM catalog_import_job_identifiers e WHERE e.job_id=page.job_id AND e.identifier=json_extract(item.value,'$.value'))`
        )
        .bind(id, body.index, payloadHash, serializedIdentifiers),
      database
        .prepare(
          `${liveWorkspace} INSERT INTO catalog_import_job_guards(id,satisfied) SELECT ?5,CASE WHEN EXISTS(SELECT 1 FROM owned j
       JOIN catalog_import_job_pages page ON page.job_id=j.id WHERE page.page_index=?6 AND page.payload_hash=?7
       AND (SELECT count(*) FROM catalog_import_job_rows WHERE job_id=j.id AND page_index=?6)=?8
       AND (SELECT count(*) FROM catalog_import_job_pages WHERE job_id=j.id)=?6+1
       AND (SELECT count(*) FROM catalog_import_job_rows WHERE job_id=j.id)=?10
       AND (SELECT sum(record_count) FROM catalog_import_job_pages WHERE job_id=j.id)=?10
       AND (SELECT count(*) FROM catalog_import_job_entries WHERE job_id=j.id)=?11
       AND (SELECT count(*) FROM catalog_import_job_identifiers WHERE job_id=j.id)=?12
       AND (SELECT count(*) FROM json_each(?9) item CROSS JOIN catalog_import_job_identifiers e ON e.job_id=j.id
        AND e.identifier=json_extract(item.value,'$.value') AND e.variant_id=json_extract(item.value,'$.variantId'))=json_array_length(?9)) THEN 1 ELSE 0 END`
        )
        .bind(
          ...parameters(claims, options),
          id,
          body.index,
          payloadHash,
          body.records.length,
          serializedIdentifiers,
          row.received_records + body.records.length,
          expectedEntries,
          expectedIdentifiers
        ),
      ...serializedEntries.map((part, index) =>
        database
          .prepare(
            `${liveWorkspace}
       INSERT INTO catalog_import_job_guards(id,satisfied) SELECT ?6,CASE WHEN EXISTS(SELECT 1 FROM owned j
       JOIN catalog_import_job_pages page ON page.job_id=j.id WHERE page.page_index=?7 AND page.payload_hash=?8
       AND (SELECT count(*) FROM json_each(?9) item CROSS JOIN catalog_import_job_entries e ON e.job_id=j.id
        AND e.kind=json_extract(item.value,'$.kind') AND e.item_id=json_extract(item.value,'$.id')
        AND e.payload=json_extract(item.value,'$.payload') AND e.payload_hash=json_extract(item.value,'$.hash'))=json_array_length(?9)) THEN 1 ELSE 0 END`
          )
          .bind(...parameters(claims, options), id, `${id}:entries:${index}`, body.index, payloadHash, part)
      ),
      database.prepare('DELETE FROM catalog_import_job_guards WHERE id LIKE ?').bind(`${id}:entries:%`),
      database.prepare('DELETE FROM catalog_import_job_guards WHERE id=?').bind(id)
    ])
  } catch (failure) {
    if (!stagingConstraint(failure)) throw failure
    await authorize(database, claims, options)
    const raced = await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT page.payload_hash FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id
       JOIN catalog_import_job_pages page ON page.job_id=j.id WHERE j.id=?5 AND page.page_index=?6`
      )
      .bind(...parameters(claims, options), id, body.index)
      .first<{ payload_hash: string }>()
    if (raced?.payload_hash === payloadHash) return readCatalogImportJob(database, claims, id, options)
    return invalid('catalog_page_conflict')
  }
  return readCatalogImportJob(database, claims, id, options)
}

export function catalogImportJobTypedSourceSql(jobIdSql: string) {
  return `SELECT entry.item_id AS id,json_extract(entry.payload,'$.categoryId') AS category_id,
    json_extract(entry.payload,'$.attributes') AS attributes FROM catalog_import_job_entries entry
    WHERE entry.job_id=${jobIdSql} AND entry.kind='products'`
}
export function catalogImportJobReferencesSql(job: string) {
  return `EXISTS(SELECT 1 FROM inventory_locations WHERE id=${job}.warehouse_id AND active=1 AND kind='warehouse')
    AND (SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse')=1
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e LEFT JOIN catalog_sources source ON source.id=json_extract(e.payload,'$.sourceId')
     LEFT JOIN categories category ON category.id=json_extract(e.payload,'$.categoryId') LEFT JOIN brands brand ON brand.id=json_extract(e.payload,'$.brandId')
     WHERE e.job_id=${job}.id AND e.kind='products' AND (source.id IS NULL OR source.is_master<>1 OR category.id IS NULL OR brand.id IS NULL
      OR category.status<>json_extract(e.payload,'$.categoryStatus') OR brand.status<>json_extract(e.payload,'$.brandStatus')))
    AND (SELECT count(DISTINCT json_extract(payload,'$.sourceId')) FROM catalog_import_job_entries WHERE job_id=${job}.id AND kind='products')=1
    AND (SELECT count(DISTINCT json_extract(payload,'$.sourceVersion')) FROM catalog_import_job_entries WHERE job_id=${job}.id AND kind IN ('products','variants'))=1
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e LEFT JOIN tax_classes tax ON tax.id=json_extract(e.payload,'$.taxClassId')
     LEFT JOIN shipping_profiles shipping ON shipping.id=json_extract(e.payload,'$.shippingProfileId') WHERE e.job_id=${job}.id AND e.kind='variants'
     AND (tax.id IS NULL OR shipping.id IS NULL OR ${at('tax.valid_from')} IS NULL OR ${at('tax.valid_from')}>${at(clock)}
      OR (tax.valid_until IS NOT NULL AND (${at('tax.valid_until')} IS NULL OR ${at('tax.valid_until')}<=${at(clock)}))))
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e WHERE e.job_id=${job}.id AND e.kind='variants'
     AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries parent WHERE parent.job_id=e.job_id AND parent.kind='products' AND parent.item_id=json_extract(e.payload,'$.productId')))
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e WHERE e.job_id=${job}.id AND e.kind='media' AND (
      NOT EXISTS(SELECT 1 FROM catalog_import_job_entries p WHERE p.job_id=e.job_id AND p.kind='products' AND p.item_id=json_extract(e.payload,'$.productId'))
      OR NOT EXISTS(SELECT 1 FROM catalog_import_job_entries a WHERE a.job_id=e.job_id AND a.kind='assets' AND a.item_id=json_extract(e.payload,'$.assetId'))
      OR (json_extract(e.payload,'$.variantId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries v
       WHERE v.job_id=e.job_id AND v.kind='variants' AND v.item_id=json_extract(e.payload,'$.variantId') AND json_extract(v.payload,'$.productId')=json_extract(e.payload,'$.productId')))))`
}
export function catalogImportJobNoConflictsSql(job: string) {
  return `NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e JOIN products p ON p.id=e.item_id OR p.legacy_id=e.legacy_id OR p.slug=e.slug WHERE e.job_id=${job}.id AND e.kind='products')
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e JOIN variants v ON v.id=e.item_id OR v.legacy_id=e.legacy_id OR v.sku=e.sku WHERE e.job_id=${job}.id AND e.kind='variants')
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_identifiers e JOIN variants v ON v.ean=e.identifier OR v.gtin=e.identifier WHERE e.job_id=${job}.id)
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e JOIN media_assets a ON a.id=e.item_id OR a.storage_key=e.storage_key OR a.checksum_sha256=e.checksum WHERE e.job_id=${job}.id AND e.kind='assets')
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_entries e JOIN media_uploads a ON a.id=e.item_id OR a.object_key=e.storage_key OR a.checksum=e.checksum WHERE e.job_id=${job}.id AND e.kind='assets')`
}
export async function sealCatalogImportJob(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: Options = {}
): Promise<CatalogImportJob | NativeImportInvalid> {
  validId(id)
  const claims = await authorize(database, input, options),
    parsed = catalogImportJobFinalizeInputSchema.safeParse(raw)
  if (!parsed.success) throw new NativeCatalogImportError('invalid_input')
  const row = await ownedJob(database, claims, id, options)
  if (row.hash !== null) {
    if (row.seal_reason !== parsed.data.reason) throw new NativeCatalogImportError('idempotency_conflict')
    return projection(row)
  }
  if (row.received_pages !== row.total_pages || row.received_records !== row.record_count)
    return invalid('catalog_job_incomplete')
  if (row.expires_at <= (options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')))
    throw new NativeCatalogImportError('preview_expired')
  const pages = (
    await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT page.page_index,page.payload_hash FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id
   JOIN catalog_import_job_pages page ON page.job_id=j.id WHERE j.id=?5 ORDER BY page.page_index`
      )
      .bind(...parameters(claims, options), id)
      .all<{ page_index: number; payload_hash: string }>()
  ).results
  await authorize(database, claims, options)
  if (pages.length !== row.total_pages || pages.some((page, index) => page.page_index !== index))
    return invalid('catalog_job_incomplete')
  const hash = await sha256(
    JSON.stringify([
      'catalog-native-job.v1',
      id,
      row.warehouse_id,
      row.record_count,
      row.total_pages,
      JSON.parse(row.counts),
      pages
    ])
  )
  const facts = await database
    .prepare(
      `WITH actor AS (${actorSql}),${nativeImportTypedValidityCte(catalogImportJobTypedSourceSql('?5'))} SELECT ${catalogImportJobReferencesSql('j')} AS refs,${catalogImportJobNoConflictsSql('j')} AS unique_ok,(SELECT valid FROM typed_check) AS typed_ok
    FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id WHERE j.id=?5`
    )
    .bind(...parameters(claims, options), id)
    .first<{ refs: number; unique_ok: number; typed_ok: number }>()
  await authorize(database, claims, options)
  if (facts?.refs !== 1) return invalid('reference_conflict')
  if (facts.unique_ok !== 1) return invalid('catalog_identifier_conflict')
  if (facts.typed_ok !== 1) return invalid('invalid_typed_values')
  const counts = JSON.parse(row.counts) as CatalogImportJob['counts']
  if (Object.values(counts).some((value) => value < 1)) return invalid('catalog_job_incomplete')
  try {
    await database.batch([
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_import_job_guards',
            nativeImportTypedValidityCte(catalogImportJobTypedSourceSql('?5')),
            'JOIN catalog_import_jobs j ON j.actor_id=actor.id WHERE j.id=?5'
          )
        )
        .bind(...parameters(claims, options), id),
      database
        .prepare(
          `${liveWorkspace} INSERT INTO catalog_import_job_seals(job_id,hash,counts,reason,created_at,expires_at)
       SELECT j.id,?6,?7,?8,${clock},strftime('%Y-%m-%dT%H:%M:%SZ',${clock},'+30 minutes') FROM owned j
       WHERE (SELECT count(*) FROM catalog_import_job_pages WHERE job_id=j.id)=j.total_pages
       AND (SELECT sum(record_count) FROM catalog_import_job_pages WHERE job_id=j.id)=j.record_count
       AND (SELECT count(*) FROM catalog_import_job_rows WHERE job_id=j.id)=j.record_count
       AND ${jobCounts('j.id')}=?7
       AND ${catalogImportJobReferencesSql('j')} AND ${catalogImportJobNoConflictsSql('j')}`
        )
        .bind(...parameters(claims, options), id, hash, JSON.stringify(counts), parsed.data.reason),
      database
        .prepare(
          `WITH actor AS (${actorSql}) INSERT INTO catalog_import_job_guards(id,satisfied) SELECT ?5,
       CASE WHEN EXISTS(SELECT 1 FROM actor JOIN catalog_import_jobs j ON j.actor_id=actor.id JOIN catalog_import_job_seals s ON s.job_id=j.id
       WHERE j.id=?5 AND s.hash=?6 AND s.counts=?7 AND ${jobCounts('j.id')}=s.counts
       AND (SELECT count(*) FROM catalog_import_job_pages WHERE job_id=j.id)=j.total_pages
       AND (SELECT sum(record_count) FROM catalog_import_job_pages WHERE job_id=j.id)=j.record_count
       AND (SELECT count(*) FROM catalog_import_job_rows WHERE job_id=j.id)=j.record_count
       AND ${catalogImportJobReferencesSql('j')} AND ${catalogImportJobNoConflictsSql('j')}) THEN 1 ELSE 0 END`
        )
        .bind(...parameters(claims, options), id, hash, JSON.stringify(counts)),
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_import_job_guards',
            nativeImportTypedValidityCte(catalogImportJobTypedSourceSql('?5')),
            'JOIN catalog_import_jobs j ON j.actor_id=actor.id JOIN catalog_import_job_seals s ON s.job_id=j.id WHERE j.id=?5'
          )
        )
        .bind(...parameters(claims, options), id),
      database.prepare('DELETE FROM catalog_import_job_guards WHERE id=?').bind(id)
    ])
  } catch (failure) {
    if (!isD1CheckConstraintFailure(failure)) throw failure
    await authorize(database, claims, options)
    const raced = await ownedJob(database, claims, id, options)
    if (raced.hash === hash && raced.seal_reason === parsed.data.reason) return projection(raced)
    return invalid('catalog_job_conflict')
  }
  return readCatalogImportJob(database, claims, id, options)
}
